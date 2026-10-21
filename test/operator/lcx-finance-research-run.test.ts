import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  writeReceipt,
  parseArgs,
  parseControllerResearchScope,
  compactFinanceResearchSummary,
  buildControllerNightResearchTargets,
  run,
  readControllerResearchInput,
} from "../../scripts/operator/lcx-finance-research-run.ts";
import {
  FINANCE_NIGHT_RESEARCH_SCOPE_EVIDENCE_ID,
  FINANCE_NIGHT_RESEARCH_SCOPE_EVIDENCE_SOURCE,
  FINANCE_NIGHT_RESEARCH_SCOPE_SCHEMA_VERSION,
  readFinanceActiveStrategyResearchScope,
} from "../../src/agents/finance-night-review-context.ts";
import { assertFinanceResearchRuleUse } from "../../src/agents/finance-research-portfolio-plan.js";
import {
  runFinanceResearchRun,
  type FinanceResearchRunReceipt,
} from "../../src/agents/finance-research-runner.js";
import {
  declareFinanceStrategyRule,
  activateFinanceStrategyRule,
} from "../../src/agents/finance-strategy-rule-ledger.js";

describe("controller rule-use validation", () => {
  async function prepare() {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "finance-rule-use-"));
    const asOf = "2026-10-05T19:30:00.000Z";
    await declareFinanceStrategyRule(directory, {
      kind: "declared",
      ruleId: "original-rule",
      form: "trend",
      instruments: ["SPY"],
      emits: "weights",
      schedule: { kind: "daily" },
      body: { frozenRule: { lookbackMonths: 6, budgetFraction: 0.4 } },
      observedAt: "2026-10-01T00:00:00Z",
    });
    await activateFinanceStrategyRule(directory, {
      kind: "activated",
      ruleId: "original-rule",
      observedAt: "2026-10-02T00:00:00Z",
    });
    const scope = await readFinanceActiveStrategyResearchScope({
      directory,
      asOf,
      strategyIds: ["original-rule"],
    });
    const evidence = structuredClone([...scope.evidence]);
    const active = evidence.find((item) => item.id === "finance-controller:active-strategies")!;
    const portfolioContext = {
      accountId: "private-rule-observer",
      venue: "paper" as const,
      validityMinutes: 60,
      conflictPolicy: "block" as const,
      activeStrategyIds: ["original-rule"],
      requiredInstruments: ["SPY"],
    };
    const use = {
      source: { ...scope.source, selectedRuleIds: [...scope.source.selectedRuleIds] },
      accountScope: { accountId: portfolioContext.accountId, venue: portfolioContext.venue, asOf },
      evidence: { id: active.id, sha256: createHash("sha256").update(active.text).digest("hex") },
    };
    return { directory, asOf, scope, evidence, active, portfolioContext, use };
  }
  it("validates an original ledger read without claiming the account owns the rule ledger", async () => {
    const fixture = await prepare();
    try {
      expect(() =>
        assertFinanceResearchRuleUse(
          fixture.use,
          fixture.evidence,
          fixture.portfolioContext,
          fixture.asOf,
        ),
      ).not.toThrow();
      expect(assertFinanceResearchRuleUse(undefined, [], undefined, fixture.asOf)).toBeUndefined();
    } finally {
      await fs.rm(fixture.directory, { recursive: true, force: true });
    }
  });
  it.each(["parent_run", "finance_state_dir"] as const)(
    "rejects %s in the original runner before a valid rule packet can return a dry plan",
    async (fault) => {
      const fixture = await prepare();
      try {
        const use = assertFinanceResearchRuleUse(
          fixture.use,
          fixture.evidence,
          fixture.portfolioContext,
          fixture.asOf,
        );
        if (!use) {
          throw new Error("original valid rule-use packet missing");
        }
        const model = vi.fn().mockRejectedValue(new Error("model forbidden"));
        await expect(
          runFinanceResearchRun({
            input: {
              ask: "Review the original active rule without executing trades.",
              asOf: fixture.asOf,
              decisionMode: "strategy_candidate",
              portfolioContext: fixture.portfolioContext,
              controllerEvidence: fixture.evidence,
              controllerRuleUse:
                fault === "parent_run" ? { ...use, parentRunId: "foreign-unbound-parent" } : use,
            },
            financeStateDir:
              fault === "finance_state_dir"
                ? path.join(fixture.directory, "foreign-rule-owner")
                : fixture.directory,
            workspaceDir: fixture.directory,
            liveFetch: false,
            allowProviderCalls: false,
            modelInvoker: model,
            batchOptions: { realtimeAdapters: [], collectionAdapters: [] },
          }),
        ).rejects.toThrow(
          fault === "parent_run"
            ? "controller rule use parent run mismatch"
            : "controller rule use finance state directory mismatch",
        );
        expect(model).not.toHaveBeenCalled();
      } finally {
        await fs.rm(fixture.directory, { recursive: true, force: true });
      }
    },
  );
  it.each(["missing", "hash", "body", "selected_ids", "account", "venue", "asof"] as const)(
    "rejects %s controller rule-use provenance before research",
    async (fault) => {
      const fixture = await prepare();
      try {
        if (fault === "missing") {
          fixture.evidence.splice(fixture.evidence.indexOf(fixture.active), 1);
        }
        if (fault === "hash") {
          fixture.use.evidence.sha256 = "0".repeat(64);
        }
        if (fault === "body") {
          const body = JSON.parse(fixture.active.text) as {
            activeRules: Array<{ body: { frozenRule: { budgetFraction: number } } }>;
          };
          body.activeRules[0].body.frozenRule.budgetFraction = 0.9;
          const activeIndex = fixture.evidence.indexOf(fixture.active);
          fixture.active = { ...fixture.active, text: JSON.stringify(body) };
          fixture.evidence[activeIndex] = fixture.active;
          // Rehash the envelope: the distinct selected-rule fingerprint must still reject replacement.
          fixture.use.evidence.sha256 = createHash("sha256")
            .update(fixture.active.text)
            .digest("hex");
        }
        if (fault === "selected_ids") {
          fixture.use.source.selectedRuleIds = ["foreign-rule"];
        }
        if (fault === "account") {
          fixture.use.accountScope.accountId = "foreign-account";
        }
        if (fault === "venue") {
          Object.assign(fixture.use.accountScope, { venue: "alpaca" });
        }
        if (fault === "asof") {
          fixture.use.accountScope.asOf = "2026-10-06T19:30:00.000Z";
        }
        expect(() =>
          assertFinanceResearchRuleUse(
            fixture.use,
            fixture.evidence,
            fixture.portfolioContext,
            fixture.asOf,
          ),
        ).toThrow();
      } finally {
        await fs.rm(fixture.directory, { recursive: true, force: true });
      }
    },
  );
});

describe("scheduled controller handoff input", () => {
  async function prepare() {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "finance-controller-handoff-"));
    const asOf = "2026-10-05T19:30:00.000Z";
    const portfolioContext = {
      accountId: "private-test-account",
      venue: "paper" as const,
      validityMinutes: 60,
      conflictPolicy: "block" as const,
      activeStrategyIds: ["private-rule"],
      requiredInstruments: ["SPY"],
    };
    const controllerEvidence = [
      {
        id: "private-controller",
        source: "private-source",
        timestamp: asOf,
        text: "Explicit local observation only; no execution authority.",
      },
    ];
    const evidencePath = path.join(directory, "controller-evidence.json");
    const contextPath = path.join(directory, "portfolio-context.json");
    const handoffPath = path.join(directory, "controller-handoff.json");
    const evidenceBytes = Buffer.from(JSON.stringify(controllerEvidence) + "\n");
    const contextBytes = Buffer.from(JSON.stringify(portfolioContext) + "\n");
    await fs.writeFile(evidencePath, evidenceBytes);
    await fs.writeFile(contextPath, contextBytes);
    const pin = (file: string, bytes: Buffer) => ({
      path: file,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      bytes: bytes.length,
    });
    const manifest = {
      schemaVersion: "finance_scheduled_research_handoff_v1",
      sourceScope: {
        runId: "e47e3bd0-c7ef-44f0-a4c8-f6bc5df2f2ad",
        accountId: portfolioContext.accountId,
        venue: portfolioContext.venue,
        asOf,
      },
      inputs: {
        controllerEvidence: pin(evidencePath, evidenceBytes),
        portfolioContext: pin(contextPath, contextBytes),
      },
    };
    return {
      directory,
      asOf,
      portfolioContext,
      controllerEvidence,
      evidencePath,
      contextPath,
      handoffPath,
      manifest,
    };
  }
  async function options(fixture: Awaited<ReturnType<typeof prepare>>, includeManifest = true) {
    const bytes = Buffer.from(JSON.stringify(fixture.manifest) + "\n");
    await fs.writeFile(fixture.handoffPath, bytes);
    return {
      bytes,
      parsed: parseArgs([
        "--live",
        "--workflow-models",
        "--write",
        "--decision-mode",
        "strategy_candidate",
        "--controller-evidence",
        fixture.evidencePath,
        "--portfolio-context",
        fixture.contextPath,
        ...(includeManifest
          ? [
              "--controller-handoff",
              fixture.handoffPath,
              "--controller-handoff-sha256",
              createHash("sha256").update(bytes).digest("hex"),
            ]
          : []),
      ]),
    };
  }
  it("reads the original pinned inputs and retains the independent scheduler source scope", async () => {
    const fixture = await prepare();
    try {
      const input = await options(fixture);
      const read = await readControllerResearchInput(input.parsed, fixture.asOf);
      expect(read.controllerEvidence).toEqual(fixture.controllerEvidence);
      expect(read.portfolioContext).toEqual(fixture.portfolioContext);
      expect(read.controllerHandoff).toMatchObject({
        ...fixture.manifest,
        producer: {
          sha256: createHash("sha256").update(input.bytes).digest("hex"),
          bytes: input.bytes.length,
        },
      });
      expect(read.controllerHandoff?.producer.path).toBe(input.parsed.controllerHandoffPath);
    } finally {
      await fs.rm(fixture.directory, { recursive: true, force: true });
    }
  });
  it.each([
    "manifest_hash",
    "evidence_hash",
    "context_bytes",
    "input_path",
    "account",
    "venue",
    "asof",
  ] as const)("rejects %s before returning controller inputs", async (fault) => {
    const fixture = await prepare();
    try {
      if (fault === "input_path") {
        fixture.manifest.inputs.controllerEvidence.path = path.join(
          fixture.directory,
          "other-evidence.json",
        );
      }
      if (fault === "account") {
        fixture.manifest.sourceScope.accountId = "other-private-account";
      }
      if (fault === "venue") {
        Object.assign(fixture.manifest.sourceScope, { venue: "alpaca" });
      }
      if (fault === "asof") {
        fixture.manifest.sourceScope.asOf = "2026-10-06T19:30:00.000Z";
      }
      const input = await options(fixture);
      if (fault === "manifest_hash") {
        await fs.appendFile(fixture.handoffPath, " ");
      }
      if (fault === "evidence_hash") {
        await fs.writeFile(
          fixture.evidencePath,
          JSON.stringify([{ ...fixture.controllerEvidence[0], text: "Replaced source bytes." }]) +
            "\n",
        );
      }
      if (fault === "context_bytes") {
        await fs.appendFile(fixture.contextPath, " ");
      }
      await expect(readControllerResearchInput(input.parsed, fixture.asOf)).rejects.toThrow(
        /handoff|controller|portfolio|hash|scope/iu,
      );
    } finally {
      await fs.rm(fixture.directory, { recursive: true, force: true });
    }
  });
  it("preserves legacy unbound input reads without fabricating a source scope", async () => {
    const fixture = await prepare();
    try {
      const input = await options(fixture, false);
      const read = await readControllerResearchInput(input.parsed, fixture.asOf);
      expect(read.controllerEvidence).toEqual(fixture.controllerEvidence);
      expect(read.portfolioContext).toEqual(fixture.portfolioContext);
      expect(read.controllerHandoff).toBeUndefined();
    } finally {
      await fs.rm(fixture.directory, { recursive: true, force: true });
    }
  });
});

describe("finance research thesis persistence option", () => {
  it("defaults to declared model capacity and accepts positive safe-integer token overrides", () => {
    expect(parseArgs([]).maxTokens).toBeUndefined();
    expect(parseArgs(["--max-tokens", "384000"]).maxTokens).toBe(384_000);
    for (const invalid of ["0", "-1", "1.5", "9007199254740992"]) {
      expect(() => parseArgs(["--max-tokens", invalid])).toThrow();
    }
  });

  it("requires a live, quality-verified workflow and an explicit state root", () => {
    expect(() => parseArgs(["--persist-theses"])).toThrow(
      /requires --live --workflow-models --write/,
    );
    expect(() => parseArgs(["--persist-theses", "--live", "--workflow-models", "--write"])).toThrow(
      /requires an exact --finance-state-dir/,
    );
    expect(() =>
      parseArgs([
        "--persist-theses",
        "--live",
        "--workflow-models",
        "--write",
        "--skip-quality",
        "--finance-state-dir",
        "/tmp/finance-state",
      ]),
    ).toThrow(/with quality enabled/);
  });

  it("accepts an explicitly named finance state directory", () => {
    const options = parseArgs([
      "--persist-theses",
      "--live",
      "--workflow-models",
      "--write",
      "--finance-state-dir",
      "./state/finance",
    ]);
    expect(options.financeStateDir).toBe(path.resolve("./state/finance"));
    expect(options.persistTheses).toBe(true);
  });

  it("accepts an explicit state directory for bounded source snapshots without thesis writes", () => {
    const options = parseArgs([
      "--live",
      "--workflow-models",
      "--write",
      "--finance-state-dir",
      "./state/finance",
    ]);
    expect(options.financeStateDir).toBe(path.resolve("./state/finance"));
    expect(options.persistTheses).toBe(false);
  });
});

describe("controller-owned night research scope", () => {
  it("uses equity close evidence for night review without requesting execution quotes", () => {
    const targets = buildControllerNightResearchTargets({
      ask: "Night review current portfolio risk, fresh news and latest evidence.",
      asOf: "2026-10-09T21:43:57.204Z",
      horizonMonths: 6,
      instruments: [
        { instrument: "SPY", assetClass: "us_equity", reasons: ["held_position"] },
        { instrument: "BTC/USD", assetClass: "crypto", reasons: ["held_position"] },
      ],
    });
    const equity = targets.find((target) => target.instrument === "SPY");
    expect(equity?.realtime).toBe(false);
    expect(equity?.collections?.map((collection) => collection.collection)).toEqual([
      "eod_history",
      "news",
    ]);
    expect(targets.find((target) => target.instrument === "BTC/USD")?.realtime).toMatchObject({
      freshnessMaxMinutes: 30,
    });
  });

  it("requires explicit evidence, exact finance root, and research-only mode", () => {
    expect(() => parseArgs(["--controller-research-scope"])).toThrow(
      /requires --controller-evidence/,
    );
    expect(() =>
      parseArgs([
        "--controller-research-scope",
        "--controller-evidence",
        "/tmp/night.json",
        "--live",
        "--workflow-models",
        "--write",
      ]),
    ).toThrow(/requires --finance-state-dir/);
    expect(() =>
      parseArgs([
        "--controller-research-scope",
        "--controller-evidence",
        "/tmp/night.json",
        "--finance-state-dir",
        "/tmp/finance",
        "--decision-mode",
        "strategy_candidate",
        "--live",
        "--workflow-models",
        "--write",
      ]),
    ).toThrow(/requires --decision-mode research_only/);
    const options = parseArgs([
      "--controller-research-scope",
      "--controller-evidence",
      "/tmp/night.json",
      "--finance-state-dir",
      "/tmp/finance",
      "--live",
      "--workflow-models",
      "--write",
    ]);
    expect(options.controllerResearchScope).toBe(true);
    expect(options.decisionMode).toBe("research_only");
  });

  it("builds exact typed targets without converting BTC/USD into equity or substituting from the ask", () => {
    const targets = buildControllerNightResearchTargets({
      ask: "Night review portfolio risk; do not infer instruments from this text.",
      asOf: "2026-09-29T00:00:00.000Z",
      horizonMonths: 6,
      instruments: [
        { instrument: "SPY", assetClass: "us_equity", reasons: ["held_position"] },
        { instrument: "BTC/USD", assetClass: "crypto", reasons: ["held_position"] },
      ],
    });
    expect(targets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ instrument: "SPY", assetClass: "us_equity" }),
        expect.objectContaining({ instrument: "BTC/USD", assetClass: "crypto" }),
      ]),
    );
    expect(
      targets.some((target) => target.instrument === "BTC/USD" && target.assetClass !== "crypto"),
    ).toBe(false);
    expect(targets.some((target) => target.instrument === "QQQ")).toBe(false);
  });

  it("accepts only one well-formed scope at the exact run asOf", () => {
    const asOf = "2026-09-29T00:00:00.000Z";
    const evidence = {
      id: FINANCE_NIGHT_RESEARCH_SCOPE_EVIDENCE_ID,
      source: FINANCE_NIGHT_RESEARCH_SCOPE_EVIDENCE_SOURCE,
      timestamp: asOf,
      text: JSON.stringify({
        schemaVersion: FINANCE_NIGHT_RESEARCH_SCOPE_SCHEMA_VERSION,
        asOf,
        activeStrategyIds: ["daily-trend"],
        instruments: [{ instrument: "BTC/USD", assetClass: "crypto", reasons: ["held_position"] }],
      }),
    };
    const parsed = parseControllerResearchScope([evidence], asOf);
    expect(parsed.instruments).toEqual([
      { instrument: "BTC/USD", assetClass: "crypto", reasons: ["held_position"] },
    ]);
    expect(() => parseControllerResearchScope([evidence], "2026-09-29T00:01:00.000Z")).toThrow(
      /does not match --as-of/,
    );
    expect(() =>
      parseControllerResearchScope([{ ...evidence, timestamp: "2026-09-28T23:59:00.000Z" }], asOf),
    ).toThrow(/evidence timestamp does not match --as-of/);
    expect(() => parseControllerResearchScope([evidence, evidence], asOf)).toThrow(
      /exactly one canonical night scope item/,
    );
    const invalid = {
      ...evidence,
      text: JSON.stringify({
        schemaVersion: FINANCE_NIGHT_RESEARCH_SCOPE_SCHEMA_VERSION,
        asOf,
        activeStrategyIds: [],
        instruments: [
          { instrument: "BTC/USD", assetClass: "us_equity", reasons: ["held_position"] },
        ],
      }),
    };
    expect(() => parseControllerResearchScope([invalid], asOf)).toThrow(
      /unsupported instrument identity/,
    );
    expect(() => parseControllerResearchScope([evidence], "2030-09-29T00:00:00.000Z")).toThrow(
      /non-future asOf/,
    );
  });

  it("preserves broker holding provenance for exact scope matching and refuses execution authority", () => {
    const asOf = "2026-09-29T00:00:00.000Z";
    const scope = {
      schemaVersion: FINANCE_NIGHT_RESEARCH_SCOPE_SCHEMA_VERSION,
      asOf,
      activeStrategyIds: [],
      instruments: [{ instrument: "BTC/USD", assetClass: "crypto", reasons: ["held_position"] }],
      holdingBasis: {
        source: "broker_reconciliation",
        snapshotRefs: ["a".repeat(64)],
        issues: [],
        omittedAccounts: 0,
        executionAuthority: "none",
      },
    };
    const evidence = (holdingBasis = scope.holdingBasis) => [
      {
        id: FINANCE_NIGHT_RESEARCH_SCOPE_EVIDENCE_ID,
        source: FINANCE_NIGHT_RESEARCH_SCOPE_EVIDENCE_SOURCE,
        timestamp: asOf,
        text: JSON.stringify({ ...scope, holdingBasis }),
      },
    ];
    expect(JSON.stringify(parseControllerResearchScope(evidence(), asOf))).toBe(
      JSON.stringify(scope),
    );
    expect(() =>
      parseControllerResearchScope(
        evidence({ ...scope.holdingBasis, executionAuthority: "alpaca:paper" }),
        asOf,
      ),
    ).toThrow();
    expect(() =>
      parseControllerResearchScope(
        evidence({ ...scope.holdingBasis, snapshotRefs: ["unverified"] }),
        asOf,
      ),
    ).toThrow();
  });

  it("validates overflow coverage metadata and rejects tampering or unsupported identities", () => {
    const asOf = "2026-09-29T00:00:00.000Z";
    const selected = Array.from({ length: 14 }, (_, index) => ({
      instrument: `A${String.fromCharCode(65 + index)}`,
      assetClass: "us_equity",
      reasons: ["active_strategy"],
    }));
    const deferred = ["ZZ", "ZY"].map((instrument) => ({
      instrument,
      assetClass: "us_equity",
      reasons: ["active_strategy"],
    }));
    const evidence = {
      id: FINANCE_NIGHT_RESEARCH_SCOPE_EVIDENCE_ID,
      source: FINANCE_NIGHT_RESEARCH_SCOPE_EVIDENCE_SOURCE,
      timestamp: asOf,
      text: JSON.stringify({
        schemaVersion: FINANCE_NIGHT_RESEARCH_SCOPE_SCHEMA_VERSION,
        asOf,
        activeStrategyIds: ["daily-trend"],
        instruments: selected,
        coverage: {
          totalInstrumentCount: 16,
          deferredInstruments: deferred,
          selectionMethod: "held_priority_et_date_rotation_v1",
        },
      }),
    };
    expect(parseControllerResearchScope([evidence], asOf).coverage).toMatchObject({
      totalInstrumentCount: 16,
      deferredInstruments: deferred,
    });
    const malformed = (coverage: unknown) => ({
      ...evidence,
      text: JSON.stringify({ ...JSON.parse(evidence.text), coverage }),
    });
    expect(() =>
      parseControllerResearchScope(
        [malformed({ ...JSON.parse(evidence.text).coverage, totalInstrumentCount: 17 })],
        asOf,
      ),
    ).toThrow(/coverage is invalid/);
    expect(() =>
      parseControllerResearchScope(
        [
          malformed({
            ...JSON.parse(evidence.text).coverage,
            deferredInstruments: [deferred[0], selected[0]],
          }),
        ],
        asOf,
      ),
    ).toThrow(/duplicate instrument/);
    expect(() =>
      parseControllerResearchScope(
        [
          malformed({
            ...JSON.parse(evidence.text).coverage,
            totalInstrumentCount: 15,
            deferredInstruments: [{ ...deferred[0], instrument: "BTC/USD" }],
          }),
        ],
        asOf,
      ),
    ).toThrow(/unsupported instrument identity/);
  });

  it("fails closed for conflicting, invalid, duplicate, or oversized typed scope", () => {
    const build = (
      instruments: readonly { instrument: string; assetClass: "us_equity" | "crypto" }[],
    ) =>
      buildControllerNightResearchTargets({
        ask: "portfolio",
        asOf: "2026-09-29T00:00:00.000Z",
        horizonMonths: 6,
        instruments: instruments.map((item) => ({ ...item, reasons: ["active_strategy"] })),
      });
    expect(() =>
      build([
        { instrument: "SPY", assetClass: "us_equity" },
        { instrument: "SPY", assetClass: "crypto" },
      ]),
    ).toThrow(/unsupported crypto instrument/);
    expect(() =>
      build([
        { instrument: "SPY", assetClass: "us_equity" },
        { instrument: "SPY", assetClass: "us_equity" },
      ]),
    ).toThrow(/duplicate instrument/);
    expect(() => build([{ instrument: "BTC/USD", assetClass: "us_equity" }])).toThrow(
      /unsupported us_equity instrument/,
    );
    expect(() =>
      build(
        Array.from({ length: 15 }, (_, index) => ({
          instrument: `A${String.fromCharCode(65 + index)}`,
          assetClass: "us_equity" as const,
        })),
      ),
    ).toThrow(/must contain 1-14 instruments/);
  });
});

it("keeps the scheduler protocol parseable while full evidence stays in the receipt", () => {
  const summary = {
    schemaVersion: "lcx_finance_research_operator_v1",
    boundary: "local_finance_research_run_only",
    status: "candidate" as const,
    answerDecision: "candidate_for_review" as const,
    gates: [],
    plan: { asOf: "2026-09-29T00:00:00Z" },
    written: { datedPath: "/synthetic/research.json", latestPath: "/synthetic/latest.json" },
    portfolioPlanWritten: "/synthetic/plan.json",
    portfolioPlanWrite: {
      path: "/synthetic/plan.json",
      sha256: "a".repeat(64),
      asOf: "2026-09-29T00:00:00Z",
      accountId: "paper-account",
      venue: "paper" as const,
    },
    intradayFeedbackReview: {
      schemaVersion: "finance_research_intraday_feedback_review_v1" as const,
      boundary:
        "reported_research_response_not_configuration_publication_execution_or_adoption" as const,
      inputCount: 0,
      respondedCount: 0,
      researchAccepted: false,
      entries: [],
      gaps: ["feedback_history_unavailable"],
    },
    unusedEvidence: "x".repeat(100000),
  };
  const compact = compactFinanceResearchSummary(summary);
  expect(JSON.stringify(compact).length).toBeLessThan(65536);
  expect(compact).toMatchObject({
    status: "candidate",
    plan: summary.plan,
    written: summary.written,
    portfolioPlanWritten: summary.portfolioPlanWritten,
    portfolioPlanWrite: summary.portfolioPlanWrite,
  });
  expect(compact.intradayFeedbackReview).toMatchObject({
    inputCount: 0,
    respondedCount: 0,
    unaddressedCount: 0,
    researchAccepted: false,
    gapCount: 1,
    details: "original_written_research_receipt",
  });
  expect(compact.intradayFeedbackReview).not.toHaveProperty("entries");
  expect(compact).not.toHaveProperty("unusedEvidence");
  expect(parseArgs(["--scheduler-summary"]).json).toBe(true);
});

it("rejects a portfolio context whose strategy id is not active before research starts", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "finance-research-context-"));
  vi.stubEnv("OPENCLAW_WORKSPACE_DIR", path.join(directory, "workspace"));
  try {
    const contextPath = path.join(directory, "portfolio-context.json");
    await fs.writeFile(
      contextPath,
      JSON.stringify({
        accountId: "paper-account",
        venue: "alpaca",
        validityMinutes: 60,
        conflictPolicy: "block",
        activeStrategyIds: ["missing-rule"],
      }),
    );
    const options = parseArgs([
      "--ask",
      "Review the active portfolio allocation",
      "--as-of",
      "2026-09-29T00:00:00.000Z",
      "--decision-mode",
      "strategy_candidate",
      "--portfolio-context",
      contextPath,
      "--finance-state-dir",
      directory,
      "--live",
      "--workflow-models",
      "--persist-theses",
      "--write",
    ]);
    await expect(run(options)).rejects.toThrow("not active in the controller ledger");
  } finally {
    vi.unstubAllEnvs();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

it("preserves reviewed portfolio abstention in the scheduler protocol without a plan path", () => {
  const portfolioAbstention = {
    reason: "No strategy has evidence for a positive allocation.",
    evidenceIds: ["rule-evidence"],
  };
  const compact = compactFinanceResearchSummary({
    schemaVersion: "lcx_finance_research_operator_v1",
    boundary: "local_finance_research_run_only",
    status: "candidate",
    answerDecision: "candidate_for_review",
    plan: { asOf: "2026-09-29T19:00:00.000Z" },
    gates: [{ id: "quality", passed: true, reason: "verified" }],
    portfolioAbstention,
  });
  expect(compact.portfolioAbstention).toEqual(portfolioAbstention);
  expect(compact.portfolioPlanWritten).toBeUndefined();
});

it("writes the exact archived bytes including newline and preserves their digest in compact protocol", async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "receipt-hash-"));
  vi.stubEnv("OPENCLAW_WORKSPACE_DIR", workspace);
  try {
    const receipt = {
      plan: { asOf: "2026-10-04T00:00:00Z", ask: "diagnostic" },
      status: "needs_review",
    } as FinanceResearchRunReceipt;
    const written = await writeReceipt(receipt, receipt.plan.asOf, {
      workspaceDir: workspace,
      config: {
        agents: { defaults: { memorySearch: { enabled: false } } },
      },
    });
    const bytes = await fs.readFile(written.datedPath);
    expect(bytes.at(-1)).toBe(10);
    expect(written.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
    expect(await fs.readFile(written.latestPath)).toEqual(bytes);
    expect(
      compactFinanceResearchSummary({
        schemaVersion: "fixture",
        boundary: "fixture",
        status: "needs_review",
        answerDecision: "return_failed_reason",
        gates: [],
        plan: { asOf: receipt.plan.asOf },
        written,
      } as Parameters<typeof compactFinanceResearchSummary>[0]).written,
    ).toEqual(written);
  } finally {
    vi.unstubAllEnvs();
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

it("registers the complete written research and keeps disabled indexing separate from storage", async () => {
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "research-result-index-"));
  try {
    const { runFinanceResearchRun } = await import("../../src/agents/finance-research-runner.js");
    const receipt = await runFinanceResearchRun({
      input: { ask: "Offline risk review", asOf: "2026-10-01T00:00:00.000Z" },
    });
    const written = await writeReceipt(receipt, receipt.plan.asOf, {
      workspaceDir,
      config: {
        agents: {
          defaults: {
            memorySearch: {
              enabled: true,
              store: { path: path.join(workspaceDir, "memory.sqlite") },
            },
          },
        },
      },
    });
    expect(written.artifactEvidence.status).toBe("registered");
    const envelope = JSON.parse(
      await fs.readFile(path.join(workspaceDir, written.artifactEvidence.relativePath!), "utf8"),
    );
    expect(envelope.value.details.receipt).toEqual(receipt);
    expect(envelope.sourceReceiptRefs).toEqual([written.datedPath, `sha256:${written.sha256}`]);
    expect(JSON.parse(await fs.readFile(written.datedPath, "utf8"))).toEqual(receipt);
    const disabled = await writeReceipt(receipt, receipt.plan.asOf, {
      workspaceDir,
      config: {
        agents: { defaults: { memorySearch: { enabled: false } } },
      },
    });
    expect(disabled.artifactEvidence).toMatchObject({
      status: "unavailable",
      reason: "artifact_recording_disabled",
    });
    expect(JSON.parse(await fs.readFile(disabled.datedPath, "utf8"))).toEqual(receipt);
  } finally {
    await fs.rm(workspaceDir, { recursive: true, force: true });
  }
});
