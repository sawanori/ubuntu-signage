/**
 * T11 — src/main/config.ts
 *
 * ConfigManager: electron-store ラッパー
 *
 * 責務:
 *   - 初回起動時に既定値（DEFAULT_CONFIG）を生成・永続化する
 *   - 既存 config を読み込み、zod ConfigSchema で検証する
 *   - JSON 破損時は .corrupt-<ts> に退避し、既定値にリセットする
 *   - 型不正なフィールドは既定値で補完し、WARN ログを出す
 *   - 保存は electron-store のアトミック書き込みに委譲する（自前 temp→rename は実装しない）
 *   - settings:update 相当の applyUpdate() で ConfigUpdateSchema による不正拒否 + WARN ログ
 *
 * 設計方針:
 *   - StoreAdapter インターフェースで electron-store を抽象化（テストで DI 注入可能）
 *   - electron-store@11 と zod v4 互換のため、store 読込後に自前で zod parse して検証
 *     （store 内部スキーマには依存しない）
 *   - ConfigLogger インターフェースで logger を抽象化（テストでモック注入可能）
 */

import { renameSync, existsSync, statSync } from 'node:fs'
import { ConfigSchema, ConfigUpdateSchema } from '../shared/schema'
import type { Config } from '../shared/types'

// ─── 既定値 ───────────────────────────────────────────────────────────────────

/**
 * アプリの初期設定値。
 * config.json が存在しない・破損している・型不正のフィールドがある場合に使用される。
 *
 * siteUrl = '' (空文字) は「未設定」を表し、スタート画面を表示する。
 */
export const DEFAULT_CONFIG: Config = {
  siteUrl: '',
  videoFolderPath: '',
  intervalMinutes: 5,
  loopEnabled: true,
  /** 現状未配線（CSS は 2000ms 固定、styles.css 参照）。本フィールドはランタイム未読込 */
  fadeDurationMs: 1000,
} as const satisfies Config

// ─── インターフェース ──────────────────────────────────────────────────────────

/**
 * electron-store の最小インターフェース。
 * テストでは DI でモックを注入し、本番では ElectronStore インスタンスを使用する。
 */
export interface StoreAdapter {
  /** ストアファイルの絶対パス */
  readonly path: string
  /** ストア全体のデータ（読み書き可能） */
  store: Record<string, unknown>
  /** ストアを初期状態にリセットする */
  clear(): void
}

/**
 * 構造化ログのインターフェース。
 * テストではモックを注入し、本番では console/electron-log などに差し替える。
 */
export interface ConfigLogger {
  error(event: string, meta?: Record<string, unknown>): void
  warn(event: string, meta?: Record<string, unknown>): void
}

/**
 * ファイルシステム検査のインターフェース。
 * テストでは DI でモックを注入し、本番では node:fs を使用する。
 *
 * 注意: ネットワークマウントや可搬ドライブは一時的に不在になり得る。
 * apply 時に存在しない場合は拒否するが、その後マウントされた場合は
 * 再度 settings:update を送信して反映させること。
 */
export interface ConfigFsAdapter {
  /** path が存在するディレクトリかどうかを確認する */
  isDirectory(path: string): boolean
}

const defaultFsAdapter: ConfigFsAdapter = {
  isDirectory(path: string): boolean {
    try {
      return existsSync(path) && statSync(path).isDirectory()
    } catch {
      return false
    }
  },
}

// ─── デフォルトロガー実装 ─────────────────────────────────────────────────────

const defaultLogger: ConfigLogger = {
  error(event, meta) {
    process.stderr.write(
      JSON.stringify({ level: 'ERROR', event, ...meta }) + '\n'
    )
  },
  warn(event, meta) {
    process.stdout.write(
      JSON.stringify({ level: 'WARN', event, ...meta }) + '\n'
    )
  },
}

// ─── ConfigManager クラス ─────────────────────────────────────────────────────

/**
 * アプリ設定の読み書きを管理するクラス。
 *
 * @example
 * // 本番での使用（createConfigManager ファクトリ経由）
 * const manager = createConfigManager()
 * const config = manager.load()
 *
 * @example
 * // テストでの使用（DI でモックを注入）
 * const manager = new ConfigManager(mockStore, mockLogger)
 */
export class ConfigManager {
  private _current: Config = { ...DEFAULT_CONFIG }

  constructor(
    private readonly store: StoreAdapter,
    private readonly logger: ConfigLogger = defaultLogger,
    private readonly fsAdapter: ConfigFsAdapter = defaultFsAdapter
  ) {}

  /**
   * 現在メモリに保持している設定のコピーを返す。
   * load() を呼ぶ前は DEFAULT_CONFIG と同じ値になる。
   */
  get current(): Config {
    return { ...this._current }
  }

  /**
   * ストアから設定を読み込んで返す。
   *
   * 処理フロー:
   * 1. store.store を読み込む（失敗した場合は JSON 破損として処理）
   * 2. zod ConfigSchema で全フィールドを検証する
   * 3. 完全に有効な場合はそのまま返す
   * 4. 空ストア（初回起動）の場合は既定値を書き込んで返す
   * 5. 一部フィールドが不正な場合は既定値で補完して返す
   */
  load(): Config {
    let raw: unknown

    // ── ステップ1: ストア読み込み（JSON 破損検出）────────────────────────────
    try {
      raw = this.store.store
    } catch (e) {
      // SyntaxError などで JSON が破損している場合
      const ts = Date.now()
      const corruptPath = `${this.store.path}.corrupt-${ts}`

      try {
        renameSync(this.store.path, corruptPath)
      } catch (renameErr) {
        // rename 失敗（権限なし・ファイル消失等）を WARN ログに記録
        this.logger.warn('config.corruptRenameFailed', {
          event: 'config.corruptRenameFailed',
          corruptPath,
          reason: renameErr instanceof Error ? renameErr.message : String(renameErr),
        })
      }

      this.logger.error('config.corrupt', {
        event: 'config.corrupt',
        path: this.store.path,
        corruptPath,
        reason: e instanceof Error ? e.message : String(e),
      })

      this._current = { ...DEFAULT_CONFIG }
      return { ...this._current }
    }

    // ── ステップ2: zod による完全検証 ────────────────────────────────────────
    const result = ConfigSchema.safeParse(raw)

    if (result.success) {
      // 完全に有効な config → そのまま使用
      this._current = result.data
      return { ...this._current }
    }

    // ── ステップ3: 空ストア（初回起動）の処理 ────────────────────────────────
    const rawObj: Record<string, unknown> =
      typeof raw === 'object' && raw !== null
        ? (raw as Record<string, unknown>)
        : {}

    if (Object.keys(rawObj).length === 0) {
      // 初回起動: 既定値を永続化して返す
      this._current = { ...DEFAULT_CONFIG }
      try {
        this.store.store = { ...this._current }
      } catch (e) {
        // 書き込み失敗を ERROR ログに記録し、呼び出し側がログから検知できるようにする
        this.logger.error('config.initialWriteFailed', {
          event: 'config.initialWriteFailed',
          reason: e instanceof Error ? e.message : String(e),
        })
      }
      return { ...this._current }
    }

    // ── ステップ4: 一部フィールドが不正な場合の部分補完 ──────────────────────
    const merged: Record<string, unknown> = { ...rawObj }

    // zod のエラーパスからフィールド名を抽出して既定値で補完する
    const fixedFields = new Set<string>()
    for (const issue of result.error.issues) {
      const pathHead = issue.path[0]
      if (pathHead === undefined) continue
      const field = String(pathHead)
      if (fixedFields.has(field)) continue // 同じフィールドへの二重ログを防止
      fixedFields.add(field)

      merged[field] = DEFAULT_CONFIG[field as keyof Config]

      // フィールドが存在するが型不正だった場合のみ WARN ログを出す
      if (field in rawObj) {
        this.logger.warn('config.fieldFixed', {
          event: 'config.fieldFixed',
          field,
        })
      }
    }

    // 完全に欠落しているフィールドも既定値で補完する（ログなし）
    for (const key of Object.keys(DEFAULT_CONFIG) as (keyof Config)[]) {
      if (!(key in merged)) {
        merged[key] = DEFAULT_CONFIG[key]
      }
    }

    // 補完後に再検証して _current を確定する
    const finalResult = ConfigSchema.safeParse(merged)
    this._current = finalResult.success ? finalResult.data : { ...DEFAULT_CONFIG }

    return { ...this._current }
  }

  /**
   * 設定をストアへ保存する。
   * @returns 保存成功時は true、失敗時は false（ERROR ログを出力）
   */
  save(config: Config): boolean {
    try {
      this.store.store = { ...(config as unknown as Record<string, unknown>) }
      this._current = { ...config }
      return true
    } catch (e) {
      this.logger.error('config.saveFailed', {
        event: 'config.saveFailed',
        reason: e instanceof Error ? e.message : String(e),
      })
      return false
    }
  }

  /**
   * 設定の部分更新を適用する。
   * ConfigUpdateSchema（zod）で payload を検証し、不正な値は拒否する。
   *
   * @param update - 更新する設定の部分オブジェクト（検証前の unknown 型）
   * @returns 更新後の Config、または検証失敗時は null
   */
  applyUpdate(update: unknown): Config | null {
    const result = ConfigUpdateSchema.safeParse(update)

    if (!result.success) {
      this.logger.warn('settings.invalidUpdate', {
        event: 'settings.invalidUpdate',
        errors: result.error.issues.map((i) => ({
          path: i.path,
          message: i.message,
        })),
      })
      return null
    }

    // videoFolderPath が含まれる場合は存在するディレクトリであることを確認する。
    // 空文字（フォルダ未選択）は許容する。
    // ネットワークマウント等で一時的に不在になり得るが、設定パネルはダイアログで
    // 実在フォルダを選ぶ前提のため apply 時に存在検証を行うのが妥当。
    const newFolderPath = result.data.videoFolderPath
    if (newFolderPath !== undefined && newFolderPath !== '') {
      if (!this.fsAdapter.isDirectory(newFolderPath)) {
        this.logger.warn('settings.invalidUpdate', {
          event: 'settings.invalidUpdate',
          reason: 'videoFolderPath does not exist or is not a directory',
          videoFolderPath: newFolderPath,
        })
        return null
      }
    }

    const newConfig: Config = { ...this._current, ...result.data }
    const saved = this.save(newConfig)
    if (!saved) return null
    return { ...this._current }
  }
}

// ─── マイグレーション関数 ─────────────────────────────────────────────────────

/**
 * レガシーな siteUrl プレースホルダを未設定（空文字）へ移行する。
 * 既存ユーザーの config.json に 'http://localhost:8080' が永続化されている場合に適用。
 *
 * @param config - 現在の設定
 * @param configManager - 設定マネージャ（applyUpdate 経由で保存する）
 * @returns マイグレーション後の Config（変更なしの場合は引数をそのまま返す）
 *
 * @example
 * // ⚠️ CRITICAL: const → let に変更し、移行後の値を必ず再代入する
 * let config = configManager.load()
 * config = migrateLegacySiteUrl(config, configManager)
 */
export function migrateLegacySiteUrl(
  config: Config,
  configManager: ConfigManager
): Config {
  const LEGACY_PLACEHOLDER = 'http://localhost:8080'
  // FIX SET CHANGE 4: 末尾スラッシュあり（'http://localhost:8080/'）も対象に含める
  const normalizedSiteUrl = config.siteUrl.replace(/\/$/, '')
  if (normalizedSiteUrl !== LEGACY_PLACEHOLDER) return config
  const migrated = configManager.applyUpdate({ siteUrl: '' })
  if (migrated === null) {
    // applyUpdate 失敗（ありえないが CRITICAL: サイレント障害にしない）
    // config は変更せずそのまま使い、did-fail-load フォールバックで救済する
    return config
  }
  return migrated
}

// ─── 本番用ファクトリ関数 ─────────────────────────────────────────────────────

/**
 * 本番環境用の ConfigManager を生成するファクトリ関数。
 * electron-store を動的に require することで、テスト環境での electron 依存を回避する。
 *
 * テストでは直接 `new ConfigManager(mockStore)` を使用すること。
 */
export function createConfigManager(logger?: ConfigLogger, fsAdapter?: ConfigFsAdapter): ConfigManager {
  // テスト環境では呼ばれないため、ここで electron-store を動的 require する
  const ElectronStore = (
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require('electron-store') as {
      default: new (options: { name: string }) => StoreAdapter
    }
  ).default
  const store = new ElectronStore({ name: 'config' })
  return new ConfigManager(store, logger, fsAdapter)
}
