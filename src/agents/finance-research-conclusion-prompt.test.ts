import { describe, expect, it } from "vitest";
import {
  buildFinanceConclusionPrompt,
  extractFinanceConclusionJson,
} from "./finance-research-conclusion-prompt.js";

const sources = [
  { sourceId: "sec-edgar", description: "SEC filings" },
  { sourceId: "alpha-vantage-news-sentiment", description: "News sentiment" },
];

describe("buildFinanceConclusionPrompt", () => {
  it("lists only the sources that exist, so the model cannot invent one", () => {
    const prompt = buildFinanceConclusionPrompt({
      instrument: "AAPL",
      assetClass: "us_equity",
      availableSources: sources,
    });
    expect(prompt).toContain("sec-edgar");
    expect(prompt).toContain("alpha-vantage-news-sentiment");
    expect(prompt).toContain("do not invent others");
  });

  it("tells the model that a hold is free and a guess is not", () => {
    const prompt = buildFinanceConclusionPrompt({
      instrument: "AAPL",
      assetClass: "us_equity",
      availableSources: sources,
    });
    expect(prompt).toContain("hold");
    expect(prompt.toLowerCase()).toContain("a guess becomes a trade");
  });

  it("requires two distinct sources explicitly", () => {
    const prompt = buildFinanceConclusionPrompt({
      instrument: "AAPL",
      assetClass: "us_equity",
      availableSources: sources,
    });
    expect(prompt).toContain("at least two DISTINCT sourceId");
  });

  it("warns against importing optimism into conviction", () => {
    const prompt = buildFinanceConclusionPrompt({
      instrument: "AAPL",
      assetClass: "us_equity",
      availableSources: sources,
    });
    expect(prompt).toContain("do not write 0.9");
  });
});

describe("extractFinanceConclusionJson", () => {
  const object = { direction: "buy", conviction: 0.5, nested: { a: 1 } };

  it("reads a fenced code block", () => {
    const text = "Here you go:\n```json\n" + JSON.stringify(object) + "\n```\nDone.";
    expect(extractFinanceConclusionJson(text)).toEqual(object);
  });

  it("reads a bare object among prose", () => {
    const text = "I think: " + JSON.stringify(object) + " hope that helps";
    expect(extractFinanceConclusionJson(text)).toEqual(object);
  });

  it("keeps nested objects intact rather than cutting at the first brace", () => {
    const text = "```" + JSON.stringify(object) + "```";
    expect(extractFinanceConclusionJson(text)).toEqual(object);
  });

  it("ignores braces inside strings", () => {
    const text = '{"thesis":"uses { and } literally","direction":"hold"}';
    const parsed = extractFinanceConclusionJson(text) as { thesis: string };
    expect(parsed.thesis).toBe("uses { and } literally");
  });

  it("returns null instead of throwing when there is no object", () => {
    expect(extractFinanceConclusionJson("I have no conclusion.")).toBeNull();
  });

  it("returns null on truncated json rather than guessing", () => {
    expect(extractFinanceConclusionJson('{"direction":"buy"')).toBeNull();
  });
});
