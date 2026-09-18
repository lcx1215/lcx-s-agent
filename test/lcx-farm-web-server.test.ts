import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(import.meta.dirname, "..");

describe("LCX farm web projection view", () => {
  it("wires a display-only projection summary into the snapshot", async () => {
    const source = await fs.readFile(
      path.join(repoRoot, "scripts/operator/lcx-farm-web-server.ts"),
      "utf8",
    );

    expect(source).toContain("readGlobalEvidenceProjection");
    expect(source).toContain("readGlobalEvidenceProjectionForAdapter");
    expect(source).toContain("globalEvidenceProjectionReader");
    expect(source).toContain('adapterId: "farm-web-server"');
    expect(source).toContain('sourceOwner: "farm-web-server"');
    expect(source).toContain("globalEvidenceProjection,");
    expect(source).toContain("Projection status is display-only");
    expect(source).toContain("CONTROL_ROOM_LATEST_PATH");
    expect(source).toContain("const controlRoom = readJson(CONTROL_ROOM_LATEST_PATH)");
    expect(source).toContain("canonicalSource: CONTROL_ROOM_LATEST_PATH");
    expect(source).toContain("externalSchedulerBoundary");
    expect(source).not.toContain("stateRoot");
    expect(source).not.toContain("lcx-governance-autopilot-latest.json");
  });

  it("projects the central agent decision layer so the agent is visible, not just stored", async () => {
    const source = await fs.readFile(
      path.join(repoRoot, "scripts/operator/lcx-farm-web-server.ts"),
      "utf8",
    );

    expect(source).toContain('const centralAgentOwner = objectAt(owners, "centralAgent")');
    expect(source).toContain("brainOutcome");
    expect(source).toContain("approvedOwners");
    expect(source).toContain("registryTools");
    // The dashboard stays read-only: the projection must not grant the agent authority.
    expect(source).not.toContain("providerConfigTouched: true");
  });

  it("surfaces the context budget and evidence-write health, not only the plan", async () => {
    const source = await fs.readFile(
      path.join(repoRoot, "scripts/operator/lcx-farm-web-server.ts"),
      "utf8",
    );

    // A bound the harness applied is only honest if a human can see it; the same
    // goes for a cycle whose evidence could not be persisted.
    expect(source).toContain("contextBudget");
    expect(source).toContain("evidenceComplete");
    expect(source).toContain("evidenceWriteFailures");
    expect(source).toContain("centralAgentContextBudget");
    expect(source).toContain("centralAgentEvidenceComplete");
    expect(source).toContain("centralAgentEvidenceWriteFailures");
    // Tri-state readers, so an absent flag reads as unknown instead of false.
    expect(source).toContain("function booleanAt");
    expect(source).toContain("function optionalObjectAt");
    expect(source).toContain("function optionalArrayAt");
    // The collapsing readers must not be used for a health flag: `objectAt`
    // returns `{}` for absent, so `?? fallback` would never fire.
    expect(source).not.toContain('objectAt(centralAgentOwner, "contextBudget")');
  });

  it("projects the autopilot's own evidence health, not only the central agent's", async () => {
    const source = await fs.readFile(
      path.join(repoRoot, "scripts/operator/lcx-farm-web-server.ts"),
      "utf8",
    );

    // The autopilot receipt is reachable through the control room, but a curated
    // projection only shows what it names explicitly. Without this block a
    // partial governance cycle would look complete on the dashboard.
    expect(source).toContain("governanceEvidence");
    expect(source).toContain('booleanAt(autopilot, "evidenceComplete")');
    expect(source).toContain('optionalArrayAt(autopilot, "evidenceWriteFailures")');
    // Same tri-state rule as the central agent: never the collapsing reader.
    expect(source).not.toContain('objectAt(autopilot, "evidenceComplete")');
  });
});
