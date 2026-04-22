#!/usr/bin/env bash
set -euo pipefail

export PATH="/opt/homebrew/bin:/Users/liuchengxu/.local/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
export LANG="${LANG:-en_US.UTF-8}"
export LC_ALL="${LC_ALL:-en_US.UTF-8}"
export PYTHONIOENCODING="${PYTHONIOENCODING:-utf-8}"

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ROOT="${OPENCLAW_ROOT:-$SCRIPT_DIR}"
ENV_FILE="$ROOT/.env.lobster"
BIN="${OPENCLAW_CLI_BIN:-}"

if [[ -z "$BIN" ]]; then
  BIN="$(command -v openclaw || true)"
fi

if [[ -z "$BIN" ]]; then
  for candidate in "$HOME/.local/bin/openclaw" "/opt/homebrew/bin/openclaw" "/usr/local/bin/openclaw"; do
    if [[ -x "$candidate" ]]; then
      BIN="$candidate"
      break
    fi
  done
fi

cd "$ROOT"

if [[ -f "$ENV_FILE" ]]; then
  set -a
  source "$ENV_FILE"
  set +a
fi

TARGET="${1:-}"
TEXT="${2:-}"

# 兼容只传一段文本
if [[ -n "${TARGET:-}" && -z "${TEXT:-}" ]]; then
  TEXT="$TARGET"
  TARGET="${FEISHU_CHAT_ID:-${OPENCLAW_TARGET:-}}"
fi

if [[ -z "${TARGET:-}" ]]; then
  TARGET="${FEISHU_CHAT_ID:-${OPENCLAW_TARGET:-}}"
fi

if [[ -z "${TEXT:-}" ]]; then
  echo '{"ok": false, "error": "missing text"}'
  exit 2
fi

if [[ -z "${TARGET:-}" ]]; then
  echo '{"ok": false, "error": "missing target"}'
  exit 2
fi

if [[ ! -x "$BIN" ]]; then
  echo "{\"ok\": false, \"error\": \"openclaw bin missing: $BIN\"}"
  exit 2
fi

exec "$BIN" message send --channel feishu --target "$TARGET" --message "$TEXT"
