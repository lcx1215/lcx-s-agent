#!/usr/bin/env bash
set -euo pipefail

ROOT="${OPENCLAW_ROOT:-$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)}"
LOG_DIR="$HOME/.openclaw/logs"
PLIST="$HOME/Library/LaunchAgents/ai.openclaw.feishu.proxy.plist"
LABEL="ai.openclaw.feishu.proxy"
UID_NUM="$(id -u)"

mkdir -p "$HOME/Library/LaunchAgents" "$LOG_DIR"

PYTHON_BIN="$(command -v python3 || true)"
if [[ -z "$PYTHON_BIN" ]]; then
  echo "ERROR: python3 not found on PATH" >&2
  exit 2
fi

PATH_JOINED="/opt/homebrew/bin:$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>$LABEL</string>

    <key>ProgramArguments</key>
    <array>
      <string>$PYTHON_BIN</string>
      <string>$ROOT/feishu_event_proxy.py</string>
    </array>

    <key>WorkingDirectory</key>
    <string>$ROOT</string>

    <key>RunAtLoad</key>
    <true/>

    <key>KeepAlive</key>
    <true/>

    <key>StandardOutPath</key>
    <string>$LOG_DIR/feishu_proxy.out.log</string>

    <key>StandardErrorPath</key>
    <string>$LOG_DIR/feishu_proxy.err.log</string>

    <key>EnvironmentVariables</key>
    <dict>
      <key>OPENCLAW_ROOT</key>
      <string>$ROOT</string>
      <key>LOBSTER_PROXY_PORT</key>
      <string>3011</string>
      <key>ORIGINAL_FEISHU_URL</key>
      <string>http://127.0.0.1:3000/feishu/events</string>
      <key>OPENCLAW_BIN</key>
      <string>$ROOT/send_feishu_reply.sh</string>
      <key>PATH</key>
      <string>$PATH_JOINED</string>
      <key>PYTHONIOENCODING</key>
      <string>utf-8</string>
      <key>LANG</key>
      <string>en_US.UTF-8</string>
      <key>LC_ALL</key>
      <string>en_US.UTF-8</string>
    </dict>
  </dict>
</plist>
PLIST

SERVICE="gui/$UID_NUM/$LABEL"
PROXY_SCRIPT="$ROOT/feishu_event_proxy.py"

process_command() {
  ps -p "$1" -o command= 2>/dev/null || true
}

is_own_proxy_pid() {
  local pid="$1"
  local command
  command="$(process_command "$pid")"
  [[ "$command" == *"$PROXY_SCRIPT"* ]]
}

terminate_own_proxy_pid() {
  local pid="$1"
  [[ -z "$pid" ]] && return 0
  if is_own_proxy_pid "$pid"; then
    kill "$pid" 2>/dev/null || true
  fi
}

kill_own_proxy_pid() {
  local pid="$1"
  [[ -z "$pid" ]] && return 0
  if is_own_proxy_pid "$pid"; then
    kill -9 "$pid" 2>/dev/null || true
  fi
}

ensure_port_is_free() {
  local pid
  while IFS= read -r pid; do
    [[ -z "$pid" ]] && continue
    if is_own_proxy_pid "$pid"; then
      echo "ERROR: port 3011 is still occupied by this Feishu proxy after stop:" >&2
      process_command "$pid" >&2
      exit 4
    else
      echo "ERROR: port 3011 is occupied by a non-Feishu-proxy process:" >&2
      process_command "$pid" >&2
      exit 3
    fi
  done < <(lsof -tiTCP:3011 -sTCP:LISTEN 2>/dev/null || true)
}

launchctl bootout "gui/$UID_NUM" "$PLIST" 2>/dev/null || true
launchctl bootout "$SERVICE" 2>/dev/null || true

# Clear only this checkout's proxy process. A stale orphan on 3011 prevents
# launchd from supervising the real service and causes a silent restart loop.
while IFS= read -r pid; do
  terminate_own_proxy_pid "$pid"
done < <(pgrep -f "$PROXY_SCRIPT" || true)

sleep 1

while IFS= read -r pid; do
  kill_own_proxy_pid "$pid"
done < <(pgrep -f "$PROXY_SCRIPT" || true)

while IFS= read -r pid; do
  kill_own_proxy_pid "$pid"
done < <(lsof -tiTCP:3011 -sTCP:LISTEN 2>/dev/null || true)

ensure_port_is_free

launchctl bootstrap "gui/$UID_NUM" "$PLIST"
launchctl kickstart -k "$SERVICE"

sleep 2

echo "=== launchd ==="
launchctl print "$SERVICE" | grep -En 'state =|pid =|runs =|last exit code|active count' || true

echo
echo "=== local proxy challenge ==="
curl -sS -i -X POST http://127.0.0.1:3011/feishu/events \
  -H 'Content-Type: application/json' \
  --data '{"type":"url_verification","challenge":"local-health-check"}' | sed -n '1,20p'
