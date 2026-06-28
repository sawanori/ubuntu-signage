/**
 * test/unit/folder-change-handler.test.ts
 *
 * applyFolderChange の単体テスト（T32-BE）
 *
 * 検証方針:
 *   - Watcher / PlaylistManager を最小モックで注入（Electron / chokidar 非依存）
 *   - 呼び出し順序と引数を検証する
 *   - 空パス・エラー伝播の境界値を確認する
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { applyFolderChange } from '../../src/main/folder-change-handler'
import type { Watcher } from '../../src/main/watcher'
import type { PlaylistManager } from '../../src/main/playlist'

// ─── モック型 ────────────────────────────────────────────────────────────────

type WatcherMock = {
  stop: ReturnType<typeof vi.fn<[], Promise<void>>>
  start: ReturnType<typeof vi.fn<[string], Promise<void>>>
}

type PlaylistMock = {
  resetCursor: ReturnType<typeof vi.fn<[], void>>
}

// ─── テストスイート ───────────────────────────────────────────────────────────

describe('applyFolderChange (T32-BE)', () => {
  let watcher: WatcherMock
  let playlist: PlaylistMock
  let callOrder: string[]

  beforeEach(() => {
    callOrder = []
    watcher = {
      stop: vi.fn(async () => {
        callOrder.push('stop')
      }),
      start: vi.fn(async (_path: string) => {
        callOrder.push('start')
      }),
    }
    playlist = {
      resetCursor: vi.fn(() => {
        callOrder.push('resetCursor')
      }),
    }
  })

  it('UC-07-1: 正常パス — stop → resetCursor → start の順に呼ばれる', async () => {
    await applyFolderChange(
      '/videos/new',
      watcher as unknown as Watcher,
      playlist as unknown as PlaylistManager,
    )

    expect(callOrder).toEqual(['stop', 'resetCursor', 'start'])
  })

  it('UC-07-2: start に新しいパスが渡される', async () => {
    const newPath = '/videos/campaign-2026'
    await applyFolderChange(
      newPath,
      watcher as unknown as Watcher,
      playlist as unknown as PlaylistManager,
    )

    expect(watcher.start).toHaveBeenCalledOnce()
    expect(watcher.start).toHaveBeenCalledWith(newPath)
  })

  it('UC-07-3: 空パス — stop と resetCursor は呼ばれるが start は呼ばれない', async () => {
    await applyFolderChange(
      '',
      watcher as unknown as Watcher,
      playlist as unknown as PlaylistManager,
    )

    expect(watcher.stop).toHaveBeenCalledOnce()
    expect(playlist.resetCursor).toHaveBeenCalledOnce()
    expect(watcher.start).not.toHaveBeenCalled()
    expect(callOrder).toEqual(['stop', 'resetCursor'])
  })

  it('UC-07-4: stop は常に resetCursor より先に完了してから resetCursor が呼ばれる', async () => {
    // stop が非同期で完了するパターンで順序を検証
    const asyncOrder: string[] = []
    watcher.stop = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          setTimeout(() => {
            asyncOrder.push('stop-done')
            resolve()
          }, 0)
        }),
    )
    playlist.resetCursor = vi.fn(() => {
      asyncOrder.push('resetCursor')
    })
    watcher.start = vi.fn(async () => {
      asyncOrder.push('start')
    })

    await applyFolderChange(
      '/path',
      watcher as unknown as Watcher,
      playlist as unknown as PlaylistManager,
    )

    expect(asyncOrder).toEqual(['stop-done', 'resetCursor', 'start'])
  })

  it('UC-07-5: watcher.stop が例外をスローした場合、Promise が reject される', async () => {
    watcher.stop = vi.fn(async () => {
      throw new Error('stop failed')
    })

    await expect(
      applyFolderChange(
        '/path',
        watcher as unknown as Watcher,
        playlist as unknown as PlaylistManager,
      ),
    ).rejects.toThrow('stop failed')

    // stop が失敗したので resetCursor / start は呼ばれない
    expect(playlist.resetCursor).not.toHaveBeenCalled()
    expect(watcher.start).not.toHaveBeenCalled()
  })

  it('UC-07-6: watcher.start が例外をスローした場合、Promise が reject される', async () => {
    watcher.start = vi.fn(async () => {
      throw new Error('start failed')
    })

    await expect(
      applyFolderChange(
        '/path',
        watcher as unknown as Watcher,
        playlist as unknown as PlaylistManager,
      ),
    ).rejects.toThrow('start failed')

    // stop と resetCursor は既に呼ばれている
    expect(watcher.stop).toHaveBeenCalledOnce()
    expect(playlist.resetCursor).toHaveBeenCalledOnce()
  })
})
