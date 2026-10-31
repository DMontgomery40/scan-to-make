#!/usr/bin/env python3
"""Write a launchd user agent and a host-only CLI; no secrets in the plist."""
import argparse
from pathlib import Path
import plistlib
import shlex

LABEL = 'org.scantomake.companion'


def configure(state, app, node, blender, launch_agents, lan=False):
    state, app, launch_agents = map(Path, (state, app, launch_agents))
    state.mkdir(parents=True, exist_ok=True, mode=0o700)
    logs = state / 'logs'
    logs.mkdir(exist_ok=True, mode=0o700)
    env_file = state / 'companion.env'
    if not env_file.exists():
        env_file.write_text('# Host-only printer/model credentials. Node dotenv syntax.\nMCP_TRANSPORT=stdio\n')
        env_file.chmod(0o600)
    # Node --env-file does not override these inherited environment variables.
    # These are installation paths, not credentials.
    environment = {
        'PATH': ':'.join([str(app / '.venv/bin'), str(app / 'printers/bambu/bin'),
                          str(app / 'printers/generic/bin'), str(Path(node).parent),
                          '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin']),
        'BLENDER': blender,
        'SCAN_TO_MAKE_REMOTE_AUTH_DIR': str(state / 'auth'),
        'SCAN_TO_MAKE_CAPTURE_DIR': str(state / 'capture'),
        'SCAN_TO_MAKE_CAPTURE_PYTHON': str(app / '.venv/bin/python3'),
        'SCAN_TO_MAKE_SCAN_REPAIR_TOOL': str(app / 'tools/scan-repair/repair.py'),
        'SCAN_TO_MAKE_SCAN_BLENDER': blender,
    }
    if lan:
        environment['SCAN_TO_MAKE_LAN_TLS_CERT'] = str(state / 'tls/cert.pem')
        environment['SCAN_TO_MAKE_LAN_TLS_KEY'] = str(state / 'tls/key.pem')
    launcher = state / 'companion'
    # The helper runs any host CLI with the SAME env file and executable paths.
    script = '#!/bin/sh\nset -eu\numask 077\n'
    script += ''.join(f'export {key}={shlex.quote(value)}\n' for key, value in environment.items())
    script += f'cd {shlex.quote(str(app))}\n'
    script += f'exec {shlex.quote(node)} --env-file={shlex.quote(str(env_file))} "$@"\n'
    launcher.write_text(script)
    launcher.chmod(0o700)
    launch_agents.mkdir(parents=True, exist_ok=True)
    path = launch_agents / f'{LABEL}.plist'
    with path.open('wb') as handle:
        plistlib.dump({
            'Label': LABEL,
            'ProgramArguments': [str(launcher), str(app / 'services/companion/dist/server-cli.js')],
            'WorkingDirectory': str(app),
            'RunAtLoad': True, 'KeepAlive': True, 'ThrottleInterval': 15,
            'Umask': 0o077,
            'StandardOutPath': str(logs / 'companion.log'),
            'StandardErrorPath': str(logs / 'companion-error.log'),
        }, handle)
    path.chmod(0o600)
    return path


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('state', 'app', 'node', 'blender', 'launch-agents'):
        parser.add_argument('--' + name, required=True)
    parser.add_argument('--lan', action='store_true')
    args = parser.parse_args()
    print(configure(args.state, args.app, args.node, args.blender, args.launch_agents, args.lan))
