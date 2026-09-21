import { applyJobPatch } from "../../src/cron/service/jobs.js";
import type { CronJob, CronJobPatch } from "../../src/cron/types.js";
/**
 * Read-only probe.
 *
 * Follow-up to cron-failure-alert-clear.probe.ts. That probe showed the UI cannot
 * express "failureAlert = inherit". This one asks the next question: when a client
 * tries to clear a failureAlert field, do the two server layers agree on what a
 * "clear" looks like?
 *
 *   layer 1: the gateway wire schema   src/gateway/protocol/schema/cron.ts
 *   layer 2: the merge                mergeCronFailureAlert in src/cron/service/jobs.ts
 *
 * Layer 2 already treats "" / 0 / negative as "clear this field". If layer 1 rejects
 * those exact values, the clear is unreachable over the gateway even though the merge
 * implements it -- and the client sees a loud INVALID_REQUEST, not a silent no-op.
 *
 * `null` is the supported clear for both the whole object and each subfield (added
 * 2026-09-21). Note the two probes answer different questions: this one is about what the
 * two SERVER layers agree on, while cron-failure-alert-subfield-clear.probe.ts covers the
 * client end -- where the failure was silent rather than loud, because the UI never sent
 * the empty values layer 1 rejects; it sent nothing at all.
 *
 * Nothing here writes to the store or to a running service.
 */
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

const lines: string[] = [];
const say = (s: string) => lines.push(s);

/**
 * What the gateway does before `context.cron.update()` sees the patch.
 * The envelope must be valid on its own, otherwise a REJECTED verdict could be
 * caused by the envelope rather than by the field under test.
 */
function wireVerdict(patch: unknown): { ok: boolean; detail: string } {
  const candidate = { jobId: "job-alert", patch };
  const ok = validateCronUpdateParams(candidate);
  if (ok) {
    return { ok, detail: "accepted" };
  }
  const errs = (validateCronUpdateParams.errors ?? [])
    .map((e) => `${e.instancePath || "/"} ${e.message ?? ""}`.trim())
    .join("; ");
  return { ok, detail: errs || "rejected" };
}

/** What the merge layer does once it is reached. */
function mergeVerdict(patch: unknown): string {
  const job = makeJob();
  try {
    applyJobPatch(job, patch as CronJobPatch);
    return JSON.stringify(job.failureAlert);
  } catch (err) {
    return `THREW ${err instanceof Error ? err.message : String(err)}`;
  }
}

const CASES: Array<[label: string, patch: Record<string, unknown>]> = [
  ["BASELINE after: 2 (must be ACCEPTED)", { failureAlert: { after: 2 } }],
  ["BASELINE enabled: true (must be ACCEPTED)", { enabled: true }],
  ["after: 0        (merge treats as clear)", { failureAlert: { after: 0 } }],
  ['channel: ""     (merge treats as clear)', { failureAlert: { channel: "" } }],
  ['to: ""          (merge treats as clear)', { failureAlert: { to: "" } }],
  ["cooldownMs: -1  (merge treats as clear)", { failureAlert: { cooldownMs: -1 } }],
  ['accountId: ""   (merge treats as clear)', { failureAlert: { accountId: "" } }],
  ["after: null     (the supported clear, added 09-21)", { failureAlert: { after: null } }],
  ["failureAlert: null  (sentinel added 09-21, F-56)", { failureAlert: null }],
  ["failureAlert: false (the one clear that works)", { failureAlert: false }],
  ["delivery.accountId: ''  (precedent #31075)", { delivery: { mode: "announce", accountId: "" } }],
];

say("=== layer 1 (AJV wire schema) vs layer 2 (merge) ===");
say("");
for (const [label, patch] of CASES) {
  const wire = wireVerdict(patch);
  say(`   ${label}`);
  say(`     wire  : ${wire.ok ? "ACCEPTED" : "REJECTED"}${wire.ok ? "" : ` -- ${wire.detail}`}`);
  say(`     merge : ${mergeVerdict(patch)}`);
  say("");
}

say("=== reading ===");
say('   The merge layer\'s own clear values for a subfield are `""`, `0` and negatives -- and');
say("   those are exactly the values the wire schema forbids (`after` is `minimum: 1`,");
say("   `accountId` is a non-empty string, `cooldownMs` is `minimum: 0`). So none of them");
say("   ever worked over the gateway; `to` was the lone exception, and only because the");
say("   schema types it as a plain string.");
say("");
say("   The supported way to clear a subfield is now `null` (row added 2026-09-21, closing");
say("   doc section 12.5b). It is deliberately NOT the same as sending an empty value: a");
say("   client says `null`, not something that merely looks blank. The `after: null` row");
say("   reads ACCEPTED + the field dropped from the merge output; before that change it read");
say("   REJECTED.");
say("");
say("   The `failureAlert: null` row is the whole-object sentinel from F-56. Before that");
say("   change it read `wire: REJECTED` + `merge: THREW`, because the patch schema had no");
say('   null branch and `"after" in null` is a TypeError. Re-running this probe is the');
say("   before/after check for that fix; the row flipping to ACCEPTED / undefined is the");
say("   whole point of it.");

console.log(lines.join("\n"));
