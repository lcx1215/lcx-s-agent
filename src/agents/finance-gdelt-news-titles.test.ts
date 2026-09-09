import { describe, expect, it } from "vitest";
import { createGdeltNewsTitlesAdapter } from "./finance-gdelt-news-titles.js";

const request = {
  instrument: "AAPL",
  seriesId: "Apple",
  assetClass: "us_equity",
  collection: "news" as const,
  asOf: "2026-09-09T03:22:00Z",
  limit: 5,
};
const signal = new AbortController().signal;

describe("GDELT title sample", () => {
  it("uses only published-minute paths, deduplicates URLs and excludes future/nonmatching records", async () => {
    const urls: string[] = [];
    const adapter = createGdeltNewsTitlesAdapter({
      fetchImpl: async (url) => {
        urls.push(url);
        return {
          ok: true,
          status: 200,
          text: async () =>
            [
              {
                ID: 1,
                title: "Apple launches phone",
                url: "https://news.test/apple",
                date: "2026-09-09T03:16:00Z",
              },
              {
                ID: 2,
                title: "Pineapple exports",
                url: "https://news.test/pineapple",
                date: "2026-09-09T03:16:00Z",
              },
              {
                ID: 3,
                title: "Apple future",
                url: "https://news.test/future",
                date: "2026-09-10T03:16:00Z",
              },
              {
                ID: 4,
                title: "Apple invalid",
                url: "javascript:alert(1)",
                date: "2026-09-09T03:16:00Z",
              },
            ]
              .map((row) => JSON.stringify(row))
              .join("\n"),
        };
      },
    });
    const records = await adapter.collect(request, signal);
    expect(urls.map((url) => url.split("/").at(-1))).toEqual([
      "20260909031600.toc.json.gz",
      "20260909031700.toc.json.gz",
    ]);
    expect(records).toHaveLength(1);
    expect(records[0].data).toMatchObject({
      coverage: "two_minute_title_sample_not_fulltext_search",
      fullTextSearched: false,
      query: "apple",
    });
    expect(records[0].data.scannedFiles).toHaveLength(2);
  });

  it("retains missing-file coverage without relabeling the sample as complete", async () => {
    let calls = 0;
    const adapter = createGdeltNewsTitlesAdapter({
      fetchImpl: async () =>
        ++calls === 1
          ? { ok: false, status: 404, text: async () => "not published" }
          : {
              ok: true,
              status: 200,
              text: async () =>
                JSON.stringify({
                  ID: 1,
                  title: "Apple news",
                  url: "https://news.test/apple",
                  date: "2026-09-09T03:17:00Z",
                }),
            },
    });
    const records = await adapter.collect(request, signal);
    expect(records[0].data.scannedFiles).toEqual([
      expect.objectContaining({ status: "not_published" }),
      expect.objectContaining({ status: "loaded" }),
    ]);
  });

  it("does not treat an empty sample as proof of no news", async () => {
    const adapter = createGdeltNewsTitlesAdapter({
      fetchImpl: async () => ({ ok: true, status: 200, text: async () => "" }),
    });
    await expect(adapter.collect(request, signal)).rejects.toThrow("does not establish absence");
  });
});

it("does not fetch a title file after cancellation", async () => {
  let calls = 0;
  const controller = new AbortController();
  controller.abort();
  const adapter = createGdeltNewsTitlesAdapter({
    fetchImpl: async () => {
      calls++;
      return { ok: true, status: 200, text: async () => "" };
    },
  });
  await expect(adapter.collect(request, controller.signal)).rejects.toMatchObject({
    kind: "cancelled",
  });
  expect(calls).toBe(0);
});
