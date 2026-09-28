import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { requireNodeSqlite } from "../memory/sqlite.js";
import { openFinanceModelCheckpoints } from "./finance-model-checkpoints.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});
async function options() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "model-checkpoints-"));
  directories.push(dir);
  return {
    path: path.join(dir, "model.sqlite"),
    runId: "fixture",
    executionFingerprint: "v1",
    maxModelCalls: 2,
  };
}
describe("finance model checkpoints", () => {
  it("reuses stage results without new inference or new attestation", async () => {
    const opts = await options();
    let calls = 0;
    const original = {
      modelCalls: [{ evidence: "adapter-attested", callId: "original-call" }],
      qualityPassed: false,
    };
    const first = openFinanceModelCheckpoints(opts, { evidence: "frozen" });
    const invoke = first.invoker(async () => {
      calls++;
      return original;
    })!;
    await first.stage("committee", () => invoke({}, new AbortController().signal));
    first.close();
    const resumed = openFinanceModelCheckpoints(opts, { evidence: "frozen" });
    try {
      expect(
        await resumed.stage("committee", async () => {
          calls++;
          return {};
        }),
      ).toEqual(original);
      expect(calls).toBe(1);
      expect(resumed.summary()).toMatchObject({
        newModelCalls: 0,
        reservedModelCalls: 1,
        reusedStages: ["committee"],
        attestationScope: "original_execution_receipts",
      });
    } finally {
      resumed.close();
    }
  });
  it("charges failures and never renews budget on reopen", async () => {
    const opts = { ...(await options()), maxModelCalls: 1 };
    const first = openFinanceModelCheckpoints(opts, {});
    try {
      await expect(
        first.invoker(async () => {
          throw new Error("model failed");
        })!({}, new AbortController().signal),
      ).rejects.toThrow("model failed");
    } finally {
      first.close();
    }
    const resumed = openFinanceModelCheckpoints(opts, {});
    let invoked = false;
    try {
      expect(() =>
        resumed.invoker(async () => {
          invoked = true;
        })!({}, new AbortController().signal),
      ).toThrow("budget_exhausted");
      expect(invoked).toBe(false);
      expect(resumed.summary().reservedModelCalls).toBe(1);
    } finally {
      resumed.close();
    }
  });
  it("does not repeat a stage with an unknown outcome", async () => {
    const opts = await options();
    const first = openFinanceModelCheckpoints(opts, {});
    await expect(
      first.stage("quality", async () => {
        throw new Error("interrupted");
      }),
    ).rejects.toThrow("interrupted");
    first.close();
    const resumed = openFinanceModelCheckpoints(opts, {});
    try {
      await expect(resumed.stage("quality", async () => "must not run")).rejects.toThrow(
        "model_stage_outcome_unknown",
      );
    } finally {
      resumed.close();
    }
  });
  it("blocks changed evidence before model dispatch", async () => {
    const opts = await options();
    openFinanceModelCheckpoints(opts, { evidence: "old" }).close();
    expect(() => openFinanceModelCheckpoints(opts, { evidence: "new" })).toThrow("mismatch");
  });
  it("records transport outcomes without claiming contract acceptance", async () => {
    const opts = await options();
    const store = openFinanceModelCheckpoints(opts, {});
    await store.invoker(async () => ({ secret: "must not persist per-call output" }))!(
      {},
      new AbortController().signal,
    );
    store.close();
    const { DatabaseSync } = requireNodeSqlite();
    const db = new DatabaseSync(opts.path);
    try {
      const row = db
        .prepare("SELECT job_id, status, result FROM finance_checkpoint_nodes WHERE cost=1")
        .get()!;
      expect(row.job_id).toMatch(/^call:legacy:/);
      expect(row.status).toBe("completed");
      expect(JSON.parse(String(row.result))).toMatchObject({
        transportOutcome: "returned",
        contractAcceptance: "not_assessed",
      });
      expect(String(row.result)).not.toContain("secret");
    } finally {
      db.close();
    }
  });
  it("records bounded contract failures without changing or retaining the raw model output", async () => {
    const opts = await options();
    const store = openFinanceModelCheckpoints(opts, {});
    const output = { arbitrary: "model text" };
    const routing = store.routing({
      revision: "fixture",
      adapters: [
        {
          id: "fixture",
          provider: "fixture",
          modelId: "fixture",
          mode: "deterministic",
          capabilities: [],
          requiredTools: [],
          requiredSideEffects: [],
          invoke: async () => output,
        },
      ],
      defaultPolicy: {
        primary: "fixture",
        requiredCapabilities: [],
        maxInputBytes: 10000,
        timeoutMs: 1000,
        outputContract: {
          revision: "fixture",
          validate: () => false,
          describeFailure: () => "missing uncertainty ".repeat(100),
        },
      },
    })!;
    expect(
      await routing.adapters[0].invoke(
        {
          callId: "c",
          correlationId: "r",
          taskId: "draft",
          role: "research_draft",
          attempt: 1,
          provider: "fixture",
          modelId: "fixture",
          payload: {},
        },
        new AbortController().signal,
      ),
    ).toBe(output);
    store.close();
    const { DatabaseSync } = requireNodeSqlite();
    const db = new DatabaseSync(opts.path);
    try {
      const row = db.prepare("SELECT result FROM finance_checkpoint_nodes WHERE cost=1").get()!;
      const result = JSON.parse(String(row.result));
      expect(result.contractCheck.passed).toBe(false);
      expect(result.contractCheck.detail).toHaveLength(600);
      expect(result.contractAcceptance).toBe("not_assessed");
      expect(String(row.result)).not.toContain("model text");
    } finally {
      db.close();
    }
  });

  it("does not write late transport results into a closed checkpoint", async () => {
    const opts = await options();
    const store = openFinanceModelCheckpoints(opts, {});
    let finish!: (value: unknown) => void;
    const pending = store.invoker(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    )!({}, new AbortController().signal);
    store.close();
    finish("late");
    await expect(pending).resolves.toBe("late");
    const { DatabaseSync } = requireNodeSqlite();
    const db = new DatabaseSync(opts.path);
    try {
      expect(
        db.prepare("SELECT status FROM finance_checkpoint_nodes WHERE cost=1").get()?.status,
      ).toBe("reserved");
    } finally {
      db.close();
    }
  });
  it("does not charge or invoke a cancelled dispatch", async () => {
    const store = openFinanceModelCheckpoints(await options(), {});
    const controller = new AbortController();
    controller.abort();
    let invoked = false;
    try {
      expect(() =>
        store.invoker(async () => {
          invoked = true;
        })!({}, controller.signal),
      ).toThrow("cancelled_before_dispatch");
      expect(invoked).toBe(false);
      expect(store.summary().reservedModelCalls).toBe(0);
    } finally {
      store.close();
    }
  });
});
