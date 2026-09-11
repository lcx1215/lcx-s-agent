import { Type } from "@sinclair/typebox";
import { runCodexCodingHarness } from "../coding-harness/codex-acp.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readStringParam } from "./common.js";

const CodexCodingHarnessToolSchema = Type.Object({
  task: Type.String({ minLength: 1, maxLength: 40_000 }),
  cwd: Type.Optional(Type.String({ minLength: 1 })),
  agentId: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
  verify: Type.Optional(
    Type.Array(Type.String({ minLength: 1, maxLength: 500 }), { minItems: 1, maxItems: 32 }),
  ),
  timeoutSeconds: Type.Optional(Type.Number({ minimum: 1, maximum: 1_800 })),
});

export function createCodexCodingHarnessTool(opts?: {
  workspaceDir?: string;
  agentSessionKey?: string;
  agentChannel?: string;
  agentAccountId?: string;
  agentTo?: string;
  agentThreadId?: string | number;
  sandboxed?: boolean;
}): AnyAgentTool {
  return {
    label: "Codex Coding",
    name: "codex_coding_harness",
    description:
      "Run a bounded Codex coding task through the existing ACP runtime. Requires a clean non-main worktree; pass verify as an argv array to earn a verified result.",
    parameters: CodexCodingHarnessToolSchema,
    ownerOnly: true,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const task = readStringParam(params, "task", { required: true });
      const cwd = readStringParam(params, "cwd") ?? opts?.workspaceDir;
      if (!cwd) {
        return jsonResult({
          status: "forbidden",
          error: "coding harness requires cwd or a configured workspace directory",
        });
      }
      const agentId = readStringParam(params, "agentId") ?? "codex";
      const verify = Array.isArray(params.verify)
        ? params.verify.filter(
            (part): part is string => typeof part === "string" && part.trim().length > 0,
          )
        : undefined;
      const timeoutSeconds =
        typeof params.timeoutSeconds === "number" && Number.isFinite(params.timeoutSeconds)
          ? params.timeoutSeconds
          : undefined;
      const result = await runCodexCodingHarness({
        task,
        cwd,
        agentId,
        verify,
        timeoutMs: timeoutSeconds === undefined ? undefined : Math.floor(timeoutSeconds * 1_000),
        context: {
          agentSessionKey: opts?.agentSessionKey,
          agentChannel: opts?.agentChannel,
          agentAccountId: opts?.agentAccountId,
          agentTo: opts?.agentTo,
          agentThreadId: opts?.agentThreadId,
          sandboxed: opts?.sandboxed,
        },
      });
      return jsonResult(result);
    },
  };
}
