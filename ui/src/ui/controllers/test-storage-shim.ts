/**
 * Test-only storage shim. Not reachable from the app entry, so it is never bundled.
 *
 * Why this exists: `ui/src/ui/i18n/lib/translate.ts` reads `localStorage` at module
 * init, which makes every module that imports the i18n layer (the controllers do,
 * via `t(...)`) unloadable under the node test environment. This is a no-op in a
 * real browser, so importing it costs nothing there and lets the same test file
 * also run under `vitest.unit.config.ts` -- which is the only config CI executes.
 *
 * Scope is deliberate: this is imported by the individual test files that need it,
 * NOT added to the global `test/setup.ts`. A global shim would flip the
 * `typeof localStorage !== "undefined"` branches in `controllers/usage.ts`, i.e. it
 * would silently change behaviour for tests that are not asking for a DOM.
 */
class MemoryStorage implements Storage {
  private readonly entries = new Map<string, string>();

  get length(): number {
    return this.entries.size;
  }

  clear(): void {
    this.entries.clear();
  }

  getItem(key: string): string | null {
    return this.entries.get(key) ?? null;
  }

  key(index: number): string | null {
    return [...this.entries.keys()][index] ?? null;
  }

  removeItem(key: string): void {
    this.entries.delete(key);
  }

  setItem(key: string, value: string): void {
    this.entries.set(key, String(value));
  }
}

const globals = globalThis as unknown as Record<string, unknown>;
if (typeof globals.localStorage === "undefined") {
  globals.localStorage = new MemoryStorage();
}
