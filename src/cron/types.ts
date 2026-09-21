import type { ChannelId } from "../channels/plugins/types.js";
import type { CronJobBase } from "./types-shared.js";

export type CronSchedule =
  | { kind: "at"; at: string }
  | { kind: "every"; everyMs: number; anchorMs?: number }
  | {
      kind: "cron";
      expr: string;
      tz?: string;
      /** Optional deterministic stagger window in milliseconds (0 keeps exact schedule). */
      staggerMs?: number;
    };

export type CronSessionTarget = "main" | "isolated";
export type CronWakeMode = "next-heartbeat" | "now";

export type CronMessageChannel = ChannelId | "last";

export type CronDeliveryMode = "none" | "announce" | "webhook";

export type CronDelivery = {
  mode: CronDeliveryMode;
  channel?: CronMessageChannel;
  to?: string;
  /** Explicit channel account id for multi-account setups (e.g. multiple Telegram bots). */
  accountId?: string;
  bestEffort?: boolean;
  /** Separate destination for failure notifications. */
  failureDestination?: CronFailureDestination;
};

export type CronFailureDestination = {
  channel?: CronMessageChannel;
  to?: string;
  accountId?: string;
  mode?: "announce" | "webhook";
};

export type CronDeliveryPatch = Partial<CronDelivery>;

export type CronRunStatus = "ok" | "error" | "skipped";
export type CronDeliveryStatus = "delivered" | "not-delivered" | "unknown" | "not-requested";

export type CronUsageSummary = {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  cache_read_tokens?: number;
  cache_write_tokens?: number;
};

export type CronRunTelemetry = {
  model?: string;
  provider?: string;
  usage?: CronUsageSummary;
};

export type CronRunOutcome = {
  status: CronRunStatus;
  error?: string;
  /** Optional classifier for execution errors to guide fallback behavior. */
  errorKind?: "delivery-target";
  summary?: string;
  sessionId?: string;
  sessionKey?: string;
};

export type CronFailureAlert = {
  after?: number;
  channel?: CronMessageChannel;
  to?: string;
  cooldownMs?: number;
  /** Delivery mode: announce (via messaging channels) or webhook (HTTP POST). */
  mode?: "announce" | "webhook";
  /** Account ID for multi-account channel configurations. */
  accountId?: string;
};

/**
 * Patch shape for a per-job failure alert. Mirrors `CronFailureAlertPatchSchema`: every
 * subfield may additionally be `null`, which drops that per-job override so the field
 * falls back to the global cron `failureAlert` config.
 *
 * Written out explicitly rather than as a mapped type over {@link CronFailureAlert} so it
 * stays in lockstep with the wire schema, which widens exactly these six keys.
 */
export type CronFailureAlertPatch = {
  after?: number | null;
  channel?: CronMessageChannel | null;
  to?: string | null;
  cooldownMs?: number | null;
  mode?: "announce" | "webhook" | null;
  accountId?: string | null;
};

export type CronPayload = { kind: "systemEvent"; text: string } | CronAgentTurnPayload;

export type CronPayloadPatch = { kind: "systemEvent"; text?: string } | CronAgentTurnPayloadPatch;

type CronAgentTurnPayloadFields = {
  message: string;
  /** Optional model override (provider/model or alias). */
  model?: string;
  /** Optional per-job fallback models; overrides agent/global fallbacks when defined. */
  fallbacks?: string[];
  thinking?: string;
  timeoutSeconds?: number;
  allowUnsafeExternalContent?: boolean;
  /** If true, run with lightweight bootstrap context. */
  lightContext?: boolean;
  deliver?: boolean;
  channel?: CronMessageChannel;
  to?: string;
  bestEffortDeliver?: boolean;
};

type CronAgentTurnPayload = {
  kind: "agentTurn";
} & CronAgentTurnPayloadFields;

type CronAgentTurnPayloadPatch = {
  kind: "agentTurn";
} & Partial<CronAgentTurnPayloadFields>;

export type CronJobState = {
  nextRunAtMs?: number;
  runningAtMs?: number;
  lastRunAtMs?: number;
  /** Preferred execution outcome field. */
  lastRunStatus?: CronRunStatus;
  /** Back-compat alias for lastRunStatus. */
  lastStatus?: "ok" | "error" | "skipped";
  lastError?: string;
  lastDurationMs?: number;
  /** Number of consecutive execution errors (reset on success). Used for backoff. */
  consecutiveErrors?: number;
  /** Last failure alert timestamp (ms since epoch) for cooldown gating. */
  lastFailureAlertAtMs?: number;
  /** Number of consecutive schedule computation errors. Auto-disables job after threshold. */
  scheduleErrorCount?: number;
  /** Explicit delivery outcome, separate from execution outcome. */
  lastDeliveryStatus?: CronDeliveryStatus;
  /** Delivery-specific error text when available. */
  lastDeliveryError?: string;
  /** Whether the last run's output was delivered to the target channel. */
  lastDelivered?: boolean;
};

export type CronJob = CronJobBase<
  CronSchedule,
  CronSessionTarget,
  CronWakeMode,
  CronPayload,
  CronDelivery,
  CronFailureAlert | false
> & {
  state: CronJobState;
};

export type CronStoreFile = {
  version: 1;
  jobs: CronJob[];
};

export type CronJobCreate = Omit<CronJob, "id" | "createdAtMs" | "updatedAtMs" | "state"> & {
  state?: Partial<CronJobState>;
};

// `failureAlert` is omitted from the base on purpose: `Partial<Omit<CronJob, ...>>` still
// carries `failureAlert?: CronFailureAlert | false`, and intersecting that with the
// widened property below re-narrows `null` away (`A & (A | null)` is `A`). Without the
// omission the patch type would reject the very value the wire schema accepts.
export type CronJobPatch = Partial<
  Omit<CronJob, "id" | "createdAtMs" | "state" | "payload" | "failureAlert">
> & {
  payload?: CronPayloadPatch;
  delivery?: CronDeliveryPatch;
  state?: Partial<CronJobState>;
  /**
   * `null` removes this job's override, so the job follows the global cron
   * `failureAlert` config again. The other two states are `false` (alerts suppressed
   * for this job) and an object (per-job override).
   *
   * This mirrors the "`null` = explicit clear" convention `normalizeCronJobInput`
   * already uses for `agentId` and `sessionKey`. It has to exist because `undefined`
   * cannot express a clear over the wire: `JSON.stringify` drops the key, and an
   * absent key means "leave this field alone".
   *
   * The same rule applies one level down: inside the object, a `null` subfield clears
   * just that field (see {@link CronFailureAlertPatch}).
   */
  failureAlert?: CronFailureAlertPatch | false | null;
};
