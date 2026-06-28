/**
 * T20 — src/preload/settings.ts
 *
 * settingsView 用 contextBridge API
 *
 * 公開する最小 API:
 *   getConfig()         — settings:get を invoke して現在設定を取得する
 *   updateConfig(patch) — settings:update を invoke して設定を更新する
 *   onOpen(cb)          — Main から settings:open を受信したときのコールバック登録
 *   onUpdated(cb)       — Main から settings:updated を受信したときのコールバック登録
 *   close()             — settings:close を Main へ送信（パネルを閉じる）
 *   testPlay()          — settings:test-play を Main へ送信（今すぐテスト再生）
 *   pickFolder()        — settings:pick-folder を invoke してフォルダパスを取得する
 *
 * 冪等性保証:
 *   IPC リスナーはモジュールロード時に一度だけ登録する（listener 蓄積なし）。
 */

import { contextBridge, ipcRenderer } from 'electron'
import type { Config } from '../shared/types'

// ─── モジュールレベルリスナー（一度だけ登録）────────────────────────────────

/** settings:open コールバック */
let _openCallback: (() => void) | null = null
/** settings:updated コールバック */
let _updatedCallback: ((config: Config) => void) | null = null
/** app:quit-armed コールバック */
let _quitArmedCallback: ((armed: boolean) => void) | null = null

/** settings:open を一度だけ登録 */
ipcRenderer.on('settings:open', () => {
  _openCallback?.()
})

/** settings:updated を一度だけ登録 */
ipcRenderer.on('settings:updated', (_event, config: Config) => {
  _updatedCallback?.(config)
})

/** app:quit-armed を一度だけ登録 (修正 C §B2-2) */
ipcRenderer.on('app:quit-armed', (_event, armed: boolean) => {
  _quitArmedCallback?.(armed)
})

// ─── contextBridge API ────────────────────────────────────────────────────────

contextBridge.exposeInMainWorld('settingsApi', {
  /** 現在設定を取得する（Main: settings:get ハンドラが ConfigManager.current を返す） */
  getConfig: (): Promise<Config> => ipcRenderer.invoke('settings:get'),

  /**
   * 設定を部分更新する。
   * Main 側で ConfigUpdateSchema (zod) 検証・ConfigManager 保存・Scheduler 反映が行われる。
   */
  updateConfig: (patch: Partial<Config>): Promise<Config | null> =>
    ipcRenderer.invoke('settings:update', patch),

  /**
   * Main から settings:open が届いたときに呼ぶコールバックを登録する。
   * 複数回呼んでも IPC リスナーは増えない。
   */
  onOpen: (callback: () => void): void => {
    _openCallback = callback
  },

  /**
   * Main から settings:updated が届いたときに呼ぶコールバックを登録する。
   * 設定変更が反映された Config を受け取り、UI を更新する。
   */
  onUpdated: (callback: (config: Config) => void): void => {
    _updatedCallback = callback
  },

  /** 設定パネルを閉じる要求を Main へ送信する */
  close: (): void => {
    ipcRenderer.send('settings:close')
  },

  /** 今すぐテスト再生要求を Main へ送信する（IDLE 時のみ有効） */
  testPlay: (): void => {
    ipcRenderer.send('settings:test-play')
  },

  /**
   * フォルダ選択ダイアログを開く（Main プロセスが dialog.showOpenDialog を呼ぶ）。
   * @returns 選択されたフォルダパス、またはキャンセル時は null
   */
  pickFolder: (): Promise<{ folderPath: string | null }> =>
    ipcRenderer.invoke('settings:pick-folder'),

  /**
   * 終了要求を Main へ送信する（2段押し 1回目 or 2回目）(修正 C §B2-2)。
   * QuitCoordinator が状態を管理する。
   */
  quitApp: (): void => {
    ipcRenderer.send('app:request-quit')
  },

  /**
   * Main から app:quit-armed が届いたときに呼ぶコールバックを登録する (修正 C §B2-2)。
   * armed=true: 確認待ち状態（終了ボタンの表示を変える）
   * armed=false: 確認待ち解除（元の表示に戻す）
   */
  onQuitArmed: (callback: (armed: boolean) => void): void => {
    _quitArmedCallback = callback
  },
})
