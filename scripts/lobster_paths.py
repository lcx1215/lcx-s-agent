#!/usr/bin/env python3
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
TMP_DIR = ROOT / "tmp"
RUNTIME_DIR = TMP_DIR / "runtime"
STATE_DIR = ROOT / "branches" / "_system"
RETRIEVAL_CACHE_DIR = RUNTIME_DIR / "retrieval_cache"
SEARCH_CACHE_DIR = RUNTIME_DIR / "search_cache"
RETRIEVAL_WORK_DIR = RUNTIME_DIR / "retrieval_work"
LLM_RAW_DIR = RUNTIME_DIR / "llm_raw"
CONTROL_PANEL_STATE_NAME = "control_panel_state.json"
CONTROL_PANEL_COMPAT_NAME = "l3_status.json"


def ensure_dir(path: Path) -> Path:
    path.mkdir(parents=True, exist_ok=True)
    return path


def ensure_runtime_dirs() -> None:
    ensure_dir(TMP_DIR)
    ensure_dir(RUNTIME_DIR)
    ensure_dir(STATE_DIR)
    ensure_dir(RETRIEVAL_CACHE_DIR)
    ensure_dir(SEARCH_CACHE_DIR)
    ensure_dir(RETRIEVAL_WORK_DIR)
    ensure_dir(LLM_RAW_DIR)


def state_path(name: str) -> Path:
    ensure_runtime_dirs()
    return STATE_DIR / name


def legacy_state_path(name: str) -> Path:
    return ROOT / name


def load_json(path: Path, default: Any) -> Any:
    if not path.exists():
        return default
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return default


def save_json(path: Path, obj: Any) -> None:
    ensure_dir(path.parent)
    path.write_text(json.dumps(obj, ensure_ascii=False, indent=2), encoding="utf-8")


def load_state_json(name: str, default: Any) -> Any:
    for path in (STATE_DIR / name, legacy_state_path(name)):
        if not path.exists():
            continue
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            continue
    return default


def save_state_json(name: str, obj: Any) -> Path:
    path = state_path(name)
    save_json(path, obj)
    return path


def normalize_control_panel_state(obj: Any) -> dict[str, Any]:
    data = dict(obj or {})
    legacy_current = str(data.get("current_phase") or data.get("current_milestone") or "").strip()
    legacy_next = str(data.get("next_phase") or data.get("next_milestone") or "").strip()
    current_phase = (
        "L4 baseline hardening and shared-brain runtime"
        if not legacy_current or "L3" in legacy_current
        else legacy_current
    )
    next_phase = (
        "Complete branch-wide brain-aware state consumption and remove remaining legacy L3 surfaces"
        if not legacy_next or legacy_next == "L4 branch operations and deeper execution integration"
        else legacy_next
    )
    normalized = dict(data)
    normalized["system_stage"] = data.get("system_stage") or "L4"
    normalized["control_panel_status"] = data.get("control_panel_status") or "l4_brain_hardened"
    normalized["current_phase"] = current_phase
    normalized["next_phase"] = next_phase
    normalized["l3_completed"] = True
    normalized["current_milestone"] = current_phase
    normalized["next_milestone"] = next_phase
    return normalized


def load_control_panel_state(default: Any) -> Any:
    for name in (CONTROL_PANEL_STATE_NAME, CONTROL_PANEL_COMPAT_NAME):
        payload = load_state_json(name, None)
        if payload is not None:
            return normalize_control_panel_state(payload)
    return default


def save_control_panel_state(obj: Any) -> Path:
    normalized = normalize_control_panel_state(obj)
    save_state_json(CONTROL_PANEL_STATE_NAME, normalized)
    save_state_json(CONTROL_PANEL_COMPAT_NAME, normalized)
    return state_path(CONTROL_PANEL_STATE_NAME)
