/**
 * Whether the source-power audit tells a *set* credential apart from a *named* one.
 *
 * The distinction is the whole point of the audit. `~/.openclaw/.env` names every finance key and
 * sets none of them -- all 33 lines are commented -- so an audit that reported "the file mentions
 * FRED_API_KEY" would have said the macro source was configured, when `defaultMacroFor` was
 * returning `undefined` and the sampler was silently skipping the leg.
 *
 * Two bugs in my first draft are pinned here, because both are the same mistake -- treating a
 * partial read as a complete one:
 *
 *   1. reading only a slice of the config's env block, which is how "this config sets one variable"
 *      gets concluded from a file that sets several;
 *   2. letting an empty value in a high-precedence layer fall through to a lower layer that does
 *      have a value, when a higher layer shadows rather than defers.
 */

import { describe, expect, it } from "vitest";
import {
  auditKey,
  keysReadByCode,
  parseConfigEnvVars,
  parseDotenv,
  type Layer,
} from "../scripts/operator/lcx-finance-source-power-audit.js";

function layer(name: string, values: Record<string, string>, template: string[] = []): Layer {
  return { name, values: new Map(Object.entries(values)), template: new Set(template) };
}

describe("a dotenv line that only names a key does not set it", () => {
  it("reads a commented key as a template, not a value", () => {
    const parsed = parseDotenv("# FRED_API_KEY=xxx\n# FMP_API_KEY=abc\n");
    expect(parsed.values.size).toBe(0);
    expect([...parsed.template].toSorted()).toEqual(["FMP_API_KEY", "FRED_API_KEY"]);
  });

  it("reads an uncommented key as a value", () => {
    const parsed = parseDotenv("FMP_API_KEY=abc\n");
    expect(parsed.values.get("FMP_API_KEY")).toBe("abc");
    expect(parsed.template.has("FMP_API_KEY")).toBe(false);
  });

  /**
   * The dangerous shape: uncommented but empty. It is neither "named" nor "set", and collapsing it
   * into either is how a source ends up looking configured while it is not.
   */
  it("reads an uncommented but empty key as declared-empty", () => {
    const parsed = parseDotenv("FMP_API_KEY=\n");
    expect(parsed.values.get("FMP_API_KEY")).toBe("");
    expect(parsed.template.has("FMP_API_KEY")).toBe(false);
  });

  it("strips matching quotes", () => {
    expect(parseDotenv('FINNHUB_API_KEY="abc"\n').values.get("FINNHUB_API_KEY")).toBe("abc");
  });
});

describe("the config's env block is read whole, not sampled", () => {
  /**
   * The measured mistake: reading 400 characters of the block and concluding "only one variable".
   * A config that sets several must report several.
   */
  it("finds every variable, however long the block is", () => {
    const padding = "x".repeat(900);
    const config = `{
  "models": { "note": "${padding}" },
  "env": {
    "vars": {
      "LCX_FINANCE_STATE_DIR": "/tmp/state",
      "FRED_API_KEY": "fred-value",
      "FMP_API_KEY": "fmp-value"
    }
  }
}`;
    const values = parseConfigEnvVars(config);
    expect(values.get("FRED_API_KEY")).toBe("fred-value");
    expect(values.get("FMP_API_KEY")).toBe("fmp-value");
    expect(values.get("LCX_FINANCE_STATE_DIR")).toBe("/tmp/state");
  });

  it("reports nothing when there is no env block", () => {
    expect(parseConfigEnvVars('{ "models": {} }').size).toBe(0);
  });
});

describe("a credential is powered only by a layer that actually supplies it", () => {
  it("is powered by the highest layer that supplies a value", () => {
    // A layer that only *names* the key (commented out) does not shadow: it supplies nothing, so the
    // next layer is still consulted. That is the ~/.openclaw/.env case.
    const status = auditKey("FMP_API_KEY", [
      layer("process", {}),
      layer("./.env", {}, ["FMP_API_KEY"]),
      layer("~/.openclaw/.env", { FMP_API_KEY: "real" }),
    ]);
    expect(status.powered).toBe(true);
    expect(status.from).toBe("~/.openclaw/.env");
  });

  /**
   * The shadowing bug: a higher layer declaring the key empty must not fall through to a lower layer
   * that has a real value. dotenv does not override a key the environment already has, so the empty
   * value is what the source receives.
   */
  it("is not powered when a higher layer declares it empty and a lower one has a value", () => {
    const status = auditKey("FMP_API_KEY", [
      layer("process", { FMP_API_KEY: "" }),
      layer("~/.openclaw/.env", { FMP_API_KEY: "real" }),
    ]);
    expect(status.powered).toBe(false);
    expect(status.from).toBeNull();
    expect(status.declaredEmpty).toEqual(["process"]);
  });

  it("is not powered when every layer only names it", () => {
    const status = auditKey("FRED_API_KEY", [
      layer("process", {}),
      layer("~/.openclaw/.env", {}, ["FRED_API_KEY"]),
    ]);
    expect(status.powered).toBe(false);
    expect(status.templateOnly).toEqual(["~/.openclaw/.env"]);
    expect(status.declaredEmpty).toEqual([]);
  });

  it("reports absent when no layer mentions it at all", () => {
    const status = auditKey("COINCAP_API_KEY", [layer("process", {})]);
    expect(status.powered).toBe(false);
    expect(status.templateOnly).toEqual([]);
    expect(status.declaredEmpty).toEqual([]);
  });
});

/**
 * The end-to-end shape of the measured defect, because the audit is only useful if a template file
 * cannot be mistaken for a powered source: `~/.openclaw/.env` names all ten finance keys and sets
 * none of them, and the macro source was silently absent while that file existed.
 */
describe("a template dotenv file does not power a source", () => {
  const template = [
    "# LCX Agent — 金融数据源凭据",
    "# 当前全部为注释状态 —— 不会产生空值覆盖。",
    "# FMP_API_KEY=xxx",
    "# FRED_API_KEY=xxx",
    "",
  ].join("\n");

  it("leaves every key in it unpowered", () => {
    const parsed = parseDotenv(template);
    const layers: Layer[] = [
      layer("process", {}),
      { name: "~/.openclaw/.env", values: parsed.values, template: parsed.template },
    ];
    for (const key of ["FMP_API_KEY", "FRED_API_KEY"]) {
      const status = auditKey(key, layers);
      expect(status.powered).toBe(false);
      expect(status.templateOnly).toEqual(["~/.openclaw/.env"]);
    }
  });

  it("powers a source once the line is uncommented with a value", () => {
    const parsed = parseDotenv(template.replace("# FRED_API_KEY=xxx", "FRED_API_KEY=real-value"));
    const layers: Layer[] = [
      layer("process", {}),
      { name: "~/.openclaw/.env", values: parsed.values, template: parsed.template },
    ];
    expect(auditKey("FRED_API_KEY", layers).powered).toBe(true);
    // The control: uncommenting one line must not power the others.
    expect(auditKey("FMP_API_KEY", layers).powered).toBe(false);
  });
});

describe("the watched list is kept in step with the code", () => {
  it("finds keys read through keyFrom", () => {
    expect(keysReadByCode('const k = keyFrom(env, "FRED_API_KEY");').has("FRED_API_KEY")).toBe(
      true,
    );
  });

  it("finds keys read straight off env", () => {
    expect(
      keysReadByCode("fredApiKey: env.FRED_API_KEY?.trim() || undefined,").has("FRED_API_KEY"),
    ).toBe(true);
  });

  it("does not mistake an unrelated word for a credential", () => {
    expect(keysReadByCode("const x = env.HOME;").size).toBe(0);
  });
});
