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

/** スケジューラ状態 */
export type SchedulerState = 'IDLE' | 'FADE_IN' | 'PLAYING' | 'FADE_OUT'

