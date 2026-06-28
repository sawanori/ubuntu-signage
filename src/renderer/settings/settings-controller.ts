/**
 * T19/T20/T23/T32-UI — settings-controller.ts
 *
 * DOM非依存の設定ロジックコントローラ。
 *
 * 責務:
 *   - 現在設定の保持（initialize()でIPCブリッジから取得）
 *   - loopEnabledのトグル（toggleLoop()）
 *   - interval選択（selectInterval()）
 *   - URL入力の検証（validateUrl()）: http/https以外はエラー
 *   - URL保存（setUrl()）: 検証通過後にIPCで保存
 *   - フォルダ選択結果の反映（applyFolderPick() / pickFolder()）
 *   - テスト再生（testPlay()）: schedulerState が IDLE のときのみ許可
 *   - 保存はIPCブリッジのupdateConfig()経由で往復し、返却値で内部状態を更新する
 *
 * 設計方針:
 *   - DOM / HTML / CSS には一切依存しない（テストはnode環境で実行可能）
 *   - SettingsBridge インターフェースで IPC を抽象化（テストでモック注入可能）
 *   - SchedulerState は 'IDLE' | 'FADE_IN' | 'PLAYING' | 'FADE_OUT' の文字列リテラル
 */

import type { Config } from '../../shared/types'

// ─── 型定義 ─────────────────────────────────────────────────────────────────

/** スケジューラの状態 */
export type SchedulerState = 'IDLE' | 'FADE_IN' | 'PLAYING' | 'FADE_OUT'

/** URL検証結果 */
export type UrlValidationResult =
  | { valid: true }
  | { valid: false; message: string }

/**
 * IPCブリッジのインターフェース。
 *
 * 本番環境では preload の contextBridge 経由の API がこれを実装する。
 * テストでは vi.fn() でモックを注入する。
 *
 * updateConfig の返却値:
 *   - 成功時: サーバー側で保存・検証された最新の Config
 *   - 失敗時（zod検証拒否 / 保存エラー）: null
 */
export interface SettingsBridge {
  /** 現在の設定を取得する */
  getConfig(): Promise<Config>

  /**
   * 設定を部分更新し、更新後の Config を返す。
   * IPC roundtrip: settings:update → settings:updated の往復。
   * 検証拒否または保存失敗の場合は null を返す。
   */
  updateConfig(patch: Partial<Config>): Promise<Config | null>

  /** テスト再生を要求する（settings:test-play 送出） */
  testPlay(): void

  /**
   * フォルダ選択ダイアログを開き、選択結果を返す。
   * ユーザーがキャンセルした場合は folderPath が null になる。
   */
  pickFolder(): Promise<{ folderPath: string | null }>
}

// ─── SettingsController クラス ────────────────────────────────────────────────

/**
 * 設定パネルのDOM非依存ロジックコントローラ。
 *
 * @example
 * // 本番での使用
 * const bridge: SettingsBridge = {
 *   getConfig: () => window.settingsApi.getConfig(),
 *   updateConfig: (patch) => window.settingsApi.updateConfig(patch),
 *   testPlay: () => window.settingsApi.testPlay(),
 *   pickFolder: () => window.settingsApi.pickFolder(),
 * }
 * const controller = new SettingsController(bridge)
 * await controller.initialize()
 *
 * @example
 * // テストでの使用（モック注入）
 * const bridge = { getConfig: vi.fn().mockResolvedValue(config), ... }
 * const controller = new SettingsController(bridge)
 */
export class SettingsController {
  private _config: Config | null = null
  private _schedulerState: SchedulerState = 'IDLE'
  private _urlError: string | null = null

  constructor(private readonly bridge: SettingsBridge) {}

  // ─── ゲッター ───────────────────────────────────────────────────────────

  /** 現在保持している設定のコピーを返す。initialize() 前は null */
  get config(): Config | null {
    return this._config ? { ...this._config } : null
  }

  /** 最後の URL 検証エラーメッセージ。有効 URL 検証後はクリアされる */
  get urlError(): string | null {
    return this._urlError
  }

  /** 現在のスケジューラ状態 */
  get schedulerState(): SchedulerState {
    return this._schedulerState
  }

  // ─── 初期化 ─────────────────────────────────────────────────────────────

  /**
   * IPCブリッジから現在の設定を取得し、内部状態を初期化する。
   *
   * @returns 取得した設定
   */
  async initialize(): Promise<Config> {
    const config = await this.bridge.getConfig()
    this._config = config
    this._urlError = null
    return { ...config }
  }

  // ─── 設定変更操作 ────────────────────────────────────────────────────────

  /**
   * loopEnabled を現在の値から反転させ、IPC経由で保存する。
   *
   * @returns 更新後の Config。IPC側が拒否した場合は null（内部状態は変更しない）
   */
  async toggleLoop(): Promise<Config | null> {
    if (!this._config) return null
    return this._saveAndApply({ loopEnabled: !this._config.loopEnabled })
  }

  /**
   * 割り込み間隔を選択し、IPC経由で保存する。
   *
   * @param intervalMinutes - 選択する間隔（1 | 5 | 10 | 15 | 30）
   * @returns 更新後の Config。IPC側が拒否した場合は null（内部状態は変更しない）
   */
  async selectInterval(
    intervalMinutes: 1 | 5 | 10 | 15 | 30
  ): Promise<Config | null> {
    return this._saveAndApply({ intervalMinutes })
  }

  /**
   * URL文字列を検証する（DOM非依存）。
   * 空文字（未設定・スタート画面）は有効とする。
   * http / https スキームのみ有効。その他は urlError をセットして invalid を返す。
   *
   * @param url - 検証する URL 文字列
   * @returns UrlValidationResult
   */
  validateUrl(url: string): UrlValidationResult {
    // 空文字（または空白のみ）は「未設定（スタート画面）」として有効（§5.6）
    if (url.trim() === '') {
      this._urlError = null
      return { valid: true }
    }

    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      const message = 'Invalid URL format'
      this._urlError = message
      return { valid: false, message }
    }

    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      const scheme = parsed.protocol.replace(':', '')
      const message = `URL scheme must be http or https (got ${scheme})`
      this._urlError = message
      return { valid: false, message }
    }

    this._urlError = null
    return { valid: true }
  }

  /**
   * サイト URL を検証し、有効な場合のみ IPC経由で保存する。
   * 無効な URL の場合は urlError をセットして null を返す。
   *
   * @param url - 設定する URL 文字列
   * @returns 更新後の Config（有効 URL の場合）、または null（無効 URL / IPC拒否）
   */
  async setUrl(url: string): Promise<Config | null> {
    const validation = this.validateUrl(url)
    if (!validation.valid) return null
    return this._saveAndApply({ siteUrl: url })
  }

  /**
   * フォルダ選択ダイアログの結果を適用する。
   * folderPath が null（キャンセル）の場合は何もしない。
   *
   * @param folderPath - 選択されたフォルダパス、またはキャンセル時は null
   * @returns 更新後の Config（選択あり）、または null（キャンセル / IPC拒否）
   */
  async applyFolderPick(folderPath: string | null): Promise<Config | null> {
    if (!folderPath) return null
    return this._saveAndApply({ videoFolderPath: folderPath })
  }

  /**
   * フォルダ選択ダイアログを開き、選択結果を内部設定に反映する。
   * IPCブリッジ経由でダイアログを要求し、返却されたパスを applyFolderPick() で適用する。
   *
   * @returns 更新後の Config（選択あり）、または null（キャンセル / IPC拒否）
   */
  async pickFolder(): Promise<Config | null> {
    const result = await this.bridge.pickFolder()
    return this.applyFolderPick(result.folderPath)
  }

  // ─── テスト再生 ─────────────────────────────────────────────────────────

  /**
   * テスト再生を要求する。schedulerState が IDLE のときのみ有効。
   * IDLE 以外（FADE_IN / PLAYING / FADE_OUT）は no-op として false を返す。
   *
   * @returns IDLE で再生要求を送出した場合は true、それ以外は false
   */
  testPlay(): boolean {
    if (this._schedulerState !== 'IDLE') return false
    this.bridge.testPlay()
    return true
  }

  // ─── 状態更新（外部から呼ばれる） ────────────────────────────────────────

  /**
   * スケジューラの状態を更新する。
   * Mainプロセスからの通知（IPC）を受けてこの値を更新することで、
   * testPlay() の可否が動的に制御される。
   *
   * @param state - 新しいスケジューラ状態
   */
  setSchedulerState(state: SchedulerState): void {
    this._schedulerState = state
  }

  /**
   * 外部（アドレスバー等の第2書き手）による config 更新を内部状態に反映する。
   *
   * settings/main.ts の onUpdated から renderConfig() と並行して呼ぶこと。
   * これを呼ばないと _config が stale のままになり、次の toggleLoop() 等が
   * 古い値を使って誤った更新を送信してしまう（§2.7 CRITICAL）。
   *
   * @param config - 外部から通知された最新の Config
   */
  applyExternalConfig(config: Config): void {
    this._config = config
  }

  // ─── 内部ヘルパー ────────────────────────────────────────────────────────

  /**
   * IPC経由で設定を部分更新し、返却された Config を内部状態に適用する。
   * IPC側が null を返した場合（検証拒否 / 保存エラー）は内部状態を変更しない。
   *
   * @param patch - 更新する設定の部分オブジェクト
   * @returns 更新後の Config、または null
   */
  private async _saveAndApply(patch: Partial<Config>): Promise<Config | null> {
    const updated = await this.bridge.updateConfig(patch)
    if (updated !== null) {
      this._config = updated
    }
    return updated
  }
}
