const DEFAULT_RESET_TRIGGERS = ["/new", "/reset"] as const;

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

/**
 * Keep Feishu natural language untouched. Only explicit slash commands should
 * enter reset handling; otherwise "继续" style turns can jump across lanes and
 * contaminate the wrong workflow.
 */
export function normalizeFeishuCommandText(messageText: string): string {
  return messageText.trim();
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
