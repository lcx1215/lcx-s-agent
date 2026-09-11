import { describe, expect, it } from "vitest";
import { assessFinanceNewsEntity, financeNewsQuery } from "./finance-news-entity.js";

describe("finance headline entity evidence", () => {
  it.each([
    ["SPY", "Kevin Hart spy movie opens this week"],
    ["GLD", "How we improved our GLD score in three years"],
    ["AAPL", "Live AAPL price chart, swap on USDT"],
  ])("excludes observed symbol collisions without dropping raw records: %s", (symbol, title) => {
    expect(assessFinanceNewsEntity(symbol, { title }).status).toBe("excluded");
  });
  it.each([
    ["SPY", "SPY ETF outperforms small caps"],
    ["AAPL", "Apple unveils a new iPhone"],
    ["NVDA", "Nvidia announces new chips"],
  ])("requires an entity and usable context: %s", (symbol, title) => {
    expect(assessFinanceNewsEntity(symbol, { title }).status).toBe("matched");
  });
  it("does not infer Nvidia relevance from its RSS subscription", () => {
    expect(assessFinanceNewsEntity("NVDA", { title: "Why restaurant shares rallied" }).status).toBe(
      "unverified",
    );
  });
  it("does not equate a common word with an issuer", () => {
    expect(assessFinanceNewsEntity("AAPL", { title: "An apple a day" }).status).toBe("unverified");
  });
  it("searches ticker plus issuer and financial context", () => {
    expect(financeNewsQuery("SPY")).toContain('"SPDR S&P 500"');
    expect(financeNewsQuery("SPY")).toContain("ETF");
  });
});
