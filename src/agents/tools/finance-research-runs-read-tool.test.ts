import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { createFinanceResearchRunsReadTool } from "./finance-research-runs-read-tool.js";

async function workspace(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "finance-runs-read-"));
}

async function seedRun(root: string): Promise<void> {
  const runDir = path.join(root, "state", "finance-research-runs", "2026-09-20", "morning");
  await fs.mkdir(runDir, { recursive: true });
  await fs.writeFile(
    path.join(runDir, "runtime.json"),
    JSON.stringify({ manifest: { revision: "test_v1", models: ["fast-a"] } }),
  );
  await fs.writeFile(
    path.join(runDir, "response-01.json"),
    JSON.stringify({
      stage: "review",
      model: "fast-a",
      status: 200,
      choices: [{ index: 0, message: { role: "assistant", content: "窗口最大回撤 -28.689%" } }],
    }),
  );
}

type Payload = {
  ok?: boolean;
  available?: boolean;
  reason?: string;
  totalRuns?: number;
  runs?: Array<{ id: string; files: number; revision?: string }>;
  hits?: Array<{ file: string; stage?: string; snippet: string }>;
};

const call = async (params: Record<string, unknown>): Promise<Payload> => {
  const tool = createFinanceResearchRunsReadTool();
  const result = await tool.execute("call", params);
  const block = result.content?.[0];
  const text = block && "text" in block ? block.text : "{}";
  return JSON.parse(text) as Payload;
};

it("reports an absent runs directory as empty history rather than an error", async () => {
  const root = await workspace();
  const payload = await call({ workspaceDir: root, action: "list" });
  expect(payload.available).toBe(false);
  expect(payload.reason).toBe("no research runs directory");
  expect(payload.runs).toEqual([]);
});

it("lists stored runs with their manifest revision", async () => {
  const root = await workspace();
  await seedRun(root);
  const payload = await call({ workspaceDir: root, action: "list" });
  expect(payload.available).toBe(true);
  expect(payload.totalRuns).toBe(1);
  expect(payload.runs?.[0]?.id).toBe("2026-09-20/morning");
  expect(payload.runs?.[0]?.revision).toBe("test_v1");
  expect(payload.runs?.[0]?.files).toBe(2);
});

it("searches stored run text and reports the containing run and file", async () => {
  const root = await workspace();
  await seedRun(root);
  const payload = await call({ workspaceDir: root, action: "search", query: "最大回撤" });
  expect(payload.hits).toHaveLength(1);
  expect(payload.hits?.[0]?.file).toBe("response-01.json");
  expect(payload.hits?.[0]?.stage).toBe("review");
  expect(payload.hits?.[0]?.snippet).toContain("最大回撤");
});

it("refuses a run path that escapes the runs directory", async () => {
  const root = await workspace();
  await seedRun(root);
  const payload = await call({ workspaceDir: root, action: "read", run: "../outside" });
  expect(payload.ok).toBe(false);
});
