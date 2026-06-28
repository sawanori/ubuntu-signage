/**
 * T13 — Watcher
 *
 * chokidar v4/v5 ラッパー。フォルダを監視し PlaylistManager を最新に保つ。
 *
 * 動作:
 *   - add / unlink / change (.mp4) イベントを 500ms デバウンスで束ね、
 *     playlist.load() を呼び出してプレイリストを更新する
 *   - awaitWriteFinish: { stabilityThreshold: 2000, pollInterval: 200 } により
 *     コピー途中の巨大 MP4 を誤読しない
 *   - 5 分周期再スキャン（rescanIntervalMs, 0 = 無効）でイベント欠落を補完
 *   - フォルダ消失 (unlinkDir / ENOENT) や権限エラーを捕捉しクラッシュしない
 */

import * as path from 'path'
import { watch as chokidarWatch, type FSWatcher } from 'chokidar'
import { PlaylistManager } from './playlist'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface WatcherLogger {
  debug(data: Record<string, unknown>): void
  warn(data: Record<string, unknown>): void
  error(data: Record<string, unknown>): void
}

export interface WatcherOptions {
  /** awaitWriteFinish stabilityThreshold ms (default: 2000) */
  stabilityThreshold?: number
  /** awaitWriteFinish pollInterval ms (default: 200) */
  pollInterval?: number
  /** デバウンス ms: 連続イベントを束ねて playlist.load() を呼ぶ間隔 (default: 500) */
  debounceMs?: number
  /** 周期再スキャン間隔 ms。0 = 無効 (default: 300000 = 5分) */
  rescanIntervalMs?: number
  /**
   * ネイティブ inotify の代わりにポーリングで FS 変更を検出する。
   * WSL2 / USB / NFS など inotify が不安定な環境で rename 欠落を防ぐ。
   * 本番 Pi4 のローカル ext4 では false のまま（デフォルト）。
   */
  usePolling?: boolean
  /**
   * usePolling=true 時のポーリング間隔 ms (chokidar の interval/binaryInterval に渡す)。
   * デフォルト: 100ms。開発環境では 50ms 程度が適切。
   */
  pollIntervalMs?: number
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

const noopLogger: WatcherLogger = {
  debug: (_data: Record<string, unknown>): void => {
    /* noop */
  },
  warn: (_data: Record<string, unknown>): void => {
    /* noop */
  },
  error: (_data: Record<string, unknown>): void => {
    /* noop */
  },
}

function isMp4(filePath: string): boolean {
  return filePath.toLowerCase().endsWith('.mp4')
}

// ---------------------------------------------------------------------------
// Watcher class
// ---------------------------------------------------------------------------

export class Watcher {
  private fsWatcher: FSWatcher | null = null
  private debounceTimer: ReturnType<typeof setTimeout> | null = null
  private rescanTimer: ReturnType<typeof setInterval> | null = null
  private currentFolder: string = ''

  constructor(
    private readonly playlist: PlaylistManager,
    private readonly options: WatcherOptions = {},
    private readonly logger: WatcherLogger = noopLogger,
  ) {}

  /**
   * フォルダ監視を開始する。
   * 既に監視中の場合は先に停止し、新しいフォルダに切り替える。
   */
  async start(folderPath: string): Promise<void> {
    await this.stop()
    this.currentFolder = folderPath

    const stabilityThreshold = this.options.stabilityThreshold ?? 2000
    const pollInterval = this.options.pollInterval ?? 200
    const debounceMs = this.options.debounceMs ?? 500
    const rescanIntervalMs = this.options.rescanIntervalMs ?? 5 * 60 * 1000
    const usePolling = this.options.usePolling ?? false
    const pollIntervalMs = this.options.pollIntervalMs ?? 100

    // ---- 初期スキャン ----
    // playlist.load() は内部でエラーを捕捉するため、ここでは await のみ
    await this.playlist.load(folderPath)

    // ---- chokidar 起動 ----
    const fsw = chokidarWatch(folderPath, {
      persistent: true,
      ignoreInitial: true,
      usePolling,
      ...(usePolling && { interval: pollIntervalMs, binaryInterval: pollIntervalMs }),
      awaitWriteFinish: {
        stabilityThreshold,
        pollInterval,
      },
    })
    this.fsWatcher = fsw

    // ---- デバウンス付き再スキャン ----
    const scheduleRescan = (): void => {
      if (this.debounceTimer !== null) {
        clearTimeout(this.debounceTimer)
      }
      this.debounceTimer = setTimeout(() => {
        this.debounceTimer = null
        void this.playlist.load(this.currentFolder)
      }, debounceMs)
    }

    // ---- ファイルイベントハンドラ ----
    fsw.on('add', (filePath: string) => {
      if (isMp4(filePath)) {
        scheduleRescan()
      }
    })

    fsw.on('unlink', (filePath: string) => {
      if (isMp4(filePath)) {
        scheduleRescan()
      }
    })

    fsw.on('change', (filePath: string) => {
      if (isMp4(filePath)) {
        scheduleRescan()
      }
    })

    // ---- 監視フォルダ自体の消失 ----
    fsw.on('unlinkDir', (dirPath: string) => {
      if (path.resolve(dirPath) === path.resolve(this.currentFolder)) {
        this.logger.error({ event: 'watcher.folderGone', path: dirPath })
        // load() はエラーを捕捉し空リストを返す
        void this.playlist.load(this.currentFolder)
      }
    })

    // ---- 永続エラーハンドラ ----
    fsw.on('error', (err: unknown) => {
      const e = err instanceof Error ? err : new Error(String(err))
      const code = (e as NodeJS.ErrnoException).code
      if (code === 'ENOENT' || code === 'ENOTDIR') {
        this.logger.error({ event: 'watcher.folderGone', reason: e.message })
        void this.playlist.load(this.currentFolder)
      } else {
        this.logger.error({ event: 'watcher.error', reason: e.message })
      }
    })

    // ---- ready 待機（権限エラー等でエラーが先に来た場合も resolve する） ----
    await new Promise<void>((resolve) => {
      let settled = false
      const settle = (): void => {
        if (!settled) {
          settled = true
          resolve()
        }
      }
      // ready が来たら解決
      fsw.once('ready', settle)
      // ready より前にエラーが来た場合も解決（ハング防止）
      fsw.once('error', settle)
    })

    // ---- 周期再スキャン ----
    if (rescanIntervalMs > 0) {
      this.rescanTimer = setInterval(() => {
        void this.playlist.load(this.currentFolder)
      }, rescanIntervalMs)
    }
  }

  /**
   * 監視を停止し、タイマー・ウォッチャーを解放する。
   */
  async stop(): Promise<void> {
    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer)
      this.debounceTimer = null
    }
    if (this.rescanTimer !== null) {
      clearInterval(this.rescanTimer)
      this.rescanTimer = null
    }
    if (this.fsWatcher !== null) {
      await this.fsWatcher.close()
      this.fsWatcher = null
    }
  }
}
