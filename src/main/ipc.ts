/**
 * T18/T20 — src/main/ipc.ts
 *
 * IPC チャンネル登録と信頼境界実装 (§3.5)
 *
 * 責務:
 *   - 全 IPC ハンドラを起動時一度だけ登録する（冪等性保証）
 *   - 各チャネルで event.senderFrame.url を View 別 allowlist と照合する
 *   - allowlist 外の sender は即拒否し ERROR ログ {event:"ipc.invalidSender"} を出す
 *   - settings:update の payload を ConfigUpdateSchema (zod) で検証する
 *     （configManager.applyUpdate() に委譲）
 *   - ConfigManager と PlaybackOrchestrator を IPC と結線する
 *
 * 設計方針:
 *   - Electron を直接 import しない（DI で注入）→ Node.js 環境でユニットテスト可能
 *   - IpcConfigManager / IpcOrchestrator インターフェース経由で依存を抽象化する
 */

import type { Config } from '../shared/types'
import { normalizeUrlInput } from '../shared/url-normalize'

// ─── 公開インターフェース ──────────────────────────────────────────────────────

/**
 * ipcMain.handle / ipcMain.on が受け取るイベントの最小インターフェース。
 * Electron の IpcMainEvent / IpcMainInvokeEvent の共通部分。
 */
export interface IpcEvent {
  /** 送信元フレーム情報。sandbox / contextIsolation 環境では null の場合がある */
  senderFrame: { url: string } | null
  /**
   * 送信元 WebContents の参照（C2: WebContents id 同一性検証に使用）。
   * Electron の IpcMainEvent.sender に相当。省略可（後方互換）。
   */
  sender?: { id: number }
}

/** ipcMain の最小インターフェース（テストでモック注入可能） */
export interface IpcMainLike {
  handle(
    channel: string,
    listener: (event: IpcEvent, payload?: unknown) => unknown
  ): void
  on(
    channel: string,
    listener: (event: IpcEvent, payload?: unknown) => void
  ): void
}

/** 構造化ログの最小インターフェース */
export interface IpcLogger {
  error(event: string, meta?: Record<string, unknown>): void
  warn(event: string, meta?: Record<string, unknown>): void
}

/** WebContents の最小インターフェース（Main → renderer への送信） */
export interface WebContentsLike {
  send(channel: string, ...args: unknown[]): void
}

/** dialog の最小インターフェース（フォルダ選択ダイアログ） */
export interface DialogLike {
  showOpenDialog(options: {
    properties: ('openDirectory' | 'createDirectory')[]
  }): Promise<{ canceled: boolean; filePaths: string[] }>
}

/**
 * ConfigManager の最小インターフェース。
 * ConfigManager クラスはこのインターフェースを構造的に満たす。
 */
export interface IpcConfigManager {
  /** 現在メモリに保持している設定（コピーを返す） */
  readonly current: Config
  /**
   * 設定の部分更新を適用する。
   * 内部で ConfigUpdateSchema (zod) による検証を行い、不正値は拒否する。
   * @returns 更新後の Config、または検証失敗時は null
   */
  applyUpdate(update: unknown): Config | null
}

/**
 * PlaybackOrchestrator の最小インターフェース。
 * PlaybackOrchestrator クラスはこのインターフェースを構造的に満たす。
 */
export interface IpcOrchestrator {
  notifyFadeInDone(): void
  notifyDurationReady(ms: number): void
  notifyPlayed(): void
  notifyError(): void
  notifyFadeOutDone(): void
  testPlay(): void
  updateConfig(partial: {
    intervalMinutes?: 1 | 5 | 10 | 15 | 30
    loopEnabled?: boolean
  }): void
}

/** registerHandlers に渡す依存オブジェクト */
export interface RegisterHandlersDeps {
  /** IPC ハンドラ登録先 */
  ipcMain: IpcMainLike
  /** settings renderer への送信（settings:open / settings:updated） */
  settingsWebContents: WebContentsLike
  /** 設定管理（読み書き・zod 検証） */
  configManager: IpcConfigManager
  /** スケジューラ＋プレイリストオーケストレーター */
  orchestrator: IpcOrchestrator
  /** フォルダ選択ダイアログ */
  dialog: DialogLike
  /** 構造化ロガー */
  logger: IpcLogger
  /**
   * videoFolderPath が変化したときに呼ばれるフック（省略可）。
   * 実体（watcher 再ポイント等）は Phase5 統合層 index.ts で配線する。
   */
  onFolderChange?: (path: string) => void
  /**
   * siteUrl が変化したときに呼ばれるフック（省略可）。
   * 実体（siteView.loadURL 等）は Phase5 統合層 index.ts で配線する。
   */
  onSiteUrlChange?: (url: string) => void
  /**
   * settings:close IPC 受信後（sender 検証済み）に呼ばれるフック（省略可）。
   * 実体（settingsView.setVisible(false) 等）は Phase5 統合層 index.ts で配線する。
   */
  onCloseSettings?: () => void
  /**
   * hotspot:tap IPC（隅タップ 1 回）受信後（sender 検証済み）に呼ばれるフック（省略可）。
   * 実体（InputCoordinator.recordTap()）は Phase5 統合層 index.ts で配線する。
   * 3 回カウント・トグルロジックは InputCoordinator 側が担う。
   */
  onHotspotTap?: () => void
  /**
   * addressBarView の WebContents（config 変更の broadcast 先）。
   * 省略可（テストで不要な場合）。
   */
  addressBarWebContents?: WebContentsLike
  /**
   * アドレスバーのナビゲーション要求時フック（applyUpdate 後）。
   * siteView の再ロードを index.ts で担う。URL が変化した場合のみ呼ばれる。
   */
  onAddressBarNavigate?: (url: string) => void
  /**
   * toolbar の表示/非表示トグル要求（Ctrl+L / 上部中央ゾーン）。
   */
  onToggleAddressBar?: () => void
  /**
   * siteView のリロード要求（addressbar:reload）。
   */
  onAddressBarReload?: () => void
  /**
   * 'app:request-quit' IPC 受信後（二層 sender 検証済み）に呼ばれるフック（省略可）。
   * 実体（QuitCoordinator.requestQuit()）は index.ts で配線する。
   * 未定義の場合は WARN(ipc.quitCallbackNotSet) を出力する（サイレント障害なし）。
   */
  onRequestQuit?: () => void
  /**
   * settings renderer の WebContents id（C2: WebContents id 同一性検証用）。
   * 指定した場合、app:request-quit の sender.id がこの値と一致しなければ拒否する。
   * 省略した場合は id 検証をスキップする（後方互換モード）。
   */
  settingsWebContentsId?: number
}

// ─── 内部ヘルパー ─────────────────────────────────────────────────────────────

/**
 * senderFrame の URL が特定の View 由来かどうかを判定する。
 *
 * 判定ルール（開発・本番両対応）:
 *   - 開発: http://localhost:5173/overlay/index.html → localhost オリジン + `/overlay/` パス
 *   - 本番: file:///path/renderer/overlay/index.html → file: プロトコル + `/overlay/` パス
 *   - 空文字（senderFrame が null の場合）→ 常に false
 *
 * 部分文字列 includes による spoof（https://overlay.attacker.com/ 等）を塞ぐために
 * URL をパースしてオリジンを厳密に確認してからパスを照合する。
 */
function isUrlFromView(url: string, viewName: string): boolean {
  if (!url) return false

  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }

  const proto = parsed.protocol
  const host = parsed.hostname

  // file: (本番パッケージ) または localhost (開発サーバー) のみを許可する
  const isAllowedOrigin =
    proto === 'file:' ||
    ((proto === 'http:' || proto === 'https:') && host === 'localhost')

  if (!isAllowedOrigin) return false

  // pathname が /<viewName>/ セグメントを含むことを確認する
  const pathname = parsed.pathname.toLowerCase()
  return pathname.includes(`/${viewName}/`) || pathname.includes(`/${viewName}.`)
}

/**
 * event.senderFrame の URL を View 別 allowlist で照合する。
 *
 * allowlist 外の sender の場合は ERROR ログ {event:"ipc.invalidSender"} を出し false を返す。
 * allowlist 内の sender の場合は true を返す。
 */
function validateSender(
  event: IpcEvent,
  expectedView: string,
  channel: string,
  logger: IpcLogger
): boolean {
  const url = event.senderFrame?.url ?? ''
  if (!isUrlFromView(url, expectedView)) {
    logger.error('ipc.invalidSender', {
      event: 'ipc.invalidSender',
      channel,
      sender: url,
      expectedView,
    })
    return false
  }
  return true
}

// ─── IPC ハンドラ登録 ─────────────────────────────────────────────────────────

/**
 * 全 IPC チャンネルのハンドラを登録する。
 *
 * 起動時に一度だけ呼ぶこと（再呼び出しはハンドラ二重登録になる）。
 * Electron の ipcMain を直接 import せず、deps.ipcMain 経由で操作するため
 * Node.js 環境（Vitest）でのユニットテストが可能。
 */
export function registerHandlers(deps: RegisterHandlersDeps): void {
  const {
    ipcMain,
    settingsWebContents,
    configManager,
    orchestrator,
    dialog,
    logger,
    onFolderChange,
    onSiteUrlChange,
    onCloseSettings,
    onHotspotTap,
    addressBarWebContents,
    onAddressBarNavigate,
    onToggleAddressBar,
    onAddressBarReload,
    onRequestQuit,
    settingsWebContentsId,
  } = deps

  // ─── overlay チャンネル（overlay renderer → Main）─────────────────────────

  /** overlay:played — 再生完了通知 → Scheduler へ PLAYING→FADE_OUT 遷移を通知 */
  ipcMain.on('overlay:played', (event) => {
    if (!validateSender(event, 'overlay', 'overlay:played', logger)) return
    orchestrator.notifyPlayed()
  })

  /** overlay:error — 再生エラー通知 → {path,reason} をログ後、Scheduler へ強制 IDLE 復帰を通知（§8/UT-08〜10） */
  ipcMain.on('overlay:error', (event, payload) => {
    if (!validateSender(event, 'overlay', 'overlay:error', logger)) return
    const p = payload as { path?: unknown; reason?: unknown } | undefined
    logger.error('overlay.videoError', {
      path: typeof p?.path === 'string' ? p.path : undefined,
      reason: typeof p?.reason === 'string' ? p.reason : undefined,
    })
    orchestrator.notifyError()
  })

  /**
   * overlay:duration-ready — 動画長通知。
   * loadedmetadata で確定した ms を受け取り、ウォッチドッグタイマーを更新する。
   */
  ipcMain.on('overlay:duration-ready', (event, payload) => {
    if (!validateSender(event, 'overlay', 'overlay:duration-ready', logger)) return
    const p = payload as { ms?: unknown } | undefined
    if (typeof p?.ms === 'number') {
      orchestrator.notifyDurationReady(p.ms)
    }
  })

  /** overlay:fade-in-done — フェードイン完了 → FADE_IN→PLAYING 遷移 */
  ipcMain.on('overlay:fade-in-done', (event) => {
    if (!validateSender(event, 'overlay', 'overlay:fade-in-done', logger)) return
    orchestrator.notifyFadeInDone()
  })

  /** overlay:fade-out-done — フェードアウト完了 → FADE_OUT→IDLE 遷移・タイマー再装填 */
  ipcMain.on('overlay:fade-out-done', (event) => {
    if (!validateSender(event, 'overlay', 'overlay:fade-out-done', logger)) return
    orchestrator.notifyFadeOutDone()
  })

  // ─── settings チャンネル（settings renderer → Main）──────────────────────

  /**
   * settings:get — 現在設定の取得要求。
   * configManager.current を返す（呼び出し元は settings:current チャンネルを待たず
   * invoke の戻り値で受け取る）。
   */
  ipcMain.handle('settings:get', (event) => {
    if (!validateSender(event, 'settings', 'settings:get', logger)) return null
    return configManager.current
  })

  /**
   * settings:update — 設定変更要求。
   *
   * フロー:
   *   1. sender allowlist 照合（settingsView 以外は拒否）
   *   2. configManager.applyUpdate(payload) → 内部で ConfigUpdateSchema 検証
   *   3. 検証 OK → Scheduler へ設定反映 + settings:updated 送信
   *   4. 検証 NG → null 返却（ログは configManager 側が出力済み）
   */
  ipcMain.handle('settings:update', (event, payload) => {
    if (!validateSender(event, 'settings', 'settings:update', logger)) return null
    const prevConfig = configManager.current
    // siteUrl が含まれる場合のみスキーム補完を適用する（元の payload を変異させない）
    let updatePayload = payload
    if (
      payload &&
      typeof payload === 'object' &&
      typeof (payload as { siteUrl?: unknown }).siteUrl === 'string'
    ) {
      updatePayload = {
        ...(payload as object),
        siteUrl: normalizeUrlInput((payload as { siteUrl: string }).siteUrl),
      }
    }
    const updated = configManager.applyUpdate(updatePayload)
    if (updated === null) return null
    orchestrator.updateConfig({
      intervalMinutes: updated.intervalMinutes,
      loopEnabled: updated.loopEnabled,
    })
    // 動的切替フック: 値が変化した場合のみ呼び出す（実体は Phase5 統合層で配線）
    if (onFolderChange && updated.videoFolderPath !== prevConfig.videoFolderPath) {
      onFolderChange(updated.videoFolderPath)
    }
    if (onSiteUrlChange && updated.siteUrl !== prevConfig.siteUrl) {
      onSiteUrlChange(updated.siteUrl)
    }
    settingsWebContents.send('settings:updated', updated)
    addressBarWebContents?.send('addressbar:config-updated', updated)
    return updated
  })

  /** settings:close — 設定パネル閉じ要求。sender 検証後に onCloseSettings コールバックへ委譲。 */
  ipcMain.on('settings:close', (event) => {
    if (!validateSender(event, 'settings', 'settings:close', logger)) return
    onCloseSettings?.()
  })

  /** settings:test-play — 今すぐテスト再生要求。IDLE 時のみ有効（Scheduler 側でチェック）。 */
  ipcMain.on('settings:test-play', (event) => {
    if (!validateSender(event, 'settings', 'settings:test-play', logger)) return
    orchestrator.testPlay()
  })

  /**
   * settings:pick-folder — フォルダ選択ダイアログ要求。
   * Main プロセスが dialog.showOpenDialog を呼び、結果を返す。
   */
  ipcMain.handle('settings:pick-folder', async (event) => {
    if (!validateSender(event, 'settings', 'settings:pick-folder', logger)) {
      return { folderPath: null }
    }
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory', 'createDirectory'],
    })
    return {
      folderPath: result.canceled ? null : (result.filePaths[0] ?? null),
    }
  })

  // ─── hotspot チャンネル（hotspot renderer → Main）────────────────────────

  /**
   * hotspot:tap — 隅タップ 1 回通知。
   * onHotspotTap コールバック（InputCoordinator.recordTap()）へ委譲する。
   * 3 回カウント・トグルロジックは InputCoordinator が担う（UH-03/Wayland 対応）。
   */
  ipcMain.on('hotspot:tap', (event) => {
    if (!validateSender(event, 'hotspot', 'hotspot:tap', logger)) return
    onHotspotTap?.()
  })

  /**
   * hotspot:address-bar-toggle — 上部中央ゾーン単一タップ通知（Wayland フォールバック）。
   * onToggleAddressBar コールバック（InputCoordinator.toggleAddressBarZone()）へ委譲する。
   */
  ipcMain.on('hotspot:address-bar-toggle', (event) => {
    if (!validateSender(event, 'hotspot', 'hotspot:address-bar-toggle', logger)) return
    onToggleAddressBar?.()
  })

  // ─── addressbar チャンネル（addressbar renderer → Main）──────────────────

  /**
   * addressbar:get-config — 現在設定の取得要求。
   * configManager.current を返す（addressbar renderer の初期化用）。
   */
  ipcMain.handle('addressbar:get-config', (event) => {
    if (!validateSender(event, 'addressbar', 'addressbar:get-config', logger)) return null
    return configManager.current
  })

  /**
   * addressbar:navigate — URL ナビゲーション要求。
   *
   * フロー:
   *   1. sender allowlist 照合（addressBarView 以外は拒否）
   *   2. configManager.applyUpdate({siteUrl: url}) → ConfigUpdateSchema 検証
   *   3. 検証 NG → {ok: false, message} を返す（addressbar:navigate-error IPC は発行しない）
   *   4. 検証 OK → broadcast + URL 変化時のみ onAddressBarNavigate 呼び出し
   *   5. {ok: true, config: updated} を返す
   */
  ipcMain.handle('addressbar:navigate', (event, payload) => {
    if (!validateSender(event, 'addressbar', 'addressbar:navigate', logger)) return null
    const p = payload as { url?: unknown } | undefined
    const url = normalizeUrlInput(typeof p?.url === 'string' ? p.url : '')
    const prevConfig = configManager.current
    const updated = configManager.applyUpdate({ siteUrl: url })
    if (updated === null) {
      return { ok: false, message: 'URL validation failed' }
    }
    settingsWebContents.send('settings:updated', updated)
    addressBarWebContents?.send('addressbar:config-updated', updated)
    if (onAddressBarNavigate && updated.siteUrl !== prevConfig.siteUrl) {
      onAddressBarNavigate(updated.siteUrl)
    }
    return { ok: true, config: updated }
  })

  /**
   * addressbar:toggle-loop — loopEnabled トグル要求。
   *
   * フロー:
   *   1. sender allowlist 照合（addressBarView 以外は拒否）
   *   2. configManager.applyUpdate({loopEnabled: !current.loopEnabled})
   *   3. 成功 → orchestrator 更新 + settingsWebContents / addressBarWebContents に broadcast
   *   4. 戻り値: 更新後 Config or null（楽観的更新禁止: renderer は戻り値でのみ UI 更新）
   */
  ipcMain.handle('addressbar:toggle-loop', (event) => {
    if (!validateSender(event, 'addressbar', 'addressbar:toggle-loop', logger)) return null
    const updated = configManager.applyUpdate({ loopEnabled: !configManager.current.loopEnabled })
    if (updated === null) return null
    orchestrator.updateConfig({ loopEnabled: updated.loopEnabled })
    settingsWebContents.send('settings:updated', updated)
    addressBarWebContents?.send('addressbar:config-updated', updated)
    return updated
  })

  /**
   * addressbar:reload — siteView の再ロード要求。
   * onAddressBarReload コールバックへ委譲する。
   */
  ipcMain.on('addressbar:reload', (event) => {
    if (!validateSender(event, 'addressbar', 'addressbar:reload', logger)) return
    onAddressBarReload?.()
  })

  // ─── アプリ終了チャンネル（settings renderer → Main）────────────────────────

  /**
   * app:request-quit — 終了確認フロー（2段押し）の起動要求。
   *
   * 二層 sender 検証 (§4-B2):
   *   Layer 1: senderFrame.url が settings View 由来かどうかを allowlist で照合。
   *   Layer 2: settingsWebContentsId が指定されている場合、sender.id と照合する（C2）。
   *            id 不一致は 'webContents id mismatch' 理由でログ出力して拒否する。
   *
   * onRequestQuit が未定義の場合はサイレント障害を避けるため WARN を出力する。
   */
  ipcMain.on('app:request-quit', (event) => {
    // Layer 1: URL allowlist 照合（settings View のみ許可）
    if (!validateSender(event, 'settings', 'app:request-quit', logger)) return

    // Layer 2: WebContents id 同一性検証（settingsWebContentsId が指定された場合のみ）
    if (settingsWebContentsId !== undefined) {
      const senderId = event.sender?.id
      if (senderId !== settingsWebContentsId) {
        logger.error('ipc.invalidSender', {
          event: 'ipc.invalidSender',
          channel: 'app:request-quit',
          reason: 'webContents id mismatch',
          expectedId: settingsWebContentsId,
          actualId: senderId,
        })
        return
      }
    }

    // コールバック未定義はサイレント障害なし（WARN で通知）
    if (!onRequestQuit) {
      logger.warn('ipc.quitCallbackNotSet', { channel: 'app:request-quit' })
      return
    }

    onRequestQuit()
  })
}
