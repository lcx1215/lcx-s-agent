import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FetchImpl } from "../finance-live-market-source.js";
import { createGeospatialSourceRefreshTool } from "./geospatial-source-refresh-tool.js";

afterEach(() => vi.useRealTimers());

describe("geospatial_source_refresh tool", () => {
  it("keeps Nominatim dispatch spacing across tool executions", async () => {
    vi.useFakeTimers();
    const times: number[] = [];
    const fetchImpl: FetchImpl = async (url) => {
      const nominatim = url.includes("nominatim");
      if (nominatim) {
        times.push(Date.now());
      }
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify(
            nominatim
              ? [{ lat: "31.2", lon: "121.5", display_name: "Shanghai" }]
              : { results: [{ name: "Shanghai", latitude: 31.2, longitude: 121.5 }] },
          ),
      };
    };
    const tool = createGeospatialSourceRefreshTool({ fetchImpl });
    const params = { kind: "geocode", query: "Shanghai", liveFetch: true };
    await tool.execute("first", params);
    const pending = tool.execute("second", params);
    await vi.advanceTimersByTimeAsync(1099);
    expect(times).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(times).toHaveLength(2);
    expect(times[1] - times[0]).toBeGreaterThanOrEqual(1100);
  });

  it("does not dispatch or write a receipt after caller cancellation", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "geospatial-cancelled-"));
    let fetchCalls = 0;
    const fetchImpl: FetchImpl = async () => {
      fetchCalls += 1;
      return { ok: true, status: 200, text: async () => JSON.stringify({}) };
    };
    const controller = new AbortController();
    controller.abort(new Error("platform cancelled"));
    try {
      const tool = createGeospatialSourceRefreshTool({ workspaceDir, fetchImpl });
      await expect(
        tool.execute(
          "cancelled",
          {
            kind: "weather",
            query: "31.2,121.5",
            liveFetch: true,
            writeReceipt: true,
          },
          controller.signal,
        ),
      ).rejects.toThrow("platform cancelled");
      expect(fetchCalls).toBe(0);
      await expect(fs.stat(path.join(workspaceDir, "memory"))).rejects.toThrow();
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });
});
