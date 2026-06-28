/**
 * Playwright Electron E2E ハーネス — WebContentsView 取得可否スパイク (T07.5)
 *
 * ## 目的
 * `_electron.launch()` で BaseWindow + WebContentsView 構成のアプリを起動し、
 * 各 View の Page が Playwright から取得・操作できるかを早期検証する。
 *
 * ## 既知制約 (§9.4)
 * Playwright `_electron` は BrowserWindow には対応しているが、
 * BaseWindow + WebContentsView 構成では View の Page が取得できない可能性がある。
 * `webContentsViewAccessible` が false の場合、テストは skip され、
 * README の「WebdriverIO 移行メモ」を参照すること。
 *
 * ## 使い方
 * ```ts
 * const handle = await launchApp();
 * if (!handle.webContentsViewAccessible) {
 *   test.skip(true, 'WebContentsView 取得不可 — WDIO 移行が必要');
 * }
 * // ... テスト本体 ...
 * await teardownApp(handle);
 * ```
 */

import { _electron as electron } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import * as path from 'path';
import * as fs from 'fs';

// --------------------------------------------------------------------------
// 定数
// --------------------------------------------------------------------------

/** Electron アプリのエントリポイント（npm run build で生成）*/
export const APP_ENTRY = path.resolve(__dirname, '../../../out/main/index.js');

/**
 * 各 View の renderer HTML ファイルパス末尾。
 * dev（http://localhost:PORT/overlay/index.html）と
 * prod（file:///…/renderer/overlay/index.html）の両方で endsWith() が一致する。
 */
const VIEW_RENDERER_PATHS = {
  overlay: '/overlay/index.html',
  settings: '/settings/index.html',
  hotspot: '/hotspot/index.html',
  addressbar: '/addressbar/index.html',
} as const;

// --------------------------------------------------------------------------
// 型定義
// --------------------------------------------------------------------------

/** 識別済みの View ページ（取得できなかった View は null）*/
export interface ViewPages {
  overlayPage: Page | null;
  settingsPage: Page | null;
  hotspotPage: Page | null;
  /** siteView（外部 URL を表示する View）*/
  sitePage: Page | null;
  /** addressBarView（アドレスバー UI）*/
  addressBarPage: Page | null;
}

/** launchApp の戻り値 */
export interface LaunchResult {
  app: ElectronApplication;
  /** 取得できた全ページ */
  allPages: Page[];
  /** 識別済み View ページ */
  views: ViewPages;
  /**
   * WebContentsView の Page が Playwright から取得できたか否か。
   *
   * **false の場合の対応:**
   * - テストを skip し `test/e2e/README.md` の「WebdriverIO 移行メモ」を参照する。
   * - WebdriverIO + wdio-electron-service への移行を検討すること（工数目安: 2〜3 日）。
   *
   * **取得可否の判定基準:**
   * `electronApp.windows()` が 1 件以上のページを返せば `true` とする。
   * 0 件の場合は BaseWindow + WebContentsView 構成への対応が不十分と判定し `false` を返す。
   */
  webContentsViewAccessible: boolean;
}

// --------------------------------------------------------------------------
// 公開関数
// --------------------------------------------------------------------------

/**
 * Electron アプリを起動し、WebContentsView の Page 取得を試みる。
 *
 * @param envOverrides - プロセス環境変数の上書き（例: `{ SIGNAGE_INTERVAL_OVERRIDE: '1' }`）
 */
export async function launchApp(envOverrides?: Record<string, string>): Promise<LaunchResult> {
  // ビルド未完了チェック: 明確なエラーメッセージを出す
  if (!fs.existsSync(APP_ENTRY)) {
    throw new Error(
      `[E2E harness] アプリのビルド成果物が見つかりません: ${APP_ENTRY}\n` +
        'E2E テスト実行前に `npm run build` を実行してください。',
    );
  }

  // 安全に process.env を Record<string, string> へ変換（undefined 値を除外）
  const inheritedEnv: Record<string, string> = Object.entries(process.env).reduce<
    Record<string, string>
  >((acc, [k, v]) => {
    if (v !== undefined) acc[k] = v;
    return acc;
  }, {});

  const app = await electron.launch({
    args: [APP_ENTRY],
    env: {
      ...inheritedEnv,
      NODE_ENV: 'test',
      ...envOverrides,
    },
  });

  // --------------------------------------------------------------------------
  // WebContentsView ページ取得試行
  // --------------------------------------------------------------------------

  // 最初のウィンドウが現れるのを待つ（最大 10 秒）
  // BaseWindow + WebContentsView 構成では firstWindow() が解決しない場合がある
  const firstWindowOrTimeout = await Promise.race<Page | null>([
    app.firstWindow().then((p) => p),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), 10_000)),
  ]);

  if (firstWindowOrTimeout === null) {
    console.warn(
      '[E2E harness] 10 秒待機しましたがウィンドウが検出されませんでした。\n' +
        '  BaseWindow + WebContentsView 構成では firstWindow() が解決しない可能性があります。\n' +
        '  (§9.4 既知制約)',
    );
  }

  // 全 View の初期化を待つための追加待機
  await delay(2_000);

  const allPages = app.windows();
  const webContentsViewAccessible = allPages.length > 0;

  if (!webContentsViewAccessible) {
    console.error(
      '[E2E harness] ⚠ WebContentsView のページ取得に失敗しました（0 件）。\n' +
        '\n' +
        '  Playwright _electron は BaseWindow + WebContentsView 構成で\n' +
        '  View の Page を取得できない可能性があります（計画書 §9.4）。\n' +
        '\n' +
        '  対応: WebdriverIO + wdio-electron-service への移行を検討してください。\n' +
        '  移行メモは test/e2e/README.md を参照。\n' +
        '  工数目安: 2〜3 日',
    );
  } else {
    console.log(`[E2E harness] ${allPages.length} ページを取得しました。`);
    allPages.forEach((p, i) => {
      console.log(`  [${i}] ${p.url()}`);
    });
  }

  const views = identifyViews(allPages);

  if (webContentsViewAccessible) {
    if (!views.overlayPage) console.warn('[E2E harness] overlayPage が識別できませんでした');
    if (!views.settingsPage) console.warn('[E2E harness] settingsPage が識別できませんでした');
    if (!views.hotspotPage) console.warn('[E2E harness] hotspotPage が識別できませんでした');
    if (!views.sitePage) console.warn('[E2E harness] sitePage が識別できませんでした');
    // addressBarPage は実装完了後に検出される（フェーズ E 完了まで null が正常）
    if (!views.addressBarPage)
      console.info('[E2E harness] addressBarPage が識別できませんでした（実装完了後に有効）');
  }

  return { app, allPages, views, webContentsViewAccessible };
}

/**
 * アプリを終了する。beforeAll/afterAll または try/finally で必ず呼ぶこと。
 */
export async function teardownApp(handle: LaunchResult): Promise<void> {
  try {
    await handle.app.close();
  } catch {
    // close に失敗しても後続処理を止めない
  }
}

// --------------------------------------------------------------------------
// 内部ユーティリティ
// --------------------------------------------------------------------------

/**
 * レンダラーパスの末尾一致で各 View を識別する。
 *
 * VIEW_RENDERER_PATHS の値（例: '/overlay/index.html'）で endsWith() 判定するため、
 * 外部サイト URL が 'settings'/'overlay' 等を含んでいても siteView と誤分類しない。
 *
 * siteView 判定: 「既知 renderer path のいずれにも一致しない http(s) URL」
 * （about:blank / about:srcdoc / file: URL は siteView に含めない）
 *
 * 正常時は従来と同じ 4 renderer view + site の判定結果を返す。
 */
function identifyViews(pages: Page[]): ViewPages {
  const result: ViewPages = {
    overlayPage: null,
    settingsPage: null,
    hotspotPage: null,
    sitePage: null,
    addressBarPage: null,
  };

  for (const page of pages) {
    const url = page.url();

    if (url.endsWith(VIEW_RENDERER_PATHS.overlay)) {
      result.overlayPage = page;
    } else if (url.endsWith(VIEW_RENDERER_PATHS.settings)) {
      result.settingsPage = page;
    } else if (url.endsWith(VIEW_RENDERER_PATHS.hotspot)) {
      result.hotspotPage = page;
    } else if (url.endsWith(VIEW_RENDERER_PATHS.addressbar)) {
      result.addressBarPage = page;
    } else if (url.startsWith('http://') || url.startsWith('https://')) {
      // 既知のレンダラーパスに一致しない http(s) URL を siteView と判定
      result.sitePage = page;
    }
  }

  return result;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
