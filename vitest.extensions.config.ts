import { createScopedVitestConfig } from "./vitest.scoped-config.ts";

export default createScopedVitestConfig(["extensions/**/*.test.ts"]);
// Vitest configuration for extension and plugin package tests.
