/**
 * Read-only probe.
 *
 * F-56 closed the whole-object half: `failureAlert: null` now means "drop the per-job
 * override". This probe covers the half that was left open (doc section 12.5b): clearing
 * an INDIVIDUAL subfield (`after` / `cooldownMs` / `to` / `accountId`) from the UI edit
 * form.
 *
 * Three layers were involved and they disagreed:
 *
 *   UI    ui/src/ui/controllers/cron.ts  buildFailureAlert()
 *         emitted `undefined` for a cleared field, and `JSON.stringify` drops undefined
 *         values before the frame leaves the browser, so the key never reached the server.
 *   wire  src/gateway/protocol/schema/cron.ts
 *         the patch schema typed `after` as `minimum: 1` and `accountId` as a non-empty
 *         string, so the merge layer's own clear values ("", 0) were rejected outright.
 *   merge src/cron/service/jobs.ts  mergeCronFailureAlert()
 *         clears a subfield only when the KEY IS PRESENT with an empty/zero value
 *         (`if ("after" in patch)`). An absent key means "this patch does not touch it".
 *
 * The failure was silent, not loud: the UI's edit payload was fully legal, the wire
 * ACCEPTED it, and the merge simply kept the stale value.
 *
 * The fix added `null` as a per-subfield clear sentinel to the patch-only schema and made
 * the UI and the CLI send it. The merge needed no change -- see the note on
 * `mergeCronFailureAlert`. This probe keeps both the pre-fix and post-fix UI payloads so a
 * single run is the before/after evidence.
 *
 * Nothing here writes to the store or to a running service.
 */
import { applyJobPatch } from "../../src/cron/service/jobs.js";
import type { CronJob, CronJobPatch } from "../../src/cron/types.js";
import { validateCronUpdateParams } from "../../src/gateway/protocol/index.js";

const EXISTING_ALERT = {
  after: 3,
  channel: "telegram",
  to: "123456",
  cooldownMs: 120_000,
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

/**
 * Mirrors `buildFailureAlert()` in the UI controller for `failureAlertMode === "custom"`
 * with every optional field left blank, followed by the `JSON.stringify` hop that the
 * real frame takes. Kept as a literal rather than imported because the controller's
 * builder is not exported; the UI-side tests in `ui/src/ui/controllers/cron.test.ts` are
 * what pin the real builder's output.
 *
 * Both the pre-fix and post-fix shapes are listed so one run shows the whole story: the
 * first is what the edit form used to send, the second is what it sends now.
 */
const UI_EDIT_PAYLOAD_BEFORE_FIX = JSON.parse(
  JSON.stringify({
    failureAlert: {
      after: undefined, // `after > 0 ? Math.floor(after) : undefined`
      channel: "last", // `... || CRON_CHANNEL_LAST` -- the select always yields a value
      to: undefined, // `... || undefined`
      // cooldownMs was omitted entirely when blank (the builder spread it in conditionally)
      mode: "announce", // sent whenever the select has a value
      accountId: undefined, // `accountId || undefined`
    },
  }),
) as Record<string, unknown>;

/**
 * The edit form now sends `null` for a blank optional subfield, and nothing else changes.
 * `channel` / `mode` are absent here because their controls always carry a value, so the
 * form has no "unset" gesture for them -- see the builder's own comment.
 */
const UI_EDIT_PAYLOAD_AFTER_FIX = JSON.parse(
  JSON.stringify({
    failureAlert: {
      after: null,
      channel: "last",
      to: null,
      cooldownMs: null,
      mode: "announce",
      accountId: null,
    },
  }),
) as Record<string, unknown>;

const lines: string[] = [];
const say = (s: string) => lines.push(s);

function wireVerdict(patch: unknown): { ok: boolean; detail: string } {
  const ok = validateCronUpdateParams({ jobId: "job-alert", patch });
  if (ok) {
    return { ok, detail: "accepted" };
  }
  const errs = (validateCronUpdateParams.errors ?? [])
    .map((e) => `${e.instancePath || "/"} ${e.message ?? ""}`.trim())
    .filter((s) => !/required property 'id'/.test(s))
    .join("; ");
  return { ok, detail: errs || "rejected" };
}

function mergeVerdict(patch: unknown): string {
  const job = makeJob();
  try {
    applyJobPatch(job, patch as CronJobPatch);
    return JSON.stringify(job.failureAlert);
  } catch (err) {
    return `THREW ${err instanceof Error ? err.message : String(err)}`;
  }
}

/** Which of the four cleared subfields survived the round trip. */
function survivors(patch: unknown): string[] {
  const job = makeJob();
  try {
    applyJobPatch(job, patch as CronJobPatch);
  } catch {
    return ["<patch threw>"];
  }
  const alert = job.failureAlert;
  if (!alert || typeof alert !== "object") {
    return [];
  }
  const kept: string[] = [];
  if (typeof alert.after === "number") {
    kept.push(`after=${alert.after}`);
  }
  if (typeof alert.cooldownMs === "number") {
    kept.push(`cooldownMs=${alert.cooldownMs}`);
  }
  if (typeof alert.to === "string") {
    kept.push(`to=${alert.to}`);
  }
  if (typeof alert.accountId === "string") {
    kept.push(`accountId=${alert.accountId}`);
  }
  return kept;
}

const CASES: Array<[label: string, patch: Record<string, unknown>]> = [
  ["UI edit payload BEFORE the fix (blank -> undefined, key dropped)", UI_EDIT_PAYLOAD_BEFORE_FIX],
  ["UI edit payload AFTER the fix (blank -> null)", UI_EDIT_PAYLOAD_AFTER_FIX],
  ["hand-written: after: null", { failureAlert: { after: null } }],
  ["hand-written: cooldownMs: null", { failureAlert: { cooldownMs: null } }],
  ["hand-written: to: null", { failureAlert: { to: null } }],
  ["hand-written: accountId: null", { failureAlert: { accountId: null } }],
  [
    "hand-written: all four null at once",
    {
      failureAlert: { after: null, cooldownMs: null, to: null, accountId: null },
    },
  ],
  ["control: real values still accepted", { failureAlert: { after: 5, accountId: "ops" } }],
  ["control: whole-object null still clears everything", { failureAlert: null }],
];

say("=== clearing a failureAlert SUBFIELD from the edit form ===");
say("");
say(`   job before: ${JSON.stringify(EXISTING_ALERT)}`);
say("");
for (const [label, patch] of CASES) {
  const wire = wireVerdict(patch);
  say(`   ${label}`);
  say(`     sent  : ${JSON.stringify(patch)}`);
  say(`     wire  : ${wire.ok ? "ACCEPTED" : "REJECTED"}${wire.ok ? "" : ` -- ${wire.detail}`}`);
  say(`     merge : ${mergeVerdict(patch)}`);
  const kept = survivors(patch);
  say(`     stale : ${kept.length > 0 ? `STILL SET -> ${kept.join(", ")}` : "none (cleared)"}`);
  say("");
}

say("=== reading ===");
say("   A cleared field is only really cleared when the key arrives carrying a value the");
say('   merge reads as "clear". That is what `null` now does, at both levels: the whole');
say("   object (`failureAlert: null`, F-56) and each subfield (this change).");
say("");
say("   The BEFORE row is kept as the before/after reference: it is the payload the edit");
say("   form used to send, and it is still ACCEPTED by the wire while silently keeping");
say("   every stale value. That is why the defect was invisible -- there was no error to");
say("   notice, only an edit that did nothing. The AFTER row is the same edit today.");
say("");
say("   Note that the merge layer needed no change at all: its per-subfield coercion");
say("   already reads a non-matching value as the clear value, and `null` is neither a");
say("   number nor a string. What was missing was the wire accepting `null` and the client");
say("   sending it. Re-running this probe is the before/after check for both.");
say("");
say("   The two control rows must stay unchanged across the fix: real values are still");
say("   accepted, and the whole-object `null` still clears everything.");
say("");
say("   Still not expressible, deliberately: `channel` and `mode` have no blank state in");
say("   the form (both controls always carry a value), so the form never sends `null` for");
say("   them even though the patch schema now accepts it.");

console.log(lines.join("\n"));
