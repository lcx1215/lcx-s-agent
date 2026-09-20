# 量化能力整合地图

**日期**：2026-09-20
**归属**：本窗口
**问题**：这些量化能力要怎么和文本、图表、其他来源配合起来。

## 0. 这份文档是怎么来的

不是凭印象列的。方法：遍历 `src/` 与 `scripts/` 下所有匹配 `finance|quant` 且非 `.test.ts` 的
TypeScript 文件，正则抽取每个文件的 `from "..."` 导入，只保留指向 `finance-*|quant-*` 的边，
得到一张**真实的有向图**。下面每个"入度/出度"都是这张图算出来的，不是估的。

**规模**：

| 指标                                  | 实测值                                         |
| ------------------------------------- | ---------------------------------------------- |
| 非测试 `finance\|quant` 模块          | **120**                                        |
| 零出度（不依赖任何其他 finance 模块） | 39                                             |
| `tool-catalog.ts` 中 `finance_*` 工具 | **49**（48 在 `memory` section，1 在 `media`） |
| 本地持久化表（`CREATE TABLE`）        | **7** 张                                       |

**7 张表**（这是整个 durable 核心，比模块数小得多）：

| 表                                                     | 归属模块                          |
| ------------------------------------------------------ | --------------------------------- |
| `finance_position_records`                             | `finance-position-ledger.ts`      |
| `finance_position_projection_state`                    | `finance-position-ledger.ts`      |
| `finance_outcomes`                                     | `finance-outcome-ledger.ts`       |
| `finance_checkpoint_runs` / `finance_checkpoint_nodes` | `finance-run-checkpoints.ts`      |
| `finance_strategy_rule_records`                        | `finance-strategy-rule-ledger.ts` |
| `finance_thesis_records`                               | `finance-thesis-ledger.ts`        |

⇒ **记忆点：能力面（49 工具）远大于状态面（7 表）。** 绝大部分是"读时计算"，不是"存下来的"。

## 1. 七层能力地图（按供给方式分类）

"配合不起来"的根因往往不是缺接口，而是**供给方式不同**。所以按下表分类：

| 层               | 代表模块                                                                                                                                                                 | 供给方式            | 备注                                       |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------- | ------------------------------------------ |
| ① 来源/采集      | `finance-market-collection-registry`（**入度 16，全仓最大枢纽**）、`finance-data-gateway`、`finance-realtime-source-registry`、`finance-free-market-collection-adapters` | **实时拉取**        | 采集门禁已被放宽（旁窗 9-19 改动，未提交） |
| ② 外部连接器     | `finance-data-connectors`、`finance-mcp-client`、`finance-rest-client`                                                                                                   | **实时/需凭据**     | 有 `lcx-finance-connector-probe` 可探活    |
| ③ 文本           | `finance-article-source-collection`（入度 5）、`finance-news-entity`、`finance-gdelt-news-titles`、`finance-research-evidence`                                           | **实时拉取**        | GDELT 是免费源                             |
| ④ 图表           | `finance-chart-analysis`（876 行）+ `finance-chart-analysis-tool`                                                                                                        | **⚠️ 调用方现场喂** | 见 §2 缺口 1                               |
| ⑤ 存储           | 上表 7 张                                                                                                                                                                | **本地 SQLite**     | 唯一真正的状态面                           |
| ⑥ 判据（纯投影） | `finance-behaviour-profile`、`finance-rule-readiness`、`finance-equity-curve`、`quant-math-tool`                                                                         | **读时重算**        | 无状态根                                   |
| ⑦ 执行           | `finance-execution-adapter`（入度 8）、paper 适配器、`finance-alpaca-execution-adapter`（**入度 0**）                                                                    | **需适配器+凭据**   | 见 §2 缺口 3                               |
| ⑧ 研究编排       | `finance-research-runner`（**出度 12，最大编排枢纽**）、`finance-brain-orchestration`、`finance-agent-committee`、`finance-decision-policy`（入度 7）                    | 编排                | 与 ⑤⑥⑦ 几乎无交叉                          |

## 2. 四个断连点（实测）

### 缺口 1：图表没有本地供给 —— 本轮最重要的发现

`finance-chart-analysis.ts` 的 `FinanceChartBar` 是完整 OHLC：
`{ timestamp, date, open, high, low, close, volume? }`，`analyzeFinanceChartBars()` 已经能算出
`maxDrawdownPct`、`rsi14`、`atr14`、`sma20/50/200`、`support20/resistance20`。

**但**：

- 引用 `FinanceChartBar` / `normalizeFinanceChartBars` 的文件只有 3 个 —— 模块自身、它的 tool、它的测试
- 全仓**没有任何 `CREATE TABLE` 存 bar 序列**
- 所有行情源（`finance-market-collection-registry` / `finance-data-gateway` / `finance-live-market-source`）
  对 `bars|ohlc|candles|kline` **零命中**，只有 `history` 命中 1 次

⇒ 图表是**调用方现场喂数据**的。这直接决定一件事：

> **不能让"规则就绪度"直接去吃 OHLC bar** —— 没有供给，那就是一个不可达分支。
> （这正是上一轮在 `emptyReason` 第一分支上踩过的坑：看着合理，正常流下永远走不到。）

**正确顺序**：先有 bar 的本地供给（或声明式的 bar 来源），再谈图表→判据。这个顺序不能倒。

### 缺口 1 的供给通路：MCP 已是一等公民（2026-09-21 落地）

缺口 1 说的是"没有 bar 供给"。MCP 本身不产生供给，但它现在是**把外部 bar 供给接进来的通道**：

| 层     | 落点                                                                               | 说明                                                                             |
| ------ | ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| 配置面 | `tools.mcp.servers`（`src/config/types.tools.ts` + `zod-schema.agent-runtime.ts`） | 声明即授权，strict schema；未知 transport / 多余字段直接报错                     |
| 解析层 | `src/agents/mcp-servers.ts`                                                        | 单点的名字解析、失败闭合并报问题、子进程环境清洗、secret 只出键名                |
| 传输层 | `src/agents/mcp-client.ts`                                                         | stdio（新增，真实 spawn + NDJSON）+ http（复用 `finance-mcp-client.ts`）         |
| 工具桥 | `src/agents/tools/mcp-bridge-tools.ts`                                             | `mcp_list_tools` / `mcp_call_tool`，已在 catalog 与 `openclaw-tools.ts` 两处注册 |

边界（与全系统一致）：

- **配置即授权边界**：模型只传 server **名字**，不传 command / url / argv；未声明的名字直接拒
- **stdio 子进程不继承 ambient 代理变量与会话级变量**；http 只走显式 `proxyUrl`
- 调用结果带 `detectVendorBusinessError` 检查（HTTP-200 里藏业务错误的老问题），并标
  `provenance.untrusted`

### 缺口 1 已闭合：bar 供给 → 落账 → 可读（2026-09-21 端到端跑通）

| 段   | 落点                                                                            | 状态                           |
| ---- | ------------------------------------------------------------------------------- | ------------------------------ |
| 供给 | `scripts/mcp/bar-source-server.mjs`（本地 stdio MCP server，工具 `daily_bars`） | ✅ 实测取到 600519.SH 真实日线 |
| 落账 | 工具 `finance_bar_ledger` action=append                                         | ✅ append-only + 幂等          |
| 可读 | 工具 `finance_bar_ledger` action=read                                           | ✅ agent 能读到自己的账本      |

端到端实测：`daily_bars` 取 35 条（2026-08-03→09-18，前复权）→ append（`barCount 35`,
`recordCount 1`）→ read（`status: ready`, 35 条，`sampleCount: null`）→ 重复 append
`appended: false`。出口 `route: proxy:...` 来自 server 声明里显式给的 `env`，不是继承的。

`daily_bars` 返回值**第一个 content item 就是账本的 `ohlcv` batch 原样**，可以直接喂给
append，不需要任何再整形（再整形就是两处漂移的起点）。诊断信息放第二个 item。

**供给侧的三个已知边界**（都写进了 server 代码注释）：

- 厂商（腾讯 `web.ifzq.gtimg.cn`）**忽略日期区间参数**，传 `start/end` 会返回空 ⇒ 改成拉 count
  后在本地按日期裁剪，"窗口内无数据" 与 "厂商没返回" 因此可区分。
- `qfq` 前复权：**range 结构保留，绝对价格被缩放** ⇒ provenance.note 明写"不要把历史价当成当日成交价"。
  要原始成交价用 `adjust: "none"`。
- Node 内置 fetch **不读代理环境变量** ⇒ server 自己读声明的 `HTTPS_PROXY` 建 ProxyAgent；
  读不到 undici 则报错，不静默改走直连。

**已闭环**（`bar_source` 已声明，生产跑通，详见下节）。

### 消费方：账本 → 图表分析（装配层落点）

`finance_bar_ledger` read 返回 `chartBars`，形状即 `finance_chart_analysis` 的 `bars`
（后者 schema 是封闭对象，所以转换必须有单点）。**并带语义门**：含 `point_derived` bar 时
不产出 `chartBars`，改给 `chartBarsUnavailableReason` —— 因为那种 bar 的 high/low 只是观测到的
极值，喂给 ATR/回撤会系统性低估。

⇒ **装配层的价值不是转格式，是在接缝处守住语义**（缺口 4 的真正落点）。

## 2.6 已有 API 的 MCP 接入（同花顺，2026-09-21）

不新造供给，直接接 `finance-data-connectors.ts` 里已声明的端点：

| 端点                    | tools/list | tools/call        | 工具数 |
| ----------------------- | ---------- | ----------------- | ------ |
| `.../mcp/a-share`       | ✅ 免 key  | ❌ 需 `X-api-key` | 21     |
| `.../mcp/fund`          | ✅ 免 key  | ❌                | 28     |
| `.../mcp/futures`       | ✅ 免 key  | ❌                | 13     |
| `.../mcp/a-share-index` | ✅ 免 key  | ❌                | 4      |
| `.../mcp/options`       | ✅ 免 key  | ❌                | 4      |
| `.../mcp/meta`          | ✅ 免 key  | ❌                | 2      |

共 **72 个真实工具**已可枚举（含 `get_a_share_prices_historical`，参数用**毫秒时间戳** +
`adjust: none|forward|backward`，`thscode` 形如 `600519.SH`）。

**无 key 时调用返回 `{"code":2003,"message":"Missing X-api-key","data":null}` 且 `isError:false`**
—— 正是 `detectVendorBusinessError` 要防的形状，实测被工具层捕获并标为"无数据"。

**凭据声明：已实测，不需要改代码，但有两个坑**（2026-09-21）

`${ENV}` 在 MCP `headers` 里**本来就能用** —— `resolveConfigEnvVars`（`src/config/io.ts:779`）
是通用深遍历，覆盖整个配置对象。实测 `headers: {"X-api-key": "${HITHINK_FINANCE_API_KEY}"}`
在 env 有值时被正确替换成 `sk-probe-123`。

两个必须知道的坑（都是实测，不是推断）：

1. **变量缺失不是"这个 server 不可用"，而是整份配置失效。** `MissingEnvVarError` 会一路传到
   `src/cli/program/config-guard.ts:90-117`：快照 `valid:false`，且 `serve` **不在**
   `ALLOWED_INVALID_COMMANDS`（只有 doctor/logs/health/help/status）⇒ `exit(1)`。配合 launchd 的
   `KeepAlive`，表现为进程反复起来又退出。缺失时整段 server 声明从加载结果里消失（实测
   `server = undefined`）。
2. **长驻进程拿不到 shell 里 export 的变量。** `ai.openclaw.serve.plist` 的
   `EnvironmentVariables` 只给了 `PATH`。所以 key 要么进 plist（文件权限 600），要么进配置。

⇒ 同一处 `EnvironmentVariables` 也是 `LCX_FINANCE_STATE_DIR` 该去的地方（见 §2.8）。

### 序 2 已落地：就绪度吃到真实 bar（2026-09-21）

`buildFinanceRuleReadiness` 新增可选 `bars` 输入（`FinanceReadinessBar`，带 `sampleCount`）。
装配点在 `finance_strategy_rule_ledger_read` 的 readiness 段：读 bar 账本 → 喂投影层。

**改了三个口径，每个都有理由**：

| 项       | 之前             | 现在（有可用 bar 时）        | 为什么                                                    |
| -------- | ---------------- | ---------------------------- | --------------------------------------------------------- |
| reversal | close→close 回撤 | **peak high → trough low**   | 收盘序列看不见盘中下跌：真实数据上 7.50% → 8.02%          |
| gap      | 相邻两次观测的差 | **开盘跳空**（今开 vs 昨收） | 跳空后当天收回的行情在收盘序列里完全消失                  |
| chop     | 收盘方向翻转     | 不变                         | "摆动"没有给定阈值，不擅自换定义 ⇒ `basis` 照旧标 `close` |

**`basis` 字段随数字一起返回**（`ohlc` / `close`）：close-to-close 回撤不是"小一号的真实回撤"，
是另一个量。边界说明 `interpretationBoundary` 也随之切换措辞。

**语义门（与 `chartBars` 同一条规则）**：窗口里出现 `point_derived` bar（`sampleCount !== null`）
⇒ reversal / gap 判 `null` + 理由，**不用 close 数兜底**。理由：点派生的 high/low 只会让回撤被
_低估_，而低估正好产生"没经历过逆境"的结论 —— 这是唯一会往"放行"方向错的误差。
`unjudgeable = uncovered`，所以结果是 `ready: null` 而不是 `ready: false`。

**顺带修掉一个真实缺陷**：原来 `windowedPrices` 把规则的所有标的**拼成一条序列**再算收益，
两个标的之间会产生一次"跨标的跳空"（例：AAA 100 → BBB 1000 读作 +900%）。现在按标的分组
计算、取最坏值。旧测试全是单标的，没覆盖到 —— 已加测试钉住。

**验证**：21 个单测（含 7 个新增）+ 工具层 9 个测试全绿；两处变异各自只打红对应的新测试
（range 口径 / point-derived 拒绝）；真实 35 根 600519.SH bar 跑过三种供给形态
（真 OHLC / 只给收盘 / 谎报 point_derived）。

**供给**：美股日线不用新造 —— 系统自带免 key 适配器 `china_reachable_us_eod_history`
（东财优先、新浪兜底；**不能选 `yahoo_public_eod_history`：Yahoo 自 2021-11 起对大陆 IP 返回 403**）。
已用它把规则那 8 个标的各 120 根（2026-03-30 → 09-18，新浪源）落进**规则所在的目录**。

**生产实测（2026-09-21）**：`barCount 960`、`barSource: finance_bar_ledger` —— 供给确实读到了。
但这条规则 `startObservedAt = 2026-09-20T13:38Z`，bar 只到 `2026-09-18`
（09-19/20 是周末，最后一个交易日就是 09-18）⇒ **窗口内 0 根 bar** ⇒ 回落到 marks
（`observationCount 7`）、三项 `basis: close`。

这是**正确行为，不是缺陷**：规则才活了 0 天，本来就没有它的历史。真正的含义是：

> bar 供给必须**持续日更**，否则任何"新声明"规则的窗口永远落在 bar 覆盖范围之后，
> 就绪度会一直走 close 口径 —— 而 close 口径看不见盘中回撤，正是这次要修的东西。

### 供给已挂进 daily cycle：采集即落账（2026-09-21）

`finance-daily-cycle.ts` **本来就在**用 `china_reachable_us_eod_history` 取 bar（limit 8000），
但只留下 `date`/`close` 算信号，high/low 用完就丢。改法：取到就顺手落进 bar 账本
（`toOhlcvBatch` + `appendFinanceBars`，`derivation: "ohlcv"`）。

几个刻意的取舍：

- **落账失败不中断交易**：写不进去只进 `dataIssues` 继续跑。供给是副作用，不是交易的前提。
- **先落账、后过 400 根信号阈值**：400 是信号的要求，不是"值不值得留"的要求。
- **只有四价齐全的行才落**：缺 high/low 的那是报价不是 bar，当 `ohlcv` 落进去就是给区间度量
  喂没人观测过的数 —— 正是 `point_derived` 这个形状要防的事。四价自相矛盾（low 高于 open/close、
  high 低于它们）的行同样丢弃。
- **批次时钟 = 最新一根观测时间**，不是运行时刻（否则回放到过去会看不到历史，把"窗口内没 bar"
  误读成"没有历史"）。
- **幂等**：内容指纹去重 ⇒ 第二次跑 `appended: false`，账本不重复增长。已实测。

**实测**：一次 cycle（计划模式，未下单）把供给从 960 根推到 **42030 根 / 16 个批次**
（SPY 回溯到 2001-01-02）；再跑一次 `appended` 全 false、`recordCount` 仍是 16。
报告新增 `barsFiled` 字段并透到 operator 输出 —— 否则"没落账"和"没试过"分不出来。

**真实数据上的口径翻转**（同一标的、同一窗口，只有能不能看见 high/low 的差别）：

| SPY 2026-06-01→09-18（154 根） | reversal 阈值 5% | 结论       |
| ------------------------------ | ---------------- | ---------- |
| 真实 OHLC                      | **5.763%**       | 经历过 ✓   |
| 只给收盘                       | 4.495%           | 没经历过 ✗ |

⇒ 同一段行情，"这条规则有没有被逆境检验过"这个问题的**答案会翻转**。这就是这次改动的全部理由。

### 生产实测：finance 状态面其实是**两个根**（2026-09-21）

不是静态推断，是同一条链生产跑两次的返回值：

| 调用                              | `ledgerDirectory` / `resolvedFrom`                          | 结果                                                                                |
| --------------------------------- | ----------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| 不带 `directory`                  | `~/.openclaw/workspace/state/finance` / `workspace_default` | `status: absent` —— **规则账本不在那儿**（那儿只有 `bar-ledger_1.sqlite`）          |
| 带 `directory=仓库 state/finance` | 显式 / `explicit`                                           | `status: ready`，规则 1 条、marks 12、阈值已声明，但 **barCount 0、barSource null** |

⇒ **供给（bar）在 agent 侧根，规则/持仓/阈值在 operator 侧根**。后果是：agent 按默认路径
根本看不到规则账本；显式指定目录又看不到 bar。这条"就绪度吃 bar"的接缝在生产上目前是断开的，
不是代码问题，是**两个目录**。

（2026-09-21 补充：**已收敛** —— 见上。默认根现在是规则所在目录；A 股 bar 已重新采集进同一根。
旧根的文件一个都没删，只是默认读不到了。）

**已修（2026-09-21）**，而且没动 plist：

配置里有 `env.vars`（`applyConfigEnvVars`，读配置时就写进 `process.env`，且不覆盖已存在的值），
所以在 `openclaw.json` 里声明 `env.vars.LCX_FINANCE_STATE_DIR` 即可 —— **不依赖 launchd 的环境**，
长驻进程自己读配置时会拿到。`resolveFinanceStateDir` 的优先级是 explicit > env > workspace，
所以显式 `--dir` 仍然最优先，这个只是把"默认"改对。

A 股 bar 的处理：**重新采集，不复制**。走已声明的 `bar_source` MCP 重新拉 600519.SH（120 根，
origin `tencent-gtimg-qfq-day`）落进同一个根，而不是把旧账本拷过去 —— 副本的 provenance 只能说
"抄自另一个账本"，重新采集的 provenance 才指向厂商。旧账本**没有删**，仍在原处（只是默认读不到了）。

生产复验（不带 `directory`）：

```
ledgerDirectory: /Users/.../state/finance   resolvedFrom: env
status: ready   ruleCount: 1
barCount: 42150   recordCount: 17   markCount: 12
```

**顺带修的两处"读不到 ≠ 不存在"**：

1. `barSource` 原来在 bar 账本根本不存在时也报 `finance_bar_ledger`（空书和没书分不出来，
   会让读的人以为供给存在只是恰好为空）。已改成先查 `financeBarLedgerExists`，书不在 ⇒ `null`。
2. **`barWindowNote`**：窗口里没有 bar 时，读者看到 `basis: close` 分不清"这段历史不存在"和
   "历史存在、只是窗口没套上" —— 前者要去取数，后者等一天就好，需要的动作相反。
   现在会明说：

   > `the bar book holds 42030 bar(s) for this rule's instruments, but none inside the window
(newest bar 2026-09-18, window starts 2026-09-20), so the range measures fall back to closes`

   生产复验（默认根，不带 `directory`）已确认这条出现在真实返回里。

### 缺口 2：文本/研究 与 论点没有连接键

已单独成文：`ops/external-learning/2026-09-19-thesis-outcome-assessment-gap.md`。
要点：outcome 按 `packetRef + caseId` 键且 `claimId` 必须在 packet 自带 claims 内
（`finance-outcome-ledger.ts:141-149`），而论点按 `thesisId` 键、不带任何 packet/case 引用
⇒ **结构上无法互相评估**。

### 缺口 3：Alpaca venue 适配器入度 0

`finance-alpaca-execution-adapter.ts` 是**真的 venue 适配器**：`kind: "venue"`、读
`ALPACA_API_KEY_ID/SECRET`、并校验 key 前缀（`PK…` paper / `AK…` live，互相拒绝）。

但引用它的文件只有自身与测试 ⇒ **没接进任何执行入口**。
⚠️ 旁窗 04:41 正在改这个文件 —— **本轮不碰**。

### 缺口 4：没有装配层（"配合"的真正落点）

49 个 finance 工具**各自独立解析 `asOf`、各自解析目录、各自报状态**。要让它们"配合"，
模型必须：知道要调哪几个 → 逐个调 → 自己 join → 自己保证时间口径一致。

目前**没有任何模块做这件事**。跨层引用实测：

| 模块                               | 入度  | 引用者                                                      |
| ---------------------------------- | ----- | ----------------------------------------------------------- |
| `finance-position-ledger`          | 8     | 画像、净值、就绪度、读面、3 个 operator                     |
| `finance-execution-adapter`        | 8     | alpaca、画像、净值、持仓、读面、2 个 operator               |
| `finance-decision-policy`          | 7     | committee、orchestration、执行缝、research-runner、3 个入口 |
| `finance-strategy-rule-ledger`     | 3     | 就绪度、读面、operator                                      |
| `finance-thesis-ledger`            | 2     | 读面、operator                                              |
| `finance-rule-readiness`           | 2     | 读面、operator                                              |
| `finance-behaviour-profile`        | 2     | 读面、operator                                              |
| `finance-chart-analysis`           | 1     | 只有它自己的 tool                                           |
| `finance-alpaca-execution-adapter` | **0** | —                                                           |

⇒ **量化链（规则/论点/就绪度/画像）与文本层、图表层、来源层之间，一条边都没有。**
唯一把量化链接到主干的是"就绪度读持仓账本的 mark 流"这一条。

## 3. 建议的整合次序

按"先补供给，再补连接，最后才补装配"排 —— 顺序倒了就会产出不可达代码。

| 序  | 做什么                                                                                                                 | 前置                                  | 代价                      | 状态                                       |
| --- | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------- | ------------------------- | ------------------------------------------ |
| 1   | **bar 序列的本地供给**（或声明式来源）                                                                                 | 无                                    | 中：新增一张表 + 采集写入 | 未开始；与旁窗的 source 工作相邻，需先划界 |
| 2   | 图表 → 判据：就绪度改用 true drawdown（用 high/low）                                                                   | 1                                     | 小：就绪度加可选 bar 输入 | **已落地**（2026-09-21，见 §2 新节）       |
| 3   | Alpaca 接进执行入口                                                                                                    | 旁窗完成 + 用户给凭据                 | 小                        | **旁窗在改，不碰**                         |
| 4   | 文本/研究 → 论点：加 `packetRef` 连接键                                                                                | 决策（要放松已提交账本的 claim 校验） | 中                        | 已有决策文档，待你拍板                     |
| 5   | **装配层**：一个只读的标的级视图，把 图表特征 + 来源健康 + 持仓 + 论点 + 生效规则 + 就绪度 一次给出，且**统一 `asOf`** | 1–4 任一                              | 中大：新 tool + 注册      | 本次仅提出                                 |

第 5 项是"全方面配合"的实质落点：它不做任何新判断，只把已经存在的各层**按同一个时间点**拼起来。
但它也最贵，且要动 `openclaw-tools.ts` / `tool-catalog.ts`（旁窗 04:39 正在改这两个文件的注册测试）
⇒ 本轮**只提出、不动手**。

## 3.5 与 trader-strategy-lab skill 的对接（运行时副本，不在本仓）

Skill 装在 agent 的 workspace 根内：**`~/.openclaw/workspace/skills/trader-strategy-lab/`**
（只有放在 workspace 根内，模型的 read 才够得到；`~/.agents/skills` 会被沙箱根挡住）。
对接映射表是 skill 内的 **`references/lcx-system-bridge.md`**，本仓**不复制其内容**，只记位置：

| 对接项                  | 系统侧真值来源                                                 |
| ----------------------- | -------------------------------------------------------------- |
| 阶段 → `decisionMode`   | `finance-decision-policy.ts`（`FINANCE_DECISION_MODES`）       |
| 候选契约六项            | `finance-decision-policy.ts` 的 `requiredEvidence`             |
| 证据状态 → claim status | `finance-research-runner.ts` 的 `qualityVerifier`              |
| 情景/概率合同           | `finance-research-assessment.ts`（probability 和 = 1）         |
| 冻结规则落账            | `scripts/operator/lcx-finance-strategy-rule-ledger.ts`         |
| 论点落账                | `scripts/operator/lcx-finance-thesis-ledger.ts`                |
| 执行边界                | `finance-execution-adapter.ts`（unattended 三项 cap + 拒绝码） |

⇒ 改系统侧门禁/字段时，**必须同步改 `lcx-system-bridge.md`**，否则 skill 教的是过期契约。

## 4. 边界声明

- 入度/出度来自**静态 import 图**，不含运行时动态调用；未覆盖 `dist/`。
- "入度 0"只说明**没有别的模块 import 它**，不代表功能不可用 —— 它可能由 operator 脚本或人工使用。
- 未验证运行时行为；未做任何代码改动。
- 旁窗当前活跃区（04:37–04:44）：`finance-alpaca-execution-adapter`、`quant-lab-tool`、
  `finance-answer-grounding-gate`、`finance-calculation-ledger`、`lcx-commercial-answer-pipeline`。
  **以上均未触碰。**
