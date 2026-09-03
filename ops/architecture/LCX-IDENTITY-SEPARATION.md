# LCX Identity Separation

## Canonical identity

- Product: **LCX Agent**
- Repository: `lcx1215/lcx-s-agent`
- Git authority: `origin` only
- Default branch: `main` (resolve from the current repository before scripts)

Approved canonical runtime names:

| surface         | canonical   | legacy compatibility                                            |
| --------------- | ----------- | --------------------------------------------------------------- |
| package         | `lcx-agent` | `openclaw` package imports only through a named loader boundary |
| CLI             | `lcx`       | `openclaw` wrapper                                              |
| config file     | `lcx.json`  | `openclaw.json` until read-old/write-new migration              |
| state directory | `~/.lcx`    | `~/.openclaw` until read-old/write-new migration                |

LCX Agent is independent. No upstream repository, vendor, provider, model, or
runtime project is a second authority for source, state, routing, or release.

## Separation rule

Historical identifiers may remain only when a current integration still needs
them. They must be treated as compatibility surfaces, not as product identity.
Do not perform a global search-and-replace across code, environment variables,
package exports, Docker images, app identifiers, state directories, tests, and
historical records in one step.

For each migration slice, record:

```text
legacy surface | canonical replacement | fallback period
owner | focused check | rollback
```

The canonical LCX path must be preferred first; the legacy path may be accepted
only at the compatibility boundary. Removal requires evidence that the fallback
is no longer needed and that existing users or extensions have a migration path.

## Current status

### Separated

- The local Git `upstream` remote has been removed.
- Root product and contribution documentation no longer present an upstream
  project as LCX Agent's authority.
- The repository's only configured Git remote is `origin` pointing to the LCX
  Agent repository.

### Canonical package/CLI slice completed

- `package.json` now declares `lcx-agent`, publishes the `lcx` bin and points
  `./cli-entry` at `lcx.mjs`.
- `openclaw.mjs` remains a thin legacy wrapper into `lcx.mjs`.
- Current source and tests use `lcx-agent/plugin-sdk`; the plugin loader also
  aliases the old `openclaw/plugin-sdk` paths for existing plugin source.
- Config and state names are approved targets but deliberately remain on the
  compatibility path until their own read-old/write-new migration is tested.

### Config/state migration design in progress

- `src/config/paths.ts` now exposes `resolveLcxIdentityMigrationPlan` as a
  pure, filesystem-read-only planning boundary.
- With no explicit override, the plan reads the canonical candidates first,
  falls back to existing OpenClaw-era state/config candidates, and selects
  `~/.lcx/lcx.json` as the write target.
- An explicit `OPENCLAW_*` or `CLAWDBOT_*` state/config override remains the
  operator's read/write authority for compatibility and rollback.
- The active `resolveStateDir` and `resolveConfigPath` defaults are unchanged;
  this slice does not activate `~/.lcx` or create migration state.
- Activation still requires config I/O and every state writer (sessions,
  credentials, queues, backups, and audit) to share the same read/write plan,
  plus focused rollback tests proving no split state.

### Activation-gate writer inventory (first pass)

This is an owner map for the next migration slice, not a claim that the
runtime has already switched. The paths below were verified against current
source call sites; tests and historical migration fixtures are deliberately
not treated as runtime writers.

| surface                 | path/owner                                                                                                                    | current write surfaces                                                  | activation proof still required                                                                          |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Config root             | `src/config/io.ts`                                                                                                            | config file, `.bak` rotation, config audit                              | One selected config path for read, write, backup, audit, expected-path checks, and rollback              |
| Sessions                | `src/config/sessions/paths.ts`, `src/config/sessions/store.ts`, `src/config/sessions/transcript.ts`                           | session store, transcripts, session cleanup/repair                      | Read legacy stores, write one canonical store under lock, and prove no dual-write or split session state |
| Agent workspace/auth    | `src/config/agent-dirs.ts`, `src/agents/agent-paths.ts`, `src/agents/auth-profiles/`, `src/agents/subagent-registry.store.ts` | agent files, auth profiles, subagent registry, model/workspace state    | Canonical root propagation, legacy read fallback, permission checks, and token/non-duplication rollback  |
| Delivery/schedule state | `src/infra/outbound/delivery-queue.ts`, `src/cron/store.ts`, `src/infra/restart-sentinel.ts`                                  | outbound queue, cron store, restart sentinel                            | Durable queue/cron migration with one target root and replay/rollback evidence                           |
| Device/security/pairing | `src/infra/device-identity.ts`, `src/infra/device-auth-store.ts`, `src/infra/exec-approvals.ts`, `src/infra/pairing-files.ts` | device identity/auth, exec approvals, pairing files                     | Read-old/write-new with file modes, secret boundary, and recovery proof                                  |
| Channel-local state     | Telegram/Discord/Web stores plus `src/plugins/services.ts`                                                                    | offsets, sticker cache, thread bindings, OAuth and plugin service state | Adapter-specific path injection; this does not prove external-channel binding or visible delivery        |
| Operator/runtime state  | `scripts/operator/` owners and `~/.openclaw/workspace`                                                                        | governance snapshots, receipts, training and external-channel artifacts | Separate owner migration and fresh receipts; never silently mix this with core config activation         |

Before activation, the remaining direct legacy path references must be
classified as a compatibility adapter, a migration fixture, or a real writer.
Profile state-root derivation in `src/cli/profile.ts` and `src/daemon/paths.ts`
now delegates to `resolveNewStateDirForProfile` in `src/config/paths.ts`; this
is centralization only and still returns the current `.openclaw[-profile]`
compatibility root. `src/infra/exec-approvals.ts` likewise derives its default
file/socket paths from `resolveNewStateDir` while retaining the same filenames.
The first remaining core hotspots are `src/agents/workspace.ts`, `src/utils.ts`,
`src/gateway/session-utils.fs.ts`, `src/plugins/discovery.ts`, and the doctor
state/config flows. Any unclassified reference blocks the default switch.

### Compatibility retained intentionally

The following still require a dedicated migration before removal:

- package name and CLI entry names;
- runtime source filenames and internal `OpenClaw*` type names;
- legacy environment variables and configuration keys;
- Docker/Podman image, command, and state-root names;
- app/bundle identifiers and plugin SDK paths;
- historical changelog entries, fixtures, and wire-level protocol names.

These are implementation compatibility facts, not a reason to restore an
upstream remote or copy upstream configuration. New LCX code must not add new
legacy references unless it is inside a named compatibility adapter.

## Migration order

1. Establish canonical LCX identity and repository authority.
2. Add a canonical package/CLI identity with a tested legacy wrapper.
3. Migrate configuration, environment, state paths, and app identifiers with
   explicit read-old/write-new behavior and rollback.
4. Migrate imports, plugin contracts, Docker, installers, and documentation.
5. Remove compatibility fallbacks only after focused tests and a release note.

Never rewrite Git history or historical release records just to remove a name.
