import { describe, expect, it } from "vitest";
import { runFinanceSourceHeartbeatCli } from "../../scripts/operator/lcx-finance-source-heartbeat.js";

describe("finance source heartbeat CLI argument bounds", () => {
  it.each(["1.5", "2147483648", "Infinity", "0"])(
    "rejects unsafe --timeout-ms value %s before reading or probing",
    async (value) => {
      await expect(runFinanceSourceHeartbeatCli(["--once", "--timeout-ms", value])).rejects.toThrow(
        "--timeout-ms must be a positive safe integer",
      );
    },
  );
});
