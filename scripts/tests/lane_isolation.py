"""Keep every test here off the Mac's real build lane (~/.stm-ios.lock, ~/.stm-ios-2.lock, ~/.stm-lane).

Every test module imports this first, and test_lane_isolation.py fails if one doesn't. On import it points the
lane's path overrides (scripts/lane.py) at a temporary folder for the whole test process. Subprocesses inherit
those overrides through os.environ. A test that builds an environment from scratch adds `lane_env()` to it.
Nov 10: a test ran prepare-testflight.sh with the real paths, and its "archive build 42" sat in the real queue
ahead of real work.
"""
import atexit
import os
from pathlib import Path
import pwd
import shutil
import tempfile

_KEYS = ('STM_LANE_SLOT1', 'STM_LANE_SLOT2', 'STM_LANE_DIR')


def real_lane_paths():
    """The paths a caller with no overrides would use, for the real HOME and for $HOME as it is now."""
    homes = {Path(pwd.getpwuid(os.getuid()).pw_dir), Path.home()}
    return {home / name for home in homes for name in ('.stm-ios.lock', '.stm-ios-2.lock', '.stm-lane')}


if not os.environ.get('STM_LANE_TEST_DIR'):
    _folder = tempfile.mkdtemp(prefix='stm-lane-test-')
    os.environ['STM_LANE_TEST_DIR'] = _folder
    atexit.register(shutil.rmtree, _folder, True)
FOLDER = Path(os.environ['STM_LANE_TEST_DIR'])


def lane_env(folder=FOLDER):
    """Lane overrides that put slots and state under `folder`."""
    folder = Path(folder)
    return {'STM_LANE_SLOT1': str(folder / 'slot1.lock'), 'STM_LANE_SLOT2': str(folder / 'slot2.lock'),
            'STM_LANE_DIR': str(folder / 'lane')}


os.environ.pop('STM_IOS_LOCK', None)
os.environ.update(lane_env())
