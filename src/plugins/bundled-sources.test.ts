import { beforeEach, describe, expect, it, vi } from "vitest";
import { findBundledPluginSource, resolveBundledPluginSources } from "./bundled-sources.js";

const discoverOpenClawPluginsMock = vi.fn();
const loadPluginManifestMock = vi.fn();

vi.mock("./discovery.js", () => ({
  discoverOpenClawPlugins: (...args: unknown[]) => discoverOpenClawPluginsMock(...args),
}));

vi.mock("./manifest.js", () => ({
  loadPluginManifest: (...args: unknown[]) => loadPluginManifestMock(...args),
}));

describe("bundled plugin sources", () => {
  beforeEach(() => {
    discoverOpenClawPluginsMock.mockReset();
    loadPluginManifestMock.mockReset();
  });

  it("resolves bundled sources keyed by plugin id", () => {
    discoverOpenClawPluginsMock.mockReturnValue({
      candidates: [
        {
          origin: "global",
          rootDir: "/global/external",
          packageName: "@openclaw/external",
          packageManifest: { install: { npmSpec: "@openclaw/external" } },
        },
        {
          origin: "bundled",
          rootDir: "/app/extensions/external",
          packageName: "@openclaw/external",
          packageManifest: { install: { npmSpec: "@openclaw/external" } },
        },
        {
          origin: "bundled",
          rootDir: "/app/extensions/external-dup",
          packageName: "@openclaw/external",
          packageManifest: { install: { npmSpec: "@openclaw/external" } },
        },
        {
          origin: "bundled",
          rootDir: "/app/extensions/msteams",
          packageName: "@openclaw/msteams",
          packageManifest: { install: { npmSpec: "@openclaw/msteams" } },
        },
      ],
      diagnostics: [],
    });

    loadPluginManifestMock.mockImplementation((rootDir: string) => {
      if (rootDir === "/app/extensions/external") {
        return { ok: true, manifest: { id: "external" } };
      }
      if (rootDir === "/app/extensions/msteams") {
        return { ok: true, manifest: { id: "msteams" } };
      }
      return {
        ok: false,
        error: "invalid manifest",
        manifestPath: `${rootDir}/openclaw.plugin.json`,
      };
    });

    const map = resolveBundledPluginSources({});

    expect(Array.from(map.keys())).toEqual(["external", "msteams"]);
    expect(map.get("external")).toEqual({
      pluginId: "external",
      localPath: "/app/extensions/external",
      npmSpec: "@openclaw/external",
    });
  });

  it("finds bundled source by npm spec", () => {
    discoverOpenClawPluginsMock.mockReturnValue({
      candidates: [
        {
          origin: "bundled",
          rootDir: "/app/extensions/external",
          packageName: "@openclaw/external",
          packageManifest: { install: { npmSpec: "@openclaw/external" } },
        },
      ],
      diagnostics: [],
    });
    loadPluginManifestMock.mockReturnValue({ ok: true, manifest: { id: "external" } });

    const resolved = findBundledPluginSource({
      lookup: { kind: "npmSpec", value: "@openclaw/external" },
    });
    const missing = findBundledPluginSource({
      lookup: { kind: "npmSpec", value: "@openclaw/not-found" },
    });

    expect(resolved?.pluginId).toBe("external");
    expect(resolved?.localPath).toBe("/app/extensions/external");
    expect(missing).toBeUndefined();
  });

  it("finds bundled source by plugin id", () => {
    discoverOpenClawPluginsMock.mockReturnValue({
      candidates: [
        {
          origin: "bundled",
          rootDir: "/app/extensions/diffs",
          packageName: "@openclaw/diffs",
          packageManifest: { install: { npmSpec: "@openclaw/diffs" } },
        },
      ],
      diagnostics: [],
    });
    loadPluginManifestMock.mockReturnValue({ ok: true, manifest: { id: "diffs" } });

    const resolved = findBundledPluginSource({
      lookup: { kind: "pluginId", value: "diffs" },
    });
    const missing = findBundledPluginSource({
      lookup: { kind: "pluginId", value: "not-found" },
    });

    expect(resolved?.pluginId).toBe("diffs");
    expect(resolved?.localPath).toBe("/app/extensions/diffs");
    expect(missing).toBeUndefined();
  });
});
