import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { buildCommercialAcceptanceHarness } from "../../scripts/operator/lcx-commercial-acceptance-harness.js";
import {
  buildDirectedContentReviewInput,
  readDirectedDailyCases,
  reviewDirectedDailyCases,
} from "../../scripts/operator/lcx-directed-daily-research-brief.js";
import {
  auditWorkflowHandoffs,
  type WorkflowHandoffEvidence,
} from "../../scripts/operator/lcx-flow-graph.js";
import { buildQualityHarnessModelPromptWithCoverage } from "../../src/agents/local-text-model-adapter.js";
import type {
  LogicalAgentModelAdapter,
  LogicalAgentModelRouting,
  ModelCallObservation,
} from "../../src/agents/logical-agent-model-router.js";
import type { QualityHarnessModelRequest } from "../../src/agents/quality-harness-contract.js";
import {
  produceDirectedCase,
  writeDirectedBindings,
} from "./lcx-waterflow-directed-case-read-probe.js";

export type DirectedReviewFault =
  | "reject"
  | "unavailable"
  | "late"
  | "reference_conflict"
  | "uncertain"
  | "task_coverage"
  | "candidate_self_reference";
/** Only original producers, private filesystem and lowest model transport substitutes. */
export async function createDirectedContentReviewProbe(workspace: string, taskId?: string) {
  const producer = await produceDirectedCase({
    directory: path.join(workspace, "cases"),
    caseId: "directed-content-native",
    taskId,
  });
  const binding = await writeDirectedBindings(workspace, producer, taskId);
  const readerOptions = { workspaceDir: workspace, date: "2026-10-11", bindingsFile: binding.file };
  return { producer, binding, ...(await createReaderContentReviewProbe(readerOptions)) };
}

/** Reuse original retained bytes without regenerating research or changing case identities. */
export async function createRetainedDirectedContentReviewProbe(
  workspace: string,
  retainedDirectory: string,
) {
  const retained = JSON.parse(
    await fs.readFile(path.join(retainedDirectory, "native-result.json"), "utf8"),
  ) as {
    result: { date: string; caseBindingsSource: { sourceRef: string; sourceSha256: string } };
  };
  await fs.cp(path.join(retainedDirectory, "private-bytes"), workspace, { recursive: true });
  const hostBytes = await fs.readFile(path.join(workspace, "independent-host.json"));
  const batchHost = JSON.parse(hostBytes.toString("utf8")) as NonNullable<
    Parameters<typeof readDirectedDailyCases>[0]["batchHost"]
  >;
  const readerOptions = {
    workspaceDir: workspace,
    date: retained.result.date,
    bindingsFile: retained.result.caseBindingsSource.sourceRef,
    batchHost,
  };
  const bindingBytes = await fs.readFile(path.join(workspace, readerOptions.bindingsFile));
  const bindingSha256 = createHash("sha256").update(bindingBytes).digest("hex");
  if (bindingSha256 !== retained.result.caseBindingsSource.sourceSha256) {
    throw new Error("retained original binding hash conflict");
  }
  return {
    ...(await createReaderContentReviewProbe(readerOptions)),
    retainedSource: {
      path: path.join(retainedDirectory, "native-result.json"),
      sha256: createHash("sha256")
        .update(await fs.readFile(path.join(retainedDirectory, "native-result.json")))
        .digest("hex"),
      bindingSha256,
      host: {
        path: "independent-host.json",
        sha256: createHash("sha256").update(hostBytes).digest("hex"),
        value: batchHost,
      },
    },
  };
}

async function createReaderContentReviewProbe(
  readerOptions: Parameters<typeof readDirectedDailyCases>[0],
) {
  const requests: QualityHarnessModelRequest[] = [];
  const replies: unknown[] = [];
  const prompts: string[] = [];
  const promptCoverage = new Map<string, ModelCallObservation["evidenceCoverage"]>();
  let releaseLate: (() => void) | undefined;
  let modelAbortObserved = false;
  const read = () => readDirectedDailyCases(readerOptions);
  const run = async (fault?: DirectedReviewFault, signal?: AbortSignal) => {
    const adapter: LogicalAgentModelAdapter = {
      id: "offline-directed-review",
      provider: "fixture",
      modelId: "offline-directed-review",
      mode: "adapter",
      capabilities: ["quality_harness"],
      requiredTools: [],
      requiredSideEffects: [],
      invoke: async (call, abortSignal) => {
        const request = call.payload as QualityHarnessModelRequest;
        requests.push(request);
        const rendered = buildQualityHarnessModelPromptWithCoverage(request);
        prompts.push(rendered.prompt);
        promptCoverage.set(call.callId, rendered.evidenceCoverage);
        abortSignal.addEventListener(
          "abort",
          () => {
            modelAbortObserved = true;
          },
          { once: true },
        );
        if (fault === "unavailable") {
          throw new Error("offline_review_model_unavailable");
        }
        if (fault === "late") {
          await new Promise<void>((resolve) => {
            releaseLate = resolve;
          });
        }
        let reply: unknown;
        if (request.stage === "intake") {
          reply = {
            kind: "plan",
            requirements: ["Review source-bound daily task coverage"],
            missingEvidence: [],
          };
        } else if (request.stage === "draft" || request.stage === "format") {
          const id =
            fault === "candidate_self_reference"
              ? (request.evidence.find((item) => item.id.endsWith(":directed-candidate-body"))
                  ?.id ?? "missing")
              : (request.evidence[0]?.id ?? "missing");
          reply = {
            kind: "artifact",
            artifact: {
              answer:
                "A rewritten research-only summary keeps the supplied timestamps, uncertainty and missing daily-task coverage explicit.",
              claims: [
                {
                  id: "review-claim",
                  text: "The candidate remains limited by the supplied source coverage.",
                  status: fault === "uncertain" ? "uncertain" : "supported",
                  uncertainty:
                    fault === "uncertain"
                      ? "Missing independent evidence for this point; retain it as unresolved."
                      : undefined,
                  evidenceIds:
                    fault === "uncertain"
                      ? []
                      : [fault === "reference_conflict" ? "other-task:unseen" : id],
                  epistemicClass: "inference",
                  basis: "Actual supplied evidence and candidate scope",
                  evidenceRelations:
                    fault === "uncertain"
                      ? []
                      : [
                          {
                            evidenceId: fault === "reference_conflict" ? "other-task:unseen" : id,
                            relation: "supports",
                          },
                        ],
                },
              ],
            },
          };
        } else {
          const watchlist = request.evidence.find(
            (item) => item.id === "timely_stock_candidates:directed-candidate-body",
          );
          const watchlistBody = watchlist
            ? (JSON.parse(watchlist.text) as { analysis?: string })
            : undefined;
          const missingWatchlist =
            fault === "task_coverage" &&
            watchlistBody &&
            !["核心跟踪", "需要数据", "降权观察", "丢弃"].every((tier) =>
              watchlistBody.analysis?.includes(tier),
            );
          reply = {
            kind: "review",
            review: {
              verdict: fault === "reject" || missingWatchlist ? "reject" : "pass",
              criticalFindings:
                fault === "reject"
                  ? ["offline_task_coverage_rejected"]
                  : missingWatchlist
                    ? [
                        "offline_actual_watchlist_task_coverage_missing: candidate has no declared watchlist tiers",
                      ]
                    : [],
              evidenceGaps: [],
              notes: request.evidence.map(
                (item) => `[${item.id}] actually supplied to this offline review.`,
              ),
            },
          };
        }
        replies.push(reply);
        return reply;
      },
      observe: (call) => ({
        callId: call.callId,
        provider: "fixture",
        modelId: "offline-directed-review",
        transportRequestId: `offline:${call.callId}`,
        kind: "model_inference",
        evidenceCoverage: promptCoverage.get(call.callId),
      }),
    };
    const modelRouting: LogicalAgentModelRouting = {
      revision: "offline-directed-content-review-v1",
      adapters: [adapter],
      defaultPolicy: {
        primary: adapter.id,
        requiredCapabilities: ["quality_harness"],
        maxInputBytes: 1_000_000,
        timeoutMs: fault === "late" ? 20 : 1_000,
      },
    };
    const result = await reviewDirectedDailyCases({
      ...readerOptions,
      qualityOptions: { modelRouting, signal, taskTimeoutMs: fault === "late" ? 20 : 1_000 },
      timeoutMs: fault === "late" ? 10 : 5_000,
    });
    const acceptance = buildCommercialAcceptanceHarness({
      directedDailyResearchBrief: {
        ok: result.ok,
        owner: "lcx-directed-daily-research-brief",
        command: "explicit offline review",
        payload: result,
      },
    });
    return { result, acceptance };
  };
  return {
    readerOptions,
    requests,
    replies,
    prompts,
    read,
    run,
    input: buildDirectedContentReviewInput,
    releaseLate: () => releaseLate?.(),
    modelAbortObserved: () => modelAbortObserved,
  };
}

export async function saveDirectedContentReviewEvidence(
  workspace: string,
  name: string,
  result: unknown,
) {
  const directory = process.env.LCX_DIRECTED_CONTENT_REVIEW_PROOF_DIR;
  if (!directory) {
    return;
  }
  const target = path.join(directory, name);
  await fs.mkdir(target, { recursive: true });
  await fs.cp(workspace, path.join(target, "private-source"), { recursive: true });
  await fs.writeFile(
    path.join(target, "original-handoff.json"),
    JSON.stringify(result, null, 2) + "\n",
  );
}

/** Exact original producer fields and independent acceptance readback; other scene gaps remain. */
export async function auditDirectedContentReviewHandoff(
  workspace: string,
  output: Awaited<ReturnType<Awaited<ReturnType<typeof createDirectedContentReviewProbe>>["run"]>>,
) {
  const receiptPath = process.env.LCX_DIRECTED_CONTENT_REVIEW_PROOF_DIR
    ? path.join(
        process.env.LCX_DIRECTED_CONTENT_REVIEW_PROOF_DIR,
        "actual-original-field-audit",
        "native-handoff-receipt.json",
      )
    : path.join(workspace, "original-directed-review-handoff.json");
  await fs.mkdir(path.dirname(receiptPath), { recursive: true });
  const bytes = JSON.stringify(output, null, 2) + "\n";
  await fs.writeFile(receiptPath, bytes);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const index = output.acceptance.gates.findIndex(
    (gate) => gate.id === "directed_daily_research_packet_pending",
  );
  const consumer = `/acceptance/gates/${index}/evidence/contentReview`;
  const ref = (pointer: string) => ({ path: receiptPath, sha256, pointer });
  const evidence: WorkflowHandoffEvidence[] = [
    {
      scenarioId: "directed_daily_research_brief_waterflow",
      environment: "offline_fixture",
      nodes: [
        {
          nodeId: "review_panel",
          scope: ref("/result/contentReview/inputFingerprint"),
          output: ref("/result/contentReview/quality/status"),
        },
        {
          nodeId: "daily_research_packet",
          scope: ref(`${consumer}/inputFingerprint`),
          output: ref(consumer),
          inputs: [{ from: "review_panel", value: ref(`${consumer}/qualityStatus`) }],
        },
      ],
    },
  ];
  const audit = await auditWorkflowHandoffs(evidence);
  return { receiptPath, sha256, evidence, audit };
}
