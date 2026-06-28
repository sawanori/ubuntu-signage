/**
 * FIX SET CHANGE 1 — test/unit/url-normalize.test.ts
 *
 * normalizeUrlInput のユニットテスト（テーブル駆動）。
 *
 * このファイルは src/shared/url-normalize.ts が実装されるまで FAIL する（Red フェーズ）。
 *
 * 検証範囲:
 *   - スキームなし入力へのスキーム付与（ローカル → http://、パブリック → https://）
 *   - 既存スキームはそのまま保持
 *   - 危険スキーム（javascript: 等）はそのまま返す（schema 側で拒否）
 *   - 空文字・空白のみ → '' を返す
 */

import { describe, it, expect } from 'vitest'
import { normalizeUrlInput } from '../../src/shared/url-normalize'

describe('normalizeUrlInput', () => {
  it.each([
    // 空文字・空白 → '' （スタート画面）
    ['', ''],
    ['  ', ''],

    // スキームなし パブリックホスト → https://
    ['m.yahoo.co.jp', 'https://m.yahoo.co.jp'],
    ['example.com', 'https://example.com'],
    ['www.google.com/search', 'https://www.google.com/search'],

    // スキームなし ローカル/プライベートホスト → http://
    ['localhost:8080', 'http://localhost:8080'],
    ['127.0.0.1:9000', 'http://127.0.0.1:9000'],
    ['192.168.1.50:3000', 'http://192.168.1.50:3000'],
    ['box.local', 'http://box.local'],

    // 既に http:// / https:// 付き → そのまま
    ['https://m.yahoo.co.jp', 'https://m.yahoo.co.jp'],
    ['HTTP://X.com', 'HTTP://X.com'],
    [' https://example.com ', 'https://example.com'],

    // 危険スキーム → そのまま（schema 側で拒否させる）
    ['javascript:alert(1)', 'javascript:alert(1)'],

    // 他スキーム（// あり） → そのまま（schema 側で拒否させる）
    ['ftp://h/f', 'ftp://h/f'],

    // IPv6 ブラケット記法: ローカル → http://
    ['[::1]:8080', 'http://[::1]:8080'],
    ['[::1]:8080/path', 'http://[::1]:8080/path'],

    // ベア IPv6 ループバック: ローカルとして扱い http:// を付与する
    // （ブラウザが受け付けるかどうかは schema 層・実際の URL パースに委ねる）
    ['::1', 'http://::1'],
  ] as const)('normalizeUrlInput(%j) → %j', (input, expected) => {
    expect(normalizeUrlInput(input)).toBe(expected)
  })
})
