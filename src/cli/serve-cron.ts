import { setLocalGatewayProvider } from "../agents/tools/gateway.js";
import { createLocalCronService } from "../cron/local-service.js";
import { createLocalCronGatewayCaller, LOCAL_CRON_METHODS } from "../gateway/local-cron-bridge.js";
import { defaultRuntime } from "../runtime.js";
import type { createDefaultDeps } from "./deps.js";

/**
 * Arms agent-side scheduling for the daemon-free `lcx serve` entry point.
 *
 * `lcx serve` runs the agent loop in-process with no Gateway websocket, so the
 * agent's `cron` tool would otherwise fail on every call. This installs an
 * in-process `CronService` (same store file as the Gateway,
 * `CONFIG_DIR/cron/jobs.json`) plus a bridge that reuses the Gateway's own cron
 * RPC handlers, and registers it as a process-local provider.
 *
 * Scheduling semantics are shared with the Gateway through the store file, so a
 * job created by `serve` is visible to a later Gateway run and vice versa. The
 * two must not run their schedulers against the same store at the same time,
 * for the same reason two Gateways must not.
 */

export type ServeCronHandle = {
  storePath: string;
  cronEnabled: boolean;
  dispose: () => Promise<void>;
};

export function installServeLocalCron(params: {
  deps: ReturnType<typeof createDefaultDeps>;
  cfg?: Parameters<typeof createLocalCronService>[0]["cfg"];
}): ServeCronHandle {
  const state = createLocalCronService({ deps: params.deps, cfg: params.cfg });
  const caller = createLocalCronGatewayCaller({
    cron: state.cron,
    cronStorePath: state.storePath,
  });

  const removeProvider = setLocalGatewayProvider({
    methods: new Set<string>(LOCAL_CRON_METHODS),
    call: (method, opts, callParams, extra) => caller(method, opts, callParams, extra),
  });

  // `CronService.start()` is async; a failure here is a degraded capability, not a
  // fatal condition, so it is reported and the service keeps running. Same shape
  // as the Gateway reload path in `server-reload-handlers.ts`.
  void state.cron.start().catch((error) => {
    defaultRuntime.error(`serve: local cron failed to start: ${String(error)}`);
  });

  return {
    storePath: state.storePath,
    cronEnabled: state.cronEnabled,
    dispose: async () => {
      removeProvider();
      // `CronService.stop()` is synchronous, matching every other call site
      // (`server-close.ts`, `server-reload-handlers.ts`).
      state.cron.stop();
    },
  };
}
