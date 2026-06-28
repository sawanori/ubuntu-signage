/**
 * T12 — playlist テスト (UP-01〜UP-08)
 *
 * PlaylistManager: フォルダ走査・拡張子フィルタ・ファイル名昇順ソート・巡回カーソル・空処理
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { PlaylistManager, type PlaylistLogger } from '../../src/main/playlist'

// -------- test helpers --------

async function makeTempDir(): Promise<string> {
  return fs.promises.mkdtemp(path.join(os.tmpdir(), 'playlist-test-'))
}

async function touch(dir: string, name: string): Promise<void> {
  await fs.promises.writeFile(path.join(dir, name), Buffer.alloc(0))
}

async function removeFile(dir: string, name: string): Promise<void> {
  await fs.promises.unlink(path.join(dir, name))
}

// -------- test suite --------

describe('PlaylistManager', () => {
  let tmpDir: string
  let manager: PlaylistManager
  let warnLogs: Record<string, unknown>[]
  let errorLogs: Record<string, unknown>[]
  let mockLogger: PlaylistLogger

  beforeEach(async () => {
    tmpDir = await makeTempDir()
    warnLogs = []
    errorLogs = []
    mockLogger = {
      warn: (data: Record<string, unknown>) => {
        warnLogs.push(data)
      },
      error: (data: Record<string, unknown>) => {
        errorLogs.push(data)
      },
    }
    manager = new PlaylistManager(mockLogger)
  })

  afterEach(async () => {
    await fs.promises.rm(tmpDir, { recursive: true, force: true })
  })

  // -------- UP-01: N本順送り → 一周 --------
  it('UP-01: 3 files — next() ×4 returns a→b→c→a (wraps to head)', async () => {
    await touch(tmpDir, 'a.mp4')
    await touch(tmpDir, 'b.mp4')
    await touch(tmpDir, 'c.mp4')
    await manager.load(tmpDir)

    const r1 = manager.next()
    const r2 = manager.next()
    const r3 = manager.next()
    const r4 = manager.next()

    expect(r1).not.toBeNull()
    expect(r2).not.toBeNull()
    expect(r3).not.toBeNull()
    expect(r4).not.toBeNull()
    expect(path.basename(r1!)).toBe('a.mp4')
    expect(path.basename(r2!)).toBe('b.mp4')
    expect(path.basename(r3!)).toBe('c.mp4')
    expect(path.basename(r4!)).toBe('a.mp4') // wrapped
  })

  // -------- UP-02: 1本同一 --------
  it('UP-02: 1 file — next() ×3 returns same file every time', async () => {
    await touch(tmpDir, 'only.mp4')
    await manager.load(tmpDir)

    const r1 = manager.next()
    const r2 = manager.next()
    const r3 = manager.next()

    expect(r1).not.toBeNull()
    expect(path.basename(r1!)).toBe('only.mp4')
    expect(path.basename(r2!)).toBe('only.mp4')
    expect(path.basename(r3!)).toBe('only.mp4')
  })

  // -------- UP-03: 0本 no-op --------
  it('UP-03: empty folder — next() returns null and emits WARN', async () => {
    await manager.load(tmpDir) // load empty dir
    const result = manager.next()

    expect(result).toBeNull()
    // At least one WARN with event 'playlist.empty' must have been emitted
    const hasEmptyWarn = warnLogs.some((l) => l['event'] === 'playlist.empty')
    expect(hasEmptyWarn).toBe(true)
  })

  // -------- UP-04: パス不正捕捉 --------
  it('UP-04: invalid path — load() catches error, returns empty list, emits ERROR', async () => {
    const nonExistentPath = '/non/existent/path/playlist-test-totally-missing'
    await manager.load(nonExistentPath)

    expect(manager.getFiles()).toHaveLength(0)
    const hasLoadError = errorLogs.some((l) => l['event'] === 'playlist.loadFailed')
    expect(hasLoadError).toBe(true)
    // next() after failed load returns null without crashing
    expect(manager.next()).toBeNull()
  })

  // -------- UP-05: 非対応拡張子除外 --------
  it('UP-05: mixed extensions — only .mp4 files are included', async () => {
    await touch(tmpDir, 'video.mp4')
    await touch(tmpDir, 'video.mkv')
    await touch(tmpDir, 'video.avi')
    await touch(tmpDir, 'readme.txt')
    await manager.load(tmpDir)

    const files = manager.getFiles()
    // Only .mp4 (case-insensitive) should be present
    for (const f of files) {
      expect(path.basename(f).toLowerCase()).toMatch(/\.mp4$/)
    }
    expect(files.some((f) => path.basename(f) === 'video.mp4')).toBe(true)
    expect(files.some((f) => path.basename(f) === 'video.mkv')).toBe(false)
    expect(files.some((f) => path.basename(f) === 'video.avi')).toBe(false)
    expect(files.some((f) => path.basename(f) === 'readme.txt')).toBe(false)
  })

  // -------- UP-06: ファイル名昇順ソート --------
  it('UP-06: files are sorted by filename ascending', async () => {
    // Create in non-alphabetical order to confirm sort is applied
    await touch(tmpDir, 'z.mp4')
    await touch(tmpDir, 'a.mp4')
    await touch(tmpDir, 'm.mp4')
    await manager.load(tmpDir)

    const names = manager.getFiles().map((f) => path.basename(f))
    expect(names).toEqual(['a.mp4', 'm.mp4', 'z.mp4'])
  })

  // -------- UP-07: 中央挿入で既再生スキップせず --------
  it('UP-07: rescan after inserting c.mp4 — cursor at b.mp4 advances to c.mp4 (not back to a.mp4)', async () => {
    await touch(tmpDir, 'a.mp4')
    await touch(tmpDir, 'b.mp4')
    await manager.load(tmpDir) // [a.mp4, b.mp4]

    manager.next() // → a.mp4, cursor = a.mp4
    manager.next() // → b.mp4, cursor = b.mp4

    // Insert c.mp4 and rescan; cursor must survive as "b.mp4"
    await touch(tmpDir, 'c.mp4')
    await manager.load(tmpDir) // [a.mp4, b.mp4, c.mp4]

    // next() must return c.mp4 (next after b.mp4), NOT a.mp4 (head reset)
    const result = manager.next()
    expect(result).not.toBeNull()
    expect(path.basename(result!)).toBe('c.mp4')
  })

  // -------- UP-08: 削除時次要素 --------
  it('UP-08: cursor file deleted — next() returns next sorted element, no crash', async () => {
    await touch(tmpDir, 'a.mp4')
    await touch(tmpDir, 'b.mp4')
    await touch(tmpDir, 'c.mp4')
    await manager.load(tmpDir) // [a.mp4, b.mp4, c.mp4]

    manager.next() // → a.mp4, cursor = a.mp4
    manager.next() // → b.mp4, cursor = b.mp4

    // Delete b.mp4 and rescan; cursor stays "b.mp4" (deleted)
    await removeFile(tmpDir, 'b.mp4')
    await manager.load(tmpDir) // [a.mp4, c.mp4]

    // next() must return c.mp4 (next alphabetically after "b.mp4") without crashing
    let result: string | null = null
    expect(() => {
      result = manager.next()
    }).not.toThrow()
    expect(result).not.toBeNull()
    expect(path.basename(result!)).toBe('c.mp4')
  })
})
