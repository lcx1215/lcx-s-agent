# LCX 中央 Agentic 主循环（Central Agent Harness）落地计划

## Context（为什么做）

用户核心诉求：**"我要的是全系统整个是个大 agent harness，而不是其中一部分是个 agent harness。"**
经确认，目标形态 = **中央 agentic 主循环 + 可配置 LLM 推理作为决策大脑，且建立在现有六平面架构之上**。

当前现状（诚实评估）：系统是"六平面 + 单一控制室"架构，但执行碎片化——几十个独立 operator 脚本各自单次运行，靠 state 文件+锁协调，没有真正的中央 agentic 闭环。真正的 agent harness 只有一小块（`logical-agent-pool` + 本地小脑）。`lcx-governance-autopilot` 已经是"按序调度一串 owner + 统一 receipt + 产 next-action"的**规则驱动**主循环雏形，只是决策不是 LLM 做的。

**目标产物**：一个 `lcx-central-agent` 守护进程，持续执行

```
感知(perceive state) -> 由可配置LLM推理决策(plan next actions)
-> 调度现有 owner/能力 作为工具(act) -> 读取receipt证据(observe)
-> 写入统一快照+支付ledger(learn) -> 回到感知
```

关键约束（沿用用户长期原则）：

- **LLM 只"提建议"，TS 规则/门禁做最终批准**——模型不碰 provider 配置、外部通道发送、受保护记忆、交易执行（research-only，无执行权限）。
- **复用现有架构**：不重造语义注册表、证据、门禁、dashboard。现有 owner 脚本 = 中央循环可调用的"工具/步骤"；`lcx-flow-graph` 提供步骤图；`lcx-run-receipt` 提供统一证据信封；`lcx-control-room-latest.json` 仍为唯一 dashboard 数据源。
- 不造假、数据可溯源。

## 复用的已有资产（不重造）

| 需要的能力                   | 复用哪个                                                                                     | 位置                                                     |
| ---------------------------- | -------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| 可配置 LLM 决策大脑          | `LogicalAgentModelRouter.invoke()`（primary/fallback/能力校验/output contract/call receipt） | `src/agents/logical-agent-model-router.ts` L266          |
| 可配置 adapter               | `createConfiguredFinanceModelAdapter()`                                                      | `src/agents/configured-finance-model-adapter.ts` L117    |
| workflow→routing 组装        | `createFinanceModelWorkflow()`                                                               | `src/agents/finance-model-workflow.ts` L152              |
| 任务主循环骨架               | `logical-agent-pool` 的 submit/#pump/checkpoint                                              | `src/agents/logical-agent-pool.ts` L534/L743             |
| 步骤/tool 封装范式           | `createFinanceResearchRunTool()` 的 `{name,label,description,parameters,execute}`            | `src/agents/tools/finance-research-run-tool.ts` L71      |
| 现有 owner 命令清单+统一调度 | `OWNER_COMMANDS`、`runOwner()`、`buildSelfRepairAutoSignal`                                  | `scripts/operator/lcx-governance-autopilot.ts` L154/L797 |
| 步骤图/水乘                  | `FLOW_SCENARIOS`、`FlowScenario`                                                             | `scripts/operator/lcx-flow-graph.ts` L88/L25             |
| 统一证据信封                 | `LcxRunSnapshot`、`buildLcxRunReceipt`                                                       | `src/shared/lcx-run-receipt.ts` L33/L153                 |
| 唯一 dashboard 数据源        | `lcx-control-room-latest.json` 的写入链                                                      | `scripts/operator/lcx-governance-autopilot.ts` L1488     |
| 模型 call 证据               | `ModelCallReceipt`、`restoreCompletedModelCalls`                                             | model-router L230/L743                                   |

## 新增组成

新建目录 `src/agents/central-harness/`（TS，mockable、可测）：

1. **`types.ts`** — 定义 `CentralAction`（LLM 提议的动作：ownerId + 参数 + 理由）、`ToolSpec`（name/description/argsSchema/execute，封装 owner 或能力工具）、`CentralStep`、`CentralRunReceipt`。

2. **`model-brain.ts`** — 把 `LogicalAgentModelRouter.invoke()` 封装为"决策大脑"：输入当前感知快照（control-room + backlog + ledger），输出结构化行动JSON（如 `[{action, owner, args, reasoning}]`），带 output contract 校验（复用 project 里既有 negative / policy contract 的写法）。

3. **`tool-registry.ts`** — 把现有子步骤注册为工具（**只读/受控**）：
   - 治理类 owner（commercialAcceptance、flowGraph、mindModel、headTail、monotonicDataLedger…）→ 由 `runOwner` 封装；
   - 能力类（finance research…）→ 复用 `createFinanceResearchRunTool`；
   - 提供 `run(action)` 分发 + 统一 receipt 采集。
   - **边界白名单**：每个 tool 声明它不能触碰的权限（provider/config/外部发送/protected memory/交易），由 TS 门禁校验，模型建议不会越权。

4. **`harness-loop.ts`** — 主循环：perceive → LLM plan → 门禁过滤 → dispatch run → observe receipts → 写 `LcxRunSnapshot`+control-room 投影 + payment ledger → 记录 model call receipt → next。用 `logical-agent-pool` 的 checkpoint/fingerprint 保证跨重启可恢复。

5. **`lcx-central-agent.ts`**（`scripts/operator/`）— 守护入口：`node --import tsx scripts/operator/lcx-central-agent.ts`，读取 `openclaw` 配置里的 providers，跑 harness-loop，追加 `state/lcx-central-agent-log-latest.jsonl`。

6. **`lcx-central-agent.test.ts`** — 用 mock router + mock `runOwner`，验证：pump 收敛、LLM 建议被门禁过滤、receipt 一致性、boundary 白名单（失控建议不越权）。

## 落地顺序（分阶段验证）

1. **Phase A — 骨架 + 大脑**：`types.ts` + `model-brain.ts`（复用 model-router）+ `lcx-central-agent.ts` 守护能读 state 并调 LLM 产 JSON 行动。验证：一次 dry-run 产行动 receipt。
2. **Phase B — 工具注册 + 门禁**：`tool-registry.ts` 包装存量 owner/能力，跑一个治理 owner 作为工具。验证：LLM 建议 + TS 门禁批准后真正执行一个安全 owner（如 flowGraph），receipt 写入。
3. **Phase C — 闭环落账**：`harness-loop.ts` 串 感知→决策→门禁→执行→观测→落账→回环，复用 `lcx-run-receipt` 与 control-room 投影、payment ledger。验证：连续循环后 control-room 快照与 ledger 正确更新。
4. **Phase D — 边界与恢复**：加白名单越权测试、checkpoint/resume。验证：注入一个"模型请求改 provider/发外部消息"的失控建议，被 TS 门禁拦截且无副作用。

## 不改动的部分（明确的"不碰"）

- 不反转模型为语义/证据/门禁/外部通道 authorizer；六大平面与 canonical owner 不变。
- 不动 `lcx-governance-autopilot` 的现有 owner 语义（它作为一个工具被中央循环调用，仍可用 `logical-agent-pool` 作为实现选项，可被 `configured` 理财模型路由大脑调用）。
- 不触碰 provider 配置、外部发送器、受保护记忆、交易执行。
- 与正在后台跑的盲闸重训互不影响（重训只写 trainer 目录与 eval receipt）。

## 验证方式（端到端）

- `pnpm tsgo` 通过（当前仅剩退休 MiniMax 的预存在错误，不在本项目范围）。
- 单测：`pnpm vitest run src/agents/central-harness`。
- 冒烟：`node --import tsx scripts/operator/lcx-central-agent.ts --dry-run --duration-minutes 2` 产一份 JSON 行动且 `boundary` 全是只读。
- 门禁测试：注入越权建议（provider change / external send / trading）断言被拦截、receipt 记 `blocked_by_owner_gate`。
- 与治理对齐：跑过之后 `lcx-problem-cluster-radar`、`lcx-mind-model`、`lcx-flow-graph`、`lcx-owner-control-map` 仍全绿。
