# 同类投研 Agent 系统现状：GitHub 实测 + 社区做法（2026-09-20）

> 目的：回答"现在别人是怎么做我这种系统的"。只记录**可核验的**事实（API 返回值、README 原文、
> 实测响应），并把取证边界标出来。

---

## 0. 结论先行

1. **这个赛道在 2026 年是拥挤且高速的**：头部项目周更，TOP 项目 star 10 万级且**当天还在提交**。
2. **分成两派，而你已经站在其中一派**：**Skills 派**（方法论是 markdown，跑在 Claude Code / Codex /
   WorkBuddy 里，无常驻服务）vs **服务派**（FastAPI + React + PostgreSQL + Docker，必须常驻）。
   你的 daemon-free 硬约束属于前者，且比前者的多数项目更极端（他们只是"不用自己起服务"，你是"不许有服务"）。
3. **你已领先的一块是数据连接器 + 可复现探活**——Star 1.6 万的 `ai-berkshire` 把 MCP 数据接入还写在
   TODO 里；而"端点是不是还活着"这件事，头部项目是靠**线上出事才发现的**，没有常规探活。
4. **你明确落后的一块是"数字从哪来"的可核验闸门**：他们有 grounding gate、计算 DAG、跨源冲突文件、
   引用机器校验。你目前让模型自己把 payload 映射成字段，中间没有一道"这个数字是不是真被观测过"的闸门。
5. **2026 年的行业主题就是"数据要说明自己是什么"**（Vibe-Trading v0.1.15 原话）。这与你这周做的事
   是同一件事——**同一类 bug，两边各发现一次**。

---

## 1. 取证边界（先说清楚我能证明什么）

| 证据来源             | 状态          | 说明                                                                                                                                                            |
| -------------------- | ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GitHub Search API    | ✅ 硬数据     | 2026-09-19 实调，含真实 star 数与 `pushed_at`                                                                                                                   |
| 项目 README 原文     | ✅ 一手       | 4 个代表项目逐个抓取                                                                                                                                            |
| **小红书站内内容**   | ❌ **未取得** | 站内搜索需登录 + JS 渲染，直接访问 `xiaohongshu.com/search_result?keyword=…` 返回"页面不见了"；公开搜索引擎不索引小红书笔记。**本报告不含小红书原始笔记证据。** |
| "社区做法"的间接证据 | ⚠️ 二手       | 来自中文项目 README 与被转载到其他平台的中文技术帖子，不是小红书原文                                                                                            |

**替代路径建议**：要真看小红书，需要登录态的浏览器会话（本仓有 `agent-browser` 能力可做），
或 xhslib 一类第三方接口。本次未做，因为需要你的登录态，且我不拿你的账号凭据去抓取。

---

## 2. GitHub 硬数据（2026-09-19 实测 API）

`pushed` = 最后提交日期；距今 >180 天视为停滞。

| 项目                                 |      stars | pushed         | 定位                                               |
| ------------------------------------ | ---------: | -------------- | -------------------------------------------------- |
| `TauricResearch/TradingAgents`       |    107,585 | 2026-09-18     | 多智能体 LLM 金融交易框架（事实标准）              |
| `microsoft/qlib`                     |     48,672 | 2026-09-17     | AI 导向量化投资平台                                |
| `HKUDS/Vibe-Trading`                 |     33,686 | 2026-09-19     | "Your Personal Trading Agent"，一条命令装全套能力  |
| `hsliuping/TradingAgents-CN`         |     31,884 | 2026-07-24     | TradingAgents 中文增强版                           |
| **`xbtlin/ai-berkshire`**            | **16,446** | **2026-09-18** | **价值投资研究框架（Claude Code / Codex skills）** |
| `OpenByteInc/QuantDinger`            |     11,728 | 2026-09-19     | AI Trading OS / vibe trading                       |
| `ValueCell-ai/valuecell`             |     11,006 | 2026-03-09     | 社区驱动多智能体金融平台                           |
| `simonlin1212/TradingAgents-astock`  |      3,375 | 2026-09-16     | A 股多 Agent 投研（龙虎榜/游资/解禁）              |
| **`simonlin1212/Vibe-Research`**     |  **2,523** | **2026-09-16** | **A/美/港个人投研工作台，117 端点**                |
| `ginlix-ai/LangAlpha`                |      1,757 | 2026-09-19     | "Claude Code for Financial Market"                 |
| `KylinMountain/TradingAgents-AShare` |        836 | 2026-09-18     | 15 名 Agent；**支持 LCX Agent / Claude Code 集成** |
| `LLMQuant/awesome-trading-agents`    |        826 | 2026-08-13     | MCP servers + agent skills 清单                    |
| **`kyky2347/ALTA`**                  |    **552** | **2026-09-13** | **evidence-first research（与你的理念最像）**      |

**观察**：30 个仓库里只有 2 个停滞（`valuecell` 3 月、`FinMem` 2024 年）。这不是一个可以慢慢做的赛道。

---

## 3. 四个代表系统怎么做的

### 3.1 `ai-berkshire`（16.4k）— Skills 派，最像你的方向

**三层架构**（README 原文）：Skill 层（20 个明确入口）→ Agent 层（Team Lead 并行调度 4 个大师视角
Agent，各自独立搜索、独立判断、互相挑战）→ 工具层（精确计算、实时检索、报告抽检）。

- **方法论载体**：`skills/*.md`（Claude Code commands），另有 `codex-skills/*/SKILL.md` 由脚本从同一份
  canonical workflow 同步生成。**一份源文件，两套客户端入口**。
- **数据**：**没有自建数据层**，靠 Agent 联网搜索；只有 `tools/financial_rigor.py` 做校验。
  未来方向里明确写着：`基于MCP的实时数据接入（Wind/Bloomberg/Yahoo Finance）` —— **还是 TODO**。
- **防幻觉**：至少 2 个独立来源交叉验证、误差 >1% 告警；所有计算用 `decimal.Decimal`，**不用 float**
  （原文：`0.1 + 0.2 = 0.3` 在金融场景中不允许失败）；Benford 定律检测；市值手算校验（股价×总股本）。
- **反偏见**：信息丰富度 A/B/C 评级（防止"资料多=确定性高"）、8 条红线快速否决、反共识检查、
  **留白原则**（数据不足时标"灰色地带"，不用推测伪装确定性）。
- **部署**：无需常驻服务，纯 prompt + 客户端。
- **产出**：2347 份报告 / 110 家公司 / 23 专题。

### 3.2 `ALTA`（552 stars）— evidence-first，理念与你最近

- **执行闸门**：Shadow / Broker API 两模式；**Paper / Live 是账户设置，不是第三种模式**。
  授权绑定 provider + account + environment + configuration revision。
  后端只接受持久化的研究产物与独立审计产物，**不接受浏览器提交的订单**。
- **证据**：Opportunity 是持久研究身份，版本化 thesis；
  `Evidence（sources · event/observation times · content hashes）` /
  `Hypothesis（含 falsifier）` / `Reviews（锁定评估）` / `Expression` / `Follow-up`。
  **事件时间与检索时间分离**（原文：a newly fetched page may describe an old event）。
- **决策链**：两个评估者在看到对方之前先提交 → moderator 只面对已保存记录 → **排序由代码实现，
  不是再找一个 Agent 投票** → 独立 auditor 选一个方案或 Wait。
- **诚实声明**："These are implementation states, **not six live-account acceptance results**"；
  三类证据分开（软件检查 / 已记录的研究运行 / 前瞻投资结果）；`916 passing tests`。
- **部署**：React console + Node gateway + Python research service + PostgreSQL + Redis。**需要常驻**。

### 3.3 `Vibe-Trading`（33.7k）— 服务派，工程密度最高

规模：27 个数据源 / 18 connectors / 14 brokers / 74 MCP tools / `quantlib` 306 个已测函数 / 8 种语言。
**部署**：FastAPI + React 19 + Electron 桌面壳 + Docker。**需要常驻**。

它 2026 年 8–9 月的 changelog 几乎是"金融数据正确性教科书"，主题原话：

> **The theme of this cycle is data that says what it is** — 而三个最大的修复是同一个 bug 换了三件衣服：
> **一个默认值悄悄用看似合理的值替代缺失值，下游无法与真实观测区分。**

具体三类（均可迁移到你）：

1. 缺失输入仍能算出数：`462` 个 alpha 里 **84 个**在输入全空的那根 bar 上照样返回一个数字，
   而 `dropna()` 恰好是"把缺口挡在 IC 之外"的机制，于是这些常数**被当成真信号消费**。
2. 默认值造出不存在的收益：`pct_change()` 默认前向填充，缺失收盘价变成**从未发生的 0.0% 收益**；
   逐个修了 4 处后做穷尽扫描，**10 个文件里还有 24 处**。
3. 声明了却没实现：`futures` loader 链写着 `tushare` 和 `akshare`，**两者根本没实现期货端点**，
   每个合约都掉到 A 股股票端点上。

以及一条与你这周修的 bug **同类**的（2026-09-19）：

> A-share shareholder counts work again after an upstream column rename; **rejected queries now report
> the provider's error instead of claiming the stock has no disclosure**.

——即"厂商报错被当成'没有数据'"。这正是我修 `detectVendorBusinessError()` 抓的那类问题
（HTTP 200 + `isError:false` + payload 里 `code:2003 Missing X-api-key`）。**两边独立发现同一类坑。**

其他值得抄的原则：

- **provenance 命名真正服务的 loader**，带 fallback 标记与复权标签；volume 单位随源变化会被发现
  （A 股成交量曾因回退源切换跳 100×）。
- **grounding gate**：模型在一个 `figures` 块里声明每个数字的性质
  （`observed` / `derived` / `proposed` / `cited` / `count`），门只读数字形状并对照本轮工具结果检查；
  失败的答案不是整段拒绝，而是**把对不上的数字剪掉**（`（omitted※）`）。
- **fail closed**：报告审计器曾跳过所有没取到值的条目然后报 PASS（"certifying a report backed by
  no evidence at all"）；刷新失败的源是 error 且**从合计中剔除**，不做陈旧缓存。
- **NOT_EVALUABLE**：离线评测在缺少必要探针时输出 `NOT_EVALUABLE`，**而不是 pass**。
- 明确 `source="fmp"` 时失败要大声失败，**不能返回另一个源的数字却署着 FMP 的名**。

### 3.4 `Vibe-Research`（2.5k）— 中文 A 股，形态与你最接近

- **数据**：注册表 **117 个端点 / 30 层**，覆盖 CN / US / HK。
- **三级约束，不靠提示词**：提示层（`AGENTS.md` + `.agents/skills/`）→ 执行层（sandbox / hooks /
  受控 MCP）→ 编排层（orchestrator + validator + calc + gate）。
- **证据产物**（每次研究落盘）：`evidence.json`（每条含来源、资料期、原文引用）、
  `calculations.json`（**派生数字的输入、函数与计算 DAG**）、`conflicts.json`（跨源冲突不静默取舍）、
  `manifest.json`。
- **两条硬话**：「不把空缺当成零，也不把无法验证的结果当作已完成」；
  「Agent 研究阶段无网络；取数由编排器用受控脚本完成，原始响应落盘并记录哈希」。
- **引用机器校验**：`[资料:<id> p.<页码>]`，漏引、错引、未知引用**被机器校验拒绝**。
- **合规边界**：只出数据、分析框架、情景概率和裁决点，**不提供建仓、加减仓、目标价或止损位**。
- **测试**：orchestrator 853 / desktop 84 / Python 754。
- **部署**：本机浏览器工作台（React + Vite）+ Python 后端，`scripts/start` 一次起两端，绑定 127.0.0.1。
  **半常驻**（用完 Ctrl+C 停）。
- **模型接入**：复用用户已有的 Codex / Claude Code / **WorkBuddy / CodeBuddy** 订阅，或填 API。
  「模板存在不等于已通过兼容矩阵，界面区分"已实测"和"有模板、未实测"」。

---

## 4. 横向对比

| 维度           | ai-berkshire         | ALTA                   | Vibe-Trading                | Vibe-Research                        | **LCX（你）**                                                                                          |
| -------------- | -------------------- | ---------------------- | --------------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------ |
| 方法论载体     | markdown skills ×20  | 角色提示 + 代码闸门    | skills + quantlib           | `AGENTS.md` + skills                 | **Skill + 分层代码**                                                                                   |
| 数据层厚度     | 无（靠搜索）         | 6 connectors           | 27 源 / 18 conn / 14 broker | **117 端点 / 30 层**                 | 21 声明 / 13 实测                                                                                      |
| 端点探活       | 无                   | 无                     | **无（靠线上出事发现）**    | 有健康巡检                           | **✅ 可复现 CLI**                                                                                      |
| 证据产物       | 报告                 | 版本化 thesis + hashes | figures 声明 + provenance   | evidence/calc/conflicts/manifest     | ✅ observation（含时间戳/来源/定义）                                                                   |
| 确定性计算     | `Decimal` + 手算校验 | —                      | `quantlib` 306 已测函数     | `calc/` + 计算 DAG                   | ✅ `quant_math` 工具（1090 行，Sharpe/Sortino/Beta/CAGR/MDD/组合风险贡献/期权/债券），已注册、已被调用 |
| 计算可追溯     | —                    | —                      | —                           | `calculations.json`（输入+函数+DAG） | ❌ **调用不留痕**（receipt/ledger/persist 零命中）                                                     |
| grounding gate | 多源交叉验证         | 独立审计               | ✅ figures 声明 + 剪数字    | 引用机器校验                         | ❌ **无**                                                                                              |
| 执行闸门       | none（纯研究）       | Shadow / Broker，Paper | Live 是账户设置             | Shadow + live fails closed           | **完全不出交易建议**                                                                                   | research_only → live_execution（适配器仍 paper） |
| 部署形态       | 无常驻               | **常驻**（PG+Redis）   | **常驻**（+Electron）       | 本机起两端                           | **daemon-free（硬约束）**                                                                              |
| 测试规模       | —                    | 916                    | 大量                        | 853+84+754                           | 133（本次相关子集）                                                                                    |

---

## 5. 对你系统的判断（意见，已与事实分开）

### 已领先（有证据）

1. **分层**：声明 / 传输（MCP ∥ REST）/ 证据 / 编排 / 方法论五层分离——上面四个项目里，只有
   Vibe-Research 的"三级约束"接近，其余都是提示词 + 客户端。
2. **可复现探活**：`lcx-finance-connector-probe.ts` 17 秒跑完 21 个连接器，五态判定。
   头部项目**没有这个**，所以他们是在 changelog 里一条条修"上游改列名了"。
3. **daemon-free 是硬约束**，不是顺带的选择——他们里没有任何一个做得到。

### 明确落后（有证据）

1. **计算不可追溯**（原写"没有确定性计算层"，**已更正**——见下方自我纠错）。计算能力本仓已有且已在用，
   缺的是"这次计算用了什么函数、什么输入、得出什么"的留痕。Vibe-Research 有 `calculations.json`
   （派生数字的输入、函数与计算 DAG）。
   另注：本仓计算走 float，而 `ai-berkshire` 连 `0.1+0.2` 都不肯用 float、一律 `Decimal`——
   这一条是否要跟进，取决于你是否会遇到长链路复利/小数累加场景，目前无证据表明已出问题。
2. **没有 grounding gate**。Vibe-Trading 让模型声明每个数字是 `observed/derived/proposed/cited/count`
   再对照工具结果检查，对不上的**剪掉**而不是整段拒绝。你现在没有这道闸门。
3. **没有跨源冲突产物**（`conflicts.json`）。你只有一个源的映射，还没遇到"两个源打架"；
   等你有第二个免凭据源就会撞上。
4. **数据层厚度**：21 vs 117。但这条**要谨慎看**——他们的 117 里有多少能真取到数是未知的，
   而你的 21 里有 9 个已被实测证明 `auth_required`（没 key 取不到）。**铺量不等于可用**。

### 可迁移（按性价比排序）

| 优先级 | 抄什么                                      | 理由                                                                                                                                                |
| ------ | ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| P0     | **计算留痕（输入 + 函数 + 输出）**          | 计算能力已有（`quant_math`），但调用不留痕，`derived` 数字无法追溯。参考 `calculations.json`；做完即可让 grounding gate 校验 `derived` 而不只是放行 |
| P0     | **grounding gate（figures 声明 + 剪数字）** | 直接对上你"可核验"的诉求；Vibe-Trading 已跑通三轮对抗评审                                                                                           |
| P1     | **`conflicts.json`**                        | 跨源冲突显式落盘，不静默取舍                                                                                                                        |
| P1     | **`NOT_EVALUABLE` 而非 pass**               | 你已有治理环；缺探针时该说"无法评估"                                                                                                                |
| P2     | 多源交叉验证（≥2 独立来源，误差告警）       | ai-berkshire 的做法，成本低                                                                                                                         |
| P2     | 引用机器校验（漏引/错引被拒）               | 需要你先有"引用"这一层                                                                                                                              |

### 不该抄

- **常驻服务形态**（PG / Redis / Docker / Electron）——与你的 daemon-free 硬约束直接冲突。
- **connector 铺量**——在没有凭据的情况下，声明 100 个连接器只会得到 90 个 `auth_required`；
  我的探活脚本已经把这个代价量化了。**先加深，再加宽。**
- **"实盘业绩"叙事**——`ai-berkshire` 首页挂 +69.29% / +66.38% 实盘收益。可以学它的纪律机制，
  不要学这个表达（本项目 AGENTS.md 明确禁止把回测/回执说成成功）。

---

## 6. 未验证 / 不确定

1. 小红书侧**零一手证据**（见第 1 节）。本报告的"社区做法"全部来自 GitHub 与转载文章。
2. 表里的 star / pushed 是 2026-09-19 一次 API 调用的快照，会变。
3. 四个项目的 README 是**自述**，其"已实现"程度未经我执行验证——只有 `ai-berkshire` 的
   "MCP 数据接入仍是 TODO" 和 ALTA 的"6 个连接器不等于 6 个实盘验收"这类**自我否定**的陈述可信度较高。
4. 我没有跑他们的代码，因此不 claim"他们的闸门真的有效"，只 claim"他们声明了什么"。
5. **自我纠错**：本节第 5 项最初写的是"没有确定性计算层"，**这个结论是错的**。本仓已有
   `src/agents/tools/quant-math-tool.ts`（1090 行，Sharpe / Sortino / Beta / 相关系数矩阵 /
   线性回归 / rolling beta / tracking error / information ratio / 最大回撤 / 回撤持续时间 /
   组合收益·波动·风险贡献 / CAGR / 期权与债券参数），且已注册为 `quant_math` 工具，
   `finance-rule-readiness.ts` 已在调用 `calculateMaxDrawdown`。
   正确结论是：**计算能力已有，缺的是计算留痕（可追溯）**。
   教训：写"我们落后"之前必须先在本仓检索一遍，不能只凭外部对照表下判断——这正是本报告
   第 5 节自己在批评的那类错误。
