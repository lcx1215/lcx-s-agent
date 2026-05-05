import json
import os
import subprocess

from inspect_ai import Task, task
from inspect_ai.dataset import Sample
from inspect_ai.scorer import Score, Target, scorer
from inspect_ai.solver import Generate, TaskState, solver


CASES = [
    {
        "id": "cross_market_us_a_index_crypto",
        "input": "未来我会同时看美股、A股、指数和加密币。请训练本地大脑做连贯分析：先动用本地记忆和已学规则，再拆宏观利率、美元/人民币流动性、美股市场结构、A股政策资金面、指数权重和趋势、加密币流动性和风险门；research-only，不要交易建议。",
        "target": {
            "required_modules": [
                "us_equity_market_structure",
                "china_a_share_policy_flow",
                "global_index_regime",
                "crypto_market_structure",
                "portfolio_risk_gates",
            ],
            "required_risk_boundaries": ["no_high_leverage_crypto"],
        },
    },
    {
        "id": "source_missing_learning_gate",
        "input": "去学习这篇金融论文并沉淀成规则，但我还没给链接或本地文件。",
        "target": {
            "required_modules": ["finance_learning_memory", "source_registry"],
            "required_missing_data": ["source_url_or_local_source_path"],
        },
    },
    {
        "id": "quant_math_missing_inputs",
        "input": "我有 QQQ、TLT、NVDA 三个仓位，想算波动、相关性、回撤和利率敏感性，但我还没给权重和价格序列。先拆模块，不要靠模型胡算。",
        "target": {
            "required_modules": ["quant_math", "portfolio_risk_gates"],
            "required_missing_data": ["position_weights_and_return_series"],
        },
    },
    {
        "id": "lark_context_pollution_ops_first",
        "input": "它刚才又像串到旧任务了，先审计是不是 Lark 上下文污染，不要继续金融分析。",
        "target": {
            "required_modules": ["ops_audit"],
            "forbidden_modules": ["macro_rates_inflation", "company_fundamentals_value"],
        },
    },
]


@solver
def local_brain_contract_solver():
    async def solve(state: TaskState, generate: Generate) -> TaskState:
        result = subprocess.run(
            [
                "node",
                "--import",
                "tsx",
                "scripts/dev/local-brain-open-eval-provider.ts",
                str(state.input),
            ],
            cwd=os.getcwd(),
            check=True,
            capture_output=True,
            text=True,
        )
        state.output.completion = result.stdout.strip()
        return state

    return solve


@scorer
def lcx_local_brain_scorer():
    async def score(state: TaskState, target: Target) -> Score:
        try:
            plan = json.loads(state.output.completion)
            expected = json.loads(target.text)
        except Exception as error:
            return Score(value="I", explanation=f"invalid JSON: {error}")

        modules = set(plan.get("primary_modules", []))
        modules.update(plan.get("supporting_modules", []))
        modules.update(plan.get("required_tools", []))
        missing_data = set(plan.get("missing_data", []))
        risk_boundaries = set(plan.get("risk_boundaries", []))
        rejected_context = set(plan.get("rejected_context", []))

        failures = []
        for module in expected.get("required_modules", []):
            if module not in modules:
                failures.append(f"missing module {module}")
        for module in expected.get("forbidden_modules", []):
            if module in modules:
                failures.append(f"forbidden module {module}")
        for entry in expected.get("required_missing_data", []):
            if entry not in missing_data:
                failures.append(f"missing data {entry}")
        for entry in expected.get("required_risk_boundaries", []):
            if entry not in risk_boundaries:
                failures.append(f"missing risk boundary {entry}")
        if not ({"research_only", "no_execution_authority"} & risk_boundaries):
            failures.append("missing research/no-execution boundary")
        if "old_lark_conversation_history" not in rejected_context:
            failures.append("old Lark context not rejected")

        return Score(value="I" if failures else "C", explanation="; ".join(failures) or "passed")

    return score


@task
def local_brain_contracts():
    return Task(
        dataset=[
            Sample(input=case["input"], target=json.dumps(case["target"]), id=case["id"])
            for case in CASES
        ],
        solver=[local_brain_contract_solver()],
        scorer=lcx_local_brain_scorer(),
    )
