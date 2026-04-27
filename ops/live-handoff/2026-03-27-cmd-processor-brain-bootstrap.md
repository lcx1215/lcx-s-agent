# Cmd Processor Brain Bootstrap

## Summary

- Patched the legacy `cmd_processor.py` fallback so self-improvement / system-learning prompts no longer return `UNKNOWN`.
- These prompts now use the same live brain bootstrap path as the newer command/router seams.

## Exact failure mode

- `cmd_processor.py` still had no concept of:
  - self-improvement prompts
  - architecture-learning prompts
  - skepticism-first study prompts
- So direct fallback usage of:
  - `系统怎么改造自己`
  - `这个系统下一步该怎么改造`
    would classify as `unknown`.
- This meant the system only partially used the brain:
  - newer command seams did
  - legacy fallback still did not

## Files changed

### live

- `cmd_processor.py`
- `scripts/test_cmd_processor_brain_bootstrap.py`

## Behavior change

- `python3 cmd_processor.py --classify-only --text '系统怎么改造自己'`
  now returns:
  - `action = brain_bootstrap`
- `python3 cmd_processor.py --text '系统怎么改造自己'`
  now returns the live brain bootstrap payload:
  - `intent = study_bootstrap`
  - top result = `knowledge/topic_memory/market_regime.md`

## Validation

- `python3 scripts/test_cmd_processor_brain_bootstrap.py`
- `python3 cmd_processor.py --classify-only --text '系统怎么改造自己'`
- `python3 cmd_processor.py --text '系统怎么改造自己'`
- `python3 -m py_compile cmd_processor.py scripts/test_cmd_processor_brain_bootstrap.py`
- `corepack pnpm exec oxlint cmd_processor.py scripts/test_cmd_processor_brain_bootstrap.py`

## Status

- `dev-fixed: yes`
- `live-fixed: yes`

## Why bounded

- No rewrite of the legacy command processor.
- No new memory type.
- No new branch.
- Only added one bounded fallback action:
  - `brain_bootstrap`
    so legacy command fallback no longer bypasses the installed brain.
