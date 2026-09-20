import { describe, expect, it } from "vitest";
import {
  dispatcherConstructorName,
  isAmbientEnvProxyDispatcher,
  isDeclaredProxyDispatcher,
} from "./egress-dispatcher.js";

function named(name: string): unknown {
  return { constructor: { name } };
}

describe("dispatcherConstructorName", () => {
  it("reads the constructor name", () => {
    expect(dispatcherConstructorName(named("Agent"))).toBe("Agent");
  });

  it("returns undefined for unusable inputs", () => {
    expect(dispatcherConstructorName(undefined)).toBeUndefined();
    expect(dispatcherConstructorName(null)).toBeUndefined();
    expect(dispatcherConstructorName(named(""))).toBeUndefined();
  });

  it("reads the plain-object constructor rather than guessing", () => {
    // A dispatcher stub is a plain object, so its constructor name is "Object" — the helper reports
    // what is there instead of inventing a classification.
    expect(dispatcherConstructorName({})).toBe("Object");
  });
});

describe("isAmbientEnvProxyDispatcher", () => {
  it("matches the env-driven agent", () => {
    expect(isAmbientEnvProxyDispatcher(named("EnvHttpProxyAgent"))).toBe(true);
  });

  it("does not match a declared proxy or a bare agent", () => {
    expect(isAmbientEnvProxyDispatcher(named("ProxyAgent"))).toBe(false);
    expect(isAmbientEnvProxyDispatcher(named("Agent"))).toBe(false);
    expect(isAmbientEnvProxyDispatcher(undefined)).toBe(false);
  });
});

describe("isDeclaredProxyDispatcher", () => {
  it("matches a declared proxy", () => {
    expect(isDeclaredProxyDispatcher(named("ProxyAgent"))).toBe(true);
  });

  it("rejects the ambient env agent despite the shared substring", () => {
    // `EnvHttpProxyAgent` contains "ProxyAgent"; a substring test alone would classify the
    // dependency-installed ambient agent as operator configuration.
    expect(isDeclaredProxyDispatcher(named("EnvHttpProxyAgent"))).toBe(false);
  });

  it("rejects non-proxy agents", () => {
    expect(isDeclaredProxyDispatcher(named("Agent"))).toBe(false);
    expect(isDeclaredProxyDispatcher(undefined)).toBe(false);
  });
});
