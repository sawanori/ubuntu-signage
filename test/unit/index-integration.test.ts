/**
 * test/unit/index-integration.test.ts — toolbar-utils zone 検証 (§2.5 / §6.1)
 *
 * DI モックを使って以下を検証する:
 *   - notifyAddressZoneEnabled: setToolbarVisible → zone-disable IPC 送信
 *
 * addressbar:navigate / toggle-loop / settings:update / address-bar-toggle /
 * addressbar:reload 等の IPC 結合テストは test/unit/ipc.test.ts の
 * 「Phase C: addressbar IPC チャネル」に集約済み（重複削除済み）。
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
