import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import crypto from "node:crypto";
import syncFs from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import vm from "node:vm";
import type { OperatorDigestEvidence } from "../../scripts/operator/lcx-owner-brief.ts";

const repoRoot = path.resolve(import.meta.dirname, "../..");
export const operatorBytesHash = (bytes: string | Buffer) =>
  crypto.createHash("sha256").update(bytes).digest("hex");

/** Only the original receipt writer is executed. All upstream owner IO is private substitute data. */
export async function originalOperatorWriter(
  root: string,
  writerPath: string,
  options: {
    doctorBlocked?: boolean;
    doctorExitCode?: number;
    governanceSummary?: Record<string, unknown>;
    contextRecoveryBlocked?: boolean;
    contextRecoveryFailures?: string[];
    contextRecoveryStderr?: string;
  } = {},
) {
  await fs.mkdir(root, { recursive: true });
  const fullSource = await fs.readFile(writerPath, "utf8");
  const anchor = fullSource.indexOf("function writeJsonAtomically(filePath, value)");
  const begin = fullSource.lastIndexOf("<<'NODE'\n", anchor) + "<<'NODE'\n".length;
  const end = fullSource.indexOf("\nNODE", anchor);
  assert.ok(anchor > 0 && begin > 0 && end > begin);
  const writerSource = fullSource.slice(begin, end);
  const io: Array<{ op: string; path: string; sha256?: string }> = [];
  const safe = (file: string) => {
    assert.equal(typeof file, "string");
    const resolved = path.resolve(file);
    assert.ok(
      resolved === path.resolve(root) || resolved.startsWith(path.resolve(root) + path.sep),
    );
    return resolved;
  };
  const safeFs = {
    readFileSync(file: string, encoding: BufferEncoding) {
      const bytes = syncFs.readFileSync(safe(file));
      io.push({ op: "read", path: file, sha256: operatorBytesHash(bytes) });
      return bytes.toString(encoding);
    },
    mkdirSync(file: string, options: syncFs.MakeDirectoryOptions) {
      return syncFs.mkdirSync(safe(file), options);
    },
    writeFileSync(file: string, bytes: string, options?: syncFs.WriteFileOptions) {
      io.push({ op: "write", path: file, sha256: operatorBytesHash(bytes) });
      return syncFs.writeFileSync(safe(file), bytes, options);
    },
    renameSync(from: string, to: string) {
      return syncFs.renameSync(safe(from), safe(to));
    },
    appendFileSync(file: string, bytes: string) {
      io.push({ op: "append", path: file, sha256: operatorBytesHash(bytes) });
      return syncFs.appendFileSync(safe(file), bytes);
    },
  };
  const env: Record<string, string> = {
    NODE_REPO_ROOT: root,
    NODE_SOURCE_COMMIT: "private_offline_source_not_a_runtime_claim",
    NODE_OBSERVE_ONLY: "true",
    NODE_SKIP_CLEANUP: "true",
    NODE_SKIP_TRAINING_RESTART: "true",
    NODE_CLEANUP_CODE: "0",
    NODE_EXAM_CODE: "0",
    NODE_JSONL: path.join(root, "operator-log.jsonl"),
    NODE_REPO_LATEST: path.join(root, "repo-operator-latest.json"),
    NODE_LATEST: path.join(root, "workspace-operator-latest.json"),
    NODE_CLEANUP_FILE: path.join(root, "cleanup.txt"),
  };
  const ownerInputs: Array<[string, string, unknown]> = [
    [
      "DOCTOR",
      "DOCTOR",
      {
        ok: !options.doctorBlocked,
        boundary: "offline_private_owner_IO",
        checks: [
          {
            name: "minimax-brain-training-guard",
            summary: { active: false, overlappingHeavyEval: false },
          },
        ],
        summary: { passed: options.doctorBlocked ? 0 : 1, failed: options.doctorBlocked ? 1 : 0 },
      },
    ],
    ["PLAN", "PLAN", { ok: true, activeProcesses: [], decisions: [] }],
    ["EXAM", "EXAM", { skipped: true, reason: "offline: original owners are not executed" }],
    [
      "GOVERNANCE",
      "GOVERNANCE",
      {
        ok: true,
        checkedAt: new Date().toISOString(),
        summary: {
          fastestSafeNextAction: "review_original_operator_identity_gap",
          ...options.governanceSummary,
        },
      },
    ],
    ["MIND", "MIND", { ok: true, summary: {} }],
    ["FLOW", "FLOW", { ok: true, summary: {} }],
    [
      "CONTEXT_RECOVERY",
      "CONTEXT_RECOVERY",
      {
        ok: !options.contextRecoveryBlocked,
        actionableFailures: options.contextRecoveryFailures ?? [],
      },
    ],
    ["TRAINING_SUPERVISOR", "TRAINING_SUPERVISOR", { ok: true }],
  ];
  await fs.writeFile(env.NODE_CLEANUP_FILE, "cleanup skipped: private receipt-writer-only probe\n");
  for (const [fileKey, codeKey, value] of ownerInputs) {
    const file = path.join(root, `${fileKey.toLowerCase()}.json`);
    await fs.writeFile(file, JSON.stringify(value));
    env[`NODE_${fileKey}_FILE`] = file;
    env[`NODE_${codeKey}_CODE`] = String(fileKey === "DOCTOR" ? (options.doctorExitCode ?? 0) : 0);
    const errorPath = path.join(root, `${fileKey.toLowerCase()}.err`);
    await fs.writeFile(
      errorPath,
      fileKey === "DOCTOR" && options.doctorBlocked
        ? "native-doctor-source-check: source quality gate failed"
        : fileKey === "CONTEXT_RECOVERY"
          ? (options.contextRecoveryStderr ?? "")
          : "",
    );
    env[`NODE_${fileKey}_ERR`] = errorPath;
  }
  const stdout: string[] = [];
  vm.runInNewContext(
    writerSource,
    {
      require(name: string) {
        if (name === "fs") {
          return safeFs;
        }
        if (name === "path") {
          return path;
        }
        throw new Error(`unexpected writer dependency: ${name}`);
      },
      process: { env, pid: 41011 },
      console: {
        log(value: string) {
          stdout.push(value);
        },
      },
    },
    { timeout: 1000 },
  );
  const bytes = await fs.readFile(env.NODE_LATEST);
  assert.deepEqual(JSON.parse(bytes.toString()), JSON.parse(stdout.join("\n")));
  assert.deepEqual(
    JSON.parse(await fs.readFile(env.NODE_REPO_LATEST, "utf8")),
    JSON.parse(bytes.toString()),
  );
  const output = {
    path: env.NODE_LATEST,
    sha256: operatorBytesHash(bytes),
    value: JSON.parse(bytes.toString()) as Record<string, unknown>,
    io,
    source: {
      path: writerPath,
      sha256: operatorBytesHash(fullSource),
      writerSha256: operatorBytesHash(writerSource),
    },
    boundary: "original_receipt_writer_private_IO_only_upstream_owners_unrun_no_scheduler",
  };
  await fs.writeFile(
    path.join(root, "original-writer-proof.json"),
    JSON.stringify(output, null, 2) + "\n",
  );
  return output;
}

type OperatorBriefReadback = {
  ok: boolean;
  headline: string;
  firstFailedGate: string;
  markdown: string;
  sourcePaths: string[];
  operatorDigest: OperatorDigestEvidence;
  runReceipt?: unknown;
  snapshot?: unknown;
};

/** Execute the original CLI/renderer/writer; both persisted brief formats are independently read. */
export async function originalOperatorBriefCli(
  root: string,
  inputPath: string,
  pins: {
    sha256?: string;
    checkedAt?: string;
    repoRoot?: string;
  } = {},
) {
  const args = [
    "--import",
    "tsx",
    path.join(repoRoot, "scripts/operator/lcx-owner-brief.ts"),
    "--operator-path",
    inputPath,
    "--operator-repo-root",
    pins.repoRoot ?? root,
    "--json",
    "--write",
    ...(pins.sha256 ? ["--operator-sha256", pins.sha256] : []),
    ...(pins.checkedAt ? ["--operator-checked-at", pins.checkedAt] : []),
  ];
  let stdout = "";
  let stderr = "";
  let exitCode = 0;
  try {
    ({ stdout, stderr } = await promisify(execFile)(process.execPath, args, {
      cwd: repoRoot,
      env: { ...process.env, LCX_USER_HOME: root },
      timeout: 10000,
      maxBuffer: 1024 * 1024,
    }));
  } catch (error) {
    const failure = error as Error & { stdout?: string; stderr?: string; code?: number };
    stdout = failure.stdout ?? "";
    stderr = failure.stderr ?? "";
    exitCode = failure.code ?? 1;
  }
  const value = JSON.parse(stdout) as OperatorBriefReadback;
  const jsonPath = path.join(root, ".openclaw/workspace/state/lcx-owner-brief-latest.json");
  const markdownPath = path.join(root, ".openclaw/workspace/state/lcx-owner-brief-latest.md");
  const jsonBytes = await fs.readFile(jsonPath);
  const markdownBytes = await fs.readFile(markdownPath);
  const readback = JSON.parse(jsonBytes.toString()) as OperatorBriefReadback;
  assert.deepEqual(readback, value);
  assert.equal(markdownBytes.toString(), `${value.markdown}\n`);
  const output = {
    exitCode,
    stderr,
    stdout,
    value,
    readback,
    args,
    source: {
      path: "scripts/operator/lcx-owner-brief.ts",
      sha256: operatorBytesHash(
        await fs.readFile(path.join(repoRoot, "scripts/operator/lcx-owner-brief.ts")),
      ),
    },
    persisted: [
      { path: jsonPath, sha256: operatorBytesHash(jsonBytes) },
      { path: markdownPath, sha256: operatorBytesHash(markdownBytes) },
    ],
    boundary:
      "original_reader_renderer_writer_private_state_only_no_gov_trace_hostloop_or_provider",
  };
  await fs.writeFile(
    path.join(
      root,
      `original-brief-consumer-proof-${operatorBytesHash(JSON.stringify(args)).slice(0, 12)}.json`,
    ),
    JSON.stringify(output, null, 2) + "\n",
  );
  return output;
}
