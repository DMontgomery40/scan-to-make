"""ux_screens.py: what can fail without a simulator fails before the lane, with a sentence and a non-zero exit, and
a long --work path no longer breaks the companion (its control socket used to live under --work: over ~104 bytes,
"Local control startup failed"). These run the real script with a synthetic project copy, never the Mac's own data,
and point the lane at a temporary folder, so they never queue in the real lane."""
import lane_isolation  # noqa: F401  (first: no test may reach the real build lane)
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
SCRIPT = REPO / 'scripts/ux_screens.py'
sys.path.insert(0, str(REPO / 'scripts'))
import ux_screens  # noqa: E402

PNG = bytes.fromhex('89504e470d0a1a0a0000000d4948445200000001000000010806000000'
                    '1f15c4890000000d49444154789c63f8cfc0f01f0005000201a1b2b4f20000000049454e44ae426082')


def synthetic_state(root: Path) -> Path:
    """A state root with one project per id prefix the screens name, enough for prepare() and the companion."""
    objects = root / 'capture/objects'
    prefixes = [prefix for _, prefix, _ in ux_screens.PROJECTS if not prefix.startswith('synth:')] + ['2f0a0229']
    for index, prefix in enumerate(prefixes):
        pid = f'{prefix}-0000-4000-8000-{index:012d}'
        folder = objects / pid
        (folder / 'current/renders').mkdir(parents=True)
        (folder / 'photos').mkdir()
        (folder / 'current/renders/1.png').write_bytes(PNG)
        (folder / 'photos/a.jpg').write_bytes(b'\xff\xd8\xff\xd9')
        (folder / 'current/model.stl').write_text('solid x\nendsolid x\n')
        project = {'id': pid, 'createdAtMs': 1, 'updatedAtMs': 2, 'state': 'ready', 'kind': 'fit', 'title': f'Project {index}',
                   'instructions': 'Make a thing.', 'photos': [], 'messages': [],
                   'passes': [{'startedAtMs': 1, 'endedAtMs': 2, 'status': 'done', 'dir': str(root / 'capture/objects' / pid)}],
                   'current': {'model': 'current/model.stl', 'renders': ['current/renders/1.png']}}
        if prefix == '30a2a33c':
            project['ask'] = {'id': 'a', 'question': 'How wide is it?', 'answers': ['text'], 'status': 'answered', 'askedAtMs': 1}
        (folder / 'object.json').write_text(json.dumps(project))
    (root / 'events.ndjson').write_text('')
    (root / 'settings.json').write_text('{}')
    return root


class UxScreensTests(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix='uxs-test-'))
        lane = self.tmp / 'lane'
        lane.mkdir()
        self.env = dict(os.environ, STM_LANE_SLOT1=str(lane / 'slot1.lock'), STM_IOS_LOCK=str(lane / 'slot1.lock'),
                        STM_LANE_SLOT2=str(lane / 'slot2.lock'), STM_LANE_DIR=str(lane / 'state'))
        self.env.pop('STM_LANE_HELD', None)
        self.env.pop('UX_SCREENS_COMPANION', None)
        self.lane_state = lane / 'state'

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def run_script(self, *args):
        return subprocess.run([sys.executable, str(SCRIPT), *map(str, args)], env=self.env, capture_output=True, text=True, timeout=180)

    def test_a_copy_that_cannot_be_made_exits_non_zero_with_a_sentence_before_the_lane(self):
        empty = self.tmp / 'empty-state'
        (empty / 'capture/objects').mkdir(parents=True)
        run = self.run_script(self.tmp / 'out', '--work', self.tmp / 'work', '--source', empty, '--devices', 'iphone')
        self.assertNotEqual(run.returncode, 0, run.stdout + run.stderr)
        self.assertIn('The copy needs exactly one project whose id starts', run.stderr)
        tickets = list(self.lane_state.rglob('*')) if self.lane_state.exists() else []
        self.assertEqual([p for p in tickets if p.is_file()], [], 'a run that failed before capturing never queues in the lane')

    @unittest.skipUnless(sys.platform == 'darwin' and shutil.which('node') and (REPO / 'services/companion/dist/server-cli.js').exists(),
                         'needs macOS, node and the built companion')
    def test_a_long_work_path_still_starts_the_companion(self):
        source = synthetic_state(self.tmp / 'state')
        work = self.tmp / ('a-work-folder-name-long-enough-to-push-a-socket-under-it-past-the-unix-limit-' * 2) / 'work'
        self.assertGreater(len(str(work / 'data/state/auth/control.sock')), 110)
        run = self.run_script(self.tmp / 'out', '--work', work, '--source', source, '--prepare-only')
        self.assertEqual(run.returncode, 0, run.stdout + run.stderr)
        expected = len([1 for _, prefix, _ in ux_screens.PROJECTS if not prefix.startswith('synth:')]) + 1 + 2
        self.assertIn(f'companion serves {expected} projects', run.stdout + run.stderr)
        self.assertFalse((work / 'data/state/auth/control.sock').exists(), 'the control socket lives outside --work')

    @unittest.skipUnless(sys.platform == 'darwin' and shutil.which('node') and (REPO / 'services/companion/dist/server-cli.js').exists(),
                         'needs macOS, node and the built companion')
    def test_two_prepared_runs_have_companions_of_their_own_at_once(self):
        source = synthetic_state(self.tmp / 'state')
        companions = []
        try:
            for name in ('first', 'second'):
                data = self.tmp / name / 'data'
                ux_screens.prepare(source, data)
                companions.append(ux_screens.Companion(data / 'state', self.tmp / f'{name}.log'))
            urls = [c.info['url'] for c in companions]
            self.assertEqual(len(set(urls)), 2, urls)
            for companion in companions:
                self.assertEqual(companion.info['objectsStatus'], 200)
                self.assertTrue(re.fullmatch(r'http://127\.0\.0\.1:(9078|908\d|909[0-7])', companion.info['url']), companion.info['url'])
                self.assertEqual(companion.info['record']['baseUrl'], companion.info['url'], 'the pairing record carries the chosen address')
        finally:
            for companion in companions: companion.stop()

    def test_project_images_are_named_by_title_and_an_id_prefix_no_other_project_shares(self):
        objects = [{'id': '5ea94301-84d9-5acd-b3b2-36f33d063099', 'title': 'Wall holder for three'},
                   {'id': '5ea94301-0000-4000-8000-000000000001', 'title': 'Wall holder for three'},
                   {'id': '30a2a33c-75f9-4519-aaeb-f53affeffb61', 'title': None}]
        names = ux_screens.project_names([o['id'] for o in objects], objects)
        self.assertEqual(names['5ea94301-84d9-5acd-b3b2-36f33d063099'], 'wall-holder-for-three-5ea94301-8')
        self.assertEqual(names['5ea94301-0000-4000-8000-000000000001'], 'wall-holder-for-three-5ea94301-0')
        self.assertEqual(names['30a2a33c-75f9-4519-aaeb-f53affeffb61'], 'untitled-30a2a33c')
        self.assertEqual(len(set(names.values())), 3)
        screens = [item['name'] for pid, name in names.items() for item in ux_screens.project_screens(name, pid, '', 'real', '{}')]
        self.assertEqual(len(screens), len(set(screens)), 'no two projects write the same image files')

    def test_a_hold_that_captures_no_screens_fails(self):
        """The real run_devices and capture: every open refused (an agent-device session bound to another run's
        simulator, Nov 10) means no image, and the hold exits non-zero with that reason. Only the outside world is
        replaced: the build, simctl and the agent-device CLI."""
        import argparse
        from unittest import mock
        out, work = self.tmp / 'out', self.tmp / 'work'
        out.mkdir(); work.mkdir()
        held = {'info': {'record': {'baseUrl': 'http://127.0.0.1:9080'}, 'objects': [], 'url': 'http://127.0.0.1:9080'},
                'manifest': {'ids': {name: f'{name}-id' for name, _, _ in ux_screens.PROJECTS}, 'copiedAt': 'now'},
                'processes': [], 'served': []}
        args = argparse.Namespace(screens='home', project=[], redo=False, max_minutes=10)
        refusal = 'session ux-screens-iphone is bound to another simulator'

        def agent_device(device, *command, **_):
            if command[0] == 'open': raise RuntimeError(f'agent-device open: {refusal}')
            return {}
        with mock.patch.object(ux_screens, 'build_app', return_value=Path('/nonexistent.app')), \
             mock.patch.object(ux_screens, 'simctl', return_value='10FBF416-0590-4874-86CD-5ABD67A941C0'), \
             mock.patch.object(ux_screens.Device, 'ad', agent_device):
            with self.assertRaises(SystemExit) as stopped:
                ux_screens.capture(args, out, work, ['iphone'], held)
        self.assertNotIn(stopped.exception.code, (0, None))
        self.assertIn('captured no screens', str(stopped.exception.code))
        self.assertIn(refusal, str(stopped.exception.code))
        self.assertEqual(ux_screens.read_jsonl(out / 'done.jsonl'), [], 'a failed screen is not done: the next run retries it')

    def test_a_screens_typo_fails_before_the_companion_and_the_lane(self):
        source = synthetic_state(self.tmp / 'state')
        run = self.run_script(self.tmp / 'out', '--work', self.tmp / 'work', '--source', source, '--devices', 'iphone',
                              '--screens', 'hoem')
        self.assertNotEqual(run.returncode, 0, run.stdout + run.stderr)
        self.assertIn("No screen matches --screens 'hoem'", run.stderr)
        self.assertIn('home', run.stderr.split('The screens are:')[1], 'the message names the valid screens')
        self.assertFalse((self.tmp / 'work/companion.log').exists(), 'no companion was started')
        tickets = [p for p in self.lane_state.rglob('*') if p.is_file()] if self.lane_state.exists() else []
        self.assertEqual(tickets, [])

    @unittest.skipUnless(sys.platform == 'darwin' and shutil.which('node') and (REPO / 'services/companion/dist/server-cli.js').exists(),
                         'needs macOS, node and the built companion')
    def test_a_signal_stops_the_run_waiting_in_the_lane_and_reaps_it(self):
        """SIGTERM while the capture waits in the lane: the lane child is terminated and waited for, the companion
        stops, and nothing of the run is left running."""
        import fcntl
        import signal as signals
        import time
        source = synthetic_state(self.tmp / 'state')
        slots = [Path(self.env['STM_LANE_SLOT1']), Path(self.env['STM_LANE_SLOT2'])]
        holders = [open(slot, 'a+') for slot in slots]
        try:
            for handle in holders: fcntl.flock(handle, fcntl.LOCK_EX)  # the lane is busy: the capture has to wait
            outer = subprocess.Popen([sys.executable, str(SCRIPT), str(self.tmp / 'out'), '--work', str(self.tmp / 'work'),
                                      '--source', str(source), '--devices', 'iphone', '--screens', 'home'],
                                     env=self.env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            queue = self.lane_state / 'queue'
            deadline = time.time() + 120
            while time.time() < deadline and not (queue.exists() and any(queue.iterdir())):
                time.sleep(0.5)
            tickets = [json.loads(p.read_text()) for p in queue.iterdir()] if queue.exists() else []
            self.assertTrue(tickets, 'the capture is waiting in the lane')
            lane_pid = tickets[0]['pid']
            outer.send_signal(signals.SIGTERM)
            _, stderr = outer.communicate(timeout=200)
            self.assertNotEqual(outer.returncode, 0)
            self.assertIn('Stopped by signal', stderr)
            with self.assertRaises(ProcessLookupError, msg='the lane child was reaped'):
                os.kill(lane_pid, 0)
            info = json.loads((self.tmp / 'work/companion-info.json').read_text())['info']
            with self.assertRaises(ProcessLookupError, msg='the companion stopped'):
                os.kill(info['pid'], 0)
        finally:
            for handle in holders: handle.close()

    def test_the_companion_is_rebuilt_whenever_its_source_differs_from_the_build(self):
        """Nov 10: a companion dist built from an older commit was captured as the train's build. Reuse is keyed on the
        source content (committed, uncommitted and untracked); any change rebuilds. Only npm is replaced."""
        repo = self.tmp / 'repo'
        src = repo / 'services/companion/src'
        src.mkdir(parents=True)
        for folder in ('services/project', 'services/printer-handoff', 'packages/contracts'):
            (repo / folder).mkdir(parents=True)
            (repo / folder / 'index.ts').write_text('export {};\n')
        (src / 'fit.ts').write_text('export const brief = true;\n')
        (repo / '.gitignore').write_text('dist/\nnode_modules/\n')
        git = lambda *a: subprocess.run(['git', '-C', str(repo), *a], check=True, capture_output=True)
        git('init', '-q'); git('add', '.'); git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'one')
        builds = []

        def npm(command, **_):
            builds.append(command[-1] if command[1] == 'run' else 'ci')
            if command[-1].endswith('services/companion') and command[1] == 'run':
                (repo / 'services/companion/dist').mkdir(exist_ok=True)
                (repo / 'services/companion/dist/server-cli.js').write_text('built')
            return subprocess.CompletedProcess(command, 0, '', '')
        def built_now():
            before = len(builds)
            ux_screens.ensure_companion(repo, run=npm)
            return len(builds) > before
        self.assertTrue(built_now(), 'no stamp yet: build')
        self.assertFalse(built_now(), 'same source: reuse')
        (src / 'fit.ts').write_text('export const brief = false;\n')
        self.assertTrue(built_now(), 'an uncommitted change rebuilds')
        self.assertFalse(built_now())
        git('commit', '-qam', 'two')
        self.assertFalse(built_now(), 'committing the same content keeps the build')
        (src / 'new.ts').write_text('export {};\n')
        self.assertTrue(built_now(), 'an untracked source file rebuilds')
        (src / 'new.ts').unlink()
        git('checkout', '-q', 'HEAD~1')
        self.assertTrue(built_now(), 'another commit rebuilds')
        self.assertIn(ux_screens.describe_source(repo).split()[0], subprocess.run(['git', '-C', str(repo), 'rev-parse', 'HEAD'],
                      capture_output=True, text=True).stdout)

    def test_every_run_names_its_simulators_and_sessions_uniquely(self):
        run = subprocess.run([sys.executable, '-c', 'import sys; sys.path.insert(0, sys.argv[1]); import ux_screens; print(ux_screens.RUN_ID)',
                              str(REPO / 'scripts')], capture_output=True, text=True, check=True)
        self.assertNotEqual(run.stdout.strip(), ux_screens.RUN_ID)
        device = ux_screens.Device('iphone', '10FBF416-0590-4874-86CD-5ABD67A941C0', self.tmp, lambda *_: None)
        self.assertEqual(device.session, f'ux-screens-iphone-{ux_screens.RUN_ID}')


if __name__ == '__main__':
    unittest.main()
