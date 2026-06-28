# デプロイ・動作確認ガイド

対象バージョン: v3.1.0 (ドキュメントバージョン。アプリバージョンは package.json の `"version": "0.1.0"` を参照)  
作成日: 2026-06-27

---

## 目次

1. [前提環境](#1-前提環境)
2. [設定方法](#2-設定方法)
3. [開発機での起動確認](#3-開発機での起動確認)
4. [arm64 ビルド手順](#4-arm64-ビルド手順)
5. [systemd 自動起動の導入](#5-systemd-自動起動の導入)
6. [スリープ抑止](#6-スリープ抑止)
7. [手動検証チェックリスト](#7-手動検証チェックリスト)

---

## 1. 前提環境

### ターゲット機材

| 項目 | 要件 |
|------|------|
| ハードウェア | Raspberry Pi 4 Model B (4GB 以上推奨) |
| OS | Raspberry Pi OS 64bit (Bookworm 相当) |
| アーキテクチャ | arm64 (aarch64) |
| Node.js | v20 LTS 以上 (ビルド機のみ。Pi4 本体での Node.js インストールは不要) |
| ffmpeg | 4.x 以上 (開発機でのダミー資産生成に使用。`scripts/gen-dummy-assets.sh`) |
| Python | 不要 |

### 確認コマンド (ビルド機)

```bash
node --version    # v20.x.x 以上であること
npm --version     # 10.x.x 以上であること
ffmpeg -version   # 4.x 以上であること (ダミー資産生成に必要)
uname -m          # arm64 または x86_64
```

### Pi4 側の前提確認

```bash
# 実機で要実行
uname -m            # aarch64 であること
getconf LONG_BIT    # 64 であること
vainfo 2>/dev/null || echo "VA-API 未対応 (ソフトデコードで動作継続)"
```

**libfuse2 の前提インストール (Pi OS Bookworm)**

Pi OS Bookworm (Debian 12) は既定で fuse3 のみ搭載しており、type-2 AppImage の実行に必要な `libfuse2` が含まれません。インストール前に以下を実行してください:

```bash
# 実機で要実行 (Pi OS Bookworm)
sudo apt-get install -y libfuse2
```

`ops/install.sh` はプリフライト検査として `libfuse2` の有無を確認し、未導入の場合は明示エラーで停止します。

**libfuse2 なしで起動する代替手順 (FUSE 不使用モード)**

`libfuse2` がインストールできない環境では、環境変数 `APPIMAGE_EXTRACT_AND_RUN=1` を設定すると FUSE を使わずに AppImage を展開・実行できます (起動に数秒余分にかかります):

```bash
# install.sh の代替呼び出し
APPIMAGE_EXTRACT_AND_RUN=1 bash ops/install.sh /home/pi/ubuntuapp-0.1.0-arm64.AppImage
# 起動後の systemd ユニット経由での起動も同様に環境変数が必要なため、
# ~/.config/systemd/user/signage-overlay.service に Environment=APPIMAGE_EXTRACT_AND_RUN=1 を追記すること
```

> 推奨は `sudo apt-get install -y libfuse2` です。

---

## 2. 設定方法

### 設定項目

| 項目 | 説明 | デフォルト |
|------|------|-----------|
| `siteUrl` | 下層に表示するサイネージサイトの URL | `""` (空 — 未設定時はスタート画面を表示) |
| `videoFolderPath` | 広告動画 MP4 が置かれたフォルダの**絶対パス**（必須。サブディレクトリは非対応） | `""` (空) |
| `intervalMinutes` | 広告割り込み間隔 (1/5/10/15/30 分) | `5` |
| `loopEnabled` | 広告割り込み有効/無効 | `true` |

### 方法 A: 設定パネルから入力する (推奨)

設定パネルは以下の 2 つの方法で開けます。

**方法 1: 隅 3 回タップ (Wayland/X11 共通・常設正規経路)**

画面の任意の隅を **1.5 秒以内に 3 回** タップまたはクリックします。
Wayland 環境では隅 3 回タップが唯一の開き方です。

**方法 2: Ctrl+G キーショートカット (X11 のみ・ベストエフォート)**

X11 セッション上では `Ctrl+G` でパネルが開閉します。
Wayland 環境ではこのショートカットは動作しません。

パネルが開いたら:

1. 「サイト URL」欄に表示したいサイネージ URL を入力します
2. 「動画フォルダ選択」ボタンをクリックしてフォルダ選択ダイアログを開き、MP4 ファイルが入ったフォルダを指定します
3. 広告間隔・ループ ON/OFF を選択します
4. 「閉じる」ボタンまたは再度の隅 3 タップでパネルを閉じます

設定は即時有効になり、再起動後も維持されます。

### 方法 B: 設定ファイルを直接編集する

`electron-store` が保存する JSON ファイルを編集できます。
アプリ停止中に編集してください。

```bash
# ファイルパスの確認 (Linux)
# 通常 ~/.config/ubuntuapp/config.json に保存される
ls ~/.config/ubuntuapp/

# 編集例
nano ~/.config/ubuntuapp/config.json
```

```json
{
  "siteUrl": "https://your-signage-site.example.com",
  "videoFolderPath": "/home/pi/videos",
  "intervalMinutes": 10,
  "loopEnabled": true
}
```

JSON が不正な場合はアプリ起動時に `.corrupt` ファイルへ退避され、デフォルト値で起動します。

---

## 2.0 動画ファイルの制約

以下の制約はコードで固定されており、設定で変更できません。

| 制約 | 詳細 |
|------|------|
| **形式: MP4 のみ** | `media-protocol.ts` にて `Content-Type: video/mp4` をハードコード。`.mp4` 以外の拡張子はプレイリストに含まれない (`playlist.ts` で `.mp4` のみフィルタ) |
| **直下のファイルのみ** | `videoFolderPath` 直下の `.mp4` ファイルのみ対象。サブディレクトリは再帰走査しない (`fs.promises.readdir` で非再帰) |
| **絶対パス必須** | `videoFolderPath` は絶対パスで指定する。相対パスは動作未保証 |

## 2.1 動画フォルダが USB / NFS マウントの場合（usePolling）

Linux の inotify は USB マスストレージや NFS マウントされたフォルダでは正常に動作しないことがあります。
この場合、chokidar のポーリングモードを有効にすることで rename イベントの欠落を防げます。

### 設定方法

環境変数 `WATCHER_USE_POLLING` と `WATCHER_POLL_INTERVAL_MS` で制御できます。

```bash
# USB / NFS マウントフォルダを監視する場合
export WATCHER_USE_POLLING=true
export WATCHER_POLL_INTERVAL_MS=200   # デフォルト: 100ms。USB は 200〜500ms が適切

# systemd ユニットに設定する場合は Environment= に追記する
# ~/.config/systemd/user/signage-overlay.service:
# [Service]
# Environment=WATCHER_USE_POLLING=true
# Environment=WATCHER_POLL_INTERVAL_MS=200
```

### 注意事項

| 環境 | 推奨設定 |
|------|---------|
| Pi4 ローカル ext4 (SD カード / SSD) | `usePolling: false`（デフォルト・inotify 使用） |
| USB マスストレージ | `usePolling: true`、`pollIntervalMs: 200〜500` |
| NFS マウント | `usePolling: true`、`pollIntervalMs: 500〜1000` |
| WSL2 開発環境 | `usePolling: true`、`pollIntervalMs: 50〜100` |

ポーリングモードではファイルシステムを定期的にポーリングするため、CPU 負荷がわずかに増加します。
Pi4 のローカル ext4 では不要です。

---

## 3. 開発機での起動確認

### 3.1 WSL2 / ヘッドレス環境での注意

WSL2 や表示サーバのない環境では Electron の GUI を直接起動できません。  
X11 フォワーディングまたは **Xvfb (仮想フレームバッファ)** が必要です。

```bash
# Xvfb のインストール (Ubuntu/Debian)
sudo apt-get install -y xvfb

# Xvfb を使って起動する場合
xvfb-run -a --server-args="-screen 0 1920x1080x24" npm run dev
```

WSL2 の場合は WSLg (Windows 11) が有効であれば直接 GUI が表示される場合があります。  
WSLg なしの WSL2 では上記の Xvfb 経由が必要です。

### 3.2 開発機 (X11/Wayland) での通常起動

```bash
# プロジェクトルートで実行
cd /path/to/ubuntuapp
npm install          # 初回のみ
npm run dev          # 開発サーバ起動 (HMR 有効)
```

### 3.3 起動確認チェック

```bash
# TypeScript 型チェック
npm run typecheck

# Lint チェック
npm run lint

# ユニットテスト (Vitest)
npm run test

# E2E テスト (Playwright - xvfb-run 必須)
# package.json の "test:e2e": "xvfb-run -a playwright test" で実行できる
xvfb-run -a --server-args="-screen 0 1920x1080x24" npm run test:e2e
```

---

## 4. arm64 ビルド手順

### なぜ実機 (arm64 環境) でビルドするか

`electron-builder` は arm64 向けに Electron のプリビルドバイナリを取得しますが、  
ネイティブ Node モジュールが含まれる場合はクロスコンパイルが困難です。  
また、Pi4 固有の起動フラグ (`--enable-features=VaapiVideoDecoder` 等) の動作確認は  
**実機でしか行えません** (実装計画書 §9 C-2 参照)。

実機またはネイティブ arm64 環境 (QEMU arm64 VM など) でビルドすることを強く推奨します。

### ビルド手順

```bash
# ビルド機 (arm64 または x86_64 でのクロスビルド) で実行
cd /path/to/ubuntuapp

# 依存パッケージのインストール
npm install

# TypeScript ビルド + パッケージング (arm64)
npm run build:linux-arm64
```

生成物は `release/` ディレクトリに出力されます:

```
release/
  ubuntuapp-0.1.0-arm64.AppImage
  ubuntuapp_0.1.0_arm64.deb
```

### Pi4 への転送と起動確認

```bash
# 実機で要実行
# AppImage を Pi4 へ転送
scp release/ubuntuapp-0.1.0-arm64.AppImage pi@raspberrypi.local:~/

# Pi4 側で実行権限を付与して起動
ssh pi@raspberrypi.local
chmod +x ~/ubuntuapp-0.1.0-arm64.AppImage
~/ubuntuapp-0.1.0-arm64.AppImage
```

HW デコード (VA-API) を有効にする場合は起動フラグを追加します:

```bash
# 実機で要実行
~/ubuntuapp-0.1.0-arm64.AppImage --enable-features=VaapiVideoDecoder
```

有効フラグの確定値は `docs/pi4-verification.md` に記録してください (T09 完了後)。

---

## 5. systemd 自動起動の導入

### 5.1 前提

- Pi4 にグラフィカルセッション (X11 または Wayland) が起動していること
- `graphical-session.target` が available であること (`systemctl --user list-units --type=target`)

### 5.2 インストール

```bash
# プロジェクトルートで実行
# 引数: Pi4 上での AppImage の絶対パス
bash ops/install.sh /home/pi/ubuntuapp-0.1.0-arm64.AppImage
```

`install.sh` は以下を行います:

1. `ops/signage-overlay.service` を `~/.config/systemd/user/signage-overlay.service` へコピー
2. `ExecStart`・`DISPLAY`・`XDG_RUNTIME_DIR` を実行環境の値に書き換え
3. `systemctl --user daemon-reload && enable`
4. `loginctl enable-linger $USER` でログアウト後の自動起動を有効化
5. `ops/signage-overlay.desktop` を `~/.config/autostart/` へコピー (フォールバック)

### 5.3 手動インストール手順

`install.sh` が使えない場合は以下を手動で実行します:

```bash
# 実機で要実行

# 1. ユニットディレクトリ作成
mkdir -p ~/.config/systemd/user/

# 2. ユニットファイルを配置 (ExecStart を AppImage の実際のパスに書き換える)
cp ops/signage-overlay.service ~/.config/systemd/user/
sed -i "s|ExecStart=.*|ExecStart=/home/pi/ubuntuapp-0.1.0-arm64.AppImage|" \
  ~/.config/systemd/user/signage-overlay.service

# 3. DISPLAY / XDG_RUNTIME_DIR を確認して必要に応じて編集
nano ~/.config/systemd/user/signage-overlay.service

# 4. systemd に読み込ませて有効化
systemctl --user daemon-reload
systemctl --user enable signage-overlay

# 5. ログアウト後も動作させるために linger を有効化
loginctl enable-linger $USER

# 6. .desktop autostart フォールバック
mkdir -p ~/.config/autostart/
cp ops/signage-overlay.desktop ~/.config/autostart/
sed -i "s|Exec=.*|Exec=/home/pi/ubuntuapp-0.1.0-arm64.AppImage|" \
  ~/.config/autostart/signage-overlay.desktop
```

### 5.4 起動・停止・ログ確認

```bash
# 実機で要実行

# 手動起動
systemctl --user start signage-overlay

# 停止
systemctl --user stop signage-overlay

# 状態確認
systemctl --user status signage-overlay

# リアルタイムログ
journalctl --user -u signage-overlay -f

# 起動以降の全ログ
journalctl --user -u signage-overlay --since "today"

# 連続クラッシュで start-limit に達した後の手動復旧
systemctl --user reset-failed signage-overlay
systemctl --user start signage-overlay
```

### 5.5 ユニットファイルのパラメータ説明

`ops/signage-overlay.service` の主要パラメータ:

| パラメータ | 値 | 説明 |
|-----------|-----|------|
| `After=graphical-session.target` | — | グラフィカルセッション確立後に起動 |
| `WantedBy=graphical-session.target` | — | グラフィカルセッション起動時に自動起動 |
| `Restart=always` | — | 終了理由を問わず再起動 |
| `RestartSec=5` | 5 秒 | 再起動までの待機時間 |
| `StartLimitIntervalSec=60` | 60 秒 | 連続クラッシュ判定ウィンドウ |
| `StartLimitBurst=5` | 5 回 | この回数を超えると起動停止 |
| `Environment=DISPLAY=:0` | `:0` | X11 ディスプレイ番号 (Wayland 不使用時も設定) |
| `Environment=WAYLAND_DISPLAY=wayland-0` | `wayland-0` | Wayland ソケット名 |
| `Environment=XDG_RUNTIME_DIR=/run/user/1000` | UID=1000 の場合 | 実行ユーザーの UID で書き換え |

---

## 6. スリープ抑止

### 6.1 アプリ内 (powerSaveBlocker)

アプリ起動時に `powerSaveBlocker.start('prevent-display-sleep')` が自動的に有効になります。  
`src/main/index.ts` 内で管理されており、追加の設定は不要です。

### 6.2 X11 環境での補完設定

X11 セッションでは `powerSaveBlocker` に加えて `xset` コマンドで OS レベルのスリープを抑止します。  
アプリが起動時に自動実行しますが、手動でも確認できます:

```bash
# 実機で要実行 (X11 セッション上で)
xset s off       # スクリーンセーバーを無効化
xset -dpms       # DPMS (ディスプレイ省電力) を無効化
xset q           # 現在の設定を確認
```

現在の設定確認:

```
Screen Saver:
  prefer blanking:  no    interval:  0    timeout:  0
DPMS (Energy Star):
  Standby: 0    Suspend: 0    Off: 0
  DPMS is Disabled
```

`DPMS is Disabled` と `timeout: 0` になっていれば正常です。

### 6.3 Wayland 環境での補完設定

Wayland では `xset` は使用できません。  
コンポジタの idle inhibit 機能が `powerSaveBlocker` 経由で制御されます。  
GNOME の場合は追加で設定が必要な場合があります:

```bash
# 実機で要実行 (GNOME + Wayland の場合)
gsettings set org.gnome.desktop.session idle-delay 0
gsettings set org.gnome.settings-daemon.plugins.power sleep-inactive-ac-timeout 0
```

### 6.4 Pi4 の電源設定 (OS レベル)

```bash
# 実機で要実行
# /etc/lightdm/lightdm.conf または Xsession で設定
# (lightdm 使用時)
grep -r "xserver-command" /etc/lightdm/ || echo "設定なし"

# lightdm.conf の [SeatDefaults] セクションに以下を追加:
# xserver-command=X -s 0 -dpms
```

---

## 7. 手動検証チェックリスト

**注意: 以下の全項目は実機 (Raspberry Pi 4) で実際に動作確認が必要です。**  
自動テスト (Vitest / Playwright) で代替できない項目を列挙します。

---

### [CHK-01] 起動時に枠なし全画面でサイネージ URL が内部表示される

対応テスト: E2E-07 / M-01

**手順:**
1. 設定パネルで `siteUrl` に実際のサイネージ URL (X-Frame-Options 付き) を設定する
2. アプリを再起動する (`systemctl --user restart signage-overlay`)
3. 画面を観察する

**期待結果:**
- OS のタスクバー・ウィンドウ枠が表示されず、全画面でサイネージが表示される
- `X-Frame-Options: SAMEORIGIN` または `frame-ancestors 'none'` が付いたサイトであっても正常に表示される
- ヘッダー書き換えが siteView 専用 session にのみ適用されていることをログで確認する

---

### [CHK-02] 指定間隔ごとに広告が 1 回フェードイン割り込みする

対応テスト: E2E-01 / US-01 / US-06

**手順:**
1. 設定パネルで間隔を **1 分** に設定する (短縮確認用)
2. 動画フォルダに `.mp4` ファイルを 3 本置く
3. アプリを起動して 1 分以上待機する

**期待結果:**
- 1 分経過後にオーバーレイ動画がフェードイン → 動画 1 本再生 → フェードアウトする
- 下層のサイネージ画面に戻り、さらに 1 分後に次の動画が再生される
- 動画再生中に次の間隔が到来しても二重発火しない (多重発火スキップ)
- 広告終了時刻から interval 後に次の広告が発火する (再生完了起点計時)

---

### [CHK-03] フェードイン/アウトで黒チラなし

対応テスト: T08 / UO-06 / M-03

**手順:**
1. 間隔 1 分で動作させ、広告が 50 回以上フェードインするのを観察する
2. フェードイン時 (動画が出現するタイミング) を注視する
3. フェードアウト時 (動画が消えるタイミング) を注視する

**期待結果:**
- フェードイン時・フェードアウト時のどちらでも黒いフレームが一瞬も挟まらない
- 下層のサイネージが透けて見えたまま動画の透明度が変化する
- `requestVideoFrameCallback` で最初のフレーム描画確認後に `setVisible(true)` しているため黒フラッシュは発生しない

---

### [CHK-04] Pi4 で HW デコードが有効・カクつきなし

対応テスト: T09 / M-02

**手順:**
1. `vainfo` コマンドで VA-API デコーダを確認する
2. 1080p/30fps の MP4 を再生して CPU 使用率・温度・フレームレートを計測する

```bash
# 実機で要実行
vainfo 2>/dev/null | grep -E "VA-API|H264"
top -b -n 3 | grep -E "ubuntuapp|AppImage"
vcgencmd measure_temp
```

**期待結果 (Pi4 受け入れ閾値):**
- フレームレート: 30fps 以上を維持
- CPU 使用率: 4 コア合計で 80% 以下
- 温度: 80°C 以下 (`vcgencmd measure_temp`)
- プロセス合計メモリ: 512MB 以内

HW デコードが使えない場合はソフトデコードにフォールバックして継続動作します。  
結果を `docs/pi4-verification.md` に記録してください。

---

### [CHK-05] Ctrl+G と隅 3 タップの両方でパネルが開閉する

対応テスト: E2E-06 / E2E-13 / M-10

**手順 (X11 環境):**
1. アプリ起動後、`Ctrl+G` を押す
2. 設定パネルが開くことを確認する
3. 再度 `Ctrl+G` を押してパネルが閉じることを確認する (トグル動作)
4. 画面の隅 (任意の角) を 1.5 秒以内に 3 回タップして設定パネルが開くことを確認する
5. 再度 3 タップでパネルが閉じることを確認する

**手順 (Wayland 環境):**
1. `Ctrl+G` が動作しないことを確認する (Wayland 既知制約)
2. ログに `globalShortcut スキップ` の記録があることを確認する
3. 画面の隅を 1.5 秒以内に 3 回タップしてパネルが開くことを確認する

**期待結果:**
- X11: Ctrl+G と隅 3 タップの両方が動作する
- Wayland: 隅 3 タップのみが動作する (Ctrl+G は非対応・これは既知の制約)
- どちらの方法でも多重起動 (パネルが二重に開く) しない
- 普段はパネルが非表示であることを確認する

---

### [CHK-06] フォルダに MP4 を置くと次回発火から自動反映される

対応テスト: UW-01 / M-08

**手順:**
1. 動画フォルダを空にしてアプリを起動する
2. 広告が発火しないことを確認する
3. 実行中に動画フォルダへ `clip-001.mp4` をコピーする
4. 次の間隔経過後に広告が発火することを確認する
5. 大容量 MP4 (100MB 以上) を コピー中の状態で間隔が経過する → コピー完了まで採用されないことを確認する

**期待結果:**
- ファイル追加後、次回の発火から自動的に新しい動画が再生対象に含まれる
- コピー途中 (`awaitWriteFinish` の stabilityThreshold 未達) では採用されない

---

### [CHK-07] 動画が常時ミュートで再生される

対応テスト: UO-01 / E2E-02

**手順:**
1. 音声付き MP4 を動画フォルダに置く
2. 広告が発火して動画が再生されるのを観察する

**期待結果:**
- 動画再生中に音声が一切出力されない
- `<video muted>` 属性が設定されており、volume 変更 IPC も存在しない

---

### [CHK-08] ループ ON/OFF・間隔設定が再起動後も維持される

対応テスト: E2E-05 / E2E-10

**手順 (ループ OFF の永続化):**
1. 設定パネルでループを OFF にする
2. アプリを再起動する (`systemctl --user restart signage-overlay`)
3. 30 分間待機する

**期待結果:**
- 再起動後もループ OFF 設定が維持され、広告が発火しない

**手順 (間隔変更の永続化):**
1. 設定パネルで間隔を 15 分に変更する
2. アプリを再起動する
3. 15 分後に広告が発火することを確認する

**期待結果:**
- 再起動後も 15 分間隔が維持される

---

### [CHK-09] 異常状態でもアプリが停止しない

対応テスト: UT-01〜05 / UT-07〜10 / UT-13 / E2E-11 / E2E-12

以下の各シナリオで **アプリが停止せず継続動作** することと、**ログに痕跡が残る** ことを確認する。

```bash
# ログ確認コマンド (実機で要実行)
journalctl --user -u signage-overlay -f
# ERROR・WARN 両方を含めて確認する（siteView.loadFailed は WARN レベル）
journalctl --user -u signage-overlay | grep -E '"level":"(ERROR|WARN)"'
```

| シナリオ | 注入方法 | 期待ログ | 期待動作 |
|---------|---------|---------|---------|
| 空フォルダ | 動画フォルダを空にする | `WARN playlist.empty` | 広告スキップ・サイネージ継続 |
| 破損 MP4 | 0 バイトファイルを置く | `ERROR overlay.videoError` | 広告スキップ・次回は正常 |
| パス不正 | 存在しないパスを設定 | `ERROR playlist.loadFailed` | 空リスト・クラッシュなし |
| 設定 JSON 破損 | `config.json` を壊して起動 | `ERROR config.corrupt` | `.corrupt` 退避・デフォルト起動 |
| ネット断 | Wi-Fi オフ | `WARN siteView.loadFailed` | バックオフ再試行・広告層は継続 |
| フォルダ監視中にフォルダ削除 | `rmdir` で監視フォルダ削除 | `ERROR watcher.folderGone` | 空リスト更新・クラッシュなし |

---

### [CHK-10] 自動起動・クラッシュ復帰・スリープ抑止・24h 連続稼働

対応テスト: M-04 / M-05 / M-06 / UT-20

**自動起動の確認:**
1. Pi4 を再起動する
2. ログインなしで (または自動ログイン後に) アプリが自動起動することを確認する

```bash
# 実機で要実行
sudo reboot
# 再起動後
journalctl --user -u signage-overlay --since "today" | head -20
systemctl --user status signage-overlay
```

**クラッシュ復帰 (5 秒以内) の確認:**
1. アプリのプロセス ID を確認する
2. `kill -9 <PID>` でプロセスを強制終了する
3. 5 秒以内に systemd が再起動することを確認する

```bash
# 実機で要実行
systemctl --user status signage-overlay | grep PID
kill -9 <AppImage-PID>
# 5 秒待機後
systemctl --user status signage-overlay
```

**スリープ抑止 (30 分) の確認:**
1. アプリ起動中に 30 分間放置する
2. スクリーンセーバー・ディスプレイスリープが発動しないことを確認する

**24h 連続稼働の確認:**
1. 間隔 1 分で動作させながら 24h 以上放置する
2. 以下を確認する:

```bash
# 実機で要実行
# メモリ使用量 (512MB 以内であること)
ps aux | grep -E "AppImage|ubuntuapp" | awk '{sum += $6} END {print sum/1024 "MB"}'

# IPC ハンドラ蓄積なし・クラッシュなし
journalctl --user -u signage-overlay --since "24 hours ago" | grep -E "ERROR|WARN|crash"

# 継続動作の確認
systemctl --user status signage-overlay
```

**連続クラッシュ (start-limit) の確認:**
1. 60 秒以内に 6 回クラッシュさせる (start-limit 超過テスト)
2. journald で start-limit に達したことを確認する

```bash
# 実機で要実行
journalctl --user -u signage-overlay | grep -E "Start request repeated|start-limit"
# 手動復旧
systemctl --user reset-failed signage-overlay
systemctl --user start signage-overlay
```

---

### [CHK-11] シングルインスタンスガード

対応テスト: M-11

**手順:**
1. アプリが起動中の状態で同じ AppImage を再度実行する
2. 2 番目のプロセスの動作を確認する

```bash
# 実機で要実行
~/ubuntuapp-0.1.0-arm64.AppImage &
~/ubuntuapp-0.1.0-arm64.AppImage  # 2番目の起動
```

**期待結果:**
- 2 番目のプロセスは起動せずに終了する
- 既存インスタンスのウィンドウがフォーカスされる
- `app.requestSingleInstanceLock()` が機能している

---

*このドキュメントのコマンドはすべて実際の npm スクリプト (`package.json` の `scripts` セクション) または標準 Linux コマンドを使用しています。存在しないスクリプトは参照していません。*

*チェックリスト項目数: 11 項目 (CHK-01 〜 CHK-11)*
