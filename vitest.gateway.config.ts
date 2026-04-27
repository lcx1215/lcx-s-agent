import { createScopedVitestConfig } from "./vitest.scoped-config.ts";

export default createScopedVitestConfig(["src/gateway/**/*.test.ts"]);
// Vitest configuration for gateway protocol and server-method tests.
