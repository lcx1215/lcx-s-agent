import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { runCentralHarnessCycle } from "../../src/agents/central-harness/harness-loop.js";
import { createCentralBrain } from "../../src/agents/central-harness/model-brain.js";
import type { CentralBrain } from "../../src/agents/central-harness/model-brain.js";
import { createCentralToolRegistry } from "../../src/agents/central-harness/tool-registry.js";
import type { CentralPerception } from "../../src/agents/central-harness/types.js";
import { loadConfig } from "../../src/config/io.js";

const WORKSPACE = path.join(process.env.HOME ?? ".", ".openclaw", "workspace");
const STATE_DIR = path.join(WORKSPACE, "state");

const CLAIMED_BOUNDARIES = [
  "research_only",
  "no_execution_authority",
  "llm_proposes_ts_gate_approves",
];

class ParseError extends Error {}

function parseArgs(args: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = { durationMinutes: 2, dryRun: false };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--duration-minutes") {
      out.durationMinutes = Number(args[i + 1]);
      i += 1;
    } else if (arg === "--dry-run") {
      out.dryRun = true;
    } else if (arg === "--json") {
      out.json = true;
    } else if (arg === "--help" || arg === "-h") {
      throw new ParseError(
        "Usage: node --import tsx scripts/operator/lcx-central-agent.ts [--duration-minutes N] [--dry-run] [--json]",
      );
    }
  }
  return out;
}

async function readLatest<T>(name: string, fallback: T): Promise<T> {
  try {
    const raw = await fs.readFile(path.join(STATE_DIR, name), "utf8");
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function extractOwnerTotals(state: Record<string, unknown>): Record<string, unknown> {
  const byOwner = state.byOwner as Record<string, unknown> | undefined;
  if (byOwner && typeof byOwner === "object") {
    const totals: Record<string, unknown> = {};
    for (const [ownerId, run] of Object.entries(byOwner)) {
      const r = run as Record<string, unknown>;
      const compact = r?.compact as Record<string, unknown> | undefined;
      totals[ownerId] = {
        ok: r?.ok,
        status: (r?.runReceipt as Record<string, unknown> | undefined)?.status,
        ...(compact?.ok !== undefined ? { compactOk: compact.ok } : {}),
      };
    }
    return totals;
  }
  return {};
}

async function buildPerception(): Promise<CentralPerception> {
  const controlRoom = await readLatest<Record<string, unknown>>("lcx-control-room-latest.json", {});
  const governance = await readLatest<Record<string, unknown>>(
    "lcx-governance-autopilot-latest.json",
    {},
  );
  const ownerTotals = extractOwnerTotals(governance);
  const observedAt = new Date().toISOString();
  return {
    observedAt,
    ownerTotals,
    controlRoom,
    backlog: [],
    boundaries: CLAIMED_BOUNDARIES,
  };
}

async function settle(receipt: unknown): Promise<void> {
  const logPath = path.join(STATE_DIR, "lcx-central-agent-log-latest.jsonl");
  await fs.mkdir(path.dirname(logPath), { recursive: true });
  const handle = await fs.open(logPath, "a");
  try {
    await handle.write(`${JSON.stringify(receipt)}\n`);
  } finally {
    await handle.close();
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const durationMinutes = Number(options.durationMinutes);
  const dryRun = options.dryRun === true;
  const registry = createCentralToolRegistry();
  const brain: CentralBrain = dryRun
    ? {
        propose: async () => ({ kind: "blocked_no_provider" as const, reason: "dry_run_no_llm" }),
      }
    : createCentralBrain(loadConfig());

  const deadline = Date.now() + durationMinutes * 60_000;
  let runs = 0;
  while (Date.now() < deadline) {
    const perception = await buildPerception();
    const receipt = await runCentralHarnessCycle({
      perception,
      brain,
      registry,
      runId: `central-${runs}-${Date.now()}`,
    });
    await settle(receipt);
    runs += 1;
    if (dryRun) {
      break;
    }
    // Bounded pacing: at least a short pause between cycles to stay idle-friendly.
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
  if (options.json) {
    const summary = {
      ok: true,
      boundary: "local_central_agent_observe_only",
      runs,
      dryRun,
      liveTouched: false,
      providerConfigTouched: false,
      protectedMemoryTouched: false,
    };
    process.stdout.write(`${JSON.stringify(summary)}\n`);
  } else {
    process.stdout.write(`central agent ran ${runs} cycle(s) over ${durationMinutes} min(s)\n`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main().catch((error) => {
    if (error instanceof ParseError) {
      process.stdout.write(`${error.message}\n`);
      process.exitCode = 2;
    } else {
      process.stderr.write(`central agent failed: ${String(error)}\n`);
      process.exitCode = 1;
    }
  });
}
