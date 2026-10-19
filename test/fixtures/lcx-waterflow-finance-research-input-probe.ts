import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";
import { parseArgs, run } from "../../scripts/operator/lcx-finance-research-run.js";
import { readFinanceScheduledResearchFeedback } from "../../scripts/operator/lcx-finance-scheduler.js";
import {
  buildFinanceBrokerAccountResearchEvidence,
  writeFinanceNightReviewEvidence,
} from "../../src/agents/finance-night-review-context.js";
import {
  financeResearchPortfolioContextSchema,
  financeScheduledResearchHandoffSchema,
} from "../../src/agents/finance-research-portfolio-plan.js";
import {
  activateFinanceStrategyRule,
  declareFinanceStrategyRule,
} from "../../src/agents/finance-strategy-rule-ledger.js";

const repo = path.resolve(import.meta.dirname, "../..");
const hash = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
export type ResearchInputFault =
  | "cross_account"
  | "cross_venue"
  | "body_position_account"
  | "body_profit_account"
  | "source_whitespace_cross_account"
  | "missing_account_scope"
  | "invalid_broker_summary"
  | "missing_evidence"
  | "invalid_evidence_json"
  | "missing_context"
  | "invalid_context_json";

/** Original preflight and original CLI reader; only child transport becomes a private dry run. */
export async function probeOriginalResearchInput(params: {
  directory: string;
  fault?: ResearchInputFault;
}) {
  const workspace = path.join(params.directory, "workspace");
  const book = path.join(params.directory, "finance-book");
  await fsp.mkdir(workspace, { recursive: true });
  await fsp.mkdir(book, { recursive: true });
  const asOf = new Date().toISOString();
  const runId = randomUUID();
  await declareFinanceStrategyRule(book, {
    kind: "declared",
    ruleId: "private-input-rule",
    form: "monthly_trend",
    instruments: ["SPY"],
    emits: "target_weights",
    schedule: { kind: "monthly", timezone: "America/New_York" },
    body: { frozenRule: { lookbackMonths: 3 } },
    observedAt: asOf,
    provenance: { origin: "private offline research input probe" },
  });
  await activateFinanceStrategyRule(book, {
    kind: "activated",
    ruleId: "private-input-rule",
    observedAt: asOf,
  });
  const contextPath = path.join(book, "private-operator-context.json");
  const portfolio = financeResearchPortfolioContextSchema.parse({
    accountId: `private-${hash(book).slice(0, 12)}`,
    venue: "paper",
    validityMinutes: 60,
    conflictPolicy: "block",
    activeStrategyIds: ["private-input-rule"],
    requiredInstruments: ["SPY"],
  });
  await fsp.writeFile(contextPath, JSON.stringify(portfolio) + "\n", { mode: 0o600 });
  const sourcePath = path.join(repo, "scripts/operator/lcx-finance-scheduler.ts");
  const source = await fsp.readFile(sourcePath, "utf8");
  const ast = ts.createSourceFile(sourcePath, source, ts.ScriptTarget.Latest, true);
  const names = [
    "runDayResearchPreflight",
    "failedDayResearchPreflight",
    "financeResearchProcessEnv",
    "SchedulerProgressBeforeDispatchError",
  ];
  const declarations = ast.statements.filter(
    (node) =>
      (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) &&
      node.name &&
      names.includes(node.name.text),
  );
  if (declarations.length !== names.length) {
    throw new Error("original preflight declarations missing");
  }
  let originalArgv: string[] = [];
  let evidencePath = "";
  let frozenContextPath = "";
  let originalEvidenceBytes = "";
  let originalContextBytes = "";
  let consumedEvidenceBytes: string | null = null;
  let consumedContextBytes: string | null = null;
  let output: Awaited<ReturnType<typeof run>> | undefined;
  let failure: string | undefined;
  const context = vm.createContext({
    fs,
    path,
    createHash,
    Buffer,
    financeScheduledResearchHandoffSchema,
    process: { env: {} },
    URL,
    REPO_ROOT: repo,
    RESEARCH_SCRIPT: path.join(repo, "scripts/operator/lcx-finance-research-run.ts"),
    financeResearchPortfolioContextSchema,
    buildFinanceBrokerAccountResearchEvidence,
    readFinanceScheduledResearchFeedback,
    writeFinanceNightReviewEvidence,
    runScheduledCycleProcess: async (
      _context: unknown,
      stage: string,
      child: { argv: string[] },
    ) => {
      if (stage !== "research_preflight") {
        throw new Error(`unexpected child stage ${stage}`);
      }
      originalArgv = [...child.argv];
      const value = (flag: string) => child.argv[child.argv.indexOf(flag) + 1];
      evidencePath = value("--controller-evidence");
      frozenContextPath = value("--portfolio-context");
      originalEvidenceBytes = await fsp.readFile(evidencePath, "utf8");
      originalContextBytes = await fsp.readFile(frozenContextPath, "utf8");
      if (
        params.fault === "cross_account" ||
        params.fault === "cross_venue" ||
        params.fault === "body_position_account" ||
        params.fault === "body_profit_account" ||
        params.fault === "source_whitespace_cross_account" ||
        params.fault === "missing_account_scope" ||
        params.fault === "invalid_broker_summary"
      ) {
        const items = JSON.parse(originalEvidenceBytes);
        const body = JSON.parse(items[0].text);
        if (params.fault === "body_position_account" || params.fault === "body_profit_account") {
          body[params.fault === "body_position_account" ? "positionSnapshots" : "accounts"] = [
            { accountId: "different-private-account", venue: "paper" },
          ];
        } else if (params.fault === "missing_account_scope") {
          delete body.accountScope;
        } else if (params.fault !== "invalid_broker_summary") {
          body.accountScope[params.fault === "cross_venue" ? "venue" : "accountId"] =
            params.fault === "cross_venue" ? "alpaca:paper" : "different-private-account";
        }
        if (params.fault === "source_whitespace_cross_account") {
          items[0].source = " finance-broker-profit-summary ";
        }
        items[0].text =
          params.fault === "invalid_broker_summary" ? "{invalid" : JSON.stringify(body);
        await fsp.writeFile(evidencePath, JSON.stringify(items) + "\n");
      }
      if (params.fault === "missing_evidence") {
        await fsp.rm(evidencePath);
      } else if (params.fault === "invalid_evidence_json") {
        await fsp.writeFile(evidencePath, "{invalid");
      } else if (params.fault === "missing_context") {
        await fsp.rm(frozenContextPath);
      } else if (params.fault === "invalid_context_json") {
        await fsp.writeFile(frozenContextPath, "{invalid");
      }
      consumedEvidenceBytes = await fsp.readFile(evidencePath, "utf8").catch(() => null);
      consumedContextBytes = await fsp.readFile(frozenContextPath, "utf8").catch(() => null);
      const options = parseArgs(child.argv.slice(3));
      // Original CLI disallows these paths without live flags. Only the test execution mode changes.
      options.live = false;
      try {
        output = await run(options);
        return { ok: true, status: "succeeded", exitCode: 0, stdout: "", stderr: "" };
      } catch (error) {
        failure = error instanceof Error ? error.message : String(error);
        return { ok: false, status: "failed", exitCode: 1, stdout: "", stderr: failure };
      }
    },
  });
  const isolated = `${declarations.map((node) => node.getText(ast).replace(/^export\s+/u, "")).join("\n")}\nglobalThis.preflight = runDayResearchPreflight;`;
  new vm.Script(
    ts.transpileModule(isolated, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    }).outputText,
    { filename: sourcePath },
  ).runInContext(context);
  const preflight = context.preflight as (input: unknown) => Promise<unknown>;
  const processResult = await preflight({
    context: {
      root: { directory: book },
      options: {
        timeoutMs: 10_000,
        researchPlan: { contextPath, ask: "Review SPY under the private active rule." },
      },
      signal: new AbortController().signal,
    },
    attempt: { firedAt: asOf, etDate: asOf.slice(0, 10), runId },
    portfolioPlanPath: path.join(book, "research-portfolio-plan-latest.json"),
  });
  const written = output?.written as { datedPath?: string; latestPath?: string } | undefined;
  const receiptReadbackBytes = written?.datedPath
    ? await fsp.readFile(written.datedPath, "utf8")
    : undefined;
  const receiptReadback = receiptReadbackBytes ? JSON.parse(receiptReadbackBytes) : undefined;
  return {
    fault: params.fault ?? "normal",
    workspace,
    book,
    asOf,
    attemptRunId: runId,
    sourceSha256: hash(source),
    originalArgv,
    offlineSeam:
      "original parseArgs; only parsed options.live=false; planned output grants no candidate, source, quality or broker acceptance",
    evidencePath,
    frozenContextPath,
    originalEvidenceBytes,
    originalContextBytes,
    originalEvidenceSha256: hash(originalEvidenceBytes),
    originalContextSha256: hash(originalContextBytes),
    consumedEvidenceBytes,
    consumedContextBytes,
    consumedEvidenceSha256: consumedEvidenceBytes === null ? null : hash(consumedEvidenceBytes),
    consumedContextSha256: consumedContextBytes === null ? null : hash(consumedContextBytes),
    processResult,
    output,
    failure,
    receiptReadback,
    receiptReadbackBytes,
  };
}
