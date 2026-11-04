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
Reads TYPESAFE_API_KEY and OPENROUTER_API_KEY from the environment, ~/.config/jev/env or ~/.env.
"""
import argparse
import json
import os
import re
from pathlib import Path
import subprocess
import sys
import urllib.error
import urllib.request

# The same provider chain as David's configured Jev runner (harness-watch lib/jev-provider.mjs): TypeSafe
# first, then Jev through OpenRouter when TypeSafe refuses the key or has no credits (401/402/403).
# Models are pinned so a calibration stays meaningful; bump them together.
PROVIDERS = (
    {'name': 'TypeSafe', 'endpoint': 'https://api.typesafe.ai/v1/systemone', 'model': 'jev-1.13.0', 'key': 'TYPESAFE_API_KEY'},
    {'name': 'OpenRouter', 'endpoint': 'https://openrouter.ai/api/v1/systemone', 'model': 'typesafe/jev-1.13', 'key': 'OPENROUTER_API_KEY'},
)
FALLBACK_STATUSES = (401, 402, 403)
# Calibrated 2026-11-04 on 14 real hunks from this repo through Jev 1.13 (OpenRouter), with removed lines in the state:
# eight that break the rule scored 0.33-0.93 (the external-spool slot rule 0.33, colour matching 0.40, 3MF metadata 0.68,
# the rest 0.80+); six that don't scored 0.03-0.13. 0.3 flags all eight. Recalibrate when the pinned models change.
THRESHOLD = 0.3
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
    'instructions': ("Does `added_code` (lines added to the app file `file`) put NEW printer, slicer, firmware, filament-system, "
                     "Blender or Fusion knowledge into the app, so that it would need editing when one of those changes, as `rule` forbids? "
                     "`removed_code` is what the same change deleted from that file: knowledge that was already there and is only "
                     "moved, reworded or reduced is not new."),
    'criteria': {
        'true': ("It adds such knowledge: branching on the MCP package or slicer name; tables of printer models, serial prefixes, "
                 "nozzles or materials; matching printer or MCP error codes, HMS codes or error wording; slicer setting keys, presets "
                 "or numeric print settings (layer heights, wall counts, infill); which slicers accept which options; parsing slicer "
                 "or 3MF/G-code metadata; colour-to-spool matching; printer discovery protocols; Blender or Fusion add-on internals; "
                 "or a fallback for MCPs that lack a tool."),
        'false': ("It adds none: UI, wording, pairing, auth, notifications, storage, sync, scan capture or cleanup, tests, or "
                  "orchestration that only calls an MCP tool by name, passes the person's choice through unchanged (such as "
                  "`quality: 'fine'` or `strength`), renders the tool's structured result, checks whether a tool takes an argument, "
                  "tells the person to update the MCP when a capability is missing, or deletes or shrinks such knowledge."),
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
        diff = git('diff', '-U0', f'{base}...{head}', '--', path).splitlines()
        added = [line[1:] for line in diff if line.startswith('+') and not line.startswith('+++')]
        removed = '\n'.join(line[1:] for line in diff if line.startswith('-') and not line.startswith('---'))[:CHUNK_CHARS]
        text, piece = '\n'.join(added).strip(), ''
        for line in text.splitlines(keepends=True):
            if piece and len(piece) + len(line) > CHUNK_CHARS:
                chunks.append((path, piece, removed)); piece = ''
            piece += line[:CHUNK_CHARS]
        if piece.strip():
            chunks.append((path, piece, removed))
    return chunks


def read_key(name):
    """A key from the environment or an env file, read as data (never sourced or printed)."""
    if os.environ.get(name):
        return os.environ[name]
    for env in (Path.home() / '.config/jev/env', Path.home() / '.env'):
        try: text = env.read_text()
        except OSError: continue
        match = re.search(r'^\s*(?:export\s+)?' + name + r'\s*=\s*["\']?([^"\'\s]+)', text, re.M)
        if match:
            return match.group(1)
    return None


def providers():
    return [dict(p, secret=read_key(p['key'])) for p in PROVIDERS if read_key(p['key'])]


def api_key():
    """Whether any provider is configured (kept for callers that only need to know)."""
    return bool(providers())


def ask(path, text, key=None, post=None, removed=''):
    """Probability that this chunk adds backend knowledge, from the first provider that answers."""
    state = {'rule': RULE, 'file': path, 'added_code': text, 'removed_code': removed}
    if post:
        return post({'model': PROVIDERS[0]['model'], 'state': state, 'questions': {'backend_knowledge': QUESTION}})
    chain = providers()
    for i, provider in enumerate(chain):
        body = {'model': provider['model'], 'state': state, 'questions': {'backend_knowledge': QUESTION}}
        request = urllib.request.Request(provider['endpoint'], data=json.dumps(body).encode(), method='POST',
                                         headers={'Authorization': 'Bearer ' + provider['secret'], 'Content-Type': 'application/json'})
        try:
            with urllib.request.urlopen(request, timeout=60) as response:
                return float(json.load(response)['answers']['backend_knowledge']['noul'])
        except urllib.error.HTTPError as error:
            if error.code in FALLBACK_STATUSES and i + 1 < len(chain):
                continue
            raise


def check(base, head, post=None, out=print):
    """0 when nothing is flagged, 1 when something is (or it couldn't be checked)."""
    chunks = added_chunks(base, head)
    if not chunks:
        out('boundary: no app code added; nothing to check.')
        return 0
    key = api_key()
    if not key and not post:
        out('boundary: NOT CHECKED: neither TYPESAFE_API_KEY nor OPENROUTER_API_KEY is set (environment, ~/.config/jev/env or ~/.env).')
        return 1
    flagged, failed = [], []
    for path, text, removed in chunks[:MAX_CHUNKS]:
        try:
            p = ask(path, text, key, post, removed)
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
