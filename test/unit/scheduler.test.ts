/**
 * T14 — scheduler 状態機械 ユニットテスト (US-01〜US-11)
 *
 * カバー範囲:
 *   US-01: 間隔ごとに発火 (IDLE → FADE_IN)
 *   US-02: ループ OFF → 発火しない
 *   US-03: PLAYING 中の発火はスキップ (多重発火スキップ)
 *   US-04: interval 変更で次の発火から新 interval
 *   US-05: loopEnabled false → 次の発火以降は止まる
 *   US-06: interval < 動画長 → 重複なし、再生完了起点で次を発火
 *   US-07: FADE_IN ウォッチドッグ (1500ms 超過で強制 IDLE + ERROR ログ)
 *   US-08: PLAYING ウォッチドッグ (duration-ready 受信後 ms+30s 超過で強制 IDLE + ERROR ログ)
 *   US-09: FADE_OUT ウォッチドッグ (3000ms 超過で強制 IDLE + ERROR ログ)
 *   US-10: testPlay() が IDLE 時に即時 FADE_IN を開始する
 *   US-11: testPlay() が IDLE 以外の時は no-op + WARN ログ
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Scheduler } from '../../src/main/scheduler/scheduler'
import type { SchedulerOptions } from '../../src/main/scheduler/scheduler'

describe('Scheduler', () => {
  let scheduler: Scheduler | undefined
  let mockOnFire: ReturnType<typeof vi.fn>
  let mockOnPlay: ReturnType<typeof vi.fn>
  let mockOnSetVisible: ReturnType<typeof vi.fn>
  let mockWarn: ReturnType<typeof vi.fn>
  let mockError: ReturnType<typeof vi.fn>

  function createScheduler(overrides: Partial<SchedulerOptions> = {}): Scheduler {
    return new Scheduler({
      intervalMinutes: 5,
      loopEnabled: true,
      onFire: mockOnFire as () => string | null,
      onPlay: mockOnPlay as (path: string) => void,
      onSetVisible: mockOnSetVisible as (visible: boolean) => void,
      logger: {
        warn: mockWarn as (event: string, data?: Record<string, unknown>) => void,
        error: mockError as (event: string, data?: Record<string, unknown>) => void,
      },
      ...overrides,
    })
  }

  beforeEach(() => {
    vi.useFakeTimers()
    mockOnFire = vi.fn().mockReturnValue('/path/to/video.mp4')
    mockOnPlay = vi.fn()
    mockOnSetVisible = vi.fn()
    mockWarn = vi.fn()
    mockError = vi.fn()
    scheduler = undefined
  })

  afterEach(() => {
    scheduler?.dispose()
    vi.useRealTimers()
  })

  // -------------------------------------------------------------------------
  // US-01: ループ ON・間隔 5 分 → fake timer で 5 分進める → FADE_IN に遷移
  // -------------------------------------------------------------------------
  it('US-01: fires once after 5-minute interval and transitions to FADE_IN', () => {
    scheduler = createScheduler({ intervalMinutes: 5, loopEnabled: true })
    expect(scheduler.getState()).toBe('IDLE')

    vi.advanceTimersByTime(5 * 60 * 1000)

    expect(scheduler.getState()).toBe('FADE_IN')
    expect(mockOnPlay).toHaveBeenCalledOnce()
    expect(mockOnPlay).toHaveBeenCalledWith('/path/to/video.mp4')
  })

  // -------------------------------------------------------------------------
  // US-02: ループ OFF → fake timer で 30 分進めても発火しない
  // -------------------------------------------------------------------------
  it('US-02: does not fire when loopEnabled is false', () => {
    scheduler = createScheduler({ intervalMinutes: 5, loopEnabled: false })

    vi.advanceTimersByTime(30 * 60 * 1000)

    expect(scheduler.getState()).toBe('IDLE')
    expect(mockOnPlay).not.toHaveBeenCalled()
  })

  // -------------------------------------------------------------------------
  // US-03: PLAYING 中に発火をトリガーしても多重発火スキップ (no-op + WARN)
  // -------------------------------------------------------------------------
  it('US-03: multi-fire is skipped (no-op + WARN) when triggered while PLAYING', () => {
    scheduler = createScheduler({ intervalMinutes: 5, loopEnabled: true })

    vi.advanceTimersByTime(5 * 60 * 1000) // IDLE → FADE_IN
    scheduler.notifyFadeInDone() // FADE_IN → PLAYING
    expect(scheduler.getState()).toBe('PLAYING')

    const playCallsBefore = (mockOnPlay as ReturnType<typeof vi.fn>).mock.calls.length

    // タイマー発火のシミュレーション（防御的チェックのテスト）
    scheduler.triggerFireForTest()

    expect(scheduler.getState()).toBe('PLAYING')
    expect((mockOnPlay as ReturnType<typeof vi.fn>).mock.calls.length).toBe(playCallsBefore)
    expect(mockWarn).toHaveBeenCalledWith('scheduler.multiFireSkipped', { state: 'PLAYING' })
  })

  // -------------------------------------------------------------------------
  // US-04: 間隔を 10 分→5 分に変更 → 前のタイマーリセット、次の発火は変更時刻+5分
  // -------------------------------------------------------------------------
  it('US-04: interval change resets timer; next fire occurs at change-time + new-interval', () => {
    scheduler = createScheduler({ intervalMinutes: 10, loopEnabled: true })

    // 5 分経過（10 分タイマーの半分）→まだ発火しない
    vi.advanceTimersByTime(5 * 60 * 1000)
    expect(scheduler.getState()).toBe('IDLE')
    expect(mockOnPlay).not.toHaveBeenCalled()

    // interval を 5 分に変更 → タイマーリセット（変更時刻から 5 分後に発火するよう再装填）
    scheduler.updateConfig({ intervalMinutes: 5 })

    // さらに 5 分経過 → 発火
    vi.advanceTimersByTime(5 * 60 * 1000)
    expect(scheduler.getState()).toBe('FADE_IN')
    expect(mockOnPlay).toHaveBeenCalledOnce()
  })

  // -------------------------------------------------------------------------
  // US-05: ON で動作中 → loopEnabled=false → 次の発火以降は止まる
  // -------------------------------------------------------------------------
  it('US-05: setting loopEnabled=false stops future fires (current play continues if active)', () => {
    scheduler = createScheduler({ intervalMinutes: 5, loopEnabled: true })

    // ループを OFF に変更
    scheduler.updateConfig({ loopEnabled: false })

    // 30 分経過 → 発火しない
    vi.advanceTimersByTime(30 * 60 * 1000)
    expect(scheduler.getState()).toBe('IDLE')
    expect(mockOnPlay).not.toHaveBeenCalled()
  })

  // -------------------------------------------------------------------------
  // US-05b: PLAYING 中に loopEnabled=false → notifyPlayed/fadeOutDone で正常完走 → 以降無発火
  // -------------------------------------------------------------------------
  it('US-05b: loopEnabled set to false while PLAYING → play completes normally, no subsequent fires', () => {
    scheduler = createScheduler({ intervalMinutes: 5, loopEnabled: true })

    // t=5min: 発火 → FADE_IN → PLAYING
    vi.advanceTimersByTime(5 * 60 * 1000)
    expect(scheduler.getState()).toBe('FADE_IN')
    scheduler.notifyFadeInDone()
    expect(scheduler.getState()).toBe('PLAYING')

    // PLAYING 中に loopEnabled=false へ変更（現在の再生は継続するはず）
    scheduler.updateConfig({ loopEnabled: false })
    expect(scheduler.getState()).toBe('PLAYING')

    // 再生を正常完了: PLAYING → FADE_OUT
    scheduler.notifyPlayed()
    expect(scheduler.getState()).toBe('FADE_OUT')

    // フェードアウト完了: FADE_OUT → IDLE（loopEnabled=false なのでタイマー装填なし）
    scheduler.notifyFadeOutDone()
    expect(scheduler.getState()).toBe('IDLE')

    // 30 分経過 → 以降は発火しない
    vi.advanceTimersByTime(30 * 60 * 1000)
    expect(scheduler.getState()).toBe('IDLE')
    expect(mockOnPlay).toHaveBeenCalledOnce() // 最初の1回のみ
  })

  // -------------------------------------------------------------------------
  // US-06: interval=1分・動画=2分 → 再生中に発火なし、再生完了+1分で次を発火
  // -------------------------------------------------------------------------
  it('US-06: interval < video length has no overlap; fires again after play completion + interval', () => {
    const videoLengthMs = 2 * 60 * 1000 // 2 分
    scheduler = createScheduler({ intervalMinutes: 1, loopEnabled: true })

    // t=0: IDLE, 1 分タイマー起動
    // t=1min: 発火 → FADE_IN
    vi.advanceTimersByTime(60 * 1000)
    expect(scheduler.getState()).toBe('FADE_IN')
    expect(mockOnFire).toHaveBeenCalledTimes(1)

    // フェードイン完了 → PLAYING（タイマーは停止中）
    scheduler.notifyFadeInDone()
    expect(scheduler.getState()).toBe('PLAYING')

    // 動画再生中（2 分経過）→ 新たな発火なし（タイマー停止中）
    vi.advanceTimersByTime(videoLengthMs)
    expect(scheduler.getState()).toBe('PLAYING')
    expect(mockOnFire).toHaveBeenCalledTimes(1)

    // 再生完了 → FADE_OUT
    scheduler.notifyPlayed()
    expect(scheduler.getState()).toBe('FADE_OUT')

    // フェードアウト完了 → IDLE（この時点からタイマー再装填）
    scheduler.notifyFadeOutDone()
    expect(scheduler.getState()).toBe('IDLE')

    // さらに 1 分経過 → 2 回目の発火（再生完了起点）
    vi.advanceTimersByTime(60 * 1000)
    expect(scheduler.getState()).toBe('FADE_IN')
    expect(mockOnFire).toHaveBeenCalledTimes(2)
  })

  // -------------------------------------------------------------------------
  // US-07: FADE_IN ウォッチドッグ: 15000ms 超過 → 強制 IDLE + ERROR ログ
  //        (WATCHDOG_FADE_IN_MS=15000: load+decode+reveal+フェードを賄うマージン)
  // -------------------------------------------------------------------------
  it('US-07: FADE_IN watchdog triggers after 15000ms and forces IDLE with ERROR log', () => {
    scheduler = createScheduler({ intervalMinutes: 5, loopEnabled: true })

    vi.advanceTimersByTime(5 * 60 * 1000) // IDLE → FADE_IN
    expect(scheduler.getState()).toBe('FADE_IN')

    // notifyFadeInDone() を呼ばずに 16000ms 経過（15000ms ウォッチドッグ超過）
    vi.advanceTimersByTime(16_000)

    // 15000ms でウォッチドッグ発動 → 強制 IDLE
    expect(scheduler.getState()).toBe('IDLE')
    expect(mockOnSetVisible).toHaveBeenCalledWith(false)
    expect(mockError).toHaveBeenCalledWith('scheduler.watchdogTriggered', { state: 'FADE_IN' })
  })

  // -------------------------------------------------------------------------
  // US-08: PLAYING ウォッチドッグ: duration-ready 受信後 ms+30s 超過 → 強制 IDLE + ERROR ログ
  // -------------------------------------------------------------------------
  it('US-08: PLAYING watchdog triggers after duration+30s when duration-ready was received', () => {
    const videoLengthMs = 60 * 1000 // 1 分
    scheduler = createScheduler({ intervalMinutes: 5, loopEnabled: true })

    vi.advanceTimersByTime(5 * 60 * 1000) // IDLE → FADE_IN
    scheduler.notifyFadeInDone() // FADE_IN → PLAYING（デフォルト 300s ウォッチドッグ）

    // duration-ready 受信 → ウォッチドッグを videoLengthMs+30000ms にリセット
    scheduler.notifyDurationReady(videoLengthMs)

    // videoLengthMs+31s 進める（watchdog = videoLengthMs+30000ms を超過）
    vi.advanceTimersByTime(videoLengthMs + 31 * 1000)

    // ウォッチドッグ発動 → 強制 IDLE
    expect(scheduler.getState()).toBe('IDLE')
    expect(mockOnSetVisible).toHaveBeenCalledWith(false)
    expect(mockError).toHaveBeenCalledWith('scheduler.watchdogTriggered', { state: 'PLAYING' })
  })

  // -------------------------------------------------------------------------
  // US-08b: FADE_IN 中に duration-ready を受信 → PLAYING 遷移時に精密ウォッチドッグが適用される
  // -------------------------------------------------------------------------
  it('US-08b: duration received during FADE_IN is applied as precise watchdog on PLAYING transition', () => {
    const videoLengthMs = 60 * 1000 // 1 分
    scheduler = createScheduler({ intervalMinutes: 5, loopEnabled: true })

    vi.advanceTimersByTime(5 * 60 * 1000) // IDLE → FADE_IN
    expect(scheduler.getState()).toBe('FADE_IN')

    // FADE_IN 中に duration-ready が着信（通常より早い通知）
    scheduler.notifyDurationReady(videoLengthMs)
    expect(scheduler.getState()).toBe('FADE_IN') // まだ FADE_IN のまま

    // フェードイン完了 → PLAYING（pending duration が適用されるはず）
    scheduler.notifyFadeInDone()
    expect(scheduler.getState()).toBe('PLAYING')

    // videoLengthMs+31s 進める（精密ウォッチドッグ = 60s+30s = 90s を超過）
    // 暫定 300s ウォッチドッグならまだ発動しないが、精密なら発動する
    vi.advanceTimersByTime(videoLengthMs + 31 * 1000) // 91s 経過

    // FADE_IN 中着信 duration が PLAYING で精密ウォッチドッグとして適用されたことを確認
    expect(scheduler.getState()).toBe('IDLE')
    expect(mockOnSetVisible).toHaveBeenCalledWith(false)
    expect(mockError).toHaveBeenCalledWith('scheduler.watchdogTriggered', { state: 'PLAYING' })
  })

  // -------------------------------------------------------------------------
  // US-09: FADE_OUT ウォッチドッグ: 3000ms 超過 → 強制 IDLE + ERROR ログ
  // -------------------------------------------------------------------------
  it('US-09: FADE_OUT watchdog triggers after 3000ms and forces IDLE with ERROR log', () => {
    scheduler = createScheduler({ intervalMinutes: 5, loopEnabled: true })

    vi.advanceTimersByTime(5 * 60 * 1000) // IDLE → FADE_IN
    scheduler.notifyFadeInDone() // FADE_IN → PLAYING
    scheduler.notifyPlayed() // PLAYING → FADE_OUT
    expect(scheduler.getState()).toBe('FADE_OUT')

    // notifyFadeOutDone() を呼ばずに 4000ms 経過
    vi.advanceTimersByTime(4000)

    // 3000ms でウォッチドッグ発動 → 強制 IDLE
    expect(scheduler.getState()).toBe('IDLE')
    expect(mockOnSetVisible).toHaveBeenCalledWith(false)
    expect(mockError).toHaveBeenCalledWith('scheduler.watchdogTriggered', { state: 'FADE_OUT' })
  })

  // -------------------------------------------------------------------------
  // US-09b: notifyError() が WARN ログ "scheduler.forcedIdleOnError" を出力する
  // -------------------------------------------------------------------------
  it('US-09b: notifyError() emits WARN log scheduler.forcedIdleOnError and forces IDLE', () => {
    scheduler = createScheduler({ intervalMinutes: 5, loopEnabled: true })

    vi.advanceTimersByTime(5 * 60 * 1000) // IDLE → FADE_IN
    scheduler.notifyFadeInDone() // FADE_IN → PLAYING
    expect(scheduler.getState()).toBe('PLAYING')

    scheduler.notifyError()

    expect(scheduler.getState()).toBe('IDLE')
    expect(mockOnSetVisible).toHaveBeenCalledWith(false)
    expect(mockWarn).toHaveBeenCalledWith('scheduler.forcedIdleOnError', { state: 'PLAYING' })
  })

  // -------------------------------------------------------------------------
  // US-10: IDLE 状態で testPlay() → 即時 FADE_IN
  // -------------------------------------------------------------------------
  it('US-10: testPlay() when IDLE immediately triggers FADE_IN', () => {
    scheduler = createScheduler({ intervalMinutes: 5, loopEnabled: true })
    expect(scheduler.getState()).toBe('IDLE')

    scheduler.testPlay()

    expect(scheduler.getState()).toBe('FADE_IN')
    expect(mockOnPlay).toHaveBeenCalledOnce()
    expect(mockOnPlay).toHaveBeenCalledWith('/path/to/video.mp4')
  })

  // -------------------------------------------------------------------------
  // US-11: PLAYING 状態で testPlay() → no-op + WARN ログ
  // -------------------------------------------------------------------------
  it('US-11: testPlay() when PLAYING is a no-op with WARN log', () => {
    scheduler = createScheduler({ intervalMinutes: 5, loopEnabled: true })

    vi.advanceTimersByTime(5 * 60 * 1000) // IDLE → FADE_IN
    scheduler.notifyFadeInDone() // FADE_IN → PLAYING
    expect(scheduler.getState()).toBe('PLAYING')

    const playCallsBefore = (mockOnPlay as ReturnType<typeof vi.fn>).mock.calls.length

    scheduler.testPlay()

    expect(scheduler.getState()).toBe('PLAYING')
    expect((mockOnPlay as ReturnType<typeof vi.fn>).mock.calls.length).toBe(playCallsBefore)
    expect(mockWarn).toHaveBeenCalledWith('scheduler.testPlayIgnored', { state: 'PLAYING' })
  })
})
