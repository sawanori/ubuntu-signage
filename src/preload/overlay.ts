/**
 * T18 — src/preload/overlay.ts
 *
 * overlayView 用 contextBridge API
 *
 * 公開する最小 API:
 *   onPlay(cb)          — Main から overlay:play を受信したときのコールバック登録
 *   sendPlayed(path)    — overlay:played を Main へ送信（再生完了）
 *   sendError(path, r)  — overlay:error を Main へ送信（再生エラー）
 *   sendDurationReady(ms) — overlay:duration-ready を Main へ送信（動画長確定）
 *   sendFadeInDone()    — overlay:fade-in-done を Main へ送信（フェードイン完了）
 *   sendFadeOutDone()   — overlay:fade-out-done を Main へ送信（フェードアウト完了）
 *
 * UO-07 冪等性保証:
 *   ipcRenderer.on('overlay:play', ...) はモジュールロード時に一度だけ登録する。
 *   onPlay(cb) が複数回呼ばれてもリスナーは蓄積しない（コールバック参照のみ更新）。
 */

import { contextBridge, ipcRenderer } from 'electron'
import type { OverlayApi } from '../shared/window-api'

// ─── モジュールレベルリスナー（一度だけ登録）────────────────────────────────

/** 現在登録されている overlay:play コールバック */
let _playCallback: ((path: string) => void) | null = null

/**
 * overlay:play リスナーをモジュールロード時に一度だけ登録する。
 * 以降は _playCallback の参照を更新するだけでハンドラは蓄積しない（UO-07）。
 */
ipcRenderer.on('overlay:play', (_event, payload: { path: string }) => {
  _playCallback?.(payload.path)
})

// ─── contextBridge API ────────────────────────────────────────────────────────

const overlayApi: OverlayApi = {
  /**
   * Main から overlay:play が届いたときに呼ぶコールバックを登録する。
   * 複数回呼んでも IPC リスナーは増えない（UO-07）。
   */
  onPlay: (callback: (path: string) => void): void => {
    _playCallback = callback
  },

  /** 再生完了を Main へ通知する（Scheduler: PLAYING→FADE_OUT） */
  sendPlayed: (path: string): void => {
    ipcRenderer.send('overlay:played', { path })
  },

  /** 再生エラーを Main へ通知する（Scheduler: 強制 IDLE 復帰） */
  sendError: (path: string, reason: string): void => {
    ipcRenderer.send('overlay:error', { path, reason })
  },

  /**
   * 動画長確定を Main へ通知する（loadedmetadata イベントで呼ぶ）。
   * Scheduler の PLAYING ウォッチドッグタイマーを ms+30000ms に更新する。
   */
  sendDurationReady: (ms: number): void => {
    ipcRenderer.send('overlay:duration-ready', { ms })
  },

  /** フェードイン完了を Main へ通知する（Scheduler: FADE_IN→PLAYING） */
  sendFadeInDone: (): void => {
    ipcRenderer.send('overlay:fade-in-done')
  },

  /** フェードアウト完了を Main へ通知する（Scheduler: FADE_OUT→IDLE） */
  sendFadeOutDone: (): void => {
    ipcRenderer.send('overlay:fade-out-done')
  },
}

contextBridge.exposeInMainWorld('overlayApi', overlayApi)
