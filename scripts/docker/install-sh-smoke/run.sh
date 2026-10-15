#!/usr/bin/env bash
set -euo pipefail

PACKAGE_NAME="lcx-agent"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# shellcheck source=../install-sh-common/cli-verify.sh
source "$SCRIPT_DIR/../install-sh-common/cli-verify.sh"

if [[ -n "${LCX_INSTALL_TARBALL:-}" ]]; then
  PACKAGE_NAME="lcx-agent"
  LATEST_VERSION="$(tar -xOf "$LCX_INSTALL_TARBALL" package/package.json | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).version')"
  if [[ "${OPENCLAW_INSTALL_SMOKE_SKIP_PREVIOUS:-0}" != "1" ]]; then
    PREVIOUS_VERSION="${OPENCLAW_INSTALL_SMOKE_PREVIOUS:-}"
    if [[ -z "$PREVIOUS_VERSION" ]]; then
      PREVIOUS_VERSION="$(npm view lcx-agent versions --json | LATEST_VERSION="$LATEST_VERSION" node -e '
let input = "";
process.stdin.on("data", chunk => input += chunk);
process.stdin.on("end", () => {
  const parsed = JSON.parse(input);
  const versions = Array.isArray(parsed) ? parsed : [parsed];
  const previous = versions.filter(v => v !== process.env.LATEST_VERSION).at(-1);
  if (!previous) process.exit(1);
  process.stdout.write(previous);
});')" || { echo "ERROR: no prior LCX release available; clean-install-only testing requires OPENCLAW_INSTALL_SMOKE_SKIP_PREVIOUS=1" >&2; exit 1; }
    fi
    if [[ ! "$PREVIOUS_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+([.-][0-9A-Za-z.-]+)?$ ]]; then
      echo "ERROR: prior LCX release must be an exact version" >&2
      exit 1
    fi
    npm install -g "lcx-agent@${PREVIOUS_VERSION}"
  fi
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
