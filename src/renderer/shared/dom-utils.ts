/**
 * src/renderer/shared/dom-utils.ts
 *
 * renderer 共通の DOM ユーティリティ。
 * 各 renderer entry（addressbar / settings / overlay 等）から import して使用する。
 */

/**
 * 必須 DOM 要素を取得する共通ヘルパー。
 * 要素が見つからない場合はセレクタ付きの Error をスローする（J3 承認済み: 正常系不変・異常系のみラベル化）。
 *
 * 使用例:
 *   const panel = getEl<HTMLDivElement>('#settings-panel')
 *   const btn   = getEl<HTMLButtonElement>('#close-btn')
 */
export function getEl<T extends HTMLElement>(selector: string): T {
  const el = document.querySelector<T>(selector)
  if (!el) {
    throw new Error(`[renderer] Required element not found: ${selector}`)
  }
  return el
}
