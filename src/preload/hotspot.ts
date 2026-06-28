/**
 * T22 — src/preload/hotspot.ts
 *
 * hotspotView 用 contextBridge API
 *
 * 公開する最小 API:
 *   sendTap()              — hotspot:tap を Main へ送信（隅 3 タップ検出通知）
 *   sendAddressBarToggle() — hotspot:address-bar-toggle を Main へ送信（上部中央ゾーンタップ）
 *   onAddressZoneEnabled() — hotspot:set-address-zone-enabled 受信コールバック登録
 *                            enabled=false → .zone-top-center を pointer-events:none に切替
 *
 * 冪等性保証:
 *   ipcRenderer.on はモジュールロード時に一度だけ登録する。
 *   onAddressZoneEnabled() を複数回呼んでも IPC リスナーは増えない。
 */

import { contextBridge, ipcRenderer } from 'electron'
import type { HotspotApi } from '../shared/window-api'

// ─── モジュールレベルリスナー（一度だけ登録）────────────────────────────────

/** hotspot:set-address-zone-enabled コールバック */
let _addressZoneEnabledCallback: ((enabled: boolean) => void) | null = null

/** hotspot:set-address-zone-enabled を一度だけ登録（§2.5 zone-disable 機構） */
ipcRenderer.on(
  'hotspot:set-address-zone-enabled',
  (_event, payload: { enabled: boolean }) => {
    _addressZoneEnabledCallback?.(payload.enabled)
  }
)

// ─── contextBridge API ────────────────────────────────────────────────────────

const hotspotApi: HotspotApi = {
  /**
   * 隅 3 タップ検出を Main へ通知する。
   * Main の hotspot:tap ハンドラが InputCoordinator 経由で settingsView を開く。
   */
  sendTap: (): void => {
    ipcRenderer.send('hotspot:tap')
  },

  /**
   * 上部中央ゾーンのタップを Main へ通知する（アドレスバートグル）。
   * Main の hotspot:address-bar-toggle ハンドラが deps.onToggleAddressBar へ委譲する。
   */
  sendAddressBarToggle: (): void => {
    ipcRenderer.send('hotspot:address-bar-toggle')
  },

  /**
   * Main から hotspot:set-address-zone-enabled が届いたときのコールバックを登録する。
   * renderer の main.ts から呼ばれ、.zone-top-center の pointer-events を切り替える。
   * 複数回呼んでも IPC リスナーは増えない（モジュールレベルで一度のみ登録済み）。
   */
  onAddressZoneEnabled: (callback: (enabled: boolean) => void): void => {
    _addressZoneEnabledCallback = callback
  },
}

contextBridge.exposeInMainWorld('hotspotApi', hotspotApi)
