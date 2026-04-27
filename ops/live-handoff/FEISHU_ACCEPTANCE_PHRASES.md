# Feishu Acceptance Phrases

Use these after a bounded live patch reaches `Projects/openclaw`, builds, restarts, and passes probe.

The goal is not broad chatting. The goal is to verify the exact user-visible seam that was changed.

## Rules

- use 1 to 2 short phrases per patch
- verify the exact seam that changed
- record the phrases and results in the handoff record
- do not claim `live-fixed` without a matching Feishu acceptance check

## Display normalization

### Phrase A

````text
把这段原样回给我：
## Daily Workface

| Item | Value |
|------|-------|
| Tokens | 12345 |

```ts
const ready = true;
````

````

### Expected result

- no raw code fence markers in the Feishu-visible reply
- no heavy markdown table syntax in the Feishu-visible reply
- reply is normalized into readable plain text

### Phrase B

```text
把这个作为普通文本解释给我，不要保留 markdown 壳子：
## Watchtower
- status: stable
````

### Expected result

- heading shell is stripped
- output remains human-readable plain text

## Learning workspace propagation

### Phrase A

```text
learn_topic market regime
```

### Expected result

- the learning report is generated for the current lane
- queue/state/report carry the current lane identity
- the report path is lane-suffixed, not silently shared with another lane

### Phrase B

```text
在另一个 Feishu chat 里再发一次：
learn_topic market regime
```

### Expected result

- the two chats do not collapse into one shared queue row
- each chat produces its own lane-separated report evidence
- validate with:
  - `python3 scripts/learning_acceptance_probe.py`

### Current note

- this acceptance currently verifies **lane metadata hardening**
- it does **not** yet prove full lane workspace directory isolation

## Workface / scorecard / validation dedupe

### Phrase A

```text
给我一个工作面板。
```

Then trigger a real state change and send:

```text
再给我一个工作面板。
```

### Expected result

- if content changed, the updated panel is delivered again
- same-name same-day rewrites are not incorrectly suppressed

### Phrase B

```text
给我最新的验证雷达。
```

Then trigger a real validation or correction change and send:

```text
再给我最新的验证雷达。
```

### Expected result

- updated content is not swallowed by stale dedupe state
- unchanged content may still dedupe normally

## Branch stability

### technical_daily_branch

#### Phrase A

```text
技术日报
```

#### Expected result

- reply maps to the technical daily branch path
- reply content is recognizably technical-daily shaped
- no fallback into unrelated learning or generic chat mode

#### Phrase B

```text
expand technical
```

#### Expected result

- expansion stays on the technical lane
- the branch output remains consistent with the daily technical artifact

### knowledge_maintenance_branch

#### Phrase A

```text
知识维护
```

#### Expected result

- reply maps to the maintenance branch path
- output reads like a maintenance/control snapshot, not market commentary

#### Phrase B

```text
维护状态
```

#### Expected result

- reply stays in maintenance mode
- output reflects branch-style maintenance knowledge instead of drifting into another specialist lane

## Short operator check

After the patch-specific phrase, optionally send:

```text
现在回复我一句确认。
```

### Expected result

- confirms the gateway is still responsive after the live patch
