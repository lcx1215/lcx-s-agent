#!/usr/bin/env bash
set -euo pipefail

SOURCE_REPO="${LCX_REPO_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null || true)}"
RUNTIME="${LCX_EXTERNAL_CHANNEL_RUNTIME:-}"
MANIFEST="${LCX_RUNTIME_PARITY_MANIFEST:-}"
APPLY=0
case "${1:-}" in
  "") ;;
  --help|-h)
    echo "Usage: LCX_EXTERNAL_CHANNEL_RUNTIME=... LCX_RUNTIME_PARITY_MANIFEST=... $0 [--apply]"
    echo "Read-only by default; manifest.files declares exact relative parity files."
    exit 0 ;;
  --apply) APPLY=1 ;;
  *) echo "unsupported argument" >&2; exit 2 ;;
esac
[[ $# -le 1 ]] || { echo "too many arguments" >&2; exit 2; }
command -v node >/dev/null || { echo "blocked: node runtime unavailable" >&2; exit 2; }
[[ -n "$SOURCE_REPO" && -n "$RUNTIME" && -n "$MANIFEST" ]] || {
  echo "blocked: verify source, runtime and LCX_RUNTIME_PARITY_MANIFEST first" >&2
  exit 2
}
git -C "$SOURCE_REPO" rev-parse --show-toplevel >/dev/null 2>&1 || {
  echo "blocked: source is not a Git checkout" >&2; exit 2;
}
node --input-type=module - "$SOURCE_REPO" "$RUNTIME" "$MANIFEST" "$APPLY" <<'NODE'
import fs from "node:fs";
import path from "node:path";

const [sourceArg, runtimeArg, manifestArg, applyArg] = process.argv.slice(2);
const inside = (root, target) => target === root || target.startsWith(root + path.sep);
const appliedFiles = [];
try {
  const source = fs.realpathSync(sourceArg);
  const runtime = fs.realpathSync(runtimeArg);
  if (inside(source, runtime) || inside(runtime, source)) {
    throw new Error("source and runtime must be separate, non-overlapping roots");
  }
  const manifestStat = fs.statSync(manifestArg);
  if (!manifestStat.isFile() || manifestStat.size > 512 * 1024) {
    throw new Error("parity manifest must be a bounded JSON file");
  }
  const manifest = JSON.parse(fs.readFileSync(manifestArg, "utf8"));
  if (!Array.isArray(manifest.files) || !manifest.files.length || manifest.files.length > 2000) {
    throw new Error("manifest.files must declare 1..2000 exact relative files");
  }
  const rows = [];
  const seen = new Set();
  let sourceBytes = 0;
  for (const relative of manifest.files) {
    if (typeof relative !== "string" || !relative || path.isAbsolute(relative) ||
        relative.includes("\\") || relative.split("/").some(p => !p || p === "." || p === "..") ||
        /^(?:\.git|node_modules|state)(?:\/|$)|(?:^|\/)\.env(?:[./]|$)/u.test(relative) ||
        /(?:^|\/)(?:auth-profiles\.json|credentials|secrets)(?:\/|$)/u.test(relative)) {
      throw new Error("invalid or protected parity path");
    }
    if (seen.has(relative)) throw new Error("duplicate parity path");
    seen.add(relative);
    const from = path.join(source, relative);
    const to = path.join(runtime, relative);
    if (!inside(source, fs.realpathSync(from)) || !fs.statSync(from).isFile()) {
      throw new Error("source file unavailable or outside the declared root");
    }
    sourceBytes += fs.statSync(from).size;
    if (sourceBytes > 128 * 1024 * 1024) throw new Error("parity file set exceeds 128 MiB");
    let parent = to;
    while (!fs.existsSync(parent)) {
      if (fs.lstatSync(parent, { throwIfNoEntry: false })?.isSymbolicLink()) {
        throw new Error("dangling destination symlink");
      }
      parent = path.dirname(parent);
    }
    if (!inside(runtime, fs.realpathSync(parent))) {
      throw new Error("destination escapes the declared runtime");
    }
    if (fs.existsSync(to) && (!fs.lstatSync(to).isFile() || fs.lstatSync(to).isSymbolicLink())) {
      throw new Error("destination must be a regular file");
    }
    rows.push({ relative, from, to,
      different: !fs.existsSync(to) || !fs.readFileSync(from).equals(fs.readFileSync(to)) });
  }
  // Validate the whole declared set before the first mutation.
  const changed = rows.filter(row => row.different);
  const missing = changed.filter(row => !fs.existsSync(row.to)).length;
  if (applyArg === "1") {
    for (const row of changed) {
      fs.mkdirSync(path.dirname(row.to), { recursive: true });
      const staging = row.to + ".lcx-parity-" + process.pid + "-" + appliedFiles.length;
      let created = false;
      try {
        const descriptor = fs.openSync(staging, "wx");
        created = true;
        fs.closeSync(descriptor);
        fs.copyFileSync(row.from, staging);
        fs.chmodSync(staging, fs.statSync(row.from).mode & 0o777);
        fs.renameSync(staging, row.to);
        appliedFiles.push(row.relative);
      } finally {
        if (created) fs.rmSync(staging, { force: true });
      }
    }
  }
  console.log(JSON.stringify({ status: changed.length ? (applyArg === "1" ? "applied" : "drift") : "in_sync",
    source, runtime, files: rows.length, different: changed.map(row => row.relative),
    applied: applyArg === "1", deleted: 0 }));
  // Existing binding owners consume this presentation; it does not widen the manifest.
  console.log(`summary same=${rows.length - changed.length} missing=${missing} different=${changed.length - missing}`);
} catch (error) {
  console.error(JSON.stringify({ status: "blocked", reason: error.message, applied: appliedFiles.length > 0, appliedFiles }));
  process.exitCode = 2;
}
NODE
