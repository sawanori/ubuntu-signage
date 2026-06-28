/**
 * 4-B0. QuitCoordinator ユニットテスト
 *
 * src/main/quit-coordinator.ts の QuitCoordinator クラスを検証する。
 * 設計: DI で quit / onArmedChange / setTimeout / clearTimeout を注入する。
 * fake timers と vi.fn() ラッパーでタイマー動作を精密に制御する。
 *
 * 注意: src/main/quit-coordinator.ts は未実装のため、import 失敗 → RED が期待される。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { QuitCoordinator } from '../../src/main/quit-coordinator'

describe('QuitCoordinator', () => {
  let mockQuit: ReturnType<typeof vi.fn>
  let mockOnArmedChange: ReturnType<typeof vi.fn>
  /** グローバル fake setTimeout へ委譲するラッパー（呼び出し検証用） */
  let mockSetTimeout: ReturnType<typeof vi.fn>
  /** グローバル fake clearTimeout へ委譲するラッパー（呼び出し検証用） */
  let mockClearTimeout: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.useFakeTimers()
    mockQuit = vi.fn()
    mockOnArmedChange = vi.fn()
    // グローバル fake タイマーに委譲することで vi.advanceTimersByTime() が機能する
    mockSetTimeout = vi.fn().mockImplementation((fn: () => void, ms: number) => {
      return setTimeout(fn, ms)
    })
    mockClearTimeout = vi.fn().mockImplementation((id: unknown) => {
      clearTimeout(id as ReturnType<typeof setTimeout>)
    })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  function createCoordinator(confirmWindowMs?: number): QuitCoordinator {
    return new QuitCoordinator({
      quit: mockQuit as () => void,
      onArmedChange: mockOnArmedChange as (armed: boolean) => void,
      setTimeoutFn: mockSetTimeout as unknown as typeof setTimeout,
      clearTimeoutFn: mockClearTimeout as unknown as typeof clearTimeout,
      ...(confirmWindowMs !== undefined ? { confirmWindowMs } : {}),
    })
  }

  // ─── B0-01: 初回 requestQuit → armed=true + onArmedChange(true) + タイマー開始 ──

  it('B0-01: requestQuit() 初回 → onArmedChange(true) が1回呼ばれ、タイマーが開始される', () => {
    const coordinator = createCoordinator()
    coordinator.requestQuit()

    expect(mockOnArmedChange).toHaveBeenCalledOnce()
    expect(mockOnArmedChange).toHaveBeenCalledWith(true)
    expect(mockSetTimeout).toHaveBeenCalledOnce()
    expect(mockQuit).not.toHaveBeenCalled()
  })

  // ─── B0-02: armed=true で requestQuit() → タイマー解除 + quit() 呼び出し ──────

  it('B0-02: armed 状態で requestQuit() → clearTimeout が呼ばれ quit() が1回呼ばれる', () => {
    const coordinator = createCoordinator()
    coordinator.requestQuit() // arm
    coordinator.requestQuit() // confirm

    expect(mockClearTimeout).toHaveBeenCalled()
    expect(mockQuit).toHaveBeenCalledOnce()
  })

  // ─── B0-03: confirmWindowMs 経過 → 自動 disarm（onArmedChange(false)） ─────────

  it('B0-03: requestQuit() 後に confirmWindowMs 経過 → onArmedChange(false) が呼ばれる（自動 disarm）', () => {
    const coordinator = createCoordinator(3000)
    coordinator.requestQuit()
    // onArmedChange(true) をクリアして false のみを検証する
    mockOnArmedChange.mockClear()

    vi.advanceTimersByTime(3000)

    expect(mockOnArmedChange).toHaveBeenCalledOnce()
    expect(mockOnArmedChange).toHaveBeenCalledWith(false)
    expect(mockQuit).not.toHaveBeenCalled()
  })

  // ─── B0-04: requestQuit() 後に disarm() → タイマー解除 + onArmedChange(false) ──

  it('B0-04: requestQuit() 後に disarm() → clearTimeout が呼ばれ onArmedChange(false) が呼ばれる', () => {
    const coordinator = createCoordinator()
    coordinator.requestQuit()
    mockOnArmedChange.mockClear()

    coordinator.disarm()

    expect(mockClearTimeout).toHaveBeenCalled()
    expect(mockOnArmedChange).toHaveBeenCalledOnce()
    expect(mockOnArmedChange).toHaveBeenCalledWith(false)
    expect(mockQuit).not.toHaveBeenCalled()
  })

  // ─── B0-05: requestQuit() 2回連続（タイムアウト前） → quit() 呼出・タイマーリークなし ──

  it('B0-05: requestQuit() 2回連続（タイムアウト前） → quit() 1回・clearTimeout でタイマーリークなし', () => {
    const coordinator = createCoordinator()
    coordinator.requestQuit() // arm → timer started
    coordinator.requestQuit() // confirm → timer cleared + quit()

    expect(mockQuit).toHaveBeenCalledOnce()
    // 2回目の requestQuit で既存タイマーが解除される
    expect(mockClearTimeout).toHaveBeenCalled()
    // 終了後にペンディングタイマーがないこと
    expect(vi.getTimerCount()).toBe(0)
  })

  // ─── B0-06: requestQuit() → タイムアウト → requestQuit() → 2サイクル目 armed ──

  it('B0-06: requestQuit() → タイムアウト disarm → 再 requestQuit() → 再び onArmedChange(true)・quit() は呼ばれない', () => {
    const coordinator = createCoordinator(3000)
    coordinator.requestQuit()
    vi.advanceTimersByTime(3000) // 自動 disarm

    mockOnArmedChange.mockClear()
    mockQuit.mockClear()

    coordinator.requestQuit() // 2サイクル目の arm

    expect(mockOnArmedChange).toHaveBeenCalledWith(true)
    expect(mockQuit).not.toHaveBeenCalled()
  })

  // ─── B0-07: disarm() を armed=false 状態で呼ぶ → no-op ────────────────────────

  it('B0-07: disarm() を armed=false 状態で呼ぶ → エラーなし・quit/onArmedChange は呼ばれない', () => {
    const coordinator = createCoordinator()

    expect(() => coordinator.disarm()).not.toThrow()
    expect(mockQuit).not.toHaveBeenCalled()
    expect(mockOnArmedChange).not.toHaveBeenCalled()
  })

  // ─── B0-08: confirmWindowMs カスタム値 → 境界値検証 ──────────────────────────

  it('B0-08: confirmWindowMs=500 のカスタム指定 → 499ms では disarm されない・500ms で disarm される', () => {
    const coordinator = createCoordinator(500)
    coordinator.requestQuit()

    vi.advanceTimersByTime(499)
    // この時点で onArmedChange(false) は呼ばれていない
    expect(mockOnArmedChange).not.toHaveBeenCalledWith(false)

    vi.advanceTimersByTime(1) // 合計 500ms
    expect(mockOnArmedChange).toHaveBeenCalledWith(false)
  })
})
