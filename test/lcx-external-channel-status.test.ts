import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  resolveExternalChannelTruth,
  selectBindingOwnerPayload,
} from "../scripts/operator/lcx-external-channel-status.js";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(import.meta.dirname, "..");

async function runStatus(args: string[]) {
  const { stdout } = await execFileAsync(
    process.execPath,
    ["--import", "tsx", "scripts/operator/lcx-external-channel-status.ts", ...args],
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
  it("does not let legacy compatibility evidence override the binding owner", () => {
    expect(
      resolveExternalChannelTruth({
        binding: {
          status: "deferred_active_training_or_eval",
          userVisibleObserved: false,
        },
        legacyExternalChannelStatus: {
          externalChannelBound: true,
          userVisibleObserved: true,
        },
        visibleProof: {
          status: "user_visible_observed",
          acceptanceMatched: true,
        },
      }),
    ).toEqual({
      externalChannelBound: false,
      userVisibleObserved: false,
      bindingStatus: "deferred_active_training_or_eval",
    });
  });

  it("fails closed when the canonical binding owner is unavailable", () => {
    expect(
      resolveExternalChannelTruth({
        binding: undefined,
        bindingOwnerAvailable: false,
        legacyExternalChannelStatus: {
          externalChannelBound: true,
          userVisibleObserved: true,
        },
        visibleProof: {
          status: "user_visible_observed",
          acceptanceMatched: true,
        },
      }),
    ).toEqual({
      externalChannelBound: false,
      userVisibleObserved: false,
      bindingStatus: "unavailable",
    });
  });

  it("never substitutes a stale latest snapshot after owner failure", () => {
    expect(
      selectBindingOwnerPayload({
        commandSucceeded: false,
        payload: {
          externalChannelBinding: {
            status: "channel_runtime_probe_ok_user_visible_observed",
            userVisibleObserved: true,
          },
        },
      }),
    ).toEqual({ payload: {}, source: "unavailable" });
  });

  it("wraps legacy promote-live status as a read-only external-channel owner", async () => {
    const payload = await runStatus(["--json"]);

    expect(payload).toEqual(
      expect.objectContaining({
        ok: true,
        boundary: "local_external_channel_status_only",
        owner: "lcx-external-channel-status",
        conceptStatus: "legacy_promote_live_status_wrapped_by_external_channel_status",
        liveTouched: false,
        providerConfigTouched: false,
        protectedMemoryTouched: false,
      }),
    );
    expect(payload.externalChannelStatus).toEqual(
      expect.objectContaining({
        statusModel: "core-ready -> external-channel-bound -> user-visible-observed",
        canonicalBindingOwner: "lcx-external-channel-binding",
        canonicalBindingStatus: expect.any(String),
        nextHumanStep: expect.not.stringContaining("promote_local_to_live"),
        userVisibleObserved: expect.any(Boolean),
      }),
    );
    expect(payload.ownerChildStatus).toEqual(
      expect.objectContaining({
        bindingStatusAvailable: expect.any(Boolean),
        bindingStatusSource: expect.stringMatching(/^(command|unavailable)$/u),
        bindingLatestPath: expect.stringContaining("lcx-external-channel-binding-latest.json"),
      }),
    );
    const ownerChildStatus = payload.ownerChildStatus as { bindingStatusAvailable?: boolean };
    if (ownerChildStatus.bindingStatusAvailable === true) {
      expect(payload.externalChannelBinding).toEqual(
        expect.objectContaining({
          boundary: "local_external_channel_binding_operator_only",
        }),
      );
    } else {
      expect(payload.externalChannelStatus).toEqual(
        expect.objectContaining({
          canonicalBindingStatus: "unavailable",
          nextHumanStep: "inspect_lcx_external_channel_binding_owner",
        }),
      );
    }
    expect(payload.visibleProof).toEqual(
      expect.objectContaining({
        replyFlowProbeCommand:
          "node --import tsx scripts/operator/lcx-external-channel-status.ts --json --with-probe",
        legacyReplyFlowProbeCommand: expect.stringContaining("lcx-external-channel-compat.ts"),
      }),
    );
    const externalChannelStatus = payload.externalChannelStatus as {
      externalChannelBound?: boolean;
    };
    expect(payload).not.toHaveProperty("devLiveDrift");
    expect(payload).not.toHaveProperty("legacyLegacyRepoLiveDrift");
    const canonicalWorktreeDrift = payload.canonicalWorktreeDrift as
      | {
          repositoryDrift?: unknown;
          liveNeedsPromotion?: unknown;
        }
      | undefined;
    if (externalChannelStatus.externalChannelBound === true) {
      expect(canonicalWorktreeDrift).toEqual(
        expect.objectContaining({
          repositoryDrift: "external_channel_bound_legacy_commit_diff_ignored",
          liveNeedsPromotion: false,
        }),
      );
    }
    expect(payload.legacyPromoteLiveStatus).toEqual(
      expect.objectContaining({
        owner: "lcx-external-channel-compat",
        boundary: "local_external_channel_status_only",
        devLiveDrift: expect.any(Object),
        visibleProof: expect.any(Object),
      }),
    );
  });
});
