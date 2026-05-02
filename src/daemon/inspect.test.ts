import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { findExtraGatewayServices, inferOpenClawRootFromGatewayCommand } from "./inspect.js";

const { execSchtasksMock } = vi.hoisted(() => ({
  execSchtasksMock: vi.fn(),
}));

vi.mock("./schtasks-exec.js", () => ({
  execSchtasks: (...args: unknown[]) => execSchtasksMock(...args),
}));

describe("findExtraGatewayServices (win32)", () => {
  const originalPlatform = process.platform;

  beforeEach(() => {
    Object.defineProperty(process, "platform", {
      configurable: true,
      value: "win32",
    });
    execSchtasksMock.mockReset();
  });

  afterEach(() => {
    Object.defineProperty(process, "platform", {
      configurable: true,
      value: originalPlatform,
    });
  });

  it("skips schtasks queries unless deep mode is enabled", async () => {
    const result = await findExtraGatewayServices({});
    expect(result).toEqual([]);
    expect(execSchtasksMock).not.toHaveBeenCalled();
  });

  it("returns empty results when schtasks query fails", async () => {
    execSchtasksMock.mockResolvedValueOnce({
      code: 1,
      stdout: "",
      stderr: "error",
    });

    const result = await findExtraGatewayServices({}, { deep: true });
    expect(result).toEqual([]);
  });

  it("collects only non-openclaw marker tasks from schtasks output", async () => {
    execSchtasksMock.mockResolvedValueOnce({
      code: 0,
      stdout: [
        "TaskName: OpenClaw Gateway",
        "Task To Run: C:\\Program Files\\OpenClaw\\openclaw.exe gateway run",
        "",
        "TaskName: Clawdbot Legacy",
        "Task To Run: C:\\clawdbot\\clawdbot.exe run",
        "",
        "TaskName: Other Task",
        "Task To Run: C:\\tools\\helper.exe",
        "",
        "TaskName: MoltBot Legacy",
        "Task To Run: C:\\moltbot\\moltbot.exe run",
        "",
      ].join("\n"),
      stderr: "",
    });

    const result = await findExtraGatewayServices({}, { deep: true });
    expect(result).toEqual([
      {
        platform: "win32",
        label: "Clawdbot Legacy",
        detail: "task: Clawdbot Legacy, run: C:\\clawdbot\\clawdbot.exe run",
        scope: "system",
        marker: "clawdbot",
        legacy: true,
      },
      {
        platform: "win32",
        label: "MoltBot Legacy",
        detail: "task: MoltBot Legacy, run: C:\\moltbot\\moltbot.exe run",
        scope: "system",
        marker: "moltbot",
        legacy: true,
      },
    ]);
  });
});

describe("inferOpenClawRootFromGatewayCommand", () => {
  it("infers the repo root from a dist entrypoint when working directory is missing", () => {
    expect(
      inferOpenClawRootFromGatewayCommand({
        programArguments: [
          "/usr/local/bin/node",
          "/Users/example/Desktop/lcx-s-openclaw/dist/index.js",
          "gateway",
        ],
      }),
    ).toBe("/Users/example/Desktop/lcx-s-openclaw");
  });
});

describe("findExtraGatewayServices (darwin)", () => {
  const originalPlatform = process.platform;
  let tempDir: string | undefined;

  beforeEach(async () => {
    Object.defineProperty(process, "platform", {
      configurable: true,
      value: "darwin",
    });
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-inspect-"));
  });

  afterEach(async () => {
    Object.defineProperty(process, "platform", {
      configurable: true,
      value: originalPlatform,
    });
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
  });

  it("includes launchd program and root details for extra gateway-like services", async () => {
    const home = tempDir ?? "";
    const launchAgentsDir = path.join(home, "Library", "LaunchAgents");
    await fs.mkdir(launchAgentsDir, { recursive: true });
    const plistPath = path.join(launchAgentsDir, "ai.openclaw.feishu.proxy.plist");
    await fs.writeFile(
      plistPath,
      `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>ai.openclaw.feishu.proxy</string>
    <key>ProgramArguments</key>
    <array>
      <string>/opt/homebrew/bin/python3</string>
      <string>/Users/example/Desktop/openclaw/feishu_event_proxy.py</string>
    </array>
    <key>WorkingDirectory</key>
    <string>/Users/example/Desktop/openclaw</string>
    <key>EnvironmentVariables</key>
    <dict>
      <key>OPENCLAW_ROOT</key>
      <string>/Users/example/Desktop/openclaw</string>
      <key>OPENCLAW_BIN</key>
      <string>/Users/example/Desktop/openclaw/send_feishu_reply.sh</string>
    </dict>
  </dict>
</plist>`,
      "utf8",
    );

    const result = await findExtraGatewayServices(
      { HOME: home },
      { expectedRoot: "/Users/example/Desktop/lcx-s-openclaw" },
    );

    expect(result).toEqual([
      expect.objectContaining({
        platform: "darwin",
        label: "ai.openclaw.feishu.proxy",
        scope: "user",
        marker: "openclaw",
        legacy: false,
        detail: expect.stringContaining(
          "program: /Users/example/Desktop/openclaw/feishu_event_proxy.py",
        ),
      }),
    ]);
    expect(result[0]?.detail).toContain("cwd: /Users/example/Desktop/openclaw");
    expect(result[0]?.detail).toContain("OPENCLAW_ROOT: /Users/example/Desktop/openclaw");
    expect(result[0]?.detail).toContain(
      "OPENCLAW_BIN: /Users/example/Desktop/openclaw/send_feishu_reply.sh",
    );
    expect(result[0]?.detail).toContain(
      "root-drift: expected /Users/example/Desktop/lcx-s-openclaw",
    );
    expect(result[0]?.detail).toContain("observed /Users/example/Desktop/openclaw");
  });

  it("ignores known live-sidecar companions once they point at non-Desktop runtime", async () => {
    const home = tempDir ?? "";
    const launchAgentsDir = path.join(home, "Library", "LaunchAgents");
    await fs.mkdir(launchAgentsDir, { recursive: true });
    await fs.writeFile(
      path.join(launchAgentsDir, "ai.openclaw.feishu.proxy.plist"),
      `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>ai.openclaw.feishu.proxy</string>
    <key>ProgramArguments</key>
    <array>
      <string>/opt/homebrew/bin/python3</string>
      <string>/Users/example/.openclaw/live-sidecars/lcx-s-openclaw/feishu_event_proxy.py</string>
    </array>
    <key>WorkingDirectory</key>
    <string>/Users/example/.openclaw/live-sidecars/lcx-s-openclaw</string>
  </dict>
</plist>`,
      "utf8",
    );
    await fs.writeFile(
      path.join(launchAgentsDir, "com.openclaw.cloudflared.plist"),
      `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>com.openclaw.cloudflared</string>
    <key>ProgramArguments</key>
    <array>
      <string>cloudflared</string>
      <string>tunnel</string>
    </array>
  </dict>
</plist>`,
      "utf8",
    );

    const result = await findExtraGatewayServices(
      { HOME: home },
      { expectedRoot: "/Users/example/Desktop/lcx-s-openclaw" },
    );

    expect(result).toEqual([]);
  });
});
