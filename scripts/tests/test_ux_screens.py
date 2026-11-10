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
                self.assertTrue(re.fullmatch(r'http://127\.0\.0\.1:(9078|90[89]\d)', companion.info['url']), companion.info['url'])
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


if __name__ == '__main__':
    unittest.main()
