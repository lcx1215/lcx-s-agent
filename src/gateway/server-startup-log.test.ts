import { describe, expect, it, vi } from "vitest";
import { withEnvAsync } from "../test-utils/env.js";
import { logGatewayStartup } from "./server-startup-log.js";

describe("gateway startup log", () => {
  it("warns when dangerous config flags are enabled", () => {
    const info = vi.fn();
    const warn = vi.fn();

    logGatewayStartup({
      cfg: {
        gateway: {
          controlUi: {
            dangerouslyDisableDeviceAuth: true,
          },
        },
      },
      bindHost: "127.0.0.1",
      port: 18789,
      log: { info, warn },
      isNixMode: false,
    });

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("dangerous config flags enabled"));
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("gateway.controlUi.dangerouslyDisableDeviceAuth=true"),
    );
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("openclaw security audit"));
  });

  it("does not warn when dangerous config flags are disabled", () => {
    const info = vi.fn();
    const warn = vi.fn();

    logGatewayStartup({
      cfg: {},
      bindHost: "127.0.0.1",
      port: 18789,
      log: { info, warn },
      isNixMode: false,
    });

    expect(warn).not.toHaveBeenCalled();
  });

  it("logs the empty-config default model source", async () => {
    const info = vi.fn();
    const warn = vi.fn();

    await withEnvAsync(
      {
        MINIMAX_API_KEY: "sk-minimax-test",
        MINIMAX_OAUTH_TOKEN: undefined,
        OPENCLAW_MINIMAX_DEFAULT_MODEL: "MiniMax-M2.7",
      },
      async () => {
        logGatewayStartup({
          cfg: {},
          bindHost: "127.0.0.1",
          port: 18789,
          log: { info, warn },
          isNixMode: false,
        });
      },
    );

    expect(info).toHaveBeenCalledWith("agent model: minimax/MiniMax-M2.7", {
      defaultModelSource: "MINIMAX_API_KEY",
      consoleMessage: expect.stringContaining("source: MINIMAX_API_KEY"),
    });
  });

  it("logs configured defaults without claiming they came from the empty-config fallback", () => {
    const info = vi.fn();
    const warn = vi.fn();

    logGatewayStartup({
      cfg: { agents: { defaults: { model: { primary: "minimax-portal/MiniMax-M2.7" } } } },
      bindHost: "127.0.0.1",
      port: 18789,
      log: { info, warn },
      isNixMode: false,
    });

    expect(info).toHaveBeenCalledWith("agent model: minimax-portal/MiniMax-M2.7", {
      defaultModelSource: "agents.defaults.model",
      consoleMessage: expect.stringContaining("source: agents.defaults.model"),
    });
  });

  it("logs all listen endpoints on a single line", () => {
    const info = vi.fn();
    const warn = vi.fn();

    logGatewayStartup({
      cfg: {},
      bindHost: "127.0.0.1",
      bindHosts: ["127.0.0.1", "::1"],
      port: 18789,
      log: { info, warn },
      isNixMode: false,
    });

    const listenMessages = info.mock.calls
      .map((call) => call[0])
      .filter((message) => message.startsWith("listening on "));
    expect(listenMessages).toEqual([
      `listening on ws://127.0.0.1:18789, ws://[::1]:18789 (PID ${process.pid})`,
    ]);
  });
});
