/**
 * T13 — watcher integration tests (UW-01 ~ UW-07)
 *
 * 実 chokidar + 一時ディレクトリで決定的に動作を検証する。
 *
 * UW-01: 追加は次回反映
 * UW-02: コピー途中は awaitWriteFinish 後採用
 * UW-03: 再生中削除でカーソル整合
 * UW-04: 権限なしフォルダ → エラー捕捉、クラッシュなし
 * UW-05: フォルダ自体が消える → 空リスト、エラー捕捉
 * UW-06: リネームでプレイリスト更新・カーソル整合
 * UW-07: 低速コピー後のアトミック rename → 書き込み安定後に採用
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { Watcher, type WatcherOptions, type WatcherLogger } from '../../src/main/watcher'
import { PlaylistManager } from '../../src/main/playlist'
import { makeTempDir, touch } from './helpers/fs-fixtures'

/**
 * ポーリングでconditionがtrueになるまで待機する。
 * timeoutMs を超えるとエラーをスロー。
 */
async function waitFor(
  condition: () => boolean,
  timeoutMs = 10000,
  intervalMs = 50,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (condition()) return
    await new Promise<void>((r) => setTimeout(r, intervalMs))
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`)
}

/**
 * テスト用の短いオプション（stabilityThreshold=400ms, debounce=100ms）
 * usePolling=true / pollIntervalMs=50 でネイティブ inotify の代わりにポーリングを使用し、
 * WSL2 での rename イベント欠落を防いでテストを決定論化する。
 */
function testOptions(override: Partial<WatcherOptions> = {}): WatcherOptions {
  return {
    stabilityThreshold: 400,
    pollInterval: 50,
    debounceMs: 100,
    rescanIntervalMs: 0, // 周期再スキャン無効
    usePolling: true,
    pollIntervalMs: 50,
    ...override,
  }
}

function makeMockLogger(): {
  warns: Record<string, unknown>[]
  errors: Record<string, unknown>[]
  logger: WatcherLogger
} {
  const warns: Record<string, unknown>[] = []
  const errors: Record<string, unknown>[] = []
  const logger: WatcherLogger = {
    debug: (_d) => {
      /* noop */
    },
    warn: (d) => warns.push(d),
    error: (d) => errors.push(d),
  }
  return { warns, errors, logger }
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

// これらは実 chokidar ポーリング + 実 FS を使う統合テスト。Vitest が複数テストファイルを
// 並列ワーカーで実行するため、CPU 競合時にはポーリング検出やデバウンス(setTimeout)が
// 数百ms〜数秒遅延しうる（単独実行では 0/20 失敗、フル並列実行で稀に超過）。
// テスト/フックのタイムアウトをファイルスコープで引き上げ、各 waitFor の予算を実効上限にする。
// 正常系では条件成立時に即 return するため、上限引き上げによる実行時間増は発生しない。
vi.setConfig({ testTimeout: 15000, hookTimeout: 15000 })

describe('Watcher (UW-01 ~ UW-07)', () => {
  let tmpDir: string
  let playlist: PlaylistManager
  let watcher: Watcher
  let warns: Record<string, unknown>[]
  let errors: Record<string, unknown>[]
  let logger: WatcherLogger

  beforeEach(async () => {
    tmpDir = await makeTempDir('watcher-test-')
    const mock = makeMockLogger()
    warns = mock.warns
    errors = mock.errors
    logger = mock.logger
    playlist = new PlaylistManager(logger)
    watcher = new Watcher(playlist, testOptions(), logger)
  })

  afterEach(async () => {
    await watcher.stop()
    await fs.promises.rm(tmpDir, { recursive: true, force: true })
  })

  // -------------------------------------------------------------------------
  // UW-01: 追加は次回反映
  // -------------------------------------------------------------------------
  it('UW-01: new .mp4 added while watching → included in playlist after stabilization', async () => {
    await touch(tmpDir, 'a.mp4')
    await touch(tmpDir, 'b.mp4')
    await watcher.start(tmpDir) // 初期ロード: [a.mp4, b.mp4]

    // 新ファイルを追加
    await touch(tmpDir, 'c.mp4')

    // stabilityThreshold=400ms + debounce=100ms + バッファ後にプレイリストへ反映される
    await waitFor(() => playlist.getFiles().some((f) => path.basename(f) === 'c.mp4'), 10000)

    const names = playlist.getFiles().map((f) => path.basename(f))
    expect(names).toContain('a.mp4')
    expect(names).toContain('b.mp4')
    expect(names).toContain('c.mp4')
  })

  // -------------------------------------------------------------------------
  // UW-02: コピー途中は awaitWriteFinish 後採用
  // -------------------------------------------------------------------------
  it('UW-02: file being written is NOT in playlist until awaitWriteFinish stabilizes', async () => {
    await watcher.start(tmpDir) // 空フォルダ

    const largePath = path.join(tmpDir, 'large.mp4')

    // 書き込みストリームを開いたまま（サイズが変化し続ける）
    const writeStream = fs.createWriteStream(largePath)

    // 初回バイトを書き込む
    await new Promise<void>((resolve, reject) => {
      writeStream.write(Buffer.alloc(1024), (err) => {
        if (err) reject(err)
        else resolve()
      })
    })

    // stabilityThreshold(400ms) 未満の時間で確認 → まだプレイリスト外
    await new Promise<void>((r) => setTimeout(r, 150))
    expect(playlist.getFiles().some((f) => path.basename(f) === 'large.mp4')).toBe(false)

    // 書き込み終了（ファイルサイズ確定）
    await new Promise<void>((resolve, reject) => {
      writeStream.end((err?: Error | null) => {
        if (err) reject(err)
        else resolve()
      })
    })

    // stabilizationThreshold + debounce + バッファ後に反映される
    await waitFor(() => playlist.getFiles().some((f) => path.basename(f) === 'large.mp4'), 10000)

    expect(playlist.getFiles().map((f) => path.basename(f))).toContain('large.mp4')
  })

  // -------------------------------------------------------------------------
  // UW-03: 再生中削除でカーソル整合
  // -------------------------------------------------------------------------
  it('UW-03: delete cursor file while watching → cursor aligns to next element', async () => {
    await touch(tmpDir, 'clip-001.mp4')
    await touch(tmpDir, 'clip-002.mp4')
    await touch(tmpDir, 'clip-003.mp4')
    await watcher.start(tmpDir) // 初期ロード: [clip-001, clip-002, clip-003]

    // cursor を clip-001.mp4 にセット
    const first = playlist.next()
    expect(first).not.toBeNull()
    expect(path.basename(first!)).toBe('clip-001.mp4')

    // clip-001.mp4 を削除
    await fs.promises.unlink(path.join(tmpDir, 'clip-001.mp4'))

    // ウォッチャーが unlink を検出しリロード完了するまで待つ
    await waitFor(
      () => !playlist.getFiles().some((f) => path.basename(f) === 'clip-001.mp4'),
      10000,
    )

    // next() は cursor('clip-001.mp4') の次の昇順要素 clip-002.mp4 を返す
    const result = playlist.next()
    expect(result).not.toBeNull()
    expect(path.basename(result!)).toBe('clip-002.mp4')
  })

  // -------------------------------------------------------------------------
  // UW-04: 権限なしフォルダ → エラー捕捉、クラッシュなし
  // -------------------------------------------------------------------------
  it('UW-04: no-permission folder → error logged, playlist empty, no crash', async () => {
    if (process.getuid?.() === 0) {
      console.warn('UW-04: skipped (running as root)')
      return
    }

    const noPermDir = await makeTempDir('watcher-test-')
    await fs.promises.chmod(noPermDir, 0o000)

    const { errors: errs, logger: log } = makeMockLogger()
    const pl = new PlaylistManager(log)
    const w = new Watcher(pl, testOptions(), log)

    try {
      // 権限なしでも start() はスローしない
      await expect(w.start(noPermDir)).resolves.toBeUndefined()

      // プレイリストは空（load 失敗）
      expect(pl.getFiles()).toHaveLength(0)

      // エラーがログに記録されている
      expect(errs.length).toBeGreaterThan(0)
    } finally {
      await w.stop()
      // クリーンアップのためにパーミッションを復元
      await fs.promises.chmod(noPermDir, 0o755)
      await fs.promises.rm(noPermDir, { recursive: true, force: true })
    }
  })

  // -------------------------------------------------------------------------
  // UW-05: フォルダ自体が消える → 空リスト・エラー捕捉
  // -------------------------------------------------------------------------
  it('UW-05: watched folder deleted → playlist becomes empty, error logged, no crash', async () => {
    await touch(tmpDir, 'video.mp4')
    await watcher.start(tmpDir) // 初期ロード: [video.mp4]

    expect(playlist.getFiles()).toHaveLength(1)

    // フォルダごと削除
    await fs.promises.rm(tmpDir, { recursive: true, force: true })

    // プレイリストが空になるまで待つ（watcher が検出してリロード）
    await waitFor(() => playlist.getFiles().length === 0, 10000)

    expect(playlist.getFiles()).toHaveLength(0)
    // エラーまたは警告が記録されていること（playlist.loadFailed 等）
    const hasLog = errors.length > 0 || warns.length > 0
    expect(hasLog).toBe(true)
  })

  // -------------------------------------------------------------------------
  // UW-06: リネームでプレイリスト更新・カーソル整合
  // usePolling=true で inotify の代わりにポーリングを使用し、WSL2 での rename 欠落を防ぐ
  // -------------------------------------------------------------------------
  it('UW-06: rename clip-001.mp4 → clip-001a.mp4 → playlist updated, cursor aligned', async () => {
    await touch(tmpDir, 'clip-001.mp4')
    await touch(tmpDir, 'clip-002.mp4')

    // usePolling=true（testOptions() のデフォルト）により rename を確実に検出する
    // rescanIntervalMs は 0（ポーリングが補完するため周期再スキャン不要）
    await watcher.start(tmpDir) // 初期ロード: [clip-001.mp4, clip-002.mp4]

    // cursor を clip-001.mp4 にセット
    const first = playlist.next()
    expect(first).not.toBeNull()
    expect(path.basename(first!)).toBe('clip-001.mp4')

    // clip-001.mp4 → clip-001a.mp4 にリネーム
    await fs.promises.rename(
      path.join(tmpDir, 'clip-001.mp4'),
      path.join(tmpDir, 'clip-001a.mp4'),
    )

    // usePolling(50ms) + stabilityThreshold(400ms) + debounce(100ms) → ~600ms 以内に反映
    await waitFor(
      () =>
        !playlist.getFiles().some((f) => path.basename(f) === 'clip-001.mp4') &&
        playlist.getFiles().some((f) => path.basename(f) === 'clip-001a.mp4'),
      10000,
    )

    // cursor は 'clip-001.mp4'（削除済み）
    // next() は 'clip-001.mp4' より辞書順で後ろの要素 clip-001a.mp4 を返す
    const result = playlist.next()
    expect(result).not.toBeNull()
    expect(path.basename(result!)).toBe('clip-001a.mp4')
  })

  // -------------------------------------------------------------------------
  // UW-07: 低速コピー後のアトミック rename → 書き込み安定後に採用
  // -------------------------------------------------------------------------
  it('UW-07: atomic rename (temp file → .mp4) → adopted after awaitWriteFinish + rename event', async () => {
    await watcher.start(tmpDir) // 空フォルダ

    // .tmp ファイルに書き込み（.mp4 ではないので watcher は無視）
    const tmpFile = path.join(tmpDir, 'new_video.tmp')
    await fs.promises.writeFile(tmpFile, Buffer.alloc(1024))

    // .mp4 として rename する前はプレイリスト外
    await new Promise<void>((r) => setTimeout(r, 200))
    expect(playlist.getFiles().some((f) => path.basename(f) === 'new_video.mp4')).toBe(false)

    // アトミック rename: .tmp → .mp4
    const mp4File = path.join(tmpDir, 'new_video.mp4')
    await fs.promises.rename(tmpFile, mp4File)

    // rename による add イベント検出 + awaitWriteFinish + debounce 後に採用
    await waitFor(
      () => playlist.getFiles().some((f) => path.basename(f) === 'new_video.mp4'),
      10000,
    )

    const names = playlist.getFiles().map((f) => path.basename(f))
    expect(names).toContain('new_video.mp4')
  })
})
