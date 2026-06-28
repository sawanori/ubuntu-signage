/**
 * UT-13/UT-19 — test/unit/site-guards.test.ts
 *
 * src/main/site-guards.ts の純関数をユニットテストする。
 *
 * UT-13: backoffDelayMs — 指数バックオフ系列の正確性
 * UT-19: isAllowedNavUrl — 許可ホストは通し、外部ホストは拒否
 */

import { describe, it, expect } from 'vitest'
import { isAllowedNavUrl, backoffDelayMs } from '../../src/main/site-guards'

// ─── UT-13: backoffDelayMs ───────────────────────────────────────────────────

describe('backoffDelayMs (UT-13)', () => {
  it('attempt=1 → 1000ms', () => {
    expect(backoffDelayMs(1)).toBe(1000)
  })

  it('attempt=2 → 2000ms', () => {
    expect(backoffDelayMs(2)).toBe(2000)
  })

  it('attempt=3 → 4000ms', () => {
    expect(backoffDelayMs(3)).toBe(4000)
  })

  it('attempt=4 → 8000ms', () => {
    expect(backoffDelayMs(4)).toBe(8000)
  })

  it('attempt=5 → 16000ms', () => {
    expect(backoffDelayMs(5)).toBe(16000)
  })

  it('attempt=6 → 32000ms', () => {
    expect(backoffDelayMs(6)).toBe(32000)
  })

  it('attempt=7 → 60000ms（上限に到達）', () => {
    expect(backoffDelayMs(7)).toBe(60_000)
  })

  it('attempt=10 → 60000ms（上限を超えない）', () => {
    expect(backoffDelayMs(10)).toBe(60_000)
  })

  it('attempt=100 → 60000ms（上限を超えない）', () => {
    expect(backoffDelayMs(100)).toBe(60_000)
  })
})

// ─── UT-19: isAllowedNavUrl ──────────────────────────────────────────────────

describe('isAllowedNavUrl (UT-19)', () => {
  const SITE_URL = 'https://signage.example.com'

  it('同一ホストの https URL を許可する', () => {
    expect(isAllowedNavUrl('https://signage.example.com/page', SITE_URL)).toBe(true)
  })

  it('同一ホストのサブパスを許可する', () => {
    expect(isAllowedNavUrl('https://signage.example.com/deep/path?q=1', SITE_URL)).toBe(true)
  })

  it('外部ホストは拒否する', () => {
    expect(isAllowedNavUrl('https://evil.attacker.com/page', SITE_URL)).toBe(false)
  })

  it('サブドメインを許可する（FIX SET CHANGE 3: サブドメイン/親ドメイン間のリダイレクト許可）', () => {
    expect(isAllowedNavUrl('https://sub.signage.example.com/page', SITE_URL)).toBe(true)
  })

  it('スキームが異なっても同一ホストなら許可する（http vs https）', () => {
    expect(isAllowedNavUrl('http://signage.example.com/page', SITE_URL)).toBe(true)
  })

  it('不正 URL は拒否する（解析失敗）', () => {
    expect(isAllowedNavUrl('not-a-url', SITE_URL)).toBe(false)
  })

  it('siteUrl が不正の場合は拒否する', () => {
    expect(isAllowedNavUrl('https://signage.example.com/', 'not-a-url')).toBe(false)
  })

  it('空文字 URL は拒否する', () => {
    expect(isAllowedNavUrl('', SITE_URL)).toBe(false)
  })

  it('http siteUrl で同一ホストを許可する', () => {
    expect(isAllowedNavUrl('http://local.signage.test/', 'http://local.signage.test')).toBe(true)
  })

  it('javascript: スキームは拒否する', () => {
    expect(isAllowedNavUrl('javascript:alert(1)', SITE_URL)).toBe(false)
  })

  // ─── FIX SET CHANGE 3: サブドメイン/親ドメイン間のリダイレクトを許可 ──────

  it('google.com → www.google.com へのリダイレクトを許可する（サブドメイン方向）', () => {
    expect(isAllowedNavUrl('https://www.google.com/', 'https://google.com')).toBe(true)
  })

  it('www.google.com → google.com へのリダイレクトを許可する（親ドメイン方向）', () => {
    expect(isAllowedNavUrl('https://google.com/', 'https://www.google.com')).toBe(true)
  })

  it('evil.com は google.com のサイトで拒否される（クロスドメイン）', () => {
    expect(isAllowedNavUrl('https://evil.com/', 'https://google.com')).toBe(false)
  })

  it('siteUrl が空文字の場合は拒否する（スタート画面）', () => {
    expect(isAllowedNavUrl('https://x/', '')).toBe(false)
  })

  // ─── 敵対的ケース（adversarial）: 親ドメイン方向の過剰許可を防ぐ ──────────

  it('evil-google.com は google.com の配下ではないため拒否する', () => {
    // "evil-google.com" は ".google.com" で終わらないため拒否されること
    expect(isAllowedNavUrl('https://evil-google.com/', 'https://google.com')).toBe(false)
  })

  it('ベア TLD "com" を www.google.com の親ドメインとして許可しない', () => {
    // targetHost が単一ラベル（TLD）の場合は親ドメイン方向として扱わない
    expect(isAllowedNavUrl('https://com/', 'https://www.google.com')).toBe(false)
  })

  it('www.google.com は google.com のサブドメインとして許可する（回帰）', () => {
    expect(isAllowedNavUrl('https://www.google.com/', 'https://google.com')).toBe(true)
  })

  // ─── PSL（tldts）を使った同一サイト（eTLD+1）判定 ─────────────────────────────

  it('www.yahoo.co.jp → m.yahoo.co.jp の兄弟サブドメインを許可する（ライブバグ修正）', () => {
    // m.yahoo.co.jp が www.yahoo.co.jp にリダイレクトする実際のケース
    expect(isAllowedNavUrl('https://www.yahoo.co.jp/', 'https://m.yahoo.co.jp')).toBe(true)
  })

  it('news.yahoo.co.jp/path は yahoo.co.jp のサブドメインとして許可する', () => {
    expect(isAllowedNavUrl('https://news.yahoo.co.jp/path', 'https://yahoo.co.jp')).toBe(true)
  })

  it('m.yahoo.co.jp → www.yahoo.co.jp の逆方向リダイレクトも許可する', () => {
    expect(isAllowedNavUrl('https://m.yahoo.co.jp/', 'https://www.yahoo.co.jp')).toBe(true)
  })

  it('foo.co.jp と bar.co.jp は異なる登録可能ドメインとして拒否する', () => {
    // co.jp はパブリックサフィックスのため、同一サイト判定ブランチは作動しない
    expect(isAllowedNavUrl('https://foo.co.jp/', 'https://bar.co.jp')).toBe(false)
  })

  it('yahoo.co.jp と google.com は異なる登録可能ドメインとして拒否する', () => {
    expect(isAllowedNavUrl('https://yahoo.co.jp/', 'https://google.com')).toBe(false)
  })

  it('evil-google.com は google.com のサイトで拒否される（回帰）', () => {
    expect(isAllowedNavUrl('https://evil-google.com/', 'https://google.com')).toBe(false)
  })

  it('ベア TLD "com" は www.google.com の親ドメインとして許可されない（回帰）', () => {
    expect(isAllowedNavUrl('https://com/', 'https://www.google.com')).toBe(false)
  })

  // ─── IP/localhost は完全一致のみで判定 ────────────────────────────────────────

  it('localhost:8080 は同一ホストとして許可する', () => {
    expect(isAllowedNavUrl('http://localhost:8080/', 'http://localhost:8080')).toBe(true)
  })

  it('127.0.0.1 と 10.0.0.1 は異なる IP として拒否する', () => {
    expect(isAllowedNavUrl('http://127.0.0.1/', 'http://10.0.0.1')).toBe(false)
  })
})
