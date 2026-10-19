import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Type } from "@sinclair/typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { ArtifactStore } from "../memory/artifact-store.js";
import {
  AGENT_ARTIFACT_MAX_BYTES,
  recordAgentArtifact,
  withArtifactResultRecording,
} from "./artifact-result-recording.js";
import { runCentralHarnessCycle } from "./central-harness/harness-loop.js";
import type { AnyAgentTool } from "./tools/common.js";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-artifact-recording-"));
  roots.push(workspaceDir);
  const dbPath = path.join(workspaceDir, "memory.sqlite");
  const config: OpenClawConfig = {
    agents: { defaults: { memorySearch: { enabled: true, store: { path: dbPath } } } },
  };
  return { workspaceDir, dbPath, config, agentId: "main" };
}
const observedAt = "2026-10-04T12:00:00.000Z";
const value = {
  content: [
    { type: "text", text: "Measured slippage is 2 basis points." },
    { type: "image", mimeType: "image/png", data: "iVBORexactbase64" },
    { type: "audio", mimeType: "audio/wav", data: "UklGRexactbase64" },
  ],
  details: {
    method: "Compare matched samples before promoting a rule.",
    scope: { symbol: "fixture", observations: 3 },
  },
};

describe("host-owned artifact result recording", () => {
  it("preserves tool-call identity while binding exact bytes to the host invocation", async () => {
    const host = await fixture();
    const input = {
      ...host,
      owner: "memory_get",
      runId: "same-tool-call",
      invocationRunId: "host-attempt-a",
      observedAt,
      value,
    };
    const first = await recordAgentArtifact(input);
    const workspaceId = createHash("sha256")
      .update(await fs.realpath(host.workspaceDir))
      .digest("hex");
    expect(first).toMatchObject({
      status: "registered",
      invocationRunId: input.invocationRunId,
      workspaceId,
    });
    const firstBytes = await fs.readFile(path.join(host.workspaceDir, first.relativePath!));
    expect(JSON.parse(firstBytes.toString())).toEqual({
      schemaVersion: "lcx_agent_artifact_v1",
      owner: input.owner,
      runId: input.runId,
      value,
      invocation: { runId: input.invocationRunId, workspaceId },
      observedAt,
    });
    const repeated = await recordAgentArtifact(input);
    expect(repeated).toEqual({ ...first, status: "unchanged" });
    expect(await fs.readFile(path.join(host.workspaceDir, first.relativePath!))).toEqual(
      firstBytes,
    );
    const otherRun = await recordAgentArtifact({ ...input, invocationRunId: "host-attempt-b" });
    expect(otherRun.status).toBe("registered");
    expect(otherRun.id).not.toBe(first.id);
    expect(otherRun.sha256).not.toBe(first.sha256);
    expect(otherRun.workspaceId).toBe(workspaceId);
    const proofRoot = process.env.LCX_ARTIFACT_INVOCATION_PROOF_DIR;
    if (proofRoot) {
      await fs.mkdir(proofRoot, { recursive: true });
      await fs.writeFile(path.join(proofRoot, "original-attempt-a.json"), firstBytes);
      await fs.writeFile(
        path.join(proofRoot, "original-attempt-b.json"),
        await fs.readFile(path.join(host.workspaceDir, otherRun.relativePath!)),
      );
      await fs.writeFile(
        path.join(proofRoot, "invocation-proof.json"),
        JSON.stringify({
          first,
          repeated,
          otherRun,
          workspaceId,
          hostWorkspace: host.workspaceDir,
        }),
      );
    }
  });

  it.each(["", " ", " leading", "trailing ", "control\ninside", "nul\0", "x".repeat(241), 7])(
    "rejects invalid host invocation %j before file or database registration",
    async (invocationRunId) => {
      const host = await fixture();
      const result = await recordAgentArtifact({
        ...host,
        owner: "memory_get",
        runId: "valid-tool-call",
        // Deliberately bypass the static type only for a malformed host input counterexample.
        invocationRunId: invocationRunId as string,
        value,
      });
      expect(result).toEqual({
        status: "unavailable",
        reason: "artifact_invocation_metadata_invalid",
      });
      expect(await fs.readdir(host.workspaceDir)).toEqual([]);
    },
  );

  it("uses canonical workspace identity without turning it into a business account", async () => {
    const host = await fixture();
    const foreign = await fixture();
    foreign.config = host.config;
    const input = {
      ...host,
      owner: "memory_get",
      runId: "shared-call",
      invocationRunId: "shared-host-attempt",
      observedAt,
      value,
    };
    const first = await recordAgentArtifact(input);
    const alias = path.join(host.workspaceDir, "canonical-alias");
    await fs.symlink(host.workspaceDir, alias);
    const sameWorkspace = await recordAgentArtifact({ ...input, workspaceDir: alias });
    expect(sameWorkspace).toEqual({ ...first, status: "unchanged" });
    const otherWorkspace = await recordAgentArtifact({ ...input, ...foreign });
    expect(otherWorkspace.status).toBe("registered");
    expect(otherWorkspace.workspaceId).not.toBe(first.workspaceId);
    expect(otherWorkspace.id).not.toBe(first.id);
    expect(otherWorkspace.sha256).not.toBe(first.sha256);
    const envelope = JSON.parse(
      await fs.readFile(path.join(host.workspaceDir, first.relativePath!), "utf8"),
    );
    expect(envelope.invocation).toEqual({
      runId: input.invocationRunId,
      workspaceId: first.workspaceId,
    });
    expect(envelope.invocation.accountId).toBeUndefined();
    expect(envelope.invocation.semanticTruth).toBeUndefined();
    const store = ArtifactStore.open({
      dbPath: host.dbPath,
      workspaceDir: host.workspaceDir,
      readOnly: true,
    });
    try {
      await expect(store.read(otherWorkspace.id!)).rejects.toMatchObject({
        code: "artifact_not_registered",
      });
    } finally {
      store.close();
    }
  });

  it("indexes bounded reference metadata while preserving every original reference and value", async () => {
    const host = await fixture();
    const refs = Array.from({ length: 21 }, (_, index) => `receipt:${index}`);
    const input = {
      ...host,
      owner: "workflow_delivery",
      runId: "many-references",
      value,
      sourceReceiptRefs: refs,
    };
    const receipt = await recordAgentArtifact(input);
    expect(receipt.status).toBe("registered");
    const raw = await fs.readFile(path.join(host.workspaceDir, receipt.relativePath!), "utf8");
    expect(JSON.parse(raw)).toMatchObject({ value, sourceReceiptRefs: refs });
    const reader = ArtifactStore.open({
      dbPath: host.dbPath,
      workspaceDir: host.workspaceDir,
      readOnly: true,
    });
    try {
      const read = await reader.read(receipt.id!);
      expect(read.artifact.sourceReceiptRefs).toEqual(refs.slice(0, 20));
      expect(read.artifact.summary).toContain("1 source reference(s) retained only in original");
      expect(read.artifact.sha256).toBe(createHash("sha256").update(raw).digest("hex"));
    } finally {
      reader.close();
    }
    expect((await recordAgentArtifact(input)).status).toBe("unchanged");
  });
  it("rejects invalid references even beyond the index projection instead of laundering them", async () => {
    const host = await fixture();
    const receipt = await recordAgentArtifact({
      ...host,
      owner: "workflow_delivery",
      runId: "bad-late-ref",
      value,
      sourceReceiptRefs: [
        ...Array.from({ length: 20 }, (_, i) => `receipt:${i}`),
        "x".repeat(2049),
      ],
    });
    expect(receipt).toMatchObject({
      status: "unavailable",
      reason: "artifact_source_refs_invalid",
    });
  });
  it("preserves the exact JSON tool envelope and media, registers SQLite, and is immutable/idempotent", async () => {
    const host = await fixture();
    const first = await recordAgentArtifact({
      ...host,
      owner: "quant_math",
      runId: "run-a",
      observedAt,
      value,
      sourceReceiptRefs: ["receipt:fixture"],
    });
    expect(first).toMatchObject({ status: "registered", reason: "ok" });
    const originalPath = path.join(host.workspaceDir, first.relativePath!);
    const before = await fs.readFile(originalPath);
    expect(JSON.parse(before.toString())).toEqual({
      schemaVersion: "lcx_agent_artifact_v1",
      observedAt,
      owner: "quant_math",
      runId: "run-a",
      value,
      sourceReceiptRefs: ["receipt:fixture"],
    });
    expect(first.sha256).toBe(createHash("sha256").update(before).digest("hex"));
    expect((await fs.stat(originalPath)).mode & 0o777).toBe(0o600);
    expect(
      (
        await recordAgentArtifact({
          ...host,
          owner: "quant_math",
          runId: "run-a",
          observedAt,
          value,
          sourceReceiptRefs: ["receipt:fixture"],
        })
      ).status,
    ).toBe("unchanged");
    expect(await fs.readFile(originalPath)).toEqual(before);
    const store = ArtifactStore.open({
      dbPath: host.dbPath,
      workspaceDir: host.workspaceDir,
      readOnly: true,
    });
    try {
      const read = await store.read(first.id!);
      expect(read.artifact.sha256).toBe(first.sha256);
      expect(read.text).not.toContain("iVBORexactbase64");
      expect(read.text).not.toContain("UklGRexactbase64");
      expect(store.search({ query: "iVBORexactbase64" }).artifacts).toEqual([]);
      expect(store.search({ query: "matched samples" }).artifacts.map((item) => item.id)).toContain(
        first.id,
      );
    } finally {
      store.close();
    }
  });

  it("captures plain method objects without pretending they are validated skills", async () => {
    const host = await fixture();
    const method = {
      problem: "A missed evidence input",
      workingAnswer: "Compare matching scope and source timestamp",
      validated: false,
    };
    const result = await recordAgentArtifact({
      ...host,
      owner: "central-harness",
      runId: "method-a",
      observedAt,
      value: method,
    });
    const envelope = JSON.parse(
      await fs.readFile(path.join(host.workspaceDir, result.relativePath!), "utf8"),
    );
    expect(envelope.value).toEqual(method);
  });

  it("records a real production central receipt with the original JSON wire contents", async () => {
    const host = await fixture();
    const receipt = await runCentralHarnessCycle({
      perception: { observedAt, ownerTotals: {}, controlRoom: {}, backlog: [], boundaries: [] },
      registry: new Map(),
      brain: {
        propose: async () => ({
          kind: "proposed",
          provider: "offline",
          modelId: "fixture",
          plan: { actions: [], note: "No changed input" },
        }),
      },
      planOnly: true,
    });
    const recorded = await recordAgentArtifact({
      ...host,
      owner: "central-harness",
      runId: receipt.runId,
      value: receipt,
    });
    expect(recorded.status).toBe("registered");
    const envelope = JSON.parse(
      await fs.readFile(path.join(host.workspaceDir, recorded.relativePath!), "utf8"),
    );
    expect(envelope.value).toEqual(JSON.parse(JSON.stringify(receipt)));
    expect(envelope.omittedUndefinedCount).toBeUndefined();
  });

  it("preserves undefined optional tool fields in memory and explicitly names wire omissions", async () => {
    const host = await fixture();
    const details = { ok: true, optional: undefined };
    const tool: AnyAgentTool = {
      name: "optional_tool",
      label: "Fixture",
      description: "Fixture",
      parameters: Type.Object({}),
      execute: async () => ({ content: [{ type: "text", text: "success" }], details }),
    };
    const output = await withArtifactResultRecording(tool, host).execute("optional", {});
    expect(output.details).toBe(details);
    expect(Object.hasOwn(output.details as object, "optional")).toBe(true);
    const artifact = JSON.parse(
      String((output.content.at(-1) as { text: string }).text),
    ).artifactEvidence;
    expect(artifact.status).toBe("registered");
    const envelope = JSON.parse(
      await fs.readFile(path.join(host.workspaceDir, artifact.relativePath), "utf8"),
    );
    expect(envelope.value.details).toEqual({ ok: true });
    expect(envelope.omittedUndefinedFields).toEqual(["$/value/details/optional"]);
    expect(envelope.omittedUndefinedCount).toBe(1);
    expect(
      (
        await recordAgentArtifact({
          ...host,
          owner: "fixture",
          runId: "array-undefined",
          value: [undefined],
        })
      ).reason,
    ).toBe("artifact_value_unserializable");
  });

  it("reuses a stable first-file timestamp when observedAt is omitted", async () => {
    const host = await fixture();
    const input = { ...host, owner: "quant_math", runId: "retry", value: { number: 1 } };
    expect((await recordAgentArtifact(input)).status).toBe("registered");
    expect((await recordAgentArtifact(input)).status).toBe("unchanged");
  });

  it.each(["disabled", "cyclic", "bigint", "function", "budget"])(
    "reports %s without creating a database",
    async (kind) => {
      const host = await fixture();
      const cyclic: Record<string, unknown> = {};
      cyclic.self = cyclic;
      const payload =
        kind === "cyclic"
          ? cyclic
          : kind === "bigint"
            ? { number: 1n }
            : kind === "function"
              ? { method: () => 1 }
              : kind === "budget"
                ? "x".repeat(AGENT_ARTIFACT_MAX_BYTES + 1)
                : value;
      if (kind === "disabled") {
        host.config = { agents: { defaults: { memorySearch: { enabled: false } } } };
      }
      const result = await recordAgentArtifact({
        ...host,
        owner: "fixture",
        runId: "bad",
        value: payload,
      });
      expect(result).toMatchObject({
        status: "unavailable",
        reason:
          kind === "disabled"
            ? "artifact_recording_disabled"
            : kind === "cyclic"
              ? "artifact_value_cyclic"
              : kind === "budget"
                ? "artifact_budget_exceeded"
                : "artifact_value_unserializable",
      });
      expect(await fs.readdir(host.workspaceDir)).toEqual([]);
    },
  );

  it("retains the original for an unavailable database and makes a retry discoverable by id/ref", async () => {
    const host = await fixture();
    await fs.mkdir(host.dbPath);
    const result = await recordAgentArtifact({
      ...host,
      owner: "fixture",
      runId: "db-busy",
      value,
    });
    expect(result.status).toBe("unavailable");
    expect(result.id).toMatch(/^artifact-/u);
    expect(
      JSON.parse(await fs.readFile(path.join(host.workspaceDir, result.relativePath!), "utf8"))
        .value,
    ).toEqual(value);
    await fs.rmdir(host.dbPath);
    expect(
      (await recordAgentArtifact({ ...host, owner: "fixture", runId: "db-busy", value })).status,
    ).toBe("registered");
  });

  it.each(["state", "state/artifacts"])(
    "blocks an alias at %s without writing outside its tree",
    async (alias) => {
      const host = await fixture();
      const outside = await fixture();
      await fs.mkdir(path.dirname(path.join(host.workspaceDir, alias)), { recursive: true });
      await fs.symlink(outside.workspaceDir, path.join(host.workspaceDir, alias));
      expect(
        (await recordAgentArtifact({ ...host, owner: "fixture", runId: "alias", value })).status,
      ).toBe("unavailable");
      expect(await fs.readdir(outside.workspaceDir)).toEqual([]);
      await expect(fs.access(host.dbPath)).rejects.toThrow();
    },
  );

  it("does not overwrite a conflicting immutable artifact", async () => {
    const host = await fixture();
    const envelope = {
      schemaVersion: "lcx_agent_artifact_v1",
      owner: "fixture",
      runId: "collision",
      value,
    };
    const hash = createHash("sha256")
      .update(`${JSON.stringify(envelope)}\n`)
      .digest("hex");
    const destination = path.join(host.workspaceDir, "state", "artifacts", `${hash}.json`);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.writeFile(destination, "prior immutable bytes");
    expect(
      (await recordAgentArtifact({ ...host, owner: "fixture", runId: "collision", value })).reason,
    ).toBe("artifact_identity_conflict");
    expect(await fs.readFile(destination, "utf8")).toBe("prior immutable bytes");
    await expect(fs.access(host.dbPath)).rejects.toThrow();
  });

  it("namespaces identical values and run ids by canonical workspace in a shared private database", async () => {
    const firstHost = await fixture();
    const secondHost = await fixture();
    secondHost.config = firstHost.config;
    const first = await recordAgentArtifact({
      ...firstHost,
      owner: "fixture",
      runId: "same",
      observedAt,
      value,
    });
    const second = await recordAgentArtifact({
      ...secondHost,
      owner: "fixture",
      runId: "same",
      observedAt,
      value,
    });
    expect(first.status).toBe("registered");
    expect(second.status).toBe("registered");
    expect(first.sha256).toBe(second.sha256);
    expect(first.id).not.toBe(second.id);
    const scoped = ArtifactStore.open({
      dbPath: firstHost.dbPath,
      workspaceDir: firstHost.workspaceDir,
      readOnly: true,
    });
    try {
      await expect(scoped.read(second.id!)).rejects.toMatchObject({
        code: "artifact_not_registered",
      });
    } finally {
      scoped.close();
    }
  });

  it("returns a cancelled gap before recording any output", async () => {
    const host = await fixture();
    const controller = new AbortController();
    controller.abort();
    expect(
      await recordAgentArtifact({
        ...host,
        owner: "fixture",
        runId: "cancel",
        value,
        signal: controller.signal,
      }),
    ).toEqual({ status: "unavailable", reason: "artifact_recording_cancelled" });
    expect(await fs.readdir(host.workspaceDir)).toEqual([]);
  });
});

describe("artifact recording tool wrapper", () => {
  it("preserves arguments/signal, all original media/content/details and business fields", async () => {
    const host = { ...(await fixture()), invocationRunId: "host-original-wrapper-run" };
    const result = {
      content: [
        { type: "text" as const, text: "original" },
        { type: "image" as const, mimeType: "image/png", data: "iVBORexactbase64" },
      ],
      details: value.details,
      artifactEvidence: { business: true },
    };
    const execute = vi.fn(async () => result);
    const tool: AnyAgentTool = {
      name: "fixture_tool",
      label: "Fixture",
      description: "Fixture",
      parameters: Type.Object({}),
      execute,
    };
    const wrapped = withArtifactResultRecording(tool, host);
    const controller = new AbortController();
    const params = {
      secretArgNotRecorded: "test-sentinel",
      invocationRunId: "tool-argument-cannot-override-host",
    };
    const output = await wrapped.execute("wrapped", params, controller.signal);
    expect(execute).toHaveBeenCalledWith("wrapped", params, controller.signal, undefined);
    expect(output.details).toBe(result.details);
    expect(output.content.slice(0, result.content.length)).toEqual(result.content);
    expect(output).toMatchObject({ artifactEvidence: { business: true } });
    const evidence = JSON.parse(
      String((output.content.at(-1) as { text: string }).text),
    ).artifactEvidence;
    expect(evidence.status).toBe("registered");
    expect(evidence.invocationRunId).toBe(host.invocationRunId);
    expect(
      await fs.readFile(path.join(host.workspaceDir, evidence.relativePath), "utf8"),
    ).not.toContain("test-sentinel");
  });

  it("keeps original failures and cancellation exceptions, and skips artifact recall tools", async () => {
    const host = await fixture();
    const failure = new Error("original cancelled");
    const tool: AnyAgentTool = {
      name: "fixture_tool",
      label: "Fixture",
      description: "Fixture",
      parameters: Type.Object({}),
      execute: async () => {
        throw failure;
      },
    };
    await expect(withArtifactResultRecording(tool, host).execute("failed", {})).rejects.toBe(
      failure,
    );
    expect(await fs.readdir(host.workspaceDir)).toEqual([]);
    expect(withArtifactResultRecording({ ...tool, name: "artifact_get" }, host).execute).toBe(
      tool.execute,
    );
    expect(
      withArtifactResultRecording({ ...tool, name: "artifact_memory_recall" }, host).execute,
    ).toBe(tool.execute);
  });

  it("preserves original successful result when its details are cyclic", async () => {
    const host = await fixture();
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const tool: AnyAgentTool = {
      name: "fixture_tool",
      label: "Fixture",
      description: "Fixture",
      parameters: Type.Object({}),
      execute: async () => ({ content: [{ type: "text", text: "success" }], details: cyclic }),
    };
    const output = await withArtifactResultRecording(tool, host).execute("cyclic", {});
    expect(output.details).toBe(cyclic);
    expect(output.content[0]).toEqual({ type: "text", text: "success" });
    expect(output).toMatchObject({
      artifactEvidence: { status: "unavailable", reason: "artifact_value_cyclic" },
    });
  });

  it("keeps business success when recording is disabled", async () => {
    const host = await fixture();
    host.config = { agents: { defaults: { memorySearch: { enabled: false } } } };
    const tool: AnyAgentTool = {
      name: "fixture_tool",
      label: "Fixture",
      description: "Fixture",
      parameters: Type.Object({}),
      execute: async () => ({
        content: [{ type: "text", text: "success" }],
        details: { ok: true },
      }),
    };
    const output = await withArtifactResultRecording(tool, host).execute("disabled", {});
    expect(output.details).toEqual({ ok: true });
    expect(output.content[0]).toEqual({ type: "text", text: "success" });
    expect(output).toMatchObject({
      artifactEvidence: { status: "unavailable", reason: "artifact_recording_disabled" },
    });
  });
});
