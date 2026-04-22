#!/usr/bin/env python3
from __future__ import annotations

import json
from typing import Any


def parse_json_output(text: str) -> dict[str, Any] | None:
    raw = (text or "").strip()
    if not raw:
        return None
    try:
        payload = json.loads(raw)
    except Exception:
        return None
    return payload if isinstance(payload, dict) else None


def classify_report_delivery(result: dict[str, Any]) -> dict[str, Any]:
    code = int(result.get("code", 1) or 0)
    stdout = str(result.get("stdout") or "")
    stderr = str(result.get("stderr") or "")

    if code != 0:
        return {
            "status": "failed",
            "delivered": False,
            "deliveryStatus": "failed",
            "reason": (stderr or stdout or f"sender exited {code}")[:500],
        }

    payload = parse_json_output(stdout)
    if payload is None:
        return {
            "status": "malformed",
            "delivered": False,
            "deliveryStatus": "malformed",
            "reason": "sender returned non-JSON output",
        }

    delivery_status = str(payload.get("deliveryStatus") or "").strip().lower()
    delivered = payload.get("delivered")
    muted = bool(payload.get("muted"))

    if delivered is True or delivery_status in {"success", "sent", "delivered"}:
        return {
            "status": "delivered",
            "delivered": True,
            "deliveryStatus": delivery_status or "delivered",
            "payload": payload,
        }

    if muted or delivery_status in {"muted", "skipped", "not-delivered", "not_delivered", "noop", "no-op"}:
        return {
            "status": "skipped",
            "delivered": False,
            "deliveryStatus": delivery_status or "muted",
            "payload": payload,
            "reason": str(payload.get("message") or payload.get("reason") or "delivery muted"),
        }

    return {
        "status": "malformed",
        "delivered": False,
        "deliveryStatus": delivery_status or "malformed",
        "payload": payload,
        "reason": "sender did not declare an explicit delivery outcome",
    }
