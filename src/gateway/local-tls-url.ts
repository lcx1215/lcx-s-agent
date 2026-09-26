import { resolveGatewayPort } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.js";
import { pickPrimaryTailnetIPv4 } from "../infra/tailnet.js";
import { isLoopbackHost, pickPrimaryLanIPv4 } from "./net.js";

export function isConfiguredLocalGatewayTlsUrl(config: OpenClawConfig, rawUrl: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return false;
  }
  const port = parsed.port ? Number(parsed.port) : 443;
  if (parsed.protocol !== "wss:" || port !== resolveGatewayPort(config)) {
    return false;
  }
  const host = parsed.hostname.replace(/^\[|\]$/gu, "").toLowerCase();
  if (isLoopbackHost(host)) {
    return true;
  }
  const bind = config.gateway?.bind ?? "loopback";
  const customHost = config.gateway?.customBindHost?.trim().toLowerCase();
  const localBindHosts = new Set<string>();
  if (bind === "lan" || bind === "auto") {
    const lanHost = pickPrimaryLanIPv4();
    if (lanHost) {
      localBindHosts.add(lanHost);
    }
  } else if (bind === "tailnet") {
    const tailnetHost = pickPrimaryTailnetIPv4();
    if (tailnetHost) {
      localBindHosts.add(tailnetHost);
    }
  } else if (bind === "custom" && customHost) {
    if (customHost === "0.0.0.0") {
      const lanHost = pickPrimaryLanIPv4();
      if (lanHost) {
        localBindHosts.add(lanHost);
      }
    } else {
      localBindHosts.add(customHost);
    }
  }
  return localBindHosts.has(host);
}
