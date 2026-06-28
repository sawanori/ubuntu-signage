/**
 * src/renderer/addressbar/main.ts
 *
 * アドレスバー renderer ロジック
 *
 * 責務:
 *   - 起動時に getConfig() で現在設定（siteUrl / loopEnabled）を取得し UI に反映する
 *   - URL 入力 Enter / [表示]ボタン → navigate() invoke → 戻り値 {ok, message} でエラー表示
 *   - [↻再読込] → reload() 送信
 *   - [広告ループ]トグル → toggleLoop() invoke → 戻り値（Config | null）で UI 更新
 *   - onConfigUpdated コールバック → 外部（設定パネル等）からの config 変更を反映
 *
 * 楽観的更新禁止:
 *   invoke の戻り値でのみ UI を更新する。invoke 完了前に UI を変更しない。
 *
 * 視覚確認・実操作は E2E に委ねる。
 *
 * IPC（preload/addressbar.ts 経由）:
 *   invoke: addressbar:get-config, addressbar:navigate, addressbar:toggle-loop
 *   send:   addressbar:reload
 *   on:     addressbar:config-updated
 */

import type { Config } from '../../shared/types'
import type { AddressBarApi } from '../../shared/window-api'

// ─── 型宣言（contextBridge から公開された API）───────────────────────────────
//
// NavigateResult / AddressBarApi は src/shared/window-api.ts に単一定義済み（C2/C3）。
// import type で再利用し、ここでの再宣言を排除する。

declare global {
  interface Window {
    addressBarApi: AddressBarApi
  }
}

// ─── DOM 要素の参照 ──────────────────────────────────────────────────────────

const reloadBtn = document.getElementById('reload-btn') as HTMLButtonElement
const navigateForm = document.getElementById('navigate-form') as HTMLFormElement
const urlInput = document.getElementById('url-input') as HTMLInputElement
const urlError = document.getElementById('url-error') as HTMLSpanElement
const navigateBtn = document.getElementById('navigate-btn') as HTMLButtonElement
const loopToggle = document.getElementById('loop-toggle') as HTMLButtonElement
const loopLabel = document.getElementById('loop-label') as HTMLSpanElement

// ─── UI 更新ヘルパー ─────────────────────────────────────────────────────────

/**
 * URL エラーメッセージを表示する。
 * message が null / undefined の場合はエラーを非表示にする。
 */
function showUrlError(message: string | null | undefined): void {
  if (message) {
    urlError.textContent = message
    urlError.hidden = false
  } else {
    urlError.textContent = ''
    urlError.hidden = true
  }
}

/**
 * ループトグルボタンの表示を loopEnabled に合わせて更新する。
 * 楽観的更新禁止: invoke / onConfigUpdated 受信時のみ呼ぶ。
 */
function renderLoopToggle(loopEnabled: boolean): void {
  loopToggle.setAttribute('aria-pressed', String(loopEnabled))
  loopLabel.textContent = loopEnabled ? 'ON' : 'OFF'
}

/**
 * 設定全体を UI に反映する。
 * getConfig() 初期化時および onConfigUpdated 受信時に呼ぶ。
 */
function renderConfig(config: Config): void {
  urlInput.value = config.siteUrl
  renderLoopToggle(config.loopEnabled)
}

// ─── ナビゲーション ──────────────────────────────────────────────────────────

/**
 * URL を入力してナビゲーションを実行する。
 * invoke 戻り値でのみエラー表示・UI 更新を行う（楽観的更新禁止）。
 * 成功時: Main が setToolbarVisible(false) を呼ぶため、アドレスバーは自動的に非表示になる。
 * 失敗時: エラーメッセージを表示し、URL 入力欄にフォーカスを戻す。
 */
async function handleNavigate(): Promise<void> {
  const url = urlInput.value.trim()
  showUrlError(null)

  try {
    navigateBtn.disabled = true
    const result = await window.addressBarApi.navigate(url)
    if (!result.ok) {
      showUrlError(result.message ?? 'ナビゲーションに失敗しました')
      urlInput.focus()
    } else {
      // 成功: Main が config-updated を送信してくるため、onConfigUpdated で UI 更新される
      showUrlError(null)
    }
  } catch {
    showUrlError('エラーが発生しました。もう一度お試しください。')
    urlInput.focus()
  } finally {
    navigateBtn.disabled = false
  }
}

// ─── ループトグル ─────────────────────────────────────────────────────────────

/**
 * 広告ループトグルを切り替える。
 * invoke 戻り値（Config | null）でのみ UI を更新する（楽観的更新禁止）。
 * null 返却時は UI を変更しない。
 */
async function handleToggleLoop(): Promise<void> {
  try {
    loopToggle.disabled = true
    const updated = await window.addressBarApi.toggleLoop()
    if (updated !== null) {
      renderLoopToggle(updated.loopEnabled)
    }
    // null の場合: 失敗。UI は変更しない（楽観的更新禁止）
  } catch (err) {
    // IPC エラー: UI は変更しない（楽観的更新禁止）
    console.error('[addressbar] toggle-loop failed', err)
  } finally {
    loopToggle.disabled = false
  }
}

// ─── 再読込 ──────────────────────────────────────────────────────────────────

function handleReload(): void {
  window.addressBarApi.reload()
}

// ─── イベント結線 ─────────────────────────────────────────────────────────────

reloadBtn.addEventListener('click', handleReload)

navigateForm.addEventListener('submit', (event: Event) => {
  event.preventDefault()
  void handleNavigate()
})

loopToggle.addEventListener('click', () => {
  void handleToggleLoop()
})

// ─── config 変更通知（外部書き手からの同期） ───────────────────────────────────

window.addressBarApi.onConfigUpdated((config: Config) => {
  renderConfig(config)
})

// ─── 初期化 ──────────────────────────────────────────────────────────────────

/**
 * 起動時に現在の config を取得して UI を初期化する。
 * エラー時は UI をデフォルト状態のまま維持する（サイレント障害にしない）。
 */
async function init(): Promise<void> {
  try {
    const config = await window.addressBarApi.getConfig()
    renderConfig(config)
  } catch {
    // getConfig 失敗: UI はデフォルト状態を維持。onConfigUpdated で後から補正される。
    // サイレント障害にしないためコンソールに出力する（preload/renderer はコンソール確認可）
    console.error('[addressbar] getConfig failed on init')
  }
}

// DOMContentLoaded 後に初期化
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => { void init() })
} else {
  void init()
}
