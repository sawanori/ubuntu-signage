/**
 * src/main/index.ts — Phase E 最終統合 (T06/T07/T24/T25/T27/T28/T32-BE + Phase E)
 *
 * 主プロセス エントリポイント。
 * 各モジュール（config / playlist / watcher / scheduler / playback-orchestrator /
 * media-protocol / ipc / input-coordinator）を結線し、
 * BaseWindow + 5層 WebContentsView を構築する。
 *
 * WebContentsView z 順 (Phase E 更新):
 *   [0] siteView        — 外部サイネージ URL（sandbox / persist:site）
 *   [1] addressBarView  — アドレスバー UI（preload=addressbar.js / in-memory session）
 *   [2] overlayView     — 動画オーバーレイ（透過背景 #00000000 / persist:overlay）
 *   [3] hotspotView     — 隅タップ検出専用（透過 / persist:hotspot）
 *   [4] settingsView    — 設定パネル（既定 hidden / persist:settings）
 *
 * 未検証項目（表示環境が必要なため E2E/[M] に委譲）:
 *   - 透過合成・黒チラなしの視覚確認 (UO-06, M-03)
 *   - globalShortcut 実挙動・Wayland 非対応確認 (E2E-06, M-10)
 *   - siteView 実表示・X-Frame 回避 (E2E-07, M-01)
 *   - hotspotView 実タップ・settingsView 開閉 (E2E-04, E2E-13, UH-01~03)
 *   - overlayView マウスパススルー（renderer CSS pointer-events: none 依存）(UO-08)
 *   - powerSaveBlocker 実効果 (M-05)
 *   - 全フロー広告割り込み (E2E-01)
 *   - addressBarView 実動作・Ctrl+L / 上部中央ゾーンタップ (E2E-new)
 *
 * TODO(未解決事項):
 *   - §10.6: 単一タップ誤発火リスク → 将来は長押し(500ms)トリガーへ改善候補
 *   - §10.7: 任意 http/https 先への無制限ナビ → 将来は PIN/ジェスチャ敷居化候補
 */

import {
  app,
  BaseWindow,
  WebContentsView,
  protocol,
  session,
  globalShortcut,
  powerSaveBlocker,
  ipcMain,
  dialog,
} from 'electron'
import { join } from 'node:path'
import * as fs from 'node:fs'
import { exec, execSync } from 'node:child_process'
import { createConfigManager, migrateLegacySiteUrl } from './config'
import { PlaylistManager } from './playlist'
import { Watcher } from './watcher'
import { PlaybackOrchestrator } from './playback-orchestrator'
import { createElectronProtocolHandler, toMediaUri } from './media-protocol'
import type { FsAdapter } from './media-protocol'
import { registerHandlers } from './ipc'
import type { IpcMainLike, WebContentsLike } from './ipc'
import { InputCoordinator } from './input-coordinator'
import { QuitCoordinator } from './quit-coordinator'
import { shouldDisableGpu, gpuCommandLineSwitches, gpuFallbackPhase } from './wsl-detect'
import { applyFolderChange } from './folder-change-handler'
import { isAllowedNavUrl } from './site-guards'
import {
  createRetryState,
  onLoadStart,
  onLoadFail,
  onLoadFinish,
  MAX_RETRY_ATTEMPTS,
} from './site-load-retry'
import { notifyAddressZoneEnabled, computeLayeredBounds } from './toolbar-utils'
import type { SchedulerLogger } from './scheduler/scheduler'
import type { PlaylistLogger } from './playlist'
import type { WatcherLogger } from './watcher'

// ─── シングルインスタンスガード (T29) ─────────────────────────────────────────
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
  process.exit(0)
}

// ─── WSL GPU 無効化判定 (修正 A: §A-2) ────────────────────────────────────────
// /proc/version を読み取り WSL 環境かどうかを判定する。
// 読み取り失敗時（Linux 以外・権限なし等）は null を渡して false 扱いにする。
{
  let procVersion: string | null = null
  try {
    procVersion = fs.readFileSync('/proc/version', 'utf8')
  } catch {
    // /proc/version が存在しない環境（macOS / Windows ネイティブ等）では無視
    // logWarn はまだ定義されていないため後で定義する関数の参照を避ける
    process.stdout.write(
      JSON.stringify({ level: 'WARN', event: 'gpu.procVersionReadFailed', ts: Date.now() }) + '\n',
    )
  }
  const gpuParams = { env: process.env as Record<string, string | undefined>, procVersion }
  if (shouldDisableGpu(gpuParams)) {
    const phase = gpuFallbackPhase(gpuParams.env)
    // phase 3 (swiftshader GL) / phase 4 (実 GPU を in-process で使う) は hw accel を切らない
    // （phase 1/2 のみ無効化）
    if (phase !== 3 && phase !== 4) {
      app.disableHardwareAcceleration()
    }
    // GPU_FALLBACK_PHASE 環境変数で切替（デフォルト 2）。app.whenReady() より前に呼ぶ必要あり
    const gpuSwitches = gpuCommandLineSwitches(gpuParams)
    for (const sw of gpuSwitches) {
      app.commandLine.appendSwitch(sw.name, sw.value)
    }
    process.stdout.write(
      JSON.stringify({
        level: 'WARN',
        event: 'gpu.hardwareAccelerationDisabled',
        phase,
        hardwareAccelerationDisabled: phase !== 3 && phase !== 4,
        gpuSwitches,
        ts: Date.now(),
      }) + '\n',
    )
  }
}

// ─── 構造化ロガー ──────────────────────────────────────────────────────────────

function logError(event: string, meta?: Record<string, unknown>): void {
  process.stderr.write(
    JSON.stringify({ level: 'ERROR', event, ...meta, ts: Date.now() }) + '\n',
  )
}

function logWarn(event: string, meta?: Record<string, unknown>): void {
  process.stdout.write(
    JSON.stringify({ level: 'WARN', event, ...meta, ts: Date.now() }) + '\n',
  )
}

// ─── 未捕捉例外・Promise 拒否の集約ログ (T30 / UT-15 / UT-16) ────────────────
process.on('uncaughtException', (err: Error) => {
  logError('process.uncaughtException', {
    message: err.message,
    stack: err.stack ?? '',
  })
  // systemd が Restart=always で自動再起動する
  app.relaunch()
  app.quit()
})

process.on('unhandledRejection', (reason: unknown) => {
  logError('process.unhandledRejection', {
    reason: reason instanceof Error ? reason.message : String(reason),
  })
})

// ─── 64bit 自己診断 (§3.7) ───────────────────────────────────────────────────
/** 診断コマンド（execSync）のタイムアウト ms */
const DIAG_EXEC_TIMEOUT_MS = 3000

try {
  const longBit = execSync('getconf LONG_BIT', { timeout: DIAG_EXEC_TIMEOUT_MS }).toString().trim()
  if (longBit !== '64') {
    logWarn('arch.not64bit', { longBit })
  }
} catch {
  try {
    const machine = execSync('uname -m', { timeout: DIAG_EXEC_TIMEOUT_MS }).toString().trim()
    if (!machine.includes('64') && machine !== 'aarch64') {
      logWarn('arch.not64bit', { machine })
    }
  } catch (diagErr: unknown) {
    logWarn('arch.diagFailed', {
      reason: diagErr instanceof Error ? diagErr.message : String(diagErr),
    })
  }
}

// ─── Wayland / X11 判定 (§3.6) ───────────────────────────────────────────────
const isWayland = process.env['XDG_SESSION_TYPE'] === 'wayland'

// ─── media:// プロトコル特権登録（app.whenReady 前に必要）────────────────────
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'media',
    privileges: {
      secure: true,
      standard: true,
      stream: true,
      supportFetchAPI: true,
    },
  },
])

// ─── fs アダプター（media-protocol 依存注入用）───────────────────────────────
const mediaFsAdapter: FsAdapter = {
  realpath: fs.promises.realpath,
  stat: fs.promises.stat,
  createReadStream: (p: string, opts?: { start: number; end: number }) =>
    fs.createReadStream(p, opts),
}

// ─── 現在の動画フォルダ（onFolderChange で動的更新）─────────────────────────
let currentVideoFolder = ''

// ─── powerSaveBlocker ID ─────────────────────────────────────────────────────
let powerBlockerId: number | null = null

// ─── 2番目のインスタンス起動時: 既存ウィンドウにフォーカス (T29 / M-11) ──────
app.on('second-instance', (_event, _argv, _workingDirectory, _additionalData) => {
  const wins = BaseWindow.getAllWindows()
  const win = wins[0]
  if (win !== undefined) {
    if (win.isMinimized()) win.restore()
    win.focus()
  }
})

// ─── アプリライフサイクル ─────────────────────────────────────────────────────
app.whenReady().then(() => {
  void main()
})

app.on('window-all-closed', () => {
  app.quit()
})

app.on('before-quit', () => {
  globalShortcut.unregisterAll()
  if (powerBlockerId !== null) {
    powerSaveBlocker.stop(powerBlockerId)
    powerBlockerId = null
  }
})

// ─── メイン初期化関数 ────────────────────────────────────────────────────────
async function main(): Promise<void> {
  // ── ConfigManager 初期化 ────────────────────────────────────────────────
  const configManager = createConfigManager()
  // ⚠️ CRITICAL (§2.6 E-6): const → let に変更し、移行後の値を必ず再代入する。
  // migrateLegacySiteUrl の戻り値を再代入しないと旧 URL が loadURL に渡り黒画面になる。
  let config = configManager.load()
  config = migrateLegacySiteUrl(config, configManager)
  currentVideoFolder = config.videoFolderPath

  // ── PlaylistManager + Watcher 初期化 ───────────────────────────────────
  const playlistLogger: PlaylistLogger = {
    warn: (data) =>
      logWarn(String(data['event'] ?? 'playlist.warn'), data),
    error: (data) =>
      logError(String(data['event'] ?? 'playlist.error'), data),
  }
  const playlist = new PlaylistManager(playlistLogger)

  const watcherLogger: WatcherLogger = {
    debug: (_data: Record<string, unknown>) => {
      /* デバッグログは省略 */
    },
    warn: (data) =>
      logWarn(String(data['event'] ?? 'watcher.warn'), data),
    error: (data) =>
      logError(String(data['event'] ?? 'watcher.error'), data),
  }
  const watcher = new Watcher(
    playlist,
    {
      // USB / NFS などの inotify 非対応フォルダ用ポーリングモード
      // 環境変数 WATCHER_USE_POLLING=true で有効化できる
      usePolling: process.env['WATCHER_USE_POLLING'] === 'true',
      pollIntervalMs: process.env['WATCHER_POLL_INTERVAL_MS']
        ? Number(process.env['WATCHER_POLL_INTERVAL_MS'])
        : undefined,
    },
    watcherLogger,
  )

  // ── media:// プロトコルハンドラー登録 ──────────────────────────────────
  // currentVideoFolder を closure で参照することで、フォルダ変更に動的対応する。
  // handleMedia は毎リクエストで createElectronProtocolHandler を呼ぶため、
  // currentVideoFolder の最新値が常に参照される（live-folder closure 意味論を維持）。
  const protocolLogger = { error: logError, warn: logWarn }
  const handleMedia = (request: Request): Promise<Response> =>
    createElectronProtocolHandler(currentVideoFolder, mediaFsAdapter, protocolLogger)(request)

  // 全 view が明示 partition（persist:site / '' / persist:overlay / persist:hotspot /
  // persist:settings）を持つため、既定セッション経由の media:// 消費者は現状ゼロ。
  // セキュリティ隣接コードであり独断削除はリスクを伴うため、防御的に登録を残す（削除しない）。
  protocol.handle('media', handleMedia)

  // overlayView は partition "persist:overlay" で動作するため、media:// ハンドラは既定セッションだけでなく
  // overlay セッションにも登録する。既定セッションのみだと overlay からの media:// が未処理になり
  // <video> が "Format error" になる（実機診断で確認済み）。
  const overlayProtoSession = session.fromPartition('persist:overlay')
  overlayProtoSession.protocol.handle('media', handleMedia)

  // ── siteView セッション: X-Frame-Options / CSP frame-ancestors 除去 ────
  // **siteView 専用 partition (persist:site) に限定。他 3 View は改変しない。**
  // (§3.5 / E2E-16)
  const siteSession = session.fromPartition('persist:site')

  siteSession.webRequest.onHeadersReceived(
    { urls: ['<all_urls>'] },
    (details, callback) => {
      const headers = { ...(details.responseHeaders ?? {}) }
      for (const key of Object.keys(headers)) {
        const lower = key.toLowerCase()
        if (
          lower === 'x-frame-options' ||
          lower === 'content-security-policy'
        ) {
          // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
          delete headers[key]
        }
      }
      callback({ responseHeaders: headers })
    },
  )

  // siteView のダウンロードを抑止 (§3.5 / UT-19)
  siteSession.on('will-download', (event) => {
    event.preventDefault()
  })

  // ── BaseWindow 生成（frameless / fullscreen）(T06) ──────────────────────
  const win = new BaseWindow({
    frame: false,
    fullscreen: true,
    backgroundColor: '#000000',
  })
  win.on('close', () => {
    app.quit()
  })

  // ウィンドウ bounds ヘルパー
  const getViewBounds = (): Electron.Rectangle => {
    const b = win.getBounds()
    return { x: 0, y: 0, width: b.width, height: b.height }
  }

  // ── アドレスバー表示状態フラグ (Phase E §6.1) ────────────────────────────
  /** アドレスバーの高さ（px）§1.2 */
  const TOOLBAR_HEIGHT = 48
  /** アドレスバー表示状態（true=表示 / false=非表示） */
  let toolbarVisible = false
  /**
   * startPage フォールバック実行中フラグ（無限リトライ防止 §2.4 CRITICAL）。
   * loadStartPage() でセット、loadSiteUrl(非空URL) でクリアされる。
   */
  let inLocalFallback = false

  // ── WebContentsView 生成 (§4.1 + Phase E §6.2) ──────────────────────────

  // [z:0] siteView — 外部サイネージ URL（sandbox / persist:site）
  const siteView = new WebContentsView({
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      partition: 'persist:site',
    },
  })

  // [z:1] addressBarView — アドレスバー UI (Phase E §6.8 CRITICAL)
  // ⚠️ CRITICAL: webPreferences を必ず明示する。省略すると preload が適用されず
  //   contextBridge API が undefined になり IPC が無音で失敗する。
  // partition='' → in-memory セッション（siteView との Session 混入防止 §10.2）
  const addressBarView = new WebContentsView({
    webPreferences: {
      preload: join(__dirname, '../preload/addressbar.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      partition: '',
    },
  })

  // [z:2] overlayView — 動画オーバーレイ（透過背景 / persist:overlay）
  // NOTE: WebContentsView は setIgnoreMouseEvents を持たない（View 基底クラスに未定義）。
  //       マウスイベントのパススルーは renderer の CSS (pointer-events: none) で実現する。
  //       視覚確認: [E2E] UO-08
  // z:2 > addressBarView(z:1) → 動画再生中はアドレスバーが隠れる（意図通り §2.5）
  const overlayView = new WebContentsView({
    webPreferences: {
      preload: join(__dirname, '../preload/overlay.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      partition: 'persist:overlay',
    },
  })
  overlayView.setBackgroundColor('#00000000')

  // [z:3] hotspotView — 隅タップ検出専用（全面透過 / persist:hotspot）
  const hotspotView = new WebContentsView({
    webPreferences: {
      preload: join(__dirname, '../preload/hotspot.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      partition: 'persist:hotspot',
    },
  })
  hotspotView.setBackgroundColor('#00000000')

  // [z:4] settingsView — 設定パネル（既定 hidden / persist:settings）
  const settingsView = new WebContentsView({
    webPreferences: {
      preload: join(__dirname, '../preload/settings.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      partition: 'persist:settings',
    },
  })

  // ── z 順で addChildView（後から追加したものが前面）§6.2 確定順序 ────────────
  // z:0 siteView → z:1 addressBarView → z:2 overlayView → z:3 hotspotView → z:4 settingsView
  win.contentView.addChildView(siteView)         // z:0 — 最背面
  win.contentView.addChildView(addressBarView)    // z:1 — siteView の上（toolbar strip）
  win.contentView.addChildView(overlayView)       // z:2 — addressBarView より前面（動画フルスクリーン）
  win.contentView.addChildView(hotspotView)       // z:3
  win.contentView.addChildView(settingsView)      // z:4 — 最前面

  // ── 動的レイアウトヘルパー (§6.1) ──────────────────────────────────────────

  /** 現在の toolbar 状態に基づいて siteView の bounds を計算する（純関数経由） */
  function getSiteViewBounds(): Electron.Rectangle {
    const b = win.getBounds()
    return computeLayeredBounds(toolbarVisible, b, TOOLBAR_HEIGHT).site
  }

  /** addressBarView の固定 bounds（幅フル / 高さ TOOLBAR_HEIGHT） */
  function getAddressBarBounds(): Electron.Rectangle {
    const b = win.getBounds()
    return computeLayeredBounds(toolbarVisible, b, TOOLBAR_HEIGHT).addressBar
  }

  /**
   * hotspotView の bounds を計算する。
   * WebContentsView は CSS pointer-events を透過しないため、toolbarVisible=true 時は
   * 上部 TOOLBAR_HEIGHT 帯から退避させてアドレスバーへのクリックを保護する（Option A）。
   */
  function getHotspotBounds(): Electron.Rectangle {
    const b = win.getBounds()
    return computeLayeredBounds(toolbarVisible, b, TOOLBAR_HEIGHT).hotspot
  }

  /**
   * アドレスバーを表示/非表示にし、関連 View の bounds を更新する。
   *
   * VISIBLE 時:
   *   - addressBarView を表示して TOOLBAR_HEIGHT 分の上マージンを siteView に設定する
   *   - zone-disable IPC で上部中央ゾーンを無効化し URL 入力クリックを保護する (§2.5)
   *
   * HIDDEN 時:
   *   - addressBarView を非表示にして siteView をフルスクリーンに戻す
   *   - zone-enable IPC で上部中央ゾーンを復活させる
   *
   * bounds 失敗: Electron の setBounds はスローしない (§8) が、予期しないエラーを
   * WARN ログで記録する。次の resize イベントで自動補正される。
   */
  function setToolbarVisible(visible: boolean): void {
    toolbarVisible = visible
    addressBarView.setVisible(visible)
    try {
      if (visible) {
        addressBarView.setBounds(getAddressBarBounds())
      }
      siteView.setBounds(getSiteViewBounds())
      // hotspot を toolbar 帯から退避: WebContentsView は pointer-events 透過しない
      hotspotView.setBounds(getHotspotBounds())
    } catch (e: unknown) {
      logWarn('toolbar.setBoundsFailed', {
        event: 'toolbar.setBoundsFailed',
        visible,
        reason: e instanceof Error ? e.message : String(e),
      })
    }
    // ⚠️ CRITICAL §2.5: zone-disable IPC — isDestroyed() ガード付
    notifyAddressZoneEnabled(hotspotView.webContents, toolbarVisible)
    // 表示時はアドレスバーにフォーカスを当て、URL 入力欄でキーボード入力を受け付ける
    if (visible && !addressBarView.webContents.isDestroyed()) {
      addressBarView.webContents.focus()
    }
  }

  // 初期 bounds 設定
  const initialBounds = getViewBounds()
  siteView.setBounds(initialBounds)
  addressBarView.setBounds(getAddressBarBounds())
  overlayView.setBounds(initialBounds)
  hotspotView.setBounds(initialBounds)
  settingsView.setBounds(initialBounds)

  // 初期可視状態:
  //   - addressBarView: 既定 hidden（toolbarVisible=false）。siteUrl='' の場合は後で setToolbarVisible(true)
  //   - overlayView: アイドル時非表示
  //   - settingsView: 既定 hidden
  addressBarView.setVisible(false)
  overlayView.setVisible(false)
  settingsView.setVisible(false)

  // リサイズ時の bounds 追従（既存ハンドラを拡張 §6.1 I-10 対応）
  win.on('resize', () => {
    const vb = getViewBounds()
    siteView.setBounds(getSiteViewBounds())    // toolbar 状態に応じた動的 bounds
    overlayView.setBounds(vb)
    hotspotView.setBounds(getHotspotBounds()) // toolbar 帯から退避（pointer-events 透過なし）
    settingsView.setBounds(vb)
    if (toolbarVisible) {
      addressBarView.setBounds(getAddressBarBounds())
    }
  })

  // ── siteView セキュリティガード (§3.5 / T07 / UT-19) ───────────────────

  // ポップアップ全禁止
  siteView.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))

  // will-navigate: ホワイトリスト外の遷移を阻止（isAllowedNavUrl は site-guards.ts の純関数）
  // 空 siteUrl の場合: isAllowedNavUrl('', '') → new URL('') がスロー → false を返す
  // → startPage 内の外部リンクが発火しても阻止される（startPage 設計で外部リンクは含めない）
  siteView.webContents.on('will-navigate', (details) => {
    if (details.isMainFrame && !isAllowedNavUrl(details.url, configManager.current.siteUrl)) {
      details.preventDefault()
      logWarn('siteView.navBlocked', { url: details.url, event: 'siteView.navBlocked' })
    }
  })

  // will-redirect: ホワイトリスト外のリダイレクトを阻止
  siteView.webContents.on('will-redirect', (details) => {
    if (details.isMainFrame && !isAllowedNavUrl(details.url, configManager.current.siteUrl)) {
      details.preventDefault()
      logWarn('siteView.navBlocked', { url: details.url, event: 'siteView.navBlocked' })
    }
  })

  // siteRetryState: イミュータブルな状態管理（site-load-retry.ts）
  // failedSinceStart フラグにより、Chromium のエラーページ finish で
  // リトライカウンタがリセットされるバグを防ぐ。
  let siteRetryState = createRetryState()

  // ── startPage パス（同梱 HTML / ネットワークアクセスなし §2.3） ─────────────
  const startPagePath = join(__dirname, '../renderer/start/index.html')

  /**
   * スタート画面を siteView にロードする（§2.3 / §2.4）。
   *
   * ⚠️ CRITICAL §2.4: inLocalFallback = true を必ずセットしてから loadFile を呼ぶ。
   * did-fail-load がこのフラグを見て無限リトライを防ぐ。
   * file:// ロードでも ERR_FILE_NOT_FOUND(-6) 等で did-fail-load が発火するため
   * inLocalFallback なしでは無限ループに陥る。
   */
  function loadStartPage(): void {
    inLocalFallback = true
    siteView.webContents.loadFile(startPagePath).catch((e: unknown) => {
      logError('siteView.startPageLoadFailed', {
        event: 'siteView.startPageLoadFailed',
        reason: e instanceof Error ? e.message : String(e),
        path: startPagePath,
      })
    })
  }

  /**
   * siteView に URL をロードする共通ヘルパー（§2.4 / §9 E-4）。
   *
   * url === '' の場合: startPage（同梱 HTML）を loadFile でロードする。
   *   - inLocalFallback = true がセットされ did-fail-load のリトライを防ぐ
   *   - ネットワークアクセスなし・黒画面なし
   *
   * url !== '' の場合:
   *   - inLocalFallback = false をクリアして外部 URL ロードを開始する
   *   - onLoadStart で failedSinceStart をクリアする
   */
  function loadSiteUrl(url: string): void {
    if (url === '') {
      loadStartPage()
      return
    }
    inLocalFallback = false
    siteRetryState = onLoadStart(siteRetryState)
    siteView.webContents.loadURL(url).catch((e: unknown) => {
      logError('siteView.reloadFailed', { reason: e instanceof Error ? e.message : String(e) })
    })
  }

  siteView.webContents.on('did-finish-load', () => {
    // failedSinceStart=true の場合はエラーページの finish → attempt を維持
    // failedSinceStart=false の場合は真の成功 → attempt を 0 にリセット
    const wasFailedSinceStart = siteRetryState.failedSinceStart
    siteRetryState = onLoadFinish(siteRetryState)
    // §10.1 確定: ナビゲーション「成功」(!failedSinceStart かつ !inLocalFallback) 後のみ
    // アドレスバーを自動非表示にする。did-fail-load 時・startPage 時は非表示にしない。
    if (!wasFailedSinceStart && !inLocalFallback && toolbarVisible) {
      setToolbarVisible(false)
    }
  })
  /** Chromium のナビゲーションキャンセルコード（別ナビゲーションへの置換による中断） */
  const ERR_ABORTED = -3

  siteView.webContents.on(
    'did-fail-load',
    (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      if (!isMainFrame) return
      // ERR_ABORTED: 別ナビゲーションへの置換によるキャンセル → カウントしない
      if (errorCode === ERR_ABORTED) return

      // ⚠️ CRITICAL §2.4: startPage フォールバック中の did-fail-load は
      // 無限ループ防止のため logError のみ・リトライ一切なし（脱出条件）
      if (inLocalFallback) {
        logError('siteView.startPageLoadFailed', {
          event: 'siteView.startPageLoadFailed',
          errorCode,
          errorDescription,
          url: validatedURL,
        })
        return
      }

      const { state, delayMs } = onLoadFail(siteRetryState)
      siteRetryState = state

      if (state.attempt > MAX_RETRY_ATTEMPTS) {
        // 最大リトライ超過 → startPage へフォールバック (§2.4)
        logWarn('siteView.loadFailed.fallback', {
          event: 'siteView.loadFailed.fallback',
          errorCode,
          errorDescription,
          url: validatedURL,
          attempt: state.attempt,
          maxRetryAttempts: MAX_RETRY_ATTEMPTS,
        })
        loadStartPage()
        siteRetryState = createRetryState()
        setToolbarVisible(true)  // フォールバック後: URL 再入力のためバーを自動表示
        return
      }

      // リトライ中（ログは WARN / 1 回のみ §2.4）
      logWarn('siteView.loadFailed', {
        event: 'siteView.loadFailed',
        errorCode,
        errorDescription,
        url: validatedURL,
        attempt: state.attempt,
        retryDelayMs: delayMs,
      })
      setTimeout(() => {
        loadSiteUrl(configManager.current.siteUrl)
      }, delayMs)
    },
  )

  // ── renderer プロセスクラッシュ復旧 (§8 / M-04 + Phase E E-9) ────────────
  overlayView.webContents.on('render-process-gone', (_event, details) => {
    logError('renderer.crashed', { view: 'overlay', reason: details.reason })
    void loadOverlay()
  })
  settingsView.webContents.on('render-process-gone', (_event, details) => {
    logError('renderer.crashed', { view: 'settings', reason: details.reason })
    void loadSettings()
  })
  hotspotView.webContents.on('render-process-gone', (_event, details) => {
    logError('renderer.crashed', { view: 'hotspot', reason: details.reason })
    // E-9 §8: hotspot 再ロード後に zone 状態を復元する（クラッシュで zone-disable が失われた場合）
    loadHotspot().then(() => {
      // toolbarVisible の現状態を hotspot に再適用してゾーン状態を復元する
      notifyAddressZoneEnabled(hotspotView.webContents, toolbarVisible)
    }).catch((e: unknown) => {
      logError('renderer.hotspotReloadFailed', {
        reason: e instanceof Error ? e.message : String(e),
      })
    })
  })
  // hotspot ロード完了時に zone-disable 状態を再適用する
  // （初回ロードのタイミング競合 / dev HMR でのリロードで zone-disable が失われるのを防ぐ）
  hotspotView.webContents.on('did-finish-load', () => {
    notifyAddressZoneEnabled(hotspotView.webContents, toolbarVisible)
  })
  // E-9: addressBarView クラッシュ復旧
  addressBarView.webContents.on('render-process-gone', (_event, details) => {
    logError('renderer.crashed', { view: 'addressBar', reason: details.reason })
    // 再ロード後に toolbarVisible を setToolbarVisible で再適用して
    // bounds / visibility / zone-disable 状態を完全に復元する
    loadAddressBar().then(() => {
      setToolbarVisible(toolbarVisible)
    }).catch((e: unknown) => {
      logError('renderer.addressBarReloadFailed', {
        reason: e instanceof Error ? e.message : String(e),
      })
    })
  })

  // ── 設定パネル 開閉 ────────────────────────────────────────────────────
  let settingsVisible = false
  // quitCoordinator は closeSettings / openSettings を参照するため、
  // 両者の定義後に初期化する。閉じるボタン等のコールバックは初期化後にのみ呼ばれる。
  // eslint-disable-next-line prefer-const
  let quitCoordinator!: QuitCoordinator

  const openSettings = (): void => {
    if (settingsVisible) {
      logWarn('settings.alreadyOpen', { event: 'settings.alreadyOpen' })
      return
    }
    settingsVisible = true
    settingsView.setVisible(true)
    settingsView.webContents.send('settings:open')
  }

  const closeSettings = (): void => {
    settingsVisible = false
    settingsView.setVisible(false)
    // C1 固着防止: パネルを閉じたときに確認待ち状態をリセットする (§B2 C1)
    quitCoordinator.disarm()
  }

  // settingsWebContents プロキシ:
  // settings:open が ipc.ts から送信される際に setVisible も同時に行う
  const settingsWebContentsProxy: WebContentsLike = {
    send(channel: string, ...args: unknown[]): void {
      if (channel === 'settings:open') {
        openSettings()
        // openSettings() が settings:open を renderer に送信するため早期リターン
        return
      }
      settingsView.webContents.send(channel, ...args)
    },
  }

  // ── QuitCoordinator 初期化 ──────────────────────────────────────────────
  // openSettings / closeSettings の定義後にここで初期化する（前方参照解決）。
  // 設定パネルの終了ボタン経路（app:request-quit IPC）に使用。Ctrl+Q は app.quit() 直呼び。
  quitCoordinator = new QuitCoordinator({
    quit: () => app.quit(),
    onArmedChange: (armed: boolean): void => {
      // if (armed) openSettings() は削除済み:
      //   Ctrl+Q は app.quit() 直呼びになったため、この経路は設定ボタン経由のみ。
      //   設定ボタン経由では既に設定パネルが開いており openSettings() は no-op だった（dead code）。
      //   白パネル問題（WSLg GPU 描画失敗）の原因コードを除去して回帰防止。
      // app:quit-armed IPC は維持: 設定パネル終了ボタンの UI フィードバック用
      if (!settingsView.webContents.isDestroyed()) {
        settingsView.webContents.send('app:quit-armed', armed)
      }
    },
    setTimeoutFn: setTimeout,
    clearTimeoutFn: clearTimeout,
  })

  // ── PlaybackOrchestrator 生成 (T24/T25) ────────────────────────────────
  const schedulerLogger: SchedulerLogger = {
    warn: (event, meta) => logWarn(event, meta),
    error: (event, meta) => logError(event, meta),
  }

  const orchestrator = new PlaybackOrchestrator({
    playlist,
    onPlay: (path: string) => {
      // overlayView を表示して overlay:play を送信
      // RAW ファイルパスを media:// URI に変換してから送信する
      overlayView.setVisible(true)
      overlayView.webContents.send('overlay:play', { path: toMediaUri(path) })
    },
    onSetVisible: (visible: boolean) => {
      overlayView.setVisible(visible)
    },
    intervalMinutes: config.intervalMinutes,
    loopEnabled: config.loopEnabled,
    logger: schedulerLogger,
  })

  // ── InputCoordinator (Ctrl+G / Ctrl+L / hotspot:tap) (T21/T22 + Phase E E-8) ──
  // hotspot:tap は ipc.ts で受信し InputCoordinator.recordTap() を呼ぶ。
  // 3 回カウント・トグルロジックは InputCoordinator が担う（UH-03/Wayland 対応）。
  // [E2E/[M] 検証: E2E-06, M-10]
  const inputCoordinator = new InputCoordinator({
    onOpenSettings: openSettings,
    onCloseSettings: closeSettings,
    isSettingsOpen: () => settingsVisible,
    globalShortcut: {
      register: (accelerator, callback) =>
        globalShortcut.register(accelerator, callback),
      unregister: (accelerator) =>
        globalShortcut.unregister(accelerator),
    },
    logger: {
      warn: (event, data) => logWarn(event, data),
      debug: (_event: string, _data?: Record<string, unknown>) => {
        /* デバッグログは省略 */
      },
    },
    isWayland,
    // E-8: Ctrl+L / 上部中央ゾーンタップ → アドレスバートグル
    onToggleAddressBar: () => {
      setToolbarVisible(!toolbarVisible)
    },
    // Ctrl+Q → 即終了（確認なし・描画状態に無依存）
    // 旧: quitCoordinator.requestQuit()（2段確認）→ 新: app.quit() 直呼び
    onQuit: () => app.quit(),
  })
  inputCoordinator.registerShortcut()
  // E-8: Ctrl+L ショートカット登録（Wayland では自動スキップ）
  inputCoordinator.registerAddressBarShortcut()
  // Ctrl+Q ショートカット登録（Wayland では自動スキップ）→ 即 app.quit()
  inputCoordinator.registerQuitShortcut()

  // 右クリック → 設定パネルを開く（Ctrl+G / 隅3タップに加わる第3経路 / ユーザー要望）
  // body は pointer-events:none で下層へ透過するため通常は siteView が右クリックを受けるが、
  // 隅ゾーン等の取りこぼしを避けるため overlay/hotspot にも同一ハンドラを結線する。
  const openSettingsOnContextMenu = (): void => {
    inputCoordinator.openSettingsByContextMenu()
  }
  siteView.webContents.on('context-menu', openSettingsOnContextMenu)
  overlayView.webContents.on('context-menu', openSettingsOnContextMenu)
  hotspotView.webContents.on('context-menu', openSettingsOnContextMenu)

  // ── IPC ハンドラ登録（起動時一度のみ）(T18/T20/T24 + Phase E E-7) ─────────
  // 実 ipcMain を IpcMainLike に変換してから渡す（構造的互換はあるが型シグネチャの
  // 差異を避けるため unknown を経由してキャスト）
  registerHandlers({
    ipcMain: ipcMain as unknown as IpcMainLike,
    settingsWebContents: settingsWebContentsProxy,
    configManager,
    orchestrator,
    dialog,
    logger: { error: logError, warn: logWarn },
    // T32-BE: videoFolderPath 変更時の watcher 再ポイント + playlist 再走査
    onFolderChange: (newPath: string): void => {
      currentVideoFolder = newPath
      applyFolderChange(newPath, watcher, playlist).catch((e: unknown) => {
        logError('watcher.repoint.failed', {
          reason: e instanceof Error ? e.message : String(e),
          path: newPath,
        })
      })
    },
    // T32-UI: siteUrl 変更時の siteView 再ロード（settings:update 経路）
    // 新しい URL へ切り替えるためリトライ状態をリセットしてから読み込む
    onSiteUrlChange: (url: string): void => {
      siteRetryState = createRetryState()
      loadSiteUrl(url)
    },
    // settings:close IPC 受信時にパネルを閉じる（sender 検証は ipc.ts 側で実施済み）
    onCloseSettings: closeSettings,
    // hotspot:tap IPC（隅タップ 1 回）を InputCoordinator に渡してカウント・トグルを担わせる
    onHotspotTap: () => { inputCoordinator.recordTap() },
    // E-7: addressbar View の WebContents（config 変更の broadcast 先）
    addressBarWebContents: addressBarView.webContents as WebContentsLike,
    // E-7: addressbar:navigate 受信後の siteView 再ロード
    onAddressBarNavigate: (url: string): void => {
      siteRetryState = createRetryState()
      loadSiteUrl(url)
    },
    // E-7 / E-8: アドレスバートグル（Ctrl+L / 上部中央ゾーンタップ → hotspot:address-bar-toggle）
    onToggleAddressBar: () => {
      setToolbarVisible(!toolbarVisible)
    },
    // E-7: addressbar:reload 受信後の siteView 再ロード
    onAddressBarReload: () => {
      siteRetryState = createRetryState()
      loadSiteUrl(configManager.current.siteUrl)
    },
    // 修正 B §B2: app:request-quit 受信 → QuitCoordinator.requestQuit()
    onRequestQuit: () => quitCoordinator.requestQuit(),
    // 修正 B §B2: settings renderer の WebContents id（C2 二層 sender 検証）
    settingsWebContentsId: settingsView.webContents.id,
  })

  // ── スリープ抑止 (T28 / §3.6) ────────────────────────────────────────
  powerBlockerId = powerSaveBlocker.start('prevent-display-sleep')
  // X11 環境では xset でスクリーンセーバーも無効化
  if (!isWayland) {
    exec('xset s off -dpms', (err) => {
      if (err !== null) {
        logWarn('power.xsetFailed', { reason: err.message })
      }
    })
  }

  // ── renderer URL ロードヘルパー ─────────────────────────────────────────
  const isDev = process.env['NODE_ENV'] === 'development'
  const devBaseUrl = process.env['ELECTRON_RENDERER_URL'] ?? ''

  /**
   * 指定した WebContentsView に renderer をロードする共通ヘルパー。
   * electron-vite dev はエントリをディレクトリ名直下で配信するため /src/renderer プレフィックス不要。
   * 生成される URL/file path は各 named 関数と完全一致する。
   */
  async function loadView(view: WebContentsView, seg: string): Promise<void> {
    if (isDev && devBaseUrl !== '') {
      await view.webContents.loadURL(`${devBaseUrl}/${seg}/index.html`)
    } else {
      await view.webContents.loadFile(join(__dirname, `../renderer/${seg}/index.html`))
    }
  }

  async function loadOverlay(): Promise<void> { return loadView(overlayView, 'overlay') }
  async function loadSettings(): Promise<void> { return loadView(settingsView, 'settings') }
  async function loadHotspot(): Promise<void> { return loadView(hotspotView, 'hotspot') }
  /** アドレスバー renderer を addressBarView にロードする (§9 E-3) */
  async function loadAddressBar(): Promise<void> { return loadView(addressBarView, 'addressbar') }

  // ── 各 View に URL をロード (Phase E §9 E-6: 起動時ロジック変更) ──────────
  // ⚠️ CRITICAL §9 E-6:
  //   旧コード: siteRetryState = onLoadStart(...); await siteView.webContents.loadURL(config.siteUrl)
  //   新コード: loadSiteUrl(config.siteUrl) に完全置換
  //     - url='' の場合: loadStartPage() → loadFile(startPagePath) → 黒画面なし
  //     - url=非空の場合: inLocalFallback=false → loadURL(url) → 既存動作
  //   直接 loadURL('') を呼ぶと接続エラーになるため loadSiteUrl 経由が必須。
  loadSiteUrl(config.siteUrl)

  // renderer View: 並列ロード（siteView と同時に開始）
  await Promise.all([loadOverlay(), loadSettings(), loadHotspot(), loadAddressBar()])

  // siteUrl='' の場合: 未設定 → アドレスバーを自動表示して URL 入力を促す (§2.3)
  // 全 renderer ロード後に表示（hotspot へ zone-disable が確実に届き、addressBar にフォーカスが乗る）
  if (config.siteUrl === '') {
    setToolbarVisible(true)
  }

  // ── Watcher 起動（フォルダパスが設定済みの場合のみ）───────────────────
  if (config.videoFolderPath !== '') {
    await watcher.start(config.videoFolderPath).catch((e: unknown) => {
      logError('watcher.startFailed', {
        reason: e instanceof Error ? e.message : String(e),
        path: config.videoFolderPath,
      })
    })
  }

  // ── クリーンアップ ─────────────────────────────────────────────────────
  app.on('will-quit', () => {
    inputCoordinator.unregisterShortcut()
    inputCoordinator.unregisterAddressBarShortcut()
    // 修正 B §B2: Ctrl+Q ショートカット解除
    inputCoordinator.unregisterQuitShortcut()
    void watcher.stop()
    orchestrator.dispose()
  })
}
