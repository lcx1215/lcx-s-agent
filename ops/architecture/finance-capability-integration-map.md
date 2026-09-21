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

**真实数据上的端到端实测（2026-09-21）**：`finance_bar_ledger read instrument=SPY limit=120`
→ `chartBars` → `finance_chart_analysis`，返回 `observationCount 120`、`droppedBarCount 0`、
`ATR14 6.545`、`maxDrawdownPct -4.49%`、`volatilityPct 0.828%`（日波动）、
`support20 749.6` / `resistance20 775.3`。

`0.828% × √252 ≈ 13.1%`（这一步换算是本文档做的，工具本身只报日波动）—— 与去重后重算的
0.131 吻合，而重复未折叠时同一段是 0.080。**这条链是发现上面那个重复缺陷的地方，也是验证修好的地方。**
注意工具**不报年化波动**，只报 `volatilityPct`；要年化得自己换，别把它当成年化值引用。

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

### 写方的根也必须钉死：调度器原来靠 cwd 碰巧对上（2026-09-21）

两个根收敛之后还留着一个隐患：**agent 读的根来自配置 `env.vars`，而每天写账的调度器
根本不读配置**。它之前是这么对齐的：

- 调度器自己的账本（`lastFired` / `runs.jsonl` / pid）硬编码 `<repo>/state/finance`；
- 它 spawn 的 cycle 靠 `resolveFinanceStateDir()` 从**自己的 cwd** 解析 —— 而 cwd 恰好
  也是 `<repo>`（`spawn(..., { cwd: REPO_ROOT })`）。

两处独立陈述同一件事，今天相等纯属巧合。任何一边变动（传了 `--dir`、shell 里 export 了
`LCX_FINANCE_STATE_DIR`、从另一个 worktree 启动）都会**静默**分裂：cycle 写一本，agent 读
另一本，而空账本和"平的账户"长得一样。更糟的是 **`--dir` 传给调度器会被静默忽略**
（`forwardedArgs` 只认 `--place/--venue/--max-*`），意图最明确的那个输入反而最没用。

已改（`scripts/operator/lcx-finance-scheduler.ts`）：

1. 根在**调度器里解析一次**：`--dir` > 配置 `env.vars`（就是 agent 读的那份声明，
   通过 `applyConfigEnvVars(loadConfig())`）> workspace 默认；
2. 解析结果同时用于调度器自己的状态文件和 **传给 cycle 的 `--dir`**，
   子进程不再受 cwd 影响；
3. 根与它的来源（`explicit`/`env`/`workspace_default`）打进 `--status` 与启动行，
   配置读不到时**报出来但不自杀**（写错本比不写更坏，但配置一个笔误不该带走夜间那一跑）。

验证：

- `--status` 实测 `finance root: …/state/finance (env)` —— 与 agent 同源；
- 用一个临时根端到端跑一次：调度器自己的 `runs.jsonl` 和子进程 payload 的 `directory`
  **都是**那个临时根（已清理，未碰真账本）；
- 驻留进程已用新代码重启（旧 pid 85132 → 新 32558，存活已确认）；
- `tsgo` 对这两个文件 0 错。

下一次触发：ET 周一 15:30（day）/17:30（night）。

### 账本里 960 根"重复 bar"：同值重放 ≠ 来源分歧（2026-09-21）

`readFinanceBarLedger` 原本**故意**保留同一 `instrument@date` 的多个观测（注释："两个来源给出不同值，
是来源的事实，折叠它就藏起来了"）。但实测真账本里的 960 组重复 **100% 同值**（OHLCV/volume/
sampleCount/origin 全一致），0 组真分歧 —— 它们是**两个采集窗口重叠**的重放，不是来源分歧。

为什么必须折叠：**重复的一天 = 零收益的一天**。SPY 最近 120 行里 60/119 个相邻对是零收益，
年化波动被压到 **0.080**，同一些天读一次是 **0.131**（cycle 报的 0.129 说明 cycle 自己绕过了，
但 `finance_bar_ledger` 吐给 `finance_chart_analysis` 的 `chartBars` 没有）⇒ ATR、回撤、
支撑阻力、波动率全线低估约三分之一。

已改（`src/agents/finance-bar-ledger.ts`）：按 `instrument@date` 记签名，**同值折叠、异值保留**
（分歧仍然是事实，照旧进 `divergentDates`），并把折叠数量**报出来**（`collapsedRepeats` →
工具层 `repeatedBarsCollapsed` + 说明），不静默丢。

生产实测（SPY）：`totalBarCount 6584 → 6464`、`repeatedBarsCollapsed: 120`、日期不再重复；
就绪度 `barCount 42150 → 41190`，`barWindowNote` 同步变 41070。

验证：bar 账本 19 测试全绿（新增"重叠窗口折叠"和"第二来源同值也折叠、异值不折叠"两条）；
变异（让折叠永不触发）正好只打红这两条；`tsgo` 0 错。

### 同一个缺陷的写侧：每天会再落一份全历史（2026-09-21）

上面只修了读侧，但**因**在写侧。cycle 每次采集的是 `collection: "eod_history", limit: 8000`
—— **整段历史**，因为厂商没有增量接口。而 append 的幂等键是**整批指纹**（`recordKey` =
instrument + derivation + origin + 所有 bar 的内容指纹）：

⇒ 只要多出一天，整批指纹就变 ⇒ `appended: true` ⇒ **账本每天多一份全历史副本**。
实测记录形状印证了这个来源：记录 1-8 是浅采集（8 标的 × 120 根），记录 9-16 是同批深采集
（SPY 6464 根 / 2001 起），那 960 根重复就是这两批的重叠。按当前规模推：约 41k 根/交易日、
5MB/天，一年后任何一次 read 都要解析上亿行。

已改（`finance-bar-ledger.ts` 的 `appendFinanceBars`）：**按内容去重，不按批次**——提交批次里
与书中已有 bar 内容完全相同的那些**不再落账**，只落新的（`repeatsSkipped` 报数）；
**值变了仍会落**（厂商修订照样进书，读侧照旧算分歧）。cycle 的 `barsFiled` 同时报
`barCount`（采集到多少）与 `newBarCount`（新落多少）。

验证（临时账本，真实 operator 脚本）：

```
首次 append 2 根        → record 1: 2 根
重采全历史再 append 3 根 → record 2: 1 根（只有 09-03 是新的）  ← 不是 3 根
同样批次再来一次        → recordCount 不变（一条都不落）
read                   → 3 个日期，collapsedRepeats 0
```

单元测试 28 个全绿（新增 3 条：只落新天、无新天时啥也不写并说明、修订不被当成重放）；
变异（让过滤永不生效）正好只打红前两条；`tsgo` 0 错。

⚠️ 存量那 960 根**没动**（账本 append-only，不重写历史），靠上面那条读侧折叠兜住。

**真实厂商数据上复验（周日，数据没变 ⇒ 正好是"全重复、零新增"的极端情形）**：

```
SPY 采集 6464 / 新落 0 / appended false      IWM 采集 5461 / 新落 0 / appended false
QQQ 采集 4873 / 新落 0 / appended false      EFA 采集 5461 / 新落 0 / appended false
TLT 采集 2673 / 新落 0 / appended false      EEM 采集 5461 / 新落 0 / appended false
GLD 采集 5491 / 新落 0 / appended false      DBC 采集 5186 / 新落 0 / appended false
```

合计采集 41070 根、新落 0 根；跑完账本仍是 **17 条记录 / 5.28MB**（改之前这一跑会再塞一份
41k 根的全历史）。

**夜间那一跑首次真实执行**（此前只有 day 跑过一次，night 从未触发过，而它会在 ET 17:30 自动跑）：
`ok: true`、5 个样本 → 0 已结算 / 3 未到期 / 2 被拒、无 issues。被拒的 2 个是
`direction` 非 buy/sell（hold 不算赌注，正确排除在命中率之外），**不是缺陷**。

### 同一族第三处：校准工具读的是另一本书（2026-09-21，实测 0 → 5）

`finance_calibration_read` 是 agent 唯一能"看看自己过去判断准不准"的入口。它原来把文件路径拼成
`resolveWorkspaceRoot() + "state/finance/research-{samples,scored}.jsonl"` —— **没走
`resolveFinanceStateDir()`**，而写样本的 cycle 走的正是后者。生产实测：

```
workspaceDir: /Users/liuchengxu/.openclaw/workspace
samplesFile:  /Users/liuchengxu/.openclaw/workspace/state/finance/research-samples.jsonl  → 0 份
真实文件：     <repo>/state/finance/research-samples.jsonl                                 → 5 份
```

于是工具返回 `total 0` + "还没有任何已评分结果，任何校准数字都会是编造的"。
**"我没有历史战绩" 和 "我找错了地方" 从这里看是完全一样的** —— 正是这一族的形状。

已改：走 `resolveFinanceStateDir()`（新增 `directory` 参数，`workspaceDir` 降级为最弱输入），
并把 `financeStateDirectory` / `resolvedFrom` 一起报出来，让"空计数"能配上"读的是哪本书"。

生产复验：`total 5 / pending 5 / refused 2`、`resolvedFrom: env`、路径 = 仓库 `state/finance`。

**仍未闭合的同类接缝（未动手，记录在此）**：研究/结算面的样本与评分文件在 **5 处**仍是
`cwd + "state/finance/..."` 的相对路径 —— `lcx-finance-research-score.ts:156`、
`lcx-finance-research-turn.ts:328`、`lcx-finance-paper-rank.ts:59,70`、
`lcx-finance-research-batch.ts:275`。它们靠 cwd=仓库根 与账本侧碰巧对齐，且**都是 operator 脚本
（人工执行）**，所以优先级低于上面那条（那是 agent 自己读出错误结论）。
另：`research-scored.jsonl` 目前是空的，且**只有人工跑 research-score 才会写**
⇒ 无人值守的循环不会自己产出新的评分样本，结算面没有自动供给。

### 结算算完即弃 → 已改为落盘（2026-09-21）

`finance-outcome-backfill.ts` **一处文件写入都没有**（纯算术），cycle 的 night 分支也只是把
`scored/pending/declined/reflection` 放进返回 payload（调度器把它存进 runs.jsonl 的 stdout）。
`research-scored.jsonl` 的写方只有人工跑的 `lcx-finance-research-score.ts` ⇒

> 夜间结算**每夜算一遍、然后丢掉**；校准工具读的那个文件永远是空的，
> 它只能说"没有已评分结果，任何校准数字都会是编造的"。反思环没有输入。

已改（`scripts/operator/lcx-finance-daily-cycle.ts`）：night 分支把 `settled.scored` 追加进
`<finance root>/research-scored.jsonl`，按 `instrument@asOf@direction` 去重（重跑不会重复计一次调用），
tmp+rename 原子写，并在 payload 里报 `scoredFiled: { path, appended, skipped }`。

端到端验证（临时目录 + 真实价格序列，一个已到期样本 + 一个未到期）：

```
第一次 night: 样本 2 → 已结算 1 / 未到期 1，落盘 {"appended":1,"skipped":0}
第二次 night: 已结算 1，                    落盘 {"appended":0,"skipped":1}   ← 幂等
文件行: {"instrument":"SPY","asOf":"2026-08-01…","direction":"buy","conviction":0.62,
         "outcome":1,"movePct":19.8516}
校准工具读它: counts {total:2, mature:1, pending:1}, hitRate 1, brier 0.1444,
             floor 仍被拒给("1 个样本、不足 5 次观测，推不出底线")
```

⚠️ 途中发现、随后修掉：**night 分支在没有活跃规则时直接报错退出**
（`no active rule declares any instrument`）。结算读的是已记录的研究样本，**从不读规则库**——
night 分支只把 `ruleIds` 塞进 payload，`instruments` 一次都没用。所以暂停所有规则会连带掐断反思环，
而这恰恰是最该保留记录的时候。

已改（`scripts/operator/lcx-finance-daily-cycle.ts`）：空宇宙只拦 day；night 在规则库读不到时
降级为一条 issue 而不是中止，并在 payload 里报 `rulesActive`（空 `ruleIds` 否则与"规则库读不到"不可分）。

对照实验（临时目录，**不带规则库**）：

```
night: ok true、error 无、rulesActive false、样本 1 → 已结算 1、落盘 {appended:1}   ← 改前整条不跑
day  : ok false、error "no active rule declares any instrument"                    ← 保持原行为
```

### 同族收尾：研究/结算面 5 处 cwd 相对路径 → 单点解析（2026-09-21）

上一节的根因是"根目录由两套逻辑各说一遍"。收尾时把这族的**剩余 5 处**一起收敛到
`finance-state-dir.ts` 的两个命名函数 + 两个文件名常量：

| 位置                       | 改前                                            | 改后                                                                      |
| -------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------- |
| `research-score.ts:60,162` | `state/finance/research-{samples,scored}.jsonl` | `financeResearch{Samples,Scored}Path(resolveFinanceStateDir().directory)` |
| `research-turn.ts:332`     | 同上（scored，只读）                            | 同上                                                                      |
| `research-batch.ts:280`    | 同上（samples）                                 | 同上                                                                      |
| `paper-rank.ts:65,77`      | 同上（samples + scored）                        | 同上                                                                      |
| `daily-cycle.ts:33-34`     | 两个字面量常量                                  | 复用 `FINANCE_RESEARCH_{SAMPLES,SCORED}_FILENAME`                         |

**实测（临时状态根 + 真实 FMP 价格，带 `credentials.env` 当夹具）**：

```
research-score:  recordPath /tmp/rs/research-samples.jsonl、scoredPath /tmp/rs/research-scored.jsonl
                 mature 1 / hitRate 1 / brier 0.1444   仓库那份 scored 仍为 0 行（没被误写）
paper-rank 对照: 设 env → "1 sample(s) across 1 bucket(s)"      ← 读到临时根
                 不设 env → "no scored samples"                  ← 读到仓库根
                 ⇒ 路径真的跟着解析走，而不是跟着 cwd
```

night 结算在收敛后复验：第一次 `{"appended":1}`、第二次 `{"appended":0,"skipped":1}`（幂等），
仓库 `research-scored.jsonl` 未被动过。

护栏（`src/agents/finance-state-dir.test.ts` +3 条，共 12）：路径落在给定目录内、**切换 cwd 后结果不变**
（真正的缺陷形状）、writer 与 reader 得到同一个字符串。变异（让 samples 路径回到 cwd 相对）正好打红
这 3 条。`tsgo` 0 错；精确受影响面 66/66 全绿。

⚠️ 操作坑：本环境的 **Bash `grep` 会静默返回空**——验证"改动是否落地"必须用专用检索工具或 `node -e` 读文件，
否则会得出"没改到"的错误结论。

### 全系统配合度审计（2026-09-21）：持仓市值只在成交那天标过一次

从"LLM ↔ 数据库 ↔ 系统 API 数据"三者的接缝查起，唯一够得上"系统不会自己工作"的是这一条。

**实测（真实库）**：持仓库 20 条记录 = 8 条回执 + 12 条 mark。按 sequence 排开，7 条 mark 的
**时刻与价格逐位等于紧邻那条成交**：

```
 7  成交 SPY  2026-09-20T18:37:36  @761.69
 8  mark SPY  2026-09-20T18:37:36  @761.69     ← 同一时刻、同一价格
…（QQQ/IWM/EFA/EEM/GLD/DBC 同形）
 2-6 的 5 条 mark 是早期手工写入（其中 AAPL 的 mark 时刻 9-17 早于它 9-18 的成交）
```

根因：`appendFinancePositionMark` 在 `src/` 里只有一个调用点，`finance-daily-cycle.ts:362`，
它在 `recordCycleFill` 内部——**只有成交才写 mark**。而它的注释写着 mark 的用途正是
"下一次 cycle 给这个持仓定价"。规则是月度的，绝大多数日子不下单 ⇒ 不下单就不定价。

后果：每天采 4 万根 bar，却不回流到持仓市值。`unrealizedPnl` 停在成交那天的数，
`currentWeightsFromPositions` 用的是成交价而不是市值，equity curve 是平的。

**已改**（`src/agents/finance-daily-cycle.ts`）：采集循环之后、算信号之前，用这一跑刚采集的
`lastBar` 收盘价给每个非零持仓补一条 mark，report 里报 `marksFiled {instrument, price, at, appended}`。
mark 库的幂等键是 `mark:{instrument}@{at}`，`at` 取 bar 日期的收盘时刻 ⇒ **一天至多一条**，
重跑不写、休市不写。`markInstantForBarDate` 在 bar 日期晚于当前时刻时退回运行时刻（mark 库拒绝未来时间，
被拒就等于该持仓仍用昨天的价）。

端到端验证（临时目录 + 真实 FMP 数据，持仓造在 9-01 以 700 买入 10 股）：

```
跑之前: markPrice=700     unrealizedPnl=0       markRecordCount=1
跑之后: markPrice=761.69  unrealizedPnl=616.9   markRecordCount=2   ← appended: true
再跑一次: appended: false，markRecordCount 仍为 2                    ← 幂等
```

**两个怀疑被证伪**（别去"修"）：

1. 7 个 `markPrice` 恰好等于 `averageCost`、未实现盈亏全 0，看着像"取不到价格退回成本价"。
   拿 bar 库对账：**成本价 = 9-18 收盘价**（按收盘价成交），mark 用同一个收盘价 ⇒ 0 是真实的。
2. bar 的 provenance 写着 `sina-us-eod-history` / `tencent-gtimg-qfq-day`，而配额清单里没有这两个名字，
   看着像"真正供数的源不在监控里"。查 `source-sweep-aapl.json`：适配器 `china_reachable_us_eod_history`
   在 25 个 working 之列 ⇒ 只是命名不同，监控是覆盖的。

**观察到的未对齐（未改，记在此）**：

| 标的      | 规则宇宙 | bar 数据 | 持仓                                                  |
| --------- | -------- | -------- | ----------------------------------------------------- |
| AAPL      | ✗        | ✗        | ✓ 10 股 —— **孤儿持仓：不会被再平衡，也算不出就绪度** |
| TLT       | ✓        | ✓        | ✗                                                     |
| 600519.SH | ✗        | ✓        | ✗                                                     |

**账本里唯一非零的盈亏，来自最不可信的那个数（未改）**：

汇总 `unrealizedPnl = 17` 全部来自 AAPL，而它的成因是——

```
AAPL 成交: 2026-09-18T05:44:19Z @231.4 × 10
AAPL 最新 mark: 2026-09-17T11:00:00Z @233.1     ← 早于成交
未实现盈亏 = (233.1 − 231.4) × 10 = 17.00       ← 拿"买入之前"的价格算的
```

试过的修法：**投影拒绝早于最后一次成交的 mark**。既有测试立刻挡下了它
（`finance-position-ledger.test.ts:314`），且理由成立——真实库上那 7 笔是按 **9-18 收盘价**成交的，
而 `filledAt` 记的是**下单时刻 9-20 18:37**。价格时点与成交时刻在"按历史收盘价成交"下天然不一致，
这条规则会把自己刚写下的重标记一起拒掉（bar 收盘 9-18T20:00 早于成交 9-20T18:37）。

所以在两种形状里它是同一个规则、无法只挑一个：**手工先写 mark 后成交**（AAPL，该拒）与
**按历史收盘价成交**（7 个标的，不该拒）。已回退，只在 `finance-position-ledger.ts` 留注释说明。
要让 AAPL 那个 17 有依据，得先解决"回执没有价格时点字段"——`filledAt` 现在同时扮演
"下单时刻"和"价格所属时刻"两个角色。

- `finance_position_projection_state` 0 行：投影游标从未落盘（每次读都全量重算，20 条无所谓，但机制没跑起来）。
- `finance_outcome_ledger_read` **没有默认目录**（按 case 分区，必须传 `caseDirectory`）⇒ agent 不知道目录就调不动它。
- 全部 8 笔成交都是 paper（`venueFillCount: 0`），规则 `executionAuthority: none`。

### 链路自检：让配合度自己会说话（2026-09-21）

上面那些问题是**人工比对三张表**才看出来的——系统自己不知道。所以把那次比对做成常驻脚本：

```
node --import tsx scripts/operator/lcx-finance-link-health.ts [--json] [--dir <state root>]
exit 0 = 接线成立；exit 1 = 有断链（error 级）
```

七项检查，每条都带上"读的是哪本书"，并把**没有**与**读不到**分开（`{present, lines}`，不是行数而已）：

| 检查                      | 判的是什么                                                         |
| ------------------------- | ------------------------------------------------------------------ |
| `state_root`              | 从哪个根读的（零计数若读错书，与空书不可分）                       |
| `bar_supply`              | 有没有 bar、最新一根距今几天（>4 天告警）                          |
| `rule_universe`           | 有哪几条活跃规则、覆盖哪些标的                                     |
| `orphan_holdings`         | **有持仓但不在宇宙**：永不会被再平衡或重定价                       |
| `unpriceable_holdings`    | **有持仓但没有 bar**：mark 永远刷不新                              |
| `mark_freshness`          | mark 的日期 vs 该标的最新 bar 日期（陈旧 / 早于数据 / 领先于数据） |
| `settlement_supply`       | 记了多少次判断、结算了几条                                         |
| `scheduler_slots`         | day / night 各上次触发何时，night 是否从未触发过                   |
| `sample_universe_overlap` | **被结算的判断与规则宇宙是不是同一批标的**                         |

**它一上真实数据就把本次审计的发现全报了出来**（exit=1）：

```
FAIL  orphan_holdings       AAPL held but no active rule covers it
FAIL  unpriceable_holdings  AAPL held with no bars
FAIL  mark_freshness        AAPL priced from a day the bar book has already moved past
warn  settlement_supply     5 call(s) recorded and none scored
warn  scheduler_slots       day last fired 2026-09-20, night has never fired
```

变异验证（治具目录，双向）：**接好了的状态全绿** exit=0（SPY 在宇宙内、有 bar、mark 落在最新 bar 日期、
scored 有内容、night 触发过）；上面这份真实状态 3 红 2 黄 ⇒ 检测器既不恒定报红、也不是瞎的。

**已挂进无人值守那一跑**：day cycle 的 payload 现在自带 `linkHealth`（算子会自己问自己接没接好），
检查逻辑放在 `src/agents/finance-link-health.ts` 以便复用，CLI 只做渲染。真实库副本上跑 day：

```
cycle ok: true | dataIssues: []
marksFiled: 7 条（SPY @761.69、QQQ @721.45 …）
unpricedHoldings: ["AAPL"]
linkHealth.ok: false | FAIL: orphan_holdings,unpriceable_holdings,mark_freshness
```

### 反思环评的不是在交易的那一批（2026-09-21，已可见、未改）

`research-samples.jsonl` 里 5 条是 9-20 人工批量研究的产物，标的是
**AAPL / MSFT / NVDA / AMD / GOOGL**；而活跃规则覆盖的是
**SPY / QQQ / IWM / EFA / EEM / TLT / GLD / DBC**——**零重叠**。

> 结算与反思跑在 A 组上，交易跑在 B 组上。hitRate / brier / 底线因此回答的是
> "我在那批从不交易的标的上准不准"，而它读起来像"我准不准"。

新加的检查 `sample_universe_overlap` 直接把它说出来：

```
warn  sample_universe_overlap   every recorded call (AAPL, AMD, GOOGL, MSFT, NVDA)
                                is outside the rule universe: the track record being
                                settled is not the book being traded
```

**为什么没顺手修**：闭合它要"每次判断自动记一条样本"，而样本要带 `conviction`，
结算的 brier / 过度自信差全靠它。规则输出的是目标权重与漂移，**没有置信度**——
要记录就得从权重差编一个出来，那正是这个项目反复拒绝的事（"没有依据的数字"）。
所以这里需要的是产品决定：置信度从哪来。可选项——

1. 只记方向与到期结果，不记 `conviction`，放弃 brier、只算命中率；
2. 让信号层显式输出它自己的置信度（信号本来就该有，但今天没有）；
3. 保持现状，但校准读数标注"这批样本不在交易宇宙内"，避免被当成战绩。

### 路上踩到的两个"字段没接出去"

都是同一形状：下层算对了，上层没把它带出来，于是读数像"什么都没发生"。

1. **`marksFiled` 没进 day payload** ⇒ 7 个持仓明明被重标记了，payload 里看起来是 0 条。
   payload 是逐字段手工列的，漏一个字段不报错、也不红，只是静默地读成"没做"。
2. **孤儿持仓把 `ok` 永久污染成 false** ⇒ `ok` 的定义是 `dataIssues.length === 0`，而我最初把
   "AAPL 持有但本轮没采到"塞进了 `dataIssues`。只要 AAPL 还在账上，day 就**每天 ok=false**，
   与"这一跑真的失败了"不可分。改为专用字段 `unpricedHoldings`，`ok` 只回答"这一跑顺不顺利"；
   孤儿持仓由 `linkHealth` 的 error 级项负责（那才是常设事实该待的地方）。

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
