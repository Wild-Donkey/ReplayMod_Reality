#!/usr/bin/env bash
# macOS: double-click in Finder.
project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)" || exit 1
bash "$project_root/scripts/tools/with-local-tools.sh" node "$project_root/scripts/start/launch.cjs"
result=$?
if [ "$result" -ne 0 ]; then
  printf '\n启动失败。请检查上方信息；首次运行需要 Node.js、npm 和网络。\n按回车关闭…'
  read -r _
fi
exit "$result"
