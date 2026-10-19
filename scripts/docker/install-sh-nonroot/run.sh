#!/usr/bin/env bash
set -euo pipefail

PACKAGE_NAME="lcx-agent"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# shellcheck source=../install-sh-common/cli-verify.sh
source "$SCRIPT_DIR/../install-sh-common/cli-verify.sh"

echo "==> Pre-flight: ensure git absent"
if command -v git >/dev/null; then
  echo "git is present unexpectedly" >&2
  exit 1
fi

echo "==> Run installer (non-root user)"
bash /lcx-install.sh

# Ensure PATH picks up user npm prefix
export PATH="$HOME/.npm-global/bin:$PATH"

echo "==> Verify git installed"
command -v git >/dev/null

EXPECTED_VERSION="${OPENCLAW_INSTALL_EXPECT_VERSION:-}"
if [[ -n "$EXPECTED_VERSION" ]]; then
  LATEST_VERSION="$EXPECTED_VERSION"
else
  LATEST_VERSION="$(tar -xOf "$LCX_INSTALL_TARBALL" package/package.json | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).version')"
fi
echo "==> Verify CLI installed"
verify_installed_cli "$PACKAGE_NAME" "$LATEST_VERSION"

echo "OK"
