#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import {
  readModelRequestTrajectory,
  summarizeModelRequestTrajectory,
} from "../../src/agents/model-request-trajectory.js";

export async function runModelRequestTrajectoryCli() {
  const records = await readModelRequestTrajectory();
  const summary = summarizeModelRequestTrajectory(records);
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  return summary;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runModelRequestTrajectoryCli().catch(() => {
    process.stderr.write("model request metadata summary failed\n");
    process.exitCode = 1;
  });
}
