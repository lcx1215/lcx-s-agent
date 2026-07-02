import { defineConfig } from "vitest/config";

// scripts/dev/ holds runnable CLI tools that the main vitest.config.ts include
// globs (src/**, extensions/**, test/**) deliberately skip. This minimal config
// lets the generalization-harness unit tests run in isolation:
//   pnpm exec vitest run --config vitest.scripts-dev.config.ts
export default defineConfig({
  test: {
    include: ["scripts/dev/**/*.test.ts"],
    environment: "node",
  },
});
