import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildDirectedDailyResearchBrief,
  readDirectedDailyCases,
} from "../scripts/operator/lcx-directed-daily-research-brief.js";
import { saveFinanceCaseRun } from "../src/agents/finance-caseflow.js";
import {
  directedCaseSha,
  produceDirectedCase,
  writeDirectedBindings,
} from "./fixtures/lcx-waterflow-directed-case-read-probe.js";

const execFileAsync = promisify(execFile);
let workspace: string;
beforeEach(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), "lcx-directed-case-"));
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Network forbidden")));
});
afterEach(async () => {
  await fs.rm(workspace, { recursive: true, force: true });
  vi.unstubAllGlobals();
});
async function produce(options: Partial<Parameters<typeof produceDirectedCase>[0]> = {}) {
  return produceDirectedCase({
    directory: path.join(workspace, "cases"),
    caseId: "directed-native-case",
    ...options,
  });
}
async function read(file: string) {
  return readDirectedDailyCases({
    workspaceDir: workspace,
    date: "2026-10-11",
    bindingsFile: file,
  });
}
async function save(name: string, result: unknown) {
  const root = process.env.LCX_DIRECTED_CASE_PROOF_DIR;
  if (!root) {
    return;
  }
  const directory = path.join(root, name);
  await fs.mkdir(directory, { recursive: true });
  await fs.cp(workspace, path.join(directory, "private-bytes"), { recursive: true });
  await fs.writeFile(
    path.join(directory, "native-result.json"),
    JSON.stringify(result, null, 2) + "\n",
  );
}
describe("original daily brief consumes existing original case runs", () => {
  it("preserves default planning and does not create a researched packet", () => {
    const result = buildDirectedDailyResearchBrief({ date: "2026-10-11" });
    expect(result.executionStatus).toBe("planning_contract_only");
    expect(result.researchPacketStatus).toBe("not_produced");
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each(["missing", "malformed", "invalid_contract"])(
    "retains a complete native CLI/writer refusal for %s bindings",
    async (fault) => {
      const file = path.join(workspace, "bad-bindings.json");
      if (fault !== "missing") {
        await fs.writeFile(
          file,
          fault === "malformed" ? '{"private_body":"untrusted",' : '{"tasks":[]}',
        );
      }
      const { stdout } = await execFileAsync(
        process.execPath,
        [
          "--import",
          "tsx",
          "scripts/operator/lcx-directed-daily-research-brief.ts",
          "--json",
          "--write",
          "--date",
          "2026-10-11",
          "--case-bindings",
          file,
        ],
        {
          cwd: path.resolve(import.meta.dirname, ".."),
          env: { ...process.env, OPENCLAW_WORKSPACE_DIR: workspace },
          timeout: 15_000,
          maxBuffer: 1024 * 1024,
        },
      );
      const output = JSON.parse(stdout) as Awaited<ReturnType<typeof readDirectedDailyCases>> & {
        written: { latestJsonPath: string; latestMarkdownPath: string };
      };
      expect(output).toMatchObject({
        ok: false,
        caseBindingReadStatus: "failed",
        researchPacketStatus: "held",
      });
      expect(output.packetCandidateSections).toHaveLength(4);
      expect(
        output.packetCandidateSections.every(
          (section) => section.status === "held" && !section.packet,
        ),
      ).toBe(true);
      const reason =
        fault === "missing"
          ? "binding_read_failed:ENOENT"
          : fault === "malformed"
            ? "binding_invalid_json_or_utf8"
            : "binding_contract_invalid";
      expect(output.missingForPacket.join(" ")).toContain(reason);
      const retained = JSON.parse(
        await fs.readFile(output.written.latestJsonPath, "utf8"),
      ) as typeof output;
      expect(retained.caseBindingReadStatus).toBe("failed");
      expect(await fs.readFile(output.written.latestMarkdownPath, "utf8")).toContain(reason);
      expect(retained.visibleBrief).not.toContain("untrusted");
      expect(fetch).not.toHaveBeenCalled();
      await save(`binding-${fault}-native-receipt`, { output, retained });
    },
  );
  it("returns the missing-binding JSON without writing when --write is absent", async () => {
    const { stdout } = await execFileAsync(
      process.execPath,
      [
        "--import",
        "tsx",
        "scripts/operator/lcx-directed-daily-research-brief.ts",
        "--json",
        "--date",
        "2026-10-11",
        "--case-bindings",
        "missing.json",
      ],
      {
        cwd: path.resolve(import.meta.dirname, ".."),
        env: { ...process.env, OPENCLAW_WORKSPACE_DIR: workspace },
        timeout: 15_000,
        maxBuffer: 1024 * 1024,
      },
    );
    const output = JSON.parse(stdout) as Awaited<ReturnType<typeof readDirectedDailyCases>>;
    expect(output).toMatchObject({
      ok: false,
      caseBindingReadStatus: "failed",
      researchPacketStatus: "held",
    });
    expect(output.missingForPacket.join(" ")).toContain("binding_read_failed:ENOENT");
    expect(await fs.readdir(workspace)).toEqual([]);
    await save("binding-missing-no-write", { stdout, output });
  });
  it("reads original source-bound body and claims through the native CLI, writer and readback", async () => {
    const run = await produce();
    expect(run.receipt.status).toBe("candidate");
    const { file } = await writeDirectedBindings(workspace, run);
    const before = buildDirectedDailyResearchBrief({ date: "2026-10-11" });
    const { stdout } = await execFileAsync(
      process.execPath,
      [
        "--import",
        "tsx",
        "scripts/operator/lcx-directed-daily-research-brief.ts",
        "--json",
        "--write",
        "--date",
        "2026-10-11",
        "--case-bindings",
        file,
      ],
      {
        cwd: path.resolve(import.meta.dirname, ".."),
        env: { ...process.env, OPENCLAW_WORKSPACE_DIR: workspace },
        timeout: 15_000,
        maxBuffer: 2 * 1024 * 1024,
      },
    );
    const output = JSON.parse(stdout) as Awaited<ReturnType<typeof readDirectedDailyCases>> & {
      written: { latestJsonPath: string; latestMarkdownPath: string };
    };
    const retained = JSON.parse(
      await fs.readFile(output.written.latestJsonPath, "utf8"),
    ) as typeof output;
    const section = retained.packetCandidateSections[0];
    expect(section).toMatchObject({
      taskId: "index_options_regime",
      status: "read_ready",
      contentAcceptance: "review_required",
      source: { ref: run.saved.ref, sourceSha256: directedCaseSha(run.bytes) },
    });
    expect(section.packet).toEqual(run.readback.packet);
    expect(section.evidence).toEqual(run.readback.run.evidence);
    expect(retained.visibleBrief).toContain(run.readback.packet.analysis);
    expect(await fs.readFile(output.written.latestMarkdownPath, "utf8")).toContain(
      run.readback.packet.claims[0].text,
    );
    expect(retained.researchPacketStatus).toBe("partial_sections");
    expect(retained.missingForPacket).toContain(
      "risk_gate_and_learning_loop:task_case_not_observed",
    );
    expect(retained.missingForPacket).toContain("daily_task_content_review_not_observed");
    expect(fetch).not.toHaveBeenCalled();
    await save("native-cli-body-readback", { before, output, retained, producer: run });
  });
  it.each([
    ["hash", "case_source_hash_conflict"],
    ["identity", "case_identity_conflict"],
    ["task", "case_task_ask_mismatch"],
    ["targets", "case_target_scope_mismatch"],
    ["date", "binding_date_asof_mismatch"],
    ["missing", "ENOENT"],
  ])("holds %s with an actual source gap", async (fault, reason) => {
    const run = await produce();
    const { file, bindings } = await writeDirectedBindings(workspace, run);
    if (fault === "hash") {
      bindings.tasks[0].caseSha256 = "0".repeat(64);
    }
    if (fault === "identity") {
      bindings.tasks[0].snapshotFingerprint = "0".repeat(64);
    }
    if (fault === "task") {
      bindings.tasks[0].taskId = "semiconductor_leader_board";
    }
    if (fault === "targets") {
      bindings.tasks[0].targets = ["NVDA"];
    }
    if (fault === "date") {
      bindings.date = "2026-10-10";
    }
    if (fault === "missing") {
      await fs.unlink(run.saved.path);
    }
    await fs.writeFile(file, JSON.stringify(bindings));
    const result = await read(file);
    const section = result.packetCandidateSections.find(
      (item) => item.taskId === bindings.tasks[0].taskId,
    )!;
    expect(section.status).toBe("held");
    expect(section.gaps.join(" ")).toContain(reason);
    expect(section.source).toBeUndefined();
    expect(result.researchPacketStatus).toBe("held");
    await save(`rejected-${fault}`, { run, bindings, result });
  });
  it.each([
    ["planned", "case_status:planned"],
    ["quality_failure", "case_quality_not_verified"],
    ["missing_source", "case_required_gate:source"],
    ["timeout", "case_required_gate:source"],
  ] as const)("reads actual %s owner refusal without marking it usable", async (fault, reason) => {
    const run = await produce(fault === "planned" ? { planned: true } : { fault });
    const { file } = await writeDirectedBindings(workspace, run);
    const result = await read(file);
    expect(result.packetCandidateSections[0].status).toBe("held");
    expect(result.packetCandidateSections[0].gaps.join(" ")).toContain(reason);
    expect(result.packetCandidateSections[0].source?.ref).toBe(run.saved.ref);
    expect(result.visibleBrief).not.toContain(run.readback.packet.analysis);
    await save(`native-${fault}`, { run, result });
  });
  it("rejects an older original run even when its quality passed", async () => {
    const run = await produce({ asOf: "2026-10-10T12:00:00.000Z" });
    const { file } = await writeDirectedBindings(workspace, run);
    const result = await read(file);
    expect(result.packetCandidateSections[0].gaps).toContain("case_asof_mismatch");
    await save("older-native-source", { run, result });
  });
  it("rejects packet text conflicting with its immutable original snapshot", async () => {
    const run = await produce();
    run.readback.packet.analysis = "A different, unverified daily conclusion.";
    run.saved = await saveFinanceCaseRun(path.join(workspace, "cases"), run.readback);
    run.bytes = await fs.readFile(run.saved.path, "utf8");
    const { file } = await writeDirectedBindings(workspace, run);
    const result = await read(file);
    expect(result.packetCandidateSections[0].gaps).toContain("case_packet_snapshot_conflict");
    expect(result.visibleBrief).not.toContain(run.readback.packet.analysis);
    await save("packet-snapshot-body-conflict", { run, result });
  });
  it("does not turn a generic adopted risk packet into completed rule application", async () => {
    const taskId = "risk_gate_and_learning_loop";
    const run = await produce({ taskId });
    const { file } = await writeDirectedBindings(workspace, run, taskId);
    const result = await read(file);
    const section = result.packetCandidateSections[3];
    expect(run.readback.packet.adopted).toBe(true);
    expect(section.status).toBe("held");
    expect(section.gaps).toContain("learning_application_receipt_not_observed");
    expect(result.researchPacketStatus).toBe("held");
    await save("risk-application-not-observed", { run, result });
  });
  it("rejects duplicate declarations and filesystem escapes without consuming case content", async () => {
    const run = await produce();
    const { file, bindings } = await writeDirectedBindings(workspace, run);
    bindings.tasks.push(bindings.tasks[0]);
    await fs.writeFile(file, JSON.stringify(bindings));
    expect((await read(file)).packetCandidateSections[0].gaps).toContain(
      "binding_unknown_or_duplicate_task",
    );
    bindings.tasks.pop();
    bindings.caseDirectory = path.dirname(workspace);
    await fs.writeFile(file, JSON.stringify(bindings));
    expect((await read(file)).packetCandidateSections[0].gaps).toContain(
      "case_source_outside_workspace",
    );
  });
  it("retains outside-workspace and symlink binding refusals without revealing their body", async () => {
    const target = path.join(workspace, "private-binding.json");
    await fs.writeFile(target, '{"private_body":"never expose this"}');
    const link = path.join(workspace, "binding-link.json");
    await fs.symlink(target, link);
    const symlink = await read(link);
    expect(symlink).toMatchObject({ ok: false, researchPacketStatus: "held" });
    expect(symlink.packetCandidateSections[0].gaps).toContain("case_source_symlink");
    expect(JSON.stringify(symlink)).not.toContain("never expose this");
    const outside = await read(path.join(workspace, "..", "outside-binding.json"));
    expect(outside).toMatchObject({ ok: false, researchPacketStatus: "held" });
    expect(outside.packetCandidateSections[0].gaps).toContain("case_source_outside_workspace");
    expect(outside.caseBindingsSource).toBeUndefined();
    await save("binding-private-path-refusal", { symlink, outside });
  });
});
