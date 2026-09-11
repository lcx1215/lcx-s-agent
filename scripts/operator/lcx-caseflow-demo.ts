import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import {
  buildFinanceCaseRun,
  saveFinanceCaseRun,
  readFinanceCaseRun,
  compareFinanceCaseRuns,
  listFinanceCases,
} from "../../src/agents/finance-caseflow.ts";
import {
  appendFinanceOutcome,
  readFinanceOutcomes,
} from "../../src/agents/finance-outcome-ledger.ts";
import { runFinanceResearchRun } from "../../src/agents/finance-research-runner.ts";

/** Exercises the production owners with explicit synthetic adapters, never live markets. */
export async function runCaseflowDemo(output: string) {
  const root = path.resolve(output);
  await fs.mkdir(root, { recursive: true });
  const directory = await fs.mkdtemp(path.join(root, "caseflow-"));
  let sourceCalls = 0;
  let modelCalls = 0;
  const asOf = "2025-01-01T00:00:00Z";
  const checkpoint = {
    path: path.join(directory, "checkpoints.sqlite"),
    runId: "synthetic-example",
    executionFingerprint: "caseflow-demo-fixture-v1",
  };
  const modelInvoker = async (request: unknown) => {
    modelCalls++;
    const input = request as { stage?: string; evidence?: readonly { id: string }[] };
    if (input.stage === "intake") {
      return { kind: "plan", requirements: ["source evidence"], missingEvidence: [] };
    }
    if (input.stage === "draft" || input.stage === "format") {
      return {
        kind: "artifact",
        artifact: {
          answer:
            "Synthetic research candidate. Review the timestamped observation; no real market conclusion is asserted.",
          claims: [
            {
              id: "fixture-claim",
              text: "Synthetic evidence records an index value of 100; future movement remains uncertain.",
              status: "supported",
              evidenceIds: [
                input.evidence?.find((item) => !item.id.startsWith("finance-batch-summary"))?.id,
              ],
            },
          ],
        },
      };
    }
    return {
      kind: "review",
      review: {
        verdict: "pass",
        criticalFindings: [],
        evidenceGaps: [],
        notes: ["Synthetic fixture checked the supplied evidence packet and found no gaps."],
      },
    };
  };
  const options = {
    input: {
      ask: "Synthetic Caseflow lifecycle example",
      asOf,
      targets: [
        {
          id: "fixture",
          instrument: "FIXTURE",
          assetClass: "us_equity",
          realtime: false as const,
          collections: [{ collection: "news" as const, freshnessMaxMinutes: 60 }],
        },
      ],
    },
    liveFetch: true,
    modelInvoker,
    qualityModelInvoker: modelInvoker,
    modelCheckpoint: { ...checkpoint, maxModelCalls: 32 },
    batchOptions: {
      checkpoint,
      maxApiCalls: 2,
      realtimeAdapters: [],
      collectionAdapters: [
        {
          id: "synthetic-source",
          providerName: "synthetic-source",
          providerRole: "primary_market_data" as const,
          priority: 1,
          supports: () => true,
          collect: async () => {
            sourceCalls++;
            return [
              {
                itemId: "fixture-value",
                collection: "news" as const,
                providerName: "synthetic-source",
                providerRole: "primary_market_data" as const,
                sourceFamily: "market_data_api" as const,
                sourceTimestamp: asOf,
                observedAt: asOf,
                delayStatus: "realtime" as const,
                sourceUrlOrArtifact: "fixture://index",
                data: { index: 100, synthetic: true },
              },
            ];
          },
        },
      ],
    },
  };
  const first = await runFinanceResearchRun(options);
  assert.equal(first.status, "candidate");
  const firstCounts = { sourceCalls, modelCalls };
  const resumed = await runFinanceResearchRun(options);
  assert.deepEqual({ sourceCalls, modelCalls }, firstCounts);
  assert.deepEqual(resumed.quality, first.quality);
  const persist = (receipt: typeof first) =>
    saveFinanceCaseRun(
      directory,
      buildFinanceCaseRun({
        caseId: "synthetic-lifecycle",
        receipt,
        budget: { maxApiCalls: 2 },
        execution: { kind: "synthetic_fixture", model: "injected_fixture" },
      }),
    );
  const saved = await persist(first);
  const savedResume = await persist(resumed);
  const frozen = await readFinanceCaseRun(directory, saved.ref);
  const comparison = compareFinanceCaseRuns(
    frozen,
    await readFinanceCaseRun(directory, savedResume.ref),
  );
  assert.equal(comparison.evidenceChanged, false);
  const outcome = await appendFinanceOutcome(directory, saved.ref, {
    recordId: "synthetic-quarter-1",
    checkpointMonths: 3,
    observedAt: "2025-04-01T00:00:00Z",
    evidence: [
      {
        id: "q1-index",
        source: "fixture://quarter-observation",
        sourceTimestamp: "2025-04-01T00:00:00Z",
        field: "index",
        value: 105,
      },
    ],
    assessments: [
      {
        claimId: "fixture-claim",
        finding: "inconclusive",
        evidenceIds: ["q1-index"],
        deviation: "Synthetic change of 5 index points; original claim did not predict a target.",
        invalidationConditions: ["A fixture is not evidence about actual markets."],
      },
    ],
  });
  const outcomes = await readFinanceOutcomes(directory, saved.ref);
  assert.equal(outcomes.length, 1);
  const inventory = await listFinanceCases(directory);
  assert.equal(inventory.length, 2);
  const summary = {
    boundary: "synthetic_lifecycle_only",
    directory,
    first: saved,
    resumed: savedResume,
    dispatch: {
      initial: firstCounts,
      resumeNewSourceCalls: sourceCalls - firstCounts.sourceCalls,
      resumeNewModelCalls: modelCalls - firstCounts.modelCalls,
    },
    comparison,
    outcome: { ref: outcome.ref, status: outcome.status, timing: outcome.timing },
    inventory,
    liveMarketAnalysis: false,
    realModelInference: false,
    scheduledFollowups: false,
  };
  await fs.writeFile(path.join(directory, "summary.json"), JSON.stringify(summary, null, 2) + "\n");
  const escape = (value: string) =>
    value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  await fs.writeFile(
    path.join(directory, "index.html"),
    `<!doctype html><html lang="zh"><meta charset="utf-8"><title>LCX Caseflow 完整流程</title><style>body{font:16px system-ui;max-width:1000px;margin:48px auto;padding:24px;color:#172338;background:#f3f6fa}article{background:white;padding:28px;border-radius:16px}pre{white-space:pre-wrap;overflow-wrap:anywhere;font-size:13px}li{margin:12px 0}strong{color:#146851}</style><article><h1>LCX Caseflow 完整流程</h1><p>合成案例演示 · 无真实行情或模型推理 · 季度调度未绑定</p><ol><li>执行采集、委员会和质量门</li><li>保存案例与冻结 Decision Packet</li><li>恢复检查点：<strong>新增采集 0 次，新增模型调用 0 次</strong></li><li>重新读取并比较两个 Run：冻结证据一致</li><li>追加季度观察：原始 Packet 不变，结果待审阅</li></ol><h2>运行回执</h2><pre>${escape(JSON.stringify(summary, null, 2))}</pre></article></html>`,
  );
  return summary;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values } = parseArgs({ options: { output: { type: "string" } } });
  if (!values.output) {
    throw new Error("--output DIRECTORY required");
  }
  runCaseflowDemo(values.output).then(
    (summary) => process.stdout.write(JSON.stringify(summary, null, 2) + "\n"),
    (error: unknown) => {
      process.stderr.write(String(error) + "\n");
      process.exitCode = 1;
    },
  );
}
