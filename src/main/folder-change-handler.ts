/**
 * src/main/folder-change-handler.ts — T32-BE
 *
 * フォルダ変更処理（純粋手続き・Electron 非依存・単体テスト可能）。
 *
 * 処理順序:
 *   1. watcher.stop()  — 旧フォルダの監視を停止
 *   2. playlist.resetCursor() — カーソルを先頭にリセット（新フォルダ基準で再開）
 *   3. watcher.start(newPath) — 新フォルダへ再ポイント（内部で playlist.load を呼ぶ）
 *      ※ newPath が空文字列の場合は start をスキップ（フォルダ未設定状態）
 *
 * 呼び出し元: src/main/index.ts (onFolderChange フック)
 */

import type { Watcher } from './watcher'
import type { PlaylistManager } from './playlist'

/**
 * 動画フォルダを newPath に動的切替する。
 *
 * パラメータ型は実際に呼ぶメソッドのみを要求する Pick 型（C6）。
 * 呼び出し元は Watcher / PlaylistManager フルインスタンスを渡せる（構造的部分型で互換）。
 *
 * @param newPath - 新しい動画フォルダの絶対パス（空文字列 = フォルダ未選択）
 * @param watcher - stop / start メソッドを持つオブジェクト
 * @param playlist - resetCursor メソッドを持つオブジェクト
 */
export async function applyFolderChange(
  newPath: string,
  watcher: Pick<Watcher, 'stop' | 'start'>,
  playlist: Pick<PlaylistManager, 'resetCursor'>,
): Promise<void> {
  await watcher.stop()
  playlist.resetCursor()
  if (newPath !== '') {
    await watcher.start(newPath)
  }
}
