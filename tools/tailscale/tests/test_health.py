"""Exercise the real loopback probe; only the external Tailscale CLI is replaced."""
import contextlib
import http.server
import json
import socket
import threading
import unittest
from unittest import mock

from test_preflight import FakeRunner
import preflight


@contextlib.contextmanager
def listener(status=200, body=None, headers=None):
    body = body if body is not None else json.dumps({
        "status": "ok", "protocolVersion": "0.1.0"
    }).encode()
    requests = []

    class Handler(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            requests.append(self.path)
            self.send_response(status)
            for name, value in (headers or {}).items():
                self.send_header(name, value)
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *args):
            pass

    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=lambda: server.serve_forever(poll_interval=0.01), daemon=True)
    thread.start()
    try:
        yield server.server_port, requests
    finally:
        server.shutdown()
        server.server_close()
        thread.join()


def report_at(port):
    with mock.patch.object(preflight, "find_tailscale", return_value="/fixture/tailscale"):
        return preflight.run_preflight(companion_port=port, runner=FakeRunner())


class HealthTests(unittest.TestCase):
    def test_denied_listener_is_not_missing_or_verified_companion(self):
        # A real protected companion and an unrelated 403 server cannot be
        # distinguished by an anonymous status code. Neither may become ready.
        for status in (401, 403):
            with self.subTest(status=status), listener(status, b"unrelated service") as (port, _):
                report = report_at(port)
            health = report["facts"]["companionHealth"]
            self.assertEqual(health.get("state"), "authorization-required")
            self.assertEqual(health.get("httpStatus"), status)
            self.assertFalse(health.get("identityVerified", True))
            self.assertFalse(report["readyForCompanionIntegration"])
            check = next(c for c in report["checks"] if c["id"] == "companion-loopback")
            self.assertEqual(check["status"], "warn")
            self.assertNotIn("Start the companion", check["nextStep"])

    def test_local_healthy_response_retains_legacy_readiness(self):
        with listener() as (port, _):
            report = report_at(port)
        self.assertTrue(report["readyForCompanionIntegration"])
        self.assertEqual(report["facts"]["companionHealth"].get("state"), "local-healthy")
        self.assertFalse(report.get("remotePhoneConnectivityVerified", True))

    def test_wrong_protocol_or_payload_is_not_a_healthy_companion(self):
        for body in (b"not json", b'{"status":"ok"}',
                     b'{"status":"ok","protocolVersion":"99"}',
                     b"x" * (preflight.MAX_OUTPUT_BYTES + 1)):
            with self.subTest(body=body[:100]), listener(body=body) as (port, _):
                health = preflight.default_health_probe(port)
            self.assertFalse(health["ok"])
            self.assertEqual(health.get("state"), "invalid-response")

    def test_redirect_does_not_probe_another_endpoint(self):
        with listener() as (target, requests):
            with listener(302, b"", {"Location": f"http://127.0.0.1:{target}/other"}) as (port, _):
                health = preflight.default_health_probe(port)
        self.assertFalse(health["ok"])
        self.assertEqual(health.get("state"), "invalid-response")
        self.assertEqual(requests, [])

    def test_unreachable_listener_is_named_unavailable(self):
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            port = sock.getsockname()[1]
        health = preflight.default_health_probe(port)
        self.assertFalse(health["ok"])
        self.assertEqual(health.get("state"), "unavailable")

    def test_http_server_error_does_not_recommend_starting_another_listener(self):
        with listener(503, b"temporarily unavailable") as (port, _):
            report = report_at(port)
        check = next(c for c in report["checks"] if c["id"] == "companion-loopback")
        self.assertEqual(report["facts"]["companionHealth"].get("state"), "invalid-response")
        self.assertNotIn("Start the companion", check["nextStep"])
