import path from "node:path";
import { Type } from "@sinclair/typebox";
import { runCommandWithTimeout } from "../../process/exec.js";
import { resolveWorkspaceRoot } from "../workspace-dir.js";
import type { AnyAgentTool } from "./common.js";
import {
  ToolInputError,
  jsonResult,
  readNumberParam,
  readStringArrayParam,
  readStringParam,
} from "./common.js";

const AiderSchema = Type.Object({
  prompt: Type.String(),
  files: Type.Optional(Type.Array(Type.String())),
  readOnlyFiles: Type.Optional(Type.Array(Type.String())),
  model: Type.Optional(Type.String()),
  dryRun: Type.Optional(Type.Boolean()),
  timeoutSeconds: Type.Optional(Type.Number()),
});

type AiderCommandCandidate = {
  label: string;
  argvPrefix: string[];
};

function normalizeWorkspaceRelativePath(params: { rawPath: string; workspaceDir: string }): string {
  const trimmed = params.rawPath.trim();
  if (!trimmed) {
    throw new ToolInputError("file path required");
  }
  const expanded =
    trimmed.startsWith("~/") && process.env.HOME
      ? path.join(process.env.HOME, trimmed.slice(2))
      : trimmed;
  const absolute = path.isAbsolute(expanded)
    ? path.normalize(expanded)
    : path.normalize(path.resolve(params.workspaceDir, expanded));
  const relative = path.relative(params.workspaceDir, absolute);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new ToolInputError("aider paths must stay inside the workspace");
  }
  return relative.split(path.sep).join("/");
}

function dedupe(values: string[] | undefined): string[] {
  return Array.from(new Set((values ?? []).map((entry) => entry.trim()).filter(Boolean)));
}

function truncateOutput(value: string, maxChars = 6000): string {
  if (value.length <= maxChars) {
    return value;
  }
  return `${value.slice(0, maxChars)}\n...[truncated ${value.length - maxChars} chars]`;
}

function inferAiderRemediation(params: {
  command: string;
  stderr?: string;
  error?: string;
}): string | undefined {
  const combined = `${params.stderr ?? ""}\n${params.error ?? ""}`.toLowerCase();
  if (params.command.includes("uvx") && combined.includes("scipy")) {
    if (combined.includes("gfortran") || combined.includes("pkg-config")) {
      return "uvx aider bootstrap failed because required build tools are missing. Install gfortran and pkg-config, or point OPENCLAW_AIDER_BIN at a preinstalled aider binary.";
    }
    return "uvx aider bootstrap failed while building dependencies. Prefer a preinstalled aider binary via OPENCLAW_AIDER_BIN, or fix the local Python build environment.";
  }
  if (params.command.includes("python3 -m aider") && combined.includes("no module named aider")) {
    return "python3 can run, but the aider module is not installed in that interpreter. Install aider there or point OPENCLAW_AIDER_BIN at another aider binary.";
  }
  return undefined;
}

function buildUnavailablePayload(params: { command: string; error: string; cwd: string }) {
  return {
    ok: false,
    unavailable: true,
    command: params.command,
    cwd: params.cwd,
    error: params.error,
    action:
      "Install aider and ensure it is on PATH, or set OPENCLAW_AIDER_BIN to the aider executable.",
  };
}

function buildAiderCommandCandidates(): AiderCommandCandidate[] {
  const explicit = process.env.OPENCLAW_AIDER_BIN?.trim();
  if (explicit) {
    return [{ label: explicit, argvPrefix: [explicit] }];
  }
  return [
    { label: "aider", argvPrefix: ["aider"] },
    { label: "uvx --from aider-chat aider", argvPrefix: ["uvx", "--from", "aider-chat", "aider"] },
    { label: "python3 -m aider", argvPrefix: ["python3", "-m", "aider"] },
  ];
}

export function createAiderTool(options?: { workspaceDir?: string }): AnyAgentTool {
  const workspaceDir = resolveWorkspaceRoot(options?.workspaceDir);
  return {
    label: "Aider",
    name: "aider",
    description:
      "Run a bounded aider one-shot edit against explicit workspace files. Use this only when the user explicitly asks for aider or when an external pair-programming pass is clearly useful. Returns explicit unavailable payloads when aider is missing instead of pretending success.",
    parameters: AiderSchema,
    execute: async (_toolCallId, params) => {
      const prompt = readStringParam(params, "prompt", { required: true });
      const model = readStringParam(params, "model");
      const dryRun = params.dryRun === true;
      const timeoutSeconds = readNumberParam(params, "timeoutSeconds");
      const files = dedupe(readStringArrayParam(params, "files"));
      const readOnlyFiles = dedupe(readStringArrayParam(params, "readOnlyFiles"));

      if (files.length === 0 && readOnlyFiles.length === 0) {
        throw new ToolInputError("files or readOnlyFiles required");
      }
      if (!dryRun && files.length === 0) {
        throw new ToolInputError("editable files required unless dryRun=true");
      }

      const normalizedFiles = files.map((entry) =>
        normalizeWorkspaceRelativePath({ rawPath: entry, workspaceDir }),
      );
      const normalizedReadOnlyFiles = readOnlyFiles.map((entry) =>
        normalizeWorkspaceRelativePath({ rawPath: entry, workspaceDir }),
      );
      const baseArgs = [
        "--yes",
        "--no-auto-commits",
        "--no-dirty-commits",
        "--no-stream",
        ...(model ? ["--model", model] : []),
        ...normalizedFiles.flatMap((entry) => ["--file", entry]),
        ...normalizedReadOnlyFiles.flatMap((entry) => ["--read", entry]),
        ...(dryRun ? ["--dry-run"] : []),
        "--message",
        prompt,
      ];
      const candidates = buildAiderCommandCandidates();
      const attemptedCommands: string[] = [];
      let lastUnavailableError = "spawn aider ENOENT";

      for (const candidate of candidates) {
        const argv = [...candidate.argvPrefix, ...baseArgs];
        attemptedCommands.push(candidate.label);
        try {
          const result = await runCommandWithTimeout(argv, {
            cwd: workspaceDir,
            timeoutMs: Math.max(5, Math.floor(timeoutSeconds ?? 300)) * 1000,
          });
          return jsonResult({
            ok: result.code === 0,
            unavailable: false,
            command: candidate.label,
            cwd: workspaceDir,
            argv: argv.slice(1),
            files: normalizedFiles,
            readOnlyFiles: normalizedReadOnlyFiles,
            dryRun,
            attemptedCommands,
            exitCode: result.code,
            termination: result.termination,
            killed: result.killed,
            stdout: truncateOutput(result.stdout),
            stderr: truncateOutput(result.stderr),
            remediation:
              result.code === 0
                ? undefined
                : inferAiderRemediation({
                    command: candidate.label,
                    stderr: result.stderr,
                  }),
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          const code = (err as NodeJS.ErrnoException | undefined)?.code;
          if (code === "ENOENT" || /not found|enoent/i.test(message)) {
            lastUnavailableError = message;
            continue;
          }
          return jsonResult({
            ok: false,
            unavailable: false,
            command: candidate.label,
            cwd: workspaceDir,
            argv: argv.slice(1),
            files: normalizedFiles,
            readOnlyFiles: normalizedReadOnlyFiles,
            dryRun,
            attemptedCommands,
            error: message,
            remediation: inferAiderRemediation({
              command: candidate.label,
              error: message,
            }),
          });
        }
      }

      return jsonResult({
        ...buildUnavailablePayload({
          command: attemptedCommands[0] ?? "aider",
          error: lastUnavailableError,
          cwd: workspaceDir,
        }),
        attemptedCommands,
      });
    },
  };
}
