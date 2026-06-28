/**
 * test/unit/helpers/fs-fixtures.ts
 *
 * 実 FS を使うユニット/統合テスト向けの共通ファイルシステムヘルパー。
 * playlist.test.ts と watcher.int.test.ts の重複定義を一本化する（A11）。
 */

import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

/**
 * 一時ディレクトリを作成して返す。
 * @param prefix os.tmpdir() 直下のプレフィックス（例: 'playlist-test-'）
 */
export async function makeTempDir(prefix = 'test-'): Promise<string> {
  return fs.promises.mkdtemp(path.join(os.tmpdir(), prefix))
}

/**
 * 指定ディレクトリにファイルを作成する（touch 相当）。
 * @param dir  対象ディレクトリ
 * @param name ファイル名
 * @param content ファイル内容（省略時は空）
 * @returns 作成したファイルの絶対パス
 */
export async function touch(
  dir: string,
  name: string,
  content?: Buffer,
): Promise<string> {
  const filePath = path.join(dir, name)
  await fs.promises.writeFile(filePath, content ?? Buffer.alloc(0))
  return filePath
}
