/**
 * src/main/site-guards.ts — UT-13/UT-19 純関数抽出
 *
 * index.ts から抽出したナビゲーション制御・バックオフ計算の純関数。
 * Electron API に依存しないためユニットテスト可能。
 */

import { getDomain } from 'tldts'

/**
 * ナビゲーション先 URL が設定済みサイト URL と同一ホスト（またはサブ/親ドメイン、同一登録可能ドメイン）かどうかを判定する。
 * will-navigate / will-redirect ガード用（UT-19）。
 *
 * @param url     ナビゲーション先 URL
 * @param siteUrl 設定済みサイト URL（configManager.current.siteUrl）
 * @returns 同一ホスト・サブドメイン・親ドメイン・同一サイト（eTLD+1）なら true、解析失敗または外部ホストなら false
 *
 * @remarks
 * siteUrl === '' の場合、`new URL('')` が TypeError をスローするため catch ブロックで false を返す。
 * startPage（file:// プロトコル）表示中は外部へのナビゲーションイベント自体が発生しないため、
 * この false 返却による実害はない（§5.5 参照）。
 *
 * PSL（Public Suffix List）を使った同一サイト判定:
 * tldts の getDomain() により eTLD+1（登録可能ドメイン）を取得し、
 * m.yahoo.co.jp ↔ www.yahoo.co.jp のような兄弟サブドメイン間のリダイレクトを許可する。
 * co.jp のようなパブリックサフィックス自体は getDomain() が null を返すため、
 * 異なる *.co.jp ドメイン間を誤って許可することはない。
 *
 * IP アドレス・localhost は getDomain() が null を返すため、同一サイト判定ブランチをスキップし、
 * 完全一致またはサブドメイン一致によるマッチのみが適用される。
 */
export function isAllowedNavUrl(url: string, siteUrl: string): boolean {
  try {
    const target = new URL(url).hostname.toLowerCase()
    const configured = new URL(siteUrl).hostname.toLowerCase()

    if (target === '' || configured === '') return false

    // 完全一致
    if (target === configured) return true

    // サブドメイン方向: www.example.com ← siteUrl が example.com のとき
    if (target.endsWith('.' + configured)) return true

    // 親ドメイン方向: example.com ← siteUrl が www.example.com のとき
    // target が単一ラベル（TLD/パブリックサフィックス等）の場合は許可しない（includes('.') チェック）
    if (target.includes('.') && configured.endsWith('.' + target)) return true

    // 同一登録可能ドメイン（eTLD+1）判定: m.yahoo.co.jp ↔ www.yahoo.co.jp のような兄弟サブドメイン許可
    // getDomain() は localhost や IP アドレスに対して null を返すため、これらは上記の完全一致のみで判定される
    const td = getDomain(target)
    const cd = getDomain(configured)
    if (td !== null && cd !== null && td === cd) return true

    return false
  } catch {
    return false
  }
}

/**
 * 指数バックオフ遅延 ms を返す（UT-13）。
 *
 * attempt=1 → 1000ms, attempt=2 → 2000ms, attempt=3 → 4000ms … 上限 60000ms。
 * 式: min(1000 × 2^(attempt-1), 60000)
 *
 * @param attempt リトライ試行番号（1 始まり）
 * @returns 遅延ミリ秒
 */
export function backoffDelayMs(attempt: number): number {
  return Math.min(1000 * Math.pow(2, attempt - 1), 60_000)
}
