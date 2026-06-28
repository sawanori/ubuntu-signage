/**
 * E2E-20: アドレスバー機能 全ケース
 *
 * 仕様 (計画書 §7.3, §2, §6):
 *   前提: npm run build 済み・xvfb または実 GUI 環境
 *   対象機能:
 *     - 起動時状態（siteUrl='' → startPage 表示・アドレスバー自動表示）
 *     - アドレスバー表示/非表示トグル（Ctrl+L, 上部中央ゾーン 1 タップ）
 *     - URL ナビゲーション（Enter / [表示]ボタン）・バリデーション・成功後自動非表示
 *     - ロード失敗フォールバック（3 回リトライ → startPage, アドレスバー自動表示）
 *     - ループトグル三者同期（addressBar ↔ settingsView ↔ config）
 *     - z 順（overlayView が addressBarView を完全カバー）
 *     - CRITICAL: フォーカス横取り禁止（hotspot zone-disable）
 *     - CRITICAL: inLocalFallback 無限ループ防止
 *     - CRITICAL: stale SettingsController._config トグル防止
 *     - レグレッション（既存: Ctrl+G / 隅 3 タップ → 設定パネル）
 *     - siteUrl='http://localhost:8080' マイグレーション検証
 *     - リサイズ時 bounds 再計算
 *
 * 確定設計判断（マネージャー §10 より）:
 *   §10.1: did-finish-load かつ !failedSinceStart の場合のみ setToolbarVisible(false)
 *   §10.5: .zone-top-center の height は 32px（width 200px）
 *
 * 未実装挙動について:
 *   アドレスバー実装（Phase D-E）が完了するまで、各テストは test.fixme でマークする。
 *   実機（Raspberry Pi / xvfb CI）で有効化する際は fixme を削除し skip 条件のみ残す。
 *
 * 検証方法:
 *   - addressBarPage が取得できる場合: DOM 操作で UI 状態を確認
 *   - Main プロセスで electronApp.evaluate() を使い toolbarVisible / siteUrl 等を確認
 *   - Page が取得できない場合: skip して WDIO 移行を促す
 *
 * 関連ユニットテスト:
 *   test/unit/ipc.test.ts (addressbar:* チャネル)
 *   test/unit/input-coordinator.test.ts (registerAddressBarShortcut 等)
 *   test/unit/settings-controller.test.ts (applyExternalConfig / stale 防止)
 *   test/unit/config.test.ts (migrateLegacySiteUrl)
 */

import { test, expect } from '@playwright/test';
import { launchApp, teardownApp } from './harness/electron-launch';
import type { LaunchResult } from './harness/electron-launch';

// --------------------------------------------------------------------------
// 共通定数
// --------------------------------------------------------------------------

const SKIP_REASON_NO_WCV =
  'WebContentsView のページ取得不可 (§9.4)。' +
  'WebdriverIO + wdio-electron-service への移行を検討してください (test/e2e/README.md 参照)。';

const SKIP_REASON_NO_ADDRESSBAR =
  `addressBarView の Page が識別できませんでした。${SKIP_REASON_NO_WCV}`;

const SKIP_REASON_NO_SETTINGS =
  `settingsView の Page が識別できませんでした。${SKIP_REASON_NO_WCV}`;

const SKIP_REASON_NO_HOTSPOT =
  `hotspotView の Page が識別できませんでした。${SKIP_REASON_NO_WCV}`;

/** 上部中央ゾーン中心座標（§10.5: 200x32px、画面幅 1280px 想定） */
const ZONE_TOP_CENTER = { x: 640, y: 16 };

// --------------------------------------------------------------------------
// ヘルパ
// --------------------------------------------------------------------------

/**
 * Main プロセスの toolbarVisible 状態を取得する。
 * 公開されていない場合は 'UNKNOWN' を返す。
 */
async function getToolbarVisible(handle: LaunchResult): Promise<boolean | 'UNKNOWN'> {
  const result = await handle.app
    .evaluate(({ app }) => {
      type AppWithToolbar = typeof app & { _toolbarVisible?: boolean };
      const a = app as AppWithToolbar;
      return a._toolbarVisible ?? 'UNKNOWN';
    })
    .catch(() => 'EVAL_FAILED' as const);

  if (result === 'UNKNOWN' || result === 'EVAL_FAILED') return 'UNKNOWN';
  return result as boolean;
}

/**
 * addressBarView の URL 入力欄が表示・有効かを確認する。
 * addressBarPage が null の場合は 'unknown' を返す。
 */
async function _getAddressBarInputValue(handle: LaunchResult): Promise<string | 'unknown'> {
  if (!handle.views.addressBarPage) return 'unknown';
  try {
    return await handle.views.addressBarPage.evaluate(() => {
      const input = document.querySelector<HTMLInputElement>('input[type="url"], input[type="text"]');
      return input?.value ?? '';
    });
  } catch {
    return 'unknown';
  }
}

// --------------------------------------------------------------------------
// E2E-20-A: 起動時の状態確認（siteUrl=''）
// --------------------------------------------------------------------------

test.describe("E2E-20-A: 起動時の状態確認（siteUrl=''）", () => {
  let handle: LaunchResult;

  test.beforeAll(async () => {
    // config.json に siteUrl='' の状態で起動
    // 実装完了後は NODE_ENV=test + 専用 config fixture を使用する
    handle = await launchApp({ NODE_ENV: 'test' });
  });

  test.afterAll(async () => {
    await teardownApp(handle);
  });

  test(
    '[A-1] siteUrl="" → アドレスバーが起動時に表示されている（§2.3, §2.1）',
    async () => {
      // fixme: アドレスバー実装（Phase E-6）完了後に有効化
      test.fixme(
        true,
        'アドレスバー実装（Phase E-6）完了後に有効化。' +
          '検証: toolbarVisible === true または addressBarView の display が none でないこと。',
      );
      test.skip(!handle.webContentsViewAccessible, SKIP_REASON_NO_WCV);

      const visible = await getToolbarVisible(handle);
      console.log('[E2E-20-A-1] toolbarVisible:', visible);

      if (visible === 'UNKNOWN') {
        // Main プロセスに _toolbarVisible が公開されていない段階
        // addressBarPage の display で代替確認
        test.skip(handle.views.addressBarPage === null, SKIP_REASON_NO_ADDRESSBAR);
        const display = await handle.views.addressBarPage!.evaluate(() =>
          getComputedStyle(document.body).display,
        );
        expect(display).not.toBe('none');
      } else {
        expect(visible).toBe(true);
      }
    },
  );

  test(
    '[A-2] siteUrl="" → startPage が表示される（ネットワークエラーなし）（§2.3）',
    async () => {
      // fixme: startPage（src/renderer/start/index.html）実装（Phase D-1）完了後に有効化
      test.fixme(
        true,
        'startPage 実装（Phase D-1）完了後に有効化。' +
          '検証: siteView が file:// スキームの startPage を表示し、' +
          'コンソールに ERR_CONNECTION_REFUSED が出ていないこと。',
      );
      test.skip(!handle.webContentsViewAccessible, SKIP_REASON_NO_WCV);
      test.skip(handle.views.sitePage === null, `siteView の Page が取得できませんでした。${SKIP_REASON_NO_WCV}`);

      const siteUrl = handle.views.sitePage!.url();
      console.log('[E2E-20-A-2] siteView URL:', siteUrl);

      // startPage は file:// スキームであること（ネットワークアクセスなし）
      expect(siteUrl).toMatch(/^file:\/\//);
      // startPage の HTML に案内テキストが含まれること（最低限の UI 確認）
      const hasGuide = await handle.views.sitePage!.evaluate(() =>
        document.body.textContent?.includes('URL') ?? false,
      );
      expect(hasGuide).toBe(true);
    },
  );

  test(
    '[A-3] siteUrl="" → loadURL("") が呼ばれていない（コンソールエラーなし）（§2.3, §8 黒画面回帰テスト）',
    async () => {
      // fixme: Phase E-6（起動ロジック変更・migrateLegacySiteUrl 結線）完了後に有効化
      test.fixme(
        true,
        'Phase E-6 完了後に有効化。' +
          '検証: コンソールに ERR_CONNECTION_REFUSED / loadURL(\'\') が記録されていないこと。',
      );
      test.skip(!handle.webContentsViewAccessible, SKIP_REASON_NO_WCV);
      test.skip(handle.views.sitePage === null, `siteView の Page が取得できませんでした。${SKIP_REASON_NO_WCV}`);

      // コンソールメッセージを収集して検証する
      // 起動時のコンソールは beforeAll 後なので、ここでは siteView URL が file:// であることで代替確認
      const siteUrl = handle.views.sitePage!.url();
      expect(siteUrl).not.toBe(''); // 空文字 loadURL は呼ばれていないこと
      expect(siteUrl).not.toContain('localhost:8080'); // localhost:8080 へのロードも呼ばれていないこと
    },
  );
});

// --------------------------------------------------------------------------
// E2E-20-B: アドレスバー表示/非表示トグル
// --------------------------------------------------------------------------

test.describe('E2E-20-B: アドレスバー表示/非表示トグル', () => {
  let handle: LaunchResult;

  test.beforeAll(async () => {
    handle = await launchApp();
  });

  test.afterAll(async () => {
    await teardownApp(handle);
  });

  test('addressBarView が検出できる（WebContentsView アクセス可否の早期確認）', () => {
    test.skip(!handle.webContentsViewAccessible, SKIP_REASON_NO_WCV);
    // addressBarPage は実装完了後に検出される。ここでは WCV アクセスを確認するのみ
    console.log('[E2E-20-B] webContentsViewAccessible:', handle.webContentsViewAccessible);
    console.log('[E2E-20-B] addressBarPage:', handle.views.addressBarPage?.url() ?? 'null（未実装）');
    expect(handle.webContentsViewAccessible).toBe(true);
  });

  test(
    '[B-1] Ctrl+L → アドレスバーが表示される（§2.1, §6.4）',
    async () => {
      // fixme: Phase B-2（registerAddressBarShortcut）・Phase E（setToolbarVisible）完了後に有効化
      test.fixme(
        true,
        'registerAddressBarShortcut 実装（Phase B-2）完了後に有効化。' +
          '検証: Ctrl+L キー送信後に toolbarVisible === true、addressBarView が visible になること。',
      );
      test.skip(!handle.webContentsViewAccessible, SKIP_REASON_NO_WCV);

      // Ctrl+L は globalShortcut のため、Playwright からの直接シミュレートが難しい場合は
      // Main プロセスの _toggleAddressBar() を evaluate で直接呼び出す
      await handle.app.evaluate(({ app }) => {
        type AppWithToggle = typeof app & { _toggleAddressBar?: () => void };
        const a = app as AppWithToggle;
        a._toggleAddressBar?.();
      });
      await new Promise((r) => setTimeout(r, 300));

      const visible = await getToolbarVisible(handle);
      console.log('[E2E-20-B-1] toolbarVisible after Ctrl+L:', visible);
      if (visible !== 'UNKNOWN') expect(visible).toBe(true);
    },
  );

  test(
    '[B-2] 再度 Ctrl+L → アドレスバーが非表示になる（§2.1）',
    async () => {
      // fixme: B-1 と同じ前提。B-1 通過後に実行。
      test.fixme(
        true,
        'B-1 が有効化されていることを前提。' +
          '検証: 2 回目の Ctrl+L で toolbarVisible === false、addressBarView が hidden になること。',
      );
      test.skip(!handle.webContentsViewAccessible, SKIP_REASON_NO_WCV);

      await handle.app.evaluate(({ app }) => {
        type AppWithToggle = typeof app & { _toggleAddressBar?: () => void };
        const a = app as AppWithToggle;
        a._toggleAddressBar?.();
      });
      await new Promise((r) => setTimeout(r, 300));

      const visible = await getToolbarVisible(handle);
      console.log('[E2E-20-B-2] toolbarVisible after 2nd Ctrl+L:', visible);
      if (visible !== 'UNKNOWN') expect(visible).toBe(false);
    },
  );

  test(
    '[B-3] 上部中央ゾーンを 1 回タップ → アドレスバーが表示される（§2.1, §6.5, §10.5: 32px）',
    async () => {
      // fixme: Phase D-4（hotspot .zone-top-center 追加）・Phase E-7 結線完了後に有効化
      // §10.5 確認事項: .zone-top-center の height は 32px（64px ではない）
      test.fixme(
        true,
        'hotspot .zone-top-center 実装（Phase D-4）完了後に有効化。' +
          '検証: hotspotPage の中央上部（x=640, y=16, height=32px 内）を mouse.click() で 1 回タップ後、' +
          'toolbarVisible === true になること。' +
          '§10.5 注: .zone-top-center の height は 32px（200x32px）。',
      );
      test.skip(!handle.webContentsViewAccessible, SKIP_REASON_NO_WCV);
      test.skip(handle.views.hotspotPage === null, SKIP_REASON_NO_HOTSPOT);

      const hotspotPage = handle.views.hotspotPage!;

      // アドレスバーが閉じている状態から開始（B-2 の後）
      await hotspotPage.mouse.click(ZONE_TOP_CENTER.x, ZONE_TOP_CENTER.y);
      await hotspotPage.waitForTimeout(300);

      const visible = await getToolbarVisible(handle);
      console.log('[E2E-20-B-3] toolbarVisible after top-center tap:', visible);
      if (visible !== 'UNKNOWN') expect(visible).toBe(true);
    },
  );
});

// --------------------------------------------------------------------------
// E2E-20-C: URL ナビゲーション
// --------------------------------------------------------------------------

test.describe('E2E-20-C: URL ナビゲーション', () => {
  let handle: LaunchResult;

  test.beforeAll(async () => {
    handle = await launchApp();
  });

  test.afterAll(async () => {
    await teardownApp(handle);
  });

  test(
    '[C-1] URL を入力して Enter → siteView がその URL をロード → アドレスバーが非表示（§2.2, §10.1）',
    async () => {
      // fixme: Phase D-2（addressbar preload）・Phase C-2（addressbar:navigate IPC）完了後に有効化
      // §10.1: did-finish-load かつ !failedSinceStart の場合のみ setToolbarVisible(false)
      test.fixme(
        true,
        'addressbar:navigate IPC（Phase C-2）完了後に有効化。' +
          '検証: addressBarPage の input に URL を入力し Enter 後、' +
          'siteView が指定 URL をロードし（did-finish-load 待機）、' +
          'toolbarVisible === false になること（§10.1 自動非表示）。',
      );
      test.skip(!handle.webContentsViewAccessible, SKIP_REASON_NO_WCV);
      test.skip(handle.views.addressBarPage === null, SKIP_REASON_NO_ADDRESSBAR);

      const addressBarPage = handle.views.addressBarPage!;
      const testUrl = 'https://example.com';

      // アドレスバーを開く
      await handle.app.evaluate(({ app }) => {
        type A = typeof app & { _toggleAddressBar?: () => void };
        (app as A)._toggleAddressBar?.();
      });
      await addressBarPage.waitForTimeout(300);

      // URL 入力
      const input = addressBarPage.locator('input[type="url"], input[type="text"]').first();
      await input.fill(testUrl);
      await input.press('Enter');

      // siteView がロードするのを待つ（最大 10 秒）
      if (handle.views.sitePage) {
        await handle.views.sitePage.waitForURL(testUrl, { timeout: 10_000 }).catch(() => {
          console.warn('[E2E-20-C-1] siteView が指定 URL へ遷移しませんでした（タイムアウト）');
        });
      }

      // 自動非表示確認（§10.1: did-finish-load 後）
      await addressBarPage.waitForTimeout(2_000); // ロード完了待機
      const visible = await getToolbarVisible(handle);
      console.log('[E2E-20-C-1] toolbarVisible after navigate:', visible);
      if (visible !== 'UNKNOWN') expect(visible).toBe(false);
    },
  );

  test(
    '[C-2] URL を入力して[表示]ボタン → siteView がその URL をロード → アドレスバーが非表示（§2.2, §10.1）',
    async () => {
      // fixme: Phase D-3（addressbar renderer [表示]ボタン）完了後に有効化
      test.fixme(
        true,
        '[表示]ボタン実装（Phase D-3）完了後に有効化。' +
          '検証: URL 入力後に [表示]ボタンをクリック→ C-1 と同じ結果。',
      );
      test.skip(!handle.webContentsViewAccessible, SKIP_REASON_NO_WCV);
      test.skip(handle.views.addressBarPage === null, SKIP_REASON_NO_ADDRESSBAR);

      const addressBarPage = handle.views.addressBarPage!;
      const testUrl = 'https://example.com';

      // アドレスバーを開く
      await handle.app.evaluate(({ app }) => {
        type A = typeof app & { _toggleAddressBar?: () => void };
        (app as A)._toggleAddressBar?.();
      });
      await addressBarPage.waitForTimeout(300);

      const input = addressBarPage.locator('input[type="url"], input[type="text"]').first();
      await input.fill(testUrl);

      // [表示]ボタン（実装では id="navigate-btn" または role="button" で識別）
      const btn = addressBarPage.locator('button[data-action="navigate"], button:has-text("表示")').first();
      await btn.click();

      await addressBarPage.waitForTimeout(2_000);
      const visible = await getToolbarVisible(handle);
      console.log('[E2E-20-C-2] toolbarVisible after button click:', visible);
      if (visible !== 'UNKNOWN') expect(visible).toBe(false);
    },
  );

  test(
    '[C-3] URL 設定後に再起動 → config.siteUrl が永続化されておりその URL がロードされる（§2.2-5）',
    async () => {
      // fixme: Phase E 完了後に有効化。再起動が必要なため別の launchApp インスタンスが必要。
      test.fixme(
        true,
        'Phase E 完了後に有効化。' +
          '検証手順: (1) URL を navigate して config に書き込み → (2) teardown → (3) 再起動 → ' +
          '(4) siteView が前回の URL をロードしていること。',
      );

      // 別インスタンスが必要なため、ここでは Main プロセスの configManager を evaluate で確認する代替案を示す
      const savedUrl = await handle.app
        .evaluate(({ app }) => {
          type A = typeof app & { _configManager?: { load: () => { siteUrl: string } } };
          return (app as A)._configManager?.load().siteUrl ?? 'UNKNOWN';
        })
        .catch(() => 'EVAL_FAILED');
      console.log('[E2E-20-C-3] 保存済み siteUrl:', savedUrl);
      // 実機確認: 前のテスト（C-1/C-2）で navigate した URL が保存されていること
    },
  );

  test(
    '[C-4] 無効な URL（ftp://xxx）を入力 → エラーメッセージ表示、ナビゲーション不発（§2.2-3）',
    async () => {
      // fixme: Phase C-2（invoke 戻り値 {ok, message}）・Phase D-3（エラー表示 UI）完了後に有効化
      test.fixme(
        true,
        'addressbar:navigate invoke 実装（Phase C-2）完了後に有効化。' +
          '検証: ftp://example.com を入力 Enter → addressBar 内にエラーメッセージが表示され、' +
          'siteView の URL が変わっていないこと。',
      );
      test.skip(!handle.webContentsViewAccessible, SKIP_REASON_NO_WCV);
      test.skip(handle.views.addressBarPage === null, SKIP_REASON_NO_ADDRESSBAR);

      const addressBarPage = handle.views.addressBarPage!;
      const prevSiteUrl = handle.views.sitePage?.url() ?? '';

      // アドレスバーを開く
      await handle.app.evaluate(({ app }) => {
        type A = typeof app & { _toggleAddressBar?: () => void };
        (app as A)._toggleAddressBar?.();
      });
      await addressBarPage.waitForTimeout(300);

      const input = addressBarPage.locator('input[type="url"], input[type="text"]').first();
      await input.fill('ftp://example.com');
      await input.press('Enter');
      await addressBarPage.waitForTimeout(500);

      // エラーメッセージが表示されていること
      const errorEl = addressBarPage.locator('[data-role="error"], .error, [aria-live="polite"]').first();
      const errorVisible = await errorEl.isVisible().catch(() => false);
      console.log('[E2E-20-C-4] エラー要素 visible:', errorVisible);
      expect(errorVisible).toBe(true);

      // siteView の URL が変わっていないこと（ナビゲーション不発）
      const afterSiteUrl = handle.views.sitePage?.url() ?? '';
      expect(afterSiteUrl).toBe(prevSiteUrl);
    },
  );
});

// --------------------------------------------------------------------------
// E2E-20-D: ロード失敗フォールバック
// --------------------------------------------------------------------------

test.describe('E2E-20-D: ロード失敗フォールバック（did-fail-load → startPage）', () => {
  let handle: LaunchResult;

  test.beforeAll(async () => {
    handle = await launchApp();
  });

  test.afterAll(async () => {
    await teardownApp(handle);
  });

  test(
    '[D-1] did-fail-load 3 回 → startPage にフォールバック（赤いエラーなし）（§2.4）',
    async () => {
      // fixme: Phase E-5（did-fail-load ハンドラ変更）完了後に有効化
      // 注: inLocalFallback フラグにより無限ループは防止済み（§2.4 CRITICAL）
      test.fixme(
        true,
        'Phase E-5 完了後に有効化。' +
          '検証手順: (1) アドレスバーで到達不能 URL（http://localhost:19999）を入力 → ' +
          '(2) 3 回リトライ（最大 1+2+4 = 7 秒）後 → ' +
          '(3) siteView が file:// の startPage を表示していること。' +
          '(4) コンソールに ERR_CONNECTION_REFUSED が 1 回 WARN 以上で出ていないこと（大量ログ消滅確認）。',
      );
      test.skip(!handle.webContentsViewAccessible, SKIP_REASON_NO_WCV);

      // 到達不能ポート（テスト専用）
      const unreachableUrl = 'http://127.0.0.1:19999';
      if (handle.views.addressBarPage) {
        await handle.app.evaluate(({ app }) => {
          type A = typeof app & { _toggleAddressBar?: () => void };
          (app as A)._toggleAddressBar?.();
        });
        await handle.views.addressBarPage.waitForTimeout(300);
        const input = handle.views.addressBarPage.locator('input').first();
        await input.fill(unreachableUrl);
        await input.press('Enter');
      }

      // リトライ完了待機（最大 1+2+4+余裕 = 10 秒）
      await new Promise((r) => setTimeout(r, 10_000));

      const siteUrl = handle.views.sitePage?.url() ?? '';
      console.log('[E2E-20-D-1] フォールバック後 siteView URL:', siteUrl);
      expect(siteUrl).toMatch(/^file:\/\//);
    },
  );

  test(
    '[D-2] did-fail-load → アドレスバーが自動表示される（§2.4, E-5）',
    async () => {
      // fixme: Phase E-5（setToolbarVisible(true) フォールバック呼び出し）完了後に有効化
      test.fixme(
        true,
        'Phase E-5 完了後に有効化。' +
          '検証: D-1 のフォールバック完了後に toolbarVisible === true であること。' +
          'ユーザーが URL を再入力できる状態になっていることを確認。',
      );
      test.skip(!handle.webContentsViewAccessible, SKIP_REASON_NO_WCV);

      const visible = await getToolbarVisible(handle);
      console.log('[E2E-20-D-2] フォールバック後 toolbarVisible:', visible);
      if (visible !== 'UNKNOWN') expect(visible).toBe(true);
    },
  );
});

// --------------------------------------------------------------------------
// E2E-20-E: ループトグル三者同期
// --------------------------------------------------------------------------

test.describe('E2E-20-E: ループトグル三者同期（addressBar ↔ settingsView ↔ config）', () => {
  let handle: LaunchResult;

  test.beforeAll(async () => {
    handle = await launchApp();
  });

  test.afterAll(async () => {
    await teardownApp(handle);
  });

  test(
    '[E-1] アドレスバーのループトグル ON→OFF → settingsView を開くとループトグルも OFF（§1.2, §2.1）',
    async () => {
      // fixme: Phase C-2（addressbar:toggle-loop）・Phase D-3（ループトグル UI）完了後に有効化
      test.fixme(
        true,
        'addressbar:toggle-loop IPC（Phase C-2）完了後に有効化。' +
          '検証: (1) addressBarPage のループトグルを ON→OFF に切替 → ' +
          '(2) 隅 3 回タップで settingsView を開く → ' +
          '(3) settingsView のループトグルも OFF になっていること。',
      );
      test.skip(!handle.webContentsViewAccessible, SKIP_REASON_NO_WCV);
      test.skip(handle.views.addressBarPage === null, SKIP_REASON_NO_ADDRESSBAR);
      test.skip(handle.views.settingsPage === null, SKIP_REASON_NO_SETTINGS);

      const addressBarPage = handle.views.addressBarPage!;

      // ループトグルを探してクリック（ON → OFF）
      const toggle = addressBarPage
        .locator('input[type="checkbox"][data-action="toggle-loop"], button[data-action="toggle-loop"]')
        .first();
      const isOn = await toggle.isChecked().catch(() => false);
      if (!isOn) {
        await toggle.click(); // OFF → ON（まず ON にする）
        await addressBarPage.waitForTimeout(300);
      }
      await toggle.click(); // ON → OFF
      await addressBarPage.waitForTimeout(300);

      // settingsView を開く（隅 3 回タップ）
      if (handle.views.hotspotPage) {
        for (let i = 0; i < 3; i++) {
          await handle.views.hotspotPage.mouse.click(20, 20);
          if (i < 2) await handle.views.hotspotPage.waitForTimeout(400);
        }
        await handle.views.hotspotPage.waitForTimeout(600);
      }

      // settingsView のループトグルが OFF になっていること
      const settingsPage = handle.views.settingsPage!;
      const settingsToggle = settingsPage
        .locator('input[type="checkbox"][data-action="loop-enabled"]')
        .first();
      const settingsToggleChecked = await settingsToggle.isChecked().catch(() => null);
      console.log('[E2E-20-E-1] settingsView ループトグル checked:', settingsToggleChecked);
      if (settingsToggleChecked !== null) expect(settingsToggleChecked).toBe(false);
    },
  );

  test(
    '[E-2] settingsView のループトグル OFF→ON → アドレスバーのループトグルも ON（§1.2）',
    async () => {
      // fixme: Phase A-3（applyExternalConfig・stale 防止）完了後に有効化
      // §8 CRITICAL: SettingsController._config を常に最新化（applyExternalConfig）
      test.fixme(
        true,
        'Phase A-3（applyExternalConfig）完了後に有効化。' +
          '検証: settingsView のループトグルを OFF→ON → ' +
          'addressBarPage のループトグルも ON になっていること（settings:updated 受信で同期）。',
      );
      test.skip(!handle.webContentsViewAccessible, SKIP_REASON_NO_WCV);
      test.skip(handle.views.settingsPage === null, SKIP_REASON_NO_SETTINGS);
      test.skip(handle.views.addressBarPage === null, SKIP_REASON_NO_ADDRESSBAR);

      const settingsPage = handle.views.settingsPage!;
      const settingsToggle = settingsPage
        .locator('input[type="checkbox"][data-action="loop-enabled"]')
        .first();
      await settingsToggle.click(); // OFF → ON
      await settingsPage.waitForTimeout(500); // IPC 伝播待機

      // addressBarPage のループトグルが ON になっていること
      const addressBarPage = handle.views.addressBarPage!;
      const abToggle = addressBarPage
        .locator('input[type="checkbox"][data-action="toggle-loop"], button[data-action="toggle-loop"]')
        .first();
      const abChecked = await abToggle.isChecked().catch(() => null);
      console.log('[E2E-20-E-2] addressBar ループトグル checked:', abChecked);
      if (abChecked !== null) expect(abChecked).toBe(true);
    },
  );
});

// --------------------------------------------------------------------------
// E2E-20-F: z 順・レイアウト
// --------------------------------------------------------------------------

test.describe('E2E-20-F: z 順・レイアウト', () => {
  let handle: LaunchResult;

  test.beforeAll(async () => {
    handle = await launchApp();
  });

  test.afterAll(async () => {
    await teardownApp(handle);
  });

  test(
    '[F-1] overlayView 動画再生中 → アドレスバーが表示中でも overlayView が完全カバー（§2.1 z 順）',
    async () => {
      // fixme: Phase E-1（z 順: siteView < addressBarView < overlayView < hotspotView < settingsView）完了後に有効化
      test.fixme(
        true,
        'Phase E-1（z 順設定）完了後に有効化。' +
          '検証: アドレスバー VISIBLE 中に overlayView の動画が再生されると、' +
          'overlayView が addressBarView を覆い全画面になること。' +
          '確認手段: overlayPage の <video> の getBoundingClientRect() が (0,0,W,H) であること。',
      );
      test.skip(!handle.webContentsViewAccessible, SKIP_REASON_NO_WCV);
      test.skip(
        handle.views.overlayPage === null,
        `overlayView の Page が識別できませんでした。${SKIP_REASON_NO_WCV}`,
      );

      const overlayPage = handle.views.overlayPage!;
      const rect = await overlayPage.evaluate(() => {
        const video = document.querySelector<HTMLVideoElement>('video');
        if (!video) return null;
        return video.getBoundingClientRect();
      });
      console.log('[E2E-20-F-1] overlayView video rect:', JSON.stringify(rect));
      // overlayView は全画面（addressBarView より上位）であること
      if (rect) {
        expect(rect.x).toBe(0);
        expect(rect.y).toBe(0);
      }
    },
  );

  test(
    '[F-2] アドレスバー表示中にリサイズ → siteView bounds が正しく再計算される（§2.1, E-2）',
    async () => {
      // fixme: Phase E-2（resize ハンドラ拡張）完了後に有効化
      test.fixme(
        true,
        'Phase E-2（resize ハンドラ拡張）完了後に有効化。' +
          '検証: (1) アドレスバーを VISIBLE に → (2) ウィンドウをリサイズ → ' +
          '(3) siteView の bounds が {x:0, y:48, w:新W, h:新H-48} になっていること。' +
          '確認手段: Main プロセスの _siteViewBounds を evaluate で取得。',
      );
      test.skip(!handle.webContentsViewAccessible, SKIP_REASON_NO_WCV);

      // アドレスバーを開く
      await handle.app.evaluate(({ app }) => {
        type A = typeof app & { _toggleAddressBar?: () => void };
        (app as A)._toggleAddressBar?.();
      });
      await new Promise((r) => setTimeout(r, 300));

      // ウィンドウリサイズ（Playwright で Main ウィンドウをリサイズ）
      const newW = 1024;
      const newH = 600;
      await handle.app.evaluate(
        ({ BrowserWindow }, [w, h]) => {
          BrowserWindow.getAllWindows()[0]?.setSize(w, h);
        },
        [newW, newH],
      );
      await new Promise((r) => setTimeout(r, 500));

      // siteView bounds の確認
      const bounds = await handle.app
        .evaluate(({ app }) => {
          type A = typeof app & { _siteViewBounds?: { x: number; y: number; width: number; height: number } };
          return (app as A)._siteViewBounds ?? null;
        })
        .catch(() => null);
      console.log('[E2E-20-F-2] siteView bounds after resize:', JSON.stringify(bounds));
      if (bounds) {
        expect(bounds.x).toBe(0);
        expect(bounds.y).toBe(48); // TOOLBAR_HEIGHT
        expect(bounds.width).toBe(newW);
        expect(bounds.height).toBe(newH - 48);
      }
    },
  );
});

// --------------------------------------------------------------------------
// E2E-20-G: CRITICAL — フォーカス横取り禁止（hotspot zone-disable）
// --------------------------------------------------------------------------

test.describe('E2E-20-G: CRITICAL — URL 入力欄フォーカス（hotspot 横取り禁止）', () => {
  let handle: LaunchResult;

  test.beforeAll(async () => {
    handle = await launchApp();
  });

  test.afterAll(async () => {
    await teardownApp(handle);
  });

  test(
    '[G-1] CRITICAL: アドレスバー VISIBLE 中に URL 入力欄をクリック → フォーカスが当たる（hotspot 非横取り）（§8）',
    async () => {
      // fixme: Phase D-4（hotspot onAddressZoneEnabled で pointer-events 切替）・Phase E-7 結線完了後に有効化
      // 背景: hotspotView は z:3 でフルスクリーン。.zone-top-center（200x32px）が中央上部に常駐する。
      //       アドレスバー VISIBLE 中は setToolbarVisible(true) → hotspot:set-address-zone-enabled{enabled:false}
      //       で .zone-top-center を pointer-events:none に切替。これを怠るとクリックが奪われる。
      test.fixme(
        true,
        'Phase D-4（zone-disable IPC）・Phase E-7 結線完了後に有効化。' +
          '検証: (1) setToolbarVisible(true) を呼ぶ → ' +
          '(2) addressBarPage の input をクリック → ' +
          '(3) input がフォーカスを持つこと（document.activeElement が input であること）。' +
          '失敗例: hotspotView の .zone-top-center が pointer-events:auto のままだとクリックを奪われフォーカスが当たらない。',
      );
      test.skip(!handle.webContentsViewAccessible, SKIP_REASON_NO_WCV);
      test.skip(handle.views.addressBarPage === null, SKIP_REASON_NO_ADDRESSBAR);

      const addressBarPage = handle.views.addressBarPage!;

      // アドレスバーを開く
      await handle.app.evaluate(({ app }) => {
        type A = typeof app & { _toggleAddressBar?: () => void };
        (app as A)._toggleAddressBar?.();
      });
      await addressBarPage.waitForTimeout(300);

      // URL 入力欄をクリック
      const input = addressBarPage.locator('input').first();
      await input.click();
      await addressBarPage.waitForTimeout(200);

      // フォーカスが当たっていること
      const hasFocus = await addressBarPage.evaluate(() => {
        const active = document.activeElement;
        return active?.tagName.toLowerCase() === 'input';
      });
      console.log('[E2E-20-G-1] input がフォーカスを持つ:', hasFocus);
      expect(hasFocus).toBe(true);
    },
  );

  test(
    '[G-2] CRITICAL: アドレスバー VISIBLE 中に URL 入力欄にテキストを入力できる（§8）',
    async () => {
      // fixme: G-1 と同じ前提。
      test.fixme(
        true,
        'G-1 が通過することを前提。' +
          '検証: input.fill("https://example.com") 後に input.inputValue() === "https://example.com"。',
      );
      test.skip(!handle.webContentsViewAccessible, SKIP_REASON_NO_WCV);
      test.skip(handle.views.addressBarPage === null, SKIP_REASON_NO_ADDRESSBAR);

      const addressBarPage = handle.views.addressBarPage!;
      const input = addressBarPage.locator('input').first();

      await input.fill('https://example.com');
      const value = await input.inputValue();
      console.log('[E2E-20-G-2] input value:', value);
      expect(value).toBe('https://example.com');
    },
  );
});

// --------------------------------------------------------------------------
// E2E-20-H: CRITICAL — inLocalFallback 無限ループ防止
// --------------------------------------------------------------------------

test.describe('E2E-20-H: CRITICAL — inLocalFallback 無限ループ防止', () => {
  let handle: LaunchResult;

  test.beforeAll(async () => {
    // startPage が欠落している状態をシミュレートする場合は、
    // ビルド後に out/ から start ファイルを削除してから起動する。
    // 通常の CI テストでは実施せず、開発者が実機で検証する。
    handle = await launchApp();
  });

  test.afterAll(async () => {
    await teardownApp(handle);
  });

  test(
    '[H-1] CRITICAL: startPage ファイル欠落でアプリ起動 → 黒画面になるが再起動なし・エラーログ増殖しない（§2.4, §8）',
    async () => {
      // fixme: Phase E-3/E-5（inLocalFallback ガード）完了後に実機で検証。
      // 自動 CI での実行は難しい（out/ のファイル操作が必要）。
      // 検証手順（実機のみ）:
      //   1. npm run build
      //   2. startPage HTML を削除: rm out/renderer/start/index.html
      //   3. アプリ起動
      //   4. 期待: ERR_FILE_NOT_FOUND が 1 回 logError → 以降 did-fail-load を無視
      //            CPU 使用率が跳ね上がらない（無限ループしていない）
      //   5. アプリを強制終了しても再起動しないこと
      test.fixme(
        true,
        'Phase E-5（inLocalFallback === true の場合 logError 1 回のみ・リトライなし）完了後に実機で有効化。' +
          '自動化困難（ビルド成果物の手動操作が必要）。' +
          '実機検証手順はコメント参照。',
      );

      // 通常環境では startPage が存在するので、inLocalFallback が発火しないことを確認する
      const siteUrl = handle.views.sitePage?.url() ?? '';
      console.log('[E2E-20-H-1] siteView URL（startPage欠落なし通常起動）:', siteUrl);
      // アプリが生きていること（evaluate が成功する）
      const alive = await handle.app.evaluate(() => true).catch(() => false);
      expect(alive).toBe(true);
    },
  );
});

// --------------------------------------------------------------------------
// E2E-20-I: CRITICAL — stale SettingsController._config トグル防止
// --------------------------------------------------------------------------

test.describe('E2E-20-I: CRITICAL — stale トグル防止（applyExternalConfig）', () => {
  let handle: LaunchResult;

  test.beforeAll(async () => {
    handle = await launchApp();
  });

  test.afterAll(async () => {
    await teardownApp(handle);
  });

  test(
    '[I-1] CRITICAL: addressBar で loopEnabled 切替後、設定パネルでトグルを 1 回押す → 正しく反転（§8, §5.6）',
    async () => {
      // fixme: Phase A-3（applyExternalConfig により SettingsController._config を常時最新化）完了後に有効化
      // 背景: 旧実装では addressBar でループを切替えても settingsView の _config が stale のまま。
      //       パネルのトグルを押すと「stale な値を反転」= 意図しない状態になる（二度押し問題）。
      //       applyExternalConfig で onUpdated 受信のたびに _config を更新することで解消。
      test.fixme(
        true,
        'Phase A-3（applyExternalConfig）完了後に有効化。' +
          '検証手順: ' +
          '(1) addressBar のループトグル ON→OFF → ' +
          '(2) 隅 3 回タップで settingsView を開く → ' +
          '(3) settingsView のループトグルを 1 回クリック → ' +
          '(4) config の loopEnabled が true になっていること（false→true へ正しく反転）。' +
          '失敗例（stale 問題）: (3) を押すと false のまま（_config が古く二度押しが必要）。',
      );
      test.skip(!handle.webContentsViewAccessible, SKIP_REASON_NO_WCV);
      test.skip(handle.views.addressBarPage === null, SKIP_REASON_NO_ADDRESSBAR);
      test.skip(handle.views.settingsPage === null, SKIP_REASON_NO_SETTINGS);

      const addressBarPage = handle.views.addressBarPage!;
      const settingsPage = handle.views.settingsPage!;

      // (1) addressBar ループトグル ON→OFF
      await handle.app.evaluate(({ app }) => {
        type A = typeof app & { _toggleAddressBar?: () => void };
        (app as A)._toggleAddressBar?.();
      });
      await addressBarPage.waitForTimeout(300);

      const abToggle = addressBarPage
        .locator('input[type="checkbox"][data-action="toggle-loop"]')
        .first();
      const isOn = await abToggle.isChecked().catch(() => false);
      if (!isOn) await abToggle.click(); // まず ON に
      await addressBarPage.waitForTimeout(300);
      await abToggle.click(); // ON → OFF
      await addressBarPage.waitForTimeout(300);

      // (2) settingsView を開く
      if (handle.views.hotspotPage) {
        for (let i = 0; i < 3; i++) {
          await handle.views.hotspotPage.mouse.click(20, 20);
          if (i < 2) await handle.views.hotspotPage.waitForTimeout(400);
        }
        await handle.views.hotspotPage.waitForTimeout(600);
      }

      // (3) settingsView のループトグルを 1 回クリック（OFF → ON になるべき）
      const stToggle = settingsPage
        .locator('input[type="checkbox"][data-action="loop-enabled"]')
        .first();
      await stToggle.click();
      await settingsPage.waitForTimeout(500);

      // (4) config の loopEnabled が true であること
      const loopEnabled = await handle.app
        .evaluate(({ app }) => {
          type A = typeof app & { _configManager?: { load: () => { loopEnabled: boolean } } };
          return (app as A)._configManager?.load().loopEnabled ?? null;
        })
        .catch(() => null);
      console.log('[E2E-20-I-1] config.loopEnabled after 1 toggle:', loopEnabled);
      if (loopEnabled !== null) expect(loopEnabled).toBe(true);
    },
  );
});

// --------------------------------------------------------------------------
// E2E-20-J: レグレッション・マイグレーション
// --------------------------------------------------------------------------

test.describe('E2E-20-J: レグレッション・マイグレーション', () => {
  let handle: LaunchResult;

  test.beforeAll(async () => {
    handle = await launchApp();
  });

  test.afterAll(async () => {
    await teardownApp(handle);
  });

  test(
    '[J-1] 既存: Ctrl+G / 隅 3 回タップ → 設定パネルが開く（regression）（§7.8）',
    async () => {
      // このテストは既存機能の regression 確認。E2E-13 と同じ検証をここでも行う。
      // fixme: Phase E 完了後にアドレスバー実装と共存した状態で regression 確認。
      test.fixme(
        true,
        'Phase E 完了後に有効化。' +
          '検証: アドレスバー追加後も隅 3 回タップ（400ms 間隔）で settingsView が開くこと（E2E-13 と同じ）。',
      );
      test.skip(!handle.webContentsViewAccessible, SKIP_REASON_NO_WCV);
      test.skip(handle.views.hotspotPage === null, SKIP_REASON_NO_HOTSPOT);

      const hotspotPage = handle.views.hotspotPage!;

      for (let i = 0; i < 3; i++) {
        await hotspotPage.mouse.click(20, 20);
        if (i < 2) await hotspotPage.waitForTimeout(400);
      }
      await hotspotPage.waitForTimeout(600);

      // settingsView が開いていることを確認
      if (handle.views.settingsPage) {
        const isHidden = await handle.views.settingsPage.evaluate(() => {
          const style = getComputedStyle(document.body);
          return style.display === 'none' || style.visibility === 'hidden';
        }).catch(() => true);
        console.log('[E2E-20-J-1] settingsView hidden:', isHidden);
        expect(isHidden).toBe(false);
      } else {
        // Page が取得できない場合はアプリが生きていることを確認
        const alive = await handle.app.evaluate(() => true).catch(() => false);
        expect(alive).toBe(true);
      }
    },
  );

  test(
    '[J-2] siteUrl=\'http://localhost:8080\' の既存 config.json → 起動後 siteUrl=\'\' に変換・startPage 表示（§1.2, §8）',
    async () => {
      // fixme: Phase A-2（migrateLegacySiteUrl）・Phase E-6（結線）完了後に有効化
      // 黒画面回帰テスト: migrateLegacySiteUrl の戻り値を再代入しない場合の回帰を防ぐ
      test.fixme(
        true,
        'Phase A-2（migrateLegacySiteUrl）・Phase E-6（let config = ... の再代入）完了後に有効化。' +
          '検証手順: ' +
          '(1) テスト用 config.json に siteUrl=\'http://localhost:8080\' を書き込む → ' +
          '(2) アプリ起動 → ' +
          '(3) config.siteUrl が \'\' に変換されていること（Main プロセスで確認）。' +
          '(4) siteView が file:// の startPage を表示していること（localhost:8080 への loadURL 不発）。' +
          '失敗例（黒画面回帰）: migrateLegacySiteUrl の戻り値を再代入しないと localhost:8080 が loadURL に渡され黒画面。',
      );
      test.skip(!handle.webContentsViewAccessible, SKIP_REASON_NO_WCV);

      // 通常起動では config.json が書き換えられない前提で、
      // Main プロセスで migrateLegacySiteUrl が正しく動作しているかを evaluate で確認
      const siteUrl = await handle.app
        .evaluate(({ app }) => {
          type A = typeof app & { _configManager?: { load: () => { siteUrl: string } } };
          return (app as A)._configManager?.load().siteUrl ?? 'UNKNOWN';
        })
        .catch(() => 'EVAL_FAILED');
      console.log('[E2E-20-J-2] 起動後 config.siteUrl:', siteUrl);
      // localhost:8080 が残っていないこと（migration 済みであること）
      if (siteUrl !== 'UNKNOWN' && siteUrl !== 'EVAL_FAILED') {
        expect(siteUrl).not.toBe('http://localhost:8080');
      }
    },
  );
});
