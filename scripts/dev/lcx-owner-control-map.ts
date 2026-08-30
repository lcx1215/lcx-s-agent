import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  GOVERNANCE_AUTOPILOT_LATEST_PATH,
  LOCAL_FAILURE_TRACE_LATEST_PATH,
  OWNER_CONTROL_MAP_LATEST_JSON_PATH,
  OWNER_CONTROL_MAP_LATEST_MARKDOWN_PATH,
} from "./lcx-local-paths.ts";

type JsonRecord = Record<string, unknown>;

type OwnerControlInput = {
  checkedAt: string;
  governance: JsonRecord;
  localFailureTrace: JsonRecord;
  paths: {
    latestMarkdownPath: string;
    latestJsonPath: string;
    sourcePaths: string[];
  };
};

type ControlStatus = "owner_visible" | "codex_can_act_when_safe" | "blocked_now" | "never_auto";

type ControlItem = {
  id: string;
  title: string;
  status: ControlStatus;
  ownerCanSee: boolean;
  ownerCanDirectNow: boolean;
  codexCanActWhenSafe: boolean;
  supervisor: string;
  evidenceNow: string;
  reason: string;
  nextControl: string;
  proceedWhen: string;
  stopWhen: string;
  ownerAuthorization: string;
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

function addIf(items: ControlItem[], condition: boolean, item: ControlItem) {
  if (condition) {
    items.push(item);
  }
}

function selfRepairAutoWritePlainLabels(policy: JsonRecord | undefined): string {
  const ids = arrayValue(policy?.whenAutoWrite)
    .map((entry) => recordValue(entry)?.id)
    .filter((id): id is string => typeof id === "string");
  const labels = new Set<string>();
  for (const id of ids) {
    if (id === "candidate_eval_dirty_cases") {
      labels.add("候选小考出现失败、格式不干净或只能勉强修回的案例");
    } else if (id === "module_learning_incomplete_evidence") {
      labels.add("资料学习证据链不完整");
    } else if (id === "skillopt_static_or_parse_gap") {
      labels.add("小规则候选没过静态门或格式门");
    }
  }
  if (labels.size === 0) {
    labels.add("候选小考出现失败、格式不干净或只能勉强修回的案例");
    labels.add("资料学习证据链不完整");
    labels.add("小规则候选没过静态门或格式门");
  }
  return Array.from(labels).join("；");
}

function section(title: string, items: ControlItem[], empty: string): string[] {
  return [
    `## ${title}`,
    ...(items.length > 0
      ? items.map((item) => `- ${item.title}：${item.reason} 下一步：${item.nextControl}`)
      : [`- ${empty}`]),
    "",
  ];
}

function supervisionSection(items: ControlItem[]): string[] {
  return [
    "## 透明监督表",
    "- 固定刷新：每次总控跑完自动刷新。",
    "- 使用方式：先看“必须停手的情况”，再看“允许继续的条件”。",
    "",
    ...items.flatMap((item) => [
      `### ${item.title}`,
      `- 谁负责看：${item.supervisor}`,
      `- 现在看什么：${item.evidenceNow}`,
      `- 当前状态：${item.reason}`,
      `- 允许继续的条件：${item.proceedWhen}`,
      `- 必须停手的情况：${item.stopWhen}`,
      `- 是否需要你授权：${item.ownerAuthorization}`,
      "",
    ]),
  ];
}

export function buildOwnerControlMap(input: OwnerControlInput) {
  const summary = recordValue(input.governance.summary) ?? {};
  const triggerPolicy = recordValue(input.governance.triggerPolicy) ?? {};
  const selfRepairWritePolicy = recordValue(triggerPolicy.selfRepairHandsOwnerWritePolicy);
  const owners = recordValue(input.governance.owners) ?? {};
  const trainingPlan = recordValue(owners.trainingPlan) ?? {};
  const latestCandidateEval = recordValue(trainingPlan.latestCandidateEval) ?? {};
  const monotonicDataLedger = recordValue(owners.monotonicDataLedger) ?? {};
  const selfRepairHands = recordValue(owners.selfRepairHands) ?? {};
  const providerCouncil = recordValue(owners.providerCouncilAcceleration) ?? {};
  const externalChannelBinding =
    recordValue(trainingPlan.externalChannelBinding) ??
    recordValue(recordValue(owners.liveLarkBrainBinding)?.externalChannelBinding) ??
    recordValue(owners.liveLarkBrainBinding) ??
    {};
  const universeIndex = recordValue(owners.universeIndex) ?? {};
  const processSummary = recordValue(input.localFailureTrace.processSummary) ?? {};
  const counts = recordValue(processSummary.counts) ?? {};
  const activeHeavy =
    boolValue(processSummary.activeHeavy) === true ||
    boolValue(summary.activeTrainingOrEval) === true;
  const dirtyFiles = numberValue(universeIndex.dirtyFiles) ?? 0;
  const unmatchedChangedFiles = numberValue(universeIndex.unmatchedChangedFiles) ?? 0;
  const acceptedSkillOptPackets = numberValue(monotonicDataLedger.acceptedSkillOptPackets) ?? 0;
  const moduleLearningEvalAbsorbed =
    numberValue(monotonicDataLedger.moduleLearningEvalAbsorbed) ?? 0;
  const selfRepairStatus = typeof selfRepairHands.status === "string" ? selfRepairHands.status : "";
  const selfRepairLatestWritten = recordValue(selfRepairHands.latestWrittenReceipt);
  const selfRepairAutoWriteRules = selfRepairAutoWritePlainLabels(selfRepairWritePolicy);
  const parseIssueCount =
    stringArray(latestCandidateEval.parseRecoveredCaseIds).length +
    stringArray(latestCandidateEval.parseErrorCaseIds).length;
  const externalChannelMissingProof = stringArray(externalChannelBinding.missingProof);
  const externalChannelStatus =
    typeof summary.externalChannelBindingStatus === "string"
      ? summary.externalChannelBindingStatus
      : typeof externalChannelBinding.status === "string"
        ? externalChannelBinding.status
        : summary.liveLarkBrainBindingStatus;
  const providerBlocks = stringArray(providerCouncil.hardBlocks);
  const items: ControlItem[] = [];

  addIf(items, activeHeavy, {
    id: "active_eval_and_mlx",
    title: "正在跑的评测和本地模型",
    status: "blocked_now",
    ownerCanSee: true,
    ownerCanDirectNow: false,
    codexCanActWhenSafe: false,
    supervisor: "总控负责盯进程；Codex 只读汇报；老板看是否异常超时。",
    evidenceNow: "后台守护、评测、本地模型进程数和运行时长。",
    reason: `现在还能看到后台守护 ${numberValue(counts.guard) ?? 0}、评测 ${
      numberValue(counts.eval) ?? 0
    }、本地模型 ${numberValue(counts.mlx) ?? 0}，但不能安全插队。`,
    nextControl: "等它空下来，再按总控给的下一步做。",
    proceedWhen: "评测、本地模型训练都结束，并且总控给出空闲后的下一条安全命令。",
    stopWhen: "发现重叠训练、进程卡死、运行时间明显异常，或输出开始写受保护位置。",
    ownerAuthorization: "不需要你授权等待；需要重启、停止、晋级时必须另算。",
  });

  addIf(items, dirtyFiles > 0 || unmatchedChangedFiles > 0, {
    id: "dirty_and_unmatched_worktree",
    title: "脏文件和未归类文件",
    status: "codex_can_act_when_safe",
    ownerCanSee: true,
    ownerCanDirectNow: true,
    codexCanActWhenSafe: true,
    supervisor: "Codex 负责归类；总控负责把未归类数量写出来；老板看清单决定是否收口。",
    evidenceNow: "git 脏文件、未归类文件数、变更影响检查结果。",
    reason: `现在有 ${dirtyFiles} 个脏文件，其中 ${unmatchedChangedFiles} 个还没完全归到清楚的板块。`,
    nextControl: "用变更影响检查把每个文件归类成保留、继续、暂缓或清理。",
    proceedWhen: "每个文件都能说清楚属于哪个板块，以及为什么要留下。",
    stopWhen: "发现无关改动混在一起、文件归属说不清、或准备改外部通道发送/供应商/受保护记忆。",
    ownerAuthorization: "普通归类不需要；删除、回滚、提交、推送需要你明确说。",
  });

  addIf(
    items,
    externalChannelMissingProof.length > 0 || externalChannelStatus !== "ready_for_apply",
    {
      id: "external_lark_channel_real_user_proof",
      title: "真实 Lark 可见效果",
      status: "blocked_now",
      ownerCanSee: true,
      ownerCanDirectNow: false,
      codexCanActWhenSafe: true,
      supervisor: "外部通道绑定检查负责证明；Codex 只做读证据和准备；老板看是否真的用户可见。",
      evidenceNow: "真实 Lark 入站/出站证据、外部通道绑定状态、缺失证明列表。",
      reason: "现在只能看到开发侧准备情况，还缺真实 Lark 进出消息证明。",
      nextControl: "等评测空下来，再按外部通道绑定检查走真实证明。",
      proceedWhen: "有新鲜真实 Lark 收到消息和发出回复的证据，而且只绑定一个干净模型。",
      stopWhen: "只有开发探针、模拟消息、旧日志，或准备把脏候选模型接到外部 Lark 通道。",
      ownerAuthorization: "真实外部通道写入或发送必须你明确授权；只读检查不需要。",
    },
  );

  addIf(items, acceptedSkillOptPackets > 0, {
    id: "skillopt_not_model_weight",
    title: "小规则还没进模型权重",
    status: "codex_can_act_when_safe",
    ownerCanSee: true,
    ownerCanDirectNow: true,
    codexCanActWhenSafe: true,
    supervisor: "小规则检查负责收集；训练计划负责证明有没有进训练；老板看是否能当作能力。",
    evidenceNow: "已接受小规则数量、定向小考、训练切片、新模型验收结果。",
    reason: `现在有 ${acceptedSkillOptPackets} 条小规则候选，但它们还只是可用规则，不等于模型真的学会了。`,
    nextControl: "空闲后跑定向小考、训练切片和新模型验收。",
    proceedWhen: "规则进入训练材料，并且新模型在相关小考里稳定通过。",
    stopWhen: "只有规则文本，没有小考、训练切片或新模型通过证据。",
    ownerAuthorization: "整理成训练材料不需要；晋级成外部通道可见能力需要通过验收。",
  });

  addIf(items, selfRepairStatus.length > 0, {
    id: "self_repair_memory_and_training_candidate_hands",
    title: "记忆清洁手、题库修复手和补丁候选手",
    status: "codex_can_act_when_safe",
    ownerCanSee: true,
    ownerCanDirectNow: true,
    codexCanActWhenSafe: true,
    supervisor:
      "总控决定什么时候自动加 --write；自修手只写允许目录；Codex 负责审查候选能不能进入正式训练/评测/补丁路径。",
    evidenceNow:
      "self-repair latest/jsonl、记忆纠错/降权 note、训练/评测候选 packet、repo 补丁候选 packet、总控 owner 写入策略。",
    reason:
      selfRepairStatus === "write_completed" ||
      selfRepairLatestWritten?.status === "write_completed"
        ? `LCX Agent 已经能自己写允许范围内的记忆纠错、训练候选和补丁候选文件。什么时候自动写：${selfRepairAutoWriteRules}。`
        : `LCX Agent 已经有三只手可写能力演练；当前总控只做 dry-run，未写入新的候选文件。什么时候自动写：${selfRepairAutoWriteRules}。`,
    nextControl: "只有总控 owner 信号变化时才自动加 --write；同一个 signalKey 已写过就不重复写。",
    proceedWhen:
      "只写 workspace memory/self-repair、state、logs；候选通过轻量检查；训练计划确认没有重活后才能进入下一段链路。",
    stopWhen:
      "没有 owner 信号、同一个信号已经写过、试图改 repo 源码、git index/commit、受保护记忆、provider 配置、外部通道发送器、formal language corpus，或直接启动训练。",
    ownerAuthorization:
      "写普通自修候选不需要；吸收到正式训练、把补丁候选应用到 repo、启动训练或外部通道变更需要 owner 门禁。",
  });

  addIf(items, parseIssueCount > 0, {
    id: "candidate_adapter_not_clean",
    title: "候选模型还不干净",
    status: "blocked_now",
    ownerCanSee: true,
    ownerCanDirectNow: false,
    codexCanActWhenSafe: true,
    supervisor: "训练计划负责守晋级门；Codex 负责解释失败案例；老板看是否允许继续训练。",
    evidenceNow: "候选模型失败案例、格式不干净案例、当前干净模型路径。",
    reason: `候选模型还有 ${parseIssueCount} 个格式或输出不干净的案例。`,
    nextControl: "保持当前干净模型不变，只用这些失败案例做下一轮小考或训练材料。",
    proceedWhen: "失败案例清零、格式问题清零，并且仍通过基础能力小考。",
    stopWhen: "还有格式问题、明确失败，或有人想绕过干净模型直接晋级。",
    ownerAuthorization: "继续准备失败材料不需要；替换当前干净模型必须通过验收。",
  });

  addIf(items, moduleLearningEvalAbsorbed === 0, {
    id: "module_learning_not_absorbed",
    title: "资料学习还不能算真正学会",
    status: "codex_can_act_when_safe",
    ownerCanSee: true,
    ownerCanDirectNow: true,
    codexCanActWhenSafe: true,
    supervisor: "资料学习检查负责证据链；Codex 负责补齐缺口；老板看是否算学会。",
    evidenceNow: "读取范围、应用验证、小考或训练吸收证据、保留/降级/丢弃决定。",
    reason: "现在有资料、摘要和记录，但还没有足够证据说明已经进评测或训练效果。",
    nextControl: "要求每个资料都有读取范围、应用验证、小考或训练吸收证据。",
    proceedWhen: "同一份资料能在相邻任务里用出来，并有小考或训练吸收证据。",
    stopWhen: "只有摘要、截图、链接或记录，却说成模型已经学会。",
    ownerAuthorization: "补证据不需要；写入受保护记忆或长期 doctrine 需要你明确授权。",
  });

  addIf(items, providerBlocks.length > 0 || providerCouncil.action === "dry_run_plan_only", {
    id: "provider_council_blocked",
    title: "外部模型评审和高额度调用",
    status: "blocked_now",
    ownerCanSee: true,
    ownerCanDirectNow: false,
    codexCanActWhenSafe: true,
    supervisor: "外部模型评审门负责看能不能写；Codex 只在空闲且干净时执行一次。",
    evidenceNow: "外部评审状态、硬阻塞原因、下一条安全命令、工作区干净程度。",
    reason: "现在计划能看见，但被正在跑的评测或脏工作区挡住，不能直接写入。",
    nextControl: "等机器空闲且工作区干净，再跑一次写入版评审。",
    proceedWhen: "没有评测/训练在跑，工作区干净，且两小时内没有新鲜完整评审。",
    stopWhen: "机器忙、工作区脏、评审已经新鲜，或输出要改 provider/外部通道/protected 位置。",
    ownerAuthorization: "只写普通评审材料可按门禁走；改 provider 配置必须你明确授权。",
  });

  items.push({
    id: "protected_authority_boundaries",
    title: "受保护记忆、供应商配置、外部通道发送、交易执行",
    status: "never_auto",
    ownerCanSee: true,
    ownerCanDirectNow: false,
    codexCanActWhenSafe: false,
    supervisor: "老板最终负责；Codex 和自动化只负责报警，不负责放权。",
    evidenceNow:
      "legacy liveTouched、providerConfigTouched、protectedMemoryTouched、外部通道和交易执行权限边界。",
    reason: "这些是高权限边界，不能因为自动化觉得可以就自己放权。",
    nextControl: "只能在你明确授权、并且对应证明通过时才处理；交易执行默认没有权限。",
    proceedWhen: "你明确授权、范围写清楚、相关证明通过，并且不是交易执行默认禁区。",
    stopWhen: "任何自动化想自己改受保护记忆、供应商配置、外部通道发送或交易执行。",
    ownerAuthorization: "必须你明确授权；没有授权就永远不做。",
  });

  const ownerInvisible = items.filter(
    (item) => !item.ownerCanDirectNow && item.status !== "never_auto",
  );
  const codexActionable = items.filter((item) => item.codexCanActWhenSafe);
  const blockedNow = items.filter((item) => item.status === "blocked_now");
  const neverAuto = items.filter((item) => item.status === "never_auto");
  const markdown = [
    "# LCX 老板管控图",
    "",
    `生成时间：${input.checkedAt}`,
    "",
    "一句话：底层日志已经很多了，现在这张图专门告诉你哪些事老板能看见、哪些事 Codex 能代管、哪些事现在不能动、哪些事永远不能自动放权。",
    "",
    ...section("老板现在管不到什么", ownerInvisible, "暂时没有新增的老板盲区。"),
    ...supervisionSection(items),
    ...section("Codex 可以帮你管什么", codexActionable, "暂时没有适合自动推进的事项。"),
    ...section("现在先别碰什么", blockedNow, "暂时没有需要暂停的事项。"),
    ...section("永远不能自动放权什么", neverAuto, "没有高权限边界异常。"),
    "## 这张图读了哪些文件",
    ...input.paths.sourcePaths.map((sourcePath) => `- ${sourcePath}`),
    "",
    "边界：这是老板管控索引，不是新事实来源；事实仍以总控、训练计划、失败小票、真实日志和外部通道证明为准。",
    "",
  ].join("\n");

  return {
    ok: true,
    kind: "lcx-owner-control-map",
    boundary: "local_owner_control_map_only",
    checkedAt: input.checkedAt,
    summary: {
      totalItems: items.length,
      unmanagedCount: ownerInvisible.length,
      codexActionableCount: codexActionable.length,
      blockedNowCount: blockedNow.length,
      neverAutoCount: neverAuto.length,
      supervisedCount: items.length,
      ownerAuthorizationRequiredCount: items.filter((item) =>
        item.ownerAuthorization.includes("必须你明确授权"),
      ).length,
    },
    latestMarkdownPath: input.paths.latestMarkdownPath,
    latestJsonPath: input.paths.latestJsonPath,
    sourcePaths: input.paths.sourcePaths,
    items,
    markdown,
    liveTouched: input.governance.liveTouched === true,
    providerConfigTouched: input.governance.providerConfigTouched === true,
    protectedMemoryTouched: input.governance.protectedMemoryTouched === true,
  };
}

export type OwnerControlMap = ReturnType<typeof buildOwnerControlMap>;

export async function writeOwnerControlMap(map: OwnerControlMap) {
  await fs.mkdir(path.dirname(OWNER_CONTROL_MAP_LATEST_JSON_PATH), { recursive: true });
  await fs.writeFile(OWNER_CONTROL_MAP_LATEST_JSON_PATH, `${JSON.stringify(map, null, 2)}\n`);
  await fs.writeFile(OWNER_CONTROL_MAP_LATEST_MARKDOWN_PATH, `${map.markdown}\n`);
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
        "Usage: node --import tsx scripts/dev/lcx-owner-control-map.ts [--json] [--write]",
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
  const map = buildOwnerControlMap({
    checkedAt: new Date().toISOString(),
    governance,
    localFailureTrace,
    paths: {
      latestMarkdownPath: OWNER_CONTROL_MAP_LATEST_MARKDOWN_PATH,
      latestJsonPath: OWNER_CONTROL_MAP_LATEST_JSON_PATH,
      sourcePaths: [GOVERNANCE_AUTOPILOT_LATEST_PATH, LOCAL_FAILURE_TRACE_LATEST_PATH],
    },
  });
  if (options.write) {
    await writeOwnerControlMap(map);
  }
  console.log(options.json ? JSON.stringify(map, null, 2) : map.markdown);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
