import lane_isolation  # noqa: F401  (first: no test may reach the real build lane)
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import unittest

LANE = Path(__file__).resolve().parents[1] / 'lane.py'
# The command each caller runs: note when it started, then hold until the test releases it.
HOLD = ('import pathlib,sys,time\n'
        'folder=pathlib.Path(sys.argv[1]); name=sys.argv[2]\n'
        '(folder/("started-"+name)).touch()\n'
        'while not (folder/("release-"+name)).exists(): time.sleep(0.02)\n')


class LaneTests(unittest.TestCase):
    """Every test uses temporary slot files: never the real ~/.stm-ios.lock."""

    def setUp(self):
        self.folder = Path(tempfile.mkdtemp())
        self.env = {k: v for k, v in os.environ.items() if not k.startswith(('STM_LANE', 'STM_IOS'))}
        self.env.update(STM_LANE_SLOT1=str(self.folder / 'slot1.lock'), STM_LANE_SLOT2=str(self.folder / 'slot2.lock'),
                        STM_LANE_DIR=str(self.folder / 'lane'), STM_LANE_POLL='0.05')
        self.children = []

    def tearDown(self):
        for child in self.children:
            if child.poll() is None:
                with self._suppress():
                    os.killpg(child.pid, signal.SIGKILL)
                child.wait()
        shutil.rmtree(self.folder, ignore_errors=True)

    @staticmethod
    def _suppress():
        import contextlib
        return contextlib.suppress(ProcessLookupError)

    def caller(self, name, *flags):
        child = subprocess.Popen([sys.executable, str(LANE), '--label', name, *flags, '--',
                                  sys.executable, '-c', HOLD, str(self.folder), name],
                                 env=self.env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
        self.children.append(child)
        return child

    def started(self, name):
        return (self.folder / ('started-' + name)).exists()

    def release(self, name):
        (self.folder / ('release-' + name)).touch()

    def wait_for(self, predicate, what, timeout=10):
        end = time.monotonic() + timeout
        while time.monotonic() < end:
            if predicate():
                return
            time.sleep(0.02)
        self.fail('timed out waiting for ' + what + '\n' + self.status_text())

    def stays_false(self, predicate, seconds=0.6):
        end = time.monotonic() + seconds
        while time.monotonic() < end:
            if predicate():
                return False
            time.sleep(0.02)
        return True

    def status(self):
        done = subprocess.run([sys.executable, str(LANE), '--status', '--json'], env=self.env, capture_output=True, text=True, check=True)
        return json.loads(done.stdout)

    def status_text(self):
        return subprocess.run([sys.executable, str(LANE), '--status'], env=self.env, capture_output=True, text=True).stdout

    def queued(self, name):
        """Wait until `name` is in the queue, so the next caller arrives after it."""
        self.wait_for(lambda: name in [w['label'] for w in self.status()['waiters']], name + ' in the queue')

    def hold_both_slots(self):
        self.caller('a'); self.caller('b')
        self.wait_for(lambda: self.started('a') and self.started('b'), 'two normal holders')

    def test_two_normal_callers_hold_at_once_and_a_third_waits(self):
        self.hold_both_slots()
        third = self.caller('c')
        self.queued('c')
        self.assertTrue(self.stays_false(lambda: self.started('c')), 'a third caller ran beside two holders')
        report = self.status()
        self.assertEqual(sorted(h['label'] for h in report['holders']), ['a', 'b'])
        self.assertEqual(sorted(s['holder']['label'] for s in report['slots']), ['a', 'b'])
        self.release('a')
        self.wait_for(lambda: self.started('c'), 'the third caller after a slot freed')
        self.release('b'); self.release('c')
        self.assertEqual(third.wait(10), 0)

    def test_exclusive_waits_for_both_slots_then_excludes_everyone(self):
        self.hold_both_slots()
        exclusive = self.caller('x', '--exclusive')
        self.queued('x')
        self.release('a')
        self.assertTrue(self.stays_false(lambda: self.started('x')), 'exclusive ran while slot 2 was still held')
        # While it waits for the second slot, the first is shown as x's, not as an unknown process's.
        self.wait_for(lambda: any((s['holder'] or {}).get('label') == 'x' for s in self.status()['slots']), 'x named on its first slot')
        self.assertFalse(any('unrecorded' in s for s in self.status()['slots']), self.status_text())
        self.assertIn('waiting for the other slot', self.status_text())
        self.release('b')
        self.wait_for(lambda: self.started('x'), 'the exclusive caller')
        holder = self.status()['holders'][0]
        self.assertEqual((holder['label'], holder['slots'], holder['exclusive']), ('x', [1, 2], True))
        self.caller('n')
        self.queued('n')
        self.assertTrue(self.stays_false(lambda: self.started('n')), 'a normal caller ran beside an exclusive holder')
        self.release('x')
        self.wait_for(lambda: self.started('n'), 'the normal caller after the exclusive one')
        self.release('n')
        self.assertEqual(exclusive.wait(10), 0)

    def test_a_waiting_exclusive_is_not_overtaken_by_later_normal_callers(self):
        self.hold_both_slots()
        self.caller('x', '--exclusive'); self.queued('x')
        self.caller('n1'); self.queued('n1')
        self.caller('n2'); self.queued('n2')
        self.release('a')  # One slot frees up: it belongs to x, not to n1 or n2.
        self.assertTrue(self.stays_false(lambda: self.started('n1') or self.started('n2')), 'a later normal caller overtook the exclusive one')
        self.release('b')
        self.wait_for(lambda: self.started('x'), 'the exclusive caller')
        self.assertFalse(self.started('n1') or self.started('n2'))
        self.release('x')
        self.wait_for(lambda: self.started('n1') and self.started('n2'), 'both normal callers after it')

    def test_waiters_of_the_same_kind_go_in_arrival_order(self):
        self.hold_both_slots()
        for name in ('w1', 'w2', 'w3'):
            self.caller(name); self.queued(name)
        self.assertEqual([w['label'] for w in self.status()['waiters']], ['w1', 'w2', 'w3'])
        self.release('a')
        self.wait_for(lambda: self.started('w1'), 'w1 first')
        self.assertTrue(self.stays_false(lambda: self.started('w2') or self.started('w3'), 0.3))
        self.release('w1')
        self.wait_for(lambda: self.started('w2'), 'w2 second')
        self.assertTrue(self.stays_false(lambda: self.started('w3'), 0.3))
        self.release('b'); self.wait_for(lambda: self.started('w3'), 'w3 third')

    def test_a_killed_holder_or_waiter_frees_its_place_and_drops_out_of_status(self):
        killed = self.caller('k')
        self.wait_for(lambda: self.started('k'), 'the holder')
        self.caller('b'); self.wait_for(lambda: self.started('b'), 'a second holder')
        stuck = self.caller('dead-waiter'); self.queued('dead-waiter')
        self.caller('x', '--exclusive'); self.queued('x')
        os.killpg(killed.pid, signal.SIGKILL); killed.wait()
        os.killpg(stuck.pid, signal.SIGKILL); stuck.wait()
        report = self.status()
        self.assertNotIn('k', [h['label'] for h in report['holders']])
        self.assertNotIn('dead-waiter', [w['label'] for w in report['waiters']])
        self.release('b')  # Only now are both slots free: the dead holder's and the dead waiter's state block nothing.
        self.wait_for(lambda: self.started('x'), 'the exclusive caller after the killed one')
        self.assertEqual([h['label'] for h in self.status()['holders']], ['x'])
        self.assertEqual(sorted(p.name for p in (self.folder / 'lane/holders').iterdir()), [n['_name'] for n in self.status()['holders']])

    def test_a_waiter_stopped_before_its_turn_is_listed_until_it_is_queued_again(self):
        """#703: a T3 restart cancelled every queued hold and nobody noticed. A waiter stopped by a signal, or killed
        outright, is kept with its label, folder and command; one that got its turn never is."""
        self.hold_both_slots()
        termed = self.caller('termed'); self.queued('termed')
        killed = self.caller('killed', '--exclusive'); self.queued('killed')
        os.killpg(termed.pid, signal.SIGTERM); termed.wait(10)
        os.killpg(killed.pid, signal.SIGKILL); killed.wait(10)
        report = self.status()
        self.assertEqual(report['waiters'], [])
        cancelled = {entry['label']: entry for entry in report['cancelled']}
        self.assertEqual(sorted(cancelled), ['killed', 'termed'])
        self.assertEqual(cancelled['termed']['how'], 'stopped by SIGTERM while waiting')
        self.assertIn('killed, or its session restarted', cancelled['killed']['how'])
        self.assertTrue(cancelled['killed']['exclusive'])
        for entry in cancelled.values():
            self.assertEqual(entry['cwd'], os.getcwd())
            self.assertEqual(entry['command'][:2], [sys.executable, '-c'])
            self.assertEqual(entry['command'][-1], entry['label'])
        text = self.status_text()
        self.assertIn('stopped while waiting, never ran', text); self.assertIn('"termed" in ' + os.getcwd(), text)
        # Queued again from the same folder: the old entry is answered. The other stays.
        self.caller('termed'); self.queued('termed')
        self.assertEqual([entry['label'] for entry in self.status()['cancelled']], ['killed'])
        self.release('a'); self.release('b')
        self.wait_for(lambda: self.started('termed'), 'the re-queued caller')
        self.release('termed')
        self.wait_for(lambda: not self.status()['holders'], 'every hold to end')
        self.assertEqual([entry['label'] for entry in self.status()['cancelled']], ['killed'], 'a hold that ran is never listed')

    def test_cancelled_waiters_older_than_the_keep_window_are_deleted(self):
        folder = self.folder / 'lane/cancelled'; folder.mkdir(parents=True)
        old = time.time() - (24 * 3600 + 60)  # lane.CANCELLED_KEEP_HOURS
        (folder / '000000000001-1.json').write_text(json.dumps({'label': 'old', 'pid': 1, 'since': old - 5, 'endedAt': old, 'how': 'x'}))
        (folder / '000000000002-2.json').write_text(json.dumps({'label': 'new', 'pid': 2, 'since': time.time() - 5, 'endedAt': time.time(), 'how': 'x'}))
        self.assertEqual([entry['label'] for entry in self.status()['cancelled']], ['new'])
        self.assertEqual(sorted(p.name for p in folder.iterdir()), ['000000000002-2.json'])

    def test_a_direct_lockf_holder_of_slot_1_leaves_slot_2_and_blocks_exclusive(self):
        slot1 = self.env['STM_LANE_SLOT1']
        hold = [sys.executable, '-c', HOLD, str(self.folder), 'direct']
        if Path('/usr/bin/lockf').exists():
            direct = ['/usr/bin/lockf', '-k', slot1, *hold]
        elif shutil.which('flock'):
            direct = ['flock', slot1, *hold]
        else:
            self.skipTest('neither lockf nor flock is installed')
        self.children.append(subprocess.Popen(direct, start_new_session=True))
        self.wait_for(lambda: self.started('direct'), 'the direct lockf holder')
        self.caller('n')
        self.wait_for(lambda: self.started('n'), 'a normal caller on slot 2')
        report = self.status()
        self.assertEqual(report['holders'][0]['slots'], [2])
        self.assertTrue(report['slots'][0]['held'])
        self.assertIsNone(report['slots'][0]['holder'])
        self.release('n')
        self.caller('x', '--exclusive'); self.queued('x')
        self.assertTrue(self.stays_false(lambda: self.started('x')), 'exclusive ran beside a direct lockf holder')
        self.release('direct')
        self.wait_for(lambda: self.started('x'), 'the exclusive caller after lockf let go')
        self.release('x')

    def test_exit_code_is_passed_through(self):
        for code in (0, 3, 42):
            done = subprocess.run([sys.executable, str(LANE), '--', sys.executable, '-c', 'import sys; sys.exit(%d)' % code],
                                  env=self.env, capture_output=True)
            self.assertEqual(done.returncode, code)
        done = subprocess.run([sys.executable, str(LANE), '--', sys.executable, '-c', 'import os,signal; os.kill(os.getpid(), signal.SIGTERM)'],
                              env=self.env, capture_output=True)
        self.assertEqual(done.returncode, 128 + signal.SIGTERM)

    def test_output_sends_the_command_to_a_file_and_keeps_lane_messages_on_stderr(self):
        self.hold_both_slots()
        log = self.folder / 'build.log'
        child = subprocess.Popen([sys.executable, str(LANE), '--label', 'install', '--output', str(log), '--',
                                  sys.executable, '-c', 'import sys; print("built"); print("warned", file=sys.stderr)'],
                                 env=self.env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, start_new_session=True)
        self.children.append(child)
        self.queued('install')
        self.release('a')
        out, err = child.communicate(timeout=10)
        self.assertEqual(child.returncode, 0)
        self.assertIn('"a"', err); self.assertIn('"b"', err)  # Who held the lane while it waited.
        self.assertNotIn('built', out + err)
        self.assertEqual(sorted(log.read_text().split()), ['built', 'warned'])

    def test_status_reports_an_overdue_hold_and_the_label(self):
        self.caller('long build', '--max-minutes', '0.001')
        self.wait_for(lambda: self.started('long build'), 'the holder')
        time.sleep(0.2)
        holder = self.status()['holders'][0]
        self.assertTrue(holder['overdue'])
        text = self.status_text()
        self.assertIn('"long build"', text); self.assertIn('OVERDUE', text)
        self.release('long build')

    def test_a_nested_call_inside_a_hold_runs_without_queueing(self):
        self.caller('x', '--exclusive')
        self.wait_for(lambda: self.started('x'), 'the exclusive holder')
        # A command run by the holder (it carries STM_LANE_HELD) must not wait behind its own holder.
        holder_pid = self.status()['holders'][0]['pid']
        done = subprocess.run([sys.executable, str(LANE), '--', sys.executable, '-c', 'import sys; sys.exit(5)'],
                              env=dict(self.env, STM_LANE_HELD=str(holder_pid)), capture_output=True, timeout=10)
        self.assertEqual(done.returncode, 5)
        done = subprocess.run([sys.executable, str(LANE), '--', sys.executable, '-c', 'import os,signal; os.kill(os.getpid(), signal.SIGTERM)'],
                              env=dict(self.env, STM_LANE_HELD=str(holder_pid)), capture_output=True, timeout=10)
        self.assertEqual(done.returncode, 128 + signal.SIGTERM)
        # A leftover STM_LANE_HELD naming no live holder does not bypass the lane.
        stale = subprocess.Popen([sys.executable, str(LANE), '--', sys.executable, '-c', 'pass'],
                                 env=dict(self.env, STM_LANE_HELD='999999'), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                 start_new_session=True)
        self.children.append(stale)
        with self.assertRaises(subprocess.TimeoutExpired):
            stale.wait(0.6)
        self.release('x')
        self.assertEqual(stale.wait(10), 0)


if __name__ == '__main__':
    unittest.main()
