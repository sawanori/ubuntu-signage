/**
 * src/main/site-load-retry.ts — siteView ロードリトライ状態管理（純関数群）
 *
 * Electron API に依存しない純関数のみで構成し、ユニットテスト可能とする。
 *
 * 設計意図:
 * Chromium は接続失敗後に内部エラーページを表示し、それが did-finish-load を
 * 発火させる。この finish はページの「真の成功」ではないため、
 * failedSinceStart フラグで区別してリトライカウンタのリセットを防ぐ。
 */

import { backoffDelayMs } from './site-guards'

/**
 * ロード失敗の最大リトライ回数（超過後は startPage へフォールバック）。
 * §5.5 参照。
 */
export const MAX_RETRY_ATTEMPTS = 3

/**
 * siteView のロードリトライ状態。
 * イミュータブル設計（各操作で新しいオブジェクトを返す）。
 */
export interface SiteLoadRetryState {
  /** これまでの連続失敗回数（1 始まりの試行番号として使う） */
  readonly attempt: number
  /** 現在のロード試行で did-fail-load を観測したか */
  readonly failedSinceStart: boolean
}

/**
 * 初期状態（attempt=0, failedSinceStart=false）を返す。
 */
export function createRetryState(): SiteLoadRetryState {
  return { attempt: 0, failedSinceStart: false }
}

/**
 * loadURL を発行する直前に呼ぶ。
 * failedSinceStart をクリアする（attempt は維持）。
 *
 * @param state 現在の状態
 * @returns 新しい状態
 */
export function onLoadStart(state: SiteLoadRetryState): SiteLoadRetryState {
  return { attempt: state.attempt, failedSinceStart: false }
}

/**
 * did-fail-load（メインフレーム）で呼ぶ。
 * attempt を 1 増やし、次回遅延 delayMs を返す。
 *
 * @param state 現在の状態
 * @returns 新しい状態と次回リトライまでの遅延 ms
 */
export function onLoadFail(state: SiteLoadRetryState): {
  state: SiteLoadRetryState
  delayMs: number
} {
  const attempt = state.attempt + 1
  return {
    state: { attempt, failedSinceStart: true },
    delayMs: backoffDelayMs(attempt),
  }
}

/**
 * did-finish-load で呼ぶ。
 *
 * 当該ロードで失敗を観測していなければ「真の成功」とみなし attempt を 0 にリセット。
 * 失敗を観測済み（= Chromium のエラーページの finish）の場合は attempt を維持し、
 * バックオフが指数的に増え続けるようにする。
 *
 * @param state 現在の状態
 * @returns 新しい状態
 */
export function onLoadFinish(state: SiteLoadRetryState): SiteLoadRetryState {
  // failedSinceStart=true はエラーページの finish → リセットしない
  if (state.failedSinceStart) {
    return state
  }
  // 真の成功 → 初期状態に戻す
  return createRetryState()
}
