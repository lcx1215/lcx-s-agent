import importlib.util
import io
import json
import unittest
from pathlib import Path
from unittest.mock import patch


MODULE_PATH = Path(__file__).with_name("feishu_event_proxy.py")
SPEC = importlib.util.spec_from_file_location("feishu_event_proxy", MODULE_PATH)
assert SPEC and SPEC.loader
feishu_event_proxy = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(feishu_event_proxy)


class CaseInsensitiveHeaders(dict):
    def get(self, key, default=None):  # type: ignore[override]
        lower = key.lower()
        for existing_key, value in self.items():
            if str(existing_key).lower() == lower:
                return value
        return default


class FakeHandler:
    def __init__(self, path: str, headers: CaseInsensitiveHeaders, body: dict) -> None:
        encoded = json.dumps(body, ensure_ascii=False).encode("utf-8")
        self.path = path
        self.headers = headers
        self.rfile = io.BytesIO(encoded)
        self.sent_status = None
        self.sent_body = None

    def _send_json(self, obj, status=200) -> None:
        self.sent_status = status
        self.sent_body = obj

    def _send_bytes(self, data: bytes, status=200, content_type="application/json; charset=utf-8") -> None:
        self.sent_status = status
        self.sent_body = data


class FeishuEventProxyTest(unittest.TestCase):
    def test_filtered_forward_headers_keeps_lark_signature_headers(self) -> None:
        headers = CaseInsensitiveHeaders(
            {
                "Content-Type": "application/json",
                "X-Lark-Request-Timestamp": "1713772800",
                "X-Lark-Request-Nonce": "nonce-123",
                "X-Lark-Signature": "sig-abc",
                "X-Extra": "ignored",
            }
        )

        self.assertEqual(
            feishu_event_proxy.filtered_forward_headers(headers),
            {
                "content-type": "application/json",
                "x-lark-request-timestamp": "1713772800",
                "x-lark-request-nonce": "nonce-123",
                "x-lark-signature": "sig-abc",
            },
        )

    def test_card_action_callback_bypasses_proxy_token_gate_and_forwards(self) -> None:
        body = {
            "schema": "2.0",
            "header": {"event_type": "card.action.trigger"},
            "event": {"open_message_id": "om_test"},
        }
        encoded = json.dumps(body, ensure_ascii=False).encode("utf-8")
        raw_headers = CaseInsensitiveHeaders(
            {
                "Content-Length": str(len(encoded)),
                "Content-Type": "application/json; charset=utf-8",
                "X-Lark-Request-Timestamp": "1713772800",
                "X-Lark-Request-Nonce": "nonce-123",
                "X-Lark-Signature": "sig-abc",
            }
        )
        handler = FakeHandler("/feishu/events", raw_headers, body)

        with patch.object(feishu_event_proxy, "VERIFY_TOKEN", "expected-token"):
            with patch.object(
                feishu_event_proxy,
                "forward_to_origin",
                return_value=(200, b'{"ok":true}'),
            ) as forward_mock:
                feishu_event_proxy.Handler.do_POST(handler)

        self.assertEqual(handler.sent_status, 200)
        self.assertEqual(handler.sent_body, b'{"ok":true}')
        forward_mock.assert_called_once_with(
            encoded,
            {
                "content-type": "application/json; charset=utf-8",
                "x-lark-request-timestamp": "1713772800",
                "x-lark-request-nonce": "nonce-123",
                "x-lark-signature": "sig-abc",
            },
        )


if __name__ == "__main__":
    unittest.main()
