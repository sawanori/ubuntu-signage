/**
 * T08 (protocol 部) — test/unit/media-protocol.test.ts
 *
 * §3.4 / UT-21 / UT-22 に対応するユニットテスト（Red → Green）
 *
 * テスト対象: src/main/media-protocol.ts
 * 実行環境: Node (jsdom 不要)。Electron 非依存のコアロジックのみ。
 *
 * カバレッジ:
 *   UT-21: パストラバーサル拒否（../、シンボリックリンク脱出、ルート外）→ 403
 *   UT-22: 不正 Range ヘッダー → 416
 *   正常系: 206 Partial Content / Range なし全体 / Range 境界値
 */

import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
  type MockInstance,
} from 'vitest'
import * as os from 'node:os'
import * as fs from 'node:fs'
import * as path from 'node:path'

// ─── テスト対象 ────────────────────────────────────────────────────────────────

import {
  handleMediaRequest,
  toMediaUri,
  type FsAdapter,
  type ProtocolRequest,
  type ProtocolLogger,
} from '../../src/main/media-protocol'

// ─── ヘルパー ──────────────────────────────────────────────────────────────────

/** テスト用の一時ディレクトリを作成し、後片付け関数とともに返す */
function createTempDir(): { dir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'media-proto-test-'))
  return {
    dir,
    cleanup: () => {
      fs.rmSync(dir, { recursive: true, force: true })
    },
  }
}

/** テスト用のバイナリコンテンツを持つファイルを作成する */
function createTestFile(filePath: string, content: Buffer): void {
  fs.writeFileSync(filePath, content)
}

/**
 * 実 Node.js fs を使った FsAdapter を生成する。
 * シンボリックリンクのテストでは realpath が実パスを返すため、
 * symlink 先がルート外なら脱出として検出される。
 */
function makeRealFsAdapter(): FsAdapter {
  return {
    async realpath(p: string): Promise<string> {
      return fs.promises.realpath(p)
    },
    async stat(p: string): Promise<{ size: number }> {
      const s = await fs.promises.stat(p)
      return { size: s.size }
    },
    createReadStream(
      p: string,
      opts?: { start: number; end: number },
    ): NodeJS.ReadableStream {
      return fs.createReadStream(p, opts)
    },
  }
}

/** ProtocolLogger モック（warn を含む） */
function makeMockLogger(): ProtocolLogger & {
  error: MockInstance
  warn: MockInstance
} {
  return { error: vi.fn(), warn: vi.fn() }
}

/** media:// URL を組み立てる */
function makeMediaUrl(relPath: string): string {
  // relPath: "clip-001.mp4" → "media://videos/clip-001.mp4"
  // relPath can also be an arbitrary string for traversal tests
  return `media://videos/${relPath}`
}

/**
 * ProtocolRequest を組み立てる。
 * @param url    リクエスト URL
 * @param range  Range ヘッダー値（省略時は Range なし）
 */
function makeReq(url: string, range?: string): ProtocolRequest {
  return {
    url,
    headers: {
      get: (name: string) => (name === 'range' ? (range ?? null) : null),
    },
  }
}

/**
 * ストリームを読み込んで Buffer に変換する。
 * テスト内で応答ボディを検証するための補助関数。
 */
async function readStream(stream: ReadableStream<Uint8Array>): Promise<Buffer> {
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (value) chunks.push(value)
  }
  return Buffer.concat(chunks)
}

// ─── テスト本体 ───────────────────────────────────────────────────────────────

describe('handleMediaRequest', () => {
  let tempDir: { dir: string; cleanup: () => void }
  let videoFolder: string
  let fsAdapter: FsAdapter
  let logger: ReturnType<typeof makeMockLogger>

  beforeEach(() => {
    tempDir = createTempDir()
    videoFolder = tempDir.dir
    fsAdapter = makeRealFsAdapter()
    logger = makeMockLogger()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    tempDir.cleanup()
  })

  // ─────────────────────────────────────────────────────────────────────────
  // UT-21: パストラバーサル拒否
  // ─────────────────────────────────────────────────────────────────────────

  describe('UT-21: パストラバーサル攻撃を 403 で拒否する', () => {
    it('../ を含むパスはルート外に出るため 403 を返す', async () => {
      // media://videos/../../../etc/passwd のような URL
      const req = makeReq('media://videos/../../../etc/passwd')
      const res = await handleMediaRequest(req, videoFolder, fsAdapter, logger)
      expect(res.status).toBe(403)
    })

    it('パストラバーサル時に ERROR ログ event "protocol.pathTraversal" を出力する', async () => {
      const req = makeReq('media://videos/../../../etc/passwd')
      await handleMediaRequest(req, videoFolder, fsAdapter, logger)
      expect(logger.error).toHaveBeenCalled()
      const calls = vi.mocked(logger.error).mock.calls
      const traversalCall = calls.find(([, meta]) => {
        const m = meta as Record<string, unknown> | undefined
        return m?.['event'] === 'protocol.pathTraversal'
      })
      expect(traversalCall).toBeDefined()
    })

    it('URL エンコードされた ../ (パーセントエンコーディング) も 403 を返す', async () => {
      // %2e%2e%2f = ../
      const req = makeReq('media://videos/%2e%2e%2fetc%2fpasswd')
      const res = await handleMediaRequest(req, videoFolder, fsAdapter, logger)
      expect(res.status).toBe(403)
    })

    it('二重エンコードされた ../ (%252e%252e/) も 403 を返す', async () => {
      const req = makeReq('media://videos/%252e%252e%2fclip.mp4')
      const res = await handleMediaRequest(req, videoFolder, fsAdapter, logger)
      expect(res.status).toBe(403)
    })

    it('ルート外への絶対パス参照も 403 を返す', async () => {
      // videoFolder が /tmp/xxx の場合、/etc/passwd は外部
      const req = makeReq('media://videos//etc/passwd')
      const res = await handleMediaRequest(req, videoFolder, fsAdapter, logger)
      expect(res.status).toBe(403)
    })

    it('ファイルが存在しない場合も 403 または 404 を返す（クラッシュしない）', async () => {
      const req = makeReq(makeMediaUrl('nonexistent.mp4'))
      const res = await handleMediaRequest(req, videoFolder, fsAdapter, logger)
      expect(res.status).toBeGreaterThanOrEqual(400)
      expect(res.status).toBeLessThan(500)
    })
  })

  describe('UT-21: シンボリックリンク脱出を 403 で拒否する', () => {
    it('シンボリックリンクが videoFolder 外を指す場合は 403 を返す', async () => {
      // tmpDir/outside-dir/secret.txt を作成
      const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'outside-'))
      const secretFile = path.join(outsideDir, 'secret.txt')
      fs.writeFileSync(secretFile, 'secret content')

      // videoFolder 内に外部ファイルへのシンボリックリンクを作成
      const symlinkPath = path.join(videoFolder, 'evil.mp4')
      fs.symlinkSync(secretFile, symlinkPath)

      try {
        const req = makeReq(makeMediaUrl('evil.mp4'))
        const res = await handleMediaRequest(req, videoFolder, fsAdapter, logger)
        expect(res.status).toBe(403)
      } finally {
        fs.rmSync(outsideDir, { recursive: true, force: true })
      }
    })

    it('シンボリックリンク脱出時に ERROR ログ event "protocol.pathTraversal" を出力する', async () => {
      const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'outside-'))
      const secretFile = path.join(outsideDir, 'secret.txt')
      fs.writeFileSync(secretFile, 'secret content')

      const symlinkPath = path.join(videoFolder, 'evil.mp4')
      fs.symlinkSync(secretFile, symlinkPath)

      try {
        const req = makeReq(makeMediaUrl('evil.mp4'))
        await handleMediaRequest(req, videoFolder, fsAdapter, logger)
        const calls = vi.mocked(logger.error).mock.calls
        const traversalCall = calls.find(([, meta]) => {
          const m = meta as Record<string, unknown> | undefined
          return m?.['event'] === 'protocol.pathTraversal'
        })
        expect(traversalCall).toBeDefined()
      } finally {
        fs.rmSync(outsideDir, { recursive: true, force: true })
      }
    })

    it('シンボリックリンクが videoFolder 内を指す場合は正常に応答する', async () => {
      // videoFolder 内のファイルへのシンボリックリンク → OK
      const content = Buffer.alloc(100, 0x42)
      const realFile = path.join(videoFolder, 'real.mp4')
      fs.writeFileSync(realFile, content)

      const linkFile = path.join(videoFolder, 'link.mp4')
      fs.symlinkSync(realFile, linkFile)

      const req = makeReq(makeMediaUrl('link.mp4'), 'bytes=0-9')
      const res = await handleMediaRequest(req, videoFolder, fsAdapter, logger)
      expect(res.status).toBe(206)
    })
  })

  // ─────────────────────────────────────────────────────────────────────────
  // 正常系: 206 Partial Content
  // ─────────────────────────────────────────────────────────────────────────

  describe('正常系: 206 Partial Content を返す', () => {
    let testFile: string
    let testContent: Buffer

    beforeEach(() => {
      // 100 バイトのテストファイルを作成
      testContent = Buffer.from(
        Array.from({ length: 100 }, (_, i) => i % 256),
      )
      testFile = path.join(videoFolder, 'clip-001.mp4')
      createTestFile(testFile, testContent)
    })

    it('Range: bytes=0-9 で 206 を返す', async () => {
      const req = makeReq(makeMediaUrl('clip-001.mp4'), 'bytes=0-9')
      const res = await handleMediaRequest(req, videoFolder, fsAdapter, logger)
      expect(res.status).toBe(206)
    })

    it('Range: bytes=0-9 で Content-Range ヘッダーが正しい', async () => {
      const req = makeReq(makeMediaUrl('clip-001.mp4'), 'bytes=0-9')
      const res = await handleMediaRequest(req, videoFolder, fsAdapter, logger)
      expect(res.headers['Content-Range']).toBe('bytes 0-9/100')
    })

    it('Range: bytes=0-9 で Content-Length が 10', async () => {
      const req = makeReq(makeMediaUrl('clip-001.mp4'), 'bytes=0-9')
      const res = await handleMediaRequest(req, videoFolder, fsAdapter, logger)
      expect(res.headers['Content-Length']).toBe('10')
    })

    it('Range: bytes=0-9 でボディが最初の 10 バイト', async () => {
      const req = makeReq(makeMediaUrl('clip-001.mp4'), 'bytes=0-9')
      const res = await handleMediaRequest(req, videoFolder, fsAdapter, logger)
      expect(res.body).not.toBeNull()
      const body = await readStream(res.body!)
      expect(body).toEqual(testContent.subarray(0, 10))
    })

    it('Range: bytes=50-99 で末尾のデータを返す', async () => {
      const req = makeReq(makeMediaUrl('clip-001.mp4'), 'bytes=50-99')
      const res = await handleMediaRequest(req, videoFolder, fsAdapter, logger)
      expect(res.status).toBe(206)
      expect(res.headers['Content-Range']).toBe('bytes 50-99/100')
      expect(res.headers['Content-Length']).toBe('50')
      const body = await readStream(res.body!)
      expect(body).toEqual(testContent.subarray(50, 100))
    })

    it('Range なし（ヘッダーなし）で 200 OK を返す', async () => {
      const req = makeReq(makeMediaUrl('clip-001.mp4'))
      const res = await handleMediaRequest(req, videoFolder, fsAdapter, logger)
      expect(res.status).toBe(200)
    })

    it('Range なしのとき Content-Range ヘッダーを含まず Content-Length がファイルサイズになる', async () => {
      const req = makeReq(makeMediaUrl('clip-001.mp4'))
      const res = await handleMediaRequest(req, videoFolder, fsAdapter, logger)
      expect(res.headers['Content-Range']).toBeUndefined()
      expect(res.headers['Content-Length']).toBe('100')
    })

    it('応答 Content-Type は video/mp4 を含む', async () => {
      const req = makeReq(makeMediaUrl('clip-001.mp4'), 'bytes=0-9')
      const res = await handleMediaRequest(req, videoFolder, fsAdapter, logger)
      expect(res.headers['Content-Type']).toContain('video/mp4')
    })

    it('Accept-Ranges: bytes ヘッダーが付く', async () => {
      const req = makeReq(makeMediaUrl('clip-001.mp4'), 'bytes=0-9')
      const res = await handleMediaRequest(req, videoFolder, fsAdapter, logger)
      expect(res.headers['Accept-Ranges']).toBe('bytes')
    })

    it('ボディはストリーム（ReadableStream）であり Buffer でない', async () => {
      const req = makeReq(makeMediaUrl('clip-001.mp4'), 'bytes=0-9')
      const res = await handleMediaRequest(req, videoFolder, fsAdapter, logger)
      // Buffer や null ではなく ReadableStream を返す
      expect(res.body).not.toBeNull()
      expect(res.body).not.toBeInstanceOf(Buffer)
      expect(typeof (res.body as ReadableStream<Uint8Array>).getReader).toBe('function')
    })

    it('URL にスペースを含むファイル名（%20 エンコード）でも正常に処理される', async () => {
      const spacedFile = path.join(videoFolder, 'clip 002.mp4')
      createTestFile(spacedFile, Buffer.alloc(50, 0xff))
      const req = makeReq('media://videos/clip%20002.mp4', 'bytes=0-9')
      const res = await handleMediaRequest(req, videoFolder, fsAdapter, logger)
      expect(res.status).toBe(206)
    })
  })

  // ─────────────────────────────────────────────────────────────────────────
  // 200/206 分岐テスト（HTTP 仕様準拠確認）
  // ─────────────────────────────────────────────────────────────────────────

  describe('200/206 分岐: Range なし → 200 OK、Range あり → 206 Partial Content', () => {
    let testFile: string
    let testContent: Buffer
    const FILE_SIZE = 100

    beforeEach(() => {
      testContent = Buffer.from(Array.from({ length: FILE_SIZE }, (_, i) => i % 256))
      testFile = path.join(videoFolder, 'split-test.mp4')
      createTestFile(testFile, testContent)
    })

    it('Range ヘッダーなし → status 200 OK、Content-Length=fileSize、Accept-Ranges=bytes、Content-Range なし', async () => {
      const req = makeReq(makeMediaUrl('split-test.mp4'))
      const res = await handleMediaRequest(req, videoFolder, fsAdapter, logger)
      expect(res.status).toBe(200)
      expect(res.headers['Content-Length']).toBe(String(FILE_SIZE))
      expect(res.headers['Accept-Ranges']).toBe('bytes')
      expect(res.headers['Content-Range']).toBeUndefined()
    })

    it('Range: bytes=0- → status 206、Content-Range "bytes 0-(fileSize-1)/fileSize"', async () => {
      const req = makeReq(makeMediaUrl('split-test.mp4'), 'bytes=0-')
      const res = await handleMediaRequest(req, videoFolder, fsAdapter, logger)
      expect(res.status).toBe(206)
      expect(res.headers['Content-Range']).toBe(`bytes 0-${FILE_SIZE - 1}/${FILE_SIZE}`)
    })

    it('Range: bytes=10-20 → status 206、Content-Range "bytes 10-20/fileSize"、Content-Length "11"', async () => {
      const req = makeReq(makeMediaUrl('split-test.mp4'), 'bytes=10-20')
      const res = await handleMediaRequest(req, videoFolder, fsAdapter, logger)
      expect(res.status).toBe(206)
      expect(res.headers['Content-Range']).toBe(`bytes 10-20/${FILE_SIZE}`)
      expect(res.headers['Content-Length']).toBe('11')
    })
  })

  // ─────────────────────────────────────────────────────────────────────────
  // UT-22: 不正 Range ヘッダー → 416
  // ─────────────────────────────────────────────────────────────────────────

  describe('UT-22: 不正 Range ヘッダーを 416 で拒否する', () => {
    let testFile: string

    beforeEach(() => {
      testFile = path.join(videoFolder, 'clip-001.mp4')
      createTestFile(testFile, Buffer.alloc(100, 0x00))
    })

    it('Range: bytes=-1 → 416 を返す', async () => {
      const req = makeReq(makeMediaUrl('clip-001.mp4'), 'bytes=-1')
      const res = await handleMediaRequest(req, videoFolder, fsAdapter, logger)
      expect(res.status).toBe(416)
    })

    it('Range: bytes=100-200（ファイルサイズ超過: start >= fileSize) → 416 を返す', async () => {
      // ファイルは 100 バイト (0-99)。bytes=100-200 は範囲外
      const req = makeReq(makeMediaUrl('clip-001.mp4'), 'bytes=100-200')
      const res = await handleMediaRequest(req, videoFolder, fsAdapter, logger)
      expect(res.status).toBe(416)
    })

    it('Range: bytes=50-20（start > end）→ 416 を返す', async () => {
      const req = makeReq(makeMediaUrl('clip-001.mp4'), 'bytes=50-20')
      const res = await handleMediaRequest(req, videoFolder, fsAdapter, logger)
      expect(res.status).toBe(416)
    })

    it('Range: bytes=abc-def（非数値）→ 416 を返す', async () => {
      const req = makeReq(makeMediaUrl('clip-001.mp4'), 'bytes=abc-def')
      const res = await handleMediaRequest(req, videoFolder, fsAdapter, logger)
      expect(res.status).toBe(416)
    })

    it('Range: invalid-format → 416 を返す', async () => {
      const req = makeReq(makeMediaUrl('clip-001.mp4'), 'invalid-format-range')
      const res = await handleMediaRequest(req, videoFolder, fsAdapter, logger)
      expect(res.status).toBe(416)
    })

    it('416 応答に Content-Range: bytes */fileSize ヘッダーを含む', async () => {
      const req = makeReq(makeMediaUrl('clip-001.mp4'), 'bytes=-1')
      const res = await handleMediaRequest(req, videoFolder, fsAdapter, logger)
      expect(res.status).toBe(416)
      expect(res.headers['Content-Range']).toBe('bytes */100')
    })

    // ── (B) 416 返却前の構造化ログ ───────────────────────────────────────────

    it('不正 Range 時に ERROR ログ "protocol.invalidRange" を出力する', async () => {
      const req = makeReq(makeMediaUrl('clip-001.mp4'), 'bytes=-1')
      await handleMediaRequest(req, videoFolder, fsAdapter, logger)
      expect(logger.error).toHaveBeenCalledWith(
        'protocol.invalidRange',
        expect.objectContaining({ event: 'protocol.invalidRange' })
      )
    })

    it('start > end の不正 Range でも "protocol.invalidRange" ログを出力する', async () => {
      const req = makeReq(makeMediaUrl('clip-001.mp4'), 'bytes=50-20')
      await handleMediaRequest(req, videoFolder, fsAdapter, logger)
      expect(logger.error).toHaveBeenCalledWith(
        'protocol.invalidRange',
        expect.objectContaining({ event: 'protocol.invalidRange', fileSize: 100 })
      )
    })
  })

  // ─────────────────────────────────────────────────────────────────────────
  // Range 境界値テスト
  // ─────────────────────────────────────────────────────────────────────────

  describe('Range 境界値テスト', () => {
    let testFile: string
    let testContent: Buffer

    beforeEach(() => {
      // 256 バイトのテストファイル
      testContent = Buffer.from(Array.from({ length: 256 }, (_, i) => i))
      testFile = path.join(videoFolder, 'clip-001.mp4')
      createTestFile(testFile, testContent)
    })

    it('Range: bytes=0-0（先頭 1 バイトのみ）で 206 を返す', async () => {
      const req = makeReq(makeMediaUrl('clip-001.mp4'), 'bytes=0-0')
      const res = await handleMediaRequest(req, videoFolder, fsAdapter, logger)
      expect(res.status).toBe(206)
      expect(res.headers['Content-Range']).toBe('bytes 0-0/256')
      expect(res.headers['Content-Length']).toBe('1')
      const body = await readStream(res.body!)
      expect(body[0]).toBe(0)
    })

    it('Range: bytes=255-255（末尾 1 バイトのみ）で 206 を返す', async () => {
      const req = makeReq(makeMediaUrl('clip-001.mp4'), 'bytes=255-255')
      const res = await handleMediaRequest(req, videoFolder, fsAdapter, logger)
      expect(res.status).toBe(206)
      expect(res.headers['Content-Range']).toBe('bytes 255-255/256')
      const body = await readStream(res.body!)
      expect(body[0]).toBe(255)
    })

    it('Range: bytes=256-256（ファイルサイズ = 256、インデックス 256 は範囲外）→ 416', async () => {
      const req = makeReq(makeMediaUrl('clip-001.mp4'), 'bytes=256-256')
      const res = await handleMediaRequest(req, videoFolder, fsAdapter, logger)
      expect(res.status).toBe(416)
    })

    it('Range: bytes=0- でファイル全体を取得できる', async () => {
      const req = makeReq(makeMediaUrl('clip-001.mp4'), 'bytes=0-')
      const res = await handleMediaRequest(req, videoFolder, fsAdapter, logger)
      expect(res.status).toBe(206)
      expect(res.headers['Content-Range']).toBe('bytes 0-255/256')
      expect(res.headers['Content-Length']).toBe('256')
      const body = await readStream(res.body!)
      expect(body).toEqual(testContent)
    })

    it('Range: bytes=128- で後半のデータを取得できる', async () => {
      const req = makeReq(makeMediaUrl('clip-001.mp4'), 'bytes=128-')
      const res = await handleMediaRequest(req, videoFolder, fsAdapter, logger)
      expect(res.status).toBe(206)
      expect(res.headers['Content-Range']).toBe('bytes 128-255/256')
      expect(res.headers['Content-Length']).toBe('128')
      const body = await readStream(res.body!)
      expect(body).toEqual(testContent.subarray(128))
    })
  })

  // ─────────────────────────────────────────────────────────────────────────
  // (E) 軽微修正: 0 バイトファイル / ENOENT区別 / % 精緻化
  // ─────────────────────────────────────────────────────────────────────────

  describe('(E) 0 バイトファイルは 404 を返す', () => {
    it('0 バイトのファイルに対して 404 を返す', async () => {
      const zeroFile = path.join(videoFolder, 'empty.mp4')
      fs.writeFileSync(zeroFile, Buffer.alloc(0))
      const req = makeReq(makeMediaUrl('empty.mp4'))
      const res = await handleMediaRequest(req, videoFolder, fsAdapter, logger)
      expect(res.status).toBe(404)
    })
  })

  describe('(E) 非 ENOENT の fs 異常は WARN ログを出す', () => {
    it('EACCES エラー時に warn ログ "protocol.fsError" を出し 404 を返す', async () => {
      const errorFs: FsAdapter = {
        async realpath(p) { return p },
        async stat(_p) {
          const e = Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' })
          throw e
        },
        createReadStream(p, opts) { return fs.createReadStream(p, opts) },
      }
      const req = makeReq(makeMediaUrl('secret.mp4'))
      const res = await handleMediaRequest(req, videoFolder, errorFs, logger)
      expect(res.status).toBe(404)
      expect(logger.warn).toHaveBeenCalledWith(
        'protocol.fsError',
        expect.objectContaining({ event: 'protocol.fsError', code: 'EACCES' })
      )
    })

    it('ENOENT エラー時は warn ログなしで 404 を返す', async () => {
      const req = makeReq(makeMediaUrl('nonexistent.mp4'))
      const res = await handleMediaRequest(req, videoFolder, fsAdapter, logger)
      expect(res.status).toBe(404)
      expect(logger.warn).not.toHaveBeenCalled()
    })
  })

  describe('(E) % 二重エンコード判定の精緻化', () => {
    it('リテラル % を含むファイル名 (50%25.mp4) は正常に配信される', async () => {
      // ファイル名: "50%.mp4"（URLエンコードで %25 → %）
      const percentFile = path.join(videoFolder, '50%.mp4')
      fs.writeFileSync(percentFile, Buffer.alloc(50, 0xAA))
      const req = makeReq('media://videos/50%25.mp4', 'bytes=0-9')
      const res = await handleMediaRequest(req, videoFolder, fsAdapter, logger)
      expect(res.status).toBe(206)
    })

    it('%2e%2e 系の二重エンコード URL は 403 で拒否される（既存動作維持）', async () => {
      const req = makeReq('media://videos/%252e%252e%2fclip.mp4')
      const res = await handleMediaRequest(req, videoFolder, fsAdapter, logger)
      expect(res.status).toBe(403)
    })
  })
})

// ─── toMediaUri テスト ────────────────────────────────────────────────────────

describe('toMediaUri', () => {
  it('通常のファイルパスを media:// URI に変換する', () => {
    expect(toMediaUri('/home/u/videos/testriver.mp4')).toBe(
      'media://videos/testriver.mp4',
    )
  })

  it('スペースを含むファイル名は %20 にエンコードされる', () => {
    expect(toMediaUri('/v/My Ad.mp4')).toBe('media://videos/My%20Ad.mp4')
  })

  it('日本語ファイル名は encodeURIComponent でエンコードされる', () => {
    expect(toMediaUri('/v/広告.mp4')).toBe(
      'media://videos/' + encodeURIComponent('広告.mp4'),
    )
  })

  it('ラウンドトリップ: toMediaUri で生成した URI が handleMediaRequest でルート外エラーなしに解決される', async () => {
    // 一時ディレクトリをビデオフォルダとして使用
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'toMediaUri-rt-'))
    const fileName = 'roundtrip.mp4'
    const filePath = path.join(tmpDir, fileName)
    fs.writeFileSync(filePath, Buffer.alloc(64, 0x01))

    const mockFsOps = makeRealFsAdapter()
    const mockLogger: ProtocolLogger = { error: vi.fn(), warn: vi.fn() }

    const uri = toMediaUri(filePath)
    const req = makeReq(uri)

    const res = await handleMediaRequest(req, tmpDir, mockFsOps, mockLogger)

    // forbidden(403) または notFound(404) が path 起因で返っていないことを確認
    // Range なし → 200 OK の正常なレスポンスであること
    expect(res.status).toBe(200)
    expect(mockLogger.error).not.toHaveBeenCalled()

    fs.rmSync(tmpDir, { recursive: true, force: true })
  })
})
