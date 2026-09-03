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
