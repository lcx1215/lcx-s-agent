# LCX Quality Harness

LCX 的质量 harness 是现有 LogicalAgentPool 之上的控制平面，不是另一套
Agent runtime。它直接复用 `buildDefaultLogicalAgentPlan` 的十角色 DAG、同一个
本地模型槽位和既有能力/副作用边界：

```text
现有十角色 DAG
  -> 结构化阶段合同
  -> 证据完整性审查
  -> 草稿与格式化
  -> 反方挑战
  -> 最终预审
  -> 本地确定性 verifier
  -> verified / quality-failed / needs-repair
```

## 它实际增强了什么

- 让一个小参数模型分饰十个有明确责任的逻辑角色，而不是让一次生成直接
  变成最终答案。
- 要求候选输出是结构化 artifact：每个 supported claim 必须引用输入证据，
  不确定内容必须显式说明原因。
- `evidence_integrity`、`adversarial_challenge` 和 `final_precheck` 是三个
  强制审查角色。它们使用同一模型绑定，但拥有不同任务合同和依赖上下文；
  这叫独立角色审查，不冒充三个不同模型。
- 质量闸门是确定性的：十个阶段完成、artifact 合同、证据 grounding、三道
  审查、无副作用，全部通过后才进入 verifier。
- 失败最多按配置重跑一次修复（默认最多两次尝试），把有限反馈传给下一轮；
  不允许无限自我循环。
- `maxConcurrency` 可以显式设为 2，但模型调用仍由既有共享槽位串行化；在
  8GB 机器上默认保持 1，避免并发数量制造假的吞吐。

## 运行和接入

计划与既有池保持同源：

```bash
node --import tsx scripts/operator/lcx-logical-agent-pool.ts --json
```

运行结合质量闸门的无网络演示：

```bash
node --import tsx scripts/operator/lcx-logical-agent-pool.ts --quality-demo --json
```

真实接入时实现 `QualityHarnessOptions.modelInvoker`，把它绑定到现有本地
Qwen/MLX 执行器；不要在 harness 中新增 provider、认证或模型加载器。只有
调用方提供真实的本地 invoker 和确定性 `verify`，才有资格把结果接入实际
工作流。当前 receipt 明确标记 `realModelInferenceObserved: false`，测试和
deterministic demo 不会被包装成真实推理证据。

## 和现有能力的关系

- `LogicalAgentPool` 继续是调度、DAG、失败传播、超时、单模型槽位和副作用
  能力的权威；quality harness 不复制 scheduler。
- `review_panel` 仍负责既有的高风险/多模型 review work order 和本地仲裁，
  不被这个本地质量闭环悄悄替换。
- `local-brain-generalization-harness` 负责样本外泛化证明。一次质量 receipt
  只能证明这次编排和闸门结果，不能证明 Qwen 权重学习、`eval_absorbed`、晋升
  或长期能力。
- `codex_coding_harness` 仍是实际 coding executor，ACP、sandbox、审批和
  coding trajectory 仍由它及 LCX Agent 现有边界负责。质量 harness 可以在
  coding 任务前后提供计划/审查/验证，但不复制 ACP app-server。

## 失败语义

`verified` 需要质量闸门和 verifier 都通过；没有 verifier 时只能是
`completed-unverified`。结构化输出或模型调用失败是 `failed`，审查/grounding
失败是 `quality-failed`，verifier 失败是 `verification-failed`，verifier 明确
无法执行是 `blocked`。这些状态不能互相升级。

逻辑任务超时后先请求取消，并最多等待两秒确认清理；执行器仍未结束时，
失败回执标记 `cleanup_unconfirmed`。池会阻断尚未开始的工作，这些回执没有
`startedAt`，依赖任务按现有 DAG 合同传播失败。真实执行槽位和正在使用的
模型槽位继续占用，直到执行器实际结束才恢复队列。失败回执已经结算不等于
底层工作已经停止，不能靠新建池或提前释放资源掩盖这个缺口。

代表性协作验收复用中央循环、注册的本地工具、LogicalAgentPool 和质量门禁，
不新增工作流 owner。七类离线案例覆盖：显式任务与针对性工具选择、真实工具
参数失败后的有界修正、先索引再补读指定字段、独立角色经 DAG 交接汇合、
反证覆盖缺失时停止、共享池超时清理与跨任务排队隔离、以及同一事实包的
检查点续跑。源时间、完整参数身份、未决字段和失败原因必须随回执保留；
其他任务的结果、已审批但未执行的动作或尚未确认终止的执行器均不能替代证据。

这些案例使用真实本地工具与实际控制流程，决策使用标记为 offline 的脚本。
它们证明接线、事实流转、恢复和停止合同，不能证明模型自主选择质量、真实
模型推理、部署效果或交易收益。模型能力验收需要另外记录真实调用及输出。
本地工具发现无法补读的字段时应保留明确缺口，不为通过验收扩大工具权限，
也不删除反证或把计划、候选、质量通过升级为执行授权。
