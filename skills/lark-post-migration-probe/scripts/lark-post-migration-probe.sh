#!/usr/bin/env bash
set -euo pipefail

WORKSPACE="${LCX_WORKSPACE:-${OPENCLAW_WORKSPACE:-}}"
LOG_FILE="${LCX_GATEWAY_LOG:-${OPENCLAW_GATEWAY_LOG:-}}"
SINCE=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --since)
      SINCE="${2:-}"
      shift 2
      ;;
    --workspace)
      WORKSPACE="${2:-}"
      shift 2
      ;;
    --gateway-log)
      LOG_FILE="${2:-}"
      shift 2
      ;;
    *)
      echo "unknown arg: $1" >&2
      exit 2
      ;;
  esac
done

echo "workspace=$WORKSPACE"
echo "gateway_log=$LOG_FILE"
echo "since=$SINCE"

if ! command -v jq >/dev/null 2>&1; then
  echo "probeStatus=blocked_missing_jq"
  exit 2
fi

if ! command -v node >/dev/null 2>&1; then
  echo "probeStatus=blocked_missing_node"
  exit 2
fi

if [[ -z "$WORKSPACE" || ! -d "$WORKSPACE" ]]; then
  echo "probeStatus=blocked_missing_workspace"
  exit 2
fi

if [[ -z "$SINCE" ]]; then
  echo "probeStatus=blocked_missing_since"
  exit 2
fi

parse_epoch_ms() {
  node -e '
    const value = Date.parse(process.argv[1]);
    if (!Number.isFinite(value)) process.exit(1);
    process.stdout.write(String(value));
  ' "$1" 2>/dev/null
}

SINCE_MS="$(parse_epoch_ms "$SINCE" || true)"
if [[ -z "$SINCE_MS" ]]; then
  echo "probeStatus=blocked_invalid_since"
  exit 2
fi

RG_BIN="$(command -v rg || true)"
if [[ -z "$RG_BIN" && -x "/Applications/ChatGPT.app/Contents/Resources/rg" ]]; then
  RG_BIN="/Applications/ChatGPT.app/Contents/Resources/rg"
fi

echo "--- gateway recent startup ---"
if [[ -f "$LOG_FILE" ]]; then
  if [[ -n "$RG_BIN" ]]; then
    startup_count="$(tail -n 160 "$LOG_FILE" | "$RG_BIN" -c "starting feishu|Webhook server listening|agent model|listening on|signal SIGTERM|received SIGTERM|bot open_id" || true)"
  else
    startup_count="$(tail -n 160 "$LOG_FILE" | grep -Ec "starting feishu|Webhook server listening|agent model|listening on|signal SIGTERM|received SIGTERM|bot open_id" || true)"
  fi
  echo "recent_startup_match_count=${startup_count:-0}"
else
  echo "missing gateway log"
fi

latest_json() {
  local dir="$1"
  local best_file=""
  local best_at=""
  local best_ms=-1
  local file timestamp timestamp_ms
  if [[ -d "$dir" ]]; then
    while IFS= read -r -d '' file; do
      timestamp="$(jq -er '(.generatedAt // .recordedAt // .createdAt // .timestamp // .at) | select(type == "string" and length > 0)' "$file" 2>/dev/null || true)"
      [[ -n "$timestamp" ]] || continue
      timestamp_ms="$(parse_epoch_ms "$timestamp" || true)"
      [[ -n "$timestamp_ms" && "$timestamp_ms" -ge "$SINCE_MS" ]] || continue
      if [[ "$timestamp_ms" -gt "$best_ms" ]]; then
        best_file="$file"
        best_at="$timestamp"
        best_ms="$timestamp_ms"
      fi
    done < <(find "$dir" -type f -name '*.json' -print0)
  fi
  [[ -n "$best_file" ]] && printf '%s\t%s\n' "$best_file" "$best_at"
}

latest_md() {
  local dir="$1"
  local best_file=""
  local best_at=""
  local best_ms=-1
  local file timestamp timestamp_ms
  if [[ -d "$dir" ]]; then
    while IFS= read -r -d '' file; do
      timestamp="$(awk -F': *' '/^(generatedAt|recordedAt|createdAt|timestamp):[[:space:]]*/ {print $2; exit}' "$file")"
      [[ -n "$timestamp" ]] || continue
      timestamp_ms="$(parse_epoch_ms "$timestamp" || true)"
      [[ -n "$timestamp_ms" && "$timestamp_ms" -ge "$SINCE_MS" ]] || continue
      if [[ "$timestamp_ms" -gt "$best_ms" ]]; then
        best_file="$file"
        best_at="$timestamp"
        best_ms="$timestamp_ms"
      fi
    done < <(find "$dir" -type f -name '*.md' -print0)
  fi
  [[ -n "$best_file" ]] && printf '%s\t%s\n' "$best_file" "$best_at"
}

handoff_record="$(latest_json "$WORKSPACE/memory/lark-language-handoff-receipts")"
candidate_record="$(latest_json "$WORKSPACE/memory/lark-language-routing-candidates")"
review_record="$(latest_json "$WORKSPACE/memory/lark-language-routing-reviews")"
work_record="$(latest_md "$WORKSPACE/memory/feishu-work-receipts")"

record_file() {
  local label="$1"
  local record="$2"
  local file=""
  local timestamp=""
  if [[ -n "$record" ]]; then
    IFS=$'\t' read -r file timestamp <<< "$record"
    echo "$label.path=$file"
    echo "$label.generatedAt=$timestamp"
    return 0
  fi
  echo "$label.path=none"
  return 1
}

echo "--- latest handoff ---"
record_file "handoff" "$handoff_record" || true

echo "--- latest routing candidate ---"
record_file "routing_candidate" "$candidate_record" || true

echo "--- latest routing review ---"
record_file "routing_review" "$review_record" || true

echo "--- latest work receipt ---"
record_file "work_receipt" "$work_record" || true

if [[ -n "$handoff_record" && -n "$candidate_record" && -n "$work_record" ]]; then
  echo "probeStatus=post-migration-ingress-observed"
else
  echo "probeStatus=no-post-migration-ingress"
fi
echo "userVisibleStatus=not-proven"
echo "nextStep=use the external-channel owner to inspect fresh inbound and outbound reply evidence"
