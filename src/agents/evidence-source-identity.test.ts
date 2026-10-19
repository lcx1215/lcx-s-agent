import { describe, expect, it } from "vitest";
import { evidenceSourceIdentity, inspectEvidenceMultiplicity } from "./evidence-source-identity.js";

describe("evidence multiplicity", () => {
  it("ignores tracking but preserves document-selecting parameters", () => {
    expect(
      evidenceSourceIdentity("https://example.org/a?id=1&utm_source=x&utm_medium=y&gclid=z#part"),
    ).toBe("https://example.org/a?id=1");
    expect(evidenceSourceIdentity("https://example.org/a?id=2")).not.toBe(
      evidenceSourceIdentity("https://example.org/a?id=1"),
    );
  });
  it("groups transitive copies without claiming independent sources or dropping contrary text", () => {
    const input = [
      { id: "a", text: "same report", source: "https://one.test/a" },
      { id: "b", text: "same  report", source: "https://two.test/b" },
      { id: "c", text: "correction: report withdrawn", source: "https://two.test/b?utm_source=x" },
      { id: "d", text: "a distinct statement", source: "collector" },
      { id: "e", text: "another distinct statement", source: "collector" },
    ];
    expect(inspectEvidenceMultiplicity(input)).toMatchObject({
      inputCount: 5,
      distinctPacketGroups: 3,
      duplicateGroups: [["a", "b", "c"]],
      independentSourceCount: null,
      upstreamLineage: "not_assessed",
      semanticTruth: "not_assessed",
    });
    expect(input[2].text).toBe("correction: report withdrawn");
  });
});
