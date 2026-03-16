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
1. Shared hotspots
   - src/hooks/bundled/session-memory/handler.ts
   - src/agents/system-prompt.ts
   - src/hooks/bundled/README.md
2. Runtime seams
   - scripts/bundle-a2ui.sh
   - build/copy surfaces only if they affect build correctness
3. Preserve local overlay
   - learning/frontier/fundamental hooks
   - memory helper substrate
   - local sync/audit scripts

Stop if
- the work expands into a full upstream merge
- the chosen slice starts spilling into unrelated overlay paths
- a change would revert shared helpers back to duplicated implementations

Reference docs
- audit/upstream-overlay-maintenance.md
- audit/shared-hotspots-integration.md
- audit/runtime-seams-integration.md
EOF
