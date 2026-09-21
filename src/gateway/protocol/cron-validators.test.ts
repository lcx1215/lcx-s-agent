import { describe, expect, it } from "vitest";
import {
  validateCronAddParams,
  validateCronListParams,
  validateCronRemoveParams,
  validateCronRunParams,
  validateCronRunsParams,
  validateCronUpdateParams,
} from "./index.js";

const minimalAddParams = {
  name: "daily-summary",
  schedule: { kind: "every", everyMs: 60_000 },
  sessionTarget: "main",
  wakeMode: "next-heartbeat",
  payload: { kind: "systemEvent", text: "tick" },
} as const;

describe("cron protocol validators", () => {
  it("accepts minimal add params", () => {
    expect(validateCronAddParams(minimalAddParams)).toBe(true);
  });

  it("rejects add params when required scheduling fields are missing", () => {
    const { wakeMode: _wakeMode, ...withoutWakeMode } = minimalAddParams;
    expect(validateCronAddParams(withoutWakeMode)).toBe(false);
  });

  it("accepts update params for id and jobId selectors", () => {
    expect(validateCronUpdateParams({ id: "job-1", patch: { enabled: false } })).toBe(true);
    expect(validateCronUpdateParams({ jobId: "job-2", patch: { enabled: true } })).toBe(true);
  });

  it("accepts a null failureAlert in update patches so an override can be cleared", () => {
    expect(validateCronUpdateParams({ jobId: "job-1", patch: { failureAlert: null } })).toBe(true);
    expect(validateCronUpdateParams({ jobId: "job-1", patch: { failureAlert: false } })).toBe(true);
    expect(
      validateCronUpdateParams({
        jobId: "job-1",
        patch: { failureAlert: { after: 2, channel: "telegram" } },
      }),
    ).toBe(true);
  });

  it("rejects a null failureAlert on add, where there is no override to clear", () => {
    // The add schema is deliberately narrower than the patch schema: a brand new job has
    // nothing to clear, so `null` stays a patch-only sentinel. Asserting the `false`
    // branch here as well keeps this from being satisfied by an over-broad widening.
    expect(validateCronAddParams({ ...minimalAddParams, failureAlert: null })).toBe(false);
    expect(validateCronAddParams({ ...minimalAddParams, failureAlert: false })).toBe(true);
  });

  it("accepts a null failureAlert subfield in update patches so one override can be dropped", () => {
    // Each subfield can be cleared on its own, so a per-job override can fall back to the
    // global cron `failureAlert` config field by field instead of all at once.
    for (const subfield of ["after", "channel", "to", "cooldownMs", "mode", "accountId"]) {
      expect(
        validateCronUpdateParams({ jobId: "job-1", patch: { failureAlert: { [subfield]: null } } }),
        `failureAlert.${subfield}: null should be accepted`,
      ).toBe(true);
    }
  });

  it("still enforces the strict subfield types in update patches", () => {
    // Negative controls for the test above: without these, a schema widened to accept
    // anything at all would keep it green. `null` is the only added branch, and the
    // merge layer's own clear values ("", 0, a negative) are deliberately not accepted --
    // a client must say `null`, not a value that happens to look empty.
    expect(
      validateCronUpdateParams({ jobId: "job-1", patch: { failureAlert: { after: 0 } } }),
    ).toBe(false);
    expect(
      validateCronUpdateParams({ jobId: "job-1", patch: { failureAlert: { accountId: "" } } }),
    ).toBe(false);
    expect(
      validateCronUpdateParams({ jobId: "job-1", patch: { failureAlert: { cooldownMs: -1 } } }),
    ).toBe(false);
    expect(
      validateCronUpdateParams({ jobId: "job-1", patch: { failureAlert: { channel: "" } } }),
    ).toBe(false);
    expect(
      validateCronUpdateParams({ jobId: "job-1", patch: { failureAlert: { mode: "email" } } }),
    ).toBe(false);
  });

  it("rejects a null failureAlert subfield on add, where there is nothing to drop", () => {
    for (const subfield of ["after", "channel", "to", "cooldownMs", "mode", "accountId"]) {
      expect(
        validateCronAddParams({
          ...minimalAddParams,
          failureAlert: { [subfield]: null },
        }),
        `failureAlert.${subfield}: null should be rejected on add`,
      ).toBe(false);
    }
    // Same control as above: the real value must still be accepted on add.
    expect(
      validateCronAddParams({
        ...minimalAddParams,
        failureAlert: { after: 2, accountId: "bot-a" },
      }),
    ).toBe(true);
  });

  it("accepts remove params for id and jobId selectors", () => {
    expect(validateCronRemoveParams({ id: "job-1" })).toBe(true);
    expect(validateCronRemoveParams({ jobId: "job-2" })).toBe(true);
  });

  it("accepts run params mode for id and jobId selectors", () => {
    expect(validateCronRunParams({ id: "job-1", mode: "force" })).toBe(true);
    expect(validateCronRunParams({ jobId: "job-2", mode: "due" })).toBe(true);
  });

  it("accepts list paging/filter/sort params", () => {
    expect(
      validateCronListParams({
        includeDisabled: true,
        limit: 50,
        offset: 0,
        query: "daily",
        enabled: "all",
        sortBy: "nextRunAtMs",
        sortDir: "asc",
      }),
    ).toBe(true);
    expect(validateCronListParams({ offset: -1 })).toBe(false);
  });

  it("enforces runs limit minimum for id and jobId selectors", () => {
    expect(validateCronRunsParams({ id: "job-1", limit: 1 })).toBe(true);
    expect(validateCronRunsParams({ jobId: "job-2", limit: 1 })).toBe(true);
    expect(validateCronRunsParams({ id: "job-1", limit: 0 })).toBe(false);
    expect(validateCronRunsParams({ jobId: "job-2", limit: 0 })).toBe(false);
  });

  it("rejects cron.runs path traversal ids", () => {
    expect(validateCronRunsParams({ id: "../job-1" })).toBe(false);
    expect(validateCronRunsParams({ id: "nested/job-1" })).toBe(false);
    expect(validateCronRunsParams({ jobId: "..\\job-2" })).toBe(false);
    expect(validateCronRunsParams({ jobId: "nested\\job-2" })).toBe(false);
  });

  it("accepts runs paging/filter/sort params", () => {
    expect(
      validateCronRunsParams({
        id: "job-1",
        limit: 50,
        offset: 0,
        status: "error",
        query: "timeout",
        sortDir: "desc",
      }),
    ).toBe(true);
    expect(validateCronRunsParams({ id: "job-1", offset: -1 })).toBe(false);
  });

  it("accepts all-scope runs with multi-select filters", () => {
    expect(
      validateCronRunsParams({
        scope: "all",
        limit: 25,
        statuses: ["ok", "error"],
        deliveryStatuses: ["delivered", "not-requested"],
        query: "fail",
        sortDir: "desc",
      }),
    ).toBe(true);
    expect(
      validateCronRunsParams({
        scope: "job",
        statuses: [],
      }),
    ).toBe(false);
  });
});
