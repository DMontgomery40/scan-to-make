# SPDX-License-Identifier: GPL-3.0-or-later
"""Companion .img bytes, image normalization and source/sent-image receipts."""
import base64
import hashlib
from io import BytesIO
from pathlib import Path
import sys
import tempfile
import unittest
from PIL import Image

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from still_images import prepare_still, MAX_SOURCE_BYTES, MAX_ENCODED_BYTES
from adapters import image_data


class StillImageTests(unittest.TestCase):
    def test_img_suffix_and_sidecar_do_not_override_bytes(self):
        with tempfile.TemporaryDirectory() as tmp:
            for kind,mime in [('PNG','image/png'),('JPEG','image/jpeg'),('WEBP','image/webp')]:
                p=Path(tmp)/'still.img';Image.new('RGB',(80,40),'blue').save(p,format=kind)
                p.with_suffix('.json').write_text('{"mediaType":"image/heic"}')
                prepared=prepare_still(p)
                self.assertEqual(prepared['image'][0],mime)
                self.assertEqual(base64.b64decode(prepared['image'][1]),p.read_bytes())
                self.assertEqual(prepared['metadata']['sourceSha256'],hashlib.sha256(p.read_bytes()).hexdigest())
                self.assertEqual(image_data(p),prepared['image'])

    def test_large_companion_image_is_downscaled_under_encoded_limit(self):
        with tempfile.TemporaryDirectory() as tmp:
            p=Path(tmp)/'large.img'
            Image.frombytes('RGB',(2000,1600),Image.effect_noise((6000,1600),80).tobytes()).save(p,format='PNG')
            self.assertGreater(p.stat().st_size,8*1024*1024)
            self.assertLess(p.stat().st_size,MAX_SOURCE_BYTES)
            prepared=prepare_still(p)
            self.assertLessEqual(len(prepared['image'][1]),MAX_ENCODED_BYTES)
            sent=Image.open(BytesIO(base64.b64decode(prepared['image'][1])))
            self.assertLess(sent.width,2000);self.assertAlmostEqual(sent.width/sent.height,1.25,delta=.01)
            self.assertEqual(prepared['image'][0],'image/jpeg')
            self.assertTrue(prepared['metadata']['normalization'])

    def test_heic_is_jpeg_or_clear_missing_decoder_error(self):
        try:import pillow_heif
        except ImportError:
            # Minimal CI environments still verify the dependency failure, not a fake decode.
            with tempfile.TemporaryDirectory() as tmp:
                p=Path(tmp)/'still.img';p.write_bytes(b'\x00\x00\x00\x18ftypheic'+b'\x00'*12)
                with self.assertRaisesRegex(ValueError,'requirements'):prepare_still(p)
            return
        with tempfile.TemporaryDirectory() as tmp:
            p=Path(tmp)/'still.img'
            pillow_heif.from_pillow(Image.new('RGB',(128,64),'green')).save(p,quality=90)
            prepared=prepare_still(p)
            self.assertEqual(prepared['metadata']['sourceMediaType'],'image/heic')
            self.assertEqual(prepared['image'][0],'image/jpeg')
            decoded=Image.open(BytesIO(base64.b64decode(prepared['image'][1])))
            self.assertEqual(decoded.size,(128,64))
            self.assertGreater(decoded.getpixel((32,32))[1],80)

    def test_exif_orientation_is_applied_when_normalized(self):
        with tempfile.TemporaryDirectory() as tmp:
            p=Path(tmp)/'still.img';exif=Image.Exif();exif[274]=6
            Image.new('RGB',(40,20),'red').save(p,format='JPEG',exif=exif)
            prepared=prepare_still(p)
            sent=Image.open(BytesIO(base64.b64decode(prepared['image'][1])))
            self.assertEqual(sent.size,(20,40))
            self.assertNotIn(274,sent.getexif())

    def test_oversized_and_invalid_images_fail_before_model(self):
        with tempfile.TemporaryDirectory() as tmp:
            p=Path(tmp)/'still.img';p.write_bytes(b'not an image')
            with self.assertRaises(ValueError):prepare_still(p)
            with p.open('wb') as f:f.truncate(MAX_SOURCE_BYTES+1)
            with self.assertRaisesRegex(ValueError,'25 MiB'):prepare_still(p)
