import { resolveGatewayPort, type OpenClawConfig } from "../config/config.js";
import { pickPrimaryLanIPv4 } from "../gateway/net.js";
import { pickPrimaryTailnetIPv4 } from "../infra/tailnet.js";
import { getTailnetHostname } from "../infra/tailscale.js";
import { isIpv6Address, parseCanonicalIpAddress } from "../shared/net/ip.js";

export const TAILSCALE_EXPOSURE_OPTIONS = [
  { value: "off", label: "Off", hint: "No Tailscale exposure" },
  {
    value: "serve",
    label: "Serve",
    hint: "Private HTTPS for your tailnet (devices on Tailscale)",
  },
  {
    value: "funnel",
    label: "Funnel",
    hint: "Public HTTPS via Tailscale Funnel (internet)",
  },
] as const;

export const TAILSCALE_MISSING_BIN_NOTE_LINES = [
  "Tailscale binary not found in PATH or /Applications.",
  "Ensure Tailscale is installed from:",
  "  https://tailscale.com/download/mac",
  "",
  "You can continue setup, but serve/funnel will fail at runtime.",
] as const;

export const TAILSCALE_DOCS_LINES = [
  "Docs:",
  "https://docs.openclaw.ai/gateway/tailscale",
  "https://docs.openclaw.ai/web",
] as const;

function normalizeTailnetHostForUrl(rawHost: string): string | null {
  const trimmed = rawHost.trim().replace(/\.$/, "");
  if (!trimmed) {
    return null;
  }
  const parsed = parseCanonicalIpAddress(trimmed);
  if (parsed && isIpv6Address(parsed)) {
    return `[${parsed.toString().toLowerCase()}]`;
  }
  return trimmed;
}

export function buildTailnetHttpsOrigin(rawHost: string, port?: number): string | null {
  const normalizedHost = normalizeTailnetHostForUrl(rawHost);
  if (!normalizedHost) {
    return null;
  }
  try {
    return new URL(`https://${normalizedHost}${port ? `:${port}` : ""}`).origin;
  } catch {
    return null;
  }
}

export function appendAllowedOrigin(existing: string[] | undefined, origin: string): string[] {
  const current = existing ?? [];
  const normalized = origin.toLowerCase();
  if (current.some((entry) => entry.toLowerCase() === normalized)) {
    return current;
  }
  return [...current, origin];
}

export async function maybeAddTailnetOriginToControlUiAllowedOrigins(params: {
  config: OpenClawConfig;
  tailscaleMode: string;
  tailscaleBin?: string | null;
}): Promise<OpenClawConfig> {
  const bind = params.config.gateway?.bind;
  const serveMode = params.tailscaleMode === "serve" || params.tailscaleMode === "funnel";
  const directTlsBind =
    params.config.gateway?.tls?.enabled === true &&
    (bind === "lan" || bind === "tailnet" || bind === "custom");
  if (!serveMode && !directTlsBind) {
    return params.config;
  }
  let origin: string | null = null;
  if (serveMode) {
    origin = await getTailnetHostname(undefined, params.tailscaleBin ?? undefined)
      .then((host) => buildTailnetHttpsOrigin(host))
      .catch(() => null);
  } else {
    const customHost = params.config.gateway?.customBindHost?.trim();
    const host =
      bind === "tailnet"
        ? pickPrimaryTailnetIPv4()
        : bind === "lan"
          ? pickPrimaryLanIPv4()
          : customHost === "0.0.0.0"
            ? pickPrimaryLanIPv4()
            : customHost;
    if (host) {
      origin = buildTailnetHttpsOrigin(host, resolveGatewayPort(params.config));
    }
  }
  if (!origin) {
    return params.config;
  }

  const existing = params.config.gateway?.controlUi?.allowedOrigins ?? [];
  const updatedOrigins = appendAllowedOrigin(existing, origin);
  return {
    ...params.config,
    gateway: {
      ...params.config.gateway,
      controlUi: {
        ...params.config.gateway?.controlUi,
        allowedOrigins: updatedOrigins,
      },
    },
  };
}
