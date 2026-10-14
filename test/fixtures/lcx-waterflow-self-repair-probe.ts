import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  buildSelfRepairHandsReceipt,
  writeSelfRepairHandsReceipt,
} from "../../scripts/operator/lcx-self-repair-hands.js";
import {
  compactReceipts,
  runCentralHarnessCycle,
  type CompactBacklogEntry,
} from "../../src/agents/central-harness/harness-loop.js";
import { createCentralToolRegistry } from "../../src/agents/central-harness/tool-registry.js";
import type {
  CentralActionPlan,
  CentralPerception,
  CentralRunReceipt,
} from "../../src/agents/central-harness/types.js";

export type SelfRepairFault =
  | "missing"
  | "hash"
  | "account"
  | "run"
  | "stale"
  | "future"
  | "conflict"
  | "unreviewed";
const sha = (bytes: string) => createHash("sha256").update(bytes).digest("hex");

/** Original writer, postwrite consumer and memory reader; only reasoning is an offline substitute. */
export async function probeOriginalSelfRepair(
  workspaceDir: string,
  fault?: SelfRepairFault,
  replacementRule = "Require current scoped evidence before memory reuse.",
) {
  const scope = { accountId: "offline-self-repair-paper", runId: "offline-self-repair" };
  const sourcePath = "state/repair-source.json";
  const source = {
    scope: {
      accountId: fault === "account" ? "other" : scope.accountId,
      runId: fault === "run" ? "other" : scope.runId,
    },
    observedAt: new Date(
      Date.now() + (fault === "future" ? 60000 : fault === "stale" ? -8 * 86400000 : -1000),
    ).toISOString(),
    replacementRule: fault === "conflict" ? "contradictory proposed rule" : replacementRule,
    trust: "private_fixture_no_market_truth",
  };
  await fs.mkdir(path.join(workspaceDir, "state"), { recursive: true });
  const sourceBody = `${JSON.stringify(source, null, 2)}\n`;
  await fs.writeFile(path.join(workspaceDir, sourcePath), sourceBody);
  const pin = { path: sourcePath, sha256: fault === "hash" ? "0".repeat(64) : sha(sourceBody) };
  const writer = buildSelfRepairHandsReceipt({
    checkedAt: new Date().toISOString(),
    workspaceDir,
    signalKey: scope.runId,
    issue: "provisional_repair_source_review",
    observedFailure: "Original note lacked verified current sources.",
    replacementRule,
    domain: "offline_fixture",
    write: true,
    ...(fault !== "unreviewed"
      ? { sourceReview: { schemaVersion: 1, source: pin, expectedScope: scope } }
      : {}),
  });
  await fs.writeFile(
    path.join(workspaceDir, "state/self-repair-builder.json"),
    `${JSON.stringify(writer, null, 2)}\n`,
  );
  if (fault === "missing") {
    await fs.unlink(path.join(workspaceDir, sourcePath));
  }
  await writeSelfRepairHandsReceipt(writer);
  // Actual file readback, not the builder object relabeled as a consumer.
  const persistedWriter = JSON.parse(
    await fs.readFile(writer.latestJsonPath, "utf8"),
  ) as typeof writer;
  const candidateExists = await fs.access(writer.hands.memoryCleaner.path).then(
    () => true,
    () => false,
  );
  const correctionBody = candidateExists
    ? await fs.readFile(writer.hands.memoryCleaner.path, "utf8")
    : "";
  const manifest = {
    schemaVersion: 1,
    source: pin,
    correction: {
      path: writer.hands.memoryCleaner.relativePath.split(path.sep).join("/"),
      sha256: sha(correctionBody),
    },
  };
  const manifestPath = path.join(workspaceDir, "state/review-input.json");
  const protectedStatus = path.join(workspaceDir, "state/private-protected-status.txt");
  await fs.writeFile(manifestPath, JSON.stringify(manifest));
  await fs.writeFile(protectedStatus, "");
  const repo = path.resolve(import.meta.dirname, "../..");
  const cli = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      path.join(repo, "scripts/operator/lcx-system-memory-sedimentation-gate.ts"),
      "--workspace",
      workspaceDir,
      "--protected-status",
      protectedStatus,
      "--correction-review",
      manifestPath,
      "--review-account-id",
      scope.accountId,
      "--review-run-id",
      scope.runId,
      "--json",
    ],
    { cwd: repo, encoding: "utf8", timeout: 30000 },
  );
  assert.equal(cli.status, 0, cli.stderr);
  const gatePath = path.join(workspaceDir, "state/postwrite-review.json");
  await fs.writeFile(gatePath, cli.stdout);
  const consumedReview = JSON.parse(await fs.readFile(gatePath, "utf8")) as {
    status: string;
    correctionReview: { status: string; reuseAllowed: false; blockers: string[] };
  };
  const ids = new Set(["memory_get", "artifact_memory_recall"]);
  const registry = new Map(
    [
      ...createCentralToolRegistry({
        workspaceDir,
        config: {
          agents: {
            defaults: {
              workspace: workspaceDir,
              memorySearch: {
                enabled: true,
                store: { path: path.join(workspaceDir, "private-artifacts.sqlite") },
              },
            },
          },
        },
      }),
    ].filter(([id]) => ids.has(id)),
  );
  const receipts: CentralRunReceipt[] = [];
  const inputs: CentralPerception[] = [];
  const cycle = async (propose: (input: CentralPerception) => CentralActionPlan) => {
    const input: CentralPerception = {
      observedAt: new Date().toISOString(),
      ownerTotals: {},
      controlRoom: { selfRepair: persistedWriter, correctionReview: consumedReview },
      backlog: compactReceipts(receipts, 10, ids),
      boundaries: ["offline_only", "provisional_not_replacement", "broker_unknown_blocked"],
    };
    inputs.push(input);
    const receipt = await runCentralHarnessCycle({
      perception: input,
      registry,
      capabilityOwnerIds: ids,
      planOnly: true,
      brain: {
        propose: async (seen) => ({
          kind: "proposed",
          provider: "offline-fixture",
          modelId: "scripted-provisional-consumer",
          plan: propose(seen),
        }),
      },
    });
    receipts.push(receipt);
    await fs.writeFile(
      path.join(workspaceDir, "state", `self-repair-cycle-${receipts.length}.json`),
      `${JSON.stringify(receipt, null, 2)}\n`,
    );
    return receipt;
  };
  const read = await cycle(() => ({
    actions: [
      { ownerId: "memory_get", args: { path: manifest.correction.path, from: 1, lines: 40 } },
    ],
    note: "Read exact candidate note; file availability cannot authorize replacement or ranking.",
  }));
  if (!candidateExists) {
    await cycle(() => ({
      actions: [],
      note: `Hold repair: ${persistedWriter.sourceReview.blockers.join(";")}; candidate absent, replacement and ranking unconfirmed.`,
    }));
  } else {
    const artifact = read.steps[0].resultArtifact;
    assert.ok(artifact?.id && artifact.sha256);
    await cycle(() => ({
      actions: [
        {
          ownerId: "artifact_memory_recall",
          args: { action: "read", id: artifact.id, field: "/value/text" },
        },
      ],
      note: "Deliver archived provisional note body.",
    }));
    await cycle((input) => {
      const outcome = input.backlog
        .flatMap((e) => (e.outcomes ?? []) as CompactBacklogEntry["outcomes"])
        .find(
          (s) => s.outcome?.artifactId === artifact.id && s.outcome?.field === "/value/text",
        )?.outcome;
      const text = outcome?.selectedValue;
      assert.ok(typeof text === "string" && text.includes(replacementRule));
      return {
        actions: [],
        note: `Candidate says ${replacementRule}; hold actual reuse, replacement and search ranking until owner review and fresh adjacent application.`,
        evidenceUse: [
          {
            artifactId: artifact.id!,
            sourceSha256: artifact.sha256!,
            field: "/value/text",
            effect: "retain",
            reason:
              "Actual read confirms provisional candidate content; it does not prove applied replacement, ranking change, source truth or model absorption.",
          },
        ],
      };
    });
  }
  await cycle((input) => {
    assert.ok(input.backlog.some((e) => e.note === receipts.at(-1)!.brainCall.note));
    return {
      actions: [],
      note: "Retain previous actual hold and source gap; broker remains blocked.",
    };
  });
  return {
    writer: persistedWriter,
    source,
    sourceBody,
    manifest,
    correctionBody,
    candidateExists,
    consumedReview,
    gatePath,
    inputs,
    receipts,
    fault,
    reuseAllowed: false,
    actualReplacement: "not_proven",
    actualSearchRankingChange: "not_proven",
    semanticAdoption: "offline_scripted_only_natural_not_proven",
  };
}
