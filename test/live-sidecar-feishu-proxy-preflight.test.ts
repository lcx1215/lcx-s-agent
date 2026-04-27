import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildFeishuProxyPreflightReceipt } from "../scripts/dev/live-sidecar-feishu-proxy-preflight.ts";

const tmpRoots: string[] = [];

function makeTmpRoot(label: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `openclaw-${label}-`));
  tmpRoots.push(root);
  return root;
}

function writeFile(root: string, relativePath: string, content = "x\n") {
  const filePath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");
}

function writeProxyFiles(root: string) {
  writeFile(root, "feishu_event_proxy.py", "print('proxy')\n");
  writeFile(root, "run_feishu_proxy.sh", "#!/usr/bin/env bash\n");
  writeFile(root, "send_feishu_reply.sh", "#!/usr/bin/env bash\n");
  writeFile(root, "scripts/learning_goal_registry.py", "VALUE = 1\n");
}

afterEach(() => {
  for (const root of tmpRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("live sidecar Feishu proxy preflight", () => {
  it("copies bounded legacy proxy files into a non-Desktop runtime", () => {
    const legacyRoot = makeTmpRoot("feishu-legacy");
    const targetRoot = makeTmpRoot("feishu-target");
    const outputDir = makeTmpRoot("feishu-output");
    writeProxyFiles(legacyRoot);

    const receipt = buildFeishuProxyPreflightReceipt({
      legacyRoot,
      targetRoot,
      outputDir,
      writeRuntime: true,
      generatedAt: "2026-04-27T00:00:00.000Z",
      runSmokeCheck: false,
    });

    expect(receipt.files.every((file) => file.copied)).toBe(true);
    expect(receipt.boundary.join("\n")).toContain("does not replace the live 3011 proxy");
    expect(fs.existsSync(path.join(targetRoot, "feishu_event_proxy.py"))).toBe(true);
    expect(fs.existsSync(path.join(targetRoot, "scripts/learning_goal_registry.py"))).toBe(true);
  });

  it("blocks Desktop runtime targets", () => {
    const legacyRoot = makeTmpRoot("feishu-legacy");
    const outputDir = makeTmpRoot("feishu-output");
    writeProxyFiles(legacyRoot);

    const receipt = buildFeishuProxyPreflightReceipt({
      legacyRoot,
      targetRoot: path.join(os.homedir(), "Desktop", "feishu-proxy-test"),
      outputDir,
      writeRuntime: true,
      generatedAt: "2026-04-27T00:00:00.000Z",
      runSmokeCheck: false,
    });

    expect(receipt.readyForLiveInstall).toBe(false);
    expect(receipt.blockedReasons.join("\n")).toContain("must not be under Desktop");
    expect(receipt.files.every((file) => !file.copied)).toBe(true);
  });
});
