# アドレスバー実装計画書

バージョン: 1.1.0 (レビュー反映済)
作成日: 2026-06-27
更新日: 2026-06-27 (Opus/Codex ダブルレビュー反映)
担当: Sonnet 実装計画書作成エンジニア

---

## 1. 概要 / 目的 / 確定要件サマリ

### 1.1 目的

現状の ubuntuapp は起動時に `config.siteUrl = 'http://localhost:8080'` をそのまま `siteView.webContents.loadURL()` でロードし、サーバーが存在しないため `ERR_CONNECTION_REFUSED(-102)` を指数バックオフで無限リトライする。これにより赤いエラーログが大量出力され、画面は真っ黒のままになる。

本計画は以下を実現することで「普通のブラウザのように URL を打てる、かつ看板として普段はスッキリ全画面」を達成する。

1. ウィンドウ上部に出し入れ可能なアドレスバーを追加する
2. URL 未設定 / ロード失敗時はアプリ同梱のスタート画面を表示し、エラー状態を完全に消す
3. アドレスバーに動画ループ ON/OFF の小型トグルを置き、設定パネルのトグルと三者同期させる

### 1.2 確定要件サマリ

| 項目 | 仕様 |
|------|------|
| アドレスバー高さ | 約 48px |
| バーの構成 | [↻再読込] [URL 入力ボックス] [表示ボタン] [広告ループトグル(小)] |
| 戻る/進むボタン | **非採用**（看板用途では優先度低・管理コスト過大） |
| 既定状態 | **非表示**（看板はスッキリ全画面） |
| 表示トリガー | Ctrl+L（X11）/ 画面上部中央タップゾーン 1 回（Wayland/タッチ） |
| URL 確定操作 | Enter キー / [表示]ボタン |
| URL バリデーション | ConfigUpdateSchema（zod）既存経路の再利用 |
| config 保存 | `settings:update` 相当の `addressbar:navigate` IPC 経由 → applyUpdate |
| 未設定状態 | `siteUrl === ''` → startPage（同梱 HTML）をネットワークアクセスなしで表示 |
| 未設定時のバー | **既定で表示**しておく（すぐ URL を打てるように） |
| ロード失敗時 | 最大 3 回リトライ後に startPage へフォールバック。ログは WARN 1 回 |
| 動画 z 順 | overlayView > addressBarView（動画は常にフルスクリーン） |
| ループトグル | `loopEnabled`（広告割り込み機能の有効/無効）を ON/OFF。三者同期必須 |
| 設定パネル URL 欄 | **連動** — `settings:updated` 受信で同期（§5.6 参照: controller 内部状態も更新必須） |
| 後方互換 | `'http://localhost:8080'` は初回起動時に `''`（未設定）へマイグレーション |
| 空 URL の settings UI | settings-controller.ts の `validateUrl('')` が拒否しないよう変更必須（§5.6） |

---

## 2. 機能一覧と仕様

### 2.1 アドレスバー表示/非表示 — 状態機械

```
[HIDDEN]
  ├── Ctrl+L 押下 → [VISIBLE]
  ├── 上部中央ゾーン タップ → [VISIBLE]
  └── siteUrl === '' かつ起動時 → [VISIBLE]（自動展開）

[VISIBLE]
  ├── Ctrl+L 押下 → [HIDDEN]
  ├── 上部中央ゾーン タップ → [HIDDEN]  ← §2.5 の zone-disable 機構により上部中央ゾーンは VISIBLE 中は無効化
  └── URL 入力 Enter/[表示]ボタン → siteView ナビゲーション後 → [HIDDEN]
       （ナビゲーション成功時のみ閉じる；ユーザーが手動で閉じる動作も維持）
```

**siteView bounds との連動:**

| アドレスバー状態 | siteView bounds | addressBarView bounds |
|--------------|-----------------|----------------------|
| HIDDEN | {x:0, y:0, w:W, h:H} | setVisible(false) |
| VISIBLE | {x:0, y:48, w:W, h:H-48} | {x:0, y:0, w:W, h:48} |

overlayView / hotspotView / settingsView は常時 {x:0, y:0, w:W, h:H}（変更なし）。

### 2.2 URL ナビゲーション

1. ユーザーが URL を入力して Enter / [表示]ボタン押下
2. preload → `addressbar:navigate` IPC → Main
3. Main: `configManager.applyUpdate({siteUrl: url})` でバリデーション（ConfigUpdateSchema / httpHttpsUrlSchema）
4. バリデーション OK → `inLocalFallback = false` → `siteRetryState = createRetryState()` → `loadSiteUrl(url)` → siteView へロード
5. `settings:updated` を settingsView へ送信（URL 欄の連動同期）
6. `addressbar:config-updated` を addressBarView へ送信（URL 入力欄更新）
7. バリデーション NG → invoke の戻り値 `{ok: false, message}` を返す（addressbar renderer がエラー表示）

> **設計注記:** `addressbar:navigate-error` IPC チャネルを廃止し、invoke 戻り値のみでエラーを返す（§6.3 参照）。二経路の競合を排除する。

### 2.3 未設定状態 → スタート画面

- `config.siteUrl === ''` のとき、`siteView.webContents.loadFile(startPagePath)` を呼ぶ
- startPage = `src/renderer/start/index.html`（app バンドル同梱、file:// ロード、ネットワークアクセスなし）
- startPage の表示内容: 「URL を入力してください」案内 + Ctrl+L / 上部タップの操作説明
- 未設定かつ起動時: アドレスバーを自動表示（`toolbarVisible = true`）

### 2.4 ロード失敗フォールバック

> **⚠️ CRITICAL 修正 (Opus #3):** Electron は `file://` の `ERR_FILE_NOT_FOUND(-6)` 等でも `did-fail-load` を発火する。旧計画の「file:// は did-fail-load を発火しない」は誤り。`inLocalFallback` フラグを導入しなければ、startPage 失敗時にフォールバック後 `siteRetryState = createRetryState()` でカウンタがリセットされ無限ループに陥る。

- `inLocalFallback` フラグをモジュールスコープに追加（`let inLocalFallback = false`）
- `loadStartPage()` 内で `inLocalFallback = true` を設定
- `loadSiteUrl(url)` 内で `inLocalFallback = false` をリセット（外部 URL ロード開始時）
- `did-fail-load` ハンドラ:
  - `ERR_ABORTED(-3)` はスキップ（既存通り）
  - **`inLocalFallback === true` の場合: `logError` 1 回のみ、リトライ一切なし（脱出条件）**
  - それ以外: `attempt` をカウントアップ
  - `attempt <= MAX_RETRY_ATTEMPTS(3)` の間は指数バックオフリトライ（既存の `backoffDelayMs` 再利用）
  - `attempt > MAX_RETRY_ATTEMPTS(3)` → `loadStartPage()` へフォールバック（`inLocalFallback = true` がセットされる）+ `siteRetryState = createRetryState()`
  - ログは `logError` → **`logWarn`** に格下げ、1 回のみ（連打なし）
  - フォールバック後: アドレスバーを自動表示（`setToolbarVisible(true)`）

### 2.5 動画 z 順（overlayView がアドレスバーより前面）と z 順干渉の解消

> **⚠️ CRITICAL 修正 (Opus #1 / Codex #2):** 計画の z 順は `hotspotView(3) > addressBarView(1)` であるため、hotspotView が全画面でかぶさり、上部中央ゾーン(`.zone-top-center`: top:0, height:64px, width:200px)がアドレスバーの URL 入力クリックを横取りしてしまう。アドレスバーが表示中に上部中央ゾーンをタップすると「バーを閉じる」が発火し、URL 入力欄に文字を打てない。

**z 順は変更しない（z:3 hotspotView > z:1 addressBarView を維持）。代わりに zone-disable IPC 機構を追加する。**

新 z 順（addChildView の追加順）:

| 順番 | View | 役割 | bounds |
|------|------|------|--------|
| 0 | siteView | サイネージ URL | 動的（toolbar 状態に依存） |
| 1 | addressBarView | アドレスバー UI | {0, 0, W, 48}（HIDDEN 時は invisible） |
| 2 | overlayView | 動画オーバーレイ | 常時 {0, 0, W, H}（addressBarView より前面） |
| 3 | hotspotView | 隅タップ検出 | 常時 {0, 0, W, H} |
| 4 | settingsView | 設定パネル | 常時 {0, 0, W, H} |

**zone-disable 機構:**

```
setToolbarVisible(true) 呼び出し時:
  → hotspotView に hotspot:set-address-zone-enabled {enabled: false} を送信
  → hotspot/main.ts: .zone-top-center の pointer-events を 'none' に設定
  → 効果: URL 入力クリックが hotspotView に奪われなくなる ✓

setToolbarVisible(false) 呼び出し時:
  → hotspotView に hotspot:set-address-zone-enabled {enabled: true} を送信
  → hotspot/main.ts: .zone-top-center の pointer-events を 'auto' に復帰
  → 効果: 上部中央タップでアドレスバーをトグルできる ✓
```

**z 順・座標・表示状態の干渉まとめ（表）:**

| addressBar 状態 | .zone-top-center pointer-events | URL 入力クリック | 上部中央タップ |
|----------------|-------------------------------|----------------|--------------|
| HIDDEN | auto | addressBarView 非表示のため hotspot が受け取る | バー表示 ✓ |
| VISIBLE | **none（zone-disable 済）** | addressBarView が受け取る ✓ | 発火しない ✓ |

overlayView が addressBarView より前面（z:2 > z:1）なので動画再生中はアドレスバーが隠れる（意図通り）。

### 2.6 後方互換マイグレーション

既存ユーザーの `config.json` には `siteUrl: 'http://localhost:8080'` が保存されている。

マイグレーション処理: `main()` 内で `configManager.load()` の直後に実行。

```typescript
function migrateLegacySiteUrl(config: Config, configManager: ConfigManager): Config {
  const LEGACY_PLACEHOLDER = 'http://localhost:8080'
  if (config.siteUrl !== LEGACY_PLACEHOLDER) return config
  // 既存 DEFAULT_CONFIG のプレースホルダを未設定扱いに変換
  const migrated = configManager.applyUpdate({ siteUrl: '' })
  if (migrated === null) {
    // applyUpdate 失敗（ありえないが CRITICAL: サイレント障害にしない）
    // config は変更せずそのまま使い、did-fail-load フォールバックで救済する
    return config
  }
  return migrated
}
```

> **⚠️ CRITICAL 修正 (Opus #4 / Codex #1):** `main()` の `const config = configManager.load()` を **`let config`** に変え、マイグレーション後の値を**必ず再代入**する。
>
> ```typescript
> let config = configManager.load()            // const → let に変更
> config = migrateLegacySiteUrl(config, configManager)  // 戻り値を再代入（必須）
> ```
>
> また既存 L581-588 の `siteView.webContents.loadURL(config.siteUrl)` を撤去し、空 URL 分岐付き `loadSiteUrl(config.siteUrl)` に完全置換する（§9 E-6 参照）。これを行わないと移行後の configManager.current は空文字になっているのにローカル `config` 変数は旧値のまま `loadURL('http://localhost:8080')` が実行され、要件①(黒画面解消)が保証されない。

注意: `applyUpdate` が空文字を受け入れるためには schema 変更（§5 参照）が前提。

### 2.7 アドレスバー上のループトグル（loopEnabled 三者同期）

**セマンティクス確認済み（実コード読取）:**
- `Config.loopEnabled`: "広告割り込み機能の有効/無効"（`types.ts` コメント）
- `Scheduler._doFire()` が `!this.loopEnabled` で早期リターン → ループが false なら割り込み再生サイクル自体が止まる
- 「単一動画の繰り返し再生」ではなく「割り込み再生サイクル全体の ON/OFF」

**UI ラベル:** `広告ループ` (aria-label="広告ループ ON/OFF")、テキスト最小・アイコン + 状態表示（ON/OFF）

> **⚠️ CRITICAL 修正 (Opus #2):** `settings/main.ts` の `onUpdated` は現状 `renderConfig(config)`（DOM 更新のみ）しか呼ばず、`SettingsController._config` を更新しない。アドレスバーという第 2 の書き手が加わると、アドレスバーで loopEnabled を切り替えた後にパネルのループトグルを押すと「古い値の !old」を IPC へ送信し、サイレントに誤動作する。
>
> **修正**: `SettingsController` に `applyExternalConfig(config: Config): void` を追加し、`settings/main.ts` の `onUpdated` から `renderConfig` と **並行して呼ぶ**（§5.6 参照）。

**アドレスバー renderer の楽観的更新禁止:** `addressbar:toggle-loop` の invoke 戻り値（サーバー側更新後の Config）でのみ UI を更新する。invoke 失敗時（null 返却）は UI 変更しない。

**三者同期フロー:**

```
[アドレスバーでトグル]
  addressbar:toggle-loop invoke
  → configManager.applyUpdate({loopEnabled: !current.loopEnabled})
  → orchestrator.updateConfig({loopEnabled})
  → settingsWebContents.send('settings:updated', updated)    ← 設定パネル同期
  → addressBarWebContents.send('addressbar:config-updated', updated)  ← 自身も更新
  (invoke 戻り値 = updated Config が addressbar renderer に届く)

[設定パネルでトグル（既存 settings:update 経路）]
  settings:update({loopEnabled: !this._config.loopEnabled}) IPC
  → configManager.applyUpdate → orchestrator.updateConfig
  → settingsWebContents.send('settings:updated', updated)
    ↳ settings/main.ts: controller.applyExternalConfig(updated) + renderConfig(updated)  ← 追加
  → addressBarWebContents.send('addressbar:config-updated', updated)  ← 追加
```

**真実源:** `config.loopEnabled` が唯一の真実源。両 UI は `settings:updated` / `addressbar:config-updated` 受信で表示を更新する。古い表示 (stale) は残さない。

---

## 3. ファイル構成・変更対象ファイル

### 3.1 新規ファイル

| ファイルパス | 役割 |
|------------|------|
| `src/renderer/addressbar/index.html` | アドレスバー renderer HTML |
| `src/renderer/addressbar/main.ts` | アドレスバー renderer ロジック |
| `src/renderer/addressbar/styles.css` | アドレスバー スタイル（48px 固定高） |
| `src/renderer/start/index.html` | スタート画面 HTML（静的・ネットワーク不要） |
| `src/preload/addressbar.ts` | addressBarView 用 contextBridge API |

### 3.2 変更ファイル

| ファイルパス | 主な変更点 |
|------------|-----------|
| `src/shared/schema.ts` | `siteUrl` を空文字許容に拡張（`optionalSiteUrlSchema`） |
| `src/main/config.ts` | `DEFAULT_CONFIG.siteUrl = ''`、`migrateLegacySiteUrl()` 追加 |
| `src/main/ipc.ts` | addressbar 系 IPC チャネル追加、`addressBarWebContents` deps 追加、`settings:update` ハンドラで `addressbar:config-updated` broadcast 追加 |
| `src/main/input-coordinator.ts` | `Ctrl+L` 登録、`onToggleAddressBar` コールバック追加、`toggleAddressBarZone()` メソッド追加 |
| `src/main/index.ts` | `addressBarView` 追加（WebPreferences 明示）、`inLocalFallback` フラグ、動的レイアウト（`toolbarVisible`）、`loadStartPage()`、`loadSiteUrl()` 空 URL 分岐、初期 loadURL 直呼び撤去・`loadSiteUrl` へ置換、`migrateLegacySiteUrl` 再代入、`hotspot:set-address-zone-enabled` 送信 |
| `src/main/site-guards.ts` | 空 siteUrl 時の挙動コメント文書化（コード変更最小） |
| `src/main/site-load-retry.ts` | `MAX_RETRY_ATTEMPTS` 定数エクスポート追加 |
| `src/renderer/hotspot/index.html` | 上部中央ゾーン `<div class="zone zone-top-center">` 追加 |
| `src/renderer/hotspot/hotspot.css` | `.zone-top-center` スタイル追加 |
| `src/renderer/hotspot/main.ts` | 上部中央ゾーン click → `hotspot:address-bar-toggle` 送出；`onAddressZoneEnabled` 受信で pointer-events 切替 |
| `src/preload/hotspot.ts` | `sendAddressBarToggle()` 追加；`onAddressZoneEnabled(cb)` 追加 |
| `src/renderer/settings/settings-controller.ts` | `applyExternalConfig(config)` 追加；`validateUrl` で空文字を有効とする（§5.6） |
| `src/renderer/settings/main.ts` | `onUpdated` ハンドラで `controller.applyExternalConfig(config)` 追加 |
| `electron.vite.config.ts` | `addressbar` preload エントリ追加、`addressbar` / `start` renderer エントリ追加 |

---

## 4. 依存関係・技術選定の根拠

### 4.1 新規依存ライブラリ

**なし。** 既存の依存関係のみで実現する。

理由: electron-vite + TypeScript + Vitest + Playwright の既存スタックで完結可能。UI に新たなフレームワーク（React/Vue 等）を持ち込むと既存 renderer との不整合が生まれる。アドレスバーは Vanilla TS + HTML で実装する。

### 4.2 技術選定根拠

| 選択 | 根拠 |
|------|------|
| addressBarView を独立 WebContentsView にする | settingsView と同様の「信頼済みアプリ View」パターンを踏襲。siteView（外部サイト）に chrome を注入しないセキュリティ方針を維持 |
| startPage を `loadFile()` で表示 | ネットワークアクセスゼロ保証。`file:` プロトコルは siteView 用セッション（persist:site）と分離されるため外部サイトの CSP が干渉しない |
| siteUrl の空文字許容 | `null` / `undefined` より TypeScript 的に簡潔。既存の `z.string()` 型制約と整合 |
| マイグレーションを `applyUpdate()` 経由にする | ConfigUpdateSchema の検証を通過させることで CRITICAL 安全性（サイレント障害なし）を保つ。直接 store 書き換えは避ける |
| Ctrl+L を InputCoordinator で管理 | 既存の Ctrl+G と同一モジュールで一元管理。Wayland フォールバック実装を同一箇所に集約 |
| 上部中央ゾーン（単一タップ）を Wayland フォールバックに選択 | 既存の隅 3 回タップと発火条件（ゾーン位置・カウント数）が完全に異なり衝突しない。既存 hotspot インフラを再利用できる |
| zone-disable IPC 機構 | z 順変更なしで hotspot/addressBar z 干渉を解消。ゾーンの有効/無効を Main が制御し、renderer 側は状態を受信して pointer-events を切り替える |
| addressBarView session: in-memory | 信頼済み Chrome View であるためログイン状態の永続化不要。デフォルトセッション（`persist:default`）を共有せず明示的に in-memory（空 partition = `''`）を指定し、siteView（`persist:site`）との Session 混入を防ぐ |

### 4.3 「戻る/進む」ボタンの非採用

看板用途ではページ内リンクナビゲーション履歴の管理が不要。アドレスバーへの URL 直打ちが主要操作。WebContentsView の `goBack()` / `goForward()` API は存在するが、管理状態が増えリトライ・フォールバックとの整合が複雑化する。nice-to-have 扱いとし本実装スコープから除外する。

---

## 5. データモデル / スキーマ変更

### 5.1 `src/shared/schema.ts` — siteUrl 空文字許容

```typescript
// 変更前
const httpHttpsUrlSchema = z.string().refine(...)

export const ConfigSchema = z.object({
  siteUrl: httpHttpsUrlSchema,
  ...
})
```

```typescript
// 変更後
const httpHttpsUrlSchema = z.string().refine(
  (url: string): boolean => {
    try {
      const parsed = new URL(url)
      return parsed.protocol === 'http:' || parsed.protocol === 'https:'
    } catch { return false }
  },
  { message: 'siteUrl must use http or https scheme' }
)

/**
 * 空文字（未設定）または http/https URL を許容する。
 * 空文字 = スタート画面表示。http/https = サイネージ URL。
 */
const optionalSiteUrlSchema = z.union([z.literal(''), httpHttpsUrlSchema])

export const ConfigSchema = z.object({
  siteUrl: optionalSiteUrlSchema,  // 変更
  videoFolderPath: z.string(),
  intervalMinutes: intervalMinutesSchema,
  loopEnabled: z.boolean(),
  fadeDurationMs: z.number().int().positive(),
})

export const ConfigUpdateSchema = ConfigSchema.partial()
```

`ConfigUpdateSchema = ConfigSchema.partial()` のため、`ConfigUpdateSchema.siteUrl` も自動的に空文字許容になる。

### 5.2 `src/shared/types.ts`

変更なし。`siteUrl: string` のまま（型は変わらない）。

### 5.3 `src/main/config.ts` — DEFAULT_CONFIG 変更

```typescript
// 変更前
export const DEFAULT_CONFIG: Config = {
  siteUrl: 'http://localhost:8080',
  ...
}

// 変更後
export const DEFAULT_CONFIG: Config = {
  siteUrl: '',            // 未設定状態（スタート画面を表示）
  videoFolderPath: '',
  intervalMinutes: 5,
  loopEnabled: true,
  fadeDurationMs: 1000,
} as const satisfies Config
```

### 5.4 マイグレーション関数（`src/main/config.ts` に追加）

```typescript
/**
 * レガシーな siteUrl プレースホルダを未設定（空文字）へ移行する。
 * 既存ユーザーの config.json に 'http://localhost:8080' が永続化されている場合に適用。
 *
 * @returns マイグレーション後の Config（変更なしの場合は引数をそのまま返す）
 */
export function migrateLegacySiteUrl(
  config: Config,
  configManager: ConfigManager
): Config {
  const LEGACY_PLACEHOLDER = 'http://localhost:8080'
  if (config.siteUrl !== LEGACY_PLACEHOLDER) return config
  const migrated = configManager.applyUpdate({ siteUrl: '' })
  if (migrated === null) {
    // applyUpdate 失敗（ありえないが CRITICAL: サイレント障害にしない）
    // config は変更せずそのまま使い、did-fail-load フォールバックで救済する
    return config
  }
  return migrated
}
```

この関数は `main()` 内で以下のように呼ぶ（**再代入必須**）:

```typescript
// ⚠️ CRITICAL: const → let に変更し、移行後の値を必ず再代入する
let config = configManager.load()
config = migrateLegacySiteUrl(config, configManager)
```

### 5.5 isAllowedNavUrl 空 siteUrl 時の挙動

`site-guards.ts` の `isAllowedNavUrl(url, siteUrl)`:
- `siteUrl === ''` のとき `new URL('')` がスロー → `catch` で `false` を返す（既存動作）
- siteView が startPage（file://）を表示中は外部ナビゲーション自体が発生しないため、false 返却は実害なし
- コード変更は不要だが、コメントで空 siteUrl 時の挙動を明文化する

`site-load-retry.ts` に定数追加:

```typescript
/** ロード失敗の最大リトライ回数（超過後は startPage へフォールバック） */
export const MAX_RETRY_ATTEMPTS = 3
```

### 5.6 `src/renderer/settings/settings-controller.ts` — 変更（CRITICAL 追加）

> **⚠️ CRITICAL 修正 (Opus #2 / Codex #3):** 2 点の変更が必要。

#### (a) `applyExternalConfig(config: Config): void` 追加

アドレスバー等の外部書き手が `settings:updated` を発行した場合、DOM は `renderConfig` で更新されるが `SettingsController._config` が stale のまま。次に `toggleLoop()` が呼ばれると `!this._config.loopEnabled` で古い値を計算してしまう。

```typescript
/**
 * 外部（アドレスバー等の第2書き手）による config 更新を内部状態に反映する。
 * settings/main.ts の onUpdated から renderConfig() と並行して呼ぶこと。
 */
applyExternalConfig(config: Config): void {
  this._config = config
}
```

#### (b) `validateUrl('')` を有効とする

```typescript
// 変更前
validateUrl(url: string): UrlValidationResult {
  let parsed: URL
  try {
    parsed = new URL(url)  // '' を渡すと TypeError: Invalid URL
  } catch {
    this._urlError = 'Invalid URL format'
    return { valid: false, message: 'Invalid URL format' }
  }
  // ...
}

// 変更後
validateUrl(url: string): UrlValidationResult {
  // 空文字は「未設定（スタート画面）」として有効
  if (url.trim() === '') {
    this._urlError = null
    return { valid: true }
  }
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    const message = 'Invalid URL format'
    this._urlError = message
    return { valid: false, message }
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    const scheme = parsed.protocol.replace(':', '')
    const message = `URL scheme must be http or https (got ${scheme})`
    this._urlError = message
    return { valid: false, message }
  }
  this._urlError = null
  return { valid: true }
}
```

また `setUrl('')` は `validateUrl('')` が valid を返すため `_saveAndApply({ siteUrl: '' })` へ進む。UI ではプレースホルダテキスト「URL を入力してください」を表示する。

#### `settings/main.ts` — `onUpdated` 変更

```typescript
// 変更前
window.settingsApi.onUpdated((config: Config) => {
  renderConfig(config)
})

// 変更後
window.settingsApi.onUpdated((config: Config) => {
  controller.applyExternalConfig(config)  // 内部状態を同期（CRITICAL 追加）
  renderConfig(config)
})
```

---

## 6. レイアウト / z 順 / IPC チャネル設計

### 6.1 動的レイアウト（`src/main/index.ts`）

```typescript
/** アドレスバーの高さ（px）*/
const TOOLBAR_HEIGHT = 48

/** アドレスバー表示状態 */
let toolbarVisible = false

/** startPage フォールバック実行中フラグ（無限リトライ防止） */
let inLocalFallback = false

/** 現在の toolbar 状態に基づいて siteView の bounds を計算する */
function getSiteViewBounds(): Electron.Rectangle {
  const b = win.getBounds()
  if (toolbarVisible) {
    return { x: 0, y: TOOLBAR_HEIGHT, width: b.width, height: b.height - TOOLBAR_HEIGHT }
  }
  return { x: 0, y: 0, width: b.width, height: b.height }
}

/** addressBarView の固定 bounds */
function getAddressBarBounds(): Electron.Rectangle {
  const b = win.getBounds()
  return { x: 0, y: 0, width: b.width, height: TOOLBAR_HEIGHT }
}

/** toolbar を表示/非表示にし、関連 View の bounds を更新する */
function setToolbarVisible(visible: boolean): void {
  toolbarVisible = visible
  addressBarView.setVisible(visible)
  if (visible) {
    addressBarView.setBounds(getAddressBarBounds())
  }
  siteView.setBounds(getSiteViewBounds())
  // ⚠️ CRITICAL: zone-disable IPC (§2.5)
  // アドレスバー表示中は上部中央ゾーンを無効化して URL 入力クリックを保護する
  if (!hotspotView.webContents.isDestroyed()) {
    hotspotView.webContents.send('hotspot:set-address-zone-enabled', { enabled: !visible })
  }
}

// リサイズ時の bounds 追従（既存 resize ハンドラを拡張）
win.on('resize', () => {
  siteView.setBounds(getSiteViewBounds())
  overlayView.setBounds(getViewBounds())
  hotspotView.setBounds(getViewBounds())
  settingsView.setBounds(getViewBounds())
  if (toolbarVisible) {
    addressBarView.setBounds(getAddressBarBounds())
  }
})
```

### 6.2 addChildView 順序（z 順確定）

```typescript
win.contentView.addChildView(siteView)         // z:0 — 最背面
win.contentView.addChildView(addressBarView)    // z:1 — siteView の上（toolbar strip）
win.contentView.addChildView(overlayView)       // z:2 — addressBarView より前面（動画フルスクリーン）
win.contentView.addChildView(hotspotView)       // z:3
win.contentView.addChildView(settingsView)      // z:4 — 最前面
```

> **z 干渉メモ:** hotspotView (z:3) > addressBarView (z:1) であるが、`setToolbarVisible` 内で `.zone-top-center` を pointer-events:none にすることで、VISIBLE 時に hotspot ゾーンが URL 入力クリックを横取りしなくなる（§2.5 参照）。

### 6.3 IPC チャネル一覧

#### Renderer → Main

| チャネル | 方向 | 送信元 View | payload | 処理 |
|----------|------|-----------|---------|------|
| `addressbar:get-config` | invoke | addressBarView | なし | `configManager.current` を返す |
| `addressbar:navigate` | invoke | addressBarView | `{url: string}` | `applyUpdate({siteUrl: url})` → ナビゲーション。戻り値: `{ok: boolean, config?: Config, message?: string}` |
| `addressbar:toggle-loop` | invoke | addressBarView | なし | `applyUpdate({loopEnabled: !current.loopEnabled})`。戻り値: 更新後 Config or null |
| `addressbar:reload` | on | addressBarView | なし | `loadSiteUrl(configManager.current.siteUrl)` |
| `hotspot:address-bar-toggle` | on | hotspotView | なし | `inputCoordinator.toggleAddressBarZone()` |

> **設計注記:** `addressbar:navigate` は invoke の戻り値でバリデーション結果（`{ok, message?}`）を返す。旧設計の `addressbar:navigate-error` 別チャネルは**廃止**（二経路競合を排除）。

#### Main → Renderer

| チャネル | 送信先 View | payload | 用途 |
|---------|-----------|---------|------|
| `addressbar:config-updated` | addressBarView | `Config` | config 変更を address bar に通知（三者同期） |
| `settings:updated` | settingsView | `Config` | 既存（変更なし） |
| `hotspot:set-address-zone-enabled` | hotspotView | `{enabled: boolean}` | アドレスバー可視時に `.zone-top-center` を無効化（§2.5 zone-disable 機構） |

> **廃止チャネル:** `addressbar:navigate-error` は廃止。invoke 戻り値 `{ok: false, message: string}` に統一。

#### `settings:update` ハンドラへの追加

```typescript
// 既存コード（変更前）
settingsWebContents.send('settings:updated', updated)

// 変更後（addressBarWebContents に broadcast 追加）
settingsWebContents.send('settings:updated', updated)
deps.addressBarWebContents?.send('addressbar:config-updated', updated)
```

### 6.4 新 IPC RegisterHandlersDeps 追加フィールド

```typescript
export interface RegisterHandlersDeps {
  // ... 既存フィールド ...
  /**
   * addressBarView の WebContents（config 変更の broadcast 先）。
   * 省略可（テストで不要な場合）。
   */
  addressBarWebContents?: WebContentsLike
  /**
   * アドレスバーのナビゲーション要求時フック（applyUpdate 後）。
   * siteView の再ロードを index.ts で担う。onSiteUrlChange と同じ役割だが
   * sender が addressBarView である点でチャネルを分ける。
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
}
```

### 6.5 `src/preload/addressbar.ts` — 公開 API

```typescript
contextBridge.exposeInMainWorld('addressBarApi', {
  getConfig:       () => ipcRenderer.invoke('addressbar:get-config'),
  navigate:        (url: string) => ipcRenderer.invoke('addressbar:navigate', { url }),
  // 戻り値: {ok: boolean, config?: Config, message?: string}
  toggleLoop:      () => ipcRenderer.invoke('addressbar:toggle-loop'),
  reload:          () => ipcRenderer.send('addressbar:reload'),
  onConfigUpdated: (cb: (config: Config) => void) => { ... },  // ipcRenderer.on('addressbar:config-updated', ...)
})
```

> **廃止:** `onNavigateError` コールバックは廃止（invoke 戻り値で判断）。

冪等性保証: `ipcRenderer.on` はモジュールロード時に一度のみ登録（settings.ts と同じパターン）。

### 6.6 `src/main/input-coordinator.ts` — 拡張内容

追加オプション:
```typescript
export interface InputCoordinatorOptions {
  // ... 既存 ...
  onToggleAddressBar?: () => void  // アドレスバートグルコールバック
}
```

追加メソッド:
```typescript
/**
 * Ctrl+L shortcut を登録する。
 * Wayland では登録をスキップし、上部中央ゾーンタップを唯一の経路とする。
 */
registerAddressBarShortcut(): void

/**
 * Ctrl+L shortcut を解除する。
 */
unregisterAddressBarShortcut(): void

/**
 * 上部中央ゾーン単一タップ → アドレスバートグル。
 * カウント不要（専用ゾーン）。即座に onToggleAddressBar() を呼ぶ。
 */
toggleAddressBarZone(): void
```

### 6.7 `src/renderer/hotspot/` — 上部中央ゾーン追加

```html
<!-- index.html に追加 -->
<div class="zone zone-top-center" aria-label="address-bar-zone"></div>
```

```css
/* hotspot.css に追加 */
.zone-top-center {
  position: fixed;
  top: 0;
  left: 50%;
  transform: translateX(-50%);
  width: 200px;
  height: 64px;   /* 隅 40px より大きく、タッチ操作を考慮 */
  background: transparent;
  pointer-events: auto;  /* 既定は有効。アドレスバー表示中は Main の IPC で none に切替 */
}
```

衝突回避確認:
- 既存 `.corner-top-left`: top:0, left:0, 40x40px
- 既存 `.corner-top-right`: top:0, right:0, 40x40px
- 新 `.zone-top-center`: top:0, left:50%-100px 〜 left:50%+100px（中央 200px）
- 1920px 幅の場合: top-left = 0-40px, top-right = 1880-1920px, zone-top-center = 860-1060px → **重複なし**
- 最小幅環境（例: 640px）: top-left = 0-40px, top-right = 600-640px, zone-top-center = 220-420px → **重複なし**

```typescript
// hotspot/main.ts — クリックハンドラ追加
const addressBarZone = document.querySelector<HTMLElement>('.zone-top-center')
addressBarZone?.addEventListener('click', () => {
  window.hotspotApi.sendAddressBarToggle()
})

// hotspot/main.ts — zone-disable IPC 受信 (§2.5 CRITICAL)
window.hotspotApi.onAddressZoneEnabled((enabled: boolean) => {
  if (addressBarZone) {
    addressBarZone.style.pointerEvents = enabled ? 'auto' : 'none'
  }
})
```

```typescript
// preload/hotspot.ts — 追加
sendAddressBarToggle: (): void => {
  ipcRenderer.send('hotspot:address-bar-toggle')
},
onAddressZoneEnabled: (cb: (enabled: boolean) => void): void => {
  ipcRenderer.on('hotspot:set-address-zone-enabled', (_event, payload: {enabled: boolean}) => {
    cb(payload.enabled)
  })
}
```

### 6.8 `addressBarView` WebContentsView 生成仕様（CRITICAL 追加）

> **⚠️ CRITICAL 修正 (Codex #4):** addressBarView の `webPreferences` を明示する。省略すると preload が適用されず IPC が無音で失敗する。

```typescript
// ⚠️ CRITICAL: E-1 にて以下の webPreferences を明示すること
const addressBarView = new WebContentsView({
  webPreferences: {
    preload: join(__dirname, '../preload/addressbar.js'),
    sandbox: true,
    contextIsolation: true,
    nodeIntegration: false,
    partition: '',         // in-memory セッション（§4.2 参照）
  },
})
```

**sender 検証:** `addressbar:*` チャネルのハンドラでは `event.senderFrame` を検証し、addressBarView の webContents 以外からのメッセージを拒否する（既存の `validateSender` パターン踏襲）。

### 6.9 `electron.vite.config.ts` 変更

```typescript
preload: {
  build: {
    rollupOptions: {
      input: {
        overlay:    resolve(__dirname, 'src/preload/overlay.ts'),
        settings:   resolve(__dirname, 'src/preload/settings.ts'),
        hotspot:    resolve(__dirname, 'src/preload/hotspot.ts'),
        addressbar: resolve(__dirname, 'src/preload/addressbar.ts'),  // 追加
      },
    },
  },
},
renderer: {
  build: {
    rollupOptions: {
      input: {
        overlay:    resolve(__dirname, 'src/renderer/overlay/index.html'),
        settings:   resolve(__dirname, 'src/renderer/settings/index.html'),
        hotspot:    resolve(__dirname, 'src/renderer/hotspot/index.html'),
        addressbar: resolve(__dirname, 'src/renderer/addressbar/index.html'),  // 追加
        start:      resolve(__dirname, 'src/renderer/start/index.html'),       // 追加
      },
    },
  },
},
```

---

## 7. テストケースリスト

### 7.1 ユニットテスト（Vitest）

#### 7.1.1 スキーマ変更（`test/unit/schema.test.ts` 追加）

- [正常] `ConfigSchema.parse({ siteUrl: '', ... })` → 成功
- [正常] `ConfigSchema.parse({ siteUrl: 'https://example.com', ... })` → 成功（既存）
- [正常] `ConfigSchema.parse({ siteUrl: 'http://localhost:8080', ... })` → 成功（http は有効）
- [異常] `ConfigSchema.parse({ siteUrl: 'ftp://example.com', ... })` → 拒否（既存）
- [異常] `ConfigSchema.parse({ siteUrl: 'javascript:alert(1)', ... })` → 拒否（既存）
- [正常] `ConfigUpdateSchema.parse({ siteUrl: '' })` → 成功（partial 更新で空文字 OK）
- [エッジ] `ConfigUpdateSchema.parse({})` → 成功（siteUrl 省略 = partial）

#### 7.1.2 ConfigManager マイグレーション（`test/unit/config.test.ts` 追加）

- [正常] `migrateLegacySiteUrl(config, manager)`: siteUrl='http://localhost:8080' → 空文字に変換・applyUpdate が呼ばれる
- [正常] `migrateLegacySiteUrl`: siteUrl='https://example.com' → 変更なし（呼び出し元に同じ値を返す）
- [正常] `migrateLegacySiteUrl`: siteUrl='' → 変更なし
- [異常] `migrateLegacySiteUrl`: applyUpdate が null を返す → 元の config を返す（サイレント障害なし・CRITICAL）
- [正常] `DEFAULT_CONFIG.siteUrl === ''` を確認
- [正常] 空文字 siteUrl で `load()` → そのまま返す（補完なし）
- **[結合] 初回起動 siteUrl='' → `loadSiteUrl` が `loadURL('')` でなく `loadFile(startPagePath)` を呼ぶ（黒画面回帰なし）**
- **[結合] 旧 config siteUrl='http://localhost:8080' → migrateLegacySiteUrl 後 `loadURL('http://localhost:8080')` が呼ばれないこと**

#### 7.1.3 site-load-retry（`test/unit/site-load-retry.test.ts` 追加）

- [正常] `MAX_RETRY_ATTEMPTS` が 3 であることを確認
- [正常] 3 回 `onLoadFail()` 後の `attempt > MAX_RETRY_ATTEMPTS` フラグを index.ts が参照できること
- （純関数のテストは既存のもので充足）

#### 7.1.4 InputCoordinator 拡張（`test/unit/input-coordinator.test.ts` 追加）

- [正常] `registerAddressBarShortcut()`: X11 環境で 'Control+L' が登録される
- [正常] `registerAddressBarShortcut()`: Wayland 環境でスキップ（WARN ログ）
- [正常] `registerAddressBarShortcut()` 二重呼び出し → 二重登録されない
- [正常] `unregisterAddressBarShortcut()`: 登録済みなら解除、未登録なら no-op
- [正常] `toggleAddressBarZone()`: `onToggleAddressBar()` が呼ばれる
- [エッジ] `onToggleAddressBar` が未定義の場合 → `toggleAddressBarZone()` が no-op（TypeError なし）
- [エッジ] Ctrl+L 発火 → `onToggleAddressBar()` が呼ばれる

#### 7.1.5 IPC 新チャネル（`test/unit/ipc.test.ts` 追加）

- [正常] `addressbar:get-config` — addressBarView sender → `configManager.current` を返す
- [異常] `addressbar:get-config` — settingsView sender → 拒否（`ipc.invalidSender` ログ）
- [正常] `addressbar:navigate` — valid URL → invoke 戻り値 `{ok: true, config}` + `onAddressBarNavigate` フック呼び出し
- [正常] `addressbar:navigate` — URL 変更なし → `onAddressBarNavigate` 呼ばれない
- [異常] `addressbar:navigate` — invalid URL (ftp://) → invoke 戻り値 `{ok: false, message: '...'}`（`addressbar:navigate-error` IPC は発行しない）
- [異常] `addressbar:navigate` — 不正 sender → 拒否
- [正常] `addressbar:toggle-loop` — loopEnabled=true → `applyUpdate({loopEnabled: false})` 呼び出し
- [正常] `addressbar:toggle-loop` — `orchestrator.updateConfig({loopEnabled})` 呼び出し
- [正常] `addressbar:toggle-loop` — `addressBarWebContents.send('addressbar:config-updated', ...)` 呼び出し
- [正常] `addressbar:toggle-loop` — `settingsWebContents.send('settings:updated', ...)` 呼び出し（三者同期）
- [正常] `addressbar:reload` — `onAddressBarReload()` フック呼び出し
- [正常] `settings:update({loopEnabled})` 成功時 → `addressBarWebContents.send('addressbar:config-updated', ...)` も呼ばれる（新規追加）
- [異常] `addressBarWebContents` が未定義の場合 → `settings:update` ハンドラが TypeError をスローしない

#### 7.1.6 SettingsController 変更（`test/unit/settings-controller.test.ts` 追加）

- **[正常] `validateUrl('')` → `{valid: true}` を返す（設定パネルから空文字で URL をクリアできる）**
- **[正常] `setUrl('')` → `_saveAndApply({siteUrl: ''})` が呼ばれる**
- **[正常] `applyExternalConfig(externalConfig)` → `this._config` が externalConfig に更新される**
- **[順序] アドレスバーで loopEnabled=ON→OFF 切替 → `onUpdated` で `applyExternalConfig(updated)` 呼び出し後、`toggleLoop()` が `!false=true` を送信（正しく反転）**
- **[順序] アドレスバーで loopEnabled=OFF→ON 切替 → `onUpdated` で `applyExternalConfig(updated)` 呼び出しなし（stale=ON のまま）→ `toggleLoop()` が `!ON=OFF` を送信（誤動作）** ← このケースが失敗することで stale バグを検出する Red テスト
- [正常] `validateUrl('https://example.com')` → `{valid: true}`（既存）
- [異常] `validateUrl('ftp://example.com')` → `{valid: false, message: '...'}`（既存）

#### 7.1.7 startPage 無限ループ防止（`test/unit/site-load-retry.test.ts` または新規）

- **[異常] `inLocalFallback=true` 中に `did-fail-load` 発火 → リトライしない（logError のみ）**
- **[異常] startPage（file://）が `ERR_FILE_NOT_FOUND(-6)` を発火 → `inLocalFallback=true` のためリトライカウンタがリセットされない**
- **[正常] 3 回失敗後 `loadStartPage()` → `inLocalFallback=true` → 次の `did-fail-load` でリトライなし（ループ脱出）**

### 7.2 結合テスト（Vitest）

- [正常] `addressbar:navigate` → `configManager.applyUpdate` → `onAddressBarNavigate` → siteView 再ロードの一連フロー
- [正常] `addressbar:toggle-loop` → config 更新 → settingsView・addressBarView 両方に broadcast
- [正常] `settings:update({siteUrl})` → `onSiteUrlChange` → `loadSiteUrl` の既存フロー（regression）
- [正常] `migrateLegacySiteUrl` → `configManager.applyUpdate` → 空文字に変換
- **[正常] アドレスバーで loopEnabled 切替 → `settings:updated` → `controller.applyExternalConfig` 呼び出し → controller._config が最新値になる**
- **[正常] `setToolbarVisible(true)` → `hotspot:set-address-zone-enabled {enabled: false}` が hotspotView へ送信される**
- **[正常] `setToolbarVisible(false)` → `hotspot:set-address-zone-enabled {enabled: true}` が hotspotView へ送信される**

### 7.3 E2E テスト（Playwright）

- [正常] 起動時: siteUrl='' → アドレスバーが表示されている（既定で表示）
- [正常] 起動時: siteUrl='' → startPage が表示される（ネットワークエラーなし）
- **[正常] 起動時: siteUrl='' → `loadURL('')` が呼ばれていないこと（コンソールエラーなし）**
- [正常] Ctrl+L → アドレスバーが表示される / 再度 Ctrl+L → 非表示
- [正常] URL を入力して Enter → siteView がそのURLをロード → アドレスバーが非表示になる
- [正常] URL を入力して[表示]ボタン → 同上
- [正常] URL 設定後に再起動 → config.siteUrl が永続化されておりそのURLがロードされる
- [異常] 無効な URL（ftp://xxx）を入力 → エラーメッセージ表示、ナビゲーション不発
- [正常] did-fail-load（3 回）→ startPage にフォールバック（赤いエラーなし）
- [正常] did-fail-load → アドレスバーが自動表示される
- [正常] アドレスバーのループトグル ON→OFF → settingsView 開いてループトグルも OFF になっている
- [正常] settingsView のループトグル OFF→ON → アドレスバーのループトグルも ON になっている
- [正常] overlayView 動画再生中 → アドレスバーが表示状態でも overlayView が完全にカバー（全画面動画）
- [正常] 上部中央ゾーンタップ → アドレスバー表示（Wayland 相当テスト）
- [正常] 既存: Ctrl+G / 隅 3 回タップ → 設定パネル（regression）
- [正常] siteUrl='http://localhost:8080' 既存 config.json → 起動後 siteUrl='' に変換・startPage 表示
- [エッジ] アドレスバー表示中にリサイズ → siteView bounds が正しく再計算される
- **[CRITICAL] アドレスバーが VISIBLE のとき、URL 入力欄をクリック → フォーカスが当たる（hotspot ゾーンがクリックを横取りしない）**
- **[CRITICAL] アドレスバーが VISIBLE のとき、URL 入力欄にテキストを入力できる**
- **[CRITICAL] startPage ファイルが欠落したビルドでアプリ起動 → 黒画面になるが再起動・エラーログ増殖しない（inLocalFallback により無限ループしない）**
- **[CRITICAL] アドレスバーで loopEnabled を切替後、直後に設定パネルでトグルを 1 回押す → 正しく反転している（stale 二度押し不要）**

---

## 8. エラー＆レスキューマップ

| 処理 | 想定される異常 | ハンドリング方法 | ユーザーへの影響 |
|------|---------------|----------------|----------------|
| `migrateLegacySiteUrl()` | `applyUpdate()` が null を返す（内部エラー） | 元の config を返す（移行せず続行）。did-fail-load フォールバックで startPage に到達できる | localhost:8080 へのロード試行が 3 回発生後に startPage へ落ちる。影響軽微 |
| **`migrateLegacySiteUrl()` 後の local config 変数未更新** | `migrateLegacySiteUrl` 呼び出しの戻り値を再代入しない（取りこぼし） | `let config = configManager.load(); config = migrateLegacySiteUrl(config, configManager)` として必ず再代入する。CI/テストで「初回起動で `loadURL('')` でなく `loadFile` が呼ばれること」を検証 | 旧 URL `http://localhost:8080` が `loadURL` に渡され黒画面回帰。要件①が保証されない |
| **`loadStartPage()` — file:// ロード失敗** | startPage HTML が欠落・破損（`ERR_FILE_NOT_FOUND` 等で `did-fail-load` 発火） | `inLocalFallback=true` 設定後に `loadFile` を呼ぶ。`did-fail-load` ハンドラは `inLocalFallback===true` の場合 `logError` 1 回のみ・リトライなし（無限ループ防止）。CI で startPage HTML の存在を検証 | 画面は黒のまま。再起動後も同じだが CPU 消費・エラーの山は発生しない |
| `loadSiteUrl(url)` — url=非空 | 接続拒否 / タイムアウト | `did-fail-load` → 最大 3 回リトライ → startPage フォールバック。`inLocalFallback = true` | 最大 7 秒（1+2+4s）の待機後 startPage 表示。エラー画面なし |
| **アドレスバー VISIBLE 中に hotspot 上部中央ゾーンが URL クリックを横取り** | hotspotView (z:3) > addressBarView (z:1) であるため `.zone-top-center` が click を奪う | `setToolbarVisible(true)` 時に `hotspot:set-address-zone-enabled {enabled:false}` を送信し `.zone-top-center` を `pointer-events:none` に切替 | ユーザーが URL 入力欄をタップできない（アドレスバー機能が成立しない）→ zone-disable で解消 |
| **設定パネル側 SettingsController._config が stale** | アドレスバーで loopEnabled を変更後、パネルのトグルが古い値で誤書き込みする | `settings/main.ts` の `onUpdated` で `controller.applyExternalConfig(config)` を呼び、_config を常に最新化。テストでアドレスバー切替→パネル切替の順序ケースを追加 | トグルが「効かない / 二度押し必要」無音の誤動作 |
| `addressbar:navigate` — URL バリデーション失敗 | ftp:// 等の不正スキーム | `applyUpdate` 拒否 → invoke 戻り値 `{ok: false, message: '...'}` → addressBar がエラー表示 | アドレスバーにエラーメッセージ表示。ナビゲーション不発 |
| `addressbar:navigate` — `applyUpdate` 保存失敗 | electron-store 書き込みエラー | `applyUpdate` が null を返す → invoke 戻り値 `{ok: false, message: '...'}` + logError 出力 | アドレスバーにエラー表示。ナビゲーション不発。次回起動時は旧 URL を使用 |
| `addressbar:toggle-loop` — `applyUpdate` 失敗 | 保存エラー | null 返却。loopEnabled は変更されない。UI は invoke 戻り値が null のため更新しない（楽観的更新禁止） | トグルが効かず視覚的フィードバックなし。logError から問題を検知できる |
| **設定パネルから空文字 URL を保存しようとする** | `SettingsController.validateUrl('')` が旧実装で拒否 | `validateUrl('')` を `{valid: true}` を返すよう変更（§5.6）。`setUrl('')` → `applyUpdate({siteUrl:''})` → startPage 表示 | 変更前: UI エラーが出てクリアできない。変更後: 正常にスタート画面へ戻れる |
| **addressBarView preload/session 未指定** | WebPreferences を省略すると preload が適用されず `addressBarApi` が undefined | E-1 にて §6.8 の WebPreferences ブロックを必ず記述。起動時アサーションで `addressBarApi` の存在確認 | IPC が無音で失敗。アドレスバーが完全に無反応 |
| `addressBarWebContents.send('addressbar:config-updated')` | addressBarView がクラッシュ後 `render-process-gone` → 再ロード前に send | Electron の内部 send: renderer が存在しない場合は silently dropped | addressBar の表示がズレる可能性。render-process-gone ハンドラ（既存パターン）で再ロード後に `addressbar:get-config` で再取得される |
| `addressBarView.render-process-gone` | addressBar renderer がクラッシュ | `loadAddressBar()` で再ロード（overlayView/settingsView と同じパターン）。toolbarVisible 状態は Main 側で保持しているため再ロード後も correct | アドレスバーが一時的に白/空になる。数秒で復帰 |
| `setToolbarVisible(true)` — `addressBarView.setBounds()` 失敗 | 極めて稀（内部エラー） | Electron の setBounds はスローしない。no-op | レイアウトが崩れる可能性。次の resize イベントで補正される |
| `hotspot:address-bar-toggle` — 不正 sender | hotspot 以外の View から送信 | `validateSender(event, 'hotspot', ...)` → 拒否 + logError | アドレスバーはトグルされない |
| **`hotspot:set-address-zone-enabled` 送信時に hotspotView が未ロード / クラッシュ中** | `hotspotView.webContents.isDestroyed()` が true | `isDestroyed()` チェック後に send（§6.1 参照）。hotspot は render-process-gone で自動リロード、リロード後に `toolbarVisible` の現状態に応じて zone 状態を復元（`loadHotspot()` 後に `setToolbarVisible(toolbarVisible)` を再適用） | アドレスバーが VISIBLE 中に hotspot がクラッシュすると zone-disable が失われ URL クリックが奪われる可能性。hotspot 再ロード時に補正される |
| `isAllowedNavUrl('', '')` — 空 siteUrl 時の will-navigate | startPage 内から外部ナビゲーション発生（想定外） | false を返す → `details.preventDefault()` → ナビゲーション阻止 | startPage 内の外部リンクが動作しない。startPage 設計時に外部リンクを含めないことで回避 |
| Ctrl+L 登録失敗（X11 でも） | 他プロセスが 'Control+L' を占有 | `registerAddressBarShortcut()` が false → WARN ログ。上部中央ゾーンタップが唯一の経路になる | キーボードショートカットが使えないが、タッチ操作で代替可能 |
| **`addressbar:*` IPC の sender spoof** | addressBarView 以外（siteView 等）から IPC 送信 | `validateSender(event, 'addressbar', ...)` で拒否・logError 出力 | 不正操作は無効化される |

---

## 9. 実装ステップ順序

### Phase A — スキーマ・基盤変更（最小影響範囲）

**A-1: スキーマ変更 + テスト（Red→Green）**
1. `test/unit/schema.test.ts` に空文字 siteUrl テストを追加 → Red
2. `src/shared/schema.ts` を変更（`optionalSiteUrlSchema`） → Green

**A-2: DEFAULT_CONFIG 変更 + マイグレーション関数 + テスト（Red→Green）**
1. `test/unit/config.test.ts` に `migrateLegacySiteUrl` テスト追加（黒画面回帰テストを含む）→ Red
2. `src/main/config.ts`: `DEFAULT_CONFIG.siteUrl = ''`、`migrateLegacySiteUrl()` 追加 → Green

**A-3: SettingsController 変更 + テスト（Red→Green）**
1. `test/unit/settings-controller.test.ts` に `applyExternalConfig`・`validateUrl('')`・順序テスト追加 → Red
2. `src/renderer/settings/settings-controller.ts`: `applyExternalConfig()` 追加・`validateUrl('')` 変更 → Green
3. `src/renderer/settings/main.ts`: `onUpdated` に `controller.applyExternalConfig(config)` 追加 → Green

**A-4: site-load-retry 定数追加**
1. `MAX_RETRY_ATTEMPTS = 3` を `site-load-retry.ts` にエクスポート

### Phase B — InputCoordinator 拡張（独立モジュール）

**B-1: InputCoordinator テスト追加 → Red**
**B-2: `registerAddressBarShortcut()` / `unregisterAddressBarShortcut()` / `toggleAddressBarZone()` 実装 → Green**

### Phase C — IPC 拡張

**C-1: IPC テスト追加（addressbar:* チャネル）→ Red**
**C-2: `src/main/ipc.ts` に addressbar チャネル追加・`addressBarWebContents` deps 追加 → Green**
- `addressbar:navigate-error` IPC は廃止し、invoke 戻り値 `{ok, message?}` に統一
**C-3: `settings:update` ハンドラに `addressbar:config-updated` broadcast 追加 → Green**

### Phase D — 新レンダラ / preload 作成

**D-1: `src/renderer/start/index.html` 作成**（静的・UI のみ）

**D-2: `src/preload/addressbar.ts` 作成**
- `getConfig`, `navigate`, `toggleLoop`, `reload`
- `onConfigUpdated` コールバック登録（`onNavigateError` は廃止）

**D-3: `src/renderer/addressbar/` 作成**
- `index.html`: 48px 高、ボタン・input・ループトグル配置
- `styles.css`: 固定高 48px、横幅 100%、ダークテーマ
- `main.ts`: `window.addressBarApi` を使用した UI ロジック。`navigate` invoke 戻り値の `{ok, message}` でエラー表示

**D-4: hotspot 拡張**
- `hotspot.css`: `.zone-top-center` 追加（pointer-events: auto が既定）
- `hotspot/index.html`: 上部中央ゾーン `<div>` 追加
- `hotspot/main.ts`: `sendAddressBarToggle()` 呼び出し追加；`onAddressZoneEnabled` 受信で pointer-events 切替（CRITICAL）
- `preload/hotspot.ts`: `sendAddressBarToggle()` 追加；`onAddressZoneEnabled(cb)` 追加（CRITICAL）

**D-5: `electron.vite.config.ts` 更新**（addressbar/start エントリ追加）

### Phase E — index.ts 統合（最終結線）

**E-1: `addressBarView` WebContentsView 生成・addChildView**
- §6.8 の WebPreferences ブロック（preload, sandbox, contextIsolation, nodeIntegration, partition=''）を**必ず**明示する（CRITICAL）
- z 順を siteView → addressBarView → overlayView → hotspotView → settingsView に変更

**E-2: 動的レイアウト実装**
- `TOOLBAR_HEIGHT` 定数
- `toolbarVisible` フラグ
- `inLocalFallback` フラグ（§2.4 CRITICAL 追加）
- `setToolbarVisible()` 関数（zone-disable IPC 送信含む）
- `resize` ハンドラ拡張（既存 resize ハンドラ内に addressBarView の bounds 更新を追加）

**E-3: loadStartPage / loadAddressBar ヘルパー追加**
- `loadStartPage()`: `inLocalFallback = true` 設定後 `loadFile`

**E-4: `loadSiteUrl()` 拡張**
- `url === ''` 分岐 → `loadStartPage()`（`inLocalFallback = true`）
- それ以外 → `inLocalFallback = false` + 既存の `siteView.webContents.loadURL(url)`

**E-5: `did-fail-load` ハンドラ変更**
- `inLocalFallback === true` の場合: `logError` 1 回のみ・リトライなし（**CRITICAL: 無限ループ防止**）
- `MAX_RETRY_ATTEMPTS` 超過 → `loadStartPage()` + `siteRetryState = createRetryState()`
- ログを `logError` → `logWarn` に格下げ
- フォールバック時にアドレスバーを自動表示（`setToolbarVisible(true)`）

**E-6: 起動時ロジック変更（CRITICAL）**
1. `const config = configManager.load()` → **`let config = configManager.load()`** に変更
2. `config = migrateLegacySiteUrl(config, configManager)` を直後に追加（**戻り値を再代入**）
3. 既存 L581-588 の `siteView.webContents.loadURL(config.siteUrl)` を**撤去**し `loadSiteUrl(config.siteUrl)` に完全置換
4. `config.siteUrl === ''` の場合 `setToolbarVisible(true)`（startPage 表示後 toolbar を自動展開）

**E-7: registerHandlers 呼び出し更新**
- `addressBarWebContents`、`onAddressBarNavigate`、`onToggleAddressBar`、`onAddressBarReload` 追加

**E-8: inputCoordinator 拡張の結線**
- `onToggleAddressBar: () => setToolbarVisible(!toolbarVisible)` 追加
- `registerAddressBarShortcut()` 呼び出し

**E-9: addressBarView `render-process-gone` ハンドラ追加**
- クラッシュ後の再ロード: `loadAddressBar()` 後に `setToolbarVisible(toolbarVisible)` を再適用してゾーン状態を復元

### Phase F — リファクタリング

- `setToolbarVisible` のエラーハンドリング追加（bounds 設定失敗時の WARN ログ）
- index.ts のコメント更新（z 順コメント更新・`inLocalFallback` 説明）
- 未解決事項のドキュメント化

---

## 10. 未解決の設計判断

### 10.1 ナビゲーション後のアドレスバー自動非表示

URL 入力 Enter 後にアドレスバーを自動非表示にするかどうか。

- 採用案: ロード成功（`did-finish-load` & `!failedSinceStart`）後に `setToolbarVisible(false)` を呼ぶ
- 非採用案: 常にユーザーが明示的に Ctrl+L で閉じる

**推奨:** 自動非表示（看板用途では不要な chrome を隠す）。ただし `did-fail-load` 時は非表示にしない（URL を再入力できるように）。**アーキテクトに確定を依頼。**

### 10.2 addressBarView のセッション（方針確定）

**採用: in-memory セッション（`partition: ''`）**

理由: addressBarView は信頼済み Chrome View であり、Cookie/キャッシュの永続化は不要。`persist:addressbar` を使うとデフォルトセッションの共有リスクはないが、不要な永続化ストアが増える。`partition: ''` により完全に in-memory で分離され siteView（`persist:site`）との混入を防ぐ。

### 10.3 startPage のデザイン

- 最低限: 「URLを入力してください」テキスト + Ctrl+L / 上部タップの説明
- 追加候補: QR コード表示、ブランドロゴなど
- **本計画では最低限 HTML のみを想定。** デザイン詳細はアーキテクト/デザイナーに委ねる。

### 10.4 Wayland 環境での `hotspot:address-bar-toggle` 受信確認

Wayland で `hotspot:tap` が実際に届くかどうかは既存の未確認項目（E2E-13 未検証）に依存する。`hotspot:address-bar-toggle` も同様に実機（Raspberry Pi / Wayland）での E2E 検証が必要。

### 10.5 上部中央ゾーン(200x64)による中央上部クリック不活性化 [INFORMATIONAL 対応済]

`.zone-top-center` は幅 200px・高さ 64px と大きく、サイト中央上部（ロゴ・グローバルナビ）のクリックを常時奪う可能性がある。

**対応方針（採用）:**
- アドレスバー VISIBLE 中は zone-disable IPC で pointer-events:none → サイト閲覧中は影響なし
- アドレスバー HIDDEN 中（= サイト表示中）は 200x64 が中央上部に常駐する。この点はトレードオフとして許容する
- 将来的な改善案: ゾーン高さを縮小（64→32px）、または半透明デバッグ可視化での実機確認をリリース前に実施することを推奨

### 10.6 単一タップによる誤発火リスク [INFORMATIONAL 対応済]

設定パネルは「1.5 秒以内に隅 3 回」と意図的に出しにくいが、アドレスバーは中央上部 1 回タップで露出する。通行人の偶発タップでバーが表示される可能性がある。

**対応方針（見送り・将来改善候補）:**
- 本 MVP では単一タップ仕様を維持する
- 今後の改善案として「長押し（500ms）トリガー」または「設定ジェスチャ（隅 3 回）と同じ敷居」を未解決事項に残す

### 10.7 任意 http/https 先への無制限ナビゲーション [INFORMATIONAL 対応済]

公共設置時に通行人が任意ブラウジング可能になるリスクがある。

**対応方針（見送り・将来改善候補）:**
- 本 MVP ではスコープ外
- 将来改善案: アドレスバー露出を既存設定ジェスチャ配下に置く / PIN 化 を未解決事項として記録

---

## 付録: loopEnabled セマンティクス確認結果

`src/shared/types.ts`: `/** 広告割り込み機能の有効/無効 */`

`src/main/scheduler/scheduler.ts` `_doFire()` 内:
```typescript
if (!this.loopEnabled) {
  // loopEnabled=false → 割り込み再生サイクルを発火しない
  return
}
```

`src/renderer/settings/index.html`: ボタン id=`loop-toggle`、ラベルテキスト「広告ループ」

**確認済み:** `loopEnabled` = 「広告割り込み再生サイクル全体の ON/OFF」。単一動画のリピート再生ではない。

アドレスバーの UI ラベル: **「広告ループ」**、aria-label: **「広告ループ ON/OFF」**、状態表示: ON / OFF テキスト + 視覚的差異（色・アイコン）。

---

## 11. レビュー反映ログ

### OPUS_REVIEW 対応状況

| # | 指摘タイトル | 種別 | 対応状況 | 対応章 |
|---|------------|------|---------|-------|
| 1 | z順の破綻: hotspotView が addressBarView より前面で URL 入力を横取り | CRITICAL | **反映済** | §2.5・§6.1・§6.7・§8・§9 D-4/E-2 |
| 2 | ループ三者同期が単一真実源になっておらず設定パネル側が古い値で誤書き込み | CRITICAL | **反映済** | §2.7・§3.2・§5.6・§7.1.6・§8・§9 A-3 |
| 3 | startPage フォールバック失敗時に無限リトライループへ陥る | CRITICAL | **反映済** | §2.4・§6.1・§7.1.7・§8・§9 E-3/E-5 |
| 4 | 起動時の初期ロードが直接 loadURL 経路のままで黒画面回帰 | CRITICAL | **反映済** | §2.6・§3.2・§8・§9 E-6 |
| I-1 | 上部中央ゾーン(200x64)がサイト中央上部を不活性化 | INFORMATIONAL | **方針記載** | §10.5（zone-disable で VISIBLE 中は無効、HIDDEN 中はトレードオフ許容） |
| I-2 | 単一タップ表示トリガーは誤発火しやすい | INFORMATIONAL | **方針記載（見送り）** | §10.6 |
| I-3 | 任意 http/https 先への無制限ナビゲーション | INFORMATIONAL | **方針記載（見送り）** | §10.7 |
| I-4 | navigate チャネルが invoke 戻り値と navigate-error を併用しデッドパス | INFORMATIONAL | **採用（修正反映）** | §2.2・§6.3（navigate-error 廃止・invoke 戻り値に統一） |
| I-5 | テスト網羅の不足 | INFORMATIONAL | **採用（反映済）** | §7.1.6・§7.1.7・§7.2・§7.3 に不足テストを追加 |

### CODEX_REVIEW 対応状況

| # | 指摘タイトル | 種別 | 対応状況 | 対応章 |
|---|------------|------|---------|-------|
| 1 | Legacy migration result が起動時 local config 変数に反映されない | CRITICAL | **反映済**（Opus #4 と重複） | §2.6・§9 E-6 |
| 2 | Top-center hotspot が addressBar 入力を interceptする | CRITICAL | **反映済**（Opus #1 と重複） | §2.5・§6.7・§9 D-4 |
| 3 | 空 siteUrl が schema で許容されても settings-controller が拒否する | CRITICAL | **反映済** | §5.6・§3.2・§7.1.6 |
| 4 | addressBarView WebPreferences が未指定 | CRITICAL | **反映済** | §6.8・§9 E-1 |
| I-1 | Checkpoint① migration 保証が弱い | INFORMATIONAL | **採用**（Codex #1 に含む） | §2.6・§9 E-6 |
| I-2 | Checkpoint② zone geometry OK だが z-order 競合 | INFORMATIONAL | **採用**（Codex #2 に含む） | §2.5 |
| I-3 | Checkpoint③ overlayView z-order は正しい | INFORMATIONAL | **確認済み・変更なし** | — |
| I-4 | Checkpoint④ 空 URL の schema/UI ギャップ | INFORMATIONAL | **採用**（Codex #3 に含む） | §5.6 |
| I-5 | Checkpoint⑤ Wayland fallback は hotspot 経由で存在する | INFORMATIONAL | **確認済み** | §10.4 |
| I-6 | Checkpoint⑥ loop toggle 楽観的更新リスク | INFORMATIONAL | **採用** | §2.7（addressbar renderer での楽観的更新禁止を明記） |
| I-7 | addressBarView session 未確定 | INFORMATIONAL | **採用（方針確定）** | §10.2（in-memory に決定） |
| I-8 | startPage loadFile 失敗の recovery path | INFORMATIONAL | **採用**（Opus #3 と重複。CRITICAL として対応済み） | §2.4・§8 |
| I-9 | hotspot renderer クラッシュで Wayland fallback が消える | INFORMATIONAL | **方針記載** | §8（hotspot クラッシュ後のゾーン状態復元を E-9 で対応） |
| I-10 | resize ハンドラ拡張が暗黙 | INFORMATIONAL | **採用** | §6.1（resize ハンドラのスニペットに addressBarView を明示） |

### エラー＆レスキューマップ ギャップ補完状況

| ギャップ | 対応状況 |
|---------|---------|
| startPage file:// 無限リトライ防止（Opus） | §8 に「`loadStartPage()` — file:// ロード失敗」行を追加、`inLocalFallback` 機構を記載 |
| SettingsController._config stale 競合（Opus） | §8 に「設定パネル側 SettingsController._config が stale」行を追加 |
| 初回起動 local config 未更新による黒画面回帰（Opus/Codex） | §8 に「`migrateLegacySiteUrl()` 後の local config 変数未更新」行を追加 |
| hotspot 上部中央ゾーンが URL クリックを横取り（Opus/Codex） | §8 に「アドレスバー VISIBLE 中に hotspot 上部中央ゾーンが URL クリックを横取り」行を追加 |
| addressbar IPC sender 非検証（Opus） | §8 に「`addressbar:*` IPC の sender spoof」行を追加 |
| settings-controller が空 URL を拒否（Codex） | §8 に「設定パネルから空文字 URL を保存しようとする」行を追加 |
| addressBarView webPreferences 未指定（Codex） | §8 に「addressBarView preload/session 未指定」行を追加 |
| hotspot クラッシュで zone-disable 状態が失われる（Codex） | §8 に「`hotspot:set-address-zone-enabled` 送信時に hotspotView が未ロード」行を追加 |
