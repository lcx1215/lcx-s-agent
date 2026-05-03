import { spawn } from "node:child_process";
import { parseJsonObjectFromOutput } from "./smoke-json-output.ts";

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
      const payload = check.parseJson
        ? parseJsonOutput(stdout)
        : { stdoutTail: stdout.slice(-500) };
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
  if (name === "lark-adversarial-workflow") {
    const cases = array(payload.cases, "cases");
    return {
      cases: cases.length,
      financeOrchestrationCases: cases.filter(
        (entry) => record(entry, "adversarial case").hasFinanceOrchestration === true,
      ).length,
      financeNoticeCases: cases.filter(
        (entry) => record(entry, "adversarial case").financeNoticeReady === true,
      ).length,
    };
  }
  if (name === "lark-routing-family-score-cli") {
    return {
      total: payload.total,
      deterministicPassRate: payload.deterministicPassRate,
      semanticPassRate: payload.semanticPassRate,
      stableFamilies: payload.stableFamilies,
      weakFamilies: payload.weakFamilies,
    };
  }
  if (name === "lark-language-corpus-review-cli") {
    return {
      mode: payload.mode,
      sourceRoot: payload.sourceRoot,
      counts: payload.counts,
      skippedCounts: payload.skippedCounts,
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
        "lark-market-capability-extraction-gap",
        "capability-apply",
        "capability-apply-unmatched",
        "blocked",
      ]) {
        assert(caseNames.has(required), `finance pipeline missing case ${required}`);
      }
      const intake = caseResult(cases, "lark-market-capability-intake");
      assert(
        stringValue(intake.agentVisibleLearningLine, "intake.agentVisibleLearningLine").includes(
          "learningInternalizationStatus=application_ready",
        ),
        "successful Lark learning case should expose application_ready",
      );
      const missingSource = caseResult(cases, "lark-market-capability-missing-source");
      assert(
        stringValue(
          missingSource.agentVisibleLearningLine,
          "missingSource.agentVisibleLearningLine",
        ).includes("failedReason=safe_local_or_manual_source_required"),
        "missing source case should expose safe-source failedReason",
      );
      const extractionGap = caseResult(cases, "lark-market-capability-extraction-gap");
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
    name: "lark-adversarial-workflow",
    args: ["exec", "tsx", "scripts/dev/lark-adversarial-workflow-smoke.ts"],
    parseJson: true,
    assert: (payload) => {
      assert(payload.ok === true, "adversarial Lark workflow smoke should be ok");
      const cases = array(payload.cases, "cases");
      assert(cases.length >= 7, "adversarial smoke should cover real-world utterance families");
      const byName = new Map(
        cases.map((entry) => {
          const item = record(entry, "adversarial case");
          return [stringValue(item.name, "case.name"), item] as const;
        }),
      );
      const marketMath = record(byName.get("market-math-index"), "market-math-index");
      assert(
        array(marketMath.primaryModules, "marketMath.primaryModules").includes("quant_math"),
        "market math should require quant_math",
      );
      assert(
        booleanValue(marketMath.financeNoticeReady, "marketMath.financeNoticeReady"),
        "market math should expose finance notice to agent prompt",
      );
      const audit = record(byName.get("audit-no-relearn"), "audit-no-relearn");
      assert(
        audit.hasFinanceOrchestration === false,
        "learning audit identifiers should not trigger finance modules",
      );
      const execution = record(
        byName.get("execution-order-research-boundary"),
        "execution-order-research-boundary",
      );
      assert(
        booleanValue(execution.noExecutionApproval, "execution.noExecutionApproval"),
        "execution-like wording must retain no-execution approval boundary",
      );
      const source = record(byName.get("source-grounding-complaint"), "source-grounding-complaint");
      assert(source.targetSurface === "ops_audit", "source complaint should route to ops audit");
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
  {
    name: "lark-routing-family-score-cli",
    args: ["exec", "tsx", "scripts/dev/lark-routing-family-score.ts", "--json"],
    parseJson: true,
    assert: (payload) => {
      assert(payload.total === 72, "routing family score should cover supervised corpus");
      assert(payload.deterministicPassRate === 1, "deterministic family score should pass");
      assert(payload.semanticPassRate === 1, "semantic family score should pass");
      assert(numberValue(payload.stableFamilies, "stableFamilies") >= 20, "stable families");
      assert(payload.weakFamilies === 0, "no weak routing families expected");
      assert(array(payload.families, "families").length >= 20, "family list should be present");
    },
  },
  {
    name: "lark-language-corpus-review-cli",
    args: [
      "exec",
      "tsx",
      "scripts/dev/lark-language-corpus-review.ts",
      "--date",
      "2099-01-01",
      "--json",
    ],
    parseJson: true,
    assert: (payload) => {
      assert(payload.ok === true, "language corpus review CLI should be ok");
      assert(payload.boundary === "language_routing_only", "language corpus boundary");
      assert(payload.mode === "dry-run", "language corpus CLI should default to dry-run");
      const counts = record(payload.counts, "counts");
      assert(counts.sourceArtifacts === 0, "empty queue should have no source artifacts");
      assert(counts.promotedCases === 0, "empty queue should promote no cases");
      assert(array(payload.skipped, "skipped").length === 0, "missing dir is an empty queue");
    },
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
        "Full dev loop passed: Lark/Feishu language routing, finance learning intake, multi-capability brain synthesis, fresh event analysis, receipt memory, fail-closed cases, family scoring CLI, and language corpus review CLI.",
    },
    null,
    2,
  )}\n`,
);
