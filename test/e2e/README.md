# E2E テスト — Playwright Electron ハーネス (T07.5)

## 概要

このディレクトリには Playwright `_electron` を使った Electron E2E テストが含まれます。  
**現在の環境（WSL2 / 表示サーバなし）では E2E テストを実行できません。**  
実行は xvfb を使った CI 環境または実機 GUI 環境に委ねてください（計画書 §10.1）。

---

## ディレクトリ構成

```
test/e2e/
├── README.md                   # このファイル
├── harness/
│   └── electron-launch.ts      # 起動ヘルパ・WebContentsView 取得可否スパイク
├── e2e-01.spec.ts              # E2E-01: フル広告フロー
├── e2e-13.spec.ts              # E2E-13: 隅 3 タップ → settingsView 開閉
└── e2e-16.spec.ts              # E2E-16: ヘッダー書換えスコープ確認
```

---

## セットアップ

### 1. 依存インストール

```bash
# @playwright/test は devDependency 追加済み（ブラウザ DL は不要）
npm install
```

> Playwright のブラウザ（Chromium/Firefox/WebKit）は Electron テストには不要です。  
> Electron が自前の Chromium を持つため、`PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1` を設定するか  
> `--ignore-scripts` でインストールしてください。

### 2. xvfb のインストール（Linux / WSL2）

Electron アプリの E2E テストには表示サーバが必要です。WSL2 や GUI なしの CI では `xvfb` を使います。

```bash
# Ubuntu / Debian
sudo apt-get install -y xvfb

# 動作確認
xvfb-run --version
```

### 3. アプリのビルド

```bash
npm run build
# → out/main/index.js が生成される
```

---

## 実行コマンド

```bash
# E2E テスト実行（xvfb 経由）
npm run test:e2e
# 内部コマンド: xvfb-run -a playwright test

# 特定スペックのみ実行
xvfb-run -a npx playwright test test/e2e/e2e-01.spec.ts

# CI 向け（1920×1080 解像度指定）
xvfb-run -a --server-args="-screen 0 1920x1080x24" npx playwright test

# 型チェックのみ（表示環境不要）
npm run typecheck:e2e
```

> **注意**: WSL2 環境では xvfb が利用できない場合があります。  
> 表示サーバのないマシンでの E2E 実行は CI（GitHub Actions 等）または  
> Ubuntu 実機（開発機）で行ってください。

---

## WebContentsView 取得可否（§9.4 既知制約）

### 問題

`BaseWindow + WebContentsView` 構成（Electron v30 以降の推奨パターン）では、  
Playwright `_electron` が各 View の Page を取得できない可能性があります。

ハーネス（`harness/electron-launch.ts`）は起動時に自動的に取得可否を検証します。

| 判定 | 意味 | `webContentsViewAccessible` |
|------|------|---------------------------|
| `electronApp.windows()` が 1 件以上 | 取得可能 → E2E テスト実行 | `true` |
| `electronApp.windows()` が 0 件 | 取得不可 → テストを skip | `false` |

### 取得不可だった場合の確認事項

1. アプリのビルド成果物 `out/main/index.js` が存在するか確認
2. 実際に GUI 環境（または xvfb）でアプリを起動して動作確認
3. `electronApp.evaluate()` によるメインプロセス側の検証は引き続き有効

---

## WebdriverIO + wdio-electron-service への移行メモ

`webContentsViewAccessible: false` が継続する場合（Playwright で View が取得できない確定）、  
以下の手順で WebdriverIO + wdio-electron-service に移行します。

### 移行の理由

WebdriverIO の `wdio-electron-service` は Electron の WebDriver プロトコルを通じて  
各 WebContentsView を制御できる場合があります。

### 移行手順（工数目安: 2〜3 日）

```bash
# 1. 既存 @playwright/test を devDependency から除去
npm uninstall @playwright/test

# 2. WebdriverIO + electron サービスをインストール
npm install --save-dev \
  @wdio/cli \
  @wdio/local-runner \
  @wdio/mocha-framework \
  wdio-electron-service

# 3. wdio.config.ts を作成
npx wdio config

# 4. 既存 spec ファイルを WebdriverIO の記法に書き換え
#    Playwright の expect() → WebdriverIO の expect()
#    test.describe() → describe()
#    test() → it()
#    handle.app.evaluate() → browser.electron.execute()
```

### 移行後の設定例（wdio.config.ts 抜粋）

```typescript
import { defineConfig } from '@wdio/cli';

export const config = defineConfig({
  runner: 'local',
  specs: ['test/e2e/**/*.spec.ts'],
  services: [
    ['electron', {
      appPath: 'out/main/index.js',
      appArgs: [],
    }],
  ],
  framework: 'mocha',
  reporters: ['spec'],
});
```

---

## Vitest との共存

Vitest（ユニットテスト用）と Playwright（E2E テスト用）は**ランナーが独立**しています。

| ツール | 対象ファイル | 実行コマンド |
|-------|------------|------------|
| Vitest | `test/unit/**/*.test.ts` | `npm test` |
| Playwright | `test/e2e/**/*.spec.ts` | `npm run test:e2e` |

`vitest.config.ts` に `exclude: ['test/e2e/**']` を設定済みのため、  
`npm test`（Vitest）を実行しても E2E ファイルは読み込まれません。

---

## CI 設定例（GitHub Actions）

```yaml
- name: Install xvfb
  run: sudo apt-get install -y xvfb

- name: Build app
  run: npm run build

- name: Run E2E tests
  run: xvfb-run -a --server-args="-screen 0 1920x1080x24" npm run test:e2e
```

---

## 型チェック（表示環境不要）

```bash
# E2E ファイルの型整合性確認（実 Electron 起動は不要）
npm run typecheck:e2e
# 内部コマンド: tsc --noEmit -p tsconfig.e2e.json
```

このコマンドは表示サーバなしで実行でき、TypeScript の型エラーを早期に検出します。
