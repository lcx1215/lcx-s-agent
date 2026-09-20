#!/usr/bin/env node
/**
 * Local stdio MCP server: daily OHLCV bar supply for CN A-shares and indices.
 *
 * Why this exists: the finance bar ledger is complete and append-only, but nothing in the system
 * supplies bars. This server is that supply, delivered as a declared MCP server rather than as a
 * one-off script, so the same "declared in config, called by name" boundary applies to it.
 *
 * The `daily_bars` result is shaped exactly like `FinanceBarAppendInput`'s `ohlcv` batch
 * (`instrument`, `derivation`, `provenance`, `observedAt`, `bars`), so the value this returns can
 * be handed to the ledger unchanged instead of being re-shaped by a caller that might get it wrong.
 *
 * Egress: the proxy is read from this process's own environment and is therefore *declared* by the
 * server entry in `tools.mcp.servers`, never inherited from wherever the agent happened to start.
 * Node's built-in fetch ignores proxy variables, so the route is applied explicitly here.
 *
 * Protocol: newline-delimited JSON-RPC on stdin/stdout. Nothing but protocol frames may go to
 * stdout — diagnostics go to stderr, which the client keeps for error messages.
 */

const TOOLS = [
  {
    name: "daily_bars",
    description:
      "Fetch daily OHLCV bars for a CN A-share or index symbol. Returns a payload shaped for the LCX bar ledger (instrument, derivation, provenance, observedAt, bars).",
    inputSchema: {
      type: "object",
      properties: {
        symbol: {
          type: "string",
          description:
            "Ticker in any of: 600519, sh600519, 600519.SH, 000001, sz000001, 000001.SZ, sh000300.",
        },
        start: {
          type: "string",
          description: "Inclusive start date, YYYY-MM-DD (default: 400 bars back).",
        },
        end: { type: "string", description: "Inclusive end date, YYYY-MM-DD (default: today)." },
        count: {
          type: "integer",
          description: "Max bars to request from the vendor, 1-640 (default: 640).",
        },
        adjust: {
          type: "string",
          enum: ["qfq", "none"],
          description:
            "qfq = forward-adjusted (default; use for range measures). none = raw traded prices.",
        },
      },
      required: ["symbol"],
      additionalProperties: false,
    },
  },
];

const FIELD_ORDER = ["date", "open", "close", "high", "low", "volume"];

function fail(message) {
  throw new Error(message);
}

/** Normalize the several ways people write a CN ticker into the vendor's `sh600519` form. */
function toVendorSymbol(raw) {
  const symbol = String(raw ?? "")
    .trim()
    .toLowerCase();
  if (!symbol) {
    fail("symbol is required");
  }
  const withSuffix = symbol.match(/^([a-z]{2})(\d{6})$/u);
  if (withSuffix) {
    return `${withSuffix[1]}${withSuffix[2]}`;
  }
  const dotted = symbol.match(/^(\d{6})\.(sh|sz|bj)$/u);
  if (dotted) {
    return `${dotted[2]}${dotted[1]}`;
  }
  const bare = symbol.match(/^(\d{6})$/u);
  if (bare) {
    const digits = bare[1];
    // 6xxxxx and 9xxxxx are Shanghai; 0/2/3 are Shenzhen; 8/4 are Beijing.
    const market = /^[69]/u.test(digits) ? "sh" : /^[023]/u.test(digits) ? "sz" : "bj";
    return `${market}${digits}`;
  }
  fail(`unrecognized symbol: ${raw}`);
}

/** `sh600519` -> `600519.SH`, which is the instrument key the ledger stores. */
function toInstrument(vendorSymbol) {
  return `${vendorSymbol.slice(2)}.${vendorSymbol.slice(0, 2).toUpperCase()}`;
}

async function makeDispatcher() {
  const proxyUrl =
    process.env.HTTPS_PROXY ?? process.env.https_proxy ?? process.env.LCX_BAR_HTTP_PROXY ?? "";
  if (!proxyUrl.trim()) {
    return { dispatcher: undefined, route: "direct" };
  }
  try {
    const { ProxyAgent } = await import("undici");
    return { dispatcher: new ProxyAgent(proxyUrl.trim()), route: `proxy:${proxyUrl.trim()}` };
  } catch {
    // Being unable to honour a declared route is not the same as having no route: going direct
    // would silently take a different path than the operator wrote down.
    fail(`a proxy route was declared but undici is not resolvable from ${process.cwd()}`);
  }
}

function parseRow(row, vendorSymbol) {
  if (!Array.isArray(row) || row.length < 6) {
    return null;
  }
  const out = {};
  for (let i = 0; i < FIELD_ORDER.length; i += 1) {
    const key = FIELD_ORDER[i];
    if (key === "date") {
      out.date = String(row[i]);
      continue;
    }
    const value = Number(row[i]);
    if (!Number.isFinite(value) || value <= 0) {
      return null;
    }
    out[key] = value;
  }
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(out.date)) {
    return null;
  }
  // The ledger rejects impossible prices; drop the row here rather than letting a bad bar fail
  // the whole batch at write time with a message that no longer names the source.
  const lowest = Math.min(out.open, out.close);
  const highest = Math.max(out.open, out.close);
  if (out.low > lowest || out.high < highest) {
    return null;
  }
  return { ...out, instrument: toInstrument(vendorSymbol) };
}

async function dailyBars(args) {
  const vendorSymbol = toVendorSymbol(args?.symbol);
  const adjust = args?.adjust === "none" ? "none" : "qfq";
  // The vendor ignores the date window — asking for `...,20260701,20260920,640,qfq` returns no
  // series at all (verified). Ask for a count with an empty window and trim the range locally,
  // so a caller's window is honoured by code we control rather than by a parameter that is not.
  const count = Math.min(Number.parseInt(String(args?.count ?? "640"), 10) || 640, 640);
  const param = [vendorSymbol, "day", "", "", String(count), adjust].join(",");
  const url = `https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${encodeURIComponent(param)}`;

  const { dispatcher, route } = await makeDispatcher();
  const response = await fetch(url, {
    headers: { "user-agent": "lcx-agent-bar-source/1.0", accept: "application/json" },
    ...(dispatcher ? { dispatcher } : {}),
  });
  if (!response.ok) {
    fail(`bar source returned HTTP ${response.status}`);
  }
  const payload = await response.json();
  if (payload?.code !== 0) {
    fail(`bar source returned code ${payload?.code ?? "unknown"}: ${payload?.msg ?? ""}`);
  }
  const node = payload?.data?.[vendorSymbol];
  const series = adjust === "qfq" ? node?.qfqday : node?.day;
  if (!Array.isArray(series)) {
    fail(
      `bar source returned no ${adjust === "qfq" ? "qfqday" : "day"} series for ${vendorSymbol}`,
    );
  }

  const bars = [];
  const skipped = [];
  for (const row of series) {
    const parsed = parseRow(row, vendorSymbol);
    if (parsed) {
      bars.push({
        date: parsed.date,
        open: parsed.open,
        high: parsed.high,
        low: parsed.low,
        close: parsed.close,
        volume: parsed.volume,
      });
    } else {
      skipped.push(Array.isArray(row) ? String(row[0]) : String(row));
    }
  }
  // Trim to the requested window here, where "no bars in window" is distinguishable from
  // "the vendor returned nothing".
  const start = typeof args?.start === "string" ? args.start : undefined;
  const end = typeof args?.end === "string" ? args.end : undefined;
  const inWindow = bars.filter((bar) => (!start || bar.date >= start) && (!end || bar.date <= end));
  if (bars.length === 0) {
    fail(`bar source returned ${series.length} rows and none were usable for ${vendorSymbol}`);
  }
  if (inWindow.length === 0) {
    fail(
      `bar source returned ${bars.length} usable bars for ${vendorSymbol} spanning ` +
        `${bars[0].date}..${bars.at(-1).date}, none inside ${start ?? "..."}..${end ?? "..."}; ` +
        `raise count or widen the window`,
    );
  }

  const batch = {
    instrument: toInstrument(vendorSymbol),
    derivation: "ohlcv",
    provenance: {
      origin: `tencent-gtimg-${adjust}-day`,
      sourceUrlOrArtifact: url,
      note:
        adjust === "qfq"
          ? "Forward-adjusted daily bars. The high/low range is exchange-aggregated and its structure is preserved, but absolute prices are rescaled, so do not quote a historical price as the price traded on that day."
          : "Unadjusted daily bars: absolute prices are the prices traded on the day.",
    },
    observedAt: new Date().toISOString(),
    bars: inWindow,
  };

  // Two content items on purpose. The first is exactly the ledger's `ohlcv` batch, so it can be
  // handed to `appendFinanceBars` unchanged; anything else would break that schema's `.strict()`.
  // Diagnostics ride in the second item, where they cannot be mistaken for batch fields.
  return {
    batch,
    diagnostics: {
      route,
      returned: inWindow.length,
      window: `${inWindow[0].date}..${inWindow.at(-1).date}`,
      fetched: bars.length,
      ...(skipped.length > 0 ? { skippedRows: skipped.length } : {}),
    },
  };
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newline = buffer.indexOf("\n");
  while (newline >= 0) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    newline = buffer.indexOf("\n");
    if (!line) {
      continue;
    }
    let request;
    try {
      request = JSON.parse(line);
    } catch {
      continue;
    }
    void handle(request);
  }
});

async function handle(request) {
  const { id, method, params } = request ?? {};
  if (method === "initialize") {
    send({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "lcx-bar-source", version: "1.0.0" },
      },
    });
    return;
  }
  if (typeof method === "string" && method.startsWith("notifications/")) {
    return;
  }
  if (method === "tools/list") {
    send({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
    return;
  }
  if (method === "tools/call") {
    const name = params?.name;
    try {
      if (name !== "daily_bars") {
        fail(`unknown tool: ${name}`);
      }
      const result = await dailyBars(params?.arguments ?? {});
      send({
        jsonrpc: "2.0",
        id,
        result: {
          content: [
            { type: "text", text: JSON.stringify(result.batch) },
            { type: "text", text: JSON.stringify(result.diagnostics) },
          ],
          isError: false,
        },
      });
    } catch (error) {
      // A transport-level error, not a tool result: the client turns this into a thrown error,
      // so a failed fetch can never be mistaken for "the source had no bars".
      send({
        jsonrpc: "2.0",
        id,
        error: { code: -32603, message: error instanceof Error ? error.message : String(error) },
      });
    }
    return;
  }
  if (id !== undefined) {
    send({ jsonrpc: "2.0", id, error: { code: -32601, message: `method not found: ${method}` } });
  }
}
