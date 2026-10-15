#!/usr/bin/env python3
"""Read-only Tailscale readiness preflight for Scan to Make.

This tool never installs Tailscale, logs in, changes tailnet policy, or runs
Serve/Funnel. It only locates the CLI, reads version/status/serve status, and
optionally probes the companion's loopback health endpoint.
"""

from __future__ import annotations

import argparse
import json
import os
import platform
import shutil
import subprocess
import sys
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Mapping, Sequence

SCHEMA = "scan-to-make.tailscale-preflight/0.1.0"
DEFAULT_COMPANION_PORT = 9077
MAX_OUTPUT_BYTES = 256 * 1024
MACOS_APP_CLI = "/Applications/Tailscale.app/Contents/MacOS/Tailscale"

# The complete Tailscale argv allowlist. Setup/mutation commands are absent by
# design; tests pin this list.
ALLOWED_COMMANDS: tuple[tuple[str, ...], ...] = (
    ("version",),
    ("status", "--json"),
    ("serve", "status", "--json"),
)


@dataclass
class Check:
    id: str
    status: str  # pass | warn | fail | unknown
    detail: str
    next_step: str | None = None

    def as_dict(self) -> dict[str, Any]:
        out: dict[str, Any] = {
            "id": self.id,
            "status": self.status,
            "detail": self.detail,
        }
        if self.next_step:
            out["nextStep"] = self.next_step
        return out


@dataclass
class CommandResult:
    argv: tuple[str, ...]
    returncode: int
    stdout: str = ""
    stderr: str = ""


Runner = Callable[[Sequence[str], Mapping[str, str]], CommandResult]
HealthProbe = Callable[[int], dict[str, Any]]


def _bounded(text: str) -> str:
    encoded = text.encode("utf-8", errors="replace")
    if len(encoded) <= MAX_OUTPUT_BYTES:
        return text
    return encoded[:MAX_OUTPUT_BYTES].decode("utf-8", errors="replace")


def default_runner(argv: Sequence[str], env: Mapping[str, str]) -> CommandResult:
    try:
        proc = subprocess.run(
            list(argv),
            capture_output=True,
            text=True,
            timeout=8,
            env=dict(env),
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        return CommandResult(tuple(argv), 127, "", str(exc))
    return CommandResult(
        tuple(argv),
        proc.returncode,
        _bounded(proc.stdout or ""),
        _bounded(proc.stderr or ""),
    )


def find_tailscale(explicit: str | None = None) -> str | None:
    if explicit:
        return explicit if Path(explicit).exists() or shutil.which(explicit) else None
    found = shutil.which("tailscale")
    if found:
        return found
    if Path(MACOS_APP_CLI).exists():
        return MACOS_APP_CLI
    return None


def cli_env(base: Mapping[str, str] | None = None) -> dict[str, str]:
    env = dict(os.environ if base is None else base)
    # On macOS the app binary doubles as the CLI; Tailscale documents this
    # variable so scripts do not accidentally launch the GUI app.
    env["TAILSCALE_BE_CLI"] = "1"
    return env


def _parse_json(text: str) -> dict[str, Any] | None:
    try:
        value = json.loads(text)
    except (TypeError, ValueError):
        return None
    return value if isinstance(value, dict) else None


def _self_login(status: Mapping[str, Any]) -> str | None:
    self_node = status.get("Self") or {}
    user_id = self_node.get("UserID") if isinstance(self_node, Mapping) else None
    users = status.get("User") or {}
    if isinstance(users, Mapping) and user_id is not None:
        record = users.get(str(user_id)) or users.get(user_id)
        if isinstance(record, Mapping):
            login = record.get("LoginName")
            if isinstance(login, str) and login:
                return login
    return None


def _peer_summary(status: Mapping[str, Any]) -> dict[str, int]:
    peers = status.get("Peer") or {}
    summary = {"total": 0, "online": 0, "onlineMobile": 0}
    if not isinstance(peers, Mapping):
        return summary
    for peer in peers.values():
        if not isinstance(peer, Mapping):
            continue
        summary["total"] += 1
        if peer.get("Online"):
            summary["online"] += 1
            if str(peer.get("OS", "")).lower() in {"ios", "android"}:
                summary["onlineMobile"] += 1
    return summary


def _contains_target(value: Any, port: int) -> bool:
    needles = (
        f"127.0.0.1:{port}",
        f"localhost:{port}",
        f"[::1]:{port}",
    )
    if isinstance(value, str):
        return any(needle in value for needle in needles)
    if isinstance(value, Mapping):
        return any(_contains_target(v, port) for v in value.values())
    if isinstance(value, Sequence) and not isinstance(value, (bytes, bytearray)):
        return any(_contains_target(v, port) for v in value)
    return False


def default_health_probe(port: int) -> dict[str, Any]:
    url = f"http://127.0.0.1:{port}/healthz"
    request = urllib.request.Request(url, method="GET")
    try:
        with urllib.request.urlopen(request, timeout=2) as response:
            body = response.read(MAX_OUTPUT_BYTES + 1)
    except (OSError, urllib.error.URLError) as exc:
        return {"ok": False, "detail": f"loopback health probe failed: {exc}"}
    if len(body) > MAX_OUTPUT_BYTES:
        return {"ok": False, "detail": "companion health response exceeded bound"}
    payload = _parse_json(body.decode("utf-8", errors="replace"))
    if not payload:
        return {"ok": False, "detail": "companion health response was not JSON"}
    return {
        "ok": payload.get("status") == "ok",
        "protocolVersion": payload.get("protocolVersion"),
        "templates": payload.get("templates"),
        "detail": "companion loopback health returned status ok"
        if payload.get("status") == "ok"
        else "companion health did not return status ok",
    }


def run_preflight(
    *,
    tailscale_bin: str | None = None,
    companion_port: int = DEFAULT_COMPANION_PORT,
    probe_companion: bool = True,
    runner: Runner = default_runner,
    health_probe: HealthProbe = default_health_probe,
    env: Mapping[str, str] | None = None,
) -> dict[str, Any]:
    checks: list[Check] = []
    facts: dict[str, Any] = {
        "platform": platform.system(),
        "companionPort": companion_port,
    }
    binary = find_tailscale(tailscale_bin)
    if not binary:
        checks.append(
            Check(
                "cli",
                "fail",
                "Tailscale CLI was not found on PATH or in the macOS app bundle.",
                "Install Tailscale on this host, then re-run preflight. "
                "See docs/tailscale-setup.md.",
            )
        )
        return _report("not-installed", checks, facts)

    facts["tailscaleBinary"] = binary
    run_env = cli_env(env)

    version = runner((binary, "version"), run_env)
    if version.returncode == 0 and version.stdout.strip():
        facts["tailscaleVersion"] = version.stdout.strip().splitlines()[0][:120]
        checks.append(Check("cli", "pass", f"Tailscale CLI found: {facts['tailscaleVersion']}"))
    else:
        checks.append(
            Check("cli", "unknown", "Tailscale CLI was found but version could not be read.")
        )

    status_result = runner((binary, "status", "--json"), run_env)
    status = _parse_json(status_result.stdout)
    if status is None:
        checks.append(
            Check(
                "tailnet-status",
                "fail",
                "Could not parse `tailscale status --json` output.",
                "Open Tailscale and confirm this host is signed in, then re-run preflight.",
            )
        )
        return _report("status-unreadable", checks, facts)

    backend = status.get("BackendState")
    facts["backendState"] = backend
    if backend != "Running":
        state = "needs-login" if backend in {"NeedsLogin", "NeedsMachineAuth"} else "not-running"
        checks.append(
            Check(
                "tailnet-status",
                "fail",
                f"Tailscale backend state is {backend!r}, not Running.",
                "Sign in to Tailscale on this host and approve the device if "
                "your tailnet requires approval, then re-run preflight.",
            )
        )
        return _report(state, checks, facts)

    self_node = status.get("Self") if isinstance(status.get("Self"), Mapping) else {}
    dns_name = str(self_node.get("DNSName") or "").rstrip(".")
    ips = self_node.get("TailscaleIPs") or []
    tailnet = status.get("CurrentTailnet") if isinstance(status.get("CurrentTailnet"), Mapping) else {}
    facts.update(
        {
            "selfDnsName": dns_name or None,
            "selfTailscaleIps": [str(ip) for ip in ips] if isinstance(ips, Sequence) else [],
            "selfLogin": _self_login(status),
            "magicDnsEnabled": tailnet.get("MagicDNSEnabled"),
            "magicDnsSuffix": status.get("MagicDNSSuffix"),
            "peers": _peer_summary(status),
        }
    )
    if dns_name and self_node.get("Online"):
        checks.append(Check("tailnet-status", "pass", f"Host is online in the tailnet as {dns_name}."))
    else:
        checks.append(
            Check(
                "tailnet-status",
                "warn",
                "Backend is Running, but the host has no online MagicDNS name yet.",
                "Confirm MagicDNS is enabled and the device is approved, then re-run preflight.",
            )
        )

    serve = runner((binary, "serve", "status", "--json"), run_env)
    serve_payload = _parse_json(serve.stdout)
    facts["serveProxiesCompanion"] = bool(
        serve_payload and _contains_target(serve_payload, companion_port)
    )
    if serve.returncode != 0 or serve_payload is None:
        checks.append(
            Check("serve", "unknown", "Tailscale Serve status could not be read as JSON.")
        )
    elif facts["serveProxiesCompanion"]:
        checks.append(
            Check(
                "serve",
                "warn",
                "Serve already proxies to the companion loopback port. The "
                "authenticated remote transport is not implemented yet, so "
                "do not treat this as a supported phone connection.",
                "Leave Serve unchanged until the companion pairing/auth transport lands.",
            )
        )
    else:
        checks.append(
            Check(
                "serve",
                "warn",
                "Serve is not currently proxying to the companion loopback port.",
                "A future, separately confirmed setup step may enable Serve; preflight will not do it.",
            )
        )

    companion_ok = False
    if probe_companion:
        health = health_probe(companion_port)
        companion_ok = bool(health.get("ok"))
        facts["companionHealth"] = {
            key: health.get(key)
            for key in ("ok", "protocolVersion", "templates")
            if key in health
        }
        checks.append(
            Check(
                "companion-loopback",
                "pass" if companion_ok else "fail",
                str(health.get("detail") or "companion health probe completed"),
                None
                if companion_ok
                else "Start the companion loopback generation service, then re-run preflight.",
            )
        )
    else:
        checks.append(Check("companion-loopback", "unknown", "Companion probe skipped by request."))

    tailnet_ready = bool(dns_name and self_node.get("Online"))
    state = "ready-for-companion-integration" if tailnet_ready and companion_ok else "tailnet-ready"
    if not tailnet_ready:
        state = "tailnet-incomplete"
    return _report(state, checks, facts)


def _report(state: str, checks: list[Check], facts: dict[str, Any]) -> dict[str, Any]:
    return {
        "schema": SCHEMA,
        "readOnly": True,
        "state": state,
        "readyForCompanionIntegration": state == "ready-for-companion-integration",
        "remotePhoneConnectivityImplemented": False,
        "facts": facts,
        "checks": [check.as_dict() for check in checks],
        "boundaries": [
            "No install, login, Serve/Funnel, ACL, device, or printer change was made.",
            "A ready result means the host is ready for the separate authenticated companion transport; it does not prove a phone can use the app flow today.",
        ],
    }


def _print_human(report: Mapping[str, Any]) -> None:
    print(f"Tailscale preflight: {report['state']}")
    for check in report["checks"]:
        print(f"[{check['status']}] {check['id']}: {check['detail']}")
        if check.get("nextStep"):
            print(f"  next: {check['nextStep']}")
    print("Read-only: no install, login, Serve/Funnel, policy, device, or printer change was made.")
    print("Remote phone connectivity is not implemented by this preflight.")


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Read-only Tailscale readiness preflight")
    parser.add_argument("--json", action="store_true", help="print the machine-readable report")
    parser.add_argument("--tailscale-bin", help="explicit Tailscale CLI path")
    parser.add_argument(
        "--companion-port",
        type=int,
        default=DEFAULT_COMPANION_PORT,
        help="loopback companion port (default 9077)",
    )
    parser.add_argument(
        "--skip-companion-probe",
        action="store_true",
        help="do not probe the loopback companion health endpoint",
    )
    args = parser.parse_args(argv)
    if not 1 <= args.companion_port <= 65535:
        parser.error("--companion-port must be between 1 and 65535")
    report = run_preflight(
        tailscale_bin=args.tailscale_bin,
        companion_port=args.companion_port,
        probe_companion=not args.skip_companion_probe,
    )
    if args.json:
        print(json.dumps(report, indent=2, sort_keys=True))
    else:
        _print_human(report)
    return 0 if report["readyForCompanionIntegration"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
