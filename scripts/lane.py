#!/usr/bin/env python3
"""The Mac's build lane: two slots for xcodebuild and simulator work, taken in arrival order.

  python3 scripts/lane.py [--exclusive] [--label "<who and what>"] [--max-minutes N] -- <command...>
  python3 scripts/lane.py --status [--json]

A normal caller takes whichever slot is free. --exclusive takes both: the gate's iPhone/iPad UI test job
and anything that starts a print. Callers wait in one queue in arrival order, so a waiting exclusive
caller is not overtaken by normal callers that arrive after it.

Slot 1 is ~/.stm-ios.lock, so `/usr/bin/lockf -k ~/.stm-ios.lock <command>` still excludes one slot.
Slot 2 is ~/.stm-ios-2.lock. The kernel locks (flock(2) on those files) are the truth. Queue tickets
(~/.stm-lane/queue) and holder records (~/.stm-lane/holders) only describe them; each is flock'ed by its
live owner, so a killed caller's files are recognised as stale and blocks no one.

Python 3.9 standard library only. Paths can be overridden for tests: STM_LANE_SLOT1 (or STM_IOS_LOCK),
STM_LANE_SLOT2, STM_LANE_DIR; when only slot 1 is overridden, slot 2 and the state folder sit beside it.
"""
import argparse
import contextlib
import fcntl
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import time

DEFAULT_MAX_MINUTES = 10
HELD_ENV = 'STM_LANE_HELD'


def paths():
    slot1 = Path(os.environ.get('STM_LANE_SLOT1') or os.environ.get('STM_IOS_LOCK') or Path.home() / '.stm-ios.lock')
    slot2 = Path(os.environ.get('STM_LANE_SLOT2') or slot1.with_name(slot1.stem + '-2' + slot1.suffix))
    state = Path(os.environ.get('STM_LANE_DIR') or slot1.parent / '.stm-lane')
    return [slot1, slot2], state


def poll_seconds():
    return float(os.environ.get('STM_LANE_POLL', '0.25'))


def try_lock(handle, blocking=False):
    try:
        fcntl.flock(handle, fcntl.LOCK_EX | (0 if blocking else fcntl.LOCK_NB))
        return True
    except BlockingIOError:
        return False


def pid_alive(pid):
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


class Record:
    """A small JSON file its owner keeps flock'ed for as long as it lives (a queue ticket or a holder record)."""

    def __init__(self, folder, name, data):
        folder.mkdir(parents=True, exist_ok=True)
        temporary = folder / ('.tmp-' + str(os.getpid()) + '-' + str(time.time_ns()))
        self.handle = temporary.open('w+')
        try_lock(self.handle, blocking=True)  # Nobody else knows the name yet: immediate.
        self.handle.write(json.dumps(data)); self.handle.flush()
        self.path = folder / name
        os.rename(temporary, self.path)  # Appears already locked, so no reader sees it as stale.

    def close(self):
        with contextlib.suppress(FileNotFoundError):
            self.path.unlink()
        self.handle.close()


def live_records(folder):
    """Records whose owner still holds them, oldest name first; stale ones are removed."""
    found = []
    if not folder.is_dir():
        return found
    for path in sorted(folder.iterdir()):
        if path.name.startswith('.'):
            if path.name.startswith('.tmp-') and time.time() - _mtime(path) > 60:
                _remove_if_unlocked(path)
            continue
        try:
            with path.open() as handle:
                if try_lock(handle):  # Its owner is gone: the description is stale.
                    with contextlib.suppress(FileNotFoundError):
                        path.unlink()
                    continue
                data = json.loads(handle.read() or '{}')
        except (FileNotFoundError, json.JSONDecodeError):
            continue
        if not pid_alive(int(data.get('pid', 0))):
            continue
        data['_name'] = path.name
        found.append(data)
    return found


def _mtime(path):
    try:
        return path.stat().st_mtime
    except FileNotFoundError:
        return time.time()


def _remove_if_unlocked(path):
    with contextlib.suppress(FileNotFoundError), path.open() as handle:
        if try_lock(handle):
            path.unlink()


def next_ticket_number(state):
    state.mkdir(parents=True, exist_ok=True)
    with (state / 'sequence').open('a+') as handle:
        try_lock(handle, blocking=True)
        handle.seek(0)
        number = int(handle.read().strip() or 0) + 1
        handle.seek(0); handle.truncate(); handle.write(str(number)); handle.flush()
    return number


def legacy_holder(slot):
    """ci_local.py before the lane wrote 'pid label since HH:MM:SS' into slot 1; show it if present."""
    try:
        return slot.read_text().strip()
    except OSError:
        return ''


def slot_held(slot):
    """Probe one slot without keeping it (a momentary flock; a held slot is left untouched)."""
    try:
        with slot.open('a+') as handle:
            if try_lock(handle):
                return False
            return True
    except OSError:
        return False


def status(now=None):
    now = time.time() if now is None else now
    slots, state = paths()
    holders = live_records(state / 'holders')
    waiters = live_records(state / 'queue')
    for entry in holders + waiters:
        entry['ageSeconds'] = round(now - entry['since'])
    for entry in holders:
        entry['overdue'] = now - entry['since'] > 60 * entry['maxMinutes']
    rows = []
    for number, slot in enumerate(slots, 1):
        owner = next((h for h in holders if number in h['slots']), None)
        held = slot_held(slot) if owner is None else True
        row = {'slot': number, 'path': str(slot), 'held': held, 'holder': owner}
        if held and owner is None:
            row['unrecorded'] = legacy_holder(slot) or 'a process outside the lane (a direct lockf?)'
        rows.append(row)
    return {'slots': rows, 'holders': holders, 'waiters': waiters}


def _age(seconds):
    minutes, seconds = divmod(int(seconds), 60)
    return '%dm%02ds' % (minutes, seconds) if minutes else '%ds' % seconds


def describe(report):
    lines = []
    for row in report['slots']:
        holder = row['holder']
        if holder:
            text = ('held %s by pid %s%s "%s" (max %sm)' % (
                _age(holder['ageSeconds']), holder['pid'], ' [exclusive]' if holder['exclusive'] else '',
                holder['label'], holder['maxMinutes']))
            if holder['overdue']:
                text += ' OVERDUE by ' + _age(holder['ageSeconds'] - 60 * holder['maxMinutes'])
        elif row['held']:
            text = 'held by ' + row['unrecorded']
        else:
            text = 'free'
        lines.append('slot %d (%s): %s' % (row['slot'], row['path'], text))
    if report['waiters']:
        lines.append('waiting, in order:')
        for index, waiter in enumerate(report['waiters'], 1):
            lines.append('  %d. pid %s%s "%s" for %s' % (index, waiter['pid'], ' [exclusive]' if waiter['exclusive'] else '',
                                                        waiter['label'], _age(waiter['ageSeconds'])))
    else:
        lines.append('nobody waiting')
    return '\n'.join(lines)


@contextlib.contextmanager
def hold(label, exclusive=False, max_minutes=DEFAULT_MAX_MINUTES, log=None):
    """Wait in line, take one slot (or both if exclusive), and keep them until the block ends."""
    log = log or (lambda text: print(text, file=sys.stderr, flush=True))
    slots, state = paths()
    for slot in slots:
        slot.parent.mkdir(parents=True, exist_ok=True)
    handles = [slot.open('a+') for slot in slots]
    held = []
    record = None
    number = next_ticket_number(state)
    info = {'pid': os.getpid(), 'label': label, 'exclusive': exclusive, 'maxMinutes': max_minutes,
            'since': time.time(), 'ticket': number}
    ticket = Record(state / 'queue', '%012d-%d.json' % (number, os.getpid()), info)
    announced = False
    try:
        while True:  # Wait until this ticket is the oldest live one.
            waiters = live_records(state / 'queue')
            if not waiters or waiters[0]['_name'] == ticket.path.name:
                break
            if not announced:
                log('lane: waiting behind %d caller(s).\n%s' % (len(waiters) - 1, describe(status()))); announced = True
            time.sleep(poll_seconds())
        if exclusive:
            for index in (1, 0):  # Block in the kernel: everyone else is queued behind this ticket.
                if not try_lock(handles[index]):
                    if not announced:
                        log('lane: waiting for both slots.\n' + describe(status())); announced = True
                    try_lock(handles[index], blocking=True)
                held.append(index)
        else:
            while not held:
                for index in (1, 0):  # Slot 2 first, leaving slot 1 to callers still using lockf directly.
                    if try_lock(handles[index]):
                        held.append(index); break
                else:
                    if not announced:
                        log('lane: waiting for a free slot.\n' + describe(status())); announced = True
                    time.sleep(poll_seconds())
        info = dict(info, slots=sorted(i + 1 for i in held), since=time.time())
        record = Record(state / 'holders', '%012d-%d.json' % (number, os.getpid()), info)
        ticket.close(); ticket = None
        if announced:
            log('lane: got slot %s for "%s".' % (' and '.join(str(s) for s in info['slots']), label))
        yield info
    finally:
        if ticket:
            ticket.close()
        if record:
            record.close()
        for handle in handles:
            handle.close()  # Closing releases the flock.


def nested_holder():
    """The pid of a live lane holder this process runs under, if any (so nested calls don't deadlock)."""
    value = os.environ.get(HELD_ENV, '')
    if not value.isdigit():
        return None
    _, state = paths()
    if any(h['pid'] == int(value) for h in live_records(state / 'holders')):
        return int(value)
    return None


def run(command, label, exclusive, max_minutes):
    if nested_holder():
        return subprocess.call(command)
    child = None
    def forward(signum, frame):
        if child and child.poll() is None:
            child.send_signal(signum)
        else:
            raise SystemExit(128 + signum)
    for signum in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
        signal.signal(signum, forward)
    with hold(label, exclusive, max_minutes):
        child = subprocess.Popen(command, env=dict(os.environ, **{HELD_ENV: str(os.getpid())}))
        code = child.wait()
    return 128 - code if code < 0 else code


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--status', action='store_true', help='print holders and waiters with their ages')
    parser.add_argument('--json', action='store_true', help='with --status: print JSON')
    parser.add_argument('--exclusive', action='store_true', help='take both slots')
    parser.add_argument('--label', help='who and what, shown by --status')
    parser.add_argument('--max-minutes', type=float, default=DEFAULT_MAX_MINUTES,
                        help='how long the hold should take; longer is reported as overdue (default 10)')
    parser.add_argument('command', nargs=argparse.REMAINDER)
    args = parser.parse_args(argv)
    if args.status:
        report = status()
        print(json.dumps(report, indent=2) if args.json else describe(report))
        return 0
    command = args.command[1:] if args.command[:1] == ['--'] else args.command
    if not command:
        parser.error('give a command after --')
    label = args.label or ' '.join(command)[:120]
    return run(command, label, args.exclusive, args.max_minutes)


if __name__ == '__main__':
    sys.exit(main())
