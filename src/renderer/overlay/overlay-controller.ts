/**
 * src/renderer/overlay/overlay-controller.ts — T16/T17
 *
 * DOM 非依存の再生制御ロジック（小さな状態機械）。
 *
 * VideoElement を抽象インターフェース (IVideoElement) の背後に置くことで、
 * 実 DOM・CSS・視覚に依存せずにユニットテスト可能にする。
 *
 * 状態遷移:
 *   IDLE ──(play(path))──────────────────────────► LOADING
 *   LOADING ──(requestVideoFrameCallback 発火)──── ► FADE_IN  + setVisible(true)
 *   FADE_IN ──(フェードイン完了コールバック)────── ► PLAYING  + onFadeInDone + video.play()
 *   PLAYING ──(video ended)──────────────────────► FADE_OUT + onPlayed
 *   PLAYING ──(video error)──────────────────────► FADE_OUT  + onError 即通知
 *   FADE_OUT ──(フェードアウト完了コールバック)──► IDLE     + setVisible(false) + onFadeOutDone
 *   LOADING ──(video error)──────────────────────► IDLE     + onError 即通知 (reveal なし)
 *
 * 二重 play 防止: IDLE 以外の状態での play() は無視する。
 * 24h 冪等性: play() 呼び出しごとに clearListeners() でリスナを解放・再設定する。
 */

// ─── 抽象 VideoElement インターフェース ──────────────────────────────────────

/**
 * DOM の <video> 要素を隠蔽する最小抽象インターフェース。
 * テストでは mock に差し替える。実装は overlay.ts の DOM 側で行う。
 */
export interface IVideoElement {
  /** src 属性を設定する */
  setSrc(src: string): void
  /** 再生を開始する */
  play(): void
  /** 再生を停止する */
  pause(): void
  /** 動画終了ハンドラを登録する */
  setOnEnded(handler: () => void): void
  /** エラーハンドラを登録する（reason は MediaError.message 相当の文字列） */
  setOnError(handler: (reason: string) => void): void
  /** loadedmetadata ハンドラを登録する（durationMs = Math.ceil(duration * 1000)）*/
  setOnLoadedMetadata(handler: (durationMs: number) => void): void
  /**
   * requestVideoFrameCallback 相当: 最初の実描画フレームが確定したときに callback を呼ぶ。
   * DOM の実装では `video.requestVideoFrameCallback(callback)` を使用する。
   */
  requestVideoFrameCallback(callback: () => void): void
  /** 登録済みの全イベントハンドラを解除する（再生周回ごとに呼ぶ）*/
  clearListeners(): void
}

// ─── OverlayController オプション ────────────────────────────────────────────

/** OverlayController に注入するコールバック群 */
export interface OverlayControllerOptions {
  /** 制御対象の抽象 VideoElement */
  video: IVideoElement
  /**
   * オーバーレイ View の表示/非表示を切り替える。
   * 実装では Main プロセスへの IPC または setVisible() 相当を呼ぶ。
   */
  setVisible: (visible: boolean) => void
  /**
   * フェードイン CSS アニメーションを開始する。
   * アニメーション完了時に onComplete を呼ぶ（transitionend 相当）。
   */
  triggerFadeIn: (onComplete: () => void) => void
  /**
   * フェードアウト CSS アニメーションを開始する。
   * アニメーション完了時に onComplete を呼ぶ（transitionend 相当）。
   */
  triggerFadeOut: (onComplete: () => void) => void
  /** 1 本の再生が正常完了したときに呼ぶ（path = 再生した media:// URI）*/
  onPlayed: (path: string) => void
  /** 動画再生エラーが発生したときに呼ぶ（path, reason）*/
  onError: (path: string, reason: string) => void
  /** フェードイン完了（PLAYING に遷移した瞬間）を通知する */
  onFadeInDone: () => void
  /** フェードアウト完了（IDLE に戻った瞬間）を通知する */
  onFadeOutDone: () => void
  /** 動画の durationMs が確定したとき（loadedmetadata）に通知する */
  onDurationReady: (ms: number) => void
}

// ─── 状態型 ──────────────────────────────────────────────────────────────────

/** OverlayController の内部状態 */
export type OverlayState = 'IDLE' | 'LOADING' | 'FADE_IN' | 'PLAYING' | 'FADE_OUT'

// ─── OverlayController 本体 ───────────────────────────────────────────────────

export class OverlayController {
  private state: OverlayState = 'IDLE'
  /** 現在再生中（または試みている）の media:// URI */
  private currentPath: string | null = null
  private readonly opts: OverlayControllerOptions

  constructor(opts: OverlayControllerOptions) {
    this.opts = opts
  }

  /** 現在の状態を返す（テスト・デバッグ用）*/
  getState(): OverlayState {
    return this.state
  }

  /**
   * 動画を再生する。
   * IDLE 以外の状態では無視する（二重 play 防止）。
   *
   * 処理フロー:
   * 1. IDLE → LOADING: setSrc + イベントリスナ設定 + requestVideoFrameCallback 予約
   * 2. rvfc 発火 → LOADING → FADE_IN: setVisible(true) + フェードイン開始
   * 3. フェードイン完了 → FADE_IN → PLAYING: onFadeInDone + video.play()
   * 4. ended → PLAYING → FADE_OUT: onPlayed 通知 + フェードアウト開始
   * 5. フェードアウト完了 → FADE_OUT → IDLE: setVisible(false) + onFadeOutDone
   */
  play(path: string): void {
    // 二重 play 防止
    if (this.state !== 'IDLE') return

    this.currentPath = path
    this.state = 'LOADING'

    const { video } = this.opts

    // リスナを解放して新たに設定（24h 冪等性）
    video.clearListeners()
    video.setSrc(path)

    // loadedmetadata → duration 通知
    video.setOnLoadedMetadata((durationMs: number) => {
      this.opts.onDurationReady(durationMs)
    })

    // ended → フェードアウト開始
    video.setOnEnded(() => {
      if (this.state !== 'PLAYING') return
      this._startFadeOut()
    })

    // error → 即通知 + 状態復帰
    video.setOnError((reason: string) => {
      this._handleError(reason)
    })

    // requestVideoFrameCallback: 1 フレーム描画確定後に reveal
    video.requestVideoFrameCallback(() => {
      if (this.state !== 'LOADING') return
      this.state = 'FADE_IN'
      this.opts.setVisible(true)
      this.opts.triggerFadeIn(() => {
        if (this.state !== 'FADE_IN') return
        this.state = 'PLAYING'
        this.opts.onFadeInDone()
        video.play()
      })
    })
  }

  // ─── プライベートメソッド ────────────────────────────────────────────────

  /**
   * PLAYING → FADE_OUT: フェードアウト CSS を開始し、完了後に IDLE へ戻る。
   * 正常終了 (ended) のときに呼ぶ。
   */
  private _startFadeOut(): void {
    const path = this.currentPath ?? ''
    this.state = 'FADE_OUT'
    // 動画終了時点で onPlayed を通知（PLAYING->FADE_OUT）。以前は fade-out 完了時に
    // onFadeOutDone と同時に送っていたため scheduler の FADE_OUT ウォッチドッグが誤発火していた。
    this.opts.onPlayed(path)
    this.opts.triggerFadeOut(() => {
      if (this.state !== 'FADE_OUT') return
      this.state = 'IDLE'
      this.opts.setVisible(false)
      this.currentPath = null
      this.opts.onFadeOutDone()
    })
  }

  /**
   * エラー発生時の処理。
   * - LOADING (reveal 前): onError 通知のみ → IDLE
   * - FADE_IN / PLAYING (visible): onError 通知 → FADE_OUT → IDLE
   */
  private _handleError(reason: string): void {
    if (this.state === 'IDLE') return

    const path = this.currentPath ?? ''
    const wasVisible = this.state === 'FADE_IN' || this.state === 'PLAYING'

    // エラーを即座に通知
    this.opts.onError(path, reason)

    if (wasVisible) {
      // 表示中の場合はフェードアウトして IDLE へ
      this.state = 'FADE_OUT'
      this.opts.triggerFadeOut(() => {
        if (this.state !== 'FADE_OUT') return
        this.state = 'IDLE'
        this.opts.setVisible(false)
        this.currentPath = null
        this.opts.onFadeOutDone()
      })
    } else {
      // LOADING 中 (reveal 前) は即 IDLE へ
      this.state = 'IDLE'
      this.currentPath = null
    }
  }
}
