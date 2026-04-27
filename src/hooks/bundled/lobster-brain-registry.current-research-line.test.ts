import { describe, expect, it } from "vitest";
import { parseCurrentResearchLineArtifact } from "./lobster-brain-registry.js";

describe("parseCurrentResearchLineArtifact", () => {
  it("parses the legacy current-research-line anchor contract", () => {
    const parsed = parseCurrentResearchLineArtifact(`# Current Research Line

current_focus: holdings_thesis_revalidation
top_decision: re-check whether the old thesis still survives
current_session_summary: focusing the current session on old-thesis survival instead of a fresh stance
next_step: retrieve the old thesis and latest invalidation evidence before writing any stance
guardrail: research-only memory; no execution-first behavior
memory_state_contract: verified supports current decisions; provisional requires fresh re-check; stale is drill-down only until re-verified
`);

    expect(parsed).toEqual({
      updatedAt: undefined,
      currentFocus: "holdings_thesis_revalidation",
      lineStatus: "active",
      topDecision: "re-check whether the old thesis still survives",
      currentSessionSummary:
        "focusing the current session on old-thesis survival instead of a fresh stance",
      latestReviewMemoState: undefined,
      latestFollowUpState: undefined,
      nextStep:
        "retrieve the old thesis and latest invalidation evidence before writing any stance",
      researchGuardrail: "research-only memory; no execution-first behavior",
      memoryStateContract:
        "verified supports current decisions; provisional requires fresh re-check; stale is drill-down only until re-verified",
      freshness: undefined,
      primaryAnchor: undefined,
      anchorDate: undefined,
      drillDownOnlyBefore: undefined,
      currentSession: {
        source: undefined,
        sessionId: undefined,
        intake: undefined,
      },
    });
  });

  it("parses the operating-loop protected summary form", () => {
    const parsed =
      parseCurrentResearchLineArtifact(`<!-- operating-loop-write-guard: {"generation":1742040000000,"producedAt":"2026-03-15T12:00:00.000Z","sourceRunId":"agent:main:main:session:reset:2026-03-15T12:00:00.000Z"} -->
# Current Research Line

- updated_at: 2026-03-15T12:00:00.000Z
- current_focus: fundamental_follow_up
- line_status: active
- top_decision: ready_for_risk_review: AAPL
- current_session_summary: cli: Summarize today's operating loop before reset
- latest_review_memo_state: follow_up_collection_needed
- latest_follow_up_state: follow_up_active
- next_step: AAPL: repair metadata sidecars
- research_guardrail: research-first operating memory only; this is not an execution approval surface
- memory_state_contract: verified supports current decisions; provisional requires fresh re-check; stale is drill-down only until re-verified

## Current Session
- source: cli
- session_id: active-session
- intake: Summarize today's operating loop before reset

## Working Memory Discipline
- freshness: fresh
- primary_anchor: fundamental-collection-follow-up-tracker
- anchor_date: 2026-03-15
- drill_down_only_before: 2026-03-01

## Next Step
- AAPL: repair metadata sidecars

## Guardrails
- research-first operating memory only; this is not an execution approval surface
`);

    expect(parsed).toEqual({
      updatedAt: "2026-03-15T12:00:00.000Z",
      currentFocus: "fundamental_follow_up",
      lineStatus: "active",
      topDecision: "ready_for_risk_review: AAPL",
      currentSessionSummary: "cli: Summarize today's operating loop before reset",
      latestReviewMemoState: "follow_up_collection_needed",
      latestFollowUpState: "follow_up_active",
      nextStep: "AAPL: repair metadata sidecars",
      researchGuardrail:
        "research-first operating memory only; this is not an execution approval surface",
      memoryStateContract:
        "verified supports current decisions; provisional requires fresh re-check; stale is drill-down only until re-verified",
      freshness: "fresh",
      primaryAnchor: "fundamental-collection-follow-up-tracker",
      anchorDate: "2026-03-15",
      drillDownOnlyBefore: "2026-03-01",
      currentSession: {
        source: "cli",
        sessionId: "active-session",
        intake: "Summarize today's operating loop before reset",
      },
    });
  });

  it("fails closed on malformed current-research-line content", () => {
    expect(parseCurrentResearchLineArtifact("# Current Research Line\n")).toBeUndefined();
    expect(parseCurrentResearchLineArtifact("# Not Current Research Line\n")).toBeUndefined();
    expect(
      parseCurrentResearchLineArtifact(`# Current Research Line

current_focus: macro_watch
line_status: drifting
top_decision: do not reopen the old line yet
next_step: wait for a real catalyst
research_guardrail: research-only
`),
    ).toBeUndefined();
  });
});
