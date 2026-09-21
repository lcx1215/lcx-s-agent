import { randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Command } from "commander";
import { isFailoverError } from "../agents/failover-error.js";
import { shouldRejectBrowserMutation } from "../browser/csrf.js";
import { agentCommand } from "../commands/agent.js";
import type { AgentCommandOpts } from "../commands/agent/types.js";
import { isLoopbackHost } from "../gateway/net.js";
import { defaultRuntime } from "../runtime.js";
import { createDefaultDeps } from "./deps.js";
import { installServeLocalCron, type ServeCronHandle } from "./serve-cron.js";
import {
  clearServePidFile,
  readLiveServePid,
  resolveServeDetachPaths,
  spawnDetachedServe,
  stopDetachedServe,
  writeServePidFile,
} from "./serve-detach.js";
import {
  SERVE_LAUNCH_AGENT_LABEL,
  installServeService,
  readServeServiceStatus,
  uninstallServeService,
} from "./serve-service.js";

/**
 * Minimal in-process HTTP entrypoint.
 *
 * This is the daemon-free counterpart to `openclaw gateway`: it serves a single
 * `POST /agent` route that calls `agentCommand` directly in-process, plus a
 * `GET /healthz` probe. It deliberately carries no WebSocket control plane, no
 * channel adapters, no canvas host, and no node/pairing state, so it can run on
 * a laptop or in a container without a persistent gateway daemon.
 */

export const SERVE_SERVICE_NAME = "lcx-agent-serve";
export const DEFAULT_SERVE_PORT = 8788;
export const DEFAULT_SERVE_SESSION_KEY = "agent:main:serve";
/** Upper bound on a single request body. Agent turns are text-only here. */
export const MAX_SERVE_BODY_BYTES = 1024 * 1024;

export type ServeBindMode = "loopback" | "lan";

export type ServeConfig = {
  port: number;
  bind: ServeBindMode;
  token?: string;
  agentId?: string;
  sessionKey: string;
};

export type ServeAgentRunner = (
  opts: AgentCommandOpts,
  runtime: typeof defaultRuntime,
  deps: ReturnType<typeof createDefaultDeps>,
) => Promise<unknown>;

/** Normalizes the bind flag; unknown values fail loudly instead of defaulting open. */
export function resolveServeBind(raw: string | undefined): ServeBindMode {
  const value = (raw ?? "").trim().toLowerCase();
  if (value === "" || value === "loopback" || value === "local" || value === "127.0.0.1") {
    return "loopback";
  }
  if (value === "lan" || value === "all" || value === "0.0.0.0") {
    return "lan";
  }
  throw new Error(`--bind must be "loopback" or "lan", received: ${raw}`);
}

export function resolveServePort(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") {
    return DEFAULT_SERVE_PORT;
  }
  const parsed = Number.parseInt(raw.trim(), 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new Error(`--port must be an integer in 1..65535, received: ${raw}`);
  }
  return parsed;
}

/**
 * Fail-closed guard: exposing the agent over a non-loopback interface without a
 * bearer token would let any reachable host drive owner-level agent runs.
 */
export function assertServeConfigSafe(config: ServeConfig): void {
  if (config.bind === "lan" && !config.token) {
    throw new Error(
      "refusing to bind a non-loopback address without LCX_SERVE_TOKEN; " +
        "set --token/LCX_SERVE_TOKEN or use --bind loopback",
    );
  }
}

export function resolveServeConfig(
  opts: { port?: string; bind?: string; token?: string; agent?: string; session?: string },
  env: NodeJS.ProcessEnv = process.env,
): ServeConfig {
  const token = (opts.token ?? env.LCX_SERVE_TOKEN ?? "").trim();
  return {
    port: resolveServePort(opts.port ?? env.LCX_SERVE_PORT),
    bind: resolveServeBind(opts.bind ?? env.LCX_SERVE_BIND),
    token: token === "" ? undefined : token,
    agentId: (opts.agent ?? env.LCX_SERVE_AGENT ?? "").trim() || undefined,
    sessionKey: (opts.session ?? env.LCX_SERVE_SESSION ?? "").trim() || DEFAULT_SERVE_SESSION_KEY,
  };
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) {
    return false;
  }
  return timingSafeEqual(left, right);
}

export function isServeRequestAuthorized(req: IncomingMessage, token: string | undefined): boolean {
  // Loopback-only servers may omit the token; non-loopback binds require one
  // and are already rejected at startup when missing.
  if (!token) {
    return true;
  }
  const header = req.headers.authorization;
  if (typeof header !== "string") {
    return false;
  }
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  const presented = match?.[1]?.trim();
  if (!presented) {
    return false;
  }
  return safeEqual(presented, token);
}

/** Tokenless owner access is local-only, including the browser's initiating site. */
function isSafeTokenlessServeRequest(req: IncomingMessage): boolean {
  const host = req.headers.host;
  if (!host || /[\\/?#@\s]/.test(host)) {
    return false;
  }
  try {
    if (!isLoopbackHost(new URL(`http://${host}`).hostname)) {
      return false;
    }
  } catch {
    return false;
  }

  const origin = req.headers.origin;
  const referer = req.headers.referer;
  const secFetchSite = req.headers["sec-fetch-site"];
  if (Array.isArray(origin) || Array.isArray(referer) || Array.isArray(secFetchSite)) {
    return false;
  }
  // The shared guard checks loopback sites. Restrict URL schemes/shape too:
  // file/opaque origins or URL userinfo must not become trusted local origins.
  const source = origin ?? referer;
  if (source !== undefined) {
    const value = source.trim();
    if (
      !/^https?:\/\/[^/\\]/i.test(value) ||
      (origin !== undefined && !/^https?:\/\/[^\\/?#\s]+$/i.test(value))
    ) {
      return false;
    }
    try {
      const parsed = new URL(source);
      if (
        !["http:", "https:"].includes(parsed.protocol) ||
        parsed.username ||
        parsed.password ||
        (origin !== undefined && (parsed.pathname !== "/" || parsed.search || parsed.hash))
      ) {
        return false;
      }
    } catch {
      return false;
    }
  }
  return !shouldRejectBrowserMutation({
    method: req.method ?? "POST",
    origin,
    referer,
    secFetchSite,
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
  });
  res.end(text);
}

/** Collects payload text blocks from an `agentCommand` result without assuming its shape. */
export function readServePayloadTexts(result: unknown): string[] {
  if (typeof result !== "object" || result === null || !("payloads" in result)) {
    return [];
  }
  const payloads = result.payloads;
  if (!Array.isArray(payloads)) {
    return [];
  }
  const texts: string[] = [];
  for (const entry of payloads) {
    if (typeof entry !== "object" || entry === null || !("text" in entry)) {
      continue;
    }
    const text = entry.text;
    if (typeof text === "string" && text.trim() !== "") {
      texts.push(text);
    }
  }
  return texts;
}

/** Detects agent-run failures that are returned as payload metadata instead of thrown. */
export function readServeResultError(result: unknown): string | undefined {
  if (typeof result !== "object" || result === null) {
    return undefined;
  }

  const payloads = "payloads" in result ? result.payloads : undefined;
  if (Array.isArray(payloads)) {
    for (const entry of payloads) {
      if (
        typeof entry !== "object" ||
        entry === null ||
        !("isError" in entry) ||
        entry.isError !== true
      ) {
        continue;
      }
      if ("text" in entry && typeof entry.text === "string" && entry.text.trim() !== "") {
        return entry.text;
      }
      return "agent returned an error payload";
    }
  }

  const meta = "meta" in result ? result.meta : undefined;
  if (typeof meta === "object" && meta !== null && "error" in meta) {
    const error = meta.error;
    if (typeof error === "object" && error !== null && "message" in error) {
      if (typeof error.message === "string" && error.message.trim() !== "") {
        return error.message;
      }
    }
    if (typeof error === "string" && error.trim() !== "") {
      return error;
    }
    return "agent run failed";
  }
  return undefined;
}

export type ServeResultFailure = {
  status: 409 | 502 | 504;
  error: string;
};

function readStructuredStatus(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null || !("status" in error)) {
    return undefined;
  }
  const status = error.status;
  return typeof status === "number" && Number.isInteger(status) ? status : undefined;
}

function readErrorCause(error: unknown): unknown {
  if (typeof error !== "object" || error === null || !("cause" in error)) {
    return undefined;
  }
  return error.cause;
}

/** Maps structured thrown agent failures without inferring status from message text. */
export function readServeThrownFailure(error: unknown): ServeResultFailure | undefined {
  const seen = new Set<unknown>();
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current !== undefined && !seen.has(current); depth += 1) {
    seen.add(current);
    if (isFailoverError(current)) {
      const status =
        current.reason === "timeout" || current.status === 408 || current.status === 504
          ? 504
          : current.status === 409
            ? 409
            : 502;
      return {
        status,
        error:
          status === 504
            ? "agent request timed out"
            : status === 409
              ? "agent request was cancelled"
              : "agent upstream failure",
      };
    }

    const status = readStructuredStatus(current);
    const name = current instanceof Error ? current.name : undefined;
    if (status === 408 || status === 504 || name === "TimeoutError") {
      return {
        status: 504,
        error: "agent request timed out",
      };
    }
    if (status === 409 || name === "AbortError") {
      return {
        status: 409,
        error: "agent request was cancelled",
      };
    }
    if (status === 502 || status === 503) {
      return { status: 502, error: "agent upstream failure" };
    }

    current = readErrorCause(current);
  }
  return undefined;
}

/** Maps an accepted agent result onto an HTTP failure without guessing from text. */
export function readServeResultFailure(result: unknown): ServeResultFailure | undefined {
  if (typeof result !== "object" || result === null) {
    return undefined;
  }
  const meta = "meta" in result ? result.meta : undefined;
  const metaRecord = typeof meta === "object" && meta !== null ? meta : undefined;
  const resultError = readServeResultError(result);
  const readMetaFlag = (key: string) =>
    metaRecord !== undefined && key in metaRecord && metaRecord[key] === true;
  const timedOut = readMetaFlag("timedOut");
  const timedOutDuringCompaction = readMetaFlag("timedOutDuringCompaction");
  const promptCompleted = readMetaFlag("promptCompleted");
  const completedAfterCompactionTimeout = timedOutDuringCompaction && promptCompleted;

  if (timedOut && !completedAfterCompactionTimeout) {
    return {
      status: 504,
      error: resultError ?? "agent request timed out",
    };
  }
  if (readMetaFlag("aborted") && !completedAfterCompactionTimeout) {
    return {
      status: 409,
      error: resultError ?? "agent request was cancelled",
    };
  }
  if (resultError) {
    return { status: 502, error: resultError };
  }
  return undefined;
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let total = 0;
  let tooLarge = false;
  // Event-style consumption (rather than `for await`) so an oversized body can
  // still be drained and answered with 413 instead of resetting the socket.
  await new Promise<void>((resolve, reject) => {
    req.on("data", (chunk: Buffer) => {
      if (tooLarge) {
        return;
      }
      total += chunk.length;
      if (total > MAX_SERVE_BODY_BYTES) {
        tooLarge = true;
        chunks.length = 0;
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", resolve);
    req.on("error", reject);
  });
  if (tooLarge) {
    throw new Error("PAYLOAD_TOO_LARGE");
  }
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (text === "") {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("INVALID_JSON");
    }
    return parsed as Record<string, unknown>;
  } catch {
    throw new Error("INVALID_JSON");
  }
}

function readOptionalString(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key];
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

function readOptionalTimeoutSeconds(source: Record<string, unknown>): number | undefined {
  const value = source.timeoutSeconds;
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }
  if (typeof value === "string") {
    const parsed = Number.parseInt(value.trim(), 10);
    if (Number.isInteger(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return undefined;
}

export type ServeHandlerOptions = {
  config: ServeConfig;
  deps: ReturnType<typeof createDefaultDeps>;
  runtime?: typeof defaultRuntime;
  /** Injectable for tests; defaults to the real in-process agent loop. */
  runAgent?: ServeAgentRunner;
};

export function createServeRequestHandler(options: ServeHandlerOptions) {
  const { config, deps } = options;
  const runtime = options.runtime ?? defaultRuntime;
  const runAgent: ServeAgentRunner = options.runAgent ?? (agentCommand as ServeAgentRunner);

  return async function handleServeRequest(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const rawUrl = req.url ?? "/";
    const pathname = (rawUrl.split("?")[0] ?? "/").replace(/\/+$/, "") || "/";

    if (pathname === "/healthz") {
      if (req.method !== "GET" && req.method !== "HEAD") {
        sendJson(res, 405, { ok: false, error: "method not allowed" });
        return;
      }
      sendJson(res, 200, {
        ok: true,
        service: SERVE_SERVICE_NAME,
        status: "ok",
        bind: config.bind,
        port: config.port,
        tokenRequired: config.token !== undefined,
      });
      return;
    }

    if (pathname !== "/agent") {
      sendJson(res, 404, { ok: false, error: "not found" });
      return;
    }

    if (req.method !== "POST") {
      sendJson(res, 405, { ok: false, error: "method not allowed" });
      return;
    }

    if (!isServeRequestAuthorized(req, config.token)) {
      sendJson(res, 401, { ok: false, error: "unauthorized" });
      return;
    }

    if (!config.token && !isSafeTokenlessServeRequest(req)) {
      sendJson(res, 403, { ok: false, error: "forbidden request origin or host" });
      return;
    }

    let body: Record<string, unknown>;
    try {
      body = await readJsonBody(req);
    } catch (error) {
      const message = String(error instanceof Error ? error.message : error);
      if (message === "PAYLOAD_TOO_LARGE") {
        sendJson(res, 413, { ok: false, error: "payload too large" });
        return;
      }
      sendJson(res, 400, { ok: false, error: "invalid JSON body" });
      return;
    }

    const message = readOptionalString(body, "message");
    if (!message) {
      sendJson(res, 400, { ok: false, error: "message is required" });
      return;
    }

    const runId = randomUUID();
    const timeoutSeconds = readOptionalTimeoutSeconds(body);
    try {
      const result = await runAgent(
        {
          message,
          agentId: readOptionalString(body, "agentId") ?? config.agentId,
          sessionKey: readOptionalString(body, "sessionKey") ?? config.sessionKey,
          model: readOptionalString(body, "model"),
          thinking: readOptionalString(body, "thinking"),
          lane: readOptionalString(body, "lane"),
          extraSystemPrompt: readOptionalString(body, "extraSystemPrompt"),
          timeout: timeoutSeconds === undefined ? undefined : String(timeoutSeconds),
          runId,
          // Delivery is intentionally off: this entrypoint has no channel adapters.
          deliver: false,
          // Startup and request admission enforce the bind/token and browser boundaries.
          senderIsOwner: true,
        },
        runtime,
        deps,
      );
      const resultFailure = readServeResultFailure(result);
      if (resultFailure) {
        sendJson(res, resultFailure.status, {
          ok: false,
          runId,
          status: "error",
          error: resultFailure.error,
        });
        return;
      }
      const texts = readServePayloadTexts(result);
      sendJson(res, 200, {
        ok: true,
        runId,
        status: "ok",
        summary: "completed",
        payloads: texts.map((text) => ({ text })),
      });
    } catch (error) {
      const thrownFailure = readServeThrownFailure(error);
      sendJson(res, thrownFailure?.status ?? 502, {
        ok: false,
        runId,
        status: "error",
        error: thrownFailure?.error ?? "agent request failed",
      });
    }
  };
}

export function createServeServer(options: ServeHandlerOptions) {
  const handler = createServeRequestHandler(options);
  return createServer((req, res) => {
    void handler(req, res).catch((error: unknown) => {
      if (res.headersSent) {
        res.end();
        return;
      }
      sendJson(res, 500, {
        ok: false,
        error: String(error instanceof Error ? error.message : error),
      });
    });
  });
}

function readFlag(value: string | boolean | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/**
 * Lifecycle subcommands that make the agent self-running.
 *
 * Without these, `serve` only exists while a human keeps a terminal open — the
 * exact dependency a daemon-free deployment is meant to remove. Installing a
 * per-user LaunchAgent lets the agent start itself at login, restart itself
 * after a crash, and then self-schedule through its own in-process cron.
 */
function registerServeServiceCommands(serve: Command): void {
  serve
    .command("install")
    .description("Install a per-user LaunchAgent so this service starts itself (macOS)")
    .option("--port <port>", `Port the service listens on (default: ${DEFAULT_SERVE_PORT})`)
    .option("--bind <mode>", 'Bind mode: "loopback" or "lan" (default: loopback)')
    .option("--token <token>", "Bearer token persisted into the plist (env: LCX_SERVE_TOKEN)")
    .option("--node <path>", "Node binary to pin in the plist (default: the running one)")
    .option("--json", "Output JSON", false)
    .action(async (cmdOpts: Record<string, string | boolean | undefined>) => {
      try {
        const port = resolveServePort(readFlag(cmdOpts.port));
        const bind = resolveServeBind(readFlag(cmdOpts.bind));
        const token = (readFlag(cmdOpts.token) ?? process.env.LCX_SERVE_TOKEN ?? "").trim();
        const result = await installServeService({
          port,
          bind,
          token: token === "" ? undefined : token,
          ...(readFlag(cmdOpts.node) ? { nodePath: readFlag(cmdOpts.node) } : {}),
        });
        const payload = {
          ok: true,
          action: "install",
          label: result.paths.label,
          plistPath: result.paths.plistPath,
          logDir: result.paths.logDir,
          stdoutPath: result.paths.stdoutPath,
          stderrPath: result.paths.stderrPath,
          bind,
          port,
          tokenRequired: token !== "",
          programArguments: result.programArguments,
        };
        if (cmdOpts.json) {
          defaultRuntime.log(JSON.stringify(payload, null, 2));
        } else {
          defaultRuntime.log(`serve service installed: ${payload.label}`);
          defaultRuntime.log(`  plist:   ${payload.plistPath}`);
          defaultRuntime.log(`  command: ${payload.programArguments.join(" ")}`);
          defaultRuntime.log(`  bind:    ${bind}:${port} (tokenRequired=${payload.tokenRequired})`);
          defaultRuntime.log(`  logs:    ${payload.stdoutPath}`);
          defaultRuntime.log("The agent now starts itself at login and restarts after a crash.");
        }
        defaultRuntime.exit(0);
      } catch (error) {
        defaultRuntime.error(String(error instanceof Error ? error.message : error));
        defaultRuntime.exit(1);
      }
    });

  serve
    .command("uninstall")
    .description("Stop and remove the LaunchAgent installed by `serve install`")
    .option("--json", "Output JSON", false)
    .action(async (cmdOpts: Record<string, string | boolean | undefined>) => {
      try {
        const result = await uninstallServeService();
        const payload = {
          ok: true,
          action: "uninstall",
          label: SERVE_LAUNCH_AGENT_LABEL,
          plistPath: result.plistPath,
          removed: result.existed,
        };
        if (cmdOpts.json) {
          defaultRuntime.log(JSON.stringify(payload, null, 2));
        } else {
          defaultRuntime.log(
            result.existed
              ? `serve service uninstalled: ${result.plistPath}`
              : `serve service was not installed: ${result.plistPath}`,
          );
        }
        defaultRuntime.exit(0);
      } catch (error) {
        defaultRuntime.error(String(error instanceof Error ? error.message : error));
        defaultRuntime.exit(1);
      }
    });

  serve
    .command("status")
    .description("Show whether the self-running serve service is installed and alive")
    .option("--json", "Output JSON", false)
    .action(async (cmdOpts: Record<string, string | boolean | undefined>) => {
      try {
        const status = await readServeServiceStatus();
        const detachPaths = resolveServeDetachPaths();
        const detachedPid = await readLiveServePid(detachPaths);
        const alive = status.running === true || detachedPid !== undefined;
        const payload = {
          ok: true,
          action: "status",
          label: status.label,
          plistPath: status.plistPath,
          installed: status.installed,
          running: status.running ?? null,
          pid: status.pid ?? null,
          lastExitCode: status.lastExitCode ?? null,
          detail: status.detail ?? null,
          detached: {
            pid: detachedPid ?? null,
            alive: detachedPid !== undefined,
            pidPath: detachPaths.pidPath,
            stdoutPath: detachPaths.stdoutPath,
            stderrPath: detachPaths.stderrPath,
          },
        };
        if (cmdOpts.json) {
          defaultRuntime.log(JSON.stringify(payload, null, 2));
        } else {
          defaultRuntime.log(`label:     ${status.label}`);
          defaultRuntime.log(`plist:     ${status.plistPath}`);
          defaultRuntime.log(`installed: ${status.installed}`);
          defaultRuntime.log(
            `running:   ${status.running === undefined ? "unknown (launchctl state unavailable)" : status.running}`,
          );
          if (status.pid !== undefined) {
            defaultRuntime.log(`pid:       ${status.pid}`);
          }
          if (status.lastExitCode !== undefined) {
            defaultRuntime.log(`last exit: ${status.lastExitCode}`);
          }
          if (status.detail) {
            defaultRuntime.log(`detail:    ${status.detail}`);
          }
          defaultRuntime.log(
            `detached:  ${detachedPid === undefined ? "no" : `yes (pid ${detachedPid})`}`,
          );
          defaultRuntime.log(`pidfile:   ${detachPaths.pidPath}`);
        }
        // Exit non-zero only when the agent is neither registered nor running:
        // `running: unknown` is a read limitation, not evidence of a stop.
        defaultRuntime.exit(status.installed || alive ? 0 : 1);
      } catch (error) {
        defaultRuntime.error(String(error instanceof Error ? error.message : error));
        defaultRuntime.exit(1);
      }
    });

  serve
    .command("stop")
    .description("Stop a detached serve process started with `serve --detach`")
    .option("--json", "Output JSON", false)
    .action(async (cmdOpts: Record<string, string | boolean | undefined>) => {
      try {
        const result = await stopDetachedServe({ paths: resolveServeDetachPaths() });
        // "nothing was running" is a successful end state for a stop request.
        const ok = result.stopped || result.reason === "no pidfile";
        const payload = {
          ok,
          action: "stop",
          stopped: result.stopped,
          pid: result.pid ?? null,
          reason: result.reason ?? null,
        };
        if (cmdOpts.json) {
          defaultRuntime.log(JSON.stringify(payload, null, 2));
        } else if (result.stopped) {
          defaultRuntime.log(`serve stopped (pid ${result.pid})`);
        } else if (result.reason === "no pidfile") {
          defaultRuntime.log("no detached serve process recorded");
        } else {
          defaultRuntime.log(
            `serve not stopped${result.pid === undefined ? "" : ` (pid ${result.pid})`}: ${result.reason}`,
          );
        }
        defaultRuntime.exit(ok ? 0 : 1);
      } catch (error) {
        defaultRuntime.error(String(error instanceof Error ? error.message : error));
        defaultRuntime.exit(1);
      }
    });
}

export function registerServeCli(program: Command): void {
  const serve = program
    .command("serve")
    .description("Run a minimal in-process HTTP agent service (no Gateway daemon)")
    .option(
      "--port <port>",
      `Port to listen on (env: LCX_SERVE_PORT, default: ${DEFAULT_SERVE_PORT})`,
    )
    .option("--bind <mode>", 'Bind mode: "loopback" or "lan" (env: LCX_SERVE_BIND)')
    .option("--token <token>", "Bearer token required for POST /agent (env: LCX_SERVE_TOKEN)")
    .option("--agent <id>", "Default agent id for runs (env: LCX_SERVE_AGENT)")
    .option(
      "--session <key>",
      `Default session key (env: LCX_SERVE_SESSION, default: ${DEFAULT_SERVE_SESSION_KEY})`,
    )
    .option("--detach", "Run in the background, detached from this terminal", false)
    .action(async (opts: Record<string, string | boolean | undefined>) => {
      try {
        const config = resolveServeConfig({
          port: readFlag(opts.port),
          bind: readFlag(opts.bind),
          token: readFlag(opts.token),
          agent: readFlag(opts.agent),
          session: readFlag(opts.session),
        });
        assertServeConfigSafe(config);

        if (opts.detach) {
          const detachPaths = resolveServeDetachPaths();
          const alreadyRunning = await readLiveServePid(detachPaths);
          if (alreadyRunning !== undefined) {
            defaultRuntime.error(
              `serve is already running detached (pid ${alreadyRunning}); run \`serve stop\` first`,
            );
            defaultRuntime.exit(1);
            return;
          }
          // Config travels through the environment so a bearer token never
          // appears in the child's process arguments.
          const childEnv: NodeJS.ProcessEnv = {
            LCX_SERVE_BIND: config.bind,
            LCX_SERVE_PORT: String(config.port),
            ...(config.token ? { LCX_SERVE_TOKEN: config.token } : {}),
            ...(config.agentId ? { LCX_SERVE_AGENT: config.agentId } : {}),
            LCX_SERVE_SESSION: config.sessionKey,
          };
          const detached = await spawnDetachedServe({
            paths: detachPaths,
            entryPath: process.argv[1] ?? "",
            execArgv: process.execArgv,
            args: ["serve"],
            cwd: process.cwd(),
            env: childEnv,
          });
          defaultRuntime.log(`serve detached: pid ${detached.pid}`);
          defaultRuntime.log(`  bind: ${config.bind}:${config.port}`);
          defaultRuntime.log(`  pid:  ${detached.pidPath}`);
          defaultRuntime.log(`  logs: ${detached.stdoutPath}`);
          defaultRuntime.log("This process is now independent of the launching terminal.");
          defaultRuntime.exit(0);
          return;
        }

        const deps = createDefaultDeps();
        // Arm in-process cron so the agent's `cron` tool works without a Gateway
        // daemon. A broken scheduler is a degraded capability, not a fatal
        // condition, so it must never prevent the HTTP service from starting.
        let cron: ServeCronHandle | null = null;
        try {
          cron = installServeLocalCron({ deps });
        } catch (error) {
          defaultRuntime.error(
            `serve: local cron unavailable (agent scheduling disabled): ${String(
              error instanceof Error ? error.message : error,
            )}`,
          );
        }

        const server = createServeServer({ config, deps });
        const host = config.bind === "loopback" ? "127.0.0.1" : "0.0.0.0";

        await new Promise<void>((resolve, reject) => {
          server.once("error", reject);
          server.listen(config.port, host, () => {
            server.off("error", reject);
            resolve();
          });
        });

        defaultRuntime.log(
          `${SERVE_SERVICE_NAME} listening on http://${host}:${config.port} ` +
            `(bind=${config.bind}, tokenRequired=${config.token !== undefined})`,
        );
        defaultRuntime.log(
          cron
            ? `serve: local cron ${cron.cronEnabled ? "enabled" : "disabled"} (store=${cron.storePath})`
            : "serve: local cron not installed",
        );

        // Publish the pidfile only after the socket is actually accepting
        // connections, so `serve stop`/`status` never see a half-started agent.
        const detachPaths = resolveServeDetachPaths();
        await writeServePidFile(detachPaths);

        const shutdown = () => {
          void cron?.dispose().catch(() => {});
          void clearServePidFile(detachPaths).catch(() => {});
          server.close(() => {
            defaultRuntime.exit(0);
          });
        };
        process.once("SIGINT", shutdown);
        process.once("SIGTERM", shutdown);
      } catch (error) {
        defaultRuntime.error(String(error instanceof Error ? error.message : error));
        defaultRuntime.exit(1);
      }
    });

  registerServeServiceCommands(serve);
}

export const __testing = {
  readJsonBody,
  readServePayloadTexts,
  safeEqual,
};
