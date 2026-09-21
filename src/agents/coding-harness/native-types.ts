import type { OpenClawConfig } from "../../config/config.js";
import type { EmbeddedPiRunResult } from "../pi-embedded-runner/types.js";
import type { SandboxContext } from "../sandbox/types.js";

/** Process-local capability. Never accepted from JSON or persisted for replay. */
export type NativeCodingRunBinding = Readonly<{ kind: "native-coding-run" }>;
export type NativeCodingBindingView = Readonly<{
  taskId: string;
  runId: string;
  sessionId: string;
  sessionKey: string;
  workspaceDir: string;
  sessionFile: string;
  agentDir: string;
  sandbox: SandboxContext;
  config: OpenClawConfig;
  maxRuntimeMs: number;
}>;
const bindings = new WeakMap<NativeCodingRunBinding, NativeCodingBindingView>();

function freezeData<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) {
      freezeData(child);
    }
  }
  return value;
}

/** Only the trusted coordinator calls this after inspecting the actual container. */
export function issueNativeCodingBinding(view: NativeCodingBindingView): NativeCodingRunBinding {
  if (!Number.isFinite(view.maxRuntimeMs) || view.maxRuntimeMs <= 0) {
    throw new Error("native coding runtime limit must be positive");
  }
  const { fsBridge, ...sandboxData } = view.sandbox;
  const sandbox = Object.freeze({ ...freezeData(structuredClone(sandboxData)), fsBridge });
  const trusted = Object.freeze({
    ...view,
    sandbox,
    config: freezeData(structuredClone(view.config)),
  });
  const binding = Object.freeze({ kind: "native-coding-run" as const });
  bindings.set(binding, trusted);
  return binding;
}
export function resolveTrustedNativeCodingBinding(
  binding: NativeCodingRunBinding,
): NativeCodingBindingView {
  const view = bindings.get(binding);
  if (!view) {
    throw new Error("native coding binding is forged, expired, or revoked");
  }
  return view;
}
export function revokeNativeCodingBinding(binding: NativeCodingRunBinding): void {
  bindings.delete(binding);
}
export type NativeCodingRunInput = Readonly<{
  binding: NativeCodingRunBinding;
  task: string;
  requesterSessionKey: string;
  signal: AbortSignal;
  timeoutMs?: number;
}>;
export type NativeCodingRunResult = Readonly<{
  status:
    | "completed"
    | "failed"
    | "timed-out"
    | "cancelled"
    | "context-limit"
    | "blocked"
    | "interrupted";
  result?: EmbeddedPiRunResult;
  executionStarted: boolean;
  childRunId: string;
  childSessionKey: string;
  error?: string;
}>;
export type NativeCodingRunner = (input: NativeCodingRunInput) => Promise<NativeCodingRunResult>;
