/**
 * src/renderer/overlay/main.ts — T16 / T17 / T18
 *
 * overlayView DOM エントリポイント。
 *
 * 配線:
 *   window.overlayApi.onPlay(path) → OverlayController.play(path)
 *   OverlayController コールバック → window.overlayApi.send* IPC 送出
 *
 * <video> 要素を DomVideoElement (IVideoElement 実装) でラップし
 * OverlayController に注入する。OverlayController 自体はテスト済みであり、
 * このファイルは DOM / preload との結線グルーのみを担う。
 *
 * 視覚挙動（黒チラなし・フェード・透過合成）は実描画環境に依存するため
 * E2E / [M] テスト（UO-06, M-03）に委ねる。
 */

import { type IVideoElement, OverlayController } from './overlay-controller'
import type { OverlayApi } from '../../shared/window-api'

// ─── window.overlayApi 型宣言 ─────────────────────────────────────────────────
//
// src/preload/overlay.ts の contextBridge.exposeInMainWorld('overlayApi', ...)
// に対応する型。src/shared/window-api.ts の OverlayApi を import type で再利用する。

declare global {
  interface Window {
    overlayApi: OverlayApi
  }
}

// ─── DomVideoElement ──────────────────────────────────────────────────────────

/**
 * 実 <video> 要素を IVideoElement インターフェースでラップする。
 *
 * 24h 冪等性:
 *   play() 呼び出しごとに OverlayController が clearListeners() を呼ぶ。
 *   このメソッドで登録済みリスナーをすべて解除し、src をリセットする。
 *   これによりイベントリスナーが蓄積せず、何周回しても安全に動作する（UO-07）。
 */
class DomVideoElement implements IVideoElement {
  private readonly el: HTMLVideoElement

  /** addEventListener で登録したリスナー参照（removeEventListener 用）*/
  private _endedHandler: (() => void) | null = null
  private _errorHandler: (() => void) | null = null
  private _loadedMetadataHandler: (() => void) | null = null

  constructor(el: HTMLVideoElement) {
    this.el = el
  }

  setSrc(src: string): void {
    // media:// URI を設定。autoplay 属性によりブラウザが即ロードを開始する。
    this.el.src = src
  }

  play(): void {
    // フェードイン完了後に OverlayController が呼ぶ（明示的再生開始）。
    // autoplay で既に再生中の場合は no-op に近い動作となる。
    void this.el.play()
  }

  pause(): void {
    this.el.pause()
  }

  setOnEnded(handler: () => void): void {
    this._endedHandler = handler
    this.el.addEventListener('ended', handler)
  }

  setOnError(handler: (reason: string) => void): void {
    // error イベントは Event 型。MediaError は this.el.error プロパティから取得する。
    const wrapped = (): void => {
      const err = this.el.error
      const reason =
        err !== null
          ? err.message !== ''
            ? err.message
            : `code:${String(err.code)}`
          : 'unknown error'
      handler(reason)
    }
    this._errorHandler = wrapped
    this.el.addEventListener('error', wrapped)
  }

  setOnLoadedMetadata(handler: (durationMs: number) => void): void {
    const wrapped = (): void => {
      const durationSec = this.el.duration
      // NaN / Infinity はライブストリーム等の特殊ケース。MP4 では通常 >0 の有限値。
      if (!isFinite(durationSec) || durationSec <= 0) return
      handler(Math.ceil(durationSec * 1000))
    }
    this._loadedMetadataHandler = wrapped
    this.el.addEventListener('loadedmetadata', wrapped)
  }

  requestVideoFrameCallback(callback: () => void): void {
    // 実描画 1 フレーム確定後に callback を呼ぶ。黒チラ防止の核心。
    // display:none では発火しないため index.html で display を省略している。
    // 視覚確認（フレーム確定タイミング）は E2E / [M] (UO-06, M-03) に委ねる。
    this.el.requestVideoFrameCallback((_now, _metadata) => {
      callback()
    })
  }

  clearListeners(): void {
    // 登録済みリスナーをすべて解除（24h 冪等性・UO-07）
    if (this._endedHandler !== null) {
      this.el.removeEventListener('ended', this._endedHandler)
      this._endedHandler = null
    }
    if (this._errorHandler !== null) {
      this.el.removeEventListener('error', this._errorHandler)
      this._errorHandler = null
    }
    if (this._loadedMetadataHandler !== null) {
      this.el.removeEventListener('loadedmetadata', this._loadedMetadataHandler)
      this._loadedMetadataHandler = null
    }
    // リソース解放: 再生停止 → src クリア → メディア要素リセット
    this.el.pause()
    this.el.src = ''
    this.el.load()
  }
}

// ─── DOM 要素取得 ─────────────────────────────────────────────────────────────

const videoEl = document.getElementById('ad-video')
const containerEl = document.getElementById('overlay-container')

if (videoEl === null || !(videoEl instanceof HTMLVideoElement)) {
  throw new Error('[overlay] #ad-video が見つからないか HTMLVideoElement ではありません')
}
if (containerEl === null) {
  throw new Error('[overlay] #overlay-container が見つかりません')
}

// null チェック後は HTMLVideoElement / HTMLElement に narrowed される
const video: HTMLVideoElement = videoEl
const container: HTMLElement = containerEl

// ─── フェード制御関数 ─────────────────────────────────────────────────────────

/**
 * DOM レベルの可視性制御。
 *
 * setVisible(true):
 *   フェードイン前の準備。opacity は triggerFadeIn が 0→1 にするため
 *   ここでは特別な DOM 操作は不要。
 *
 * setVisible(false):
 *   フェードアウト完了後（opacity はすでに 0）のリセット確定。
 *   次の play() 周回に向けて opacity=0 を明示的に固定する。
 *
 * Note: Main プロセス側の WebContentsView.setVisible() は
 *       ipcController が overlay:play 送信時・fade-out-done 受信時に管理する。
 *       renderer 側では DOM opacity のみを担当する。
 */
function setVisible(visible: boolean): void {
  if (!visible) {
    // フェードアウト完了後の安全リセット。
    // triggerFadeOut 完了時点で opacity=0 は確定しているが、
    // 明示設定でエラー回復ルート（LOADING→IDLE）も包括する。
    container.style.opacity = '0'
  }
  // visible=true: フェードイン前。opacity は triggerFadeIn が管理するため no-op。
}

/**
 * CSS opacity 0→1 フェードイン（2000ms、styles.css の transition: opacity 2000ms 参照）。
 * transitionend 受信後に onComplete を呼ぶ。
 *
 * 視覚確認は E2E / [M] に委ねる（UO-06）。
 */
function triggerFadeIn(onComplete: () => void): void {
  const handleEnd = (ev: TransitionEvent): void => {
    if (ev.propertyName !== 'opacity') return
    container.removeEventListener('transitionend', handleEnd)
    onComplete()
  }
  container.addEventListener('transitionend', handleEnd)
  // opacity を 1 にセット → CSS transition: opacity 2000ms ease-in-out が発火（styles.css 参照）
  container.style.opacity = '1'
}

/**
 * CSS opacity 1→0 フェードアウト（2000ms、styles.css の transition: opacity 2000ms 参照）。
 * transitionend 受信後に onComplete を呼ぶ。
 *
 * 視覚確認は E2E / [M] に委ねる（UO-06）。
 */
function triggerFadeOut(onComplete: () => void): void {
  const handleEnd = (ev: TransitionEvent): void => {
    if (ev.propertyName !== 'opacity') return
    container.removeEventListener('transitionend', handleEnd)
    onComplete()
  }
  container.addEventListener('transitionend', handleEnd)
  // opacity を 0 にセット → CSS transition: opacity 2000ms ease-in-out が発火（styles.css 参照）
  container.style.opacity = '0'
}

// ─── OverlayController 生成と IPC 結線 ───────────────────────────────────────

const domVideo = new DomVideoElement(video)

const controller = new OverlayController({
  video: domVideo,
  setVisible,
  triggerFadeIn,
  triggerFadeOut,
  onPlayed: (path: string): void => {
    // overlay:played → Main (Scheduler: PLAYING→FADE_OUT)
    window.overlayApi.sendPlayed(path)
  },
  onError: (path: string, reason: string): void => {
    // overlay:error → Main (Scheduler: 強制 IDLE 復帰)
    window.overlayApi.sendError(path, reason)
  },
  onFadeInDone: (): void => {
    // overlay:fade-in-done → Main (Scheduler: FADE_IN→PLAYING)
    window.overlayApi.sendFadeInDone()
  },
  onFadeOutDone: (): void => {
    // overlay:fade-out-done → Main (Scheduler: FADE_OUT→IDLE)
    window.overlayApi.sendFadeOutDone()
  },
  onDurationReady: (ms: number): void => {
    // overlay:duration-ready → Main (Scheduler: PLAYING ウォッチドッグ更新)
    window.overlayApi.sendDurationReady(ms)
  },
})

// ─── overlay:play 受信コールバック登録（モジュールロード時一度のみ）──────────

/**
 * overlay:play { path } を受信したら controller.play(path) を呼ぶ。
 *
 * UO-07 冪等性:
 *   onPlay は preload 側で IPC リスナーを一度だけ登録する設計になっている。
 *   ここも一度だけ呼ぶことでコールバック参照のみが更新され、
 *   何周回しても IPC リスナーは蓄積しない。
 */
window.overlayApi.onPlay((path: string) => {
  controller.play(path)
})
