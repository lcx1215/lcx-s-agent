import { defineConfig } from "vitest/config";
import baseConfig from "./vitest.config.ts";

const base = baseConfig as unknown as Record<string, unknown>;
const baseTest = (baseConfig as { test?: { exclude?: string[] } }).test ?? {};
const compatibilityTest = "src/plugins/loader-legacy-root.test.ts";

// Package compatibility requires this checkout's build; ordinary unit tests do not.
export default defineConfig({
  ...base,
  test: {
    ...baseTest,
    include: [compatibilityTest],
    exclude: (baseTest.exclude ?? []).filter((pattern) => pattern !== compatibilityTest),
  },
});
