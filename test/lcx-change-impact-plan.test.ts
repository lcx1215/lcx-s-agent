import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { reviewMechanismComparison } from "../scripts/operator/lcx-change-impact-plan.js";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(import.meta.dirname, "..");

async function mechanismFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "lcx-mechanism-review-"));
  privateRoots.push(root);
  const targetPath = "scripts/operator/minimax-quota-brain-saturator.ts";
  const current = path.join(repoRoot, targetPath);
  const bytes = await fs.readFile(current);
  const hash = (data: Buffer | string) => createHash("sha256").update(data).digest("hex");
  const before = path.join(root, "before.ts");
  await fs.writeFile(before, bytes);
  const source = { path: current, sha256: hash(bytes) };
  const snapshot = { path: before, sha256: hash(bytes) };
  const report = {
    sourceHash: source.sha256,
    inputHash: "a".repeat(64),
    calls: 1,
    subsequentWork: false,
  };
  const oldReport = path.join(root, "old-report.json");
  const newReport = path.join(root, "new-report.json");
  const body = JSON.stringify(report) + "\n";
  await fs.writeFile(oldReport, body);
  await fs.writeFile(newReport, body);
  const field = (file: string, pointer: string) => ({ path: file, sha256: hash(body), pointer });
  const input = {
    schemaVersion: "lcx_mechanism_comparison_v1",
    repoRoot,
    targetPath,
    ownerPath: targetPath,
    disposition: "preserve",
    beforeSource: snapshot,
    afterSource: source,
    beforeSourceHash: field(oldReport, "/sourceHash"),
    afterSourceHash: field(newReport, "/sourceHash"),
    beforeInputHash: field(oldReport, "/inputHash"),
    afterInputHash: field(newReport, "/inputHash"),
    checks: [
      {
        id: "selected_call_count",
        before: field(oldReport, "/calls"),
        after: field(newReport, "/calls"),
        expectedBefore: 1,
        expectedAfter: 1,
      },
    ],
  };
  const routes = [
    {
      source: { path: targetPath, sha256: source.sha256 },
      familyIds: ["fixture_binding_only"],
      ownerPaths: [targetPath],
      ownerSources: [{ path: targetPath, sha256: source.sha256, bytes: bytes.length }],
      disposition: "preserve_existing_owner" as const,
      gaps: [],
      semanticEquivalence: "not_proven" as const,
    },
  ];
  return { root, input, routes, oldReport, newReport, source };
}

describe("selected source-bound mechanism report comparison", () => {
  it("compares actual selected fields without treating source hashes as semantic equivalence or mutation authority", async () => {
    const f = await mechanismFixture();
    const result = await reviewMechanismComparison(
      f.input,
      { rootDir: f.root, repoRoot },
      f.routes,
    );
    expect(result).toMatchObject({
      status: "reviewed",
      disposition: "preserve",
      sourceMutationAuthorized: false,
      semanticEquivalence: "not_proven",
      coverage: "selected_behavior_reports_only",
      checks: [{ before: 1, after: 1, changed: false }],
    });
    expect(result.sourceReads.length).toBeGreaterThan(2);
  });
  it.each([
    "source-hash",
    "input-hash",
    "missing-field",
    "different-outcome",
    "owner",
    "repo",
    "deadline",
    "report-hash",
  ] as const)("does not approve %s as a valid selected comparison", async (fault) => {
    const f = await mechanismFixture();
    const input = structuredClone(f.input);
    const host = { rootDir: f.root, repoRoot, deadlineAt: Date.now() + 20_000 };
    if (fault === "source-hash") {
      input.afterSource.sha256 = "b".repeat(64);
    }
    if (fault === "input-hash") {
      input.afterInputHash.pointer = "/sourceHash";
    }
    if (fault === "missing-field") {
      input.checks[0].after.pointer = "/missing";
    }
    if (fault === "different-outcome") {
      input.checks[0].expectedAfter = 0;
    }
    if (fault === "owner") {
      input.ownerPath = "src/unowned.ts";
    }
    if (fault === "repo") {
      input.repoRoot = f.root;
    }
    if (fault === "deadline") {
      host.deadlineAt = Date.now() - 1;
    }
    if (fault === "report-hash") {
      await fs.appendFile(f.newReport, " ");
    }
    const result = await reviewMechanismComparison(input, host, f.routes);
    expect(result.status).toBe("unknown");
    expect(result.disposition).toBe("unknown");
    expect(result.sourceMutationAuthorized).toBe(false);
    expect(result.reason).toContain("mechanism_review_");
  });
});

async function runPlanArgs(args: string[], env: NodeJS.ProcessEnv = process.env) {
  const { stdout } = await execFileAsync(
    process.execPath,
    ["--import", "tsx", "scripts/operator/lcx-change-impact-plan.ts", "--json", ...args],
    {
      cwd: repoRoot,
      env,
      maxBuffer: 10 * 1024 * 1024,
    },
  );
  return JSON.parse(stdout) as {
    ok: boolean;
    changedFiles: string[];
    changedFilesReadback?: { source: string; status: string; reason?: string };
    affectedLanes: string[];
    impacts: Array<{
      id: string;
      lane: string;
      matchedFiles: string[];
      requiredChecks: string[];
      commands: string[];
    }>;
    unmatchedFiles: string[];
    strayGate: {
      ok: boolean;
      rule: string;
      unmatchedChangedFiles: string[];
      nextAction: string;
      consolidation: {
        status: string;
        blocksPlan: boolean;
        routes: unknown[];
        conflicts: unknown[];
      };
      priorWork: {
        status: string;
        blocksPlan: boolean;
        gaps: string[];
        reads: unknown[];
        semanticEquivalence: string;
      };
    };
    recommendedFastCommands: string[];
    deferredCommands: string[];
    safetyNotes: string[];
    cleanupReview?: {
      status: "blocked" | "reviewed";
      reason: string;
      cleanupAuthorized: false;
      dispositions: unknown[];
    };
  };
}

async function runPlan(changedFile: string) {
  return runPlanArgs(["--changed", changedFile]);
}

const privateRoots: string[] = [];
afterEach(async () => {
  await Promise.all(
    privateRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});
async function privateGit(mode: string) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "lcx-impact-git-source-"));
  privateRoots.push(root);
  const bin = path.join(root, "bin");
  await fs.mkdir(bin);
  const pidPath = path.join(root, "git.pid");
  await fs.writeFile(
    path.join(bin, "git"),
    [
      `#!${process.execPath}`,
      `const mode = ${JSON.stringify(mode)};`,
      `const fs = require("node:fs");`,
      `if (mode === "timeout") { fs.writeFileSync(${JSON.stringify(pidPath)}, String(process.pid)); setTimeout(() => {}, 60000); }`,
      `else if (mode === "missing" || (mode === "status_failure" && process.argv[2] === "status")) process.exit(128);`,
      `else if (mode === "empty_root") process.exit(0);`,
      `else if (process.argv[2] === "rev-parse") process.stdout.write((mode === "foreign_root" ? "/foreign/git/root" : ${JSON.stringify(repoRoot)}) + "\\n");`,
      "",
    ].join("\n"),
    { mode: 0o700 },
  );
  return {
    env: { ...process.env, PATH: bin + path.delimiter + (process.env.PATH ?? "") },
    pidPath,
  };
}

describe("lcx-change-impact-plan", () => {
  it
    .skipIf(process.platform === "win32")
    .each(["missing", "foreign_root", "empty_root", "status_failure"])(
    "keeps unavailable Git source %s blocked with a complete receipt",
    async (mode) => {
      const { env } = await privateGit(mode);
      const result = await runPlanArgs([], env);
      expect(result).toMatchObject({
        ok: false,
        changedFilesReadback: { source: "git", status: "unavailable" },
        strayGate: { ok: false },
      });
      expect(result.changedFilesReadback?.reason).toMatch(/git_/);
      expect(result.strayGate.nextAction).toContain("unknown is not clean");
      const explicit = await runPlanArgs(
        ["--changed", "scripts/operator/lcx-change-impact-plan.ts"],
        env,
      );
      expect(explicit).toMatchObject({
        ok: true,
        changedFilesReadback: { source: "explicit_paths", status: "observed" },
      });
    },
  );
  it.skipIf(process.platform === "win32")(
    "distinguishes an actually observed empty Git change set",
    async () => {
      const { env } = await privateGit("clean");
      expect(await runPlanArgs([], env)).toMatchObject({
        ok: true,
        changedFiles: [],
        changedFilesReadback: { source: "git", status: "observed" },
      });
    },
  );
  it.skipIf(process.platform === "win32")(
    "ends a stalled Git source read and reports unknown instead of clean",
    async () => {
      const { env, pidPath } = await privateGit("timeout");
      const started = Date.now();
      const result = await runPlanArgs([], env);
      expect(result).toMatchObject({
        ok: false,
        changedFilesReadback: { status: "unavailable", reason: "git_changed_paths_unavailable" },
      });
      expect(Date.now() - started).toBeLessThan(25_000);
      const pid = Number(await fs.readFile(pidPath, "utf8"));
      expect(() => process.kill(pid, 0)).toThrow();
    },
    30_000,
  );

  it("assigns new source-bound reply and self-repair readers to their existing owners", async () => {
    const result = await runPlanArgs([
      "--files",
      "src/agents/finance-reply-evidence.ts",
      "src/agents/self-repair-source-review.ts",
    ]);
    expect(result.ok).toBe(true);
    expect(result.unmatchedFiles).toEqual([]);
    expect(result.impacts).toContainEqual(
      expect.objectContaining({
        id: "external_message_visible_surface",
        matchedFiles: expect.arrayContaining(["src/agents/finance-reply-evidence.ts"]),
      }),
    );
    expect(result.impacts).toContainEqual(
      expect.objectContaining({
        id: "module_learning_memory",
        matchedFiles: expect.arrayContaining(["src/agents/self-repair-source-review.ts"]),
      }),
    );
    expect(result.recommendedFastCommands.join("\n")).toContain(
      "src/agents/self-repair-source-review.test.ts",
    );
  });
  it("keeps the old path-only receipt compatible without claiming a cleanup review", async () => {
    const result = await runPlan("src/agents/finance-expectation-gap.ts");
    expect(result.ok).toBe(true);
    expect(result.cleanupReview).toBeUndefined();
    expect(result.strayGate.consolidation).toMatchObject({
      status: "not_observed",
      blocksPlan: false,
      routes: [],
      conflicts: [],
    });
    expect(result.strayGate.priorWork).toMatchObject({
      status: "not_observed",
      blocksPlan: false,
      gaps: ["explicit_paths_inventory_only"],
      reads: [],
      semanticEquivalence: "not_proven",
    });
  });
  it("parses review input separately from changed paths and reports an unreadable input as blocked", async () => {
    const result = await runPlanArgs([
      "--changed",
      "src/agents/finance-expectation-gap.ts",
      "--cleanup-review",
      "state/definitely-absent-cleanup-review.json",
    ]);
    expect(result.changedFiles).toEqual(["src/agents/finance-expectation-gap.ts"]);
    expect(result.ok).toBe(false);
    expect(result.cleanupReview).toMatchObject({
      status: "blocked",
      dispositions: [],
      cleanupAuthorized: false,
    });
  });
  it("rejects unknown and duplicate review flags instead of laundering them as changed paths", async () => {
    await expect(runPlanArgs(["--review-unrecognized", "value"])).rejects.toThrow(
      "unknown review flag",
    );
    await expect(
      runPlanArgs(["--cleanup-review", "one", "--cleanup-review", "two"]),
    ).rejects.toThrow("duplicate --cleanup-review");
  });
  it("keeps strategy judgment contracts in the existing unattended finance lane", async () => {
    const result = await runPlan("src/agents/finance-expectation-gap.ts");
    expect(result.ok).toBe(true);
    expect(result.unmatchedFiles).toEqual([]);
    expect(result.impacts.some((impact) => impact.id === "finance_unattended_cycle")).toBe(true);
  });
  it("routes the commit helper alone to its original hook regression", async () => {
    const result = await runPlan("scripts/committer");
    expect(result.ok).toBe(true);
    expect(result.unmatchedFiles).toEqual([]);
    expect(result.affectedLanes).toEqual(["local_dev_tooling"]);
    expect(result.recommendedFastCommands).toContain(
      "pnpm vitest run test/git-hooks-pre-commit.test.ts",
    );
    expect(result.recommendedFastCommands).toContain("bash -n scripts/committer");
  });

  it("routes project Skill pointers through the canonical Skill lane", async () => {
    const result = await runPlanArgs([
      "--files",
      ".agents/skills/agent-brain-eval",
      "skills/agent-brain-eval/SKILL.md",
    ]);
    expect(result.ok).toBe(true);
    expect(result.unmatchedFiles).toEqual([]);
    expect(result.affectedLanes).toEqual(["skill_runtime"]);
    expect(result.recommendedFastCommands.join(" ")).toContain("skills.test.ts");
  });

  it("assigns resident workers and host lifecycle to existing owners", async () => {
    const files = [
      "src/agents/local-text-worker.ts",
      "src/agents/local-vision-vlm.ts",
      "src/plugins/lcx-model-fleet.ts",
      "docs/tools/local-data-workers.md",
      "src/cli/serve-cli.ts",
    ];
    const result = await runPlanArgs(["--files", ...files]);
    expect(result.unmatchedFiles).toEqual([]);
    expect(result.affectedLanes).toEqual(
      expect.arrayContaining(["agent_workflow_memory", "daemon_free_agent_entry"]),
    );
    expect(result.recommendedFastCommands.join(" ")).toContain("local-text-worker.test.ts");
  });
  it("routes cloud and canonical answer files without admitting unknown operators", async () => {
    const unknown = "scripts/operator/lcx-unclassified-cloud.ts";
    const result = await runPlanArgs([
      "--files",
      "deploy/cloud/.env.example",
      "docs/install/cloud.md",
      "scripts/operator/lcx-cloud-preflight.ts",
      "src/agents/commercial-answer-pipeline.ts",
      unknown,
    ]);
    expect(result.unmatchedFiles).toEqual([unknown]);
    expect(result.affectedLanes).toEqual(
      expect.arrayContaining(["local_deployment_boundary", "external_message_visible_reply"]),
    );
    expect(result.ok).toBe(false);
  });

  it("keeps unknown artifact paths blocked", async () => {
    const result = await runPlan(".artifacts/unowned/report.json");
    expect(result.ok).toBe(false);
    expect(result.strayGate.unmatchedChangedFiles).toContain(".artifacts/unowned/report.json");
  });
  it("routes finance methods and retained receipts to explicit owners", async () => {
    const files = [
      "src/agents/finance-strategy-method-kit.ts",
      "src/agents/finance-strategy-method-catalog.ts",
      "src/agents/quality-harness-findings.ts",
      "scripts/operator/finance-strategy-all-methods.ts",
      "docs/experiments/research/finance-strategy-all-methods-2026-09-10.md",
      "docs/experiments/research/finance-strategy-stress-matrix-2026-09-10.md",
      "src/agents/finance-source-recovery.ts",
      "src/agents/finance-model-workflow.ts",
      "src/agents/finance-model-specialist.ts",
      "docs/experiments/research/finance-model-workflow.md",
      "src/agents/configured-finance-model-adapter.ts",
      "src/agents/finance-http-body.ts",
      "src/agents/finance-http-body.test.ts",
      "src/agents/finance-news-entity.ts",
      "src/agents/finance-research-evidence.ts",
      "src/agents/finance-agent-committee.ts",
      "src/agents/local-text-model-adapter.ts",
      "src/agents/logical-agent-model-router.ts",
      "scripts/operator/finance-strategy-method-benchmark.ts",
      ".artifacts/finance-strategy/benchmark-20260910.json",
    ];
    const result = await runPlanArgs(files.flatMap((file) => ["--changed", file]));
    expect(result.ok).toBe(true);
    expect(result.unmatchedFiles).toEqual([]);
    expect(result.impacts.map((impact) => impact.id)).toEqual(
      expect.arrayContaining([
        "finance_caseflow",
        "logical_agent_pool",
        "finance_benchmark_receipts",
      ]),
    );
  });
  it("routes commodity-pair source and replay artifacts to the M13 research owner", async () => {
    const files = [
      "src/agents/quant-math-pair-spread.ts",
      "docs/experiments/research/commodity-pair-y2501-p2501/README.md",
      "docs/experiments/research/commodity-pair-y-maturity-panel/capture.mts",
      "docs/experiments/research/commodity-pair-y-maturity-panel/capture.json",
      "docs/experiments/research/commodity-pair-y-maturity-panel/input.csv",
      "docs/experiments/research/commodity-pair-y-maturity-panel/replay.mts",
      "docs/experiments/research/commodity-pair-y-maturity-panel/result.json",
    ];
    const result = await runPlanArgs(["--files", ...files]);

    expect(result.ok).toBe(true);
    expect(result.unmatchedFiles).toEqual([]);
    expect(result.impacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "commodity_pair_research_replay",
          matchedFiles: expect.arrayContaining(files),
          commands: expect.arrayContaining([
            "node --import tsx docs/experiments/research/commodity-pair-y-maturity-panel/replay.mts",
          ]),
        }),
      ]),
    );
  });

  it("routes metadata-only model request trajectory through its owner and regressions", async () => {
    const payload = await runPlanArgs([
      "--files",
      "src/agents/model-request-trajectory.ts",
      "src/agents/model-request-trajectory.test.ts",
      "src/agents/configured-finance-model-adapter.ts",
      "src/agents/central-harness/model-brain.ts",
      "src/agents/pi-embedded-runner/run/attempt.ts",
      "scripts/operator/lcx-model-trajectory.ts",
    ]);

    expect(payload.ok).toBe(true);
    expect(payload.unmatchedFiles).toEqual([]);
    expect(payload.affectedLanes).toContain("agent_workflow_memory");
    expect(payload.impacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "model_request_metadata_trajectory",
          requiredChecks: ["model-request-trajectory-tests"],
        }),
      ]),
    );
    expect(payload.recommendedFastCommands.join("\n")).toContain(
      "src/agents/model-request-trajectory.test.ts",
    );
  });
  it("routes every test file through the single main vitest configuration", async () => {
    const result = await runPlanArgs([
      "--files",
      "test/operator/lcx-finance-research.test.ts",
      "src/agents/quality-harness-findings.test.ts",
    ]);
    expect(result.recommendedFastCommands).toContain(
      "pnpm vitest run src/agents/quality-harness-findings.test.ts test/operator/lcx-finance-research.test.ts",
    );
    expect(result.recommendedFastCommands).not.toContain(
      "pnpm vitest run --config vitest.scripts-operator.config.ts test/operator/lcx-finance-research.test.ts",
    );
  });
  it("keeps retained benchmark evidence on an existing mathematical test owner", async () => {
    const result = await runPlan(".artifacts/finance-strategy/all-methods-20260910.json");
    expect(result.recommendedFastCommands).toContain(
      "pnpm vitest run src/agents/finance-strategy-method-benchmark.test.ts",
    );
  });
  it("does not recommend heavy local-brain eval tests as fast commands while training may be active", async () => {
    const payload = await runPlan("scripts/operator/lcx-context-recovery-exam.ts");

    expect(payload.ok).toBe(true);
    expect(payload.affectedLanes).toEqual(["global_doctrine_and_runbook"]);
    expect(payload.impacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "architecture_supervision_stack",
          lane: "global_doctrine_and_runbook",
          requiredChecks: expect.arrayContaining(["architecture-supervision-tests"]),
        }),
      ]),
    );
    expect(payload.recommendedFastCommands.join("\n")).not.toContain(
      "test/local-brain-distill-eval.test.ts",
    );
    expect(payload.deferredCommands).toEqual(
      expect.arrayContaining(["pnpm vitest run test/local-brain-distill-eval.test.ts"]),
    );
    expect(payload.safetyNotes.join("\n")).toContain("no active guard/eval/MLX");
    expect(payload.safetyNotes.join("\n")).toContain("do not create overlapping heavy eval");
  });

  it("classifies flow graph changes as architecture supervision, not Qwen training work", async () => {
    const payload = await runPlan("scripts/operator/lcx-flow-graph.ts");

    expect(payload.ok).toBe(true);
    expect(payload.strayGate.ok).toBe(true);
    expect(payload.affectedLanes).toEqual(["global_doctrine_and_runbook"]);
    expect(payload.impacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "architecture_supervision_stack",
          lane: "global_doctrine_and_runbook",
          matchedFiles: ["scripts/operator/lcx-flow-graph.ts"],
        }),
      ]),
    );
    expect(payload.impacts).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "local_brain_micro_surface",
        }),
      ]),
    );
  });

  it("gives architecture and engineering governance docs one owner lane", async () => {
    const payload = await runPlanArgs([
      "--files",
      "ops/architecture/LCX-SYSTEM-ARCHITECTURE.md",
      "ops/engineering/LCX-GIT-DELIVERY-STANDARD.md",
    ]);

    expect(payload.ok).toBe(true);
    expect(payload.unmatchedFiles).toEqual([]);
    expect(payload.affectedLanes).toEqual(["global_doctrine_and_runbook"]);
    expect(payload.impacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "doctrine_or_runbook",
          lane: "global_doctrine_and_runbook",
          matchedFiles: [
            "ops/architecture/LCX-SYSTEM-ARCHITECTURE.md",
            "ops/engineering/LCX-GIT-DELIVERY-STANDARD.md",
          ],
          headTailRequired: true,
        }),
      ]),
    );
  });

  it("routes multi-agent pattern shadow artifacts through the dedicated owner lane", async () => {
    const payload = await runPlan("scripts/operator/lcx-multi-agent-pattern-shadow.ts");

    expect(payload.ok).toBe(true);
    expect(payload.affectedLanes).toEqual(["agent_workflow_memory"]);
    expect(payload.impacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "multi_agent_pattern_shadow",
          requiredChecks: expect.arrayContaining(["multi-agent-pattern-replay"]),
          headTailRequired: true,
          risk: "elevated",
        }),
      ]),
    );
    expect(payload.unmatchedFiles).toEqual([]);
  });

  it("routes logical agent pool artifacts through the dedicated owner lane", async () => {
    const payload = await runPlan("src/agents/logical-agent-pool.ts");

    expect(payload.ok).toBe(true);
    expect(payload.affectedLanes).toEqual(["agent_workflow_memory"]);
    expect(payload.impacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "logical_agent_pool",
          requiredChecks: expect.arrayContaining(["logical-agent-pool-tests"]),
          headTailRequired: true,
        }),
      ]),
    );
    expect(payload.unmatchedFiles).toEqual([]);
  });

  it("fails the stray gate when a changed file has no owner lane", async () => {
    const payload = await runPlan("tmp/unknown-stray-output.txt");

    expect(payload.ok).toBe(false);
    expect(payload.unmatchedFiles).toEqual(["tmp/unknown-stray-output.txt"]);
    expect(payload.strayGate).toEqual(
      expect.objectContaining({
        ok: false,
        rule: "every changed file must match at least one owner lane",
        unmatchedChangedFiles: ["tmp/unknown-stray-output.txt"],
      }),
    );
    expect(payload.strayGate.nextAction).toContain("add an owner rule");
  });

  it("routes explicitly retired logs and audit receipts through cleanup", async () => {
    const payload = await runPlanArgs([
      "--files",
      ".tmp/mixprobe-train.log",
      "docs/lcx-capability-review-20260702.md",
      "ops/dev-full-loop-acceptance/2026-05-06T114336Z.md",
      "ops/paper-learning-audit/2026-05-06T172709Z-paper-learning-internalization-audit.md",
    ]);

    expect(payload.ok).toBe(true);
    expect(payload.unmatchedFiles).toEqual([]);
    expect(payload.affectedLanes).toEqual(["repository_cleanup"]);
    expect(payload.impacts).toEqual([
      expect.objectContaining({
        id: "retired_artifact_cleanup",
        lane: "repository_cleanup",
        matchedFiles: [
          ".tmp/mixprobe-train.log",
          "docs/lcx-capability-review-20260702.md",
          "ops/dev-full-loop-acceptance/2026-05-06T114336Z.md",
          "ops/paper-learning-audit/2026-05-06T172709Z-paper-learning-internalization-audit.md",
        ],
      }),
    ]);
  });

  it("routes Python changes through the TS/Python boundary check", async () => {
    const payload = await runPlanArgs([
      "--files",
      "lobster_orchestrator.py",
      "scripts/branch_freshness.py",
    ]);

    expect(payload.ok).toBe(true);
    expect(payload.unmatchedFiles).toEqual([]);
    expect(payload.affectedLanes).toEqual(["global_doctrine_and_runbook"]);
    expect(payload.impacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "ts_python_boundary",
          lane: "global_doctrine_and_runbook",
          matchedFiles: ["lobster_orchestrator.py", "scripts/branch_freshness.py"],
          requiredChecks: ["ts-python-boundary"],
          commands: ["node --import tsx scripts/operator/lcx-ts-python-boundary.ts --json"],
        }),
      ]),
    );
  });

  it("classifies the external agent upgrade radar as architecture supervision", async () => {
    const payload = await runPlanArgs([
      "--files",
      "scripts/operator/lcx-external-agent-upgrade-radar.ts",
      "scripts/operator/lcx-github-cli-capability-inventory.ts",
      "test/lcx-github-cli-capability-inventory.test.ts",
    ]);

    expect(payload.ok).toBe(true);
    expect(payload.affectedLanes).toEqual(["global_doctrine_and_runbook", "test_surface"]);
    expect(payload.impacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "architecture_supervision_stack",
          lane: "global_doctrine_and_runbook",
          matchedFiles: [
            "scripts/operator/lcx-external-agent-upgrade-radar.ts",
            "scripts/operator/lcx-github-cli-capability-inventory.ts",
            "test/lcx-github-cli-capability-inventory.test.ts",
          ],
        }),
      ]),
    );
  });

  it("classifies SkillOpt-lite SOP training as architecture supervision", async () => {
    const payload = await runPlanArgs([
      "--files",
      "scripts/operator/lcx-skillopt-lite.ts",
      "scripts/operator/lcx-provider-council-acceleration.ts",
      "test/lcx-skillopt-lite.test.ts",
      "test/lcx-provider-council-acceleration.test.ts",
    ]);

    expect(payload.ok).toBe(true);
    expect(payload.unmatchedFiles).toEqual([]);
    expect(payload.affectedLanes).toEqual(["global_doctrine_and_runbook", "test_surface"]);
    expect(payload.impacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "architecture_supervision_stack",
          lane: "global_doctrine_and_runbook",
          matchedFiles: [
            "scripts/operator/lcx-provider-council-acceleration.ts",
            "scripts/operator/lcx-skillopt-lite.ts",
            "test/lcx-provider-council-acceleration.test.ts",
            "test/lcx-skillopt-lite.test.ts",
          ],
          commands: expect.arrayContaining([
            expect.stringContaining("test/lcx-skillopt-lite.test.ts"),
          ]),
        }),
      ]),
    );
  });

  it("classifies the universe index as the global architecture inventory owner", async () => {
    const payload = await runPlanArgs([
      "--files",
      "scripts/operator/lcx-universe-index.ts",
      "test/lcx-universe-index.test.ts",
    ]);

    expect(payload.ok).toBe(true);
    expect(payload.unmatchedFiles).toEqual([]);
    expect(payload.affectedLanes).toEqual(["global_doctrine_and_runbook", "test_surface"]);
    expect(payload.impacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "architecture_supervision_stack",
          lane: "global_doctrine_and_runbook",
          matchedFiles: [
            "scripts/operator/lcx-universe-index.ts",
            "test/lcx-universe-index.test.ts",
          ],
          commands: expect.arrayContaining([
            expect.stringContaining("test/lcx-universe-index.test.ts"),
          ]),
        }),
      ]),
    );
  });

  it("classifies the live fadeout audit as architecture supervision", async () => {
    const payload = await runPlanArgs([
      "--files",
      "scripts/operator/lcx-live-fadeout-audit.ts",
      "test/lcx-live-fadeout-audit.test.ts",
    ]);

    expect(payload.ok).toBe(true);
    expect(payload.unmatchedFiles).toEqual([]);
    expect(payload.affectedLanes).toEqual(["global_doctrine_and_runbook", "test_surface"]);
    expect(payload.impacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "architecture_supervision_stack",
          lane: "global_doctrine_and_runbook",
          matchedFiles: [
            "scripts/operator/lcx-live-fadeout-audit.ts",
            "test/lcx-live-fadeout-audit.test.ts",
          ],
          commands: expect.arrayContaining([
            expect.stringContaining("test/lcx-live-fadeout-audit.test.ts"),
          ]),
        }),
      ]),
    );
  });

  it("treats --files as a batch file flag and routes external-channel work to the local boundary", async () => {
    const payload = await runPlanArgs([
      "--files",
      "scripts/operator/lcx-external-channel-compat.ts",
      "test/lcx-external-channel-compat-status.test.ts",
    ]);

    expect(payload.ok).toBe(true);
    expect(payload.changedFiles).toEqual([
      "scripts/operator/lcx-external-channel-compat.ts",
      "test/lcx-external-channel-compat-status.test.ts",
    ]);
    expect(payload.changedFiles).not.toContain("--files");
    expect(payload.unmatchedFiles).toEqual([]);
    expect(payload.affectedLanes).toEqual(["local_live_boundary", "test_surface"]);
    expect(payload.impacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "live_or_provider_boundary",
          lane: "local_live_boundary",
          matchedFiles: [
            "scripts/operator/lcx-external-channel-compat.ts",
            "test/lcx-external-channel-compat-status.test.ts",
          ],
          commands: expect.arrayContaining([
            "pnpm vitest run test/lcx-external-channel-compat-status.test.ts",
            "node --import tsx scripts/operator/lcx-system-doctor.ts --json",
          ]),
        }),
        expect.objectContaining({
          id: "test_file_changed",
          lane: "test_surface",
          matchedFiles: ["test/lcx-external-channel-compat-status.test.ts"],
        }),
      ]),
    );
  });

  it("routes SkillOpt runtime self-use hooks to the External visible reply lane", async () => {
    const payload = await runPlanArgs([
      "--files",
      "src/auto-reply/reply/get-reply-run.ts",
      "src/auto-reply/reply/skillopt-autocue.ts",
      "src/auto-reply/reply/skillopt-autocue.test.ts",
    ]);

    expect(payload.ok).toBe(true);
    expect(payload.unmatchedFiles).toEqual([]);
    expect(payload.affectedLanes).toEqual(["external_message_visible_reply", "test_surface"]);
    expect(payload.impacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "external_message_visible_surface",
          lane: "external_message_visible_reply",
          matchedFiles: [
            "src/auto-reply/reply/get-reply-run.ts",
            "src/auto-reply/reply/skillopt-autocue.test.ts",
            "src/auto-reply/reply/skillopt-autocue.ts",
          ],
          commands: expect.arrayContaining([
            "pnpm vitest run src/auto-reply/reply/skill-autocue.test.ts src/auto-reply/reply/skillopt-autocue.test.ts",
          ]),
        }),
        expect.objectContaining({
          id: "test_file_changed",
          lane: "test_surface",
          matchedFiles: ["src/auto-reply/reply/skillopt-autocue.test.ts"],
        }),
      ]),
    );
  });

  it("routes commercial visible answer quality owners to the External visible reply lane", async () => {
    const payload = await runPlanArgs([
      "--files",
      "scripts/operator/lcx-commercial-answer-pipeline.ts",
      "scripts/operator/lcx-visible-answer-quality-fuzzer.ts",
      "test/lcx-visible-answer-quality-fuzzer.test.ts",
    ]);

    expect(payload.ok).toBe(true);
    expect(payload.unmatchedFiles).toEqual([]);
    expect(payload.affectedLanes).toEqual(["external_message_visible_reply", "test_surface"]);
    expect(payload.impacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "external_message_visible_surface",
          lane: "external_message_visible_reply",
          matchedFiles: [
            "scripts/operator/lcx-commercial-answer-pipeline.ts",
            "scripts/operator/lcx-visible-answer-quality-fuzzer.ts",
          ],
          commands: expect.arrayContaining([
            "pnpm vitest run src/auto-reply/reply/skill-autocue.test.ts src/auto-reply/reply/skillopt-autocue.test.ts",
          ]),
        }),
        expect.objectContaining({
          id: "test_file_changed",
          lane: "test_surface",
          matchedFiles: ["test/lcx-visible-answer-quality-fuzzer.test.ts"],
        }),
      ]),
    );
  });

  it("routes owner dashboard observability files instead of leaving them unmatched", async () => {
    const payload = await runPlanArgs([
      "--files",
      "apps/web/lcx-agent-farm/index.html",
      "scripts/operator/lcx-farm-web-server.ts",
      "scripts/operator/lcx-owner-control-map.ts",
      "scripts/operator/lcx-real-cost-ledger.ts",
      "test/lcx-owner-control-map.test.ts",
      "test/lcx-real-cost-ledger.test.ts",
      "tmp-lcx-owner-dashboard.png",
    ]);

    expect(payload.ok).toBe(true);
    expect(payload.unmatchedFiles).toEqual([]);
    expect(payload.affectedLanes).toEqual(["local_automation", "test_surface"]);
    expect(payload.impacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "owner_control_room_surface",
          lane: "local_automation",
          matchedFiles: [
            "apps/web/lcx-agent-farm/index.html",
            "scripts/operator/lcx-farm-web-server.ts",
            "scripts/operator/lcx-owner-control-map.ts",
            "scripts/operator/lcx-real-cost-ledger.ts",
            "test/lcx-owner-control-map.test.ts",
            "test/lcx-real-cost-ledger.test.ts",
            "tmp-lcx-owner-dashboard.png",
          ],
          safetyNotes: expect.arrayContaining([
            expect.stringContaining("screenshots should be deleted or explicitly kept"),
          ]),
        }),
      ]),
    );
  });

  it("routes local ignore hygiene through the runbook lane", async () => {
    const payload = await runPlan(".gitignore");

    expect(payload.ok).toBe(true);
    expect(payload.unmatchedFiles).toEqual([]);
    expect(payload.affectedLanes).toEqual(["global_doctrine_and_runbook"]);
    expect(payload.impacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "doctrine_or_runbook",
          lane: "global_doctrine_and_runbook",
          matchedFiles: [".gitignore"],
        }),
      ]),
    );
  });

  it("routes the split thread-binding state owner through persisted-state recovery checks", async () => {
    const payload = await runPlanArgs(["--files", "src/discord/monitor/thread-bindings.state.ts"]);
    expect(payload.ok).toBe(true);
    expect(payload.unmatchedFiles).toEqual([]);
    expect(payload.impacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "persisted_state_read_contract",
          lane: "agent_workflow_memory",
          matchedFiles: ["src/discord/monitor/thread-bindings.state.ts"],
          commands: expect.arrayContaining([
            "pnpm vitest run src/discord/monitor/thread-bindings.corrupt-guard.test.ts src/discord/monitor/thread-bindings.state.identity-migration.test.ts",
          ]),
        }),
      ]),
    );
  });

  it("routes ontology and current operator-support changes to their existing owners", async () => {
    const payload = await runPlanArgs([
      "--files",
      "scripts/operator/lcx-ontology.ts",
      "src/shared/lcx-ontology.ts",
      "src/shared/global-evidence-projection-read.ts",
      "src/hooks/bundled/lobster-brain-registry.ts",
      "scripts/operator/lcx-projection-reader-audit.ts",
      "src/daemon/inspect.ts",
      "docs/help/testing.md",
      "docs/tools/lcx-system-doctor.md",
      "evals/local-brain/promptfoo.yaml",
      "src/agents/finance-answer-composer.ts",
      "src/agents/finance-live-market-source.ts",
      "src/hooks/bundled/operating-loop/handler.ts",
    ]);

    expect(payload.ok).toBe(true);
    expect(payload.unmatchedFiles).toEqual([]);
    expect(payload.affectedLanes).toEqual([
      "global_doctrine_and_runbook",
      "qwen_training_or_local_brain",
      "agent_workflow_memory",
      "local_automation",
      "local_live_boundary",
    ]);
  });

  it("routes the external sidecar runtime bundle to the live-boundary owner", async () => {
    const payload = await runPlanArgs([
      "--files",
      "scripts/operator/external-channel-sidecar-runtime-bundle.ts",
    ]);

    expect(payload.ok).toBe(true);
    expect(payload.unmatchedFiles).toEqual([]);
    expect(payload.affectedLanes).toEqual(["local_live_boundary"]);
  });
});

it("keeps scheduler lifecycle owners and verification on the finance unattended lane", async () => {
  const files = [
    "src/agents/finance-scheduler-process.ts",
    "src/agents/finance-scheduler-lock.ts",
    "src/agents/finance-scheduler-state.ts",
    "test/operator/lcx-finance-scheduler-lifecycle.test.ts",
    "docs/tools/finance-scheduler.md",
  ];
  const result = await runPlanArgs(files.flatMap((file) => ["--changed", file]));
  const impact = result.impacts.find((entry) => entry.id === "finance_unattended_cycle");
  expect(impact?.matchedFiles).toEqual(expect.arrayContaining(files));
  expect(impact?.commands.join(" ")).toContain("lcx-finance-scheduler-lifecycle.test.ts");
  expect(result.unmatchedFiles).toEqual([]);
});

it("routes finance health and lifecycle feedback to their owning finance lanes", async () => {
  const healthCli = "scripts/operator/lcx-finance-link-health.ts";
  const lifecycleFeedback = "src/agents/finance-automatic-lifecycle-feedback.ts";
  const result = await runPlanArgs(["--changed", healthCli, "--changed", lifecycleFeedback]);

  expect(
    result.impacts.find((entry) => entry.id === "finance_live_execution_seam")?.matchedFiles,
  ).toContain(healthCli);
  expect(
    result.impacts.find((entry) => entry.id === "finance_unattended_cycle")?.matchedFiles,
  ).toContain(lifecycleFeedback);
  expect(result.unmatchedFiles).toEqual([]);
});

it("routes the model-facing composition entry to the canonical research regression checks", async () => {
  const result = await runPlanArgs([
    "--changed",
    "src/agents/tools/finance-research-run-tool.ts",
    "--changed",
    "docs/tools/finance-research-composition.md",
  ]);
  const impact = result.impacts.find((entry) => entry.id === "finance_caseflow");
  expect(impact?.matchedFiles).toEqual(
    expect.arrayContaining([
      "src/agents/tools/finance-research-run-tool.ts",
      "docs/tools/finance-research-composition.md",
    ]),
  );
  expect(impact?.commands.join(" ")).toContain("finance-brain-orchestration.test.ts");
  expect(result.unmatchedFiles).toEqual([]);
});

it("owns the intraday execution bridge and requires its focused controller regression", async () => {
  const files = [
    "src/agents/finance-intraday-execution.ts",
    "src/agents/finance-intraday-execution.test.ts",
    "src/agents/finance-intraday-control-ledger.ts",
    "src/agents/finance-intraday-control-ledger.test.ts",
  ];
  const result = await runPlanArgs(["--files", ...files]);
  expect(result.ok).toBe(true);
  expect(result.unmatchedFiles).toEqual([]);
  const impact = result.impacts.find((entry) => entry.id === "finance_unattended_cycle");
  expect(impact?.matchedFiles).toEqual(files.toSorted());
  expect(impact?.requiredChecks).toContain("head-tail-consistency");
  expect(impact?.commands).toContain(
    "pnpm vitest run src/agents/finance-intraday-execution.test.ts src/agents/finance-alpaca-cycle-controller.test.ts",
  );
});

it("keeps the order intent compiler and its test under the original unattended owner", async () => {
  const files = [
    "src/agents/finance-intent-compiler.ts",
    "src/agents/finance-intent-compiler.test.ts",
  ];
  const result = await runPlanArgs(["--files", ...files]);
  expect(result.ok).toBe(true);
  expect(result.unmatchedFiles).toEqual([]);
  const impact = result.impacts.find((entry) => entry.id === "finance_unattended_cycle");
  expect(impact?.matchedFiles).toEqual(files.toSorted());
  expect(impact?.commands).toContain(
    "pnpm vitest run src/agents/finance-intent-compiler.test.ts src/agents/finance-alpaca-run.test.ts",
  );
});

it("keeps trade review, evidence and result recall on the original unattended owner", async () => {
  const files = ["decision-review", "review-evidence", "result-recall"].flatMap((name) => [
    `src/agents/finance-trade-${name}.ts`,
    `src/agents/finance-trade-${name}.test.ts`,
  ]);
  const result = await runPlanArgs(["--files", ...files]);
  expect(result.ok).toBe(true);
  expect(result.unmatchedFiles).toEqual([]);
  const impact = result.impacts.find((entry) => entry.id === "finance_unattended_cycle");
  expect(impact?.matchedFiles).toEqual(files.toSorted());
  expect(impact?.requiredChecks).toContain("head-tail-consistency");
  expect(impact?.commands).toContain(
    "pnpm vitest run src/agents/finance-trade-decision-review.test.ts src/agents/finance-trade-review-evidence.test.ts src/agents/finance-trade-result-recall.test.ts",
  );
});

it("keeps intraday rule/replay and original economics consumers visible in recovery", async () => {
  const files = [
    "scripts/operator/lcx-finance-intraday-paper.ts",
    "scripts/operator/lcx-finance-trade-economics-eval.ts",
    "src/agents/finance-intraday-paper.ts",
    "src/agents/finance-intraday-paper.test.ts",
  ];
  const result = await runPlanArgs(["--files", ...files]);
  expect(result.ok).toBe(true);
  expect(result.unmatchedFiles).toEqual([]);
  const impact = result.impacts.find((entry) => entry.id === "finance_unattended_cycle");
  expect(impact?.matchedFiles).toEqual(files.toSorted());
  expect(impact?.commands).toContain(
    "pnpm vitest run src/agents/finance-intraday-paper.test.ts src/agents/finance-trade-economics.test.ts test/operator/lcx-finance-trade-economics-eval.test.ts",
  );
  expect(impact?.requiredChecks).toContain("head-tail-consistency");
});

it("does not absorb a similarly named unknown finance operator into a known owner", async () => {
  const result = await runPlan("scripts/operator/lcx-finance-intraday-paper-unknown.ts");
  expect(result.ok).toBe(false);
  expect(result.unmatchedFiles).toEqual(["scripts/operator/lcx-finance-intraday-paper-unknown.ts"]);
});

it("owns the fifteen natural Universe coverage gaps while retaining unknown-path refusal", async () => {
  // Exact paths retained from the natural Universe receipt of 2026-10-12T23:34:18.983Z.
  const owners = {
    finance_caseflow: [
      "src/agents/finance-additional-source-adapters.ts",
      "src/agents/finance-module-composition.ts",
      "src/agents/finance-module-execution.ts",
      "src/agents/finance-outcome-backfill.ts",
      "src/agents/finance-research-portfolio-plan.ts",
    ],
    module_learning_memory: [
      "src/agents/module-learning-application-review.ts",
      "src/agents/self-repair-candidate-review.ts",
      "src/agents/self-repair-owner-map-feedback.ts",
    ],
    system_prompt_or_agent_tools: [
      "src/agents/artifact-result-recording.ts",
      "src/agents/pi-tools.ts",
    ],
    external_message_visible_surface: [
      "src/agents/commercial-answer-reply-gate.ts",
      "src/agents/provider-learning-council.ts",
      "src/auto-reply/reply/agent-runner-execution.ts",
      "src/auto-reply/reply/queue/types.ts",
    ],
    architecture_supervision_stack: ["test/fixtures/lcx-universe-deadline-probe.ts"],
  };
  const files = Object.values(owners).flat();
  expect(files).toHaveLength(15);
  const result = await runPlanArgs(["--files", ...files]);
  expect(result.ok).toBe(true);
  expect(result.unmatchedFiles).toEqual([]);
  for (const [id, paths] of Object.entries(owners)) {
    const impact = result.impacts.find((entry) => entry.id === id);
    expect(impact?.matchedFiles).toEqual(expect.arrayContaining(paths));
    expect(impact?.requiredChecks.length).toBeGreaterThan(0);
  }
  expect(result.recommendedFastCommands.join("\n")).toContain("finance-module-execution.test.ts");
  expect(result.recommendedFastCommands.join("\n")).toContain("artifact-result-recording.test.ts");
  expect(result.recommendedFastCommands.join("\n")).toContain(
    "lcx-universe-index-deadline.test.ts",
  );
  expect(
    result.impacts.find((entry) => entry.id === "live_or_provider_boundary")?.matchedFiles,
  ).toContain("src/agents/provider-learning-council.ts");

  const unknown = [
    "src/agents/finance-unowned-future-source.ts",
    "src/agents/self-repair-unowned-future.ts",
    "src/auto-reply/reply/queue/unowned-future.ts",
    "test/fixtures/lcx-universe-unowned-future.ts",
  ];
  const refused = await runPlanArgs(["--files", ...unknown]);
  expect(refused.ok).toBe(false);
  expect(refused.unmatchedFiles).toEqual(unknown.toSorted());
  expect(refused.strayGate.ok).toBe(false);
});

it("routes recovered finance sources to original owners and concrete regressions", async () => {
  const cycleFiles = [
    "src/agents/finance-alpaca-activity-contract.ts",
    "src/agents/finance-alpaca-history-reconciliation.ts",
    "src/agents/finance-alpaca-safety-transport.ts",
    "src/agents/finance-broker-profit-feedback.ts",
    "src/agents/finance-intraday-ledger.ts",
    "src/agents/finance-owned-protection-exits.ts",
    "src/agents/finance-trade-economics.ts",
    "src/agents/finance-tuning-lifecycle.ts",
  ];
  const researchFile = "src/agents/finance-module-producer-input.ts";
  const result = await runPlanArgs(["--files", ...cycleFiles, researchFile]);
  expect(result.unmatchedFiles).toEqual([]);
  const cycle = result.impacts.find((entry) => entry.id === "finance_unattended_cycle");
  expect(cycle?.matchedFiles).toEqual(cycleFiles.toSorted());
  expect(cycle?.requiredChecks).toContain("head-tail-consistency");
  for (const test of [
    "finance-alpaca-history-reconciliation.test.ts",
    "finance-alpaca-safety-transport.test.ts",
    "finance-broker-profit-feedback.test.ts",
    "finance-intraday-ledger.test.ts",
    "finance-owned-protection-exits.test.ts",
    "finance-trade-economics.test.ts",
    "finance-tuning-lifecycle.test.ts",
  ]) {
    expect(cycle?.commands.join(" ")).toContain(test);
  }
  const research = result.impacts.find((entry) => entry.id === "finance_caseflow");
  expect(research?.matchedFiles).toContain(researchFile);
  expect(research?.commands.join(" ")).toContain("finance-module-producer-input.test.ts");
});

it("routes Deribit data and its quota policy through original finance owners", async () => {
  const result = await runPlanArgs([
    "--files",
    "src/agents/finance-deribit-collection.ts",
    "src/agents/finance-deribit-collection.test.ts",
    "src/agents/finance-source-quota-policy.ts",
  ]);
  expect(result.unmatchedFiles).toEqual([]);
  expect(
    result.impacts.find((entry) => entry.id === "finance_caseflow")?.commands.join(" "),
  ).toContain("finance-deribit-collection.test.ts");
  expect(
    result.impacts.find((entry) => entry.id === "finance_state_plane")?.matchedFiles,
  ).toContain("src/agents/finance-source-quota-policy.ts");
});
