#!/bin/bash
set -euo pipefail

# Only this application's copied bundle is touched. No global Gatekeeper setting changes.
source_dir="$(cd "$(dirname "$0")" && pwd)"
source_app="$source_dir/Wire DeepSeek.app"
target_dir="$HOME/Applications"
launch=1
while [ "$#" -gt 0 ]; do
  case "$1" in
    --source) source_app="$2"; shift 2 ;;
    --target) target_dir="$2"; shift 2 ;;
    --no-launch) launch=0; shift ;;
    *) printf '未知参数：%s\n' "$1" >&2; exit 1 ;;
  esac
done

if [ ! -d "$source_app/Contents" ]; then
  printf '找不到应用：%s\n请从 DMG 内运行此脚本，或使用 --source 指定 .app。\n' "$source_app" >&2
  exit 1
fi
if /usr/bin/pgrep -x 'Wire DeepSeek' >/dev/null 2>&1; then
  printf '请先从菜单栏退出 Wire DeepSeek，再运行安装脚本。\n' >&2
  exit 1
fi

mkdir -p "$target_dir"
target_app="$target_dir/Wire DeepSeek.app"
staging_app="$target_dir/.Wire-DeepSeek-install-$$.app"
trap 'if [ -d "$staging_app" ]; then /bin/rm -rf "$staging_app"; fi' EXIT
/usr/bin/ditto "$source_app" "$staging_app"
/usr/bin/codesign --verify --deep --strict "$staging_app"
/usr/bin/xattr -dr com.apple.quarantine "$staging_app"
if [ -d "$target_app" ]; then
  backup_app="$target_dir/Wire DeepSeek.backup-$(date +%Y%m%d-%H%M%S).app"
  /bin/mv "$target_app" "$backup_app"
  printf '旧版本保留在：%s\n' "$backup_app"
fi
/bin/mv "$staging_app" "$target_app"
printf '安装完成：%s\n' "$target_app"
if [ "$launch" -eq 1 ]; then /usr/bin/open "$target_app"; fi
