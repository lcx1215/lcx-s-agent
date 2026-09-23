import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
const buildInfo = JSON.parse(readFileSync("dist/build-info.json", "utf8"));
const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();

const problems = [];
if (buildInfo.version !== packageJson.version) {
  problems.push(
    `build version ${buildInfo.version ?? "missing"} != package version ${packageJson.version}`,
  );
}
if (buildInfo.commit !== sourceCommit) {
  problems.push(`build commit ${buildInfo.commit ?? "missing"} != source commit ${sourceCommit}`);
}
if (buildInfo.sourceDirty !== false) {
  problems.push(
    `build source dirty state must be false (received ${String(buildInfo.sourceDirty)})`,
  );
}

if (problems.length > 0) {
  console.error(`build identity mismatch: ${problems.join("; ")}`);
  process.exitCode = 1;
} else {
  console.log(`build identity ok: ${buildInfo.version} (${sourceCommit.slice(0, 12)})`);
}
