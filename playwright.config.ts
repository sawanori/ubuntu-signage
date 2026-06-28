/**
 * Playwright 設定 — Electron E2E テスト専用
 *
 * 実行前提:
 *   - `npm run build` で out/main/index.js が生成されていること
 *   - 表示サーバが利用可能であること（または xvfb-run 経由）
 *
 * 実行コマンド:
 *   npm run test:e2e           # xvfb-run -a playwright test
 *
 * 注意:
 *   - ブラウザ DL は不要（Electron が自前の Chromium を持つため）
 *   - Vitest との併用: vitest.config.ts で test/e2e を exclude 済み
 */
import { defineConfig } from '@playwright/test';

export default defineConfig({
  /** E2E テストディレクトリ */
  testDir: 'test/e2e',

  /** テストファイルのパターン */
  testMatch: '**/*.spec.ts',

  /**
   * テストタイムアウト（ms）
   * E2E-01 は 1 分間隔での発火を待つため 120s を確保する
   */
  timeout: 120_000,

  /** expect のタイムアウト */
  expect: {
    timeout: 15_000,
  },

  /**
   * Electron アプリを複数同時起動するとリソース競合が発生するため
   * 直列実行（workers: 1）にする
   */
  fullyParallel: false,
  workers: 1,

  /** CI ではリトライなし。失敗したら即座に報告する */
  retries: 0,

  reporter: [
    ['list'],
    ['html', { open: 'never', outputFolder: 'playwright-report' }],
  ],

  use: {
    /**
     * Electron テストではブラウザを使用しない。
     * _electron.launch() で Electron アプリを直接起動する。
     */
  },
});
