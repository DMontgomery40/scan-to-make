#!/usr/bin/env python3
"""The bad-day gate for a train (docs/operations.md, "Waiting, failed and empty are screens too"; board X76).

Every project page of a fresh copy of this Mac's projects, on the iPhone and the iPad, with the Mac slow, refusing files
and gone away, through the blank check. One command; it takes several exclusive lane holds (each at most --max-minutes,
queued in turn with everyone else) and resumes where it stopped if run again with the same folder.

    python3 scripts/ux_gate.py ~/scan-to-make-work/gate-<train> [--devices iphone,ipad] [--conditions slow,refusing,away]

Writes <folder>/gate.md: every flagged frame with its device, condition and project, and exits 1 when any frame is
blank (a stage or picture with nothing drawn and nothing said, or the app not on screen), 2 when a capture could not
finish, 0 when every page passed.
"""
from __future__ import annotations

import argparse
import re
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent


def run_until_done(out: Path, work: Path, device: str, condition: str, max_minutes: float, holds: int) -> bool:
    """ux_screens.py holds for one device and condition until no screen is left. False when it could not finish."""
    for hold in range(1, holds + 1):
        run = subprocess.run([sys.executable, str(REPO / 'scripts/ux_screens.py'), str(out), '--work', str(work),
                              '--devices', device, '--condition', condition, '--project', 'all', '--screens', 'result',
                              '--pages', '1', '--max-minutes', str(max_minutes)], capture_output=True, text=True)
        text = run.stdout + run.stderr
        (out.parent / f'{out.name}-hold{hold}.log').write_text(text)
        if re.search(r' 0 screens left|every screen is captured', text):
            return True
        if re.search(r'captured no screens|did not start|is not built|Traceback|Unknown', text):
            print(f'{device} {condition}: the capture stopped: {text.strip().splitlines()[-1][:300]}', file=sys.stderr)
            return False
    print(f'{device} {condition}: screens still left after {holds} holds', file=sys.stderr)
    return False


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
    finished, flagged = True, []
    for device in args.devices.split(','):
        for condition in args.conditions.split(','):
            out = folder / f'{device}-{condition}'
            finished &= run_until_done(out, folder / 'work', device, condition, args.max_minutes, args.holds)
            if out.exists():
                flagged += [(device, condition, png, problems) for png, problems in ux_blank.check_folder(out)]
    lines = ['# Bad-day gate', '', f'Devices: {args.devices}. Conditions: {args.conditions}. '
             f'{"Every capture finished." if finished else "Some captures did not finish; see the hold logs."} '
             f'{len(flagged)} blank frames.', '', '| Device | Condition | Frame | What is wrong |', '|---|---|---|---|']
    lines += [f'| {d} | {c} | [{p.relative_to(folder)}]({p.relative_to(folder)}) | {"; ".join(w).replace("|", "/")} |'
              for d, c, p, w in flagged]
    (folder / 'gate.md').write_text('\n'.join(lines) + '\n')
    print(f'{len(flagged)} blank frames; {"all captures finished" if finished else "captures unfinished"}: {folder / "gate.md"}')
    return 1 if flagged else (0 if finished else 2)


if __name__ == '__main__':
    sys.exit(main())
