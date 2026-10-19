import { expect, it, vi } from "vitest";
const run = vi.hoisted(() =>
  vi.fn(async () => ({ status: "completed-unverified", verified: false })),
);
vi.mock("../coding-harness/native-coordinator.js", () => ({ runNativeCodingHarness: run }));
import { createNativeCodingHarnessTool } from "./native-coding-harness-tool.js";
const options = { workspaceDir: "/fixture", agentSessionKey: "agent:fixture:main", config: {} };
it("rejects model verification without controller authority", async () => {
  run.mockClear();
  const result = await createNativeCodingHarnessTool(options).execute("test", {
    task: "task",
    verify: ["echo", "pass"],
  });
  expect(result.details).toMatchObject({ status: "blocked" });
  expect(run).not.toHaveBeenCalled();
});
it("only accepts identical controller verification and freezes a copied argv", async () => {
  run.mockClear();
  const argv = ["python3", "trusted.py"];
  const tool = createNativeCodingHarnessTool({ ...options, verification: { argv } });
  argv[1] = "changed.py";
  expect(
    (await tool.execute("test", { task: "task", verify: ["python3", "changed.py"] })).details,
  ).toMatchObject({ status: "blocked" });
  await tool.execute("test", { task: "task", verify: ["python3", "trusted.py"] });
  expect(run).toHaveBeenCalledWith(
    expect.objectContaining({
      verification: expect.objectContaining({ argv: ["python3", "trusted.py"] }),
    }),
    undefined,
  );
});
it("blocks sandbox and missing trusted context before dispatch", async () => {
  run.mockClear();
  expect(
    (
      await createNativeCodingHarnessTool({ ...options, sandboxed: true }).execute("test", {
        task: "task",
      })
    ).details,
  ).toMatchObject({ status: "blocked" });
  expect(run).not.toHaveBeenCalled();
});
