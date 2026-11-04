#!/usr/bin/env python3
"""Does a diff add printer/slicer/firmware/Blender/Fusion knowledge to app code? (PRD §8.0)

David, 2026-11-04: "agents are CONSTANTLY blurring the boundary and adding backend stuff that should be in
mcp to the app itself". The rule: code that would have to change when a printer, slicer, firmware, filament
system, Blender or Fusion changes belongs in the MCPs.

  python3 scripts/boundary_check.py [--base origin/main] [--head HEAD]

Sends each added hunk of app code (not tests, docs or the MCP repos) to the configured Jev checker
(TypeSafe System One, one Noul per chunk) and exits 1 if any chunk probably adds backend knowledge.
This is a semantic signal for review, not proof: a flagged PR moves the code to the MCPs, or merges with
`branch_check.py --merge <branch> --boundary-reviewed "<why it belongs in the app>"`, which is printed
into the gate output. If the checker can't be reached the check fails closed and says so.
Reads TYPESAFE_API_KEY from the environment or ~/.config/jev/env.
"""
import argparse
import json
import os
from pathlib import Path
import subprocess
import sys
import urllib.error
import urllib.request

ENDPOINT = os.environ.get('STM_JEV_ENDPOINT', 'https://api.typesafe.ai/v1/systemone')
MODEL = 'jev-latest'
THRESHOLD = 0.5
CHUNK_CHARS = 6000
MAX_CHUNKS = 60

# App code: everything Counterpart ships, minus tests and fixtures. The MCPs are other repositories.
APP_ROOTS = ('services/', 'apps/', 'packages/', 'android/app/src/main/', 'tools/linux-host/')
CODE_SUFFIXES = ('.ts', '.tsx', '.mjs', '.js', '.swift', '.kt', '.rs', '.py', '.sh')
NOT_APP = ('/tests/', '/test/', 'Tests/', '/fixtures/', '/node_modules/', '/dist/', 'Fixtures.swift', 'DesignFixtures.swift')

RULE = ("Counterpart is a front end stapled onto printer MCP servers (bambu-printer-mcp and mcp-3D-printer-server), which change "
        "almost daily for new printers, slicers, firmware and Blender/Fusion. Code that would have to change when a printer, slicer, "
        "firmware, filament system, Blender or Fusion changes belongs in those MCPs, never in the app. The app calls MCP tools, "
        "renders their structured results, and passes the person's choices through.")
QUESTION = {
    'type': 'noul',
    'instructions': ("Does `added_code` (lines added to the app file `file`) put printer, slicer, firmware, filament-system, "
                     "Blender or Fusion knowledge into the app, so that it would need editing when one of those changes, as `rule` forbids?"),
    'criteria': {
        'true': ("It adds such knowledge: branching on the MCP package or slicer name; tables of printer models, serial prefixes, "
                 "nozzles or materials; matching printer or MCP error codes, HMS codes or error wording; slicer setting keys, presets "
                 "or numeric print settings (layer heights, wall counts, infill); which slicers accept which options; parsing slicer "
                 "or 3MF/G-code metadata; colour-to-spool matching; printer discovery protocols; Blender or Fusion add-on internals; "
                 "or a fallback for MCPs that lack a tool."),
        'false': ("It adds none: UI, wording, pairing, auth, notifications, storage, sync, scan capture or cleanup, tests, or "
                  "orchestration that only calls an MCP tool by name, passes the person's choice through unchanged, renders the "
                  "tool's structured result, or tells the person to update the MCP when a capability is missing."),
    },
}


def git(*args):
    return subprocess.run(['git', *args], check=True, capture_output=True, text=True).stdout


def app_file(path):
    return path.startswith(APP_ROOTS) and path.endswith(CODE_SUFFIXES) and not any(part in path for part in NOT_APP)


def added_chunks(base, head):
    """(file, added text) pieces of at most CHUNK_CHARS, for app files only."""
    chunks = []
    for path in git('diff', '--name-only', '--diff-filter=AM', f'{base}...{head}').split():
        if not app_file(path):
            continue
        added = [line[1:] for line in git('diff', '-U0', f'{base}...{head}', '--', path).splitlines()
                 if line.startswith('+') and not line.startswith('+++')]
        text, piece = '\n'.join(added).strip(), ''
        for line in text.splitlines(keepends=True):
            if piece and len(piece) + len(line) > CHUNK_CHARS:
                chunks.append((path, piece)); piece = ''
            piece += line[:CHUNK_CHARS]
        if piece.strip():
            chunks.append((path, piece))
    return chunks


def api_key():
    if os.environ.get('TYPESAFE_API_KEY'):
        return os.environ['TYPESAFE_API_KEY']
    env = Path.home() / '.config/jev/env'
    if env.exists():
        for line in env.read_text().splitlines():
            if line.startswith('TYPESAFE_API_KEY='):
                return line.split('=', 1)[1].strip()
    return None


def ask(path, text, key, post=None):
    """Probability that this chunk adds backend knowledge."""
    body = {'model': MODEL, 'state': {'rule': RULE, 'file': path, 'added_code': text}, 'questions': {'backend_knowledge': QUESTION}}
    if post:
        return post(body)
    request = urllib.request.Request(ENDPOINT, data=json.dumps(body).encode(), method='POST',
                                     headers={'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json'})
    with urllib.request.urlopen(request, timeout=60) as response:
        return float(json.load(response)['answers']['backend_knowledge']['noul'])


def check(base, head, post=None, out=print):
    """0 when nothing is flagged, 1 when something is (or it couldn't be checked)."""
    chunks = added_chunks(base, head)
    if not chunks:
        out('boundary: no app code added; nothing to check.')
        return 0
    key = api_key()
    if not key and not post:
        out('boundary: NOT CHECKED: no TYPESAFE_API_KEY (environment or ~/.config/jev/env).')
        return 1
    flagged, failed = [], []
    for path, text in chunks[:MAX_CHUNKS]:
        try:
            p = ask(path, text, key, post)
        except urllib.error.HTTPError as error:
            try: detail = json.load(error).get('detail', {})
            except (ValueError, OSError): detail = {}
            message = detail.get('message') if isinstance(detail, dict) else detail
            failed.append(f'{path}: the Jev checker answered HTTP {error.code}' + (f': {message}' if message else ''))
            if error.code in (401, 402, 403):
                break  # the same answer for every chunk
            continue
        except (urllib.error.URLError, OSError, KeyError, ValueError) as error:
            failed.append(f'{path}: {error}')
            continue
        if p >= THRESHOLD:
            first = next((line.strip() for line in text.splitlines() if line.strip()), '')[:100]
            flagged.append(f'{path} (p={p:.2f}): {first}')
    if len(chunks) > MAX_CHUNKS:
        failed.append(f'{len(chunks) - MAX_CHUNKS} more chunks not checked (the limit is {MAX_CHUNKS}); split the PR')
    for line in flagged:
        out('boundary: probably printer/slicer/firmware/Blender/Fusion knowledge in app code: ' + line)
    for line in failed:
        out('boundary: NOT CHECKED: ' + line)
    if not flagged and not failed:
        out(f'boundary: {len(chunks)} added app-code chunks checked; none adds backend knowledge.')
    return 1 if flagged or failed else 0


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--base', default='origin/main')
    ap.add_argument('--head', default='HEAD')
    a = ap.parse_args()
    return check(a.base, a.head)


if __name__ == '__main__':
    sys.exit(main())
