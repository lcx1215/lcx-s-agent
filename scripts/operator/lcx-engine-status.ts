import {
  LCX_ENGINE_CONTRACT_VERSION,
  LCX_ENGINE_SERVICES,
  LCX_OPENCLAW_AGENT_HARNESS_ID,
  LCX_OPENCLAW_AGENT_HARNESS_LABEL,
  LCX_OPENCLAW_AGENT_HARNESS_SEAM,
  LCX_OPENCLAW_CLI_HOST_ID,
  LCX_OPENCLAW_EMBEDDED_HOST_ID,
} from "../../src/engine/index.ts";

const status = {
  boundary: "local_lcx_engine_status_only",
  productAuthority: "lcx-engine",
  contractVersion: LCX_ENGINE_CONTRACT_VERSION,
  hostAdapters: [
    { id: LCX_OPENCLAW_EMBEDDED_HOST_ID, status: "current_compatible_host" },
    { id: LCX_OPENCLAW_CLI_HOST_ID, status: "current_compatible_host" },
  ],
  latestOpenClawHarness: {
    id: LCX_OPENCLAW_AGENT_HARNESS_ID,
    label: LCX_OPENCLAW_AGENT_HARNESS_LABEL,
    seam: LCX_OPENCLAW_AGENT_HARNESS_SEAM,
    status: "explicit_only_boundary_not_registered",
  },
  services: Object.keys(LCX_ENGINE_SERVICES),
  externalEffects: {
    providerConfig: "not_touched",
    launchAgent: "not_touched",
    externalChannel: "not_touched",
    training: "not_started",
  },
} as const;

if (process.argv.includes("--json")) {
  console.log(JSON.stringify(status, null, 2));
} else {
  console.log(`LCX Engine ${status.contractVersion}`);
  console.log(`authority: ${status.productAuthority}`);
  console.log(`hosts: ${status.hostAdapters.map((host) => host.id).join(", ")}`);
  console.log(
    `latest harness: ${status.latestOpenClawHarness.id} (${status.latestOpenClawHarness.status})`,
  );
  console.log(`services: ${status.services.join(", ")}`);
  console.log(
    "external effects: providerConfig=not_touched launchAgent=not_touched channel=not_touched training=not_started",
  );
}
