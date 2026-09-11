# 三地交易方法与市场结构情报

更新时间：2026-09-10（Asia/Shanghai）。这份文件只收录当前可访问的公开材料和本地真实市场诊断，不声称发现任何机构的秘密仓位、私有信号或稳定 alpha。新闻是情景证据，不是交易触发。

## 当前共同背景

- IMF《Global Financial Stability Report》2026年4月指出，宏观、多策略和相对价值基金的融资增长使回购利率跳升、保证金约束和被迫平仓成为核心风险；前十大基金占全部基金总名义敞口超过三分之一，流动性错配会放大压力。[IMF GFSR 2026](https://www.imf.org/-/media/files/publications/gfsr/2026/april/english/text.pdf)
- 美国金融研究办公室（OFR）2026年3月总结其2025年年报：行业总资产约11.8万亿美元、整体杠杆约2.6倍，部分宏观/多策略/相对价值基金杠杆约6倍；2025年回购借款较2022年增长154%，主要经纪商借款增长83%。[OFR 2025 Annual Report highlights](https://www.financialresearch.gov/the-ofr-blog/2026/03/26/calm-markets-and-underlying-risks/)
- 英格兰银行2026年7月金融稳定报告继续监测对冲基金杠杆、波动率放大和信用利差；这支持把“融资、流动性和相关性跃迁”作为伦敦及全球策略的共同失效条件。[BoE Financial Stability Report July 2026](https://www.bankofengland.co.uk/financial-stability-report/2026/july-2026)
- BNP Paribas 2026年1月对246名配置者（涉及约1.1万亿美元对冲基金资产）的调查显示，配置者关注宏观、量化和多策略的低 beta/低相关性，但同时报告相关性上升；这不能作为任何经理未来收益的证明。[BNP Paribas 2026 Hedge Fund Outlook](https://usa.bnpparibas/en/bnp-paribas-publishes-results-of-its-2026-hedge-fund-outlook/)
- 2026年第二季度策略展望普遍强调区域、行业和资本结构分化、事件性波动和灵活风险预算；Franklin Templeton明确把信用、可转债/固定收益相对价值、股票多空和全球宏观列为机会与流动性风险并存的领域。[Franklin Templeton Q2 2026](https://www.franklintempleton.com/articles/2026/alternatives/hedge-fund-strategy-outlook-second-quarter-2026)
- BlackRock 2026展望将AI、地缘政治和产业政策造成的分化、通胀冲击、制度切换和企业活动列为六个主题，同时强调传统分散可能减弱。[BlackRock Hedge Fund Outlook 2026](https://www.blackrock.com/uk/professionals/insights/hedge-fund-outlook)

## 三地公开方法的共同可迁移层

1. **先写风险来源，再写交易方向。** 宏观、信用、事件和波动率都要先拆出收益来源、融资/流动性来源和反证；方向只是表达层。
2. **把信息时间和成交时间分开。** 公告、财报、宏观发布和指数生效必须记录实际可见时点；回测不能用修订值、未来成分或同一收盘成交。
3. **用相对简单基线验证复杂叙事。** 趋势对买入持有，复制对目标产品，事件对市场基线，保护对现金/减仓，波动率对未对冲基线。
4. **把融资和退出当作策略变量。** 回购、借券、保证金、价差和容量在压力下会同时变坏；净名义和总名义都要记录。
5. **将“可解释”与“有效”分开。** 经理自述和媒体报道只能证明方法或事件存在；真实收益需要独立、点时、净成本、样本外和纸面证据。

## 未来 Skill 的落地路径

- **研究模式**：先从 M01/M02/M07/M12 开始，建立来源、时间戳、基线和停止条件。
- **策略候选模式**：只有当前数据、触发、反证、退出、风险预算和流动性齐全，才输出条件性方向；不产生订单。
- **数据受阻模式**：使用真实市场代理或沙箱只测试合同和风险闸门，并保留 `gate_status`；不得跨越 `method_only`。
- **每周新闻刷新**：按三地和策略家族检索官方公告、监管报告、机构公开材料和主流报道；同一事件要记录原文、发布日期、访问时间、市场窗口和反证。
- **组合复盘**：把新信息映射到 M03/M08/M09/M10/M11 的压力项，再检查 M12 共同暴露；不能因为某位经理近期表现好就增加配置。

## 当前研究边界

本文件不做“隐藏超级强大”排名。公开资料无法验证私有参数、实时仓位、容量、对手方或个人账户适用性；匿名爆料、搜索摘要和单期收益不进入证据层。涉及真实投资时，仍需用户的市场、期限、资金用途、最大损失、流动性和现有持仓约束。

## 2025—2026命名案例与反例（用于刷新，不是信号）

- Dymon公开材料把亚洲多策略拆成PM专长、资本配置和压力限制；迁移时应测试“专家袖套 + 组合层风险预算”，不能把Danny Yong的角色变化解释成预测优势。[S46](https://www.aima.org/press-office/the-long-short/perspectives-mark-wong-dymon-asia.html) [S47](https://www.dymonasia.com/news/star-trader-who-lost-his-touch-bounces-back-as-hedge-fund-coach/)
- Prusik官方方法强调质量价值、现金流与股息，媒体报道其香港配置较高；刷新时要检查估值折价、股息变化、地产风险和流动性，而不是追逐标的名单。[S49](https://prusikim.co.uk/philosophy/) [S51](https://www.bloomberg.com/news/articles/2025-07-24/big-bets-on-hong-kong-stocks-help-prusik-fund-outshine-peers)
- CloudAlpha与Chris Wang的公开材料把AI主题落在半导体、PCB、硬件和数据中心供应链；可研究交期、库存、资本开支和订单，不能把会议观点当作当前持仓。[S54](https://www.hkexnews.hk/listedco/listconews/sehk/2026/0413/2026041300005.pdf) [S56](https://hedgefundalpha.com/conferences/sohn-hong-kong-2026-chris-wang/)
- ActusRay/SHK与CASH材料提供“核心/侦察管理人”“量化 + 人工修正”“新闻/CTA回撤”三个风险治理样本；应优先测试beta、换手、借券、波动率和回撤闸门。[S58](https://www.hkexnews.hk/listedco/listconews/sehk/2025/0820/2025082001044.pdf) [S60](https://www.hkexnews.hk/listedco/listconews/sehk/2025/0827/2025082701845.pdf)
- Brilliance、Triata和Tybourne分别提供衍生品/停牌风险、另类数据验证和策略退出反例；13F只能作为部分多头观察，媒体回报必须标记reported。[S61](https://brilliancecap.com/upload/portal/20250311/cecc99d1ae5d5f5b96ffd412d01516b2.pdf) [S65](https://www.sec.gov/Archives/edgar/data/2014039/000201403926000001/0002014039-26-000001-index.html) [S66](https://www.bloomberg.com/news/articles/2025-02-20/tybourne-to-return-external-capital-in-long-only-funds)
- Rokos、Man AHL、Winton和Aspect的公开材料共同显示：宏观表达、趋势速度和市场集合必须与融资、容量、跳空及反转压力一起评估；2025阶段性回报或回撤不等于稳定alpha。[S70](https://rcmplatform.com/) [S75](https://www.man.com/insights/is-this-time-different) [S83](https://aspectcapital.s3.amazonaws.com/documents/Aspect_Capital_Insight_Series_-_Living_With_Trend_Following_Lessons_From_the_P_kS3q7rz.pdf)
- Marshall Wace/TOPS把信号贡献者、行为、方向、周期和交易成本纳入组合优化；个人版本只能用可追溯公开文本，且必须记录信息可见时间。[S87](https://us.mwam.com/regulatory-disclosures/stewardship-code-disclosure/)
- Ruffer与Manulife|CQS提供保护资产和信用筛选的当前流程样本；保护保费、违约损失、久期、流动性和结构风险仍是独立门槛。[S89](https://www.ruffer.co.uk/en/about/investment-approach) [S93](https://www.manulifeim.com/institutional/global/en/cqs/multi-asset-credit)

这些条目只改变刷新时的检索优先级，不改变任何策略的晋级阶段；当前六模块真实市场诊断仍保持 `method_only`，缺失点时、成本、借券或历史期权资料时应继续阻断。

## AI/科技时代刷新（2026-09-10）

- Coatue 2026材料把AI和技术创新作为全生命周期投资主题，公开说明Mosaic/Coatue Brain把数据科学和生成式AI用于研究与监控，但最终投资决定仍由人员作出；刷新时应检查AI采用、单位经济、资本开支回报和估值，而不是只看主题热度。[S103](https://www.coatue.com/ctek/documents/Coatue_CTEK_Main_Q2-2026.pdf) [S104](https://www.coatue.com/ctek/documents/Coatue_-_CTEK_Prospectus_May_1_2026.pdf)
- WorldQuant、Numerai和G-Research共同提供“信号工厂”样本：大量候选模型、外部贡献者、机器学习和工程化部署必须经过相关性、稳定性、成本和容量筛选；Numerai明确不公开基金绩效且混淆数据不能直接交易。[S106](https://www.worldquant.com/how-we-work/) [S107](https://numerai.com/mlst) [S109](https://docs.numer.ai/numerai-tournament/faq) [S110](https://www.gresearch.com/)
- High-Flyer和XTX展示不同的AI应用路径：前者把深度学习、NLP、基本面/另类数据与算力平台结合，后者把机器学习预测放进跨资产做市与低冲击执行；两者都依赖个人无法复制的算力、数据和微观结构权限。[S111](https://www.high-flyer.cn/en/fund/) [S113](https://www.xtxmarkets.com/)
- Burry/Scion提供AI估值反例：13F只是一张滞后、不完整的快照，媒体评论不是空头触发；研究时必须把资本开支、折旧、现金流、催化剂、时间成本和期权保费分开。[S116](https://www.sec.gov/Archives/edgar/data/1649339/000164933925000007/0001649339-25-000007-index.htm) [S117](https://www.investing.com/news/stock-market-news/big-short-investor-burry-targets-ai-boom-with-new-blog-after-hedge-fund-closure-4384222)
- AI辅助散户应作为风险治理样本：调查显示使用率上升，但没有收益证明；任何聊天机器人或Reddit情绪结果都必须经过原始来源、点时和成本闸门。[S118](https://www.investing.com/news/stock-market-news/analysischatgpt-what-stocks-should-i-buy-ai-fuels-boom-in-roboadvisory-market-4254547) [S119](https://arxiv.org/abs/2507.22922)

AI/科技主题的共同压力项：估值与资本开支错配、客户集中、模型漂移、数据/版权/监管事件、融资收紧、流动性拥挤和AI基础设施相关性上升。
