/**
 * src/main/input-coordinator.ts — T21/T22
 *
 * 入力ロジック:
 *   (1) 隅 3 回タップカウンタ (T22)
 *       いずれかの隅で 1.5 秒以内に 3 回タップ → 設定パネルをトグル。
 *       時間窓外はカウントリセット（スライディングウィンドウ方式）。
 *
 *   (2) globalShortcut (Ctrl+G) 登録ラッパ (T21)
 *       登録/解除・開閉トグル・多重起動防止・Wayland 非対応認識。
 *       Wayland 環境では登録をスキップし、隅 3 タップが唯一・常設の正規経路となる。
 *
 * 実 globalShortcut / hotspotView の main 結線は別モジュール（表示環境が必要）。
 * このモジュールはロジックのみを担い、純粋に単体テスト可能。
 * タイマーとして Date.now() を使用（vitest fake timers でモック可能）。
 */

export interface InputCoordinatorLogger {
  warn(event: string, data?: Record<string, unknown>): void
  debug(event: string, data?: Record<string, unknown>): void
}

export interface GlobalShortcutAdapter {
  /** ショートカットを登録し、成功した場合は true を返す */
  register(accelerator: string, callback: () => void): boolean
  /** ショートカットを解除する */
  unregister(accelerator: string): void
}

export interface InputCoordinatorOptions {
  /** 設定パネルを開く */
  onOpenSettings: () => void
  /** 設定パネルを閉じる */
  onCloseSettings: () => void
  /** 設定パネルが現在開いているか返す */
  isSettingsOpen: () => boolean
  /** Electron の globalShortcut をラップしたアダプタ（テスト時はモックを注入） */
  globalShortcut: GlobalShortcutAdapter
  /** 構造化ロガー */
  logger: InputCoordinatorLogger
  /**
   * Wayland 環境か（true なら Ctrl+G / Ctrl+L 登録をスキップ）。
   * デフォルト false（X11 想定）。
   */
  isWayland?: boolean
  /** タップの時間窓 (ms)。デフォルト 1500 */
  tapWindowMs?: number
  /** 発火に必要なタップ数。デフォルト 3 */
  requiredTaps?: number
  /**
   * アドレスバーをトグルするコールバック（Ctrl+L / 上部中央ゾーンタップ時に呼ばれる）。
   * 省略可（未定義の場合は no-op）。
   */
  onToggleAddressBar?: () => void
  /**
   * Ctrl+Q 押下時に呼ばれるコールバック（QuitCoordinator.requestQuit() を想定）。
   * 省略可（未定義の場合は no-op）。
   */
  onQuit?: () => void
}

/**
 * 入力イベント（隅タップ・Ctrl+G ショートカット）を一元管理するコーディネータ。
 *
 * 設計方針:
 * - 外部依存（globalShortcut / isSettingsOpen 等）はコンストラクタで注入（DI）
 * - Date.now() を直接使用（vitest fake timers でモック可能）
 * - Electron API に直接依存しない（テスト可能性を保つ）
 */
export class InputCoordinator {
  private readonly onOpenSettings: () => void
  private readonly onCloseSettings: () => void
  private readonly isSettingsOpen: () => boolean
  private readonly globalShortcut: GlobalShortcutAdapter
  private readonly logger: InputCoordinatorLogger
  private readonly isWayland: boolean
  private readonly tapWindowMs: number
  private readonly requiredTaps: number
  private readonly onToggleAddressBar?: () => void
  private readonly onQuit?: () => void

  /** Ctrl+G が現在登録済みか */
  private shortcutRegistered = false
  /** Ctrl+L が現在登録済みか */
  private addressBarShortcutRegistered = false
  /** Ctrl+Q が現在登録済みか */
  private quitShortcutRegistered = false
  /** タップのタイムスタンプ履歴（スライディングウィンドウ） */
  private tapTimestamps: number[] = []

  constructor(options: InputCoordinatorOptions) {
    this.onOpenSettings = options.onOpenSettings
    this.onCloseSettings = options.onCloseSettings
    this.isSettingsOpen = options.isSettingsOpen
    this.globalShortcut = options.globalShortcut
    this.logger = options.logger
    this.isWayland = options.isWayland ?? false
    this.tapWindowMs = options.tapWindowMs ?? 1500
    this.requiredTaps = options.requiredTaps ?? 3
    this.onToggleAddressBar = options.onToggleAddressBar
    this.onQuit = options.onQuit
  }

  /**
   * Ctrl+G globalShortcut を登録する。
   *
   * - Wayland 環境では登録をスキップし WARN ログを出す。
   *   （隅 3 タップが Wayland での唯一・常設の正規経路）
   * - 二重登録を防止する（既に登録済みなら no-op）。
   * - 登録失敗時は WARN ログを出す。
   */
  registerShortcut(): void {
    if (this.isWayland) {
      this.logger.warn('input.shortcutSkipped', {
        reason: 'wayland',
        accelerator: 'Control+G',
      })
      return
    }
    if (this.shortcutRegistered) {
      return
    }
    const success = this.globalShortcut.register('Control+G', () => {
      this.toggleSettings()
    })
    if (success) {
      this.shortcutRegistered = true
    } else {
      this.logger.warn('input.shortcutRegisterFailed', { accelerator: 'Control+G' })
    }
  }

  /**
   * Ctrl+G globalShortcut を解除する。
   * 登録されていない場合は no-op。
   */
  unregisterShortcut(): void {
    if (!this.shortcutRegistered) return
    this.globalShortcut.unregister('Control+G')
    this.shortcutRegistered = false
  }

  /**
   * 隅タップを記録する。
   *
   * tapWindowMs 以内に requiredTaps 回タップされたら設定パネルをトグルする。
   * 時間窓外のタップはカウントから除外（スライディングウィンドウ方式）。
   * トグル実行後はカウンタをリセットする。
   */
  recordTap(): void {
    const now = Date.now()
    // 時間窓外のタイムスタンプを除去（スライディングウィンドウ）
    this.tapTimestamps = this.tapTimestamps.filter((t) => now - t < this.tapWindowMs)
    this.tapTimestamps.push(now)

    if (this.tapTimestamps.length >= this.requiredTaps) {
      this.tapTimestamps = []
      this.toggleSettings()
    }
  }

  /**
   * Ctrl+L globalShortcut を登録する。
   *
   * - Wayland 環境では登録をスキップし WARN ログを出す。
   *   （上部中央ゾーンタップが Wayland での唯一・常設の正規経路）
   * - 二重登録を防止する（既に登録済みなら no-op）。
   * - 登録失敗時は WARN ログを出す。
   */
  registerAddressBarShortcut(): void {
    if (this.isWayland) {
      this.logger.warn('input.shortcutSkipped', {
        reason: 'wayland',
        accelerator: 'Control+L',
      })
      return
    }
    if (this.addressBarShortcutRegistered) {
      return
    }
    const success = this.globalShortcut.register('Control+L', () => {
      this.onToggleAddressBar?.()
    })
    if (success) {
      this.addressBarShortcutRegistered = true
    } else {
      this.logger.warn('input.shortcutRegisterFailed', { accelerator: 'Control+L' })
    }
  }

  /**
   * Ctrl+L globalShortcut を解除する。
   * 登録されていない場合は no-op。
   */
  unregisterAddressBarShortcut(): void {
    if (!this.addressBarShortcutRegistered) return
    this.globalShortcut.unregister('Control+L')
    this.addressBarShortcutRegistered = false
  }

  /**
   * 上部中央ゾーン単一タップ → アドレスバートグル。
   * カウント不要（専用ゾーン）。即座に onToggleAddressBar() を呼ぶ。
   * onToggleAddressBar が未定義の場合は no-op（TypeError なし）。
   */
  toggleAddressBarZone(): void {
    this.onToggleAddressBar?.()
  }

  /**
   * Ctrl+Q globalShortcut を登録する。
   *
   * Ctrl+G / Ctrl+L と同一パターン:
   * - Wayland 環境では登録をスキップし WARN ログを出す。
   * - 二重登録を防止する（既に登録済みなら no-op）。
   * - 登録失敗時は WARN ログを出す。
   * - コールバック発火時は onQuit() を呼ぶ（未定義の場合は no-op）。
   */
  registerQuitShortcut(): void {
    if (this.isWayland) {
      this.logger.warn('input.shortcutSkipped', {
        reason: 'wayland',
        accelerator: 'Control+Q',
      })
      return
    }
    if (this.quitShortcutRegistered) {
      return
    }
    const success = this.globalShortcut.register('Control+Q', () => {
      this.onQuit?.()
    })
    if (success) {
      this.quitShortcutRegistered = true
    } else {
      this.logger.warn('input.shortcutRegisterFailed', { accelerator: 'Control+Q' })
    }
  }

  /**
   * Ctrl+Q globalShortcut を解除する。
   * 登録されていない場合は no-op。
   */
  unregisterQuitShortcut(): void {
    if (!this.quitShortcutRegistered) return
    this.globalShortcut.unregister('Control+Q')
    this.quitShortcutRegistered = false
  }

  /**
   * 右クリック（コンテキストメニュー）経由で設定パネルを開く。
   * Ctrl+G / 隅3タップに加わる第3の開き方。既に開いている場合は no-op（多重 open 防止）。
   * トグルではなく「開く」専用: 表示中は最前面 settingsView が右クリックを受けるため、
   * 閉じる操作は ✕ ボタン / Ctrl+G / 隅3タップに委ねる。
   */
  openSettingsByContextMenu(): void {
    if (!this.isSettingsOpen()) {
      this.onOpenSettings()
    }
  }

  /**
   * 設定パネルをトグルする。
   * - 既に開いている場合: 閉じる（多重起動防止）
   * - 閉じている場合: 開く
   */
  private toggleSettings(): void {
    if (this.isSettingsOpen()) {
      this.onCloseSettings()
    } else {
      this.onOpenSettings()
    }
  }
}
