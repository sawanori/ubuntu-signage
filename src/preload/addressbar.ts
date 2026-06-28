/**
 * src/preload/addressbar.ts
 *
 * addressBarView 用 contextBridge API
 *
 * 公開する最小 API:
 *   getConfig()          — addressbar:get-config を invoke して現在設定を取得する
 *   navigate(url)        — addressbar:navigate を invoke して URL ナビゲーションを実行する
 *                          戻り値: {ok: boolean, config?: Config, message?: string}
 *   toggleLoop()         — addressbar:toggle-loop を invoke して loopEnabled を反転する
 *                          戻り値: 更新後の Config、または失敗時 null
 *   reload()             — addressbar:reload を Main へ送信（siteView の再ロード）
 *   onConfigUpdated(cb)  — Main から addressbar:config-updated を受信したときのコールバック登録
 *
 * 冪等性保証:
 *   ipcRenderer.on はモジュールロード時に一度だけ登録する（settings.ts と同じパターン）。
 *   onConfigUpdated() を複数回呼んでも IPC リスナーは増えない。
 */

import { contextBridge, ipcRenderer } from 'electron'
import type { Config } from '../shared/types'
import type { AddressBarApi, NavigateResult } from '../shared/window-api'

// ─── モジュールレベルリスナー（一度だけ登録）────────────────────────────────

/** addressbar:config-updated コールバック */
let _configUpdatedCallback: ((config: Config) => void) | null = null

/** addressbar:config-updated を一度だけ登録 */
ipcRenderer.on('addressbar:config-updated', (_event, config: Config) => {
  _configUpdatedCallback?.(config)
})

// ─── contextBridge API ────────────────────────────────────────────────────────

const addressBarApi: AddressBarApi = {
  /**
   * 現在設定を取得する。
   * Main: addressbar:get-config ハンドラが ConfigManager.current を返す。
   */
  getConfig: (): Promise<Config> => ipcRenderer.invoke('addressbar:get-config'),

  /**
   * URL ナビゲーションを実行する。
   * Main 側で ConfigUpdateSchema (zod) 検証・ConfigManager 保存・siteView ロードが行われる。
   * 戻り値: {ok: true, config} または {ok: false, message}
   *
   * 楽観的更新禁止: invoke 戻り値でのみ UI を更新する。
   */
  navigate: (url: string): Promise<NavigateResult> =>
    ipcRenderer.invoke('addressbar:navigate', { url }),

  /**
   * 広告ループ (loopEnabled) を反転する。
   * 楽観的更新禁止: invoke 戻り値（更新後 Config または null）でのみ UI を更新する。
   * null 返却時は UI を変更しない。
   */
  toggleLoop: (): Promise<Config | null> => ipcRenderer.invoke('addressbar:toggle-loop'),

  /**
   * siteView の再ロードを要求する（addressbar:reload）。
   */
  reload: (): void => {
    ipcRenderer.send('addressbar:reload')
  },

  /**
   * Main から addressbar:config-updated が届いたときに呼ぶコールバックを登録する。
   * 設定変更が反映された Config を受け取り、UI を更新する。
   * 複数回呼んでも IPC リスナーは増えない。
   */
  onConfigUpdated: (callback: (config: Config) => void): void => {
    _configUpdatedCallback = callback
  },
}

contextBridge.exposeInMainWorld('addressBarApi', addressBarApi)
