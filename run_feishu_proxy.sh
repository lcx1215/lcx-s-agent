#!/usr/bin/env bash
set -euo pipefail

export PATH="/opt/homebrew/bin:/Users/liuchengxu/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
export LANG="${LANG:-en_US.UTF-8}"
export LC_ALL="${LC_ALL:-en_US.UTF-8}"
export PYTHONIOENCODING="${PYTHONIOENCODING:-utf-8}"

ROOT="/Users/liuchengxu/Projects/openclaw"
ENV_FILE="$ROOT/.env.lobster"
PY="$(command -v python3)"

if [[ -f "$ENV_FILE" ]]; then
  set -a
  source "$ENV_FILE"
  set +a
fi

export OPENCLAW_BIN="/Users/liuchengxu/Projects/openclaw/send_feishu_reply.sh"

exec "$PY" "$ROOT/feishu_event_proxy.py"
