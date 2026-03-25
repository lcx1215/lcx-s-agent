# Feishu Input Smoke Runbook

Date: 2026-03-24
Branch: `main`

Use this runbook for low-cost Feishu front-door checks before touching search providers.

## Current provider stance

Do not add Tavily yet.

Current repo-native web search providers already available:

- `brave`
- `perplexity`
- `grok`
- `gemini`
- `kimi`

Only open a provider patch when a real Feishu experiment shows one of these failures:

- search quality is consistently too weak for macro/fundamental work
- latency is too high for normal operator use
- cost is materially worse than an existing provider
- a provider fails on a repeated task shape that matters to the mainline

## Smoke messages

Send these messages from Feishu and check the expected behavior.

### 1. Reset / continue alias

Message:

`继续这个研究线`

Expected:

- treated as high-confidence control input
- normalized into the existing `/new` flow
- current reset/memory hooks run
- operating artifacts refresh

### 2. Fundamental research prompt

Message:

`把这些内容整理进当前基本面研究，并补一个 AAPL 和微软的 follow-up 清单`

Expected:

- stays natural language
- does not normalize into `/new`
- does not trigger reset hooks
- should route as a normal research request

### 3. Macro research prompt

Message:

`查一下最近美国非农、通胀预期和 QQQ / TLT 的关系`

Expected:

- stays natural language
- does not normalize into `/new`
- does not trigger reset hooks
- should remain eligible for normal web-search-backed reasoning

### 4. Frontier research prompt

Message:

`继续这个方法研究，但先检查这个 paper 有没有 leakage 和 overfitting 风险`

Expected:

- stays natural language
- does not normalize into `/new`
- does not trigger reset hooks
- should route as a normal frontier/method review request

## Failure signs

Treat any of these as real regressions:

- a research prompt is rewritten into `/new`
- an empty or whitespace topic/thread id behaves like a valid topic success
- reply text looks like a generic success ack but no real research action follows
- a plain research prompt unexpectedly refreshes reset/memory artifacts

## What to inspect first when something looks wrong

1. `extensions/feishu/src/feishu-command-handler.ts`
2. `extensions/feishu/src/bot.ts`
3. `extensions/feishu/src/feishu-command-handler.test.ts`
4. `extensions/feishu/src/bot.test.ts`

## Decision rule after the smoke

- If front-door routing is wrong: fix Feishu input handling first.
- If routing is right but search quality is weak: compare existing providers before adding a new one.
- If existing providers are good enough: do not spend budget on Tavily.
