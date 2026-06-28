/**
 * T10 — shared/schema.ts テスト (UC-01〜UC-06 相当)
 *
 * ConfigSchema: 完全検証スキーマ
 * ConfigUpdateSchema: settings:update payload の部分更新検証スキーマ
 */
import { describe, it, expect } from 'vitest'
import { ConfigSchema, ConfigUpdateSchema } from '../../src/shared/schema'

// --------- ConfigSchema ---------

describe('ConfigSchema', () => {
  const validConfig = {
    siteUrl: 'https://example.com/signage',
    videoFolderPath: '/home/user/videos',
    intervalMinutes: 5 as const,
    loopEnabled: true,
    fadeDurationMs: 1000,
  }

  it('parses a fully valid Config', () => {
    const result = ConfigSchema.safeParse(validConfig)
    expect(result.success).toBe(true)
  })

  it.each([1, 5, 10, 15, 30] as const)(
    'accepts intervalMinutes = %i (allowed value)',
    (interval) => {
      const result = ConfigSchema.safeParse({ ...validConfig, intervalMinutes: interval })
      expect(result.success).toBe(true)
    }
  )

  it.each([0, 2, 3, 4, 6, 7, 8, 9, 11, 20, 25, 31, 60])(
    'rejects intervalMinutes = %i (not in allowed set {1,5,10,15,30})',
    (interval) => {
      const result = ConfigSchema.safeParse({ ...validConfig, intervalMinutes: interval })
      expect(result.success).toBe(false)
    }
  )

  it('accepts http:// siteUrl', () => {
    const result = ConfigSchema.safeParse({ ...validConfig, siteUrl: 'http://example.com' })
    expect(result.success).toBe(true)
  })

  it('accepts https:// siteUrl', () => {
    const result = ConfigSchema.safeParse({ ...validConfig, siteUrl: 'https://example.com' })
    expect(result.success).toBe(true)
  })

  // 空文字は「未設定（スタート画面）」として有効に変更（optionalSiteUrlSchema）
  it('accepts empty string siteUrl (未設定 = スタート画面)', () => {
    const result = ConfigSchema.safeParse({ ...validConfig, siteUrl: '' })
    expect(result.success).toBe(true)
  })

  it.each([
    'javascript://evil',
    'ftp://ftp.example.com',
    'file:///etc/passwd',
    'data:text/html,hello',
    'vbscript:alert(1)',
    'not-a-url',
    // '' は有効（未設定扱い）のためリストから除外
  ])('rejects invalid/dangerous siteUrl: %s', (url) => {
    const result = ConfigSchema.safeParse({ ...validConfig, siteUrl: url })
    expect(result.success).toBe(false)
  })

  it('rejects fadeDurationMs = 0 (must be positive)', () => {
    expect(ConfigSchema.safeParse({ ...validConfig, fadeDurationMs: 0 }).success).toBe(false)
  })

  it('rejects negative fadeDurationMs', () => {
    expect(ConfigSchema.safeParse({ ...validConfig, fadeDurationMs: -100 }).success).toBe(false)
  })

  it('rejects non-integer fadeDurationMs', () => {
    expect(ConfigSchema.safeParse({ ...validConfig, fadeDurationMs: 999.9 }).success).toBe(false)
  })

  it('rejects missing required field siteUrl', () => {
    const withoutSiteUrl = {
      videoFolderPath: '/home/user/videos',
      intervalMinutes: 5 as const,
      loopEnabled: true,
      fadeDurationMs: 1000,
    }
    expect(ConfigSchema.safeParse(withoutSiteUrl).success).toBe(false)
  })

  it('rejects missing required field intervalMinutes', () => {
    const withoutInterval = {
      siteUrl: 'https://example.com',
      videoFolderPath: '/home/user/videos',
      loopEnabled: true,
      fadeDurationMs: 1000,
    }
    expect(ConfigSchema.safeParse(withoutInterval).success).toBe(false)
  })

  it('returns parsed value with correct field types', () => {
    const result = ConfigSchema.safeParse(validConfig)
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(typeof result.data.siteUrl).toBe('string')
    expect(typeof result.data.videoFolderPath).toBe('string')
    expect(typeof result.data.intervalMinutes).toBe('number')
    expect(typeof result.data.loopEnabled).toBe('boolean')
    expect(typeof result.data.fadeDurationMs).toBe('number')
  })
})

// --------- ConfigUpdateSchema ---------

describe('ConfigUpdateSchema', () => {
  it('accepts an empty object (all fields optional)', () => {
    expect(ConfigUpdateSchema.safeParse({}).success).toBe(true)
  })

  it.each([
    { intervalMinutes: 5 as const },
    { loopEnabled: false },
    { siteUrl: 'https://example.com' },
    { videoFolderPath: '/new/path' },
    { fadeDurationMs: 500 },
  ])('accepts a single valid field update: %o', (update) => {
    expect(ConfigUpdateSchema.safeParse(update).success).toBe(true)
  })

  it.each([1, 5, 10, 15, 30] as const)(
    'accepts intervalMinutes = %i in update',
    (interval) => {
      expect(ConfigUpdateSchema.safeParse({ intervalMinutes: interval }).success).toBe(true)
    }
  )

  it.each([2, 3, 4, 6, 7, 8, 9, 11, 20, 25, 31, 60])(
    'rejects intervalMinutes = %i in update (not in {1,5,10,15,30})',
    (interval) => {
      expect(ConfigUpdateSchema.safeParse({ intervalMinutes: interval }).success).toBe(false)
    }
  )

  it.each([
    'javascript://evil',
    'ftp://ftp.example.com',
    'file:///etc/passwd',
    'data:text/html,hello',
  ])('rejects invalid URL scheme in siteUrl: %s', (url) => {
    expect(ConfigUpdateSchema.safeParse({ siteUrl: url }).success).toBe(false)
  })

  it('accepts http:// siteUrl in update', () => {
    expect(ConfigUpdateSchema.safeParse({ siteUrl: 'http://example.com' }).success).toBe(true)
  })

  it('accepts https:// siteUrl in update', () => {
    expect(ConfigUpdateSchema.safeParse({ siteUrl: 'https://example.com' }).success).toBe(true)
  })

  // §5.1: 空文字は「未設定（スタート画面）」として有効（partial 更新で siteUrl をクリアできる）
  it('accepts empty string siteUrl in update (未設定へのリセット)', () => {
    expect(ConfigUpdateSchema.safeParse({ siteUrl: '' }).success).toBe(true)
  })

  it('rejects invalid intervalMinutes even when siteUrl is valid', () => {
    const result = ConfigUpdateSchema.safeParse({
      siteUrl: 'https://example.com',
      intervalMinutes: 7,
    })
    expect(result.success).toBe(false)
  })

  it('accepts partial update with multiple valid fields', () => {
    const result = ConfigUpdateSchema.safeParse({
      siteUrl: 'https://example.com',
      intervalMinutes: 15,
      loopEnabled: false,
    })
    expect(result.success).toBe(true)
  })
})
