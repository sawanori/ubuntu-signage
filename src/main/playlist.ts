/**
 * T12 — PlaylistManager
 *
 * フォルダ走査（.mp4 のみ）・ファイル名昇順ソート・巡回カーソル（ファイル名ベース）・空処理
 *
 * 巡回カーソル仕様:
 *   - 「最後に再生したファイル名（basename）」を保持する
 *   - next() は 1 本ずつ前進。末尾 → 先頭で循環
 *   - 再走査（load() 再呼出し）後はカーソルが指すファイル名の次の昇順要素から再開
 *   - カーソルが指すファイルが削除されていた場合は次要素（alphabetically）へ
 *   - 空プレイリスト時は null 返却 + WARN ログ
 */

import * as fs from 'fs'
import * as path from 'path'

/** ログインタフェース（structuredログ想定） */
export interface PlaylistLogger {
  warn(data: Record<string, unknown>): void
  error(data: Record<string, unknown>): void
}

const noopLogger: PlaylistLogger = {
  warn: (_data: Record<string, unknown>): void => {
    /* noop */
  },
  error: (_data: Record<string, unknown>): void => {
    /* noop */
  },
}

export class PlaylistManager {
  /** ソート済み絶対パスリスト */
  private files: string[] = []
  /** 最後に load() を呼んだフォルダパス */
  private folderPath: string = ''
  /** 最後に next() が返したファイルの basename。null = 未再生 */
  private lastPlayedFileName: string | null = null
  private readonly logger: PlaylistLogger

  constructor(logger: PlaylistLogger = noopLogger) {
    this.logger = logger
  }

  /**
   * 指定フォルダを走査し、.mp4 ファイルをファイル名昇順で読み込む。
   * 再呼出し時はカーソル (lastPlayedFileName) を維持する（再走査後カーソル継続仕様）。
   * パス不正 / 権限なし の場合はエラーを捕捉し、空リストをセットして ERROR ログを出す。
   */
  async load(folderPath: string): Promise<void> {
    this.folderPath = folderPath
    try {
      const entries: string[] = await fs.promises.readdir(folderPath)
      const mp4Files: string[] = entries
        .filter((name: string): boolean => name.toLowerCase().endsWith('.mp4'))
        .sort() // ファイル名昇順
        .map((name: string): string => path.join(folderPath, name))

      this.files = mp4Files

      if (this.files.length === 0) {
        this.logger.warn({ event: 'playlist.empty', folderPath })
      }
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code
      const reason: string = code !== undefined ? code : String(err)
      this.logger.error({ event: 'playlist.loadFailed', reason, folderPath })
      this.files = []
    }
  }

  /**
   * 次に再生すべきファイルの絶対パスを返す。
   * - 空プレイリスト時: null + WARN ログ
   * - カーソル未設定 (null): 先頭ファイルを返す
   * - カーソルが存在する場合: 1 つ後ろへ進む（末尾 → 先頭で循環）
   * - カーソルが削除されている場合: 削除されたファイル名の次の昇順要素を返す
   */
  next(): string | null {
    if (this.files.length === 0) {
      this.logger.warn({ event: 'playlist.empty' })
      return null
    }

    if (this.lastPlayedFileName === null) {
      // 未再生: 先頭ファイルを返す
      const first = this.files[0]
      if (first === undefined) {
        this.logger.warn({ event: 'playlist.empty' })
        return null
      }
      this.lastPlayedFileName = path.basename(first)
      return first
    }

    // カーソル位置を探す
    const cursorIdx: number = this.files.findIndex(
      (f: string): boolean => path.basename(f) === this.lastPlayedFileName
    )

    let nextIdx: number
    if (cursorIdx === -1) {
      // カーソルのファイルが削除済み: 削除名より大きい最初の要素へ
      nextIdx = this.findNextAfterName(this.lastPlayedFileName)
    } else {
      // 通常進行: 1 つ後ろ（末尾 → 先頭で循環）
      nextIdx = (cursorIdx + 1) % this.files.length
    }

    const nextFile = this.files[nextIdx]
    if (nextFile === undefined) {
      // 防御: ここに来ることは files.length > 0 の場合あり得ないが型安全のため
      this.logger.warn({ event: 'playlist.empty' })
      return null
    }

    this.lastPlayedFileName = path.basename(nextFile)
    return nextFile
  }

  /**
   * 削除されたファイル名 (deletedName) よりアルファベット順で後ろの
   * 最初の要素のインデックスを返す。
   * すべてが deletedName より前の場合は 0（先頭）を返す（末尾→先頭循環）。
   */
  private findNextAfterName(deletedName: string): number {
    for (let i = 0; i < this.files.length; i++) {
      const file = this.files[i]
      if (file !== undefined && path.basename(file) > deletedName) {
        return i
      }
    }
    // wrap to head
    return 0
  }

  /** 現在のプレイリスト（読み取り専用） */
  getFiles(): readonly string[] {
    return this.files
  }

  /** 最後に再生されたファイルの basename (null = 未再生) */
  getLastPlayedFileName(): string | null {
    return this.lastPlayedFileName
  }

  /** load() を呼んだフォルダパス */
  getFolderPath(): string {
    return this.folderPath
  }

  /** カーソルを先頭にリセットする（フォルダ切替時などに使用） */
  resetCursor(): void {
    this.lastPlayedFileName = null
  }
}
