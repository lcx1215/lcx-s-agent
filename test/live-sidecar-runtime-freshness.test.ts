import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildRuntimeFreshnessReceipt } from "../scripts/dev/live-sidecar-runtime-freshness.ts";

const tmpRoots: string[] = [];

function makeTmpRoot(label: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `openclaw-${label}-`));
  tmpRoots.push(root);
  return root;
}

function writeFile(root: string, relativePath: string, content: string): void {
  const filePath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");
}

function initTrackedSource(root: string): void {
  writeFile(root, "package.json", "{}\n");
  writeFile(root, "src/main.ts", "export const ok = true;\n");
  writeFile(root, "memory/ignored.md", "protected\n");
  writeFile(root, "dist/ignored.js", "generated\n");
  writeFile(
    root,
    "ops/live-handoff/launchagent-candidates/live-sidecar-runtime-bundle-receipt.json",
    '{"generated":true}\n',
  );
  spawnSync("git", ["init"], { cwd: root, stdio: "ignore" });
  spawnSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
}

afterEach(() => {
  for (const root of tmpRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("live sidecar runtime freshness", () => {
  it("reports fresh when comparable tracked files match the runtime copy", () => {
    const sourceRoot = makeTmpRoot("freshness-source");
    const targetRoot = makeTmpRoot("freshness-target");
    const outputDir = makeTmpRoot("freshness-output");
    initTrackedSource(sourceRoot);
    writeFile(targetRoot, "package.json", "{}\n");
    writeFile(targetRoot, "src/main.ts", "export const ok = true;\n");

    const receipt = buildRuntimeFreshnessReceipt({
      sourceRoot,
      targetRoot,
      outputDir,
      generatedAt: "2026-04-27T00:00:00.000Z",
    });

    expect(receipt.status).toBe("fresh");
    expect(receipt.readyForLaunchAgent).toBe(true);
    expect(receipt.checkedFileCount).toBe(2);
    expect(receipt.missingCount).toBe(0);
    expect(receipt.mismatchCount).toBe(0);
  });

  it("reports stale when a tracked runtime file is missing or mismatched", () => {
    const sourceRoot = makeTmpRoot("freshness-source-stale");
    const targetRoot = makeTmpRoot("freshness-target-stale");
    const outputDir = makeTmpRoot("freshness-output-stale");
    initTrackedSource(sourceRoot);
    writeFile(targetRoot, "package.json", '{"old":true}\n');

    const receipt = buildRuntimeFreshnessReceipt({
      sourceRoot,
      targetRoot,
      outputDir,
      generatedAt: "2026-04-27T00:00:00.000Z",
    });

    expect(receipt.status).toBe("stale");
    expect(receipt.readyForLaunchAgent).toBe(false);
    expect(receipt.mismatchCount).toBe(1);
    expect(receipt.missingCount).toBe(1);
    expect(receipt.sampleMismatched).toContain("package.json");
    expect(receipt.sampleMissing).toContain("src/main.ts");
  });

  it("keeps protected memory and generated receipts out of the comparison", () => {
    const sourceRoot = makeTmpRoot("freshness-source-boundary");
    const targetRoot = makeTmpRoot("freshness-target-boundary");
    const outputDir = makeTmpRoot("freshness-output-boundary");
    initTrackedSource(sourceRoot);
    writeFile(targetRoot, "package.json", "{}\n");
    writeFile(targetRoot, "src/main.ts", "export const ok = true;\n");

    const receipt = buildRuntimeFreshnessReceipt({
      sourceRoot,
      targetRoot,
      outputDir,
      generatedAt: "2026-04-27T00:00:00.000Z",
    });

    expect(receipt.status).toBe("fresh");
    expect(receipt.boundary.join("\n")).toContain(
      "Excludes memory, dist, apps, node_modules, and live-handoff launchagent receipts",
    );
  });
});
