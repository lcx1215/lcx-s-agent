/**
 * Type gate coverage self-check.
 *
 * A type gate can only fail on files it actually loads. When a top-level
 * directory with TypeScript sources is not matched by `tsconfig.json`'s
 * `include`, `tsgo` skips it silently and can still exit 0. That is a gate
 * that never ran, mistaken for a passing gate.
 *
 * This check compares the tracked TypeScript files against the files the
 * compiler actually loaded, so the coverage of the gate cannot shrink without
 * CI noticing.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

const TS_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts"] as const;

/**
 * Tracked sources that are deliberately outside the product type gate.
 * Keep a reason next to every entry; adding one should be a deliberate choice,
 * not a way to silence this check.
 */
const OUT_OF_GATE = new Map<string, string>([
  ["vendor/", "vendored third-party copy that ships its own tsconfig.json"],
  [".pi/", "Pi coding-agent workspace extensions, resolved by Pi's own loader"],
  ["dist/", "generated build output"],
]);

function isTypeScript(filePath: string): boolean {
  return TS_EXTENSIONS.some((extension) => filePath.endsWith(extension));
}

function gitStdout(args: string[]): string {
  return execFileSync("git", args, { encoding: "utf8" });
}

function repoRoot(): string {
  return gitStdout(["rev-parse", "--show-toplevel"]).trim();
}

function trackedTypeScriptFiles(): string[] {
  // Include untracked files too, so a local refactor cannot "pass" by accident.
  return gitStdout(["ls-files", "--cached", "--others", "--exclude-standard"])
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .filter(isTypeScript)
    .filter((filePath) => existsSync(filePath));
}

function tsgoBinary(): string {
  const local = path.join("node_modules", ".bin", "tsgo");
  return existsSync(local) ? local : "tsgo";
}

function parseProject(argv: string[]): string {
  const index = argv.indexOf("--project");
  if (index === -1) {
    return "tsconfig.json";
  }
  const value = argv[index + 1];
  if (!value) {
    throw new Error("Missing value for --project");
  }
  return value;
}

/** Large enough for a full program listing; spawnSync's default 1 MB truncates it. */
const LIST_FILES_MAX_BUFFER = 64 * 1024 * 1024;

/** Files the compiler actually loaded for the project, as absolute paths. */
function compilerProgramFiles(project: string): Set<string> {
  const result = spawnSync(tsgoBinary(), ["--noEmit", "-p", project, "--listFiles"], {
    encoding: "utf8",
    maxBuffer: LIST_FILES_MAX_BUFFER,
  });

  if (result.error) {
    throw new Error(`Failed to run tsgo: ${result.error.message}`);
  }
  if (result.status === null) {
    throw new Error(`tsgo was terminated before finishing (signal ${String(result.signal)}).`);
  }

  const files = (result.stdout ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("/") && isTypeScript(line));

  // A truncated listing would report unrelated files as uncovered, so refuse to
  // judge coverage unless the compiler really did hand us a program.
  if (!files.some((filePath) => filePath.includes("/src/"))) {
    throw new Error(`tsgo --listFiles returned an implausible file list for ${project}.`);
  }

  return new Set(files.map((filePath) => path.resolve(filePath)));
}

function main() {
  // Makes `... | head` safe.
  process.stdout.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code === "EPIPE") {
      process.exit(0);
    }
    throw error;
  });

  const project = parseProject(process.argv.slice(2));
  const root = repoRoot();
  const program = compilerProgramFiles(project);
  const tracked = trackedTypeScriptFiles();

  const allowlisted: string[] = [];
  const uncovered: string[] = [];

  for (const filePath of tracked) {
    if (program.has(path.resolve(root, filePath))) {
      continue;
    }
    if ([...OUT_OF_GATE.keys()].some((prefix) => filePath.startsWith(prefix))) {
      allowlisted.push(filePath);
      continue;
    }
    uncovered.push(filePath);
  }

  if (!uncovered.length) {
    const covered = tracked.length - allowlisted.length;
    // eslint-disable-next-line no-console
    console.log(
      `type gate covers ${covered}/${tracked.length} tracked TypeScript files ` +
        `(${allowlisted.length} intentionally out of gate: ${[...OUT_OF_GATE.keys()].join(", ")})`,
    );
    return;
  }

  console.error(`TypeScript files not covered by the type gate (project: ${project}):`);
  for (const filePath of uncovered.toSorted()) {
    console.error(`  ${filePath}`);
  }
  console.error(
    "\nAdd the matching directory to `include` in tsconfig.json, or list its prefix in OUT_OF_GATE with a reason.",
  );
  process.exitCode = 1;
}

main();
