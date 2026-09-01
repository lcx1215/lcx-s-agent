# Feishu Learn-Memory Routing Hardening

## Status

- `dev-fixed`: yes
- `live-fixed`: yes

## Exact failure mode

- `学习记忆` contains the broad cue `学习`.
- `feishu_event_proxy.py` therefore treated it as a research-style freeform message and bypassed command classification.
- the event got forwarded to origin instead of the Lobster command seam.
- user-visible result: HTTP `200` with empty body and no proper direct command reply.

## Why dangerous

- explicit learning-memory commands could look like “no reply” or “empty reply”.
- this undermines confidence in the live Feishu command surface exactly where Lobster is supposed to feel operational and reliable.

## Smallest safe patch

- keep the broad research bypass.
- carve out explicit Lobster command phrases so they stay on the command path:
  - `学习记忆`
  - `学习状态`
  - `学习队列`
  - `运行下一条学习`
  - `夜间学习`
  - `learn_topic ...`
  - `topic卡片 ...`

## Live files changed

- `feishu_event_proxy.py`

## Proof tests

- `python3 -m py_compile feishu_event_proxy.py`
- synthetic inbound POST for `学习记忆`
- gateway log confirmation:
  - command classified
  - `run_command code=0`
  - no `forward status=200 bytes=0` for the new post-fix event

## What is now prevented

- `学习记忆` silently bypassing the command seam
- empty `200` response behavior for this explicit operator command

## Out of scope

- this does not solve every NLU ambiguity
- it only protects explicit learning-memory command phrases
