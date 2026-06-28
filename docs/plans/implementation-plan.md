# デジタルサイネージ 動画オーバーレイ Electron アプリ — 実装計画書

バージョン: v3.1.0
作成日: 2026-06-27
改訂日: 2026-06-27
改訂理由: Codex収束確認の軽微回帰4件修正（§3.5文言統一・US-08 IPC経路明記・§7.1.2監査修正・§7.1.1 T32分割表記）

---

## 1. 背景・目的

### 1.1 問題の所在：純 Web の 2 つの壁

既存のデジタルサイネージは外部 URL（商用 SaaS）で運営されており、そこへ広告動画を「割り込みオーバーレイ」させたい。純粋な Web アプリでこれを実現しようとすると、以下 2 つの構造的な制約に阻まれる。

| 壁 | 内容 | 純 Web での回避不可な理由 |
|----|------|--------------------------|
| **ローカルフォルダ読み取り不可** | ブラウザの File System API はユーザー操作（ファイル選択ダイアログ）を必須とし、起動時の自動走査ができない | セキュリティモデル上、バックグラウンドでのローカル fs アクセスは禁止 |
| **iframe 拒否（X-Frame-Options / CSP）** | 多くの商用サイネージ SaaS は `X-Frame-Options: SAMEORIGIN` または `frame-ancestors 'none'` を付与しており、別オリジンからの埋め込みを拒否する | リクエストヘッダーを書き換えられない |

### 1.2 Electron 取り込み型での回避

Electron は Node.js ランタイム（fs/chokidar）と Chromium（BrowserEngine）を同一プロセスグループで動かす。`session.webRequest.onHeadersReceived` でレスポンスヘッダーを書き換えることで `X-Frame-Options` / `frame-ancestors` を無効化し、既存サイネージ URL を内部表示できる。ローカルファイルアクセスは Main プロセスが直接 fs を叩く。

### 1.3 目的の要約

- Linux(Ubuntu 開発機) + 本番 Raspberry Pi 4 で動作する、枠なし全画面のデジタルサイネージ広告割り込みアプリを構築する
- 下層：既存サイネージサイト(URL)を内部表示し、継続再生を中断しない
- 上層：一定間隔ごとに動画 1 本をフェードイン/アウトで割り込ませる
- 設定はパネルでワンタップ変更、再起動後も維持する
- 空フォルダ・破損動画・設定破損・ネット断のいずれでも停止しない

---

## 2. 確定仕様

| 項目 | 仕様 |
|------|------|
| **ターゲット OS** | Ubuntu (x86_64 開発) / Raspberry Pi OS 64bit (arm64 本番) |
| **形態** | Electron デスクトップアプリ（取り込み型） |
| **下層表示** | 固定 URL のサイネージサイト（ログイン/Cookie 保持なし）|
| **動画フォルダ** | ローカルフォルダをユーザーが指定（設定パネルで変更可）|
| **動画フォーマット** | H.264 MP4 (`.mp4`) 前提。1080p/yuv420p |
| **巡回方式** | フォルダ内をファイル名昇順で 1 本ずつ順番に巡回。1 本なら毎回同一 |
| **巡回カーソル** | 「最後に再生したファイル名」で保持。再走査・再ソート後はその次の昇順要素から再開。カーソル対象削除時は次要素へ。再起動で先頭リセット（永続化しない）|
| **割り込み間隔** | 5 / 10 / 15 / 30 分から選択（短縮確認用に 1 分も利用可）|
| **スケジューラ計時基準** | **直前の割り込み終了時刻 + interval** で再装填。再生中は計時停止（再生完了起点）。多重発火スキップ = IDLE 以外の状態での発火は no-op |
| **ループ ON/OFF** | 広告割り込み機能自体の有効/無効。設定パネルでワンタップ |
| **1 回の割り込み** | 動画 1 本のみ |
| **音声** | 常時ミュート（`<video muted>`）|
| **フェード** | CSS opacity フェード（≈1000ms、設定可）。黒チラなし |
| **設定パネル** | `Ctrl+G`（X11 ベストエフォート）+ 隅 3 回タップ（Wayland/X11 共通・常設正規経路）の両対応。普段は隠れている |
| **設定永続化** | `electron-store`（アトミック書き込みはライブラリに委譲）+ zod 検証。再起動後も維持 |
| **動画配信プロトコル** | カスタムプロトコル `media://` を `protocol.handle` で登録し Range リクエスト対応で配信。`file://` 直読は禁止 |
| **自動起動** | systemd --user（主）+ `.desktop` フォールバック |
| **スリープ抑止** | `powerSaveBlocker`（主）+ OS 設定（従）|
| **フォルダ監視** | chokidar v4（`awaitWriteFinish` でコピー途中の巨大 MP4 を誤読しない）|
| **隅 3 タップ** | いずれかの隅・1.5 秒以内に 3 回 |
| **定時再起動** | 既定 OFF（後付けで任意追加可）|

---

## 3. 技術選定と根拠

### 3.1 技術スタック

| レイヤー | 技術 | バージョン方針 | 採用根拠 |
|---------|------|--------------|---------|
| アプリフレームワーク | **Electron** | **v33.x.x 以上 完全固定（`^` 禁止）。arm64 プリビルド存在確認済みバージョンを使用**。Electron 30 以降で BrowserView 非推奨（WebContentsView は v30 で正式採用）| 2 つの壁を同時に回避できる唯一の選択肢 |
| 言語 | **TypeScript** | `strict: true` + `noUncheckedIndexedAccess: true` | 型安全・サイレント障害をコンパイル時に検出 |
| ビルドツール | **electron-vite** | 最新安定版 | Electron 向けマルチエントリ Vite。HMR 対応で開発効率 ↑ |
| パッケージャ | **electron-builder** | `linux arm64` ターゲット | AppImage/deb を arm64 でクロスビルド可能 |
| 設定永続化 | **electron-store** + **zod** | — | **アトミック書き込みは electron-store に委譲**（自前 temp→rename は実装しない）。型安全な読み書き。`settings:update` 受信時は **`ConfigUpdateSchema`（zod）** でランタイム検証し、不正値（URLスキーム不正・不存在フォルダ・`interval ∉ {1,5,10,15,30}`）は拒否+WARN ログ |
| フォルダ監視 | **chokidar v4** | — | `awaitWriteFinish` が v4 で安定。大容量 MP4 の安全読み込み |
| テスト(Unit) | **Vitest** | — | fake timers / メモリ fs でスケジューラ・プレイリストを純関数テスト |
| テスト(E2E) | **Playwright `_electron`** | — | **T07.5（ハーネス成立性スパイク）で WebContentsView の page 駆動可否を最優先確認**。不可時は WebdriverIO + wdio-electron-service へ切替（工数見積り §9 参照）|

### 3.2 ウィンドウ構成：BaseWindow + 複数 WebContentsView

`BrowserView` は Electron 30 以降で非推奨（削除予定）。`BrowserWindow` は単一 Chromium コンテキストしか持てず、透過合成・z 順制御・セキュリティ分離が困難。**`BaseWindow` + 複数 `WebContentsView`** を採用することで、各 View を独立したセキュリティコンテキストで管理しつつ、z 順・可視性を Main プロセスから制御できる。

**hotspotView の統合検討**: hotspotView を独立 WebContentsView にせず、overlayView の DOM 内に統合すれば renderer 数を 1 削減できる（Pi4 メモリ節約）。T06 完了後に Pi4 のメモリ footprint を計測し、採否を決定して `docs/pi4-verification.md` に記録する（§10.2 参照）。

### 3.3 透過/フェード方針

- `overlayView` の背景色を `#00000000`（透過）に設定
- `html` / `body` / `video` を透明化。動画コンテナの CSS `opacity` を `0→1` でアニメーション
- **黒チラ防止手順（requestVideoFrameCallback 方式）**:
  1. アイドル時は `setVisible(false)` でオーバーレイを非表示
  2. 再生前に `preload` → `seek(0)` → `requestVideoFrameCallback` で実描画 1 フレーム確定 → `setVisible(true)` してフェードイン開始
  3. フェードアウト完了後に `setVisible(false)` に戻す
- `autoplayPolicy: 'no-user-gesture-required'`、`<video muted autoplay playsinline>`
- **24h 冪等性**: IPC ハンドラは起動時一度だけ登録。`<video>` 要素は使い回し＋各再生周回で `src`/イベントリスナを確実に解放・再設定
- **overlayView クリックスルー/フォーカス（State 別 `setIgnoreMouseEvents` 定義）**:

  | 状態 | `setIgnoreMouseEvents` 呼び出し | 引数 | 備考 |
  |------|-------------------------------|------|------|
  | IDLE | `setIgnoreMouseEvents(true, { forward: true })` | forward:true | hotspot タップを siteView へ透過 |
  | FADE_IN | `setIgnoreMouseEvents(true, { forward: true })` | forward:true | フェード中も hotspot タップ有効 |
  | PLAYING | `setIgnoreMouseEvents(true, { forward: true })` | forward:true | 再生中も隅タップで設定パネルを開ける |
  | FADE_OUT | `setIgnoreMouseEvents(true, { forward: true })` | forward:true | 同上 |

  → overlayView が最前面を占有する状態でも hotspot タップは常時有効。`setVisible(false)` 前後でも状態を維持する（テスト: UO-08）

### 3.4 ローカル動画のカスタムプロトコル配信

- `protocol.handle('media', handler)` を Main プロセス起動時に登録
- `Range` リクエストに対応した**ストリーミング部分配信（206 Partial Content）**のみ。ファイル全体のバッファリング（200 OK + 全送信）は禁止
- **不正 Range ヘッダー**（`Range: bytes=-1`、範囲外など）は `416 Requested Range Not Satisfiable` を返す
- **パストラバーサル拒否**: `decodeURIComponent` 後に `path.resolve` で絶対パスに正規化し、プレイリストルートフォルダ以下に収まることを確認。シンボリックリンクは `fs.realpath` で実パスを解決してから同検証を行う。脱出を検出した場合は 403 Forbidden を返し ERROR ログ `{event:"protocol.pathTraversal"}` を出す
- dev 環境（electron-vite `http://localhost`）/ prod 環境（`file://` ベース）を問わず `<video src="media://videos/clip-001.mp4">` の単一形式で統一
- **`file://` 直読は禁止**（CSP・セキュリティポリシーの一貫性のため）
- パス URL エンコード規約: 特殊文字・Unicode・空白はすべて `encodeURIComponent` でエンコード。Main 側で `decodeURIComponent` してから `fs` アクセス

### 3.5 IPC / セキュリティ境界

- 全 renderer: `contextIsolation: true` / `nodeIntegration: false` / `sandbox: true`
- preload の `contextBridge` で型付きの最小 API のみ公開
- `fs` / タイマー / `electron-store` は **Main プロセスが単独所有**
- 外部 Web（siteView）に特権 API を露出しない
- **全 View の partition 明示割当て**:

  | View | partition/session | 備考 |
  |------|-------------------|------|
  | siteView | `persist:site` | ヘッダー書換え・ナビゲーションガード適用 |
  | overlayView | `persist:overlay`（または default） | ローカル renderer。ヘッダー改変なし |
  | hotspotView | `persist:hotspot`（または default） | タップ検出専用。ヘッダー改変なし |
  | settingsView | `persist:settings`（または default） | 設定パネル。ヘッダー改変なし |

- **ヘッダー書換えのスコープ限定**: `session.webRequest.onHeadersReceived`（XFO/CSP 剥がし）は **siteView 専用 partition/session (`persist:site`) に限定**。他 3 View のローカル renderer レスポンスヘッダーは改変しない（siteView 以外の3 View（overlay/settings/hotspot）のヘッダー非改変を E2E-16 で確認）
- **IPC 信頼境界（全 Main ハンドラ必須）**: 各 `ipcMain.handle` / `ipcMain.on` で `event.senderFrame` の URL または sender ID を View 別 allowlist と照合。allowlist 外の sender は即拒否し ERROR ログ `{event:"ipc.invalidSender", sender:"..."}` を出す。payload は必ず対応 zod スキーマで `parse` し、失敗時は拒否+ログ（テスト: UT-23）
- **siteView 遷移/ポップアップ/DL ガード**:
  - `setWindowOpenHandler: () => ({ action: 'deny' })` でポップアップ全禁止
  - `will-navigate` / `will-redirect` イベントで設定 URL ホワイトリスト外の遷移を `preventDefault`
  - ダウンロードリクエストを `session.on('will-download', (e) => e.preventDefault())` で抑止

### 3.6 Wayland / X11 自動判定

起動時に `XDG_SESSION_TYPE` 環境変数を読み、全画面・`globalShortcut`・スリープ抑止の方式を切替：

| 環境 | 全画面 | globalShortcut | スリープ抑止 |
|------|--------|---------------|------------|
| X11 | `setFullScreen(true)` + `xset s off -dpms` | 通常動作（ベストエフォート） | `powerSaveBlocker` + xset |
| Wayland | `setFullScreen(true)` | **非対応。隅 3 タップを正規・常時経路として使用**（Ctrl+G は X11 のみ）| `powerSaveBlocker` + コンポジタ idle-inhibit |

**Wayland での globalShortcut 非対応は既知制約**。隅 3 タップが唯一の入力経路となる Wayland 環境での動作確認は **[M] 必須ゲート**（§10.2）。

### 3.7 64bit 自己診断

起動時に `getconf LONG_BIT` / `uname -m` を実行し、32bit 環境を検出した場合はログに警告を出力する（動作は継続）。

---

## 4. アーキテクチャ

### 4.1 ビュー構成・z 順

```
BaseWindow（frameless、全画面）
  │
  ├── [z:0] siteView        ← 既存サイネージ URL を全面表示
  │         sandbox: true / nodeIntegration: false
  │         専用 partition/session で X-Frame-Options を無効化
  │         ナビゲーション/ポップアップ/DL ガード設定済み
  │
  ├── [z:1] overlayView     ← 全面・背景透過 #00000000
  │         idle 時 setVisible(false)
  │         <video muted autoplay playsinline src="media://...">
  │         [オプション] hotspotView の DOM を内包する場合あり（§3.2）
  │
  ├── [z:2] hotspotView     ← 隅の小領域 (例: 40×40px × 4隅) のみ
  │         透過・常時前面・3 回タップ検出専用
  │         ※overlayView に統合した場合は本 View は廃止
  │
  └── [z:3] settingsView    ← 全面・既定 hidden・開時のみ前面占有
```

### 4.2 IPC チャンネル一覧（API Contract）

| チャンネル | 方向 | payload | 説明 |
|-----------|------|---------|------|
| `overlay:play` | Main → overlay | `{ path: string }` | 動画再生要求（`media://` URI を渡す）|
| `overlay:played` | overlay → Main | `{ path: string }` | 再生完了通知 |
| `overlay:error` | overlay → Main | `{ path: string, reason: string }` | 再生エラー通知 |
| `overlay:duration-ready` | overlay → Main | `{ ms: number }` | 動画 duration 取得通知（PLAYING ウォッチドッグタイマー設定用）。`<video>.duration` が確定した時点で送出 |
| `overlay:fade-in-done` | overlay → Main | — | フェードイン完了 |
| `overlay:fade-out-done` | overlay → Main | — | フェードアウト完了 |
| `settings:get` | settings → Main | — | 現在設定取得要求 |
| `settings:current` | Main → settings | `Config` | 現在設定応答 |
| `settings:update` | settings → Main | `Partial<Config>` | 設定変更要求 |
| `settings:updated` | Main → settings | `Config` | 変更反映済み通知 |
| `settings:test-play` | settings → Main | — | 今すぐテスト再生要求 |
| `settings:open` | Main → settings | — | パネル表示指示 |
| `settings:close` | settings → Main | — | パネル閉じ要求 |
| `hotspot:tap` | hotspot → Main | — | 隅タップ検出通知 |
| `settings:pick-folder` | settings → Main | — | フォルダ選択ダイアログ要求 |
| `settings:folder-picked` | Main → settings | `{ folderPath: string \| null }` | フォルダ選択結果 |

### 4.3 スケジューラ状態機械（ウォッチドッグ付き）

```
IDLE ──(間隔経過 & ループ ON & プレイリスト有)──► FADE_IN
FADE_IN ──(フェードイン完了)──────────────────► PLAYING
PLAYING ──(ended / error)──────────────────────► FADE_OUT
FADE_OUT ──(フェードアウト完了)────────────────► IDLE
IDLE ──(割り込み終了時刻 + interval 経過)──────► FADE_IN  （再装填基準）

多重発火スキップ: FADE_IN / PLAYING / FADE_OUT 中の発火は no-op
```

**ウォッチドッグ（タイムアウト）**:

各非 IDLE 状態に最大滞留タイマを設定し、超過時は強制 `setVisible(false)` → `IDLE` 復帰 + `ERROR` 構造化ログ出力。

| 状態 | 最大滞留時間 | 超過時の処置 |
|------|------------|------------|
| `FADE_IN` | 1500ms | `setVisible(false)` → `IDLE` 強制遷移 + ERROR ログ |
| `PLAYING` | **`overlay:duration-ready { ms }` 受信後に `ms + 30000` ms** でタイマーセット。受信前は暫定 300s のフォールバック値を使用 | `setVisible(false)` → `IDLE` 強制遷移 + ERROR ログ |
| `FADE_OUT` | 1500ms | `setVisible(false)` → `IDLE` 強制遷移 + ERROR ログ |

> **duration 取得経路**: overlay renderer が `<video>` の `loadedmetadata` イベントで `duration` を取得し、IPC `overlay:duration-ready { ms: Math.ceil(video.duration * 1000) }` を Main へ送出。Main の Scheduler がこれを受信してウォッチドッグタイマーを更新する。

**スケジューラ計時基準（確定）**:

- タイマーは「直前の割り込み終了時刻（`overlay:fade-out-done` 受信時刻）+ interval」で再装填
- 再生中（FADE_IN/PLAYING/FADE_OUT）は計時停止（再生完了起点方式）
- 間隔変更時は次の再装填タイミングから新 interval を適用（現在動作中のタイマーは即座にリセット）

### 4.4 データフロー

```
Main Process
  ├── ConfigManager      (electron-store + zod)
  ├── PlaylistManager    (ファイル走査・巡回カーソル=ファイル名ベース)
  ├── Watcher            (chokidar)
  ├── Scheduler          (状態機械・ウォッチドッグ・計時停止方式)
  ├── ProtocolHandler    (media:// カスタムプロトコル・Range 対応)
  └── IPCController      (チャンネル仲介・ハンドラ起動時一度登録)

Renderers
  ├── overlayView.html   (video フェード UI・requestVideoFrameCallback)
  ├── settingsView.html  (設定パネル UI・フォルダ/URL 設定)
  └── hotspotView.html   (タップ検出のみ、またはoverlayDOMに統合)

siteView              (外部 URL・特権 API なし・専用 partition)
```

---

## 5. ディレクトリ構成

```
ubuntuapp/
├── package.json                   # 完全固定バージョン（^ 禁止）
├── electron.vite.config.ts        # electron-vite マルチエントリ設定
├── tsconfig.json                  # strict + noUncheckedIndexedAccess
├── tsconfig.node.json             # Main/preload 用
├── .eslintrc.json
├── .prettierrc
├── electron-builder.yml           # linux arm64 / x64 パッケージング設定
├── src/
│   ├── main/                      # Main プロセス（Node.js）
│   │   ├── index.ts               # エントリ・BaseWindow 生成・自己診断
│   │   ├── windowManager.ts       # WebContentsView 生成・z 順管理
│   │   ├── headerHook.ts          # X-Frame-Options 無効化（siteView専用session限定）
│   │   ├── protocolHandler.ts     # media:// カスタムプロトコル登録・Range 配信
│   │   ├── ipcController.ts       # IPC チャンネル登録（起動時一度のみ）・仲介
│   │   ├── config/
│   │   │   └── configManager.ts   # electron-store + zod 読み書き
│   │   ├── playlist/
│   │   │   ├── playlistManager.ts # 走査・ソート・巡回カーソル（ファイル名ベース）
│   │   │   └── watcher.ts         # chokidar ラッパー
│   │   ├── scheduler/
│   │   │   └── scheduler.ts       # 状態機械・ウォッチドッグ・計時停止方式
│   │   └── utils/
│   │       ├── logger.ts          # 構造化ログ（winston or electron-log）
│   │       ├── archDiag.ts        # 64bit 自己診断
│   │       └── powerBlocker.ts    # powerSaveBlocker ラッパー
│   ├── preload/
│   │   ├── overlay.ts             # overlayView 用 contextBridge
│   │   ├── settings.ts            # settingsView 用 contextBridge
│   │   └── hotspot.ts             # hotspotView 用 contextBridge
│   ├── renderer/
│   │   ├── overlay/
│   │   │   ├── index.html
│   │   │   ├── main.ts
│   │   │   └── styles.css         # video フェード CSS
│   │   ├── settings/
│   │   │   ├── index.html
│   │   │   ├── main.ts
│   │   │   └── styles.css
│   │   └── hotspot/
│   │       ├── index.html
│   │       └── main.ts
│   └── shared/
│       ├── types.ts               # Config / PlaylistState / IPCPayload 型
│       └── schema.ts              # zod スキーマ（Config）
├── assets/
│   └── dummy/                     # 開発用ダミー資産（T04 で生成）
│       ├── signage.html           # 疑似サイネージ HTML（X-Frame 付き）
│       ├── clip-001.mp4           # 1080p H.264 ダミー MP4（短尺）
│       ├── clip-002.mp4
│       ├── clip-003.mp4
│       ├── clip-broken.mp4        # 破損 MP4（0 バイト or 非 H.264）
│       └── clip-large.mp4         # 巨大 MP4（200MB 相当、コピー途中テスト用）
├── scripts/
│   ├── generate-dummy-assets.sh   # ffmpeg ダミー生成スクリプト
│   └── install-systemd.sh         # systemd ユニット配置スクリプト
├── systemd/
│   └── ubuntuapp.service          # systemd --user ユニットテンプレート
├── docs/
│   ├── plans/
│   │   └── implementation-plan.md # 本書
│   └── pi4-verification.md        # Pi4 実機確認記録（T09 で作成）
└── test/
    ├── unit/                      # Vitest ユニットテスト
    └── e2e/                       # Playwright _electron E2E テスト
```

---

## 6. タスク一覧 T01〜T32

### 共通凡例

- **成果物**: タスクが生み出す具体的な成果物
- **依存**: 先行して完了が必要なタスク
- **Done の定義**: タスク完了の判定基準
- **対応テスト**: タスクを検証するテストケース ID（Section 7 参照）
- **並列可否**: 他タスクと並列実行できるか

---

### Phase 0: 基盤

#### T01 — electron-vite + TS 最小起動（空 BaseWindow）

| 項目 | 内容 |
|------|------|
| 成果物 | `package.json`（完全固定版・Electron バージョンは arm64 プリビルド存在確認済みの v33.x.x 以上を選択）、`electron.vite.config.ts`、`tsconfig.json`、空 BaseWindow が起動する `src/main/index.ts` |
| 依存 | なし |
| Done の定義 | `npm run dev` で Electron が起動し、空の BaseWindow（frameless 未設定でよい）が表示される。`npm run build` がエラーなく完了する |
| 対応テスト | — （手動確認） |
| 並列可否 | T02、T03、T04 と並列 |

#### T02 — lint + prettier + strict tsconfig

| 項目 | 内容 |
|------|------|
| 成果物 | `.eslintrc.json`（`no-empty` ルール有効化を含む）、`.prettierrc`、`tsconfig.json`（`strict: true` + `noUncheckedIndexedAccess: true`）、`npm run lint` / `npm run format` スクリプト |
| 依存 | T01 |
| Done の定義 | `npm run lint` がゼロエラーで終了する。空 `catch` ブロックが lint エラーになることを確認する |
| 対応テスト | — |
| 並列可否 | T03、T04 と並列 |

#### T03 — CI 雛形（lint + unit、xvfb 準備）

| 項目 | 内容 |
|------|------|
| 成果物 | `.github/workflows/ci.yml`（lint + Vitest unit、xvfb-run セットアップ含む） |
| 依存 | T01、T02 |
| Done の定義 | GitHub Actions（またはローカル act）で lint と unit テストが xvfb-run 経由で実行され、PASS する |
| 対応テスト | — |
| 並列可否 | T04 と並列 |

#### T04 — ダミー資産生成

| 項目 | 内容 |
|------|------|
| 成果物 | `assets/dummy/` 以下の疑似サイネージ HTML（X-Frame-Options 付き）、ffmpeg で生成した H.264/1080p ダミー MP4 × 3（短尺 5s）、破損 MP4 × 1、巨大 MP4 × 1（200MB 相当）。`scripts/generate-dummy-assets.sh` |
| 依存 | なし（ffmpeg は開発機に存在） |
| Done の定義 | `ffprobe` で各 MP4 が H.264/yuv420p/faststart/無音を持つことを確認。`curl -I` でダミー HTML が `X-Frame-Options: SAMEORIGIN` を返す |
| 対応テスト | [M] 手動確認 |
| 並列可否 | T01〜T03 と並列 |

#### T05 — ディレクトリ責務固定

| 項目 | 内容 |
|------|------|
| 成果物 | `src/main`、`src/preload`、`src/renderer/overlay`、`src/renderer/settings`、`src/renderer/hotspot`、`src/shared` の各ディレクトリと index ファイル雛形 |
| 依存 | T01 |
| Done の定義 | `electron.vite.config.ts` の `input` エントリが全 renderer を参照し、`npm run build` がエラーなく完了する |
| 対応テスト | — |
| 並列可否 | T06 の前提として完了が必要 |

---

### Phase 1: 中核シェル

#### T06 — frameless 全画面

| 項目 | 内容 |
|------|------|
| 成果物 | `windowManager.ts` — BaseWindow を frameless・全画面・ `alwaysOnTop` なし（通常 Z 順）で生成する実装 |
| 依存 | T05 |
| Done の定義 | `npm run dev` で Electron が全画面・枠なしで起動する。`Alt+F4` で終了できる |
| 対応テスト | [M] 手動確認 |
| 並列可否 | T07 の前提 |

#### T07 — siteView 内部表示（ダミー HTML）+ セキュリティガード

| 項目 | 内容 |
|------|------|
| 成果物 | `headerHook.ts`（**siteView 専用 partition の session に限定した** X-Frame-Options / CSP frame-ancestors 無効化）、`windowManager.ts` への siteView 組み込み（専用 partition/session 設定）、siteView の遷移/ポップアップ/DL ガード実装（`setWindowOpenHandler`・`will-navigate`/`will-redirect` ホワイトリスト・`will-download` 抑止）、ダミー HTML 表示確認 |
| 依存 | T06 |
| Done の定義 | (1) `X-Frame-Options: SAMEORIGIN` 付きダミー HTML が siteView 内に表示される。(2) overlay/settings renderer のレスポンスヘッダーが改変されていないことを E2E で確認。(3) siteView での外部リンククリックがブロックされる。(4) ダウンロードリクエストがブロックされる |
| 対応テスト | [E] E2E-07（X-Frame 持ち実サイトの内部表示）、[E] E2E-14（siteView ナビゲーションブロック）、[E] E2E-15（siteView ポップアップブロック）、[E] E2E-16（ヘッダー書換えスコープ確認）、[M] 実サイト確認 |
| 並列可否 | T07.5 の前提 |

#### T07.5 — 【SPK】Playwright テストハーネス成立性スパイク

| 項目 | 内容 |
|------|------|
| 成果物 | Playwright `_electron` が WebContentsView（overlayView・settingsView）の page を取得・操作できるかの検証レポート（`docs/playwright-spike.md`）。不可の場合は WebdriverIO + wdio-electron-service への移行スコープと工数見積りを含む |
| 依存 | T07 |
| Done の定義 | `docs/playwright-spike.md` に「対応可 / 不可 + 代替案」が記録されている。不可の場合は T08 着手前に E2E フレームワーク切替を完了する |
| 対応テスト | — （スパイク自体が検証） |
| 並列可否 | T08 の前提。**T08 着手前に必ず完了すること** |

#### T08 — 【SPK】透過 overlay 重畳実証（静的動画 1 本・開発機）

| 項目 | 内容 |
|------|------|
| 成果物 | `protocolHandler.ts`（`media://` 登録・Range 対応）、overlayView（`#00000000` 背景・透過）をダミー HTML 上に重畳し、`media://` 経由のダミー MP4 1 本を requestVideoFrameCallback + opacity フェードで再生する PoC 実装 |
| 依存 | T07.5 |
| Done の定義 | 開発機の xvfb-run 環境で「下層 HTML が見えた状態でオーバーレイ動画がフェードイン→再生→フェードアウトし、下層に戻る」が動作確認できる。黒フラッシュが視認されない。`file://` 直読が使われていないことを確認 |
| 対応テスト | [E] E2E-01、[M] 開発機目視 |
| 並列可否 | **同期点①**。T08 完了を確認してから T09 実機確認（同期点①.5）へ進む |

#### T09 — 【SPK 実機・必須ゲート①.5】Pi4 で T08 再現・透過合成・HWデコード確認

| 項目 | 内容 |
|------|------|
| 成果物 | Pi4 上での再現手順メモ（`docs/pi4-verification.md`）。必要な起動フラグ（`--enable-features=VaapiVideoDecoder` 等）の確定。HW デコード可否の記録。**hotspotView の overlay DOM 統合採否の決定**（メモリ footprint 計測結果を記録）。Wayland での globalShortcut 非対応確認 |
| 依存 | T08 |
| Done の定義 | Pi4 上で T08 と同等の動作が確認でき、フラグリスト・メモリ計測・hotspotView 統合採否が `docs/pi4-verification.md` に記録されている。**Pi4 受け入れ閾値（全項目を記録）**: 1080p 30fps 以上・CPU 80% 以下・温度 80°C 以下・メモリ合計 512MB 以内（M-02 参照）|
| 対応テスト | [M] 実機目視 |
| 並列可否 | **同期点①.5（必須実機ゲート）**。T09 完了を確認してから Phase 2/3 へ進む |

---

### Phase 2: 中核ロジック（BE 純関数・T09 完了後 並列実装可）

#### T10 — shared 型 + zod スキーマ（Config / PlaylistState）

| 項目 | 内容 |
|------|------|
| 成果物 | `src/shared/types.ts`（`Config` / `PlaylistState` / IPC payload 型。`Config` には `siteUrl: string` と `videoFolderPath: string` を含む）、`src/shared/schema.ts`（zod スキーマ: `ConfigSchema` + **`ConfigUpdateSchema`**（`settings:update` payload のランタイム検証用。不正 URL スキーム・`interval ∉ {1,5,10,15,30}` を拒否））|
| 依存 | T05 |
| Done の定義 | `tsc --noEmit` がエラーなく通る。zod スキーマが `Config` の不正値を検出し `ZodError` を投げる |
| 対応テスト | [U] UC-01〜UC-06（config テスト） |
| 並列可否 | T11〜T15 の前提として最初に完了 |

#### T11 — config（electron-store + zod・破損隔離リセット・永続化）

| 項目 | 内容 |
|------|------|
| 成果物 | `src/main/config/configManager.ts` — 初回既定生成・既存復元・JSON 破損時の `.corrupt` 退避+既定リセット+ログ・型不正時の zod 補完+ログ。**アトミック書き込みは electron-store に委譲**（自前 temp→rename は実装しない）|
| 依存 | T10 |
| Done の定義 | UC-01〜UC-06 全テストが PASS する |
| 対応テスト | [U] UC-01〜UC-06 |
| 並列可否 | T12〜T15 と並列 |

#### T12 — playlist（走査・拡張子フィルタ・ソート・1 本ずつ巡回カーソル・空処理）

| 項目 | 内容 |
|------|------|
| 成果物 | `src/main/playlist/playlistManager.ts` — フォルダ走査（`.mp4` のみ）・ファイル名昇順ソート・**巡回カーソル（「最後に再生したファイル名」で保持）**。`next()` 呼び出しで 1 本ずつ前進。再走査・再ソート後はカーソルが指すファイル名の**次の昇順要素**から再開。カーソル対象が削除されていた場合は次要素へ。末尾→先頭循環。空プレイリスト時は `null` 返却+ログ |
| 依存 | T10 |
| Done の定義 | UP-01〜UP-08 全テストが PASS する |
| 対応テスト | [U] UP-01〜UP-08 |
| 並列可否 | T11、T13〜T15 と並列 |

#### T13 — watcher（chokidar + awaitWriteFinish・カーソル整合）

| 項目 | 内容 |
|------|------|
| 成果物 | `src/main/playlist/watcher.ts` — chokidar v4 でフォルダを監視。`awaitWriteFinish: { stabilityThreshold: 2000, pollInterval: 200 }` + イベントデバウンス（連続発火を 500ms で束ねる）を設定。`add` / `unlink` / `rename` / `change` イベントで `playlistManager` を更新。削除・リネームで対象がカーソル位置の場合は次要素へ整合。**周期再スキャン**（5 分ごと）でイベント欠落を補完。USB/NFS 低速コピー + アトミック rename パターンにも対応（UW-07）|
| 依存 | T12 |
| Done の定義 | UW-01〜UW-07 全テストが PASS する |
| 対応テスト | [U] UW-01〜UW-07、[M] M-08 |
| 並列可否 | T11〜T12、T14〜T15 と並列 |

#### T14 — scheduler 状態機械（ウォッチドッグ・計時停止方式）

| 項目 | 内容 |
|------|------|
| 成果物 | `src/main/scheduler/scheduler.ts` — 状態機械本体。**計時基準: 割り込み終了時刻 + interval で再装填**。再生中は計時停止。**ウォッチドッグ: 各非 IDLE 状態に最大滞留タイマ**（FADE_IN: 1500ms、PLAYING: `overlay:duration-ready { ms }` 受信後に `ms + 30000` ms でタイマー更新・受信前は暫定 300s、FADE_OUT: 1500ms）。超過時は強制 IDLE 復帰 + ERROR ログ。ループ ON/OFF 制御。多重発火スキップ |
| 依存 | T10 |
| Done の定義 | US-01〜US-11 全テストが PASS する（Vitest fake timers 使用）|
| 対応テスト | [U] US-01〜US-11 |
| 並列可否 | T11〜T13、T15 と並列 |

#### T15 — scheduler ↔ playlist 連携（次の 1 本取得・空なら安全スキップ+ログ）

| 項目 | 内容 |
|------|------|
| 成果物 | `src/main/scheduler/scheduler.ts` への playlist 連携組み込み。`Scheduler.onFire()` が `playlistManager.next()` を呼び、`null` の場合は WARN ログを出してスキップし `IDLE` に戻る |
| 依存 | T14、T12 |
| Done の定義 | US-12〜US-14 全テストが PASS する |
| 対応テスト | [U] US-12〜US-14 |
| 並列可否 | T11〜T13 と並列（T14 完了が前提）|

---

### Phase 3: overlay（FE・T09 完了後 T16〜T18 並列実装可）

#### T16 — overlay 再生 UI（`<video muted autoplay>` → ended 通知）

| 項目 | 内容 |
|------|------|
| 成果物 | `src/renderer/overlay/main.ts`・`index.html` — `<video muted autoplay playsinline src="media://...">` の配置、`ended` / `error` イベントを IPC で Main へ通知。**`<video>` 要素は使い回し・各再生周回で src/イベントリスナを確実に解放・再設定**（24h 冪等性）|
| 依存 | T08 |
| Done の定義 | overlay renderer にパスを渡すと動画が再生され、`ended` 後に `overlay:played` IPC が送出される。`file://` 直読でないことを確認。**UO-07 が PASS する（IPC ハンドラ蓄積なし）**。UO-08 が PASS する（PLAYING 中も hotspot タップが siteView へ透過する）|
| 対応テスト | [E] E2E-02、[E] UO-01〜UO-03、[U] UO-07、[E] UO-08 |
| 並列可否 | T17、T18 と並列 |

#### T17 — フェード演出（requestVideoFrameCallback 後 reveal）

| 項目 | 内容 |
|------|------|
| 成果物 | `src/renderer/overlay/styles.css` と `main.ts` のフェード制御ロジック。`preload` → `seek(0)` → **`requestVideoFrameCallback` で実描画 1 フレーム確定** → `setVisible(true)` + opacity `0→1` CSS トランジション（≈1000ms）→ 再生 → opacity `1→0` → `transitionend` で `overlay:fade-out-done` 送出 |
| 依存 | T16 |
| Done の定義 | [M] 目視で黒チラが発生しないことを確認。`UO-04〜UO-06` が PASS する |
| 対応テスト | [U] UO-04〜UO-06、[M] 目視 |
| 並列可否 | T18 と並列 |

#### T18 — overlay IPC 契約（再生要求受信・完了/失敗送出）

| 項目 | 内容 |
|------|------|
| 成果物 | `src/preload/overlay.ts`（contextBridge）。`overlay:play` を受信して `<video>.src` をセット。`overlay:played` / `overlay:error` を Main へ送出するハンドラ。**IPC ハンドラは起動時一度のみ登録**（24h 冪等性）|
| 依存 | T16、T10 |
| Done の定義 | Main から `overlay:play` を送ると動画が再生され、完了時に `overlay:played` が届く。破損パスには `overlay:error` が届く。`overlay:duration-ready` が `loadedmetadata` で送出される。**UO-07 が PASS する（IPC ハンドラ蓄積なし・100 回再生後もリスナ数一定）** |
| 対応テスト | [E] E2E-03、[U] UO-07 |
| 並列可否 | T16、T17 と並列 |

---

### Phase 4: settings + 入力

#### T19 — settings UI（ON/OFF トグル・間隔ボタン・サイトURL入力・フォルダ選択・ループ切替・今すぐテスト再生・閉じる）

| 項目 | 内容 |
|------|------|
| 成果物 | `src/renderer/settings/` — 設定パネル HTML/CSS/TS。ON/OFF トグル、間隔選択ボタン（5/10/15/30 分）、ループ切替（= 広告割り込み有効/無効）、**「サイト URL 入力欄」**（テキスト入力）、**「動画フォルダ選択」ボタン**（`settings:pick-folder` IPC → Main が `dialog.showOpenDialog` を呼び出し → `settings:folder-picked` で結果返送）、「今すぐテスト再生」ボタン、「閉じる」ボタン |
| 依存 | T10 |
| Done の定義 | パネルが開き、各 UI 要素が操作可能で、IPC を送出する（T20 との結合前は mock）。フォルダ選択ダイアログが Main プロセス所有で開くことを確認 |
| 対応テスト | [E] E2E-04 |
| 並列可否 | T20〜T23 と並列 |

#### T20 — settings ↔ config IPC（往復・即時反映）

| 項目 | 内容 |
|------|------|
| 成果物 | `src/preload/settings.ts`（contextBridge）、`src/main/ipcController.ts` の settings 系ハンドラ。`settings:get` → `settings:current` 往復。`settings:update` → **`event.senderFrame` で settingsView allowlist 照合** → **`ConfigUpdateSchema`(zod) で payload 検証**（不正値は拒否+WARN ログ `{event:"settings.invalidUpdate"}`）→ 検証通過後に ConfigManager 保存 + Scheduler 反映 → `settings:updated` 返送。全ハンドラで sender allowlist + zod 検証を実施（§3.5 IPC 信頼境界に準拠）。`settings:pick-folder` → `dialog.showOpenDialog` → `settings:folder-picked` 返送 |
| 依存 | T19、T11、T14 |
| Done の定義 | パネルで間隔を変更すると即時 Scheduler に反映され、再起動後も値が維持される。URL・フォルダパスの変更も同様に反映される |
| 対応テスト | [E] E2E-05、[U] US-04、[U] UT-23（不正sender拒否）、[U] UT-24（不正update拒否）|
| 並列可否 | T21〜T23 と並列 |

#### T21 — Ctrl+G 開閉（globalShortcut・多重起動防止）

| 項目 | 内容 |
|------|------|
| 成果物 | `src/main/index.ts` への `globalShortcut.register('Control+G', ...)` 組み込み（X11 のみ有効。Wayland では登録スキップ）。settingsView のトグル制御（既開なら閉じる、閉じているなら開く）。二重登録防止 |
| 依存 | T05 |
| Done の定義 | X11 環境で `Ctrl+G` でパネルが開閉する。連打しても二重に開かない。Wayland 環境ではスキップされ、ログに記録される |
| 対応テスト | [E] E2E-06 |
| 並列可否 | T22、T23 と並列 |

#### T22 — 隅 3 タップ（hotspotView 計数・Wayland 正規経路）

| 項目 | 内容 |
|------|------|
| 成果物 | `src/renderer/hotspot/main.ts` — 4 隅に透明なタップ領域を配置。1.5 秒の時間窓内に 3 回タップを検出すると `hotspot:tap` を Main へ送出。`src/main/ipcController.ts` で `hotspot:tap` を受信して settingsView を開く。**Wayland では隅 3 タップが唯一の開き方（Ctrl+G 非対応のため常設正規経路として実装）** |
| 依存 | T21 |
| Done の定義 | 隅を 1.5 秒以内に 3 回タップすると settingsView が開く。時間窓外の 3 回では開かない。Wayland / X11 両環境で動作する |
| 対応テスト | [E] E2E-13（隅 3 タップ）、[U] UH-01〜UH-03 |
| 並列可否 | T23 と並列 |

#### T23 — 今すぐテスト再生（IDLE 時のみ通常経路で即時 1 本）

| 項目 | 内容 |
|------|------|
| 成果物 | `src/main/ipcController.ts` の `settings:test-play` ハンドラ。Scheduler が `IDLE` の場合のみ即時再生をトリガー。`IDLE` 以外の場合は no-op +ログ |
| 依存 | T20、T14 |
| Done の定義 | IDLE 時に「今すぐテスト再生」を押すと即時再生が始まる。PLAYING 中の連打は無視される |
| 対応テスト | [U] US-10、US-11、[E] E2E-08 |
| 並列可否 | 単独 |

#### T32 — フォルダ/URL 動的切替（watcher 再ポイント・playlist 再走査・siteView 再ロード）

> **実装フェーズ分割（矛盾解消）**:
> - **T32-BE（Phase 2: T13 完了後に並列実装可）**: `videoFolderPath` 変更時の watcher 再ポイント・playlist 再走査・カーソル先頭リセットロジック。UC-07 で検証
> - **T32-UI（Phase 4: T20 完了後に実装）**: `settings:update` IPC 受信 → T32-BE 呼び出し + `siteUrl` 変更時の `siteView.loadURL` 再ロード。E2E-17 で結合確認

| 項目 | 内容 |
|------|------|
| 成果物 | `settings:update` で `videoFolderPath` または `siteUrl` が変更された際の動的切替処理。`videoFolderPath` 変更時: chokidar watcher を停止→新フォルダへ再ポイント→playlist 再走査→カーソル先頭リセット（T32-BE）。`siteUrl` 変更時: siteView の `loadURL` を呼び出して再ロード（T32-UI）|
| 依存 | T32-BE: T13。T32-UI: T20、T13 |
| Done の定義 | UC-07（フォルダ切替）・UC-08（URL 切替）が PASS する。[E] E2E-17（動的フォルダ切替）が PASS する |
| 対応テスト | [U] UC-07、UC-08、[E] E2E-17 |
| 並列可否 | T32-BE は Phase 2 で T13 と並列実装可。T32-UI は T20 完了後（Phase 4）|

---

### Phase 5: 結合

#### T24 — フル広告フロー結線（発火→フェードイン→1 本→フェードアウト→site 復帰）

| 項目 | 内容 |
|------|------|
| 成果物 | Main プロセスの IPC フロー全体結線。Scheduler → `overlay:play` → (`overlay:fade-in-done`) → 再生 → `overlay:played` → フェードアウト → `overlay:fade-out-done` → `IDLE` 復帰。IPC ハンドラ冪等性（二重登録がないこと）を確認 |
| 依存 | T15、T18、T17 |
| Done の定義 | **同期点②**。E2E-01（フル広告フロー）が PASS する |
| 対応テスト | [E] E2E-01 |
| 並列可否 | T24 完了を同期点として T25〜T27 開始 |

#### T25 — 設定の動的反映（間隔 / ON-OFF / ループ）

| 項目 | 内容 |
|------|------|
| 成果物 | Scheduler の `updateConfig(partial: Partial<Config>)` メソッド。設定パネルで変更した間隔/ON-OFF が次の発火から即時適用されることを確認 |
| 依存 | T24、T20 |
| Done の定義 | 間隔を 10→5 分に変更すると次の発火が（変更時刻 + 5 分後）になる。ON→OFF で発火が停止する |
| 対応テスト | [U] US-04、US-05、[E] E2E-05 |
| 並列可否 | T26、T27 と並列 |

#### T26 — 巡回継続性（サイクル跨ぎ前進・1 本なら反復）

| 項目 | 内容 |
|------|------|
| 成果物 | `playlistManager.next()` の巡回ロジック確認テスト。N 本→一周後に先頭へ。1 本→毎回同じファイルを返す |
| 依存 | T24 |
| Done の定義 | UP-01〜UP-03 が PASS する（T12 で実装済みであることの結合確認）|
| 対応テスト | [U] UP-01〜UP-03、[E] E2E-09 |
| 並列可否 | T25、T27 と並列 |

#### T27 — 起動時復元（設定永続値）

| 項目 | 内容 |
|------|------|
| 成果物 | 起動シーケンスにおける `configManager.load()` → Scheduler 初期化への反映フロー |
| 依存 | T24、T11 |
| Done の定義 | 間隔を 15 分に変更して Electron を再起動すると 15 分間隔で動作する。ループ OFF も再起動後維持される |
| 対応テスト | [E] E2E-10 |
| 並列可否 | T25、T26 と並列 |

---

### Phase 6: 運用・耐障害

#### T28 — スリープ抑止

| 項目 | 内容 |
|------|------|
| 成果物 | `src/main/utils/powerBlocker.ts` — `powerSaveBlocker.start('prevent-display-sleep')` ラッパー。X11 では加えて `xset s off -dpms` を子プロセスで実行 |
| 依存 | T06 |
| Done の定義 | 30 分放置してもスリープ/スクリーンセーバーが発動しない（[M] 実機確認）|
| 対応テスト | [M] 実機 |
| 並列可否 | T29〜T31 と並列 |

#### T29 — 自動起動（systemd --user + .desktop）

| 項目 | 内容 |
|------|------|
| 成果物 | `systemd/ubuntuapp.service`（`Restart=always`・`RestartSec=5`・`StartLimitIntervalSec=60`・`StartLimitBurst=5`・`graphical-session.target`・`loginctl enable-linger`）。**`Environment=` または `EnvironmentFile=` で `DISPLAY`・`WAYLAND_DISPLAY`・`XDG_RUNTIME_DIR` を明示設定**（graphical-session.target のみでは環境変数が引き継がれないケースに対応）。**`app.requestSingleInstanceLock()` によるシングルインスタンスガード**（2 番目の起動は既存インスタンスにフォーカスして終了）。`~/.config/autostart/ubuntuapp.desktop` フォールバック。`scripts/install-systemd.sh` |
| 依存 | T06 |
| Done の定義 | [M] Pi4 でリブート後に自動起動し、`kill -9` 後に 5 秒以内に復帰する。連続クラッシュで start-limit 到達時は `journald` で確認できる（[M] UT-20）。**2 番目のプロセス起動で既存インスタンスへフォーカスが移り、2 番目が終了することを確認（[M] M-11）** |
| 対応テスト | [M] 実機、[M] UT-20、[M] M-11 |
| 並列可否 | T28、T30、T31 と並列 |

#### T30 — エラー耐性（エラー&レスキューマップ全分岐・例外は必ずログと状態に出す）

| 項目 | 内容 |
|------|------|
| 成果物 | `uncaughtException` / `unhandledRejection` の集約ログハンドラ。全 catch 節での構造化ログ+状態反映の確認。空 catch 禁止の lint ルール（`no-empty`）。ウォッチドッグ動作確認 |
| 依存 | T24 |
| Done の定義 | **自動(unit)ゲート**: UT-01〜UT-13・UT-15・UT-16・UT-18・UT-19・UT-21〜UT-24 が Vitest で PASS する。**手動[M]ゲート（自動PASS条件から除外）**: UT-14（GPU フォールバック実機確認）・UT-17（SIGSEGV 復帰実機確認）・UT-20（start-limit 実機確認）が実機で確認済みとなる |
| 対応テスト | [U] UT-01〜UT-13、UT-15、UT-16、UT-18、UT-19、UT-21〜UT-24、[M] UT-14、UT-17、UT-20 |
| 並列可否 | T28、T29、T31 と並列 |

#### T31 — 【実機】パッケージング arm64

| 項目 | 内容 |
|------|------|
| 成果物 | `electron-builder.yml` の arm64/x64 設定確定。`npm run build:linux-arm64` で AppImage / deb が生成される |
| 依存 | T09（Pi4 実機確認済み）、T29 |
| Done の定義 | **同期点③（実機ゲート）**。Pi4 上でパッケージを展開・起動し、T08 と同等の動作が確認できる |
| 対応テスト | [M] 実機 |
| 並列可否 | 最終ゲート |

---

### 並列計画・同期点まとめ

```
T01-T04 (並列) ──→ T05 ──→ T06 ──→ T07 ──→ T07.5
                                              │
                                       ◆同期点①.pre（ハーネス成立性確認）
                                              │
                                            T08
                                              │
                                       ◆同期点① T08 完了
                                              │
                                            T09（Pi4 実機）
                                              │
                                       ◆同期点①.5 T09 完了（必須実機ゲート）
                                              │
                    ┌──────────────────────────┤
                    │                          │
               [Phase2 BE 並列]           [Phase3 FE 並列]
               T10 → T11〜T15             T16 → T17, T18
               (Vitest unit)              (xvfb E2E)
               + T32-BE (watcher切替・UC-07)
                    │                          │
                    └──────────────┬───────────┘
                                   │
                            ◆同期点② T24 完了（IPC 結合）
                                   │
                    T25, T26, T27, T32-UI (並列)
                                   │
                    T28, T29, T30 (並列)
                                   │
                            ◆同期点③ T31（実機ゲート）
```

---

## 7. テストケース

### 7.1 凡例

- **[U]**: Vitest ユニットテスト（fake timers / メモリ fs）
- **[E]**: Playwright `_electron`（要 xvfb-run）
- **[M]**: 手動実機確認（Pi4 または開発機目視）

### 7.1.2 トレーサビリティ監査結果（v3.0.0 時点）

v3.0.0 修正後に全テスト ID を grep 精査した結果:

- **重複 ID**: 0件（各プレフィックス体系で管理）
- **孤児テスト（どのタスクからも参照されない ID）**: 0件
  - UP-08 → T12 に結線済み
  - UO-07 → T16/T18 に結線済み、UO-08 → T16 に結線済み
  - UW-06, UW-07 → T13 に結線済み
  - UT-21〜24 → T30 に結線済み
  - M-11 → T29 に結線済み
- **§11 全項目のテスト ID 紐付け**: 18項目 / 18項目 = 100%

### 7.1.1 テスト ID 一意性保証

全テスト ID は以下のプレフィックス体系で管理し、重複を禁止する:

| プレフィックス | 分類 | 対象タスク |
|-------------|------|----------|
| UC-xx | config ユニット | T11, T32-BE |
| UP-xx | playlist ユニット | T12 |
| UW-xx | watcher ユニット | T13 |
| US-xx | scheduler ユニット | T14, T15, T23, T25 |
| UO-xx | overlay ユニット | T16, T17 |
| UH-xx | hotspot ユニット | T22 |
| UT-xx | 耐障害ユニット | T30 |
| E2E-xx | E2E (Playwright) | T07〜T27, T32-UI |
| M-xx | 手動実機 | T04, T06, T08〜T09, T28〜T31 |

---

### 7.2 config テスト（UC-xx）

| ID | 前提 | 操作 | 期待結果 | 検証手段 |
|----|------|------|---------|---------|
| UC-01 | `config.json` が存在しない | `configManager.load()` | 既定値が返り、`config.json` が生成される | [U] |
| UC-02 | 有効な `config.json` が存在する | `configManager.load()` | ファイルの値が返る | [U] |
| UC-03 | `config.json` が不正 JSON | `configManager.load()` | `.corrupt` に退避、既定値が返る、ERROR ログが出る | [U] |
| UC-04 | `config.json` に型不正なフィールド（例: `interval: "abc"`） | `configManager.load()` | zod で検出し既定値で補完、WARN ログが出る | [U] |
| UC-05 | 正常な config | `configManager.save(config)` | **electron-store のアトミック保存**後に整合 JSON が残ることを確認（`electron-store` の内部動作に委譲）| [U] |
| UC-06 | electron-store の保存後にファイルを読み直す | `configManager.save()` + 即時 `load()` | 保存した値が正確に復元される | [U] |
| UC-07 | フォルダパスを変更 | `settings:update({ videoFolderPath: newPath })` | watcher が新フォルダに再ポイントされ playlist が再走査される | [U] |
| UC-08 | サイト URL を変更 | `settings:update({ siteUrl: newUrl })` | siteView が新 URL を再ロードする | [U] |

---

### 7.3 playlist テスト（UP-xx）

| ID | 前提 | 操作 | 期待結果 | 検証手段 |
|----|------|------|---------|---------|
| UP-01 | 3 本の MP4 が存在 | `next()` を 4 回呼ぶ | A→B→C→A の順で返る（先頭へ循環）| [U] |
| UP-02 | 1 本の MP4 が存在 | `next()` を 3 回呼ぶ | 毎回同じファイルが返る | [U] |
| UP-03 | 0 本（空フォルダ）| `next()` を呼ぶ | `null` が返り WARN ログが出る | [U] |
| UP-04 | 不正パス（存在しないフォルダ）| `playlist.load(path)` | エラーを捕捉し空リストを返す。ERROR ログが出る | [U] |
| UP-05 | `.mp4` と `.mkv` が混在 | `playlist.load(path)` | `.mp4` のみがリストに入る | [U] |
| UP-06 | ファイル名昇順ソート確認 | `playlist.load(path)` | `a.mp4 < b.mp4 < z.mp4` の順 | [U] |
| UP-07 | カーソルが `b.mp4` を指している状態でフォルダに `c.mp4` が追加・再走査 | `next()` を呼ぶ | カーソルは `b.mp4` の次の昇順要素（`c.mp4`）を返す。既再生分（`a.mp4`）はスキップされる | [U] |
| UP-08 | カーソルが指す `b.mp4` が削除される | watcher `unlink` → `next()` | カーソルが次要素（`c.mp4` 等）へ移動。クラッシュしない | [U] |

---

### 7.4 watcher テスト（UW-xx）

| ID | 前提 | 操作 | 期待結果 | 検証手段 |
|----|------|------|---------|---------|
| UW-01 | フォルダ監視中 | `clip-004.mp4` を追加（書き込み完了後）| 次の `next()` から `clip-004` が巡回対象に入る | [U] |
| UW-02 | 巨大 MP4 をコピー途中 | ファイルが書き込み中の状態で `add` イベント（stabilityThreshold 未達）| `awaitWriteFinish` により書き込み完了後まで採用されない | [U] |
| UW-03 | フォルダ監視中・カーソルが `clip-001.mp4` を指している | `clip-001.mp4` を削除 | プレイリストから除外。カーソルが次要素（`clip-002.mp4` 等）へ整合 | [U] |
| UW-04 | 権限のないフォルダを監視 | `watcher.start('/root/videos')` | エラーを捕捉しログに出す。アプリはクラッシュしない | [U] |
| UW-05 | 監視中にフォルダ自体が消える | `rmdir` | エラーを捕捉し空リストに更新する。クラッシュしない | [U] |
| UW-06 | 監視中にファイルがリネームされる | `clip-001.mp4` → `clip-001a.mp4` にリネーム | rename イベントが検知され、プレイリストが更新される（削除+追加として処理）。カーソルが整合される | [U] |
| UW-07 | USB/NFS 低速コピー後のアトミックリネーム | 一時ファイルを書き込み後 `rename` で `.mp4` 拡張子に変更 | `awaitWriteFinish` + rename イベントで書き込み安定後にのみ採用される | [U] |

---

### 7.5 scheduler テスト（US-xx）

計時基準: **割り込み終了時刻 + interval**。再生中は計時停止（再生完了起点）。

| ID | 前提 | 操作 | 期待結果 | 検証手段 |
|----|------|------|---------|---------|
| US-01 | ループ ON・間隔 5 分 | fake timer で 5 分進める（IDLE 起点）| 1 回発火し `FADE_IN` に遷移する | [U] |
| US-02 | ループ OFF | fake timer で 30 分進める | 発火しない（`IDLE` のまま）| [U] |
| US-03 | `PLAYING` 状態で間隔が経過 | 再度タイマー発火 | 多重発火スキップ（no-op）。状態が `PLAYING` のまま。WARN ログが出る | [U] |
| US-04 | 間隔を 10 分→5 分に変更 | `updateConfig({ intervalMinutes: 5 })` | 次の発火は（変更時刻 + 5 分後）になる。前の 10 分タイマーはリセット | [U] |
| US-05 | ON で動作中 | `updateConfig({ loopEnabled: false })` | 次の発火以降は止まる（現在再生中なら完了まで継続）| [U] |
| US-06 | 間隔 1 分・動画 2 分 | fake timer で 1 分（IDLE 起点）→ 再生開始（計時停止）→ 2 分後再生完了（計時再開）→ 1 分後 | 再生中に次の発火はスキップ。**再生完了後 1 分で次を発火**（再生完了起点）| [U] |
| US-07 | ウォッチドッグ: `FADE_IN` 状態で 1500ms 超過 | fake timer で 2000ms 進める | 強制 `setVisible(false)` → `IDLE` 遷移。ERROR ログ（構造化）が出る | [U] |
| US-08 | ウォッチドッグ: `PLAYING` 状態。overlay renderer が `loadedmetadata` 後に `overlay:duration-ready { ms }` を overlay→Main で送出し、Scheduler がそれを受信して動画長+31s でタイマーを武装済みの状態 | fake timer で動画長+31s 進める（`overlay:duration-ready { ms }` 受信値基準） | 強制 `setVisible(false)` → `IDLE` 遷移。ERROR ログ（構造化）が出る | [U] |
| US-09 | ウォッチドッグ: `FADE_OUT` 状態で 1500ms 超過 | fake timer で 2000ms 進める | 強制 `setVisible(false)` → `IDLE` 遷移。ERROR ログ（構造化）が出る | [U] |
| US-10 | `IDLE` 状態 | `testPlay()` を呼ぶ | 即時 `FADE_IN` → 再生が開始される | [U] |
| US-11 | `PLAYING` 状態 | `testPlay()` を呼ぶ | no-op（無視）。WARN ログが出る | [U] |
| US-12 | プレイリスト空 | タイマー発火 | `next()` が `null` → WARN ログ → `IDLE` に戻る | [U] |
| US-13 | ループ ON・1 本のみ | 3 サイクル | 同じファイルが 3 回再生される | [U] |
| US-14 | ループ ON・N 本 | N+1 サイクル | 先頭に戻って再度 1 本目が再生される | [U] |

---

### 7.6 overlay テスト（UO-xx）

| ID | 前提 | 操作 | 期待結果 | 検証手段 |
|----|------|------|---------|---------|
| UO-01 | 正常 MP4 パス（`media://` URI） | `overlay:play` を送信 | フェードイン後に再生が始まる | [E] |
| UO-02 | 再生完了 | `ended` イベント発火 | `overlay:played` IPC が Main に届く | [E] |
| UO-03 | 破損 MP4 パス | `overlay:play` を送信 | `video.onerror` → `overlay:error` IPC が届く | [E] |
| UO-04 | フェードイン開始 | `preload` + `requestVideoFrameCallback` で 1 フレーム確定後 `setVisible(true)` | opacity が `0→1` でアニメーションする。黒フレームが挟まらない | [U] |
| UO-05 | フェードアウト | `ended` 後にアニメーション | opacity が `1→0` でアニメーションし、`transitionend` で `overlay:fade-out-done` が送出 | [U] |
| UO-06 | 黒チラ確認 | フェードイン/アウト全体 | 下層の HTML が透けて見える。黒フレームが挟まらない | [M] |
| UO-07 | 24h 冪等性: IPC ハンドラ二重登録チェック | Electron 再起動なしで 100 回再生 | ハンドラが蓄積されない（イベントリスナ数が一定のまま）| [U] |
| UO-08 | PLAYING 中の hotspot タップ透過 | PLAYING 状態で overlayView が前面を占有しているときに隅をタップ | `setIgnoreMouseEvents(true, { forward: true })` によりタップが siteView/hotspotView に透過し、settingsView が開く | [E] |

---

### 7.7 hotspot テスト（UH-xx）

| ID | 前提 | 操作 | 期待結果 | 検証手段 |
|----|------|------|---------|---------|
| UH-01 | hotspotView 動作中 | 1.5 秒以内に隅を 3 回タップ | `hotspot:tap` が Main に届き settingsView が開く | [E] |
| UH-02 | hotspotView 動作中 | 2 秒かけて 3 回タップ（時間窓外）| `hotspot:tap` が送出されない | [U] |
| UH-03 | settingsView が開いている状態 | 再度 3 タップ | settingsView がトグルして閉じる（二重に開かない）| [E] |

---

### 7.8 E2E テスト（E2E-xx）

| ID | 前提 | 操作 | 期待結果 | 検証手段 |
|----|------|------|---------|---------|
| E2E-01 | 間隔 1 分・3 本 MP4 | アプリ起動 → 1 分待機 | フェードイン→動画 1 本→フェードアウト→下層復帰の全フロー完了 | [E] |
| E2E-02 | 正常 MP4（`media://` URI）| `overlay:play` | 動画が再生され `overlay:played` が届く | [E] |
| E2E-03 | 破損 MP4 | `overlay:play` | `overlay:error` が届き Scheduler が `IDLE` に戻る | [E] |
| E2E-04 | 設定パネルを開く | `Ctrl+G`（X11）または隅 3 タップ | settingsView が表示され、URL 入力欄・フォルダ選択ボタンが存在する | [E] |
| E2E-05 | 設定変更 | パネルで間隔を 15 分に変更 → 閉じる → 再起動 | 再起動後も 15 分間隔が維持される | [E] |
| E2E-06 | settingsView 開いている | `Ctrl+G` を押す（X11 のみ） | settingsView が閉じる（トグル）| [E] |
| E2E-07 | X-Frame-Options 付きダミー HTML | siteView に表示 | ヘッダー書換えにより正常に表示される | [E] |
| E2E-08 | IDLE 状態 | 「今すぐテスト再生」 | 即時再生が開始される | [E] |
| E2E-09 | 3 本 MP4 | 4 回広告フロー実行 | A→B→C→A の順で再生される | [E] |
| E2E-10 | ループ OFF に設定後再起動 | 再起動後に 30 分待機 | 広告が発火しない | [E] |
| E2E-11 | 空フォルダ | アプリ起動 → 間隔経過 | 広告が発火せず WARN ログが出る。アプリが継続動作する | [E] （T30 対応テスト、UT-04 結線）|
| E2E-12 | 設定破損（JSON 壊れ）| アプリ起動 | `.corrupt` 退避 → 既定値で起動。ERROR ログが出る | [E] （T30 対応テスト、UT-01 結線）|
| E2E-13 | 隅 3 タップ | 1.5 秒以内に隅を 3 回タップ | settingsView が開く（Wayland/X11 両対応）| [E] |
| E2E-14 | siteView にナビゲーションリンク | 外部リンクをクリック | ナビゲーションがブロックされる（`will-navigate` / `will-redirect` 防御）| [E] |
| E2E-15 | siteView でポップアップトリガー | `window.open()` を siteView 内で実行 | ポップアップが生成されない（`setWindowOpenHandler` 防御）| [E] |
| E2E-16 | overlay/settings/hotspot renderer のヘッダー確認 | overlay・settings・hotspot 全 3 View の HTTP レスポンス確認 | `X-Frame-Options` がいずれの View でも除去されていない（siteView 専用 `persist:site` session 限定の確認）| [E] |
| E2E-17 | 動画フォルダを A→B に動的切替 | `settings:update({ videoFolderPath: B })` | watcher がフォルダ B を監視し、次の広告発火でフォルダ B の動画が再生される | [E] |

---

### 7.9 耐障害テスト（UT-xx）

**§8 エラー＆レスキューマップの全行と 1 対 1 で対応。各テストには「異常の注入方法 / 期待ログ（構造化） / 期待状態遷移」を明記する。T30 の Done 条件はこの UT 群の全 PASS が前提。**

| ID | §8 対応行 | 異常の注入方法 | 期待ログ（level/key） | 期待状態遷移 | 検証手段 |
|----|---------|------------|-------------------|------------|---------|
| UT-01 | 設定読み込み: JSON 破損 | `config.json` に不正 JSON を書き込んだ状態で `configManager.load()` | `ERROR { event: "config.corrupt" }` | ファイルが `.corrupt` に退避。既定値が返る | [U] |
| UT-02 | 設定読み込み: 型不正 | `config.json` に `{ interval: "abc" }` を書き込んで `load()` | `WARN { event: "config.fieldFixed", field: "interval" }` | 不正フィールドが既定値で補完。他フィールドは維持 | [U] |
| UT-03 | 設定保存: 書き込み失敗 | `electron-store.set` を例外スローでモック | `ERROR { event: "config.saveFailed" }` | 既存の設定値を保持。例外が上位に伝播しない | [U] |
| UT-04 | フォルダ走査: 空フォルダ | 空のテンポラリフォルダをロード | `WARN { event: "playlist.empty" }` | Scheduler が IDLE を維持。アプリ継続 | [U] |
| UT-05 | フォルダ走査: パス不正・権限なし | 存在しないパス / 権限なしパスを `playlist.load()` | `ERROR { event: "playlist.loadFailed", reason: "ENOENT" }` | 空リストを返す。クラッシュしない | [U] |
| UT-06 | フォルダ監視: コピー途中の MP4 | `stabilityThreshold` 未達で `add` イベントを発火させる | `DEBUG { event: "watcher.stabilizing" }` | ファイルがプレイリストに追加されない（書き込み完了後に追加）| [U] |
| UT-07 | フォルダ監視: フォルダ消失 | 監視中フォルダを `rmdir` | `ERROR { event: "watcher.folderGone" }` | 空リストに更新。クラッシュしない | [U] |
| UT-08 | 動画再生: 破損 MP4 | `media://` で 0 バイトファイルを指定 | `ERROR { event: "overlay.videoError", path: "..." }` | Scheduler がフェードアウトをスキップして IDLE へ。次回発火は正常 | [U] |
| UT-09 | 動画再生: 再生中にファイル削除 | 再生中に `unlink` → `video.onerror` を発火させる | `ERROR { event: "overlay.videoError", reason: "srcGone" }` | 同上 | [U] |
| UT-10 | 動画再生: IPC 送信後にパス消失 | `overlay:play` 送信直後に `unlink`（タイミング制御） | `ERROR { event: "overlay.videoError" }` | 同上 | [U] |
| UT-11 | Scheduler: 間隔 < 動画長 | fake timers で間隔 < 動画長の発火 | `WARN { event: "scheduler.multiFireSkipped" }` | 再生中に no-op。再生完了後 interval 後に次発火 | [U] |
| UT-12 | 設定パネル多重起動 | `settings:open` を連続 5 回送信 | `DEBUG { event: "settings.alreadyOpen" }` | パネルが単一インスタンスのまま | [U] |
| UT-13 | siteView 読み込み失敗・ネット断 | `did-fail-load` をモック発火 | `ERROR { event: "siteView.loadFailed", attempt: N }` | 指数バックオフで再試行（1→2→4→8→max 60s）。広告層は独立継続 | [U] |
| UT-14 | overlay: GPU 異常・透過合成失敗（段階的フォールバック） | `--disable-gpu-compositing` でのフォールバック、次に `--disable-gpu` を最終手段として起動 | `ERROR { event: "overlay.gpuFallback", level: "compositing" }` / `ERROR { ..., level: "full" }` | 段階①: ソフト合成のみ停止（HW デコードは継続）。段階②: GPU 全無効（最終手段）。継続動作 | [M] |
| UT-15 | プロセス全体: 未捕捉例外 | `process.emit('uncaughtException', new Error('test'))` | `ERROR { event: "process.uncaughtException", stack: "..." }` | 集約ログ後 `app.relaunch()` + `app.quit()`。systemd が再起動 | [U] |
| UT-16 | プロセス全体: 未処理 Promise 拒否 | `process.emit('unhandledRejection', reason)` | `ERROR { event: "process.unhandledRejection" }` | 集約ログ。継続 or relaunch（設定による）| [U] |
| UT-17 | プロセス全体: クラッシュ（SIGSEGV 等）| — （systemd レベル）| — | systemd `Restart=always`・`RestartSec=5` で 5 秒以内に再起動 | [M] |
| UT-18 | IPC 無応答（ウォッチドッグ発動）| FADE_IN 状態のまま fake timer で 2000ms 超過 | `ERROR { event: "scheduler.watchdogTriggered", state: "FADE_IN" }` | 強制 `setVisible(false)` → IDLE 復帰。次の発火は正常 | [U] |
| UT-19 | siteView ナビゲーション/ポップアップ/DL ガード | `will-navigate` イベントを外部 URL でモック発火 | `WARN { event: "siteView.navBlocked", url: "..." }` | ナビゲーションが `preventDefault()` で阻止。siteView は現在 URL を維持 | [U] |
| UT-20 | systemd start-limit 到達（連続クラッシュ） | 60 秒以内に 6 回クラッシュ（StartLimitBurst=5 超過）| journald で `ubuntuapp.service: Start request repeated too quickly` 確認 | systemd が起動を停止。`journalctl` で確認可能 | [M] |
| UT-21 | media:// パストラバーサル拒否 | `media://videos/../../../etc/passwd` をプロトコルハンドラに渡す | パス正規化でプレイリストルート外を検出し 403 Forbidden を返す。ERROR ログ `{event:"protocol.pathTraversal"}` が出る | [U] |
| UT-22 | media:// 不正 Range ヘッダー → 416 | `Range: bytes=-1`・範囲外 Range を送信 | 416 Requested Range Not Satisfiable を返す。全ファイルのバッファリングが発生しない | [U] |
| UT-23 | IPC 不正 sender 拒否 | siteView（allowlist 外）から `overlay:play` を ipcRenderer 経由で送信 | `senderFrame` 検証で即拒否。ERROR ログ `{event:"ipc.invalidSender", sender:"..."}` が出る。動画が再生されない | [U] |
| UT-24 | settings:update 不正値拒否 | `{ intervalMinutes: 7 }`（allowlist 外）/ `{ siteUrl: "javascript://..." }`（不正スキーム）/ 不存在フォルダパスで update 送信 | `ConfigUpdateSchema`(zod) が検証し拒否。WARN ログ `{event:"settings.invalidUpdate"}` が出る。設定が変更されない | [U] |

---

### 7.10 手動実機テスト（[M]）

| ID | 確認項目 | 手順 |
|----|---------|------|
| M-01 | X-Frame/CSP 持ち実サイト内部表示 | Pi4 に実 URL を設定して起動し、サイネージが表示されることを確認 |
| M-02 | HW デコード・1080p 再生 | `vainfo` でデコーダ確認後、1080p MP4 の再生がカクつかないことを確認。**Pi4 受け入れ閾値**: フレームレート 30fps 以上維持・CPU 使用率 80% 以下（4 コア合計）・温度 80°C 以下（`vcgencmd measure_temp`）・プロセス合計メモリ 512MB 以内 |
| M-03 | 黒チラなし確認 | フェードイン/アウトを **50 回以上**繰り返し目視。1 回も黒フレームが挟まらないことを確認 |
| M-04 | 24h 連続稼働 + renderer クラッシュ回復 | リーク・タイマー蓄積・フェード劣化なしを journald ログで確認。**メモリ常駐上限: プロセス合計 512MB 以内**。IPC ハンドラ/リスナの蓄積がないことを確認。**renderer クラッシュ回復**: 稼働中に `kill -9 <overlayViewPID>` を実行し `render-process-gone` ハンドラが View を再生成・再ロードして 5 秒以内に復旧することを確認（プロセス数サンプリングで View 数が正常に戻ることを検証）|
| M-05 | スリープ抑止 | 30 分放置でスクリーンセーバー/スリープが発動しないことを確認 |
| M-06 | クラッシュ自動復帰 | `kill -9 <pid>` 後 5 秒以内に systemd が再起動することを確認 |
| M-07 | ネット断での継続 | Wi-Fi オフ後に siteView がエラー表示になるが広告層は独立継続することを確認 |
| M-08 | コピー途中 MP4 の誤読なし | 大容量 MP4 のコピー中に間隔が経過しても `awaitWriteFinish` により採用されないことを確認 |
| M-09 | Pi4 メモリ footprint | `top` / `ps` でプロセス合計メモリを計測。hotspotView の overlay 統合採否を記録（`docs/pi4-verification.md`）|
| M-10 | Wayland 隅 3 タップ必須ゲート | Wayland 環境で Ctrl+G が動作しないことを確認し、隅 3 タップで settingsView が開くことを確認 |
| M-11 | シングルインスタンスガード | アプリ起動中に同じパッケージを再起動する | `app.requestSingleInstanceLock()` により 2 回目の起動が既存インスタンスにフォーカスを渡して終了することを確認 |

---

## 8. エラー＆レスキューマップ

**方針: サイレント障害ゼロ。全ての `catch` は (a) 構造化ログ（level/event/detail） (b) 状態/戻り値への反映 を必須とする。空 `catch` 禁止（`no-empty` lint ルール）。**

| 処理 | 想定される異常 | ハンドリング方法 | ユーザーへの影響 | 対応 UT |
|------|---------------|-----------------|-----------------|--------|
| 設定読み込み: JSON 破損 | `SyntaxError` | `.corrupt` に退避 → 既定値リセット → ERROR ログ `{event:"config.corrupt"}` | 設定がリセットされるが起動継続 | UT-01 |
| 設定読み込み: 型不正・欠落 | zod `ZodError` | 不正フィールドのみ既定値で補完 → WARN ログ `{event:"config.fieldFixed"}` | 一部設定がリセットされるが起動継続 | UT-02 |
| 設定保存: 書き込み失敗 | `ENOSP` / `EROFS` / electron-store 例外 | electron-store のアトミック保存に委譲。失敗時 ERROR ログ → 前回値を保持 | 保存されないが現在の設定でセッション継続 | UT-03 |
| フォルダ走査: 空フォルダ | `items.length === 0` | no-op → WARN ログ `{event:"playlist.empty"}`。Scheduler は IDLE を維持 | 広告が発火しないが下層サイネージは継続 | UT-04 |
| フォルダ走査: パス不正・権限なし | `ENOENT` / `EACCES` | エラー捕捉 → 空リスト → ERROR ログ `{event:"playlist.loadFailed"}` | 上記と同様 | UT-05 |
| フォルダ監視: コピー途中の巨大 MP4 | stabilityThreshold 未達 | `awaitWriteFinish` により採用を遅延。書き込み完了後に採用 | 一時的に採用されないだけ。問題なし | UT-06 |
| フォルダ監視: フォルダ消失 | `ENOENT` (chokidar) | エラー捕捉 → 空リスト更新 → ERROR ログ `{event:"watcher.folderGone"}` | 広告停止。下層サイネージは継続 | UT-07 |
| 動画再生: 破損 MP4 | `video.onerror` | `overlay:error` → Scheduler がフェードアウトスキップして IDLE | 広告 1 回がスキップされる。ERROR ログ | UT-08 |
| 動画再生: 再生中にファイルが削除 | `video.onerror` (src 消失) | 同上 | 同上 | UT-09 |
| 動画再生: パス消失（IPC 送信後に削除）| `video.onerror` | 同上 | 同上 | UT-10 |
| Scheduler: 間隔 < 動画長 | 再生中に次の発火 | 多重発火スキップ（no-op）。WARN ログ `{event:"scheduler.multiFireSkipped"}` | 次回発火まで待機。動画再生は正常完了 | UT-11 |
| **IPC 無応答（無音失敗）**: 非 IDLE 状態でフェード完了通知が届かない | ウォッチドッグタイムアウト（FADE_IN/FADE_OUT: 1500ms, PLAYING: 動画長+30s）| 強制 `setVisible(false)` → IDLE 復帰 + ERROR ログ `{event:"scheduler.watchdogTriggered", state:"..."}` | 広告が途中で終了。次回発火は正常 | UT-18 |
| 設定パネル: 多重起動 | `settings:open` が複数回来る | 単一インスタンス管理（`settingsView.isVisible()` チェック）→ トグルのみ | パネルが二重に開かない | UT-12 |
| siteView: 読み込み失敗・ネット断 | `did-fail-load` イベント | 指数バックオフ（1→2→4→8→max 60 秒）で再読み込み → ERROR ログ `{event:"siteView.loadFailed"}` | 下層が白/エラー表示になるが広告層は独立継続 | UT-13 |
| siteView: 不正ナビゲーション/ポップアップ/DL | `will-navigate` / `will-redirect` / `window.open` / DL リクエスト | `preventDefault()` で全ブロック。WARN ログ `{event:"siteView.navBlocked"}` | siteView が外部へ遷移しない。DL が発生しない | UT-19 |
| overlay: GPU 異常・透過合成失敗 | レンダリングエラー | **段階フォールバック**: ① `--disable-gpu-compositing`（HW デコードは維持）→ 改善しない場合 ② `--disable-gpu`（最終手段・ソフトデコード）→ ERROR ログ `{event:"overlay.gpuFallback", level:"compositing"\|"full"}` | ①: 画質影響なし。②: CPU 使用率増加の可能性。継続動作 | UT-14 |
| プロセス全体: 未捕捉例外 | `uncaughtException` | 集約ログ `{event:"process.uncaughtException"}` → 必要に応じて `app.relaunch()` + `app.quit()` | systemd が自動再起動（5 秒以内）| UT-15 |
| プロセス全体: 未処理 Promise 拒否 | `unhandledRejection` | 集約ログ `{event:"process.unhandledRejection"}` | 同上 | UT-16 |
| プロセス全体: クラッシュ | SIGSEGV 等 | systemd `Restart=always`・`RestartSec=5` | 5 秒以内に自動再起動 | UT-17 |
| systemd start-limit 到達 | 連続クラッシュ（60s 以内に 6 回）| `StartLimitIntervalSec=60`・`StartLimitBurst=5` を超えると systemd が起動停止。journald に記録される | 管理者による手動介入が必要。`systemctl --user reset-failed ubuntuapp` で復旧 | UT-20 |
| media:// パストラバーサル攻撃 | シンボリックリンクまたは `../` でプレイリストルート外へ脱出 | パス正規化 → `fs.realpath` でルート内閉じ込め確認 → 脱出検出時は 403 返却。ERROR ログ `{event:"protocol.pathTraversal"}` | 動画が再生されない。アプリは継続 | UT-21 |
| media:// 不正 Range ヘッダー | `Range: bytes=-1` 等の不正 Range | 416 Requested Range Not Satisfiable を返す。全バッファリングしない。ERROR ログ `{event:"protocol.invalidRange"}` | レンダラーがエラー状態。次の再生は正常 | UT-22 |
| IPC 不正 sender | allowlist 外 View（siteView など）から IPC 送信 | `event.senderFrame` 検証で拒否。ERROR ログ `{event:"ipc.invalidSender"}` | 不正 IPC が無視される。アプリ継続 | UT-23 |
| settings:update 不正値 | `intervalMinutes` が allowlist 外 / 不正 URL スキーム / 不存在フォルダ | `ConfigUpdateSchema`(zod) で拒否 + WARN ログ `{event:"settings.invalidUpdate"}`. 設定変更なし | 設定が変更されない。ユーザーはパネルで再入力 | UT-24 |
| renderer プロセスクラッシュ | `render-process-gone` イベント（overlayView / hotspotView / settingsView）| 対象 View を再生成・再ロード。ERROR ログ `{event:"renderer.crashed", view:"..."}` | 一時的に表示が乱れる。5 秒以内に View が復旧 | M-04 |

---

## 9. リスクと未確定の外部入力 & ダミー戦略

### 9.1 未確定の外部入力

| 項目 | 開発時の代替手段 | 本番時の対応 |
|------|----------------|------------|
| 既存サイネージ URL | `assets/dummy/signage.html`（X-Frame-Options: SAMEORIGIN を付与） | ユーザーが設定パネルの URL 入力欄で入力 |
| 動画フォルダパス | `assets/dummy/` 以下のダミー MP4 を使用 | ユーザーが設定パネルのフォルダ選択ボタンで選択（`dialog.showOpenDialog` 経由）|
| Pi4 の X-Frame 回避確認 | 開発機 xvfb-run で概念実証（T08）| T09 実機ゲートで確定 |

### 9.2 ダミー資産戦略（T04）

```bash
# ダミー MP4 生成（H.264/1080p/yuv420p/+faststart/無音/5 秒）
ffmpeg -f lavfi -i color=c=blue:s=1920x1080:r=30 \
  -f lavfi -i anullsrc -c:v libx264 -preset fast \
  -pix_fmt yuv420p -t 5 -movflags +faststart \
  -an assets/dummy/clip-001.mp4
# clip-002.mp4, clip-003.mp4 も同様（色違い）
# 破損 MP4: 0 バイトファイル
touch assets/dummy/clip-broken.mp4
# 巨大 MP4: 200MB 相当（コピー途中テスト用）
ffmpeg -f lavfi -i color=c=red:s=1920x1080:r=30 -c:v libx264 \
  -b:v 30M -t 60 assets/dummy/clip-large.mp4
```

### 9.3 X-Frame 回避の対比検証

| 方式 | 開発機での確認方法 |
|------|-----------------|
| ヘッダー書換えなし | siteView に X-Frame HTML を読み込ませ、表示されないことを確認 |
| ヘッダー書換えあり | `headerHook.ts` 適用後に同 URL が正常表示されることを確認 |
| overlay/settings renderer への影響なし | E2E-16 で確認 |

### 9.4 リスク一覧

| リスク | 影響度 | 対策 |
|--------|--------|------|
| Playwright `_electron` が WebContentsView の page 取得に対応しない | 高 | **T07.5（ハーネス成立性スパイク）で T08 着手前に確認**。不可の場合は WebdriverIO + wdio-electron-service に切替。移行工数: 2〜3 日と見積る |
| Pi4 の Wayland で `globalShortcut` が動作しない | **確定制約（非リスク）** | **Wayland 非対応は既知。隅 3 タップを正規・常時経路として実装済み**（T22）。Ctrl+G は X11 のベストエフォート |
| arm64 用 Electron プリビルドがない（バージョン固定時）| 高 | T01 の時点で arm64 プリビルドが存在するバージョン（v33.x.x 以上）を確認して固定 |
| Pi4 での HW デコード（VA-API）が動作しない | 中 | T09 で確認。動作しない場合はソフトウェアデコードで継続（M-04 の CPU 使用率確認）|
| Wayland 環境での透過合成が動作しない | 中 | X11 バックエンド強制（`ELECTRON_OZONE_PLATFORM_HINT=x11`）。M-10 で確認 |
| Pi4 メモリ不足（複数 WebContentsView）| 中 | T09 で footprint 計測（M-09）。hotspotView の overlay DOM 統合で削減検討 |

---

## 10. Linux 検証戦略

### 10.1 開発機（WSL2 x86_64）

- 表示サーバ/xvfb なし環境のため E2E テストは `xvfb-run` 前提
- 透過合成・HW デコード・実 X-Frame サイト表示は開発機では完全確認不可
- CI では `xvfb-run -a npm run test:e2e` でヘッドレス実行

```yaml
# CI での xvfb-run 設定例
- name: Install xvfb
  run: sudo apt-get install -y xvfb
- name: Run E2E tests
  run: xvfb-run -a --server-args="-screen 0 1920x1080x24" npm run test:e2e
```

### 10.2 Pi4 実機（[M] バケット）

- T08 完了後に T09（Pi4 再現実証・必須ゲート①.5）を実施
- 以下の項目は必ず実機で確認：
  - 透過合成（黒チラなし・M-03 を 50 回以上）
  - HW デコード可否（`vainfo`）
  - 1080p でのカクつきなし
  - スリープ抑止 30 分
  - systemd 自動起動・クラッシュ復帰（M-06）
  - 24h 連続稼働（M-04、メモリ常駐 512MB 以内）
  - **hotspotView 統合採否の決定**（M-09 メモリ計測後）
  - **Wayland 隅 3 タップ必須動作確認**（M-10）

### 10.3 間隔短縮確認

- ユニットテスト: Vitest fake timers で 5/10/15/30 分を模擬
- E2E テスト: 間隔を 1 分に短縮して実際の発火タイミングを確認
- 実機長時間テスト: 1 分間隔で 1 時間の連続稼働確認

---

## 11. 受け入れ基準チェックリスト

- [ ] 起動時に枠なし全画面で既存サイネージ（実 URL・X-Frame 持ち）が取り込み表示される ← E2E-07, M-01
- [ ] 間隔（5/10/15/30 分、短縮 1 分でも）ごとに広告が 1 回割り込む ← E2E-01, US-01, US-06
- [ ] フェードイン → 動画 1 本 → フェードアウトで黒チラなし（実機目視 50 回以上確認） ← UO-04, UO-05, UO-06, M-03
- [ ] フォルダ内の MP4 を 1 本ずつ巡回し、1 本のみなら毎回同じ動画が再生される ← UP-01, UP-02, E2E-09
- [ ] 広告後に下層サイネージへ即復帰し、下層が中断・再読み込みされない ← E2E-01
- [ ] フォルダに MP4 を置くだけで次回発火から自動反映される（コピー途中は採用しない） ← UW-01, UW-02, M-08
- [ ] 動画が常時ミュートで再生される ← UO-01, E2E-02
- [ ] ループ ON/OFF・間隔がパネルでワンタップ切替でき、再起動後も維持される ← US-04, US-05, E2E-05, E2E-10
- [ ] サイト URL と動画フォルダパスが設定パネルから変更でき、動的に切替わる ← UC-07, UC-08, E2E-17
- [ ] X11 環境で `Ctrl+G`、Wayland/X11 両環境で隅 3 回タップ（1.5 秒以内）でパネルが開く。普段は非表示。多重起動しない ← E2E-04, E2E-06, E2E-13, UH-01, UH-02, UH-03
- [ ] 動画ファイルは `media://` カスタムプロトコル経由で配信され、`file://` 直読は使用しない。パストラバーサル拒否・Range 不正 416 ← E2E-02, UT-21, UT-22
- [ ] 空フォルダ / パス不正 / 破損動画 / 設定破損 / ネット断のいずれでもアプリが停止しない。すべて構造化ログに痕跡が残る ← UT-01〜05, UT-07〜10, UT-13, E2E-11, E2E-12
- [ ] IPC 無応答（ウォッチドッグ超過）時も強制 IDLE 復帰し、次回発火は正常動作する ← UT-18, US-07, US-08, US-09
- [ ] siteView の外部ナビゲーション・ポップアップ・ダウンロードがすべてブロックされる ← E2E-14, E2E-15, UT-19
- [ ] ヘッダー書換えが siteView 専用 session に限定されており、overlay/settings/hotspot renderer には影響しない ← E2E-16
- [ ] 自動起動・クラッシュ復帰（5 秒以内）・スリープ抑止が 24h 連続で機能する ← M-05, M-06, UT-20
- [ ] 連続クラッシュ（start-limit 到達）が journald に記録され、管理者が復旧できる ← UT-20, M-06
- [ ] IPC 不正 sender は拒否され、設定の不正更新は ConfigUpdateSchema で拒否される ← UT-23, UT-24

---

*以上*
