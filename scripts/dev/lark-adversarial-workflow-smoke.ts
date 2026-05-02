import {
  buildLarkLanguageHandoffReceiptArtifact,
  renderLarkFinanceBrainOrchestrationNotice,
} from "../../extensions/feishu/src/lark-language-handoff-receipts.ts";
import {
  resolveLarkAgentInstructionHandoff,
  type LarkRoutingFamily,
} from "../../extensions/feishu/src/lark-routing-corpus.ts";
import type { FeishuConfig } from "../../extensions/feishu/src/types.ts";

type CaseExpectation = {
  name: string;
  utterance: string;
  apiFamily: LarkRoutingFamily;
  expectedFamily: LarkRoutingFamily;
  expectedTarget: string;
  expectedBackendTool: string | null;
  expectFinanceOrchestration: boolean;
  expectedPrimaryModules?: readonly string[];
  expectedRequiredTools?: readonly string[];
  expectedNoticeSnippets?: readonly string[];
};

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function buildSmokeConfig(): FeishuConfig {
  return {
    enabled: true,
    connectionMode: "webhook",
    appId: "adversarial-smoke-app",
    appSecret: "adversarial-smoke-secret",
    surfaces: {
      control_room: { chatId: "oc-control" },
      learning_command: { chatId: "oc-learning" },
      technical_daily: { chatId: "oc-technical" },
      fundamental_research: { chatId: "oc-fundamental" },
      knowledge_maintenance: { chatId: "oc-knowledge" },
      ops_audit: { chatId: "oc-ops" },
    },
  } as FeishuConfig;
}

function assertIncludesAll(values: readonly string[], expected: readonly string[], label: string) {
  for (const item of expected) {
    assert(values.includes(item), `${label} missing ${item}`);
  }
}

const CASES: readonly CaseExpectation[] = [
  {
    name: "market-math-index",
    utterance: "用你的数学知识分析下最近一个月的纳斯达克指数",
    apiFamily: "technical_timing",
    expectedFamily: "technical_timing",
    expectedTarget: "technical_daily",
    expectedBackendTool: null,
    expectFinanceOrchestration: true,
    expectedPrimaryModules: ["etf_regime", "quant_math", "causal_map"],
    expectedRequiredTools: ["quant_math", "review_panel"],
    expectedNoticeSnippets: [
      "Finance brain orchestration contract",
      "primaryModules=etf_regime,quant_math,causal_map",
      "do not replace quant_math with model guesses",
    ],
  },
  {
    name: "learn-not-teach",
    utterance:
      "不是教我，是你自己学完一套ETF仓位管理和回撤数学，最后给application_ready或明确失败原因",
    apiFamily: "market_capability_learning_intake",
    expectedFamily: "market_capability_learning_intake",
    expectedTarget: "learning_command",
    expectedBackendTool: "finance_learning_pipeline_orchestrator",
    expectFinanceOrchestration: true,
    expectedPrimaryModules: ["etf_regime", "portfolio_risk_gates", "quant_math", "causal_map"],
    expectedRequiredTools: ["finance_framework_portfolio_risk_gates_producer", "quant_math"],
  },
  {
    name: "github-skill-intake",
    utterance:
      "去github上学习huggingface/ml-intern这个skill，看看哪些能力能装进我们的智能体，列已有雏形和采用决定",
    apiFamily: "learning_external_source",
    expectedFamily: "learning_external_source",
    expectedTarget: "learning_command",
    expectedBackendTool: "github_project_capability_intake",
    expectFinanceOrchestration: false,
  },
  {
    name: "audit-no-relearn",
    utterance:
      "只复盘 lark-live-learning-20260502-2 的结果，不重新学习，必须可见 handoff receipt 和 audit_handoff_ready",
    apiFamily: "knowledge_internalization_audit",
    expectedFamily: "knowledge_internalization_audit",
    expectedTarget: "knowledge_maintenance",
    expectedBackendTool: null,
    expectFinanceOrchestration: false,
  },
  {
    name: "execution-order-research-boundary",
    utterance: "买100股AAPL市价单，收盘前必须成交",
    apiFamily: "trading_execution_order",
    expectedFamily: "trading_execution_order",
    expectedTarget: "control_room",
    expectedBackendTool: null,
    expectFinanceOrchestration: true,
    expectedPrimaryModules: ["company_fundamentals_value", "portfolio_risk_gates", "causal_map"],
    expectedRequiredTools: ["review_panel"],
  },
  {
    name: "source-grounding-complaint",
    utterance: "你刚才纳斯达克那句话哪来的，给我出处，别用泛泛框架糊弄我",
    apiFamily: "ops_source_grounding",
    expectedFamily: "ops_source_grounding",
    expectedTarget: "ops_audit",
    expectedBackendTool: null,
    expectFinanceOrchestration: false,
  },
  {
    name: "external-coverage-honesty",
    utterance: "去Google上学世界顶级大学前沿金融论文，但说明只读了哪些材料，别把抽样说成全网覆盖",
    apiFamily: "external_source_coverage_honesty",
    expectedFamily: "external_source_coverage_honesty",
    expectedTarget: "learning_command",
    expectedBackendTool: null,
    expectFinanceOrchestration: true,
    expectedPrimaryModules: ["causal_map"],
    expectedRequiredTools: ["finance_framework_causal_map_producer", "review_tier"],
  },
];

async function runCase(testCase: CaseExpectation) {
  const handoff = await resolveLarkAgentInstructionHandoff({
    cfg: buildSmokeConfig(),
    chatId: "oc-control",
    utterance: testCase.utterance,
    apiProvider: async () => ({
      family: testCase.apiFamily,
      confidence: 0.91,
      rationale: "adversarial local API stub",
    }),
  });
  const receipt = buildLarkLanguageHandoffReceiptArtifact({
    generatedAt: "2026-05-02T22:00:00.000Z",
    agentId: "main",
    targetSurface: handoff.targetSurface as never,
    effectiveSurface: handoff.targetSurface as never,
    chatId: "oc-control",
    sessionKey: "agent:main:adversarial-smoke",
    messageId: `om_${testCase.name}`,
    userMessage: testCase.utterance,
    handoff,
  });
  const orchestration = receipt.financeBrainOrchestration;
  const financeNotice = renderLarkFinanceBrainOrchestrationNotice(orchestration);

  assert(handoff.family === testCase.expectedFamily, `${testCase.name}: wrong family`);
  assert(handoff.targetSurface === testCase.expectedTarget, `${testCase.name}: wrong target`);
  assert(
    (handoff.backendToolContract?.toolName ?? null) === testCase.expectedBackendTool,
    `${testCase.name}: wrong backend tool`,
  );
  assert(
    Boolean(orchestration) === testCase.expectFinanceOrchestration,
    `${testCase.name}: wrong finance orchestration presence`,
  );
  assert(receipt.noExecutionApproval, `${testCase.name}: missing noExecutionApproval`);
  if (orchestration) {
    assertIncludesAll(
      orchestration.primaryModules,
      testCase.expectedPrimaryModules ?? [],
      `${testCase.name}: primaryModules`,
    );
    assertIncludesAll(
      orchestration.requiredTools,
      testCase.expectedRequiredTools ?? [],
      `${testCase.name}: requiredTools`,
    );
  }
  for (const snippet of testCase.expectedNoticeSnippets ?? []) {
    assert(financeNotice?.includes(snippet), `${testCase.name}: notice missing ${snippet}`);
  }

  return {
    name: testCase.name,
    family: handoff.family,
    targetSurface: handoff.targetSurface ?? null,
    backendTool: handoff.backendToolContract?.toolName ?? null,
    hasFinanceOrchestration: Boolean(orchestration),
    primaryModules: orchestration?.primaryModules ?? [],
    requiredTools: orchestration?.requiredTools ?? [],
    financeNoticeReady: Boolean(financeNotice),
    noExecutionApproval: receipt.noExecutionApproval,
  };
}

const cases = [];
for (const testCase of CASES) {
  cases.push(await runCase(testCase));
}

process.stdout.write(
  `${JSON.stringify(
    {
      ok: true,
      scope: "dev_lark_adversarial_workflow_smoke",
      cases,
      liveTouched: false,
      providerConfigTouched: false,
      protectedMemoryTouched: false,
      executionAuthorityGranted: false,
    },
    null,
    2,
  )}\n`,
);
