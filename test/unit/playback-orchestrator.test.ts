/**
 * T15 — PlaybackOrchestrator ユニットテスト (US-12〜US-14)
 *
 * カバー範囲:
 *   US-12: プレイリスト空のときタイマー発火 → WARN ログ → IDLE に戻る
 *   US-13: ループ ON・1 本のみ → 3 サイクル → 同じファイルが 3 回再生される
 *   US-14: ループ ON・N 本 → N+1 サイクル → 先頭に戻って再度 1 本目が再生される
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { PlaybackOrchestrator } from '../../src/main/playback-orchestrator'
import { PlaylistManager } from '../../src/main/playlist'

describe('PlaybackOrchestrator', () => {
  let mockOnPlay: ReturnType<typeof vi.fn>
  let mockOnSetVisible: ReturnType<typeof vi.fn>
  let mockWarn: ReturnType<typeof vi.fn>
  let mockError: ReturnType<typeof vi.fn>
  let playlist: PlaylistManager
  let orchestrator: PlaybackOrchestrator | undefined

  beforeEach(() => {
    vi.useFakeTimers()
    mockOnPlay = vi.fn()
    mockOnSetVisible = vi.fn()
    mockWarn = vi.fn()
    mockError = vi.fn()
    // PlaylistManager with noop logger (no files loaded → empty)
    playlist = new PlaylistManager()
    orchestrator = undefined
  })

  afterEach(() => {
    orchestrator?.dispose()
    vi.useRealTimers()
  })

  // ---------------------------------------------------------------------------
  // US-12: 空フォルダ tick で no-op + WARN ログ
  // ---------------------------------------------------------------------------
  it('US-12: empty playlist on tick → warns and stays IDLE', () => {
    orchestrator = new PlaybackOrchestrator({
      playlist,
      onPlay: mockOnPlay as (path: string) => void,
      onSetVisible: mockOnSetVisible as (visible: boolean) => void,
      intervalMinutes: 5,
      loopEnabled: true,
      logger: {
        warn: mockWarn as (event: string, data?: Record<string, unknown>) => void,
        error: mockError as (event: string, data?: Record<string, unknown>) => void,
      },
    })

    expect(orchestrator.getState()).toBe('IDLE')

    // タイマー発火（5 分経過）
    vi.advanceTimersByTime(5 * 60 * 1000)

    // 空プレイリスト → no-op（onPlay 未呼出し）、IDLE 維持
    expect(orchestrator.getState()).toBe('IDLE')
    expect(mockOnPlay).not.toHaveBeenCalled()
    // WARN ログが scheduler から出ること
    expect(mockWarn).toHaveBeenCalledWith('playlist.empty', {})
  })

  // ---------------------------------------------------------------------------
  // US-13: ループ ON・1 本のみ → 3 サイクル → 同じファイルが 3 回再生される
  // ---------------------------------------------------------------------------
  it('US-13: single file is played for 3 cycles in a row', () => {
    const filePath = '/videos/clip-001.mp4'
    vi.spyOn(playlist, 'next').mockReturnValue(filePath)

    orchestrator = new PlaybackOrchestrator({
      playlist,
      onPlay: mockOnPlay as (path: string) => void,
      onSetVisible: mockOnSetVisible as (visible: boolean) => void,
      intervalMinutes: 1,
      loopEnabled: true,
      logger: {
        warn: mockWarn as (event: string, data?: Record<string, unknown>) => void,
        error: mockError as (event: string, data?: Record<string, unknown>) => void,
      },
    })

    // 3 サイクルを完走する
    for (let i = 0; i < 3; i++) {
      vi.advanceTimersByTime(60 * 1000) // 1 分経過 → tick
      expect(orchestrator.getState()).toBe('FADE_IN')

      orchestrator.notifyFadeInDone() // FADE_IN → PLAYING
      expect(orchestrator.getState()).toBe('PLAYING')

      orchestrator.notifyPlayed() // PLAYING → FADE_OUT
      expect(orchestrator.getState()).toBe('FADE_OUT')

      orchestrator.notifyFadeOutDone() // FADE_OUT → IDLE
      expect(orchestrator.getState()).toBe('IDLE')
    }

    // 3 回とも同じファイルが再生された
    expect(mockOnPlay).toHaveBeenCalledTimes(3)
    expect(mockOnPlay).toHaveBeenNthCalledWith(1, filePath)
    expect(mockOnPlay).toHaveBeenNthCalledWith(2, filePath)
    expect(mockOnPlay).toHaveBeenNthCalledWith(3, filePath)
  })

  // ---------------------------------------------------------------------------
  // US-14: ループ ON・N 本 → N+1 サイクル → 先頭に戻って再度 1 本目が再生される
  // ---------------------------------------------------------------------------
  it('US-14: N files cycle back to the first file on N+1th cycle', () => {
    const files = ['/videos/a.mp4', '/videos/b.mp4', '/videos/c.mp4']
    let callCount = 0
    vi.spyOn(playlist, 'next').mockImplementation((): string | null => {
      const file = files[callCount % files.length]
      callCount++
      return file ?? null
    })

    orchestrator = new PlaybackOrchestrator({
      playlist,
      onPlay: mockOnPlay as (path: string) => void,
      onSetVisible: mockOnSetVisible as (visible: boolean) => void,
      intervalMinutes: 1,
      loopEnabled: true,
      logger: {
        warn: mockWarn as (event: string, data?: Record<string, unknown>) => void,
        error: mockError as (event: string, data?: Record<string, unknown>) => void,
      },
    })

    // N+1 = 4 サイクル完走
    for (let i = 0; i < 4; i++) {
      vi.advanceTimersByTime(60 * 1000)
      expect(orchestrator.getState()).toBe('FADE_IN')
      orchestrator.notifyFadeInDone()
      orchestrator.notifyPlayed()
      orchestrator.notifyFadeOutDone()
      expect(orchestrator.getState()).toBe('IDLE')
    }

    // a → b → c → a（先頭に循環）
    expect(mockOnPlay).toHaveBeenCalledTimes(4)
    expect(mockOnPlay).toHaveBeenNthCalledWith(1, '/videos/a.mp4')
    expect(mockOnPlay).toHaveBeenNthCalledWith(2, '/videos/b.mp4')
    expect(mockOnPlay).toHaveBeenNthCalledWith(3, '/videos/c.mp4')
    expect(mockOnPlay).toHaveBeenNthCalledWith(4, '/videos/a.mp4')
  })
})
