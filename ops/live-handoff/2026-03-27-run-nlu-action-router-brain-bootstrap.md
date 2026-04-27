# Run NLU Action Router Brain Bootstrap

## Summary

- Patched the multi-action NLU execution seam so `run_nlu_action_router.py` no longer sends self-improvement / system-learning prompts into clarification.
- These prompts now resolve to a bounded `brain_bootstrap` action and execute the installed live brain via `local_corpus_search.py`.

## Exact failure mode

- `feishu_nlu_parser.py` and `run_nlu_action_router.py` did not recognize:
  - `系统怎么改造自己`
  - `这个系统下一步该怎么改造`
  - architecture/study/skepticism-first prompts in the same family
- So this whole seam returned:
  - `needs_clarification = true`
  - `intent = unknown`
- That meant a real multi-action NLU route still bypassed the brain even after:
  - `lobster_command_v2.sh`
  - `feishu_nlu_router.py`
  - `cmd_processor.py`
  were already aligned.

## Files changed

### live

- `scripts/feishu_nlu_parser.py`
- `scripts/run_nlu_action_router.py`
- `scripts/test_run_nlu_action_router.py`

## Behavior change

- `python3 scripts/feishu_nlu_parser.py '系统怎么改造自己'`
  now returns:
  - `intent = brain_bootstrap`
  - `needs_clarification = false`
- `python3 scripts/run_nlu_action_router.py '系统怎么改造自己'`
  now executes:
  - `action = brain_bootstrap`
  - inner result `intent = study_bootstrap`
  - top result = `knowledge/topic_memory/market_regime.md`

## Validation

- `python3 scripts/test_run_nlu_action_router.py`
- `python3 scripts/feishu_nlu_parser.py '系统怎么改造自己'`
- `python3 scripts/run_nlu_action_router.py '系统怎么改造自己'`
- `python3 -m py_compile scripts/feishu_nlu_parser.py scripts/run_nlu_action_router.py scripts/test_run_nlu_action_router.py`
- `corepack pnpm exec oxlint scripts/feishu_nlu_parser.py scripts/run_nlu_action_router.py scripts/test_run_nlu_action_router.py`

## Status

- `dev-fixed: yes`
- `live-fixed: yes`

## Why bounded

- No new memory type.
- No learner rewrite.
- No new branch.
- Only aligned one remaining NLU execution seam with the already-installed brain.
