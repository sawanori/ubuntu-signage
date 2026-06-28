/**
 * T19/T20/T23/T32-UI — settings/main.ts
 *
 * 設定パネル renderer エントリ。
 *
 * 責務:
 *   - window.settingsApi（preload/settings.ts が contextBridge で公開）を
 *     SettingsBridge として SettingsController に注入する
 *   - DOM 要素を SettingsController のメソッドに配線する
 *   - settings:open 受信でパネルを表示し、設定を再取得して UI を更新する
 *   - settings:updated 受信で UI を最新 Config に同期する
 *
 * 検証委任（視覚/実挙動）:
 *   - 開閉アニメーション・実際のパネル表示/非表示は E2E/[M](E2E-04) に委ねる
 *   - フォルダダイアログの実開閉・フォルダ選択結果は E2E-05 / [M] に委ねる
 *   - 「今すぐテスト再生」による動画実再生は E2E-08 / [M] に委ねる
 *   - URL 不正時のサーバーサイド拒否（UT-24）は unit テストに委ねる
 *
 * DOM 依存:
 *   - #settings-panel  : パネル本体（hidden 属性で開閉）
 *   - #loop-toggle     : 広告ループ ON/OFF トグル
 *   - .interval-btn    : 再生間隔ボタン（data-minutes="5/10/15/30"）
 *   - #site-url-input  : サイト URL テキスト入力
 *   - #site-url-save-btn: URL 保存ボタン
 *   - #url-error       : validateUrl() エラーメッセージ表示
 *   - #folder-path-display: 選択済みフォルダパス表示
 *   - #pick-folder-btn : フォルダ選択ダイアログ呼び出し（settings:pick-folder IPC）
 *   - #test-play-btn   : 今すぐテスト再生（IDLE 時のみ有効）
 *   - #close-btn       : パネルを閉じる（settings:close IPC）
 */

import {
  SettingsController,
  type SettingsBridge,
} from './settings-controller'
import type { Config } from '../../shared/types'
import type { SettingsWindowApi } from '../../shared/window-api'
import { getEl } from '../shared/dom-utils'

// ─── window.settingsApi 型宣言 ────────────────────────────────────────────────
//
// preload/settings.ts が contextBridge.exposeInMainWorld('settingsApi', ...) で公開する API。
// src/shared/window-api.ts の SettingsWindowApi を import type で再利用する（C2）。
// ─────────────────────────────────────────────────────────────────────────────

declare global {
  interface Window {
    settingsApi: SettingsWindowApi
  }
}

// ─── SettingsBridge 実装 ──────────────────────────────────────────────────────
//
// window.settingsApi を SettingsBridge インターフェースにマッピングする。
// テスト時はここのモックを SettingsController に注入する（settings-controller.test.ts 参照）。
// ─────────────────────────────────────────────────────────────────────────────

const bridge: SettingsBridge = {
  getConfig: () => window.settingsApi.getConfig(),
  updateConfig: (patch: Partial<Config>) =>
    window.settingsApi.updateConfig(patch),
  testPlay: () => window.settingsApi.testPlay(),
  pickFolder: () => window.settingsApi.pickFolder(),
}

// ─── コントローラ生成 ─────────────────────────────────────────────────────────

const controller = new SettingsController(bridge)

// ─── DOM 参照 ────────────────────────────────────────────────────────────────

const panel = getEl<HTMLDivElement>('#settings-panel')
const loopToggle = getEl<HTMLButtonElement>('#loop-toggle')
const urlInput = getEl<HTMLInputElement>('#site-url-input')
const urlSaveBtn = getEl<HTMLButtonElement>('#site-url-save-btn')
const urlErrorSpan = getEl<HTMLSpanElement>('#url-error')
const folderPathDisplay = getEl<HTMLSpanElement>('#folder-path-display')
const pickFolderBtn = getEl<HTMLButtonElement>('#pick-folder-btn')
const testPlayBtn = getEl<HTMLButtonElement>('#test-play-btn')
const closeBtn = getEl<HTMLButtonElement>('#close-btn')
const quitBtn = getEl<HTMLButtonElement>('#quit-btn')

// querySelectorAll は NodeList を返すので Array に変換して使う
const intervalBtns = Array.from(
  document.querySelectorAll<HTMLButtonElement>('.interval-btn')
)

// ─── interval 値バリデーター（型ガード） ──────────────────────────────────────

function isValidInterval(n: number): n is 1 | 5 | 10 | 15 | 30 {
  return n === 1 || n === 5 || n === 10 || n === 15 || n === 30
}

// ─── UI 更新関数 ──────────────────────────────────────────────────────────────

/**
 * Config の内容を全 UI 要素に反映する。
 * フォーカス中の URL 入力欄は上書きしない（入力中の文字を保護する）。
 */
function renderConfig(config: Config): void {
  // ループ ON/OFF トグル
  const isOn = config.loopEnabled
  loopToggle.textContent = isOn ? 'ON' : 'OFF'
  loopToggle.setAttribute('aria-pressed', String(isOn))

  // 再生間隔ボタン — 選択中のボタンに interval-btn--selected を付与
  for (const btn of intervalBtns) {
    const minutesAttr = btn.getAttribute('data-minutes')
    const minutes = minutesAttr !== null ? Number(minutesAttr) : -1
    btn.classList.toggle('interval-btn--selected', minutes === config.intervalMinutes)
  }

  // サイト URL（フォーカス中は上書きしない）
  if (document.activeElement !== urlInput) {
    urlInput.value = config.siteUrl
  }

  // 動画フォルダパス
  folderPathDisplay.textContent = config.videoFolderPath.length > 0
    ? config.videoFolderPath
    : '（未設定）'

  // 「今すぐテスト再生」ボタン: IDLE 時のみ有効
  // ※ schedulerState は renderer では更新されず（IPC チャンネル未配線）、
  //   SettingsController._schedulerState は常に初期値 'IDLE' のまま。
  //   この disabled 設定は cosmetic / 非機能であり実ガードではない。
  //   実際の IDLE ガードは Main 側 ipcController が担保する。
  testPlayBtn.disabled = controller.schedulerState !== 'IDLE'
}

/** URL エラーメッセージを表示する */
function showUrlError(message: string): void {
  urlErrorSpan.textContent = message
  urlErrorSpan.hidden = false
  urlInput.classList.add('url-input--error')
}

/** URL エラーメッセージをクリアする */
function clearUrlError(): void {
  urlErrorSpan.textContent = ''
  urlErrorSpan.hidden = true
  urlInput.classList.remove('url-input--error')
}

// ─── パネル開閉 ───────────────────────────────────────────────────────────────

/**
 * パネルを表示し、最新の Config を取得して UI に反映する。
 * settings:open IPC 受信時および初回表示時に呼ぶ。
 */
async function openPanel(): Promise<void> {
  panel.hidden = false
  try {
    const config = await controller.initialize()
    renderConfig(config)
    clearUrlError()
  } catch (err) {
    console.error('[settings] openPanel: initialize() failed', err)
  }
}

// ─── イベントバインド ─────────────────────────────────────────────────────────

// 広告ループ ON/OFF トグル
loopToggle.addEventListener('click', () => {
  void (async () => {
    const updated = await controller.toggleLoop()
    if (updated !== null) renderConfig(updated)
  })()
})

// 再生間隔ボタン（5/10/15/30 分）
for (const btn of intervalBtns) {
  btn.addEventListener('click', () => {
    void (async () => {
      const minutesAttr = btn.getAttribute('data-minutes')
      if (!minutesAttr) return
      const minutesNum = parseInt(minutesAttr, 10)
      if (!isValidInterval(minutesNum)) return
      const updated = await controller.selectInterval(minutesNum)
      if (updated !== null) renderConfig(updated)
    })()
  })
}

// URL 保存ボタン — validateUrl() でクライアント検証してから setUrl() を呼ぶ
urlSaveBtn.addEventListener('click', () => {
  void (async () => {
    const url = urlInput.value.trim()
    clearUrlError()
    const updated = await controller.setUrl(url)
    if (updated !== null) {
      renderConfig(updated)
    } else {
      // controller.urlError: 不正 URL スキームのエラーまたは IPC 側拒否
      const err = controller.urlError
      if (err !== null) {
        showUrlError(err)
      }
    }
  })()
})

// URL 入力中: エラー表示をクリア（再入力中はエラーを消しておく）
urlInput.addEventListener('input', () => {
  clearUrlError()
})

// Enter キーで URL 保存ボタンを発火
urlInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    urlSaveBtn.click()
  }
})

// フォルダ選択ボタン — settings:pick-folder IPC 経由でダイアログを Main プロセスで開く
pickFolderBtn.addEventListener('click', () => {
  void (async () => {
    const updated = await controller.pickFolder()
    if (updated !== null) renderConfig(updated)
  })()
})

// 今すぐテスト再生（IDLE 時のみ有効; Main 側も IDLE ガードを持つ）
testPlayBtn.addEventListener('click', () => {
  controller.testPlay()
})

// 閉じるボタン
closeBtn.addEventListener('click', () => {
  panel.hidden = true
  window.settingsApi.close()
})

// 終了ボタン（修正 D §B2-5）: 1回目 = armed 状態へ、2回目 = 確定終了
quitBtn.addEventListener('click', () => {
  window.settingsApi.quitApp()
})

// ─── IPC コールバック登録（モジュールロード時に一度のみ） ──────────────────────
//
// preload/settings.ts がモジュールレベルで ipcRenderer.on() を登録済みのため、
// ここで onOpen / onUpdated にコールバックをセットするだけで冪等性が保たれる。
// ─────────────────────────────────────────────────────────────────────────────

// Main から settings:open が届いたらパネルを開き、設定を再取得する
window.settingsApi.onOpen(() => {
  void openPanel()
})

// Main から settings:updated が届いたら UI を最新 Config に同期する
// （他コンポーネントによる設定変更の反映や、settings:update の往復結果を含む）
window.settingsApi.onUpdated((config: Config) => {
  controller.applyExternalConfig(config) // 内部状態を同期（CRITICAL §2.7: stale 防止）
  renderConfig(config)
})

// 終了確認状態（armed）変化を UI に反映する（修正 D §B2-5）
// armed=true: 「もう一度押して確定」表示 + パルスアニメーション
// armed=false: 通常表示に戻す
window.settingsApi.onQuitArmed((armed: boolean) => {
  if (armed) {
    quitBtn.textContent = 'もう一度押して終了'
    quitBtn.classList.add('quit-btn--confirm')
  } else {
    quitBtn.textContent = '終了'
    quitBtn.classList.remove('quit-btn--confirm')
  }
})
