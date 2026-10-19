import { Type } from "@sinclair/typebox";
import type { OpenClawConfig } from "../../config/config.js";
import { resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import { resolveAgentDir } from "../agent-scope.js";
import {
  runNativeCodingHarness,
  type NativeCodingHarnessInput,
  type NativeCoordinatorDeps,
} from "../coding-harness/native-coordinator.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readStringParam } from "./common.js";

export function createNativeCodingHarnessTool(
  options: {
    workspaceDir?: string;
    agentSessionKey?: string;
    config?: OpenClawConfig;
    sandboxed?: boolean;
    /** Immutable acceptance policy supplied by the controller, never the model. */
    verification?: NativeCodingHarnessInput["verification"];
    artifactRoot?: string;
  },
  deps?: NativeCoordinatorDeps,
): AnyAgentTool {
  const verification = options.verification
    ? Object.freeze({
        argv: Object.freeze([...options.verification.argv]),
        timeoutMs: options.verification.timeoutMs,
      })
    : undefined;
  return {
    name: "native_coding_harness",
    label: "Native Coding",
    ownerOnly: true,
    description:
      "Run an LCX coding task in an isolated Docker copy of a clean feature worktree. Returns durable patch/artifact absolute paths; never changes source or commits. Verification supports only controller-owned inline Python (/usr/bin/python3 -I -B -c CODE), never an artifact script; absent that policy, completion is unverified. Requires Docker and the configured model.",
    parameters: Type.Object(
      {
        task: Type.String({ minLength: 1, maxLength: 40_000 }),
        cwd: Type.Optional(Type.String({ minLength: 1 })),
        verify: Type.Optional(
          Type.Array(Type.String({ minLength: 1 }), { minItems: 1, maxItems: 32 }),
        ),
        timeoutSeconds: Type.Optional(Type.Number({ minimum: 1, maximum: 1800 })),
      },
      { additionalProperties: false },
    ),
    execute: async (_id, args, signal) => {
      if (
        options.sandboxed ||
        !options.workspaceDir ||
        !options.agentSessionKey ||
        !options.config
      ) {
        return jsonResult({
          status: "blocked",
          verified: false,
          error:
            "native coding requires an owner session with trusted workspace/configuration outside a sandbox",
        });
      }
      const params = args as Record<string, unknown>;
      if (
        Object.keys(params).some(
          (key) => !["task", "cwd", "timeoutSeconds", "verify"].includes(key),
        )
      ) {
        return jsonResult({
          status: "blocked",
          verified: false,
          error: "unknown arguments; model-provided verification commands are not permitted",
        });
      }
      if (
        params.verify !== undefined &&
        (!verification ||
          !Array.isArray(params.verify) ||
          JSON.stringify(params.verify) !== JSON.stringify(verification.argv))
      ) {
        return jsonResult({
          status: "blocked",
          verified: false,
          error:
            "verify must exactly match the controller-authorized acceptance argv; configure controller verification first",
        });
      }
      const task = readStringParam(params, "task", { required: true });
      const cwd = readStringParam(params, "cwd") ?? options.workspaceDir;
      const timeoutMs =
        typeof params.timeoutSeconds === "number" && Number.isFinite(params.timeoutSeconds)
          ? Math.max(1, Math.min(1800, params.timeoutSeconds)) * 1000
          : undefined;
      return jsonResult(
        await runNativeCodingHarness(
          {
            task,
            cwd,
            authorizedWorkspaceDir: options.workspaceDir,
            config: options.config,
            agentDir: resolveAgentDir(
              options.config,
              resolveAgentIdFromSessionKey(options.agentSessionKey),
            ),
            requesterSessionKey: options.agentSessionKey,
            artifactRoot: options.artifactRoot,
            timeoutMs,
            signal,
            verification,
          },
          deps,
        ),
      );
    },
  };
}
