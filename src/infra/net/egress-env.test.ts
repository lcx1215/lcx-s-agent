import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { syncAmbientEgressEnv } from "./egress-env.js";

const AMBIENT_KEYS = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "http_proxy",
  "https_proxy",
  "NO_PROXY",
  "no_proxy",
] as const;

const saved = new Map<string, string | undefined>();

beforeEach(() => {
  saved.clear();
  for (const key of AMBIENT_KEYS) {
    saved.set(key, process.env[key]);
  }
});

afterEach(() => {
  for (const key of AMBIENT_KEYS) {
    const value = saved.get(key);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

function seedAmbient(): void {
  process.env.HTTP_PROXY = "http://ambient.example:8080";
  process.env.HTTPS_PROXY = "http://ambient.example:8080";
  process.env.http_proxy = "http://ambient.example:8080";
  process.env.https_proxy = "http://ambient.example:8080";
  process.env.NO_PROXY = "localhost,127.0.0.1";
  process.env.no_proxy = "localhost,127.0.0.1";
}

describe("syncAmbientEgressEnv", () => {
  it("points every ambient variable at the declared proxy", () => {
    seedAmbient();

    syncAmbientEgressEnv("http://declared.example:3128");

    for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"]) {
      expect(process.env[key]).toBe("http://declared.example:3128");
    }
  });

  it("removes the opt-out list when a proxy is declared", () => {
    seedAmbient();

    syncAmbientEgressEnv("http://declared.example:3128");

    // `NO_PROXY` alone is enough to arm Bedrock's ambient branch, so leaving it would smuggle an
    // exception into the declared route.
    expect(process.env.NO_PROXY).toBeUndefined();
    expect(process.env.no_proxy).toBeUndefined();
  });

  it("removes every ambient variable when nothing is declared", () => {
    seedAmbient();

    syncAmbientEgressEnv(undefined);

    for (const key of AMBIENT_KEYS) {
      expect(process.env[key], key).toBeUndefined();
    }
  });

  it("treats a blank declaration as undeclared", () => {
    seedAmbient();

    syncAmbientEgressEnv("");

    for (const key of AMBIENT_KEYS) {
      expect(process.env[key], key).toBeUndefined();
    }
  });

  it("is idempotent", () => {
    syncAmbientEgressEnv("http://declared.example:3128");
    const first = AMBIENT_KEYS.map((key) => process.env[key]);
    syncAmbientEgressEnv("http://declared.example:3128");

    expect(AMBIENT_KEYS.map((key) => process.env[key])).toEqual(first);
  });

  it("leaves unrelated variables alone", () => {
    process.env.MY_UNRELATED = "keep-me";
    try {
      syncAmbientEgressEnv(undefined);
      expect(process.env.MY_UNRELATED).toBe("keep-me");
    } finally {
      delete process.env.MY_UNRELATED;
    }
  });
});
