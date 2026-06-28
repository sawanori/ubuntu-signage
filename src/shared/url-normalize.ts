/**
 * src/shared/url-normalize.ts — URL 正規化ユーティリティ (FIX SET CHANGE 1)
 *
 * 信頼境界注: この関数はスキームを補完する「利便性変換」のみ担う。
 * 正規化後の値は引き続き ConfigUpdateSchema (zod) による検証を通るため、
 * 不正な値はここを通っても schema 層で拒否される。
 *
 * 依存関係なし（Node.js 環境・Electron なし）のため単体テスト可能。
 */

/**
 * ユーザー入力の URL 文字列を正規化し、スキームを補完して返す。
 *
 * 処理規則:
 * 1. 前後の空白を除去する
 * 2. 空文字（空白のみも含む）→ '' を返す（スタート画面 = 未設定）
 * 3. 既に http:// / https:// で始まる → そのまま返す
 * 4. 他スキーム（`://` を含む ftp:// 等）→ そのまま返す（schema 側で拒否）
 * 5. 危険スキーム（javascript: data: 等、`://` なし）→ そのまま返す（schema 側で拒否）
 * 6. スキームなし → ホスト部分を解析してローカル/プライベートなら http://、それ以外は https:// を付与
 *
 * @param raw ユーザーが入力した生 URL 文字列
 * @returns 正規化後の URL 文字列（スキームを補完済み）
 */
export function normalizeUrlInput(raw: string): string {
  const s = raw.trim()

  // ステップ2: 空文字 → スタート画面（未設定）
  if (s === '') return ''

  // ステップ3: 既に http(s):// → そのまま返す
  if (/^https?:\/\//i.test(s)) return s

  // ステップ4: 他スキーム（`://` を含む、ftp:// 等）→ そのまま（schema 側で拒否させる）
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) return s

  // ステップ5: 危険スキーム（`://` なし、javascript: data: 等）→ そのまま（schema 側で拒否させる）
  if (/^(javascript|data|vbscript|file|blob|about|mailto|tel):/i.test(s)) return s

  // ステップ6: スキームなし → ホスト部分を解析してスキームを補完する
  // 注意: "localhost:8080" や "192.168.1.5:3000" のような host:port 形式は
  // ここに到達する（ステップ3〜5 のいずれにもマッチしないため）
  // パス・クエリ・フラグメント・ポートを除いたホスト名を抽出する
  const hostAndPortPart =
    ((s.split('/')[0] ?? '').split('?')[0] ?? '').split('#')[0] ?? ''

  let hostRaw: string
  if (hostAndPortPart.startsWith('[')) {
    // IPv6 括弧記法: "[::1]:8080" → "::1"
    hostRaw = (hostAndPortPart.match(/^\[([^\]]+)\]/) ?? [])[1] ?? ''
  } else if ((hostAndPortPart.match(/:/g) ?? []).length > 1) {
    // ベア IPv6（括弧なし複数コロン）: "::1" → "::1"（ゾーン ID を除く）
    hostRaw = hostAndPortPart.split('%')[0] ?? hostAndPortPart
  } else {
    // 通常の hostname:port 形式: "localhost:8080" → "localhost"
    hostRaw = hostAndPortPart.split(':')[0] ?? ''
  }

  const host = hostRaw.toLowerCase()

  return isLocalOrPrivate(host) ? 'http://' + s : 'https://' + s
}

/**
 * ホスト名がローカルまたはプライベートネットワークに属するかどうかを判定する。
 * スキーム補完の際に http:// か https:// のどちらを使うかを決定するために使用する。
 *
 * @param host 小文字化済みのホスト名（ポート番号なし）
 * @returns ローカル/プライベートなら true、それ以外なら false
 */
function isLocalOrPrivate(host: string): boolean {
  // 既知のローカルホスト
  if (
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host === '::1' ||
    host === '0.0.0.0'
  ) {
    return true
  }

  // .local / .localhost サフィックス（mDNS / Bonjour デバイス等）
  if (host.endsWith('.local') || host.endsWith('.localhost')) {
    return true
  }

  // プライベート IPv4 レンジ (RFC 1918)
  if (/^10\./.test(host)) return true
  if (/^192\.168\./.test(host)) return true
  if (/^172\.(1[6-9]|2[0-9]|3[01])\./.test(host)) return true

  return false
}
