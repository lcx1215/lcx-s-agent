import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { LcxRunSnapshot } from "../../src/shared/lcx-run-receipt.ts";
import {
  GOVERNANCE_AUTOPILOT_LATEST_PATH,
  LOCAL_FAILURE_TRACE_LATEST_PATH,
  OWNER_BRIEF_LATEST_JSON_PATH,
  OWNER_BRIEF_LATEST_MARKDOWN_PATH,
  resolveLocalOperatorLatestPath,
} from "./lcx-local-paths.ts";

type JsonRecord = Record<string, unknown>;

export type OperatorDigestEvidence = {
  status: "rendered_requires_review" | "blocked";
  contentStatus: "read" | "unavailable";
  source: { path: string; sha256?: string; checkedAt?: string; repoRoot?: string; commit?: string };
  sourcePins: {
    hash: "matched" | "not_requested" | "conflict";
    checkedAt: "matched" | "not_requested" | "conflict";
    repoRoot: "matched" | "conflict" | "unavailable";
  };
  operatorAggregateOk?: boolean;
  owners: Record<
    string,
    {
      ok?: boolean;
      exitCode?: number;
      reason?: string;
      reasonField?: string;
      stderr?: string;
      bodySource?: { path: string; sha256: string; field?: string };
    }
  >;
  reasons: string[];
  collection?: {
    runId: string;
    manifestPath: string;
    manifestSha256: string;
    consumedChildBodies: string[];
  };
  runBinding: "unavailable";
  semanticTruth: "not_proven";
  fieldsUsed: string[];
};

type OwnerBriefInput = {
  checkedAt: string;
  snapshot?: LcxRunSnapshot;
  governance: JsonRecord;
  localFailureTrace: JsonRecord;
  operatorDigest?: OperatorDigestEvidence;
  priorOperatorDigest?: OperatorDigestEvidence;
  paths: {
    latestMarkdownPath: string;
    latestJsonPath: string;
    sourcePaths: string[];
    ownerControlMapMarkdownPath?: string;
  };
};

function recordValue(value: unknown): JsonRecord | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : undefined;
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringArray(value: unknown): string[] {
  return arrayValue(value).filter((item): item is string => typeof item === "string");
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function boolValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function textValue(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim().length > 0) {
    return value;
  }
  return undefined;
}

function shortPath(value: unknown): string | undefined {
  const text = textValue(value);
  if (!text) {
    return undefined;
  }
  return text.split("/").filter(Boolean).at(-1) ?? text;
}

function firstFailedGateText(firstFailedGate: string | undefined): string {
  if (!firstFailedGate || firstFailedGate === "none") {
    return "暂时没有新的硬卡点。";
  }
  if (firstFailedGate.includes("commercialAcceptance")) {
    return "商品级验收还没过，说明现在还不能说已经达到可发布水准。";
  }
  if (firstFailedGate.includes("contextRecovery")) {
    return "接力单还没完全干净，未来新窗口接手时还可能漏信息。";
  }
  if (firstFailedGate.includes("universeIndex")) {
    return "全量文件地图还没完全干净，说明还有文件归属或脏状态需要收敛。";
  }
  if (firstFailedGate === "active_eval_or_mlx") {
    return "评测和本地模型还在跑，现在不能叠加新的重活。";
  }
  return `当前第一处卡点是 ${firstFailedGate}。`;
}

function nextActionText(nextSafeAction: string | undefined): string {
  if (!nextSafeAction) {
    return "先看第一处卡点，再决定下一步。";
  }
  if (nextSafeAction === "wait_for_current_training_eval_then_run_idle_queue") {
    return "等当前评测结束，再执行排队里的下一步。";
  }
  if (nextSafeAction === "wait_for_eval_idle") {
    return "先等评测空下来。";
  }
  if (nextSafeAction.includes("targeted")) {
    return "空闲后先跑定向小考，不要直接大范围重训。";
  }
  return nextSafeAction;
}

function headline(params: { activeTrainingOrEval: boolean; result: string | undefined }) {
  if (params.activeTrainingOrEval) {
    return "机器还在跑评测，先不加新的重活。";
  }
  if (params.result === "passed") {
    return "当前总控没有发现新的硬卡点，可以按下一步推进。";
  }
  return "当前有卡点，先处理第一处卡点。";
}

function yesNo(value: unknown): string {
  return value === true ? "是" : "否";
}

function lineList(lines: string[]): string {
  return lines.map((line) => `- ${line}`).join("\n");
}

export function buildOwnerBrief(input: OwnerBriefInput) {
  const summary = recordValue(input.governance.summary) ?? {};
  const owners = recordValue(input.governance.owners) ?? {};
  const universeIndex = recordValue(owners.universeIndex) ?? {};
  const trainingPlan = recordValue(owners.trainingPlan) ?? {};
  const latestCandidateEval = recordValue(trainingPlan.latestCandidateEval) ?? {};
  const monotonicDataLedger = recordValue(owners.monotonicDataLedger) ?? {};
  const processSummary = recordValue(input.localFailureTrace.processSummary) ?? {};
  const processCounts = recordValue(processSummary.counts) ?? {};
  const activeTrainingOrEval =
    boolValue(summary.activeTrainingOrEval) === true ||
    boolValue(processSummary.activeTrainingOrEval) === true ||
    boolValue(processSummary.activeHeavy) === true;
  const result = textValue(input.localFailureTrace.result);
  const firstFailedGate = textValue(input.localFailureTrace.firstFailedGate);
  const nextSafeAction =
    textValue(input.localFailureTrace.nextSafeAction) ?? textValue(summary.fastestSafeNextAction);
  const parseIssueCount =
    stringArray(latestCandidateEval.parseRecoveredCaseIds).length +
    stringArray(latestCandidateEval.parseErrorCaseIds).length;
  const failedCaseCount = stringArray(latestCandidateEval.failedCaseIds).length;
  const governanceTotalComponents = numberValue(universeIndex.governanceTotalComponents);
  const governanceGovernedComponents = numberValue(universeIndex.governanceGovernedComponents);
  const governanceInventoryOnlyComponents = numberValue(
    universeIndex.governanceInventoryOnlyComponents,
  );
  const governanceReviewRequiredComponents = numberValue(
    universeIndex.governanceReviewRequiredComponents,
  );
  const governanceCoverageRate = numberValue(universeIndex.governanceCoverageRate);
  const governanceStatus = textValue(universeIndex.governanceStatus);
  const acceptedSkillOptPackets = numberValue(monotonicDataLedger.acceptedSkillOptPackets);
  const datasetExamples = numberValue(monotonicDataLedger.datasetExamples);
  const trainSliceWritten = numberValue(monotonicDataLedger.trainSliceWritten);
  const selectedCleanAdapter = shortPath(trainingPlan.selectedCleanAdapter);
  const governanceRunId = textValue(recordValue(input.governance.runReceipt)?.runId) ?? "未关联";
  const headlineText = input.operatorDigest
    ? input.operatorDigest.status === "blocked"
      ? "原 operator 回执有阻断或来源缺口，先处理具体原因。"
      : "原 operator 回执已汇总，仍缺同轮运行身份，等待验收。"
    : headline({ activeTrainingOrEval, result });
  const blockers = [
    firstFailedGateText(firstFailedGate),
    ...stringArray(summary.actionableClusters).map((cluster) => `还有待处理问题：${cluster}。`),
  ].slice(0, 4);
  // "卡在哪里" names the cluster but not the cause, and a cluster name alone is not
  // actionable. Quote each failing owner's first reason verbatim — paraphrasing a receipt
  // is how a brief stops being a report and starts being an opinion. Owners the autopilot
  // already calls structurally failed come first, because those are the named blockers.
  const ownersWithReasons: { id: string; reasons: string[] }[] = Object.entries(owners)
    .map(([id, value]) => ({ id, reasons: stringArray(recordValue(value)?.actionableFailures) }))
    .filter((entry) => entry.reasons.length > 0);
  const structuralFailureIds = stringArray(summary.structuralOwnerFailures);
  const orderedReasonOwners = [
    ...structuralFailureIds.flatMap((id) => ownersWithReasons.filter((entry) => entry.id === id)),
    ...ownersWithReasons
      .filter((entry) => !structuralFailureIds.includes(entry.id))
      .toSorted((a, b) => a.id.localeCompare(b.id)),
  ];
  const MAX_REASON_LINES = 4;
  const MAX_REASON_CHARS = 320;
  const reasonLines = orderedReasonOwners.slice(0, MAX_REASON_LINES).map((entry) => {
    const reason = entry.reasons[0] ?? "";
    const clipped =
      reason.length > MAX_REASON_CHARS ? `${reason.slice(0, MAX_REASON_CHARS)}…` : reason;
    return `${entry.id}：${clipped}`;
  });
  const hiddenReasonCount = Math.max(0, orderedReasonOwners.length - MAX_REASON_LINES);
  const progressLines = [
    datasetExamples !== undefined ? `训练材料账本现在看到 ${datasetExamples} 条样本。` : undefined,
    trainSliceWritten !== undefined ? `当前训练切片是 ${trainSliceWritten} 条。` : undefined,
    acceptedSkillOptPackets !== undefined
      ? `已经有 ${acceptedSkillOptPackets} 条小规则候选。`
      : undefined,
    selectedCleanAdapter ? `当前干净模型还是 ${selectedCleanAdapter}。` : undefined,
    parseIssueCount > 0 ? `候选模型还有 ${parseIssueCount} 个格式不干净的案例。` : undefined,
    failedCaseCount > 0 ? `候选模型还有 ${failedCaseCount} 个明确失败案例。` : undefined,
    governanceTotalComponents !== undefined
      ? `全量部件治理：${governanceStatus ?? "状态未知"}，${governanceGovernedComponents ?? 0} 个源组件、${governanceInventoryOnlyComponents ?? 0} 个库存组件，共 ${governanceTotalComponents} 个；review-required=${governanceReviewRequiredComponents ?? "未知"}，覆盖率=${governanceCoverageRate ?? "未知"}。`
      : undefined,
  ].filter((line): line is string => typeof line === "string");
  const machineLines = input.operatorDigest
    ? [
        `原回执训练 active：${String(boolValue(processSummary.activeTrainingOrEval) ?? "unknown")}`,
        `原回执重活重叠：${String(boolValue(processSummary.activeHeavy) ?? "unknown")}`,
        `原回执训练计划进程数：${String(numberValue(trainingPlan.activeProcessCount) ?? "unknown")}`,
      ]
    : [
        `后台守护：${numberValue(processCounts.guard) ?? 0}`,
        `评测：${numberValue(processCounts.eval) ?? 0}`,
        `本地模型：${numberValue(processCounts.mlx) ?? 0}`,
        `老师批处理：${numberValue(processCounts.teacher) ?? 0}`,
        `配额填充：${numberValue(processCounts.quota) ?? 0}`,
      ];
  const boundaryLines = [
    `碰线上：${yesNo(input.governance.liveTouched)}`,
    `改供应商配置：${yesNo(input.governance.providerConfigTouched)}`,
    `碰受保护记忆：${yesNo(input.governance.protectedMemoryTouched)}`,
    `能否变训练材料：${yesNo(input.localFailureTrace.canBecomeTrainingMaterial)}`,
  ];
  const markdown = [
    "# LCX 老板总览",
    "",
    `生成时间：${input.checkedAt}`,
    `总控 runId：${governanceRunId}`,
    "",
    `一句话：${headlineText}`,
    "",
    ...(input.operatorDigest
      ? [
          "## 原 operator 回执",
          `- 内容读取：${input.operatorDigest.contentStatus}`,
          `- 摘要状态：${input.operatorDigest.status}`,
          `- 原时间：${input.operatorDigest.source.checkedAt ?? "unknown"}`,
          `- 原聚合 ok：${String(input.operatorDigest.operatorAggregateOk ?? "unknown")}`,
          `- 来源 SHA-256：${input.operatorDigest.source.sha256 ?? "unknown"}`,
          `- 运行身份：${input.operatorDigest.runBinding}；来源和结论真实性：${input.operatorDigest.semanticTruth}`,
          lineList(input.operatorDigest.reasons),
          "",
        ]
      : []),
    ...(input.priorOperatorDigest
      ? [
          "## 上一轮采集诊断（不代表当前轮业务验收）",
          `- 原采集时间：${input.priorOperatorDigest.source.checkedAt ?? "unknown"}`,
          `- 来源：${input.priorOperatorDigest.source.path}`,
          `- 来源 SHA-256：${input.priorOperatorDigest.source.sha256 ?? "unknown"}`,
          ...Object.entries(input.priorOperatorDigest.owners).flatMap(([id, owner]) =>
            owner.reason && (owner.ok === false || owner.exitCode !== 0)
              ? [`- ${id}：${owner.reason}`]
              : [],
          ),
          ...input.priorOperatorDigest.reasons
            .filter(
              (reason) =>
                reason.startsWith("operator_collection_") || reason.startsWith("operator_source_"),
            )
            .map((reason) => `- 来源缺口：${reason}`),
          "",
        ]
      : []),
    "## 今天进展",
    progressLines.length > 0 ? lineList(progressLines) : "- 暂时没有新的进展数字。",
    "",
    "## 卡在哪里",
    lineList(blockers),
    "",
    ...(reasonLines.length > 0
      ? [
          "## 具体原因（回执原文，未改写）",
          lineList([
            ...reasonLines,
            ...(hiddenReasonCount > 0
              ? [`还有 ${hiddenReasonCount} 个 owner 有待处理问题，见管控图。`]
              : []),
          ]),
          "",
        ]
      : []),
    "## 机器在干嘛",
    lineList(machineLines),
    "",
    "## 下一步",
    `- ${nextActionText(nextSafeAction)}`,
    "",
    "## 风险边界",
    lineList(boundaryLines),
    "",
    "## 管控图",
    input.paths.ownerControlMapMarkdownPath
      ? `- 老板管得到和 Codex 能代管的清单：${input.paths.ownerControlMapMarkdownPath}`
      : "- 暂未生成老板管控图。",
    "",
    "## 这份总览读了哪些文件",
    lineList(input.paths.sourcePaths),
    "",
    "边界：这只是给人看的中文汇总，不是新事实来源；事实仍以总控、小票、训练计划、评测和真实日志为准。",
    "",
  ].join("\n");

  return {
    ok: true,
    kind: "lcx-owner-brief",
    boundary: "local_owner_brief_readable_summary_only",
    checkedAt: input.checkedAt,
    ...(input.snapshot ? { snapshot: input.snapshot } : {}),
    runReceipt: input.governance.runReceipt,
    title: "LCX 老板总览",
    headline: headlineText,
    firstFailedGate: firstFailedGate ?? "none",
    nextSafeAction: nextSafeAction ?? "review_first_failed_gate",
    latestMarkdownPath: input.paths.latestMarkdownPath,
    latestJsonPath: input.paths.latestJsonPath,
    sourcePaths: input.paths.sourcePaths,
    ...(input.operatorDigest ? { operatorDigest: input.operatorDigest } : {}),
    ...(input.priorOperatorDigest
      ? {
          priorOperatorDigest: {
            ...input.priorOperatorDigest,
            observationOrigin: "prior_collection" as const,
          },
        }
      : {}),
    markdown,
    liveTouched: input.governance.liveTouched === true,
    providerConfigTouched: input.governance.providerConfigTouched === true,
    protectedMemoryTouched: input.governance.protectedMemoryTouched === true,
  };
}

export type OwnerBrief = ReturnType<typeof buildOwnerBrief>;

export async function writeOwnerBrief(brief: OwnerBrief) {
  await fs.mkdir(path.dirname(OWNER_BRIEF_LATEST_JSON_PATH), { recursive: true });
  await fs.writeFile(OWNER_BRIEF_LATEST_JSON_PATH, `${JSON.stringify(brief, null, 2)}\n`);
  await fs.writeFile(OWNER_BRIEF_LATEST_MARKDOWN_PATH, `${brief.markdown}\n`);
}

async function readJson(filePath: string): Promise<JsonRecord | undefined> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8")) as JsonRecord;
  } catch {
    return undefined;
  }
}

/** Read original captured child bytes; a parent capture id is not a child business run id. */
async function readOperatorCollection(body: JsonRecord, repoRoot: string) {
  const collection = recordValue(body.collection);
  if (!collection) {
    return undefined;
  }
  const runId = textValue(collection.runId);
  const ref = recordValue(collection.manifest);
  const expectedPrefix = `state/local-operator-collections/${runId}/`;
  if (!runId || !/^[a-f0-9-]{36}$/u.test(runId) || ref?.path !== `${expectedPrefix}manifest.json`) {
    throw new Error("operator_collection_scope_conflict");
  }
  const root = await fs.realpath(repoRoot);
  async function readPinned(reference: JsonRecord, expectedPath: string, limit: number) {
    if (reference.path !== expectedPath || typeof reference.sha256 !== "string") {
      throw new Error("operator_collection_child_reference_conflict");
    }
    const filename = await fs.realpath(path.resolve(root, expectedPath));
    if (!filename.startsWith(root + path.sep) || (await fs.stat(filename)).size > limit) {
      throw new Error("operator_collection_child_scope_or_budget_conflict");
    }
    const bytes = await fs.readFile(filename);
    if (
      bytes.length > limit ||
      crypto.createHash("sha256").update(bytes).digest("hex") !== reference.sha256
    ) {
      throw new Error("operator_collection_child_hash_conflict");
    }
    return bytes;
  }
  const bytes = await readPinned(ref, `${expectedPrefix}manifest.json`, 1_048_576);
  const manifest = recordValue(JSON.parse(bytes.toString("utf8")));
  if (
    !manifest ||
    manifest.schemaVersion !== "lcx_local_operator_collection_v1" ||
    manifest.collectionRunId !== runId ||
    path.resolve(String(manifest.repoRoot)) !== path.resolve(repoRoot) ||
    manifest.sourceCommit !== recordValue(body.source)?.commit
  ) {
    throw new Error("operator_collection_manifest_identity_conflict");
  }
  const children = recordValue(manifest.children) ?? {};
  const results = new Map<string, { body: JsonRecord; source: { path: string; sha256: string } }>();
  const unreadableChildren: string[] = [];
  for (const id of [
    "doctor",
    "trainingPlan",
    "governanceAutopilot",
    "mindModel",
    "flowGraph",
    "contextRecovery",
    "trainingSupervisor",
  ]) {
    const child = recordValue(children[id]);
    if (!child || child.collectionRunId !== runId) {
      throw new Error("operator_collection_child_parent_conflict");
    }
    const stdout = recordValue(child.stdout);
    if (stdout?.status !== "captured") {
      continue;
    }
    const expectedPath = `${expectedPrefix}${id}.stdout`;
    const raw = await readPinned(stdout, expectedPath, 4 * 1_048_576);
    let parsed: JsonRecord | undefined;
    try {
      parsed = recordValue(JSON.parse(raw.toString("utf8")));
    } catch {
      // A timed-out child can leave partial JSON; keep other verified child bodies.
    }
    if (!parsed) {
      unreadableChildren.push(`operator_collection_child_body_unreadable:${id}:${expectedPath}`);
      continue;
    }
    results.set(id, {
      body: parsed,
      source: { path: expectedPath, sha256: String(stdout.sha256) },
    });
  }
  return {
    runId,
    manifestPath: String(ref.path),
    manifestSha256: String(ref.sha256),
    results,
    unreadableChildren,
  };
}

/** Explicit single-file consumer; legacy operator files have no canonical run/snapshot identity. */
export async function readOperatorDigest(
  filePath: string,
  host: {
    repoRoot: string;
    expectedSha256?: string;
    expectedCheckedAt?: string;
    nowMs?: number;
  },
) {
  const evidence: OperatorDigestEvidence = {
    status: "blocked",
    contentStatus: "unavailable",
    source: { path: filePath },
    sourcePins: { hash: "not_requested", checkedAt: "not_requested", repoRoot: "unavailable" },
    owners: {},
    reasons: [],
    runBinding: "unavailable",
    semanticTruth: "not_proven",
    fieldsUsed: [],
  };
  let operator: JsonRecord = {};
  try {
    const bytes = await fs.readFile(filePath);
    evidence.source.sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
    if (host.expectedSha256 !== undefined) {
      evidence.sourcePins.hash =
        /^[a-f0-9]{64}$/u.test(host.expectedSha256) &&
        host.expectedSha256 === evidence.source.sha256
          ? "matched"
          : "conflict";
      if (evidence.sourcePins.hash === "conflict") {
        evidence.reasons.push("operator_source_hash_conflict");
      }
    }
    const body = recordValue(JSON.parse(bytes.toString("utf8")));
    if (!body) {
      throw new Error("operator_source_object_missing");
    }
    operator = body;
    evidence.fieldsUsed.push(
      "/ok",
      "/checkedAt",
      "/source/repoRoot",
      "/source/commit",
      "/lane",
      "/boundary",
      "/mode",
      "/status",
    );
    evidence.source.checkedAt = textValue(body.checkedAt);
    const source = recordValue(body.source);
    evidence.source.repoRoot = textValue(source?.repoRoot);
    evidence.source.commit = textValue(source?.commit);
    evidence.sourcePins.repoRoot = evidence.source.repoRoot
      ? path.resolve(evidence.source.repoRoot) === path.resolve(host.repoRoot)
        ? "matched"
        : "conflict"
      : "unavailable";
    if (evidence.sourcePins.repoRoot !== "matched") {
      evidence.reasons.push(`operator_source_repo_root_${evidence.sourcePins.repoRoot}`);
    }
    if (!evidence.source.commit) {
      evidence.reasons.push("operator_source_commit_unavailable");
    }
    if (host.expectedCheckedAt !== undefined) {
      evidence.sourcePins.checkedAt =
        host.expectedCheckedAt === evidence.source.checkedAt ? "matched" : "conflict";
      if (evidence.sourcePins.checkedAt === "conflict") {
        evidence.reasons.push("operator_source_checked_at_conflict");
      }
    }
    const sourceAt = Date.parse(evidence.source.checkedAt ?? "");
    const age = (host.nowMs ?? Date.now()) - sourceAt;
    // Reuse the original compressed-recovery 3-hour operator freshness threshold.
    if (!Number.isFinite(sourceAt)) {
      evidence.reasons.push("operator_source_checked_at_unavailable");
    } else if (age < 0) {
      evidence.reasons.push("operator_source_time_in_future");
    } else if (age > 3 * 60 * 60 * 1000) {
      evidence.reasons.push("operator_source_stale");
    }
    if (body.lane !== "local_operator_loop" || body.boundary !== "local_observability_only") {
      evidence.reasons.push("operator_source_shape_conflict");
    }
    if (
      !["observe_only", "scheduled"].includes(String(body.mode)) ||
      !["observed_with_skipped_owners", "scheduled_owner_result"].includes(String(body.status))
    ) {
      evidence.reasons.push("operator_source_status_unavailable");
    }
    if (body.snapshot !== undefined || body.runReceipt !== undefined) {
      evidence.reasons.push("operator_unrecognized_run_identity");
    }
    evidence.operatorAggregateOk = boolValue(body.ok);
    if (evidence.operatorAggregateOk !== true) {
      evidence.reasons.push(
        evidence.operatorAggregateOk === false
          ? "operator_aggregate_failed"
          : "operator_aggregate_status_unknown",
      );
    }
    const captured = await readOperatorCollection(body, host.repoRoot);
    if (captured) {
      evidence.reasons.push(...captured.unreadableChildren);
      evidence.collection = {
        runId: captured.runId,
        manifestPath: captured.manifestPath,
        manifestSha256: captured.manifestSha256,
        consumedChildBodies: [...captured.results.keys()],
      };
      evidence.fieldsUsed.push("/collection/runId", "/collection/manifest");
    }
    const commands = recordValue(body.commands) ?? {};
    const errors = recordValue(body.errors) ?? {};
    const ownerEntries = [
      ["doctor", "doctorExitCode"],
      ["trainingPlan", "trainingPlanExitCode"],
      ["governanceAutopilot", "governanceAutopilotExitCode"],
      ["mindModel", "mindModelExitCode"],
      ["flowGraph", "flowGraphExitCode"],
      ["contextRecovery", "contextRecoveryExitCode"],
      ["trainingSupervisor", "trainingSupervisorExitCode"],
    ] as const;
    for (const [id, commandKey] of ownerEntries) {
      const owner = recordValue(body[id]);
      const ok = boolValue(owner?.ok);
      const exitCode = numberValue(commands[commandKey]);
      const child = captured?.results.get(id);
      const failureBody = child?.body ?? owner;
      const failures = arrayValue(failureBody?.actionableFailures);
      const failureIndex = failures.findIndex((item) => textValue(item) !== undefined);
      const checks = arrayValue(failureBody?.checks);
      const checkIndex = checks.findIndex((check) => recordValue(check)?.ok === false);
      const check = recordValue(checks[checkIndex]);
      const checkError = textValue(check?.error);
      const structuredReason =
        textValue(failures[failureIndex]) ??
        (checkError ? `${textValue(check?.name) ?? id}: ${checkError}` : undefined);
      const stderr = textValue(errors[id]);
      const originalReason = structuredReason ?? stderr;
      const childField =
        failureIndex >= 0 ? `/actionableFailures/${failureIndex}` : `/checks/${checkIndex}/error`;
      const reasonField = structuredReason
        ? child
          ? `${child.source.path}#${childField}`
          : `/${id}/actionableFailures/${failureIndex}`
        : stderr
          ? `/errors/${id}`
          : undefined;
      const reason = originalReason
        ? originalReason.slice(0, 320) + (originalReason.length > 320 ? "…" : "")
        : undefined;
      if (child && typeof child.body.ok === "boolean" && ok !== child.body.ok) {
        evidence.reasons.push(`operator_collection_owner_summary_conflict:${id}`);
      }
      evidence.owners[id] = {
        ...(child
          ? { bodySource: { ...child.source, ...(structuredReason ? { field: childField } : {}) } }
          : {}),
        ...(ok !== undefined ? { ok } : {}),
        ...(exitCode !== undefined ? { exitCode } : {}),
        ...(reason ? { reason } : {}),
        ...(reasonField ? { reasonField } : {}),
        ...(stderr ? { stderr: stderr.slice(0, 320) + (stderr.length > 320 ? "…" : "") } : {}),
      };
      evidence.fieldsUsed.push(`/${id}/ok`, `/commands/${commandKey}`, `/errors/${id}`);
      if (reasonField && structuredReason) {
        evidence.fieldsUsed.push(reasonField);
      }
      if (!owner || ok === undefined) {
        evidence.reasons.push(`operator_owner_status_unknown:${id}`);
      }
      if (ok === false) {
        evidence.reasons.push(`operator_owner_blocked:${id}${reason ? `:${reason}` : ""}`);
      }
      if (exitCode === undefined || !Number.isInteger(exitCode)) {
        evidence.reasons.push(`operator_owner_exit_unknown:${id}`);
      } else if (exitCode !== 0) {
        evidence.reasons.push(
          `operator_owner_exit_failed:${id}${reason ? `:${reason}` : `:${exitCode}`}`,
        );
      }
    }
    // Owner ok describes the governance artifact, not its business gates. Preserve the
    // original summary's explicit blockers even when the wrapper and process succeeded.
    const governanceSummary = recordValue(recordValue(body.governanceAutopilot)?.summary);
    for (const [field, reasonPrefix] of [
      ["failedGates", "operator_governance_gate_failed"],
      ["blockedGates", "operator_governance_gate_blocked"],
      ["structuralOwnerFailures", "operator_governance_owner_blocked"],
    ] as const) {
      const value = governanceSummary?.[field];
      if (value === undefined) {
        continue;
      }
      evidence.fieldsUsed.push(`/governanceAutopilot/summary/${field}`);
      if (!Array.isArray(value) || value.some((item) => !textValue(item))) {
        evidence.reasons.push(`operator_source_governance_summary_invalid:${field}`);
        continue;
      }
      for (const item of stringArray(value)) {
        evidence.reasons.push(`${reasonPrefix}:${item.slice(0, 320)}`);
      }
    }
    if (governanceSummary?.releaseBlocked !== undefined) {
      evidence.fieldsUsed.push("/governanceAutopilot/summary/releaseBlocked");
      if (governanceSummary.releaseBlocked === true) {
        evidence.reasons.push("operator_governance_release_blocked");
      } else if (governanceSummary.releaseBlocked !== false) {
        evidence.reasons.push("operator_source_governance_summary_invalid:releaseBlocked");
      }
    }
    evidence.fieldsUsed.push(
      "/commands/cleanupExitCode",
      "/training/active",
      "/training/overlappingHeavyEval",
      "/governanceAutopilot/summary/fastestSafeNextAction",
    );
    if (commands.cleanupExitCode !== 0) {
      evidence.reasons.push(
        `operator_cleanup_exit_${typeof commands.cleanupExitCode === "number" ? "failed" : "unknown"}`,
      );
    }
    if (recordValue(body.training)?.overlappingHeavyEval === true) {
      evidence.reasons.push("operator_training_overlap_guard");
    }
    const sourceErrors = evidence.reasons.some((reason) =>
      /^(operator_collection_|operator_source_|operator_unrecognized_|operator_owner_status_unknown|operator_owner_exit_unknown|operator_aggregate_status_unknown)/u.test(
        reason,
      ),
    );
    evidence.contentStatus = sourceErrors ? "unavailable" : "read";
    evidence.status = evidence.reasons.length > 0 ? "blocked" : "rendered_requires_review";
    if (sourceErrors) {
      operator = {};
    }
  } catch (error) {
    evidence.reasons.push(
      `operator_source_unavailable:${error instanceof Error ? error.message : String(error)}`,
    );
  }
  evidence.reasons.push(
    "operator_canonical_run_identity_unavailable; aggregate source status is not proof of business acceptance",
  );
  return { operator, evidence };
}

/** Original governance brief consumes the previous collection, never aliases it to its own run. */
export async function buildOwnerBriefWithPriorCollection(
  input: OwnerBriefInput,
  repoRoot: string,
  operatorPath = resolveLocalOperatorLatestPath(repoRoot),
) {
  try {
    await fs.access(operatorPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return buildOwnerBrief(input);
    }
  }
  const read = await readOperatorDigest(operatorPath, {
    repoRoot,
    nowMs: Date.parse(input.checkedAt),
  });
  return buildOwnerBrief({
    ...input,
    priorOperatorDigest: read.evidence,
    paths: { ...input.paths, sourcePaths: [...input.paths.sourcePaths, operatorPath] },
  });
}

export function buildOperatorOwnerBrief(
  read: Awaited<ReturnType<typeof readOperatorDigest>>,
  checkedAt: string,
) {
  const { operator, evidence } = read;
  const governance = recordValue(operator.governanceAutopilot) ?? {};
  const training = recordValue(operator.training) ?? {};
  const reasons = evidence.reasons.filter((reason) => !reason.startsWith("operator_canonical_"));
  const firstFailedGate =
    reasons.find((reason) => reason !== "operator_aggregate_failed") ??
    reasons[0] ??
    "operator_canonical_run_identity_unavailable";
  const owners = Object.fromEntries(
    Object.entries(evidence.owners).map(([id, value]) => [
      id,
      {
        ...recordValue(operator[id]),
        actionableFailures:
          value.reason &&
          (value.ok === false || (value.exitCode !== undefined && value.exitCode !== 0))
            ? [value.reason]
            : [],
      },
    ]),
  );
  const brief = buildOwnerBrief({
    checkedAt,
    operatorDigest: evidence,
    governance: {
      ...governance,
      owners,
      liveTouched: operator.liveTouched,
      providerConfigTouched: operator.providerConfigTouched,
      protectedMemoryTouched: operator.protectedMemoryTouched,
    },
    localFailureTrace: {
      result: "blocked",
      firstFailedGate,
      nextSafeAction:
        evidence.status === "blocked"
          ? "review_operator_source_and_original_owner_reason"
          : (textValue(recordValue(governance.summary)?.fastestSafeNextAction) ??
            "review_operator_run_identity_gap"),
      processSummary: {
        activeTrainingOrEval: boolValue(training.active),
        activeHeavy: boolValue(training.overlappingHeavyEval),
      },
    },
    paths: {
      latestMarkdownPath: OWNER_BRIEF_LATEST_MARKDOWN_PATH,
      latestJsonPath: OWNER_BRIEF_LATEST_JSON_PATH,
      sourcePaths: [evidence.source.path],
    },
  });
  return { ...brief, ok: evidence.status !== "blocked" };
}

function parseArgs(args: string[]) {
  const options = {
    json: false,
    write: false,
    operatorPath: undefined as string | undefined,
    operatorSha256: undefined as string | undefined,
    operatorCheckedAt: undefined as string | undefined,
    operatorRepoRoot: process.cwd(),
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--json") {
      options.json = true;
    } else if (arg === "--write") {
      options.write = true;
    } else if (
      [
        "--operator-path",
        "--operator-sha256",
        "--operator-checked-at",
        "--operator-repo-root",
      ].includes(arg)
    ) {
      const value = args[index + 1];
      if (!value) {
        throw new Error(`${arg} requires a value`);
      }
      if (arg === "--operator-path") {
        options.operatorPath = value;
      }
      if (arg === "--operator-sha256") {
        options.operatorSha256 = value;
      }
      if (arg === "--operator-checked-at") {
        options.operatorCheckedAt = value;
      }
      if (arg === "--operator-repo-root") {
        options.operatorRepoRoot = value;
      }
      index += 1;
    } else if (arg === "--help" || arg === "-h") {
      throw new Error(
        "Usage: node --import tsx scripts/operator/lcx-owner-brief.ts [--json] [--write] [--operator-path PATH --operator-sha256 SHA256 --operator-checked-at ISO --operator-repo-root PATH]",
      );
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.operatorPath) {
    const read = await readOperatorDigest(options.operatorPath, {
      repoRoot: options.operatorRepoRoot,
      expectedSha256: options.operatorSha256,
      expectedCheckedAt: options.operatorCheckedAt,
    });
    const brief = buildOperatorOwnerBrief(read, new Date().toISOString());
    if (options.write) {
      await writeOwnerBrief(brief);
    }
    console.log(options.json ? JSON.stringify(brief, null, 2) : brief.markdown);
    if (read.evidence.status === "blocked") {
      process.exitCode = 1;
    }
    return;
  }
  const governance = await readJson(GOVERNANCE_AUTOPILOT_LATEST_PATH);
  const localFailureTrace = await readJson(LOCAL_FAILURE_TRACE_LATEST_PATH);
  if (!governance) {
    throw new Error(`Cannot read ${GOVERNANCE_AUTOPILOT_LATEST_PATH}`);
  }
  if (!localFailureTrace) {
    throw new Error(`Cannot read ${LOCAL_FAILURE_TRACE_LATEST_PATH}`);
  }
  const brief = await buildOwnerBriefWithPriorCollection(
    {
      checkedAt: new Date().toISOString(),
      governance,
      localFailureTrace,
      paths: {
        latestMarkdownPath: OWNER_BRIEF_LATEST_MARKDOWN_PATH,
        latestJsonPath: OWNER_BRIEF_LATEST_JSON_PATH,
        sourcePaths: [GOVERNANCE_AUTOPILOT_LATEST_PATH, LOCAL_FAILURE_TRACE_LATEST_PATH],
      },
    },
    options.operatorRepoRoot,
  );
  if (options.write) {
    await writeOwnerBrief(brief);
  }
  console.log(options.json ? JSON.stringify(brief, null, 2) : brief.markdown);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
