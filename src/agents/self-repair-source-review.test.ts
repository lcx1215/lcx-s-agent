import { describe, expect, it } from "vitest";
import {
  SELF_REPAIR_SOURCE_FRESHNESS_MS,
  readSelfRepairReplacementRule,
  verifySelfRepairSourceContent,
} from "./self-repair-source-review.js";

describe("original correction source consistency boundary", () => {
  it.each([
    "single line",
    " first line  \n  second line\n\nthird line  \n",
    "first\n\n## Downrank Decision\nthis is rule content\n\n## Replacement Rule\n- still rule content",
  ])("reads the whole declared field exactly: %j", (rule) => {
    const body = `# Original\n\n## Replacement Rule\n- ${rule}\n\n## Downrank Decision\n- keep_downrank_or_discard: downrank\n`;
    expect(readSelfRepairReplacementRule(body, rule)).toBe(rule);
    expect(readSelfRepairReplacementRule(body.replace(rule, `${rule} extra`), rule)).not.toBe(rule);
  });
  it("rejects matching first line with an extra unreviewed continuation", () => {
    expect(
      readSelfRepairReplacementRule(
        "# Original\n\n## Replacement Rule\n- first\nother content\n\n## Downrank Decision\n- downrank\n",
        "first",
      ),
    ).toBeUndefined();
  });
  const nowMs = Date.parse("2026-10-11T00:00:00Z");
  const source = {
    scope: { accountId: "private-paper", runId: "private-run" },
    observedAt: new Date(nowMs - 1000).toISOString(),
    replacementRule: "require a current source",
  };
  const input = {
    source,
    accountId: "private-paper",
    runId: "private-run",
    replacementRule: source.replacementRule,
    nowMs,
  };
  it("shares exact scope, freshness and replacement consistency without declaring trust", () => {
    expect(verifySelfRepairSourceContent(input)).toEqual({
      ok: true,
      observedAt: source.observedAt,
    });
  });
  it.each([
    [undefined, "correction_source_scope_mismatch"],
    [
      { ...source, scope: { accountId: "other", runId: "private-run" } },
      "correction_source_scope_mismatch",
    ],
    [{ ...source, observedAt: new Date(nowMs + 1).toISOString() }, "correction_source_not_fresh"],
    [
      {
        ...source,
        observedAt: new Date(nowMs - SELF_REPAIR_SOURCE_FRESHNESS_MS - 1).toISOString(),
      },
      "correction_source_not_fresh",
    ],
    [
      { ...source, replacementRule: "contradiction" },
      "correction_replacement_rule_source_mismatch",
    ],
  ])("rejects inconsistent source %j", (changedSource, reason) => {
    expect(verifySelfRepairSourceContent({ ...input, source: changedSource })).toEqual({
      ok: false,
      reason,
    });
  });
  it("does not infer host identity from empty scope", () => {
    expect(verifySelfRepairSourceContent({ ...input, accountId: undefined })).toMatchObject({
      ok: false,
      reason: "correction_source_scope_mismatch",
    });
  });
});
