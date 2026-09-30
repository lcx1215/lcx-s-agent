import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

type SinaRow = {
  d: string;
  o: string;
  h: string;
  l: string;
  c: string;
  v: string;
  p: string;
  s: string;
};

type CapturedRow = {
  date: string;
  symbol: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  openInterest: number;
  settle: number;
};

const here = dirname(fileURLToPath(import.meta.url));
const symbols = ["01", "05", "09"].flatMap((month) =>
  [22, 23, 24, 25, 26].flatMap((year) => [`Y${year}${month}`, `P${year}${month}`]),
);
const rows: CapturedRow[] = [];
const series: Record<
  string,
  {
    url: string;
    rawRows: number;
    firstDate: string | null;
    lastDate: string | null;
    sha256: string;
  }
> = {};
const numericFields = ["o", "h", "l", "c", "v", "p", "s"] as const;

for (const symbol of symbols) {
  const url = `https://stock2.finance.sina.com.cn/futures/api/jsonp.php/var=/InnerFuturesNewService.getDailyKLine?symbol=${symbol}`;
  const response = await fetch(url, { headers: { "user-agent": "LCX research snapshot/1.0" } });
  if (!response.ok) {
    throw new Error(`${symbol} request failed with HTTP ${response.status}`);
  }
  const raw = await response.text();
  const jsonp = raw.match(/\(([\s\S]*)\)\s*;?\s*$/u);
  if (!jsonp) {
    throw new Error(`${symbol} response was not a JSONP payload`);
  }
  const payload: unknown = JSON.parse(jsonp[1]);
  if (!Array.isArray(payload) || payload.length === 0) {
    throw new Error(`${symbol} response had no daily rows`);
  }

  const typedRows = payload as SinaRow[];
  let previousDate: string | undefined;
  for (const [index, item] of typedRows.entries()) {
    if (!item || !/^\d{4}-\d{2}-\d{2}$/u.test(item.d)) {
      throw new Error(`${symbol} row ${index + 1} has an invalid date`);
    }
    if (previousDate !== undefined && item.d <= previousDate) {
      throw new Error(`${symbol} rows are not strictly ordered by date at ${item.d}`);
    }
    previousDate = item.d;
    const values = numericFields.map((field) => Number(item[field]));
    if (values.some((value) => !Number.isFinite(value))) {
      throw new Error(`${symbol} row ${item.d} contains a non-finite value`);
    }
    const [open, high, low, close, volume, openInterest, settle] = values;
    if (low > Math.min(open, close) || high < Math.max(open, close) || low > high) {
      throw new Error(`${symbol} row ${item.d} has inconsistent OHLC values`);
    }
    if (volume < 0 || openInterest < 0) {
      throw new Error(`${symbol} row ${item.d} has a negative volume or open interest`);
    }
    rows.push({ date: item.d, symbol, open, high, low, close, volume, openInterest, settle });
  }

  series[symbol] = {
    url,
    rawRows: typedRows.length,
    firstDate: typedRows[0].d,
    lastDate: typedRows.at(-1)!.d,
    sha256: createHash("sha256").update(raw).digest("hex"),
  };
  await new Promise((resolve) => setTimeout(resolve, 150));
}

const csv = [
  "date,symbol,open,high,low,close,volume,open_interest,settle",
  ...rows.map((row) =>
    [
      row.date,
      row.symbol,
      row.open,
      row.high,
      row.low,
      row.close,
      row.volume,
      row.openInterest,
      row.settle,
    ].join(","),
  ),
].join("\n");
const csvFile = `${csv}\n`;
const csvSha256 = createHash("sha256").update(csvFile).digest("hex");
const capture = {
  capturedAtUtc: new Date().toISOString(),
  source: "Sina Finance exact-contract daily series via AKShare-documented endpoint",
  sourceDocumentationUrl:
    "https://github.com/akfamily/akshare/blob/main/docs/data/futures/futures.md?plain=1",
  fieldMapping: {
    d: "date",
    o: "open",
    h: "high",
    l: "low",
    c: "close",
    v: "volume",
    p: "open interest",
    s: "daily settlement",
  },
  series,
  csvSha256,
  csvBytes: Buffer.byteLength(csvFile),
  rowCount: rows.length,
};

mkdirSync(here, { recursive: true });
writeFileSync(join(here, "input.csv"), csvFile);
writeFileSync(join(here, "capture.json"), `${JSON.stringify(capture, null, 2)}\n`);
process.stdout.write(
  `Captured ${Object.keys(series).length} exact-contract series (${rows.length} rows), input SHA-256 ${csvSha256}\n`,
);
