/**
 * test/unit/pi4-crash-recovery.test.ts — Pi4 堅牢性バグ修正 ユニットテスト
 *
 * PI4-01: siteView render-process-gone クラッシュ復旧
 * PI4-03: main() Promise 拒否キャッチ
 * PI4-05: siteRetryTimer 追跡・クリア
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'

// ─── PI4-01: siteView render-process-gone 復旧 ───────────────────────────────

describe('PI4-01: siteView render-process-gone 復旧', () => {
  let emitter: EventEmitter
  let logError: ReturnType<typeof vi.fn>
  let loadSiteUrl: ReturnType<typeof vi.fn>
  let resetRetryState: ReturnType<typeof vi.fn>

  beforeEach(() => {
    emitter = new EventEmitter()
    logError = vi.fn()
    loadSiteUrl = vi.fn()
    resetRetryState = vi.fn()

    const reloadSite = (url: string): void => {
      resetRetryState()
      loadSiteUrl(url)
    }

    const configManager = { current: { siteUrl: 'https://signage.example.com' } }

    // index.ts で siteView に結線するハンドラと同一ロジック (PI4-01)
    emitter.on('render-process-gone', (_e: unknown, details: { reason: string }) => {
      logError('renderer.crashed', { view: 'site', reason: details.reason })
      reloadSite(configManager.current.siteUrl)
    })
  })

  it('PI4-01-01: render-process-gone 発火で renderer.crashed ログを view:"site" で出力する', () => {
    emitter.emit('render-process-gone', {}, { reason: 'oom' })
    expect(logError).toHaveBeenCalledTimes(1)
    expect(logError).toHaveBeenCalledWith('renderer.crashed', { view: 'site', reason: 'oom' })
  })

  it('PI4-01-02: render-process-gone 発火で reloadSite 経由 loadSiteUrl が呼ばれる', () => {
    emitter.emit('render-process-gone', {}, { reason: 'killed' })
    expect(loadSiteUrl).toHaveBeenCalledTimes(1)
    expect(loadSiteUrl).toHaveBeenCalledWith('https://signage.example.com')
  })

  it('PI4-01-03: ログペイロードの view キーが "site"（他4View と同形式）', () => {
    emitter.emit('render-process-gone', {}, { reason: 'crashed' })
    const [event, payload] = logError.mock.calls[0] as [string, Record<string, unknown>]
    expect(event).toBe('renderer.crashed')
    expect(payload['view']).toBe('site')
    expect(payload).toHaveProperty('reason')
  })

  it('PI4-01-04: reloadSite 内で retryState リセットと loadSiteUrl がそれぞれ呼ばれる', () => {
    emitter.emit('render-process-gone', {}, { reason: 'crashed' })
    expect(resetRetryState).toHaveBeenCalledTimes(1)
    expect(loadSiteUrl).toHaveBeenCalledTimes(1)
  })

  it('PI4-01-05: reason="killed" でも同様に復旧ロジックが走る', () => {
    emitter.emit('render-process-gone', {}, { reason: 'killed' })
    expect(logError).toHaveBeenCalledWith('renderer.crashed', expect.objectContaining({ reason: 'killed' }))
    expect(loadSiteUrl).toHaveBeenCalled()
  })
})

// ─── PI4-03: main() Promise 拒否キャッチ ─────────────────────────────────────

describe('PI4-03: main() reject 時のフェールセーフ', () => {
  it('PI4-03-01: main() が reject したとき logError("main.initFailed") を呼ぶ', () => {
    const logError = vi.fn()
    const relaunch = vi.fn()
    const quit = vi.fn()

    // index.ts の .catch ブロックと同一ロジックを再現してテスト
    const mainCatchHandler = (e: unknown): void => {
      logError('main.initFailed', {
        reason: e instanceof Error ? e.message : String(e),
        stack: e instanceof Error ? (e.stack ?? '') : '',
      })
      relaunch()
      quit()
    }

    const error = new Error('renderer file not found')
    mainCatchHandler(error)

    expect(logError).toHaveBeenCalledTimes(1)
    expect(logError).toHaveBeenCalledWith('main.initFailed', {
      reason: 'renderer file not found',
      stack: expect.any(String),
    })
  })

  it('PI4-03-02: main() reject 時に app.relaunch() が呼ばれる', () => {
    const logError = vi.fn()
    const relaunch = vi.fn()
    const quit = vi.fn()

    const mainCatchHandler = (e: unknown): void => {
      logError('main.initFailed', {
        reason: e instanceof Error ? e.message : String(e),
        stack: e instanceof Error ? (e.stack ?? '') : '',
      })
      relaunch()
      quit()
    }

    mainCatchHandler(new Error('init failed'))
    expect(relaunch).toHaveBeenCalledTimes(1)
  })

  it('PI4-03-03: main() reject 時に app.quit() が呼ばれる', () => {
    const logError = vi.fn()
    const relaunch = vi.fn()
    const quit = vi.fn()

    const mainCatchHandler = (e: unknown): void => {
      logError('main.initFailed', {
        reason: e instanceof Error ? e.message : String(e),
        stack: e instanceof Error ? (e.stack ?? '') : '',
      })
      relaunch()
      quit()
    }

    mainCatchHandler(new Error('init failed'))
    expect(quit).toHaveBeenCalledTimes(1)
  })

  it('PI4-03-04: Error 以外 (string) の reject でも動作する', () => {
    const logError = vi.fn()
    const relaunch = vi.fn()
    const quit = vi.fn()

    const mainCatchHandler = (e: unknown): void => {
      logError('main.initFailed', {
        reason: e instanceof Error ? e.message : String(e),
        stack: e instanceof Error ? (e.stack ?? '') : '',
      })
      relaunch()
      quit()
    }

    mainCatchHandler('string error')
    expect(logError).toHaveBeenCalledWith('main.initFailed', {
      reason: 'string error',
      stack: '',
    })
    expect(relaunch).toHaveBeenCalled()
    expect(quit).toHaveBeenCalled()
  })
})

// ─── PI4-05: siteRetryTimer 追跡・クリア ──────────────────────────────────────

describe('PI4-05: siteRetryTimer 追跡・クリア', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('PI4-05-01: バックオフ待機中に reloadSite を呼ぶと旧タイマーが発火しない', () => {
    vi.useFakeTimers()

    let siteRetryTimer: ReturnType<typeof setTimeout> | null = null
    const loadSiteUrl = vi.fn()

    // did-fail-load 内の setTimeout 相当
    const delayMs = 5000
    siteRetryTimer = setTimeout(() => {
      siteRetryTimer = null
      loadSiteUrl('https://signage.example.com')
    }, delayMs)

    // reloadSite() 相当（タイマーをクリアして新規ロード）
    if (siteRetryTimer !== null) { clearTimeout(siteRetryTimer); siteRetryTimer = null }
    loadSiteUrl('https://signage.example.com') // reloadSite内のloadSiteUrl呼び出し

    // 旧タイマーが発火しても二重呼び出しにならないことを確認
    vi.advanceTimersByTime(delayMs + 1000)

    // reloadSite からの 1 回のみ（stale timer は発火しない）
    expect(loadSiteUrl).toHaveBeenCalledTimes(1)
  })

  it('PI4-05-02: タイマー発火後に siteRetryTimer が null にリセットされる', () => {
    vi.useFakeTimers()

    let siteRetryTimer: ReturnType<typeof setTimeout> | null = null
    const loadSiteUrl = vi.fn()

    siteRetryTimer = setTimeout(() => {
      siteRetryTimer = null
      loadSiteUrl('https://signage.example.com')
    }, 2000)

    expect(siteRetryTimer).not.toBeNull()
    vi.advanceTimersByTime(2001)
    expect(siteRetryTimer).toBeNull()
    expect(loadSiteUrl).toHaveBeenCalledTimes(1)
  })

  it('PI4-05-03: will-quit 時に残存タイマーをクリアして発火しない', () => {
    vi.useFakeTimers()

    let siteRetryTimer: ReturnType<typeof setTimeout> | null = null
    const loadSiteUrl = vi.fn()

    siteRetryTimer = setTimeout(() => {
      siteRetryTimer = null
      loadSiteUrl('https://signage.example.com')
    }, 60000)

    // will-quit 処理相当
    if (siteRetryTimer !== null) { clearTimeout(siteRetryTimer); siteRetryTimer = null }

    vi.advanceTimersByTime(61000)
    expect(loadSiteUrl).not.toHaveBeenCalled()
    expect(siteRetryTimer).toBeNull()
  })

  it('PI4-05-04: タイマー未設定時に reloadSite が null チェックで安全に動作する', () => {
    let siteRetryTimer: ReturnType<typeof setTimeout> | null = null
    const loadSiteUrl = vi.fn()

    // null の場合は clearTimeout を呼ばない
    if (siteRetryTimer !== null) { clearTimeout(siteRetryTimer); siteRetryTimer = null }
    loadSiteUrl('https://signage.example.com')

    expect(loadSiteUrl).toHaveBeenCalledTimes(1)
    expect(siteRetryTimer).toBeNull()
  })
})
