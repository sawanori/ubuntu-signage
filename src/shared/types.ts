// shared/types.ts — アプリ共通ドメイン型・IPC ペイロード型

/** アプリ設定 */
export type Config = {
  /** 表示するサイネージサイトの URL */
  siteUrl: string
  /** 動画フォルダの絶対パス */
  videoFolderPath: string
  /** 割り込み間隔（分）: 1 | 5 | 10 | 15 | 30 */
  intervalMinutes: 1 | 5 | 10 | 15 | 30
  /** 広告割り込み機能の有効/無効 */
  loopEnabled: boolean
  /** フェード時間（ms） */
  fadeDurationMs: number
}

/** プレイリスト状態 */
export type PlaylistState = {
  /** ソート済みファイル名リスト（絶対パス） */
  files: readonly string[]
  /** 最後に再生したファイル名（basename）。null = 未再生 */
  lastPlayedFileName: string | null
}

/** スケジューラ状態 */
export type SchedulerState = 'IDLE' | 'FADE_IN' | 'PLAYING' | 'FADE_OUT'

// IPC payload 型
export type OverlayPlayPayload = { path: string }
export type OverlayPlayedPayload = { path: string }
export type OverlayErrorPayload = { path: string; reason: string }
export type OverlayDurationReadyPayload = { ms: number }
export type SettingsFolderPickedPayload = { folderPath: string | null }
