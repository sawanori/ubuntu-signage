/**
 * T15 — PlaybackOrchestrator
 *
 * Scheduler と PlaylistManager を結線するオーケストレーター。
 *
 * 責務:
 *   - Scheduler の tick（onFire）で PlaylistManager.next() を呼び次の動画パスを取得する
 *   - パスが取得できた場合は onPlay コールバックで再生要求を発行する
 *   - プレイリストが空（next() === null）の場合は WARN ログを出して IDLE に留まる
 *   - 再生完了・エラー・フェード完了を Scheduler に通知しカーソルを前進させる
 *     （カーソル前進は next() 呼び出し自体で完結するため、完了通知は状態遷移のみ担う）
 *
 * 設計方針:
 *   - Scheduler と PlaylistManager の両クラスを変更しない（読み込みのみ）
 *   - Scheduler はコンストラクタ内で生成し onFire に playlist.next() を渡す
 *   - テストでは playlist.next() を vi.spyOn でモック可能
 */

import { Scheduler } from './scheduler/scheduler'
import type { SchedulerLogger } from './scheduler/scheduler'
import type { PlaylistManager } from './playlist'
import type { SchedulerState } from '../shared/types'

/** PlaybackOrchestrator のコンストラクタオプション */
export interface PlaybackOrchestratorOptions {
  /** 巡回プレイリスト（PlaylistManager インスタンス） */
  playlist: PlaylistManager
  /** 再生開始コールバック（動画パスを渡す） */
  onPlay: (path: string) => void
  /** オーバーレイ表示/非表示コールバック */
  onSetVisible: (visible: boolean) => void
  /** 割り込み間隔（分）: 1 | 5 | 10 | 15 | 30 */
  intervalMinutes: 1 | 5 | 10 | 15 | 30
  /** 広告割り込み機能の有効/無効 */
  loopEnabled: boolean
  /** 構造化ロガー（Scheduler へ渡す） */
  logger: SchedulerLogger
}

export class PlaybackOrchestrator {
  private readonly scheduler: Scheduler
  private readonly playlist: PlaylistManager

  constructor(options: PlaybackOrchestratorOptions) {
    this.playlist = options.playlist

    this.scheduler = new Scheduler({
      intervalMinutes: options.intervalMinutes,
      loopEnabled: options.loopEnabled,
      /**
       * Scheduler の tick ハンドラ: PlaylistManager.next() を呼んで次の動画パスを返す。
       * null の場合は Scheduler 側で WARN ログを出して IDLE に戻る（scheduler.ts _doFire 参照）。
       */
      onFire: (): string | null => this.playlist.next(),
      onPlay: options.onPlay,
      onSetVisible: options.onSetVisible,
      logger: options.logger,
    })
  }

  // ---------------------------------------------------------------------------
  // 状態参照
  // ---------------------------------------------------------------------------

  /** 現在のスケジューラ状態を返す */
  getState(): SchedulerState {
    return this.scheduler.getState()
  }

  // ---------------------------------------------------------------------------
  // 外部通知メソッド（IPC ハンドラやテストから呼ぶ）
  // ---------------------------------------------------------------------------

  /** フェードイン完了通知: FADE_IN → PLAYING */
  notifyFadeInDone(): void {
    this.scheduler.notifyFadeInDone()
  }

  /**
   * 動画長通知: PLAYING ウォッチドッグを ms+30000ms に更新。
   * `overlay:duration-ready` 受信時に呼ぶ。
   */
  notifyDurationReady(ms: number): void {
    this.scheduler.notifyDurationReady(ms)
  }

  /**
   * 再生完了通知: PLAYING → FADE_OUT。
   * カーソル前進は次の tick の next() 呼び出しで行われる。
   */
  notifyPlayed(): void {
    this.scheduler.notifyPlayed()
  }

  /** 再生エラー通知: 非 IDLE → 強制 IDLE */
  notifyError(): void {
    this.scheduler.notifyError()
  }

  /** フェードアウト完了通知: FADE_OUT → IDLE（タイマー再装填） */
  notifyFadeOutDone(): void {
    this.scheduler.notifyFadeOutDone()
  }

  // ---------------------------------------------------------------------------
  // テスト再生・設定更新
  // ---------------------------------------------------------------------------

  /**
   * 今すぐテスト再生（設定パネルの「テスト再生」ボタン用）。
   * IDLE の場合のみ即時発火。IDLE 以外は WARN ログを出して no-op。
   */
  testPlay(): void {
    this.scheduler.testPlay()
  }

  /**
   * 設定変更を適用する。
   * IDLE 中に interval が変わった場合はタイマーをリセットする。
   */
  updateConfig(partial: {
    intervalMinutes?: 1 | 5 | 10 | 15 | 30
    loopEnabled?: boolean
  }): void {
    this.scheduler.updateConfig(partial)
  }

  /** リソース解放（テスト afterEach やアプリ終了時に呼ぶ） */
  dispose(): void {
    this.scheduler.dispose()
  }
}
