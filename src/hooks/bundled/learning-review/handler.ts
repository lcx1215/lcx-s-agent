import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveAgentWorkspaceDir } from "../../../agents/agent-scope.js";
import type { OpenClawConfig } from "../../../config/config.js";
import { resolveStateDir } from "../../../config/paths.js";
import { writeFileWithinRoot } from "../../../infra/fs-safe.js";
import { createSubsystemLogger } from "../../../logging/subsystem.js";
import { resolveAgentIdFromSessionKey } from "../../../routing/session-key.js";
import { hasInterSessionUserProvenance } from "../../../sessions/input-provenance.js";
import type { HookHandler } from "../../hooks.js";
import { generateSlugViaLLM } from "../../llm-slug-generator.js";

const log = createSubsystemLogger("hooks/learning-review");

type SessionTurn = { role: "user" | "assistant"; text: string };

const LEARNING_KEYWORDS = [
  "prove",
  "proof",
  "derive",
  "derivation",
  "equation",
  "algebra",
  "calculus",
  "derivative",
  "integral",
  "matrix",
  "linear algebra",
  "eigen",
  "probability",
  "statistics",
  "bayes",
  "expectation",
  "variance",
  "optimization",
  "math",
  "quant",
  "复盘",
  "查漏补缺",
  "推导",
  "证明",
  "概率",
  "统计",
  "导数",
  "积分",
  "矩阵",
  "线代",
  "数学",
];

function looksLikeLearningSession(turns: SessionTurn[]): boolean {
  const joined = turns
    .map((turn) => turn.text.toLowerCase())
    .join("\n");
  return LEARNING_KEYWORDS.some((keyword) => joined.includes(keyword));
}

async function getSessionTurns(sessionFilePath: string, messageCount = 18): Promise<SessionTurn[]> {
  try {
    const content = await fs.readFile(sessionFilePath, "utf-8");
    const lines = content.trim().split("\n").filter(Boolean);
    const turns: SessionTurn[] = [];

    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        if (entry.type !== "message" || !entry.message) {
          continue;
        }
        const msg = entry.message;
        const role = msg.role;
        if ((role !== "user" && role !== "assistant") || !msg.content) {
          continue;
        }
        if (role === "user" && hasInterSessionUserProvenance(msg)) {
          continue;
        }
        const text = Array.isArray(msg.content)
          ? // oxlint-disable-next-line typescript/no-explicit-any
            msg.content.find((c: any) => c.type === "text")?.text
          : msg.content;
        if (!text || text.startsWith("/")) {
          continue;
        }
        turns.push({ role, text: String(text).trim() });
      } catch {
        // Ignore bad JSONL rows.
      }
    }

    return turns.slice(-messageCount);
  } catch {
    return [];
  }
}

function compactText(text: string, max = 280): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= max) {
    return normalized;
  }
  return `${normalized.slice(0, max - 1).trimEnd()}…`;
}

function inferTopic(turns: SessionTurn[]): string {
  const joined = turns
    .map((turn) => turn.text.toLowerCase())
    .join("\n");
  if (joined.includes("probability") || joined.includes("bayes") || joined.includes("概率")) {
    return "probability-and-statistics";
  }
  if (
    joined.includes("matrix") ||
    joined.includes("eigen") ||
    joined.includes("linear algebra") ||
    joined.includes("矩阵") ||
    joined.includes("线代")
  ) {
    return "linear-algebra";
  }
  if (
    joined.includes("derivative") ||
    joined.includes("integral") ||
    joined.includes("calculus") ||
    joined.includes("导数") ||
    joined.includes("积分")
  ) {
    return "calculus";
  }
  if (joined.includes("prove") || joined.includes("proof") || joined.includes("证明")) {
    return "proof-technique";
  }
  if (joined.includes("optimization") || joined.includes("最优")) {
    return "optimization";
  }
  return "math-reasoning";
}

function reviewHintsForTopic(topic: string) {
  switch (topic) {
    case "probability-and-statistics":
      return {
        principle: "先定义随机变量、事件和条件信息，再展开公式。",
        mistake: "容易把直觉当成概率关系，或者在没有定义事件的情况下直接代公式。",
        drill: "写出一个条件概率题的事件定义，再用 Bayes 定理完整展开一次。",
        transfer: "这个模式会迁移到假设检验、期望分解和风险归因。",
      };
    case "linear-algebra":
      return {
        principle: "先看对象的维度、线性映射关系和不变量，再做运算。",
        mistake: "容易跳过维度检查，导致乘法顺序、特征结构或基变换出错。",
        drill: "任取一个 2x2 矩阵，先写维度和映射，再判断可逆性与特征值。",
        transfer: "这个模式会迁移到回归、PCA、状态转移和最优化。",
      };
    case "calculus":
      return {
        principle: "先确认目标量、变量关系和适用法则，再推导。",
        mistake: "容易在链式法则、积分变量替换和边界条件上漏一步。",
        drill: "选一道复合函数求导题，逐步标明内外层函数与每一步导数。",
        transfer: "这个模式会迁移到增长率、敏感度分析和连续时间模型。",
      };
    case "proof-technique":
      return {
        principle: "先写清假设、欲证结论和证明策略，再推进每一步。",
        mistake: "容易把结论当前提用，或省略关键的桥接论证。",
        drill: "给一个简单命题，分别尝试直接证明和反证法并比较差异。",
        transfer: "这个模式会迁移到算法正确性、上界下界和逻辑推理。",
      };
    case "optimization":
      return {
        principle: "先明确目标函数、约束和可行域，再谈最优性。",
        mistake: "容易只盯一阶条件，忽略约束、边界或凸性。",
        drill: "写一个单变量优化题，分别检查一阶条件、二阶条件和边界。",
        transfer: "这个模式会迁移到投资组合、资源配置和机器学习训练。",
      };
    default:
      return {
        principle: "先定义对象和关系，再选方法，最后做 sanity check。",
        mistake: "容易跳步，把局部直觉当成完整推理链。",
        drill: "找一道同主题小题，完整写出 givens、method、steps、checks。",
        transfer: "这个模式会迁移到所有需要分步推导和验算的任务。",
      };
  }
}

async function findPreviousSessionFile(params: {
  sessionsDir: string;
  currentSessionFile?: string;
  sessionId?: string;
}): Promise<string | undefined> {
  try {
    const files = await fs.readdir(params.sessionsDir);
    const fileSet = new Set(files);
    const trimmedSessionId = params.sessionId?.trim();

    if (params.currentSessionFile) {
      const base = path.basename(params.currentSessionFile).split(".reset.")[0];
      if (base && fileSet.has(base)) {
        return path.join(params.sessionsDir, base);
      }
    }

    if (trimmedSessionId) {
      const canonical = `${trimmedSessionId}.jsonl`;
      if (fileSet.has(canonical)) {
        return path.join(params.sessionsDir, canonical);
      }
      const topicVariants = files
        .filter(
          (name) =>
            name.startsWith(`${trimmedSessionId}-topic-`) &&
            name.endsWith(".jsonl") &&
            !name.includes(".reset."),
        )
        .toSorted()
        .toReversed();
      if (topicVariants.length > 0) {
        return path.join(params.sessionsDir, topicVariants[0]);
      }
    }
  } catch {
    // Ignore lookup errors.
  }
  return undefined;
}

async function resolveSessionFile(params: {
  workspaceDir: string;
  sessionId?: string;
  sessionFile?: string;
}): Promise<string | undefined> {
  const sessionsDirs = new Set<string>();
  if (params.sessionFile) {
    sessionsDirs.add(path.dirname(params.sessionFile));
  }
  sessionsDirs.add(path.join(params.workspaceDir, "sessions"));

  for (const sessionsDir of sessionsDirs) {
    const recovered = await findPreviousSessionFile({
      sessionsDir,
      currentSessionFile: params.sessionFile,
      sessionId: params.sessionId,
    });
    if (recovered) {
      return recovered;
    }
  }
  return params.sessionFile;
}

async function generateReviewSlug(params: {
  turns: SessionTurn[];
  cfg?: OpenClawConfig;
}): Promise<string> {
  const isTestEnv =
    process.env.OPENCLAW_TEST_FAST === "1" ||
    process.env.VITEST === "true" ||
    process.env.VITEST === "1" ||
    process.env.NODE_ENV === "test";

  if (!isTestEnv && params.cfg) {
    const sessionContent = params.turns.map((turn) => `${turn.role}: ${turn.text}`).join("\n");
    const slug = await generateSlugViaLLM({ sessionContent, cfg: params.cfg });
    if (slug) {
      return `review-${slug}`;
    }
  }

  return `review-${inferTopic(params.turns)}`;
}

const saveLearningReview: HookHandler = async (event) => {
  if (event.type !== "command" || (event.action !== "new" && event.action !== "reset")) {
    return;
  }

  try {
    const context = event.context || {};
    const cfg = context.cfg as OpenClawConfig | undefined;
    const agentId = resolveAgentIdFromSessionKey(event.sessionKey);
    const workspaceDir = cfg
      ? resolveAgentWorkspaceDir(cfg, agentId)
      : path.join(resolveStateDir(process.env, os.homedir), "workspace");
    const memoryDir = path.join(workspaceDir, "memory");
    await fs.mkdir(memoryDir, { recursive: true });

    const sessionEntry = (context.previousSessionEntry || context.sessionEntry || {}) as Record<
      string,
      unknown
    >;
    const sessionId = sessionEntry.sessionId as string | undefined;
    const sessionFile = await resolveSessionFile({
      workspaceDir,
      sessionId,
      sessionFile: sessionEntry.sessionFile as string | undefined,
    });
    if (!sessionFile) {
      return;
    }

    const turns = await getSessionTurns(sessionFile);
    if (!looksLikeLearningSession(turns)) {
      return;
    }

    const now = new Date(event.timestamp);
    const dateStr = now.toISOString().split("T")[0];
    const timeStr = now.toISOString().split("T")[1].split(".")[0];
    const topic = inferTopic(turns);
    const hints = reviewHintsForTopic(topic);
    const latestUser = [...turns].reverse().find((turn) => turn.role === "user")?.text ?? "";
    const latestAssistant =
      [...turns].reverse().find((turn) => turn.role === "assistant")?.text ?? "";
    const slug = await generateReviewSlug({ turns, cfg });
    const filename = `${dateStr}-${slug}.md`;

    const entry = [
      `# Learning Review: ${dateStr} ${timeStr} UTC`,
      "",
      `- **Session Key**: ${event.sessionKey}`,
      `- **Session ID**: ${sessionId ?? "unknown"}`,
      `- **Topic**: ${topic}`,
      "",
      "## Problem",
      `- ${compactText(latestUser || turns[0]?.text || "Study-heavy session")}`,
      "",
      "## Working Answer",
      `- ${compactText(latestAssistant || "No assistant answer captured.")}`,
      "",
      "## Review Note",
      `- mistake_pattern: ${hints.mistake}`,
      `- core_principle: ${hints.principle}`,
      `- micro_drill: ${hints.drill}`,
      `- transfer_hint: ${hints.transfer}`,
      "",
      "## Session Trace",
      ...turns.slice(-8).map((turn) => `- ${turn.role}: ${compactText(turn.text, 160)}`),
      "",
    ].join("\n");

    await writeFileWithinRoot({
      rootDir: memoryDir,
      relativePath: filename,
      data: entry,
      encoding: "utf-8",
    });

    log.info(`Learning review saved to ${path.join(memoryDir, filename).replace(os.homedir(), "~")}`);
  } catch (err) {
    if (err instanceof Error) {
      log.error("Failed to save learning review", {
        errorName: err.name,
        errorMessage: err.message,
        stack: err.stack,
      });
    } else {
      log.error("Failed to save learning review", { error: String(err) });
    }
  }
};

export default saveLearningReview;
