/**
 * before-input-quit.ts — Wayland 環境での Ctrl+Q 終了ハンドラファクトリ
 *
 * globalShortcut は Wayland セッションでは機能しないため、
 * 各 WebContentsView の `before-input-event` で Ctrl+Q を捕捉する代替実装。
 * 本アプリは `ozone-platform-hint=x11` を付与して常時 XWayland で動くため
 * キーイベントは確実に before-input-event に届く。
 *
 * X11 では既存 globalShortcut（InputCoordinator.registerQuitShortcut）が担当するため
 * 二重発火防止として isWayland ガード下でのみ結線すること。
 */

/** Electron Input の必要最小フィールド（テスト用に型を明示） */
export interface InputLike {
  type: string
  control: boolean
  key: string
}

/** before-input-event ハンドラ型 */
export type BeforeInputQuitHandler = (_event: unknown, input: InputLike) => void

/**
 * Ctrl+Q を検知して onQuit を呼ぶ before-input-event ハンドラを生成する。
 * - input.type === 'keyDown'
 * - input.control === true
 * - input.key.toLowerCase() === 'q'
 * の3条件が揃ったときのみ onQuit() を呼ぶ。それ以外は no-op。
 */
export function makeBeforeInputQuitHandler(onQuit: () => void): BeforeInputQuitHandler {
  return (_event: unknown, input: InputLike): void => {
    if (input.type === 'keyDown' && input.control && input.key.toLowerCase() === 'q') {
      onQuit()
    }
  }
}
