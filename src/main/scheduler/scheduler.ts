/**
 * src/main/scheduler/scheduler.ts — T14
 *
 * スケジューラ状態機械（ウォッチドッグ付き・計時停止方式）
 *
 * 状態遷移:
 *   IDLE ──(interval 経過 & loopEnabled & 動画あり)──► FADE_IN
 *   FADE_IN ──(フェードイン完了通知)────────────────► PLAYING
 *   PLAYING ──(再生完了 / エラー通知)─────────────── ► FADE_OUT
 *   FADE_OUT ──(フェードアウト完了通知)──────────────► IDLE
 *
 * 計時基準: 割り込み終了時刻（FADE_OUT 完了時刻）+ interval で再装填。
 *          再生中（FADE_IN / PLAYING / FADE_OUT）はタイマー停止。
 *
 * 多重発火スキップ: IDLE 以外の状態での発火は no-op + WARN ログ。
 *
 * ウォッチドッグ:
 *   - FADE_IN  : 1500ms 超過 → 強制 IDLE + ERROR ログ
 *   - PLAYING  : duration-ready 受信前は 300s、受信後は ms+30000ms
 *   - FADE_OUT : 3000ms 超過 → 強制 IDLE + ERROR ログ
 */

import type { SchedulerState } from '../../shared/types'

// ウォッチドッグ定数
/** FADE_IN: load+decode+reveal+フェード（~1000ms）を賄う余裕マージン。正確な値は T09/[M] で実機検証。 */
const WATCHDOG_FADE_IN_MS = 15_000
/** FADE_OUT: アニメーション完了通知の上限（3s）。2000ms フェードアウト + イベント遅延の余裕マージン。*/
const WATCHDOG_FADE_MS = 3000
const WATCHDOG_PLAYING_DEFAULT_MS = 300_000

/** ロガーインターフェース（依存注入） */
export interface SchedulerLogger {
  warn(event: string, data?: Record<string, unknown>): void
  error(event: string, data?: Record<string, unknown>): void
}

/** Scheduler のコンストラクタオプション */
export interface SchedulerOptions {
  /** 割り込み間隔（分）: 1 | 5 | 10 | 15 | 30 */
  intervalMinutes: 1 | 5 | 10 | 15 | 30
  /** 広告割り込み機能の有効/無効 */
  loopEnabled: boolean
  /**
   * タイマー発火時に次の動画パスを返すコールバック。
   * null を返すと空プレイリストとして扱い IDLE を維持する。
   */
  onFire: () => string | null
  /** 再生開始を要求するコールバック（パスを渡す） */
  onPlay: (path: string) => void
  /** オーバーレイ表示/非表示を制御するコールバック */
  onSetVisible: (visible: boolean) => void
  /** 構造化ロガー */
  logger: SchedulerLogger
}

export class Scheduler {
  private state: SchedulerState = 'IDLE'
  private intervalMs: number
  private loopEnabled: boolean

  private readonly onFire: () => string | null
  private readonly onPlay: (path: string) => void
  private readonly onSetVisible: (visible: boolean) => void
  private readonly logger: SchedulerLogger

  private intervalTimer: ReturnType<typeof setTimeout> | null = null
  private watchdogTimer: ReturnType<typeof setTimeout> | null = null
  /** FADE_IN 中に受信した duration を保持し、PLAYING 遷移時に精密ウォッチドッグへ適用する */
  private _pendingDurationMs: number | null = null

  constructor(options: SchedulerOptions) {
    this.intervalMs = options.intervalMinutes * 60_000
    this.loopEnabled = options.loopEnabled
    this.onFire = options.onFire
    this.onPlay = options.onPlay
    this.onSetVisible = options.onSetVisible
    this.logger = options.logger

    // 起動時に interval タイマーを装填
    this._scheduleNext()
  }

  /** 現在の状態を返す */
  getState(): SchedulerState {
    return this.state
  }

  // ---------------------------------------------------------------------------
  // 外部からの通知メソッド（IPC ハンドラやテストから呼ぶ）
  // ---------------------------------------------------------------------------

  /** フェードイン完了通知: FADE_IN → PLAYING */
  notifyFadeInDone(): void {
    if (this.state !== 'FADE_IN') return
    this._clearWatchdog()
    this.state = 'PLAYING'
    // FADE_IN 中に受信した pending duration があれば精密ウォッチドッグを適用、なければ暫定 300s
    if (this._pendingDurationMs !== null) {
      const ms = this._pendingDurationMs
      this._pendingDurationMs = null
      this._applyDurationWatchdog(ms)
    } else {
      this.watchdogTimer = setTimeout(() => {
        this.watchdogTimer = null
        this.logger.error('scheduler.watchdogTriggered', { state: 'PLAYING' })
        this._forceIdle()
      }, WATCHDOG_PLAYING_DEFAULT_MS)
    }
  }

  /**
   * 動画長通知: PLAYING ウォッチドッグを ms+30000ms に更新。
   * `overlay:duration-ready` 受信時に呼ぶ。
   * FADE_IN 中に着信した場合は pending として保持し、PLAYING 遷移時に適用する。
   */
  notifyDurationReady(ms: number): void {
    if (this.state === 'FADE_IN') {
      // FADE_IN 中は pending に保持（PLAYING 遷移時に精密ウォッチドッグへ適用）
      this._pendingDurationMs = ms
      return
    }
    if (this.state !== 'PLAYING') return
    this._applyDurationWatchdog(ms)
  }

  /** 再生完了通知: PLAYING → FADE_OUT */
  notifyPlayed(): void {
    if (this.state !== 'PLAYING') return
    this._clearWatchdog()
    this._enterFadeOut()
  }

  /** 再生エラー通知: 非 IDLE → 強制 IDLE + WARN ログ */
  notifyError(): void {
    if (this.state === 'IDLE') return
    this.logger.warn('scheduler.forcedIdleOnError', { state: this.state })
    this._clearWatchdog()
    this._forceIdle()
  }

  /** フェードアウト完了通知: FADE_OUT → IDLE（タイマー再装填） */
  notifyFadeOutDone(): void {
    if (this.state !== 'FADE_OUT') return
    this._clearWatchdog()
    this._enterIdle()
  }

  // ---------------------------------------------------------------------------
  // テスト再生・設定更新
  // ---------------------------------------------------------------------------

  /**
   * 今すぐテスト再生（設定パネルの「テスト再生」ボタン用）。
   * IDLE の場合のみ即時発火。IDLE 以外は WARN ログを出して no-op。
   */
  testPlay(): void {
    if (this.state !== 'IDLE') {
      this.logger.warn('scheduler.testPlayIgnored', { state: this.state })
      return
    }
    // 通常の interval タイマーをキャンセルして即時発火
    this._clearIntervalTimer()
    this._doFire()
  }

  /**
   * 設定変更を適用する。
   * IDLE 中に interval が変わった場合はタイマーをリセットする。
   */
  updateConfig(partial: {
    intervalMinutes?: 1 | 5 | 10 | 15 | 30
    loopEnabled?: boolean
  }): void {
    if (partial.intervalMinutes !== undefined) {
      this.intervalMs = partial.intervalMinutes * 60_000
    }
    if (partial.loopEnabled !== undefined) {
      this.loopEnabled = partial.loopEnabled
    }
    // IDLE 中は即座にタイマーをリセット（変更時刻 + 新 interval で再装填）
    if (this.state === 'IDLE') {
      this._scheduleNext()
    }
    // 再生中（FADE_IN/PLAYING/FADE_OUT）は IDLE 復帰時に新設定を適用する
  }

  /** リソース解放（テスト afterEach やアプリ終了時に呼ぶ） */
  dispose(): void {
    this._clearIntervalTimer()
    this._clearWatchdog()
  }

  // ---------------------------------------------------------------------------
  // テスト専用: 内部タイマー発火のシミュレーション
  // ---------------------------------------------------------------------------

  /**
   * テスト専用メソッド: 内部タイマー発火ハンドラ (_doFire) を直接呼び出す。
   * IDLE 以外のときに呼ぶと多重発火スキップが働くことを確認するために使用する。
   */
  triggerFireForTest(): void {
    this._doFire()
  }

  // ---------------------------------------------------------------------------
  // プライベートメソッド
  // ---------------------------------------------------------------------------

  /** interval タイマーを消去する */
  private _clearIntervalTimer(): void {
    if (this.intervalTimer !== null) {
      clearTimeout(this.intervalTimer)
      this.intervalTimer = null
    }
  }

  /** ウォッチドッグタイマーを消去する */
  private _clearWatchdog(): void {
    if (this.watchdogTimer !== null) {
      clearTimeout(this.watchdogTimer)
      this.watchdogTimer = null
    }
  }

  /** PLAYING ウォッチドッグを ms+30000ms で装填する */
  private _applyDurationWatchdog(ms: number): void {
    this._clearWatchdog()
    this.watchdogTimer = setTimeout(() => {
      this.watchdogTimer = null
      this.logger.error('scheduler.watchdogTriggered', { state: 'PLAYING' })
      this._forceIdle()
    }, ms + 30_000)
  }

  /**
   * IDLE 状態から次の interval タイマーを装填する。
   * loopEnabled=false の場合はタイマーを設定しない（timer をクリアして終了）。
   */
  private _scheduleNext(): void {
    this._clearIntervalTimer()
    if (!this.loopEnabled) return

    this.intervalTimer = setTimeout(() => {
      this.intervalTimer = null
      this._doFire()
    }, this.intervalMs)
  }

  /**
   * 発火ハンドラ: IDLE の場合のみ再生を開始する。
   * IDLE 以外のときは多重発火スキップ（WARN ログ）。
   */
  private _doFire(): void {
    if (this.state !== 'IDLE') {
      this.logger.warn('scheduler.multiFireSkipped', { state: this.state })
      return
    }

    const path = this.onFire()
    if (path === null) {
      this.logger.warn('playlist.empty', {})
      // 空プレイリストの場合は IDLE のまま次のタイマーを再装填
      this._scheduleNext()
      return
    }

    this._enterFadeIn(path)
  }

  /** FADE_IN 状態へ遷移し、ウォッチドッグを装填する */
  private _enterFadeIn(path: string): void {
    this.state = 'FADE_IN'
    this.onPlay(path)
    this._clearWatchdog()
    this.watchdogTimer = setTimeout(() => {
      this.watchdogTimer = null
      this.logger.error('scheduler.watchdogTriggered', { state: 'FADE_IN' })
      this._forceIdle()
    }, WATCHDOG_FADE_IN_MS)
  }

  /** FADE_OUT 状態へ遷移し、ウォッチドッグを装填する */
  private _enterFadeOut(): void {
    this.state = 'FADE_OUT'
    this._clearWatchdog()
    this.watchdogTimer = setTimeout(() => {
      this.watchdogTimer = null
      this.logger.error('scheduler.watchdogTriggered', { state: 'FADE_OUT' })
      this._forceIdle()
    }, WATCHDOG_FADE_MS)
  }

  /**
   * IDLE 状態へ正常遷移（FADE_OUT 完了後）。
   * onSetVisible(false) を呼んでオーバーレイを非表示にし、次の interval タイマーを装填する。
   */
  private _enterIdle(): void {
    this.state = 'IDLE'
    this.onSetVisible(false)
    this._scheduleNext()
  }

  /**
   * ウォッチドッグ発動または notifyError による強制 IDLE 遷移。
   * onSetVisible(false) を呼んでオーバーレイを非表示にし、次の interval タイマーを装填する。
   */
  private _forceIdle(): void {
    this._clearWatchdog()
    this._pendingDurationMs = null
    this.state = 'IDLE'
    this.onSetVisible(false)
    this._scheduleNext()
  }
}
