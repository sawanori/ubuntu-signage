/**
 * test/unit/index-integration.test.ts — Phase E 結合テスト (§7.2)
 *
 * DI モックを使って以下を検証する:
 *   - notifyAddressZoneEnabled: setToolbarVisible → zone-disable IPC 送信
 *   - addressbar:navigate → onAddressBarNavigate 呼び出し（regression）
 *   - toggle-loop 三者 broadcast（regression）
 *   - settings:update → addressbar:config-updated broadcast（regression）
 *
 * index.ts は Electron 実体依存で純ユニット化が難しい箇所がある。
 * テスト可能なロジックを関数として切り出してテストし、
 * 結線部（addChildView 順・did-finish-load 等）は typecheck/build で担保する。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ─── zone-disable テスト ────────────────────────────────────────────────────────
import { notifyAddressZoneEnabled } from '../../src/main/toolbar-utils'

type MinimalWebContents = {
  isDestroyed(): boolean
  send(channel: string, payload: unknown): void
}

describe('notifyAddressZoneEnabled — zone-disable IPC 送信 (§2.5 / §6.1 CRITICAL)', () => {
  let mockSend: ReturnType<typeof vi.fn>
  let mockIsDestroyed: ReturnType<typeof vi.fn>
  let wc: MinimalWebContents

  beforeEach(() => {
    mockSend = vi.fn()
    mockIsDestroyed = vi.fn().mockReturnValue(false)
    wc = { isDestroyed: mockIsDestroyed, send: mockSend }
  })

  it('toolbarVisible=true のとき → hotspot:set-address-zone-enabled {enabled: false} を送信する', () => {
    notifyAddressZoneEnabled(wc, true)
    expect(mockSend).toHaveBeenCalledTimes(1)
    expect(mockSend).toHaveBeenCalledWith(
      'hotspot:set-address-zone-enabled',
      { enabled: false }
    )
  })

  it('toolbarVisible=false のとき → hotspot:set-address-zone-enabled {enabled: true} を送信する', () => {
    notifyAddressZoneEnabled(wc, false)
    expect(mockSend).toHaveBeenCalledTimes(1)
    expect(mockSend).toHaveBeenCalledWith(
      'hotspot:set-address-zone-enabled',
      { enabled: true }
    )
  })

  it('isDestroyed()=true のとき → 送信しない（クラッシュ後ガード）', () => {
    mockIsDestroyed.mockReturnValue(true)
    notifyAddressZoneEnabled(wc, true)
    expect(mockSend).not.toHaveBeenCalled()
  })

  it('isDestroyed()=false のとき → 送信する', () => {
    mockIsDestroyed.mockReturnValue(false)
    notifyAddressZoneEnabled(wc, false)
    expect(mockSend).toHaveBeenCalledOnce()
  })
})

// ─── IPC 結合テスト（registerHandlers 経由 regression）────────────────────────

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

type ListenerFn = (event: IpcEvent, payload?: unknown) => unknown

interface HandlerStore {
  handle: Map<string, ListenerFn>
  on: Map<string, ListenerFn>
}

function createMockIpcMain(): { ipcMain: IpcMainLike; store: HandlerStore } {
  const store: HandlerStore = {
    handle: new Map(),
    on: new Map(),
  }
  const ipcMain: IpcMainLike = {
    handle(channel, listener) { store.handle.set(channel, listener) },
    on(channel, listener) { store.on.set(channel, listener) },
  }
  return { ipcMain, store }
}

const makeEvent = (url: string): IpcEvent => ({ senderFrame: { url } })
const ADDRESSBAR_URL = 'http://localhost:5173/addressbar/index.html'
const SETTINGS_URL = 'http://localhost:5173/settings/index.html'

const BASE_CONFIG: Config = {
  siteUrl: 'https://example.com',
  videoFolderPath: '/videos',
  intervalMinutes: 5,
  loopEnabled: true,
  fadeDurationMs: 1000,
}

describe('Phase E IPC 結合テスト — registerHandlers 経由 (§7.2)', () => {
  let store: HandlerStore
  let ipcMain: IpcMainLike
  let mockLogger: IpcLogger & { error: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn> }
  let mockSettingsWebContents: WebContentsLike & { send: ReturnType<typeof vi.fn> }
  let mockAddressBarWebContents: WebContentsLike & { send: ReturnType<typeof vi.fn> }
  let mockConfigManager: IpcConfigManager & { applyUpdate: ReturnType<typeof vi.fn> }
  let mockOrchestrator: IpcOrchestrator & { updateConfig: ReturnType<typeof vi.fn> }
  let mockDialog: DialogLike
  let onAddressBarNavigateSpy: ReturnType<typeof vi.fn>
  let onToggleAddressBarSpy: ReturnType<typeof vi.fn>
  let onAddressBarReloadSpy: ReturnType<typeof vi.fn>

  beforeEach(() => {
    const result = createMockIpcMain()
    store = result.store
    ipcMain = result.ipcMain

    mockLogger = { error: vi.fn(), warn: vi.fn() }
    mockSettingsWebContents = { send: vi.fn() }
    mockAddressBarWebContents = { send: vi.fn() }

    mockConfigManager = {
      current: { ...BASE_CONFIG },
      applyUpdate: vi.fn().mockReturnValue({ ...BASE_CONFIG }),
    }

    mockOrchestrator = {
      notifyFadeInDone: vi.fn(),
      notifyDurationReady: vi.fn(),
      notifyPlayed: vi.fn(),
      notifyError: vi.fn(),
      notifyFadeOutDone: vi.fn(),
      testPlay: vi.fn(),
      updateConfig: vi.fn(),
    }

    mockDialog = {
      showOpenDialog: vi.fn().mockResolvedValue({ canceled: true, filePaths: [] }),
    }

    onAddressBarNavigateSpy = vi.fn()
    onToggleAddressBarSpy = vi.fn()
    onAddressBarReloadSpy = vi.fn()

    registerHandlers({
      ipcMain,
      settingsWebContents: mockSettingsWebContents,
      configManager: mockConfigManager,
      orchestrator: mockOrchestrator,
      dialog: mockDialog,
      logger: mockLogger,
      addressBarWebContents: mockAddressBarWebContents,
      onAddressBarNavigate: onAddressBarNavigateSpy,
      onToggleAddressBar: onToggleAddressBarSpy,
      onAddressBarReload: onAddressBarReloadSpy,
    })
  })

  // ─── addressbar:navigate → onAddressBarNavigate（E-7 結線確認）───────────────

  it('addressbar:navigate → URL 変化時に onAddressBarNavigate が呼ばれる', async () => {
    const updated = { ...BASE_CONFIG, siteUrl: 'https://new.example.com' }
    mockConfigManager.applyUpdate.mockReturnValue(updated)
    // 現在の siteUrl と異なる URL をナビゲート
    mockConfigManager.current = { ...BASE_CONFIG, siteUrl: 'https://old.example.com' }

    const handler = store.handle.get('addressbar:navigate')!
    await handler(makeEvent(ADDRESSBAR_URL), { url: 'https://new.example.com' })

    expect(onAddressBarNavigateSpy).toHaveBeenCalledWith('https://new.example.com')
  })

  it('addressbar:navigate → siteUrl が変化しない場合は onAddressBarNavigate を呼ばない', async () => {
    const sameUrl = 'https://example.com'
    const updated = { ...BASE_CONFIG, siteUrl: sameUrl }
    mockConfigManager.applyUpdate.mockReturnValue(updated)
    mockConfigManager.current = { ...BASE_CONFIG, siteUrl: sameUrl }

    const handler = store.handle.get('addressbar:navigate')!
    await handler(makeEvent(ADDRESSBAR_URL), { url: sameUrl })

    expect(onAddressBarNavigateSpy).not.toHaveBeenCalled()
  })

  // ─── toggle-loop 三者同期（E-7 結線確認）──────────────────────────────────────

  it('addressbar:toggle-loop → settingsWebContents と addressBarWebContents 両方に broadcast される', async () => {
    const updated = { ...BASE_CONFIG, loopEnabled: false }
    mockConfigManager.applyUpdate.mockReturnValue(updated)

    const handler = store.handle.get('addressbar:toggle-loop')!
    await handler(makeEvent(ADDRESSBAR_URL))

    expect(mockSettingsWebContents.send).toHaveBeenCalledWith('settings:updated', updated)
    expect(mockAddressBarWebContents.send).toHaveBeenCalledWith('addressbar:config-updated', updated)
  })

  it('addressbar:toggle-loop → orchestrator.updateConfig が loopEnabled 更新で呼ばれる', async () => {
    const updated = { ...BASE_CONFIG, loopEnabled: false }
    mockConfigManager.applyUpdate.mockReturnValue(updated)

    const handler = store.handle.get('addressbar:toggle-loop')!
    await handler(makeEvent(ADDRESSBAR_URL))

    expect(mockOrchestrator.updateConfig).toHaveBeenCalledWith(
      expect.objectContaining({ loopEnabled: false })
    )
  })

  // ─── settings:update → addressbar:config-updated broadcast（E-7 regression）──

  it('settings:update 成功時 → addressBarWebContents に addressbar:config-updated を broadcast する', async () => {
    const updated = { ...BASE_CONFIG, loopEnabled: false }
    mockConfigManager.applyUpdate.mockReturnValue(updated)
    mockConfigManager.current = { ...BASE_CONFIG }

    const handler = store.handle.get('settings:update')!
    await handler(makeEvent(SETTINGS_URL), { loopEnabled: false })

    expect(mockAddressBarWebContents.send).toHaveBeenCalledWith('addressbar:config-updated', updated)
  })

  // ─── hotspot:address-bar-toggle → onToggleAddressBar（E-8 結線確認）──────────

  it('hotspot:address-bar-toggle → onToggleAddressBar が呼ばれる', () => {
    const handler = store.on.get('hotspot:address-bar-toggle')!
    handler(makeEvent('http://localhost:5173/hotspot/index.html'))
    expect(onToggleAddressBarSpy).toHaveBeenCalledOnce()
  })

  // ─── addressbar:reload → onAddressBarReload（E-7 結線確認）─────────────────────

  it('addressbar:reload → onAddressBarReload が呼ばれる', () => {
    const handler = store.on.get('addressbar:reload')!
    handler(makeEvent(ADDRESSBAR_URL))
    expect(onAddressBarReloadSpy).toHaveBeenCalledOnce()
  })
})
