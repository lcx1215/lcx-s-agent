import type { LcxEngineHost, LcxEngineHostContext } from "./types.js";

/** Current host identity; it can be replaced without changing LCX contracts. */
export const LCX_OPENCLAW_EMBEDDED_HOST_ID = "openclaw.embedded" as const;
export const LCX_OPENCLAW_CLI_HOST_ID = "openclaw.cli" as const;

function createOpenClawHost<HostResult>(
  id: string,
  run: (context: LcxEngineHostContext) => Promise<HostResult>,
): LcxEngineHost<HostResult> {
  return { id, run };
}

export function createOpenClawEmbeddedHost<HostResult>(
  run: (context: LcxEngineHostContext) => Promise<HostResult>,
): LcxEngineHost<HostResult> {
  return createOpenClawHost(LCX_OPENCLAW_EMBEDDED_HOST_ID, run);
}

export function createOpenClawCliHost<HostResult>(
  run: (context: LcxEngineHostContext) => Promise<HostResult>,
): LcxEngineHost<HostResult> {
  return createOpenClawHost(LCX_OPENCLAW_CLI_HOST_ID, run);
}
