import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  GOVERNANCE_AUTOPILOT_LATEST_PATH,
  LOCAL_FAILURE_TRACE_LATEST_PATH,
  OWNER_BRIEF_LATEST_JSON_PATH,
  OWNER_BRIEF_LATEST_MARKDOWN_PATH,
} from "./lcx-local-paths.ts";

type JsonRecord = Record<string, unknown>;

type OwnerBriefInput = {
  checkedAt: string;
  governance: JsonRecord;
  localFailureTrace: JsonRecord;
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
  const acceptedSkillOptPackets = numberValue(monotonicDataLedger.acceptedSkillOptPackets);
  const datasetExamples = numberValue(monotonicDataLedger.datasetExamples);
  const trainSliceWritten = numberValue(monotonicDataLedger.trainSliceWritten);
  const selectedCleanAdapter = shortPath(trainingPlan.selectedCleanAdapter);
  const headlineText = headline({ activeTrainingOrEval, result });
  const blockers = [
    firstFailedGateText(firstFailedGate),
    ...stringArray(summary.actionableClusters).map((cluster) => `还有待处理问题：${cluster}。`),
  ].slice(0, 4);
  const progressLines = [
    datasetExamples !== undefined ? `训练材料账本现在看到 ${datasetExamples} 条样本。` : undefined,
    trainSliceWritten !== undefined ? `当前训练切片是 ${trainSliceWritten} 条。` : undefined,
    acceptedSkillOptPackets !== undefined
      ? `已经有 ${acceptedSkillOptPackets} 条小规则候选。`
      : undefined,
    selectedCleanAdapter ? `当前干净模型还是 ${selectedCleanAdapter}。` : undefined,
    parseIssueCount > 0 ? `候选模型还有 ${parseIssueCount} 个格式不干净的案例。` : undefined,
    failedCaseCount > 0 ? `候选模型还有 ${failedCaseCount} 个明确失败案例。` : undefined,
  ].filter((line): line is string => typeof line === "string");
  const machineLines = [
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
    "",
    `一句话：${headlineText}`,
    "",
    "## 今天进展",
    progressLines.length > 0 ? lineList(progressLines) : "- 暂时没有新的进展数字。",
    "",
    "## 卡在哪里",
    lineList(blockers),
    "",
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
    boundary: "dev_owner_brief_readable_summary_only",
    checkedAt: input.checkedAt,
    title: "LCX 老板总览",
    headline: headlineText,
    firstFailedGate: firstFailedGate ?? "none",
    nextSafeAction: nextSafeAction ?? "review_first_failed_gate",
    latestMarkdownPath: input.paths.latestMarkdownPath,
    latestJsonPath: input.paths.latestJsonPath,
    sourcePaths: input.paths.sourcePaths,
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

function parseArgs(args: string[]) {
  const options = { json: false, write: false };
  for (const arg of args) {
    if (arg === "--json") {
      options.json = true;
    } else if (arg === "--write") {
      options.write = true;
    } else if (arg === "--help" || arg === "-h") {
      throw new Error(
        "Usage: node --import tsx scripts/operator/lcx-owner-brief.ts [--json] [--write]",
      );
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const governance = await readJson(GOVERNANCE_AUTOPILOT_LATEST_PATH);
  const localFailureTrace = await readJson(LOCAL_FAILURE_TRACE_LATEST_PATH);
  if (!governance) {
    throw new Error(`Cannot read ${GOVERNANCE_AUTOPILOT_LATEST_PATH}`);
  }
  if (!localFailureTrace) {
    throw new Error(`Cannot read ${LOCAL_FAILURE_TRACE_LATEST_PATH}`);
  }
  const brief = buildOwnerBrief({
    checkedAt: new Date().toISOString(),
    governance,
    localFailureTrace,
    paths: {
      latestMarkdownPath: OWNER_BRIEF_LATEST_MARKDOWN_PATH,
      latestJsonPath: OWNER_BRIEF_LATEST_JSON_PATH,
      sourcePaths: [GOVERNANCE_AUTOPILOT_LATEST_PATH, LOCAL_FAILURE_TRACE_LATEST_PATH],
    },
  });
  if (options.write) {
    await writeOwnerBrief(brief);
  }
  console.log(options.json ? JSON.stringify(brief, null, 2) : brief.markdown);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
