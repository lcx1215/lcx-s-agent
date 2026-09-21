import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApiFetch } from "./api-call-contract.js";
import {
  FINANCE_SOURCE_QUOTA_POLICIES,
  type FinanceQuotaLane,
  type FinanceQuotaPolicy,
} from "./finance-source-quota-policy.js";
import { createFinanceQuotaGuard, withFinanceQuotaLane } from "./finance-source-quota.js";
import { financeQuotaProbesDir, financeQuotaStateDir } from "./finance-state-dir.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});
const day = 86_400_000;
// Small enough to walk a whole budget in a test. Shares: production 10, calibration 4,
// diagnostics 2, shared reserve 4.
const DAY_LIMIT = 20;
const policy: FinanceQuotaPolicy = {
  id: "shared",
  provider: "shared",
  hosts: ["example.test"],
  minIntervalMs: 0,
  windows: [{ limit: DAY_LIMIT, durationMs: day }],
  basis: "conservative_unknown",
};

async function setup() {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "finance-quota-lane-"));
  roots.push(stateDir);
  const options = { stateDir, policies: [policy], now: () => Date.now() };
  const native = vi.fn<ApiFetch>(async () => ({
    status: 200,
    ok: true,
    headers: new Headers(),
    text: async () => "{}",
  }));
  return {
    stateDir,
    native,
    call: (lane?: FinanceQuotaLane) => {
      const guarded = createFinanceQuotaGuard(options).wrap(native);
      const run = () => guarded("https://example.test/quote");
      return lane === undefined ? run() : withFinanceQuotaLane(lane, run);
    },
    inspect: async () => (await createFinanceQuotaGuard(options).inspect())[0],
    readState: async () =>
      JSON.parse(
        await fs.readFile(path.join(financeQuotaStateDir(stateDir), "shared.json"), "utf8"),
      ) as { events: Array<Record<string, unknown>> },
  };
}

describe("finance quota allocation by purpose", () => {
  it("models FMP's documented per-day allowance as a day window, not a rolling 24 hours", () => {
    // A rolling window keeps a burst spent for a full extra day after the vendor has already
    // reset, which reads downstream as "this source has no data" rather than "we miscounted".
    const fmp = FINANCE_SOURCE_QUOTA_POLICIES.find((candidate) => candidate.id === "fmp");
    expect(fmp?.windows).toEqual([{ limit: 250, durationMs: day, alignment: "utc_day" }]);
  });

  it("lets a lone lane use the whole day budget instead of holding other shares idle", async () => {
    const fixture = await setup();
    for (let index = 0; index < DAY_LIMIT; index += 1) {
      await expect(fixture.call("production")).resolves.toBeDefined();
    }
    await expect(fixture.call("production")).rejects.toMatchObject({ kind: "budget_exhausted" });
  });

  it("caps a sweep at its own share plus the shared reserve so it cannot spend production's", async () => {
    const fixture = await setup();
    await fixture.call("production"); // production is using the provider, so lanes contend
    for (let index = 0; index < 6; index += 1) {
      // 2 own + 4 from the shared reserve
      await expect(fixture.call("diagnostics")).resolves.toBeDefined();
    }
    await expect(fixture.call("diagnostics")).rejects.toMatchObject({ kind: "budget_exhausted" });
    // Production's own share is untouched: 10 - 1 = 9 more, even though diagnostics is refused.
    for (let index = 0; index < 9; index += 1) {
      await expect(fixture.call("production")).resolves.toBeDefined();
    }
    await expect(fixture.call("production")).rejects.toMatchObject({ kind: "budget_exhausted" });
  });

  it("names the lane that ran out instead of claiming the provider has no credits", async () => {
    const fixture = await setup();
    await fixture.call("production");
    for (let index = 0; index < 6; index += 1) {
      await fixture.call("diagnostics");
    }
    // "budget_exhausted" alone reads as "FMP is out of credits". It is not the same claim as
    // "your sweep spent the diagnostics share", and only the second one is actionable.
    await expect(fixture.call("diagnostics")).rejects.toThrow(/lane "diagnostics"/u);
  });

  it("records which lane and which source spent each credit", async () => {
    const fixture = await setup();
    await fixture.call("diagnostics");
    const state = await fixture.readState();
    expect(state.events).toHaveLength(1);
    expect(state.events[0]).toMatchObject({ lane: "diagnostics", weight: 1 });
    expect(typeof state.events[0].source).toBe("string");
  });

  it("marks the calls that had to borrow from the shared reserve", async () => {
    const fixture = await setup();
    await fixture.call("production");
    for (let index = 0; index < 6; index += 1) {
      await fixture.call("diagnostics");
    }
    const state = await fixture.readState();
    const diagnostics = state.events.filter((event) => event.lane === "diagnostics");
    expect(diagnostics).toHaveLength(6);
    expect(diagnostics.filter((event) => event.fromReserve === true)).toHaveLength(4);
  });

  it("bills undecorated calls to production, because the loop's own work is the default", async () => {
    const fixture = await setup();
    await fixture.call();
    const state = await fixture.readState();
    expect(state.events[0].lane).toBe("production");
  });

  it("imports limit-probe measurements as diagnostics rather than billing them to production", async () => {
    const fixture = await setup();
    const probeDir = financeQuotaProbesDir(fixture.stateDir);
    await fs.mkdir(probeDir, { recursive: true });
    await fs.writeFile(
      path.join(probeDir, "probe-one-shared.json"),
      JSON.stringify({
        schemaVersion: "lcx_finance_quota_probe_v1",
        provider: "shared",
        adapterId: "shared_adapter",
        observations: [
          {
            calls: [
              {
                operation: "http_get",
                callId: "call-1",
                startedAt: new Date(Date.now() - 60_000).toISOString(),
              },
            ],
          },
        ],
      }),
    );
    await fixture.call("production");
    const state = await fixture.readState();
    const imported = state.events.find((event) => event.source === "shared_adapter");
    expect(imported).toMatchObject({ lane: "diagnostics" });
  });

  it("reports each lane's share, spend and remaining budget", async () => {
    const fixture = await setup();
    await fixture.call("production");
    await fixture.call("diagnostics");
    const report = await fixture.inspect();
    expect(report.lanes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ lane: "production", used: 1, own: 10, uncontended: false }),
        expect.objectContaining({ lane: "diagnostics", used: 1, own: 2, uncontended: false }),
      ]),
    );
  });
});
