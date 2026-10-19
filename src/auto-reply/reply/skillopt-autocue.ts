import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export type SkillOptAutoCue = {
  matchedSkillIds: string[];
  bestSkillPaths: string[];
  promptInjection: string;
  readback: SkillOptReadback[];
  boundary: "local_skillopt_preflight_only";
  liveTouched: false;
  providerConfigTouched: false;
  protectedMemoryTouched: false;
};

export type SkillOptReadback = {
  skillId: string;
  bestSkillPath: string;
  bestSkillSha256: string | null;
  excerptSha256: string | null;
  receiptPath: string;
  receiptSha256: string | null;
  candidatePath: string | null;
  candidateSha256: string | null;
  sourceKind: "legacy_sop_context" | "bootstrap_context" | "candidate_unverified" | "unknown";
  evaluationStatus: string | null;
  behaviorAccepted: false;
  bodyIncluded: boolean;
  gaps: string[];
};

function skillOptRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

async function inspectSkillOptReadback(
  workspaceDir: string,
  skillId: string,
  absolutePath: string,
  body: string,
): Promise<SkillOptReadback> {
  const readback: SkillOptReadback = {
    skillId,
    bestSkillPath: absolutePath,
    bestSkillSha256: createHash("sha256").update(body).digest("hex"),
    receiptPath: path.join(path.dirname(absolutePath), "skillopt-lite-latest.json"),
    excerptSha256: null,
    receiptSha256: null,
    candidatePath: null,
    candidateSha256: null,
    sourceKind: "unknown",
    evaluationStatus: null,
    behaviorAccepted: false,
    bodyIncluded: false,
    gaps: [],
  };
  const hasCandidateBlock =
    /^## Candidate Edit:/mu.test(body) || /pending_eval_acceptance/u.test(body);
  let receipt: Record<string, unknown>;
  try {
    const bytes = await fs.readFile(readback.receiptPath);
    readback.receiptSha256 = createHash("sha256").update(bytes).digest("hex");
    receipt = skillOptRecord(JSON.parse(bytes.toString("utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" && !hasCandidateBlock) {
      readback.sourceKind = "legacy_sop_context";
      readback.bodyIncluded = true;
    } else {
      readback.gaps.push(
        hasCandidateBlock ? "candidate_receipt_unavailable" : "skill_receipt_unreadable",
      );
    }
    return readback;
  }
  if (
    receipt.boundary !== "local_skillopt_lite_only" ||
    receipt.skillId !== skillId ||
    typeof receipt.bestSkillPath !== "string" ||
    path.resolve(workspaceDir, receipt.bestSkillPath) !== absolutePath
  ) {
    readback.gaps.push("skill_receipt_scope_conflict");
  }
  const targetedEval = skillOptRecord(skillOptRecord(receipt.proofChain).targetedEval);
  readback.evaluationStatus = typeof targetedEval.status === "string" ? targetedEval.status : null;
  const identities = Array.isArray(targetedEval.candidateIdentities)
    ? targetedEval.candidateIdentities
        .map(skillOptRecord)
        .filter((entry) => entry.skillId === skillId)
    : [];
  if (identities.length !== 1 || identities[0]?.sha256 !== readback.bestSkillSha256) {
    readback.gaps.push("best_skill_identity_hash_conflict");
  }
  const candidate =
    receipt.phase === "candidate-edit" ||
    hasCandidateBlock ||
    (typeof receipt.status === "string" && receipt.status.startsWith("candidate_edit_"));
  if (candidate) {
    readback.sourceKind = "candidate_unverified";
    if (typeof receipt.candidatePath === "string") {
      const candidatePath = path.resolve(workspaceDir, receipt.candidatePath);
      const relative = path.relative(workspaceDir, candidatePath);
      if (
        relative.startsWith("..") ||
        path.isAbsolute(relative) ||
        identities[0]?.path !== candidatePath
      ) {
        readback.gaps.push("candidate_identity_scope_conflict");
      } else {
        readback.candidatePath = candidatePath;
        try {
          const bytes = await fs.readFile(candidatePath);
          readback.candidateSha256 = createHash("sha256").update(bytes).digest("hex");
          if (readback.candidateSha256 !== identities[0]?.sha256) {
            readback.gaps.push("candidate_file_hash_conflict");
          }
        } catch {
          readback.gaps.push("candidate_file_unavailable");
        }
      }
    } else {
      readback.gaps.push("candidate_identity_missing");
    }
    // The original evaluator currently cannot pair candidate Skill text with baseline
    // behavior. Static acceptance must never become behavioral acceptance at this read seam.
    readback.gaps.push("candidate_behavior_eval_not_supported");
  } else if (
    receipt.phase === "bootstrap" &&
    receipt.status === "bootstrap_best_skill_seed_ready" &&
    receipt.accepted === true &&
    receipt.staticGateOk === true
  ) {
    readback.sourceKind = "bootstrap_context";
  } else {
    readback.gaps.push("unclassified_skillopt_receipt_status");
  }
  if (typeof receipt.sourceAutopilotPath === "string") {
    const sourcePath = path.resolve(workspaceDir, receipt.sourceAutopilotPath);
    const relative = path.relative(workspaceDir, sourcePath);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      readback.gaps.push("skill_source_scope_conflict");
    } else {
      try {
        const source = skillOptRecord(JSON.parse(await fs.readFile(sourcePath, "utf8")));
        const sourceTime = Date.parse(typeof source.checkedAt === "string" ? source.checkedAt : "");
        const receiptTime = Date.parse(
          typeof receipt.checkedAt === "string" ? receipt.checkedAt : "",
        );
        if (
          !Number.isFinite(sourceTime) ||
          !Number.isFinite(receiptTime) ||
          source.checkedAt !== receipt.sourceAutopilotCheckedAt ||
          sourceTime > receiptTime
        ) {
          readback.gaps.push("skill_source_snapshot_stale_or_time_conflict");
        }
      } catch {
        readback.gaps.push("skill_source_snapshot_unavailable");
      }
    }
  } else {
    readback.gaps.push("skill_source_snapshot_missing");
  }
  readback.bodyIncluded = readback.gaps.length === 0 && readback.sourceKind === "bootstrap_context";
  return readback;
}

type SkillOptAutoCueRule = {
  skillId: string;
  title: string;
  reason: string;
  patterns: RegExp[];
};

const MAX_MATCHED_SKILLOPT_CUES = 3;
const MAX_BEST_SKILL_CHARS = 1800;

const SKILLOPT_AUTO_CUE_RULES: SkillOptAutoCueRule[] = [
  {
    skillId: "finance_data_provenance_preflight",
    title: "finance data provenance preflight",
    reason:
      "the request asks for current, priced, vendor-sourced, fundamental, ETF, options, or macro numbers",
    patterns: [
      /最新.{0,12}(价格|数据|估值|财报|宏观|利率|通胀|etf|期权|持仓|成交|供应商)/i,
      /(价格|估值|财报|利率|通胀|持仓|成交量|options?|ETF).{0,16}(来源|口径|单位|时间戳|供应商|vendor)/i,
      /\b(qqq|spy|tlt|nvda|aapl|msft|tsla|amd|etf|options?)\b/i,
      /finance.{0,16}(data|provenance|gateway|source)/i,
    ],
  },
  {
    skillId: "single_stock_curve_technical_timing_preflight",
    title: "single stock curve technical timing preflight",
    reason:
      "the request asks for single-stock curve, technical timing, entry, exit, invalidation, or position timing",
    patterns: [
      /个股.{0,16}(曲线|走势|技术|买点|卖点|入场|出场|止损|仓位)/,
      /(技术面|均线|支撑|阻力|突破|回撤|趋势|timing|entry|exit).{0,16}(个股|股票|NVDA|TSLA|AAPL|MSFT)/i,
      /single.{0,8}stock.{0,16}(curve|technical|timing|entry|exit)/i,
    ],
  },
  {
    skillId: "local_memory_conflict_preflight",
    title: "local memory conflict preflight",
    reason:
      "the request depends on previous local memory, stale notes, conflict resolution, or durable recall",
    patterns: [
      /(之前|上次|记忆|memory|沉淀|旧结论|旧笔记|旧快照).{0,18}(冲突|过期|更新|引用|证明|恢复|接上)/i,
      /local.{0,8}memory.{0,16}(conflict|stale|recall|preflight)/i,
      /上下文.{0,12}(恢复|丢了|接上|延续)/,
    ],
  },
  {
    skillId: "sentiment_vendor_source_gate_preflight",
    title: "sentiment and vendor source gate preflight",
    reason:
      "the request uses weak finance sources such as interviews, blogs, podcasts, sentiment, or market-attention stories",
    patterns: [
      /(采访|访谈|博客|播客|推特|社媒|情绪|舆情|网红|投资人观点|管理层讲话).{0,18}(学习|判断|影响|催化|来源|证明)/,
      /(sentiment|blog|podcast|interview|vendor).{0,18}(source|gate|finance|market)/i,
      /alternative.{0,8}finance.{0,16}source/i,
    ],
  },
  {
    skillId: "module_learning_absorption_preflight",
    title: "module learning absorption preflight",
    reason:
      "the request asks whether a source, module, or new skill was actually internalized beyond stored-only receipts",
    patterns: [
      /(模块|module|资料|source|skill|技能|知识).{0,20}(学习|内化|吸收|沉淀|会用|真的用了|学会)/i,
      /(stored[-_\s]?only|eval[-_\s]?absorbed|application[-_\s]?ready|absorption)/i,
      /模型.{0,12}(全种吸收|权重吸收|真的学会|会用了)/,
    ],
  },
  {
    skillId: "external_channel_boundary_preflight",
    title: "external-channel boundary preflight",
    reason:
      "the request touches external message external-channel binding, legacy live sidecar sync, or user-visible proof boundaries",
    patterns: [
      // These aliases recognize historical user wording only; they never grant a second local repository or runtime authority.
      /(live|external|external|外部消息通道|live仓|live repo|sidecar|livelock|lock).{0,24}(连接|同步|直接用|证明|可见|回复|迁移|手动搬|格式)/i,
      /(dev|开发仓).{0,12}(live|live仓|sidecar|外部消息通道|External).{0,18}(同步|迁移|漂移|直接用)/i,
      /live[-_\s]?user[-_\s]?seen/i,
    ],
  },
];

function uniquePaths(paths: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const candidate of paths) {
    const trimmed = candidate.trim();
    if (!trimmed) {
      continue;
    }
    const resolved = path.resolve(trimmed);
    if (!seen.has(resolved)) {
      seen.add(resolved);
      result.push(resolved);
    }
  }
  return result;
}

function resolveSkillOptWorkspaceDirs(params: {
  workspaceDir: string;
  extraWorkspaceDirs?: string[];
  includeDefaultWorkspace?: boolean;
}): string[] {
  const dirs = [params.workspaceDir, ...(params.extraWorkspaceDirs ?? [])];
  if (params.includeDefaultWorkspace !== false) {
    const envWorkspace = process.env.OPENCLAW_WORKSPACE_DIR;
    if (envWorkspace) {
      dirs.push(envWorkspace);
    }
    dirs.push(path.join(os.homedir(), ".openclaw", "workspace"));
  }
  return uniquePaths(dirs);
}

async function readBestSkill(params: {
  workspaceDirs: string[];
  skillId: string;
}): Promise<{ absolutePath: string; body: string; readback: SkillOptReadback } | null> {
  for (const workspaceDir of params.workspaceDirs) {
    const absolutePath = path.join(
      workspaceDir,
      "memory",
      "skillopt-lite",
      params.skillId,
      "best_skill.md",
    );
    try {
      const body = await fs.readFile(absolutePath, "utf8");
      if (body.trim()) {
        const readback = await inspectSkillOptReadback(
          workspaceDir,
          params.skillId,
          absolutePath,
          body,
        );
        if (readback.bodyIncluded) {
          readback.excerptSha256 = createHash("sha256")
            .update(formatBestSkillExcerpt(body))
            .digest("hex");
        }
        return { absolutePath, body, readback };
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") {
        throw error;
      }
      try {
        await fs.access(path.join(path.dirname(absolutePath), "skillopt-lite-latest.json"));
      } catch {
        continue;
      }
      const readback = await inspectSkillOptReadback(
        workspaceDir,
        params.skillId,
        absolutePath,
        "",
      );
      readback.bestSkillSha256 = null;
      readback.bodyIncluded = false;
      readback.gaps.unshift("best_skill_body_missing");
      return { absolutePath, body: "", readback };
    }
  }
  return null;
}

function formatBestSkillExcerpt(body: string): string {
  const trimmed = body.trim();
  if (trimmed.length <= MAX_BEST_SKILL_CHARS) {
    return trimmed;
  }
  return `${trimmed.slice(0, MAX_BEST_SKILL_CHARS).trimEnd()}\n[SkillOpt excerpt truncated]`;
}

function renderPromptInjection(params: {
  matched: Array<{
    rule: SkillOptAutoCueRule;
    bestSkillPath: string;
    bestSkillBody: string;
  }>;
}): string {
  const blocks = params.matched.map((entry, index) =>
    [
      `SkillOpt match ${index + 1}: ${entry.rule.title}`,
      `skillId: ${entry.rule.skillId}`,
      `reason: ${entry.rule.reason}`,
      `bestSkillPath: ${entry.bestSkillPath}`,
      "Apply this SOP internally before planning the answer. Do not expose SkillOpt labels, file paths, receipts, or proof jargon in the visible reply unless the user explicitly asks for protocol proof.",
      "",
      "[best_skill.md excerpt]",
      formatBestSkillExcerpt(entry.bestSkillBody),
    ].join("\n"),
  );
  return [
    "[SkillOpt-lite runtime preflight - deterministic]",
    "Boundary: local_skillopt_preflight_only. This is an internal planning cue, not model-weight absorption, not user-visible-observed proof, and not permission to touch provider config, protected memory, external channel sender, or trading authority.",
    "",
    ...blocks,
  ].join("\n\n");
}

export async function resolveSkillOptAutoCue(params: {
  body: string;
  workspaceDir: string;
  extraWorkspaceDirs?: string[];
  includeDefaultWorkspace?: boolean;
}): Promise<SkillOptAutoCue | null> {
  const body = params.body.trim();
  if (!body) {
    return null;
  }
  const workspaceDirs = resolveSkillOptWorkspaceDirs(params);
  const readback: SkillOptReadback[] = [];
  const matched: Array<{
    rule: SkillOptAutoCueRule;
    bestSkillPath: string;
    bestSkillBody: string;
  }> = [];
  for (const rule of SKILLOPT_AUTO_CUE_RULES) {
    if (!rule.patterns.some((pattern) => pattern.test(body))) {
      continue;
    }
    const bestSkill = await readBestSkill({ workspaceDirs, skillId: rule.skillId });
    if (!bestSkill) {
      continue;
    }
    readback.push(bestSkill.readback);
    if (!bestSkill.readback.bodyIncluded) {
      continue;
    }
    matched.push({
      rule,
      bestSkillPath: bestSkill.absolutePath,
      bestSkillBody: bestSkill.body,
    });
    if (matched.length >= MAX_MATCHED_SKILLOPT_CUES) {
      break;
    }
  }
  if (matched.length === 0 && readback.length === 0) {
    return null;
  }
  return {
    matchedSkillIds: matched.map((entry) => entry.rule.skillId),
    bestSkillPaths: matched.map((entry) => entry.bestSkillPath),
    readback,
    promptInjection: [
      matched.length ? renderPromptInjection({ matched }) : "",
      ...readback
        .filter((entry) => !entry.bodyIncluded)
        .map((entry) =>
          [
            "[SkillOpt-lite preflight gap]",
            `skillId: ${entry.skillId}`,
            `reason: ${entry.gaps.join(", ")}`,
            "Keep this provenance gap internal; explain only the missing evidence in visible replies unless protocol proof was requested.",
            "The optimization candidate is not accepted and its body was excluded. Keep the original question and existing checks; do not claim this Skill improved behavior or was adopted.",
          ].join("\n"),
        ),
      readback.some((entry) => entry.bodyIncluded)
        ? "Loaded SOP excerpts are context only; behavioral evaluation and model-weight adoption are not proven."
        : "",
    ]
      .filter(Boolean)
      .join("\n\n"),
    boundary: "local_skillopt_preflight_only",
    liveTouched: false,
    providerConfigTouched: false,
    protectedMemoryTouched: false,
  };
}

export function applySkillOptAutoCueToBody(params: {
  body: string;
  cue: SkillOptAutoCue | null;
}): string {
  if (!params.cue) {
    return params.body;
  }
  return [
    params.cue.promptInjection,
    "",
    "[Original user request after SkillOpt-lite preflight]",
    params.body,
  ].join("\n");
}
