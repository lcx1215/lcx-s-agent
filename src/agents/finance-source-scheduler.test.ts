import { expect, it } from "vitest";
import { financeProviderId, mapFinanceSourceLanes } from "./finance-source-scheduler.js";

it("lets an independent provider progress while preserving one lane for shared quota aliases", async () => {
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started: string[] = [];
  const sources = ["twelve_data_quote", "twelve_data_history", "finnhub_quote"].map((id) => ({
    id,
  }));
  const pending = mapFinanceSourceLanes(
    sources,
    async ({ id }) => {
      started.push(id);
      if (id === "twelve_data_quote") {
        await blocked;
      }
      return id;
    },
    2,
  );
  await Promise.resolve();
  expect(started).toEqual(["twelve_data_quote", "finnhub_quote"]);
  release();
  expect(await pending).toEqual(sources.map((source) => source.id));
  expect(started.at(-1)).toBe("twelve_data_history");
});

it("limits active provider lanes and waits for owned work on an unexpected error", async () => {
  let finished = false;
  const pending = mapFinanceSourceLanes(
    [{ id: "fmp_quote" }, { id: "fred_series" }],
    async ({ id }) => {
      if (id.startsWith("fmp")) {
        throw new Error("adapter failure");
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
      finished = true;
    },
  );
  await expect(pending).rejects.toThrow("adapter failure");
  expect(finished).toBe(true);
  await expect(mapFinanceSourceLanes([], async () => {}, 0)).rejects.toThrow("concurrency");
  expect(financeProviderId("alpha_vantage_macro_series")).toBe("alpha_vantage");
});
