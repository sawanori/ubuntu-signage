# ubuntuapp — デジタルサイネージ オーバーレイ

Raspberry Pi 4 向けの Electron 製デジタルサイネージアプリ。  
5 層 `WebContentsView` 構成で外部サイネージサイトの上に広告動画をオーバーレイ表示する。

---

## 必要環境

| 項目 | 要件 |
|------|------|
| ハードウェア | Raspberry Pi 4 Model B (4GB 以上推奨) |
| OS | Raspberry Pi OS 64bit (Bookworm 相当) |
| アーキテクチャ | arm64 (aarch64) |
| libfuse2 | **必須** (Pi OS Bookworm は既定で fuse3 のみ。`sudo apt-get install -y libfuse2` で導入) |
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

## デプロイ

```bash
# 1. AppImage を Pi4 へ転送
scp release/ubuntuapp-0.1.0-arm64.AppImage pi@raspberrypi.local:~/

# 2. Pi4 で libfuse2 をインストール (Bookworm 初回のみ)
ssh pi@raspberrypi.local "sudo apt-get install -y libfuse2"

# 3. install.sh でシステムに登録（プリフライト検査・systemd unit 有効化・XDG autostart 設置）
ssh pi@raspberrypi.local
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
  "videoFolderPath": "/home/pi/videos",
  "intervalMinutes": 5,
  "loopEnabled": true
}
```

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
