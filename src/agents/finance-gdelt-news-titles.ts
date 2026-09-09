import { createHash } from "node:crypto";
import { ApiCallError } from "./api-call-contract.js";
import { resolveFinanceGzipTextFetch, type FetchImpl } from "./finance-live-market-source.js";
import type {
  FinanceMarketCollectionAdapter,
  FinanceMarketCollectionItem,
} from "./finance-market-collection-registry.js";

const MINUTE = 60_000;
const normalizedWords = (text: string) =>
  text
    .toLowerCase()
    .match(/[\p{L}\p{N}]+/gu)
    ?.join(" ") ?? "";

/** Official DOC alternative; searches titles in two published minutes, never article fulltext. */
export function createGdeltNewsTitlesAdapter(
  options: { fetchImpl?: FetchImpl } = {},
): FinanceMarketCollectionAdapter {
  return {
    id: "gdelt_public_news_titles",
    providerName: "gdelt-public-news-titles",
    providerRole: "cross_check_market_data",
    priority: 32,
    sampleRequest: {
      instrument: "AAPL",
      assetClass: "us_equity",
      collection: "news",
      seriesId: "Apple",
    },
    supports: (request) => request.collection === "news",
    collect: async (request, signal) => {
      const asOf = Date.parse(request.asOf);
      if (!Number.isFinite(asOf)) {
        throw new Error("GDELT titles requires a valid asOf");
      }
      const query = normalizedWords(request.seriesId?.trim() || request.instrument);
      if (!query || query.length > 128) {
        throw new Error("GDELT titles requires a bounded keyword");
      }
      // Keep both sampled minutes at least five minutes behind the request time.
      const base = Math.floor((asOf - 7 * MINUTE) / (15 * MINUTE)) * 15 * MINUTE;
      const scannedFiles: {
        url: string;
        status: "loaded" | "not_published";
        sha256?: string;
        documentCount?: number;
      }[] = [];
      const records: FinanceMarketCollectionItem[] = [];
      const seen = new Set<string>();
      for (const offset of [1, 2]) {
        const stamp =
          new Date(base + offset * MINUTE)
            .toISOString()
            .replace(/[-:TZ.]/gu, "")
            .slice(0, 12) + "00";
        const sourceUrlOrArtifact = `https://data.gdeltproject.org/gdeltv5/weblegacy/ngrams/${stamp}.toc.json.gz`;
        let body: string;
        try {
          const response = await resolveFinanceGzipTextFetch(options.fetchImpl)(
            sourceUrlOrArtifact,
            { signal },
          );
          body = await response.text();
        } catch (error) {
          if (error instanceof ApiCallError && error.httpStatus === 404) {
            scannedFiles.push({ url: sourceUrlOrArtifact, status: "not_published" });
            continue;
          }
          throw error;
        }
        const lines = body.trim().split(/\r?\n/u).filter(Boolean);
        const sha256 = createHash("sha256").update(body).digest("hex");
        scannedFiles.push({
          url: sourceUrlOrArtifact,
          status: "loaded",
          sha256,
          documentCount: lines.length,
        });
        for (const line of lines) {
          const row = JSON.parse(line) as Record<string, unknown> | null;
          if (
            !row ||
            typeof row.title !== "string" ||
            typeof row.url !== "string" ||
            typeof row.date !== "string"
          ) {
            continue;
          }
          const time = Date.parse(row.date);
          if (
            !Number.isFinite(time) ||
            time > asOf ||
            !/^https?:\/\//iu.test(row.url) ||
            seen.has(row.url)
          ) {
            continue;
          }
          const date = new Date(time).toISOString();
          if (
            (request.fromDate && date.slice(0, 10) < request.fromDate) ||
            (request.toDate && date.slice(0, 10) > request.toDate)
          ) {
            continue;
          }
          if (!` ${normalizedWords(row.title)} `.includes(` ${query} `)) {
            continue;
          }
          seen.add(row.url);
          records.push({
            itemId: `gdelt-title:${stamp}:${String(row.ID)}`,
            collection: "news",
            providerName: "gdelt-public-news-titles",
            providerRole: "cross_check_market_data",
            sourceFamily: "market_data_api",
            sourceTimestamp: date,
            observedAt: request.asOf,
            delayStatus: "delayed",
            sourceUrlOrArtifact,
            data: {
              title: row.title,
              url: row.url,
              language: row.lang,
              image: row.img,
              query,
              sourceTimestampMeaning: "gdelt_monitoring_minute_not_article_publication",
              coverage: "two_minute_title_sample_not_fulltext_search",
              fullTextSearched: false,
              rawTextSha256: sha256,
            },
          });
        }
      }
      if (!records.length) {
        throw new Error(
          "No matching titles in the bounded GDELT sample; this does not establish absence of news",
        );
      }
      return records
        .toSorted((a, b) => b.sourceTimestamp.localeCompare(a.sourceTimestamp))
        .slice(0, request.limit ?? 20)
        .map((record) => ({ ...record, data: { ...record.data, scannedFiles } }));
    },
  };
}
