## 2026-03-27 Feishu Command Reply Humanization

- Scope: live proxy reply shaping only
- Status:
  - `dev-fixed: yes`
  - `live-fixed: no`

### Failure mode

`feishu_event_proxy.py` was forwarding raw command stdout back to Feishu. This meant status-style commands such as:

- `学习状态`
- `记忆卡片总表`

could leak full JSON payloads to the user. In addition, markdown-heavy command outputs such as:

- `技术日报`
- `topic卡片 ...`

could still look like source text because the proxy reply path was bypassing the Feishu display-normalization layer used elsewhere.

### Bounded patch

- Added a small reply-shaping layer in `feishu_event_proxy.py`
- Humanizes JSON replies for:
  - learning status
  - topic-memory status
- Applies light markdown display normalization to command replies:
  - remove heading markers
  - remove bold markers
  - unwrap fenced code blocks
- Does not change command routing, learner logic, branch logic, or gateway mainline

### Proof

- `python3 scripts/test_feishu_command_reply_shaping.py`
- `python3 -m py_compile feishu_event_proxy.py scripts/test_feishu_command_reply_shaping.py`
- proxy restart completed
- synthetic inbound commands queued successfully for:
  - `学习状态`
  - `记忆卡片总表`

### What changed for users

- `学习状态` no longer needs to appear as raw JSON in Feishu
- `记忆卡片总表` no longer needs to appear as raw JSON in Feishu
- `topic卡片 ...` now drops evidence-link path leakage and most document-shell markers before sending
- `技术日报` now keeps the same content but is compacted into a more chat-like form:
  - `技术日报`
  - `市场快照`
  - `观察点`
  - `动量与波动`
  - `执行与来源说明`
  - `风险提示`

### Out of scope

- did not change upstream branch content quality
- did not change `technical_daily` generation logic
- did not change learner memory architecture
