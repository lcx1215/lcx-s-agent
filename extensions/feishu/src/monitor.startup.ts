import type { ClawdbotConfig, RuntimeEnv } from "openclaw/plugin-sdk";
import { recordOperationalAnomaly } from "../../../src/infra/operational-anomalies.js";
import { isFeishuProbeDegraded, probeFeishu } from "./probe.js";
import type { ResolvedFeishuAccount } from "./types.js";

export const FEISHU_STARTUP_BOT_INFO_TIMEOUT_MS = 10_000;

type FetchBotOpenIdOptions = {
  config?: ClawdbotConfig;
  runtime?: RuntimeEnv;
  abortSignal?: AbortSignal;
  timeoutMs?: number;
};

function isTimeoutErrorMessage(message: string | undefined): boolean {
  return message?.toLowerCase().includes("timeout") || message?.toLowerCase().includes("timed out")
    ? true
    : false;
}

function isAbortErrorMessage(message: string | undefined): boolean {
  return message?.toLowerCase().includes("aborted") ?? false;
}

export async function fetchBotOpenIdForMonitor(
  account: ResolvedFeishuAccount,
  options: FetchBotOpenIdOptions = {},
): Promise<string | undefined> {
  if (options.abortSignal?.aborted) {
    return undefined;
  }

  const timeoutMs = options.timeoutMs ?? FEISHU_STARTUP_BOT_INFO_TIMEOUT_MS;
  const result = await probeFeishu(account, {
    timeoutMs,
    abortSignal: options.abortSignal,
  });
  if (result.ok) {
    if (!result.botOpenId && isFeishuProbeDegraded(result) && result.reason) {
      const error = options.runtime?.error ?? console.error;
      error(
        `feishu[${account.accountId}]: bot info degraded (${result.reason}); continuing startup`,
      );
      await recordOperationalAnomaly({
        cfg: options.config,
        category: "provider_degradation",
        severity: "medium",
        source: "feishu.monitor.startup",
        problem: "startup bot-info probe degraded",
        evidence: [
          `account=${account.accountId}`,
          `reason=${result.reason}`,
          "stage=startup_preflight",
        ],
        impact: "startup continues without a fully healthy bot-info anchor",
      });
    }
    return result.botOpenId;
  }

  if (options.abortSignal?.aborted || isAbortErrorMessage(result.error)) {
    return undefined;
  }

  if (isTimeoutErrorMessage(result.error)) {
    const error = options.runtime?.error ?? console.error;
    error(
      `feishu[${account.accountId}]: bot info probe timed out after ${timeoutMs}ms; continuing startup`,
    );
    await recordOperationalAnomaly({
      cfg: options.config,
      category: "provider_degradation",
      severity: "medium",
      source: "feishu.monitor.startup",
      problem: "startup bot-info probe timed out",
      evidence: [
        `account=${account.accountId}`,
        `timeout_ms=${timeoutMs}`,
        "stage=startup_preflight",
      ],
      impact: "startup continues without a stable bot-info health check",
    });
  } else if (isFeishuProbeDegraded(result) && result.reason) {
    const error = options.runtime?.error ?? console.error;
    error(`feishu[${account.accountId}]: bot info degraded (${result.reason}); continuing startup`);
    await recordOperationalAnomaly({
      cfg: options.config,
      category: "provider_degradation",
      severity: "medium",
      source: "feishu.monitor.startup",
      problem: "startup bot-info probe degraded",
      evidence: [
        `account=${account.accountId}`,
        `reason=${result.reason}`,
        "stage=startup_preflight",
      ],
      impact: "startup continues without a fully healthy bot-info anchor",
    });
  }
  return undefined;
}
