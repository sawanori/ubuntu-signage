/**
 * test/unit/before-input-quit.test.ts — Wayland Ctrl+Q before-input-event ハンドラ (W-01)
 *
 * makeBeforeInputQuitHandler が返すハンドラに Electron Input 相当のオブジェクトを渡し、
 * Ctrl+Q 時のみ onQuit() が呼ばれることを検証する。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { makeBeforeInputQuitHandler } from '../../src/main/before-input-quit'
import type { InputLike } from '../../src/main/before-input-quit'

/** Ctrl+Q に相当する Input オブジェクトを生成するヘルパー */
function makeInput(overrides: Partial<InputLike> = {}): InputLike {
  return {
    type: 'keyDown',
    control: true,
    key: 'q',
    ...overrides,
  }
}

describe('makeBeforeInputQuitHandler — Wayland Ctrl+Q before-input-event (W-01)', () => {
  let mockOnQuit: ReturnType<typeof vi.fn>

  beforeEach(() => {
    mockOnQuit = vi.fn()
  })

  // W-01: Ctrl+Q keyDown → onQuit() が1回呼ばれる
  it('W-01: Ctrl+Q keyDown → onQuit() が1回呼ばれる', () => {
    const handler = makeBeforeInputQuitHandler(mockOnQuit as () => void)
    handler(undefined, makeInput())

    expect(mockOnQuit).toHaveBeenCalledOnce()
  })

  // W-02: key='Q'（大文字）でも toLowerCase() で一致 → onQuit() が呼ばれる
  it('W-02: key="Q"（大文字）でも onQuit() が呼ばれる', () => {
    const handler = makeBeforeInputQuitHandler(mockOnQuit as () => void)
    handler(undefined, makeInput({ key: 'Q' }))

    expect(mockOnQuit).toHaveBeenCalledOnce()
  })

  // W-03: type が keyUp の場合 → onQuit() は呼ばれない（keyDown のみ対象）
  it('W-03: keyUp イベントでは onQuit() は呼ばれない', () => {
    const handler = makeBeforeInputQuitHandler(mockOnQuit as () => void)
    handler(undefined, makeInput({ type: 'keyUp' }))

    expect(mockOnQuit).not.toHaveBeenCalled()
  })

  // W-04: control=false の場合 → onQuit() は呼ばれない
  it('W-04: Ctrl キーなし（control=false）では onQuit() は呼ばれない', () => {
    const handler = makeBeforeInputQuitHandler(mockOnQuit as () => void)
    handler(undefined, makeInput({ control: false }))

    expect(mockOnQuit).not.toHaveBeenCalled()
  })

  // W-05: key が 'q' 以外の場合 → onQuit() は呼ばれない
  it('W-05: Ctrl+W など他のキーでは onQuit() は呼ばれない', () => {
    const handler = makeBeforeInputQuitHandler(mockOnQuit as () => void)
    handler(undefined, makeInput({ key: 'w' }))

    expect(mockOnQuit).not.toHaveBeenCalled()
  })

  // W-06: ハンドラを複数回呼んでも2回目以降も onQuit() を呼ぶ（ステートレス）
  it('W-06: ハンドラ複数回呼び出し → 毎回 onQuit() を呼ぶ（ステートレス）', () => {
    const handler = makeBeforeInputQuitHandler(mockOnQuit as () => void)
    handler(undefined, makeInput())
    handler(undefined, makeInput())
    handler(undefined, makeInput())

    expect(mockOnQuit).toHaveBeenCalledTimes(3)
  })

  // W-07: event 引数は無視される（undefined でもエラーなし）
  it('W-07: event 引数が undefined でもエラーなし', () => {
    const handler = makeBeforeInputQuitHandler(mockOnQuit as () => void)

    expect(() => handler(undefined, makeInput())).not.toThrow()
    expect(mockOnQuit).toHaveBeenCalledOnce()
  })
})
