#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REMOTE_NAME="${1:-origin}"

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
  skip "detached HEAD; no branch to auto-sync"
fi

if [[ -n "$(git status --porcelain)" ]]; then
  skip "worktree is dirty; refusing to auto-sync"
fi

if ! git remote get-url "$REMOTE_NAME" >/dev/null 2>&1; then
  fail "remote '$REMOTE_NAME' does not exist"
fi

REMOTE_REF="refs/remotes/${REMOTE_NAME}/${BRANCH_NAME}"

log "Fetching ${REMOTE_NAME}/${BRANCH_NAME}..."
git fetch "$REMOTE_NAME"

if ! git show-ref --verify --quiet "$REMOTE_REF"; then
  skip "remote branch ${REMOTE_NAME}/${BRANCH_NAME} does not exist"
fi

LOCAL_SHA="$(git rev-parse HEAD)"
REMOTE_SHA="$(git rev-parse "$REMOTE_REF")"
BASE_SHA="$(git merge-base HEAD "$REMOTE_REF")"

if [[ "$LOCAL_SHA" == "$REMOTE_SHA" ]]; then
  log "Already up to date on ${BRANCH_NAME}."
  exit 0
fi

if [[ "$LOCAL_SHA" != "$BASE_SHA" ]]; then
  skip "local branch has commits not in ${REMOTE_NAME}/${BRANCH_NAME}; refusing to rebase or merge"
fi

log "Fast-forwarding ${BRANCH_NAME} -> ${REMOTE_NAME}/${BRANCH_NAME}..."
git pull --ff-only "$REMOTE_NAME" "$BRANCH_NAME"
log "Updated ${BRANCH_NAME} to ${REMOTE_SHA}."
