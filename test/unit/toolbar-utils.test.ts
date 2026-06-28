/**
 * test/unit/toolbar-utils.test.ts — computeLayeredBounds 純関数テスト
 *
 * § hotspot bounds 退避ロジック検証。
 * WebContentsView は CSS pointer-events 透過しないため、
 * toolbarVisible=true 時に hotspot を上部帯から退避させる必要がある。
 */

import { describe, it, expect } from 'vitest'
import { computeLayeredBounds } from '../../src/main/toolbar-utils'

describe('computeLayeredBounds — toolbar 状態に応じたレイアウト矩形計算', () => {
  const WIN = { width: 1920, height: 1080 }
  const TOOLBAR_HEIGHT = 48

  // ─── toolbarVisible=false（非表示） ──────────────────────────────────────────

  it('非表示時: site は全画面 {0,0,1920,1080}', () => {
    const { site } = computeLayeredBounds(false, WIN, TOOLBAR_HEIGHT)
    expect(site).toEqual({ x: 0, y: 0, width: 1920, height: 1080 })
  })

  it('非表示時: hotspot は全画面 {0,0,1920,1080}', () => {
    const { hotspot } = computeLayeredBounds(false, WIN, TOOLBAR_HEIGHT)
    expect(hotspot).toEqual({ x: 0, y: 0, width: 1920, height: 1080 })
  })

  it('非表示時: addressBar は常に上部帯 {0,0,1920,48}', () => {
    const { addressBar } = computeLayeredBounds(false, WIN, TOOLBAR_HEIGHT)
    expect(addressBar).toEqual({ x: 0, y: 0, width: 1920, height: 48 })
  })

  // ─── toolbarVisible=true（表示） ─────────────────────────────────────────────

  it('表示時: site は上部帯を避けた {0,48,1920,1032}', () => {
    const { site } = computeLayeredBounds(true, WIN, TOOLBAR_HEIGHT)
    expect(site).toEqual({ x: 0, y: 48, width: 1920, height: 1032 })
  })

  it('表示時: hotspot は上部帯を避けた {0,48,1920,1032}（クリック保護の核心）', () => {
    const { hotspot } = computeLayeredBounds(true, WIN, TOOLBAR_HEIGHT)
    expect(hotspot).toEqual({ x: 0, y: 48, width: 1920, height: 1032 })
  })

  it('表示時: addressBar は常に上部帯 {0,0,1920,48}', () => {
    const { addressBar } = computeLayeredBounds(true, WIN, TOOLBAR_HEIGHT)
    expect(addressBar).toEqual({ x: 0, y: 0, width: 1920, height: 48 })
  })

  // ─── エッジケース：ウィンドウ高さ < TOOLBAR_HEIGHT ─────────────────────────

  it('エッジ: win.height(40) < toolbarHeight(48) → hotspot.height===0（負値クランプ）', () => {
    const { hotspot } = computeLayeredBounds(true, { width: 640, height: 40 }, TOOLBAR_HEIGHT)
    expect(hotspot.height).toBe(0)
    expect(hotspot.y).toBe(48)
  })

  it('エッジ: win.height(40) < toolbarHeight(48) → site.height===0（負値クランプ）', () => {
    const { site } = computeLayeredBounds(true, { width: 640, height: 40 }, TOOLBAR_HEIGHT)
    expect(site.height).toBe(0)
  })

  it('エッジ: toolbarHeight=0 → site/hotspot は全画面と同一', () => {
    const { site, hotspot } = computeLayeredBounds(true, WIN, 0)
    expect(site).toEqual({ x: 0, y: 0, width: 1920, height: 1080 })
    expect(hotspot).toEqual({ x: 0, y: 0, width: 1920, height: 1080 })
  })
})
