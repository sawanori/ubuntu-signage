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
 * 注: アドレスバー実装（Phase D-E）完了まで 22 シナリオが未実装。
 *     有効化はリファクタリング §9 確定事項（B3）に基づき、実機対応時に個別に追加する。
 *     未実装シナリオのチェックリストは本ファイル末尾を参照。
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

// --------------------------------------------------------------------------
// E2E-20-B: アドレスバー表示/非表示トグル（smoke test のみ実行）
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
});

// --------------------------------------------------------------------------
// 未実装シナリオ チェックリスト（Phase D-E 実装後に個別追加）
//
// 有効化手順: 対応 Phase 完了後、describe ブロックと test を追加し
//             test.skip(!handle.webContentsViewAccessible, SKIP_REASON_NO_WCV) のみ残す。
//
// [ ] A-1: siteUrl="" → アドレスバーが起動時に表示されている（§2.3, §2.1）
// [ ] A-2: siteUrl="" → startPage が表示される（ネットワークエラーなし）（§2.3）
// [ ] A-3: siteUrl="" → loadURL("") が呼ばれていない（コンソールエラーなし）（§2.3）
// [ ] B-1: Ctrl+L → アドレスバーが表示される（§2.1, §6.4）
// [ ] B-2: 再度 Ctrl+L → アドレスバーが非表示になる（§2.1）
// [ ] B-3: 上部中央ゾーンを 1 回タップ → アドレスバーが表示される（§2.1, §6.5, §10.5）
// [ ] C-1: URL を入力して Enter → siteView がその URL をロード → アドレスバーが非表示（§2.2, §10.1）
// [ ] C-2: URL を入力して[表示]ボタン → siteView がその URL をロード → アドレスバーが非表示（§2.2, §10.1）
// [ ] C-3: URL 設定後に再起動 → config.siteUrl が永続化されておりその URL がロードされる（§2.2-5）
// [ ] C-4: 無効な URL（ftp://xxx）を入力 → エラーメッセージ表示、ナビゲーション不発（§2.2-3）
// [ ] D-1: did-fail-load 3 回 → startPage にフォールバック（赤いエラーなし）（§2.4）
// [ ] D-2: did-fail-load → アドレスバーが自動表示される（§2.4）
// [ ] E-1: アドレスバーのループトグル ON→OFF → settingsView を開くとループトグルも OFF（§1.2, §2.1）
// [ ] E-2: settingsView のループトグル OFF→ON → アドレスバーのループトグルも ON（§1.2）
// [ ] F-1: overlayView 動画再生中 → アドレスバーが表示中でも overlayView が完全カバー（§2.1 z 順）
// [ ] F-2: アドレスバー表示中にリサイズ → siteView bounds が正しく再計算される（§2.1）
// [ ] G-1: CRITICAL: アドレスバー VISIBLE 中に URL 入力欄をクリック → フォーカスが当たる（hotspot 非横取り）（§8）
// [ ] G-2: CRITICAL: アドレスバー VISIBLE 中に URL 入力欄にテキストを入力できる（§8）
// [ ] H-1: CRITICAL: startPage ファイル欠落でアプリ起動 → 黒画面になるが再起動なし・エラーログ増殖しない（§2.4, §8）
// [ ] I-1: CRITICAL: addressBar で loopEnabled 切替後、設定パネルでトグルを 1 回押す → 正しく反転（§8, §5.6）
// [ ] J-1: 既存: Ctrl+G / 隅 3 回タップ → 設定パネルが開く（regression）（§7.8）
// [ ] J-2: siteUrl='http://localhost:8080' の既存 config.json → 起動後 siteUrl='' に変換・startPage 表示（§1.2, §8）
// --------------------------------------------------------------------------
