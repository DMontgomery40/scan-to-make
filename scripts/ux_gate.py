#!/usr/bin/env python3
"""The bad-day gate for a train (docs/operations.md, "Waiting, failed and empty are screens too"; board X76).

Every project page of a fresh copy of this Mac's projects, on the iPhone and the iPad, with the Mac slow, refusing files
and gone away, through the blank check. One command; it takes several exclusive lane holds (each at most --max-minutes,
queued in turn with everyone else) and resumes where it stopped if run again with the same folder.

    python3 scripts/ux_gate.py ~/scan-to-make-work/gate-<train> [--devices iphone,ipad] [--conditions slow,refusing,away]

Writes <folder>/gate.md: every flagged frame with its device, condition and project, and every device and condition
that captured fewer frames than the screens it was asked for, or whose hold ended with an error. Exits 1 when any frame
is blank (a stage or picture with nothing drawn and nothing said, or the app not on screen), 2 when a capture could not
finish (a screen without a frame, or a hold that failed: train 2026-11-14's iPhone `slow` captured nothing and this
gate still said every capture finished, #806), 0 only when every screen has a frame and every page passed.
"""
from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent


BLANK_EXIT = re.compile(r'frames show a blank stage or picture')  # ux_screens.py's exit when frames are blank


def hold_error(code: int, text: str) -> str:
    """Why a hold failed, or '' when it ran: exit 0, or the blank check's exit (its frames are read below)."""
    if code == 0 or BLANK_EXIT.search(text):
        return ''
    # The last line that says why: ux_screens.py's own closing line only points back at the lines above it.
    lines = [line for line in text.strip().splitlines() if line.strip() and 'see the lines above' not in line]
    return f'exit {code}: ' + (lines[-1][:300] if lines else 'no output')


def shortfall(out: Path) -> tuple[int, int | None, list[str]]:
    """(screens with a frame, screens asked for or None when no hold got as far as asking, the screens without one),
    from what ux_screens.py wrote in <out>: asked.json, and results.jsonl rows whose image is on disk."""
    asked_path = out / 'asked.json'
    if not asked_path.exists():
        return 0, None, []
    asked = [(s['device'], s['name']) for s in json.loads(asked_path.read_text())['screens']]
    rows = [json.loads(line) for line in (out / 'results.jsonl').read_text().splitlines() if line.strip()] \
        if (out / 'results.jsonl').exists() else []
    framed = {(r['device'], r['name']) for r in rows if Path(r['image']).exists()}
    missing = [f'{d}/{n}' for d, n in asked if (d, n) not in framed]
    return len(asked) - len(missing), len(asked), missing


def run_until_done(out: Path, work: Path, device: str, condition: str, max_minutes: float, holds: int) -> list[str]:
    """ux_screens.py holds for one device and condition until every screen it is asked for has a frame. Returns what
    went wrong: each failed hold, and the screens left without a frame; empty only when every screen has one."""
    errors: list[str] = []
    for hold in range(1, holds + 1):
        run = subprocess.run([sys.executable, str(REPO / 'scripts/ux_screens.py'), str(out), '--work', str(work),
                              '--devices', device, '--condition', condition, '--project', 'all', '--screens', 'result',
                              '--pages', '1', '--max-minutes', str(max_minutes)], capture_output=True, text=True)
        text = run.stdout + run.stderr
        (out.parent / f'{out.name}-hold{hold}.log').write_text(text)
        if why := hold_error(run.returncode, text):
            errors.append(f'hold {hold} failed ({out.name}-hold{hold}.log): {why}')
            break  # a hold that failed (a dead device session, a build that broke) fails the same way again
        framed, asked, _ = shortfall(out)
        if asked is not None and framed == asked:
            break
    framed, asked, missing = shortfall(out)
    if asked is None:
        errors.append('no frames: no hold got as far as choosing the screens')
    elif framed < asked:
        errors.append(f'{framed} of {asked} screens captured; without a frame: {", ".join(missing[:10])}'
                      + (f' and {len(missing) - 10} more' if len(missing) > 10 else ''))
    for error in errors:
        print(f'{device} {condition}: {error}', file=sys.stderr)
    return errors


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('folder', type=Path)
    parser.add_argument('--devices', default='iphone,ipad')
    parser.add_argument('--conditions', default='slow,refusing,away')
    parser.add_argument('--max-minutes', type=float, default=10)
    parser.add_argument('--holds', type=int, default=4, help='at most this many holds per device and condition')
    args = parser.parse_args()
    folder = args.folder.resolve()
    folder.mkdir(parents=True, exist_ok=True)
    sys.path.insert(0, str(REPO / 'scripts'))
    import ux_blank
    flagged, unfinished = [], []
    for device in args.devices.split(','):
        for condition in args.conditions.split(','):
            out = folder / f'{device}-{condition}'
            unfinished += [(device, condition, why) for why in
                           run_until_done(out, folder / 'work', device, condition, args.max_minutes, args.holds)]
            if out.exists():
                flagged += [(device, condition, png, problems) for png, problems in ux_blank.check_folder(out)]
    verdict = ('FAILED' if flagged or unfinished else 'Passed') + (
        f': {len({(d, c) for d, c, _ in unfinished})} device and condition pairs did not capture every screen they were asked for; '
        'a screen without a frame is a screen nobody checked.' if unfinished else ': every screen they were asked for was captured.')
    lines = ['# Bad-day gate', '', f'**{verdict}** Devices: {args.devices}. Conditions: {args.conditions}. '
             f'{len(flagged)} blank frames.', '']
    if unfinished:
        lines += ['## Not captured', '', '| Device | Condition | What went wrong |', '|---|---|---|']
        lines += [f'| {d} | {c} | {w.replace("|", "/").replace(chr(10), " ")} |' for d, c, w in unfinished]
        lines += ['']
    lines += ['## Blank frames', '', '| Device | Condition | Frame | What is wrong |', '|---|---|---|---|']
    lines += [f'| {d} | {c} | [{p.relative_to(folder)}]({p.relative_to(folder)}) | {"; ".join(w).replace("|", "/")} |'
              for d, c, p, w in flagged]
    (folder / 'gate.md').write_text('\n'.join(lines) + '\n')
    print(f'{verdict} {len(flagged)} blank frames: {folder / "gate.md"}')
    return 1 if flagged else (2 if unfinished else 0)

if __name__ == '__main__':
    sys.exit(main())
