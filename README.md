# LCX Agent

![LCX Agent 架构图](docs/assets/lcx-agent-architecture.png)

[![LCX Agent 能力看板](docs/assets/lcx-agent-daily-progress-wave.svg)](docs/assets/lcx-agent-daily-progress-wave.svg)

LCX Agent 是一个基于 OpenClaw 改造的个人 AI 研究操作系统。

它把飞书 / Lark 作为主控制室入口，把自然语言请求路由到研究、学习、运维和审计链路；同时把学习结果、证据、错误修正和运行状态保存成本地 artifact。它不是自动交易机器人，而是低频金融研究、筛选和风控辅助系统。

这个仓库不是 upstream OpenClaw 的原始 README，而是 `lcx1215/lcx-s-openclaw` 开发分支，用来设计、验证和迁移 LCX Agent 的长期运行能力。

## 30 秒版本

如果只用一句话介绍：

> LCX Agent = 飞书控制室 + Agent 路由 + 持久记忆 + 证据审计 + 金融研究工作流。

它解决的问题不是“让大模型多说一点”，而是让一个长期运行的个人研究系统能稳定做到：

- 听懂自然语言请求，不要求用户记住复杂命令。
- 把任务拆到研究、学习、运维、审计等内部模块。
- 用 MiniMax、Kimi、DeepSeek 等大模型做任务拆解、审阅和生成。
- 用本地大脑沉淀记忆、模块化思考和可复用经验。
- 把 dev-fixed 和 live-fixed 分清楚，避免把本地通过误报成线上可见。
- 对金融研究保持低频、研究型、风险优先，不做自动交易。

## 核心能力

| 能力                 | 说明                                                                     |
| -------------------- | ------------------------------------------------------------------------ |
| 飞书 / Lark 控制室   | 用户在一个主群或主对话里说自然语言，系统内部完成分类、路由和回复。       |
| Agent 任务路由       | 把请求分到语言理解、研究、学习、运维、审计、finance review 等链路。      |
| 本地学习大脑         | 把有价值的材料蒸馏成样本、能力卡、修正笔记、review artifact 和评估记录。 |
| 证据与 truth surface | 区分已搜索、已学习、已写入、仅推断、dev-fixed、live-fixed 等状态。       |
| 金融研究工作流       | 面向 ETF、主要资产和头部公司，强调基本面筛选、技术面择时和硬风险门控。   |
| live 验证回路        | live 变更必须 build、restart、probe，并最好通过真实 Lark 消息验收。      |

## 一个真实链路

用户可以在飞书里问：

```text
我持有 QQQ、TLT、NVDA，未来两周担心利率、AI capex 和美元流动性。
先拆内部模块，给我 research-only 判断，不要交易建议。
```

系统期望做的事：

1. 大模型先做任务拆解，识别这是宏观、ETF、个股、风险和 review 混合问题。
2. 本地大脑给出模块计划，调用已有记忆、历史经验和相关能力卡。
3. finance、math、memory、review 等模块分别参与，但不把内部 JSON 直接甩给用户。
4. 最终回复先给人能读懂的摘要，再给必要的风险边界和后续检查点。
5. 留下 handoff、receipt、review、distillation candidate 等证据，方便之后复盘和学习。

## 这个项目不是什么

- 不是自动交易系统。
- 不是高频策略或执行引擎。
- 不是“学一切赚钱知识”的泛化机器人。
- 不是把本地测试通过就宣称线上修好了的 demo。
- 不是 upstream OpenClaw 的替代品，而是在 OpenClaw runtime 上加了一层个人研究操作系统。

所有金融输出都应视为 research-only，不构成投资建议。

## 为什么强调 dev-fixed 和 live-fixed

LCX Agent 长期运行在真实飞书 / Lark 回路里，所以“本地修了”和“用户真的看到了”必须分开。

| 状态       | 含义                                                                   |
| ---------- | ---------------------------------------------------------------------- |
| dev-fixed  | 开发仓里代码、测试或 smoke 已经通过。                                  |
| migrated   | 改动已同步到 live sidecar。                                            |
| probe-ok   | live gateway 已 build / restart，并且 `channels status --probe` 通过。 |
| live-fixed | 真实 Lark/Feishu 入站、路由、回复和可见输出都被验证。                  |

这套边界能防止 silent failure：系统不能因为“生成过回复”就假装“用户已经收到回复”。

## 当前工程重点

当前默认方向是 baseline hardening，而不是继续扩功能：

1. 消除静默失败。
2. 收紧飞书 / Lark 回复回路。
3. 保持语言 corpus、学习大脑 artifact、finance doctrine 互不污染。
4. 让本地 Qwen / local brain 吃进大模型审阅和蒸馏结果。
5. 用 MiniMax 等大模型额度做持续高质量任务拆解、审阅和训练样本沉淀。
6. 对 live migration 留下可追踪证据，不把 dev-ready 说成 live-fixed。

## 关键目录

| 路径                         | 作用                                                            |
| ---------------------------- | --------------------------------------------------------------- |
| `extensions/feishu/src/`     | 飞书 / Lark 控制室、路由、回复、语言 family 和 live channel。   |
| `scripts/dev/`               | 本地大脑蒸馏、MiniMax quota 使用、system doctor、smoke/eval。   |
| `src/agents/`                | agent runtime、工具目录、模型路由和系统提示组装。               |
| `src/agents/tools/finance-*` | 金融学习、能力卡、source intake、review 和治理工具。            |
| `src/hooks/bundled/`         | 定时学习、修正、记忆卫生、operating loop 和 workface artifact。 |
| `src/auto-reply/`            | 用户可见的命令回复、状态回复和 truth surface。                  |
| `docs/tools/`                | 开发工具和本地大脑训练说明。                                    |
| `docs/assets/`               | README 图和项目展示素材。                                       |

受保护的工作记忆文件，例如 `memory/current-research-line.md`，不应被随手改写。它们是系统状态，不是草稿纸。

## 开发与验证

基础环境：Node 22+，pnpm。

```bash
pnpm install
pnpm tsgo
pnpm test
```

常用的 Lark/Feishu 回归测试：

```bash
pnpm vitest run extensions/feishu/src/bot.test.ts
pnpm vitest run extensions/feishu/src/lark-api-route-provider.test.ts
pnpm vitest run extensions/feishu/src/real-utterances-regression.test.ts
pnpm vitest run extensions/feishu/src/intent-matchers.test.ts
pnpm vitest run extensions/feishu/src/lark-language-handoff-receipts.test.ts
pnpm vitest run extensions/feishu/src/surfaces.test.ts
```

本地大脑 smoke / eval：

```bash
node --import tsx scripts/dev/local-brain-distill-smoke.ts --json
node --import tsx scripts/dev/local-brain-distill-eval.ts --summary-only --json
```

MiniMax quota 持续消耗和训练样本沉淀：

```bash
node --import tsx scripts/dev/minimax-quota-brain-saturator.ts --write
node --import tsx scripts/dev/minimax-provider-quota-saturator.ts --lane coding-plan-search --write
```

## live 迁移验证

live sidecar 默认在：

```bash
~/.openclaw/live-sidecars/lcx-s-openclaw
```

典型验证链路：

```bash
pnpm build
node openclaw.mjs daemon restart
pnpm --silent openclaw channels status --probe
```

然后发送真实 Lark/Feishu 消息，并检查：

```bash
~/.openclaw/logs/feishu-reply-flow.jsonl
~/.openclaw/logs/gateway.log
~/.openclaw/workspace/memory/
```

只有看到真实入站、路由、回复和用户可见结果，才能说 live-fixed。

## 和 OpenClaw 的关系

OpenClaw 提供底座：gateway、多渠道接入、CLI、agent runtime、工具、session 和桌面 / 移动端基础能力。

LCX Agent 在这个底座上增加个人研究操作层：飞书控制室语义、任务路由、金融研究纪律、本地学习大脑、证据留痕、记忆卫生、错误修正和 dev/live 验证边界。

Upstream OpenClaw：

- https://github.com/openclaw/openclaw
- https://docs.openclaw.ai
