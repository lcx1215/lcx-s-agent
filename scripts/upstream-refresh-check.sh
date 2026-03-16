#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SOURCE_REMOTE="${1:-upstream}"
PUBLISH_REMOTE="${2:-origin}"
BRANCH_NAME="${3:-main}"

cd "$ROOT_DIR"

scripts/upstream-sync-audit.sh "$SOURCE_REMOTE" "$PUBLISH_REMOTE" "$BRANCH_NAME"

cat <<'EOF'

Recommended next slice order
1. Shared hotspots only if new upstream changes justify reopening them
   - src/hooks/bundled/session-memory/handler.ts
   - src/agents/system-prompt.ts
   - src/hooks/bundled/README.md
2. Second-round runtime seams only when explicitly justified
   - src/agents/subagent-announce.ts (routing/wake/registry semantics only; first bounded pass already complete)
3. Runtime seams
   - shared scripts only if they affect build correctness or operator robustness
   - build/copy surfaces only if they change outputs or break builds
4. Preserve local overlay
   - learning/frontier/fundamental hooks
   - memory helper substrate
   - local sync/audit scripts

Completed bounded refreshes already on this branch
- scripts/committer
- scripts/bundle-a2ui.sh
- src/agents/subagent-announce.ts prompt-only guidance
- src/agents/subagent-announce.ts retry/timeout policy
- src/agents/subagent-announce.ts delivery provenance/internal-classification

Stop if
- the work expands into a full upstream merge
- the chosen slice starts spilling into unrelated overlay paths
- a change would revert shared helpers back to duplicated implementations

Reference docs
- audit/upstream-overlay-maintenance.md
- audit/shared-hotspots-integration.md
- audit/runtime-seams-integration.md
- audit/subagent-announce-runtime-seam.md
EOF
