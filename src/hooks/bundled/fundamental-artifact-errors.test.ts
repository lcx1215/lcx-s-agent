import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildWatchtowerArtifactDir } from "./lobster-brain-registry.js";
import { writeFundamentalArtifactErrors } from "./fundamental-artifact-errors.js";

let suiteWorkspaceRoot = "";
let workspaceCaseCounter = 0;

async function createCaseWorkspace(prefix = "artifact-errors"): Promise<string> {
  const dir = path.join(suiteWorkspaceRoot, `${prefix}-${workspaceCaseCounter}`);
  workspaceCaseCounter += 1;
  await fs.mkdir(dir, { recursive: true });
  await fs.mkdir(path.join(dir, "memory"), { recursive: true });
  return dir;
}

beforeAll(async () => {
  suiteWorkspaceRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "openclaw-fundamental-artifact-errors-"),
  );
});

afterAll(async () => {
  if (!suiteWorkspaceRoot) {
    return;
  }
  await fs.rm(suiteWorkspaceRoot, { recursive: true, force: true });
  suiteWorkspaceRoot = "";
  workspaceCaseCounter = 0;
});

describe("fundamental artifact errors", () => {
  it("dedupes repeated error writes into one record and one stable note", async () => {
    const workspaceDir = await createCaseWorkspace();
    const memoryDir = path.join(workspaceDir, "memory");

    await writeFundamentalArtifactErrors({
      workspaceDir,
      memoryDir,
      nowIso: "2026-03-15T12:00:00.000Z",
      errors: [
        {
          stage: "snapshot",
          relativePath: "bank/fundamental/readiness/msft-artifact-error.json",
          fileName: "msft-artifact-error.json",
          manifestId: "msft-artifact-error",
          errorStatus: "blocked_due_to_artifact_error",
          errorMessage: "Expected ',' or '}' after property value in JSON at position 15",
        },
      ],
    });

    await writeFundamentalArtifactErrors({
      workspaceDir,
      memoryDir,
      nowIso: "2026-03-15T13:00:00.000Z",
      errors: [
        {
          stage: "snapshot",
          relativePath: "bank/fundamental/readiness/msft-artifact-error.json",
          fileName: "msft-artifact-error.json",
          manifestId: "msft-artifact-error",
          errorStatus: "blocked_due_to_artifact_error",
          errorMessage: "Expected ',' or '}' after property value in JSON at position 15",
        },
      ],
    });

    const artifactRecord = JSON.parse(
      await fs.readFile(
        path.join(
          workspaceDir,
          "bank",
          "fundamental",
          "artifact-errors",
          "snapshot-msft-artifact-error.json",
        ),
        "utf-8",
      ),
    ) as Record<string, unknown>;

    expect(artifactRecord.occurrenceCount).toBe(2);
    expect(artifactRecord.firstSeenAt).toBe("2026-03-15T12:00:00.000Z");
    expect(artifactRecord.lastSeenAt).toBe("2026-03-15T13:00:00.000Z");

    const memoryFiles = await fs.readdir(memoryDir);
    expect(memoryFiles).toEqual(["fundamental-artifact-error-snapshot-msft-artifact-error.md"]);
    const note = await fs.readFile(path.join(memoryDir, memoryFiles[0]), "utf-8");
    expect(note).toContain("occurrence_count: 2");
    expect(note).toContain("last_seen_at: 2026-03-15T13:00:00.000Z");

    const anomalyFiles = await fs.readdir(path.join(workspaceDir, buildWatchtowerArtifactDir("anomalies")));
    expect(anomalyFiles).toHaveLength(1);
    const anomaly = JSON.parse(
      await fs.readFile(
        path.join(workspaceDir, buildWatchtowerArtifactDir("anomalies"), anomalyFiles[0]),
        "utf-8",
      ),
    ) as { category: string; occurrenceCount: number; source: string };
    expect(anomaly.category).toBe("artifact_integrity");
    expect(anomaly.occurrenceCount).toBe(2);
    expect(anomaly.source).toBe("fundamental.snapshot");

    const ticketFiles = await fs.readdir(
      path.join(workspaceDir, buildWatchtowerArtifactDir("repairTickets")),
    );
    expect(ticketFiles).toHaveLength(1);
    const ticket = await fs.readFile(
      path.join(workspaceDir, buildWatchtowerArtifactDir("repairTickets"), ticketFiles[0]),
      "utf-8",
    );
    expect(ticket).toContain("# Repair Ticket Candidate: artifact_integrity");
    expect(ticket).toContain("- **Occurrences**: 2");
  });
});
