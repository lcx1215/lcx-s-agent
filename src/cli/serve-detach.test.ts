import { describe, expect, it } from "vitest";
import { buildDetachedServeEnv, routeStandaloneServeArgs } from "./serve-detach.js";

describe("routeStandaloneServeArgs", () => {
  it("routes option-only argv through the serve subcommand", () => {
    expect(routeStandaloneServeArgs(["--bind", "loopback", "--port", "8788"])).toEqual([
      "serve",
      "--bind",
      "loopback",
      "--port",
      "8788",
    ]);
  });

  it("does not duplicate an explicit serve subcommand", () => {
    // `serve --detach` re-executes the standalone entry with ["serve"]; handing
    // the child `serve serve` makes commander abort before it can listen.
    expect(routeStandaloneServeArgs(["serve"])).toEqual(["serve"]);
    expect(routeStandaloneServeArgs(["serve", "--detach"])).toEqual(["serve", "--detach"]);
  });

  it("keeps later positional arguments after the subcommand", () => {
    expect(routeStandaloneServeArgs(["status", "--json"])).toEqual(["serve", "status", "--json"]);
  });
});

const SHIM = "/Applications/WorkBuddy AI.app/x/cli/vendor/shim/node-language-shim.cjs";

describe("buildDetachedServeEnv", () => {
  it("drops CODEBUDDY_* entries, whose guard counter never resets for a resident process", () => {
    const env = buildDetachedServeEnv({}, {
      PATH: "/usr/bin",
      CODEBUDDY_SESSION_ID: "abc",
      CODEBUDDY_SAFE_DELETE_BULK_STATE_DIR: "/tmp/x",
    } as NodeJS.ProcessEnv);
    expect(env).toEqual({ PATH: "/usr/bin" });
  });

  it("drops loopback proxies but keeps a real egress proxy", () => {
    const env = buildDetachedServeEnv({}, {
      HTTP_PROXY: "http://127.0.0.1:63998",
      https_proxy: "http://localhost:8080",
      ALL_PROXY: "socks5://[::1]:1080",
      HTTPS_PROXY: "http://proxy.corp.example:3128",
    } as NodeJS.ProcessEnv);
    expect(env).toEqual({ HTTPS_PROXY: "http://proxy.corp.example:3128" });
  });

  it("drops the lowercase proxy names too, which undici reads first", () => {
    // undici's EnvHttpProxyAgent resolves `http_proxy` before `HTTP_PROXY`, so dropping only the
    // uppercase names would leave the session-scoped proxy in effect for a resident child.
    const env = buildDetachedServeEnv({}, {
      HTTP_PROXY: "http://127.0.0.1:63998",
      http_proxy: "http://127.0.0.1:63998",
      https_proxy: "http://127.0.0.1:63998",
      all_proxy: "socks5://127.0.0.1:1080",
    } as NodeJS.ProcessEnv);
    expect(env).toEqual({});
  });

  it("strips only the injected shim require from NODE_OPTIONS, keeping other flags", () => {
    const env = buildDetachedServeEnv({}, {
      NODE_OPTIONS: `--require="${SHIM}" --max-old-space-size=2048`,
    } as NodeJS.ProcessEnv);
    expect(env.NODE_OPTIONS).toBe("--max-old-space-size=2048");
  });

  it("drops NODE_OPTIONS entirely when the shim was its only content", () => {
    // The real shim path contains spaces, so the operand is quoted; a naive
    // whitespace split would leave half of it behind.
    const env = buildDetachedServeEnv({}, { NODE_OPTIONS: `-r "${SHIM}"` } as NodeJS.ProcessEnv);
    expect(env).not.toHaveProperty("NODE_OPTIONS");
  });

  it("lets caller overrides win, so a needed value can be re-added", () => {
    const env = buildDetachedServeEnv({ HTTP_PROXY: "http://127.0.0.1:63998" }, {
      HTTP_PROXY: "http://127.0.0.1:63998",
    } as NodeJS.ProcessEnv);
    expect(env.HTTP_PROXY).toBe("http://127.0.0.1:63998");
  });
});
