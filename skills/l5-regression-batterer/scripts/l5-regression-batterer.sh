#!/bin/zsh
set -euo pipefail

# Resolve the current canonical repository/worktree at invocation time. An
# explicit root is useful for a detached operator call, while the current Git
# checkout remains the default so linked worktrees do not silently run another
# repository's battery.
repo="${LCX_REPO_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
node_bin="${LCX_NODE_BIN:-$(command -v node || true)}"

usage() {
  print "Usage: l5-regression-batterer.sh --local"
  print "Runs the bounded local L5 contract battery without training or live-channel actions."
}

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  usage
  exit 0
fi
if [[ "${1:-}" != "--local" || "$#" -ne 1 ]]; then
  usage >&2
  exit 2
fi
if [[ ! -x "$node_bin" ]]; then
  print -u2 "l5-regression-batterer: node runtime not found"
  exit 127
fi
if ! "$node_bin" -e 'const [major, minor] = process.versions.node.split(".").map(Number); if (major < 22 || (major === 22 && minor < 12)) process.exit(1)'; then
  print -u2 "l5-regression-batterer: Node.js >=22.12.0 is required"
  exit 126
fi
export PATH="$(dirname "$node_bin"):$PATH"
if [[ ! -d "$repo" ]]; then
  print -u2 "l5-regression-batterer: repo not found: $repo"
  exit 1
fi

cd "$repo"

# Keep this battery deterministic and below the heavy-training boundary. The
# context exam and doctrine owner are the contract checks; the Vitest slice
# covers the natural-language autocue and status-boundary regression surface.
"$node_bin" --import tsx scripts/operator/lcx-doctrine-consistency.ts --json
"$node_bin" --import tsx scripts/operator/lcx-context-recovery-exam.ts --json
pnpm exec vitest run \
  src/auto-reply/reply/skill-autocue.test.ts \
  src/agents/skills.test.ts \
  test/lcx-agent-exam.test.ts \
  test/lcx-doctrine-consistency.test.ts \
  --reporter=dot

print "L5 local regression battery passed"
