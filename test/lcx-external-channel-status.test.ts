import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(import.meta.dirname, "..");

async function runStatus(args: string[]) {
  const { stdout } = await execFileAsync(
    process.execPath,
    ["--import", "tsx", "scripts/dev/lcx-external-channel-status.ts", ...args],
    {
      cwd: repoRoot,
      env: process.env,
      maxBuffer: 32 * 1024 * 1024,
      timeout: 120_000,
    },
  );
  return JSON.parse(stdout) as Record<string, unknown>;
}

describe("lcx-external-channel-status", () => {
  it("wraps legacy promote-live status as a read-only external-channel owner", async () => {
    const payload = await runStatus(["--json"]);

    expect(payload).toEqual(
      expect.objectContaining({
        ok: true,
        boundary: "dev_external_channel_status_only",
        owner: "lcx-external-channel-status",
        conceptStatus: "legacy_promote_live_status_wrapped_by_external_channel_status",
        liveTouched: false,
        providerConfigTouched: false,
        protectedMemoryTouched: false,
      }),
    );
    expect(payload.externalChannelStatus).toEqual(
      expect.objectContaining({
        statusModel: "dev-ready -> external-channel-bound -> user-visible-observed",
        canonicalBindingOwner: "lcx-external-channel-binding",
        canonicalBindingStatus: expect.any(String),
        nextHumanStep: expect.not.stringContaining("promote_dev_to_live"),
        userVisibleObserved: expect.any(Boolean),
      }),
    );
    expect(payload.externalChannelBinding).toEqual(
      expect.objectContaining({
        boundary: "dev_external_channel_binding_operator_only",
      }),
    );
    expect(payload.visibleProof).toEqual(
      expect.objectContaining({
        replyFlowProbeCommand:
          "node --import tsx scripts/dev/lcx-external-channel-status.ts --json --with-probe",
        legacyReplyFlowProbeCommand: expect.stringContaining("lcx-promote-live.ts"),
      }),
    );
    const externalChannelStatus = payload.externalChannelStatus as {
      externalChannelBound?: boolean;
    };
    const devLiveDrift = payload.devLiveDrift as
      | { devLiveDrift?: unknown; legacyDevLiveDrift?: unknown; liveNeedsPromotion?: unknown }
      | undefined;
    if (externalChannelStatus.externalChannelBound === true) {
      expect(devLiveDrift).toEqual(
        expect.objectContaining({
          devLiveDrift: "external_channel_bound_legacy_commit_diff_ignored",
          liveNeedsPromotion: false,
          legacyDevLiveDrift: expect.any(String),
        }),
      );
    }
    expect(payload.legacyPromoteLiveStatus).toEqual(
      expect.objectContaining({
        owner: "lcx-promote-live",
        boundary: "dev_external_channel_status_only",
        devLiveDrift: expect.any(Object),
        visibleProof: expect.any(Object),
      }),
    );
  });

  it("accepts the old --status flag as a compatibility no-op", async () => {
    const payload = await runStatus(["--status", "--json"]);

    expect(payload.owner).toBe("lcx-external-channel-status");
    expect(payload.boundary).toBe("dev_external_channel_status_only");
  });
});
