---
title: "Release Checklist"
summary: "Step-by-step release checklist for the npm package"
read_when:
  - Cutting a new npm release
  - Verifying metadata before publishing
---

# Release Checklist (npm)

Use `pnpm` (Node 22+) from the repo root. Keep the working tree clean before tagging/publishing.

There is no native companion app, so the npm package is the only release artifact.

## Operator trigger

When the operator says “release”, immediately do this preflight (no extra questions unless blocked):

- Read this doc.
- Load env from `~/.profile` and confirm npm credentials are available.

1. **Version & metadata**

- [ ] Bump `package.json` version (e.g., `2026.1.29`).
- [ ] Run `pnpm plugins:sync` to align extension package versions + changelogs.
- [ ] Update CLI/version strings in [`src/version.ts`](https://github.com/lcx1215/lcx-s-agent/blob/main/src/version.ts) and the Baileys user agent in [`src/web/session.ts`](https://github.com/lcx1215/lcx-s-agent/blob/main/src/web/session.ts).
- [ ] Confirm canonical package name `lcx-agent`, this repository’s release identity, and the `lcx` bin pointing to [`lcx.mjs`](https://github.com/lcx1215/lcx-s-agent/blob/main/lcx.mjs). Legacy CLI names are compatibility aliases.
- [ ] Verify workspace compatibility imports against this build; compatibility names do not grant ownership of upstream registry packages.
- [ ] If dependencies changed, run `pnpm install` so `pnpm-lock.yaml` is current.

2. **Build & artifacts**

- [ ] If A2UI inputs changed, run `pnpm canvas:a2ui:bundle` and commit any updated [`src/canvas-host/a2ui/a2ui.bundle.js`](https://github.com/lcx1215/lcx-s-agent/blob/main/src/canvas-host/a2ui/a2ui.bundle.js).
- [ ] `pnpm run build` (regenerates `dist/`).
- [ ] Verify npm package `files` includes all required `dist/*` folders (notably `dist/node-host/**` and `dist/acp/**` for headless node + ACP CLI).
- [ ] Confirm `dist/build-info.json` exists and includes the expected `commit` hash (CLI banner uses this for npm installs).
- [ ] Optional: `npm pack --pack-destination /tmp` after the build; inspect the tarball contents and keep it handy for the GitHub release (do **not** commit it).

3. **Changelog & docs**

- [ ] Update `CHANGELOG.md` with user-facing highlights (create the file if missing); keep entries strictly descending by version.
- [ ] Ensure README examples/flags match current CLI behavior (notably new commands or options).

4. **Validation**

- [ ] `pnpm build`
- [ ] `pnpm test:plugin-sdk:compat` (checks the built LCX SDK; the regular unit command remains build-independent)
- [ ] `pnpm check`
- [ ] `pnpm test` (or `pnpm test:coverage` if you need coverage output)
- [ ] `pnpm release:check` (verifies npm pack contents)
- [ ] `OPENCLAW_INSTALL_SMOKE_SKIP_NONROOT=1 pnpm test:install:smoke` (Docker install smoke test, fast path; required before release)
  - If the immediate previous npm release is known broken, set `OPENCLAW_INSTALL_SMOKE_PREVIOUS=<last-good-version>` or `OPENCLAW_INSTALL_SMOKE_SKIP_PREVIOUS=1` for the preinstall step.
- [ ] (Optional) Full installer smoke (adds non-root + CLI coverage): `pnpm test:install:smoke`
- [ ] (Optional) Installer E2E (Docker, builds and installs this checkout’s LCX package with this checkout’s installer, onboards, then runs real tool calls):
  - `pnpm test:install:e2e:openai` (requires `OPENAI_API_KEY`)
  - `pnpm test:install:e2e:anthropic` (requires `ANTHROPIC_API_KEY`)
  - `pnpm test:install:e2e` (requires both keys; runs both providers)
- [ ] (Optional) Spot-check the web gateway if your changes affect send/receive paths.

5. **Publish (npm)**

- [ ] Confirm git status is clean; commit and push as needed.
- [ ] `npm login` (verify 2FA) if needed.
- [ ] `npm publish --access public` (use `--tag beta` for pre-releases).
- [ ] Do not publish `packages/openclaw` to the upstream namespace. Its name is retained for local compatibility only; publication requires separate package ownership and authorization.
- [ ] Verify the registry: `npm view lcx-agent version`, `npm view lcx-agent dist-tags`, and `npx -y --package lcx-agent@X.Y.Z lcx --version` (or `--help`).

### Troubleshooting (notes from 2.0.0-beta2 release)

- **npm pack/publish hangs or produces huge tarball**: unexpected build output gets swept into the package. Fix by whitelisting publish contents via `package.json` `files` (include dist subdirs, docs, skills). Confirm with `npm pack --dry-run` that only the intended paths are listed.
- **npm auth web loop for dist-tags**: use legacy auth to get an OTP prompt:
  - `NPM_CONFIG_AUTH_TYPE=legacy npm dist-tag add lcx-agent@X.Y.Z latest`
- **`npx` verification fails with `ECOMPROMISED: Lock compromised`**: retry with a fresh cache:
  - `NPM_CONFIG_CACHE=/tmp/npm-cache-$(date +%s) npx -y --package lcx-agent@X.Y.Z lcx --version`
- **Tag needs repointing after a late fix**: force-update and push the tag, then ensure the GitHub release assets still match:
  - `git tag -f vX.Y.Z && git push -f origin vX.Y.Z`

6. **GitHub release**

- [ ] Tag and push: `git tag vX.Y.Z && git push origin vX.Y.Z` (or `git push --tags`).
- [ ] Create/refresh the GitHub release for `vX.Y.Z` with **title `LCX Agent X.Y.Z`** (not just the tag); body should include the **full** changelog section for that version (Highlights + Changes + Fixes), inline (no bare links), and **must not repeat the title inside the body**.
- [ ] Attach the `npm pack` tarball (optional).
- [ ] From a clean temp directory (no `package.json`), run `npx -y --package lcx-agent@X.Y.Z lcx send --help` to confirm install/CLI entrypoints work.
- [ ] Announce/share release notes.

## Plugin publish scope (npm)

Bundled extension names such as `@openclaw/*` are retained for compatibility.
Their presence in this repository or in the public registry does **not** authorize
LCX to publish into the upstream namespace. Bundled extensions ship with the
qualified LCX artifact; preserve each manifest’s `private` setting.

Any independent plugin publication requires a separately authorized LCX-owned
package name, verified registry ownership and an explicit compatibility migration.
Do not derive publication authority from `npm search` results.

Release notes must call out new optional bundled plugins that are not enabled
by default.
