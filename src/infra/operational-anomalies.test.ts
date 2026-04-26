import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildWatchtowerArtifactDir,
  parseCodexEscalationArtifact,
  parseRepairTicketArtifact,
} from "../hooks/bundled/lobster-brain-registry.js";
import { recordOperationalAnomaly } from "./operational-anomalies.js";

const tempDirs: string[] = [];

async function makeWorkspaceDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-watchtower-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("recordOperationalAnomaly", () => {
  it("writes a watchtower anomaly artifact without escalating on first occurrence", async () => {
    const workspaceDir = await makeWorkspaceDir();

    const result = await recordOperationalAnomaly({
      workspaceDir,
      category: "provider_degradation",
      severity: "medium",
      source: "feishu.monitor.startup",
      problem: "startup probe timed out",
      foundationTemplate: "risk-transmission",
      evidence: ["account=alpha", "reason=timeout"],
      impact: "startup continues without stable bot health confirmation",
      nowIso: "2026-03-26T12:00:00.000Z",
    });

    expect(result.recordPath).toBeTruthy();
    expect(result.ticketPath).toBeUndefined();

    const record = JSON.parse(
      await fs.readFile(path.join(workspaceDir, result.recordPath!), "utf-8"),
    ) as { occurrenceCount: number; category: string; source: string; foundationTemplate: string };
    expect(record.occurrenceCount).toBe(1);
    expect(record.category).toBe("provider_degradation");
    expect(record.source).toBe("feishu.monitor.startup");
    expect(record.foundationTemplate).toBe("risk-transmission");
  });

  it("dedupes repeated anomalies and escalates them into repair tickets", async () => {
    const workspaceDir = await makeWorkspaceDir();

    await recordOperationalAnomaly({
      workspaceDir,
      category: "write_edit_failure",
      severity: "high",
      source: "feishu.dispatch",
      problem: "failed to dispatch message",
      foundationTemplate: "execution-hygiene",
      evidence: ["account=default", "surface=control_room"],
      impact: "user-facing reply path failed",
      nowIso: "2026-03-26T12:00:00.000Z",
    });
    const second = await recordOperationalAnomaly({
      workspaceDir,
      category: "write_edit_failure",
      severity: "high",
      source: "feishu.dispatch",
      problem: "failed to dispatch message",
      foundationTemplate: "execution-hygiene",
      evidence: ["account=default", "surface=control_room"],
      impact: "user-facing reply path failed",
      nowIso: "2026-03-26T13:00:00.000Z",
    });

    expect(second.recordPath).toBeTruthy();
    expect(second.ticketPath).toBeTruthy();
    expect(second.codexPacketPath).toBeTruthy();
    expect(second.codexCommandStatus).toBe("disabled");

    const record = JSON.parse(
      await fs.readFile(path.join(workspaceDir, second.recordPath!), "utf-8"),
    ) as { occurrenceCount: number; firstSeenAt: string; lastSeenAt: string };
    expect(record.occurrenceCount).toBe(2);
    expect(record.firstSeenAt).toBe("2026-03-26T12:00:00.000Z");
    expect(record.lastSeenAt).toBe("2026-03-26T13:00:00.000Z");

    const ticket = await fs.readFile(path.join(workspaceDir, second.ticketPath!), "utf-8");
    const parsedTicket = parseRepairTicketArtifact(ticket);
    expect(parsedTicket).toBeTruthy();
    expect(ticket).toContain("# Repair Ticket Candidate: write_edit_failure");
    expect(ticket).toContain("- **Foundation Template**: execution-hygiene");
    expect(ticket).toContain("- **Occurrences**: 2");
    expect(parsedTicket?.category).toBe("write_edit_failure");
    expect(parsedTicket?.issueKey).toHaveLength(16);
    expect(parsedTicket?.foundationTemplate).toBe("execution-hygiene");
    expect(parsedTicket?.occurrences).toBe(2);
    expect(parsedTicket?.lastSeenDateKey).toBe("2026-03-26");

    const packet = await fs.readFile(path.join(workspaceDir, second.codexPacketPath!), "utf-8");
    const parsedPacket = parseCodexEscalationArtifact(packet);
    expect(parsedPacket).toBeTruthy();
    expect(parsedPacket?.category).toBe("write_edit_failure");
    expect(parsedPacket?.repairTicketPath).toBe(second.ticketPath);
    expect(parsedPacket?.anomalyRecordPath).toBe(second.recordPath);
    expect(parsedPacket?.occurrences).toBe(2);
    expect(parsedPacket?.source).toBe("feishu.dispatch");
    expect(parsedPacket?.lastSeenDateKey).toBe("2026-03-26");
    expect(parsedPacket?.generatedDateKey).toBe("2026-03-26");

    const codexDirEntries = await fs.readdir(
      path.join(workspaceDir, buildWatchtowerArtifactDir("codexEscalations")),
    );
    expect(codexDirEntries.length).toBe(1);
  });
});
