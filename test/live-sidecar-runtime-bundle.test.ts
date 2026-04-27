import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildRuntimeBundleReceipt,
  DEFAULT_RUNTIME_BUNDLE_ROOT,
} from "../scripts/dev/live-sidecar-runtime-bundle.ts";

const tmpRoots: string[] = [];

function makeTmpRoot(label: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `openclaw-${label}-`));
  tmpRoots.push(root);
  return root;
}

function writeRequiredSource(root: string): void {
  const files = [
    "daily_learning_runner.py",
    "lobster_orchestrator.py",
    "scripts/lobster_paths.py",
    "scripts/branch_freshness.py",
    "scripts/lobster_host_watchdog.py",
  ];
  for (const file of files) {
    const filePath = path.join(root, file);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, "print('ok')\n", "utf8");
  }
}

afterEach(() => {
  for (const root of tmpRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("live sidecar runtime bundle", () => {
  it("copies only the bounded sidecar runtime files into a non-Desktop bundle", () => {
    const sourceRoot = makeTmpRoot("bundle-source");
    const targetRoot = makeTmpRoot("bundle-target");
    const outputDir = makeTmpRoot("bundle-output");
    writeRequiredSource(sourceRoot);

    const receipt = buildRuntimeBundleReceipt({
      sourceRoot,
      targetRoot,
      outputDir,
      write: true,
      generatedAt: "2026-04-27T00:00:00.000Z",
      compileCheck: { command: "stub", code: 0, stderr: "" },
    });

    expect(receipt.readyForLaunchAgent).toBe(true);
    expect(receipt.targetRoot).toBe(targetRoot);
    expect(receipt.files).toHaveLength(5);
    expect(receipt.files.every((file) => file.copied)).toBe(true);
    expect(receipt.boundary.join("\n")).toContain("Does not copy Feishu/Lark proxy code");
    expect(fs.existsSync(path.join(targetRoot, "scripts/lobster_host_watchdog.py"))).toBe(true);
  });

  it("blocks Desktop targets before writing runtime files", () => {
    const sourceRoot = makeTmpRoot("bundle-source");
    const outputDir = makeTmpRoot("bundle-output");
    writeRequiredSource(sourceRoot);

    const receipt = buildRuntimeBundleReceipt({
      sourceRoot,
      targetRoot: path.join(os.homedir(), "Desktop", "openclaw-runtime-test"),
      outputDir,
      write: true,
      generatedAt: "2026-04-27T00:00:00.000Z",
      compileCheck: null,
    });

    expect(receipt.readyForLaunchAgent).toBe(false);
    expect(receipt.blockedReasons.join("\n")).toContain("must not be under Desktop");
    expect(receipt.files.every((file) => !file.copied)).toBe(true);
  });

  it("uses the shared non-Desktop default runtime root", () => {
    expect(DEFAULT_RUNTIME_BUNDLE_ROOT).toBe(
      "/Users/liuchengxu/.openclaw/live-sidecars/lcx-s-openclaw",
    );
    expect(DEFAULT_RUNTIME_BUNDLE_ROOT).not.toContain("/Desktop/");
  });
});
