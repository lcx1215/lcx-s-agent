#!/usr/bin/env python3
from __future__ import annotations

import importlib.util
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def load_module(path: Path):
    spec = importlib.util.spec_from_file_location("nlu_feedback_memory_test_mod", path)
    module = importlib.util.module_from_spec(spec)
    assert spec is not None and spec.loader is not None
    spec.loader.exec_module(module)
    return module


def run_router(text: str, event_path: Path) -> dict:
    env = dict(os.environ)
    env["LOBSTER_NLU_FEEDBACK_EVENTS_PATH"] = str(event_path)
    res = subprocess.run(
        [sys.executable, str(ROOT / "scripts" / "run_nlu_action_router.py"), text],
        cwd=str(ROOT),
        env=env,
        capture_output=True,
        text=True,
        check=False,
    )
    if res.returncode != 0:
        raise RuntimeError(f"router failed\nstdout:\n{res.stdout}\nstderr:\n{res.stderr}")
    return json.loads((res.stdout or "").strip())


def main() -> int:
    module = load_module(ROOT / "scripts" / "nlu_feedback_memory.py")

    with tempfile.TemporaryDirectory() as td:
        event_path = Path(td) / "feedback_events.jsonl"
        os.environ["LOBSTER_NLU_FEEDBACK_EVENTS_PATH"] = str(event_path)
        receipt = module.safe_append_feedback_event(
            raw_text="顺便学习宏观利率框架",
            source="test",
            reply_text="已识别：宏观与市场结构。",
            feedback={
                "status": "success",
                "understood": [{"action": "learn_topic", "topic": "宏观与市场结构", "family": "macro_regime"}],
                "queued": [{"topic": "宏观与市场结构"}],
                "completed": [],
                "artifacts": [],
                "learning_quality": {},
            },
            parser={"intent": "learn_topic", "tasks": [{"action": "learn_topic", "topic": "宏观与市场结构", "family": "macro_regime"}]},
            executed=[],
            action="learn_topic",
        )
        assert receipt["ok"] is True, receipt
        row = json.loads(event_path.read_text(encoding="utf-8").strip())
        sample = row["distillation_sample"]
        assert sample["utterance"] == "顺便学习宏观利率框架", sample
        assert sample["action"] == "learn_topic", sample
        assert sample["family"] == "macro_regime", sample
        assert sample["topic"] == "宏观与市场结构", sample
        assert sample["queued"] is True, sample
        assert sample["executed"] is False, sample

    with tempfile.TemporaryDirectory() as td:
        event_path = Path(td) / "router_events.jsonl"
        routed = run_router("顺便学习宏观利率框架", event_path)
        assert routed["feedback_memory"]["ok"] is True, routed
        assert routed["feedback_memory"]["sample"]["topic"] == "宏观与市场结构", routed
        rows = [json.loads(line) for line in event_path.read_text(encoding="utf-8").splitlines() if line.strip()]
        assert len(rows) == 1, rows
        assert rows[0]["source"] == "run_nlu_action_router", rows
        assert rows[0]["distillation_sample"]["utterance"] == "顺便学习宏观利率框架", rows
        assert rows[0]["distillation_sample"]["queued"] is True, rows

        summary = module.summarize_feedback_events(rows)
        assert summary["sample_count"] == 1, summary
        assert summary["family_count"] == 1, summary
        assert summary["families"]["macro_regime"]["count"] == 1, summary
        assert summary["families"]["macro_regime"]["queued"] == 1, summary
        assert summary["families"]["macro_regime"]["example_utterances"] == ["顺便学习宏观利率框架"], summary

        cli = subprocess.run(
            [sys.executable, str(ROOT / "scripts" / "nlu_feedback_memory.py"), "summary", str(event_path)],
            cwd=str(ROOT),
            capture_output=True,
            text=True,
            check=False,
        )
        assert cli.returncode == 0, cli.stderr
        cli_summary = json.loads((cli.stdout or "").strip())
        assert cli_summary["families"]["macro_regime"]["score"] > 0, cli_summary

    with tempfile.TemporaryDirectory() as td:
        event_path = Path(td) / "mixed_events.jsonl"
        rows = [
            {
                "raw_text": "现在先学最新的好的金融策略论文里的值得你记住的",
                "reply_text": "已识别：前沿金融论文。",
                "feedback": {
                    "status": "success",
                    "understood": [{"action": "learn_topic", "topic": "前沿金融论文", "family": "frontier_paper"}],
                    "queued": [{"topic": "前沿金融论文"}],
                    "completed": [{"action": "run_next", "status": "success"}],
                    "artifacts": [{"report_path": "knowledge/learn/a.md", "sources_path": "knowledge/learn/a.sources.json"}],
                    "learning_quality": {"status": "usable"},
                },
            },
            {
                "raw_text": "现在先学最新的好的金融策略论文里的值得你记住的",
                "reply_text": "重复样本",
                "feedback": {
                    "status": "success",
                    "understood": [{"action": "learn_topic", "topic": "前沿金融论文", "family": "frontier_paper"}],
                    "queued": [{"topic": "前沿金融论文"}],
                    "completed": [{"action": "run_next", "status": "success"}],
                    "artifacts": [{"report_path": "knowledge/learn/a.md", "sources_path": "knowledge/learn/a.sources.json"}],
                    "learning_quality": {"status": "usable"},
                },
            },
            {
                "raw_text": "补一下期权 greek 和对冲基本功",
                "reply_text": "已识别：期权能力。",
                "feedback": {
                    "status": "success",
                    "understood": [{"action": "learn_topic", "topic": "期权能力", "family": "options"}],
                    "queued": [{"topic": "期权能力"}],
                    "completed": [],
                    "artifacts": [],
                    "learning_quality": {},
                },
            },
        ]
        with event_path.open("w", encoding="utf-8") as fp:
            for row in rows:
                row["distillation_sample"] = module.build_distillation_sample(row)
                fp.write(json.dumps(row, ensure_ascii=False) + "\n")

        summary = module.summarize_feedback_events(module.read_feedback_events(event_path))
        assert summary["event_count"] == 3, summary
        assert summary["sample_count"] == 2, summary
        assert summary["families"]["frontier_paper"]["executed"] == 1, summary
        assert summary["families"]["frontier_paper"]["artifacts"] == 1, summary
        assert summary["families"]["frontier_paper"]["usable_quality"] == 1, summary
        assert summary["families"]["options"]["executed"] == 0, summary

        plan = module.build_absorption_plan(summary)
        assert plan["schema"] == "lobster.nlu_feedback_absorption_plan.v1", plan
        assert plan["promotion_policy"]["auto_promote"] is False, plan
        assert plan["candidate_count"] == 2, plan
        by_family = {row["family"]: row for row in plan["candidate_families"]}
        assert by_family["options"]["recommended_action"] == "collect_more_real_lark_utterances", by_family
        assert "not_all_executed" in by_family["options"]["reasons"], by_family
        assert by_family["frontier_paper"]["candidate_samples"][0]["expected_topic"] == "前沿金融论文", by_family

        evalset = module.build_routing_evalset(plan)
        assert evalset["schema"] == "lobster.routing_evalset.v1", evalset
        assert evalset["case_count"] == 2, evalset
        first_case = evalset["cases"][0]
        assert first_case["id"] == "feedback-0001", evalset
        assert first_case["source"] == "nlu_feedback_absorption_plan", first_case
        assert first_case["promotion_status"] == "candidate", first_case
        assert {case["expected"]["family"] for case in evalset["cases"]} == {"frontier_paper", "options"}, evalset
        assert any(case["expected"]["topic"] == "前沿金融论文" for case in evalset["cases"]), evalset

        cli = subprocess.run(
            [sys.executable, str(ROOT / "scripts" / "nlu_feedback_memory.py"), "absorb", str(event_path)],
            cwd=str(ROOT),
            capture_output=True,
            text=True,
            check=False,
        )
        assert cli.returncode == 0, cli.stderr
        cli_plan = json.loads((cli.stdout or "").strip())
        assert cli_plan["candidate_count"] == 2, cli_plan
        assert cli_plan["promotion_policy"]["requires_review"] is True, cli_plan

        cli_eval = subprocess.run(
            [sys.executable, str(ROOT / "scripts" / "nlu_feedback_memory.py"), "evalset", str(event_path)],
            cwd=str(ROOT),
            capture_output=True,
            text=True,
            check=False,
        )
        assert cli_eval.returncode == 0, cli_eval.stderr
        cli_evalset = json.loads((cli_eval.stdout or "").strip())
        assert cli_evalset["case_count"] == 2, cli_evalset
        assert cli_evalset["cases"][0]["expected"]["action"] == "learn_topic", cli_evalset

        eval_result = module.evaluate_routing_evalset(evalset)
        assert eval_result["schema"] == "lobster.routing_eval_result.v1", eval_result
        assert eval_result["router"] == "deterministic_parser", eval_result
        assert eval_result["case_count"] == 2, eval_result
        assert eval_result["families"]["frontier_paper"]["action_accuracy"] == 1, eval_result
        assert "topic_accuracy" in eval_result["families"]["options"], eval_result

        semantic_result = module.evaluate_routing_evalset(evalset, router="semantic_candidate")
        assert semantic_result["router"] == "semantic_candidate", semantic_result
        assert semantic_result["case_count"] == 2, semantic_result
        assert semantic_result["families"]["frontier_paper"]["family_accuracy"] == 1, semantic_result
        assert semantic_result["families"]["options"]["topic_accuracy"] == 1, semantic_result

        comparison = module.compare_router_evalset(evalset)
        assert comparison["schema"] == "lobster.routing_router_comparison.v1", comparison
        assert comparison["case_count"] == 2, comparison
        assert "frontier_paper" in comparison["family_deltas"], comparison
        assert comparison["recommendation"] in {"review_semantic_candidate", "keep_deterministic_primary"}, comparison

        override_candidates = module.build_router_override_candidates(comparison)
        assert override_candidates["schema"] == "lobster.routing_override_candidates.v1", override_candidates
        assert override_candidates["auto_apply"] is False, override_candidates
        assert override_candidates["candidate_count"] == 2, override_candidates
        assert override_candidates["eligible_count"] == 0, override_candidates
        assert all(row["review_required"] is True for row in override_candidates["overrides"]), override_candidates

        synthetic_comparison = {
            "deterministic": {"families": {"macro_regime": {"count": 4}}},
            "family_deltas": {
                "macro_regime": {
                    "deterministic_accuracy": 0.5,
                    "semantic_accuracy": 0.75,
                    "delta": 0.25,
                    "deterministic_failures": [{"id": "a"}, {"id": "b"}],
                    "semantic_failures": [{"id": "b"}],
                }
            },
        }
        synthetic_overrides = module.build_router_override_candidates(synthetic_comparison)
        assert synthetic_overrides["eligible_count"] == 1, synthetic_overrides
        assert synthetic_overrides["overrides"][0]["eligible"] is True, synthetic_overrides
        assert "semantic_candidate_passes_family_gate" in synthetic_overrides["overrides"][0]["reasons"], synthetic_overrides

        receipt_path = Path(td) / "override_receipt.json"
        receipt_result = module.write_override_receipt(
            override_candidates,
            source_path=event_path,
            output_path=receipt_path,
        )
        assert receipt_result["ok"] is True, receipt_result
        written_receipt = json.loads(receipt_path.read_text(encoding="utf-8"))
        assert written_receipt["schema"] == "lobster.routing_override_receipt.v1", written_receipt
        assert written_receipt["auto_apply"] is False, written_receipt
        assert written_receipt["decision"] == "record_only", written_receipt
        assert written_receipt["candidate_count"] == 2, written_receipt
        assert written_receipt["policy"]["review_required"] is True, written_receipt

        cli_run_eval = subprocess.run(
            [sys.executable, str(ROOT / "scripts" / "nlu_feedback_memory.py"), "run-eval", str(event_path)],
            cwd=str(ROOT),
            capture_output=True,
            text=True,
            check=False,
        )
        assert cli_run_eval.returncode == 0, cli_run_eval.stderr
        cli_eval_result = json.loads((cli_run_eval.stdout or "").strip())
        assert cli_eval_result["schema"] == "lobster.routing_eval_result.v1", cli_eval_result
        assert cli_eval_result["case_count"] == 2, cli_eval_result

        cli_compare = subprocess.run(
            [sys.executable, str(ROOT / "scripts" / "nlu_feedback_memory.py"), "compare-routers", str(event_path)],
            cwd=str(ROOT),
            capture_output=True,
            text=True,
            check=False,
        )
        assert cli_compare.returncode == 0, cli_compare.stderr
        cli_comparison = json.loads((cli_compare.stdout or "").strip())
        assert cli_comparison["schema"] == "lobster.routing_router_comparison.v1", cli_comparison
        assert cli_comparison["semantic_candidate"]["router"] == "semantic_candidate", cli_comparison

        cli_select = subprocess.run(
            [sys.executable, str(ROOT / "scripts" / "nlu_feedback_memory.py"), "select-overrides", str(event_path)],
            cwd=str(ROOT),
            capture_output=True,
            text=True,
            check=False,
        )
        assert cli_select.returncode == 0, cli_select.stderr
        cli_overrides = json.loads((cli_select.stdout or "").strip())
        assert cli_overrides["schema"] == "lobster.routing_override_candidates.v1", cli_overrides
        assert cli_overrides["auto_apply"] is False, cli_overrides

        cli_receipt_path = Path(td) / "cli_override_receipt.json"
        cli_receipt = subprocess.run(
            [
                sys.executable,
                str(ROOT / "scripts" / "nlu_feedback_memory.py"),
                "write-override-receipt",
                str(event_path),
                str(cli_receipt_path),
            ],
            cwd=str(ROOT),
            capture_output=True,
            text=True,
            check=False,
        )
        assert cli_receipt.returncode == 0, cli_receipt.stderr
        cli_receipt_result = json.loads((cli_receipt.stdout or "").strip())
        assert cli_receipt_result["receipt"]["schema"] == "lobster.routing_override_receipt.v1", cli_receipt_result
        assert cli_receipt_path.exists(), cli_receipt_result

    print("OK nlu_feedback_memory")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
