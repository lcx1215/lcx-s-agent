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
    expect(source).toContain("summarizeGlobalEvidenceProjectionRead");
    expect(source).toContain('sourceOwner: "farm-web-server"');
    expect(source).toContain("globalEvidenceProjection,");
    expect(source).toContain("Projection status is display-only");
  });
});
