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
| config file     | `lcx.json`  | `openclaw.json` at the compatibility boundary                   |
| state directory | `~/.lcx`    | `~/.openclaw` at the compatibility boundary                     |

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

### Canonical package/CLI/state slice completed

- `package.json` now declares `lcx-agent`, publishes the `lcx` bin and points
  `./cli-entry` at `lcx.mjs`.
- `openclaw.mjs` remains a thin legacy wrapper into `lcx.mjs`.
- Current source and tests use `lcx-agent/plugin-sdk`; the plugin loader also
  aliases the old `openclaw/plugin-sdk` paths for existing plugin source.
- Config and state names are now active LCX defaults. The OpenClaw-era names
  remain only as explicit compatibility overrides and migration inputs.

### Config/state migration and activation

- `src/config/paths.ts` now exposes `resolveLcxIdentityMigrationPlan` as a
  pure, filesystem-read-only planning boundary.
- With no explicit override, the plan reads the canonical candidates first,
  falls back to existing OpenClaw-era state/config candidates, and selects
  `~/.lcx/lcx.json` as the write target.
- An explicit `OPENCLAW_*` or `CLAWDBOT_*` state/config override remains the
  operator's read/write authority for compatibility and rollback.
- The active `resolveStateDir` and `resolveConfigPath` defaults now resolve to
  `~/.lcx` and `~/.lcx/lcx.json`; explicit `OPENCLAW_*`/`CLAWDBOT_*` overrides
  remain available for compatibility.
- `src/config/io.ts` now exposes an explicit `createLcxIdentityMigrationConfigIO`
  adapter. It reuses the migration plan to keep one read path, one write path,
  write-target backup, audit path, expected-path guards, and rollback receipt;
  `writeConfigFileWithReceipt` is the only new writer surface.
- The adapter reads an existing legacy config while writing only the selected
  canonical target, switches subsequent writes to that target, rejects stale
  split-state plans, and refuses rollback after the target has changed. A
  missing prior target is rolled back by removing only the newly written file;
  an existing target is restored from its verified `.bak` bytes.
- The local activation bridge is enabled only after config I/O and the
  repository-owned state writers (sessions, credentials, queues, backups,
  audit, device identity/auth, pairing, workspace, and channel-local stores)
  received the shared contract and focused rollback/no-split tests.

### Shared state-writer contract completed

`src/config/identity-migration.ts` now owns the common writer contract and raw
receipt/rollback primitives. The contract is explicit about read path, write
path, backup path, audit path, expected paths, rollback target, and
`single-write-target` no-split state. It is opt-in only; ordinary compatibility
readers and writers are unchanged.

The following bounded adapters are implemented and locally tested:

- session store and transcript append: `src/config/sessions/identity-migration.ts`,
  the explicit `identityMigration` option on `saveSessionStore`, and the
  `appendSessionTranscriptForIdentityMigration` adapter; session maintenance
  rotation, transcript archive, and archive cleanup use receipt-backed
  `sessions`/`backups` adapters in `src/config/sessions/store-maintenance.ts`
  and `src/gateway/session-utils.fs.ts`;
- credentials: `src/agents/auth-profiles/identity-migration.ts` and the
  explicit `saveAuthProfileStoreForIdentityMigration` writer; the GitHub
  Copilot token cache in `src/providers/github-copilot-token.ts` uses the same
  credential contract and removes its legacy duplicate before returning;
- outbound queue: `src/infra/outbound/delivery-queue.identity-migration.ts`;
- cron jobs and cron run audit: `src/cron/identity-migration.ts` and the
  explicit `identityMigration` option on `saveCronStore`.
- device identity: the explicit read/write/rollback adapter in
  `src/infra/device-identity.ts`, including key validation and secret-free
  audit records;
- device auth: the explicit token store/clear adapter in
  `src/infra/device-auth-store.ts`, with token values excluded from audit;
- device and node pairing: the shared two-file transaction in
  `src/infra/pairing-files.ts`, wired into the pairing request/update writers
  and rejecting partial canonical/legacy roots.
- exec approvals: the explicit JSON adapter in `src/infra/exec-approvals.ts`,
  with the runtime socket kept outside the file migration boundary;
- restart sentinel: the explicit write/consume/remove adapter in
  `src/infra/restart-sentinel.ts`;
- subagent registry: the explicit v1/v2 registry adapter in
  `src/agents/subagent-registry.store.ts`;
- workspace onboarding state: the explicit state JSON adapter in
  `src/agents/workspace.ts`; the whole default workspace directory, including
  bootstrap files and user data, has a separate directory move/rollback adapter
  in the same module;
- Nostr channel-local bus/profile state: the explicit adapters in
  `extensions/nostr/src/nostr-state-store.ts`.
- Matrix credentials: the explicit credentials read/write/remove adapter in
  `extensions/matrix/src/matrix/credentials.ts`; Matrix storage, crypto
  directory, and storage metadata use the explicit directory/file transaction
  in `extensions/matrix/src/matrix/client/storage.ts`.
- Telegram update offsets and Discord thread bindings: explicit adapters in
  `src/telegram/update-offset-store.ts` and
  `src/discord/monitor/thread-bindings.state.ts`.
- Telegram sticker cache and Discord model-picker preferences: explicit
  single-file adapters in `src/telegram/sticker-cache.ts` and
  `src/discord/monitor/model-picker-preferences.ts`.
- WhatsApp Web multi-file auth state: the explicit directory migration adapter in
  `src/web/auth-store.ts`; custom `authDir` and provider-owned keychain state
  remain outside the state-root authority.
- channel pairing requests and allowlists: the explicit file adapter in
  `src/pairing/identity-migration.ts`, covering both request and account-scoped
  `allowFrom` files.
- Telegram command-menu hash and external replay dedupe: explicit channel-local
  adapters in `src/telegram/bot-native-command-menu.ts` and
  `extensions/external/src/replay-guard.ts`.
- Microsoft Teams conversation/poll stores and voice-call history: explicit
  channel-local adapters in `extensions/msteams/src/conversation-store-fs.ts`,
  `extensions/msteams/src/polls.ts`, and
  `extensions/voice-call/src/manager/store.ts`.
- phone-control: an explicit two-authority transaction in
  `extensions/phone-control/identity-migration.ts` migrates config and armed
  state together and rolls back in reverse order.

These adapters remain available for explicit migration and rollback. The local
default resolver is now active on `~/.lcx`; state-root writers have an explicit
adapter or use the central state-root owner. Workspace-local plugin files,
temporary/browser artifacts, generated media, and diagnostic/doctor probes are
not identity state. Custom workspace paths, custom auth directories, external
OAuth/keychain surfaces, and provider-owned state require an explicit owner
before migration.

### Post-activation writer inventory

This is an owner map for follow-up coverage and compatibility removal. The
paths below were verified against current source call sites; tests and
historical migration fixtures are deliberately not treated as runtime writers.

| surface                 | path/owner                                                                                                                                                                                                                                                       | current write surfaces                                                                                                                                                                                                                  | activation proof still required                                                                         |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Config root             | `src/config/io.ts`                                                                                                                                                                                                                                               | canonical `lcx.json`, `.bak` rotation, config audit                                                                                                                                                                                     | Keep explicit legacy override and rollback evidence                                                     |
| Sessions                | `src/config/sessions/paths.ts`, `src/config/sessions/store.ts`, `src/config/sessions/transcript.ts`, `src/config/sessions/store-maintenance.ts`, `src/agents/session-file-repair.ts`, `src/gateway/session-utils.fs.ts`                                          | session store/transcript/repair/rotation/archive/cleanup adapters; default runtime uses canonical root                                                                                                                                  | Keep legacy fallback isolated and prove no dual-write or split session state                            |
| Agent workspace/auth    | `src/config/agent-dirs.ts`, `src/agents/agent-paths.ts`, `src/agents/auth-profiles/`, `src/agents/subagent-registry.store.ts`, `src/agents/workspace.ts`                                                                                                         | auth, subagent registry, workspace state, and whole default workspace directory adapters                                                                                                                                                | Canonical root propagation, legacy read fallback, permission checks, and token/non-duplication rollback |
| Delivery/schedule state | `src/infra/outbound/delivery-queue.ts`, `src/cron/store.ts`, `src/infra/restart-sentinel.ts`                                                                                                                                                                     | outbound queue, cron store, restart sentinel adapters; replay/cleanup remains                                                                                                                                                           | Durable canonical queue/cron state and replay/rollback evidence                                         |
| Device/security/pairing | `src/infra/device-identity.ts`, `src/infra/device-auth-store.ts`, `src/infra/exec-approvals.ts`, `src/infra/pairing-files.ts`                                                                                                                                    | device identity/auth, exec approvals, and device/node pairing adapters                                                                                                                                                                  | Retain file modes, secret boundary, and recovery proof across the family                                |
| Channel-local state     | Telegram/Discord/Web stores, channel pairing, MSTeams, external replay, voice-call, plus `src/plugins/services.ts`, `extensions/nostr/src/nostr-state-store.ts`, `extensions/matrix/src/matrix/credentials.ts`, `extensions/matrix/src/matrix/client/storage.ts` | Nostr, Matrix credentials/storage, Telegram offset/sticker/command-hash cache, Discord binding/model-picker, channel pairing, WhatsApp Web auth, MSTeams, external replay, and voice-call adapters; custom/provider-owned state remains | Adapter-specific path injection; this does not prove external-channel binding or visible delivery       |
| Operator/runtime state  | `scripts/operator/` owners and `~/.lcx/workspace`                                                                                                                                                                                                                | governance snapshots, receipts, training and external-channel artifacts                                                                                                                                                                 | Separate owner migration and fresh receipts; never silently mix this with core config activation        |

After activation, remaining direct legacy path references must be classified
as a compatibility adapter, a migration fixture, or a real writer.
An external communication surface is intentionally modeled as a replaceable
channel adapter. SMS, visualization, Feishu, or another transport may be
selected later by an explicit binding decision; none is the default identity
or runtime authority for this repository.
Profile state-root derivation in `src/cli/profile.ts` and `src/daemon/paths.ts`
now delegates to `resolveNewStateDirForProfile` in `src/config/paths.ts`; this
keeps profile roots on the canonical `.lcx[-profile]` family. `src/infra/exec-approvals.ts`
likewise derives its default file/socket paths from `resolveNewStateDir` while
retaining the same filenames; its writer is now on the migration contract.
`src/utils.ts` and the session legacy fallback in
`src/gateway/session-utils.fs.ts` now use the same canonical state-root owner.
Session maintenance/archives now have explicit receipt-backed migration
entrypoints, and ordinary runtime calls use the canonical root. The default
workspace directory has an explicit whole-directory move/rollback boundary;
custom `agents.defaults.workspace` paths remain operator-owned inputs. The
workspace-local plugin directory in `src/plugins/discovery.ts` and the doctor
state/config flows are compatibility/migration surfaces, not generic state-root
writers, and remain unchanged.

The two remaining classes are intentionally bounded:

- `workspace/.openclaw/extensions` in plugin discovery/source display is a
  workspace-local plugin ABI. Its owner is the plugin discovery/loader path;
  it must not be treated as the user's global `~/.openclaw` state root.
- `src/commands/doctor-config-flow.ts`, `src/commands/doctor-state-integrity.ts`,
  and `src/infra/state-migrations.ts` contain migration targets and diagnostic
  probes for the current compatibility layout. Their `.openclaw` targets stay
  unchanged until a versioned migration owner supplies a narrower compatibility
  removal, rollback, and no-split-state evidence.

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
