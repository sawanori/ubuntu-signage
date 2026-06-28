/**
 * src/main/toolbar-utils.ts — アドレスバー toolbar ヘルパー（純関数）
 *
 * index.ts から抽出したテスト可能なロジック。Electron API に直接依存しない。
 * § 2.5 zone-disable 機構の実装。
 * § hotspot bounds 退避ロジック（Option A）: WebContentsView は CSS pointer-events を
 * 透過しないため、toolbarVisible=true 時に hotspot を上部帯から退避させる。
 */

/** 座標・サイズを表す矩形（Electron.Rectangle の純関数版互換型） */
export interface Rect { x: number; y: number; width: number; height: number }

/**
 * toolbar 表示状態に応じた「上部帯を避ける」レイアウト矩形を返す純関数。
 *
 * siteView と hotspotView は同一ロジック:
 *   - toolbarVisible=true  → 上 toolbarHeight を避け、height は負値ガード(Math.max(0, ...))
 *   - toolbarVisible=false → 全画面
 *
 * addressBar は常に上部帯固定（toolbarVisible に依らず）。
 *
 * @param toolbarVisible アドレスバーが表示中かどうか
 * @param win            ウィンドウの幅・高さ
 * @param toolbarHeight  アドレスバーの高さ（px）
 */
export function computeLayeredBounds(
  toolbarVisible: boolean,
  win: { width: number; height: number },
  toolbarHeight: number
): { site: Rect; hotspot: Rect; addressBar: Rect } {
  const addressBar: Rect = { x: 0, y: 0, width: win.width, height: toolbarHeight }

  if (toolbarVisible) {
    const siteOrHotspot: Rect = {
      x: 0,
      y: toolbarHeight,
      width: win.width,
      height: Math.max(0, win.height - toolbarHeight),
    }
    return { site: siteOrHotspot, hotspot: { ...siteOrHotspot }, addressBar }
  }

  const full: Rect = { x: 0, y: 0, width: win.width, height: win.height }
  return { site: full, hotspot: { ...full }, addressBar }
}

/**
 * hotspotView の .zone-top-center の pointer-events 有効/無効を制御する IPC を送信する。
 *
 * setToolbarVisible(visible) から呼ばれる。
 *   - toolbarVisible=true  → {enabled: false} でゾーンを無効化（URL 入力クリック保護）
 *   - toolbarVisible=false → {enabled: true}  でゾーンを復元（バー表示トリガーを復活）
 *
 * isDestroyed() チェックにより、hotspot がクラッシュ/再ロード中の send を防ぐ。
 *
 * @param wc            hotspotView.webContents の最小インターフェース
 * @param toolbarVisible アドレスバーが表示中かどうか
 */
export function notifyAddressZoneEnabled(
  wc: { isDestroyed(): boolean; send(channel: string, payload: unknown): void },
  toolbarVisible: boolean
): void {
  if (!wc.isDestroyed()) {
    wc.send('hotspot:set-address-zone-enabled', { enabled: !toolbarVisible })
  }
}
