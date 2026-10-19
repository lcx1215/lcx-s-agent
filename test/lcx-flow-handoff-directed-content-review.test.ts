import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildCommercialAcceptanceHarness } from "../scripts/operator/lcx-commercial-acceptance-harness.js";
import {
  inspectDirectedContentReview,
  reviewDirectedDailyCases,
} from "../scripts/operator/lcx-directed-daily-research-brief.js";
import * as qualityHarness from "../src/agents/quality-harness.js";
import {
  createDirectedContentReviewProbe,
  createRetainedDirectedContentReviewProbe,
  auditDirectedContentReviewHandoff,
  saveDirectedContentReviewEvidence,
} from "./fixtures/lcx-waterflow-directed-content-review-probe.js";

const execFileAsync = promisify(execFile);
let workspace: string;
beforeEach(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), "lcx-directed-review-"));
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Network forbidden")));
});
afterEach(async () => {
  await fs.rm(workspace, { recursive: true, force: true });
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
const gate = (result: ReturnType<typeof buildCommercialAcceptanceHarness>) =>
  result.gates.find((item) => item.id === "directed_daily_research_packet_pending");

type WatchlistFault =
  | "valid"
  | "bad_structure"
  | "bad_reference"
  | "missing_counterevidence"
  | "foreign_instrument"
  | "empty"
  | "oversize";

/** Change only the private model response; the original Quality and Caseflow owners still run. */
async function createWatchlistProbe(fault?: WatchlistFault) {
  const originalQuality = qualityHarness.runQualityHarness;
  const transportOutputs: unknown[] = [];
  const spy = vi.spyOn(qualityHarness, "runQualityHarness").mockImplementation(async (options) => {
    if (!options.modelRouting) {
      throw new Error("watchlist_producer_model_routing_missing");
    }
    return originalQuality({
      ...options,
      modelRouting: {
        ...options.modelRouting,
        adapters: options.modelRouting.adapters.map((adapter) => ({
          ...adapter,
          invoke: async (call, signal) => {
            const response = await adapter.invoke(call, signal);
            if (
              !fault ||
              typeof response !== "object" ||
              response === null ||
              !("kind" in response) ||
              response.kind !== "artifact" ||
              !("artifact" in response) ||
              typeof response.artifact !== "object" ||
              response.artifact === null
            ) {
              return response;
            }
            const payload = call.payload as { evidence?: readonly { id: string }[] };
            const id = payload.evidence?.[0]?.id;
            if (!id) {
              throw new Error("watchlist_producer_source_evidence_missing");
            }
            const entry = {
              instrument: fault === "foreign_instrument" ? "UNLISTED" : "QQQ",
              reason:
                fault === "oversize"
                  ? "x".repeat(5000)
                  : "Observe the supplied source within its timestamp; more data is required.",
              evidenceIds: [fault === "bad_reference" ? "unseen-evidence" : id],
              counterEvidenceIds: [],
              ...(fault === "missing_counterevidence"
                ? {}
                : {
                    counterEvidenceGap:
                      "Independent contrary observation is not supplied; this is an unresolved gap.",
                  }),
              invalidation:
                "Invalidate if independent contrary observations contradict the supplied source.",
            };
            const directedWatchlist = {
              coreTracking: [],
              needsData: fault === "empty" ? [] : [entry],
              downrankObservation: [],
              ...(fault === "bad_structure" ? {} : { discarded: [] }),
            };
            const previous =
              "supportingAnalysis" in response.artifact &&
              typeof response.artifact.supportingAnalysis === "object" &&
              response.artifact.supportingAnalysis !== null
                ? response.artifact.supportingAnalysis
                : {};
            const output = {
              ...response,
              artifact: {
                ...response.artifact,
                supportingAnalysis: { ...previous, directedWatchlist },
              },
            };
            transportOutputs.push({ callId: call.callId, original: response, response: output });
            return output;
          },
        })),
      },
    });
  });
  try {
    return {
      ...(await createDirectedContentReviewProbe(workspace, "timely_stock_candidates")),
      transportOutputs,
    };
  } finally {
    spy.mockRestore();
  }
}

const retainedDirectory = process.env.LCX_DIRECTED_RETAINED_BATCH_DIR;
describe.skipIf(!retainedDirectory)("retained same batch directed content review", () => {
  it("keeps unresolved and omitted causal fields explicit at the original review seam", async () => {
    const probe = await createRetainedDirectedContentReviewProbe(workspace, retainedDirectory!);
    const read = await probe.read();
    const section = read.packetCandidateSections.find((item) => item.status === "read_ready");
    if (
      !section?.packet?.supportingAnalysis ||
      !Array.isArray(section.packet.supportingAnalysis.causalHypotheses)
    ) {
      throw new Error("original causal field missing");
    }
    const selected = section.packet.supportingAnalysis.causalHypotheses as Array<
      Record<string, unknown>
    >;
    const conflict = structuredClone(read);
    const conflictSection = conflict.packetCandidateSections.find(
      (item) => item.taskId === section.taskId,
    )!;
    conflictSection.packet!.supportingAnalysis = {
      causalHypotheses: selected.map((item) => ({
        ...item,
        evidenceIds: ["foreign-task-evidence"],
      })),
    };
    expect(probe.input(conflict).structuralGaps).toContain(
      "daily_task_causal_evidence_reference_unresolved",
    );
    const oversized = structuredClone(read);
    const oversizedSection = oversized.packetCandidateSections.find(
      (item) => item.taskId === section.taskId,
    )!;
    oversizedSection.packet!.supportingAnalysis = {
      causalHypotheses: selected.map((item) => ({ ...item, mechanism: "x".repeat(5000) })),
    };
    const omitted = probe.input(oversized);
    expect(omitted.structuralGaps).toContain("daily_task_causal_input_budget_exceeded");
    const body = JSON.parse(
      omitted.request.evidence.find(
        (item) => item.id === `${section.taskId}:directed-candidate-body`,
      )!.text,
    );
    expect(body.causalHypotheses).toMatchObject({
      omitted: "input_budget_exceeded",
      field: "/packet/supportingAnalysis/causalHypotheses",
      limitBytes: 4096,
    });
    const absent = structuredClone(read);
    for (const item of absent.packetCandidateSections) {
      if (item.packet?.supportingAnalysis) {
        delete item.packet.supportingAnalysis.causalHypotheses;
      }
    }
    expect(
      probe.input(absent).structuralGaps.some((gap) => gap.startsWith("daily_task_causal")),
    ).toBe(false);
  });

  it("default unavailable model actually consumes three bound sections without adopting quality", async () => {
    const probe = await createRetainedDirectedContentReviewProbe(workspace, retainedDirectory!);
    const read = await probe.read();
    expect(read.packetCandidateSections.map((section) => section.status)).toEqual([
      "read_ready",
      "read_ready",
      "read_ready",
      "held",
    ]);
    const originalQuality = vi.spyOn(qualityHarness, "runQualityHarness");
    const result = await reviewDirectedDailyCases(probe.readerOptions);
    const input = probe.input(read);
    expect(originalQuality).toHaveBeenCalledOnce();
    const actualRequest = originalQuality.mock.calls[0]?.[0];
    expect(actualRequest?.allowProviderCalls).toBe(false);
    expect(actualRequest?.request).toEqual(input.request);
    for (const section of read.packetCandidateSections.filter(
      (item) => item.status === "read_ready",
    )) {
      const native = section.packet?.supportingAnalysis?.causalHypotheses;
      expect(Array.isArray(native)).toBe(true);
      const received = actualRequest?.request.evidence.find(
        (item) => item.id === `${section.taskId}:directed-candidate-body`,
      );
      if (!received || !Array.isArray(native)) {
        throw new Error("actual causal input missing");
      }
      const body = JSON.parse(received.text) as {
        causalHypotheses?: Array<{
          evidenceIds: string[];
          disconfirmingTest: string;
          status: string;
        }>;
      };
      expect(body.causalHypotheses).toEqual(
        native.map((hypothesis) => {
          const original = hypothesis as { evidenceIds: string[] };
          return {
            ...original,
            evidenceIds: original.evidenceIds.map((id) => `${section.taskId}:${id}`),
          };
        }),
      );
      expect(
        body.causalHypotheses?.every(
          (hypothesis) => hypothesis.status === "hypothesis" && hypothesis.disconfirmingTest,
        ),
      ).toBe(true);
    }
    expect(result.contentReview.quality?.task.sha256).toBe(
      createHash("sha256").update(input.request.task).digest("hex"),
    );
    expect(result.contentReview.status).toBe("failed");
    expect(result.contentReview.quality?.execution.realModelInferenceObserved).toBe(false);
    expect(result.contentReview.gaps).toContain("daily_task_review_model_unavailable");
    expect(result.contentReview.gaps).toEqual([
      ...input.structuralGaps,
      "daily_task_review_model_unavailable",
      "daily_task_quality:quality-failed",
      "daily_task_semantic_acceptance_not_observed",
    ]);
    expect(result.contentAcceptance).toBe("review_required");
    expect(input.scope.sections).toHaveLength(3);
    expect(
      input.request.evidence.some((item) => item.id.startsWith("risk_gate_and_learning_loop:")),
    ).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
    await saveDirectedContentReviewEvidence(workspace, "same-batch-native-no-adapter", {
      retainedSource: probe.retainedSource,
      read,
      actualQualityInput: actualRequest,
      result,
      naturalSemanticAcceptance: "not_observed",
    });
  });

  it("original quality transport sees actual batch bodies and rejects the missing watchlist task output", async () => {
    const probe = await createRetainedDirectedContentReviewProbe(workspace, retainedDirectory!);
    const read = await probe.read();
    const watchlist = read.packetCandidateSections.find(
      (section) => section.taskId === "timely_stock_candidates",
    );
    expect(watchlist?.status).toBe("read_ready");
    expect(watchlist?.packet?.analysis).toContain("three-month SPY strategy candidate");
    const output = await probe.run("task_coverage");
    const input = probe.input(read);
    expect(probe.requests.length).toBeGreaterThan(0);
    const expectedEvidence = new Map(input.request.evidence.map((item) => [item.id, item]));
    const actualEvidence = probe.requests.flatMap((request) => request.evidence);
    // The original quality owner splits this retained packet into bounded evidence batches.
    expect(
      actualEvidence.every(
        (item) =>
          item.text === expectedEvidence.get(item.id)?.text &&
          item.source === expectedEvidence.get(item.id)?.source,
      ),
    ).toBe(true);
    expect(new Set(actualEvidence.map((item) => item.id))).toEqual(
      new Set(expectedEvidence.keys()),
    );
    expect(
      probe.requests.some((request) =>
        request.evidence.some(
          (item) =>
            item.id === "timely_stock_candidates:directed-candidate-body" &&
            JSON.parse(item.text).analysis === watchlist?.packet?.analysis,
        ),
      ),
    ).toBe(true);
    expect(
      probe.prompts.some((prompt) => prompt.includes(watchlist?.packet?.analysis ?? "MISSING")),
    ).toBe(true);
    expect(JSON.stringify(output.result.contentReview.quality)).toContain(
      "offline_actual_watchlist_task_coverage_missing",
    );
    expect(output.result.contentReview.quality?.status).not.toBe("verified");
    expect(output.result.contentAcceptance).toBe("review_required");
    expect(gate(output.acceptance)?.status).toBe("blocked");
    expect(fetch).not.toHaveBeenCalled();
    await saveDirectedContentReviewEvidence(workspace, "same-batch-actual-watchlist-finding", {
      retainedSource: probe.retainedSource,
      read,
      actualQualityInput: input,
      actualModelRequests: probe.requests,
      actualModelReplies: probe.replies,
      actualRenderedPrompts: probe.prompts,
      ...output,
      modelTransport: "synthetic_offline_task_coverage_counterexample",
      naturalSemanticAcceptance: "not_observed",
    });
  });

  it("CLI explicitly reads pinned independent host while legacy missing host remains held", async () => {
    const probe = await createRetainedDirectedContentReviewProbe(workspace, retainedDirectory!);
    const guardPath = path.join(workspace, "deny-transport.mjs");
    const guardLog = path.join(workspace, "transport-attempts.jsonl");
    await fs.writeFile(guardLog, "");
    await fs.writeFile(
      guardPath,
      `import fs from "node:fs"; import http from "node:http"; import https from "node:https"; import cp from "node:child_process"; import { syncBuiltinESMExports } from "node:module";
const deny = name => () => { fs.appendFileSync(process.env.LCX_DIRECTED_DENY_TRANSPORT_LOG, JSON.stringify({name}) + "\\n"); throw new Error("offline_transport_forbidden:" + name); };
globalThis.fetch = deny("fetch"); http.request = deny("http.request"); http.get = deny("http.get"); https.request = deny("https.request"); https.get = deny("https.get"); cp.spawn = deny("spawn"); cp.execFile = deny("execFile"); cp.exec = deny("exec"); syncBuiltinESMExports();`,
    );
    const baseArgs = [
      "--import",
      "tsx",
      "--import",
      pathToFileURL(guardPath).href,
      "scripts/operator/lcx-directed-daily-research-brief.ts",
      "--json",
      "--date",
      probe.readerOptions.date!,
      "--case-bindings",
      probe.readerOptions.bindingsFile,
    ];
    const execOptions = {
      cwd: path.resolve(import.meta.dirname, ".."),
      env: {
        ...process.env,
        OPENCLAW_WORKSPACE_DIR: workspace,
        LCX_DIRECTED_DENY_TRANSPORT_LOG: guardLog,
      },
      timeout: 15_000,
      maxBuffer: 4 * 1024 * 1024,
    };
    const legacy = await execFileAsync(process.execPath, [...baseArgs, "--review"], execOptions);
    const legacyOutput = JSON.parse(legacy.stdout) as Awaited<
      ReturnType<typeof reviewDirectedDailyCases>
    >;
    expect(
      legacyOutput.packetCandidateSections.every(
        (section) =>
          section.status === "held" && section.gaps.includes("batch_host_scope_not_observed"),
      ),
    ).toBe(true);
    const hostArgs = [
      "--research-host",
      probe.retainedSource.host.path,
      "--research-host-sha",
      probe.retainedSource.host.sha256,
    ];
    const after = await execFileAsync(
      process.execPath,
      [...baseArgs, "--review", ...hostArgs],
      execOptions,
    );
    const output = JSON.parse(after.stdout) as Awaited<ReturnType<typeof reviewDirectedDailyCases>>;
    expect(output.packetCandidateSections.map((section) => section.status)).toEqual([
      "read_ready",
      "read_ready",
      "read_ready",
      "held",
    ]);
    expect(output.contentReview.status).toBe("failed");
    expect(output.contentReview.quality?.execution.realModelInferenceObserved).toBe(false);
    expect(output.contentReview.gaps).toContain("daily_task_review_model_unavailable");
    expect(output.contentReview.scope?.sections).toHaveLength(3);
    expect(output.contentReview.inputFingerprint).toBe(
      probe.input(await probe.read()).inputFingerprint,
    );
    await expect(
      execFileAsync(
        process.execPath,
        [...baseArgs, "--review", "--research-host", probe.retainedSource.host.path],
        execOptions,
      ),
    ).rejects.toMatchObject({ code: 1 });
    await expect(
      execFileAsync(process.execPath, [...baseArgs, ...hostArgs], execOptions),
    ).rejects.toMatchObject({ code: 1 });
    await expect(
      execFileAsync(
        process.execPath,
        [
          ...baseArgs,
          "--review",
          "--research-host",
          probe.retainedSource.host.path,
          "--research-host-sha",
          "0".repeat(64),
        ],
        execOptions,
      ),
    ).rejects.toMatchObject({ code: 1 });
    expect(await fs.readFile(guardLog, "utf8")).toBe("");
    await saveDirectedContentReviewEvidence(workspace, "same-batch-native-cli-host-bound", {
      retainedSource: probe.retainedSource,
      legacyStdout: legacy.stdout,
      legacyOutput,
      stdout: after.stdout,
      output,
      transportAttempts: await fs.readFile(guardLog, "utf8"),
      exit: 0,
      registeredAdapterSupplied: false,
    });
  }, 30_000);
});

describe("original directed daily content review handoff", () => {
  it("delivers the saved third-task four-tier field to original Quality without approving semantic truth", async () => {
    const probe = await createWatchlistProbe("valid");
    const read = await probe.read();
    const section = read.packetCandidateSections.find(
      (item) => item.taskId === "timely_stock_candidates",
    );
    expect(section?.status).toBe("read_ready");
    const watchlist = section?.packet?.supportingAnalysis?.directedWatchlist;
    expect(watchlist).toBeDefined();
    const groups = watchlist as Record<
      "coreTracking" | "needsData" | "downrankObservation" | "discarded",
      { evidenceIds: string[]; counterEvidenceIds?: string[] }[]
    >;
    const expectedWatchlist = Object.fromEntries(
      Object.entries(groups).map(([group, entries]) => [
        group,
        entries.map((entry) => ({
          ...entry,
          evidenceIds: entry.evidenceIds.map((id) => `timely_stock_candidates:${id}`),
          counterEvidenceIds: entry.counterEvidenceIds?.map(
            (id) => `timely_stock_candidates:${id}`,
          ),
        })),
      ]),
    );
    const output = await probe.run("reject");
    const actualBodies = probe.requests
      .flatMap((request) => request.evidence)
      .filter((item) => item.id === "timely_stock_candidates:directed-candidate-body")
      .map(
        (item) => JSON.parse(item.text) as { directedWatchlist: unknown; structuralGaps: string[] },
      );
    expect(actualBodies.length).toBeGreaterThan(0);
    for (const body of actualBodies) {
      expect(body.directedWatchlist).toEqual(expectedWatchlist);
    }
    expect(actualBodies.every((body) => body.structuralGaps.length === 0)).toBe(true);
    expect(probe.input(read).structuralGaps).toEqual([]);
    expect(output.result.contentReview.quality?.status).not.toBe("verified");
    expect(output.result.contentReview.gaps).toContain(
      "daily_task_semantic_acceptance_not_observed",
    );
    expect(gate(output.acceptance)?.status).toBe("blocked");
    expect(fetch).not.toHaveBeenCalled();
    await saveDirectedContentReviewEvidence(workspace, "watchlist-native-legal-quality-rejected", {
      producer: probe.producer,
      transportOutputs: probe.transportOutputs,
      read,
      actualQualityRequests: probe.requests,
      output,
    });
  });

  it.each([
    [undefined, "daily_task_watchlist_missing"],
    ["bad_structure", "daily_task_watchlist_structure_invalid"],
    ["bad_reference", "daily_task_watchlist_evidence_reference_unresolved:0"],
    ["missing_counterevidence", "daily_task_watchlist_counterevidence_not_observed:0"],
    ["foreign_instrument", "daily_task_watchlist_instrument_outside_universe:0"],
    ["empty", "daily_task_watchlist_empty_without_evidence_gap"],
    ["oversize", "daily_task_watchlist_input_budget_exceeded"],
  ] as const)(
    "original verifier rejects %s structure even if private reviewers pass",
    async (fault, expectedGap) => {
      const probe = await createWatchlistProbe(fault);
      const read = await probe.read();
      expect(
        read.packetCandidateSections.find((item) => item.taskId === "timely_stock_candidates")
          ?.status,
      ).toBe("read_ready");
      const output = await probe.run();
      expect(output.result.contentReview.gaps).toContain(expectedGap);
      expect(output.result.contentReview.quality?.verification).toMatchObject({
        status: "failed",
        details: expect.arrayContaining([expectedGap]),
      });
      const inspected = inspectDirectedContentReview(output.result);
      expect(inspected).toMatchObject({
        status: "bound_receipt",
        qualityPassed: false,
        gaps: expect.arrayContaining([expectedGap]),
      });
      const forgedQuality = structuredClone(output.result);
      if (!forgedQuality.contentReview.quality) {
        throw new Error("original_quality_receipt_missing");
      }
      const forged = {
        ...forgedQuality,
        contentReview: {
          ...forgedQuality.contentReview,
          quality: {
            ...forgedQuality.contentReview.quality,
            quality: { ...forgedQuality.contentReview.quality.quality, passed: true },
          },
        },
      };
      expect(inspectDirectedContentReview(forged)).toMatchObject({
        qualityPassed: false,
        gaps: expect.arrayContaining([expectedGap]),
      });
      expect(gate(output.acceptance)?.status).toBe("blocked");
      expect(fetch).not.toHaveBeenCalled();
      await saveDirectedContentReviewEvidence(workspace, `watchlist-native-${fault ?? "missing"}`, {
        producer: probe.producer,
        transportOutputs: probe.transportOutputs,
        read,
        actualQualityRequests: probe.requests,
        output,
        inspected,
      });
    },
  );

  it("retains specific missing watchlist gap when the original reviewer has no adapter", async () => {
    const probe = await createWatchlistProbe();
    const output = await reviewDirectedDailyCases(probe.readerOptions);
    expect(output.contentReview.gaps).toContain("daily_task_watchlist_missing");
    expect(output.contentReview.gaps).toContain("daily_task_review_model_unavailable");
    expect(output.contentReview.status).toBe("failed");
    expect(output.contentReview.quality?.execution.realModelInferenceObserved).toBe(false);
    await saveDirectedContentReviewEvidence(workspace, "watchlist-native-no-adapter", {
      producer: probe.producer,
      output,
    });
  });

  it("audits actual quality status to independent acceptance readback while retaining all missing scene nodes", async () => {
    const probe = await createDirectedContentReviewProbe(workspace);
    const output = await probe.run();
    const audited = await auditDirectedContentReviewHandoff(workspace, output);
    const scene = audited.audit.find(
      (item) => item.scenarioId === "directed_daily_research_brief_waterflow",
    );
    expect(scene?.status).toBe("handoff_gap");
    expect(scene?.semanticAdoption).toBe("not_proven");
    expect(
      scene?.gaps.some(
        (gap) =>
          gap.node === "daily_research_packet" &&
          /consumer_did_not_receive_output:review_panel|producer_field_cannot_serve_as_consumer_readback:review_panel|handoff_scope_conflict:review_panel/.test(
            gap.reason,
          ),
      ),
    ).toBe(false);
    expect(scene?.gaps.some((gap) => gap.node === "finance_research_modules")).toBe(true);
    await saveDirectedContentReviewEvidence(workspace, "actual-original-field-audit", {
      ...output,
      ...audited,
    });
  });
  it("consumes actual reader body, claims and evidence in original quality stages and original acceptance", async () => {
    const probe = await createDirectedContentReviewProbe(workspace);
    const before = await probe.read();
    expect(inspectDirectedContentReview(before).status).toBe("not_observed");
    const { result, acceptance } = await probe.run();
    expect(result.contentReview.quality?.status).toBe("verified");
    const qualityInput = probe.input(before);
    expect(result.contentReview.quality?.task.sha256).toBe(
      createHash("sha256").update(qualityInput.request.task).digest("hex"),
    );
    expect(result.contentReview.quality?.evidenceCoverage?.controller?.selectedEvidenceIds).toEqual(
      qualityInput.request.evidence.map((item) => item.id),
    );
    expect(result.contentReview.quality?.evidenceCoverage?.issues).toEqual([]);
    expect(result.contentReview.status).toBe("needs_review");
    expect(result.contentAcceptance).toBe("review_required");
    const request = probe.requests.find((item) => item.stage === "draft");
    expect(request?.sharedContext.candidateBodyEvidenceIds).toEqual(
      probe.input(before).request.sharedContext?.candidateBodyEvidenceIds,
    );
    expect(request?.evidence).toEqual(probe.input(before).request.evidence);
    expect(JSON.stringify(probe.requests)).toContain(
      before.packetCandidateSections[0]?.packet?.analysis,
    );
    expect(JSON.stringify(probe.requests)).not.toContain('"taskId":"risk_gate_and_learning_loop"');
    expect(inspectDirectedContentReview(result)).toMatchObject({
      status: "bound_receipt",
      qualityPassed: true,
      modelInputCoverageObserved: true,
      modelEvidenceMode: "adapter-attested",
    });
    expect(gate(acceptance)).toMatchObject({
      status: "blocked",
      evidence: { packetEvidenceStatus: "review_receipt_bound" },
    });
    expect(gate(acceptance)?.evidence.missingForAcceptance).toContain(
      "daily_learning_application_not_observed",
    );
    expect(
      probe.prompts.some((prompt) =>
        prompt.includes(before.packetCandidateSections[0]?.packet?.analysis ?? "MISSING"),
      ),
    ).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
    await saveDirectedContentReviewEvidence(workspace, "native-body-to-quality-to-acceptance", {
      before,
      producer: probe.producer,
      requests: probe.requests,
      replies: probe.replies,
      prompts: probe.prompts,
      result,
      acceptance,
      semanticAcceptance: "not_observed",
      realProviderCalls: 0,
    });
  });

  it.each(["missing_source", "hash_conflict", "cross_date", "task_conflict"])(
    "does not dispatch held sections for %s",
    async (fault) => {
      const probe = await createDirectedContentReviewProbe(workspace);
      if (fault === "missing_source") {
        await fs.rm(probe.producer.saved.path);
      }
      if (fault === "hash_conflict") {
        await fs.appendFile(probe.producer.saved.path, " ");
      }
      if (fault === "cross_date" || fault === "task_conflict") {
        const binding = {
          ...probe.binding.bindings,
          date: fault === "cross_date" ? "2026-10-10" : "2026-10-11",
          tasks: probe.binding.bindings.tasks.map((item) => ({
            ...item,
            ask: fault === "task_conflict" ? "unrelated task" : item.ask,
          })),
        };
        await fs.writeFile(probe.binding.file, JSON.stringify(binding));
      }
      const output = await probe.run();
      expect(probe.requests).toHaveLength(0);
      expect(output.result.contentReview.status).toBe("failed");
      expect(output.result.packetCandidateSections.every((item) => item.status === "held")).toBe(
        true,
      );
      expect(gate(output.acceptance)?.status).toBe("blocked");
      expect(fetch).not.toHaveBeenCalled();
      await saveDirectedContentReviewEvidence(workspace, fault, {
        ...output,
        requests: probe.requests,
        providerCalls: 0,
      });
    },
  );

  it.each(["reject", "unavailable", "reference_conflict", "candidate_self_reference"] as const)(
    "keeps %s model feedback pending or failed",
    async (fault) => {
      const probe = await createDirectedContentReviewProbe(workspace);
      const output = await probe.run(fault);
      expect(probe.requests.length).toBeGreaterThan(0);
      expect(output.result.contentReview.quality?.status).not.toBe("verified");
      expect(gate(output.acceptance)?.status).toBe("blocked");
      expect(output.result.contentAcceptance).toBe("review_required");
      expect(fetch).not.toHaveBeenCalled();
      await saveDirectedContentReviewEvidence(workspace, fault, {
        ...output,
        requests: probe.requests,
      });
    },
  );

  it("preserves an explicit uncertain claim without invented source references", async () => {
    const probe = await createDirectedContentReviewProbe(workspace);
    const output = await probe.run("uncertain");
    expect(output.result.contentReview.quality?.status).toBe("verified");
    expect(output.result.contentReview.quality?.finalArtifact?.claims[0]).toMatchObject({
      status: "uncertain",
      evidenceIds: [],
      uncertainty: expect.any(String),
    });
    expect(output.result.contentReview.status).toBe("needs_review");
    expect(gate(output.acceptance)?.status).toBe("blocked");
    await saveDirectedContentReviewEvidence(workspace, "explicit-uncertain-gap-compatible", {
      ...output,
      requests: probe.requests,
    });
  });

  it.each(["date", "body", "task", "source", "review_scope"])(
    "rejects bound receipt readback with changed %s",
    async (fault) => {
      const probe = await createDirectedContentReviewProbe(workspace);
      const { result } = await probe.run();
      const changed = structuredClone(result);
      if (fault === "date") {
        changed.date = "2026-10-10";
      }
      if (fault === "body") {
        changed.packetCandidateSections[0].packet!.analysis += " injected";
      }
      if (fault === "task") {
        changed.packetCandidateSections[0].taskId = "semiconductor_leader_board";
      }
      if (fault === "source") {
        changed.packetCandidateSections[0].source!.sourceSha256 = "a".repeat(64);
      }
      if (fault === "review_scope") {
        changed.contentReview.scope!.date = "2026-10-10";
      }
      expect(inspectDirectedContentReview(changed).status).toBe("scope_conflict");
      const acceptance = buildCommercialAcceptanceHarness({
        directedDailyResearchBrief: {
          ok: true,
          owner: "lcx-directed-daily-research-brief",
          command: "private changed readback",
          payload: changed,
        },
      });
      expect(gate(acceptance)?.evidence.packetEvidenceStatus).toBe("not_observed");
      await saveDirectedContentReviewEvidence(workspace, `readback-${fault}`, {
        changed,
        acceptance,
      });
    },
  );

  it.each(["body", "evidence"])(
    "does not reattach an old quality receipt after %s input and outer hashes are rewritten",
    async (fault) => {
      const probe = await createDirectedContentReviewProbe(workspace);
      const { result } = await probe.run();
      const changed = structuredClone(result);
      if (fault === "body") {
        changed.packetCandidateSections[0].packet!.analysis += " unrelated replacement";
      } else {
        changed.packetCandidateSections[0].evidence![0].text += " changed original evidence";
      }
      const rebuilt = probe.input(changed);
      changed.contentReview.inputFingerprint = rebuilt.inputFingerprint;
      changed.contentReview.scope = rebuilt.scope;
      expect(inspectDirectedContentReview(changed).status).toBe("scope_conflict");
      await saveDirectedContentReviewEvidence(workspace, `old-quality-receipt-${fault}`, {
        changed,
        originalQuality: result.contentReview.quality,
      });
    },
  );

  it("times out an actual original model call and does not revive after late response", async () => {
    const probe = await createDirectedContentReviewProbe(workspace);
    const output = await probe.run("late");
    expect(output.result.contentReview.status).toBe("failed");
    expect(output.result.contentReview.gaps).toContain("directed_content_review_deadline");
    expect(output.result.contentReview.cleanup).toContain("unconfirmed");
    const sealed = JSON.stringify(output.result);
    probe.releaseLate();
    await new Promise((resolve) => setTimeout(resolve, 35));
    expect(JSON.stringify(output.result)).toBe(sealed);
    expect(probe.modelAbortObserved()).toBe(true);
    expect(gate(output.acceptance)?.status).toBe("blocked");
    await saveDirectedContentReviewEvidence(workspace, "deadline-late-response", {
      ...output,
      requests: probe.requests,
      lateReplies: probe.replies,
      modelAbortObserved: probe.modelAbortObserved(),
    });
  });

  it("honors caller cancellation before dispatch", async () => {
    const probe = await createDirectedContentReviewProbe(workspace);
    const controller = new AbortController();
    controller.abort(new Error("offline_caller_cancelled"));
    const output = await probe.run(undefined, controller.signal);
    expect(probe.requests).toHaveLength(0);
    expect(output.result.contentReview.status).toBe("failed");
    expect(output.result.contentReview.cleanup).toBe("not_started");
    expect(output.result.contentReview.gaps).toContain("offline_caller_cancelled");
  });

  it("CLI review defaults to original unavailable model and writer retains the same failed review", async () => {
    const probe = await createDirectedContentReviewProbe(workspace);
    const defaultRead = await probe.read();
    expect(defaultRead).not.toHaveProperty("contentReview");
    const guardPath = path.join(workspace, "deny-transport.mjs");
    const guardLog = path.join(workspace, "transport-attempts.jsonl");
    await fs.writeFile(guardLog, "");
    await fs.writeFile(
      guardPath,
      `import fs from "node:fs"; import http from "node:http"; import https from "node:https"; import cp from "node:child_process"; import { syncBuiltinESMExports } from "node:module";
const deny = name => () => { fs.appendFileSync(process.env.LCX_DIRECTED_DENY_TRANSPORT_LOG, JSON.stringify({name}) + "\\n"); throw new Error("offline_transport_forbidden:" + name); };
globalThis.fetch = deny("fetch"); http.request = deny("http.request"); http.get = deny("http.get"); https.request = deny("https.request"); https.get = deny("https.get"); cp.spawn = deny("spawn"); cp.execFile = deny("execFile"); cp.exec = deny("exec"); syncBuiltinESMExports();`,
    );
    const { stdout } = await execFileAsync(
      process.execPath,
      [
        "--import",
        "tsx",
        "--import",
        pathToFileURL(guardPath).href,
        "scripts/operator/lcx-directed-daily-research-brief.ts",
        "--review",
        "--json",
        "--write",
        "--date",
        "2026-10-11",
        "--case-bindings",
        probe.binding.file,
      ],
      {
        cwd: path.resolve(import.meta.dirname, ".."),
        env: {
          ...process.env,
          OPENCLAW_WORKSPACE_DIR: workspace,
          LCX_DIRECTED_DENY_TRANSPORT_LOG: guardLog,
        },
        timeout: 15_000,
        maxBuffer: 4 * 1024 * 1024,
      },
    );
    const output = JSON.parse(stdout) as Awaited<ReturnType<typeof reviewDirectedDailyCases>> & {
      written: { latestJsonPath: string };
    };
    const transportAttempts = await fs.readFile(guardLog, "utf8");
    expect(transportAttempts).toBe("");
    expect(output.contentReview.quality?.modelPool.modelRoutingMode).toBe("shared_invoker");
    expect(output.contentReview.status).toBe("failed");
    expect(output.contentReview.quality?.execution.realModelInferenceObserved).toBe(false);
    expect(output.contentReview.quality?.execution.providerCallsMade).toBe("not-observed");
    const stored = JSON.parse(await fs.readFile(output.written.latestJsonPath, "utf8"));
    expect(stored.contentReview).toEqual(output.contentReview);
    expect(fetch).not.toHaveBeenCalled();
    await saveDirectedContentReviewEvidence(workspace, "native-cli-unavailable-writer", {
      stdout,
      output,
      stored,
      transportAttempts,
      sourceProviderCallsAllowed: false,
      registeredAdapterSupplied: false,
    });
  });
});
