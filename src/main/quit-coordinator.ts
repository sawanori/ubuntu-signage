/**
 * src/main/quit-coordinator.ts — 修正 B
 *
 * 終了確認フロー（2段押し）の状態管理を担うクラス。
 *
 * 設計方針:
 *   - 確認状態（armed）と3秒タイマーを Main プロセスに置き、単一真実源とする。
 *   - Ctrl+Q と設定パネルの終了ボタンが同じ "armed" 状態を共有できる。
 *   - 全依存を DI で注入してユニットテスト可能（Electron 未参照）。
 *
 * 状態遷移:
 *   disarmed → requestQuit() → armed（タイマー開始）
 *   armed → requestQuit() → quit()（確定終了）
 *   armed → タイムアウト → disarmed（自動リセット）
 *   armed → disarm() → disarmed（手動リセット）
 */

export interface QuitCoordinatorOptions {
  /** アプリを終了する関数（本番: () => app.quit()） */
  quit: () => void
  /**
   * armed 状態が変化したときに呼ばれるコールバック。
   * true: 確認待ち状態になった / false: 確認待ち解除された
   */
  onArmedChange: (armed: boolean) => void
  /** setTimeout 実装（DI によりテストで fake timer を注入可能） */
  setTimeoutFn: typeof setTimeout
  /** clearTimeout 実装（DI によりテストで fake timer を注入可能） */
  clearTimeoutFn: typeof clearTimeout
  /** 確認待ちウィンドウ (ms)。デフォルト 3000 */
  confirmWindowMs?: number
}

/**
 * 2段押し終了フロー（armed / confirm）を管理するコーディネータ。
 *
 * - 1回目の requestQuit(): disarmed → armed + onArmedChange(true) + タイマー開始
 * - 2回目の requestQuit(): armed → タイマー解除 + quit()
 * - タイムアウト: armed → disarmed + onArmedChange(false)
 * - disarm(): armed → disarmed + onArmedChange(false)（パネル閉じ時に呼ぶ）
 */
export class QuitCoordinator {
  private readonly quit: () => void
  private readonly onArmedChange: (armed: boolean) => void
  private readonly setTimeoutFn: typeof setTimeout
  private readonly clearTimeoutFn: typeof clearTimeout
  private readonly confirmWindowMs: number

  private armed = false
  private timerId: ReturnType<typeof setTimeout> | null = null

  constructor(options: QuitCoordinatorOptions) {
    this.quit = options.quit
    this.onArmedChange = options.onArmedChange
    this.setTimeoutFn = options.setTimeoutFn
    this.clearTimeoutFn = options.clearTimeoutFn
    this.confirmWindowMs = options.confirmWindowMs ?? 3000
  }

  /**
   * 終了要求を処理する。
   *
   * - disarmed 状態: armed に遷移しタイマーを開始する。
   * - armed 状態: タイマーを解除し quit() を呼んでアプリを終了する。
   *
   * 多重 requestQuit によるタイマーリークは発生しない
   * （armed=true の経路では既存タイマーを必ず解除してから quit() を呼ぶ）。
   */
  requestQuit(): void {
    if (!this.armed) {
      // 1回目: disarmed → armed
      this.armed = true
      this.onArmedChange(true)
      this.timerId = this.setTimeoutFn(() => {
        this.disarm()
      }, this.confirmWindowMs)
    } else {
      // 2回目: 確定終了
      this._clearTimer()
      this.quit()
    }
  }

  /**
   * 確認待ち状態を解除する。
   *
   * armed=false の状態で呼んだ場合は no-op（エラーなし）。
   * 設定パネルを閉じたときに呼ぶことで、パネルを閉じたら確認状態がリセットされる（C1）。
   */
  disarm(): void {
    if (!this.armed) return
    this._clearTimer()
    this.armed = false
    this.onArmedChange(false)
  }

  /** 内部タイマーを解除するヘルパー */
  private _clearTimer(): void {
    if (this.timerId !== null) {
      this.clearTimeoutFn(this.timerId)
      this.timerId = null
    }
  }
}
