# Pi4 実機検証記録

このドキュメントは Raspberry Pi 4 での実機動作確認フォームです。  
各フィールドを実際にテストして記入し、合否判定を記録してください。

---

## メタ情報

| 項目 | 値 |
|------|----|
| 確認日 | |
| Pi4 OS | (例: Raspberry Pi OS 64bit Bookworm) |
| アーキテクチャ | (例: aarch64) |
| Electron バージョン | (例: 35.7.5) |
| git コミット | (例: abc1234) |
| ビルド機 OS | (例: Ubuntu 22.04 x86_64) |

---

## セッション / 環境変数

実機で以下のコマンドを実行して実際の値を記入してください。

```bash
echo "XDG_SESSION_TYPE=$XDG_SESSION_TYPE"
echo "WAYLAND_DISPLAY=$WAYLAND_DISPLAY"
echo "XDG_RUNTIME_DIR=$XDG_RUNTIME_DIR"
echo "DISPLAY=$DISPLAY"
```

| 変数 | 実測値 |
|------|--------|
| `XDG_SESSION_TYPE` | |
| `WAYLAND_DISPLAY` | |
| `XDG_RUNTIME_DIR` | |
| `DISPLAY` | |
| セッション種別 | X11 / Wayland (どちらかを記入) |
| Ctrl+G 実挙動 | (例: 動作 / 動作しない (Wayland 既知制約)) |

---

## #5 deb クロスビルド結果

```bash
# ビルド機で実行
npm run build:linux-arm64
ls -lh release/
```

| 成果物 | 生成確認 | ファイルサイズ |
|--------|---------|--------------|
| `*.AppImage` | 成功 / 失敗 | |
| `*.deb` | 成功 / 失敗 | |
| ビルドエラー内容 | | |

---

## CHK-04 HW デコード検証 (VaapiVideoDecoder)

### 事前確認

```bash
# VA-API 対応確認
vainfo 2>/dev/null | grep -E "VA-API|H264"
```

VA-API 結果:

```
(ここに実行結果を貼り付け)
```

### 計測 (1080p/30fps MP4 再生中に計測)

```bash
# CPU 使用率
top -b -n 3 | grep -E "ubuntuapp|AppImage"

# 温度（Ubuntu 標準コマンド）
awk '{printf "%.1f°C\n",$1/1000}' /sys/class/thermal/thermal_zone0/temp 2>/dev/null || echo "N/A"
# ※ Pi4 固有の GPU 温度が必要な場合: sudo apt install libraspberrypi-bin してから vcgencmd measure_temp

# メモリ使用量
ps aux | grep -E "AppImage|ubuntuapp" | awk '{sum += $6} END {print sum/1024 "MB"}'
```

| 計測項目 | 実測値 | 閾値 | 合否 |
|---------|--------|------|------|
| フレームレート (fps) | | 30fps 以上 | |
| CPU 使用率 (4コア合計) | | 80% 以下 | |
| 温度 | | 80°C 以下 | |
| メモリ使用量 | | 512MB 以下 | |

**CHK-04 最終判定:**  
[ ] PASS / [ ] FAIL  
備考:

---

## ★CHK-03 透過合成 (黒チラなし)

**手順:** 間隔 1 分で動作させ、広告が 50 回以上フェードインするのを観察する。

| 観察回数 | 黒フリッカー発生 |
|---------|----------------|
| 50 回 | あり / なし |

**CHK-03 最終判定:**  
[ ] PASS (50 回黒チラなし) / [ ] FAIL  
備考:

---

## ★CHK-05 globalShortcut (X11/Wayland)

| テスト | X11 結果 | Wayland 結果 |
|--------|---------|-------------|
| Ctrl+G でパネル開閉 | 動作 / 動作しない | (Wayland 非対応・既知制約) |
| 隅 3 タップでパネル開閉 | 動作 / 動作しない | 動作 / 動作しない |
| 多重起動なし | 確認 / 未確認 | 確認 / 未確認 |

**CHK-05 最終判定:**  
[ ] PASS / [ ] FAIL  
備考:

---

## ★CHK-10 24h 連続稼働

| 確認項目 | 結果 |
|---------|------|
| 開始日時 | |
| 終了日時 | |
| 経過時間 | |
| メモリ使用量 (終了時) | |
| ERROR ログ件数 | |
| WARN ログ件数 | |
| クラッシュ / systemd 再起動 件数 | |

```bash
# 実機で要実行
journalctl --user -u signage-overlay --since "24 hours ago" | grep -E '"level":"(ERROR|WARN)"' | wc -l
ps aux | grep -E "AppImage|ubuntuapp" | awk '{sum += $6} END {print sum/1024 "MB"}'
```

**CHK-10 最終判定:**  
[ ] PASS / [ ] FAIL  
備考:

---

## CHK-12 オーバーレイ マウスパススルー

**手順:** 広告動画再生中に下層サイネージ上でマウスをクリック・ドラッグする。

| テスト | 結果 |
|--------|------|
| 動画再生中のマウス操作が下層サイト に届く | あり / なし |
| pointer-events: none が overlay に効いている | 確認 / 未確認 |

**CHK-12 最終判定:**  
[ ] PASS / [ ] FAIL  
備考:

---

## CHK-13 アドレスバー (Phase E)

**手順:** 画面上部中央ゾーンをタップしてアドレスバーを表示し、URL を入力して遷移確認。

| テスト | 結果 |
|--------|------|
| アドレスバーが表示される | あり / なし |
| URL 入力後に Enter でナビゲート | 動作 / 動作しない |
| 許可外 URL が拒否される | 確認 / 未確認 |
| バー外クリックでバー非表示 | 確認 / 未確認 |

**CHK-13 最終判定:**  
[ ] PASS / [ ] FAIL  
備考:

---

## CHK-14 ホットスポット 隅 3 タップ

> **CHK-05 に統合済み。** DEPLOY-AND-VERIFY.md の CHK-05「隅 3 タップの誤発火確認」を参照。
> 実機結果は CHK-05 の備考欄に記録してください。

**CHK-14 最終判定:** CHK-05 に統合 → CHK-05 の判定を参照

---

## 総合判定

| CHK | 判定 |
|-----|------|
| CHK-04 HW デコード | PASS / FAIL / SKIP |
| CHK-03 透過合成 | PASS / FAIL / SKIP |
| CHK-05 globalShortcut | PASS / FAIL / SKIP |
| CHK-10 24h 稼働 | PASS / FAIL / SKIP |
| CHK-12 マウスパススルー | PASS / FAIL / SKIP |
| CHK-13 アドレスバー | PASS / FAIL / SKIP |
| CHK-14 隅 3 タップ | PASS / FAIL / SKIP |
| #5 deb クロスビルド | PASS / FAIL / SKIP |

**総合結果:** PASS / FAIL / 一部保留  
**次のアクション:**
