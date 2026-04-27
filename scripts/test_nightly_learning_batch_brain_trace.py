#!/usr/bin/env python3
from __future__ import annotations

import importlib.util
import json
import tempfile
from pathlib import Path


def load_module(path: Path):
    spec = importlib.util.spec_from_file_location("nightly_learning_batch_test_mod", path)
    module = importlib.util.module_from_spec(spec)
    assert spec is not None and spec.loader is not None
    spec.loader.exec_module(module)
    return module


def write_json(path: Path, obj: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(obj, ensure_ascii=False, indent=2), encoding="utf-8")


def main() -> int:
    script_path = Path(__file__).resolve().parents[1] / "scripts" / "run_nightly_learning_batch.py"
    module = load_module(script_path)

    with tempfile.TemporaryDirectory() as td:
        root = Path(td)
        module.ROOT = root
        module.STATE_PATH = root / "branches" / "learn" / "night_batch_state.json"
        module.REPORT_DIR = root / "knowledge" / "learn_batch"
        module.REPORT_DIR.mkdir(parents=True, exist_ok=True)

        learn_sources_path = root / "knowledge" / "learn" / "2026-03-27_market_regime__lane_global.sources.json"
        write_json(
            learn_sources_path,
            {
                "generated_at": "2026-03-27T22:34:44Z",
                "brain_trace_summary": {
                    "intents": ["semantic_recall"],
                    "item_brain_types": ["semantic_or_procedural", "episodic"],
                    "query_traces": [
                        {
                            "query": "market regime drivers",
                            "intent": "semantic_recall",
                            "expanded_tokens": ["market", "regime", "drivers"],
                            "item_brain_types": ["semantic_or_procedural", "episodic"],
                        }
                    ],
                },
            },
        )

        module.pick_next_topics = lambda limit: {
            "ok": True,
            "items": [{"topic": "market regime", "lane_key": "global", "status": "queued"}],
        }
        module.mark_running = lambda topic, lane_key="": {"ok": True}
        module.mark_done = lambda topic, report_path, sources_path, lane_key="": {"ok": True}
        module.mark_failed = lambda topic, err, lane_key="": {"ok": True}
        module.run_one = lambda topic, lane_key="": {
            "ok": True,
            "report_path": "knowledge/learn/2026-03-27_market_regime__lane_global.md",
            "sources_path": "knowledge/learn/2026-03-27_market_regime__lane_global.sources.json",
            "bookkeeping_result": {"status": "recorded"},
        }
        module.try_send_feishu_summary = lambda report_path: {"ok": True, "message": "synthetic"}
        module.sys.argv = ["run_nightly_learning_batch.py", "1"]

        rc = module.main()
        assert rc == 0

        state = json.loads(module.STATE_PATH.read_text(encoding="utf-8"))
        night_state = state["night_batch_learn"]
        assert night_state["brain_trace_summary"]["intents"] == ["semantic_recall"], night_state
        assert "semantic_or_procedural" in night_state["brain_trace_summary"]["item_brain_types"], night_state
        assert night_state["learning_quality"]["status"] == "usable", night_state

        batch_source_paths = sorted(module.REPORT_DIR.glob("*_night_batch.sources.json"))
        assert len(batch_source_paths) == 1, batch_source_paths
        batch_sources = json.loads(batch_source_paths[0].read_text(encoding="utf-8"))
        assert batch_sources["brain_trace_summary"]["intents"] == ["semantic_recall"], batch_sources
        assert batch_sources["runs"][0]["brain_trace_summary"]["intents"] == ["semantic_recall"], batch_sources
        assert batch_sources["learning_quality"]["topics_with_brain_trace"] == 1, batch_sources

    print("OK nightly_learning_batch brain trace + quality")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
