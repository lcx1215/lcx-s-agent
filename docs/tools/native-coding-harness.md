# Native coding harness

`native_coding_harness` runs the configured LCX agent against an isolated Docker
copy of a clean, non-default feature worktree. `cwd` must be the controller's
workspace or a linked worktree of the same Git repository. No source files,
commits, branches, provider settings, or credentials are changed by the harness.

Inputs are `task`, optional `cwd`, `timeoutSeconds`, and `verify`. The owner
controller must supply a trusted verification policy when constructing the tool:

```ts
createNativeCodingHarnessTool({
  workspaceDir,
  agentSessionKey,
  config,
  verification: {
    argv: [
      "/usr/bin/python3",
      "-I",
      "-B",
      "-c",
      "import sys; sys.path.insert(0, '/workspace'); from calculator import add; assert add(2, 3) == 5",
    ],
  },
});
```

The optional model-facing `verify` must exactly match that policy. Supplying it
without a controller policy is blocked. Omitting it uses the controller policy;
if no policy exists, a completed model run is `completed-unverified`. Controllers
can also call `runNativeCodingHarness` with a trusted `verification` argument.
The first version supports only the exact interpreter/flags shape
`/usr/bin/python3 -I -B -c CODE`, where `CODE` is supplied and frozen by the
controller. Script paths inside the artifact, shell entrypoints, and other argv
shapes are blocked before the model starts. This is not a general script-verifier
interface. Import required standard-library modules before explicitly adding
`/workspace` to the module path, and keep independent acceptance assertions in the
controller program. Model-edited tests must not be the sole acceptance authority.
The verifier deadline is at most 30 seconds.

The editor has one task mount, no network or credentials, a read-only container
root, dropped capabilities, and no host/elevated/background execution. The
controller inspects the actual container before dispatch. After the editor is
destroyed, bounded regular-file output is copied and hashed. Symlinks, hardlinks,
special files, and private paths are rejected. Tracked private paths or submodules
block preparation rather than silently producing a partial source snapshot.

A separate verifier container receives a separate copy and fixed controller argv.
A successful receipt means the isolated artifact passed that acceptance policy;
it does not mean the original repository was updated. Receipts expose absolute
`artifactDir`, `patchPath`, and `receiptPath`, with `delivery: "patch/artifact"`.
`sourceUnchanged` is reported only after rechecking the source baseline. Apply the
patch separately after review; this tool never applies it automatically.

Failures retain their task directory and evidence. Cancellation and timeout destroy
owned containers; uncertain cleanup is explicit and cannot yield `verified`.
`reconcileNativeCodingRun(receiptPath)` can clean up an interrupted run after a
restart, but never replays it or infers successful execution. Receipts and
transcripts stay outside the mounted task workspace. Docker unavailability is
`blocked`; there is no host execution fallback.
