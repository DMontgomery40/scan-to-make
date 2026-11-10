"""One trunk: build and install scripts refuse a dirty tree or a SHA that isn't on origin/main."""
import lane_isolation  # noqa: F401  (first: no test may reach the real build lane)
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

REPO = Path(__file__).resolve().parents[2]
GUARD = 'scripts/trunk_guard.sh'
LANE = 'scripts/lane.py'
# Every script that builds something installable or publishable. Each must refuse before doing work.
ENTRY_POINTS = [
    'apps/mac/scripts/prepare-payload.sh',
    'apps/mac/scripts/release.sh',
    'apps/mac/scripts/embed.sh',
    'apps/mobile/scripts/prepare-testflight.sh',
    'apps/mobile/scripts/install-iphone.sh',
    'apps/mobile/scripts/release-trunk-guard.sh',
    'apps/linux/scripts/bundle.sh',
    'tools/linux-host/prepare-payload.sh',
    'tools/linux-reconstruct/packaging/build-linux-payload.sh',
    'android/scripts/trunk-guard.sh',
]


class TrunkGuardTests(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory(); root = Path(self.folder.name)
        self.origin = root / 'origin.git'; self.work = root / 'work'; self.log = root / 'overrides.log'
        self.env = {k: v for k, v in os.environ.items() if not k.startswith('STM_TRUNK')}
        self.env.update(GIT_AUTHOR_NAME='t', GIT_AUTHOR_EMAIL='t@t', GIT_COMMITTER_NAME='t', GIT_COMMITTER_EMAIL='t@t',
                        STM_TRUNK_OVERRIDE_LOG=str(self.log), HOME=str(root))
        # This test's own build lane, so a test can see whether a script queued in it.
        self.lane = root / 'lane-test'; self.env.update(lane_isolation.lane_env(self.lane))
        subprocess.run(['git', 'init', '-q', '--bare', '-b', 'main', str(self.origin)], check=True)
        subprocess.run(['git', 'clone', '-q', str(self.origin), str(self.work)], check=True, stderr=subprocess.DEVNULL)
        for path in [GUARD, LANE, *ENTRY_POINTS]:
            (self.work / path).parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(REPO / path, self.work / path)
        (self.work / 'apps/mobile/ios').mkdir(parents=True)  # the iPhone project's SRCROOT (empty: git ignores it)
        self.commit('base'); self.git('push', '-q', 'origin', 'HEAD:main')

    def tearDown(self):
        self.folder.cleanup()

    def git(self, *args):
        return subprocess.run(['git', *args], cwd=self.work, env=self.env, check=True, capture_output=True, text=True).stdout.strip()

    def commit(self, message):
        (self.work / 'note.txt').write_text(message + '\n')
        self.git('add', '-A'); self.git('commit', '-q', '-m', message)

    def run_script(self, path, *args, **env):
        return subprocess.run(['bash', str(self.work / path), *args], cwd=self.work, env=dict(self.env, **env),
                              capture_output=True, text=True, timeout=60)

    def guard(self, **env):
        return self.run_script(GUARD, 'test build', **env)

    def test_clean_commit_on_main_passes_and_prints_its_sha(self):
        done = self.guard()
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertEqual(done.stdout.strip(), self.git('rev-parse', 'HEAD'))

    def test_an_older_main_commit_still_passes(self):
        old = self.git('rev-parse', 'HEAD')
        self.commit('newer'); self.git('push', '-q', 'origin', 'HEAD:main')
        self.git('checkout', '-q', old)
        self.assertEqual(self.guard().returncode, 0)

    def test_feature_branch_commit_is_refused(self):
        self.git('checkout', '-q', '-b', 'feature'); self.commit('side trunk'); self.git('push', '-q', 'origin', 'HEAD:feature')
        done = self.guard()
        self.assertEqual(done.returncode, 1)
        self.assertIn('is not on origin/main', done.stderr)
        self.assertEqual(done.stdout, '')

    def test_unpushed_local_commit_on_main_is_refused(self):
        self.commit('local only')
        self.assertEqual(self.guard().returncode, 1)

    def test_dirty_or_untracked_tree_is_refused(self):
        (self.work / 'note.txt').write_text('edited\n')
        self.assertIn('uncommitted', self.guard().stderr)
        self.git('checkout', '--', 'note.txt')
        (self.work / 'new.swift').write_text('// untracked\n')
        self.assertEqual(self.guard().returncode, 1)

    def test_override_builds_but_is_logged(self):
        self.git('checkout', '-q', '-b', 'feature'); self.commit('debugging')
        done = self.guard(STM_TRUNK_OVERRIDE='simulator repro of KAN-1')
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertIn('OVERRIDE for local debugging only', done.stderr)
        line = self.log.read_text()
        self.assertIn('reason=simulator repro of KAN-1', line)
        self.assertIn('head=' + self.git('rev-parse', 'HEAD'), line)
        self.assertIn('branch=feature', line)

    def test_every_build_and_install_script_refuses_a_side_trunk_before_doing_work(self):
        self.git('checkout', '-q', '-b', 'feature'); self.commit('side trunk')
        for path in ENTRY_POINTS:
            with self.subTest(path):
                # Required variables are set so each script reaches its guard, not a usage error.
                done = self.run_script(path, '/tmp/unused-out', BUILD_NUMBER='1', RELEASE_DIR='/tmp/unused-release',
                                       DEVELOPER_ID_APPLICATION='x', NOTARY_PROFILE='x', SPARKLE_PUBLIC_KEY='x',
                                       SPARKLE_FEED_URL='https://x', SPARKLE_BIN='x', RELEASE_DOWNLOAD_URL='https://x',
                                       MAC_PROVISIONING_PROFILE='x', SRCROOT=str(self.work / self.srcroot(path)),
                                       CONFIGURATION='Release', TARGET_BUILD_DIR='/tmp/unused', CONTENTS_FOLDER_PATH='x',
                                       STM_IPHONE_DEVICE='x')
                self.assertNotEqual(done.returncode, 0, done.stdout + done.stderr)
                self.assertIn('trunk_guard: refusing', done.stderr)
                self.assert_lane_untouched(path)

    def assert_lane_untouched(self, what):
        self.assertFalse(self.lane.exists(), what + ' queued in the build lane before refusing')

    def test_scripts_that_take_the_lane_refuse_bad_arguments_before_queueing(self):
        # Past the trunk guard (override), each refusal below is the script's own check. It must come before the
        # script takes the lane: a refused run never waits in the queue or holds a slot.
        node = self.work / 'apps/mac/Payload/node/bin/node'
        release = dict(DEVELOPER_ID_APPLICATION='x', NOTARY_PROFILE='x', SPARKLE_PUBLIC_KEY='x', SPARKLE_FEED_URL='https://x',
                       SPARKLE_BIN='x', RELEASE_DOWNLOAD_URL='https://x', BUILD_NUMBER='1', MAC_PROVISIONING_PROFILE='x')
        existing = Path(self.folder.name) / 'existing'
        (existing / 'Counterpart.xcarchive').mkdir(parents=True); (existing / 'DerivedData').mkdir()
        testflight, iphone, mac = ('apps/mobile/scripts/prepare-testflight.sh', 'apps/mobile/scripts/install-iphone.sh',
                                   'apps/mac/scripts/release.sh')
        cases = [  # (script, environment, whether the Mac Payload is prepared)
            (testflight, {'RELEASE_DIR': str(existing)}, False),  # no BUILD_NUMBER
            (testflight, {'BUILD_NUMBER': '1'}, False),  # no RELEASE_DIR
            (testflight, {'BUILD_NUMBER': '1', 'RELEASE_DIR': 'relative'}, False),
            (testflight, {'BUILD_NUMBER': 'x', 'RELEASE_DIR': str(existing)}, False),
            (testflight, {'BUILD_NUMBER': '1', 'RELEASE_DIR': str(self.work / 'out')}, False),
            (testflight, {'BUILD_NUMBER': '1', 'RELEASE_DIR': str(existing)}, False),  # archive already there
            (iphone, {'RELEASE_DIR': 'relative'}, False),
            (iphone, {'RELEASE_DIR': str(self.work / 'out')}, False),
            (iphone, {'RELEASE_DIR': str(existing)}, False),  # a build already there
            (mac, dict(release, DEVELOPER_ID_APPLICATION=''), True),  # missing signing identity
            (mac, release, False),  # Payload not prepared
            (mac, dict(release, SPARKLE_FEED_URL='http://x'), True),
            (mac, dict(release, RELEASE_DIR=str(existing)), True),  # archive already there
        ]
        for path, env, payload in cases:
            with self.subTest(path=path, env=env):
                if payload:
                    node.parent.mkdir(parents=True, exist_ok=True); node.write_text('#!/bin/sh\n'); node.chmod(0o755)
                elif node.exists():
                    node.unlink()
                done = self.run_script(path, STM_TRUNK_OVERRIDE='lane test', STM_TRUNK_NO_FETCH='1', **env)
                self.assertNotEqual(done.returncode, 0, done.stdout + done.stderr)
                self.assertNotIn('trunk_guard: refusing', done.stderr)  # Past the guard: the script refused on its own.
                self.assert_lane_untouched(path)

    @staticmethod
    def srcroot(path):
        return 'apps/mobile/ios' if path.startswith('apps/mobile/') else 'apps/mac'

    def test_xcode_phases_skip_debug_and_unsigned_builds_without_reading_git(self):
        # ci_local runs Xcode jobs from a git archive: no .git, and the guard must not be reached.
        shutil.rmtree(self.work / '.git')
        mac = self.run_script('apps/mac/scripts/embed.sh', CONFIGURATION='Debug', SRCROOT=str(self.work / 'apps/mac'),
                              TARGET_BUILD_DIR=str(self.work / 'out'), CONTENTS_FOLDER_PATH='x')
        self.assertNotIn('trunk_guard', mac.stderr)
        for env in ({'CONFIGURATION': 'Debug'}, {'CONFIGURATION': 'Release', 'CODE_SIGNING_ALLOWED': 'NO'}):
            with self.subTest(env):
                done = self.run_script('apps/mobile/scripts/release-trunk-guard.sh', SRCROOT=str(self.work / 'apps/mobile/ios'), **env)
                self.assertEqual(done.returncode, 0, done.stderr)


if __name__ == '__main__':
    unittest.main()
