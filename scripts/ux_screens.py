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
2. Starts the real companion (services/companion/dist/server-cli.js) on that copy: port 19077, empty
   environment, HOME inside the copy, its own auth store, and a printer MCP of /usr/bin/false, so nothing can
   reach a printer. The simulator reaches it at http://127.0.0.1:9078 (the app's simulator-only test address).
   It pairs once (POST /v1/pair) and hands the record to the app with -CounterpartPairingRecord.
3. Holding ~/.stm-ios.lock: builds the Debug app, creates its own simulators (iPhone 17 Pro, iPad Pro 13-inch,
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
import fcntl
import json
import os
import re
import shutil
import subprocess
import sys
import time
import uuid
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
REAL = Path.home() / 'Library/Application Support/Scan to Make'
LOCK = Path(os.environ.get('STM_IOS_LOCK', str(Path.home() / '.stm-ios.lock')))
AGENT_DEVICE = os.environ.get('AGENT_DEVICE', str(Path.home() / '.t3/userdata/device/bin/agent-device'))
BUNDLE = 'com.scantomake'
MARK = b'Library/Application Support/Scan to Make'
# Only project data. Everything else under the state root (auth, tls, companion.env, printer-handoff*,
# printers/, live-activity-tokens.json, diagnostics, logs, releases) stays where it is.
COPY = ['capture/objects', 'capture/starters', 'events.ndjson', 'events.meta.json', 'settings.json', 'pass-timings.json']
TEXT = {'.json', '.ndjson', '.jsonl', '.txt', '.log', '.md', '.py', '.csv', '.yaml', '.yml'}
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
    ('unicorn', '176821af', 'failed: cancelled before a model'),
    ('stove-gap-limit', 'synth:limit', 'stopped at a limit (copy of stove-gap-filler, last pass capped)'),
    ('scan-platform-3mf', '7f1a9e33', 'ready: an imported multi-plate 3MF from a starter'),
    ('crochet-potato', 'c302d5db', 'ready: a copy with 24 photos'),
    ('airpods-hanger', '5158831c', 'ready: 8 passes, printed before'),
    ('mic-mount', '7f157a66', 'done: the oldest project format'),
]
DEVICES = {
    'iphone': ('iPhone 17 Pro', 'com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro', 'com.apple.CoreSimulator.SimRuntime.iOS-27-2', None),
    'ipad': ('iPad Pro 13-inch (M5)', 'com.apple.CoreSimulator.SimDeviceType.iPad-Pro-13-inch-M5-12GB', 'com.apple.CoreSimulator.SimRuntime.iOS-27-2', None),
    'duo-folded': ('iPhone Duo, folded', 'com.apple.CoreSimulator.SimDeviceType.iPhone-Duo', 'com.apple.CoreSimulator.SimRuntime.iOS-27-2-iPhone19-4', 'closed'),
    'duo-open': ('iPhone Duo, unfolded', 'com.apple.CoreSimulator.SimDeviceType.iPhone-Duo', 'com.apple.CoreSimulator.SimRuntime.iOS-27-2-iPhone19-4', 'open'),
}


def log(*parts: object) -> None:
    print(f'[{dt.datetime.now():%H:%M:%S}]', *parts, flush=True)


# ---------------------------------------------------------------- the data copy

def resolve_id(objects: Path, prefix: str) -> str:
    found = [p.name for p in objects.iterdir() if p.name.startswith(prefix)]
    if len(found) != 1: raise SystemExit(f'expected one project starting {prefix} in {objects}, found {found}')
    return found[0]


def clone(src: Path, dst: Path) -> None:
    dst.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(['cp', '-cR', str(src), str(dst)], check=True)


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
        if (source / rel).exists(): clone(source / rel, state / rel)
    objects = state / 'capture/objects'
    ids = {}
    for name, prefix, _ in PROJECTS:
        if not prefix.startswith('synth:'): ids[name] = resolve_id(objects, prefix)
    ids['wall-holder-question'] = synth_question(objects, ids['wall-holder'])
    ids['stove-gap-limit'] = synth_limit(objects, resolve_id(objects, '2f0a0229'))
    rewrite_paths(state, source)
    manifest = {'source': str(source), 'copiedAt': dt.datetime.now().isoformat(timespec='seconds'), 'ids': ids, 'copied': COPY}
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
    def __init__(self, state: Path, log_path: Path):
        dist = REPO / 'services/companion/dist'
        if not (dist / 'server-cli.js').exists():
            raise SystemExit('build the companion first: npm ci --ignore-scripts in packages/contracts, services/project, '
                             'services/printer-handoff, services/companion; then npm run build in packages/contracts and services/companion')
        self.log = open(log_path, 'w')
        self.proc = subprocess.Popen(['node', str(REPO / 'scripts/ux_screens/companion.mjs'), '--state', str(state), '--dist', str(dist)],
                                     stdout=subprocess.PIPE, stderr=self.log, text=True)
        line = self.proc.stdout.readline()
        if not line: raise SystemExit(f'companion did not start; see {log_path}')
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


# ---------------------------------------------------------------- screens

def screens(ids: dict, record: str, offline_record: str, fixtures: Path, offline_fixtures: Path) -> list[dict]:
    real = ['-CounterpartPairingRecord', record]
    def fixture(*more: str, folder: Path = fixtures, set_: str = 'all') -> list[str]:
        return ['-CounterpartFixtures', str(folder), '-CounterpartFixtureSet', set_, *more]
    out: list[dict] = []
    def add(name, screen, state, data, args, actions=(), pages=1, note=''):
        out.append({'name': name, 'screen': screen, 'state': state, 'data': data, 'args': args, 'actions': list(actions),
                    'pages': pages, 'note': note})
    # First run, on a fresh install: no pairing anywhere.
    add('first-run-welcome', 'First run: Welcome', 'not paired', 'none', [])
    add('first-run-pair', 'First run: Find your Mac', 'not paired', 'none', [], [['press', 'id="welcome-continue"']], pages=2)
    add('home', 'Home', 'all projects', 'real', real, pages=6)
    add('search', 'Home: search', 'typed "holder"', 'real', real,
        [['press', 'id="project-search"'], ['type', 'holder']], pages=2)
    add('new', 'New', 'nothing chosen', 'real', real + ['-CounterpartScreen', 'new'], pages=3)
    add('new-scan', 'New, after a scan', 'scan attached, no use chosen', 'real (scan faked)', real + ['-CounterpartScreen', 'new', '-CounterpartNewScan', 'walk-around'], pages=2)
    for use in ('copy', 'fit', 'later'):
        add(f'new-scan-{use}', f'New, after a scan: {use}', f'"{use}" chosen', 'real (scan faked)',
            real + ['-CounterpartScreen', 'new', '-CounterpartNewScan', 'walk-around'], [['press', f'id="scan-use-{use}"']], pages=2)
    for label in ('Measured', 'Scan'):
        add(f'new-scan-fit-{label.lower()}', f'New, after a scan: fit, size from {label.lower()}', f'fit, "{label}" size', 'real (scan faked)',
            real + ['-CounterpartScreen', 'new', '-CounterpartNewScan', 'walk-around'],
            [['press', 'id="scan-use-fit"'], ['press', f'label="{label}"']], pages=2)
    for name, _, state in PROJECTS:
        data = 'real (state synthesised)' if name in ('wall-holder-question', 'stove-gap-limit') else 'real'
        link = f'counterpart://project/{ids[name]}'
        add(f'project-{name}-result', 'Project: Result', state, data, real + ['-CounterpartOpen', link], pages=4)
        add(f'project-{name}-sent', 'Project: What you sent', state, data, real + ['-CounterpartOpen', link, '-CounterpartSection', 'inputs'], pages=4)
        add(f'project-{name}-activity', 'Project: Activity', state, data, real + ['-CounterpartOpen', link, '-CounterpartSection', 'activity'], pages=3)
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


class Device:
    def __init__(self, key: str, udid: str, out: Path, results: list):
        self.key, self.udid, self.out, self.results = key, udid, out, results
        self.session = f'ux-screens-{key}'

    def ad(self, *args: str, timeout: int = 90) -> dict:
        cmd = [AGENT_DEVICE, *args, '--udid', self.udid, '--session', self.session, '--json']
        run = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        try: reply = json.loads(run.stdout.strip().splitlines()[-1]) if run.stdout.strip() else {}
        except json.JSONDecodeError: reply = {'raw': run.stdout[-500:]}
        if run.returncode != 0:
            raise RuntimeError(f'agent-device {" ".join(args[:3])}: {(run.stderr or run.stdout)[-400:]}')
        return reply

    def shoot(self, item: dict) -> None:
        launch = []
        for value in item['args']: launch += [f'--launch-args={value}']
        self.ad('open', BUNDLE, '--relaunch', *launch, timeout=120)
        time.sleep(4)
        error = ''
        for action in item['actions']:
            try:
                if action[0] == 'type': self.ad('type', action[1])
                elif action[0] == 'home': self.ad('home')
                else: self.ad(action[0], action[1], '--settle')
                time.sleep(1.5)
            except Exception as failure:  # the screen is still captured, with what happened
                error = str(failure)
        for page in range(1, item['pages'] + 1):
            path = self.out / f'{item["name"]}-p{page}.png'
            self.ad('screenshot', str(path), '--pixel-density', '2', '--normalize-status-bar')
            self.results.append({**item, 'device': self.key, 'image': path, 'page': page, 'error': error})
            if page == item['pages']: break
            try: moved = self.ad('scroll', 'down', '0.7')
            except Exception: break
            if json.dumps(moved).find('"moved"') < 0 and json.dumps(moved).find('moved') < 0: break
            if any(word in json.dumps(moved) for word in ('"at-edge"', '"unchanged"')): break
            time.sleep(1)


def simctl(*args: str, check: bool = True) -> str:
    return subprocess.run(['xcrun', 'simctl', *args], capture_output=True, text=True, check=check).stdout.strip()


def build_app(work: Path) -> Path:
    derived = work / 'build'
    log('building the Debug app for the simulator')
    subprocess.run(['xcodebuild', 'build', '-project', str(REPO / 'apps/mobile/ios/ScanToMake.xcodeproj'), '-scheme', 'ScanToMake',
                    '-configuration', 'Debug', '-destination', 'generic/platform=iOS Simulator', '-derivedDataPath', str(derived),
                    'CODE_SIGN_IDENTITY=-', 'CODE_SIGN_STYLE=Manual', '-quiet'], check=True, stdout=open(work / 'xcodebuild.log', 'w'), stderr=subprocess.STDOUT)
    for app in (derived / 'Build/Products/Debug-iphonesimulator').glob('*.app'):
        info = subprocess.run(['/usr/libexec/PlistBuddy', '-c', 'Print :CFBundleIdentifier', str(app / 'Info.plist')], capture_output=True, text=True).stdout.strip()
        if info == BUNDLE: return app
    raise SystemExit('built app not found')


def run_devices(keys: list[str], items: list[dict], app: Path, out: Path, results: list, failures: list) -> None:
    created: dict[str, str] = {}
    try:
        for key in keys:
            name, kind, runtime, pose = DEVICES[key]
            base = 'duo' if pose else key
            if base not in created:
                udid = simctl('create', f'ux-screens-{base}-{os.getpid()}', kind, runtime)
                created[base] = udid
                simctl('boot', udid)
                simctl('bootstatus', udid, '-b')
                simctl('install', udid, str(app))
            udid = created[base]
            device = Device(key, udid, out / key, results)
            device.out.mkdir(parents=True, exist_ok=True)
            started = time.time()
            for setting in (['settings', 'permission', 'grant', 'notifications', '--app', BUNDLE], ['settings', 'appearance', 'light']):
                try: device.ad(*setting)
                except Exception as failure: failures.append((key, ' '.join(setting), str(failure)))
            if pose:
                try: device.ad('open', BUNDLE, '--relaunch', timeout=120); device.ad('fold', pose, timeout=120)
                except Exception as failure: failures.append((key, f'fold {pose}', str(failure)))
            for item in items:
                try:
                    if item['name'].startswith('first-run'):
                        device.ad('settings', 'clear-app-state', BUNDLE)
                    device.shoot(item)
                except Exception as failure:
                    failures.append((key, item['name'], str(failure)))
                    log(key, item['name'], 'FAILED', str(failure)[:200])
            log(key, f'done in {time.time() - started:.0f} s')
            try: device.ad('close')
            except Exception: pass
    finally:
        for udid in created.values():
            simctl('shutdown', udid, check=False)
            simctl('delete', udid, check=False)


def write_index(out: Path, results: list, failures: list, info: dict, manifest: dict, minutes: float, processes: list[str]) -> None:
    lines = ['# Counterpart screens', '',
             f'Made by `scripts/ux_screens.py` on {dt.datetime.now():%Y-%m-%d %H:%M} from commit '
             f'`{subprocess.run(["git", "-C", str(REPO), "rev-parse", "--short", "HEAD"], capture_output=True, text=True).stdout.strip()}`'
             f' ({minutes:.0f} min holding the simulator lock).', '',
             '**Data.** *real*: a copy of this Mac\'s projects (copied ' + manifest['copiedAt'] + '), served by the real companion '
             '(`server-cli.js`) to the real app client over http://127.0.0.1:9078. The pairing exchange was made by the script, not the pairing UI. '
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
        lines += [f'## {DEVICES[device][0]} (`{device}`)', '', '| Image | Screen | State | Data | Note |', '|---|---|---|---|---|']
        for r in (r for r in results if r['device'] == device):
            rel = r['image'].relative_to(out)
            note = '; '.join(x for x in [r['note'], f'page {r["page"]}' if r['page'] > 1 else '', f'action failed: {r["error"][:120]}' if r['error'] else ''] if x)
            lines.append(f'| [{rel}]({rel}) | {r["screen"]} | {r["state"]} | {r["data"]} | {note.replace("|", "/")} |')
        lines.append('')
    (out / 'index.md').write_text('\n'.join(lines))


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('out', type=Path)
    parser.add_argument('--work', type=Path, help='scratch: the data copy and build (default: <out>/../ux-screens-work)')
    parser.add_argument('--source', type=Path, default=REAL, help=argparse.SUPPRESS)
    parser.add_argument('--devices', default=','.join(DEVICES))
    parser.add_argument('--screens', default='', help='comma-separated substrings of screen names to keep')
    parser.add_argument('--prepare-only', action='store_true', help='copy the data, start the companion, check it, stop')
    args = parser.parse_args()
    out, work = args.out.resolve(), (args.work or args.out.resolve().parent / 'ux-screens-work').resolve()
    keys = [k for k in args.devices.split(',') if k]
    if any(k not in DEVICES for k in keys): raise SystemExit(f'devices: {", ".join(DEVICES)}')
    if REAL in work.parents or work == REAL or REAL in out.parents: raise SystemExit('the work and out folders must be outside the real state')
    out.mkdir(parents=True, exist_ok=True); work.mkdir(parents=True, exist_ok=True)

    data = work / 'data'
    manifest = json.loads((data / 'manifest.json').read_text()) if (data / 'manifest.json').exists() else prepare(args.source.resolve(), data)
    state, ids = data / 'state', manifest['ids']
    fixtures, offline = work / 'fixtures', work / 'fixtures-offline'
    fixture_assets(state, ids, fixtures)
    fixture_assets(state, ids, offline); (offline / 'offline').write_text('')
    log('starting the companion on the copy')
    companion = Companion(state, work / 'companion.log')
    try:
        info = companion.info
        served = {o['id'] for o in info['objects']}
        missing = [name for name, _, _ in PROJECTS if ids[name] not in served]
        if info.get('objectsStatus') != 200 or missing: raise SystemExit(f'companion is missing projects {missing} (status {info.get("objectsStatus")})')
        time.sleep(6)  # the companion reads its printer MCPs 5 s after start: check what it started
        processes = companion.processes()
        if any(re.search(r'\bssh\b|bambu|mcp-3d|printer-mcp', p, re.I) for p in processes): raise SystemExit(f'companion started {processes}')
        log(f'companion serves {len(served)} projects; children: {processes}')
        record = json.dumps(info['record'])
        offline_record = json.dumps({**info['record'], 'baseUrl': 'https://127.0.0.1:9079'})
        if args.prepare_only:
            for o in info['objects']: print(f"  {o['id'][:8]}  {o['state']:<14} {o['title']}")
            return
        items = screens(ids, record, offline_record, fixtures, offline)
        if args.screens: items = [i for i in items if any(s in i['name'] for s in args.screens.split(','))]
        results, failures = [], []
        with open(LOCK, 'a') as handle:
            try: fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                log(f'waiting for {LOCK}'); fcntl.flock(handle, fcntl.LOCK_EX)
            locked = time.time()
            log('holding the simulator lock')
            app = build_app(work)
            run_devices(keys, items, app, out, results, failures)
            minutes = (time.time() - locked) / 60
        log(f'released the lock after {minutes:.1f} min')
        write_index(out, results, failures, info, manifest, minutes, processes)
        log(f'{len(results)} images, {len(failures)} not captured: {out / "index.md"}')
        log(f'the copy of the projects is in {data}; move {work} to /Volumes/Spillover when done')
    finally:
        companion.stop()


if __name__ == '__main__':
    main()
