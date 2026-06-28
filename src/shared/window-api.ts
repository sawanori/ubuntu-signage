/**
 * src/shared/window-api.ts — window API 型定義（preload / renderer 共用）
 *
 * contextBridge.exposeInMainWorld で公開する各 XxxApi interface と
 * 関連ペイロード型を単一定義する。
 *
 * 制約（R1 厳守）:
 *   - electron など preload/main 専用モジュールの import を一切持たない
 *   - 純粋な型定義のみ。ランタイムコードなし。
 *   - preload と renderer の双方がここから `import type` する。
 */

import type { Config } from './types'

// ─── 共有ペイロード型 ─────────────────────────────────────────────────────────

/** addressbar:navigate invoke の戻り値型 */
export interface NavigateResult {
  ok: boolean
  config?: Config
  message?: string
}

// ─── overlay API ──────────────────────────────────────────────────────────────

/** preload/overlay.ts が contextBridge で公開する API 型 */
export interface OverlayApi {
  /** Main から overlay:play が届いたときのコールバック登録（UO-07: 一度のみ登録）*/
  onPlay: (callback: (path: string) => void) => void
  /** 再生完了を Main へ通知 */
  sendPlayed: (path: string) => void
  /** 再生エラーを Main へ通知 */
  sendError: (path: string, reason: string) => void
  /** 動画長確定を Main へ通知（ウォッチドッグタイマー更新用）*/
  sendDurationReady: (ms: number) => void
  /** フェードイン完了を Main へ通知 */
  sendFadeInDone: () => void
  /** フェードアウト完了を Main へ通知 */
  sendFadeOutDone: () => void
}

// ─── settings API ─────────────────────────────────────────────────────────────

/** preload/settings.ts が contextBridge で公開する API 型 */
export interface SettingsWindowApi {
  /** 現在設定を取得する（settings:get IPC invoke） */
  getConfig: () => Promise<Config>
  /**
   * 設定を部分更新する（settings:update IPC invoke）。
   * Main 側で zod 検証・保存・Scheduler 反映が行われ、結果を返す。
   * 検証拒否または保存失敗の場合は null。
   */
  updateConfig: (patch: Partial<Config>) => Promise<Config | null>
  /** settings:open 受信コールバックを登録する */
  onOpen: (callback: () => void) => void
  /** settings:updated 受信コールバックを登録する */
  onUpdated: (callback: (config: Config) => void) => void
  /** settings:close を Main へ送信する */
  close: () => void
  /** settings:test-play を Main へ送信する（IDLE 時のみ Main が実行） */
  testPlay: () => void
  /** settings:pick-folder を invoke してフォルダ選択結果を返す */
  pickFolder: () => Promise<{ folderPath: string | null }>
  /** app:request-quit を Main へ送信する（終了確認フロー起動）*/
  quitApp: () => void
  /** Main から app:quit-armed が届いたときのコールバックを登録する */
  onQuitArmed: (callback: (armed: boolean) => void) => void
}

// ─── hotspot API ──────────────────────────────────────────────────────────────

/** preload/hotspot.ts が contextBridge で公開する API 型 */
export interface HotspotApi {
  /** 隅タップを Main へ通知する */
  sendTap: () => void
  /** アドレスバートグルを Main へ通知する（上部中央ゾーンタップ）*/
  sendAddressBarToggle: () => void
  /**
   * Main から hotspot:set-address-zone-enabled を受信したときのコールバックを登録する。
   * enabled=false のとき .zone-top-center を pointer-events:none にしてクリックを透過させる。
   */
  onAddressZoneEnabled: (cb: (enabled: boolean) => void) => void
}

// ─── addressbar API ───────────────────────────────────────────────────────────

/** preload/addressbar.ts が contextBridge で公開する API 型 */
export interface AddressBarApi {
  /** 現在設定を取得する（addressbar:get-config IPC invoke） */
  getConfig: () => Promise<Config>
  /**
   * URL ナビゲーションを実行する（addressbar:navigate IPC invoke）。
   * 戻り値: {ok: true, config} または {ok: false, message}
   */
  navigate: (url: string) => Promise<NavigateResult>
  /**
   * 広告ループ (loopEnabled) を反転する（addressbar:toggle-loop IPC invoke）。
   * 戻り値: 更新後の Config、または失敗時 null
   */
  toggleLoop: () => Promise<Config | null>
  /** siteView の再ロードを要求する（addressbar:reload 送信）*/
  reload: () => void
  /** Main から addressbar:config-updated を受信したときのコールバックを登録する */
  onConfigUpdated: (cb: (config: Config) => void) => void
}
