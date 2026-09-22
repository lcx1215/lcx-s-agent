import { describe, expect, it } from "vitest";
import { proposeTuning } from "./finance-tuning-proposal.js";

/**
 * The proposal layer exists to close a loop without closing it too far: it may
 * propose, it may never apply. Its tests are mostly about what it declines to
 * say, because proposing from too little data is the failure that looks like
 * progress.
 */

function samples(n: number, conviction: number, outcome: 0 | 1) {
  return Array.from({ length: n }, () => ({ conviction, outcome }));
}

describe("finance tuning proposal", () => {
  it("proposes nothing below the sample threshold, and says why", () => {
    const result = proposeTuning({
      samples: samples(5, 0.7, 1),
      currentFloor: 0.6,
      minSamples: 30,
    });
    expect(result.proposals).toEqual([]);
    expect(result.basis).toContain("below the 30");
    expect(result.basis).toContain("noise");
  });

  it("proposes nothing when no conviction level has demonstrated break-even", () => {
    // Losing at every level. A coin-flip would still meet the default break-even
    // line of 0.5, so the case that must produce no floor is a signal that loses.
    const losing = [...samples(12, 0.7, 1), ...samples(28, 0.7, 0)];
    const result = proposeTuning({ samples: losing, currentFloor: 0.6, minSamples: 30 });
    expect(result.proposals).toEqual([]);
    expect(result.basis).toContain("no conviction level");
  });

  it("proposes nothing when the derived floor already equals the current one", () => {
    const result = proposeTuning({
      samples: samples(40, 0.6, 1),
      currentFloor: 0.6,
      minSamples: 30,
    });
    expect(result.proposals).toEqual([]);
    expect(result.basis).toContain("nothing to change");
  });

  it("proposes a change only when the evidence supports one", () => {
    const result = proposeTuning({
      samples: samples(40, 0.7, 1),
      currentFloor: 0.9,
      minSamples: 30,
    });
    expect(result.proposals).toHaveLength(1);
    const proposal = result.proposals[0];
    expect(proposal.knob).toBe("convictionFloor");
    expect(proposal.status).toBe("proposed");
    // Evidence must be re-derivable, so it names the counts it used.
    expect(proposal.evidence).toContain("40 settled calls");
    expect(proposal.sampleCount).toBe(40);
    expect(proposal.applyWith).toContain("deterministic paper-promotion");
  });

  it("always reports status proposed - it never applies anything", () => {
    const result = proposeTuning({
      samples: samples(40, 0.7, 1),
      currentFloor: 0.9,
      minSamples: 30,
    });
    for (const proposal of result.proposals) {
      expect(proposal.status).toBe("proposed");
    }
  });

  it("grades confidence by how much evidence there is", () => {
    const weak = proposeTuning({ samples: samples(31, 0.7, 1), currentFloor: 0.9, minSamples: 30 });
    expect(weak.proposals[0]?.confidence).toBe("weak");
    const strong = proposeTuning({
      samples: samples(120, 0.7, 1),
      currentFloor: 0.9,
      minSamples: 30,
    });
    expect(strong.proposals[0]?.confidence).toBe("strong");
  });
});
