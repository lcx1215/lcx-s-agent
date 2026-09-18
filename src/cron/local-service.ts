import { resolveDefaultAgentId } from "../agents/agent-scope.js";
import type { CliDeps } from "../cli/deps.js";
import { loadConfig } from "../config/config.js";
import {
  canonicalizeMainSessionAlias,
  resolveAgentIdFromSessionKey,
  resolveAgentMainSessionKey,
} from "../config/sessions.js";
import { resolveStorePath } from "../config/sessions/paths.js";
import { runHeartbeatOnce } from "../infra/heartbeat-runner.js";
import { requestHeartbeatNow } from "../infra/heartbeat-wake.js";
import { enqueueSystemEvent } from "../infra/system-events.js";
import { getChildLogger } from "../logging.js";
import { normalizeAgentId, toAgentStoreSessionKey } from "../routing/session-key.js";
import { defaultRuntime } from "../runtime.js";
import { runCronIsolatedAgentTurn } from "./isolated-agent.js";
import {
  appendCronRunLog,
  resolveCronRunLogPath,
  resolveCronRunLogPruneOptions,
} from "./run-log.js";
import { CronService } from "./service.js";
import { resolveCronStorePath } from "./store.js";

/**
 * Daemon-free `CronService` construction.
 *
 * `src/gateway/server-cron.ts` builds the production `CronService`, but the cron
 * store (`CONFIG_DIR/cron/jobs.json`), the scheduler (`CronService`), the isolated
 * agent runner, and the system-event / heartbeat wake primitives are all plain
 * in-process modules with no Gateway dependency. Only the Gateway-specific
 * delivery surfaces (websocket broadcast, cron failure webhooks, channel
 * announce alerts) live in the Gateway layer.
 *
 * This module rebuilds the same service for a process that has no Gateway
 * daemon — the `lcx serve` entry point — so agent-side scheduling keeps working
 * when the Gateway is not running.
 *
 * Deliberate reductions vs. the Gateway build (all delivery-only, never
 * scheduling semantics):
 * - no `onEvent` websocket broadcast (nothing is subscribed in a daemon-free process)
 * - no cron failure webhook / announce alerts (`sendCronFailureAlert` omitted)
 * Run-history persistence (`cron.runs`) and heartbeat wake stay intact.
 */

export type LocalCronServiceParams = {
  /** Agent execution deps; the same object the in-process agent loop uses. */
  deps: CliDeps;
  /** Optional pre-loaded config (defaults to `loadConfig()`). */
  cfg?: ReturnType<typeof loadConfig>;
};

export type LocalCronServiceState = {
  cron: CronService;
  storePath: string;
  cronEnabled: boolean;
};

export function createLocalCronService(params: LocalCronServiceParams): LocalCronServiceState {
  const cfg = params.cfg ?? loadConfig();
  const cronLogger = getChildLogger({ module: "cron" });
  const storePath = resolveCronStorePath(cfg.cron?.store);
  const cronEnabled = process.env.OPENCLAW_SKIP_CRON !== "1" && cfg.cron?.enabled !== false;

  const resolveCronAgent = (requested?: string | null) => {
    const runtimeConfig = loadConfig();
    const normalized =
      typeof requested === "string" && requested.trim() ? normalizeAgentId(requested) : undefined;
    const hasAgent =
      normalized !== undefined &&
      Array.isArray(runtimeConfig.agents?.list) &&
      runtimeConfig.agents.list.some(
        (entry) =>
          entry && typeof entry.id === "string" && normalizeAgentId(entry.id) === normalized,
      );
    const agentId = hasAgent ? normalized : resolveDefaultAgentId(runtimeConfig);
    return { agentId, cfg: runtimeConfig };
  };

  const resolveCronSessionKey = (p: {
    runtimeConfig: ReturnType<typeof loadConfig>;
    agentId: string;
    requestedSessionKey?: string | null;
  }) => {
    const requested = p.requestedSessionKey?.trim();
    if (!requested) {
      return resolveAgentMainSessionKey({ cfg: p.runtimeConfig, agentId: p.agentId });
    }
    const candidate = toAgentStoreSessionKey({
      agentId: p.agentId,
      requestKey: requested,
      mainKey: p.runtimeConfig.session?.mainKey,
    });
    const canonical = canonicalizeMainSessionAlias({
      cfg: p.runtimeConfig,
      agentId: p.agentId,
      sessionKey: candidate,
    });
    if (canonical !== "global") {
      const sessionAgentId = resolveAgentIdFromSessionKey(canonical);
      if (normalizeAgentId(sessionAgentId) !== normalizeAgentId(p.agentId)) {
        return resolveAgentMainSessionKey({ cfg: p.runtimeConfig, agentId: p.agentId });
      }
    }
    return canonical;
  };

  const resolveCronWakeTarget = (opts?: { agentId?: string; sessionKey?: string | null }) => {
    const runtimeConfig = loadConfig();
    const requestedAgentId = opts?.agentId ? resolveCronAgent(opts.agentId).agentId : undefined;
    const derivedAgentId =
      requestedAgentId ??
      (opts?.sessionKey
        ? normalizeAgentId(resolveAgentIdFromSessionKey(opts.sessionKey))
        : undefined);
    const agentId = derivedAgentId || undefined;
    const sessionKey =
      opts?.sessionKey && agentId
        ? resolveCronSessionKey({
            runtimeConfig,
            agentId,
            requestedSessionKey: opts.sessionKey,
          })
        : undefined;
    return { runtimeConfig, agentId, sessionKey };
  };

  const defaultAgentId = resolveDefaultAgentId(cfg);
  const runLogPrune = resolveCronRunLogPruneOptions(cfg.cron?.runLog);
  const resolveSessionStorePath = (agentId?: string) =>
    resolveStorePath(cfg.session?.store, { agentId: agentId ?? defaultAgentId });
  const sessionStorePath = resolveSessionStorePath(defaultAgentId);

  const cron = new CronService({
    log: cronLogger,
    storePath,
    cronEnabled,
    cronConfig: cfg.cron,
    defaultAgentId,
    resolveSessionStorePath,
    sessionStorePath,
    enqueueSystemEvent: (text, opts) => {
      const { agentId, cfg: runtimeConfig } = resolveCronAgent(opts?.agentId);
      const sessionKey = resolveCronSessionKey({
        runtimeConfig,
        agentId,
        requestedSessionKey: opts?.sessionKey,
      });
      enqueueSystemEvent(text, { sessionKey, contextKey: opts?.contextKey });
    },
    requestHeartbeatNow: (opts) => {
      const { agentId, sessionKey } = resolveCronWakeTarget(opts);
      requestHeartbeatNow({ reason: opts?.reason, agentId, sessionKey });
    },
    runHeartbeatOnce: async (opts) => {
      const { runtimeConfig, agentId, sessionKey } = resolveCronWakeTarget(opts);
      const agentEntry =
        Array.isArray(runtimeConfig.agents?.list) &&
        runtimeConfig.agents.list.find(
          (entry) =>
            entry && typeof entry.id === "string" && normalizeAgentId(entry.id) === agentId,
        );
      const agentHeartbeat =
        agentEntry && typeof agentEntry === "object" ? agentEntry.heartbeat : undefined;
      const baseHeartbeat = {
        ...runtimeConfig.agents?.defaults?.heartbeat,
        ...agentHeartbeat,
      };
      const heartbeatOverride = opts?.heartbeat
        ? { ...baseHeartbeat, ...opts.heartbeat }
        : undefined;
      return await runHeartbeatOnce({
        cfg: runtimeConfig,
        reason: opts?.reason,
        agentId,
        sessionKey,
        heartbeat: heartbeatOverride,
        deps: { ...params.deps, runtime: defaultRuntime },
      });
    },
    runIsolatedAgentJob: async ({ job, message, abortSignal }) => {
      const { agentId, cfg: runtimeConfig } = resolveCronAgent(job.agentId);
      return await runCronIsolatedAgentTurn({
        cfg: runtimeConfig,
        deps: params.deps,
        job,
        message,
        abortSignal,
        agentId,
        sessionKey: `cron:${job.id}`,
        lane: "cron",
      });
    },
    // No `sendCronFailureAlert`: failure alerting needs a Gateway channel or
    // webhook destination. Failures still surface through the run log.
    onEvent: (evt) => {
      if (evt.action !== "finished") {
        return;
      }
      const logPath = resolveCronRunLogPath({ storePath, jobId: evt.jobId });
      void appendCronRunLog(
        logPath,
        {
          ts: Date.now(),
          jobId: evt.jobId,
          action: "finished",
          status: evt.status,
          error: evt.error,
          summary: evt.summary,
          delivered: evt.delivered,
          deliveryStatus: evt.deliveryStatus,
          deliveryError: evt.deliveryError,
          sessionId: evt.sessionId,
          sessionKey: evt.sessionKey,
          runAtMs: evt.runAtMs,
          durationMs: evt.durationMs,
          nextRunAtMs: evt.nextRunAtMs,
          model: evt.model,
          provider: evt.provider,
          usage: evt.usage,
        },
        runLogPrune,
      ).catch((err) => {
        cronLogger.warn({ err: String(err), logPath }, "cron: run log append failed");
      });
    },
  });

  return { cron, storePath, cronEnabled };
}
