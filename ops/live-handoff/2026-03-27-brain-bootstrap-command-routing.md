# Brain Bootstrap Command Routing

## Summary

- Added a bounded `brain_bootstrap` command seam so natural self-improvement / system-learning prompts now route through the live brain before any later learning or modification decision.
- This closes the gap where `local_corpus_search.py` already knew how to answer:
  - `系统怎么改造自己`
  - `这个系统下一步该怎么改造`
  - `这个架构怎么继续学`
  but the real command / Feishu front path still treated those prompts as non-brain or old generic routing.

## Exact failure mode

- The live brain already existed in:
  - `scripts/topic_memory.py`
  - `scripts/local_corpus_search.py`
- But high-value natural prompts about:
  - self-improvement
  - system architecture learning
  - strategy skepticism
  - study bootstrap
  were not guaranteed to enter the command path as memory-first retrieval.
- `lobster_command_v2.sh` could still route them away from the brain, and Feishu display would still show raw search JSON even if the query reached `local_corpus_search.py`.

## Files changed

### live

- `lobster_command_v2.sh`
- `scripts/local_corpus_search.py`
- `scripts/feishu_nlu_router.py`
- `feishu_event_proxy.py`
- `scripts/test_local_corpus_search_lane_preference.py`
- `scripts/test_feishu_nlu_router.py`
- `scripts/test_feishu_command_reply_shaping.py`

## Behavior change

- `lobster_command_v2.sh --classify '系统怎么改造自己'`
  now returns:
  - `action = brain_bootstrap`
- `lobster_command_v2.sh '系统怎么改造自己'`
  now runs the live brain directly:
  - `intent = study_bootstrap`
  - top result = `knowledge/topic_memory/market_regime.md`
- `scripts/feishu_nlu_router.py`
  now mirrors the same bounded route for direct router usage.
- `feishu_event_proxy.py`
  now formats these results as:
  - `脑内起点摘要`
  instead of leaking raw retrieval JSON to Feishu.

## Validation

- `python3 scripts/test_local_corpus_search_lane_preference.py`
- `python3 scripts/test_feishu_nlu_router.py`
- `python3 scripts/test_feishu_command_reply_shaping.py`
- `python3 -m py_compile scripts/local_corpus_search.py scripts/feishu_nlu_router.py feishu_event_proxy.py`
- `corepack pnpm exec oxlint scripts/local_corpus_search.py scripts/feishu_nlu_router.py feishu_event_proxy.py scripts/test_local_corpus_search_lane_preference.py scripts/test_feishu_nlu_router.py scripts/test_feishu_command_reply_shaping.py`
- `bash lobster_command_v2.sh --classify '系统怎么改造自己'`
- `bash lobster_command_v2.sh '系统怎么改造自己'`
- `python3 scripts/feishu_nlu_router.py '系统怎么改造自己'`
- proxy restart + `curl -s http://127.0.0.1:3011/healthz`

## Status

- `dev-fixed: yes`
- `live-fixed: yes`

## Why bounded

- No new memory type.
- No new branch.
- No rewrite of learner / queue / provider routing.
- Only connected existing brain seams to real command and Feishu entry paths for self-improvement / system-learning prompts.
