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
live owner, so a killed caller's files are recognised as stale and blocks no one. A waiter that stops before its
turn (a signal, or killed outright: a T3 restart cancelled every queued hold on Nov 10, #703) is kept in
~/.stm-lane/cancelled, and --status lists it until the same label is queued again from the same folder, or for
CANCELLED_KEEP_HOURS.

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
CANCELLED_KEEP_HOURS = 24


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
        self.path = folder / name
        self.handle = self._publish(data)

    def _publish(self, data):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        temporary = self.path.parent / ('.tmp-' + str(os.getpid()) + '-' + str(time.time_ns()))
        handle = temporary.open('w+')
        try_lock(handle, blocking=True)  # Nobody else knows the name yet: immediate.
        handle.write(json.dumps(data)); handle.flush()
        os.rename(temporary, self.path)  # Appears already locked, so no reader sees it as stale.
        return handle

    def replace(self, data):
        """Swap in a new description atomically; the old file was unlinked by the rename, so just close it."""
        old = self.handle
        self.handle = self._publish(data)
        old.close()

    def close(self):
        with contextlib.suppress(FileNotFoundError):
            self.path.unlink()
        self.handle.close()


def live_records(folder, cancelled=None):
    """Records whose owner still holds them, oldest name first; stale ones are removed (into `cancelled`, if given:
    a queue ticket left behind by a killed waiter)."""
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
                    # No links left means its owner removed it on the way out (it got its turn, or recorded its own
                    # cancellation) between our open and our lock: not a cancellation.
                    if cancelled is not None and os.fstat(handle.fileno()).st_nlink:
                        with contextlib.suppress(json.JSONDecodeError):
                            record_cancelled(cancelled, path.name, json.loads(handle.read() or '{}'),
                                             'its process ended without leaving the queue (killed, or its session restarted)')
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


def write_json(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.parent / ('.tmp-' + str(os.getpid()) + '-' + str(time.time_ns()))
    temporary.write_text(json.dumps(data))
    os.rename(temporary, path)


def record_cancelled(folder, name, data, how):
    """Keep what a waiter had queued, so whoever queued it (a restarted session) can see it and queue it again."""
    data = {k: v for k, v in data.items() if not k.startswith('_')}
    data.update(endedAt=time.time(), how=how)
    write_json(folder / name, data)


def cancelled_records(folder, now=None):
    """Cancelled waiters, oldest first; ones older than CANCELLED_KEEP_HOURS are deleted."""
    now = time.time() if now is None else now
    found = []
    if not folder.is_dir():
        return found
    for path in sorted(folder.iterdir()):
        if path.name.startswith('.'):
            if time.time() - _mtime(path) > 60:
                with contextlib.suppress(FileNotFoundError):
                    path.unlink()
            continue
        try:
            data = json.loads(path.read_text() or '{}')
        except (FileNotFoundError, json.JSONDecodeError):
            data = {}
        if now - float(data.get('endedAt', 0)) > CANCELLED_KEEP_HOURS * 3600:
            with contextlib.suppress(FileNotFoundError):
                path.unlink()
            continue
        data['_name'] = path.name
        found.append(data)
    return found


def forget_cancelled(folder, label, cwd):
    """Queued again from the same folder: the earlier cancellation is answered."""
    for entry in cancelled_records(folder):
        if entry.get('label') == label and entry.get('cwd') == cwd:
            with contextlib.suppress(FileNotFoundError):
                (folder / entry['_name']).unlink()


def _cwd():
    try:
        return os.getcwd()
    except OSError:
        return None


def enqueue(state, info):
    """Number a ticket and publish it under the sequence lock, so number order is the order tickets appear."""
    state.mkdir(parents=True, exist_ok=True)
    forget_cancelled(state / 'cancelled', info.get('label'), info.get('cwd'))
    with (state / 'sequence').open('a+') as handle:
        try_lock(handle, blocking=True)
        handle.seek(0)
        number = int(handle.read().strip() or 0) + 1
        handle.seek(0); handle.truncate(); handle.write(str(number)); handle.flush()
        info['ticket'] = number
        return Record(state / 'queue', '%012d-%d.json' % (number, os.getpid()), info)


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
    waiters = live_records(state / 'queue', state / 'cancelled')
    cancelled = cancelled_records(state / 'cancelled', now)
    for entry in holders + waiters:
        entry['ageSeconds'] = round(now - entry['since'])
    for entry in cancelled:
        entry['endedSecondsAgo'] = round(now - entry['endedAt'])
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
    return {'slots': rows, 'holders': holders, 'waiters': waiters, 'cancelled': cancelled}


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
            if holder.get('acquiring'):
                text += ', waiting for the other slot'
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
    if report.get('cancelled'):
        lines.append('stopped while waiting, never ran (queue again if still needed; listed for %dh):' % CANCELLED_KEEP_HOURS)
        for entry in report['cancelled']:
            where = ' in ' + entry['cwd'] if entry.get('cwd') else ''
            thread = ' (T3 thread ' + entry['thread'] + ')' if entry.get('thread') else ''
            command = '\n       ' + ' '.join(entry['command']) if entry.get('command') else ''
            lines.append('  pid %s%s "%s"%s%s, queued %s before it stopped, %s ago: %s%s' % (
                entry.get('pid'), ' [exclusive]' if entry.get('exclusive') else '', entry.get('label'), where, thread,
                _age(entry['endedAt'] - entry.get('since', entry['endedAt'])), _age(entry['endedSecondsAgo']),
                entry.get('how'), command))
    return '\n'.join(lines)


@contextlib.contextmanager
def hold(label, exclusive=False, max_minutes=DEFAULT_MAX_MINUTES, log=None, command=None):
    """Wait in line, take one slot (or both if exclusive), and keep them until the block ends. `command` (a list) is
    only described: it is shown if this waiter is stopped before its turn."""
    log = log or (lambda text: print(text, file=sys.stderr, flush=True))
    slots, state = paths()
    for slot in slots:
        slot.parent.mkdir(parents=True, exist_ok=True)
    handles = [slot.open('a+') for slot in slots]
    held = []
    record = None
    info = {'pid': os.getpid(), 'label': label, 'exclusive': exclusive, 'maxMinutes': max_minutes, 'since': time.time(),
            'cwd': _cwd(), 'thread': os.environ.get('T3CODE_THREAD_ID') or None}
    if command:
        info['command'] = [str(part) for part in command]
    ticket = enqueue(state, info)
    holder_name = ticket.path.name

    def describe_holding(acquiring):
        return dict(info, slots=sorted(i + 1 for i in held), since=time.time(), acquiring=acquiring)
    announced = False
    try:
        while True:  # Wait until this ticket is the oldest live one.
            waiters = live_records(state / 'queue', state / 'cancelled')
            if not waiters or waiters[0]['_name'] == ticket.path.name:
                break
            if not announced:
                log('lane: waiting behind %d caller(s).\n%s' % (len(waiters) - 1, describe(status()))); announced = True
            time.sleep(poll_seconds())
        while not held:  # Take whichever slot frees first (slot 2 first, leaving slot 1 to direct lockf callers).
            for index in (1, 0):
                if try_lock(handles[index]):
                    held.append(index); break
            else:
                if not announced:
                    log('lane: waiting for %s.\n%s' % ('both slots' if exclusive else 'a free slot', describe(status())))
                    announced = True
                time.sleep(poll_seconds())
        if exclusive:
            other = 1 - held[0]
            if not try_lock(handles[other]):
                # Say who holds the first slot, then block in the kernel for the other. Lane callers are queued
                # behind this ticket; blocking (not polling) keeps its turn among direct lockf callers, which block too.
                record = Record(state / 'holders', holder_name, describe_holding(True))
                if not announced:
                    log('lane: waiting for both slots.\n' + describe(status())); announced = True
                try_lock(handles[other], blocking=True)
            held.append(other)
        info = describe_holding(False)
        if record:
            record.replace(info)
        else:
            record = Record(state / 'holders', holder_name, info)
        ticket.close(); ticket = None
        if announced:
            log('lane: got slot %s for "%s".' % (' and '.join(str(s) for s in info['slots']), label))
        yield info
    except BaseException as stopped:
        if ticket:  # Stopped while still waiting for its turn: say so where a restarted session will look.
            with contextlib.suppress(OSError):
                record_cancelled(state / 'cancelled', ticket.path.name, info, _why(stopped))
        raise
    finally:
        if ticket:
            ticket.close()
        if record:
            record.close()
        for handle in handles:
            handle.close()  # Closing releases the flock.


def _why(stopped):
    if isinstance(stopped, SystemExit) and isinstance(stopped.code, int) and stopped.code > 128:
        try:
            return 'stopped by ' + signal.Signals(stopped.code - 128).name + ' while waiting'
        except ValueError:
            pass
    if isinstance(stopped, KeyboardInterrupt):
        return 'interrupted while waiting'
    return 'stopped while waiting: ' + (type(stopped).__name__ + ' ' + str(stopped)).strip()


def nested_holder():
    """The pid of a live lane holder this process runs under, if any (so nested calls don't deadlock)."""
    value = os.environ.get(HELD_ENV, '')
    if not value.isdigit():
        return None
    _, state = paths()
    if any(h['pid'] == int(value) for h in live_records(state / 'holders')):
        return int(value)
    return None


def exit_code(code):
    return 128 - code if code < 0 else code


def run(command, label, exclusive, max_minutes, output=None):
    """Run command in the lane. With output, the command's stdout and stderr go to that file, while the
    lane's own messages (who holds it, who is waiting) stay on this process's stderr."""
    sink = open(output, 'w') if output else None
    try:
        return _run(command, label, exclusive, max_minutes, sink)
    finally:
        if sink:
            sink.close()


def _run(command, label, exclusive, max_minutes, sink):
    if nested_holder():
        return exit_code(subprocess.call(command, stdout=sink, stderr=sink))
    child = None
    def forward(signum, frame):
        if child and child.poll() is None:
            child.send_signal(signum)
        else:
            raise SystemExit(128 + signum)
    for signum in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
        signal.signal(signum, forward)
    with hold(label, exclusive, max_minutes, command=command):
        child = subprocess.Popen(command, env=dict(os.environ, **{HELD_ENV: str(os.getpid())}), stdout=sink, stderr=sink)
        code = child.wait()
    return exit_code(code)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--status', action='store_true', help='print holders and waiters with their ages')
    parser.add_argument('--json', action='store_true', help='with --status: print JSON')
    parser.add_argument('--exclusive', action='store_true', help='take both slots')
    parser.add_argument('--label', help='who and what, shown by --status')
    parser.add_argument('--max-minutes', type=float, default=DEFAULT_MAX_MINUTES,
                        help='how long the hold should take; longer is reported as overdue (default 10)')
    parser.add_argument('--output', help="write the command's stdout and stderr to this file (lane messages stay on stderr)")
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
    return run(command, label, args.exclusive, args.max_minutes, args.output)


if __name__ == '__main__':
    sys.exit(main())
