/**
 * T08 (protocol 部) — src/main/media-protocol.ts
 *
 * media:// カスタムプロトコルのコアロジック。
 * Electron の protocol.handle とは分離しており、実 Electron 非依存で単体テスト可能。
 *
 * 責務:
 *   - URL からファイルパスを抽出・デコード
 *   - 生 URL の `..` セグメント検出（WHATWG 正規化前の防衛チェック）
 *   - path.resolve + fs.realpath によるパス正規化とルート閉じ込め検証
 *   - シンボリックリンク脱出を realpath で検出し 403 Forbidden を返す
 *   - Range ヘッダーを解析し、206 Partial Content をストリームで返す
 *   - 全バッファ読み込み禁止（createReadStream → Readable.toWeb() を使用）
 *   - 不正 Range → 416 Requested Range Not Satisfiable
 *   - パストラバーサル検出 → ERROR ログ {event:"protocol.pathTraversal"} + 403
 *
 * §3.4 / UT-21 / UT-22 に対応。
 */

import * as nodePath from 'node:path'
import { Readable } from 'node:stream'

// ─── インターフェース ──────────────────────────────────────────────────────────

/**
 * fs 操作を抽象化するアダプター。
 * テストではモックを注入し、本番では node:fs を使用する。
 */
export interface FsAdapter {
  /** シンボリックリンクを解決した実パスを返す */
  realpath(p: string): Promise<string>
  /** ファイルのメタデータを返す */
  stat(p: string): Promise<{ size: number }>
  /** ファイルの一部をストリームとして返す */
  createReadStream(p: string, opts?: { start: number; end: number }): NodeJS.ReadableStream
}

/**
 * Electron の Request に相当する最小インターフェース。
 * テストでは手動で構築できるシンプルな形にしている。
 */
export interface ProtocolRequest {
  /** 完全な URL 文字列（例: "media://videos/clip-001.mp4"） */
  url: string
  /** リクエストヘッダー */
  headers: {
    get(name: string): string | null
  }
}

/**
 * コアハンドラが返すレスポンス型。
 * Electron の Response とは独立しており、テストで検証しやすい。
 */
export interface ProtocolResponse {
  status: number
  headers: Record<string, string>
  body: ReadableStream<Uint8Array> | null
}

/**
 * ロガーの最小インターフェース。
 * テストではモックを注入する。
 */
export interface ProtocolLogger {
  error(event: string, meta?: Record<string, unknown>): void
  /** WARN レベルのログ（オプション）。fs 異常の区別等に使用する。 */
  warn?: (event: string, meta?: Record<string, unknown>) => void
}

// ─── 内部型 ───────────────────────────────────────────────────────────────────

interface ParsedRange {
  start: number
  end: number
}

// ─── 定数 ────────────────────────────────────────────────────────────────────

/** "bytes=start-end" または "bytes=start-" の形式のみを受理する */
const RANGE_REGEX = /^bytes=(\d*)-(\d*)$/

/** スキーム://ホスト 以降のパス部分を抽出する正規表現 */
const STRIP_SCHEME_HOST_REGEX = /^[a-z][a-z0-9+\-.]*:\/\/[^/]*(\/.*)?$/i

// ─── ユーティリティ ───────────────────────────────────────────────────────────

/**
 * 生 URL 文字列（WHATWG URL による正規化の前）を検査し、
 * `..` または `.` のパスセグメントを含む場合に true を返す。
 *
 * WHATWG URL パーサーは `../` を自動正規化するため、
 * パーサー適用後は `..` が消えてしまう。防衛的な第一チェックとして
 * 生文字列を先に検査する。
 *
 * @example
 * hasTraversalSegment('media://videos/../../../etc/passwd')  // → true
 * hasTraversalSegment('media://videos/%2e%2e/etc/passwd')    // → true（単一デコード後）
 * hasTraversalSegment('media://videos/clip-001.mp4')         // → false
 */
function hasTraversalSegment(rawUrl: string): boolean {
  const match = STRIP_SCHEME_HOST_REGEX.exec(rawUrl)
  if (!match) return false

  const rawPath = match[1] ?? '/'
  const segments = rawPath.split('/')

  for (const seg of segments) {
    // 単一デコードして確認（二重エンコードは別途 `%` チェックで捕捉）
    let decoded: string
    try {
      decoded = decodeURIComponent(seg)
    } catch {
      // デコード失敗は不正 URL として扱う
      decoded = seg
    }
    if (decoded === '..' || decoded === '.') return true
  }
  return false
}

/**
 * Range ヘッダーを解析して { start, end } を返す。
 *
 * サポートする形式:
 *   - `bytes=start-end` （両端指定）
 *   - `bytes=start-`   （末尾まで）
 *
 * サポートしない形式（→ "invalid" を返す）:
 *   - `bytes=-N` （suffix range: §3.4 で非対応）
 *   - start > end
 *   - start >= fileSize
 *
 * @param rangeHeader - "bytes=start-end" 形式の文字列
 * @param fileSize - ファイルサイズ（バイト）
 * @returns 解析済みレンジ、または "invalid"（416 返却が必要）
 */
function parseRange(
  rangeHeader: string,
  fileSize: number,
): ParsedRange | 'invalid' {
  const match = RANGE_REGEX.exec(rangeHeader)
  if (!match) return 'invalid'

  const startStr = match[1] ?? ''
  const endStr = match[2] ?? ''

  // suffix range (bytes=-N) および開始値なし: §3.4 仕様上非対応 → 416
  if (startStr === '') return 'invalid'

  const start = parseInt(startStr, 10)
  if (isNaN(start) || start < 0) return 'invalid'

  let end: number
  if (endStr === '') {
    // open-ended: bytes=start-
    end = fileSize - 1
  } else {
    end = parseInt(endStr, 10)
    if (isNaN(end) || end < 0) return 'invalid'
  }

  // 論理的検証
  if (start > end) return 'invalid'
  if (start >= fileSize) return 'invalid'
  if (end >= fileSize) {
    // RFC 7233: end が fileSize を超える場合はクランプ
    end = fileSize - 1
  }

  return { start, end }
}

/**
 * Node.js ReadableStream を WHATWG ReadableStream<Uint8Array> に変換する。
 * Node.js 17+ で利用可能な `Readable.toWeb()` を使用する。
 */
function nodeStreamToWeb(nodeStream: NodeJS.ReadableStream): ReadableStream<Uint8Array> {
  return Readable.toWeb(nodeStream as Readable) as ReadableStream<Uint8Array>
}

/**
 * 403 Forbidden レスポンスを生成する。
 */
function forbidden(): ProtocolResponse {
  return {
    status: 403,
    headers: { 'Content-Type': 'text/plain' },
    body: null,
  }
}

/**
 * 416 Requested Range Not Satisfiable レスポンスを生成する。
 */
function rangeNotSatisfiable(fileSize: number): ProtocolResponse {
  return {
    status: 416,
    headers: {
      'Content-Type': 'text/plain',
      'Content-Range': `bytes */${fileSize}`,
    },
    body: null,
  }
}

/**
 * 404 Not Found レスポンスを生成する。
 */
function notFound(): ProtocolResponse {
  return {
    status: 404,
    headers: { 'Content-Type': 'text/plain' },
    body: null,
  }
}

// ─── コアハンドラ ──────────────────────────────────────────────────────────────

/**
 * media:// リクエストを処理するコアハンドラ。
 *
 * セキュリティチェックの順序:
 *   1. 生 URL の `..` セグメント検出（WHATWG 正規化前の防衛的チェック）
 *   2. デコード後パスの `%` 残留チェック（二重エンコード検出）
 *   3. `path.resolve` によるルート外チェック（主要セキュリティチェック）
 *   4. `fs.realpath` によるシンボリックリンク脱出チェック
 *
 * @param request - プロトコルリクエスト
 * @param videoFolderRoot - 許可されるルートディレクトリの絶対パス
 * @param fsOps - ファイルシステム操作（DI）
 * @param logger - ロガー（DI）
 * @returns ProtocolResponse
 */
export async function handleMediaRequest(
  request: ProtocolRequest,
  videoFolderRoot: string,
  fsOps: FsAdapter,
  logger: ProtocolLogger,
): Promise<ProtocolResponse> {
  // ── 0. 生 URL の防衛的チェック（WHATWG 正規化前）────────────────────────────

  if (hasTraversalSegment(request.url)) {
    logger.error('protocol.pathTraversal', {
      event: 'protocol.pathTraversal',
      url: request.url,
      reason: 'traversal sequence in raw URL',
    })
    return forbidden()
  }

  // ── 1. URL からファイルパスを抽出 ──────────────────────────────────────────

  let urlObj: URL
  try {
    urlObj = new URL(request.url)
  } catch {
    return notFound()
  }

  // URL のパス部分を取り出してデコードする
  // 例: "media://videos/clip-001.mp4" → host="videos", pathname="/clip-001.mp4"
  const rawPathname = urlObj.pathname

  let decodedPathname: string
  try {
    decodedPathname = decodeURIComponent(rawPathname)
  } catch {
    // 不正な URL エンコーディング
    return notFound()
  }

  // 二重デコードによる攻撃を防ぐため、デコード後に % + 2桁16進数が残っていれば不正
  // （例: %252e → %2e → %XX 形式が残っている → 二重エンコード）
  // リテラルの % はファイル名に使用可能（例: 50%.mp4 → %25 エンコードを経てデコード後は %）
  // そのため % 単体は許容し、%XX（2桁16進数が続く）形式のみ拒否する
  if (/%[0-9a-fA-F]{2}/.test(decodedPathname)) {
    logger.error('protocol.pathTraversal', {
      event: 'protocol.pathTraversal',
      url: request.url,
      reason: 'double-encoded path',
    })
    return forbidden()
  }

  // ── 2. パス正規化とルート閉じ込め（第一チェック: resolve ベース）──────────

  const normalizedRoot = nodePath.normalize(videoFolderRoot)

  // パス先頭の "/" を除いて videoFolderRoot 配下のパスとして解釈する
  const relativePart = decodedPathname.startsWith('/')
    ? decodedPathname.slice(1)
    : decodedPathname

  // path.resolve で絶対パスに変換（./ や ../ を解決）
  const resolvedPath = nodePath.resolve(normalizedRoot, relativePart)

  // resolve 後のパスが videoFolderRoot 配下に収まっているか確認
  const rootWithSep = normalizedRoot.endsWith(nodePath.sep)
    ? normalizedRoot
    : normalizedRoot + nodePath.sep

  if (resolvedPath !== normalizedRoot && !resolvedPath.startsWith(rootWithSep)) {
    logger.error('protocol.pathTraversal', {
      event: 'protocol.pathTraversal',
      url: request.url,
      resolvedPath,
      videoFolderRoot: normalizedRoot,
    })
    return forbidden()
  }

  // ── 3. ファイルの存在確認と stat ──────────────────────────────────────────

  let fileSize: number
  try {
    const statResult = await fsOps.stat(resolvedPath)
    fileSize = statResult.size
  } catch (e) {
    // ENOENT（ファイル欠落）と権限/IO異常（EACCES 等）を区別してログ出力する
    const code = e instanceof Error ? (e as NodeJS.ErrnoException).code : undefined
    if (code !== 'ENOENT') {
      logger.warn?.('protocol.fsError', {
        event: 'protocol.fsError',
        url: request.url,
        resolvedPath,
        code: code ?? 'UNKNOWN',
        reason: e instanceof Error ? e.message : String(e),
      })
    }
    return notFound()
  }

  // 0 バイトファイルは Range なし時に不正な Content-Range ヘッダ (bytes 0--1/0) を生成するため
  // 早期に 404 で返す。実際の動画ファイルが 0 バイトになることはない（書き込み中断等）。
  if (fileSize === 0) {
    return notFound()
  }

  // ── 4. シンボリックリンク脱出チェック（第二チェック: realpath ベース）──────

  let realResolved: string
  try {
    realResolved = await fsOps.realpath(resolvedPath)
  } catch {
    return notFound()
  }

  // videoFolderRoot 自身も realpath で解決する
  let realRoot: string
  try {
    realRoot = await fsOps.realpath(normalizedRoot)
  } catch {
    return notFound()
  }

  const realRootWithSep = realRoot.endsWith(nodePath.sep)
    ? realRoot
    : realRoot + nodePath.sep

  if (realResolved !== realRoot && !realResolved.startsWith(realRootWithSep)) {
    logger.error('protocol.pathTraversal', {
      event: 'protocol.pathTraversal',
      url: request.url,
      realResolved,
      realRoot,
      reason: 'symlink escape',
    })
    return forbidden()
  }

  // ── 5. Range ヘッダー解析 ───────────────────────────────────────────────────

  const rangeHeader = request.headers.get('range') ?? request.headers.get('Range')
  const hasRange = rangeHeader !== null && rangeHeader !== ''

  let rangeStart: number
  let rangeEnd: number

  if (!hasRange) {
    // Range ヘッダーなし → 200 OK でファイル全体を返す（HTTP 正規動作）
    // 注意: Range なしで 206 を返すのは HTTP 仕様違反。Chromium の demuxer が
    // 要求していない 206 を受け取ると SRC_NOT_SUPPORTED (code 4) を返す。
    rangeStart = 0
    rangeEnd = fileSize - 1
  } else {
    const parsed = parseRange(rangeHeader, fileSize)
    if (parsed === 'invalid') {
      // §8 準拠: 不正 Range を構造化ログに記録する
      logger.error('protocol.invalidRange', {
        event: 'protocol.invalidRange',
        url: request.url,
        rangeHeader,
        fileSize,
      })
      return rangeNotSatisfiable(fileSize)
    }
    rangeStart = parsed.start
    rangeEnd = parsed.end
  }

  // ── 6. レスポンスストリームの生成 ──────────────────────────────────────────

  const chunkSize = rangeEnd - rangeStart + 1

  const nodeStream = fsOps.createReadStream(realResolved, {
    start: rangeStart,
    end: rangeEnd,
  })

  const webStream = nodeStreamToWeb(nodeStream)

  if (!hasRange) {
    // 200 OK: Content-Range ヘッダーは含めない（HTTP 仕様準拠）
    return {
      status: 200,
      headers: {
        'Content-Type': 'video/mp4',
        'Content-Length': String(fileSize),
        'Accept-Ranges': 'bytes',
      },
      body: webStream,
    }
  }

  // 206 Partial Content: Range ヘッダーあり
  return {
    status: 206,
    headers: {
      'Content-Type': 'video/mp4',
      'Content-Length': String(chunkSize),
      'Content-Range': `bytes ${rangeStart}-${rangeEnd}/${fileSize}`,
      'Accept-Ranges': 'bytes',
    },
    body: webStream,
  }
}

// ─── ファイルパス → media:// URI 変換ユーティリティ ──────────────────────────

/**
 * 絶対ファイルパスを media:// URI に変換する。
 *
 * handleMediaRequest はパス部分（videoFolderRoot 配下の相対パス）のみを使用し、
 * ホスト部分（"videos"）は固定ラベルとして扱う。
 * encodeURIComponent によりスペース・日本語・Unicode ファイル名を安全にエンコードし、
 * ハンドラ側で一度 decodeURIComponent して解決する。
 *
 * @param filePath - 絶対ファイルパス（例: "/home/u/videos/testriver.mp4"）
 * @returns media:// URI（例: "media://videos/testriver.mp4"）
 */
export function toMediaUri(filePath: string): string {
  const base = nodePath.basename(filePath)
  return 'media://videos/' + encodeURIComponent(base)
}

// ─── Electron protocol.handle アダプター ──────────────────────────────────────

/**
 * Electron の protocol.handle 向けアダプター。
 * コアロジック（handleMediaRequest）を Electron の Request/Response に接続する。
 *
 * 使用例:
 * ```ts
 * import { protocol } from 'electron'
 * import * as fs from 'node:fs'
 * import { createElectronProtocolHandler } from './media-protocol'
 *
 * const handler = createElectronProtocolHandler(
 *   config.videoFolderPath,
 *   { realpath: fs.promises.realpath, stat: fs.promises.stat, createReadStream: fs.createReadStream },
 *   logger
 * )
 * protocol.handle('media', handler)
 * ```
 */
export function createElectronProtocolHandler(
  videoFolderRoot: string,
  fsOps: FsAdapter,
  logger: ProtocolLogger,
): (request: Request) => Promise<Response> {
  return async (electronRequest: Request): Promise<Response> => {
    const req: ProtocolRequest = {
      url: electronRequest.url,
      headers: {
        get: (name: string) => electronRequest.headers.get(name),
      },
    }

    const res = await handleMediaRequest(req, videoFolderRoot, fsOps, logger)

    return new Response(res.body, {
      status: res.status,
      headers: res.headers,
    })
  }
}
