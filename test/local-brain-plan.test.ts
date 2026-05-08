import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(import.meta.dirname, "..");

describe("local-brain-plan adapter selection", () => {
  it("uses the guard resolver instead of a static legacy adapter", async () => {
    const source = await fs.readFile(
      path.join(repoRoot, "scripts/dev/local-brain-plan.ts"),
      "utf8",
    );

    expect(source).toContain("--resolve-current-adapter");
    expect(source).toContain("--bootstrap-if-missing");
    expect(source).toContain("trainingSeedAdapter");
    expect(source).toContain("adapterSelectionStatus");
    expect(source).not.toContain("thought-flow-v1-qwen3-0.6b-taxonomy-v3");
  });
});
