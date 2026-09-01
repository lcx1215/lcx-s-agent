import type { LcxEngineHost, LcxEngineHostContext } from "./types.js";

/**
 * Stable LCX-side identity for the v2026.8.x OpenClaw AgentHarness seam.
 * This is deliberately explicit-only until a version-specific plugin adapter
 * has proved the complete OpenClaw attempt contract and rollback path.
 */
export const LCX_OPENCLAW_AGENT_HARNESS_ID = "lcx-engine" as const;
export const LCX_OPENCLAW_AGENT_HARNESS_LABEL = "LCX Engine" as const;
export const LCX_OPENCLAW_AGENT_HARNESS_SEAM = "openclaw.agent-harness.v2" as const;

/** Secret-free subset needed by the LCX-side support decision. */
export type LcxOpenClawHarnessSupportContext = Readonly<{
  provider: string;
  modelId?: string;
  requestedRuntime?: string;
}>;

/** Mirrors the latest OpenClaw support decision without importing its SDK. */
export type LcxOpenClawHarnessSupport =
  | { supported: true; priority?: number; reason?: string }
  | { supported: false; reason?: string; fallbackRuntime?: "openclaw" };

/**
 * Internal bridge shape for the latest OpenClaw harness. The current fork does
 * not ship the v2026.8.1 AgentHarness SDK, so the actual plugin adapter must
 * translate OpenClaw's version-owned AttemptParams into this context.
 */
export type LcxOpenClawHarnessBoundary<HostResult> = {
  id: typeof LCX_OPENCLAW_AGENT_HARNESS_ID;
  label: typeof LCX_OPENCLAW_AGENT_HARNESS_LABEL;
  supports: (context: LcxOpenClawHarnessSupportContext) => LcxOpenClawHarnessSupport;
  runAttempt: (context: LcxEngineHostContext) => Promise<HostResult>;
};

export type LcxOpenClawHarnessBridge<HostResult> = {
  seam: typeof LCX_OPENCLAW_AGENT_HARNESS_SEAM;
  harness: LcxOpenClawHarnessBoundary<HostResult>;
  host: LcxEngineHost<HostResult>;
};

function defaultSupport(context: LcxOpenClawHarnessSupportContext): LcxOpenClawHarnessSupport {
  if (context.requestedRuntime !== LCX_OPENCLAW_AGENT_HARNESS_ID) {
    return {
      supported: false,
      reason: `explicit runtime ${LCX_OPENCLAW_AGENT_HARNESS_ID} is required; keep OpenClaw as fallback`,
      fallbackRuntime: "openclaw",
    };
  }
  return {
    supported: true,
    priority: 100,
    reason: "LCX Engine owns deterministic preflight; OpenClaw owns attempt execution",
  };
}

/**
 * Creates the LCX-side object that a future v2026.8.x plugin registration can
 * wrap. It does not register itself, change runtime selection, or contact an
 * external channel.
 */
export function createOpenClawHarnessBridge<HostResult>(
  host: LcxEngineHost<HostResult>,
  options: {
    supports?: (context: LcxOpenClawHarnessSupportContext) => LcxOpenClawHarnessSupport;
  } = {},
): LcxOpenClawHarnessBridge<HostResult> {
  return {
    seam: LCX_OPENCLAW_AGENT_HARNESS_SEAM,
    host,
    harness: {
      id: LCX_OPENCLAW_AGENT_HARNESS_ID,
      label: LCX_OPENCLAW_AGENT_HARNESS_LABEL,
      supports: options.supports ?? defaultSupport,
      runAttempt: (context) => host.run(context),
    },
  };
}
