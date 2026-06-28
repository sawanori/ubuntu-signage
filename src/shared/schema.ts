/**
 * shared/schema.ts — T10: zod スキーマ定義
 *
 * ConfigSchema      : Config の完全検証スキーマ（configManager.load() での復元値検証）
 * ConfigUpdateSchema: settings:update payload の部分更新検証スキーマ（IPC ハンドラでの
 *                     ランタイム検証。不正 URL スキーム・interval 値外を拒否する）
 *
 * electron-store 連携・デフォルト値は T11(ConfigManager) で扱う。
 */

import { z } from 'zod'

/**
 * http / https スキームのみを許可する URL 検証
 * - javascript:// / ftp:// / file:// / data: 等を拒否する
 */
const httpHttpsUrlSchema = z.string().refine(
  (url: string): boolean => {
    try {
      const parsed = new URL(url)
      return parsed.protocol === 'http:' || parsed.protocol === 'https:'
    } catch {
      return false
    }
  },
  { message: 'siteUrl must use http or https scheme' }
)

/**
 * 許可された intervalMinutes 値の共用体リテラル
 * 仕様: 1 | 5 | 10 | 15 | 30 のみ有効
 */
const intervalMinutesSchema = z.union([
  z.literal(1),
  z.literal(5),
  z.literal(10),
  z.literal(15),
  z.literal(30),
])

/**
 * 空文字（未設定）または http/https URL を許容する。
 *
 * - 空文字 = スタート画面表示（ネットワークアクセスなし）
 * - http/https = サイネージ URL
 */
const optionalSiteUrlSchema = z.union([z.literal(''), httpHttpsUrlSchema])

/**
 * ConfigSchema — アプリ設定の完全検証スキーマ
 *
 * 用途:
 *   - configManager.load() で取得値を検証し、型不正を検出する
 *   - z.infer<typeof ConfigSchema> と Config の等価性は型テスト（schema.test.ts の C5）で担保
 *
 * 検証ルール:
 *   - siteUrl      : 空文字（未設定）または http/https スキームの URL を許可
 *   - intervalMinutes: {1, 5, 10, 15, 30} のみ許可（仕様外の値は拒否）
 *   - fadeDurationMs : 正の整数のみ許可
 */
export const ConfigSchema = z.object({
  siteUrl: optionalSiteUrlSchema,
  videoFolderPath: z.string(),
  intervalMinutes: intervalMinutesSchema,
  loopEnabled: z.boolean(),
  fadeDurationMs: z.number().int().positive(),
})

/**
 * ConfigUpdateSchema — settings:update payload の部分更新検証スキーマ
 *
 * 用途:
 *   - ipcController で settings:update を受信したときのランタイム検証
 *   - ConfigSchema を .partial() したもの（全フィールドを省略可能にした Partial<Config>）
 *
 * 検証ルール:
 *   - 存在する場合は ConfigSchema と同じルールを適用する
 *   - siteUrl に javascript:// / ftp:// 等の不正スキームを拒否する
 *   - intervalMinutes が {1,5,10,15,30} 以外の場合は拒否する
 *   - videoFolderPath の存在確認は ConfigManager の責務（ここでは文字列のみ検証）
 */
export const ConfigUpdateSchema = ConfigSchema.partial()
