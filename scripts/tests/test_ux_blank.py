"""The blank check (scripts/ux_blank.py) on synthetic frames in agent-device's tree format: an empty stage, a drawn one, one
with a spinner, one with words, flat and drawn pictures, and a frame with no tree."""
import lane_isolation  # noqa: F401  (first: no test may reach the real build lane)
import json
import sys
import tempfile
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / 'scripts'))
import ux_blank  # noqa: E402

try:
    from PIL import Image, ImageDraw
except ImportError:  # pragma: no cover
    Image = None

W, H, SCALE = 402, 874, 2


def node(kind, label=None, rect=(0, 0, W, H), identifier=None):
    x, y, w, h = rect
    return {'type': kind, 'label': label, 'identifier': identifier, 'rect': {'x': x, 'y': y, 'width': w, 'height': h}}


def tree(*extra):
    return {'success': True, 'data': {'nodes': [node('Other', 'Counterpart'), node('Window'), *extra]}}


# The project page's stage: 0–380 pt, its size chip and photos button along the bottom (ProjectGalleryView.controls).
CHIPS = [node('StaticText', 'Scan · 68.4 × 34.6 × 149.9 mm', (230, 340, 160, 30)), node('Button', '77 photos', (14, 340, 110, 30))]


def frame(draw_model=False, picture=None):
    image = Image.new('RGB', (W * SCALE, H * SCALE), (10, 10, 12))
    pen = ImageDraw.Draw(image)
    for y in range(0, 380 * SCALE):  # the stage's soft gradient: nothing drawn
        shade = 30 + y * 20 // (380 * SCALE)
        pen.line([(0, y), (W * SCALE, y)], fill=(shade, shade, shade + 4))
    pen.rectangle([14 * SCALE, 340 * SCALE, 124 * SCALE, 370 * SCALE], fill=(80, 80, 80))
    pen.text((240 * SCALE, 345 * SCALE), 'Scan 68.4 x 34.6 mm', fill=(255, 255, 255))
    if draw_model:  # a bottle on the stage
        pen.ellipse([150 * SCALE, 80 * SCALE, 250 * SCALE, 300 * SCALE], fill=(200, 180, 120), outline=(255, 255, 255), width=4)
    pen.text((20 * SCALE, 420 * SCALE), 'Your scan', fill=(255, 255, 255))
    if picture == 'flat':
        pen.rectangle([12 * SCALE, 500 * SCALE, 140 * SCALE, 596 * SCALE], fill=(60, 60, 60))
    elif picture == 'drawn':
        pen.rectangle([12 * SCALE, 500 * SCALE, 140 * SCALE, 596 * SCALE], fill=(60, 60, 60))
        pen.ellipse([30 * SCALE, 510 * SCALE, 120 * SCALE, 590 * SCALE], fill=(220, 120, 40), outline=(255, 255, 255), width=3)
    return image


@unittest.skipIf(Image is None, 'needs Pillow')
class BlankCheckTests(unittest.TestCase):
    def check(self, image, *extra):
        with tempfile.TemporaryDirectory() as folder:
            png = Path(folder) / 'frame.png'
            image.save(png)
            return ux_blank.check_frame(png, tree(*extra))

    def test_an_empty_stage_with_nothing_said_is_flagged(self):
        problems = self.check(frame(), *CHIPS)
        self.assertEqual(len(problems), 1, problems)
        self.assertIn('empty stage', problems[0])

    def test_a_stage_with_a_model_drawn_is_not(self):
        self.assertEqual(self.check(frame(draw_model=True), *CHIPS), [])

    def test_a_stage_that_says_it_is_loading_is_not(self):
        self.assertEqual(self.check(frame(), *CHIPS, node('ProgressIndicator', None, (190, 180, 20, 20))), [])

    def test_a_stage_that_says_why_in_words_is_not(self):
        words = node('StaticText', "This model couldn't be shown.", (110, 180, 180, 18))
        self.assertEqual(self.check(frame(), *CHIPS, words), [])

    def test_a_screen_without_a_stage_is_not_judged_as_one(self):
        self.assertEqual(self.check(frame()), [])

    def test_a_flat_unlabelled_picture_on_screen_is_flagged(self):
        problems = self.check(frame(draw_model=True, picture='flat'), *CHIPS, node('Image', None, (12, 500, 128, 96)))
        self.assertEqual(len(problems), 1, problems)
        self.assertIn('empty picture', problems[0])

    def test_drawn_labelled_small_or_off_screen_pictures_are_not(self):
        image = frame(draw_model=True, picture='drawn')
        self.assertEqual(self.check(image, *CHIPS, node('Image', None, (12, 500, 128, 96))), [], 'drawn')
        flat = frame(draw_model=True, picture='flat')
        self.assertEqual(self.check(flat, *CHIPS, node('Image', 'Mac Mini, Filled', (12, 500, 128, 96))), [], 'a labelled symbol')
        self.assertEqual(self.check(flat, *CHIPS, node('Image', None, (12, 500, 50, 50))), [], 'under 64 pt')
        self.assertEqual(self.check(flat, *CHIPS, node('Image', None, (12, -300, 128, 96))), [], 'scrolled off screen')

    def test_a_folder_flags_frames_without_the_app_and_writes_blank_md(self):
        with tempfile.TemporaryDirectory() as folder:
            out = Path(folder)
            (out / 'iphone').mkdir()
            frame().save(out / 'iphone/project-scan-result-p1.png')
            (out / 'iphone/project-scan-result-p1.ax.json').write_text(json.dumps(tree(*CHIPS)))
            frame(draw_model=True).save(out / 'iphone/project-copy-result-p1.png')
            (out / 'iphone/project-copy-result-p1.ax.json').write_text(json.dumps(tree(*CHIPS)))
            frame().save(out / 'iphone/home-p1.png')  # no tree: the app was not on screen
            (out / 'condition.txt').write_text('slow\n')
            self.assertEqual(ux_blank.main([str(out)]), 1)
            report = (out / 'blank.md').read_text()
            self.assertIn('Condition: **slow**', report)
            self.assertIn('iphone/project-scan-result-p1.png', report)
            self.assertIn('iphone/home-p1.png', report)
            self.assertNotIn('project-copy-result', report)
            (out / 'iphone/home-p1.png').unlink()
            (out / 'iphone/project-scan-result-p1.png').unlink()
            self.assertEqual(ux_blank.main([str(out)]), 0)


if __name__ == '__main__':
    unittest.main()
