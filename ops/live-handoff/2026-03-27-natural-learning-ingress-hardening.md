## 2026-03-27 Natural Learning Ingress Hardening

- Scope: live natural-language learning ingress only
- Status:
  - `dev-fixed: yes`
  - `live-fixed: no`

### Failure mode

Natural language memory / learning requests such as:

- `把这个记住：...`
- `记下来`
- `收进记忆`
- `以后要用`

did not reliably route into the live learning path.

This meant the user still had to remember command seams like:

- `learn_topic ...`

which violated the control-room / natural-language goal.

### Bounded patch

- expanded live routing coverage in:
  - `lobster_command_v2.sh`
  - `scripts/feishu_nlu_router.py`
  - `scripts/learn_nlu.py`
- added generic topic fallback extraction for natural phrases
- kept queue / learner / bookkeeping logic unchanged
- added proxy reply shaping for `learn_nlu_v2` / `learn_branch` JSON payloads so Feishu sees a short human reply instead of raw JSON

### Proof

- `python3 scripts/test_feishu_nlu_router.py`
- `python3 scripts/test_learn_nlu_generic_topic.py`
- `python3 scripts/test_feishu_command_reply_shaping.py`
- `bash lobster_command_v2.sh --classify '把这个记住：market regime 以后要用'`
- synthetic inbound to live Feishu proxy:
  - `把这个记住：market regime 以后要用`
- live log confirms:
  - classify -> `learn_nlu`
  - run_command -> parsed topic `market regime`
  - reply_send succeeded

### What changed for users

The user can now use natural phrases to keep Lobster learning / remembering without needing explicit command syntax.

Example:

- `把这个记住：market regime 以后要用`

now routes into the learning path and returns a short human reply instead of raw JSON.

### Out of scope

- no full lane workspace propagation completion
- no learner content-quality rewrite
- no memory architecture expansion
