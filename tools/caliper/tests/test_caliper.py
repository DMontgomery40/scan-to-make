"""Checks measured on the generated meshes (not on the parameters) and on sliced G-code."""
import io
import sys
import unittest
import zipfile
from pathlib import Path

import numpy as np
from manifold3d import CrossSection, Manifold, OpType

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from caliper import design as D  # noqa: E402
from caliper.build import objects, plate  # noqa: E402
from caliper.gcode_check import analyse  # noqa: E402
from caliper.render import parse  # noqa: E402
from caliper.threemf import project_bytes, Project  # noqa: E402

READINGS = [0.0, 3.6, 23.4, 51.2, 99.8]  # include openings that aren't whole millimetres


def solid(volumes):
    return Manifold.batch_boolean([v.solid for v in volumes], OpType.Add)


def intervals(m: Manifold, z: float, y0: float, y1: float, x0=-200.0, x1=250.0):
    """x-intervals of material in the band y0..y1 at height z."""
    band = m.slice(z) ^ D.rect(x0, y0, x1, y1)
    out = []
    for piece in band.decompose():
        b = piece.bounds()
        out.append((b[0], b[2]))
    return sorted(out)


def contains(cs: CrossSection, x: float, y: float) -> bool:
    return (cs ^ D.rect(x - 0.05, y - 0.05, x + 0.05, y + 0.05)).area() > 1e-4


class Caliper(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.d = D.build()
        cls.p = cls.d.params
        cls.card = solid(cls.d.card)

    def slider(self, s):
        return solid(D.slider_at(self.d, s))

    def test_outside_and_inside_jaws_read_the_same_scale(self):
        p = self.p
        for s in READINGS:
            sl = self.slider(s)
            for y in (-30.0, -20.0, -5.0):  # along the outside jaws
                card_edge = max(b for _, b in intervals(self.card, p.body / 2, y - 0.05, y + 0.05, x1=50))
                slider_edge = min(a for a, _ in intervals(sl, p.body / 2, y - 0.05, y + 0.05, x0=-1))
                self.assertAlmostEqual(slider_edge - card_edge, s, places=3, msg=f'outside gap at y={y}, reading {s}')
            y = p.top + p.finger_len / 2  # the inside fingers, above the card
            card_face = min(a for a, _ in intervals(self.card, p.split_lo / 2, y - 0.05, y + 0.05))
            slider_face = max(b for _, b in intervals(sl, (p.split_hi + p.body) / 2, y - 0.05, y + 0.05))
            self.assertAlmostEqual(slider_face - card_face, s, places=3, msg=f'inside span, reading {s}')

    def test_vernier_lines_up_with_the_main_scale(self):
        p = self.p
        marks = next(v.solid for v in self.d.card if v.name == 'card marks')
        ticks = [(a + b) / 2 for a, b in intervals(marks, p.body + p.mark / 2, p.slot_h + 0.5, p.slot_h + 1.0)]
        self.assertEqual(len(ticks), p.range_mm + p.vernier_modulus * p.vernier_div + 1)
        self.assertAlmostEqual(ticks[0], p.zero_x, places=3)
        for s in READINGS:
            face = next(v.solid for v in D.slider_at(self.d, s) if v.name == 'slider face')
            filled = intervals(face, p.body - p.band / 2, p.slot_h - p.edge_clear - 2.0, p.slot_h - p.edge_clear - 1.5,
                               x0=p.zero_x + s - 1.0, x1=p.zero_x + s + p.vernier_pitch * p.vernier_div + 1.0)
            lines = [(filled[i][1] + filled[i + 1][0]) / 2 for i in range(len(filled) - 1)]  # gaps are the lines
            self.assertEqual(len(lines), p.vernier_div + 1)
            self.assertAlmostEqual(lines[0], p.zero_x + s, places=3, msg='vernier 0 sits at the reading')
            k = round((s - int(s)) / p.resolution)
            self.assertLess(min(abs(lines[k] - t) for t in ticks), 1e-3, msg=f'line {k} lines up at reading {s}')
            others = [min(abs(lines[j] - t) for t in ticks) for j in range(p.vernier_div) if j != k]
            self.assertGreater(min(others), p.resolution - 1e-3)

    def test_parts_only_meet_at_the_flexure_preload(self):
        p = self.p
        for s in READINGS:
            overlap = self.card ^ self.slider(s)
            for piece in overlap.decompose():
                if piece.volume() < 1e-6:  # faces that touch when the jaws close
                    continue
                bb = piece.bounding_box()
                self.assertGreaterEqual(bb[0], p.flex_x[0] - 1e-6)
                self.assertLessEqual(bb[3], p.flex_x[1] + 1e-6)
                self.assertLessEqual(bb[4], p.flex_preload + p.ridge + 1e-6)

    def test_every_print_layer_holds_one_colour(self):
        p = self.p
        printed = list(self.d.card) + [D.Volume(v.name, v.role, D.print_slider(v.solid, p.body)) for v in self.d.slider]
        top = max(v.solid.bounding_box()[5] for v in printed)
        layer = 0
        while (layer + 0.5) * p.layer < top:
            z = (layer + 0.5) * p.layer
            roles = {v.role for v in printed if v.solid.slice(z).area() > 1e-6}
            self.assertLessEqual(len(roles), 1, f'layer {layer + 1} (z={z:.2f}) mixes {roles}')
            expected = D.MARKING if z < p.band or z > p.body else D.BODY
            self.assertEqual(roles, {expected}, f'layer {layer + 1}')
            layer += 1

    def test_qr_codes_on_the_back_match_their_urls(self):
        p = self.p
        back = next(v.solid for v in self.d.card if v.name == 'card back').slice(p.band / 2)
        for qr in self.d.meta['qr']:
            matrix = D.qr_matrix(qr['url'])
            self.assertEqual(len(matrix), 33, 'version 4 at 1 mm modules')
            cu, cv = qr['centre_back_view']
            full = (len(matrix) + 2 * p.qr_quiet) * p.qr_module
            for r in range(len(matrix)):
                for c in range(len(matrix)):
                    u = cu - full / 2 + (p.qr_quiet + c + 0.5) * p.qr_module
                    v = cv - full / 2 + (p.qr_quiet + len(matrix) - 1 - r + 0.5) * p.qr_module
                    self.assertEqual(contains(back, -u, v), bool(matrix[r, c]), f'{qr["label"]} module {r},{c}')

    def test_printer_qr_keeps_the_case_sensitive_path(self):
        self.assertIn('/mcp-3D-printer-server/', self.p.printer_url)
        self.assertEqual(D.qr_matrix(self.p.printer_url).shape, (33, 33))

    def test_fiducials_are_through_holes(self):
        body = next(v.solid for v in self.d.card if v.name == 'card body')
        back = next(v.solid for v in self.d.card if v.name == 'card back')
        for f in self.d.meta['fiducials']:
            for m, z in ((back, 0.2), (body, 2.0)):
                self.assertFalse(contains(m.slice(z), f['x'], f['y']))
                self.assertTrue(contains(m.slice(z), f['x'] + f['diameter_mm'] / 2 + 0.4, f['y']))

    def test_fits_a_180_mm_bed(self):
        w, h = plate(self.d)['footprint_mm']
        self.assertLessEqual(w, 175)
        self.assertLessEqual(h, 175)

    def test_project_assigns_body_and_marking_slots(self):
        data = project_bytes(Project(objects(self.d, {D.BODY: 1, D.MARKING: 2})))
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            settings = archive.read('Metadata/model_settings.config').decode()
            model = archive.read('3D/3dmodel.model').decode()
        self.assertEqual(settings.count('<part '), 5)
        self.assertEqual(settings.count('key="extruder" value="2"'), 3)  # card back, card marks, slider face
        self.assertNotIn('BambuStudio-', model)  # a Bambu-branded file without project settings crashes the CLI
        self.assertEqual(data, project_bytes(Project(objects(self.d, {D.BODY: 1, D.MARKING: 2}))), 'reproducible bytes')


SHIPPED = Path(__file__).resolve().parents[3] / 'services/companion/src/objects/caliper'


class Shipped(unittest.TestCase):
    def test_the_app_ships_what_the_generator_makes(self):
        import hashlib, json, tempfile
        from caliper.build import write
        committed = json.loads((SHIPPED / 'caliper.json').read_text())
        with tempfile.TemporaryDirectory() as tmp:
            fresh = write(Path(tmp))
        self.assertEqual(committed['files'], fresh['files'], 'regenerate with: python -m caliper.build ' + str(SHIPPED))
        for name, info in committed['files'].items():
            self.assertEqual(hashlib.sha256((SHIPPED / name).read_bytes()).hexdigest(), info['sha256'], name)


START = ';===== machine start\nM620 S1A\n    T1\nM621 S1A\n; MACHINE_START_GCODE_END\n'


class Gcode(unittest.TestCase):
    def test_counts_changes_after_the_start_block_only(self):
        g = (START + '; CHANGE_LAYER\n; Z_HEIGHT: 0.2\n; FEATURE: Outer wall\nG1 X1 Y1 E1\n'
             '; CHANGE_LAYER\n; Z_HEIGHT: 0.4\n; WIPE_TOWER_START\nT0\n; FEATURE: Prime tower\nG1 X9 Y9 E1\n; WIPE_TOWER_END\n'
             '; FEATURE: Outer wall\nG1 X2 Y2 E1\n; CHANGE_LAYER\n; Z_HEIGHT: 0.6\n; FEATURE: Top surface\nG1 X3 Y3 E1\nT1\nG1 X4 Y4 E1\nT255\n')
        r = analyse(g)
        self.assertEqual(r.initial_filament, 1)
        self.assertEqual(r.changes, [(0.4, 1, 0), (0.6, 0, 1)])
        self.assertEqual(r.mixed_layers, [0.6])
        self.assertEqual(r.tower_layers, 1)

    def test_finds_pauses(self):
        g = START + '; Z_HEIGHT: 0.6\n; PAUSE_PRINTING\nM400 U1\n; FEATURE: Outer wall\nG1 X1 Y1 E1\n'
        self.assertEqual(analyse(g).pauses, [0.6])

    def test_render_parse_handles_arcs_towers_and_primes(self):
        g = ('; filament_colour = #FEC600;#000000\n' + START + '; Z_HEIGHT: 0.2\n; LINE_WIDTH: 0.5\n; FEATURE: Outer wall\n'
             'G1 X0 Y0\nG1 E0.8\nG1 X10 Y0 E1\nG3 X0 Y0 I-5 J0 E1\n; WIPE_TOWER_START\nG1 X20 Y20 E1\n; WIPE_TOWER_END\n')
        seg = parse(g)
        self.assertEqual(seg.colours, ['#FEC600', '#000000'])
        self.assertTrue((seg.tool[~seg.tower] == 1).all(), 'the start block loaded filament 2 (T1)')
        lengths = np.hypot(seg.x1 - seg.x0, seg.y1 - seg.y0)
        self.assertGreater(lengths.min(), 0, 'E-only primes are not lines')
        self.assertAlmostEqual(lengths[~seg.tower].sum(), 10 + np.pi * 5, delta=0.2)
        self.assertEqual(int(seg.tower.sum()), 1)


if __name__ == '__main__':
    unittest.main()
