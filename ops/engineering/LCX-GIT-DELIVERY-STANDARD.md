# LCX Git Delivery Standard

This is the repository-specific standard for worktrees, task forks, branches,
commits, pull requests, review, and final convergence. It does not configure
other repositories or change Codex-wide settings.

## Outcome

For one coherent change, the repository should end with:

- all included work accounted for by commits;
- one reviewed PR head or a clearly documented local-only result;
- one clean local `main` worktree after merge and cleanup;
- no untracked temporary worktree, branch, fork, or duplicate delivery;
- unrelated tasks, automation refs, providers, training, credentials, and
  external channels preserved.

## Vocabulary

Keep these objects separate:

| Object            | Meaning                            | Default treatment                          |
| ----------------- | ---------------------------------- | ------------------------------------------ |
| Codex window/task | UI conversation and task history   | inspect only when it affects the Git state |
| Codex task fork   | another task context               | not a Git branch by itself                 |
| Git worktree      | local checkout directory           | one writable task surface                  |
| Git branch        | movable Git ref                    | one branch per independent writable change |
| GitHub fork       | separate remote repository         | never create or delete implicitly          |
| Pull request      | remote review object               | one PR per coherent outcome                |
| Commit            | immutable local/remote change unit | identify by exact SHA                      |

Purple or red UI markers are not evidence of a Git branch, dirty file, open
PR, or active writer.

## Standard operating flow

### 1. Snapshot once

Before mutation, capture one compact snapshot:

```bash
git rev-parse --show-toplevel
git status --short --branch
git worktree list --porcelain
git branch -vv
git remote -v
```

If GitHub is in scope, qualify every command with the exact repository:

```bash
gh pr list --repo OWNER/REPO --state all --limit 30
gh run list --repo OWNER/REPO --limit 15
```

Do not repeatedly dump history, all remotes, or full PR logs when a summary is
enough.

### 2. Allocate write surfaces

- `main` is read-only while parallel work is active.
- Every writable window gets its own worktree and branch when it can change
  files. Read-only investigation does not need a new worktree.
- The integration window is the only surface that combines changes.
- If another task is actively writing the same path, send one short pause
  request and recheck once. Do not wait indefinitely for a named "owner".
- An idle task or a purple sidebar item is not a blocker.

### 3. Finish each task locally

Each task reports only:

```text
branch/worktree | commit SHA | files changed | check run | known gap
```

Stage only proven files. Do not use blanket `git add`, and do not commit a
different window's dirty file. Use the repository's configured commit helper
when available. Verify author and committer identity before publishing.

### 4. Integrate once

The integration window classifies every candidate as `merge`, `preserve`,
`superseded`, or `unknown`.

- Merge only selected commits into one candidate branch.
- Resolve duplicates and conflicts there, not independently in every window.
- Do not review or test every child branch by default.
- Test the integrated delta once at the minimum level required by its risk.
- Keep a short integration note with selected SHAs and excluded items.

### 5. Use the PR path once

The normal sequence is:

```text
local change → local commit → local candidate
→ push candidate → one PR → one review per SHA → CI
→ one coherent fix if needed → merge → sync main
```

The Codex Pull Request feature is a GitHub-side PR, not an offline staging
area. Therefore all multi-window local work should converge before creating the
PR. Do not create one PR per window unless the deliverables are intentionally
independent.

Do not re-trigger review for an unchanged SHA. If review finds a real issue,
make one coherent fix, push one new SHA, and review that SHA once.

### 6. Clean up precisely

After merge or an explicit discard decision, delete only an exact temporary
worktree or branch whose changes are preserved and whose path/ref is no longer
in use. Never use cleanup to make a UI count look small.

Preserve unrelated automation branches and other repositories. If the desired
local topology is only `main`, a long-lived remote feature branch may remain
remote-only when the user explicitly requests it.

## Minimum-sufficient verification

Choose the lowest applicable tier; do not escalate by habit:

| Tier | Change                                                           | Minimum check                                                          |
| ---- | ---------------------------------------------------------------- | ---------------------------------------------------------------------- |
| G0   | read-only, docs, or ref bookkeeping                              | status, staged/path review, `git diff --check` when files changed      |
| G1   | localized code or test change                                    | G0 plus the touched test/package check                                 |
| G2   | shared contract, runtime, workflow, or security path             | G1 plus targeted regression/type/lint checks                           |
| G3   | merge conflict, release, destructive cleanup, or external effect | fresh PR review and required CI; explicit authorization for the effect |

Do not run a full repository suite for G0/G1 unless the changed contract or CI
requires it. Reuse fresh evidence for the same commit SHA. A successful local
check proves only that check; it does not prove merge, deployment, training, or
user-visible delivery.

## Final proof

For the common one-main-worktree target, verify once after cleanup:

```bash
git status --porcelain=v1 --branch
git worktree list --porcelain
git branch --format='%(refname:short)'
git rev-parse HEAD
git rev-parse origin/main
```

Completion requires the requested topology, a clean status, and matching
heads. Report local, commit, PR, CI, review, merge, cleanup, and external
delivery as separate states. If one is not proven, say `unknown` or `blocked`.
