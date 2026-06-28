/**
 * UT-13b — test/unit/site-load-retry.test.ts
 *
 * src/main/site-load-retry.ts の純関数をユニットテストする。
 *
 * バグ修正: エラーページの did-finish-load でリトライカウンタが
 * リセットされる問題を防ぐ実装の正しさを検証する。
 */

import { describe, it, expect } from 'vitest'
import {
  createRetryState,
  onLoadStart,
  onLoadFail,
  onLoadFinish,
  MAX_RETRY_ATTEMPTS,
} from '../../src/main/site-load-retry'

// ─── §7.1.3: MAX_RETRY_ATTEMPTS 定数エクスポート確認 ─────────────────────────

describe('MAX_RETRY_ATTEMPTS', () => {
  it('MAX_RETRY_ATTEMPTS が 3 であること（§5.5）', () => {
    expect(MAX_RETRY_ATTEMPTS).toBe(3)
  })
})

// ─── createRetryState ────────────────────────────────────────────────────────

describe('createRetryState', () => {
  it('初期状態は attempt=0, failedSinceStart=false を返す', () => {
    const state = createRetryState()
    expect(state).toEqual({ attempt: 0, failedSinceStart: false })
  })
})

// ─── onLoadFail（単発） ───────────────────────────────────────────────────────

describe('onLoadFail（初回失敗）', () => {
  it('初期状態から onLoadFail → attempt=1, delayMs=1000, failedSinceStart=true', () => {
    const initial = createRetryState()
    const { state, delayMs } = onLoadFail(initial)
    expect(state.attempt).toBe(1)
    expect(state.failedSinceStart).toBe(true)
    expect(delayMs).toBe(1000)
  })
})

// ─── 連続失敗の指数バックオフ ───────────────────────────────────────────────

describe('連続失敗時の指数バックオフ', () => {
  it('onLoadStart→onLoadFail を3周すると delayMs が 1000→2000→4000 と増える', () => {
    let state = createRetryState()

    // 1回目
    state = onLoadStart(state)
    const r1 = onLoadFail(state)
    state = r1.state
    expect(r1.delayMs).toBe(1000)

    // 2回目
    state = onLoadStart(state)
    const r2 = onLoadFail(state)
    state = r2.state
    expect(r2.delayMs).toBe(2000)

    // 3回目
    state = onLoadStart(state)
    const r3 = onLoadFail(state)
    state = r3.state
    expect(r3.delayMs).toBe(4000)
  })
})

// ─── 【回帰テスト・最重要】エラーページ finish でカウンタをリセットしない ────

describe('onLoadFinish（エラーページ finish — 回帰テスト）', () => {
  it('failedSinceStart=true の状態で onLoadFinish を呼んでも attempt が維持される', () => {
    const initial = createRetryState()
    const { state: afterFail } = onLoadFail(initial)
    expect(afterFail.failedSinceStart).toBe(true)
    expect(afterFail.attempt).toBe(1)

    // Chromium がエラーページを表示し did-finish-load が発火するシナリオ
    const afterFinish = onLoadFinish(afterFail)
    expect(afterFinish.attempt).toBe(1) // リセットされてはいけない
    expect(afterFinish.failedSinceStart).toBe(true) // 失敗フラグも維持
  })
})

// ─── 真の成功 ────────────────────────────────────────────────────────────────

describe('真の成功（failedSinceStart=false での onLoadFinish）', () => {
  it('onLoadStart の後に onLoadFinish → attempt=0 にリセットされる', () => {
    // あらかじめ数回失敗した後の状態を模倣
    const initial = createRetryState()
    const { state: afterFail } = onLoadFail(initial)
    expect(afterFail.attempt).toBe(1)

    // 新しいロード開始（failedSinceStart をクリア）
    const afterStart = onLoadStart(afterFail)
    expect(afterStart.failedSinceStart).toBe(false)

    // 今回のロードでは失敗なしで完了
    const afterSuccess = onLoadFinish(afterStart)
    expect(afterSuccess.attempt).toBe(0)
    expect(afterSuccess.failedSinceStart).toBe(false)
  })
})

// ─── 成功後の再失敗 ──────────────────────────────────────────────────────────

describe('成功後の再失敗', () => {
  it('attempt を3まで上げてから成功させると 0 に戻り、次の onLoadFail で attempt=1 になる', () => {
    let state = createRetryState()

    // 3回連続失敗
    for (let i = 0; i < 3; i++) {
      state = onLoadStart(state)
      const { state: next } = onLoadFail(state)
      state = next
    }
    expect(state.attempt).toBe(3)

    // 真の成功
    state = onLoadStart(state)
    state = onLoadFinish(state)
    expect(state.attempt).toBe(0)

    // 再び失敗
    state = onLoadStart(state)
    const { state: afterRefail, delayMs } = onLoadFail(state)
    expect(afterRefail.attempt).toBe(1)
    expect(delayMs).toBe(1000)
  })
})

// ─── 上限 60000ms ────────────────────────────────────────────────────────────

describe('バックオフ上限', () => {
  it('onLoadFail を7回以上重ねると delayMs が 60000 で頭打ちになる', () => {
    let state = createRetryState()
    let delayMs = 0

    for (let i = 0; i < 8; i++) {
      state = onLoadStart(state)
      const result = onLoadFail(state)
      state = result.state
      delayMs = result.delayMs
    }

    expect(delayMs).toBe(60_000)
    expect(state.attempt).toBe(8)
  })
})

// ─── onLoadStart の挙動 ──────────────────────────────────────────────────────

describe('onLoadStart', () => {
  it('attempt を変えず failedSinceStart のみ false にする', () => {
    const initial = createRetryState()
    const { state: afterFail } = onLoadFail(initial)
    expect(afterFail.attempt).toBe(1)
    expect(afterFail.failedSinceStart).toBe(true)

    const afterStart = onLoadStart(afterFail)
    expect(afterStart.attempt).toBe(1)           // attempt は変わらない
    expect(afterStart.failedSinceStart).toBe(false)
  })
})

// ─── 【バグ再現シーケンス】attempt が 1 のまま固定されないことを保証 ────────

describe('バグ再現シーケンス（attempt が 1 のまま固定されないこと）', () => {
  it(
    '(onLoadStart→onLoadFail→onLoadFinish) を3周すると attempt が 1, 2, 3 と増える',
    () => {
      let state = createRetryState()

      // 1周目: 失敗 → エラーページ finish
      state = onLoadStart(state)
      const r1 = onLoadFail(state)
      state = r1.state
      expect(state.attempt).toBe(1)
      state = onLoadFinish(state) // エラーページの finish（failedSinceStart=true）
      expect(state.attempt).toBe(1) // リセットされない

      // 2周目: 失敗 → エラーページ finish
      state = onLoadStart(state)
      const r2 = onLoadFail(state)
      state = r2.state
      expect(state.attempt).toBe(2) // 1 ではなく 2 に増える
      state = onLoadFinish(state)
      expect(state.attempt).toBe(2)

      // 3周目: 失敗 → エラーページ finish
      state = onLoadStart(state)
      const r3 = onLoadFail(state)
      state = r3.state
      expect(state.attempt).toBe(3) // 1 ではなく 3 に増える
      state = onLoadFinish(state)
      expect(state.attempt).toBe(3)
    },
  )
})
