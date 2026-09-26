import type { OpenClawConfig } from "../config/config.js";
import {
  ensureControlUiAllowedOriginsForNonLoopbackBind,
  type GatewayNonLoopbackBindMode,
} from "../config/gateway-control-ui-origins.js";
import { maybeAddTailnetOriginToControlUiAllowedOrigins } from "./gateway-config-prompts.shared.js";

export async function maybeSeedControlUiAllowedOriginsAtStartup(params: {
  config: OpenClawConfig;
  writeConfig: (config: OpenClawConfig) => Promise<void>;
  log: { info: (msg: string) => void; warn: (msg: string) => void };
}): Promise<OpenClawConfig> {
  const seeded = ensureControlUiAllowedOriginsForNonLoopbackBind(params.config);
  if (!seeded.seededOrigins || !seeded.bind) {
    return params.config;
  }
  const config = await maybeAddTailnetOriginToControlUiAllowedOrigins({
    config: seeded.config,
    tailscaleMode: seeded.config.gateway?.tailscale?.mode ?? "off",
  });
  try {
    await params.writeConfig(config);
    params.log.info(
      buildSeededOriginsInfoLog(
        config.gateway?.controlUi?.allowedOrigins ?? seeded.seededOrigins,
        seeded.bind,
      ),
    );
  } catch (err) {
    params.log.warn(
      `gateway: failed to persist gateway.controlUi.allowedOrigins seed: ${String(err)}. The gateway will start with the in-memory value but config was not saved.`,
    );
  }
  return config;
}

function buildSeededOriginsInfoLog(origins: string[], bind: GatewayNonLoopbackBindMode): string {
  return (
    `gateway: seeded gateway.controlUi.allowedOrigins ${JSON.stringify(origins)} ` +
    `for bind=${bind} (required since v2026.2.26; see issue #29385). ` +
    "Add other origins to gateway.controlUi.allowedOrigins if needed."
  );
}
