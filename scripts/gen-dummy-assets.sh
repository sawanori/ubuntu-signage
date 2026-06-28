#!/usr/bin/env bash
# gen-dummy-assets.sh
# T04: 開発用ダミー MP4 資産を生成する
#
# 生成物:
#   assets/dev/clip-001.mp4 〜 clip-003.mp4  H.264/1080p/yuv420p/faststart/無音/5〜7秒
#   assets/dev/clip-broken.mp4               破損 MP4（ランダムバイト列・異常系テスト用）
#   assets/dev/clip-large.mp4               大容量 MP4（CRF=0・awaitWriteFinish 検証用）
#
# 前提: ffmpeg がインストール済み (which ffmpeg で確認)
# 実行: bash scripts/gen-dummy-assets.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT_DIR="${SCRIPT_DIR}/../assets/dev"

mkdir -p "${OUT_DIR}"

echo "=== ダミー資産生成開始 ==="
echo "出力先: ${OUT_DIR}"
echo "ffmpeg: $(which ffmpeg)"
echo ""

# ─────────────────────────────────────────────────────────────────────────────
# 共通 ffmpeg オプション
# -g 30 -keyint_min 30 -x264-params "open-gop=0"  → closed-GOP
# -movflags +faststart                              → Web 再生最適化
# -pix_fmt yuv420p                                  → H.264/yuv420p
# -an                                               → 無音
# ─────────────────────────────────────────────────────────────────────────────

# clip-001.mp4 — 青・5秒・"clip-001" テキスト入り
echo "生成中: clip-001.mp4 (blue, 5s)"
ffmpeg -y \
  -f lavfi -i "color=c=0x0000CC:size=1920x1080:rate=30" \
  -vf "drawtext=text='clip-001':fontsize=120:fontcolor=white:x=(w-text_w)/2:y=(h-text_h)/2" \
  -t 5 \
  -c:v libx264 -pix_fmt yuv420p -movflags +faststart \
  -g 30 -keyint_min 30 -x264-params "open-gop=0" \
  -an \
  "${OUT_DIR}/clip-001.mp4" 2>&1 | tail -2
echo "  → $(du -h "${OUT_DIR}/clip-001.mp4" | cut -f1)"

# clip-002.mp4 — 赤・6秒
echo "生成中: clip-002.mp4 (red, 6s)"
ffmpeg -y \
  -f lavfi -i "color=c=0xCC0000:size=1920x1080:rate=30" \
  -vf "drawtext=text='clip-002':fontsize=120:fontcolor=white:x=(w-text_w)/2:y=(h-text_h)/2" \
  -t 6 \
  -c:v libx264 -pix_fmt yuv420p -movflags +faststart \
  -g 30 -keyint_min 30 -x264-params "open-gop=0" \
  -an \
  "${OUT_DIR}/clip-002.mp4" 2>&1 | tail -2
echo "  → $(du -h "${OUT_DIR}/clip-002.mp4" | cut -f1)"

# clip-003.mp4 — 緑・7秒
echo "生成中: clip-003.mp4 (green, 7s)"
ffmpeg -y \
  -f lavfi -i "color=c=0x006400:size=1920x1080:rate=30" \
  -vf "drawtext=text='clip-003':fontsize=120:fontcolor=white:x=(w-text_w)/2:y=(h-text_h)/2" \
  -t 7 \
  -c:v libx264 -pix_fmt yuv420p -movflags +faststart \
  -g 30 -keyint_min 30 -x264-params "open-gop=0" \
  -an \
  "${OUT_DIR}/clip-003.mp4" 2>&1 | tail -2
echo "  → $(du -h "${OUT_DIR}/clip-003.mp4" | cut -f1)"

# ─────────────────────────────────────────────────────────────────────────────
# clip-broken.mp4 — 破損ファイル（異常系テスト用）
# ランダムバイト列で有効な MP4 ヘッダーを持たない
# ─────────────────────────────────────────────────────────────────────────────

echo "生成中: clip-broken.mp4 (ランダムバイト列・破損)"
dd if=/dev/urandom of="${OUT_DIR}/clip-broken.mp4" bs=1024 count=64 2>/dev/null
echo "  → $(du -h "${OUT_DIR}/clip-broken.mp4" | cut -f1) (破損・異常系テスト用)"

# ─────────────────────────────────────────────────────────────────────────────
# clip-large.mp4 — 大容量 MP4（awaitWriteFinish 検証用）
# CRF=0 (ほぼロスレス) で高ビットレートのファイルを生成
# 1080p 8秒 CRF=0 ≈ 数百 MB (chokidar awaitWriteFinish のテストに使用)
# ─────────────────────────────────────────────────────────────────────────────

echo "生成中: clip-large.mp4 (CRF=0 + ノイズソース 約200MB・awaitWriteFinish テスト用)"
# ランダムノイズを CRF=0 で圧縮することで 200MB 相当のファイルを生成する
# 単色 (CRF=0) では高効率に圧縮されてしまうためノイズ系入力を使用
ffmpeg -y \
  -f lavfi -i "nullsrc=size=1920x1080:rate=30,hue=s=0,geq=random(1)*255:128:128" \
  -t 2.5 \
  -c:v libx264 -pix_fmt yuv420p -movflags +faststart \
  -g 30 -keyint_min 30 -x264-params "open-gop=0" \
  -crf 0 \
  -an \
  "${OUT_DIR}/clip-large.mp4" 2>&1 | tail -2
echo "  → $(du -h "${OUT_DIR}/clip-large.mp4" | cut -f1)"

# ─────────────────────────────────────────────────────────────────────────────
# ffprobe 検証
# ─────────────────────────────────────────────────────────────────────────────

echo ""
echo "=== ffprobe 検証 ==="

for f in clip-001.mp4 clip-002.mp4 clip-003.mp4 clip-large.mp4; do
  echo "--- ${f} ---"
  ffprobe -v quiet -select_streams v:0 \
    -show_entries "stream=codec_name,pix_fmt,width,height,r_frame_rate" \
    -of default=noprint_wrappers=1 \
    "${OUT_DIR}/${f}"
  echo ""
done

echo "--- clip-broken.mp4 (破損ファイル・ffprobe エラーが正常) ---"
ffprobe -v error "${OUT_DIR}/clip-broken.mp4" 2>&1 | head -3 || true
echo ""

echo "=== 生成完了 ==="
ls -lh "${OUT_DIR}"/*.mp4
