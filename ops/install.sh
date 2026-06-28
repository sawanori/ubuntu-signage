#!/usr/bin/env bash
# install.sh — signage-overlay systemd --user ユニットのインストールと有効化
#
# 使い方:
#   bash ops/install.sh /path/to/ubuntuapp.AppImage
#
# 引数:
#   $1  インストール先の AppImage フルパス（必須）
#
# 処理内容:
#   1. systemd --user ユニットファイルを ~/.config/systemd/user/ へ配置
#   2. ExecStart と DISPLAY/XDG_RUNTIME_DIR を現在の実行環境に合わせて書き換え
#   3. systemctl --user daemon-reload && enable
#   4. loginctl enable-linger でログアウト後も自動起動を維持
#   5. .desktop autostart フォールバックを ~/.config/autostart/ へ配置

set -euo pipefail

# ─────────────────────────────────────────────────────────────────────────────
# 引数チェック
# ─────────────────────────────────────────────────────────────────────────────
if [[ $# -lt 1 ]]; then
  echo "使い方: bash ops/install.sh /path/to/ubuntuapp.AppImage" >&2
  exit 1
fi

APPIMAGE_PATH="$(realpath "$1")"

if [[ ! -f "${APPIMAGE_PATH}" ]]; then
  echo "エラー: AppImage が見つかりません: ${APPIMAGE_PATH}" >&2
  exit 1
fi

if [[ ! -x "${APPIMAGE_PATH}" ]]; then
  chmod +x "${APPIMAGE_PATH}"
  echo "AppImage に実行権限を付与しました: ${APPIMAGE_PATH}"
fi

# ─────────────────────────────────────────────────────────────────────────────
# 変数
# ─────────────────────────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
UNIT_SRC="${SCRIPT_DIR}/signage-overlay.service"
DESKTOP_SRC="${SCRIPT_DIR}/signage-overlay.desktop"

SYSTEMD_USER_DIR="${HOME}/.config/systemd/user"
AUTOSTART_DIR="${HOME}/.config/autostart"
UNIT_DEST="${SYSTEMD_USER_DIR}/signage-overlay.service"
DESKTOP_DEST="${AUTOSTART_DIR}/signage-overlay.desktop"

# XDG_RUNTIME_DIR が未設定の場合は UID から導出
XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"

# DISPLAY が未設定の場合は :0 をデフォルトに
DISPLAY="${DISPLAY:-:0}"

# ─────────────────────────────────────────────────────────────────────────────
# systemd --user ユニットのインストール
# ─────────────────────────────────────────────────────────────────────────────
echo "--- systemd --user ユニットのインストール ---"
mkdir -p "${SYSTEMD_USER_DIR}"
cp "${UNIT_SRC}" "${UNIT_DEST}"

# ExecStart・環境変数をこの環境の値に書き換え
sed -i "s|ExecStart=.*|ExecStart=${APPIMAGE_PATH}|" "${UNIT_DEST}"
sed -i "s|Environment=DISPLAY=.*|Environment=DISPLAY=${DISPLAY}|" "${UNIT_DEST}"
sed -i "s|Environment=XDG_RUNTIME_DIR=.*|Environment=XDG_RUNTIME_DIR=${XDG_RUNTIME_DIR}|" "${UNIT_DEST}"

echo "ユニットファイルを配置しました: ${UNIT_DEST}"

# daemon-reload して enable
systemctl --user daemon-reload
systemctl --user enable signage-overlay.service
echo "signage-overlay.service を有効化しました"

# ─────────────────────────────────────────────────────────────────────────────
# linger の有効化（ログアウト後もセッション継続）
# ─────────────────────────────────────────────────────────────────────────────
echo "--- loginctl enable-linger ---"
loginctl enable-linger "${USER}"
echo "linger を有効化しました（ログアウト後も自動起動が維持されます）"

# ─────────────────────────────────────────────────────────────────────────────
# .desktop autostart フォールバック
# ─────────────────────────────────────────────────────────────────────────────
echo "--- .desktop autostart フォールバックのインストール ---"
mkdir -p "${AUTOSTART_DIR}"
cp "${DESKTOP_SRC}" "${DESKTOP_DEST}"
sed -i "s|Exec=.*|Exec=${APPIMAGE_PATH}|" "${DESKTOP_DEST}"
echo ".desktop ファイルを配置しました: ${DESKTOP_DEST}"

# ─────────────────────────────────────────────────────────────────────────────
# 完了メッセージ
# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "=== インストール完了 ==="
echo "AppImage    : ${APPIMAGE_PATH}"
echo "Unit        : ${UNIT_DEST}"
echo "Autostart   : ${DESKTOP_DEST}"
echo ""
echo "今すぐ起動する場合:"
echo "  systemctl --user start signage-overlay"
echo ""
echo "ログ確認:"
echo "  journalctl --user -u signage-overlay -f"
echo ""
echo "連続クラッシュ後の手動復旧:"
echo "  systemctl --user reset-failed signage-overlay && systemctl --user start signage-overlay"
