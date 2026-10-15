#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
IMAGE_NAME="${OPENCLAW_INSTALL_E2E_IMAGE:-${CLAWDBOT_INSTALL_E2E_IMAGE:-openclaw-install-e2e:local}}"
# Use this checkout's installer and a locally built LCX archive, never remote main.
ARTIFACT_DIR="$(mktemp -d)"
trap 'rm -rf "$ARTIFACT_DIR"' EXIT
if [[ -z "${LCX_INSTALL_TARBALL:-}" ]]; then
  BUILD_IMAGE="${LCX_INSTALL_BUILD_IMAGE:-lcx-install-build:local}"
  docker build -t "$BUILD_IMAGE" -f "$ROOT_DIR/Dockerfile" "$ROOT_DIR"
  docker run --rm --user root --entrypoint sh -v "$ARTIFACT_DIR:/out" "$BUILD_IMAGE" -lc 'cd /app && npm pack --ignore-scripts --pack-destination /out'
  LCX_INSTALL_TARBALL="$(find "$ARTIFACT_DIR" -name 'lcx-agent-*.tgz' -print -quit)"
fi
[[ -f "$LCX_INSTALL_TARBALL" ]] || { echo "ERROR: missing LCX build archive" >&2; exit 1; }
LCX_INSTALL_TARBALL="$(cd "$(dirname "$LCX_INSTALL_TARBALL")" && pwd)/$(basename "$LCX_INSTALL_TARBALL")"

OPENAI_API_KEY="${OPENAI_API_KEY:-}"
ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY:-}"
ANTHROPIC_API_TOKEN="${ANTHROPIC_API_TOKEN:-}"
OPENCLAW_E2E_MODELS="${OPENCLAW_E2E_MODELS:-${CLAWDBOT_E2E_MODELS:-}}"

echo "==> Build image: $IMAGE_NAME"
docker build \
  -t "$IMAGE_NAME" \
  -f "$ROOT_DIR/scripts/docker/install-sh-e2e/Dockerfile" \
  "$ROOT_DIR/scripts/docker/install-sh-e2e"

echo "==> Run E2E installer test"
docker run --rm \
  -v "${LCX_INSTALL_TARBALL}:/lcx-agent.tgz:ro" \
  -v "${ROOT_DIR}/scripts/install.sh:/lcx-install.sh:ro" \
  -v "${ROOT_DIR}/scripts/docker/install-sh-common:/lcx-install-common:ro" \
  -e LCX_INSTALL_TARBALL=/lcx-agent.tgz \
  -e OPENCLAW_NO_PROMPT=1 \
  -e OPENCLAW_E2E_MODELS="$OPENCLAW_E2E_MODELS" \
  -e OPENCLAW_INSTALL_E2E_PREVIOUS="${OPENCLAW_INSTALL_E2E_PREVIOUS:-${CLAWDBOT_INSTALL_E2E_PREVIOUS:-}}" \
  -e OPENCLAW_INSTALL_E2E_SKIP_PREVIOUS="${OPENCLAW_INSTALL_E2E_SKIP_PREVIOUS:-${CLAWDBOT_INSTALL_E2E_SKIP_PREVIOUS:-0}}" \
  -e OPENAI_API_KEY="$OPENAI_API_KEY" \
  -e ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" \
  -e ANTHROPIC_API_TOKEN="$ANTHROPIC_API_TOKEN" \
  "$IMAGE_NAME"
