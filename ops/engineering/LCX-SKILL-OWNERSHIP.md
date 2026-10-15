# LCX Skill Ownership

The canonical maintained definitions and helper assets are under `skills/`.
[Ownership manifest](lcx-skill-ownership.json) lists this LCX system-development set.

- Project-specific Skills have a relative directory symlink under `.agents/skills/` so Codex can discover them in this checkout. Keep that bridge pointer-only; no second SKILL.md or generated snapshot.
- Portable Skills remain usable through a user-level alias to the canonical package in a verified stable checkout. They use the target repository's owners outside LCX. Do not point resident/user aliases at a disposable worktree.
- LCX's native loader already reads bundled `skills/`; its name precedence deduplicates project/workspace entries. Retire stale user/workspace copies only after verifying the canonical package and current loader.
- Retain unrelated user Skills, OMC Skills, system Skills and plugin packages. Distinct package/runtime responsibility is not redundancy. Preserve historical content outside scanned Skill roots before moving an exact target.
- Historical names in the manifest document removed or missing material and their nearest current workflow. They are not newly registered aliases and must not be recreated from a history index.

## Content and verification

Read [the runtime contract](../../skills/_shared/lcx-runtime-contract.md) before LCX-specific operations. It follows the current architecture, keeps the Harness and TypeScript gates distinct from model adapters, and chooses evidence by actual entry/profile. Qwen training and Feishu paths are optional lane inputs, not universal prerequisites.

Run the focused ownership/manifest checks, Skill syntax checks and applicable existing loader/autocue regressions after changes. Read a fresh native Skill snapshot to verify actual loading; static links do not prove the Codex selector/UI or resident service refreshed.

The sidecar helper requires a current profile's explicit JSON `files` parity list. It validates the complete source/destination set before copying, limits source bytes to 128 MiB, replaces each file through a temporary sibling, reports missing prerequisites or partial application, and never deletes destination directories. It does not decide a runtime profile, bind a provider, restart a service or send a message.

Local file movement, source commit, local integration, runtime Skill load, Codex UI discovery and deployment are separate evidence. Preserve remote delivery authorization and existing runtime owners.
