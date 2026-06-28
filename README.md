# ubuntuapp — デジタルサイネージ オーバーレイ

Raspberry Pi 4 向けの Electron 製デジタルサイネージアプリ。  
5 層 `WebContentsView` 構成で外部サイネージサイトの上に広告動画をオーバーレイ表示する。

---

## クイックスタート（Ubuntu Desktop・手動運用）

> **動作確認済み**: Ubuntu 22.04 / 24.04 で `apt install` およびファイルマネージャからのダブルクリックインストールが成功し、依存（libgbm1 / libasound2 / libcups2 等）が自動解決・`ldd` で共有ライブラリ欠落ゼロを確認。**libfuse2 は deb 経路では不要。**

### 初回セットアップ（1 回だけ）

1. deb をファイルマネージャで **ダブルクリック**（または端末で `sudo apt install ./ubuntuapp_0.1.0_arm64.deb`。x86 機は `_amd64.deb`）→ インストール完了。依存は自動解決され、アプリメニューに「ubuntuapp」アイコンが登録される。**libfuse2 は不要。**

2. 初回起動して設定（どちらかの方法で）:
   - アプリ起動後、**画面の隅を 1.5 秒以内に 3 回タップ**で設定パネルを開き → `siteUrl` / 動画フォルダ / 間隔 を設定する
   - または `~/.config/ubuntuapp/config.json` を直接編集（`siteUrl` / `videoFolderPath`（**絶対パス・直下の mp4 のみ**）/ `intervalMinutes` / `loopEnabled`）

3. 表示したい動画（mp4）を `videoFolderPath` に指定したフォルダに置く。

### 毎日の運用（担当者）

- **朝**: 機器を起動・ログイン → アプリメニューの **「ubuntuapp」アイコンをダブルクリック** → 全画面でサイネージ表示（背景に指定サイト＋一定間隔で動画オーバーレイ）
- **終了**: **Ctrl+Q**（修正済み: Wayland でも有効）／効かない環境では**画面の隅を 1.5 秒以内に 3 回タップ → 設定パネル → 「終了」ボタン**／または電源 OFF
- 画面スリープはアプリ稼働中に内部の `powerSaveBlocker` が自動的に抑止するため、追加設定は不要

### コンテンツ更新

- **動画**: フォルダに mp4 を追加 / 削除（次回の再生から自動反映）
- **表示サイト**: 設定パネル（隅 3 タップ）で変更

> **補足**: 無人 24h 自動起動（電源 ON でサイネージが自動的に起動する運用）が将来必要になった場合のみ、`ops/install.sh` による systemd 自動起動の配線が使える（手動運用には不要）。詳細は `docs/DEPLOY-AND-VERIFY.md` §5 参照。

---

## 必要環境

| 項目 | 要件 |
|------|------|
| ハードウェア | Raspberry Pi 4 Model B (4GB 以上推奨) |
| OS | **Ubuntu Desktop 24.04**（Pi4: arm64 / x86 機: amd64） |
| アーキテクチャ | Pi4: arm64 (aarch64) / x86 機: amd64 |
| libfuse2 | deb 経路では**不要**。AppImage 経路（無人 kiosk 運用）では `sudo apt-get install -y libfuse2` |
| Node.js | v20 LTS 以上 (ビルド機のみ。Pi4 での Node.js インストール不要) |

---

## ビルド

```bash
# 依存パッケージのインストール
npm install

# TypeScript のみビルド (確認用)
npm run build

# arm64 AppImage + deb のパッケージング
npm run build:linux-arm64
```

成果物は `release/` に出力される:

```
release/
  ubuntuapp-0.1.0-arm64.AppImage
  ubuntuapp_0.1.0_arm64.deb
```

---

## デプロイ（AppImage 経路・無人 kiosk 運用向け）

> **手動運用の場合は「クイックスタート」セクションを参照してください。** 以下は AppImage + systemd による 24h 無人 kiosk 運用向けの手順です。

```bash
# 1. AppImage を対象機へ転送（<user>/<host> は実際のユーザー名・ホスト名に置換）
scp release/ubuntuapp-0.1.0-arm64.AppImage <user>@<host>:~/

# 2. 対象機で libfuse2 をインストール (Ubuntu・AppImage 経路・初回のみ)
ssh <user>@<host> "sudo apt-get install -y libfuse2"

# 3. install.sh でシステムに登録（プリフライト検査・systemd unit 有効化・XDG autostart 設置）
ssh <user>@<host>
bash ops/install.sh ~/ubuntuapp-0.1.0-arm64.AppImage

# 4. 手動起動確認
systemctl --user start signage-overlay
journalctl --user -u signage-overlay -f
```

詳細手順: `docs/DEPLOY-AND-VERIFY.md`

---

## 設定

`~/.config/ubuntuapp/config.json` に保存される (electron-store):

```json
{
  "siteUrl": "https://your-signage-site.example.com",
  "videoFolderPath": "/home/<ユーザー名>/videos",
  "intervalMinutes": 5,
  "loopEnabled": true
}
```

> `videoFolderPath` には実在する絶対パスを指定してください（例: `/home/ubuntu/videos`）。設定パネルの「動画フォルダ選択」ボタンで GUI から指定するのが推奨です。

| キー | 説明 | 制約 |
|------|------|------|
| `siteUrl` | サイネージサイト URL | 空欄はスタート画面を表示 |
| `videoFolderPath` | 広告 MP4 フォルダの絶対パス | 直下の `.mp4` のみ対象 (サブディレクトリ非対応) |
| `intervalMinutes` | 広告割り込み間隔 | 1/5/10/15/30 分 |
| `loopEnabled` | 広告ループ有効/無効 | `true` / `false` |

設定パネルの開き方:
- **画面の隅を 1.5 秒以内に 3 回タップ** (Wayland/X11 共通・常設正規経路)
- `Ctrl+G` (X11 のみ・ベストエフォート)

---

## 検証

```bash
# 型チェック
npm run typecheck

# Lint
npm run lint

# ユニットテスト (Vitest)
npm test

# E2E テスト (Playwright - xvfb-run 内包済み)
npm run test:e2e
```

実機での動作確認手順: `docs/DEPLOY-AND-VERIFY.md` (CHK-01〜CHK-13)  
Pi4 実機記録フォーム: `docs/pi4-verification.md`

---

## ライセンス

Proprietary (社内用途専用・UNLICENSED)
