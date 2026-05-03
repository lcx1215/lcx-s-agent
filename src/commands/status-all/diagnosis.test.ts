import { describe, expect, it } from "vitest";
import { appendStatusAllDiagnosis, inspectMacBuildToolchain } from "./diagnosis.js";

const progress = {
  setLabel: () => {},
  setPercent: () => {},
  tick: () => {},
  done: () => {},
};

function passthrough(text: string) {
  return text;
}

describe("inspectMacBuildToolchain", () => {
  it("reports non-mac platforms as not applicable", () => {
    expect(inspectMacBuildToolchain({ platform: "linux" })).toEqual({
      status: "not_applicable",
      reason: null,
      developerDir: null,
      fix: null,
    });
  });

  it("blocks mac app rebuilds when xcode-select points at CommandLineTools", () => {
    const status = inspectMacBuildToolchain({
      platform: "darwin",
      runCommand: (command) => {
        if (command === "swift") {
          return { ok: true, stdout: "Apple Swift version 6.3" };
        }
        if (command === "xcode-select") {
          return { ok: true, stdout: "/Library/Developer/CommandLineTools" };
        }
        return { ok: false, stdout: "" };
      },
    });

    expect(status).toMatchObject({
      status: "blocked",
      developerDir: "/Library/Developer/CommandLineTools",
      reason: "full Xcode is required for Swift package macro plugins used by mac app dependencies",
    });
    expect(status.fix).toContain("sudo xcode-select -s /Applications/Xcode.app/Contents/Developer");
  });

  it("reports ready when full Xcode and xcodebuild are usable", () => {
    expect(
      inspectMacBuildToolchain({
        platform: "darwin",
        runCommand: (command) => {
          if (command === "swift") {
            return { ok: true, stdout: "Apple Swift version 6.3" };
          }
          if (command === "xcode-select") {
            return { ok: true, stdout: "/Applications/Xcode.app/Contents/Developer" };
          }
          if (command === "xcodebuild") {
            return { ok: true, stdout: "Xcode 26.0" };
          }
          return { ok: false, stdout: "" };
        },
      }),
    ).toEqual({
      status: "ready",
      reason: null,
      developerDir: "/Applications/Xcode.app/Contents/Developer",
      fix: null,
    });
  });

  it("renders the mac app rebuild blocker in status-all diagnosis", async () => {
    const lines: string[] = [];
    await appendStatusAllDiagnosis({
      lines,
      progress,
      muted: passthrough,
      ok: passthrough,
      warn: passthrough,
      fail: passthrough,
      connectionDetailsForReport: "Gateway target: local",
      snap: null,
      remoteUrlMissing: false,
      sentinel: null,
      lastErr: null,
      port: 18789,
      portUsage: null,
      tailscaleMode: "off",
      tailscale: { backendState: "Running", dnsName: null, ips: [], error: null },
      tailscaleHttpsUrl: null,
      skillStatus: null,
      channelsStatus: null,
      channelIssues: [],
      gatewayReachable: false,
      health: null,
      macBuildToolchain: {
        status: "blocked",
        developerDir: "/Library/Developer/CommandLineTools",
        reason:
          "full Xcode is required for Swift package macro plugins used by mac app dependencies",
        fix: "Install/open full Xcode, then run: sudo xcode-select -s /Applications/Xcode.app/Contents/Developer",
      },
    });

    const output = lines.join("\n");
    expect(output).toContain("Mac app rebuild toolchain: /Library/Developer/CommandLineTools");
    expect(output).toContain(
      "full Xcode is required for Swift package macro plugins used by mac app dependencies",
    );
    expect(output).toContain(
      "Fix: Install/open full Xcode, then run: sudo xcode-select -s /Applications/Xcode.app/Contents/Developer",
    );
  });

  it("does not warn when the status port belongs to the reachable gateway", async () => {
    const lines: string[] = [];
    await appendStatusAllDiagnosis({
      lines,
      progress,
      muted: passthrough,
      ok: (text) => `OK:${text}`,
      warn: (text) => `WARN:${text}`,
      fail: passthrough,
      connectionDetailsForReport: "Gateway target: local",
      snap: null,
      remoteUrlMissing: false,
      sentinel: null,
      lastErr: null,
      port: 18789,
      portUsage: {
        listeners: [{ commandLine: "node /Users/me/lcx-s-openclaw/dist/entry.js gateway" }],
      },
      tailscaleMode: "off",
      tailscale: { backendState: "Running", dnsName: null, ips: [], error: null },
      tailscaleHttpsUrl: null,
      skillStatus: null,
      channelsStatus: null,
      channelIssues: [],
      gatewayReachable: true,
      health: null,
      macBuildToolchain: { status: "not_applicable", reason: null, developerDir: null, fix: null },
    });

    const output = lines.join("\n");
    expect(output).toContain("OK:Port 18789");
    expect(output).toContain("owned by the reachable local OpenClaw gateway");
    expect(output).not.toContain("WARN:Port 18789");
    expect(output).not.toContain("Stop it (openclaw gateway stop)");
  });

  it("does not warn when tailscale is explicitly off and the binary is missing", async () => {
    const lines: string[] = [];
    await appendStatusAllDiagnosis({
      lines,
      progress,
      muted: passthrough,
      ok: (text) => `OK:${text}`,
      warn: (text) => `WARN:${text}`,
      fail: passthrough,
      connectionDetailsForReport: "Gateway target: local",
      snap: null,
      remoteUrlMissing: false,
      sentinel: null,
      lastErr: null,
      port: 18789,
      portUsage: null,
      tailscaleMode: "off",
      tailscale: {
        backendState: null,
        dnsName: null,
        ips: [],
        error: "Error: spawn tailscale ENOENT",
      },
      tailscaleHttpsUrl: null,
      skillStatus: null,
      channelsStatus: null,
      channelIssues: [],
      gatewayReachable: true,
      health: null,
      macBuildToolchain: { status: "not_applicable", reason: null, developerDir: null, fix: null },
    });

    const output = lines.join("\n");
    expect(output).toContain("OK:Tailscale: off · unknown");
    expect(output).not.toContain("WARN:Tailscale");
    expect(output).not.toContain("spawn tailscale ENOENT");
  });
});
