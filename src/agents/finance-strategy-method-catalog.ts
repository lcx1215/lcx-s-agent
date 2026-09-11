/**
 * Repository-local machine-readable projection of the full trader-strategy-lab
 * method surface. The source Skill contains the longer evidence and source
 * notes; this catalog makes every method and direction available to LCX model
 * requests regardless of which finance entry point selected the task.
 */

export const FINANCE_STRATEGY_METHOD_CATALOG_SCHEMA_VERSION =
  "lcx_finance_strategy_method_catalog_v1" as const;

export const STRATEGY_METHOD_IDS = [
  "M01",
  "M02",
  "M03",
  "M04",
  "M05",
  "M06",
  "M07",
  "M08",
  "M09",
  "M10",
  "M11",
  "M12",
] as const;
export type StrategyMethodId = (typeof STRATEGY_METHOD_IDS)[number];

export type StrategyMethodDefinition = Readonly<{
  id: StrategyMethodId;
  name: string;
  hypothesis: string;
  requiredChecks: readonly string[];
  failureModes: readonly string[];
  personalBoundary: string;
}>;

export type StrategyMethodOperationalContract = Readonly<{
  mechanism: string;
  inputs: readonly string[];
  workflow: readonly string[];
  trigger: string;
  invalidation: readonly string[];
  minimumEvidence: readonly string[];
}>;

export type StrategyDirectionDefinition = Readonly<{
  id: `D${string}`;
  name: string;
  modules: readonly StrategyMethodId[];
  hypothesis: string;
  minimumValidation: string;
}>;

const method = (
  id: StrategyMethodId,
  name: string,
  hypothesis: string,
  requiredChecks: readonly string[],
  failureModes: readonly string[],
  personalBoundary: string,
): StrategyMethodDefinition =>
  Object.freeze({
    id,
    name,
    hypothesis,
    requiredChecks: Object.freeze([...requiredChecks]),
    failureModes: Object.freeze([...failureModes]),
    personalBoundary,
  });

export const FINANCE_STRATEGY_METHODS: readonly StrategyMethodDefinition[] = Object.freeze([
  method(
    "M01",
    "科学研究与透明基线",
    "条件收益必须在预注册规则、简单基线、点时数据和净成本下可重复；解释好听不等于预测有效。",
    [
      "冻结目标、基线、样本外切分和停止条件",
      "记录失败尝试、泄漏、参数与成本敏感性",
      "报告收益、波动、回撤、换手和尾部",
    ],
    ["单一时期或少数证券", "未来信息或幸存者样本", "成交假设不可实现"],
    "这是所有方法的研究质量闸门，不是收益策略或实盘证明。",
  ),
  method(
    "M02",
    "中低频跨资产趋势",
    "投资者调整较慢，价格变化可能延续；趋势规则不负责预测顶底。",
    [
      "调整后价格、波动率、相关性和费用",
      "滞后信号、次个可交易时点和风险权重",
      "现金/买入持有基线、成本压力和多市场状态",
    ],
    ["震荡与 V 形反转", "政策干预、跳空、换手和滑点", "把机构双向杠杆收益写成个人可得"],
    "个人版本优先研究公开产品或只做多/现金切换，不复制期货 CTA 的杠杆和执行。",
  ),
  method(
    "M03",
    "宏观变化与市场定价差",
    "增长、通胀和政策变化影响不同资产，价值来自相对已定价预期的差异。",
    [
      "官方首发值、修订和发布日期",
      "政策预期、收益率曲线、汇率和资产表达",
      "增长/通胀情景与市场已定价程度",
    ],
    ["数据修订、政策路径反转", "观点正确但期限或表达错误", "宏观样本稀疏和制度变化"],
    "没有实时曲线与预期历史时，只输出条件化配置研究，不声称市场尚未定价。",
  ),
  method(
    "M04",
    "风险暴露复制与产品筛选",
    "部分基金收益可由公开市场暴露解释，但可解释部分不等于全部 alpha。",
    [
      "时点一致的基金净收益和候选因子",
      "滚动样本外拟合、跟踪误差和尾部偏离",
      "费用、换手、风格突变和币种一致",
    ],
    ["风格突变、估计滞后", "毛/净收益或币种混用", "追逐近期赢家"],
    "用于产品筛选和风险解释，不把复制结果写成原基金的可交易收益。",
  ),
  method(
    "M05",
    "股票多空、相对价值与信息源评价",
    "基本面预期或相对估值偏差可以被公开数据检验；多空只是在目标上隔离部分方向风险。",
    ["财报/公告/预测的可得时点", "行业、国家、风格与净/总暴露", "借券、拥挤、换手和多空分开评估"],
    ["基本面断裂、逼空、借券撤回", "永久重估被误写成价差收敛", "把公开信号写成专有网络"],
    "个人版本先做仅多头或相对强弱研究；没有空头条件不能声称多空组合收益。",
  ),
  method(
    "M06",
    "短期反向与流动性冲击",
    "暂时失衡可能回归，但重大新信息驱动的价格变化可能持续。",
    ["盘口/成交/订单流和新闻时点", "短时限、价格失效、最大库存", "滑点、不利选择、停牌和跳空"],
    ["持续趋势、跳空和低流动性", "仿真能成交而现实不能", "用日线替代盘中仍声称同一策略"],
    "通常保持研究级；日线代理必须说明它不等于盘中反向交易。",
  ),
  method(
    "M07",
    "封闭式基金折价与催化剂",
    "价格相对 NAV 的折价可能在正式事件后缩小，但 NAV 路径和等待成本同样重要。",
    ["同币种同估值时点 NAV/价格", "回购、要约、清算的原始公告", "分配、费用、成功概率和时间退出"],
    ["NAV 下跌、要约失败、比例配售", "折价长期不收敛", "传闻或行动派持仓被当作催化剂"],
    "只研究公开二级市场可执行部分，不假设个人拥有投票权、法律资源或机构影响力。",
  ),
  method(
    "M08",
    "信用、资本结构与可转债",
    "同一发行人的债、股和衍生品可能有相对定价差，但需要扣除违约、融资和对冲风险。",
    [
      "条款、久期、delta、回收率",
      "借券、融资、保证金和退出流动性",
      "股价下跌同时信用利差扩大的压力",
    ],
    ["违约跳跃、条款改变", "券源撤回、融资续不上", "账面收敛抵不过到期前破产"],
    "通常限研究或经尽调的公开载体，不能把高杠杆基差写成无风险套利。",
  ),
  method(
    "M09",
    "指数事件与 ETF 价格机制",
    "已公告的规则变化可能产生被动资金需求，但市场通常会提前布局。",
    ["公告、审核、生效时点", "成分权重、跟踪资金和交易量", "提前抢跑、收盘冲击和生效后反转"],
    ["公告变更或预期落空", "资金估计不确定", "把申赎套利权限假定为个人可得"],
    "输出事件研究和监测，不把普通 ETF 二级交易写成授权参与商的一级套利。",
  ),
  method(
    "M10",
    "尾部保护与保险预算",
    "为少见但严重的损失支付保费，目标是组合生存和现金流保护。",
    [
      "组合压力损失和真实期权报价",
      "期限、希腊值、价差、乘数和保费预算",
      "慢跌、急跌、波动率冲击和期限错配",
    ],
    ["theta/保费长期拖累", "保护工具与危机类型不匹配", "只看期末 payoff"],
    "权限、知识或规模不足时先比较减仓和现金，不生成伪精确期权指令。",
  ),
  method(
    "M11",
    "波动率相对价值",
    "不同市场、期限或执行价的波动率关系可能偏离可解释范围。",
    ["完整期权曲面和同步时点", "gamma/vega/theta、相关性和连续对冲成本", "结构变化与流动性压力"],
    ["波动率曲面跳变", "相关性跃迁、跳空", "delta 中性被误写成风险中性"],
    "没有完整曲面和对冲执行能力就保持研究级，不生成伪精确套利。",
  ),
  method(
    "M12",
    "多策略组合与融资拥挤",
    "策略名称数量不等于独立风险；共同因子和融资恶化会同步放大损失。",
    [
      "穿透持仓、国家/行业/利率/汇率/波动率因子",
      "总/净名义、保证金、现金和退出天数",
      "压力相关性、流动性和共同 AI 暴露",
    ],
    ["共同因子集中、被迫去杠杆", "融资余量缩小、借券撤回", "近期业绩好被误当作应加仓"],
    "这是立即可用的风险诊断工具；不提供自动调仓、下单或资金权限。",
  ),
]);

const methodContract = (
  mechanism: string,
  inputs: readonly string[],
  workflow: readonly string[],
  trigger: string,
  invalidation: readonly string[],
  minimumEvidence: readonly string[],
): StrategyMethodOperationalContract =>
  Object.freeze({
    mechanism,
    inputs: Object.freeze([...inputs]),
    workflow: Object.freeze([...workflow]),
    trigger,
    invalidation: Object.freeze([...invalidation]),
    minimumEvidence: Object.freeze([...minimumEvidence]),
  });

export const FINANCE_STRATEGY_METHOD_CONTRACTS: Readonly<
  Record<StrategyMethodId, StrategyMethodOperationalContract>
> = Object.freeze({
  M01: methodContract(
    "条件收益只有在预注册规则、简单基线、点时数据和净成本下可重复才值得继续。",
    ["观察时间戳和可得时点", "退市/成分历史", "成本和标签生成过程"],
    [
      "预先指定目标、基线、样本外切分和停止条件",
      "保留所有尝试并滚动前推，重叠标签使用隔离区间",
      "参数变化只能由训练段决定",
    ],
    "净成本结果跨越预先指定的时期，并相对简单基线仍有可解释的增量。",
    ["优势只来自单一时期、证券或参数", "删掉失败试验", "成交假设不可实现"],
    ["问题/范围冻结", "点时来源和截止时间", "同成本基线", "泄漏审计", "失败结果保留"],
  ),
  M02: methodContract(
    "投资者调整较慢，价格变化可能延续；趋势规则不负责预测顶底。",
    ["调整后价格", "展期/乘数", "波动率和相关性", "成交量与费用"],
    [
      "先用固定中期突破或均线规则，不事后挑历史最优周期",
      "用次个可交易时点执行，按信号/波动率控制风险和总名义",
      "同时检查震荡、V形反转、换手和滑点",
    ],
    "完成观察周期后，净预期优势覆盖实施成本并通过风险/流动性上限。",
    ["规则反转", "风险或流动性越限", "数据异常", "震荡和 V 形反转"],
    ["滞后信号", "同成本现金/买入持有基线", "至少三段时期", "成本和参数压力"],
  ),
  M03: methodContract(
    "增长、通胀和政策变化影响不同资产，价值来自相对于已定价预期的差异。",
    ["官方首发值/修订/发布日期", "政策声明", "收益率曲线", "市场预期"],
    [
      "先列增长/通胀情景，再检查价格已经反映的部分",
      "选择与假说关系清楚的股票、汇率或利率表达",
      "比较不同表达的期限、相关性和融资风险",
    ],
    "同一宏观变化同时有点时数据和价格证据，且表达仍有未被定价的风险补偿。",
    ["数据修订推翻论点", "政策路径反转", "市场已充分定价", "损失超过预算"],
    ["发布日期与 vintage", "预期历史", "资产表达", "情景反证"],
  ),
  M04: methodContract(
    "部分产品收益可由公开市场暴露解释；可解释部分不等于全部 alpha。",
    ["时点一致的产品净收益", "候选因子总收益", "费用", "持仓规则"],
    [
      "只在训练段估计少量受约束暴露",
      "在完全后续区间滚动评估跟踪误差、尾部偏离和换手",
      "把风格突变与因子估计滞后单独记录",
    ],
    "样本外复制误差、成本和流动性都在预设容忍范围内。",
    ["风格突变", "净/毛收益或币种混用", "追逐近期赢家", "暴露偏差越限"],
    ["滚动样本外", "跟踪误差", "尾部偏离", "费用/调仓成本"],
  ),
  M05: methodContract(
    "基本面预期或相对估值偏差可以被公开数据检验；多空只隔离部分方向风险。",
    ["财报/公告/预测时间戳", "行业/国家/风格暴露", "借券成本", "净/总暴露"],
    [
      "记录原始预测、期限、反证和基线，并去重同源新闻",
      "分开比较多头、空头和组合净暴露",
      "用行业/因子模型检查所谓中性是否真实",
    ],
    "信息增量、催化剂和净风险收益同时成立，且借券和拥挤成本可承受。",
    ["基本面结构断裂", "逼空或借券撤回", "永久重估", "新闻时点不可得"],
    ["点时财报/公告", "行业和因子中性", "借券/换手", "多头基线"],
  ),
  M06: methodContract(
    "暂时失衡可能回归，但重大新信息驱动的价格变化可能持续。",
    ["盘口/成交/价差", "订单流", "新闻时点", "最大库存"],
    [
      "先排除新增基本面信息，再测试短期偏离和回归",
      "固定持有时限、价格失效阈值和库存上限",
      "把滑点、不利选择、停牌和跳空计入净结果",
    ],
    "偏离有短期回归证据且净优势覆盖真实成交摩擦。",
    ["持续趋势", "跳空", "低流动性", "仿真成交但现实不可成交"],
    ["盘中点时数据", "成交成本", "库存/时限规则", "新闻排除检查"],
  ),
  M07: methodContract(
    "价格相对 NAV 的折价可能在明确事件后缩小，但 NAV 路径和等待成本同样重要。",
    ["同币种同估值时点 NAV/价格", "分配/费用", "回购或要约公告", "杠杆"],
    [
      "把折价、NAV 路径、分配、费用和等待期间收益放进同一账本",
      "只接受正式公告、投票或清算路径作为催化剂",
      "为失败、比例配售、延迟和时间退出设情景",
    ],
    "催化剂可验证、估值可信，且成功概率调整后的净期望收益为正。",
    ["NAV 下跌", "要约失败/比例配售", "长期不收敛", "催化剂延迟"],
    ["NAV/价格同步时点", "原始事件公告", "分配/费用", "时间退出"],
  ),
  M08: methodContract(
    "同一发行人的债、股或衍生品可能存在相对定价差，但必须扣除违约、融资和对冲风险。",
    ["条款/久期", "回收率和违约情景", "delta", "借券/融资/保证金"],
    [
      "先扣除违约、融资和对冲成本，再区分错价与流动性补偿",
      "同时压力测试股价下跌、利差扩大、券源撤回和保证金提高",
      "核对到期前退出和融资续作条件",
    ],
    "相对价差在最坏条款、融资和流动性情景下仍有足够安全边际。",
    ["条款改变", "违约跳跃", "券源撤回", "融资不能续", "对冲失效"],
    ["发行人条款", "回收率", "融资/借券", "压力相关性", "退出流动性"],
  ),
  M09: methodContract(
    "已公告规则变化可能产生被动资金需求，但市场通常会提前布局。",
    ["原始公告", "审核/公告/生效时间", "成分权重", "跟踪资金和成交量"],
    [
      "确认事件来源、适用指数和完整时间线",
      "用区间而非伪精确值估计资金流，并比较公告前后窗口",
      "检查抢跑、收盘冲击和生效后反转",
    ],
    "事件确认且未被充分交易，资金/容量区间和退出路径可解释。",
    ["公告变更", "预期落空", "提前抢跑", "收盘冲击", "生效后反转"],
    ["公告/生效时点", "成分历史", "资金流不确定性", "冲击和容量"],
  ),
  M10: methodContract(
    "为少见但严重的损失支付保费，目标是组合生存和现金流保护。",
    ["组合压力损失", "真实期权报价", "期限/希腊值", "价差/乘数/保费预算"],
    [
      "先比较减仓、现金和有限损失期权结构",
      "同时测试慢跌、急跌、波动率冲击和期限错配",
      "预先写获利兑现、续保、到期和停止保费规则",
    ],
    "保护需求、预算、工具与危机类型匹配，且组合层面改善超过保费拖累。",
    ["theta/保费长期拖累", "保护错配", "只看期末 payoff", "跳空无法兑现"],
    ["真实报价和价差", "组合压力", "四类情景", "保费/退出规则"],
  ),
  M11: methodContract(
    "不同市场、期限或执行价的波动率关系可能偏离可解释范围。",
    ["同步期权曲面", "delta/gamma/vega/theta", "相关性", "连续对冲成本"],
    [
      "先证明相对异常有机制解释，再计算非线性压力损益",
      "把相关性跃迁、跳空、资金和连续对冲成本放入情景",
      "分开记录局部 delta 中性与组合真实风险",
    ],
    "曲面关系、结构变化和对冲成本均在预设范围内，且风险预算可承受。",
    ["曲面跳变", "相关性跃迁", "跳空", "流动性或对冲执行恶化"],
    ["完整同步曲面", "Greeks", "动态对冲成本", "压力和流动性"],
  ),
  M12: methodContract(
    "策略名称数量不等于独立风险；共同因子和融资恶化会同步放大损失。",
    ["穿透持仓", "共同因子/相关性", "总/净名义", "保证金/现金/退出天数"],
    [
      "绘制国家、行业、利率、汇率和波动率共同风险，而不是只数策略名称",
      "在压力情景中上调相关性并检查边际风险",
      "把集中度、融资余量和退出天数设成越限条件",
    ],
    "新增策略只有在边际风险、现金和流动性预算都合适时才进入候选。",
    ["共同因子集中", "被迫去杠杆", "融资余量缩小", "借券撤回", "退出天数越限"],
    ["穿透重复持仓", "压力相关性", "总/净暴露", "融资/保证金", "退出计划"],
  ),
});

const direction = (
  id: `D${string}`,
  name: string,
  modules: readonly StrategyMethodId[],
  hypothesis: string,
  minimumValidation: string,
): StrategyDirectionDefinition =>
  Object.freeze({ id, name, modules: Object.freeze([...modules]), hypothesis, minimumValidation });

export const FINANCE_STRATEGY_DIRECTIONS: readonly StrategyDirectionDefinition[] = Object.freeze([
  direction(
    "D01",
    "全球多资产趋势",
    ["M02"],
    "跨资产趋势在扣除换手和滑点后改善风险收益。",
    "6/9/12/18月窗、三档成本、五个非重叠时期",
  ),
  direction(
    "D02",
    "美股大盘趋势与现金切换",
    ["M02"],
    "SPY/QQQ趋势过滤能降低回撤且不牺牲过多净收益。",
    "与买入持有同成本比较",
  ),
  direction(
    "D03",
    "港股/中国指数趋势",
    ["M02"],
    "区域趋势与全球趋势的相关性和失效期不同。",
    "沪深/恒生/恒科点时价格、汇率和交易日处理",
  ),
  direction(
    "D04",
    "利率曲线与期限表达",
    ["M03"],
    "增长/通胀变化在曲线不同期限上的表达存在相对价值。",
    "首发宏观数据、预期历史、久期和滚动成本",
  ),
  direction(
    "D05",
    "外汇宏观相对价值",
    ["M03"],
    "利差、实际利率和风险偏好形成可检验的货币相对价值。",
    "FX点时价格、利差、融资和跳空成本",
  ),
  direction(
    "D06",
    "商品与通胀保护",
    ["M02", "M03"],
    "商品趋势或通胀敏感资产提供非股票风险来源。",
    "展期、流动性、相关性跃迁和通胀数据时点",
  ),
  direction(
    "D07",
    "美股质量/价值股票多空",
    ["M05"],
    "盈利质量、现金流和估值差异在行业中性后仍有增量。",
    "财报发布日期、退市处理、行业中性、借券与换手",
  ),
  direction(
    "D08",
    "AI/半导体产业链",
    ["M05", "M12"],
    "需求、资本开支、库存和订单比主题标签更能解释重估。",
    "供应链证据、客户集中、估值敏感性和共同暴露",
  ),
  direction(
    "D09",
    "港股/中国互联网与科技",
    ["M05"],
    "基本面、治理和政策催化剂产生区域相对收益。",
    "公告时点、停牌、互联互通、汇率和流动性",
  ),
  direction(
    "D10",
    "亚洲质量价值与股息",
    ["M05"],
    "低负债、现金流和安全边际抵御估值压缩。",
    "最坏情景估值、股息变化、流动性和价值陷阱",
  ),
  direction(
    "D11",
    "欧洲/英国股票与行业相对强弱",
    ["M05"],
    "区域盈利修订和行业分化形成相对价值。",
    "本币/美元基线、行业暴露和税费",
  ),
  direction(
    "D12",
    "横截面动量",
    ["M05"],
    "相对强弱排序有稳定增量。",
    "去极值、行业/国家中性、成本和拥挤压力",
  ),
  direction(
    "D13",
    "短期事件后反向",
    ["M06"],
    "流动性冲击后部分价格偏离会均值回归。",
    "盘中点时数据、成交容量、借券和隔夜跳空",
  ),
  direction(
    "D14",
    "高波动股票短期反转",
    ["M06"],
    "极端波动后的反向信号可覆盖冲击成本。",
    "真实盘口、限价成交、最大损失和停牌规则",
  ),
  direction(
    "D15",
    "封闭式基金折价催化剂",
    ["M07"],
    "回购、清算、重组或管理协议变化促使折价收敛。",
    "正式公告、NAV路径、等待成本和退出流动性",
  ),
  direction(
    "D16",
    "ETF折溢价与跟踪误差",
    ["M07", "M09"],
    "一级/二级市场机制和跟踪误差形成可解释偏离。",
    "申赎机制、公告时点、费用和冲击成本",
  ),
  direction(
    "D17",
    "信用利差与违约筛选",
    ["M08"],
    "利差补偿只有在违约损失和流动性折价后仍足够。",
    "发行人条款、回收率、久期、融资和借券",
  ),
  direction(
    "D18",
    "可转债资本结构",
    ["M08"],
    "债券、股票和期权特征的错配可提供相对价值。",
    "条款、转股、波动率、对手方和容量",
  ),
  direction(
    "D19",
    "指数调入调出事件",
    ["M09"],
    "公告至生效的资金流和被动需求产生短期价格效应。",
    "原始公告、公告后入场、流量和容量数据",
  ),
  direction(
    "D20",
    "公司行动与特殊事件",
    ["M09"],
    "分红、分拆、回购或重组的机械流程可产生事件窗口。",
    "公告/生效/撤回时间、税费和失败概率",
  ),
  direction(
    "D21",
    "组合尾部保护",
    ["M10"],
    "预先购买保护降低组合极端损失，代价是长期保费拖累。",
    "真实期权链、滚动规则、保费预算和保护效果",
  ),
  direction(
    "D22",
    "波动率期限结构",
    ["M11"],
    "隐含与实现波动率、期限结构和偏度存在可交易差异。",
    "完整曲面、希腊值、动态对冲和跳空",
  ),
  direction(
    "D23",
    "AI模型信号集成",
    ["M01", "M05"],
    "多个低相关模型的集成优于单模型，但需防止共同数据偏差。",
    "OOS、去相关、漂移、基线增量和模型版本",
  ),
  direction(
    "D24",
    "文本/新闻/社交情绪",
    ["M01", "M05"],
    "原始文本的时点和情绪变化可作为候选信号。",
    "原文时间、去重、公告优先级、滞后和成本",
  ),
  direction(
    "D25",
    "机构信号贡献者评分",
    ["M01", "M05"],
    "按来源、方向、期限和市场状态校准信号质量。",
    "贡献者历史、反事实基线、相关性和执行摩擦",
  ),
  direction(
    "D26",
    "AI主题共同暴露",
    ["M12"],
    "不同基金、ETF和股票可能重复承担同一AI/科技风险。",
    "穿透持仓、因子映射、压力相关性和退出天数",
  ),
  direction(
    "D27",
    "多策略风险预算",
    ["M12"],
    "按策略和流动性分配风险比按名称分散更可靠。",
    "净/总暴露、融资、保证金、相关性和再平衡成本",
  ),
  direction(
    "D28",
    "融资拥挤与流动性压力",
    ["M12"],
    "回购、借券和保证金收紧会放大相关性和被迫平仓。",
    "融资利率、借券可得性、冲击成本和压力情景",
  ),
]);

export const FINANCE_STRATEGY_METHOD_CATALOG = Object.freeze({
  schemaVersion: FINANCE_STRATEGY_METHOD_CATALOG_SCHEMA_VERSION,
  methods: FINANCE_STRATEGY_METHODS,
  operationalContracts: FINANCE_STRATEGY_METHOD_CONTRACTS,
  directions: FINANCE_STRATEGY_DIRECTIONS,
  sourceSkill: "skills/trader-strategy-lab/",
});

export function buildFinanceStrategyCatalogPrompt(): string {
  const methods = FINANCE_STRATEGY_METHODS.map((item) => {
    const contract = FINANCE_STRATEGY_METHOD_CONTRACTS[item.id];
    return `${item.id} ${item.name}: ${item.hypothesis} Mechanism=${contract.mechanism} Inputs=${contract.inputs.join("; ")} Workflow=${contract.workflow.join("; ")} Trigger=${contract.trigger} Invalidation=${contract.invalidation.join("; ")} MinimumEvidence=${contract.minimumEvidence.join("; ")} Checks=${item.requiredChecks.join("; ")} Failure=${item.failureModes.join("; ")} Boundary=${item.personalBoundary}`;
  });
  const directions = FINANCE_STRATEGY_DIRECTIONS.map(
    (item) =>
      `${item.id} ${item.name} [${item.modules.join(",")}]: ${item.hypothesis} Minimum=${item.minimumValidation}`,
  );
  return [
    "Full trader-strategy-lab method catalog (all 12 methods and all 28 directions) is available for retrieval and cross-checking.",
    "Methods:",
    ...methods.map((item) => `- ${item}`),
    "Directions:",
    ...directions.map((item) => `- ${item}`),
    "Select only the methods relevant to the task for the visible answer, but do not lose the full catalog or its boundaries.",
  ].join("\n");
}
