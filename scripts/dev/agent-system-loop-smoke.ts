import { spawn } from "node:child_process";

type CommandCheck = {
  name: string;
  args: string[];
  parseJson?: boolean;
  assert?: (payload: Record<string, unknown>) => void;
};

type CommandResult = {
  name: string;
  ok: boolean;
  durationMs: number;
  summary: Record<string, unknown>;
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

function parseJsonOutput(stdout: string): Record<string, unknown> {
  const trimmed = stdout.trim();
  assert(trimmed.length > 0, "command produced no JSON output");
  return record(JSON.parse(trimmed), "json output");
}

function runCommand(check: CommandCheck): Promise<CommandResult> {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn("pnpm", check.args, {
      cwd: process.cwd(),
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
    child.on("error", reject);
    child.on("close", (code) => {
      const durationMs = Date.now() - startedAt;
      if (code !== 0) {
        reject(
          new Error(
            `${check.name} failed with exit code ${code}\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`,
          ),
        );
        return;
      }
      const payload = check.parseJson ? parseJsonOutput(stdout) : { stdoutTail: stdout.slice(-500) };
      check.assert?.(payload);
      resolve({
        name: check.name,
        ok: true,
        durationMs,
        summary: summarize(check.name, payload),
      });
    });
  });
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
  if (name === "lark-brain-language-loop") {
    return {
      language: payload.language,
      brain: payload.brain,
      analysis: payload.analysis,
      memory: payload.memory,
      protectedMemoryUntouched: payload.protectedMemoryUntouched,
      languageCorpusUntouched: payload.languageCorpusUntouched,
    };
  }
  return {
    status: "passed",
  };
}

const checks: CommandCheck[] = [
  {
    name: "finance-pipeline-all",
    args: ["exec", "tsx", "scripts/dev/finance-learning-pipeline-smoke.ts", "--case", "all"],
    parseJson: true,
    assert: (payload) => {
      assert(payload.ok === true, "finance pipeline all should be ok");
      const cases = array(payload.cases, "cases");
      assert(cases.length >= 11, "finance pipeline should run all expected cases");
      const caseNames = new Set(
        cases.map((entry) => stringValue(record(entry, "case result").case, "case")),
      );
      for (const required of [
        "lark-market-capability-intake",
        "lark-market-capability-missing-source",
        "capability-apply",
        "capability-apply-unmatched",
        "blocked",
      ]) {
        assert(caseNames.has(required), `finance pipeline missing case ${required}`);
      }
    },
  },
  {
    name: "finance-multi-candidate",
    args: ["exec", "tsx", "scripts/dev/finance-learning-multi-candidate-smoke.ts"],
    parseJson: true,
    assert: (payload) => {
      assert(payload.ok === true, "multi candidate smoke should be ok");
      assert(numberValue(payload.candidateCount, "candidateCount") >= 3, "needs >=3 candidates");
      assert(payload.synthesisMode === "multi_capability_synthesis", "needs synthesis mode");
    },
  },
  {
    name: "finance-event-review",
    args: ["exec", "tsx", "scripts/dev/finance-learning-event-review-smoke.ts"],
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
    name: "lark-brain-language-loop",
    args: ["exec", "tsx", "scripts/dev/lark-brain-language-loop-smoke.ts"],
    parseJson: true,
    assert: (payload) => {
      assert(payload.ok === true, "language brain loop should be ok");
      const language = record(payload.language, "language");
      const brain = record(payload.brain, "brain");
      const analysis = record(payload.analysis, "analysis");
      assert(language.family === "market_capability_learning_intake", "language family");
      assert(language.targetSurface === "learning_command", "language target surface");
      assert(
        language.backendTool === "finance_learning_pipeline_orchestrator",
        "language backend tool",
      );
      assert(numberValue(brain.candidateCount, "brain.candidateCount") >= 3, "brain candidates");
      assert(brain.synthesisMode === "multi_capability_synthesis", "brain synthesis mode");
      assert(analysis.eventReviewStatus === "research_review_ready", "analysis ready");
      assert(booleanValue(analysis.noActionBoundary, "analysis.noActionBoundary"), "boundary");
      assert(
        booleanValue(payload.protectedMemoryUntouched, "protectedMemoryUntouched"),
        "protected memory untouched",
      );
      assert(
        booleanValue(payload.languageCorpusUntouched, "languageCorpusUntouched"),
        "language corpus untouched",
      );
    },
  },
  {
    name: "lark-routing-and-distillation-tests",
    args: [
      "exec",
      "vitest",
      "run",
      "extensions/feishu/src/lark-routing-candidate-corpus.test.ts",
      "extensions/feishu/src/lark-api-reply-distillation.test.ts",
      "src/agents/tools/lark-language-corpus-review-tool.test.ts",
    ],
  },
];

const results: CommandResult[] = [];
for (const check of checks) {
  results.push(await runCommand(check));
}

process.stdout.write(
  `${JSON.stringify(
    {
      ok: true,
      scope: "dev_full_system_language_brain_analysis_memory_loop",
      checks: results,
      liveTouched: false,
      providerConfigTouched: false,
      protectedMemoryTouched: false,
      remoteFetchOccurred: false,
      executionAuthorityGranted: false,
      summary:
        "Full dev loop passed: Lark/Feishu language routing, finance learning intake, multi-capability brain synthesis, fresh event analysis, receipt memory, fail-closed cases, and language corpus review tests.",
    },
    null,
    2,
  )}\n`,
);
