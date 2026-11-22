#!/usr/bin/env bash
set -euo pipefail
exec /usr/bin/python3 -I -B "$(dirname -- "$0")/host-staging.py" "$@"
