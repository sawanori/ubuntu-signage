/**
 * T18/T20 — test/unit/ipc.test.ts
 *
 * IPC 信頼境界テスト (§3.5)
 *
 * カバー範囲:
 *   UT-23: IPC 不正 sender 拒否 (別Viewからのsettings:update拒否+ログ)
 *   UT-24: settings:update 不正値拒否 (ConfigUpdateSchema検証)
 *   T18:   overlay IPC 契約（正Viewの呼出は通る）
 *   T20:   settings ↔ config IPC（正Viewの呼出は通る）
 *
 * 方針:
 *   - Electron ipcMain/webContents はすべてモック
 *   - src/main/ipc.ts の registerHandlers() に DI で注入する
 *   - src/shared/schema.ts の ConfigUpdateSchema を直接テストする
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { registerHandlers } from '../../src/main/ipc'
import type {
  IpcEvent,
  IpcMainLike,
  IpcLogger,
  WebContentsLike,
  DialogLike,
  IpcConfigManager,
  IpcOrchestrator,
} from '../../src/main/ipc'
import type { Config } from '../../src/shared/types'

// ─── テスト用 URL 定数 ────────────────────────────────────────────────────────

/** 各 View の開発サーバ URL（electron-vite のパターンに沿う） */
const OVERLAY_URL = 'http://localhost:5173/overlay/index.html'
const SETTINGS_URL = 'http://localhost:5173/settings/index.html'
const HOTSPOT_URL = 'http://localhost:5173/hotspot/index.html'
/** siteView（外部サイト）の URL ──allowlist 外 */
const EXTERNAL_URL = 'https://external-signage.example.com'

/** IpcEvent ファクトリ */
const makeEvent = (url: string): IpcEvent => ({ senderFrame: { url } })
const NULL_FRAME_EVENT: IpcEvent = { senderFrame: null }

// ─── モック ipcMain ───────────────────────────────────────────────────────────

type ListenerFn = (event: IpcEvent, payload?: unknown) => unknown

interface HandlerStore {
  /** ipcMain.handle() で登録されたハンドラ */
  handle: Map<string, ListenerFn>
  /** ipcMain.on() で登録されたハンドラ */
  on: Map<string, ListenerFn>
}

function createMockIpcMain(): { ipcMain: IpcMainLike; store: HandlerStore } {
  const store: HandlerStore = {
    handle: new Map(),
    on: new Map(),
  }
  const ipcMain: IpcMainLike = {
    handle(channel, listener) {
      store.handle.set(channel, listener)
    },
    on(channel, listener) {
      store.on.set(channel, listener)
    },
  }
  return { ipcMain, store }
}

// ─── テスト共通セットアップ ───────────────────────────────────────────────────

describe('IPC 信頼境界 (T18/T20 §3.5)', () => {
  let store: HandlerStore
  let ipcMain: IpcMainLike
  let mockLogger: IpcLogger & { error: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn> }
  let mockSettingsWebContents: WebContentsLike & { send: ReturnType<typeof vi.fn> }
  let mockConfigManager: IpcConfigManager & {
    applyUpdate: ReturnType<typeof vi.fn>
  }
  let mockOrchestrator: IpcOrchestrator & {
    notifyPlayed: ReturnType<typeof vi.fn>
    notifyError: ReturnType<typeof vi.fn>
    notifyFadeInDone: ReturnType<typeof vi.fn>
    notifyFadeOutDone: ReturnType<typeof vi.fn>
    notifyDurationReady: ReturnType<typeof vi.fn>
    testPlay: ReturnType<typeof vi.fn>
    updateConfig: ReturnType<typeof vi.fn>
  }
  let mockDialog: DialogLike & { showOpenDialog: ReturnType<typeof vi.fn> }

  const defaultConfig: Config = {
    siteUrl: 'http://localhost:8080',
    videoFolderPath: '/videos',
    intervalMinutes: 5,
    loopEnabled: true,
    fadeDurationMs: 1000,
  }

  beforeEach(() => {
    const result = createMockIpcMain()
    store = result.store
    ipcMain = result.ipcMain

    mockLogger = {
      error: vi.fn(),
      warn: vi.fn(),
    }

    mockSettingsWebContents = { send: vi.fn() }

    mockConfigManager = {
      current: { ...defaultConfig },
      applyUpdate: vi.fn().mockReturnValue({ ...defaultConfig }),
    }

    mockOrchestrator = {
      notifyPlayed: vi.fn(),
      notifyError: vi.fn(),
      notifyFadeInDone: vi.fn(),
      notifyFadeOutDone: vi.fn(),
      notifyDurationReady: vi.fn(),
      testPlay: vi.fn(),
      updateConfig: vi.fn(),
    }

    mockDialog = {
      showOpenDialog: vi
        .fn()
        .mockResolvedValue({ canceled: false, filePaths: ['/some/folder'] }),
    }

    registerHandlers({
      ipcMain,
      settingsWebContents: mockSettingsWebContents,
      configManager: mockConfigManager,
      orchestrator: mockOrchestrator,
      dialog: mockDialog,
      logger: mockLogger,
    })
  })

  // ─── 正Viewの呼出は通る ──────────────────────────────────────────────────────

  describe('正Viewの呼出は通る', () => {
    it('overlay:played from overlayView → notifyPlayed を呼ぶ', () => {
      const handler = store.on.get('overlay:played')!
      handler(makeEvent(OVERLAY_URL), { path: '/videos/clip-001.mp4' })
      expect(mockOrchestrator.notifyPlayed).toHaveBeenCalledOnce()
      expect(mockLogger.error).not.toHaveBeenCalled()
    })

    it('overlay:error from overlayView → notifyError を呼ぶ', () => {
      const handler = store.on.get('overlay:error')!
      handler(makeEvent(OVERLAY_URL), {
        path: '/videos/clip-001.mp4',
        reason: 'MEDIA_ERR_SRC_NOT_SUPPORTED',
      })
      expect(mockOrchestrator.notifyError).toHaveBeenCalledOnce()
      // overlay.videoError ログが出力されること（invalidSender ではない）
      expect(mockLogger.error).toHaveBeenCalledWith('overlay.videoError', expect.any(Object))
    })

    it('overlay:duration-ready from overlayView → notifyDurationReady(ms) を呼ぶ', () => {
      const handler = store.on.get('overlay:duration-ready')!
      handler(makeEvent(OVERLAY_URL), { ms: 5000 })
      expect(mockOrchestrator.notifyDurationReady).toHaveBeenCalledWith(5000)
      expect(mockLogger.error).not.toHaveBeenCalled()
    })

    it('overlay:fade-in-done from overlayView → notifyFadeInDone を呼ぶ', () => {
      const handler = store.on.get('overlay:fade-in-done')!
      handler(makeEvent(OVERLAY_URL))
      expect(mockOrchestrator.notifyFadeInDone).toHaveBeenCalledOnce()
    })

    it('overlay:fade-out-done from overlayView → notifyFadeOutDone を呼ぶ', () => {
      const handler = store.on.get('overlay:fade-out-done')!
      handler(makeEvent(OVERLAY_URL))
      expect(mockOrchestrator.notifyFadeOutDone).toHaveBeenCalledOnce()
    })

    it('settings:get from settingsView → 現在設定を返す', () => {
      const handler = store.handle.get('settings:get')!
      const result = handler(makeEvent(SETTINGS_URL))
      expect(result).toEqual(defaultConfig)
      expect(mockLogger.error).not.toHaveBeenCalled()
    })

    it('settings:update from settingsView with valid payload → applyUpdate を呼ぶ', () => {
      const patch = { intervalMinutes: 10 as const }
      const handler = store.handle.get('settings:update')!
      handler(makeEvent(SETTINGS_URL), patch)
      expect(mockConfigManager.applyUpdate).toHaveBeenCalledWith(patch)
      expect(mockLogger.error).not.toHaveBeenCalled()
    })

    it('settings:test-play from settingsView → orchestrator.testPlay を呼ぶ', () => {
      const handler = store.on.get('settings:test-play')!
      handler(makeEvent(SETTINGS_URL))
      expect(mockOrchestrator.testPlay).toHaveBeenCalledOnce()
    })

    it('hotspot:tap from hotspotView → onHotspotTap コールバックを呼ぶ', () => {
      const onHotspotTap = vi.fn()
      const { ipcMain: ipc2, store: s2 } = createMockIpcMain()
      registerHandlers({
        ipcMain: ipc2,
        settingsWebContents: mockSettingsWebContents,
        configManager: mockConfigManager,
        orchestrator: mockOrchestrator,
        dialog: mockDialog,
        logger: mockLogger,
        onHotspotTap,
      })
      const handler = s2.on.get('hotspot:tap')!
      handler(makeEvent(HOTSPOT_URL))
      expect(onHotspotTap).toHaveBeenCalledOnce()
      expect(mockLogger.error).not.toHaveBeenCalled()
    })

    it('settings:pick-folder from settingsView → dialog を開いてフォルダパスを返す', async () => {
      const handler = store.handle.get('settings:pick-folder')!
      const result = await handler(makeEvent(SETTINGS_URL))
      expect(mockDialog.showOpenDialog).toHaveBeenCalledOnce()
      expect(result).toEqual({ folderPath: '/some/folder' })
    })
  })

  // ─── 別Viewからの呼出は拒否+ログ (UT-23) ────────────────────────────────────

  describe('別Viewからの呼出は拒否+ログ (UT-23)', () => {
    it('overlayView から settings:update を送ると拒否される', () => {
      const handler = store.handle.get('settings:update')!
      handler(makeEvent(OVERLAY_URL), { intervalMinutes: 5 })
      expect(mockConfigManager.applyUpdate).not.toHaveBeenCalled()
      expect(mockLogger.error).toHaveBeenCalledWith(
        'ipc.invalidSender',
        expect.objectContaining({
          event: 'ipc.invalidSender',
          channel: 'settings:update',
        })
      )
    })

    it('外部サイトURL から settings:update を送ると拒否される', () => {
      const handler = store.handle.get('settings:update')!
      handler(makeEvent(EXTERNAL_URL), { intervalMinutes: 5 })
      expect(mockConfigManager.applyUpdate).not.toHaveBeenCalled()
      expect(mockLogger.error).toHaveBeenCalledWith(
        'ipc.invalidSender',
        expect.objectContaining({
          event: 'ipc.invalidSender',
          sender: EXTERNAL_URL,
        })
      )
    })

    it('senderFrame が null の場合は拒否される', () => {
      const handler = store.handle.get('settings:update')!
      handler(NULL_FRAME_EVENT, { intervalMinutes: 5 })
      expect(mockConfigManager.applyUpdate).not.toHaveBeenCalled()
      expect(mockLogger.error).toHaveBeenCalledWith(
        'ipc.invalidSender',
        expect.objectContaining({ event: 'ipc.invalidSender' })
      )
    })

    it('settingsView から overlay:played を送ると拒否される', () => {
      const handler = store.on.get('overlay:played')!
      handler(makeEvent(SETTINGS_URL), { path: '/videos/clip-001.mp4' })
      expect(mockOrchestrator.notifyPlayed).not.toHaveBeenCalled()
      expect(mockLogger.error).toHaveBeenCalledWith(
        'ipc.invalidSender',
        expect.objectContaining({ event: 'ipc.invalidSender' })
      )
    })

    it('外部サイトから hotspot:tap を送ると拒否される', () => {
      const handler = store.on.get('hotspot:tap')!
      handler(makeEvent(EXTERNAL_URL))
      expect(mockSettingsWebContents.send).not.toHaveBeenCalled()
      expect(mockLogger.error).toHaveBeenCalledWith(
        'ipc.invalidSender',
        expect.any(Object)
      )
    })

    it('overlayView から settings:get を送ると拒否される', () => {
      const handler = store.handle.get('settings:get')!
      const result = handler(makeEvent(OVERLAY_URL))
      expect(result).toBeNull()
      expect(mockLogger.error).toHaveBeenCalledWith(
        'ipc.invalidSender',
        expect.objectContaining({ channel: 'settings:get' })
      )
    })
  })

  // ─── 不正 payload は zod 拒否 (UT-24) ───────────────────────────────────────

  describe('不正 payload は zod 拒否 (UT-24)', () => {
    beforeEach(() => {
      // applyUpdate が null を返す（検証拒否シナリオ）
      mockConfigManager.applyUpdate.mockReturnValue(null)
    })

    it('settings:update with { intervalMinutes: 7 } → applyUpdate は呼ばれるが orchestrator は呼ばれない', () => {
      const handler = store.handle.get('settings:update')!
      handler(makeEvent(SETTINGS_URL), { intervalMinutes: 7 })
      expect(mockConfigManager.applyUpdate).toHaveBeenCalledWith({ intervalMinutes: 7 })
      expect(mockOrchestrator.updateConfig).not.toHaveBeenCalled()
    })

    it('settings:update with invalid siteUrl → settingsWebContents に settings:updated を送らない', () => {
      const handler = store.handle.get('settings:update')!
      handler(makeEvent(SETTINGS_URL), { siteUrl: 'javascript://evil' })
      expect(mockConfigManager.applyUpdate).toHaveBeenCalledWith({
        siteUrl: 'javascript://evil',
      })
      expect(mockSettingsWebContents.send).not.toHaveBeenCalledWith(
        'settings:updated',
        expect.anything()
      )
    })
  })

  // ─── settings:update 成功フロー ──────────────────────────────────────────────

  describe('settings:update 成功フロー', () => {
    it('有効な更新 → orchestrator.updateConfig と settings:updated 送信が行われる', () => {
      const updatedConfig: Config = { ...defaultConfig, intervalMinutes: 10 }
      mockConfigManager.applyUpdate.mockReturnValue(updatedConfig)

      const handler = store.handle.get('settings:update')!
      handler(makeEvent(SETTINGS_URL), { intervalMinutes: 10 })

      expect(mockOrchestrator.updateConfig).toHaveBeenCalledWith({
        intervalMinutes: 10,
        loopEnabled: true,
      })
      expect(mockSettingsWebContents.send).toHaveBeenCalledWith(
        'settings:updated',
        updatedConfig
      )
    })

    it('成功時は更新後 Config を返す（Promise<Config|null> 契約）', () => {
      const updatedConfig: Config = { ...defaultConfig, intervalMinutes: 15 }
      mockConfigManager.applyUpdate.mockReturnValue(updatedConfig)

      const handler = store.handle.get('settings:update')!
      const result = handler(makeEvent(SETTINGS_URL), { intervalMinutes: 15 })

      expect(result).toEqual(updatedConfig)
    })

    it('不正 sender の場合は null を返す', () => {
      const handler = store.handle.get('settings:update')!
      const result = handler(makeEvent(OVERLAY_URL), { intervalMinutes: 5 })

      expect(result).toBeNull()
    })

    it('applyUpdate が null を返す（zod 拒否）場合は null を返す', () => {
      mockConfigManager.applyUpdate.mockReturnValue(null)

      const handler = store.handle.get('settings:update')!
      const result = handler(makeEvent(SETTINGS_URL), { intervalMinutes: 7 })

      expect(result).toBeNull()
    })
  })

  // ─── overlay:error ログ (UT-08〜10) ─────────────────────────────────────────

  describe('overlay:error ログ (§8/UT-08〜10)', () => {
    it('path と reason を含む overlay.videoError ログを出力する', () => {
      const handler = store.on.get('overlay:error')!
      handler(makeEvent(OVERLAY_URL), {
        path: '/videos/clip-001.mp4',
        reason: 'MEDIA_ERR_DECODE',
      })
      expect(mockLogger.error).toHaveBeenCalledWith(
        'overlay.videoError',
        expect.objectContaining({
          path: '/videos/clip-001.mp4',
          reason: 'MEDIA_ERR_DECODE',
        })
      )
      expect(mockOrchestrator.notifyError).toHaveBeenCalledOnce()
    })

    it('payload なしでも overlay.videoError ログを出力し notifyError を呼ぶ', () => {
      const handler = store.on.get('overlay:error')!
      handler(makeEvent(OVERLAY_URL), undefined)
      expect(mockLogger.error).toHaveBeenCalledWith(
        'overlay.videoError',
        expect.objectContaining({ path: undefined, reason: undefined })
      )
      expect(mockOrchestrator.notifyError).toHaveBeenCalledOnce()
    })
  })

  // ─── settings:close コールバック結線 ────────────────────────────────────────

  describe('settings:close コールバック結線', () => {
    it('正規 sender の settings:close → onCloseSettings コールバックを呼ぶ', () => {
      const onCloseSettings = vi.fn()
      const { ipcMain: ipc2, store: s2 } = createMockIpcMain()
      registerHandlers({
        ipcMain: ipc2,
        settingsWebContents: mockSettingsWebContents,
        configManager: mockConfigManager,
        orchestrator: mockOrchestrator,
        dialog: mockDialog,
        logger: mockLogger,
        onCloseSettings,
      })
      const handler = s2.on.get('settings:close')!
      handler(makeEvent(SETTINGS_URL))
      expect(onCloseSettings).toHaveBeenCalledOnce()
    })

    it('不正 sender の settings:close → onCloseSettings は呼ばれない', () => {
      const onCloseSettings = vi.fn()
      const { ipcMain: ipc2, store: s2 } = createMockIpcMain()
      registerHandlers({
        ipcMain: ipc2,
        settingsWebContents: mockSettingsWebContents,
        configManager: mockConfigManager,
        orchestrator: mockOrchestrator,
        dialog: mockDialog,
        logger: mockLogger,
        onCloseSettings,
      })
      const handler = s2.on.get('settings:close')!
      handler(makeEvent(OVERLAY_URL))
      expect(onCloseSettings).not.toHaveBeenCalled()
    })
  })

  // ─── (A) 動的切替フック (T32) ───────────────────────────────────────────────

  describe('動的切替フック: onFolderChange / onSiteUrlChange (T32)', () => {
    it('videoFolderPath が変化したとき onFolderChange が呼ばれる', () => {
      const onFolderChange = vi.fn()
      const changed: Config = { ...defaultConfig, videoFolderPath: '/new-videos' }
      mockConfigManager.applyUpdate.mockReturnValue(changed)
      // current と applyUpdate 結果を別にするため current を再設定
      Object.defineProperty(mockConfigManager, 'current', {
        value: { ...defaultConfig },
        configurable: true,
      })

      const { ipcMain: ipc2, store: s2 } = createMockIpcMain()
      registerHandlers({
        ipcMain: ipc2,
        settingsWebContents: mockSettingsWebContents,
        configManager: mockConfigManager,
        orchestrator: mockOrchestrator,
        dialog: mockDialog,
        logger: mockLogger,
        onFolderChange,
      })
      const handler = s2.handle.get('settings:update')!
      handler(makeEvent(SETTINGS_URL), { videoFolderPath: '/new-videos' })
      expect(onFolderChange).toHaveBeenCalledWith('/new-videos')
    })

    it('siteUrl が変化したとき onSiteUrlChange が呼ばれる', () => {
      const onSiteUrlChange = vi.fn()
      const changed: Config = { ...defaultConfig, siteUrl: 'http://newsite.local' }
      mockConfigManager.applyUpdate.mockReturnValue(changed)
      Object.defineProperty(mockConfigManager, 'current', {
        value: { ...defaultConfig },
        configurable: true,
      })

      const { ipcMain: ipc2, store: s2 } = createMockIpcMain()
      registerHandlers({
        ipcMain: ipc2,
        settingsWebContents: mockSettingsWebContents,
        configManager: mockConfigManager,
        orchestrator: mockOrchestrator,
        dialog: mockDialog,
        logger: mockLogger,
        onSiteUrlChange,
      })
      const handler = s2.handle.get('settings:update')!
      handler(makeEvent(SETTINGS_URL), { siteUrl: 'http://newsite.local' })
      expect(onSiteUrlChange).toHaveBeenCalledWith('http://newsite.local')
    })

    it('videoFolderPath が変化しないとき onFolderChange は呼ばれない', () => {
      const onFolderChange = vi.fn()
      // applyUpdate 結果は current と同じ（変化なし）
      mockConfigManager.applyUpdate.mockReturnValue({ ...defaultConfig })

      const { ipcMain: ipc2, store: s2 } = createMockIpcMain()
      registerHandlers({
        ipcMain: ipc2,
        settingsWebContents: mockSettingsWebContents,
        configManager: mockConfigManager,
        orchestrator: mockOrchestrator,
        dialog: mockDialog,
        logger: mockLogger,
        onFolderChange,
      })
      const handler = s2.handle.get('settings:update')!
      handler(makeEvent(SETTINGS_URL), { intervalMinutes: 10 })
      expect(onFolderChange).not.toHaveBeenCalled()
    })

    it('siteUrl が変化しないとき onSiteUrlChange は呼ばれない', () => {
      const onSiteUrlChange = vi.fn()
      mockConfigManager.applyUpdate.mockReturnValue({ ...defaultConfig })

      const { ipcMain: ipc2, store: s2 } = createMockIpcMain()
      registerHandlers({
        ipcMain: ipc2,
        settingsWebContents: mockSettingsWebContents,
        configManager: mockConfigManager,
        orchestrator: mockOrchestrator,
        dialog: mockDialog,
        logger: mockLogger,
        onSiteUrlChange,
      })
      const handler = s2.handle.get('settings:update')!
      handler(makeEvent(SETTINGS_URL), { loopEnabled: false })
      expect(onSiteUrlChange).not.toHaveBeenCalled()
    })
  })

  // ─── §B2. IPC 'app:request-quit' — 終了要求・二層 sender 検証 ─────────────────

  describe("IPC 'app:request-quit' — 終了要求・二層 sender 検証 (§4-B2)", () => {
    const SETTINGS_WEBCONTENTS_ID = 42

    /**
     * sender.id を含む拡張イベントファクトリ（C2 反映: id 同一性検証用）。
     * IpcEvent.sender は ipc.ts で既に `sender?: { id: number }` として定義済み。
     * オブジェクトは IpcEvent に構造的に適合するため型キャスト不要。
     */
    const makeQuitEvent = (url: string, senderId?: number): IpcEvent =>
      ({
        senderFrame: { url },
        sender: senderId !== undefined ? { id: senderId } : undefined,
      })

    /** 正当な settingsView sender イベント（URL 正・id 一致） */
    const makeValidQuitEvent = () => makeQuitEvent(SETTINGS_URL, SETTINGS_WEBCONTENTS_ID)

    function setupWithQuitHandler(opts: {
      onRequestQuit?: () => void
      settingsWebContentsId?: number
    }): HandlerStore {
      const { ipcMain: ipc2, store: s2 } = createMockIpcMain()
      registerHandlers({
        ipcMain: ipc2,
        settingsWebContents: mockSettingsWebContents,
        configManager: mockConfigManager,
        orchestrator: mockOrchestrator,
        dialog: mockDialog,
        logger: mockLogger,
        ...opts,
      })
      return s2
    }

    // B2-01: 正当な settings sender（URL 正・id 一致） → onRequestQuit() が1回呼ばれる
    it('B2-01: settings sender（URL 正・id 一致） → onRequestQuit() が1回呼ばれる', () => {
      const onRequestQuit = vi.fn()
      const s = setupWithQuitHandler({
        onRequestQuit,
        settingsWebContentsId: SETTINGS_WEBCONTENTS_ID,
      })
      const handler = s.on.get('app:request-quit')!
      handler(makeValidQuitEvent())

      expect(onRequestQuit).toHaveBeenCalledOnce()
      expect(mockLogger.error).not.toHaveBeenCalled()
    })

    // B2-02: overlay View から送られる（不正 sender） → onRequestQuit() 呼ばれない + ERROR
    it('B2-02: overlay sender（URL 不正） → onRequestQuit() 呼ばれない + ipc.invalidSender エラー', () => {
      const onRequestQuit = vi.fn()
      const s = setupWithQuitHandler({
        onRequestQuit,
        settingsWebContentsId: SETTINGS_WEBCONTENTS_ID,
      })
      const handler = s.on.get('app:request-quit')!
      handler(makeQuitEvent(OVERLAY_URL, 99))

      expect(onRequestQuit).not.toHaveBeenCalled()
      expect(mockLogger.error).toHaveBeenCalledWith(
        'ipc.invalidSender',
        expect.objectContaining({ event: 'ipc.invalidSender', channel: 'app:request-quit' }),
      )
    })

    // B2-03: senderFrame = null → onRequestQuit() 呼ばれない + ERROR
    it('B2-03: senderFrame = null → onRequestQuit() 呼ばれない + ipc.invalidSender エラー', () => {
      const onRequestQuit = vi.fn()
      const s = setupWithQuitHandler({
        onRequestQuit,
        settingsWebContentsId: SETTINGS_WEBCONTENTS_ID,
      })
      const handler = s.on.get('app:request-quit')!
      handler({ senderFrame: null } as IpcEvent)

      expect(onRequestQuit).not.toHaveBeenCalled()
      expect(mockLogger.error).toHaveBeenCalledWith(
        'ipc.invalidSender',
        expect.objectContaining({ event: 'ipc.invalidSender' }),
      )
    })

    // B2-04: onRequestQuit が未定義 → WARN(ipc.quitCallbackNotSet) + サイレント障害なし
    it('B2-04: onRequestQuit 未定義 → WARN(ipc.quitCallbackNotSet) が出力される（サイレント障害なし）', () => {
      const s = setupWithQuitHandler({
        // onRequestQuit: 未指定
        settingsWebContentsId: SETTINGS_WEBCONTENTS_ID,
      })
      const handler = s.on.get('app:request-quit')!

      // ハンドラ呼び出し自体はエラーなし
      expect(() => handler(makeValidQuitEvent())).not.toThrow()
      expect(mockLogger.warn).toHaveBeenCalledWith(
        'ipc.quitCallbackNotSet',
        expect.any(Object),
      )
    })

    // B2-05: app:request-quit を2回連続で呼ぶ → onRequestQuit() が2回呼ばれる（IPC 層はデバウンスなし）
    it('B2-05: app:request-quit を2回連続で送信 → onRequestQuit() が2回呼ばれる（IPC はステートレス）', () => {
      const onRequestQuit = vi.fn()
      const s = setupWithQuitHandler({
        onRequestQuit,
        settingsWebContentsId: SETTINGS_WEBCONTENTS_ID,
      })
      const handler = s.on.get('app:request-quit')!
      handler(makeValidQuitEvent())
      handler(makeValidQuitEvent())

      expect(onRequestQuit).toHaveBeenCalledTimes(2)
    })

    // B2-06: spoof URL（/settings/ を含む evil URL）→ URL は通るが id 不一致 → 拒否
    it('B2-06: spoof URL（file:///evil/settings/x.html）URL 照合を通るが id 不一致 → onRequestQuit() 呼ばれない + id mismatch エラー', () => {
      const onRequestQuit = vi.fn()
      const s = setupWithQuitHandler({
        onRequestQuit,
        settingsWebContentsId: SETTINGS_WEBCONTENTS_ID,
      })
      const handler = s.on.get('app:request-quit')!
      // file: スキームで /settings/ パスを含む evil URL（第1層 URL 照合は通る）
      // しかし sender.id が settingsWebContentsId と一致しない
      handler(makeQuitEvent('file:///evil/settings/x.html', 999))

      expect(onRequestQuit).not.toHaveBeenCalled()
      expect(mockLogger.error).toHaveBeenCalledWith(
        'ipc.invalidSender',
        expect.objectContaining({ reason: 'webContents id mismatch' }),
      )
    })

    // B2-07: URL は settings 正・event.sender.id ≠ settingsWebContentsId → 拒否
    it('B2-07: URL は settings 正でも sender.id が不一致 → onRequestQuit() 呼ばれない + id mismatch エラー', () => {
      const onRequestQuit = vi.fn()
      const s = setupWithQuitHandler({
        onRequestQuit,
        settingsWebContentsId: SETTINGS_WEBCONTENTS_ID,
      })
      const handler = s.on.get('app:request-quit')!
      // URL は正当な settings URL だが sender.id が違う
      handler(makeQuitEvent(SETTINGS_URL, 999))

      expect(onRequestQuit).not.toHaveBeenCalled()
      expect(mockLogger.error).toHaveBeenCalledWith(
        'ipc.invalidSender',
        expect.objectContaining({ reason: 'webContents id mismatch' }),
      )
    })

    // B2-08: settingsWebContentsId 未指定（後方互換）かつ URL 正 → onRequestQuit() が呼ばれる
    it('B2-08: settingsWebContentsId 未指定（後方互換モード）かつ URL 正 → onRequestQuit() が1回呼ばれる', () => {
      const onRequestQuit = vi.fn()
      const s = setupWithQuitHandler({
        onRequestQuit,
        // settingsWebContentsId: 未指定 → id 検証スキップ
      })
      const handler = s.on.get('app:request-quit')!
      // id なしのイベント（後方互換 makeEvent）
      handler(makeEvent(SETTINGS_URL))

      expect(onRequestQuit).toHaveBeenCalledOnce()
      expect(mockLogger.error).not.toHaveBeenCalled()
    })
  })

  // ─── (D) sender allowlist identity 化 — spoof URL 拒否 ───────────────────────

  describe('sender allowlist identity 化: spoof URL 拒否 (D)', () => {
    it('overlay.attacker.com からの settings:update は拒否される', () => {
      const handler = store.handle.get('settings:update')!
      handler(makeEvent('https://overlay.attacker.com/'), { intervalMinutes: 5 })
      expect(mockConfigManager.applyUpdate).not.toHaveBeenCalled()
      expect(mockLogger.error).toHaveBeenCalledWith('ipc.invalidSender', expect.any(Object))
    })

    it('外部サイトの /settings/ パスを含む偽装 URL は拒否される', () => {
      const handler = store.handle.get('settings:update')!
      handler(makeEvent('https://attacker.com/settings/index.html'), { intervalMinutes: 5 })
      expect(mockConfigManager.applyUpdate).not.toHaveBeenCalled()
      expect(mockLogger.error).toHaveBeenCalledWith('ipc.invalidSender', expect.any(Object))
    })

    it('/overlay/ パスを持つ外部ドメインからの overlay:played は拒否される', () => {
      const handler = store.on.get('overlay:played')!
      handler(makeEvent('https://evil.com/overlay/payload'), undefined)
      expect(mockOrchestrator.notifyPlayed).not.toHaveBeenCalled()
      expect(mockLogger.error).toHaveBeenCalledWith('ipc.invalidSender', expect.any(Object))
    })

    it('スキームなし URL からの IPC は拒否される', () => {
      const handler = store.handle.get('settings:update')!
      handler(makeEvent('evil/overlay/x'), { intervalMinutes: 5 })
      expect(mockConfigManager.applyUpdate).not.toHaveBeenCalled()
      expect(mockLogger.error).toHaveBeenCalledWith('ipc.invalidSender', expect.any(Object))
    })

    it('localhost.attacker.com からの IPC は拒否される', () => {
      const handler = store.handle.get('settings:update')!
      handler(makeEvent('http://localhost.attacker.com/settings/index.html'), { intervalMinutes: 5 })
      expect(mockConfigManager.applyUpdate).not.toHaveBeenCalled()
      expect(mockLogger.error).toHaveBeenCalledWith('ipc.invalidSender', expect.any(Object))
    })
  })

  // ─── Phase C: addressbar IPC チャネル (§7.1.5) ──────────────────────────────

  describe('Phase C: addressbar IPC チャネル (§7.1.5)', () => {
    const ADDRESSBAR_URL = 'http://localhost:5173/addressbar/index.html'
    let store2: HandlerStore
    let mockAddressBarWebContents: WebContentsLike & { send: ReturnType<typeof vi.fn> }
    let onAddressBarNavigate: ReturnType<typeof vi.fn>
    let onToggleAddressBar: ReturnType<typeof vi.fn>
    let onAddressBarReload: ReturnType<typeof vi.fn>

    beforeEach(() => {
      const result = createMockIpcMain()
      store2 = result.store
      mockAddressBarWebContents = { send: vi.fn() }
      onAddressBarNavigate = vi.fn()
      onToggleAddressBar = vi.fn()
      onAddressBarReload = vi.fn()

      registerHandlers({
        ipcMain: result.ipcMain,
        settingsWebContents: mockSettingsWebContents,
        configManager: mockConfigManager,
        orchestrator: mockOrchestrator,
        dialog: mockDialog,
        logger: mockLogger,
        addressBarWebContents: mockAddressBarWebContents,
        onAddressBarNavigate,
        onToggleAddressBar,
        onAddressBarReload,
      })
    })

    // ─── addressbar:get-config ─────────────────────────────────────────────

    describe('addressbar:get-config', () => {
      it('addressBarView sender → configManager.current を返す', () => {
        const handler = store2.handle.get('addressbar:get-config')!
        const result = handler(makeEvent(ADDRESSBAR_URL))
        expect(result).toEqual(defaultConfig)
        expect(mockLogger.error).not.toHaveBeenCalled()
      })

      it('settingsView sender → 拒否 + ipc.invalidSender ログ', () => {
        const handler = store2.handle.get('addressbar:get-config')!
        const result = handler(makeEvent(SETTINGS_URL))
        expect(result).toBeNull()
        expect(mockLogger.error).toHaveBeenCalledWith(
          'ipc.invalidSender',
          expect.objectContaining({ channel: 'addressbar:get-config' })
        )
      })
    })

    // ─── addressbar:navigate ───────────────────────────────────────────────

    describe('addressbar:navigate', () => {
      it('valid URL → invoke 戻り値 {ok: true, config} + onAddressBarNavigate 呼び出し', () => {
        const newUrl = 'https://newsignage.example.com'
        const updatedConfig: Config = { ...defaultConfig, siteUrl: newUrl }
        mockConfigManager.applyUpdate.mockReturnValue(updatedConfig)
        Object.defineProperty(mockConfigManager, 'current', {
          value: { ...defaultConfig },
          configurable: true,
        })

        const handler = store2.handle.get('addressbar:navigate')!
        const result = handler(makeEvent(ADDRESSBAR_URL), { url: newUrl })

        expect(result).toEqual({ ok: true, config: updatedConfig })
        expect(onAddressBarNavigate).toHaveBeenCalledWith(newUrl)
        expect(mockLogger.error).not.toHaveBeenCalled()
      })

      it('URL 変更なし → onAddressBarNavigate は呼ばれない', () => {
        const sameUrl = defaultConfig.siteUrl
        const updatedConfig: Config = { ...defaultConfig, siteUrl: sameUrl }
        mockConfigManager.applyUpdate.mockReturnValue(updatedConfig)
        // mockConfigManager.current.siteUrl === updatedConfig.siteUrl（変更なし）

        const handler = store2.handle.get('addressbar:navigate')!
        const result = handler(makeEvent(ADDRESSBAR_URL), { url: sameUrl })

        expect(onAddressBarNavigate).not.toHaveBeenCalled()
        expect(result).toEqual(expect.objectContaining({ ok: true }))
      })

      it('invalid URL (ftp://) → invoke 戻り値 {ok: false, message}（addressbar:navigate-error IPC なし）', () => {
        mockConfigManager.applyUpdate.mockReturnValue(null)

        const handler = store2.handle.get('addressbar:navigate')!
        const result = handler(makeEvent(ADDRESSBAR_URL), { url: 'ftp://example.com' }) as {
          ok: boolean
          message?: string
        }

        expect(result.ok).toBe(false)
        expect(typeof result.message).toBe('string')
        expect(onAddressBarNavigate).not.toHaveBeenCalled()
        // addressbar:navigate-error IPC は発行しない
        expect(mockAddressBarWebContents.send).not.toHaveBeenCalledWith(
          'addressbar:navigate-error',
          expect.anything()
        )
      })

      it('不正 sender → 拒否 + ipc.invalidSender ログ', () => {
        const handler = store2.handle.get('addressbar:navigate')!
        const result = handler(makeEvent(SETTINGS_URL), { url: 'https://example.com' })

        expect(result).toBeNull()
        expect(onAddressBarNavigate).not.toHaveBeenCalled()
        expect(mockLogger.error).toHaveBeenCalledWith(
          'ipc.invalidSender',
          expect.objectContaining({ channel: 'addressbar:navigate' })
        )
      })

      it('成功時 → settingsWebContents と addressBarWebContents に broadcast', () => {
        const newUrl = 'https://broadcast.example.com'
        const updatedConfig: Config = { ...defaultConfig, siteUrl: newUrl }
        mockConfigManager.applyUpdate.mockReturnValue(updatedConfig)
        Object.defineProperty(mockConfigManager, 'current', {
          value: { ...defaultConfig },
          configurable: true,
        })

        const handler = store2.handle.get('addressbar:navigate')!
        handler(makeEvent(ADDRESSBAR_URL), { url: newUrl })

        expect(mockSettingsWebContents.send).toHaveBeenCalledWith('settings:updated', updatedConfig)
        expect(mockAddressBarWebContents.send).toHaveBeenCalledWith(
          'addressbar:config-updated',
          updatedConfig
        )
      })
    })

    // ─── addressbar:toggle-loop ────────────────────────────────────────────

    describe('addressbar:toggle-loop', () => {
      it('loopEnabled=true → applyUpdate({loopEnabled: false}) を呼ぶ', () => {
        Object.defineProperty(mockConfigManager, 'current', {
          value: { ...defaultConfig, loopEnabled: true },
          configurable: true,
        })
        const updatedConfig: Config = { ...defaultConfig, loopEnabled: false }
        mockConfigManager.applyUpdate.mockReturnValue(updatedConfig)

        const handler = store2.handle.get('addressbar:toggle-loop')!
        handler(makeEvent(ADDRESSBAR_URL))

        expect(mockConfigManager.applyUpdate).toHaveBeenCalledWith({ loopEnabled: false })
      })

      it('orchestrator.updateConfig({loopEnabled}) を呼ぶ', () => {
        const updatedConfig: Config = { ...defaultConfig, loopEnabled: false }
        mockConfigManager.applyUpdate.mockReturnValue(updatedConfig)

        const handler = store2.handle.get('addressbar:toggle-loop')!
        handler(makeEvent(ADDRESSBAR_URL))

        expect(mockOrchestrator.updateConfig).toHaveBeenCalledWith(
          expect.objectContaining({ loopEnabled: false })
        )
      })

      it('addressBarWebContents に addressbar:config-updated を送信する', () => {
        const updatedConfig: Config = { ...defaultConfig, loopEnabled: false }
        mockConfigManager.applyUpdate.mockReturnValue(updatedConfig)

        const handler = store2.handle.get('addressbar:toggle-loop')!
        handler(makeEvent(ADDRESSBAR_URL))

        expect(mockAddressBarWebContents.send).toHaveBeenCalledWith(
          'addressbar:config-updated',
          updatedConfig
        )
      })

      it('settingsWebContents に settings:updated を送信する（三者同期）', () => {
        const updatedConfig: Config = { ...defaultConfig, loopEnabled: false }
        mockConfigManager.applyUpdate.mockReturnValue(updatedConfig)

        const handler = store2.handle.get('addressbar:toggle-loop')!
        handler(makeEvent(ADDRESSBAR_URL))

        expect(mockSettingsWebContents.send).toHaveBeenCalledWith('settings:updated', updatedConfig)
      })
    })

    // ─── addressbar:reload ─────────────────────────────────────────────────

    describe('addressbar:reload', () => {
      it('addressBarView sender → onAddressBarReload() を呼ぶ', () => {
        const handler = store2.on.get('addressbar:reload')!
        handler(makeEvent(ADDRESSBAR_URL))

        expect(onAddressBarReload).toHaveBeenCalledOnce()
        expect(mockLogger.error).not.toHaveBeenCalled()
      })
    })

    // ─── hotspot:address-bar-toggle ────────────────────────────────────────

    describe('hotspot:address-bar-toggle', () => {
      it('hotspotView sender → onToggleAddressBar() を呼ぶ', () => {
        const handler = store2.on.get('hotspot:address-bar-toggle')!
        handler(makeEvent(HOTSPOT_URL))

        expect(onToggleAddressBar).toHaveBeenCalledOnce()
        expect(mockLogger.error).not.toHaveBeenCalled()
      })

      it('不正 sender → 拒否 + ipc.invalidSender ログ', () => {
        const handler = store2.on.get('hotspot:address-bar-toggle')!
        handler(makeEvent(SETTINGS_URL))

        expect(onToggleAddressBar).not.toHaveBeenCalled()
        expect(mockLogger.error).toHaveBeenCalledWith(
          'ipc.invalidSender',
          expect.objectContaining({ channel: 'hotspot:address-bar-toggle' })
        )
      })
    })

    // ─── settings:update addressbar:config-updated broadcast ──────────────

    describe('settings:update の addressbar:config-updated broadcast', () => {
      it('settings:update 成功時 → addressBarWebContents に addressbar:config-updated を送信する', () => {
        const updatedConfig: Config = { ...defaultConfig, loopEnabled: false }
        mockConfigManager.applyUpdate.mockReturnValue(updatedConfig)

        const handler = store2.handle.get('settings:update')!
        handler(makeEvent(SETTINGS_URL), { loopEnabled: false })

        expect(mockAddressBarWebContents.send).toHaveBeenCalledWith(
          'addressbar:config-updated',
          updatedConfig
        )
      })

      it('addressBarWebContents が undefined でも settings:update は TypeError をスローしない', () => {
        const { ipcMain: ipc3, store: s3 } = createMockIpcMain()
        registerHandlers({
          ipcMain: ipc3,
          settingsWebContents: mockSettingsWebContents,
          configManager: mockConfigManager,
          orchestrator: mockOrchestrator,
          dialog: mockDialog,
          logger: mockLogger,
          // addressBarWebContents は未指定
        })
        const updatedConfig: Config = { ...defaultConfig, loopEnabled: false }
        mockConfigManager.applyUpdate.mockReturnValue(updatedConfig)

        const handler = s3.handle.get('settings:update')!
        expect(() => handler(makeEvent(SETTINGS_URL), { loopEnabled: false })).not.toThrow()
      })
    })

    // ─── addressbar:navigate スキームなし URL 正規化 (FIX SET CHANGE 2) ──────

    describe('addressbar:navigate スキームなし URL 正規化 (FIX SET CHANGE 2)', () => {
      it('{url:"m.yahoo.co.jp"} → applyUpdate に {siteUrl:"https://m.yahoo.co.jp"} が渡され {ok:true} を返す', () => {
        const normalizedUrl = 'https://m.yahoo.co.jp'
        const updatedConfig: Config = { ...defaultConfig, siteUrl: normalizedUrl }
        mockConfigManager.applyUpdate.mockReturnValue(updatedConfig)
        Object.defineProperty(mockConfigManager, 'current', {
          value: { ...defaultConfig },
          configurable: true,
        })

        const handler = store2.handle.get('addressbar:navigate')!
        const result = handler(makeEvent(ADDRESSBAR_URL), { url: 'm.yahoo.co.jp' }) as {
          ok: boolean
          config?: Config
        }

        expect(mockConfigManager.applyUpdate).toHaveBeenCalledWith({ siteUrl: 'https://m.yahoo.co.jp' })
        expect(result.ok).toBe(true)
      })

      it('{url:"localhost:8080"} → applyUpdate に {siteUrl:"http://localhost:8080"} が渡され {ok:true} を返す', () => {
        const normalizedUrl = 'http://localhost:8080'
        const updatedConfig: Config = { ...defaultConfig, siteUrl: normalizedUrl }
        mockConfigManager.applyUpdate.mockReturnValue(updatedConfig)
        Object.defineProperty(mockConfigManager, 'current', {
          value: { ...defaultConfig },
          configurable: true,
        })

        const handler = store2.handle.get('addressbar:navigate')!
        const result = handler(makeEvent(ADDRESSBAR_URL), { url: 'localhost:8080' }) as {
          ok: boolean
          config?: Config
        }

        expect(mockConfigManager.applyUpdate).toHaveBeenCalledWith({ siteUrl: 'http://localhost:8080' })
        expect(result.ok).toBe(true)
      })
    })
  })
})
