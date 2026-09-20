import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CANONICAL_PRODUCT_NAME, CANONICAL_PROJECT_URL } from "../src/infra/canonical-identity.js";

const repoRoot = path.resolve(import.meta.dirname, "..");

/**
 * This product is a self-owned fork: it must not identify itself as the upstream project on the
 * wire. Two headers do exactly that — OpenRouter/Perplexity style attribution headers — and both
 * are sent on every outbound request, so a stale value is a live behaviour, not dead text.
 */
const UPSTREAM_IDENTITY_PATTERNS = [
  { id: "http_referer", pattern: /"HTTP-Referer":\s*"https:\/\/openclaw\.ai"/u },
  { id: "x_title", pattern: /"X-Title":\s*"OpenClaw/u },
] as const;

/** The call sites that are allowed — and required — to set an outbound identity header. */
const IDENTITY_CALL_SITES = [
  "src/agents/pi-embedded-runner/extra-params.ts",
  "src/agents/tools/web-search.ts",
] as const;

/**
 * Links that send someone *to the upstream repository* — to fetch code, not just to read docs.
 * A mention inside a comment is provenance and stays; anything reachable by a user is not.
 */
const UPSTREAM_REPO_LINK = /github\.com\/openclaw/iu;

/** User-visible copy is spread across the CLI, extensions and the UI, so all three are scanned. */
const PRODUCTION_ROOTS = ["src", "extensions", "ui/src"] as const;

/**
 * The product must not call itself by the upstream name in anything a user can read. Two files are
 * deliberately exempt — adding a third needs the same justification, not a convenience:
 * - `daemon/constants.ts`: Windows scheduled-task *names* and service display names. Renaming them
 *   orphans tasks that are already registered on a machine; that is a migration, not a swap.
 * - `agents/visible-answer-adoption-gate.ts`: a regex that still matches the legacy self-intro so
 *   older conversations keep working.
 *
 * `canvas-host/a2ui.ts` is intentionally NOT exempt: its browser contract uses the lower-case
 * `openclawPostMessage` / `/__openclaw__/*` identifiers, which this check does not match.
 */
const SELF_NAME_EXEMPT = new Set([
  "src/daemon/constants.ts",
  "src/agents/visible-answer-adoption-gate.ts",
]);

/** Standalone word only: `OpenClawConfig` is an identifier, not copy. */
const UPSTREAM_SELF_NAME = /(?<![A-Za-z0-9_$])OpenClaw(?![A-Za-z0-9_$])/u;

/**
 * A skill may still point at the real state directory and config file (`~/.openclaw/openclaw.json`);
 * those paths keep their name because that is where user data actually lives. Only the copy is
 * in scope, so the path is allowed per line rather than exempting the whole file.
 */
const SELF_NAME_ALLOWED_PATH = /~\/\.openclaw|\.openclaw\//u;

/**
 * The upstream website itself. `docs.openclaw.ai` is deliberately excluded: the docs site still
 * lives on that host, so rewriting those links today would turn them into dead links.
 */
const UPSTREAM_WEBSITE = /(?<!docs\.)openclaw\.ai/iu;

/**
 * The upstream skill registry and community server. Neither carries the old product name in the
 * string, which is exactly why a name-based sweep missed them: `clawhub` is a separate brand with
 * its own domain, and it ends with `npx clawhub` downloading and executing upstream code.
 *
 * Both hosts ship more than one spelling — the registry answers on `.com` and `.ai`, and the chat
 * invite is handed out as `discord.com/invite/...` and as the `discord.gg/...` shortener — so the
 * alternations are explicit rather than a bare `discord\.com`, which would also match the Discord
 * *bot API* (`discord.com/api/v10`) that this product legitimately calls as a channel.
 */
const UPSTREAM_ECOSYSTEM = /clawhub\.(?:com|ai)|npx\s+clawhub|discord\.(?:com\/invite|gg)\/clawd/iu;

/**
 * Bundled skills are markdown, not TypeScript, so they need their own sweep. Two roots matter:
 * the top-level `skills/` dir and the per-extension `extensions/<name>/skills/` dirs — both are
 * injected into the model as instructions, so a stale self-name there gets repeated verbatim.
 */
function bundledSkillManifests(): string[] {
  const out: string[] = [];
  const collectFrom = (root: string): void => {
    if (!fs.existsSync(root)) {
      return;
    }
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) {
        continue;
      }
      const manifest = path.join(root, entry.name, "SKILL.md");
      if (fs.existsSync(manifest)) {
        out.push(manifest);
      }
    }
  };
  collectFrom(path.join(repoRoot, "skills"));
  const extensions = path.join(repoRoot, "extensions");
  if (fs.existsSync(extensions)) {
    for (const entry of fs.readdirSync(extensions, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        collectFrom(path.join(extensions, entry.name, "skills"));
      }
    }
  }
  return out;
}

/** Extensions that would install from the upstream npm scope instead of the in-repo source. */
function upstreamNpmExtensions(): string[] {
  const root = path.join(repoRoot, "extensions");
  const out: string[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }
    const manifest = path.join(root, entry.name, "package.json");
    if (!fs.existsSync(manifest)) {
      continue;
    }
    const parsed = JSON.parse(fs.readFileSync(manifest, "utf8")) as {
      openclaw?: { install?: { npmSpec?: string; defaultChoice?: string } };
      lcx?: { install?: { npmSpec?: string; defaultChoice?: string } };
    };
    const install = parsed.openclaw?.install ?? parsed.lcx?.install;
    if (!install) {
      continue;
    }
    // `npm` as the default choice makes plugin installation fetch upstream code even though the
    // same extension ships in this repository.
    if (install.defaultChoice === "npm" && install.npmSpec?.startsWith("@openclaw/")) {
      out.push(entry.name);
    }
  }
  return out;
}

function productionSources(roots: readonly string[] = PRODUCTION_ROOTS): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!/\.tsx?$/u.test(entry.name) || /\.test\.tsx?$/u.test(entry.name)) {
        continue;
      }
      out.push(full);
    }
  };
  for (const root of roots) {
    walk(path.join(repoRoot, root));
  }
  return out;
}

/**
 * Install endpoints on the upstream site. `docs.openclaw.ai` is the live docs host and stays, so
 * the `docs.` prefix is excluded rather than the whole domain — and this is the regression that
 * actually happened: an earlier sweep skipped every line matching `openclaw\.ai`, which silently
 * skipped the *install* URLs too and left them pointing upstream.
 */
const UPSTREAM_INSTALL_ENDPOINT = /(?<!docs\.)openclaw\.ai\/(?:install|cli|download)/iu;

/**
 * Docs and CI workflows are what a *user* reads and what CI *runs*, so the ecosystem rule that
 * applies to shipped copy applies here too. `repoTextFiles()` is deliberately not reused: it also
 * collects this very file, whose pattern literals would trip their own rule.
 */
function userFacingSources(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    if (!fs.existsSync(dir)) {
      return;
    }
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (/\.(?:md|mdx|ya?ml)$/u.test(entry.name)) {
        out.push(full);
      }
    }
  };
  walk(path.join(repoRoot, "docs"));
  walk(path.join(repoRoot, ".github"));
  return out;
}

/**
 * Text files across the whole repository — the rule below is about provenance in comments and
 * docs, not about shipped code, so it cannot reuse `productionSources()`.
 */
function repoTextFiles(): string[] {
  const skip = new Set([
    "node_modules",
    ".git",
    "dist",
    "vendor",
    ".workbuddy-ai",
    ".next",
    "coverage",
  ]);
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (skip.has(entry.name)) {
        continue;
      }
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      // CHANGELOG records upstream PR numbers as history; rewriting it would falsify the record.
      if (/CHANGELOG\.md$/iu.test(entry.name)) {
        continue;
      }
      if (/\.(ts|tsx|js|mjs|md|mdx|json|ya?ml|sh|py)$/u.test(entry.name)) {
        out.push(full);
      }
    }
  };
  walk(repoRoot);
  return out;
}

/**
 * Upstream artifacts referenced by id — issue/PR numbers and commit hashes. Deriving the host from
 * `CANONICAL_PROJECT_URL` keeps this honest: it flags *this* repository claiming an upstream id,
 * whatever the repository ends up being called.
 */
function repointedUpstreamArtifacts(): string[] {
  const host = CANONICAL_PROJECT_URL.replace(/^https?:\/\//u, "").replace(
    /[.*+?^${}()|[\]\\]/gu,
    "\\$&",
  );
  const repointed = new RegExp(`${host}/(?:issues|pull|commit)/(?:\\d+|[0-9a-f]{7,40})\\b`, "u");
  const out: string[] = [];
  for (const file of repoTextFiles()) {
    if (repointed.test(fs.readFileSync(file, "utf8"))) {
      out.push(path.relative(repoRoot, file));
    }
  }
  return out;
}

/** Comments are stripped on purpose: a mention in a comment is not an outbound identity. */
function codeLines(file: string): string[] {
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/u.test(line));
}

describe("outbound identity", () => {
  it("canonical constants identify this product, not the upstream project", () => {
    expect(CANONICAL_PRODUCT_NAME).toBe("LCX Agent");
    expect(CANONICAL_PROJECT_URL).not.toMatch(/openclaw/iu);
    expect(CANONICAL_PRODUCT_NAME).not.toMatch(/openclaw/iu);
  });

  it("no production module hardcodes an upstream outbound identity header", () => {
    const violations: string[] = [];
    for (const file of productionSources()) {
      const rel = path.relative(repoRoot, file);
      for (const line of codeLines(file)) {
        for (const rule of UPSTREAM_IDENTITY_PATTERNS) {
          if (rule.pattern.test(line)) {
            violations.push(`${rel}: ${rule.id}`);
          }
        }
      }
    }
    expect(violations).toEqual([]);
  });

  // Matching the *use site* rather than the file is deliberate: a file that still imports the
  // constants but sets a literal header would pass a `toContain` check while sending the wrong
  // identity. Anchor on the header assignment itself.
  it("no production module links a user to the upstream repository outside comments", () => {
    const violations: string[] = [];
    for (const file of productionSources()) {
      const rel = path.relative(repoRoot, file);
      for (const line of codeLines(file)) {
        if (UPSTREAM_REPO_LINK.test(line)) {
          violations.push(rel);
        }
      }
    }
    expect([...new Set(violations)]).toEqual([]);
  });

  it("no production module links a user to the upstream website outside comments", () => {
    const violations: string[] = [];
    for (const file of productionSources()) {
      const rel = path.relative(repoRoot, file);
      for (const line of codeLines(file)) {
        if (UPSTREAM_WEBSITE.test(line)) {
          violations.push(rel);
        }
      }
    }
    expect([...new Set(violations)]).toEqual([]);
  });

  it("no user-visible copy calls the product by the upstream name", () => {
    const violations: string[] = [];
    for (const file of productionSources()) {
      const rel = path.relative(repoRoot, file);
      if (SELF_NAME_EXEMPT.has(rel)) {
        continue;
      }
      for (const line of codeLines(file)) {
        UPSTREAM_SELF_NAME.lastIndex = 0;
        if (UPSTREAM_SELF_NAME.test(line)) {
          violations.push(rel);
        }
      }
    }
    // Bundled skills are prompt text injected into the model, so a stale self-name there is
    // strictly worse than in a comment: the model will repeat it. Paths such as
    // `~/.openclaw/openclaw.json` are legitimate and are skipped per line, not per file.
    for (const file of bundledSkillManifests()) {
      const rel = path.relative(repoRoot, file);
      const source = fs.readFileSync(file, "utf8");
      for (const line of source.split("\n")) {
        if (SELF_NAME_ALLOWED_PATH.test(line)) {
          continue;
        }
        UPSTREAM_SELF_NAME.lastIndex = 0;
        if (UPSTREAM_SELF_NAME.test(line)) {
          violations.push(rel);
        }
      }
    }
    expect([...new Set(violations)]).toEqual([]);
  });

  it("no production module points at the upstream skill registry or community server", () => {
    const violations: string[] = [];
    for (const file of productionSources()) {
      const rel = path.relative(repoRoot, file);
      for (const line of codeLines(file)) {
        if (UPSTREAM_ECOSYSTEM.test(line)) {
          violations.push(rel);
        }
      }
    }
    expect([...new Set(violations)]).toEqual([]);
  });

  it("no user-facing doc or workflow points at the upstream registry or community server", () => {
    // Docs are where a user is told what to install, and CI is what actually installs it: a
    // `npx clawhub` in a workflow is upstream code execution, not a stale sentence.
    const violations = userFacingSources().filter((file) =>
      UPSTREAM_ECOSYSTEM.test(fs.readFileSync(file, "utf8")),
    );
    expect(violations.map((file) => path.relative(repoRoot, file))).toEqual([]);
  });

  it("no user-facing doc or workflow installs from the upstream site", () => {
    const violations = userFacingSources().filter((file) =>
      UPSTREAM_INSTALL_ENDPOINT.test(fs.readFileSync(file, "utf8")),
    );
    expect(violations.map((file) => path.relative(repoRoot, file))).toEqual([]);
  });

  it("the upstream-ecosystem pattern matches every spelling a past sweep missed", () => {
    // Guard the guard. A clean repository cannot show that the rule still bites, so the samples
    // that historically slipped through are asserted directly — loosening the pattern fails here
    // even while every file scan stays green.
    for (const sample of [
      "https://clawhub.com",
      "https://clawhub.ai",
      "npx clawhub",
      "https://discord.com/invite/clawd",
      "https://discord.gg/clawd",
    ]) {
      expect(UPSTREAM_ECOSYSTEM.test(sample), sample).toBe(true);
    }
    // Contrast: the Discord bot API is a real channel this product calls, so it must not trip.
    expect(UPSTREAM_ECOSYSTEM.test("https://discord.com/api/v10")).toBe(false);
  });

  it("the install-endpoint pattern bites on the upstream installer but not the docs host", () => {
    // Same reason as above, plus the false-positive side: the docs site really does serve
    // `/install/*` pages and those links are still valid, so excluding `docs.` is what keeps
    // this rule from banning the documentation.
    expect(UPSTREAM_INSTALL_ENDPOINT.test("https://openclaw.ai/install.sh")).toBe(true);
    expect(UPSTREAM_INSTALL_ENDPOINT.test("https://openclaw.ai/install-cli.sh")).toBe(true);
    expect(UPSTREAM_INSTALL_ENDPOINT.test("https://docs.openclaw.ai/install/docker")).toBe(false);
    expect(UPSTREAM_INSTALL_ENDPOINT.test("https://docs.openclaw.ai/install")).toBe(false);
  });

  it("no bundled skill ships the upstream registry client", () => {
    const violations = bundledSkillManifests().filter((file) =>
      UPSTREAM_ECOSYSTEM.test(fs.readFileSync(file, "utf8")),
    );
    expect(violations.map((file) => path.relative(repoRoot, file))).toEqual([]);
  });

  it("no extension defaults to installing from the upstream npm scope", () => {
    expect(upstreamNpmExtensions()).toEqual([]);
  });

  it("no upstream artifact id is re-pointed at this repository", () => {
    // A wholesale "swap the repo URL" pass is tempting and mostly right — the repository should
    // point at itself. But `issues/30640`, `pull/812` and `commit/<sha>` are ids minted
    // *upstream*: this fork has its own numbering, so re-pointing them silently produces links
    // that resolve to the wrong ticket or to nothing at all. Generic pages (`/issues`,
    // `/pulls`, `/discussions`, `/releases`) and self-referential paths (`/blob/main/docs`) are
    // the opposite: those genuinely live here and must keep pointing here.
    expect([...new Set(repointedUpstreamArtifacts())]).toEqual([]);
  });

  it("every identity call site assigns its headers from the canonical constants", () => {
    for (const rel of IDENTITY_CALL_SITES) {
      const source = fs.readFileSync(path.join(repoRoot, rel), "utf8");
      expect(source, `${rel} must assign HTTP-Referer from CANONICAL_PROJECT_URL`).toMatch(
        /"HTTP-Referer":\s*CANONICAL_PROJECT_URL/u,
      );
      expect(source, `${rel} must assign X-Title from CANONICAL_PRODUCT_NAME`).toMatch(
        /"X-Title":\s*(?:`\$\{)?CANONICAL_PRODUCT_NAME/u,
      );
    }
  });
});
