import { describe, expect, it } from "vitest";
import { evaluateAgentSystemLoop } from "../scripts/operator/agent-system-loop-smoke.js";

describe("agent-system-loop-smoke result contract", () => {
  it("blocks when a required check is skipped", () => {
    expect(
      evaluateAgentSystemLoop([
        { ok: true, skipped: false },
        { ok: false, skipped: true },
      ]),
    ).toEqual({
      ok: false,
      status: "blocked",
      skippedCheckCount: 1,
      failedCheckCount: 1,
    });
  });

  it("fails when a required check runs and fails", () => {
    expect(
      evaluateAgentSystemLoop([
        { ok: true, skipped: false },
        { ok: false, skipped: false },
      ]),
    ).toEqual({
      ok: false,
      status: "failed",
      skippedCheckCount: 0,
      failedCheckCount: 1,
    });
  });

  it("passes only when every required check ran successfully", () => {
    expect(evaluateAgentSystemLoop([{ ok: true, skipped: false }])).toEqual({
      ok: true,
      status: "passed",
      skippedCheckCount: 0,
      failedCheckCount: 0,
    });
  });
});
