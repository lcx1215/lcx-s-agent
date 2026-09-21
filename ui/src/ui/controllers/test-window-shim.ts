/**
 * Test-only `window` shim. Not reachable from the app entry, so it is never bundled.
 *
 * Why this exists: two controllers guard on `typeof window === "undefined"` before doing
 * anything browser-flavoured, so under the node test environment they early-return and
 * their tests assert nothing. `sessions.ts` additionally calls `window.confirm(...)`.
 * Neither needs a real DOM -- a plain object with the members they touch is enough.
 * This is a no-op in a real browser.
 *
 * Scope is deliberate: imported by the individual test files that need it, NOT added to
 * the global `test/setup.ts`. Many modules branch on `typeof window !== "undefined"` to
 * decide whether they are in a browser (see `app-settings.ts`, `theme.ts`, `overview.ts`),
 * so a global shim would silently flip those branches for tests that are not asking for
 * one. Keeping it out of `test-storage-shim.ts` for the same reason: the cron tests need
 * storage, not a window.
 */
const globals = globalThis as unknown as Record<string, unknown>;

if (typeof globals.window === "undefined") {
  globals.window = {
    // Overridden per test with `vi.spyOn(window, "confirm")`.
    confirm: () => true,
  };
}
