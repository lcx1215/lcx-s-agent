#!/usr/bin/env bash
set -euo pipefail

PACKAGE_NAME="lcx-agent"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# shellcheck source=../install-sh-common/cli-verify.sh
source "$SCRIPT_DIR/../install-sh-common/cli-verify.sh"

if [[ -n "${LCX_INSTALL_TARBALL:-}" ]]; then
  PACKAGE_NAME="lcx-agent"
  LATEST_VERSION="$(tar -xOf "$LCX_INSTALL_TARBALL" package/package.json | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).version')"
  bash /lcx-install.sh
else
  echo "ERROR: installer smoke requires the current LCX build archive (LCX_INSTALL_TARBALL)" >&2
  exit 1
fi

echo "==> Verify installed version"
if [[ -n "${OPENCLAW_INSTALL_LATEST_OUT:-}" ]]; then
  printf "%s" "$LATEST_VERSION" > "${OPENCLAW_INSTALL_LATEST_OUT:-}"
fi
verify_installed_cli "$PACKAGE_NAME" "$LATEST_VERSION"

echo "OK"
