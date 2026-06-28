/**
 * T11 — config.test.ts
 *
 * UC-01: 初回起動（空ストア）→ 既定値返却 + ストア書き込み
 * UC-02: 有効な config.json が存在 → ファイルの値が返る
 * UC-03: JSON 破損 → .corrupt-<ts> 退避 + 既定値リセット + ERROR ログ
 * UC-04: 型不正フィールド → zod で既定値補完 + WARN ログ
 * UC-05: save() → electron-store のアトミック保存に委譲
 * UC-06: save() + load() ラウンドトリップ → 保存値が正確に復元
 * + 不正 update 拒否: applyUpdate() が ConfigUpdateSchema で不正を拒否
 *
 * electron と fs はモック。ConfigManager は DI で StoreAdapter を受け取る。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ─── fs モック（vi.mock は巻き上げられるため import より前に有効になる） ─────
vi.mock('node:fs', () => ({
  renameSync: vi.fn(),
  existsSync: vi.fn(() => true),
  statSync: vi.fn(() => ({ isDirectory: () => true })),
}))

// ─── electron モック（electron-store が間接的に参照する場合のフォールバック） ─
vi.mock('electron', () => ({
  default: {
    app: {
      getPath: vi.fn(() => '/tmp/mock-userData'),
      getVersion: vi.fn(() => '0.0.0'),
      isReady: vi.fn(() => true),
    },
    ipcMain: { on: vi.fn(), handle: vi.fn() },
    shell: {},
  },
  app: {
    getPath: vi.fn(() => '/tmp/mock-userData'),
    getVersion: vi.fn(() => '0.0.0'),
    isReady: vi.fn(() => true),
  },
  ipcMain: { on: vi.fn(), handle: vi.fn() },
  shell: {},
}))

import { renameSync } from 'node:fs'
import {
  ConfigManager,
  DEFAULT_CONFIG,
  migrateLegacySiteUrl,
  type StoreAdapter,
  type ConfigLogger,
  type ConfigFsAdapter,
} from '../../src/main/config'
import type { Config } from '../../src/shared/types'

// ─── テスト用フィクスチャ ──────────────────────────────────────────────────────

const STORE_PATH = '/tmp/mock-userData/config.json'

/** 有効な設定（DEFAULT_CONFIG とは異なる値を使用して差分を確認しやすくする） */
const VALID_CONFIG: Config = {
  siteUrl: 'https://example.com/signage',
  videoFolderPath: '/home/user/videos',
  intervalMinutes: 10,
  loopEnabled: false,
  fadeDurationMs: 800,
}

// ─── モックファクトリ ──────────────────────────────────────────────────────────

/**
 * テスト用のモックストアを作成する。
 * `throwOnRead` が指定されると store ゲッター読み取り時に例外を投げる。
 */
function makeMockStore(opts: {
  initialData?: Record<string, unknown>
  throwOnRead?: Error
  path?: string
}): StoreAdapter & {
  /** テスト用: 現在のストアデータを返す */
  getData(): Record<string, unknown>
} {
  let storeData: Record<string, unknown> = { ...(opts.initialData ?? {}) }
  const throwOnRead = opts.throwOnRead ?? null

  const mock = {
    path: opts.path ?? STORE_PATH,
    clear: vi.fn(() => {
      storeData = {}
    }),
    getData(): Record<string, unknown> {
      return storeData
    },
  }

  Object.defineProperty(mock, 'store', {
    get(): Record<string, unknown> {
      if (throwOnRead) throw throwOnRead
      return storeData
    },
    set(value: Record<string, unknown>): void {
      storeData = { ...value }
    },
    configurable: true,
    enumerable: true,
  })

  return mock as StoreAdapter & { getData(): Record<string, unknown> }
}

/**
 * テスト用のモックロガーを作成する。
 */
function makeMockLogger(): ConfigLogger & {
  error: ReturnType<typeof vi.fn>
  warn: ReturnType<typeof vi.fn>
} {
  return {
    error: vi.fn(),
    warn: vi.fn(),
  }
}

// ─── テスト本体 ───────────────────────────────────────────────────────────────

describe('ConfigManager', () => {
  let logger: ReturnType<typeof makeMockLogger>

  beforeEach(() => {
    logger = makeMockLogger()
    vi.mocked(renameSync).mockReset()
  })

  // ──────────────────────────────────────────────────────────────────────────
  // UC-01: 初回起動 — 空ストア → 既定値返却 + ストア書き込み
  // ──────────────────────────────────────────────────────────────────────────
  describe('UC-01: 初回起動（空ストア）', () => {
    it('空のストアの場合に DEFAULT_CONFIG を返す', () => {
      const store = makeMockStore({ initialData: {} })
      const manager = new ConfigManager(store, logger)
      const config = manager.load()
      expect(config).toEqual(DEFAULT_CONFIG)
    })

    it('初回起動時に既定値をストアへ書き込む（config.json を生成する）', () => {
      const store = makeMockStore({ initialData: {} })
      const manager = new ConfigManager(store, logger)
      manager.load()
      expect(store.getData()).toEqual(DEFAULT_CONFIG)
    })

    it('初回起動時に warn / error ログを出力しない', () => {
      const store = makeMockStore({ initialData: {} })
      const manager = new ConfigManager(store, logger)
      manager.load()
      expect(logger.warn).not.toHaveBeenCalled()
      expect(logger.error).not.toHaveBeenCalled()
    })

    it('初回書き込みが失敗した場合に ERROR ログ "config.initialWriteFailed" を出力する', () => {
      const store = makeMockStore({ initialData: {} })
      // store.store setter が例外を投げるように再定義
      Object.defineProperty(store, 'store', {
        get(): Record<string, unknown> {
          return {}
        },
        set(_v: Record<string, unknown>): void {
          throw new Error('ENOSPC: disk full')
        },
        configurable: true,
      })
      const manager = new ConfigManager(store, logger)
      const config = manager.load()

      // 既定値は返される（in-memory は有効）
      expect(config).toEqual(DEFAULT_CONFIG)
      // ERROR ログが出力されている
      expect(logger.error).toHaveBeenCalledOnce()
      const calls = vi.mocked(logger.error).mock.calls
      const firstCall = calls[0]
      expect(firstCall).toBeDefined()
      if (!firstCall) return
      const [event] = firstCall as [string, ...unknown[]]
      expect(event).toBe('config.initialWriteFailed')
    })
  })

  // ──────────────────────────────────────────────────────────────────────────
  // UC-02: 有効な config.json が存在 → ファイルの値が返る
  // ──────────────────────────────────────────────────────────────────────────
  describe('UC-02: 有効な config を復元する', () => {
    it('有効なストアの場合にその値をそのまま返す', () => {
      const store = makeMockStore({ initialData: { ...VALID_CONFIG } })
      const manager = new ConfigManager(store, logger)
      const config = manager.load()
      expect(config).toEqual(VALID_CONFIG)
    })

    it('有効な config の場合はログを出力しない', () => {
      const store = makeMockStore({ initialData: { ...VALID_CONFIG } })
      const manager = new ConfigManager(store, logger)
      manager.load()
      expect(logger.warn).not.toHaveBeenCalled()
      expect(logger.error).not.toHaveBeenCalled()
    })
  })

  // ──────────────────────────────────────────────────────────────────────────
  // UC-03: JSON 破損 → .corrupt-<ts> 退避 + 既定値リセット + ERROR ログ
  // ──────────────────────────────────────────────────────────────────────────
  describe('UC-03: JSON 破損 → .corrupt 退避 + 既定値リセット', () => {
    it('ストア読み込み時に例外が発生した場合に DEFAULT_CONFIG を返す', () => {
      const store = makeMockStore({
        throwOnRead: new SyntaxError('Unexpected token'),
      })
      const manager = new ConfigManager(store, logger)
      const config = manager.load()
      expect(config).toEqual(DEFAULT_CONFIG)
    })

    it('破損ファイルを .corrupt-<ts> へリネームする', () => {
      const store = makeMockStore({
        throwOnRead: new SyntaxError('bad json'),
        path: STORE_PATH,
      })
      const manager = new ConfigManager(store, logger)
      manager.load()

      expect(vi.mocked(renameSync)).toHaveBeenCalledOnce()
      const args = vi.mocked(renameSync).mock.calls[0]
      expect(args).toBeDefined()
      if (!args) return
      const [src, dest] = args as [string, string]
      expect(src).toBe(STORE_PATH)
      // dest は "<path>.corrupt-<数値タイムスタンプ>" の形式
      expect(dest).toMatch(/^\/tmp\/mock-userData\/config\.json\.corrupt-\d+$/)
    })

    it('ERROR ログを出力する', () => {
      const store = makeMockStore({
        throwOnRead: new SyntaxError('bad json'),
      })
      const manager = new ConfigManager(store, logger)
      manager.load()
      expect(logger.error).toHaveBeenCalledOnce()
    })

    it('ERROR ログのイベント名は "config.corrupt" を含む', () => {
      const store = makeMockStore({
        throwOnRead: new SyntaxError('bad json'),
      })
      const manager = new ConfigManager(store, logger)
      manager.load()

      const calls = vi.mocked(logger.error).mock.calls
      expect(calls.length).toBeGreaterThan(0)
      const firstCall = calls[0]
      expect(firstCall).toBeDefined()
      if (!firstCall) return

      const [eventOrMeta, meta] = firstCall as [string, Record<string, unknown>?]
      // event が第一引数にある場合
      const hasEvent =
        eventOrMeta === 'config.corrupt' ||
        (typeof meta === 'object' && meta !== null && meta['event'] === 'config.corrupt')
      expect(hasEvent).toBe(true)
    })
  })

  // ──────────────────────────────────────────────────────────────────────────
  // UC-04: 型不正フィールド → zod で既定値補完 + WARN ログ
  // ──────────────────────────────────────────────────────────────────────────
  describe('UC-04: 型不正フィールド → zod 補完 + WARN ログ', () => {
    const dataWithBadInterval = {
      ...VALID_CONFIG,
      intervalMinutes: 'abc', // 不正な型（stringだがnumber | literalが期待される）
    }

    it('不正フィールドを既定値で補完したコンフィグを返す', () => {
      const store = makeMockStore({ initialData: dataWithBadInterval })
      const manager = new ConfigManager(store, logger)
      const config = manager.load()
      expect(config.intervalMinutes).toBe(DEFAULT_CONFIG.intervalMinutes)
    })

    it('不正でないフィールドはストアの値を維持する', () => {
      const store = makeMockStore({ initialData: dataWithBadInterval })
      const manager = new ConfigManager(store, logger)
      const config = manager.load()
      expect(config.siteUrl).toBe(VALID_CONFIG.siteUrl)
      expect(config.videoFolderPath).toBe(VALID_CONFIG.videoFolderPath)
      expect(config.loopEnabled).toBe(VALID_CONFIG.loopEnabled)
      expect(config.fadeDurationMs).toBe(VALID_CONFIG.fadeDurationMs)
    })

    it('WARN ログを出力する', () => {
      const store = makeMockStore({ initialData: dataWithBadInterval })
      const manager = new ConfigManager(store, logger)
      manager.load()
      expect(vi.mocked(logger.warn)).toHaveBeenCalled()
    })

    it('WARN ログに event: "config.fieldFixed" を含む', () => {
      const store = makeMockStore({ initialData: dataWithBadInterval })
      const manager = new ConfigManager(store, logger)
      manager.load()

      const warnCalls = vi.mocked(logger.warn).mock.calls
      const fieldFixedCall = warnCalls.find(([, meta]) => {
        const m = meta as Record<string, unknown> | undefined
        return m?.['event'] === 'config.fieldFixed'
      })
      expect(fieldFixedCall).toBeDefined()
    })

    it('WARN ログに field: "intervalMinutes" を含む', () => {
      const store = makeMockStore({ initialData: dataWithBadInterval })
      const manager = new ConfigManager(store, logger)
      manager.load()

      const warnCalls = vi.mocked(logger.warn).mock.calls
      const fieldNameCall = warnCalls.find(([, meta]) => {
        const m = meta as Record<string, unknown> | undefined
        return m?.['field'] === 'intervalMinutes'
      })
      expect(fieldNameCall).toBeDefined()
    })
  })

  // ──────────────────────────────────────────────────────────────────────────
  // UC-05: save() → electron-store のアトミック保存に委譲
  // ──────────────────────────────────────────────────────────────────────────
  describe('UC-05: save() がストアへ書き込む', () => {
    it('save() 後にストアデータが保存した config と一致する', () => {
      const store = makeMockStore({ initialData: { ...DEFAULT_CONFIG } })
      const manager = new ConfigManager(store, logger)
      manager.load()
      manager.save(VALID_CONFIG)
      expect(store.getData()).toMatchObject(VALID_CONFIG)
    })

    it('save() 成功時に ERROR ログを出力しない', () => {
      const store = makeMockStore({ initialData: {} })
      const manager = new ConfigManager(store, logger)
      manager.load()
      manager.save(VALID_CONFIG)
      expect(logger.error).not.toHaveBeenCalled()
    })

    it('ストア書き込みが失敗した場合に ERROR ログを出力する', () => {
      const store = makeMockStore({ initialData: {} })
      // store.store setter が例外を投げるように再定義
      Object.defineProperty(store, 'store', {
        get(): Record<string, unknown> {
          return {}
        },
        set(_v: Record<string, unknown>): void {
          throw new Error('ENOSPC: disk full')
        },
        configurable: true,
      })
      const manager = new ConfigManager(store, logger)
      manager.save(VALID_CONFIG)
      expect(vi.mocked(logger.error)).toHaveBeenCalledOnce()

      const calls = vi.mocked(logger.error).mock.calls
      const firstCall = calls[0]
      if (!firstCall) return
      const [event] = firstCall as [string, ...unknown[]]
      expect(event).toBe('config.saveFailed')
    })
  })

  // ──────────────────────────────────────────────────────────────────────────
  // UC-06: save() + load() ラウンドトリップ → 保存した値が正確に復元される
  // ──────────────────────────────────────────────────────────────────────────
  describe('UC-06: save() + load() ラウンドトリップ', () => {
    it('save() した直後に load() を呼ぶと保存した値が返る', () => {
      const store = makeMockStore({ initialData: {} })
      const manager = new ConfigManager(store, logger)
      manager.load() // 初期化
      manager.save(VALID_CONFIG)
      const restored = manager.load()
      expect(restored).toEqual(VALID_CONFIG)
    })

    it('save() → load() ラウンドトリップで全フィールドが一致する', () => {
      const store = makeMockStore({ initialData: {} })
      const manager = new ConfigManager(store, logger)
      manager.load()

      const toSave: Config = {
        siteUrl: 'https://signage.example.org',
        videoFolderPath: '/srv/videos',
        intervalMinutes: 30,
        loopEnabled: true,
        fadeDurationMs: 500,
      }
      manager.save(toSave)
      const loaded = manager.load()

      expect(loaded.siteUrl).toBe(toSave.siteUrl)
      expect(loaded.videoFolderPath).toBe(toSave.videoFolderPath)
      expect(loaded.intervalMinutes).toBe(toSave.intervalMinutes)
      expect(loaded.loopEnabled).toBe(toSave.loopEnabled)
      expect(loaded.fadeDurationMs).toBe(toSave.fadeDurationMs)
    })
  })

  // ──────────────────────────────────────────────────────────────────────────
  // 不正 update 拒否: applyUpdate() が ConfigUpdateSchema で不正を拒否
  // ──────────────────────────────────────────────────────────────────────────
  describe('applyUpdate(): 不正な update を拒否する', () => {
    it('許可リスト外の intervalMinutes で null を返す', () => {
      const store = makeMockStore({ initialData: { ...VALID_CONFIG } })
      const manager = new ConfigManager(store, logger)
      manager.load()
      const result = manager.applyUpdate({ intervalMinutes: 7 })
      expect(result).toBeNull()
    })

    it('不正 update 時に WARN ログ event "settings.invalidUpdate" を出力する', () => {
      const store = makeMockStore({ initialData: { ...VALID_CONFIG } })
      const manager = new ConfigManager(store, logger)
      manager.load()
      manager.applyUpdate({ intervalMinutes: 7 })

      const warnCalls = vi.mocked(logger.warn).mock.calls
      const found = warnCalls.find(([, meta]) => {
        const m = meta as Record<string, unknown> | undefined
        return m?.['event'] === 'settings.invalidUpdate'
      })
      expect(found).toBeDefined()
    })

    it('不正 update 後に current の設定が変わらない', () => {
      const store = makeMockStore({ initialData: { ...VALID_CONFIG } })
      const manager = new ConfigManager(store, logger)
      manager.load()
      manager.applyUpdate({ intervalMinutes: 7 })
      expect(manager.current).toEqual(VALID_CONFIG)
    })

    it('不正な siteUrl スキームを拒否する（javascript://）', () => {
      const store = makeMockStore({ initialData: { ...VALID_CONFIG } })
      const manager = new ConfigManager(store, logger)
      manager.load()
      const result = manager.applyUpdate({ siteUrl: 'javascript://evil' })
      expect(result).toBeNull()
    })

    it('不正な siteUrl スキームを拒否する（ftp://）', () => {
      const store = makeMockStore({ initialData: { ...VALID_CONFIG } })
      const manager = new ConfigManager(store, logger)
      manager.load()
      const result = manager.applyUpdate({ siteUrl: 'ftp://ftp.example.com' })
      expect(result).toBeNull()
    })

    it('有効な update を受け入れて新しい config を返す', () => {
      const store = makeMockStore({ initialData: { ...VALID_CONFIG } })
      const manager = new ConfigManager(store, logger)
      manager.load()
      const result = manager.applyUpdate({ intervalMinutes: 15 })
      expect(result).not.toBeNull()
      expect(result?.intervalMinutes).toBe(15)
    })

    it('有効な update をストアに永続化する', () => {
      const store = makeMockStore({ initialData: { ...VALID_CONFIG } })
      const manager = new ConfigManager(store, logger)
      manager.load()
      manager.applyUpdate({ intervalMinutes: 30 })
      expect(store.getData()['intervalMinutes']).toBe(30)
    })

    it('空オブジェクトの update（全フィールド省略）を受け入れる', () => {
      const store = makeMockStore({ initialData: { ...VALID_CONFIG } })
      const manager = new ConfigManager(store, logger)
      manager.load()
      const result = manager.applyUpdate({})
      expect(result).not.toBeNull()
      expect(result).toEqual(VALID_CONFIG)
    })

    // ── (C) 不存在フォルダ拒否 ───────────────────────────────────────────────

    it('存在しない videoFolderPath を applyUpdate で指定すると null を返す', () => {
      const mockFs: ConfigFsAdapter = { isDirectory: vi.fn(() => false) }
      const store = makeMockStore({ initialData: { ...VALID_CONFIG } })
      const manager = new ConfigManager(store, logger, mockFs)
      manager.load()
      const result = manager.applyUpdate({ videoFolderPath: '/nonexistent/path' })
      expect(result).toBeNull()
    })

    it('存在しない videoFolderPath 指定時に WARN ログ "settings.invalidUpdate" を出力する', () => {
      const mockFs: ConfigFsAdapter = { isDirectory: vi.fn(() => false) }
      const store = makeMockStore({ initialData: { ...VALID_CONFIG } })
      const manager = new ConfigManager(store, logger, mockFs)
      manager.load()
      manager.applyUpdate({ videoFolderPath: '/nonexistent/path' })
      const warnCalls = vi.mocked(logger.warn).mock.calls
      const found = warnCalls.find(([, meta]) => {
        const m = meta as Record<string, unknown> | undefined
        return m?.['event'] === 'settings.invalidUpdate'
      })
      expect(found).toBeDefined()
    })

    it('実在するディレクトリの videoFolderPath は受け入れる', () => {
      const mockFs: ConfigFsAdapter = { isDirectory: vi.fn(() => true) }
      const store = makeMockStore({ initialData: { ...VALID_CONFIG } })
      const manager = new ConfigManager(store, logger, mockFs)
      manager.load()
      const result = manager.applyUpdate({ videoFolderPath: '/home/user/videos' })
      expect(result).not.toBeNull()
    })

    it('videoFolderPath が空文字の場合はフォルダ存在検証をスキップして受け入れる', () => {
      const mockFs: ConfigFsAdapter = { isDirectory: vi.fn(() => false) }
      const store = makeMockStore({ initialData: { ...VALID_CONFIG } })
      const manager = new ConfigManager(store, logger, mockFs)
      manager.load()
      const result = manager.applyUpdate({ videoFolderPath: '' })
      expect(result).not.toBeNull()
      expect(mockFs.isDirectory).not.toHaveBeenCalled()
    })

    it('videoFolderPath を含まない update はフォルダ存在検証をスキップする', () => {
      const mockFs: ConfigFsAdapter = { isDirectory: vi.fn(() => false) }
      const store = makeMockStore({ initialData: { ...VALID_CONFIG } })
      const manager = new ConfigManager(store, logger, mockFs)
      manager.load()
      const result = manager.applyUpdate({ intervalMinutes: 30 })
      expect(result).not.toBeNull()
      expect(mockFs.isDirectory).not.toHaveBeenCalled()
    })

    it('loopEnabled フィールドのみの update を受け入れる', () => {
      const store = makeMockStore({ initialData: { ...VALID_CONFIG } })
      const manager = new ConfigManager(store, logger)
      manager.load()
      const result = manager.applyUpdate({ loopEnabled: true })
      expect(result).not.toBeNull()
      expect(result?.loopEnabled).toBe(true)
    })

    it('applyUpdate でストア書き込みが失敗した場合に null を返す（検証拒否と区別可能）', () => {
      const store = makeMockStore({ initialData: { ...VALID_CONFIG } })
      const manager = new ConfigManager(store, logger)
      manager.load()

      // 書き込みが失敗するようにセッターを再定義
      let writeCount = 0
      Object.defineProperty(store, 'store', {
        get(): Record<string, unknown> {
          return { ...VALID_CONFIG }
        },
        set(_v: Record<string, unknown>): void {
          writeCount++
          throw new Error('ENOSPC: no space left on device')
        },
        configurable: true,
      })

      const result = manager.applyUpdate({ intervalMinutes: 15 })

      // save 失敗時は null を返す（検証拒否(null)と同じ値だが理由が異なる）
      expect(result).toBeNull()
      // ERROR ログが出力されている
      expect(writeCount).toBe(1)
      expect(logger.error).toHaveBeenCalled()
      const errorCalls = vi.mocked(logger.error).mock.calls
      const saveFailed = errorCalls.find(([event]) => event === 'config.saveFailed')
      expect(saveFailed).toBeDefined()
    })
  })
})

// ────────────────────────────────────────────────────────────────────────────────
// §5.3: DEFAULT_CONFIG 変更確認
// ────────────────────────────────────────────────────────────────────────────────

describe('DEFAULT_CONFIG', () => {
  it('siteUrl が空文字（未設定）であること', () => {
    expect(DEFAULT_CONFIG.siteUrl).toBe('')
  })
})

// ────────────────────────────────────────────────────────────────────────────────
// §5.4: migrateLegacySiteUrl — レガシー siteUrl のマイグレーション
// ────────────────────────────────────────────────────────────────────────────────

describe('migrateLegacySiteUrl', () => {
  const LEGACY_PLACEHOLDER = 'http://localhost:8080'

  const makeManagerWithUrl = (url: string) => {
    const config: Config = { ...VALID_CONFIG, siteUrl: url }
    const store = makeMockStore({ initialData: { ...config } })
    const log = makeMockLogger()
    const manager = new ConfigManager(store, log)
    manager.load()
    return { manager, store, log }
  }

  it('[正常] siteUrl が LEGACY_PLACEHOLDER のとき空文字に変換する', () => {
    const { manager } = makeManagerWithUrl(LEGACY_PLACEHOLDER)
    const config: Config = { ...VALID_CONFIG, siteUrl: LEGACY_PLACEHOLDER }
    const result = migrateLegacySiteUrl(config, manager)
    expect(result.siteUrl).toBe('')
  })

  it('[正常] siteUrl が LEGACY_PLACEHOLDER のとき applyUpdate({ siteUrl: \'\' }) を経由する', () => {
    const { manager } = makeManagerWithUrl(LEGACY_PLACEHOLDER)
    const config: Config = { ...VALID_CONFIG, siteUrl: LEGACY_PLACEHOLDER }
    migrateLegacySiteUrl(config, manager)
    // applyUpdate 後に configManager.current.siteUrl が '' になっていること
    expect(manager.current.siteUrl).toBe('')
  })

  it('[正常] siteUrl が LEGACY_PLACEHOLDER 以外のとき変更なしで返す', () => {
    const { manager } = makeManagerWithUrl('https://example.com')
    const config: Config = { ...VALID_CONFIG, siteUrl: 'https://example.com' }
    const result = migrateLegacySiteUrl(config, manager)
    expect(result).toBe(config) // 同一参照が返る
  })

  it('[正常] siteUrl が空文字のとき変更なしで返す', () => {
    const { manager } = makeManagerWithUrl('')
    const config: Config = { ...VALID_CONFIG, siteUrl: '' }
    const result = migrateLegacySiteUrl(config, manager)
    expect(result).toBe(config)
  })

  it('[異常] applyUpdate が null を返すとき元の config を返す（サイレント障害なし・CRITICAL）', () => {
    const { manager, store } = makeManagerWithUrl(LEGACY_PLACEHOLDER)
    // applyUpdate を強制的に失敗させる（ストア書き込みエラー）
    Object.defineProperty(store, 'store', {
      get(): Record<string, unknown> {
        return { ...VALID_CONFIG, siteUrl: LEGACY_PLACEHOLDER }
      },
      set(_v: Record<string, unknown>): void {
        throw new Error('ENOSPC: disk full')
      },
      configurable: true,
    })
    const config: Config = { ...VALID_CONFIG, siteUrl: LEGACY_PLACEHOLDER }
    const result = migrateLegacySiteUrl(config, manager)
    // 元の config が返る（マイグレーション失敗でも config は保持される）
    expect(result).toBe(config)
  })

  it('[正常] 空ストアで load() した場合は DEFAULT_CONFIG.siteUrl=\'\'（補完後も空文字）', () => {
    const store = makeMockStore({ initialData: {} })
    const manager = new ConfigManager(store, makeMockLogger())
    const config = manager.load()
    expect(config.siteUrl).toBe(DEFAULT_CONFIG.siteUrl) // '' のはず
  })
})
