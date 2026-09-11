---
name: trader-strategy-lab
description: "将纽约、伦敦、香港机构和交易员的公开方法转成可检验的投资策略；用于策略设计、组合诊断、交易员研究及条件性买卖候选。"
---

# Trader Strategy Lab

把公开方法转成可复核的研究假说和决策包。公开资料不等于私有信号、当前仓位或稳定收益。

## 按任务读取

- 人物/流派：读 [人物档案](references/practitioners.md)，按来源 ID 查 [来源账本](references/sources.json)。
- 策略设计：读 [方法模块](references/strategy-modules.md)。
- 有效性判断：读 [有效性闸门](references/evaluation-gate.md) 和 [模块评分卡](references/method-scorecard.md)。
- 多方向实证：读 [方向矩阵](references/multi-direction-matrix.md) 和 [优先实验](references/priority-experiments.md)；D01–D28 全覆盖、独立晋级。
- 数据受阻：读 [沙箱验证](references/sandbox-validation.md)；只验证合同、时点、成本和阻断逻辑。
- 当前环境/新闻：读 [当前情报](references/current-intelligence.md) 和 [新闻更新](references/news-and-refresh.md)，需要时刷新网络。
- 决策输出：用 [决策包](references/decision-packet.md)；AI/科技对象先读人物档案的对应章节。

## 模式与权限

默认 `research_only`。只有调用者明确选择时，才可使用 `strategy_candidate` 或 `conditional_trade_candidate`；三种模式的 `execution_authority` 都是 `none`，不下单、不转账、不操作账户或凭据。

- `research_only`：解释来源、机制、反证和研究步骤；没有当前数据不写资产级触发。
- `strategy_candidate`：给出冻结规则、基线、成本、情景和失效条件，不写成已触发。
- `conditional_trade_candidate`：只有当前数据、触发、反证、退出、风险预算、流动性和人工确认齐全时才可输出条件方向。

## 证据合同

每个当前数值必须记录 `source`、`source_timestamp`、`observed_as_of`、字段定义、单位/币种、新鲜度和证据状态（`confirmed`/`reported`/`inference`/`uncertain`）。缺项写 `unknown` 或降级。来源健康、调用成功和数据质量分别判断；保存请求时点、来源尝试、失败原因和原始收据。

区分：来源事实、研究推导、当前数据。每个方向冻结市场、工具、期限、标的、规则、基线、成本、压力、失效、流动性和权限。禁止修订值、未来成分、同一收盘信号与成交、幸存者样本和未经说明的代理值。

## 晋级

`method_only → research_candidate → paper_candidate → conditional_trade_candidate`。

- `research_candidate`：有可复现规则、点时数据、简单基线、净成本和无泄漏设计。
- `paper_candidate`：增加至少三个非重叠时期（数据允许时）、稳健性、压力和完整纸面周期。
- `conditional_trade_candidate`：再增加新鲜数据、可观察触发/退出、风险预算、流动性、权限和人工确认。

若优势只来自单一资产、时期、参数、毛收益、管理人自述或媒体数字，停留在 `method_only`/`research_candidate`。

## 必查风险

成本、融资、借券、展期、滑点、容量、跳空、停牌、退市、共同因子和退出天数必须显式处理。13F 不含完整空头且有披露滞后；折价不保证收敛；对冲不等于无风险；delta 中性仍有 gamma/vega/theta；机构执行条件不能默认个人可得。

当前研究状态是“材料与规则可复核”，不是模型学习、收益验证或自动执行系统。
