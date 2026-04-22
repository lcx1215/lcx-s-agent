#!/usr/bin/env python3
import json

print(json.dumps({
    "ok": True,
    "delivered": False,
    "muted": True,
    "deliveryStatus": "muted",
    "message": "old daily learning report sender disabled"
}, ensure_ascii=False, indent=2))
