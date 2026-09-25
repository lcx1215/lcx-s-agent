#!/usr/bin/env node
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import {
  FINANCE_SOURCE_HEARTBEAT_MAX_TIMER_MS,
  planFinanceSourceHeartbeat,
  readFinanceSourceHeartbeat,
  runFinanceSourceHeartbeat,
} from "../../src/agents/finance-source-heartbeat.js";

function value(argv: readonly string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  return index === -1 ? undefined : argv[index + 1];
}

function numberValue(argv: readonly string[], flag: string, fallback: number): number {
  const raw = value(argv, flag);
  const parsed = raw === undefined ? fallback : Number(raw);
  if (
    !Number.isSafeInteger(parsed) ||
    parsed <= 0 ||
    parsed > FINANCE_SOURCE_HEARTBEAT_MAX_TIMER_MS
  ) {
    throw new Error(
      `${flag} must be a positive safe integer no greater than ${FINANCE_SOURCE_HEARTBEAT_MAX_TIMER_MS}`,
    );
  }
  return parsed;
}

export async function runFinanceSourceHeartbeatCli(
  argv: readonly string[] = process.argv.slice(2),
) {
  const live = argv.includes("--live");
  const loop = argv.includes("--loop");
  const force = argv.includes("--force");
  const json = argv.includes("--json");
  const directory = value(argv, "--dir");
  const asOf = value(argv, "--as-of");
  const intervalMs = numberValue(argv, "--interval-ms", 15 * 60_000);
  const timeoutMs = numberValue(argv, "--timeout-ms", 15_000);
  if (loop && !live) {
    throw new Error("--loop requires --live; dry mode never keeps a process alive");
  }
  if (!loop && !argv.includes("--once")) {
    throw new Error("usage: --once [--live] | --loop --live");
  }

  if (!live) {
    const [plan, state] = await Promise.all([
      planFinanceSourceHeartbeat({ asOf }),
      readFinanceSourceHeartbeat({ directory }),
    ]);
    const result = { ...plan, persistedState: state, liveRequired: true };
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return result;
  }

  let last: Awaited<ReturnType<typeof runFinanceSourceHeartbeat>> | undefined;
  do {
    last = await runFinanceSourceHeartbeat({
      directory,
      asOf,
      force,
      intervalMs,
      timeoutMs,
    });
    if (json) {
      process.stdout.write(`${JSON.stringify(last, null, 2)}\n`);
    } else {
      process.stdout.write(
        `heartbeat providers=${last.providerCount} checked=${last.checkedProviders.length} ` +
          `healthy=${last.healthyCount} degraded=${last.degradedCount} unhealthy=${last.unhealthyCount}\n`,
      );
    }
    if (loop) {
      await delay(intervalMs);
    }
  } while (loop);
  return last;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runFinanceSourceHeartbeatCli().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : "heartbeat failed"}\n`);
    process.exitCode = 1;
  });
}
