#!/usr/bin/env bash
set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
export PATH="$project_root/../.tools/node/bin:$project_root/../.tools/ffmpeg-native/bin:$project_root/../.tools/ffmpeg:$project_root/../.tools/gpac-package/tmppkg.pkg/Payload/GPAC.app/Contents/MacOS:$PATH"

exec "$@"
