/**
 * T16/T17 — overlay-controller.test.ts
 *
 * overlay-controller.ts の DOM 非依存ロジックをテストする。
 * VideoElement はモックに差し替え、状態機械・コールバック呼び出しを純粋に検証する。
 *
 * カバー範囲:
 *   OC-01: 正常フロー: play(path) → setSrc → rvfc fires → setVisible(true) → fadeIn →
 *          PLAYING + onFadeInDone → ended + onPlayed → fadeOut → IDLE + setVisible(false) + onFadeOutDone
 *   OC-02: エラーフロー (LOADING 中): onError → 即 IDLE + onError 通知 (setVisible 呼ばない)
 *   OC-03: エラーフロー (PLAYING 中): onError → onError 通知 + fadeOut + setVisible(false) + IDLE
 *   OC-04: フェード状態遷移が正しい順序で通過する
 *   OC-05: 二重 play 防止: LOADING/FADE_IN/PLAYING 中に play() を呼んでも無視される
 *   OC-06: requestVideoFrameCallback fires する前に error → LOADING state でエラー処理
 *   OC-07: play 完了後に IDLE に戻り、再び play() が受け付けられる
 *   OC-08: onDurationReady が loadedMetadata イベントで呼ばれる
 *   OC-09: onFadeOutDone が呼ばれる（フェードアウト完了通知）
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  OverlayController,
  type IVideoElement,
  type OverlayControllerOptions,
} from '../../src/renderer/overlay/overlay-controller'

// ─── モック VideoElement ────────────────────────────────────────────────────

function createMockVideo(): IVideoElement & {
  _triggerEnded: () => void
  _triggerError: (reason: string) => void
  _triggerLoadedMetadata: (durationMs: number) => void
  _triggerRvfc: () => void
} {
  let endedHandler: (() => void) | null = null
  let errorHandler: ((reason: string) => void) | null = null
  let metadataHandler: ((durationMs: number) => void) | null = null
  let rvfcCallback: (() => void) | null = null

  return {
    setSrc: vi.fn(),
    play: vi.fn(),
    pause: vi.fn(),
    setOnEnded(handler) {
      endedHandler = handler
    },
    setOnError(handler) {
      errorHandler = handler
    },
    setOnLoadedMetadata(handler) {
      metadataHandler = handler
    },
    requestVideoFrameCallback(callback) {
      rvfcCallback = callback
    },
    clearListeners() {
      endedHandler = null
      errorHandler = null
      metadataHandler = null
      rvfcCallback = null
    },
    _triggerEnded() {
      endedHandler?.()
    },
    _triggerError(reason: string) {
      errorHandler?.(reason)
    },
    _triggerLoadedMetadata(durationMs: number) {
      metadataHandler?.(durationMs)
    },
    _triggerRvfc() {
      rvfcCallback?.()
    },
  }
}

// ─── ヘルパー ────────────────────────────────────────────────────────────────

function createController(
  video: IVideoElement,
  overrides: Partial<Omit<OverlayControllerOptions, 'video'>> = {},
): {
  ctrl: OverlayController
  setVisible: ReturnType<typeof vi.fn>
  triggerFadeIn: ReturnType<typeof vi.fn>
  triggerFadeOut: ReturnType<typeof vi.fn>
  onPlayed: ReturnType<typeof vi.fn>
  onError: ReturnType<typeof vi.fn>
  onFadeInDone: ReturnType<typeof vi.fn>
  onFadeOutDone: ReturnType<typeof vi.fn>
  onDurationReady: ReturnType<typeof vi.fn>
} {
  const setVisible = vi.fn()
  const triggerFadeIn = vi.fn()
  const triggerFadeOut = vi.fn()
  const onPlayed = vi.fn()
  const onError = vi.fn()
  const onFadeInDone = vi.fn()
  const onFadeOutDone = vi.fn()
  const onDurationReady = vi.fn()

  const opts: OverlayControllerOptions = {
    video,
    setVisible: setVisible as (v: boolean) => void,
    triggerFadeIn: triggerFadeIn as (cb: () => void) => void,
    triggerFadeOut: triggerFadeOut as (cb: () => void) => void,
    onPlayed: onPlayed as (path: string) => void,
    onError: onError as (path: string, reason: string) => void,
    onFadeInDone: onFadeInDone as () => void,
    onFadeOutDone: onFadeOutDone as () => void,
    onDurationReady: onDurationReady as (ms: number) => void,
    ...overrides,
  }

  return {
    ctrl: new OverlayController(opts),
    setVisible,
    triggerFadeIn,
    triggerFadeOut,
    onPlayed,
    onError,
    onFadeInDone,
    onFadeOutDone,
    onDurationReady,
  }
}

// ─── テスト ──────────────────────────────────────────────────────────────────

describe('OverlayController', () => {
  let mockVideo: ReturnType<typeof createMockVideo>

  beforeEach(() => {
    mockVideo = createMockVideo()
  })

  // ─────────────────────────────────────────────────────────────────────────
  // OC-01: 正常フロー全体
  // ─────────────────────────────────────────────────────────────────────────
  it('OC-01: normal flow — setSrc → rvfc → reveal → fadeIn → PLAYING → ended → fadeOut → IDLE + onPlayed', () => {
    const { ctrl, setVisible, triggerFadeIn, triggerFadeOut, onPlayed, onFadeInDone } =
      createController(mockVideo)

    expect(ctrl.getState()).toBe('IDLE')

    // play() で LOADING へ
    ctrl.play('media://videos/clip-001.mp4')
    expect(ctrl.getState()).toBe('LOADING')
    expect(mockVideo.setSrc).toHaveBeenCalledWith('media://videos/clip-001.mp4')

    // requestVideoFrameCallback が 1 フレーム確定後に呼ぶコールバック
    mockVideo._triggerRvfc()
    expect(ctrl.getState()).toBe('FADE_IN')
    // setVisible(true) でオーバーレイ表示
    expect(setVisible).toHaveBeenCalledWith(true)
    // triggerFadeIn が呼ばれた
    expect(triggerFadeIn).toHaveBeenCalledOnce()

    // フェードイン完了コールバックを呼ぶ
    const fadeInDoneCallback = (triggerFadeIn as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as
      | (() => void)
      | undefined
    expect(fadeInDoneCallback).toBeDefined()
    fadeInDoneCallback!()

    expect(ctrl.getState()).toBe('PLAYING')
    expect(onFadeInDone).toHaveBeenCalledOnce()
    expect(mockVideo.play).toHaveBeenCalledOnce()

    // 動画終了: ended 時点で onPlayed が通知される（PLAYING→FADE_OUT）
    mockVideo._triggerEnded()
    expect(ctrl.getState()).toBe('FADE_OUT')
    expect(triggerFadeOut).toHaveBeenCalledOnce()
    // onPlayed は fade-out 開始時（ended イベント時）に通知済み
    expect(onPlayed).toHaveBeenCalledWith('media://videos/clip-001.mp4')

    // フェードアウト完了コールバックを呼ぶ
    const fadeOutDoneCallback = (triggerFadeOut as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as
      | (() => void)
      | undefined
    expect(fadeOutDoneCallback).toBeDefined()
    fadeOutDoneCallback!()

    expect(ctrl.getState()).toBe('IDLE')
    expect(setVisible).toHaveBeenCalledWith(false)
    // onPlayed は fade-out 完了前に呼ばれていることを確認（呼び出し回数は 1 回のみ）
    expect(onPlayed).toHaveBeenCalledTimes(1)
  })

  // ─────────────────────────────────────────────────────────────────────────
  // OC-02: エラーフロー (LOADING 中 — reveal 前)
  // ─────────────────────────────────────────────────────────────────────────
  it('OC-02: error during LOADING → IDLE immediately, onError called, setVisible NOT called true', () => {
    const { ctrl, setVisible, onError } = createController(mockVideo)

    ctrl.play('media://videos/broken.mp4')
    expect(ctrl.getState()).toBe('LOADING')

    // rvfc が来る前にエラー（オーバーレイはまだ非表示）
    mockVideo._triggerError('MEDIA_ERR_SRC_NOT_SUPPORTED')

    expect(ctrl.getState()).toBe('IDLE')
    expect(onError).toHaveBeenCalledWith(
      'media://videos/broken.mp4',
      'MEDIA_ERR_SRC_NOT_SUPPORTED',
    )
    // reveal されていない（setVisible(true) が呼ばれていない）
    expect(setVisible).not.toHaveBeenCalledWith(true)
  })

  // ─────────────────────────────────────────────────────────────────────────
  // OC-03: エラーフロー (PLAYING 中)
  // ─────────────────────────────────────────────────────────────────────────
  it('OC-03: error during PLAYING → onError called immediately + fadeOut triggered + setVisible(false)', () => {
    const { ctrl, setVisible, triggerFadeIn, triggerFadeOut, onError, onFadeOutDone } =
      createController(mockVideo)

    ctrl.play('media://videos/clip-001.mp4')
    mockVideo._triggerRvfc()
    // フェードイン完了
    const fadeInCb = (triggerFadeIn as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as () => void
    fadeInCb()
    expect(ctrl.getState()).toBe('PLAYING')

    // PLAYING 中にエラー
    mockVideo._triggerError('MEDIA_ERR_DECODE')

    // onError が即座に呼ばれる
    expect(onError).toHaveBeenCalledWith('media://videos/clip-001.mp4', 'MEDIA_ERR_DECODE')

    // フェードアウトが開始される（可視状態から非表示へ）
    expect(ctrl.getState()).toBe('FADE_OUT')
    expect(triggerFadeOut).toHaveBeenCalledOnce()

    // フェードアウト完了
    const fadeOutCb = (triggerFadeOut as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as () => void
    fadeOutCb()

    expect(ctrl.getState()).toBe('IDLE')
    expect(setVisible).toHaveBeenCalledWith(false)
    expect(onFadeOutDone).toHaveBeenCalledOnce()
  })

  // ─────────────────────────────────────────────────────────────────────────
  // OC-04: フェード状態遷移が正しい順序で通過する
  // ─────────────────────────────────────────────────────────────────────────
  it('OC-04: fade state transitions follow IDLE→LOADING→FADE_IN→PLAYING→FADE_OUT→IDLE', () => {
    const { ctrl, triggerFadeIn, triggerFadeOut } = createController(mockVideo)
    const states: string[] = []

    // 各ステップで状態を記録
    expect(ctrl.getState()).toBe('IDLE')
    states.push(ctrl.getState())

    ctrl.play('media://videos/clip-001.mp4')
    states.push(ctrl.getState()) // LOADING

    mockVideo._triggerRvfc()
    states.push(ctrl.getState()) // FADE_IN

    const fadeInCb = (triggerFadeIn as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as () => void
    fadeInCb()
    states.push(ctrl.getState()) // PLAYING

    mockVideo._triggerEnded()
    states.push(ctrl.getState()) // FADE_OUT

    const fadeOutCb = (triggerFadeOut as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as () => void
    fadeOutCb()
    states.push(ctrl.getState()) // IDLE

    expect(states).toEqual(['IDLE', 'LOADING', 'FADE_IN', 'PLAYING', 'FADE_OUT', 'IDLE'])
  })

  // ─────────────────────────────────────────────────────────────────────────
  // OC-05: 二重 play 防止
  // ─────────────────────────────────────────────────────────────────────────
  it('OC-05: double play prevention — play() while non-IDLE is ignored', () => {
    const { ctrl } = createController(mockVideo)

    ctrl.play('media://videos/clip-001.mp4')
    expect(ctrl.getState()).toBe('LOADING')

    // LOADING 中に二重 play
    ctrl.play('media://videos/clip-002.mp4')
    expect(ctrl.getState()).toBe('LOADING')
    // setSrc は最初の1回のみ
    expect(mockVideo.setSrc).toHaveBeenCalledOnce()
    expect(mockVideo.setSrc).toHaveBeenCalledWith('media://videos/clip-001.mp4')

    // FADE_IN 中にも二重 play
    mockVideo._triggerRvfc()
    expect(ctrl.getState()).toBe('FADE_IN')
    ctrl.play('media://videos/clip-003.mp4')
    expect(ctrl.getState()).toBe('FADE_IN')
    expect(mockVideo.setSrc).toHaveBeenCalledOnce()
  })

  // ─────────────────────────────────────────────────────────────────────────
  // OC-06: LOADING 中にエラー（rvfc 前） — IDLE に戻り再度 play 可能
  // ─────────────────────────────────────────────────────────────────────────
  it('OC-06: error before rvfc (LOADING state) → IDLE, next play() is accepted', () => {
    const { ctrl } = createController(mockVideo)

    ctrl.play('media://videos/broken.mp4')
    mockVideo._triggerError('ERR')
    expect(ctrl.getState()).toBe('IDLE')

    // 再度 play() が受け付けられる
    ctrl.play('media://videos/clip-001.mp4')
    expect(ctrl.getState()).toBe('LOADING')
    expect(mockVideo.setSrc).toHaveBeenNthCalledWith(2, 'media://videos/clip-001.mp4')
  })

  // ─────────────────────────────────────────────────────────────────────────
  // OC-07: play 完了後 (onPlayed 通知後) に IDLE に戻り再び play 可能
  // ─────────────────────────────────────────────────────────────────────────
  it('OC-07: after full play cycle completes, play() is accepted again', () => {
    const { ctrl, triggerFadeIn, triggerFadeOut } = createController(mockVideo)

    ctrl.play('media://videos/clip-001.mp4')
    mockVideo._triggerRvfc()
    const fadeInCb = (triggerFadeIn as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as () => void
    fadeInCb()
    mockVideo._triggerEnded()
    const fadeOutCb = (triggerFadeOut as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as () => void
    fadeOutCb()

    expect(ctrl.getState()).toBe('IDLE')

    // 2 回目の play
    ctrl.play('media://videos/clip-002.mp4')
    expect(ctrl.getState()).toBe('LOADING')
    expect(mockVideo.setSrc).toHaveBeenNthCalledWith(2, 'media://videos/clip-002.mp4')
  })

  // ─────────────────────────────────────────────────────────────────────────
  // OC-08: loadedMetadata イベントで onDurationReady が呼ばれる
  // ─────────────────────────────────────────────────────────────────────────
  it('OC-08: onDurationReady is called with duration when loadedMetadata fires', () => {
    const { ctrl, onDurationReady } = createController(mockVideo)

    ctrl.play('media://videos/clip-001.mp4')
    mockVideo._triggerLoadedMetadata(5000)

    expect(onDurationReady).toHaveBeenCalledWith(5000)
  })

  // ─────────────────────────────────────────────────────────────────────────
  // OC-09: フェードアウト完了後に onFadeOutDone が呼ばれる
  // ─────────────────────────────────────────────────────────────────────────
  it('OC-09: onFadeOutDone is called after fade-out completes', () => {
    const { ctrl, triggerFadeIn, triggerFadeOut, onFadeOutDone } = createController(mockVideo)

    ctrl.play('media://videos/clip-001.mp4')
    mockVideo._triggerRvfc()
    const fadeInCb = (triggerFadeIn as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as () => void
    fadeInCb()
    mockVideo._triggerEnded()
    const fadeOutCb = (triggerFadeOut as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as () => void
    fadeOutCb()

    expect(onFadeOutDone).toHaveBeenCalledOnce()
  })
})
