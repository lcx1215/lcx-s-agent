#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SOURCE_REMOTE="${1:-upstream}"
PUBLISH_REMOTE="${2:-origin}"
PUSH_AFTER_SYNC="${PUSH_AFTER_SYNC:-0}"

log() {
  printf '%s\n' "$*"
}

skip() {
  log "SKIP: $*"
  exit 0
}

fail() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

cd "$ROOT_DIR"

git rev-parse --is-inside-work-tree >/dev/null 2>&1 || fail "not inside a git repository"

BRANCH_NAME="$(git branch --show-current)"
if [[ -z "$BRANCH_NAME" ]]; then
  skip "detached HEAD; no branch to sync"
fi

if [[ -n "$(git status --porcelain)" ]]; then
  skip "worktree is dirty; refusing to sync"
fi

for remote_name in "$SOURCE_REMOTE" "$PUBLISH_REMOTE"; do
  if ! git remote get-url "$remote_name" >/dev/null 2>&1; then
    fail "remote '$remote_name' does not exist"
  fi
done

log "Fetching ${SOURCE_REMOTE}/${BRANCH_NAME} and ${PUBLISH_REMOTE}/${BRANCH_NAME}..."
git fetch "$SOURCE_REMOTE" "$PUBLISH_REMOTE"

SOURCE_REF="refs/remotes/${SOURCE_REMOTE}/${BRANCH_NAME}"
PUBLISH_REF="refs/remotes/${PUBLISH_REMOTE}/${BRANCH_NAME}"

git show-ref --verify --quiet "$SOURCE_REF" || fail "missing ${SOURCE_REMOTE}/${BRANCH_NAME}"
git show-ref --verify --quiet "$PUBLISH_REF" || skip "missing ${PUBLISH_REMOTE}/${BRANCH_NAME}"

read -r LOCAL_ONLY UPSTREAM_ONLY < <(git rev-list --left-right --count HEAD..."$SOURCE_REF")

if (( LOCAL_ONLY > 0 && UPSTREAM_ONLY > 0 )); then
  skip "local branch diverged from ${SOURCE_REMOTE}/${BRANCH_NAME}; manual rebase required (${LOCAL_ONLY} local-only, ${UPSTREAM_ONLY} upstream-only)"
fi

if (( LOCAL_ONLY == 0 && UPSTREAM_ONLY > 0 )); then
  log "Fast-forwarding ${BRANCH_NAME} -> ${SOURCE_REMOTE}/${BRANCH_NAME}..."
  git merge --ff-only "${SOURCE_REMOTE}/${BRANCH_NAME}"
else
  log "Local branch already contains ${SOURCE_REMOTE}/${BRANCH_NAME}."
fi

read -r PUBLISH_BEHIND PUBLISH_AHEAD < <(git rev-list --left-right --count HEAD..."$PUBLISH_REF")

if (( PUBLISH_BEHIND > 0 && PUBLISH_AHEAD > 0 )); then
  skip "${PUBLISH_REMOTE}/${BRANCH_NAME} diverged from local after sync; manual push/rebase required"
fi

if (( PUBLISH_AHEAD == 0 )); then
  log "${PUBLISH_REMOTE}/${BRANCH_NAME} is already up to date."
  exit 0
fi

if [[ "$PUSH_AFTER_SYNC" != "1" ]]; then
  skip "local branch is ahead of ${PUBLISH_REMOTE}/${BRANCH_NAME} by ${PUBLISH_AHEAD}; set PUSH_AFTER_SYNC=1 to publish"
fi

log "Pushing ${BRANCH_NAME} -> ${PUBLISH_REMOTE}/${BRANCH_NAME}..."
git push "$PUBLISH_REMOTE" "$BRANCH_NAME"
log "Published ${BRANCH_NAME} to ${PUBLISH_REMOTE}/${BRANCH_NAME}."
