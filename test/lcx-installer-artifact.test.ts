import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "..");

describe("LCX installer build artifact", () => {
  it.each(["lcx-agent", "openclaw"])(
    "validates %s before any registry or install operation",
    (name) => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lcx-artifact-test-"));
      try {
        fs.mkdirSync(path.join(dir, "package"));
        fs.writeFileSync(
          path.join(dir, "package/package.json"),
          JSON.stringify({ name, version: "2026.3.3", bin: { lcx: "lcx.mjs" } }),
        );
        const archive = path.join(dir, "candidate.tgz");
        execFileSync("tar", ["-czf", archive, "-C", dir, "package"]);
        const source = fs.readFileSync(path.join(root, "scripts/install.sh"), "utf8");
        const start = source.indexOf("install_openclaw() {");
        const end = source.indexOf("\n# Run doctor", start);
        const calls = path.join(dir, "calls");
        const script = `set -euo pipefail
ui_info() { :; }
ui_error() { :; }
ui_warn() { :; }
ui_success() { :; }
ensure_openclaw_bin_link() { :; }
install_openclaw_npm() { printf '%s' "$1" > "$CALLS"; }
npm() { echo 'unexpected registry call' >&2; return 99; }
USE_BETA=0
OPENCLAW_VERSION=latest
${source.slice(start, end)}
install_openclaw`;
        if (name === "lcx-agent") {
          execFileSync("bash", ["-c", script], {
            env: { ...process.env, LCX_INSTALL_TARBALL: archive, CALLS: calls },
          });
          expect(fs.readFileSync(calls, "utf8")).toBe(archive);
        } else {
          expect(() =>
            execFileSync("bash", ["-c", script], {
              env: { ...process.env, LCX_INSTALL_TARBALL: archive, CALLS: calls },
              stdio: "pipe",
            }),
          ).toThrow();
          expect(fs.existsSync(calls)).toBe(false);
        }
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});
