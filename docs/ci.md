---
title: CI Pipeline
description: How the LCX Agent CI pipeline works
summary: "CI job graph, scope gates, and local command equivalents"
read_when:
  - You need to understand why a CI job did or did not run
  - You are debugging failing GitHub Actions checks
---

# CI Pipeline

The CI runs on every push to `main` and every pull request. It uses smart scoping to skip expensive jobs when only docs changed.

## Job Overview

| Job               | Purpose                                                | When it runs                                      |
| ----------------- | ------------------------------------------------------ | ------------------------------------------------- |
| `docs-scope`      | Detect docs-only changes                               | Always                                            |
| `changed-scope`   | Detect which areas changed (node/windows)              | Non-docs PRs                                      |
| `check`           | TypeScript types, lint, format, and strict TS smoke    | Push to `main`, or PRs with Node-relevant changes |
| `check-docs`      | Docs format, lint, and broken link check               | Docs changed                                      |
| `deadcode`        | Dead-code scan (knip / ts-prune / ts-unused-exports)   | Gated on `OPENCLAW_ENABLE_DEADCODE=true`          |
| `secrets`         | Secret scan, workflow audit, and prod dependency audit | Always                                            |
| `build-artifacts` | Build dist once, share with other jobs                 | Non-docs, node changes                            |
| `release-check`   | Validate npm pack contents                             | Push to `main` only                               |
| `checks`          | Node/Bun tests + protocol check                        | Non-docs, node changes                            |
| `checks-windows`  | Windows-specific tests                                 | Non-docs, windows-relevant changes                |
| `skills-python`   | Ruff lint + pytest for `skills/`                       | Non-docs, node changes                            |

## Fail-Fast Order

Jobs are ordered so cheap checks fail before expensive ones run:

1. `docs-scope` + `secrets` (no dependencies; run first)
2. `changed-scope` (needs `docs-scope`)
3. `build-artifacts`, `check`, `check-docs`, `checks`, `checks-windows`, `skills-python`
   (need scope detection; `deadcode` joins here when enabled)
4. `release-check` (needs `build-artifacts`)

Scope logic lives in `scripts/ci-changed-scope.mjs` and is covered by unit tests in `src/scripts/ci-changed-scope.test.ts`.

## Runners

| Runner           | Jobs                                       |
| ---------------- | ------------------------------------------ |
| `ubuntu-latest`  | Most Linux jobs, including scope detection |
| `windows-latest` | `checks-windows`                           |

## Local Equivalents

```bash
pnpm check          # types + lint + format
pnpm test           # vitest tests
pnpm check:docs     # docs format + lint + broken links
pnpm release:check  # validate npm pack
```
