import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentEventPayload } from "../infra/agent-events.js";
import * as safeFs from "../infra/fs-safe.js";
import {
  buildFinanceDataGatewaySnapshot,
  type FinanceDataProviderRole,
} from "./finance-data-gateway.js";
import { createFinanceReplyEvidenceTracker } from "./finance-reply-evidence.js";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});
async function fixture(
  options: {
    source?: boolean;
    quality?: boolean;
    accountId?: string;
    mode?: string;
    contextMissing?: boolean;
    evidenceText?: string;
  } = {},
) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "lcx-finance-evidence-unit-"));
  roots.push(root);
  const asOf = "2026-07-01T12:00:00.000Z";
  const snapshot = buildFinanceDataGatewaySnapshot({
    instrument: "BTCUSDT",
    assetClass: "crypto",
    useCase: "offline_unit",
    asOf,
    requireOfficialReference: true,
    observations: (
      [
        "primary_market_data",
        "cross_check_market_data",
        "official_or_issuer_reference",
      ] as FinanceDataProviderRole[]
    ).map((providerRole) => ({
      providerName: providerRole,
      providerRole,
      sourceFamily:
        providerRole === "official_or_issuer_reference" ? "official_filing" : "market_data_api",
      observedAt: asOf,
      timezone: "UTC",
      delayStatus: "realtime",
      fields: [
        {
          name: "last_price",
          value: 100,
          currency: "USD",
          fieldDefinition: "offline unit observed price",
          sourceTimestamp: asOf,
          sourceUrlOrArtifact: `fixture://${providerRole}/price`,
        },
      ],
    })),
  });
  const native = {
    boundary: "finance_research_run_research_only",
    quality: {
      status: options.quality === false ? "failed" : "verified",
      finalArtifact: options.contextMissing
        ? undefined
        : { claims: [{ status: "supported", evidenceIds: ["observed-price"] }] },
    },
    plan: {
      ...(options.accountId ? { portfolioContext: { accountId: options.accountId } } : {}),
      ...(options.mode ? { decisionMode: options.mode } : {}),
    },
    gates: [
      { id: "source", passed: options.source !== false, reason: "unit_source_gap" },
      { id: "quality", passed: options.quality !== false, reason: "unit_quality_gap" },
    ],
    batch: {
      jobs: [{ receipt: { snapshot } }],
      committeeEvidence: [
        { id: "observed-price", text: options.evidenceText ?? "Price is 100 USD." },
      ],
    },
  };
  const receiptPath = path.join(root, "state/finance-research-runs/unit.json");
  const bytes = JSON.stringify(native);
  await fs.mkdir(path.dirname(receiptPath), { recursive: true });
  await fs.writeFile(receiptPath, bytes);
  const receiptSha256 = createHash("sha256").update(bytes).digest("hex");
  const event: AgentEventPayload = {
    runId: "run",
    sessionKey: "session",
    seq: 1,
    ts: Date.now(),
    stream: "tool",
    data: {
      phase: "result",
      name: "finance_research_run",
      toolCallId: "call",
      isError: false,
      result: { details: { receiptPath, receiptSha256 } },
    },
  };
  const controller = new AbortController();
  const tracker = createFinanceReplyEvidenceTracker({
    workspaceDir: root,
    sessionKey: "session",
    signal: controller.signal,
  });
  tracker.start("run");
  const reference = {
    toolCallId: "call",
    receiptSha256,
    snapshotPointer: "/batch/jobs/0/receipt/snapshot",
    instrument: "BTCUSDT",
    asOf,
    ...(options.accountId ? { accountId: options.accountId } : {}),
  };
  const answer = (value = 100, changes: Record<string, unknown> = {}) =>
    `BTCUSDT price is ${value} USD.\n\`\`\`figures\n${JSON.stringify([{ kind: "observed", name: "last_price", value, unit: "USD" }])}\n\`\`\`\n\`\`\`finance_evidence\n${JSON.stringify({ ...reference, ...changes })}\n\`\`\``;
  return { root, tracker, event, controller, answer, receiptPath };
}
describe("same-invocation financial evidence host readback", () => {
  it("uses the original field/unit/value grounding and returns clean actually grounded text", async () => {
    const f = await fixture();
    f.tracker.observe(f.event);
    const result = await f.tracker.check(f.answer(), "review BTC");
    expect(result.status).toBe("verified");
    expect(result.grounding?.grounded[0]).toMatchObject({
      name: "last_price",
      value: 100,
      unit: "USD",
    });
    expect(result.text).toBe("BTCUSDT price is 100 USD.");
    expect(result.auditInput).toBeUndefined();
  });
  it.each(["research_only", "strategy_candidate", "conditional_trade_candidate", "live_execution"])(
    "selects the original %s mode and actual observed snapshot without promoting execution",
    async (mode) => {
      const f = await fixture({ mode, accountId: "original-paper" });
      f.tracker.observe(f.event);
      const result = await f.tracker.check(f.answer(), "review BTC");
      expect(result.status).toBe("verified");
      expect(result.auditInput?.financeDecisionMode).toBe(mode);
      expect(result.auditInput?.snapshot?.normalizedFields[0]?.value).toBe(100);
      expect(result.auditInput?.requireGrounding).toBeUndefined();
      if (mode !== "research_only") {
        expect(result.auditInput?.candidateContext?.evidence).toEqual([
          { id: "observed-price", text: "Price is 100 USD." },
        ]);
      }
    },
  );
  it.each([
    { mode: "unknown", gap: "finance_original_decision_mode_invalid" },
    {
      mode: "strategy_candidate",
      contextMissing: true,
      gap: "finance_original_candidate_context_not_observed",
    },
    {
      mode: "strategy_candidate",
      evidenceText: "x".repeat(12 * 1024),
      gap: "finance_original_audit_context_budget_exceeded",
    },
  ])(
    "retains an explicit audit input gap instead of defaulting or dropping evidence: $gap",
    async ({ gap, ...options }) => {
      const f = await fixture(options);
      f.tracker.observe(f.event);
      const result = await f.tracker.check(f.answer(), "review BTC");
      expect(result.status).toBe("verified");
      expect(result.auditInput).toBeUndefined();
      expect(result.auditInputGaps).toEqual([gap]);
    },
  );
  it("blocks drift and never revives a failed conclusion with a later corrected candidate", async () => {
    const f = await fixture();
    f.tracker.observe(f.event);
    expect((await f.tracker.check(f.answer(999), "review BTC")).reasons[0]).toBe(
      "finance_grounding_ungrounded",
    );
    expect((await f.tracker.check(f.answer(), "review BTC")).status).toBe("blocked");
  });
  it("isolates failed evidence from a new invocation while keeping same-run failures sticky", async () => {
    const f = await fixture();
    f.tracker.observe(f.event);
    expect((await f.tracker.check(f.answer(999), "review BTC")).status).toBe("blocked");
    f.tracker.start("run");
    expect((await f.tracker.check(f.answer(), "review BTC")).status).toBe("blocked");
    f.tracker.start("new-run");
    expect(f.tracker.hasReceipt()).toBe(false);
    f.tracker.observe(f.event);
    expect(f.tracker.hasReceipt()).toBe(false);
    f.tracker.observe({ ...f.event, runId: "new-run" });
    expect((await f.tracker.check(f.answer(), "review BTC")).status).toBe("verified");
  });
  it("rejects late old invocation filesystem success or failure without poisoning the new run", async () => {
    for (const rejectRead of [false, true]) {
      const f = await fixture();
      f.tracker.observe(f.event);
      let enter!: () => void;
      let release!: () => void;
      const entered = new Promise<void>((resolve) => {
        enter = resolve;
      });
      const deferred = new Promise<void>((resolve) => {
        release = resolve;
      });
      const original = safeFs.readFileWithinRoot;
      const read = vi
        .spyOn(safeFs, "readFileWithinRoot")
        .mockImplementationOnce(async (options) => {
          const bytes = await original(options);
          enter();
          await deferred;
          if (rejectRead) {
            throw new Error("private deferred read failure");
          }
          return bytes;
        });
      const pending = f.tracker.check(f.answer(), "review BTC");
      await entered;
      f.tracker.start("new-run");
      f.tracker.observe({ ...f.event, runId: "new-run" });
      release();
      const late = await pending;
      expect(late).toMatchObject({
        status: "blocked",
        text: "",
        reasons: ["finance_reply_scope_changed"],
      });
      expect(late.auditInput).toBeUndefined();
      expect((await f.tracker.check(f.answer(), "review BTC")).status).toBe("verified");
      read.mockRestore();
    }
  });
  it.each(["runId", "sessionKey"] as const)("cannot consume another %s", async (key) => {
    const f = await fixture();
    f.tracker.observe({ ...f.event, [key]: "other" });
    expect((await f.tracker.check(f.answer(), "review BTC")).reasons).toContain(
      "finance_tool_result_not_observed_in_current_scope",
    );
  });
  it.each(["source", "quality"] as const)(
    "preserves original %s failure diagnosis",
    async (gate) => {
      const f = await fixture({ [gate]: false });
      f.tracker.observe(f.event);
      expect((await f.tracker.check(f.answer(), "review BTC")).reasons).toContain(
        `${gate}_gate_failed:unit_${gate}_gap`,
      );
    },
  );
  it("rejects a cited hash conflict", async () => {
    const f = await fixture();
    f.tracker.observe(f.event);
    expect(
      (await f.tracker.check(f.answer(100, { receiptSha256: "a".repeat(64) }), "review BTC"))
        .reasons,
    ).toContain("finance_receipt_reference_hash_conflict");
  });
  it("rejects mutation after the actual tool result hash was pinned", async () => {
    const f = await fixture();
    f.tracker.observe(f.event);
    await fs.appendFile(f.receiptPath, " ");
    expect((await f.tracker.check(f.answer(), "review BTC")).reasons).toContain(
      "finance_receipt_source_hash_conflict",
    );
  });
  it("does not certify legacy receipts without an actual producer hash", async () => {
    const f = await fixture();
    f.event.data.result = { details: { receiptPath: f.receiptPath } };
    f.tracker.observe(f.event);
    expect((await f.tracker.check(f.answer(), "review BTC")).reasons).toContain(
      "finance_receipt_source_hash_not_observed",
    );
  });
  it("rejects wrong account, field pointer, instrument or timestamp instead of guessing", async () => {
    for (const changes of [
      { accountId: "wrong" },
      { snapshotPointer: "/batch/jobs/1/receipt/snapshot" },
      { instrument: "QQQ" },
      { asOf: "2025-01-01T00:00:00.000Z" },
    ]) {
      const f = await fixture({ accountId: "original-paper" });
      f.tracker.observe(f.event);
      expect((await f.tracker.check(f.answer(100, changes), "review BTC")).status).toBe("blocked");
    }
  });
  it("cancelled or stopped runs cannot accept late successful events", async () => {
    for (const abort of [true, false]) {
      const f = await fixture();
      f.tracker.observe(f.event);
      if (abort) {
        f.controller.abort();
      } else {
        f.tracker.stop();
      }
      f.tracker.start("new-run");
      f.tracker.observe({ ...f.event, runId: "new-run" });
      expect((await f.tracker.check(f.answer(), "review BTC")).reasons).toContain(
        "finance_reply_run_cancelled",
      );
    }
  });
  it("tool errors cannot be overwritten by a successful late result", async () => {
    const f = await fixture();
    f.tracker.observe({ ...f.event, data: { ...f.event.data, isError: true } });
    f.tracker.observe(f.event);
    expect((await f.tracker.check(f.answer(), "review BTC")).reasons).toContain(
      "finance_tool_failed",
    );
  });
  it("leaves math, explanation, technical truth and unreferenced text unchanged, without counting adoption", async () => {
    const f = await fixture();
    f.tracker.observe(f.event);
    for (const text of [
      "2 + 2 = 4",
      "protocol: tool_result, owner state queried",
      "Evidence is incomplete; this is a research explanation.",
    ]) {
      expect(await f.tracker.check(text, "question")).toMatchObject({
        status: "not_observed",
        text,
      });
    }
  });
  it("reports an explicit candidate budget gap rather than truncating referenced claims", async () => {
    const f = await fixture();
    f.tracker.observe(f.event);
    expect(
      (await f.tracker.check("x".repeat(12 * 1024) + f.answer(), "review BTC")).reasons,
    ).toContain("finance_reply_candidate_budget_exceeded");
  });
});
