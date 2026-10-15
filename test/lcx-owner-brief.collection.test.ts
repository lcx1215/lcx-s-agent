import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildOwnerBriefWithPriorCollection,
  readOperatorDigest,
} from "../scripts/operator/lcx-owner-brief.ts";
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});
const digest = (b: string) => crypto.createHash("sha256").update(b).digest("hex");
async function nativeCollection(reason: string, exitCode = 1) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "operator-child-capture-"));
  roots.push(root);
  const transient = path.join(root, "temporary-child-outputs");
  await fs.mkdir(transient);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_REPO_ROOT: root,
    NODE_SOURCE_COMMIT: "fixture-commit",
    NODE_COLLECTION_RUN_ID: crypto.randomUUID(),
    NODE_OBSERVE_ONLY: "false",
    NODE_JSONL: path.join(root, "operator-log.jsonl"),
    NODE_LATEST: path.join(root, "workspace-latest.json"),
    NODE_REPO_LATEST: path.join(root, "repo-latest.json"),
  };
  for (const key of [
    "DOCTOR",
    "PLAN",
    "GOVERNANCE",
    "MIND",
    "FLOW",
    "CONTEXT_RECOVERY",
    "TRAINING_SUPERVISOR",
    "EXAM",
    "CLEANUP",
  ]) {
    const filename = path.join(transient, key + ".stdout");
    const stderr = path.join(transient, key + ".stderr");
    const body =
      key === "DOCTOR"
        ? {
            ok: false,
            summary: { passed: 0, failed: 1 },
            checks: [{ name: "finance-readiness", ok: false, error: reason }],
          }
        : { ok: true, summary: {}, actionableFailures: [] };
    await fs.writeFile(filename, key === "CLEANUP" ? "cleanup completed" : JSON.stringify(body));
    await fs.writeFile(stderr, "configuration warning unrelated to business failure");
    env[`NODE_${key}_FILE`] = filename;
    env[`NODE_${key}_ERR`] = stderr;
    env[`NODE_${key}_CODE`] = String(key === "DOCTOR" ? exitCode : 0);
  }
  const writer = path.resolve(
    import.meta.dirname,
    "../scripts/operator/lcx-local-operator-receipt-writer.cjs",
  );
  const result = spawnSync(process.execPath, [writer], { env, encoding: "utf8", timeout: 10000 });
  expect(result.status, result.stderr).toBe(0);
  const parent = JSON.parse(result.stdout);
  await fs.rm(transient, { recursive: true, force: true });
  return {
    root,
    filename: env.NODE_REPO_LATEST!,
    parent,
    manifest: path.join(root, parent.collection.manifest.path),
  };
}

describe("original local-operator writer to owner-brief child-body consumption", () => {
  it("preserves child stdout after temporary cleanup and uses it to identify the business failure", async () => {
    const first = await nativeCollection("broker reconciliation still unresolved");
    const readback = await readOperatorDigest(first.filename, { repoRoot: first.root });
    expect(readback.evidence.collection?.consumedChildBodies).toContain("doctor");
    expect(readback.evidence.owners.doctor.reason).toBe(
      "finance-readiness: broker reconciliation still unresolved",
    );
    expect(readback.evidence.owners.doctor.bodySource?.field).toBe("/checks/0/error");
    expect(readback.evidence.owners.doctor.stderr).toContain("configuration warning");
    const second = await nativeCollection("model provider requires payment");
    const changed = await readOperatorDigest(second.filename, { repoRoot: second.root });
    expect(changed.evidence.owners.doctor.reason).toBe(
      "finance-readiness: model provider requires payment",
    );
    expect(changed.evidence.owners.doctor.reason).not.toBe(readback.evidence.owners.doctor.reason);
    expect(changed.evidence.runBinding).toBe("unavailable"); // Capture correlation never invents child business identity.
    expect(changed.evidence.semanticTruth).toBe("not_proven");
  });
  it("does not treat exit zero as successful business checks", async () => {
    const collection = await nativeCollection("source gate failed", 0);
    const result = await readOperatorDigest(collection.filename, { repoRoot: collection.root });
    expect(result.evidence.owners.doctor).toMatchObject({
      ok: false,
      exitCode: 0,
      reason: "finance-readiness: source gate failed",
    });
    expect(result.evidence.status).toBe("blocked");
  });
  it.each(["stdout_hash", "manifest_hash", "wrong_parent"])(
    "refuses %s evidence without adopting its failure body",
    async (kind) => {
      const collection = await nativeCollection("genuine original diagnostic");
      const manifest = JSON.parse(await fs.readFile(collection.manifest, "utf8"));
      if (kind === "stdout_hash") {
        await fs.appendFile(path.join(collection.root, manifest.children.doctor.stdout.path), " ");
      }
      if (kind === "manifest_hash") {
        await fs.appendFile(collection.manifest, " ");
      }
      if (kind === "wrong_parent") {
        manifest.children.doctor.collectionRunId = crypto.randomUUID();
        const text = JSON.stringify(manifest);
        await fs.writeFile(collection.manifest, text);
        collection.parent.collection.manifest.sha256 = digest(text);
        await fs.writeFile(collection.filename, JSON.stringify(collection.parent));
      }
      const readback = await readOperatorDigest(collection.filename, { repoRoot: collection.root });
      expect(readback.evidence.contentStatus).toBe("unavailable");
      expect(readback.evidence.status).toBe("blocked");
      expect(readback.evidence.owners.doctor?.bodySource).toBeUndefined();
    },
  );
  it("keeps other original diagnoses when a timed-out child leaves partial JSON", async () => {
    const collection = await nativeCollection("broker source unresolved");
    const manifest = JSON.parse(await fs.readFile(collection.manifest, "utf8"));
    const child = manifest.children.flowGraph.stdout;
    const partial = '{"ok":';
    await fs.writeFile(path.join(collection.root, child.path), partial);
    child.sha256 = digest(partial);
    child.bytes = Buffer.byteLength(partial);
    const manifestText = JSON.stringify(manifest);
    await fs.writeFile(collection.manifest, manifestText);
    collection.parent.collection.manifest.sha256 = digest(manifestText);
    await fs.writeFile(collection.filename, JSON.stringify(collection.parent));
    const result = await readOperatorDigest(collection.filename, { repoRoot: collection.root });
    expect(result.evidence.status).toBe("blocked");
    expect(result.evidence.owners.doctor.reason).toBe(
      "finance-readiness: broker source unresolved",
    );
    expect(result.evidence.collection?.consumedChildBodies).toContain("doctor");
    expect(result.evidence.collection?.consumedChildBodies).not.toContain("flowGraph");
    expect(result.evidence.reasons).toContain(
      `operator_collection_child_body_unreadable:flowGraph:${child.path}`,
    );
    expect(result.evidence.owners.flowGraph.bodySource).toBeUndefined();
  });
  it("feeds original child causes into the normal governance brief without changing current gates", async () => {
    const collection = await nativeCollection("actual reconciliation gap");
    const input = {
      checkedAt: new Date().toISOString(),
      governance: { runReceipt: { runId: "current-governance" }, summary: {}, owners: {} },
      localFailureTrace: { result: "passed", firstFailedGate: "none", nextSafeAction: "monitor" },
      paths: { latestMarkdownPath: "brief.md", latestJsonPath: "brief.json", sourcePaths: [] },
    };
    const brief = await buildOwnerBriefWithPriorCollection(
      input,
      collection.root,
      collection.filename,
    );
    expect(brief.markdown).toContain("doctor：finance-readiness: actual reconciliation gap");
    expect(brief.priorOperatorDigest?.observationOrigin).toBe("prior_collection");
    expect(brief.priorOperatorDigest?.collection?.consumedChildBodies).toContain("doctor");
    expect(brief.priorOperatorDigest?.owners.doctor.bodySource?.sha256).toBeTruthy();
    expect(brief.runReceipt).toEqual({ runId: "current-governance" });
    expect(brief.firstFailedGate).toBe("none");
    expect(brief.nextSafeAction).toBe("monitor");
    expect(brief.sourcePaths).toContain(collection.filename);
  });
  it("keeps legacy receipt compatibility without manufacturing a collection identity", async () => {
    const collection = await nativeCollection("legacy missing child body");
    delete collection.parent.collection;
    await fs.writeFile(collection.filename, JSON.stringify(collection.parent));
    const result = await readOperatorDigest(collection.filename, { repoRoot: collection.root });
    expect(result.evidence.collection).toBeUndefined();
    expect(result.evidence.runBinding).toBe("unavailable");
    expect(result.evidence.owners.doctor.bodySource).toBeUndefined();
  });
});
