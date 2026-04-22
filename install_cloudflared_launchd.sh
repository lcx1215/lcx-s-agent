#!/usr/bin/env bash
set -euo pipefail

CF_BIN="$(command -v cloudflared)"
PLIST="$HOME/Library/LaunchAgents/com.openclaw.cloudflared.plist"
LOG_DIR="$HOME/.openclaw/logs"
UID_NUM="$(id -u)"

mkdir -p "$HOME/Library/LaunchAgents"
mkdir -p "$LOG_DIR"

cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>com.openclaw.cloudflared</string>

    <key>ProgramArguments</key>
    <array>
      <string>$CF_BIN</string>
      <string>tunnel</string>
      <string>run</string>
      <string>openclaw</string>
    </array>

    <key>RunAtLoad</key>
    <true/>

    <key>KeepAlive</key>
    <true/>

    <key>WorkingDirectory</key>
    <string>$HOME</string>

    <key>StandardOutPath</key>
    <string>$LOG_DIR/cloudflared.out.log</string>

    <key>StandardErrorPath</key>
    <string>$LOG_DIR/cloudflared.err.log</string>

    <key>EnvironmentVariables</key>
    <dict>
      <key>PATH</key>
      <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
      <key>HOME</key>
      <string>$HOME</string>
    </dict>
  </dict>
</plist>
PLIST

SERVICE="gui/$UID_NUM/com.openclaw.cloudflared"

# Only restart the managed LaunchAgent job. Do not kill unrelated cloudflared tunnels.
launchctl bootout "gui/$UID_NUM" "$PLIST" 2>/dev/null || true
launchctl bootstrap "gui/$UID_NUM" "$PLIST"
launchctl kickstart -k "$SERVICE"

sleep 3

echo '=== process ==='
pgrep -af cloudflared || true

echo
echo '=== tunnel info ==='
cloudflared tunnel info openclaw || true

echo
echo '=== public healthz ==='
curl -i --max-time 15 https://bot.lcxagentxyzclawagentxyzliubotxyzopenclawbot.uk/healthz || true
