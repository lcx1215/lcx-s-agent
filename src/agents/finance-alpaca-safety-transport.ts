import { fetch } from "undici";
import {
  ALPACA_FINANCE_HTTP_BODY_MAX_BYTES,
  FinanceHttpBodyAbortError,
  readBoundedFinanceResponseText,
} from "./finance-http-body.js";
import type { FinanceUncachedFetch } from "./finance-write-transport.js";

export function safeTransportFailureCode(error: unknown): string {
  const pending: unknown[] = [error];
  const codes = new Set<string>();
  for (let n = 0; pending.length && n < 8; n++) {
    const item = pending.shift();
    if (!item || typeof item !== "object") {
      continue;
    }
    if (
      "code" in item &&
      typeof item.code === "string" &&
      item.code.length <= 64 &&
      /^(?:UND_ERR_[A-Z_]+|ECONN[A-Z_]+|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ERR_TLS_[A-Z_]+|CERT_[A-Z_]+)$/u.test(
        item.code,
      )
    ) {
      codes.add(item.code);
    }
    if ("cause" in item) {
      pending.push(item.cause);
    }
    if ("errors" in item && Array.isArray(item.errors)) {
      pending.push(...item.errors.slice(0, 4));
    }
  }
  return [...codes].slice(0, 4).join(",") || "transport_cause_unavailable";
}

export class FinanceUncachedReadError extends Error {
  readonly cleanupStatus?: "confirmed" | "unconfirmed";
  readonly diagnostic: Readonly<{
    endpoint: string;
    phase: "request" | "body";
    code: string;
    elapsedMs: number;
    cleanupStatus?: "confirmed" | "unconfirmed";
  }>;
  constructor(url: string, phase: "request" | "body", elapsedMs: number, cause: unknown) {
    super("finance uncached read failed", { cause });
    this.name = "FinanceUncachedReadError";
    const path = new URL(url).pathname;
    const endpoint =
      path === "/v2/account"
        ? "account"
        : path === "/v2/positions"
          ? "positions"
          : path.startsWith("/v2/account/activities")
            ? "activities"
            : path.startsWith("/v2/orders")
              ? "orders"
              : "other";
    this.diagnostic = {
      endpoint,
      phase,
      elapsedMs: Math.max(0, Math.round(elapsedMs)),
      ...financeReadFailureDiagnostic(cause),
    };
    this.cleanupStatus = this.diagnostic.cleanupStatus;
  }
}

/** Dedicated uncached GET: no redirects, credential lookup, ambient proxy discovery, or writes. */
export function createAlpacaSafetyReadTransport(): FinanceUncachedFetch {
  return async (url, init) => {
    const parsed = new URL(url);
    if (
      parsed.protocol !== "https:" ||
      parsed.username ||
      parsed.password ||
      parsed.port ||
      !["paper-api.alpaca.markets", "data.alpaca.markets"].includes(parsed.hostname)
    ) {
      throw new Error("Alpaca safety read host denied");
    }
    const response = await fetch(url, {
      method: "GET",
      redirect: "error",
      headers: init.headers,
      signal: init.signal,
    }).catch((error: unknown) => {
      // Retain the real cause while exposing only bounded codes, never headers/URLs/raw messages.
      throw new Error(`Alpaca safety GET transport failed: ${safeTransportFailureCode(error)}`, {
        cause: error,
      });
    });
    return {
      status: response.status,
      body: await readBoundedFinanceResponseText(response, {
        maxBytes: ALPACA_FINANCE_HTTP_BODY_MAX_BYTES,
        label: "Alpaca safety",
        signal: init.signal,
      }),
    };
  };
}

export type FinanceAccountReadStage =
  | "execution_recovery"
  | "broker_reconciliation"
  | "safety_claims"
  | "terminal_order"
  | "safety_facts";

/** Local diagnostic only; never serializes a raw upstream message or credentials. */
export class FinanceAccountReadError extends Error {
  readonly diagnostic: {
    stage: FinanceAccountReadStage;
    code: string;
    elapsedMs: number;
    cleanupStatus?: "confirmed" | "unconfirmed";
    request?: FinanceUncachedReadError["diagnostic"];
  };
  constructor(stage: FinanceAccountReadStage, elapsedMs: number, cause: unknown) {
    super("finance account read failed", { cause });
    this.diagnostic = {
      stage,
      elapsedMs: Math.max(0, Math.round(elapsedMs)),
      ...financeReadFailureDiagnostic(cause),
      ...(cause instanceof FinanceUncachedReadError ? { request: cause.diagnostic } : {}),
    };
  }
}

export type FinanceReadFailureDiagnostic = Readonly<{
  code: string;
  cleanupStatus?: "confirmed" | "unconfirmed";
}>;
export function isSafeFinanceReadFailure(value: unknown): value is FinanceReadFailureDiagnostic {
  if (!value || typeof value !== "object") {
    return false;
  }
  const v = value as Partial<FinanceReadFailureDiagnostic>;
  return (
    Object.keys(value).every((key) => key === "code" || key === "cleanupStatus") &&
    typeof v.code === "string" &&
    v.code.length <= 259 &&
    /^(?:transport_cause_unavailable|(?:UND_ERR_[A-Z_]+|ECONN[A-Z_]+|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ERR_TLS_[A-Z_]+|CERT_[A-Z_]+)(?:,(?:UND_ERR_[A-Z_]+|ECONN[A-Z_]+|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ERR_TLS_[A-Z_]+|CERT_[A-Z_]+)){0,3})$/u.test(
      v.code,
    ) &&
    (v.cleanupStatus === undefined ||
      v.cleanupStatus === "confirmed" ||
      v.cleanupStatus === "unconfirmed")
  );
}
export function financeReadFailureDiagnostic(error: unknown): FinanceReadFailureDiagnostic {
  const pending: unknown[] = [error];
  let cleanupStatus: "confirmed" | "unconfirmed" | undefined;
  for (let n = 0; pending.length && n < 8; n++) {
    const item = pending.shift();
    if (item instanceof FinanceHttpBodyAbortError) {
      if (cleanupStatus !== "unconfirmed") {
        cleanupStatus = item.cleanupStatus;
      }
    }
    if (item && typeof item === "object" && "cause" in item) {
      pending.push(item.cause);
    }
  }
  return { code: safeTransportFailureCode(error), ...(cleanupStatus ? { cleanupStatus } : {}) };
}
