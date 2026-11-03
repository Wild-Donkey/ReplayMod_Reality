#!/usr/bin/env bash
# macOS: double-click to build and install for the current user.
set -euo pipefail
project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if ! bash "$project_root/source/scripts/tools/with-local-tools.sh" node "$project_root/source/scripts/packaging/install-macos.cjs"; then
  printf '\n打包或安装失败，请检查上方信息。按回车关闭…'
  read -r _
  exit 1
fi
