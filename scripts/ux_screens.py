#!/usr/bin/env python3
"""Screenshots of every iPhone/iPad screen, on every Apple layout, filled with a copy of real projects.

David, Nov 9: "is there no reviewing thing that actually looks at what was just made and says 'huh... is this
logical and human readable and intuitive and visible and the best ux experience possible?'" This makes the
pictures; a reviewer (or David) reads them. See docs/operations.md, "Looking at the app".

    python3 scripts/ux_screens.py <out folder> [--work <folder>] [--devices iphone,ipad,duo-folded,duo-open]
                                              [--screens <substring>,...] [--prepare-only]

What it does, in order:
1. Copies the projects of this Mac's Counterpart (capture/objects, starters, events) into <work>/data/state by
   APFS clone. Never auth, tls, pairing, companion.env, printer handoff or printer profiles. Absolute paths into
   the real state are rewritten to the copy, and the run refuses to start if any remain. Two states the real
   data may lack are added as copies of real projects (an open question, a pass stopped at a limit).
2. Starts the real companion (services/companion/dist/server-cli.js) on that copy: a free port of its own, empty
   environment, HOME inside the copy, its own auth store, and a printer MCP of /usr/bin/false, so nothing can
   reach a printer. The simulator reaches it through a proxy on the first free simulator test address (http://127.0.0.1
   on 9078 or 9080–9097; CompanionAddress.isFixture), so several prepared runs can wait for the lane at once.
   It pairs once (POST /v1/pair) and hands the record to the app with -CounterpartPairingRecord.
3. Holding the whole lane (scripts/lane.py --exclusive, re-run by the script itself): builds the Debug app, creates its own simulators (iPhone 17 Pro, iPad Pro 13-inch,
   iPhone Duo), drives them with agent-device (launch arguments, taps, scrolls, screenshots), then deletes them.
   Screens that need a printer or a running pass use the app's own fixtures and say so.
4. Writes <out>/index.md: every image with its screen, state, device, and whether the data is real.

It never touches the installed app, its state or companion (port 9077), a physical device or a printer.
The copy holds the person's photos: keep <work> out of Git and move it to Spillover when done.
Android and Linux are not covered yet.
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import re
import shlex
import signal
import hashlib
import shutil
import subprocess
import sys
import tempfile
import time
import uuid
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
REAL = Path.home() / 'Library/Application Support/Scan to Make'
STARTED = time.time()
# One id per run, in every name it shares with other runs (simulators, agent-device sessions).
RUN_ID = f'{os.getpid()}-{uuid.uuid4().hex[:6]}'
sys.path.insert(0, str(REPO / 'scripts'))
import lane  # noqa: E402  (scripts/lane.py: the Mac's build lane)
def agent_device() -> list[str]:
    """The agent-device CLI with its own local daemon (T3's bundled copy, or AGENT_DEVICE). T3's `agent-device` wrapper only
    runs as the command device_open returns, and device_open boots its device outside any lock, so the script drives the
    simulators it creates itself with the CLI directly."""
    if os.environ.get('AGENT_DEVICE'): return shlex.split(os.environ['AGENT_DEVICE'])
    found = sorted(Path.home().glob('.t3/tools/agent-device/*/node_modules/agent-device/bin/agent-device.mjs'))
    if not found: raise SystemExit('agent-device not found: set AGENT_DEVICE to its command')
    return ['node', str(found[-1])]
BUNDLE = 'com.scantomake'
MARK = b'Library/Application Support/Scan to Make'
# Only project data. Everything else under the state root (auth, tls, companion.env, printer-handoff*,
# printers/, live-activity-tokens.json, diagnostics, logs, releases) stays where it is.
COPY = ['capture/objects', 'capture/starters', 'events.ndjson', 'events.meta.json', 'settings.json', 'pass-timings.json']
TEXT = {'.json', '.ndjson', '.jsonl', '.txt', '.log', '.md', '.py', '.csv', '.yaml', '.yml'}
# Projects never copied, nor their events. David, Nov 10, through the lead: leave the unicorn projects out entirely.
EXCLUDE = {'176821af-8d48-4485-b4b4-7718a5ac3305'}
EXCLUDE_WORDS = (b'unicorn', b'Unicorn')
NAMESPACE = uuid.UUID('6f1c1b6e-2d1e-4c3a-9a51-0e7a0b9e1a00')

# The real projects shown, by id prefix: (name in file names, the state it shows).
PROJECTS = [
    ('wall-holder', '30a2a33c', 'ready: a fit, its question answered, 130 scan photos'),
    ('wall-holder-question', 'synth:question', 'question open (copy of wall-holder at its first pass)'),
    ('bike-oil-scan', '0ddbecb5', 'ready: an untitled copy from a scan, 77 photos'),
    ('dad-sign', 'e9b21ab1', 'ready: an untitled copy from a scan, 94 photos'),
    ('guitar-pick', 'a2bfa85a', 'done: printed, marked works'),
    ('caliper-card', '1f1c5515', 'done: a designer 3MF copy, printed'),
    ('pink-box', '874333ab', 'failed: the printer stopped'),
    ('stove-gap-limit', 'synth:limit', 'stopped at a limit (copy of stove-gap-filler, last pass capped)'),
    ('scan-platform-3mf', '7f1a9e33', 'ready: an imported multi-plate 3MF from a starter'),
    ('crochet-potato', 'c302d5db', 'ready: a copy with 24 photos'),
    ('airpods-hanger', '5158831c', 'ready: 8 passes, printed before'),
    ('mic-mount', '7f157a66', 'done: the oldest project format'),
]
DEVICES = {
    # The gate's devices (.github/workflows/mobile.yml): an iPhone 18 Pro, and an iPad Air 11-inch, here in landscape.
    'iphone': ('iPhone 18 Pro', 'com.apple.CoreSimulator.SimDeviceType.iPhone-18-Pro', 'com.apple.CoreSimulator.SimRuntime.iOS-27-2', None),
    'ipad': ('iPad Air 11-inch (M2), landscape', 'com.apple.CoreSimulator.SimDeviceType.iPad-Air-11-inch-M2', 'com.apple.CoreSimulator.SimRuntime.iOS-27-2', 'landscape-left'),
    'duo-folded': ('iPhone Duo, folded', 'com.apple.CoreSimulator.SimDeviceType.iPhone-Duo', 'com.apple.CoreSimulator.SimRuntime.iOS-27-2-iPhone19-4', 'closed'),
    'duo-open': ('iPhone Duo, unfolded', 'com.apple.CoreSimulator.SimDeviceType.iPhone-Duo', 'com.apple.CoreSimulator.SimRuntime.iOS-27-2-iPhone19-4', 'open'),
}


def log(*parts: object) -> None:
    print(f'[{dt.datetime.now():%H:%M:%S}]', *parts, flush=True)


# ---------------------------------------------------------------- the data copy

def resolve_id(objects: Path, prefix: str) -> str:
    found = [p.name for p in objects.iterdir() if p.name.startswith(prefix)]
    if len(found) != 1: raise SystemExit(f'The copy needs exactly one project whose id starts {prefix} in {objects}; found {len(found)}.')
    return found[0]


def clone(src: Path, dst: Path) -> None:
    dst.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(['cp', '-cR' if sys.platform == 'darwin' else '-R', str(src), str(dst)], check=True)


def synth_question(objects: Path, source: str) -> str:
    """The wall holder as it was when its question was open: first pass only, no model yet, no answer."""
    new = str(uuid.uuid5(NAMESPACE, f'question:{source}'))
    clone(objects / source, objects / new)
    path = objects / new / 'object.json'
    o = json.loads(path.read_text())
    o['id'] = new
    o['state'] = 'needs-closeup'
    o['passes'] = o['passes'][:1]
    o['ask'] = {**o['ask'], 'status': 'open'}
    o['messages'] = []
    o['updatedAtMs'] = o['passes'][0].get('endedAtMs', o['updatedAtMs'])
    for key in ('current', 'outcome', 'print', 'plateProgress'): o.pop(key, None)
    path.write_text(json.dumps(o))
    return new


def synth_limit(objects: Path, source: str) -> str:
    """A real project whose last pass stopped at the inactivity limit, as capped-projects.json shapes it."""
    new = str(uuid.uuid5(NAMESPACE, f'limit:{source}'))
    clone(objects / source, objects / new)
    path = objects / new / 'object.json'
    o = json.loads(path.read_text())
    words = 'Stopped after 10 minutes without worker activity. Try again or review the saved checkpoint.'
    o['id'] = new
    o['state'] = 'failed'
    o['failure'] = words
    last = o['passes'][-1]
    last.update({'status': 'capped', 'limit': {'kind': 'inactivity', 'value': 600000}, 'resumable': True})
    last.setdefault('activity', []).append({'atMs': last.get('endedAtMs', o['updatedAtMs']), 'kind': 'message', 'text': words})
    for key in ('print', 'outcome'): o.pop(key, None)
    path.write_text(json.dumps(o))
    return new


def rewrite_paths(state: Path, source: Path) -> None:
    old, new = str(source).encode(), str(state).encode()
    for path in state.rglob('*'):
        if path.is_file() and path.suffix.lower() in TEXT and path.stat().st_size < 64 << 20:
            data = path.read_bytes()
            if old in data: path.write_bytes(data.replace(old, new))
    left = [str(p) for p in state.rglob('*') if p.is_file() and p.suffix.lower() in TEXT
            and p.stat().st_size < 64 << 20 and MARK in p.read_bytes()]
    if left: raise SystemExit(f'refusing to start: paths into the real state remain in {left[:5]}')


def prepare(source: Path, data: Path) -> dict:
    state = data / 'state'
    if state.exists(): raise SystemExit(f'{state} exists: move it away (Spillover) or choose another --work')
    for rel in COPY:
        if not (source / rel).exists(): continue
        if rel == 'capture/objects':
            for project in sorted((source / rel).iterdir()):
                if project.name not in EXCLUDE and not any(w in (project / 'object.json').read_bytes() for w in EXCLUDE_WORDS if (project / 'object.json').exists()):
                    clone(project, state / rel / project.name)
        elif rel == 'events.ndjson':
            (state / rel).parent.mkdir(parents=True, exist_ok=True)
            (state / rel).write_bytes(b''.join(line for line in (source / rel).read_bytes().splitlines(keepends=True)
                                               if not any(x.encode() in line for x in EXCLUDE) and not any(w in line for w in EXCLUDE_WORDS)))
        else: clone(source / rel, state / rel)
    objects = state / 'capture/objects'
    if not objects.is_dir() or not any(objects.iterdir()):
        raise SystemExit(f'The copy needs exactly one project whose id starts {PROJECTS[0][1]} in {objects}; there are no projects at {source}.')
    ids = {}
    for name, prefix, _ in PROJECTS:
        if prefix.startswith('synth:'): continue
        # A named project the person has since deleted is skipped, not an error (Nov 10: the bike-oil scan was gone).
        if any(p.name.startswith(prefix) for p in objects.iterdir()): ids[name] = resolve_id(objects, prefix)
        else: log(f'{name} ({prefix}) is no longer in the projects; its screens are skipped')
    if 'wall-holder' in ids: ids['wall-holder-question'] = synth_question(objects, ids['wall-holder'])
    if any(p.name.startswith('2f0a0229') for p in objects.iterdir()):
        ids['stove-gap-limit'] = synth_limit(objects, resolve_id(objects, '2f0a0229'))
    rewrite_paths(state, source)
    leftover = [str(p) for p in state.rglob('*.json') if any(w in p.read_bytes() for w in EXCLUDE_WORDS)]
    if leftover or any((objects / x).exists() for x in EXCLUDE): raise SystemExit(f'excluded projects remain in the copy: {leftover[:5]}')
    manifest = {'source': str(source), 'copiedAt': dt.datetime.now().isoformat(timespec='seconds'), 'ids': ids, 'copied': COPY, 'excluded': sorted(EXCLUDE)}
    (data / 'manifest.json').write_text(json.dumps(manifest, indent=1))
    return manifest


def fixture_assets(state: Path, ids: dict, folder: Path) -> None:
    """The app's fixture folder, filled from the copy so fixture screens show real pictures, not blanks."""
    folder.mkdir(parents=True, exist_ok=True)
    objects = state / 'capture/objects'
    mic, potato = objects / ids['mic-mount'], objects / ids['crochet-potato']
    renders = sorted((mic / 'current/renders').glob('*.png'))
    photos = sorted(p for p in (mic / 'photos').glob('*') if p.suffix.lower() in {'.jpg', '.jpeg'})
    pairs = {'mic.stl': mic / 'current/model.stl', 'thumb-mic.png': renders[0], 'render-live.png': renders[0],
             'thumb-potato.png': sorted((potato / 'current/renders').glob('*.png'))[0], 'bed.jpg': photos[0]}
    for index in range(4): pairs[f'photo{index + 1}.jpg'] = photos[index % len(photos)]
    for name in ('printer-setup-phone.json', 'mcp-profile-copies.json'):
        pairs[name] = REPO / 'packages/contracts/fixtures' / name
    for name, src in pairs.items(): shutil.copyfile(src, folder / name)


# ---------------------------------------------------------------- the companion

class Companion:
    def __init__(self, state: Path, log_path: Path, condition: str = 'none'):
        dist = REPO / 'services/companion/dist'
        if not (dist / 'server-cli.js').exists():
            raise SystemExit('The companion is not built. Build it first: npm ci --ignore-scripts in packages/contracts, services/project, '
                             'services/printer-handoff, services/companion; then npm run build in packages/contracts and services/companion')
        self.log = open(log_path, 'w')
        self.proc = subprocess.Popen(['node', str(REPO / 'scripts/ux_screens/companion.mjs'), '--state', str(state), '--dist', str(dist),
                                      '--condition', condition],
                                     stdout=subprocess.PIPE, stderr=self.log, text=True)
        line = self.proc.stdout.readline()
        if not line:
            self.proc.wait(10)
            self.log.flush()
            tail = log_path.read_text()[-600:].strip().replace('\n', ' ')
            raise SystemExit(f'The capture companion did not start, so nothing was captured: {tail or "no output"} (log: {log_path})')
        self.info = json.loads(line)

    def processes(self) -> list[str]:
        table = subprocess.run(['ps', '-A', '-o', 'pid=,ppid=,command='], capture_output=True, text=True).stdout.splitlines()
        rows = [(int(r.split()[0]), int(r.split()[1]), r.split(None, 2)[2]) for r in table if len(r.split()) >= 3]
        tree, frontier = [], {self.proc.pid}
        while frontier:
            children = [(pid, command) for pid, ppid, command in rows if ppid in frontier]
            tree += [command for _, command in children]
            frontier = {pid for pid, _ in children}
        return tree

    def stop(self) -> None:
        if self.proc.poll() is None:
            self.proc.terminate()
            try: self.proc.wait(10)
            except subprocess.TimeoutExpired: self.proc.kill()
        self.proc.stdout.close()
        self.log.close()


# ---------------------------------------------------------------- screens

def screens(ids: dict, record: str, offline_record: str, fixtures: Path, offline_fixtures: Path) -> list[dict]:
    real = ['-CounterpartPairingRecord', record]
    def fixture(*more: str, folder: Path = fixtures, set_: str = 'all') -> list[str]:
        return ['-CounterpartFixtures', str(folder), '-CounterpartFixtureSet', set_, *more]
    out: list[dict] = []
    def add(name, screen, state, data, args, actions=(), pages=1, note=''):
        out.append({'order': len(out), 'name': name, 'screen': screen, 'state': state, 'data': data, 'args': args, 'actions': list(actions),
                    'pages': pages, 'note': note})
    # First run, on a fresh install: no pairing anywhere.
    add('first-run-welcome', 'First run: Welcome', 'not paired', 'none', [])
    add('first-run-pair', 'First run: Find your Mac', 'not paired', 'none', [], [['press', 'id="welcome-continue"']], pages=2)
    add('home', 'Home', 'all projects', 'real', real, pages=6)
    add('search', 'Home: search', 'typed "holder"', 'real', real,
        [['press', 'id="project-search"'], ['type', 'holder']], pages=2)
    add('new', 'New', 'nothing chosen', 'real', real + ['-CounterpartScreen', 'new'], pages=3)
    add('new-scan', 'New, after a scan', 'scan attached, no use chosen', 'real (scan faked)', real + ['-CounterpartScreen', 'new', '-CounterpartNewScan', 'walk-around'], pages=2)
    rows = {'copy': 'Copy this object', 'fit': 'Make something that fits this', 'later': 'Just save this scan'}
    for use, row in rows.items():
        add(f'new-scan-{use}', f'New, after a scan: {use}', f'"{use}" chosen', 'real (scan faked)',
            real + ['-CounterpartScreen', 'new', '-CounterpartNewScan', 'walk-around'], [['find', row, 'click']], pages=2)
    for label in ('Measured', 'Scan'):
        add(f'new-scan-fit-{label.lower()}', f'New, after a scan: fit, size from {label.lower()}', f'fit, "{label}" size', 'real (scan faked)',
            real + ['-CounterpartScreen', 'new', '-CounterpartNewScan', 'walk-around'],
            [['find', rows['fit'], 'click'], ['find', label, 'click']], pages=2)
    for name, _, state in [p for p in PROJECTS if p[0] in ids]:
        data = 'real (state synthesised)' if name in ('wall-holder-question', 'stove-gap-limit') else 'real'
        for item in project_screens(name, ids[name], state, data, record): item['order'] = len(out); out.append(item)
    add('print-wall-holder', 'Print sheet', 'wall-holder, stub printer MCP', 'real (printer stub)', real + ['-CounterpartOpen', f'counterpart://print/{ids["wall-holder"]}'], pages=3)
    add('print-scan-platform-3mf', 'Print sheet: plates', 'multi-plate 3MF, stub printer MCP', 'real (printer stub)', real + ['-CounterpartOpen', f'counterpart://print/{ids["scan-platform-3mf"]}'], pages=3)
    add('printing-guitar-pick', 'Printing', 'finished print', 'real', real + ['-CounterpartOpen', f'counterpart://printing/{ids["guitar-pick"]}'], pages=2)
    add('printers', 'Printers', 'stub printer MCP', 'real (printer stub)', real + ['-CounterpartScreen', 'printers'], pages=2)
    add('add-printer', 'Add printer', 'stub printer MCP', 'real (printer stub)', real + ['-CounterpartScreen', 'printers'], [['press', 'id="add-printer"']], pages=2)
    add('settings', 'Settings', 'copied settings, no AI set up', 'real', real + ['-CounterpartScreen', 'settings'], pages=4)
    add('settings-notifications', 'Settings: Notifications', '', 'real', real + ['-CounterpartScreen', 'notifications'], pages=2)
    add('settings-about', 'Settings: About', '', 'real', real + ['-CounterpartScreen', 'about'], pages=3)
    add('notify', 'First run: notifications question', 'just paired', 'real', real + ['-CounterpartScreen', 'notify'])
    add('offline', 'Offline banner', 'the Mac is not answering', 'real client, no companion', ['-CounterpartPairingRecord', offline_record], pages=1)
    # The app's own fixtures: screens that need a printer, a running pass, or a state the copy can't hold.
    add('fx-home-empty', 'Home: no projects (starters)', 'empty Mac', 'fixture', fixture(set_='empty'), pages=3)
    add('fx-working', 'Project: working', 'pass running', 'fixture', fixture('-CounterpartScreen', 'working'), pages=2)
    add('fx-ask', 'Project: question', 'close-up asked', 'fixture', fixture('-CounterpartScreen', 'ask'), pages=2)
    add('fx-failed', 'Project: failed (Activity)', 'Blender closed', 'fixture', fixture('-CounterpartScreen', 'failed'), pages=2)
    for screen, state in [('print', 'AMS printer'), ('print-noams', 'one spool'), ('print-loaded', 'printer that doesn\'t report'),
                          ('print-pauses', 'layer pauses')]:
        add(f'fx-{screen}', 'Print sheet', state, 'fixture', fixture('-CounterpartScreen', screen), pages=3)
    add('fx-print-plates', 'Print sheet: plate picker', 'six plates', 'fixture', fixture('-CounterpartScreen', 'print', set_='plates'), pages=3)
    add('fx-print-designer', 'Print sheet: designer settings', 'designer 3MF', 'fixture', fixture('-CounterpartScreen', 'print', set_='designer'), pages=2)
    for screen, state in [('confirm', "the printer's own question"), ('confirm-generic', 'a question with choices'), ('confirm-mac', 'a question only the Mac can answer')]:
        add(f'fx-{screen}', 'Project: printer question', state, 'fixture', fixture('-CounterpartScreen', screen), pages=2)
    for screen, state in [('preparing', 'getting ready'), ('printing', 'in progress'), ('print-finished', 'finished')]:
        add(f'fx-printing-{screen}', 'Printing', state, 'fixture', fixture('-CounterpartScreen', screen), pages=2)
    for screen, state in [('printers', 'three printers'), ('printer', 'one printer'), ('printer-connection', 'connection choices'), ('printer-update', 'MCP update needed')]:
        add(f'fx-{screen}', 'Printers', state, 'fixture', fixture('-CounterpartScreen', screen), pages=2)
    add('fx-add-printer', 'Add printer', 'printers found', 'fixture', fixture('-CounterpartScreen', 'printers'), [['press', 'id="add-printer"']], pages=2)
    add('fx-settings', 'Settings (Design engine row)', 'code engine not set up', 'fixture', fixture('-CounterpartScreen', 'settings'), pages=4)
    add('fx-offline', 'Offline banner', 'Mac not answering', 'fixture', fixture(folder=offline_fixtures))
    add('fx-live-activity', 'Live Activity (Home screen)', 'print halfway', 'fixture', fixture('-CounterpartScreen', 'live-activity'), [['home']],
        note='after Home; the Lock Screen cannot be shown in a simulator by agent-device')
    return out


# The iPhone Duo's two panels in points (agent-device help foldable): which one a capture draws says the pose.
PANEL_POINTS = {'closed': (466, 678), 'open': (669, 951)}


def slug(text: str) -> str:
    return re.sub(r'[^a-z0-9]+', '-', text.lower()).strip('-')[:40].strip('-') or 'untitled'


def project_names(wanted: list[str], objects: list[dict]) -> dict[str, str]:
    """File names for --project: the title's slug and the shortest id prefix (8 characters or more) that no other project
    in the copy shares, so two projects never write the same images, here or in another run on the same copy."""
    ids = [o['id'] for o in objects]
    titles = {o['id']: o.get('title') or 'untitled' for o in objects}
    names = {}
    for pid in dict.fromkeys(wanted):
        length = 8
        while length < len(pid) and any(other != pid and other.startswith(pid[:length]) for other in ids): length += 1
        names[pid] = f'{slug(titles.get(pid, "untitled"))}-{pid[:length]}'
    clash = [n for n in names.values() if list(names.values()).count(n) > 1]
    if clash: raise SystemExit(f'Two projects would share the image names {sorted(set(clash))}; choose them in separate runs.')
    return names


def project_screens(name: str, pid: str, state: str, data: str, record: str) -> list[dict]:
    """A project's three tabs, opened by its link."""
    base = ['-CounterpartPairingRecord', record, '-CounterpartOpen', f'counterpart://project/{pid}']
    tabs = [('result', 'Project: Result', [], 4), ('sent', 'Project: What you sent', ['-CounterpartSection', 'inputs'], 4),
            ('activity', 'Project: Activity', ['-CounterpartSection', 'activity'], 3)]
    items = [{'order': 0, 'name': f'project-{name}-{tab}', 'screen': screen, 'state': state, 'data': data, 'args': base + extra,
              'actions': [], 'pages': pages, 'note': ''} for tab, screen, extra, pages in tabs]
    # Make something else from this scan (design §3.3), on a project with a scan: New holding it, and the new fit project
    # it makes. The second writes a project into the capture's copy of the data, never into the real app's.
    open_new = [['press', 'id="make-from-scan"']]
    made = open_new + [['press', 'id="scan-use-fit"'], ['press', 'id="describe"'], ['type', 'A belt case for it'], ['press', 'id="send"']]
    items += [{'order': 0, 'name': f'project-{name}-make-from-scan', 'screen': 'New, holding this scan', 'state': state, 'data': data,
               'args': base, 'actions': open_new, 'pages': 2, 'note': 'Make something else from this scan, pressed'},
              {'order': 0, 'name': f'project-{name}-made-from-scan', 'screen': 'The project made from this scan', 'state': state, 'data': data,
               'args': base, 'actions': made, 'pages': 2, 'note': 'Make something that fits this, "A belt case for it", Send (in the copy)'}]
    return items


class LoadSampler:
    """The Mac's 1-minute load average every 5 s while this hold runs, to a CSV, and its summary."""
    def __init__(self, path: Path):
        import threading
        self.path, self.rows, self.before = path, [], os.getloadavg()[0]
        self.stopped = threading.Event()
        self.thread = threading.Thread(target=self._run, daemon=True)
        self.thread.start()

    def _run(self) -> None:
        with open(self.path, 'w') as file:
            file.write('seconds,load1,load5\n')
            start = time.time()
            while not self.stopped.wait(5):
                one, five, _ = os.getloadavg()
                self.rows.append(one)
                file.write(f'{time.time() - start:.0f},{one:.1f},{five:.1f}\n'); file.flush()

    def stop(self) -> dict:
        self.stopped.set(); self.thread.join(10)
        rows = self.rows or [self.before]
        return {'loadBefore': round(self.before, 1), 'loadMean': round(sum(rows) / len(rows), 1), 'loadMax': round(max(rows), 1),
                'loadSamples': len(self.rows)}


class Device:
    def __init__(self, key: str, udid: str, out: Path, record):
        self.key, self.udid, self.out, self.record = key, udid, out, record
        # One agent-device session per simulator: a fixed name stayed bound to an earlier run's deleted simulator.
        self.session = f'ux-screens-{key}-{RUN_ID}'
        self.captured = 0
        self.cli = agent_device()

    def panel_points(self) -> tuple[int, int] | None:
        """The size in points of the panel a capture draws (a screenshot at density 1), to tell a Duo's pose."""
        import struct, tempfile
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'pose.png'
            try: self.ad('screenshot', str(path), '--pixel-density', '1')
            except Exception: return None
            head = path.read_bytes()[:24] if path.exists() else b''
            return struct.unpack('>II', head[16:24]) if head[12:16] == b'IHDR' else None

    def ad(self, *args: str, timeout: int = 90) -> dict:
        cmd = [*self.cli, *args, '--udid', self.udid, '--session', self.session, '--json']
        run = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        text = run.stdout.strip()
        try: reply = json.loads(text) if text else {}
        except json.JSONDecodeError:
            try: reply = json.loads(text.splitlines()[-1])
            except (json.JSONDecodeError, IndexError): reply = {'raw': text[-500:]}
        if run.returncode != 0:
            raise RuntimeError(f'agent-device {" ".join(args[:3])}: {(run.stderr or run.stdout)[-400:]}')
        return reply

    def wait_for_app(self, limit: float = 45) -> str:
        """Until the app's own tree can be read (it is on screen), at most `limit` seconds, then a moment to settle. Nov 10:
        at load 300+ a fixed 4 s wait took frames of the home screen while the app was still launching."""
        deadline, last = time.time() + limit, ''
        while time.time() < deadline:
            try:
                tree = self.ad('snapshot', '-d', '3', timeout=30)
                if len((tree.get('data') or {}).get('nodes') or []) > 3:
                    time.sleep(2)
                    return ''
                last = f'{len((tree.get("data") or {}).get("nodes") or [])} elements'
            except Exception as failure:
                last = str(failure)[-300:].replace('\n', ' ')
            time.sleep(1.5)
        # Take the frame anyway: what is on the screen is the evidence, and the blank check flags a frame without a tree.
        log(self.key, f'the app\'s tree was not readable {limit:.0f} s after it was opened: {last}')
        return f'the app\'s tree was not readable {limit:.0f} s after it was opened'

    def shoot(self, item: dict) -> None:
        # The screen's settings go into the app's defaults domain (what its launch arguments would set), fresh for each
        # screen: agent-device's --launch-args did not reach the app (Nov 10), and defaults reach UserDefaults the same way.
        simctl('terminate', self.udid, BUNDLE, check=False)
        simctl('spawn', self.udid, 'defaults', 'delete', BUNDLE, check=False)
        pairs = item['args']
        for key, value in zip(pairs[0::2], pairs[1::2]):
            simctl('spawn', self.udid, 'defaults', 'write', BUNDLE, key.lstrip('-'), '-string', value)
        console = self.out / f'{item["name"]}.console.log'  # the app's own output from launch, for when it isn't on screen
        self.ad('open', BUNDLE, '--relaunch', '--launch-console', str(console), timeout=120)
        error = self.wait_for_app()
        if error and console.exists():
            tail = console.read_text(errors='replace')[-600:].replace('\n', ' | ')
            log(self.key, item['name'], 'console:', tail)
            error += f' (console: {tail[-300:]})'
        for action in item['actions']:
            try:
                if action[0] == 'type': self.ad('type', action[1])
                elif action[0] == 'home': self.ad('home')
                elif action[0] == 'find': self.ad(*action)
                else: self.ad(action[0], action[1], '--settle')
                time.sleep(1.5)
            except Exception as failure:  # the screen is still captured, with what happened
                error = str(failure)
        previous: Path | None = None
        for page in range(1, item['pages'] + 1):
            path = self.out / f'{item["name"]}-p{page}.png'
            self.ad('screenshot', str(path), '--pixel-density', '2', '--normalize-status-bar')
            if previous and same_screen(previous, path):  # the scroll didn't move: this page repeats the last one
                path.unlink()
                break
            try:  # the accessibility tree of this frame, for the blank check (blank.py), which also runs without a simulator
                tree = self.ad('snapshot', '--raw', timeout=60)
                path.with_suffix('.ax.json').write_text(json.dumps(tree))
            except Exception as failure:
                log(self.key, item['name'], 'no accessibility snapshot:', str(failure)[:120])
            previous = path
            self.record('results', {**item, 'args': [], 'device': self.key, 'image': str(path), 'page': page, 'error': error})
            self.captured += 1
            if page == item['pages']: break
            try: moved = json.dumps(self.ad('scroll', 'down', '0.7'))
            except Exception: break
            if '"unchanged"' in moved: break
            time.sleep(1)


def same_screen(a: Path, b: Path) -> bool:
    """Two captures of one screen: equal, or (with Pillow) under 1% mean pixel difference, so a spinner or a
    blinking caret doesn't count as a new page."""
    if a.read_bytes() == b.read_bytes(): return True
    try: from PIL import Image, ImageChops, ImageStat
    except ImportError: return False
    x, y = (Image.open(p).convert('L').resize((200, 400)) for p in (a, b))
    return sum(ImageStat.Stat(ImageChops.difference(x, y)).mean) < 2.55


def simctl(*args: str, check: bool = True) -> str:
    return subprocess.run(['xcrun', 'simctl', *args], capture_output=True, text=True, check=check).stdout.strip()


# The capture companion's proxy conditions (scripts/ux_screens/conditions.mjs, which applies them).
CONDITIONS = {
    'none': 'replies as the companion gives them',
    'slow': 'every reply waits 1.5 s, and files arrive at about 1 MB/s (a 16 MB scan takes 16 s)',
    'refusing': 'file downloads answer 413 (models and scans) or 404 (pictures); the JSON API works',
    'away': 'the project list loads once; after that nothing answers',
}

APP_SOURCES = ['apps/mobile', 'packages/CounterpartKit']
# What the capture companion is built from: `npm run build` in services/companion builds project and printer-handoff too.
COMPANION_SOURCES = ['services/companion', 'services/project', 'services/printer-handoff', 'packages/contracts']


def source_state(paths: list[str], repo: Path = REPO) -> str:
    """The content of these source folders as they are on disk (committed or not, untracked files included, ignored
    build output not), as the git tree a commit of them would have. A build is reused only while this is unchanged."""
    with tempfile.TemporaryDirectory() as scratch:
        env = dict(os.environ, GIT_INDEX_FILE=str(Path(scratch) / 'index'))
        git = lambda *a: subprocess.run(['git', '-C', str(repo), *a], env=env, capture_output=True, text=True, check=True).stdout.strip()
        git('read-tree', 'HEAD')
        git('add', '-A', '--', *paths)
        tree = git('write-tree')
        return git('rev-parse', *[f'{tree}:{p}' for p in paths]).replace('\n', ' ')


def describe_source(repo: Path = REPO) -> str:
    """The commit this run's app and companion are built from, said plainly, with any uncommitted changes."""
    git = lambda *a: subprocess.run(['git', '-C', str(repo), *a], capture_output=True, text=True).stdout.strip()
    dirty = git('status', '--porcelain', '--', *APP_SOURCES, *COMPANION_SOURCES)
    branch = git('rev-parse', '--abbrev-ref', 'HEAD')
    return f'{git("rev-parse", "--short", "HEAD")} ({branch})' + (' with uncommitted changes' if dirty else '')


def ensure_companion(repo: Path = REPO, run=subprocess.run) -> None:
    """Builds the capture companion from this checkout unless its dist was built from exactly this source. Nov 10: a dist
    built from an older commit was captured as the train's build and showed a fixed bug (the Fit brief) as still there."""
    dist = repo / 'services/companion/dist'
    stamp, want = dist / '.ux-screens-source', source_state(COMPANION_SOURCES, repo)
    if (dist / 'server-cli.js').exists() and stamp.exists() and stamp.read_text() == want:
        log('reusing the companion built from this source')
        return
    log(f'building the companion from {describe_source(repo)}')
    for folder in ('packages/contracts', 'services/project', 'services/printer-handoff', 'services/companion'):
        if not (repo / folder / 'node_modules').exists():
            run(['npm', 'ci', '--prefix', str(repo / folder), '--ignore-scripts', '--no-audit', '--no-fund'], check=True, capture_output=True)
    for folder in ('packages/contracts', 'services/companion'):
        built = run(['npm', 'run', 'build', '--prefix', str(repo / folder)], capture_output=True, text=True)
        if built.returncode: raise SystemExit(f'The companion did not build from {folder}: {(built.stdout + built.stderr)[-600:]}')
    dist.mkdir(parents=True, exist_ok=True)
    stamp.write_text(want)


def find_app(derived: Path) -> Path | None:
    for app in (derived / 'Build/Products/Debug-iphonesimulator').glob('*.app'):
        info = subprocess.run(['/usr/libexec/PlistBuddy', '-c', 'Print :CFBundleIdentifier', str(app / 'Info.plist')], capture_output=True, text=True).stdout.strip()
        if info == BUNDLE: return app
    return None


def build_app(work: Path) -> Path:
    derived = work / 'build'
    stamp, fingerprint = derived / 'ux-screens-source', source_state(APP_SOURCES)
    if (app := find_app(derived)) and stamp.exists() and stamp.read_text() == fingerprint:
        log('reusing the app built from this source')
        return app
    log('building the Debug app for the simulator')
    subprocess.run(['xcodebuild', 'build', '-project', str(REPO / 'apps/mobile/ios/ScanToMake.xcodeproj'), '-scheme', 'ScanToMake',
                    '-configuration', 'Debug', '-destination', 'generic/platform=iOS Simulator', '-derivedDataPath', str(derived),
                    'CODE_SIGN_IDENTITY=-', 'CODE_SIGN_STYLE=Manual', '-quiet'], check=True, stdout=open(work / 'xcodebuild.log', 'w'), stderr=subprocess.STDOUT)
    app = find_app(derived)
    if not app: raise SystemExit('built app not found')
    stamp.write_text(fingerprint)
    return app


KEPT_PREFIX = 'stm-ux-'


def kept_simulator(base: str, kind: str, runtime: str) -> str:
    """The one simulator kept for this kind of device (stm-ux-iphone, stm-ux-ipad, stm-ux-duo), created the first time
    only. Nov 10: creating a simulator per run meant a first boot per run, dozens of system services each time, with the
    Mac's load at 150–600 while David used his app on it."""
    listing = json.loads(simctl('list', 'devices', '-j'))
    for runtime_id, devices in listing['devices'].items():
        for device in devices:
            if device['name'] == KEPT_PREFIX + base:
                if runtime_id == runtime and device.get('deviceTypeIdentifier') == kind and device.get('isAvailable', True):
                    return device['udid']
                simctl('delete', device['udid'], check=False)  # another type or runtime than the tool wants now
    return simctl('create', KEPT_PREFIX + base, kind, runtime)


def fresh_app(udid: str, app: Path, keep_data: str | None = None) -> None:
    """This run's app on a kept simulator, with nothing left from the last run: its data, defaults and keychain.
    keep_data 'keep' (--keep-app-data) installs over the last run's app and keeps its data, as an App Store update does:
    the phone's library and saved project list from the run before are there for an --condition away run. 'start'
    (--keep-app-data start) begins such a pair from a fresh install."""
    simctl('terminate', udid, BUNDLE, check=False)
    if keep_data == 'keep':
        simctl('install', udid, str(app))
        return
    simctl('uninstall', udid, BUNDLE, check=False)
    simctl('keychain', udid, 'reset', check=False)
    simctl('install', udid, str(app))


def run_devices(keys: list[str], items: list[dict], app: Path, out: Path, record, done: set, deadline: float,
                fresh_simulator: bool = False, keep_data: str | None = None) -> tuple[int, int, str]:
    """Captures what isn't done yet, until the deadline; returns the screens left, the images taken and the first failure.
    Each kind of device uses its kept simulator, shut down at the end; --fresh-simulator creates and deletes one instead."""
    created: dict[str, str] = {}
    kept: dict[str, str] = {}
    devices: list[Device] = []
    first_failure = ''
    left = sum(1 for key in keys for item in items if (key, item['name']) not in done)
    try:
        for key in keys:
            todo = [item for item in items if (key, item['name']) not in done]
            if not todo or time.time() > deadline: continue
            name, kind, runtime, pose = DEVICES[key]
            base = 'duo' if key.startswith('duo') else key
            if base not in created and base not in kept:
                if fresh_simulator:
                    udid = created[base] = simctl('create', f'ux-screens-{base}-{RUN_ID}', kind, runtime)
                else:
                    # --keep-app-data uses a kept simulator of its own (stm-ux-<kind>-kept): another run on the shared
                    # one uninstalls the app between holds, which would take the kept data with it.
                    udid = kept[base] = kept_simulator(base + ('-kept' if keep_data else ''), kind, runtime)
                simctl('boot', udid, check=False)  # already booted is fine
                simctl('bootstatus', udid, '-b')
                fresh_app(udid, app, keep_data=None if fresh_simulator else keep_data)
            udid = created.get(base) or kept[base]
            device = Device(key, udid, out / key, record)
            devices.append(device)
            device.out.mkdir(parents=True, exist_ok=True)
            started = time.time()
            simctl('ui', udid, 'appearance', 'light', check=False)
            for setting in (['settings', 'permission', 'grant', 'notifications', '--app', BUNDLE],):
                try: device.ad(*setting)
                except Exception as failure: record('failures', {'device': key, 'name': ' '.join(setting), 'why': str(failure)})
            if pose:  # a Duo's fold, or an iPad's orientation, set once with the app open
                try: device.ad('open', BUNDLE, '--relaunch', timeout=120); device.ad('orientation' if pose.startswith('landscape') else 'fold', pose, timeout=120)
                except Exception as failure:
                    # agent-device sends the fold, then reads the hinge back; when that read returns no sample (Nov 11, on
                    # this Mac) it fails with fold-pose-dispatched-unverified although the pose was sent. Its help says to
                    # check from a capture: the lit panel's points, 466 x 678 closed and 669 x 951 open.
                    why = str(failure)
                    if 'fold-pose-dispatched-unverified' in why and pose in PANEL_POINTS:
                        size = device.panel_points()
                        if size == PANEL_POINTS[pose]: why = ''
                        else: why = f'fold {pose} sent, but the capture is {size} points, not {PANEL_POINTS[pose]}: {why}'
                    if why: record('failures', {'device': key, 'name': f'fold {pose}', 'why': why})
            for item in todo:
                if time.time() > deadline: break
                left -= 1
                try:
                    device.shoot(item)
                    record('done', {'device': key, 'name': item['name']})
                except Exception as failure:
                    record('failures', {'device': key, 'name': item['name'], 'why': str(failure)})  # not done: the next run retries it
                    first_failure = first_failure or f'{item["name"]}: {str(failure)[:300]}'
                    log(key, item['name'], 'FAILED', str(failure)[:200])
            log(key, f'done in {time.time() - started:.0f} s')
            try: device.ad('close')
            except Exception: pass
    finally:
        for device in devices:
            try: device.ad('close', timeout=30)
            except Exception: pass
        for udid in created.values():
            simctl('shutdown', udid, check=False)
            simctl('delete', udid, check=False)
        for udid in kept.values():
            simctl('shutdown', udid, check=False)  # kept for the next run, never left booted
    return left, sum(d.captured for d in devices), first_failure


def read_jsonl(path: Path) -> list[dict]:
    return [json.loads(line) for line in path.read_text().splitlines() if line.strip()] if path.exists() else []


def write_index(out: Path, info: dict, manifest: dict, minutes: float, processes: list[str]) -> None:
    images = {r['image']: r for r in read_jsonl(out / 'results.jsonl') if Path(r['image']).exists()}
    results = sorted(images.values(), key=lambda r: (list(DEVICES).index(r['device']), r['order'], r['page']))
    captured = {(r['device'], r['name']) for r in results}
    failures = {(f['device'], f['name']): f['why'] for f in read_jsonl(out / 'failures.jsonl') if (f['device'], f['name']) not in captured}
    failures = [(d, n, w) for (d, n), w in failures.items()]
    lines = ['# Counterpart screens', '',
             f'**Condition: {info.get("condition", "none")}** ({CONDITIONS.get(info.get("condition", "none"), "")}).', '',
             f'Made by `scripts/ux_screens.py` on {dt.datetime.now():%Y-%m-%d %H:%M}; this run\'s app and companion were built from '
             f'`{info.get("source", describe_source())}`'
             f' (this run held the lane {minutes:.0f} min; earlier runs\' images are kept).', '',
             '**Data.** *real*: a copy of this Mac\'s projects (copied ' + manifest['copiedAt'] + '), served by the real companion '
             f'(`server-cli.js`) to the real app client over {info.get("url", "a simulator test address")}. The pairing exchange was made by the script, not the pairing UI. '
             'No printer: the printer MCP is `/usr/bin/false`, so printer screens with *real (printer stub)* show what the app says when its '
             'printer MCP can\'t start. *real (state synthesised)*: a copy of a real project changed into a state the data no longer has '
             '(the wall holder\'s open question; a pass stopped at a limit). Home therefore lists both copies too. '
             '*real (scan faked)*: New is told a scan is attached (`-CounterpartNewScan`). *fixture*: the app\'s canned Mac (`Fixtures.swift`), '
             'with real renders and photos from the copy in place of its blank assets. *none*: a fresh install.', '',
             f'Companion objects served: {len(info.get("objects", []))}. Companion process tree: {processes or "server-cli only"}.', '']
    if failures:
        lines += ['## Not captured', '', '| Device | Screen | Why |', '|---|---|---|']
        lines += [f'| {d} | {n} | {w[:300].replace("|", "/").replace(chr(10), " ")} |' for d, n, w in failures]
        lines += ['']
    for device in dict.fromkeys(r['device'] for r in results):
        lines += [f'## {DEVICES[device][0]} (`{device}`)', '', '| Image | Screen | State | Data | Built from | Note |', '|---|---|---|---|---|---|']
        for r in (r for r in results if r['device'] == device):
            rel = Path(r['image']).relative_to(out)
            note = '; '.join(x for x in [r['note'], f'page {r["page"]}' if r['page'] > 1 else '', f'action failed: {r["error"][:120]}' if r['error'] else ''] if x)
            lines.append(f'| [{rel}]({rel}) | {r["screen"]} | {r["state"]} | {r["data"]} | {r.get("source") or "unrecorded (before Nov 10 08:00)"} | {note.replace("|", "/")} |')
        lines.append('')
    (out / 'index.md').write_text('\n'.join(lines))


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('out', type=Path)
    parser.add_argument('--work', type=Path, help='scratch: the data copy and build (default: <out>/../ux-screens-work)')
    parser.add_argument('--source', type=Path, default=REAL, help=argparse.SUPPRESS)
    parser.add_argument('--devices', default=','.join(DEVICES))
    parser.add_argument('--screens', default='', help='comma-separated substrings of screen names to keep')
    parser.add_argument('--prepare-only', action='store_true', help='copy the data, start the companion, check it, stop')
    parser.add_argument('--max-minutes', type=float, default=10, help='the lane hold\'s length: no new screen starts after it, less 90 s to clean up (default 10); run again to go on')
    parser.add_argument('--project', action='append', default=[], metavar='ID',
                        help="only this project's Result, What you sent and Activity, by id (any project in the copy; repeatable), or all: "
                             "every project in the copy. With --project, --screens picks tabs (result, sent, activity)")
    parser.add_argument('--condition', choices=CONDITIONS, default='none',
                        help='the Mac on a bad day: ' + '; '.join(f'{k}: {v}' for k, v in CONDITIONS.items()) + '. One condition per output folder')
    parser.add_argument('--fresh-simulator', action='store_true',
                        help='create and delete a simulator for this run (the behaviour before Nov 10) instead of the kept stm-ux-* one')
    parser.add_argument('--keep-app-data', nargs='?', const='keep', choices=['keep', 'start'],
                        help="keep the app's data from the last --keep-app-data run (its on-device library and saved project list), "
                             "on a kept simulator of its own (stm-ux-<kind>-kept): run once with --keep-app-data start (a fresh install there), "
                             "then again with --condition away --keep-app-data to see what the phone shows from what it kept")
    parser.add_argument('--pages', type=int, help='at most this many scrolled pages per screen')
    parser.add_argument('--redo', action='store_true', help='capture the selected screens again (with --devices/--screens)')
    args = parser.parse_args()
    out, work = args.out.resolve(), (args.work or args.out.resolve().parent / 'ux-screens-work').resolve()
    keys = [k for k in args.devices.split(',') if k]
    if any(k not in DEVICES for k in keys): raise SystemExit(f'Unknown device; choose from {", ".join(DEVICES)}.')
    if REAL in work.parents or work == REAL or REAL in out.parents: raise SystemExit('The work and out folders must be outside the real state.')
    held = os.environ.get('UX_SCREENS_COMPANION')
    if held and lane.nested_holder():
        return capture(args, out, work, keys, json.loads(Path(held).read_text()))
    out.mkdir(parents=True, exist_ok=True); work.mkdir(parents=True, exist_ok=True)
    marker = out / 'condition.txt'
    if marker.exists() and marker.read_text().strip() != args.condition:
        raise SystemExit(f'{out} holds frames under the condition "{marker.read_text().strip()}"; use another folder for "{args.condition}".')
    marker.write_text(args.condition + '\n')

    # Everything that can fail without a simulator happens here, before the lane is taken.
    data = work / 'data'
    manifest = json.loads((data / 'manifest.json').read_text()) if (data / 'manifest.json').exists() else prepare(args.source.resolve(), data)
    state, ids = data / 'state', manifest['ids']
    fixtures, offline = work / 'fixtures', work / 'fixtures-offline'
    fixture_assets(state, ids, fixtures)
    fixture_assets(state, ids, offline); (offline / 'offline').write_text('')
    if args.screens and not args.project:  # a typo fails here, before the companion or the lane
        select(args, out, keys, {'ids': ids, 'record': '', 'offline_record': '', 'fixtures': fixtures, 'offline': offline, 'info': {'objects': []}})
    log('starting the companion on the copy')
    source = describe_source()
    log(f'source: {source}')
    ensure_companion()
    companion = Companion(state, work / 'companion.log', args.condition)
    try:
        info = companion.info
        served = {o['id'] for o in info['objects']}
        missing = [name for name, _, _ in PROJECTS if name in ids and ids[name] not in served]
        if info.get('objectsStatus') != 200 or missing:
            raise SystemExit(f'The companion does not serve every project the screens need (missing {missing}, status {info.get("objectsStatus")}).')
        time.sleep(6)  # the companion reads its printer MCPs 5 s after start: check what it started
        processes = companion.processes()
        printers = [p for p in processes if re.search(r'\bssh\b|bambu|mcp-3d|printer-mcp', p, re.I) and not re.search(r'\bnpm (view|show)\b', p)]
        if printers:
            raise SystemExit(f'The companion started a printer process, so the run stopped: {printers}')
        log(f'companion serves {len(served)} projects; children: {processes}')
        if args.prepare_only:
            for o in info['objects']: print(f"  {o['id'][:8]}  {o['state']:<14} {o['title']}")
            return 0
        if args.project == ['all']:
            args.project = sorted(served)
            sys.argv[sys.argv.index('all')] = ','.join(args.project)  # the run inside the lane gets the same list
        if args.project and (unknown := [p for v in args.project for p in v.split(',') if p not in served]):
            raise SystemExit(f'These projects are not in the copy: {unknown}.')
        handoff = work / 'companion-info.json'
        info['source'] = source
        handoff.write_text(json.dumps({'info': info, 'manifest': manifest, 'processes': processes, 'served': sorted(served)}))
        items, done = select(args, out, keys, handoff_context(json.loads(handoff.read_text()), work))
        if all((k, i['name']) in done for k in keys for i in items):
            log('every screen is captured; --redo captures them again')
            write_index(out, info, manifest, 0, processes)
            return 0
        # Only the simulator part takes the lane: every hold that boots a simulator takes both slots, in arrival order.
        python = sys.executable
        global LANE_CHILD
        LANE_CHILD = subprocess.Popen([python, str(REPO / 'scripts/lane.py'), '--exclusive', '--label', f'ux-screens: {args.devices}',
                                       '--max-minutes', str(args.max_minutes), '--', python, str(Path(__file__).resolve()), *sys.argv[1:]],
                                      env=dict(os.environ, UX_SCREENS_COMPANION=str(handoff)))
        try:
            code = LANE_CHILD.wait()
        except Stopped:
            # The handler passed the signal on; wait here, outside it (Popen.wait isn't re-entrant), for the capture to
            # delete its simulators, so nothing is left booted when this run ends.
            try: LANE_CHILD.wait(180)
            except subprocess.TimeoutExpired: LANE_CHILD.kill(); LANE_CHILD.wait()
            raise
        LANE_CHILD = None
        if code: raise SystemExit(f'The capture inside the lane failed (exit {code}); see the lines above.')
        return 0
    finally:
        companion.stop()


def handoff_context(held: dict, work: Path) -> dict:
    info, manifest = held['info'], held['manifest']
    record = json.dumps(info['record'], separators=(',', ':'))
    offline_record = json.dumps({**info['record'], 'baseUrl': 'https://127.0.0.1:9079'}, separators=(',', ':'))
    return {**held, 'record': record, 'offline_record': offline_record, 'ids': manifest['ids'],
            'fixtures': work / 'fixtures', 'offline': work / 'fixtures-offline'}


def select(args, out: Path, keys: list[str], ctx: dict) -> tuple[list[dict], set]:
    items = screens(ctx['ids'], ctx['record'], ctx['offline_record'], ctx['fixtures'], ctx['offline'])
    if args.screens:
        wanted = args.screens.split(',')
        items = [i for i in items if any(i['name'] == w[1:] if w.startswith('=') else w in i['name'] for w in wanted)]
        if not items:
            valid = ', '.join(i['name'] for i in screens(ctx['ids'], '', '', Path(), Path()))
            raise SystemExit(f'No screen matches --screens {args.screens!r}, so there is nothing to capture. The screens are: {valid}.')
    if args.project:
        wanted = [p for value in args.project for p in value.split(',')]
        names = project_names(wanted, ctx['info']['objects'])
        items = [item for pid in wanted for item in project_screens(names[pid], pid, 'by id', 'real', ctx['record'])]
        if args.screens:  # with --project, --screens picks tabs: result, sent, activity
            items = [i for i in items if any(i['name'].endswith('-' + w.lstrip('=')) for w in args.screens.split(','))]
    if getattr(args, 'pages', None):  # --pages N: at most N scrolled pages per screen (the stage is on the first)
        items = [{**i, 'pages': min(i['pages'], args.pages)} for i in items]
    done = {(d['device'], d['name']) for d in read_jsonl(out / 'done.jsonl')}
    if args.redo: done -= {(k, i['name']) for k in keys for i in items}
    return items, done


def capture(args, out: Path, work: Path, keys: list[str], held: dict) -> int:
    """Inside the lane: build, then create, drive and delete the simulators. The companion keeps running outside."""
    ctx = handoff_context(held, work)
    items, done = select(args, out, keys, ctx)
    def record(kind: str, row: dict) -> None:
        row = {**row, 'source': ctx['info'].get('source', ''), 'condition': ctx['info'].get('condition', 'none')}  # which build each image came from, as runs accumulate
        with open(out / f'{kind}.jsonl', 'a') as file: file.write(json.dumps(row) + '\n')
    # Screens stop starting a minute and a half before --max-minutes, leaving time to delete the simulator.
    log('holding the lane')
    sampler = LoadSampler(out / f'load-{RUN_ID}.csv')
    app = build_app(work)
    built = time.time()
    left, captured, why = run_devices(keys, items, app, out, record, done, STARTED + args.max_minutes * 60 - 90,
                                      fresh_simulator=getattr(args, 'fresh_simulator', False), keep_data=getattr(args, 'keep_app_data', False))
    minutes = (time.time() - STARTED) / 60
    load = sampler.stop()
    run = {'run': RUN_ID, 'source': ctx['info'].get('source'), 'condition': ctx['info'].get('condition'), 'devices': keys,
           'freshSimulator': getattr(args, 'fresh_simulator', False), 'images': captured, 'screens': len(items) - left,
           'buildSeconds': round(built - STARTED), 'captureSeconds': round(time.time() - built), **load}
    with open(out / 'runs.jsonl', 'a') as file: file.write(json.dumps(run) + '\n')
    log(f'load average during the hold: {load["loadBefore"]:.0f} before, mean {load["loadMean"]:.0f}, max {load["loadMax"]:.0f}; '
        f'{run["screens"]} screens in {run["captureSeconds"]} s after the build')
    write_index(out, ctx['info'], ctx['manifest'], minutes, ctx['processes'])
    log(f'{len(read_jsonl(out / "results.jsonl"))} images so far; {left} screens left' + (' (run the same command again)' if left else '') + f': {out / "index.md"}')
    log(f'the copy of the projects is in {work / "data"}; move {work} to /Volumes/Spillover when done')
    if not captured:
        raise SystemExit(f'This hold captured no screens, so it failed: {why or "no screen started before --max-minutes"}.')
    import ux_blank  # the blank check reads every frame in <out> with its accessibility tree
    flagged = ux_blank.check_folder(out)
    report = ux_blank.write_report(out, flagged)
    if flagged:
        raise SystemExit(f'{len(flagged)} frames show a blank stage or picture with nothing to say why: {report}')
    log(f'blank check: none of the frames is blank ({report})')
    return 0


LANE_CHILD: subprocess.Popen | None = None


class Stopped(SystemExit):
    """A run stopped by SIGTERM or SIGHUP."""


def stop_on_signal(signum, frame):
    """SIGTERM or SIGHUP: pass the signal to the capture running in the lane (lane.py passes it on; the capture deletes its
    simulators). main waits for it, and the companion stops on the way out."""
    child = LANE_CHILD
    if child and child.poll() is None:
        child.send_signal(signal.SIGTERM)
    raise Stopped(f'Stopped by signal {signum}; the capture, its simulators and the companion of this run were cleaned up.')


if __name__ == '__main__':
    for signum in (signal.SIGTERM, signal.SIGHUP): signal.signal(signum, stop_on_signal)
    try:
        sys.exit(main())
    except (SystemExit, KeyboardInterrupt):
        raise
    except Exception as failure:  # a plain sentence and a non-zero exit, never a traceback alone
        sys.exit(f'ux_screens stopped before capturing: {type(failure).__name__}: {failure}')
