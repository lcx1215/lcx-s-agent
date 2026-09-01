/**
 * Compatibility entry point for the neutral external-channel proxy preflight.
 * The implementation lives at the shorter canonical path.
 */
export {
  buildExternalProxyPreflightReceipt,
  main,
} from "./external-channel-sidecar-proxy-preflight.ts";
export type { ExternalProxyPreflightReceipt } from "./external-channel-sidecar-proxy-preflight.ts";
