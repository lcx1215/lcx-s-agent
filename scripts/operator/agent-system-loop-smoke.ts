import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseJsonObjectFromOutput } from "./smoke-json-output.ts";

type CommandCheck = {
  name: string;
  args: string[];
  parseJson?: boolean;
  assert?: (payload: Record<string, unknown>) => void;
  skipOnRollupFailure?: boolean;
};

type CommandResult = {
  name: string;
  ok: boolean;
  skipped: boolean;
  durationMs: number;
  summary: Record<string, unknown>;
};

type CommandFailure = Error & {
  stdout?: string;
  stderr?: string;
};

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function record(value: unknown, label: string): Record<string, unknown> {
  assert(value && typeof value === "object" && !Array.isArray(value), `${label} must be object`);
  return value as Record<string, unknown>;
}

function array(value: unknown, label: string): unknown[] {
  assert(Array.isArray(value), `${label} must be array`);
  return value;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKTREE_DIR = path.resolve(__dirname, "../..");
const VITEST_LOCAL_CLI = path.join(WORKTREE_DIR, "node_modules", "vitest", "vitest.mjs");

function stringValue(value: unknown, label: string): string {
  assert(typeof value === "string" && value.length > 0, `${label} must be non-empty string`);
  return value;
}

function booleanValue(value: unknown, label: string): boolean {
  assert(typeof value === "boolean", `${label} must be boolean`);
  return value;
}

function numberValue(value: unknown, label: string): number {
  assert(typeof value === "number" && Number.isFinite(value), `${label} must be finite number`);
  return value;
}

function caseResult(cases: unknown[], name: string): Record<string, unknown> {
  const match = cases
    .map((entry) => record(entry, "case result"))
    .find((entry) => entry.case === name);
  assert(match, `finance pipeline missing case ${name}`);
  return match;
}

function parseJsonOutput(stdout: string): Record<string, unknown> {
  return record(parseJsonObjectFromOutput(stdout), "json output");
}

function isExecutableMissingError(error: unknown): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT";
}

function isRollupBootstrapFailure(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const output = `${error.message}\n${(error as CommandFailure).stdout ?? ""}\n${(error as CommandFailure).stderr ?? ""}`;
  return /@rollup\/rollup-darwin-arm64|Cannot find module @rollup|ERR_DLOPEN_FAILED/.test(output);
}

function commandCandidates(check: CommandCheck): { command: string; args: string[] }[] {
  const [runner, ...rest] = check.args;
  if (runner !== "exec" || rest.length < 2) {
    return [{ command: "pnpm", args: check.args }];
  }

  const [runnerTool, ...toolArgs] = rest;
  if (runnerTool === "tsx") {
    return [
      { command: "pnpm", args: check.args },
      { command: "node", args: ["--import", "tsx", ...toolArgs] },
    ];
  }

  if (runnerTool === "vitest") {
    const candidates: { command: string; args: string[] }[] = [
      { command: "pnpm", args: check.args },
    ];
    if (existsSync(VITEST_LOCAL_CLI)) {
      candidates.push({ command: "node", args: [VITEST_LOCAL_CLI, ...toolArgs] });
    }
    return candidates;
  }

  return [{ command: "pnpm", args: check.args }];
}

function runCommandOnce(
  check: CommandCheck,
  commandSpec: { command: string; args: string[] },
  startedAt: number,
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(commandSpec.command, commandSpec.args, {
      cwd: WORKTREE_DIR,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      reject(error);
    });
    child.on("close", (code) => {
      const durationMs = Date.now() - startedAt;
      if (code !== 0) {
        const err = new Error(
          `${check.name} failed with exit code ${code}\nCommand: ${commandSpec.command} ${commandSpec.args.join(" ")}\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`,
        ) as CommandFailure;
        err.code = code;
        err.stdout = stdout;
        err.stderr = stderr;
        reject(err);
        return;
      }
      const payload = check.parseJson
        ? parseJsonOutput(stdout)
        : { stdoutTail: stdout.slice(-500) };
      check.assert?.(payload);
      resolve({
        name: check.name,
        ok: true,
        skipped: false,
        durationMs,
        summary: summarize(check.name, payload),
      });
    });
  });
}

async function runCommand(check: CommandCheck): Promise<CommandResult> {
  const startedAt = Date.now();
  const candidates = commandCandidates(check);
  let lastError: unknown;
  const candidatesDesc = commandCandidates(check)
    .map((candidate) => `${candidate.command} ${candidate.args.join(" ")}`)
    .join(" | ");

  for (const commandSpec of candidates) {
    try {
      return await runCommandOnce(check, commandSpec, startedAt);
    } catch (error) {
      if (commandSpec.command === "pnpm" && isExecutableMissingError(error)) {
        lastError = error;
        continue;
      }
      if (commandSpec.command === "pnpm" && isRollupBootstrapFailure(error)) {
        lastError = error;
        continue;
      }
      if (check.skipOnRollupFailure && isRollupBootstrapFailure(error)) {
        return {
          name: check.name,
          ok: false,
          skipped: true,
          durationMs: Date.now() - startedAt,
          summary: {
            skipped: true,
            skippedReason: "rollup_bootstrap_failure",
            skippedRunner: `${commandSpec.command} ${commandSpec.args.join(" ")}`,
            rawError: (error as Error).message,
          },
        };
      }
      throw error;
    }
  }

  const errorMessage = `All command runners failed for ${check.name}: ${commandCandidates(check)
    .map((candidate) => `${candidate.command} ${candidate.args.join(" ")}`)
    .join(" | ")}`;
  if (lastError instanceof Error) {
    if (check.skipOnRollupFailure && isRollupBootstrapFailure(lastError)) {
      return {
        name: check.name,
        ok: false,
        skipped: true,
        durationMs: Date.now() - startedAt,
        summary: {
          skipped: true,
          skippedReason: "rollup_bootstrap_failure_all_runners",
          candidates: candidatesDesc,
          rawError: lastError.message,
        },
      };
    }
    throw new Error(`${errorMessage}\n${String(lastError.message)}`);
  }
  throw new Error(errorMessage);
}

function summarize(name: string, payload: Record<string, unknown>): Record<string, unknown> {
  if (name === "finance-pipeline-all") {
    const cases = array(payload.cases, "cases");
    return {
      cases: cases.length,
      workspaceDir: payload.workspaceDir,
    };
  }
  if (name === "finance-multi-candidate") {
    return {
      candidateCount: payload.candidateCount,
      synthesisMode: payload.synthesisMode,
      applicationMode: payload.applicationMode,
    };
  }
  if (name === "finance-event-review") {
    const draft = record(payload.eventReviewDraft, "eventReviewDraft");
    return {
      candidateCount: payload.candidateCount,
      synthesisMode: payload.synthesisMode,
      eventReviewStatus: draft.status,
      missingInputs: draft.missingInputs,
      missingEvidenceCategories: draft.missingEvidenceCategories,
      noActionBoundary: draft.noActionBoundary,
    };
  }
  return {
    status: "passed",
  };
}

const checks: CommandCheck[] = [
  {
    name: "finance-pipeline-all",
    args: ["exec", "tsx", "scripts/operator/finance-learning-pipeline-smoke.ts", "--case", "all"],
    parseJson: true,
    assert: (payload) => {
      assert(payload.ok === true, "finance pipeline all should be ok");
      const cases = array(payload.cases, "cases");
      assert(cases.length >= 11, "finance pipeline should run all expected cases");
      const caseNames = new Set(
        cases.map((entry) => stringValue(record(entry, "case result").case, "case")),
      );
      for (const required of [
        "external-market-capability-intake",
        "external-market-capability-missing-source",
        "external-market-capability-extraction-gap",
        "capability-apply",
        "capability-apply-unmatched",
        "blocked",
      ]) {
        assert(caseNames.has(required), `finance pipeline missing case ${required}`);
      }
      const intake = caseResult(cases, "external-market-capability-intake");
      assert(
        stringValue(intake.agentVisibleLearningLine, "intake.agentVisibleLearningLine").includes(
          "learningInternalizationStatus=application_ready",
        ),
        "successful external learning case should expose application_ready",
      );
      const missingSource = caseResult(cases, "external-market-capability-missing-source");
      assert(
        stringValue(
          missingSource.agentVisibleLearningLine,
          "missingSource.agentVisibleLearningLine",
        ).includes("failedReason=safe_local_or_manual_source_required"),
        "missing source case should expose safe-source failedReason",
      );
      const extractionGap = caseResult(cases, "external-market-capability-extraction-gap");
      assert(
        stringValue(
          extractionGap.agentVisibleLearningLine,
          "extractionGap.agentVisibleLearningLine",
        ).includes("failedReason=finance_article_extraction_gap"),
        "extraction gap case should expose extraction failedReason",
      );
      const capabilityApply = caseResult(cases, "capability-apply");
      assert(
        capabilityApply.applicationStatus === "application_ready",
        "capability apply should expose application_ready",
      );
      assert(
        capabilityApply.usableAnswerContractStatus === "usable_after_fresh_inputs_are_checked",
        "capability apply should expose a usable answer contract",
      );
      const unmatchedApply = caseResult(cases, "capability-apply-unmatched");
      assert(
        unmatchedApply.applicationStatus === "not_application_ready",
        "unmatched apply should expose not_application_ready",
      );
      assert(
        unmatchedApply.failedReason === "no_retrievable_finance_capability",
        "unmatched apply should expose concrete failedReason",
      );
    },
  },
  {
    name: "finance-multi-candidate",
    args: ["exec", "tsx", "scripts/operator/finance-learning-multi-candidate-smoke.ts"],
    parseJson: true,
    assert: (payload) => {
      assert(payload.ok === true, "multi candidate smoke should be ok");
      assert(numberValue(payload.candidateCount, "candidateCount") >= 3, "needs >=3 candidates");
      assert(payload.synthesisMode === "multi_capability_synthesis", "needs synthesis mode");
    },
  },
  {
    name: "finance-event-review",
    args: ["exec", "tsx", "scripts/operator/finance-learning-event-review-smoke.ts"],
    parseJson: true,
    assert: (payload) => {
      assert(payload.ok === true, "event review smoke should be ok");
      const draft = record(payload.eventReviewDraft, "eventReviewDraft");
      assert(draft.status === "research_review_ready", "event review should be ready");
      assert(array(draft.missingInputs, "missingInputs").length === 0, "no missing inputs");
      assert(
        array(draft.missingEvidenceCategories, "missingEvidenceCategories").length === 0,
        "no missing evidence categories",
      );
      assert(booleanValue(draft.noActionBoundary, "noActionBoundary"), "no-action boundary");
    },
  },
  {
    name: "external-message-channel-contract-tests",
    args: [
      "exec",
      "vitest",
      "run",
      "extensions/external/src/accounts.test.ts",
      "extensions/external/src/monitor.test.ts",
      "extensions/external/src/protocol.test.ts",
      "extensions/external/src/security.test.ts",
      "extensions/external/src/send.test.ts",
    ],
    skipOnRollupFailure: true,
  },
];

export function evaluateAgentSystemLoop(
  results: readonly Pick<CommandResult, "ok" | "skipped">[],
): {
  ok: boolean;
  status: "passed" | "blocked" | "failed";
  skippedCheckCount: number;
  failedCheckCount: number;
} {
  const skippedCheckCount = results.filter((result) => result.skipped).length;
  const failedCheckCount = results.filter((result) => !result.ok).length;
  const ok = results.length > 0 && results.every((result) => result.ok && !result.skipped);
  return {
    ok,
    status: ok ? "passed" : skippedCheckCount > 0 ? "blocked" : "failed",
    skippedCheckCount,
    failedCheckCount,
  };
}

async function main(): Promise<void> {
  const results: CommandResult[] = [];
  for (const check of checks) {
    results.push(await runCommand(check));
  }
  const evaluation = evaluateAgentSystemLoop(results);

  process.stdout.write(
    `${JSON.stringify(
      {
        ...evaluation,
        scope: "local_full_system_external_message_finance_memory_loop",
        checks: results,
        liveTouched: false,
        providerConfigTouched: false,
        protectedMemoryTouched: false,
        remoteFetchOccurred: false,
        executionAuthorityGranted: false,
        summary:
          evaluation.status === "passed"
            ? "Full local loop passed: external message channel contract, finance learning intake, multi-capability brain synthesis, fresh event analysis, receipt memory, and fail-closed cases."
            : evaluation.status === "blocked"
              ? `Full local loop blocked: ${evaluation.skippedCheckCount} required check(s) were skipped and need a successful fallback.`
              : `Full local loop failed: ${evaluation.failedCheckCount} required check(s) failed.`,
      },
      null,
      2,
    )}\n`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
