import chalk from "chalk";
import {
  formatBuiltInDefaultModelReason,
  resolveBuiltInDefaultModelReason,
  resolveBuiltInDefaultModelRef,
} from "../agents/defaults.js";
import { resolveConfiguredModelRef } from "../agents/model-selection.js";
import type { loadConfig } from "../config/config.js";
import { resolveAgentModelPrimaryValue } from "../config/model-input.js";
import { getResolvedLoggerSettings } from "../logging.js";
import { collectEnabledInsecureOrDangerousFlags } from "../security/dangerous-config-flags.js";

export function logGatewayStartup(params: {
  cfg: ReturnType<typeof loadConfig>;
  bindHost: string;
  bindHosts?: string[];
  port: number;
  tlsEnabled?: boolean;
  log: { info: (msg: string, meta?: Record<string, unknown>) => void; warn: (msg: string) => void };
  isNixMode: boolean;
}) {
  const builtInDefault = resolveBuiltInDefaultModelRef();
  const builtInDefaultReason = resolveBuiltInDefaultModelReason();
  const { provider: agentProvider, model: agentModel } = resolveConfiguredModelRef({
    cfg: params.cfg,
    defaultProvider: builtInDefault.provider,
    defaultModel: builtInDefault.model,
  });
  const modelRef = `${agentProvider}/${agentModel}`;
  const configuredDefaultModel = resolveAgentModelPrimaryValue(params.cfg.agents?.defaults?.model);
  const defaultModelSource = configuredDefaultModel
    ? "agents.defaults.model"
    : formatBuiltInDefaultModelReason(builtInDefaultReason);
  params.log.info(`agent model: ${modelRef}`, {
    defaultModelSource,
    consoleMessage: `agent model: ${chalk.whiteBright(modelRef)} (source: ${defaultModelSource})`,
  });
  const scheme = params.tlsEnabled ? "wss" : "ws";
  const formatHost = (host: string) => (host.includes(":") ? `[${host}]` : host);
  const hosts =
    params.bindHosts && params.bindHosts.length > 0 ? params.bindHosts : [params.bindHost];
  const listenEndpoints = hosts.map((host) => `${scheme}://${formatHost(host)}:${params.port}`);
  params.log.info(`listening on ${listenEndpoints.join(", ")} (PID ${process.pid})`);
  params.log.info(`log file: ${getResolvedLoggerSettings().file}`);
  if (params.isNixMode) {
    params.log.info("gateway: running in Nix mode (config managed externally)");
  }

  const enabledDangerousFlags = collectEnabledInsecureOrDangerousFlags(params.cfg);
  if (enabledDangerousFlags.length > 0) {
    const warning =
      `security warning: dangerous config flags enabled: ${enabledDangerousFlags.join(", ")}. ` +
      "Run `openclaw security audit`.";
    params.log.warn(warning);
  }
}
