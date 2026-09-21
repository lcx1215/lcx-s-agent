/**
 * Read-only probe.
 *
 * Question: can the cron UI express "failureAlert = inherit" for a job that
 * already carries a per-job alert object?
 *
 * The UI's mode dropdown has three states (inherit / disabled / custom).
 * `buildFailureAlert()` (ui/src/ui/controllers/cron.ts:588-617) maps them to
 * `undefined` / `false` / object, and `addCronJob()` sends the whole job object
 * as either the `cron.update` patch (edit path) or the `cron.add` payload (add
 * path). This probe walks that exact wire path -- gateway.ts:346
 * `ws.send(JSON.stringify(frame))` -- and then applies the result through the
 * real server merge, to report which of the three states survives.
 *
 * F-56 was fixed on 2026-09-21 by sending an explicit `null` on the EDIT path
 * (see `addCronJob`'s `builtFailureAlert` coercion). Both paths are reported
 * below so this probe stays a before/after instrument: the "edit" row for
 * `inherit` is what the fix changed.
 *
 * Nothing here writes to the store or to a running service.
 */
import { applyJobPatch } from "../../src/cron/service/jobs.js";
import type { CronJob, CronJobPatch } from "../../src/cron/types.js";

const EXISTING_ALERT = {
  after: 3,
  channel: "telegram",
  to: "123456",
  mode: "announce",
  accountId: "coordinator",
} as const;

function makeJob(): CronJob {
  const now = 1_700_000_000_000;
  return {
    id: "job-alert",
    name: "job-alert",
    enabled: true,
    createdAtMs: now,
    updatedAtMs: now,
    schedule: { kind: "every", everyMs: 60_000 },
    sessionTarget: "isolated",
    wakeMode: "now",
    payload: { kind: "agentTurn", message: "do it" },
    delivery: { mode: "announce", channel: "telegram", to: "123456" },
    state: {},
    failureAlert: { ...EXISTING_ALERT },
  };
}

/** Exactly what ui/src/ui/gateway.ts:346 does to a frame before it leaves the browser. */
function overTheWire(frame: unknown): CronJobPatch {
  return JSON.parse(JSON.stringify(frame)) as CronJobPatch;
}

/**
 * The `failureAlert` member of the patch `addCronJob()` sends, per value of the
 * UI's `failureAlertMode` dropdown. Mirrors `buildFailureAlert()` plus the
 * `job` literal at ui/src/ui/controllers/cron.ts:669-695.
 *
 * `editing` mirrors the `state.cronEditingJobId` branch: only the edit path has
 * an override to clear, so only it turns `undefined` into the `null` sentinel.
 * The add path must keep `undefined`, because the add schema has no null branch.
 */
function uiPatchFor(
  mode: "inherit" | "disabled" | "custom",
  editing: boolean,
): Record<string, unknown> {
  const builtFailureAlert =
    mode === "disabled"
      ? false
      : mode === "inherit"
        ? undefined
        : {
            after: 3,
            channel: "telegram",
            to: "123456",
            mode: "announce",
            accountId: "coordinator",
          };
  const failureAlert = editing && builtFailureAlert === undefined ? null : builtFailureAlert;
  return { name: "job-alert", enabled: true, failureAlert };
}

const lines: string[] = [];
const say = (s: string) => lines.push(s);

function apply(job: CronJob, patch: CronJobPatch): string {
  try {
    applyJobPatch(job, patch);
    return `job.failureAlert = ${JSON.stringify(job.failureAlert)}`;
  } catch (err) {
    return `THREW ${err instanceof Error ? err.message : String(err)}`;
  }
}

say("=== 0. what the wire does to the patch object ===");
for (const editing of [false, true] as const) {
  const label = editing ? "edit (cron.update)" : "add  (cron.add)   ";
  const raw = uiPatchFor("inherit", editing);
  say(`   ${label} in-process keys:                 ${JSON.stringify(Object.keys(raw))}`);
  say(`   ${label} after JSON.stringify:            ${JSON.stringify(raw)}`);
  say(`   ${label} 'failureAlert' in patch, server: ${"failureAlert" in overTheWire(raw)}`);
}

say("");
say("=== 1. each UI state, through the real merge ===");
say(`   starting job.failureAlert = ${JSON.stringify(EXISTING_ALERT)}`);
for (const editing of [false, true] as const) {
  const label = editing ? "edit (cron.update)" : "add  (cron.add)   ";
  for (const mode of ["inherit", "disabled", "custom"] as const) {
    const job = makeJob();
    const patch = overTheWire(uiPatchFor(mode, editing));
    say(
      `   ${label} mode=${mode.padEnd(8)} wire failureAlert=${JSON.stringify(patch.failureAlert)}`,
    );
    say(`     -> ${apply(job, patch)}`);
  }
}

say("");
say("=== 2. is ANY wire value able to mean 'back to inherit'? ===");
const candidates: Array<[string, unknown]> = [
  ["key absent (add path, inherit)", Symbol("absent")],
  ["null (edit path, inherit)", null],
  ["false", false],
  ["empty string", ""],
  ["empty object", {}],
];
for (const [label, value] of candidates) {
  const job = makeJob();
  const frame: Record<string, unknown> = { name: "job-alert", enabled: true };
  if (typeof value !== "symbol") {
    frame.failureAlert = value;
  }
  const outcome = apply(job, overTheWire(frame));
  const cleared = job.failureAlert === undefined;
  say(`   ${label.padEnd(32)} -> ${outcome}${cleared ? "   <== CLEARED" : ""}`);
}

say("");
say("=== verdict ===");
say("   EDIT path (the F-56 fix):");
say('     inherit  -> explicit `null` -> survives JSON.stringify -> `"failureAlert" in patch` is');
say("                 true -> mergeCronFailureAlert returns undefined -> override dropped. WORKS.");
say("     disabled -> `false` -> reaches the merge -> works.");
say("     custom   -> object -> reaches the merge -> works.");
say("   ADD path (unchanged, and must stay unchanged):");
say("     inherit  -> `undefined` -> key dropped by JSON.stringify -> the add schema never sees a");
say("                 `null` it would reject -> the new job simply has no override. CORRECT.");
say('   No other wire value clears the override: `""` and `{}` either fail the schema or merge to');
say("   a no-op, and `false` means 'suppress for this job', not 'inherit'.");
say("   See the F-56 doc, section 12.5b, for the subfield-level half that is still open.");

console.log(lines.join("\n"));
