# 2026-08-31 raw contract 首轮失败整理

## 结论

本次只记录 blind raw contract 的失败证据，不改变训练集、语料、适配器、provider 或外部通道状态。

| 批次                  | 用例数 | raw contract 通过 | parse error | 结构化失败 | promotion |
| --------------------- | -----: | ----------------: | ----------: | ---------: | --------- |
| selected-clean subset |     18 |                 0 |          10 |          8 | blocked   |
| generated holdout     |     12 |                 0 |           3 |          9 | blocked   |
| 合计                  |     30 |                 0 |          13 |         17 | blocked   |

证据来源：

- `/tmp/lcx-neutral-six-selected-clean-after-contract-20260831.json`
- `/tmp/lcx-neutral-holdout-selected-clean-after-contract-20260831.json`
- holdout case file SHA-256：`4fa2afde315691da965499ea316f057bfd6c64b195cf0776163983a4963c6c1a`

两份 receipt 都明确 `blind_raw_contract`、`labelDisclosure=false`、`responsePrefill=null`、`modelSelfStartMode=unassisted`、`rawContractRequiredForPromotion=true`、`promotionReady=false`。因此不能把这轮结果描述成学习吸收或可晋升。

## 失败族

### 1. JSON 闭合/生成稳定性优先

- 13/30 用例在字段评分前失败：11 个 `initial_parse`，2 个 `generation_timeout`。
- parse error 的共同证据是：`blind raw output must be exactly one JSON object with no surrounding text`。
- timeout 用例：`private_credit_nonbank_leverage_stress_waterflow`、`plain_language_hidden_complexity_intake`。
- 这类失败不能回填缺失字段，也不能通过包装或 retry 伪造 raw pass；下一轮先做同尺子的 bounded 重复，保留初始失败与重试结果的对应关系。

可定位的 parse 用例：

- selected-clean：`portfolio_mixed_q_t_nvda`、`broad_finance_module_taxonomy_coverage`、`portfolio_math_without_guessing`、`rate_shock_duration_equity_chain`、`private_credit_nonbank_leverage_stress_waterflow`、`plain_language_hidden_complexity_intake`、`external_knowledge_internalization_protocol`、`recession_soft_landing_scenario_tree`、`scenario_probability_no_model_math_guessing`、`adversarial_scenario_no_guess_02`
- holdout：`gen_6_194280`、`gen_8_207712`、`gen_11_029700`

其余 17 个为结构化失败，可直接按 receipt 中的 `missingFinanceModules`、`missingRequiredData`、`missingRequiredRiskBoundaries` 分桶；不与 parse error 混合计分。

### 2. 来源与可追溯性

结构化失败中最常缺少：

- `source_url_or_local_source_path`：9 次
- `source_timestamp_and_vendor`：6 次
- `actual_reading_scope_receipt` / `actual_reading_scope`：5 次合计
- `source_coverage_limits`：1 次

这些字段缺失时，答案不能被升级为已读、已核验或 exhaustive coverage。

### 3. 当前数据与风险输入

- `fresh_market_data_snapshot`：6 次
- `price_volume_breadth_and_technical_regime_inputs`：6 次
- `commodity_curve_roll_yield_and_inventory_inputs`：5 次
- `position_weights_and_return_series`：3 次
- `red_team_invalidation_evidence`：3 次
- `options_iv_skew_gamma_and_event_calendar`：2 次

这组缺口应保持为“需要补证据”的阻断项，不得用模型猜测、旧数据或空对象补齐。

### 4. 安全边界

- `no_trade_advice`：7 次
- `no_unverified_current_market_data`：6 次
- `technical_timing_not_standalone_alpha`：6 次
- `red_team_invalidation_required`：3 次
- `sample_out_validation_required`：2 次

缺少上述边界时，即使 JSON 可解析，也不构成 contract pass。

### 5. 模块覆盖

高频缺失模块为：`portfolio_risk_gates`（8）、`commodities_oil_gold`（4）、`eval_harness_design`（4）、`technical_timing`（4）、`macro_rates_inflation`（3）、`causal_map`（3）、`source_registry`（3）。模块计数是诊断信号，不是训练标签或晋升分数。

## 下一步顺序

1. 保持训练、eval、MLX 与外部通道 idle。
2. 以现有失败用例为 failure-family 材料，先做一次不同 seed 的 bounded raw 重复；不扩大到六 case，不使用 prefill，不做字段回填。
3. 先修 JSON 单对象闭合与 timeout 观测，再复核来源/当前数据/安全边界字段；每次保留独立 receipt、case file hash 和初始失败引用。
4. raw no-prefill 与 holdout 在同一 contract 下稳定通过前，维持 `promotionReady=false`、`modelWeightAbsorbed=false`，不训练、不 promotion、不恢复 Lark。

## 边界

本整理没有写入 protected memory、语言语料、provider 配置、训练状态或 Lark；它只是可定位的失败材料与下一步队列。
