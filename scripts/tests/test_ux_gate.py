"""ux_gate.py: a device and condition that captured fewer frames than the screens it was asked for, or whose hold ended
with an error, fails the gate (#806: train 2026-11-14's iPhone `slow` hold died on a stale agent-device session,
captured nothing, and the gate said "Every capture finished" and exited 0). The holds here are fakes: no simulator,
no lane, no companion."""
import lane_isolation  # noqa: F401  (first: no test may reach the real build lane)
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / 'scripts'))
import ux_blank  # noqa: E402
import ux_gate  # noqa: E402

SCREENS = ['project-aaaa-result', 'project-bbbb-result']


class FakeHolds:
    """Stands in for ux_screens.py: each call plays the next hold, which writes what the real one would in <out>."""

    def __init__(self, *holds):
        self.holds, self.calls = list(holds), []

    def __call__(self, argv, **kwargs):
        out, device = Path(argv[2]), argv[argv.index('--devices') + 1]
        self.calls.append(argv)
        out.mkdir(parents=True, exist_ok=True)
        return self.holds.pop(0)(out, device)


def asks(out: Path, device: str) -> None:
    (out / 'asked.json').write_text(json.dumps({'condition': 'slow', 'screens': [{'device': device, 'name': n} for n in SCREENS]}))


def frames(out: Path, device: str, names) -> None:
    (out / device).mkdir(exist_ok=True)
    with open(out / 'results.jsonl', 'a') as file:
        for name in names:
            image = out / device / f'{name}-p1.png'
            image.write_bytes(b'png')
            file.write(json.dumps({'device': device, 'name': name, 'image': str(image), 'page': 1}) + '\n')


def done(code: int, text: str):
    return subprocess.CompletedProcess([], code, stdout=text, stderr='')


def captures_nothing(out, device):
    """Train 2026-11-14: every screen failed on DEVICE_IN_USE, so none was left to try, and none had a frame."""
    asks(out, device)
    for name in SCREENS:
        with open(out / 'failures.jsonl', 'a') as file:
            file.write(json.dumps({'device': device, 'name': name, 'why': 'DEVICE_IN_USE'}) + '\n')
    return done(0, '[09:00:00] 0 images so far; 0 screens left: index.md\n')


def errors(out, device):
    """The hold dies before choosing any screen."""
    return done(1, "[09:00:00] holding the lane\nagent-device open: DEVICE_IN_USE (session ux-screens-iphone-1111)\n"
                   "The capture inside the lane failed (exit 1); see the lines above.\n")


def captures_one(out, device):
    asks(out, device)
    frames(out, device, SCREENS[:1])
    return done(0, '1 images so far; 1 screens left (run the same command again)\n')


def captures_the_rest(out, device):
    asks(out, device)
    frames(out, device, SCREENS[1:])
    return done(0, '2 images so far; 0 screens left\n')


def captures_all(out, device):
    asks(out, device)
    frames(out, device, SCREENS)
    return done(0, '2 images so far; 0 screens left\n')


def captures_all_but_blank(out, device):
    asks(out, device)
    frames(out, device, SCREENS)
    return done(1, '1 frames show a blank stage or picture with nothing to say why: blank.md\n'
                   'The capture inside the lane failed (exit 1); see the lines above.\n')


class GateTests(unittest.TestCase):
    def gate(self, *holds, flagged=()):
        folder = Path(self.enterContext(tempfile.TemporaryDirectory()))
        fake = FakeHolds(*holds)
        argv = ['ux_gate.py', str(folder), '--devices', 'iphone', '--conditions', 'slow', '--holds', '3']
        with mock.patch.object(ux_gate.subprocess, 'run', fake), mock.patch.object(sys, 'argv', argv), \
                mock.patch.object(ux_blank, 'check_folder', lambda out: [(out / 'iphone' / f'{SCREENS[0]}-p1.png', ['empty stage'])] if flagged else []), \
                mock.patch('sys.stdout'), mock.patch('sys.stderr'):
            code = ux_gate.main()
        return code, (folder / 'gate.md').read_text(), fake

    def test_a_hold_that_captures_nothing_fails_the_gate(self):
        code, report, fake = self.gate(captures_nothing, captures_nothing, captures_nothing)
        self.assertEqual(code, 2)
        self.assertIn('FAILED', report)
        self.assertNotIn('Every capture finished', report)
        self.assertIn('| iphone | slow | 0 of 2 screens captured', report)
        self.assertEqual(len(fake.calls), 3)  # it tried again, as many holds as it was given

    def test_a_hold_that_ends_with_an_error_fails_the_gate(self):
        code, report, fake = self.gate(errors, captures_all)
        self.assertEqual(code, 2)
        self.assertIn('FAILED', report)
        self.assertIn('hold 1 failed', report)
        self.assertIn('DEVICE_IN_USE', report)
        self.assertIn('no hold got as far as choosing the screens', report)
        self.assertEqual(len(fake.calls), 1)  # a failed hold is not retried into a pass

    def test_a_hold_that_errors_after_some_frames_still_fails(self):
        def partial_then_error(out, device):
            captures_one(out, device)
            return errors(out, device)
        code, report, _ = self.gate(partial_then_error, captures_the_rest)
        self.assertEqual(code, 2)
        self.assertIn('hold 1 failed', report)
        self.assertIn('1 of 2 screens captured', report)

    def test_every_screen_framed_over_two_holds_passes(self):
        code, report, fake = self.gate(captures_one, captures_the_rest)
        self.assertEqual(code, 0)
        self.assertIn('**Passed', report)
        self.assertNotIn('Not captured', report)
        self.assertEqual(len(fake.calls), 2)

    def test_blank_frames_are_the_blank_check_not_a_failed_hold(self):
        code, report, _ = self.gate(captures_all_but_blank, flagged=True)
        self.assertEqual(code, 1)
        self.assertIn('FAILED', report)
        self.assertNotIn('Not captured', report)
        self.assertIn('empty stage', report)

    def test_a_frame_whose_image_is_gone_does_not_count(self):
        def lost(out, device):
            result = captures_all(out, device)
            (out / device / f'{SCREENS[1]}-p1.png').unlink()
            return result
        code, report, _ = self.gate(lost, lost, lost)
        self.assertEqual(code, 2)
        self.assertIn(f'1 of 2 screens captured; without a frame: iphone/{SCREENS[1]}', report)


if __name__ == '__main__':
    unittest.main()
