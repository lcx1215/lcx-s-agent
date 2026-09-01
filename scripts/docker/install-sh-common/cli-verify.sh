#!/usr/bin/env bash

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./version-parse.sh
source "$SCRIPT_DIR/version-parse.sh"

verify_installed_cli() {
  local package_name="$1"
  local expected_version="$2"
  local cli_name="$package_name"
  local cmd_path=""
  local entry_path=""
  local resolved_cmd_path=""
  local probe_dir=""
  local npm_root=""
  local package_json=""
  local raw_version=""
  local installed_version=""

  cmd_path="$(command -v "$cli_name" || true)"
  if [[ -z "$cmd_path" && -x "$HOME/.npm-global/bin/$package_name" ]]; then
    cmd_path="$HOME/.npm-global/bin/$package_name"
  fi

  if [[ -z "$cmd_path" ]]; then
    npm_root="$(npm root -g 2>/dev/null || true)"
    if [[ -n "$npm_root" && -f "$npm_root/$package_name/dist/entry.js" ]]; then
      entry_path="$npm_root/$package_name/dist/entry.js"
    fi
    package_json="$npm_root/$package_name/package.json"
  fi

  if [[ -n "$cmd_path" ]]; then
    resolved_cmd_path="$(readlink -f "$cmd_path" 2>/dev/null || true)"
    probe_dir="$(dirname "$resolved_cmd_path")"
    while [[ "$probe_dir" != "/" && -z "$package_json" ]]; do
      if [[ -f "$probe_dir/package.json" ]]; then
        package_json="$probe_dir/package.json"
        break
      fi
      probe_dir="$(dirname "$probe_dir")"
    done
  fi

  if [[ -z "$cmd_path" && -z "$entry_path" ]]; then
    echo "ERROR: $package_name is not on PATH" >&2
    return 1
  fi

  if [[ -n "$cmd_path" ]]; then
    raw_version="$("$cmd_path" --version 2>/dev/null || true)"
  else
    raw_version="$(node "$entry_path" --version 2>/dev/null || true)"
  fi

  installed_version="$(printf '%s\n' "$raw_version" | head -n 1 | tr -d '\r')"
  installed_version="$(extract_openclaw_semver "$installed_version")"

  if [[ -z "$installed_version" && -n "$cmd_path" ]]; then
    raw_version="$("$cmd_path" version 2>/dev/null || true)"
    installed_version="$(printf '%s\n' "$raw_version" | head -n 1 | tr -d '\r')"
    installed_version="$(extract_openclaw_semver "$installed_version")"
  fi

  if [[ -z "$installed_version" ]]; then
    if [[ -z "$package_json" ]]; then
      npm_root="$(npm root -g 2>/dev/null || true)"
      package_json="$npm_root/$package_name/package.json"
    fi
    if [[ -f "$package_json" ]]; then
      installed_version="$(node -p 'require(process.argv[1]).version' "$package_json" 2>/dev/null || true)"
    fi
  fi
  installed_version="$(extract_openclaw_semver "$installed_version")"

  echo "cli=$cli_name installed=$installed_version expected=$expected_version"
  if [[ "$installed_version" != "$expected_version" ]]; then
    echo "ERROR: expected ${cli_name}@${expected_version}, got ${cli_name}@${installed_version}" >&2
    return 1
  fi

  echo "==> Sanity: CLI runs"
  if [[ -n "$cmd_path" ]]; then
    "$cmd_path" --help >/dev/null
  else
    node "$entry_path" --help >/dev/null
  fi
}
