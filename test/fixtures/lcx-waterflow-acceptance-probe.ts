import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { runExternalShortIntentFuzzer } from "../../scripts/operator/lcx-external-short-intent-fuzzer.js";
import { runVisibleAnswerQualityFuzzer } from "../../scripts/operator/lcx-visible-answer-quality-fuzzer.js";

export type AcceptanceSourcePaths = Partial<
  Record<"training" | "flow" | "mind" | "channel" | "learning", string>
>;
export type AcceptanceProbeFault =
  | "failed_training"
  | "missing_training_state"
  | "training_child_exception"
  | "doctor_timeout"
  | "doctor_nonzero"
  | "doctor_check_unconfirmed"
  | "doctor_other_failure";
const commands = [
  ["lcx-problem-cluster-radar.ts", "radar"],
  ["lcx-flow-graph.ts", "flow"],
  ["lcx-mind-model.ts", "mind"],
  ["lcx-external-channel-status.ts", "channel"],
  ["lcx-external-channel-binding.ts", "binding"],
  ["local-brain-training-plan.ts", "training"],
  ["lcx-provider-council-acceleration.ts", "council"],
  ["lcx-module-learning-absorption-gate.ts", "learning"],
  ["lcx-commercial-answer-pipeline.ts", "pipeline"],
  ["lcx-external-short-intent-fuzzer.ts", "short"],
  ["lcx-visible-answer-quality-fuzzer.ts", "quality"],
  ["lcx-system-doctor.ts", "doctor"],
] as const;

/** Replays frozen original bytes or runs original pure producers; never executes child commands. */
export async function prepareAcceptanceProbe(
  directory: string,
  sourcePaths: AcceptanceSourcePaths = {},
  fault?: AcceptanceProbeFault,
) {
  await fs.mkdir(directory, { recursive: true });
  const sources: Array<{
    id: string;
    path: string;
    sha256: string;
    origin: string;
    upstreamPath?: string;
    upstreamSha256?: string;
  }> = [];
  const payloads: Record<string, Record<string, unknown>> = {
    radar: { ok: true, summary: { actionableClusters: 0, blockedClusters: 0, watchClusters: 0 } },
    flow: { ok: true, summary: { failed: 0 }, actionableFailures: [] },
    mind: { ok: true, summary: { failed: 0 }, actionableFailures: [] },
    training: {
      ok: true,
      activeProcesses: [],
      overlappingHeavyEval: false,
      decisions: [{ id: "offline_training_observation", action: "do_not_start_training" }],
    },
    channel: {
      ok: true,
      externalChannelStatus: { externalChannelBound: false, userVisibleObserved: false },
    },
    binding: {
      ok: true,
      externalChannelBinding: {
        status: "channel_runtime_probe_unconfirmed",
        userVisibleObserved: false,
        missingProof: ["offline_no_binding_authority"],
      },
    },
    learning: { ok: false, absorptionReady: false, blockers: ["offline_source_not_supplied"] },
    council: {
      ok: true,
      status: "provider_council_not_observed",
      action: "report_missing_source",
      dailyUse: { completeCouncilInWindow: false, dueNow: false },
      hardBlocks: ["offline_no_provider_authority"],
    },
    pipeline: { ok: false, failedReason: "offline_original_catalog_not_frozen" },
    doctor: {
      ok: true,
      checks: [
        {
          name: "model-council-provider-evidence",
          ok: true,
          summary: { boundary: "explicit_child_diagnostic_substitute_no_provider_health_claim" },
        },
      ],
    },
    financeClean: { ok: false, failedReason: "offline_finance_smoke_not_run" },
    financeConflict: { ok: false, failedReason: "offline_finance_smoke_not_run" },
    short: runExternalShortIntentFuzzer(),
    quality: runVisibleAnswerQualityFuzzer(),
  };
  for (const [id, payload] of Object.entries(payloads)) {
    const upstreamPath = sourcePaths[id as keyof AcceptanceSourcePaths];
    let raw = upstreamPath ? await fs.readFile(upstreamPath, "utf8") : JSON.stringify(payload);
    const upstreamSha256 = upstreamPath
      ? createHash("sha256").update(raw).digest("hex")
      : undefined;
    if (id === "training" && fault) {
      const value = JSON.parse(raw) as Record<string, unknown>;
      if (fault === "failed_training") {
        value.ok = false;
        value.failedReason = "offline_training_source_unavailable";
      }
      if (fault === "missing_training_state") {
        delete value.overlappingHeavyEval;
      }
      raw = JSON.stringify(value);
    }
    if (
      id === "doctor" &&
      (fault === "doctor_check_unconfirmed" || fault === "doctor_other_failure")
    ) {
      const value = JSON.parse(raw) as Record<string, unknown>;
      if (fault === "doctor_other_failure") {
        value.ok = false;
      } else {
        const checks = value.checks as Array<Record<string, unknown>>;
        const check = checks[0];
        if (!check) {
          throw new Error("private doctor fixture check missing");
        }
        delete check.ok;
      }
      raw = JSON.stringify(value);
    }
    const file = path.join(directory, `${id}.json`);
    await fs.writeFile(file, raw);
    sources.push({
      id,
      path: file,
      sha256: createHash("sha256").update(raw).digest("hex"),
      origin: upstreamPath
        ? "frozen_original_owner_replay"
        : id === "short" || id === "quality"
          ? "actual_original_pure_producer"
          : "explicit_child_diagnostic_substitute",
      ...(upstreamPath ? { upstreamPath, upstreamSha256 } : {}),
    });
  }
  const calls: Array<{
    executable: string;
    args: readonly string[];
    cwd?: string;
    timeout?: number;
    maxBuffer?: number;
    sourceId: string;
    sourceSha256: string;
  }> = [];
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  const execute = async (
    executable: string,
    args: readonly string[],
    options: { cwd?: string; timeout?: number; maxBuffer?: number },
  ) => {
    const basename = path.basename(args[2] ?? "");
    const id =
      basename === "finance-data-gateway-smoke.ts"
        ? args.includes("--conflict")
          ? "financeConflict"
          : "financeClean"
        : commands.find(([script]) => script === basename)?.[1];
    if (!id) {
      throw new Error(`unallowlisted offline child: ${basename}`);
    }
    const source = sources.find((entry) => entry.id === id)!;
    calls.push({
      executable,
      args: [...args],
      cwd: options.cwd,
      timeout: options.timeout,
      maxBuffer: options.maxBuffer,
      sourceId: id,
      sourceSha256: source.sha256,
    });
    if (calls.length === 14) {
      release();
    }
    await barrier;
    const stdout = await fs.readFile(source.path, "utf8");
    if (id === "training" && fault === "training_child_exception") {
      throw Object.assign(new Error("offline training child exception"), {
        stderr: "private owner read unavailable",
      });
    }
    if (id === "training" && fault === "failed_training") {
      throw Object.assign(new Error("offline training child returned nonzero"), {
        stdout,
        stderr: "source unavailable",
      });
    }
    if (id === "doctor" && (fault === "doctor_timeout" || fault === "doctor_nonzero")) {
      throw Object.assign(new Error(`offline doctor child ${fault}`), {
        stdout,
        stderr: "private doctor execution did not complete",
        code: fault === "doctor_timeout" ? "ETIMEDOUT" : 1,
        killed: fault === "doctor_timeout",
      });
    }
    return { stdout, stderr: "" };
  };
  return { sources, calls, execute };
}
