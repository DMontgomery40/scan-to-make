import json
import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import preflight  # noqa: E402


def status_payload(**overrides):
    payload = {
        "BackendState": "Running",
        "MagicDNSSuffix": "example.ts.net",
        "CurrentTailnet": {"MagicDNSEnabled": True},
        "Self": {
            "DNSName": "studio.example.ts.net.",
            "TailscaleIPs": ["100.64.0.10"],
            "Online": True,
            "UserID": 42,
        },
        "User": {"42": {"LoginName": "maker@example.com"}},
        "Peer": {
            "phone": {"Online": True, "OS": "iOS"},
            "laptop": {"Online": False, "OS": "macOS"},
        },
    }
    payload.update(overrides)
    return payload


class FakeRunner:
    def __init__(self, status=None, serve=None, version="1.80.0", status_returncode=0):
        self.status = status if status is not None else status_payload()
        self.serve = serve if serve is not None else {}
        self.version = version
        self.status_returncode = status_returncode
        self.calls = []
        self.envs = []

    def __call__(self, argv, env):
        self.calls.append(tuple(argv))
        self.envs.append(dict(env))
        if argv[1:] == ("version",):
            return preflight.CommandResult(tuple(argv), 0, self.version + "\n")
        if argv[1:] == ("status", "--json"):
            return preflight.CommandResult(tuple(argv), self.status_returncode, json.dumps(self.status))
        if argv[1:] == ("serve", "status", "--json"):
            return preflight.CommandResult(tuple(argv), 0, json.dumps(self.serve))
        raise AssertionError(f"unexpected command: {argv}")


def health_ok(port):
    return {"ok": True, "protocolVersion": "0.1.0", "detail": "ok"}


class PreflightTests(unittest.TestCase):
    def test_missing_cli_is_not_installed(self):
        with mock.patch.object(preflight, "find_tailscale", return_value=None):
            report = preflight.run_preflight(runner=FakeRunner(), health_probe=health_ok)
        self.assertEqual(report["state"], "not-installed")
        self.assertFalse(report["readyForCompanionIntegration"])
        self.assertTrue(report["readOnly"])

    def test_needs_login(self):
        runner = FakeRunner(status=status_payload(BackendState="NeedsLogin"))
        with mock.patch.object(preflight, "find_tailscale", return_value="/fake/tailscale"):
            report = preflight.run_preflight(runner=runner, health_probe=health_ok)
        self.assertEqual(report["state"], "needs-login")

    def test_ready_when_tailnet_and_companion_are_healthy(self):
        runner = FakeRunner()
        with mock.patch.object(preflight, "find_tailscale", return_value="/fake/tailscale"):
            report = preflight.run_preflight(runner=runner, health_probe=health_ok)
        self.assertEqual(report["state"], "ready-for-companion-integration")
        self.assertTrue(report["readyForCompanionIntegration"])
        self.assertEqual(report["facts"]["selfDnsName"], "studio.example.ts.net")
        self.assertEqual(report["facts"]["selfLogin"], "maker@example.com")
        self.assertEqual(report["facts"]["peers"], {"total": 2, "online": 1, "onlineMobile": 1})
        self.assertTrue(all(env["TAILSCALE_BE_CLI"] == "1" for env in runner.envs))

    def test_companion_down_is_not_ready(self):
        runner = FakeRunner()
        with mock.patch.object(preflight, "find_tailscale", return_value="/fake/tailscale"):
            report = preflight.run_preflight(
                runner=runner,
                health_probe=lambda port: {"ok": False, "detail": "down"},
            )
        self.assertEqual(report["state"], "tailnet-ready")
        self.assertFalse(report["readyForCompanionIntegration"])

    def test_existing_serve_proxy_is_a_warning_not_connectivity(self):
        runner = FakeRunner(serve={"TCP": {"443": {"Proxy": "http://127.0.0.1:9077"}}})
        with mock.patch.object(preflight, "find_tailscale", return_value="/fake/tailscale"):
            report = preflight.run_preflight(runner=runner, health_probe=health_ok)
        self.assertTrue(report["facts"]["serveProxiesCompanion"])
        serve_check = next(c for c in report["checks"] if c["id"] == "serve")
        self.assertEqual(serve_check["status"], "warn")
        self.assertFalse(report["remotePhoneConnectivityImplemented"])

    def test_malformed_status_fails_without_traceback(self):
        class BadRunner(FakeRunner):
            def __call__(self, argv, env):
                if argv[1:] == ("status", "--json"):
                    return preflight.CommandResult(tuple(argv), 0, "not json")
                return super().__call__(argv, env)

        with mock.patch.object(preflight, "find_tailscale", return_value="/fake/tailscale"):
            report = preflight.run_preflight(runner=BadRunner(), health_probe=health_ok)
        self.assertEqual(report["state"], "status-unreadable")

    def test_nonzero_status_exit_fails_closed_even_with_valid_stdout(self):
        runner = FakeRunner(status_returncode=1)
        with mock.patch.object(preflight, "find_tailscale", return_value="/fake/tailscale"):
            report = preflight.run_preflight(runner=runner, health_probe=health_ok)
        self.assertEqual(report["state"], "status-unreadable")
        self.assertFalse(report["readyForCompanionIntegration"])

    def test_only_read_only_tailscale_commands_are_allowlisted(self):
        forbidden = {"up", "down", "login", "logout", "funnel", "set", "file", "ssh"}
        used = {argv[0] for argv in preflight.ALLOWED_COMMANDS}
        self.assertFalse(used & forbidden)
        self.assertEqual(
            preflight.ALLOWED_COMMANDS,
            (("version",), ("status", "--json"), ("serve", "status", "--json")),
        )

    def test_runner_never_receives_mutation_commands(self):
        runner = FakeRunner()
        with mock.patch.object(preflight, "find_tailscale", return_value="/fake/tailscale"):
            preflight.run_preflight(runner=runner, health_probe=health_ok)
        tails = [call[1:] for call in runner.calls]
        self.assertEqual(tails, list(preflight.ALLOWED_COMMANDS))


if __name__ == "__main__":
    unittest.main()
