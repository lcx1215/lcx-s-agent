import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import vm from "node:vm";
import ts from "typescript";
import type { OwnerControlMap } from "../../scripts/operator/lcx-owner-control-map.js";
import {
  buildSelfRepairHandsReceipt,
  writeSelfRepairHandsReceipt,
} from "../../scripts/operator/lcx-self-repair-hands.js";
import { readSelfRepairOwnerMapFeedback } from "../../src/agents/self-repair-owner-map-feedback.js";
import {
  boundaryFromFlags,
  buildLcxRunReceipt,
  type LcxRunSnapshot,
} from "../../src/shared/lcx-run-receipt.js";
import { probeOriginalSelfRepairOwnerMap } from "./lcx-waterflow-self-repair-owner-map-probe.js";

const exec = promisify(execFile);
const repo = path.resolve(import.meta.dirname, "../..");
const sha = (bytes: string) => createHash("sha256").update(bytes).digest("hex");
const itemId = "self_repair_memory_and_training_candidate_hands";
type Row = Record<string, unknown>;
export type FeedbackFault =
  | "hash"
  | "missing"
  | "cross_governance"
  | "cross_host"
  | "standalone"
  | "duplicate"
  | "missing_item"
  | "never_auto"
  | "host_snapshot_missing"
  | "item_status_array"
  | "changed_before_write";

function functions(source: ts.SourceFile) {
  return source.statements
    .filter(ts.isFunctionDeclaration)
    .map((node) => node.getText(source).replace(/^export\s+/u, ""))
    .join("\n");
}

async function produceCompletedGovernance(
  sourcePath: string,
  produced: Awaited<ReturnType<typeof probeOriginalSelfRepairOwnerMap>>,
  destination: string,
) {
  const source = await fs.readFile(sourcePath, "utf8");
  const ast = ts.createSourceFile(sourcePath, source, ts.ScriptTarget.Latest, true);
  const declarations = ast.statements
    .filter(ts.isVariableStatement)
    .flatMap((node) => node.declarationList.declarations);
  const initializer = (name: string) => {
    const node = declarations.find(
      (entry) => ts.isIdentifier(entry.name) && entry.name.text === name,
    );
    assert.ok(node?.initializer, `original ${name} missing`);
    return node.initializer;
  };
  const receipt = initializer("receipt");
  assert.ok(ts.isObjectLiteralExpression(receipt));
  const property = (name: string) => {
    const node = receipt.properties.find(
      (entry) => ts.isPropertyAssignment(entry) && entry.name.getText(ast) === name,
    );
    assert.ok(node && ts.isPropertyAssignment(node));
    return node.initializer.getText(ast);
  };
  const commands = initializer("OWNER_COMMANDS");
  assert.ok(ts.isArrayLiteralExpression(commands));
  const selfRepairCommand = commands.elements.find(
    (entry) =>
      ts.isObjectLiteralExpression(entry) &&
      entry.properties.some(
        (prop) =>
          ts.isPropertyAssignment(prop) &&
          prop.name.getText(ast) === "id" &&
          ts.isStringLiteral(prop.initializer) &&
          prop.initializer.text === "selfRepairHands",
      ),
  );
  assert.ok(selfRepairCommand);
  const variableNames = [
    "requiredParseFailures",
    "activeTrainingOrEval",
    "structuralOwnerFailures",
    "structuralOwnerExecutionFailures",
    "universeIndexGovernanceIncomplete",
    "releaseBlocked",
    "governanceCheckedAt",
    "governanceRunStatus",
    "governanceNextAction",
    "governanceRunReceipt",
  ];
  const variables = variableNames
    .map((name) => `const ${name} = ${initializer(name).getText(ast)};`)
    .join("\n");
  const keys = [
    "ok",
    "boundary",
    "checkedAt",
    "snapshot",
    "runId",
    "runReceipt",
    "ownerCommands",
    "owners",
    "liveTouched",
    "providerConfigTouched",
    "protectedMemoryTouched",
  ];
  const code = `${functions(ast)}\nconst OWNER_COMMANDS = [${selfRepairCommand.getText(ast)}];\nconst byOwner = ownerMap(owners);\n${variables}\nconst receipt = {${keys.map((key) => `${key}: ${property(key)}`).join(",")}};\nreceipt`;
  const governance = vm.runInNewContext(
    ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText,
    {
      JSON,
      Date,
      Object,
      Set,
      owners: [produced.readerOwner],
      governanceRunId: produced.parentRunId,
      governanceSnapshot: produced.snapshot,
      boundaryFromFlags,
      buildLcxRunReceipt,
    },
  ) as Row;
  const publication = ast.statements.find(
    (node) =>
      ts.isExpressionStatement(node) &&
      ts.isAwaitExpression(node.expression) &&
      ts.isCallExpression(node.expression.expression) &&
      node.expression.expression.expression.getText(ast) === "writeEvidence" &&
      node.expression.expression.arguments[0]?.getText(ast) === '"governanceAutopilotLatest"',
  );
  assert.ok(
    publication &&
      ts.isExpressionStatement(publication) &&
      ts.isAwaitExpression(publication.expression) &&
      ts.isCallExpression(publication.expression.expression),
  );
  const callback = publication.expression.expression.arguments[1];
  assert.ok(callback && ts.isArrowFunction(callback));
  const writer = vm.runInNewContext(
    ts.transpileModule(`(${callback.getText(ast)})`, {
      compilerOptions: { target: ts.ScriptTarget.ES2022 },
    }).outputText,
    { fs, path, JSON, receipt: governance, GOVERNANCE_AUTOPILOT_LATEST_PATH: destination },
  ) as () => Promise<void>;
  await writer();
  return { governance, sourceSha256: sha(source), partialOwnerIds: ["selfRepairHands"] };
}

async function loadMapWriter(workspace: string) {
  const sourcePath = path.join(repo, "scripts/operator/lcx-owner-control-map.ts");
  const source = await fs.readFile(sourcePath, "utf8");
  const ast = ts.createSourceFile(sourcePath, source, ts.ScriptTarget.Latest, true);
  const jsonPath = path.join(workspace, "state/completed-owner-map.json");
  const markdownPath = path.join(workspace, "state/completed-owner-map.md");
  const original = vm.runInNewContext(
    ts.transpileModule(`${functions(ast)}\n({buildOwnerControlMap,writeOwnerControlMap})`, {
      compilerOptions: { target: ts.ScriptTarget.ES2022 },
    }).outputText,
    {
      fs,
      path,
      JSON,
      Date,
      Object,
      Set,
      OWNER_CONTROL_MAP_LATEST_JSON_PATH: jsonPath,
      OWNER_CONTROL_MAP_LATEST_MARKDOWN_PATH: markdownPath,
    },
  ) as {
    buildOwnerControlMap: (input: {
      checkedAt: string;
      snapshot?: LcxRunSnapshot;
      governance: Row;
      localFailureTrace: Row;
      paths: { latestJsonPath: string; latestMarkdownPath: string; sourcePaths: string[] };
    }) => OwnerControlMap;
    writeOwnerControlMap: (map: OwnerControlMap) => Promise<void>;
  };
  return { ...original, jsonPath, markdownPath, sourceSha256: sha(source) };
}

async function cli(args: string[]) {
  const argv = [
    "--import",
    "tsx",
    path.join(repo, "scripts/operator/lcx-self-repair-hands.ts"),
    ...args,
  ];
  try {
    const result = await exec(process.execPath, argv, { cwd: repo, timeout: 30000 });
    return { argv, ...result, exitCode: 0 };
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string; code?: number; message?: string };
    return {
      argv,
      stdout: failure.stdout ?? "",
      stderr: failure.stderr ?? "",
      exitCode: typeof failure.code === "number" ? failure.code : 1,
      error: failure.message,
    };
  }
}

/** Original producers and independent CLI consumer. No whole governance or model is run. */
export async function probeOriginalSelfRepairFeedback(options: {
  directory: string;
  fault?: FeedbackFault;
}) {
  const producerDir = path.join(options.directory, "producer");
  await fs.mkdir(producerDir, { recursive: true });
  const produced = await probeOriginalSelfRepairOwnerMap({ directory: producerDir, fault: "hash" });
  const workspace = path.join(producerDir, "workspace");
  const governancePath = path.join(workspace, "state/completed-governance.json");
  const governanceSourcePath = path.join(repo, "scripts/operator/lcx-governance-autopilot.ts");
  const producer = await produceCompletedGovernance(governanceSourcePath, produced, governancePath);
  const original = await loadMapWriter(workspace);
  const map = original.buildOwnerControlMap({
    checkedAt:
      options.fault === "standalone" ? new Date().toISOString() : produced.snapshot.observedAt,
    ...(options.fault === "standalone" ? {} : { snapshot: produced.snapshot }),
    governance: producer.governance,
    localFailureTrace: {},
    paths: {
      latestJsonPath: original.jsonPath,
      latestMarkdownPath: original.markdownPath,
      sourcePaths: [governancePath, String(produced.nativeWriter.latestJsonPath)],
    },
  });
  await original.writeOwnerControlMap(map);
  const originalMapBytes = await fs.readFile(original.jsonPath, "utf8");
  let governanceRefPath = governancePath;
  let secondProducer: Awaited<ReturnType<typeof produceCompletedGovernance>> | undefined;
  if (options.fault === "cross_governance") {
    const secondDir = path.join(options.directory, "producer-b");
    await fs.mkdir(secondDir, { recursive: true });
    const second = await probeOriginalSelfRepairOwnerMap({ directory: secondDir, fault: "hash" });
    governanceRefPath = path.join(workspace, "state/completed-governance-b.json");
    secondProducer = await produceCompletedGovernance(
      governanceSourcePath,
      second,
      governanceRefPath,
    );
  }
  if (options.fault === "duplicate") {
    const selected = map.items.find((item) => item.id === itemId);
    assert.ok(selected);
    await fs.writeFile(
      original.jsonPath,
      `${JSON.stringify({ ...map, items: [...map.items, selected] })}\n`,
    );
  }
  if (options.fault === "item_status_array") {
    await fs.writeFile(
      original.jsonPath,
      `${JSON.stringify({
        ...map,
        items: map.items.map((item) =>
          item.id === itemId ? { ...item, status: ["never_auto"] } : item,
        ),
      })}\n`,
    );
  }
  const mapBytes = await fs.readFile(original.jsonPath, "utf8");
  const governanceBytes = await fs.readFile(governanceRefPath, "utf8");
  const selectedId =
    options.fault === "never_auto"
      ? "protected_authority_boundaries"
      : options.fault === "missing_item"
        ? "not-an-original-item"
        : itemId;
  const request = {
    schemaVersion: 1,
    map: {
      path: path.relative(workspace, original.jsonPath),
      sha256: options.fault === "hash" ? "0".repeat(64) : sha(mapBytes),
    },
    governance: { path: path.relative(workspace, governanceRefPath), sha256: sha(governanceBytes) },
    itemId: selectedId,
  };
  const host = {
    schemaVersion: 1,
    sourceRunId:
      options.fault === "cross_host" ? `${produced.parentRunId}-other` : produced.parentRunId,
    snapshot:
      options.fault === "host_snapshot_missing"
        ? Object.fromEntries(
            Object.entries(produced.snapshot).filter(([key]) => key !== "snapshotId"),
          )
        : produced.snapshot,
    nowMs: Date.now(),
  };
  const requestPath = path.join(workspace, "state/feedback-request.json");
  const hostPath = path.join(workspace, "state/feedback-host.json");
  await fs.writeFile(requestPath, `${JSON.stringify(request, null, 2)}\n`);
  await fs.writeFile(hostPath, `${JSON.stringify(host, null, 2)}\n`);
  if (options.fault === "missing") {
    await fs.unlink(original.jsonPath);
  }
  const priorRootBytes = await fs.readFile(String(produced.nativeWriter.latestJsonPath), "utf8");
  const rule = "Explicit private candidate rule; diagnostic feedback is not a source authority.";
  const common = [
    "--workspace-dir",
    workspace,
    "--signal-key",
    "explicit-later-feedback-attempt",
    "--issue",
    "owner-map-diagnostic-feedback",
    "--observed-failure",
    "An explicitly selected completed owner diagnostic needs review.",
    "--replacement-rule",
    rule,
    "--owner-map-feedback",
    requestPath,
    "--feedback-host",
    hostPath,
    "--json",
  ];
  let initialFeedback: Awaited<ReturnType<typeof readSelfRepairOwnerMapFeedback>> | undefined;
  let firstWriteOutput: Row | undefined;
  let recoveryOutput: Row | undefined;
  let changedMapBytesBeforeWrite: string | undefined;
  let consumer: Awaited<ReturnType<typeof cli>>;
  if (options.fault === "changed_before_write") {
    initialFeedback = await readSelfRepairOwnerMapFeedback(workspace, request, host);
    assert.equal(initialFeedback.status, "read");
    const built = buildSelfRepairHandsReceipt({
      checkedAt: new Date().toISOString(),
      workspaceDir: workspace,
      signalKey: "explicit-later-feedback-attempt",
      issue: "owner-map-diagnostic-feedback",
      observedFailure: `An explicitly selected completed owner diagnostic needs review.\n${initialFeedback.diagnostic}`,
      replacementRule: rule,
      domain: "private_diagnostic_feedback",
      write: true,
      diagnosticFeedback: initialFeedback,
      diagnosticFeedbackRequest: { request, host },
    });
    // Real private source changes after the original reader, before the original writer's read.
    await fs.appendFile(original.jsonPath, "\n");
    changedMapBytesBeforeWrite = await fs.readFile(original.jsonPath, "utf8");
    await writeSelfRepairHandsReceipt(built);
    firstWriteOutput = JSON.parse(JSON.stringify(built)) as Row;
    // Restoring readable bytes cannot revive this same already-blocked attempt.
    await fs.writeFile(original.jsonPath, mapBytes);
    await writeSelfRepairHandsReceipt(built);
    recoveryOutput = JSON.parse(JSON.stringify(built)) as Row;
    consumer = {
      argv: [],
      stdout: JSON.stringify(built),
      stderr: "",
      exitCode: 0,
    };
  } else {
    consumer = await cli([...common, "--write"]);
  }
  assert.ok(consumer.stdout.trim(), `original consumer returned no JSON: ${consumer.stderr}`);
  const output = JSON.parse(consumer.stdout) as Row;
  const rootPath = String(output.latestJsonPath);
  const persistedBytes = await fs.readFile(rootPath, "utf8");
  const persisted = JSON.parse(persistedBytes) as Row;
  const hands = output.hands as {
    memoryCleaner: { path: string };
    trainingCaseBuilder: { path: string };
    patchCandidateBuilder: { path: string };
  };
  const bodies: Record<string, string | undefined> = {};
  for (const [name, hand] of Object.entries(hands)) {
    bodies[name] = await fs.readFile(hand.path, "utf8").catch(() => undefined);
  }
  // The existing no-write reader reports the saved latest separately. Re-requesting feedback
  // would intentionally build a new diagnostic attempt instead of reading the saved candidate.
  const readback = await cli(["--workspace-dir", workspace, "--json"]);
  assert.ok(readback.stdout.trim(), `original readback returned no JSON: ${readback.stderr}`);
  const proof = {
    fault: options.fault,
    produced,
    producer,
    secondProducer,
    map,
    originalMapBytes,
    consumedMapBytes: mapBytes,
    mapSha256: sha(mapBytes),
    governanceBytes,
    governanceSha256: sha(governanceBytes),
    request,
    host,
    selectedItem: map.items.find((item) => item.id === selectedId),
    rule,
    priorRootBytes,
    consumer,
    consumerEntry:
      options.fault === "changed_before_write"
        ? "original read API -> original builder -> changed private source -> original writer; API JSON serialization is not CLI stdout"
        : "original explicit CLI",
    initialFeedback,
    firstWriteOutput,
    recoveryOutput,
    changedMapBytesBeforeWrite,
    output,
    persisted,
    persistedSha256: sha(persistedBytes),
    bodies,
    readback,
    readbackOutput: JSON.parse(readback.stdout) as Row,
    sourceHashes: {
      selfRepair: sha(
        await fs.readFile(path.join(repo, "scripts/operator/lcx-self-repair-hands.ts"), "utf8"),
      ),
      governance: producer.sourceSha256,
      map: original.sourceSha256,
    },
    fieldRefs: {
      producer: "/owners/selfRepairHands/latestWrittenReceipt/sourceReview/blockers/0",
      map: `/items/${map.items.findIndex((item) => item.id === selectedId)}/reason`,
      consumer: "/hands/memoryCleaner/correctionMarkdown#Observed Failure",
    },
    boundary:
      "Explicit private original CLI/writers/readers. Governance constructor/ownerCommands/owners AST projection over only actual selfRepairHands reader; siblings unexecuted and original releaseBlocked retained, not a full governance run. Lowest writer path constants only; source hash is not semantic truth. Source run differs from later candidate attempt; no financial scope created for feedback. No model, provider, scheduler, protected memory or natural caller proof. Original governance runOwner has no deadline; private exec host limit does not prove production cancellation.",
  };
  await fs.writeFile(
    path.join(options.directory, "feedback-proof.json"),
    `${JSON.stringify(proof, null, 2)}\n`,
  );
  return proof;
}
