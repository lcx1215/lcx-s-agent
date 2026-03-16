#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SOURCE_REMOTE="${1:-upstream}"
PUBLISH_REMOTE="${2:-origin}"
BRANCH_NAME="${3:-main}"

log() {
  printf '%s\n' "$*"
}

fail() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

cd "$ROOT_DIR"

git rev-parse --is-inside-work-tree >/dev/null 2>&1 || fail "not inside a git repository"

for remote_name in "$SOURCE_REMOTE" "$PUBLISH_REMOTE"; do
  git remote get-url "$remote_name" >/dev/null 2>&1 || fail "remote '$remote_name' does not exist"
done

log "Fetching ${SOURCE_REMOTE}/${BRANCH_NAME} and ${PUBLISH_REMOTE}/${BRANCH_NAME}..."
git fetch "$SOURCE_REMOTE"
git fetch "$PUBLISH_REMOTE"

SOURCE_REF="refs/remotes/${SOURCE_REMOTE}/${BRANCH_NAME}"
PUBLISH_REF="refs/remotes/${PUBLISH_REMOTE}/${BRANCH_NAME}"

git show-ref --verify --quiet "$SOURCE_REF" || fail "missing ${SOURCE_REMOTE}/${BRANCH_NAME}"
git show-ref --verify --quiet "$PUBLISH_REF" || fail "missing ${PUBLISH_REMOTE}/${BRANCH_NAME}"

read -r LOCAL_ONLY_SOURCE SOURCE_ONLY < <(git rev-list --left-right --count HEAD..."$SOURCE_REF")
read -r LOCAL_ONLY_PUBLISH PUBLISH_ONLY < <(git rev-list --left-right --count HEAD..."$PUBLISH_REF")

log ""
log "Upstream Sync Audit"
log "repo: $(basename "$ROOT_DIR")"
log "branch: ${BRANCH_NAME}"
log "head: $(git rev-parse --short HEAD)"
log "source: ${SOURCE_REMOTE}/${BRANCH_NAME} ($(git rev-parse --short "$SOURCE_REF"))"
log "publish: ${PUBLISH_REMOTE}/${BRANCH_NAME} ($(git rev-parse --short "$PUBLISH_REF"))"
log ""
log "Divergence"
log "local-only vs ${SOURCE_REMOTE}: ${LOCAL_ONLY_SOURCE}"
log "${SOURCE_REMOTE}-only vs local: ${SOURCE_ONLY}"
log "local-only vs ${PUBLISH_REMOTE}: ${LOCAL_ONLY_PUBLISH}"
log "${PUBLISH_REMOTE}-only vs local: ${PUBLISH_ONLY}"
log ""

if (( LOCAL_ONLY_SOURCE > 0 && SOURCE_ONLY > 0 )); then
  log "sync-status: diverged-from-${SOURCE_REMOTE}"
elif (( SOURCE_ONLY > 0 )); then
  log "sync-status: behind-${SOURCE_REMOTE}"
elif (( LOCAL_ONLY_SOURCE > 0 )); then
  log "sync-status: ahead-of-${SOURCE_REMOTE}"
else
  log "sync-status: aligned-with-${SOURCE_REMOTE}"
fi

log ""
log "Recent local-only commits"
git log --oneline "$SOURCE_REF"..HEAD | sed -n '1,20p'

log ""
log "Recent ${SOURCE_REMOTE}-only commits"
git log --oneline HEAD.."$SOURCE_REF" | sed -n '1,20p'

log ""
log "Focused path diff (hooks, agents, scripts)"
git diff --name-status "$SOURCE_REF" HEAD -- \
  src/hooks/bundled \
  src/agents/system-prompt.ts \
  src/agents/system-prompt.test.ts \
  scripts \
  | sed -n '1,120p'

log ""
log "Shared hotspots"
for hotspot in \
  src/hooks/bundled/session-memory/handler.ts \
  src/hooks/bundled/session-memory/handler.test.ts \
  src/agents/system-prompt.ts \
  src/agents/system-prompt.test.ts \
  src/agents/subagent-announce.ts \
  src/hooks/bundled/README.md; do
  if git cat-file -e "$SOURCE_REF:$hotspot" 2>/dev/null; then
    printf 'SHARED %s\n' "$hotspot"
  fi
done

log ""
log "Known local overlay"
for overlay_path in \
  src/hooks/bundled/artifact-memory.ts \
  src/hooks/bundled/bootstrap-memory.ts \
  src/hooks/bundled/weekly-memory.ts \
  src/hooks/bundled/upgrade-memory.ts \
  src/hooks/bundled/operating-loop/handler.ts \
  src/hooks/bundled/fundamental-intake/handler.ts \
  src/hooks/bundled/fundamental-manifest-bridge/handler.ts \
  src/hooks/bundled/fundamental-snapshot-bridge/handler.ts \
  src/hooks/bundled/fundamental-snapshot/handler.ts \
  src/hooks/bundled/fundamental-scoring-gate/handler.ts \
  src/hooks/bundled/learning-review/handler.ts \
  src/hooks/bundled/frontier-research/handler.ts \
  src/hooks/bundled/learning-review-weekly/handler.ts \
  src/hooks/bundled/frontier-research-weekly/handler.ts \
  src/hooks/bundled/learning-review-bootstrap/handler.ts \
  src/hooks/bundled/frontier-research-bootstrap/handler.ts \
  scripts/auto-sync-repo.sh \
  scripts/sync-upstream-fork.sh \
  scripts/upstream-sync-audit.sh; do
  if ! git cat-file -e "$SOURCE_REF:$overlay_path" 2>/dev/null; then
    printf 'OVERLAY %s\n' "$overlay_path"
  fi
done
