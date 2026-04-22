#!/usr/bin/env bash
set -euo pipefail

export PATH="/opt/homebrew/bin:/Users/liuchengxu/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
export LANG="${LANG:-en_US.UTF-8}"
export LC_ALL="${LC_ALL:-en_US.UTF-8}"
export PYTHONIOENCODING="${PYTHONIOENCODING:-utf-8}"

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ROOT="${OPENCLAW_ROOT:-$SCRIPT_DIR}"
ENV_FILE="$ROOT/.env.lobster"
PY="$(command -v python3)"

if [[ -f "$ENV_FILE" ]]; then
  set -a
  source "$ENV_FILE"
  set +a
fi

export OPENCLAW_BIN="${OPENCLAW_REPLY_BIN:-$ROOT/send_feishu_reply.sh}"

exec "$PY" "$ROOT/feishu_event_proxy.py"
