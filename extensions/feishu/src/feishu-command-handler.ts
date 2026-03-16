const DEFAULT_RESET_TRIGGERS = ["/new", "/reset"] as const;
const FEISHU_RESET_INTENT_ALIASES = new Set([
  "继续",
  "继续一下",
  "继续这个研究线",
  "继续这个研究",
  "继续当前研究",
  "继续当前基本面研究",
  "继续当前方法研究",
  "继续当前学习线",
  "把我这五天学的这些吸收进去",
  "把我这几天学的这些吸收进去",
  "把这些内容吸收进去",
  "把这些内容整理进当前基本面研究",
  "整理进当前基本面研究",
  "把这些内容整理进当前方法研究",
  "整理进当前方法研究",
  "把这些内容整理进当前学习复盘",
] as const);

type FeishuBeforeResetContext = {
  cfg: Record<string, unknown>;
  sessionEntry: Record<string, unknown>;
  previousSessionEntry?: Record<string, unknown>;
  commandSource: string;
  timestamp: number;
};

type FeishuBeforeResetEvent = {
  type: "command";
  action: "new" | "reset";
  context: FeishuBeforeResetContext;
};

type FeishuBeforeResetRunner = {
  runBeforeReset: (
    event: FeishuBeforeResetEvent,
    ctx: { agentId: string; sessionKey: string },
  ) => Promise<void>;
};

function normalizeFeishuAliasCandidate(messageText: string): string {
  return messageText
    .trim()
    .replace(/[。！？!?]+$/u, "")
    .replace(/\s+/g, " ");
}

/**
 * Normalize a small set of explicit Feishu "continue / absorb" phrases into
 * the existing /new flow so we reuse the current reset + memory hooks.
 */
export function normalizeFeishuCommandText(messageText: string): string {
  const trimmed = messageText.trim();
  if (!trimmed) {
    return trimmed;
  }

  const normalizedAlias = normalizeFeishuAliasCandidate(trimmed);
  const lowered = normalizedAlias.toLowerCase();
  const isResetCommand = DEFAULT_RESET_TRIGGERS.some(
    (trigger) => lowered === trigger || lowered.startsWith(`${trigger} `),
  );
  if (isResetCommand) {
    return trimmed;
  }

  if (FEISHU_RESET_INTENT_ALIASES.has(normalizedAlias)) {
    return `/new ${normalizedAlias}`;
  }

  return trimmed;
}

/**
 * Handle Feishu command messages and trigger reset hooks.
 */
export async function handleFeishuCommand(
  messageText: string,
  sessionKey: string,
  hookRunner: FeishuBeforeResetRunner,
  context: FeishuBeforeResetContext,
): Promise<boolean> {
  const trimmed = normalizeFeishuCommandText(messageText).toLowerCase();
  const isResetCommand = DEFAULT_RESET_TRIGGERS.some(
    (trigger) => trimmed === trigger || trimmed.startsWith(`${trigger} `),
  );
  if (!isResetCommand) {
    return false;
  }

  const command = trimmed.split(" ")[0];
  const action: "new" | "reset" = command === "/new" ? "new" : "reset";
  await hookRunner.runBeforeReset(
    {
      type: "command",
      action,
      context: {
        ...context,
        commandSource: "feishu",
      },
    },
    {
      agentId: "main",
      sessionKey,
    },
  );

  return true;
}
