# 大厂与大模型厂商：投研 Agent 现在用什么接口

调研日期：2026-09-20　|　时间范围：2025-09 至 2026-09　|　范围：国内外全覆盖，接口三层（数据 / Agent 协议 / 模型调用）

---

## 0. 结论先行

**一句话答案：投研 Agent 的接口栈在 2026 年已经收敛成"MCP 取数 + Skills 装方法 + 托管 Agent API 编排"三层结构，并且这个结构在国内外的头部厂商身上高度一致。**

五条最重要的判断：

1. **MCP 是事实标准的取数层，且普遍是"远程托管 HTTP"，不是本地 stdio。** Anthropic、同花顺、万得、进门、OpenAI 都把数据以远程 MCP endpoint 暴露；本地 `npx`/`uvx` 起 server 的写法在投研场景里是少数派（因为要挂终端账号与席位）。
2. **数据方正在"退到 API 层"。** 2026 年 3 月起，同花顺 iFinD MCP、东方财富妙想 Skills、万得 AIFin Market、通达信 MCP 密集开放。终端（Bloomberg 24,240 美元/席/年、Wind 持牌机构渗透率 >85%）被拆成一笔笔 API 调用。
3. **Skills 与 MCP 有明确分工：MCP 给原子数据能力，Skills 给方法论与流程。** Anthropic 的仓库是这个分工最清晰的样本（41–53 个 Skill + 11 个数据连接器），月之暗面则把它压成 9 项标准化金融技能。
4. **金融场景买单的前提不是"答得对"，是"可核验"。** 头部方案都把"溯源到原文段落/页码/数据库条目"和"逐次授权 + 全链路留痕"做进架构，而不是当成后期补丁。
5. **国际与国内的差异不在协议，在数据授权方式：** 国际是"每家数据商各开一个 MCP endpoint，订阅制"；国内是"数据商把 MCP/Skill 上架到平台方（腾讯 WorkBuddy、Kimi、豆包、点金）市场里，由平台统一代管凭据"，甚至出现免 API Key 的直连。

---

## 1. 三层接口栈总览

| 层               | 主流形态                                                                                    | 谁在用                                                                     | 关键特征                                                                                            |
| ---------------- | ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| **数据接口层**   | 远程 MCP endpoint（Streamable HTTP）+ REST 兜底 + Python SDK/本地库                         | Anthropic 11 连接器、同花顺 6 个分片 endpoint、万得 Alice Market、进门 MCP | 认证以 API Key / OAuth 头部注入为主；MCP access 通常仍需向数据商单独订阅                            |
| **Agent 协议层** | MCP（取数）+ Skills/Commands（方法）+ 平台自有编排                                          | 全行业                                                                     | 工具粒度普遍"中粒度"：一个 tool 对应一类数据查询（如 `get_stock_fundamentals`），不是一次返回整张表 |
| **模型调用层**   | 托管 Agent API（`/v1/agents`、Agents API）或 OpenAI 兼容接口；金融客户普遍要私有化/专属网络 | Anthropic Managed Agents、OpenAI Agents API、DeepSeek 本地化部署           | 机构侧强要求：数据不出域、零留存、不回流训练                                                        |

协议细节：MCP 于 2025-03-26 引入 Streamable HTTP 并废弃原 HTTP+SSE 传输，2026 年成为主流默认。A2A / AG-UI 在投研场景未见到主导性落地（**此项为观察性判断，未找到权威落地证据**）。

---

## 2. 国际厂商

### 2.1 Anthropic — Claude for Financial Services（一手证据最完整）

仓库：`https://github.com/anthropics/financial-services`（Apache-2.0，35.1k stars，5.2k forks，72 commits）

- **双形态交付**：装成 Claude Cowork 插件，或通过 Claude Managed Agents API（`POST /v1/agents`）部署；两者共用同一套 system prompt 与 skills。Claude Code 侧用 `claude plugin marketplace add anthropics/financial-services` 安装。
- **10 个命名 Agent**：Pitch Agent、Meeting Prep Agent、Market Researcher、Earnings Reviewer、Model Builder、Valuation Reviewer、GL Reconciler、Month-End Closer、Statement Auditor、KYC Screener。
- **垂直插件**：`financial-analysis`（核心，承载全部数据连接器）、investment-banking、equity-research、private-equity、fund-admin、operations、claude-for-financial-advisors；伙伴构建：`lseg`、`sp-global`。
- **MCP 连接器集中在一个文件**：`plugins/vertical-plugins/financial-analysis/.mcp.json`。这是本项目最值得抄的一点——**连接器单点配置，跨 agent 共享**。真实 endpoint：

| 数据商       | MCP endpoint                                                            |
| ------------ | ----------------------------------------------------------------------- |
| Daloopa      | `https://mcp.daloopa.com/server/mcp`                                    |
| Morningstar  | `https://mcp.morningstar.com/mcp`                                       |
| S&P Global   | `https://kfinance.kensho.com/integrations/mcp`                          |
| FactSet      | `https://mcp.factset.com/mcp`                                           |
| Moody's      | `https://api.moodys.com/genai-ready-data/m1/mcp`                        |
| LSEG         | `https://api.analytics.lseg.com/lfa/mcp`                                |
| PitchBook    | `https://premium.mcp.pitchbook.com/mcp`                                 |
| Aiera        | `https://mcp-pub.aiera.com`                                             |
| MT Newswires | `https://vast-mcp.blueskyapi.com/mtnewswires`                           |
| Chronograph  | `https://ai.chronograph.pe/mcp`                                         |
| Egnyte / Box | `https://mcp-server.egnyte.com/mcp` / `https://mcp.box.com`（文档存储） |

README 明确写了："MCP access may require a subscription or API key from the provider"——**协议统一不等于数据免费**。

- **Skills 与 Commands**：`/comps`、`/dcf`、`/lbo`、`/3-statement-model`、`/debug-model`（Excel 审计）、`/earnings`、`/initiate`、`/screen`、`/thesis`、`/catalysts`、`/ic-memo`。Skill 自动触发，Command 显式触发。
- **模型调用可换底座**：Claude for Microsoft 365 add-in 可由 IT 管理员指向 **Vertex AI / Bedrock / 内部 LLM 网关**，而非必须用 Anthropic API。
- **合规边界写进仓库首屏**：不做投资/法律/税务建议，不执行交易、不过账、不批准入，所有输出 staged for human sign-off。
- **2026-09-14 Claude for Financial Advisors**：连接 BlackRock、Vanguard、Charles Schwab、iCapital 等托管人与财富科技平台（媒体报道，**未取得 Anthropic 一手文档，标注为媒体确证**）。

### 2.2 OpenAI — ChatGPT for Financial Services（2026-09-10）

- 同日三连发：Agents API 公测（支持多沙箱）、Data 插件全面上线、金融专用版 ChatGPT（媒体口径为 GPT-6 Astra 驱动）。
- **数据侧内置 LSEG、PitchBook、Daloopa 等持牌数据源**，Morgan Stanley 与 Evercore 参与设计。
- 注：此条为**媒体与二手来源确证**（多家一致），未取得 OpenAI 官方接口文档，具体 tool 名称与 endpoint 未公开 → **标 [不确定]**。

### 2.3 Google Cloud — Gemini Enterprise for Financial Services（2026-08-25）

- 含 **Google 托管的 Financial Research agent**，可执行端到端研究，并输出**方法说明与置信度**；50+ 新 skills。
- 2026-06 另有面向 C 端的 Google Finance agent（自然语言持续跟踪持仓、题材、大盘）。
- 来源：Google Cloud 官方新闻室 + PRNewswire。

### 2.4 机构内部系统（JPMorgan / BlackRock / Morgan Stanley 等）

- BlackRock **Aladdin Copilot**：面向投资团队的生成式 AI 平台，查数据、起草报告；2025-10 起 Aladdin Wealth 的 AI commentary tool 在 Morgan Stanley Portfolio Risk Platform 首发。
- 这类系统**没有对外 API**，接的是自有数据仓 + Aladdin 风险分析，属于"内部系统 + 内部数据"范式，与上面"开放 MCP"路线是两条路。

### 2.5 Bloomberg

- 终端订阅价 **24,240 美元/席/年**（2026），约 **32.5 万订阅用户**，终端业务年收入 ≥80 亿美元级；中国侧 Wind 持牌机构渗透率 >85%、2024 营收超 36 亿元，Wind/Choice/iFinD 合计份额约 68.5%。
- **Bloomberg 是否提供官方 MCP：未确证 [不确定]**。社区存在基于 BLPAPI 的第三方 Bloomberg-MCP server，未见官方发布。

---

## 3. 国内厂商

### 3.1 数据方（最值得抄的一层）

**同花顺 Financial-API（一手，证据最硬）**　仓库 `HiThink-Tech/Financial-API`

五种接入形态共用**同一个 API Key**（环境变量 `HITHINK_FINANCE_API_KEY`）：

| 形态                | 具体形式                                                                                                                                             |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| REST                | `GET https://fuyao.aicubes.cn/api/a-share/prices/snapshot?thscodes=600519.SH`，头部 `X-api-key: <KEY>`                                               |
| 托管 MCP            | 按业务域**分片 6 个** endpoint：`/mcp/a-share`、`/mcp/a-share-index`、`/mcp/meta`、`/mcp/fund`、`/mcp/futures`、`/mcp/options`，头部同样 `X-api-key` |
| Agent Skill         | `npx skills add HiThink-Tech/Financial-API --skill hithink-finance -g --yes`                                                                         |
| CLI                 | `@hithink-tech/hithink-finance-cli`（npm，国内可用 npmmirror 镜像）                                                                                  |
| Python SDK / 本地库 | `python/` + 本地 marketdb                                                                                                                            |

数据覆盖：行情快照与历史、财务报表与五类指标、估值（PE TTM/MRQ、PB MRQ 等）、集合竞价、标的目录 `thscode`、交易日历、指数与板块成分、涨跌停池/炸板/连板/异动/热榜/龙虎榜、公募基金、期货期权。文档聚合地址 `https://fuyao.aicubes.cn/llms-full.txt`（面向 LLM 抓取）。

**万得 — AIFin Market / Alice Market**（`market.windalice.com`）

- 三类标准化接口：**MCP 取数 + Skill 分析 + Alice Agent 编排**；原生兼容 Claude、Cursor、Trae。
- 工具粒度示例：`get_stock_fundamentals`（一次返回多公司营收/净利/毛利率/净利率）。
- Skill 生态：万得自研 + 严选第三方（示例：`/wind-find-finance-skill` 盘后复盘技能）。
- WindClaw（2026-03）：基于 LCX Agent 框架的投研 Agent 工作台。

**东方财富 — 妙想 Skills**（2026-03-13）

- 定位"为 LCX Agent 提供全面、权威、及时的金融资讯检索能力"，底层宣称**原生集成机构级 MCP 金融数据库**，把机构高频六大核心场景封装为开箱即用技能。
- 注：具体 MCP endpoint 与 tool 清单未在公开材料中给出 → **标 [不确定]**。

**恒生电子 / 恒生聚源 — WarrenQ**

- 2025-02 起全面接入 DeepSeek；WarrenQ F1 提供"Agent 交叉协同 + **MCP & Skills 管理中台**"。

**进门投研 — MCP 网关**

- MCP 能力已上架 **腾讯 WorkBuddy、豆包工作、Kimi、通义点金** 四个 Agent 应用。
- 工具不止取数：公众号舆情、自选股管理、会议管理（创建/报名/托管/转写）、云文档管理、量化回测。
- 数据：95% 券商公开路演资源、7000+ 上市公司业绩说明会、600 万+ 研报；股票与指数行情秒级刷新。

### 3.2 平台方与模型方

| 厂商     | 产品                                           | 接口与数据接入要点                                                                                                                                                                                                                                                                                               |
| -------- | ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 腾讯     | WorkBuddy 金融版（2026-09-03 上线）            | 在智能体框架上叠加**金融业务视图 + 行业 Skill + 专家团 + MCP 应用 + 数据连接器 + 流程规则 + 组织治理**；四大工作台（公司金融/零售金融/投研投顾/个客经营）；已进入 100+ 金融机构；架构为"隔离算力 + 专属网络 + 本地安全治理"                                                                                      |
| 阿里     | 点金（2026-05 发布，2026-06 金融展）           | 金融级通用智能体，直连市场行情与阿里资产，**原生支持 Wind 万得、盈米**等；覆盖投研/投顾/信贷/风控/理赔/营销/客服任务链；底座为千问，跑在百炼                                                                                                                                                                     |
| 月之暗面 | Kimi（K3，2.8T 参数、1M 上下文、Tool Calling） | 9 项标准化金融技能（机构财务建模、机构研究报告、机构 PPT、金融动态图表、业绩点评、一致预期地图、组合复盘、持仓早报、HK IPO 透镜）；通过 **MCP 打通 Wind、同花顺 iFinD、东方财富、恒生电子、S&P、SEC EDGAR、IMF、World Bank、FRED、财联社、财新、新华财经、天眼查、元典法律**；WindClaw 接入后**免 API Key** 直连 |
| 蚂蚁数科 | Agentar 金融版（2026-09-10 外滩大会）          | 开箱即用金融智能体专家团 + 行业 Skill；IDC 口径金融大模型与智能体市场头部厂商                                                                                                                                                                                                                                    |
| DeepSeek | V4（2026-04 后）                               | 凭开源低成本成为券商**本地化部署**首选（兴业、国投、中泰、国金、山西等券商已部署）                                                                                                                                                                                                                               |

### 3.3 国内格局的四类划分（东吴证券口径）

数据拥有者（同花顺、Wind、东方财富）｜场景拥有者（九方智投、财富趋势、指南针）｜模型拥有者（豆包、DeepSeek、通义千问、智谱）｜平台拥有者（腾讯 WorkBuddy 等）。

核心张力：平台型 Agent 既是数据方最大客户，也是最大威胁——MCP 标准化后用户不必打开各家终端，数据厂商面临沦为"底层供应商"的风险。

---

## 4. 数据接口形式的横向对比

| 形式                       | 典型延迟            | 适用                                       | 在 Agent 里的接入成本                                              |
| -------------------------- | ------------------- | ------------------------------------------ | ------------------------------------------------------------------ |
| **MCP Tools（远程 HTTP）** | 秒级（快照/基本面） | 财报、财务指标、估值、研报、宏观、基金资料 | 低，平台一键挂载；但工具数量要控，否则吃上下文                     |
| **REST 快照**              | 秒级–分钟级         | 同上，MCP 的底层实现                       | 低，需自己写 tool wrapper                                          |
| **WebSocket 推送**         | 毫秒–亚秒           | 实时行情、tick、盘口                       | 中：Agent 是请求-响应式，长连接订阅需要额外状态管理                |
| **Python SDK / 本地库**    | 取决于源            | Wind/Tushare/AkShare 类                    | 中：要么包一层 MCP server，要么让 Agent 直接执行代码（沙箱要求高） |
| **浏览器 / Computer Use**  | 秒级–分钟级         | **没有 API 的系统**的兜底路径              | 高，但覆盖一切                                                     |

金融数据的额外约束（有别于通用场景）：数据二次分发授权、Level-2 行情许可、研报版权、以及"输出必须可溯源"的行业硬要求。

---

## 5. 对自建投研 Agent 的可迁移结论

以下为**判断**，不是引用事实：

1. **连接器单点配置 + 按域分片**。抄 Anthropic 的 `.mcp.json` 单点与同花顺的按域分片（6 个 endpoint）；单一大 endpoint 会让 tools/list 撑爆上下文。
2. **一个凭据通吃多种形态**。同花顺"一个 API Key 走 API/MCP/CLI/Python"显著降低摩擦；凭据解析继续保持在单一位置。
3. **MCP 给原子能力，Skills 给方法论**。这是 Anthropic 与 Kimi 的共同选择；不要把行业方法论塞进 MCP tool 描述里。
4. **可核验性要建在架构里**。中信建投与月之暗面的五项措施可直接借鉴：数据分类分级、最小必要、逐次授权、输出标注来源与时间、任务-来源-决策-调用记录关联保存可回查。
5. **合规措辞前置**。头部方案都在仓库/产品首屏写"不构成投资建议、不执行交易、输出需人工签署"。
6. **无 API 系统的兜底**：保留 MCP / API / 浏览器三条路径，否则企业内网系统会成为盲区。

---

## 6. 证据与不确定项

**一手证据（官方仓库/官网/官方新闻室）**

- `https://github.com/anthropics/financial-services`（README 全文，含 12 个 MCP endpoint）
- `https://github.com/HiThink-Tech/Financial-API` + `https://fuyao.aicubes.cn/docs/`（REST 与 MCP 配置）
- `https://market.windalice.com/`（万得 Alice Market）
- `https://www.googlecloudpresscorner.com/2026-08-25-Google-Cloud-Launches-Gemini-Enterprise-for-Financial-Services`
- `https://www.blackrock.com/aladdin/platforms/products/aladdin-copilot`
- `https://platform.kimi.com/docs/guide/kimi-k3-quickstart`

**权威媒体（21 世纪经济报道 / 腾讯新闻深度 / 东吴证券研报转述）**

- `https://news.qq.com/rain/a/20260903A0A3IB00`（国内金融智能体接口开放全景）
- `https://news.qq.com/rain/a/20260917A0E9IS00`（彭博退向 API、Kimi 数据接入名单与合规网关）
- `https://www.economicnews.cn/2026/09/10/10992.html`（进门 MCP 上架四平台）

**明确不确定**

- OpenAI ChatGPT-FS 的具体 tool 名与 endpoint 未公开（仅媒体一致口径）
- Bloomberg 官方 MCP 未确证（仅见第三方社区实现）
- 东方财富妙想 Skills 的底层 MCP endpoint 与 tool 清单未公开
- A2A / AG-UI 在投研场景的落地程度缺乏权威证据
- 各家 MCP 的计费细则（是否按调用次数、是否绑定终端席位）普遍未公开

**执行偏差说明**：本轮原计划启动 8 个并行子 agent 做逐项深挖，但触发了平台额度限流（429），改为主线程直接检索。因此个案覆盖深度不均——Anthropic、同花顺、万得、Kimi 为一手/深度证据，其余为媒体与官方新闻室层面证据。

---

## 7. 端点实测记录（2026-09-20，本机直连）

上文登记的接口不是照抄文档就算数，已逐个真实探活。**13 个端点全部真实存在并响应**：

| 连接器                                                                 | 方法            | 实测响应                                            | 判定                       |
| ---------------------------------------------------------------------- | --------------- | --------------------------------------------------- | -------------------------- |
| 同花顺 REST `/api/a-share/prices/snapshot`                             | GET             | 200 + `{"code":2003,"message":"Missing X-api-key"}` | 端点存在，取数需 key       |
| 同花顺 MCP `/mcp/a-share`                                              | POST initialize | **200 + JSON-RPC result**                           | **握手无需 key**           |
| 同花顺 MCP `/mcp/meta`                                                 | POST initialize | 200 + serverInfo                                    | 同上                       |
| SEC EDGAR `/submissions/CIK0000320193.json`                            | GET             | **200 + Apple 真实数据**                            | **免凭据可用**             |
| FRED `/fred/series/observations`                                       | GET             | 400（缺 api_key 参数）                              | 端点存在                   |
| FactSet / S&P / LSEG / Morningstar / Daloopa / PitchBook / Moody's MCP | POST            | **全部 401**                                        | 端点真实存在，需订阅凭据   |
| 万得 Alice Market 门户                                                 | GET             | 200 HTML                                            | 门户存在，MCP URL 仍未公开 |

**真实握手拿到的 21 个工具**（`fuyao-a-share-mcp` v1.0.0，MCP 协议 2025-06-18）：
`get_a_share_prices_snapshot`、`get_a_share_prices_historical`、`get_a_share_corporate_actions_adjustment_factors`、
`get_a_share_financials_income_statements`、`get_a_share_financials_balance_sheets`、`get_a_share_financials_cash_flow_statements`、
`get_a_share_financials_indicators`、`get_a_share_valuations_snapshot`、`get_a_share_calendar_trading_days`、
涨跌停池 / 炸板池 / 连板 / 异动 / 热榜 / 龙虎榜系列、`get_a_share_auction_snapshot` 等。工具粒度确为"一类数据一个 tool"，印证第 1 节的中粒度判断。

### 实测发现的一个真实陷阱

`tools/call` 在无 key 时返回 **`isError: false`**，但 payload 是
`{"code":2003,"message":"Missing X-api-key","data":null}` —— HTTP 层成功、业务层失败。
只看 `isError` 会把错误当数据交出去。已在 `finance-mcp-client.ts` 增加 `detectVendorBusinessError()`
保守检测（只在 payload 形如错误信封时标记），并在工具返回里给出 `businessError` 与告警。
真实验证：`transport_isError=false` / `business_error_detected=true` / `{"code":2003,"message":"Missing X-api-key"}`。

## 8. 可复现的端点探活（不是一次性脚本）

第 7 节的实测最初是用临时脚本做的，这不可复现 —— 而"端点存在"是会被时间推翻的声明
（厂商会改 URL、下线主机、换鉴权）。已把它固化成常规动作：

```bash
node --import tsx scripts/operator/lcx-finance-connector-probe.ts            # 人类可读
node --import tsx scripts/operator/lcx-finance-connector-probe.ts --json     # 机器可读
```

只读、无副作用：每个连接器只做一次 MCP 握手或一次 GET，不下单、不写账本、不搬凭据。
2026-09-20 全量 21 个连接器的判定：

| 判定               | 数量 | 含义                                                                |
| ------------------ | ---- | ------------------------------------------------------------------- |
| `reachable`        | 7    | 端点对一次合法请求给出了正常应答                                    |
| `auth_required`    | 9    | 端点真实但被凭据拦住（**与主机已死是相反的事实**）                  |
| `endpoint_missing` | 5    | 本仓未登记可探活端点（万得/妙想/进门/Skill 类），**未探测、不猜测** |
| `unreachable`      | 0    | DNS / 连接失败                                                      |
| `error`            | 0    | 应答了，但请求没落到有效资源上                                      |

`reachable` 的 7 个：6 个同花顺 MCP 端点（握手成功，协议 2025-06-18）+ SEC EDGAR（带探测路径
`CIK0000320193.json` 后 200）。`auth_required` 的 9 个：同花顺 REST、FRED、以及 7 家国际厂商。

### 判定的两条校准（第一版曾误报）

初版把 HTTP 404/400 一律算 `reachable`，这**不诚实** —— 主机活着不等于该 URL 有效。已按真实响应体校准：

1. **SEC EDGAR 声明的是基址**（`https://data.sec.gov/submissions`），裸 GET 得到 S3 的
   `<Code>NoSuchKey</Code>` 404。探活必须带路径，因此加了探测路径表（**放在探活脚本内，不进注册表** ——
   "哪个路径能证明存活"是探活的事实，不是连接器的声明）。加权后 200。
2. **FRED 用 XML 报错**：`<error code="400" message="Bad Request. Variable api_key is not set."/>`。
   凭据缺失的写法各家不一（同花顺是 JSON 里的 `Missing X-api-key`），只认一种就会把"活着但被拦"
   报成失败。现在两种形状都归入 `auth_required`。

校准后：4xx 若非凭据问题一律记 `error`，不再混进 `reachable`。
