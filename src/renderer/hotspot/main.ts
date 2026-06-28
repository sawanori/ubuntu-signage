/**
 * T22 — src/renderer/hotspot/main.ts
 *
 * 四隅タップ検出 renderer
 *
 * 責務:
 *   - 画面四隅の透明な .corner 要素にクリック/タップイベントを結線する
 *   - 隅タップごとに preload (src/preload/hotspot.ts) の sendTap() 経由で
 *     IPC チャンネル hotspot:tap を Main プロセスへ 1 回送出する（raw イベント）
 *   - 3 回カウント・時間窓判定・トグルロジックは Main 側 InputCoordinator が担う
 *
 * 検証委任:
 *   - 視覚（透明度・サイズ）および実タップ動作の確認は E2E/[M] に委ねる
 *     E2E-13: 隅3タップで settingsView が開く
 *     UH-01:  1.5s 以内の 3 回タップで hotspot:tap が送出される
 *     UH-02:  2s かけた 3 回タップでは hotspot:tap が送出されない [U]
 *     UH-03:  settingsView が開いている状態で再度 3 タップすると閉じる [E]
 *
 * IPC:
 *   - hotspot:tap を送出（preload の sendTap() 経由）
 *   - Main からの受信なし（送信専用・最小構成）
 *
 * CSS 配線:
 *   - html/body: pointer-events:none（下層 View へタップを透過）
 *   - .corner: pointer-events:auto（透明・40×40px・四隅固定配置）
 */

// ESM モジュールとして扱い、declare global による Window 拡張を有効にする
export {};

/** preload の contextBridge で公開された hotspotApi の型 */
interface HotspotApi {
  sendTap: () => void;
  /** アドレスバートグルを Main へ通知する（上部中央ゾーンタップ） */
  sendAddressBarToggle: () => void;
  /**
   * Main から hotspot:set-address-zone-enabled を受信したときのコールバックを登録する。
   * enabled=false のとき .zone-top-center を pointer-events:none にしてクリックを透過させる。
   */
  onAddressZoneEnabled: (cb: (enabled: boolean) => void) => void;
}

declare global {
  interface Window {
    hotspotApi: HotspotApi;
  }
}

/**
 * 四隅の .corner 要素がクリック/タップされたときのハンドラ。
 *
 * 隅タップを 1 回ごとに hotspot:tap IPC として Main へ送出する（raw イベント）。
 * 3 回カウント・時間窓判定・設定パネルのトグルは Main 側 InputCoordinator が担う。
 */
function handleCornerTap(): void {
  window.hotspotApi.sendTap();
}

/**
 * DOM の四隅 .corner 要素にクリックイベントを結線する。
 * querySelectorAll で全コーナーをまとめて処理する。
 */
function initCorners(): void {
  const corners = document.querySelectorAll<HTMLElement>('.corner');
  corners.forEach((corner) => {
    corner.addEventListener('click', handleCornerTap);
  });
}

/**
 * 上部中央アドレスバートグルゾーン（.zone-top-center）を初期化する。
 *
 * クリックハンドラ: sendAddressBarToggle() → hotspot:address-bar-toggle を Main へ送出。
 *   Main の toggleAddressBarZone() → setToolbarVisible(!toolbarVisible) が呼ばれる。
 *
 * zone-disable IPC 受信（§2.5 CRITICAL）:
 *   onAddressZoneEnabled(enabled) を登録し、enabled=false のとき pointer-events:none に切替。
 *   これによりアドレスバー VISIBLE 中は URL 入力クリックが hotspot ゾーンに奪われなくなる。
 */
function initAddressBarZone(): void {
  const addressBarZone = document.querySelector<HTMLElement>('.zone-top-center');

  if (addressBarZone) {
    addressBarZone.addEventListener('click', () => {
      window.hotspotApi.sendAddressBarToggle();
    });
  }

  // zone-disable IPC: Main から enabled 状態を受信して pointer-events を切替
  window.hotspotApi.onAddressZoneEnabled((enabled: boolean) => {
    if (addressBarZone) {
      addressBarZone.style.pointerEvents = enabled ? 'auto' : 'none';
    }
  });
}

// DOMContentLoaded 後に初期化（または既にロード済みなら即時実行）
function initAll(): void {
  initCorners();
  initAddressBarZone();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initAll);
} else {
  initAll();
}
