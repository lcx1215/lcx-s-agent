import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CliDeps } from "../cli/deps.js";
import type { OpenClawConfig } from "../config/config.js";
import { SsrFBlockedError } from "../infra/net/ssrf.js";
import { resolveFeishuDailyBriefAuditPath } from "./feishu-daily-brief-audit.js";

const enqueueSystemEventMock = vi.fn();
const requestHeartbeatNowMock = vi.fn();
const loadConfigMock = vi.fn();
const fetchWithSsrFGuardMock = vi.fn();
const runCronIsolatedAgentTurnMock = vi.fn();

vi.mock("../infra/system-events.js", () => ({
  enqueueSystemEvent: (...args: unknown[]) => enqueueSystemEventMock(...args),
}));

vi.mock("../infra/heartbeat-wake.js", () => ({
  requestHeartbeatNow: (...args: unknown[]) => requestHeartbeatNowMock(...args),
}));

vi.mock("../config/config.js", async () => {
  const actual = await vi.importActual<typeof import("../config/config.js")>("../config/config.js");
  return {
    ...actual,
    loadConfig: () => loadConfigMock(),
  };
});

vi.mock("../infra/net/fetch-guard.js", () => ({
  fetchWithSsrFGuard: (...args: unknown[]) => fetchWithSsrFGuardMock(...args),
}));

vi.mock("../cron/isolated-agent.js", () => ({
  runCronIsolatedAgentTurn: (...args: unknown[]) => runCronIsolatedAgentTurnMock(...args),
}));

import { buildGatewayCronService } from "./server-cron.js";

describe("buildGatewayCronService", () => {
  let stateDir = "";
  let previousStateDir: string | undefined;

  beforeEach(() => {
    enqueueSystemEventMock.mockClear();
    requestHeartbeatNowMock.mockClear();
    loadConfigMock.mockClear();
    fetchWithSsrFGuardMock.mockClear();
    runCronIsolatedAgentTurnMock.mockReset();
  });

  beforeEach(async () => {
    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "server-cron-state-"));
    previousStateDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = stateDir;
  });

  afterEach(async () => {
    if (previousStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = previousStateDir;
    }
    await fs.rm(stateDir, { recursive: true, force: true });
  });

  async function readAuditRecords() {
    const content = await fs.readFile(resolveFeishuDailyBriefAuditPath(process.env), "utf-8");
    return content
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { [key: string]: unknown });
  }

  it("routes main-target jobs to the scoped session for enqueue + wake", async () => {
    const tmpDir = path.join(os.tmpdir(), `server-cron-${Date.now()}`);
    const cfg = {
      session: {
        mainKey: "main",
      },
      cron: {
        store: path.join(tmpDir, "cron.json"),
      },
    } as OpenClawConfig;
    loadConfigMock.mockReturnValue(cfg);

    const state = buildGatewayCronService({
      cfg,
      deps: {} as CliDeps,
      broadcast: () => {},
    });
    try {
      const job = await state.cron.add({
        name: "canonicalize-session-key",
        enabled: true,
        schedule: { kind: "at", at: new Date(1).toISOString() },
        sessionTarget: "main",
        wakeMode: "next-heartbeat",
        sessionKey: "discord:channel:ops",
        payload: { kind: "systemEvent", text: "hello" },
      });

      await state.cron.run(job.id, "force");

      expect(enqueueSystemEventMock).toHaveBeenCalledWith(
        "hello",
        expect.objectContaining({
          sessionKey: "agent:main:discord:channel:ops",
        }),
      );
      expect(requestHeartbeatNowMock).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionKey: "agent:main:discord:channel:ops",
        }),
      );
    } finally {
      state.cron.stop();
    }
  });

  it("blocks private webhook URLs via SSRF-guarded fetch", async () => {
    const tmpDir = path.join(os.tmpdir(), `server-cron-ssrf-${Date.now()}`);
    const cfg = {
      session: {
        mainKey: "main",
      },
      cron: {
        store: path.join(tmpDir, "cron.json"),
      },
    } as OpenClawConfig;

    loadConfigMock.mockReturnValue(cfg);
    fetchWithSsrFGuardMock.mockRejectedValue(
      new SsrFBlockedError("Blocked: resolves to private/internal/special-use IP address"),
    );

    const state = buildGatewayCronService({
      cfg,
      deps: {} as CliDeps,
      broadcast: () => {},
    });
    try {
      const job = await state.cron.add({
        name: "ssrf-webhook-blocked",
        enabled: true,
        schedule: { kind: "at", at: new Date(1).toISOString() },
        sessionTarget: "main",
        wakeMode: "next-heartbeat",
        payload: { kind: "systemEvent", text: "hello" },
        delivery: {
          mode: "webhook",
          to: "http://127.0.0.1:8080/cron-finished",
        },
      });

      await state.cron.run(job.id, "force");

      expect(fetchWithSsrFGuardMock).toHaveBeenCalledOnce();
      expect(fetchWithSsrFGuardMock).toHaveBeenCalledWith({
        url: "http://127.0.0.1:8080/cron-finished",
        init: {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: expect.stringContaining('"action":"finished"'),
          signal: expect.any(AbortSignal),
        },
      });
    } finally {
      state.cron.stop();
    }
  });

  it("records a delivered Feishu daily brief from the active cron finished seam", async () => {
    const tmpDir = path.join(os.tmpdir(), `server-cron-audit-${Date.now()}`);
    const cfg = {
      session: {
        mainKey: "main",
      },
      cron: {
        store: path.join(tmpDir, "cron.json"),
      },
    } as OpenClawConfig;
    loadConfigMock.mockReturnValue(cfg);
    runCronIsolatedAgentTurnMock.mockResolvedValue({
      status: "ok",
      summary:
        "**🦐 LOBSTER CONTROL-ROOM — Friday, April 17, 2026 — 7:20 PM ET**\nData freshness status: provisional.\nSource reliability status: provisional.",
      delivered: true,
      deliveryAttempted: true,
      sessionId: "sess_daily",
    });

    const state = buildGatewayCronService({
      cfg,
      deps: {} as CliDeps,
      broadcast: () => {},
    });
    try {
      const job = await state.cron.add({
        name: "Lobster Daily Brief",
        description: "Daily control-room brief for Lobster",
        enabled: true,
        schedule: { kind: "at", at: new Date(1).toISOString() },
        sessionTarget: "isolated",
        wakeMode: "now",
        payload: {
          kind: "agentTurn",
          message: "generate daily brief",
          lightContext: true,
        },
        delivery: {
          mode: "announce",
          channel: "feishu",
          to: "oc_daily",
          accountId: "default",
        },
      });

      await state.cron.run(job.id, "force");

      await vi.waitFor(async () => {
        const records = await readAuditRecords();
        expect(records).toHaveLength(1);
        expect(records[0]).toEqual(
          expect.objectContaining({
            kind: "feishu_daily_brief_delivery",
            source: "gateway_cron_finished",
            jobId: job.id,
            jobName: "Lobster Daily Brief",
            deliveryMode: "announce",
            deliveryChannel: "feishu",
            accountId: "default",
            sessionId: "sess_daily",
          }),
        );
        expect(String(records[0]?.text)).toContain("LOBSTER CONTROL-ROOM");
      });
    } finally {
      state.cron.stop();
    }
  });

  it("does not record non-daily Feishu cron deliveries", async () => {
    const tmpDir = path.join(os.tmpdir(), `server-cron-no-audit-${Date.now()}`);
    const cfg = {
      session: {
        mainKey: "main",
      },
      cron: {
        store: path.join(tmpDir, "cron.json"),
      },
    } as OpenClawConfig;
    loadConfigMock.mockReturnValue(cfg);
    runCronIsolatedAgentTurnMock.mockResolvedValue({
      status: "ok",
      summary: "Generic scheduled note",
      delivered: true,
      deliveryAttempted: true,
      sessionId: "sess_other",
    });

    const state = buildGatewayCronService({
      cfg,
      deps: {} as CliDeps,
      broadcast: () => {},
    });
    try {
      const job = await state.cron.add({
        name: "Status Note",
        description: "Plain scheduled note",
        enabled: true,
        schedule: { kind: "at", at: new Date(1).toISOString() },
        sessionTarget: "isolated",
        wakeMode: "now",
        payload: {
          kind: "agentTurn",
          message: "generic note",
        },
        delivery: {
          mode: "announce",
          channel: "feishu",
          to: "oc_daily",
          accountId: "default",
        },
      });

      await state.cron.run(job.id, "force");

      await expect(readAuditRecords()).rejects.toThrow();
    } finally {
      state.cron.stop();
    }
  });
});
