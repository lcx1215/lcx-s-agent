import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AnyAgentTool } from "./common.js";
import { createFinanceSourceHealthReadTool } from "./finance-source-health-read-tool.js";

/** A recent instant, so a seeded call counts as evidence rather than as expired. */
const AS_OF = new Date().toISOString();
const STALE = "2026-09-01T03:00:00Z";

const directories: string[] = [];
const previousStateDir = process.env.LCX_FINANCE_STATE_DIR;

async function tempDir(prefix: string): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  directories.push(directory);
  return directory;
}

afterEach(async () => {
  if (previousStateDir === undefined) {
    delete process.env.LCX_FINANCE_STATE_DIR;
  } else {
    process.env.LCX_FINANCE_STATE_DIR = previousStateDir;
  }
  await Promise.all(
    directories.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

/** A credentialed state dir plus a workspace holding one stored receipt. */
async function seed(params: { dispatchedAt?: string; withCredentials?: boolean } = {}) {
  const stateDir = await tempDir("finance-health-state-");
  const workspace = await tempDir("finance-health-workspace-");
  if (params.withCredentials !== false) {
    await fs.writeFile(
      path.join(stateDir, "credentials.env"),
      "FRED_API_KEY=fixture\nMASSIVE_API_KEY=fixture\n",
      { mode: 0o600 },
    );
  }
  process.env.LCX_FINANCE_STATE_DIR = stateDir;

  if (params.dispatchedAt !== undefined) {
    const collections = path.join(workspace, "memory", "finance-data-gateway", "collections");
    await fs.mkdir(collections, { recursive: true });
    await fs.writeFile(
      path.join(collections, "live.json"),
      JSON.stringify({
        schemaVersion: "lcx_finance_market_collection_v1",
        adaptersCalled: true,
        request: { asOf: AS_OF },
        status: "ready",
        sourceAttempts: [
          {
            adapterId: "gdelt_public_news",
            status: "succeeded",
            apiCalls: [{ dispatchedAt: params.dispatchedAt }],
          },
        ],
      }),
    );
  }
  return { stateDir, workspace };
}

/** The payload shape this tool returns, restated here so the assertions stay explicit. */
type Payload = {
  ok: boolean;
  boundary: string;
  noNetworkCalled: boolean;
  counts: { routes: number; configured: number; byCallState: Record<string, number> };
  configuredButNeverCalled: number;
  routeCount: number;
  configuredRouteCount: number;
  recentSuccessCount: number;
  reported: number;
  filtered: boolean;
  routes: {
    id: string;
    provider: string;
    configured: boolean;
    callState: string;
    lastObservation: { status: string; dispatchedAt: string } | null;
  }[];
  action?: string;
  notTouched: readonly string[];
};

async function read(tool: AnyAgentTool, params: Record<string, unknown>): Promise<Payload> {
  const result = await tool.execute("test", params);
  const text = result.content?.[0]?.type === "text" ? result.content[0].text : "";
  return JSON.parse(text.slice(text.indexOf("{")));
}

describe("finance source health read tool", () => {
  it("reports a recent successful call as usable evidence", async () => {
    const { workspace } = await seed({ dispatchedAt: AS_OF });
    // The inventory is far larger than the default page, so ask for all of it rather than relying
    // on where this route happens to sort.
    const payload = await read(createFinanceSourceHealthReadTool({ workspaceDir: workspace }), {
      limit: 500,
    });

    expect(payload.noNetworkCalled).toBe(true);
    expect(payload.boundary).toBe("inventory_and_recent_call_evidence_not_continuous_uptime");
    const route = payload.routes.find((entry: { id: string }) => entry.id === "gdelt_public_news");
    expect(route?.callState).toBe("recent_success");
    expect(route?.lastObservation?.status).toBe("succeeded");
  });

  it("separates 'never called' from 'called long ago'", async () => {
    // The two states look equally empty but demand opposite actions, so they must not collapse.
    const never = await seed();
    const neverPayload = await read(
      createFinanceSourceHealthReadTool({ workspaceDir: never.workspace }),
      { limit: 500 },
    );
    expect(neverPayload.counts.byCallState.unverified).toBeGreaterThan(0);
    expect(
      neverPayload.routes.find((entry: { id: string }) => entry.id === "gdelt_public_news")
        ?.callState,
    ).toBe("unverified");

    const stale = await seed({ dispatchedAt: STALE });
    const stalePayload = await read(
      createFinanceSourceHealthReadTool({ workspaceDir: stale.workspace }),
      { limit: 500 },
    );
    // An old receipt is expired evidence, not a source that was never reached. Reporting
    // `unverified` here would be indistinguishable from the case above and would tell the operator
    // nothing ever ran, so the seeded route must move out of `unverified` and into `expired`.
    const route = stalePayload.routes.find(
      (entry: { id: string }) => entry.id === "gdelt_public_news",
    );
    expect(route?.callState).toBe("verification_expired");
    expect(stalePayload.counts.byCallState.verification_expired).toBe(1);
    expect(stalePayload.configuredButNeverCalled).toBe(neverPayload.configuredButNeverCalled - 1);
  });

  it("filters by callState and provider without changing the underlying inventory", async () => {
    const { workspace } = await seed({ dispatchedAt: AS_OF });
    const tool = createFinanceSourceHealthReadTool({ workspaceDir: workspace });

    const onlySuccess = await read(tool, { callState: "recent_success" });
    expect(onlySuccess.reported).toBeGreaterThan(0);
    expect(onlySuccess.filtered).toBe(true);
    expect(
      onlySuccess.routes.every(
        (route: { callState: string }) => route.callState === "recent_success",
      ),
    ).toBe(true);

    const unknownProvider = await read(tool, { provider: "no_such_provider" });
    expect(unknownProvider.reported).toBe(0);
    expect(unknownProvider.routeCount).toBeGreaterThan(0);
  });

  it("explains an empty source inventory instead of implying every source is down", async () => {
    const { workspace } = await seed({ withCredentials: false });
    const payload = await read(createFinanceSourceHealthReadTool({ workspaceDir: workspace }), {});

    expect(payload.recentSuccessCount).toBe(0);
    // Without credentials every route is `not_configured_or_disabled`, which is a credentials gap,
    // not an outage. The action text has to say so rather than let the empty count speak.
    expect(payload.action).toContain("not_configured_or_disabled needs credentials");
    expect(payload.notTouched).toContain("trading_execution");
  });
});
