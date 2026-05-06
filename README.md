# LCX Agent

![LCX Agent 架构图](docs/assets/lcx-agent-architecture.png)

[![LCX Agent 能力看板](docs/assets/lcx-agent-daily-progress-wave.svg)](docs/assets/lcx-agent-daily-progress-wave.svg)

LCX Agent 是一个个人 AI 研究操作系统。它的核心不是某个单点模型，而是一套围绕长期运行设计的架构哲学：Harness 负责约束和验收，Hermes 负责消息和证据流转，本地大脑负责沉淀记忆，大模型负责拆解与审阅。

它把飞书 / Lark 作为主控制室入口，把自然语言请求路由到研究、学习、运维和审计链路；同时把学习结果、证据、错误修正和运行状态保存成本地 artifact。它不是自动交易机器人，而是低频金融研究、筛选和风控辅助系统。

这个仓库是 `lcx1215/lcx-s-openclaw` 开发分支，用来设计、验证和迁移 LCX Agent 的长期运行能力。OpenClaw 在这里主要是底层 runtime 和多渠道 gateway，不是项目叙事的中心。

## 30 秒版本

如果只用一句话介绍：

> LCX Agent = Harness 约束层 + Hermes 消息层 + 飞书控制室 + 本地大脑 + 金融研究工作流。

它解决的问题不是“让大模型多说一点”，而是让一个长期运行的个人研究系统能稳定做到：

- 听懂自然语言请求，不要求用户记住复杂命令。
- 把任务拆到研究、学习、运维、审计等内部模块。
- 用 Harness 思路把能力关进可验证边界：权限、风险、质量门、dev/live 状态都要有证据。
- 用 Hermes 思路传递消息、意图、上下文和 receipt，让模块之间靠 artifact 对齐，而不是靠聊天幻觉。
- 用 MiniMax、Kimi、DeepSeek 等大模型做任务拆解、审阅和生成。
- 用本地大脑沉淀记忆、模块化思考和可复用经验。
- 把 dev-fixed 和 live-fixed 分清楚，避免把本地通过误报成线上可见。
- 对金融研究保持低频、研究型、风险优先，不做自动交易。

## 架构哲学：Harness + Hermes

LCX Agent 的设计更接近一个可长期运行的研究系统，而不是一个“调用 LLM 的聊天机器人”。

| 概念    | 在系统里的含义                                                                         |
| ------- | -------------------------------------------------------------------------------------- |
| Harness | 约束层。负责权限、风险门控、质量门、测试、eval、live 验收和失败显式化。                |
| Hermes  | 消息层。负责把用户意图、模块计划、上下文包、handoff、receipt 和 review 结果传递清楚。  |
| Brain   | 沉淀层。负责把高价值样本、修正笔记、能力卡和审阅结果变成可复用记忆。                   |
| LLMs    | 推理层。MiniMax、Kimi、DeepSeek 等大模型负责拆解、生成、审阅，本地模型负责吸收和沉淀。 |
| Runtime | 执行层。提供 gateway、channel、session、CLI 和工具调用能力。                           |

这个分层的目的很简单：大模型可以强，但不能裸奔。它必须被 Harness 约束，被 Hermes 传递证据，被本地大脑沉淀经验，最后才变成用户能读懂的回复。

## 核心能力

| 能力                 | 说明                                                                        |
| -------------------- | --------------------------------------------------------------------------- |
| Harness 约束层       | 把权限、风险、质量门、eval、live 验收和失败显式化收成一套工程边界。         |
| Hermes 消息层        | 在用户、路由、大脑、review 和 live 回路之间传递上下文、handoff 和 receipt。 |
| 飞书 / Lark 控制室   | 用户在一个主群或主对话里说自然语言，系统内部完成分类、路由和回复。          |
| Agent 任务路由       | 把请求分到语言理解、研究、学习、运维、审计、finance review 等链路。         |
| 本地学习大脑         | 把有价值的材料蒸馏成样本、能力卡、修正笔记、review artifact 和评估记录。    |
| 证据与 truth surface | 区分已搜索、已学习、已写入、仅推断、dev-fixed、live-fixed 等状态。          |
| 金融研究工作流       | 面向 ETF、主要资产和头部公司，强调基本面筛选、技术面择时和硬风险门控。      |

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
5. Hermes 生成 handoff、context packet、receipt 和 review artifact，方便之后复盘和学习。
6. Harness 检查边界：research-only、无交易建议、无假 live-fixed、失败必须显式化。

## 这个项目不是什么

- 不是自动交易系统。
- 不是高频策略或执行引擎。
- 不是“学一切赚钱知识”的泛化机器人。
- 不是把本地测试通过就宣称线上修好了的 demo。
- 不是围绕底层框架品牌包装的 fork；底层 runtime 只是支撑，LCX Agent 的重点是 Harness、Hermes、记忆和研究工作流。

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
2. 用 Harness 收紧权限、风险、测试、eval 和 live 验收。
3. 用 Hermes 收紧上下文包、handoff、receipt 和 review artifact 的传递。
4. 保持语言 corpus、学习大脑 artifact、finance doctrine 互不污染。
5. 让本地 Qwen / local brain 吃进大模型审阅和蒸馏结果。
6. 用 MiniMax 等大模型额度做持续高质量任务拆解、审阅和训练样本沉淀。
7. 对 live migration 留下可追踪证据，不把 dev-ready 说成 live-fixed。

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

## live promotion

LCX Agent 不再推荐手动记忆“dev 仓同步 live 仓”的细碎步骤。常规只用一条命令：

```bash
pnpm lcx:live
```

这条命令会做：

1. 如果 dev 工作树有未提交 WIP，自动创建当前 `HEAD` 的临时干净快照。
2. 从干净 git 快照复制到 live sidecar，不把脏 WIP、protected memory、`dist` 或 receipt 混进去。
3. 在 live sidecar 里安装依赖、build。
4. 把 LaunchAgent 重装到 live sidecar。
5. restart gateway。
6. 跑 `channels status --probe`。
7. 写入 promotion state、receipt 和下一条 Lark 验收短语。

live sidecar 默认在：

```bash
~/.openclaw/live-sidecars/lcx-s-openclaw
```

默认 dry-run 不改 live：

```bash
pnpm lcx:promote-live
```

查看当前 promotion 状态：

```bash
pnpm lcx:live:status
```

receipt 默认写到 live sidecar 的 `branches/_system/promotions/`，当前状态写到 `branches/_system/live-promotion-state.json`。repo 里的 `ops/live-handoff/promotions/` 是本地生成物，不进入 git。

promotion 只代表 live runtime 已经切到某个 git 快照并完成探测。然后还必须发送真实 Lark/Feishu 消息，并检查：

```bash
~/.openclaw/logs/feishu-reply-flow.jsonl
~/.openclaw/logs/gateway.log
~/.openclaw/workspace/memory/
```

只有看到真实入站、路由、回复和用户可见结果，才能说 live-fixed。

状态含义：

| 状态               | 含义                                                        |
| ------------------ | ----------------------------------------------------------- |
| dev-fixed          | dev 仓代码和本地验证通过。                                  |
| live-promoted      | live sidecar 已切到 promotion 对应的 git 快照。             |
| probe-ok           | gateway 和 channel 探测通过。                               |
| live-visible-fixed | 重启后的真实 Lark/Feishu 入站、路由、回复、可见输出都通过。 |

## 底层 runtime

LCX Agent 复用现有 agent runtime 和 gateway 能力，包括多渠道接入、CLI、工具、session、桌面 / 移动端基础能力，以及 live sidecar 运行方式。

OpenClaw 是重要底座，但不是这个 README 的主角。LCX Agent 的主角是 Harness 约束、Hermes 消息流、本地大脑、证据审计和低频金融研究工作流。

底层来源：

- https://github.com/openclaw/openclaw
- https://docs.openclaw.ai
