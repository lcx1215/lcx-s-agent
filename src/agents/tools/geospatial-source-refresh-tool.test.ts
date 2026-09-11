import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { FetchImpl } from "../finance-live-market-source.js";
import { createGeospatialSourceRefreshTool } from "./geospatial-source-refresh-tool.js";

describe("geospatial_source_refresh tool", () => {
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
