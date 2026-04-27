#!/usr/bin/env python3
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

SCHEDULE_STALE_AFTER_HOURS = {
    "daily": 36.0,
    "weekly_or_manual": 192.0,
}


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def parse_iso(value: str) -> datetime | None:
    raw = (value or "").strip()
    if not raw:
        return None
    try:
        if raw.endswith("Z"):
            raw = raw[:-1] + "+00:00"
        parsed = datetime.fromisoformat(raw)
        if parsed.tzinfo is None:
            return parsed.replace(tzinfo=timezone.utc)
        return parsed.astimezone(timezone.utc)
    except Exception:
        return None


def stale_after_hours(schedule_type: str) -> float:
    return float(SCHEDULE_STALE_AFTER_HOURS.get(schedule_type or "", 48.0))


def branch_state_row(branch_state: dict[str, Any], branch_name: str) -> dict[str, Any]:
    nested = ((branch_state.get("branches", {}) or {}).get(branch_name, {}) or {})
    direct = branch_state.get(branch_name, {}) or {}
    merged = dict(direct)
    merged.update(nested)
    return merged


def build_branch_freshness_snapshot(
    branch_state: dict[str, Any],
    scheduler_state: dict[str, Any],
    now: datetime | None = None,
) -> dict[str, dict[str, Any]]:
    current = now or utc_now()
    branches = (scheduler_state.get("branches", {}) or {})
    snapshot: dict[str, dict[str, Any]] = {}

    for branch_name, meta in branches.items():
        row = branch_state_row(branch_state, branch_name)
        enabled = bool(meta.get("enabled", False))
        schedule_type = str(meta.get("schedule_type") or "")
        last_run_at = str(row.get("last_run_at") or "")
        parsed = parse_iso(last_run_at)
        threshold = stale_after_hours(schedule_type)

        status = "disabled"
        lag_hours: float | None = None
        if enabled:
            if not last_run_at:
                status = "never_run"
            elif parsed is None:
                status = "invalid_timestamp"
            else:
                lag_hours = max((current - parsed).total_seconds() / 3600.0, 0.0)
                status = "stale" if lag_hours > threshold else "fresh"

        snapshot[branch_name] = {
            "enabled": enabled,
            "schedule_type": schedule_type,
            "cron_hint": str(meta.get("cron_hint") or ""),
            "last_run_at": last_run_at,
            "stale_after_hours": threshold,
            "lag_hours": lag_hours,
            "status": status,
        }

    return snapshot


def summarize_freshness(row: dict[str, Any]) -> str:
    status = str(row.get("status") or "unknown")
    lag_hours = row.get("lag_hours")
    if lag_hours is None:
        return status
    return f"{status} ({lag_hours:.1f}h)"


def stale_branch_names(snapshot: dict[str, dict[str, Any]]) -> list[str]:
    return sorted(
        branch_name
        for branch_name, row in snapshot.items()
        if str(row.get("status") or "") == "stale"
    )
