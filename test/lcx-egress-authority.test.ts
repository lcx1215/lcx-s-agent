import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(import.meta.dirname, "..");

/**
 * Constructs that let the host's proxy environment decide where a request goes, or that let it
 * change a security policy. The egress route has to be identical on a laptop behind a VPN and on
 * AWS/Cloudflare, so every remaining use in production code must be declared below.
 */
const AMBIENT_EGRESS_RULES = [
  { id: "env_http_proxy_agent", pattern: /new EnvHttpProxyAgent\(/u },
  { id: "env_proxy_fetch_helper", pattern: /resolveProxyFetchFromEnv\(/u },
  { id: "env_proxy_opt_in_flag", pattern: /useEnvProxy/u },
  { id: "ambient_proxy_env_probe", pattern: /hasProxyEnvConfigured\(/u },
  // Installing an environment-derived agent as the *process-wide* dispatcher is the worst variant
  // of this family: it reroutes every later dispatcher-less `fetch` in the process, not just the
  // request at hand. No production module does this today.
  { id: "ambient_global_dispatcher", pattern: /setGlobalDispatcher\(\s*new EnvHttpProxyAgent/u },
] as const;

/**
 * file -> why an ambient-egress construct may appear there.
 *
 * Adding an entry is a deliberate decision, not a formality: it means "this module is allowed to
 * let the host environment influence behaviour". Prefer declaring an explicit route (`proxyUrl`
 * on `fetchWithSsrFGuard`, or the finance three-state declaration) over extending this list.
 */
const DECLARED_AMBIENT_EGRESS: Record<string, string> = {
  "src/infra/net/fetch-guard.ts":
    "Owns the guarded-fetch contract. A declared `proxyUrl` wins over everything, and the ambient branch is reachable only through an explicitly passed mode.",
  "src/infra/net/proxy-env.ts":
    "The environment probe itself. It only reports whether proxy variables are set; it never chooses a route.",
  "src/infra/net/proxy-fetch.ts":
    "The environment-derived fetch helper. It has no production caller; this entry keeps that fact visible rather than assumed.",
  "src/agents/finance-live-market-source.ts":
    "Three-state declaration: undefined means ambient, an empty string means direct, a URL means explicit. The value comes from the declared credential, not from ambient environment.",
  "src/agents/finance-write-transport.ts":
    'Reuses the same three-state "decideFinanceProxy" decision as finance-live-market-source; it differs only in skipping the response cache so order state can be polled. The route still comes from the declared credential, never from ambient variables by accident.',
  "src/browser/navigation-guard.ts":
    "Tightens the browser SSRF policy when proxy variables are set. It narrows access instead of choosing an egress route, and the browser is a separate process that reads its own proxy settings.",
  "src/browser/cdp-proxy-bypass.ts":
    "Same SSRF tightening for the CDP sidecar. It narrows access instead of choosing an egress route.",
};

function listProductionSources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === ".git") {
        continue;
      }
      out.push(...listProductionSources(path.join(dir, entry.name)));
      continue;
    }
    if (!entry.name.endsWith(".ts") || entry.name.endsWith(".test.ts")) {
      continue;
    }
    out.push(path.relative(repoRoot, path.join(dir, entry.name)).split(path.sep).join("/"));
  }
  return out;
}

function readLines(relativePath: string): string[] {
  return readSource(relativePath).split("\n");
}

function readSource(relativePath: string): string {
  return fs.readFileSync(path.join(repoRoot, relativePath), "utf8");
}

/** Every variable a proxy-aware dependency can read: `NO_PROXY` alone arms Bedrock's branch. */
const AMBIENT_ENV_PROXY_KEYS = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "http_proxy",
  "https_proxy",
  "NO_PROXY",
  "no_proxy",
] as const;

const AMBIENT_MARKER = "http://ambient.invalid:1";
const DECLARED_PROXY = "http://declared.invalid:8080";

/** Run `fn` with a hostile ambient environment, then restore exactly what was there before. */
function withAmbientEnv(vars: Record<string, string>, fn: () => void): void {
  const saved = new Map<string, string | undefined>();
  for (const key of AMBIENT_ENV_PROXY_KEYS) {
    saved.set(key, process.env[key]);
  }
  try {
    for (const key of AMBIENT_ENV_PROXY_KEYS) {
      delete process.env[key];
    }
    for (const [key, value] of Object.entries(vars)) {
      process.env[key] = value;
    }
    fn();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

/**
 * Drop comments before matching.
 *
 * Explaining a footgun in a comment is exactly what this file's own rules do — `pi-ai installs
 * setGlobalDispatcher(new EnvHttpProxyAgent())` appears in `attempt.ts` as documentation, not as
 * behaviour. Matching raw source would flag the explanation as a reintroduction, which punishes
 * the documentation that makes the hazard discoverable.
 *
 * `//` inside a string literal (a proxy URL) must survive, so only a comment that starts the
 * remaining text is stripped; block comments are tracked across lines.
 */
function stripComments(source: string): string {
  const out: string[] = [];
  let inBlock = false;
  for (const line of source.split("\n")) {
    let rest = line;
    let kept = "";
    while (rest.length > 0) {
      if (inBlock) {
        const end = rest.indexOf("*/");
        if (end === -1) {
          rest = "";
        } else {
          inBlock = false;
          rest = rest.slice(end + 2);
        }
        continue;
      }
      if (rest.trimStart().startsWith("//")) {
        break;
      }
      const blockStart = rest.indexOf("/*");
      if (blockStart !== -1) {
        kept += rest.slice(0, blockStart);
        rest = rest.slice(blockStart + 2);
        inBlock = true;
        continue;
      }
      kept += rest;
      rest = "";
    }
    out.push(kept);
  }
  return out.join("\n");
}

function scanAmbientEgress(): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const file of listProductionSources(path.join(repoRoot, "src"))) {
    const source = stripComments(fs.readFileSync(path.join(repoRoot, file), "utf8"));
    const ids = AMBIENT_EGRESS_RULES.filter((rule) => rule.pattern.test(source)).map(
      (rule) => rule.id,
    );
    if (ids.length > 0) {
      found.set(file, ids);
    }
  }
  return found;
}

describe("lcx-egress-authority", () => {
  it("declares every module where ambient proxy variables can influence behaviour", () => {
    const found = scanAmbientEgress();
    const undeclared = [...found.keys()]
      .filter((file) => !(file in DECLARED_AMBIENT_EGRESS))
      .toSorted();

    // A new hit means someone let the host environment decide something again. Declare it with a
    // reason, or route it through an explicit declaration instead.
    expect(undeclared).toEqual([]);
  });

  it("keeps the declaration honest: no entry survives without a matching module", () => {
    const found = scanAmbientEgress();
    const stale = Object.keys(DECLARED_AMBIENT_EGRESS)
      .filter((file) => !found.has(file))
      .toSorted();

    // A stale entry hides a real removal, so the list has to shrink when a use disappears.
    expect(stale).toEqual([]);
  });

  it("keeps the resident telegram dispatcher off ambient proxy variables", () => {
    const source = fs.readFileSync(path.join(repoRoot, "src/telegram/fetch.ts"), "utf8");

    // This file installs a process-wide dispatcher, so an ambient proxy here would reroute every
    // later request in the process once the launching shell disappears. Assert on the *construct*
    // rather than the bare type name: the module legitimately mentions `EnvHttpProxyAgent` while
    // refusing to treat one as an explicitly configured proxy.
    expect(source).not.toMatch(/new EnvHttpProxyAgent/u);
    expect(source).not.toMatch(/hasProxyEnvConfigured/u);
  });

  it("keeps the web tools egress free of the ambient-proxy opt-in", () => {
    const guarded = fs.readFileSync(
      path.join(repoRoot, "src/agents/tools/web-guarded-fetch.ts"),
      "utf8",
    );

    expect(guarded).not.toMatch(/useEnvProxy/u);
    expect(guarded).not.toMatch(/withTrustedEnvProxyGuardedFetchMode/u);
  });

  // The model SDK is the one dependency we cannot patch from here.
  //
  // `@mariozechner/pi-ai`'s root entry re-exports `./stream.js`, and `stream.js` carries a bare
  // side-effect import of `./utils/http-proxy.js`, which on import runs
  // `setGlobalDispatcher(new EnvHttpProxyAgent())` (asynchronously, via `import("undici").then`).
  // The repo imports that package from `model-auth.ts`, `tts-core.ts`, and others, so merely
  // loading it turns the process-wide undici dispatcher into an environment-derived one — and
  // every dispatcher-less `fetch`, model API calls included, then inherits the host's proxy
  // variables. The `src`-only scan above cannot see this: the construct lives in node_modules.
  //
  // Proven in a fresh process with the proxy variables pointed at a dead port:
  //   control (pi-ai never imported): global dispatcher `Agent`,             plain fetch -> HTTP 200
  //   pi-ai imported                : global dispatcher `EnvHttpProxyAgent`, plain fetch -> ECONNREFUSED
  //
  // Measured landing time (Node 22): still `Agent` synchronously after `await import(pi-ai)` and
  // after two microtasks; `EnvHttpProxyAgent` from the first macrotask tick onward. So the fix
  // cannot be a same-tick reset — it has to run after real I/O, which is why the guard sits behind
  // `await fs.mkdir(...)` in the run path below.
  //
  // The guarantee is therefore *not* "pi-ai never installs an ambient dispatcher". It is "the
  // declared route is asserted before any model request is issued", which is the property the
  // laptop-vs-AWS/Cloudflare requirement actually needs.
  //
  // One assertion at run start is not enough: `http-proxy.js` is evaluated on more than one
  // resolved URL under pnpm's symlinked `node_modules`, and each evaluation queues another
  // install. Measured on Node 22, a second one lands a macrotask later — so a provider loaded
  // lazily during the first call can reinstall ambient *after* the run began. The assertion
  // therefore also sits at the innermost stream layer (see the test below).
  it("wires the model egress guard into the run path, after real I/O", () => {
    const lines = readLines("src/agents/pi-embedded-runner/run/attempt.ts");

    // Match an executable statement, not the substring: a commented-out call still contains the
    // identifier, so `indexOf` would happily pass a file where the guard never runs.
    // Match the run-start call specifically: the same guard is also invoked from the innermost
    // stream wrapper, and a bare prefix match would find that one first.
    const guardLine = lines.findIndex((line) =>
      line.trim().startsWith("ensureModelEgressDispatcher(params.config)"),
    );
    const firstIoLine = lines.findIndex((line) =>
      line.includes("await fs.mkdir(resolvedWorkspace"),
    );

    expect(guardLine, "the model run path must assert the egress route").toBeGreaterThan(-1);
    expect(firstIoLine, "expected the run path to await its first I/O").toBeGreaterThan(-1);
    // A same-tick reset would be overwritten by pi-ai's side effect, so the ordering is part of the
    // contract rather than an incidental layout choice.
    expect(guardLine).toBeGreaterThan(firstIoLine);
  });

  it("asserts the egress route at the innermost stream layer, not only at run start", () => {
    const lines = readLines("src/agents/pi-embedded-runner/run/attempt.ts");

    // Every later wrapper builds on `agent.streamFn`, so being ahead of them means being *inside*
    // them — i.e. the assertion runs as the last thing before the request leaves.
    const wrapLine = lines.findIndex((line) =>
      line.trim().startsWith("activeSession.agent.streamFn = wrapStreamFnEgressAssertion("),
    );
    const transportLines = lines.reduce<number[]>((acc, line, i) => {
      if (line.includes("activeSession.agent.streamFn = streamSimple")) {
        acc.push(i);
      }
      return acc;
    }, []);
    const lastTransportLine = transportLines.at(-1) ?? -1;
    const trimLine = lines.findIndex((line) =>
      line.trim().startsWith("activeSession.agent.streamFn = wrapStreamFnTrimToolCallNames("),
    );

    expect(
      wrapLine,
      "the run path must wrap the stream function with the egress assertion",
    ).toBeGreaterThan(-1);
    expect(lastTransportLine, "expected the transport-selection branch").toBeGreaterThan(-1);
    // After the branch, or one transport would escape the assertion entirely.
    expect(wrapLine).toBeGreaterThan(lastTransportLine);
    expect(trimLine, "expected the tool-name wrapper to still be applied").toBeGreaterThan(-1);
    // Before the later wrappers, or a reinstalled ambient dispatcher would land in between.
    expect(wrapLine).toBeLessThan(trimLine);
  });

  it("routes the OpenAI WebSocket transport through the declared model proxy", () => {
    // `ws` never reads ambient proxy variables — good — but it also ignored `models.proxy`, so the
    // same field behaved differently on the HTTP stream path and this one.
    const connection = readLines("src/agents/openai-ws-connection.ts");
    const resolvesDeclaration = connection.some((line) => line.includes("resolveModelsProxyUrl("));
    const wiresAgent = connection.some((line) => line.includes("HttpsProxyAgent"));

    expect(resolvesDeclaration, "the WebSocket manager must resolve the declared proxy").toBe(true);
    expect(wiresAgent, "the WebSocket manager must hand the proxy to `ws` as an agent").toBe(true);

    // The declaration only reaches the manager if the run path forwards its config.
    const attempt = readLines("src/agents/pi-embedded-runner/run/attempt.ts");
    const wsCallAt = attempt.findIndex((line) => line.includes("createOpenAIWebSocketStreamFn("));
    const forwardsConfig =
      wsCallAt > -1 &&
      attempt.slice(wsCallAt, wsCallAt + 5).some((line) => line.includes("config: params.config"));

    expect(wsCallAt, "expected the WebSocket transport to be constructed").toBeGreaterThan(-1);
    expect(forwardsConfig, "the run path must forward its config to the WebSocket transport").toBe(
      true,
    );
  });

  it("keeps the bedrock provider off ambient proxy variables", () => {
    // `amazon-bedrock.js` (inside `@mariozechner/pi-ai`) decides its route from the environment:
    //
    //   if (process.env.HTTP_PROXY || process.env.HTTPS_PROXY || process.env.NO_PROXY || …) {
    //     config.requestHandler = new NodeHttpHandler({ httpAgent: new ProxyAgent(), … });
    //   }
    //
    // The AWS SDK uses Node's `http` module, not undici, so the global dispatcher never reaches it
    // — the only lever is the environment those variables are read from. Hence `egress-env.ts`:
    // set them to the declared proxy, or remove them.
    const egressEnv = readSource("src/infra/net/egress-env.ts");

    // Missing any one of these leaves the ambient branch armed — `NO_PROXY` alone is enough.
    for (const key of AMBIENT_ENV_PROXY_KEYS) {
      expect(egressEnv, `egress-env must handle ${key}`).toContain(`"${key}"`);
    }
  });

  // Behavioural, not textual: asserting that `model-egress.ts` merely *mentions* the env sync
  // survives deleting the call while the import stays, which reads as a passing guard over a
  // provider that is once again free to follow the host environment.
  it("aligns ambient proxy variables with the declared route", async () => {
    const { ensureModelEgressDispatcher, resetModelEgressStateForTests } =
      await import("../src/agents/model-egress.js");

    withAmbientEnv({ HTTP_PROXY: AMBIENT_MARKER, NO_PROXY: "example.com" }, () => {
      resetModelEgressStateForTests();
      ensureModelEgressDispatcher({ models: { proxy: DECLARED_PROXY } } as never);

      for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"] as const) {
        expect(process.env[key], `${key} must follow the declaration`).toBe(DECLARED_PROXY);
      }
      expect(process.env.NO_PROXY, "NO_PROXY must not narrow the declared route").toBeUndefined();
    });
  });

  it("installs the direct route at CLI startup, before the first model turn", () => {
    // `toContain` is not enough here: deleting the call leaves the import behind and still matches.
    // Match a statement instead — an `import { … }` line never starts with the call.
    const entry = readLines("src/entry.ts").map((line) => line.trim());

    expect(
      entry.some((line) => line.startsWith("ensureStartupEgressDispatcher();")),
      "src/entry.ts must call the startup guard on the CLI path",
    ).toBe(true);
  });

  it("clears ambient proxy variables when nothing is declared", async () => {
    const { ensureModelEgressDispatcher, resetModelEgressStateForTests } =
      await import("../src/agents/model-egress.js");

    withAmbientEnv({ HTTPS_PROXY: AMBIENT_MARKER, no_proxy: "example.com" }, () => {
      resetModelEgressStateForTests();
      ensureModelEgressDispatcher(undefined);

      for (const key of AMBIENT_ENV_PROXY_KEYS) {
        expect(process.env[key], `${key} must not reach bedrock`).toBeUndefined();
      }
    });
  });

  it("keeps the model egress guard itself free of ambient proxy variables", () => {
    const source = fs.readFileSync(path.join(repoRoot, "src/agents/model-egress.ts"), "utf8");

    expect(source).not.toMatch(/new EnvHttpProxyAgent/u);
    expect(source).not.toMatch(/hasProxyEnvConfigured/u);
    expect(source).not.toMatch(/process\.env/u);
  });

  it("keeps the shared dispatcher classifier a single source of truth", () => {
    // Two copies of this predicate would mean fixing one of them looks like a fix while the other
    // keeps letting the host environment pick the route.
    for (const file of ["src/telegram/fetch.ts", "src/agents/model-egress.ts"] as const) {
      const source = fs.readFileSync(path.join(repoRoot, file), "utf8");
      // Match the module specifier rather than a single line: an import may be wrapped across
      // lines, and a line-based check would then report a missing import that is right there.
      const importsClassifier = /from\s+"[^"]*infra\/net\/egress-dispatcher\.js"/u.test(source);
      const reimplementsClassifier = readLines(file).some((line) =>
        /constructor\??\.name/u.test(line),
      );

      expect(importsClassifier, `${file} must import the shared classifier`).toBe(true);
      expect(reimplementsClassifier, `${file} must not re-implement the classifier`).toBe(false);
    }
  });
});
