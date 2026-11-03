#!/usr/bin/env bash
# Linux: run in a terminal, or choose "Run in Terminal" in the file manager.
project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)" || exit 1
bash "$project_root/source/scripts/tools/with-local-tools.sh" node "$project_root/source/scripts/start/launch.cjs"
result=$?
if [ "$result" -ne 0 ] && [ -t 0 ]; then
  printf '\nStartup failed. Check the messages above. Press Enter to close…'
  read -r _
fi
exit "$result"
