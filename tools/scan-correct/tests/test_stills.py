# SPDX-License-Identifier: GPL-3.0-or-later
import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT))
from adapters import Scripted
from runner import run_job
from fixtures import textured_box


@unittest.skipUnless(os.environ.get('BLENDER'),'set BLENDER=Blender 5.0.1')
class StillEvidenceTests(unittest.TestCase):
    def test_companion_path_forwarding_and_edit_attribution(self):
        with tempfile.TemporaryDirectory() as tmp:
            base=Path(tmp);mesh=textured_box(base)
            still=base/'companion/detail-stills/closeup.png';still.parent.mkdir(parents=True)
            raw=(base/'colour.png').read_bytes();still.write_bytes(raw)
            seen=[]
            class RecordingScripted(Scripted):
                def next(self,events,context,images,seconds):
                    seen.append((context,images))
                    return super().next(events,context,images,seconds)
            script=base/'model.json'
            script.write_text(json.dumps([{'name':'scale_to_reference','arguments':{
                'target_mm':[19,11,7],'evidence_still_ids':['still-1']}}]))
            args=argparse.Namespace(mesh=str(mesh),units='mm',texture=None,still=[str(still)],
                                   reference_mm=[19,11,7],product='synthetic case',adapter='scripted',script=str(script),
                                   model=None,base_url=None,key_env=None,out=str(base/'out'),max_steps=4,max_seconds=60,max_faces=200000)
            with patch('runner.Scripted',RecordingScripted):
                report=run_job(args)
            self.assertIn('still-1',seen[0][0])
            self.assertEqual(base64.b64decode(seen[0][1][0][1]),raw)
            self.assertEqual(report['detailStills'][0]['id'],'still-1')
            entry=next(json.loads(line) for line in (base/'out/tool-calls.jsonl').read_text().splitlines()
                       if json.loads(line)['type']=='tool')
            self.assertTrue(entry['result']['ok'])
            self.assertEqual(entry['evidenceStills'][0]['sha256'],hashlib.sha256(raw).hexdigest())
            self.assertEqual(entry['evidenceStills'][0]['id'],'still-1')
            self.assertTrue((base/'out/stills/still-1.png').exists())
            script.write_text(json.dumps([{'name':'scale_to_reference','arguments':{
                'target_mm':[19,11,7],'evidence_still_ids':['still-9']}}]))
            args.out=str(base/'bad')
            with self.assertRaises(ValueError):
                run_job(args)
            bad=next(json.loads(line) for line in (base/'bad/tool-calls.jsonl').read_text().splitlines()
                     if json.loads(line)['type']=='tool')
            self.assertFalse(bad['result']['ok'])
            self.assertIn('evidence still IDs',bad['result']['error'])
