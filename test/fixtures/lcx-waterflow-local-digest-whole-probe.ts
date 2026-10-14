import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  auditWorkflowHandoffs,
  FLOW_SCENARIOS,
  type WorkflowFieldRef,
  type WorkflowHandoffEvidence,
} from "../../scripts/operator/lcx-flow-graph.ts";

const scenarioId = "local_automation_digest_waterflow";
const repoRoot = path.resolve(import.meta.dirname, "../..");
const hash = (bytes: string | Buffer) => crypto.createHash("sha256").update(bytes).digest("hex");
function record(value: unknown): Record<string, unknown> {
  assert.ok(value && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}
function string(value: unknown): string {
  assert.equal(typeof value, "string");
  return value as string;
}
async function pinnedJson(file: string, expected?: string) {
  const bytes = await fs.readFile(file);
  const sha256 = hash(bytes);
  if (expected) {
    assert.equal(sha256, expected);
  }
  return { value: record(JSON.parse(bytes.toString("utf8"))), sha256, path: file };
}

/** Reuse exact native artifacts; do not execute the host loop or reconstruct any receipt. */
export async function nativeLocalDigestWholeObservation(proofPath: string, businessBlocked = true) {
  const proof = await pinnedJson(proofPath);
  const proofValue = record(proof.value.readback);
  const digest = record(proofValue.operatorDigest);
  const nativeSource = record(digest.source);
  assert.equal(digest.runBinding, "unavailable");
  assert.equal(digest.semanticTruth, "not_proven");
  const consumerSource = record(proof.value.source);
  assert.equal(
    string(consumerSource.sha256),
    hash(await fs.readFile(path.join(repoRoot, string(consumerSource.path)))),
  );
  const producer = await pinnedJson(string(nativeSource.path), string(nativeSource.sha256));
  const writerProof = await pinnedJson(
    path.join(path.dirname(producer.path), "original-writer-proof.json"),
  );
  const writerSource = record(writerProof.value.source);
  assert.equal(hash(await fs.readFile(string(writerSource.path))), string(writerSource.sha256));
  assert.equal(producer.sha256, writerProof.value.sha256);
  assert.deepEqual(producer.value, writerProof.value.value);
  assert.equal(
    writerProof.value.boundary,
    "original_receipt_writer_private_IO_only_upstream_owners_unrun_no_scheduler",
  );
  assert.ok(Array.isArray(proof.value.persisted));
  const jsonArtifact = proof.value.persisted.find((row: unknown) =>
    string(record(row).path).endsWith(".json"),
  );
  const persisted = record(jsonArtifact);
  const consumer = await pinnedJson(string(persisted.path), string(persisted.sha256));
  assert.deepEqual(consumer.value, proofValue);
  assert.equal(
    proof.value.boundary,
    "original_reader_renderer_writer_private_state_only_no_gov_trace_hostloop_or_provider",
  );
  assert.equal(
    record(record(consumer.value.operatorDigest).source).checkedAt,
    producer.value.checkedAt,
  );
  const ref = (artifact: { path: string; sha256: string }, pointer: string): WorkflowFieldRef => ({
    path: artifact.path,
    sha256: artifact.sha256,
    pointer,
  });
  const observation: WorkflowHandoffEvidence = {
    scenarioId,
    environment: "offline_fixture",
    nodes: [
      {
        nodeId: "operator_latest_receipt",
        // Original source observation time is an artifact join only, not a canonical run id.
        scope: ref(producer, "/checkedAt"),
        output: ref(producer, businessBlocked ? "/contextRecovery/actionableFailures/0" : "/ok"),
      },
      {
        nodeId: "operator_digest",
        scope: ref(consumer, "/operatorDigest/source/checkedAt"),
        output: ref(consumer, "/operatorDigest/status"),
        inputs: [
          {
            from: "operator_latest_receipt",
            value: ref(
              consumer,
              businessBlocked
                ? "/operatorDigest/owners/contextRecovery/reason"
                : "/operatorDigest/operatorAggregateOk",
            ),
          },
        ],
        ...(businessBlocked
          ? {
              block: {
                filter: "error_receipt_required" as const,
                status: ref(consumer, "/operatorDigest/status"),
                reason: ref(consumer, "/firstFailedGate"),
              },
            }
          : {}),
      },
    ],
  };
  const scenario = FLOW_SCENARIOS.find((item) => item.id === scenarioId);
  assert.ok(scenario);
  const result = {
    index: [observation],
    producer,
    consumer,
    manifest: {
      reusedProducerProof: { path: writerProof.path, sha256: writerProof.sha256 },
      reusedConsumerProof: { path: proof.path, sha256: proof.sha256 },
      producerSource: writerSource,
      consumerSource,
      currentAuditorSource: {
        path: "scripts/operator/lcx-flow-graph.ts",
        sha256: hash(await fs.readFile(path.join(repoRoot, "scripts/operator/lcx-flow-graph.ts"))),
      },
      observationScope:
        "original producer checkedAt and independently persisted consumer source.checkedAt; artifact-time join only",
      canonicalRunBinding: digest.runBinding,
      semanticTruth: digest.semanticTruth,
      naturalCaller: "not_observed",
      upstreamOwners: "not_executed_lowest_IO_substitutes_only",
      requiredNodes: scenario.requiredNodes,
      requiredEdges: scenario.edges,
      observedNodes: observation.nodes.map((node) => node.nodeId),
      timeoutCancellation:
        "No new original writer/CLI execution; reused native writer VM 1000ms, CLI execFile 10000ms with default SIGTERM; no cleanup-confirmation claim",
      role: "read-only original producer/independent consumer field verifier",
    },
  };
  return result;
}

export async function auditNativeLocalDigestWhole(index: readonly WorkflowHandoffEvidence[]) {
  const results = await auditWorkflowHandoffs(index);
  const result = results.find((item) => item.scenarioId === scenarioId);
  assert.ok(result);
  return result;
}

export async function persistNativeLocalDigestWhole(root: string, name: string, value: unknown) {
  await fs.mkdir(root, { recursive: true });
  const file = path.join(root, `${name}.json`);
  const bytes = JSON.stringify(value, null, 2) + "\n";
  await fs.writeFile(file, bytes);
  return { path: file, sha256: hash(bytes) };
}
