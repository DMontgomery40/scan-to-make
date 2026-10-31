# SPDX-License-Identifier: MIT
"""Synthetic integration and fail-fast contract checks."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT))
from pipeline import Pipeline, StageError
from make import parser


class PipelineContracts(unittest.TestCase):
    def test_input_bounds_and_fresh_output(self):
        with tempfile.TemporaryDirectory() as tmp:
            base=Path(tmp);mesh=base/'input.obj';mesh.write_text('v 0 0 0\n')
            for extra in ([],['--units','mm','--max-seconds','0'],['--units','mm','--reference','1','nan','3']):
                args=parser().parse_args([str(mesh),'--make','scan-cradle','--profile','p1s','--out',str(base/'out'),*extra])
                with self.assertRaises(ValueError):Pipeline(args)
                self.assertFalse((base/'out').exists())

    def test_oversized_still_rejected_at_intake(self):
        with tempfile.TemporaryDirectory() as tmp:
            base=Path(tmp);src=base/'src';src.mkdir();stills=base/'stills';stills.mkdir()
            (src/'input.obj').write_text('v 0 0 0\n')
            (stills/'big.png').write_bytes(b'\x89PNG'+b'\0'*(8*1024*1024-3))
            args=parser().parse_args([str(src/'input.obj'),'--units','mm','--make','scan-cradle','--profile','p1s',
                                      '--stills',str(stills),'--out',str(base/'out')])
            with self.assertRaises(StageError):Pipeline(args).run()
            result=json.loads((base/'out/pipeline-report.json').read_text())
            self.assertEqual(result['error']['stage'],'intake')

    def test_material_escapes_rejected_before_any_subprocess(self):
        with tempfile.TemporaryDirectory() as tmp:
            base=Path(tmp);src=base/'src';src.mkdir();outside=base/'private.png';outside.write_bytes(b'private')
            for texture in ('/outside/private.png','../private.png','escape.png'):
                (src/'escape.png').unlink(missing_ok=True);(src/'escape.png').symlink_to(outside)
                (src/'input.obj').write_text('mtllib material.mtl\nv 0 0 0\n')
                (src/'material.mtl').write_text('newmtl x\nmap_Kd '+texture+'\n')
                args=parser().parse_args([str(src/'input.obj'),'--units','mm','--make','scan-cradle','--profile','p1s','--out',str(base/'out')])
                job=Pipeline(args)
                with self.assertRaises(StageError):job.run()
                result=json.loads((base/'out/pipeline-report.json').read_text())
                self.assertEqual(result['error']['stage'],'intake')
                self.assertFalse((base/'out/input').exists())
                for p in (base/'out').iterdir():
                    if p.is_dir():
                        import shutil
                        shutil.rmtree(p)
                    else:p.unlink()
                (base/'out').rmdir()

    def test_nonstandard_material_suffix_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            b=Path(tmp);(b/'input.obj').write_text('mtllib material.txt\nv 0 0 0\n')
            (b/'material.txt').write_text('newmtl x\nmap_Kd /private.png\n')
            args=parser().parse_args([str(b/'input.obj'),'--units','mm','--make','scan-cradle','--profile','p1s','--out',str(b/'out')])
            with self.assertRaises(StageError):Pipeline(args).run()
            self.assertFalse((b/'out/input').exists())

    def test_no_model_credentials_by_default(self):
        args=parser().parse_args(['input.obj','--units','mm','--make','scan-cradle','--profile','p1s','--out','out'])
        self.assertEqual(args.adapter,'scripted')


class RuntimeContracts(unittest.TestCase):
    def test_stage_timeout_and_secret_environment(self):
        from unittest.mock import patch
        with tempfile.TemporaryDirectory() as tmp:
            b=Path(tmp);mesh=b/'x.obj';mesh.write_text('v 0 0 0\n')
            args=parser().parse_args([str(mesh),'--units','mm','--make','scan-cradle','--profile','p1s','--out',str(b/'out'),'--stage-seconds','1'])
            job=Pipeline(args);job.out.mkdir()
            with patch.dict(os.environ,{'ANTHROPIC_API_KEY':'synthetic-secret','UNRELATED_TOKEN':'synthetic-other'}):
                self.assertNotIn('ANTHROPIC_API_KEY',job.environment(model=True))
                job.args.adapter='anthropic'
                self.assertEqual(job.environment(model=True)['ANTHROPIC_API_KEY'],'synthetic-secret')
                self.assertNotIn('UNRELATED_TOKEN',job.environment(model=True))
                self.assertNotIn('ANTHROPIC_API_KEY',job.environment())
            with self.assertRaisesRegex(StageError,'wall-clock'):
                job.execute('slow',[sys.executable,'-c','import time; time.sleep(10)'])

    @unittest.skipUnless(Path('/proc').is_dir(),'Linux process-state assertion')
    def test_timeout_terminates_descendant_with_its_own_session(self):
        import time
        with tempfile.TemporaryDirectory() as tmp:
            b=Path(tmp);mesh=b/'x.obj';mesh.write_text('v 0 0 0\n')
            args=parser().parse_args([str(mesh),'--units','mm','--make','scan-cradle','--profile','p1s','--out',str(b/'out'),'--stage-seconds','1'])
            job=Pipeline(args);job.out.mkdir();pidfile=b/'child.pid'
            child=b/'child.py';child.write_text('import time; time.sleep(30)')
            parent=b/'parent.py';parent.write_text('import subprocess,sys,time\nfrom pathlib import Path\np=subprocess.Popen([sys.executable,sys.argv[1]],start_new_session=True)\nPath(sys.argv[2]).write_text(str(p.pid))\ntime.sleep(30)')
            try:
                with self.assertRaises(StageError):job.execute('timeout-tree',[sys.executable,str(parent),str(child),str(pidfile)])
                pid=int(pidfile.read_text());stat=Path('/proc')/str(pid)/'stat'
                self.assertTrue(not stat.exists() or stat.read_text().rsplit(') ',1)[1].split()[0]=='Z','detached descendant survived stage timeout')
            finally:
                if pidfile.exists():
                    try:os.kill(int(pidfile.read_text()),9)
                    except ProcessLookupError:pass

    def test_optional_capability_is_an_explicit_stage_failure(self):
        from fixtures import lumpy_box
        class MissingAdvice(Pipeline):
            def call(self,name,tool,args,**kw):
                if args==['--help']:return 'tools run'
                if name=='repair':
                    p=self.out/'repair';p.mkdir();(p/'repaired.obj').write_text('synthetic')
                    return '{}'
                if name=='measure':return '{"faces":12}'
                return super().call(name,tool,args,**kw)
        with tempfile.TemporaryDirectory() as tmp:
            b=Path(tmp);mesh=lumpy_box(b/'source')
            args=parser().parse_args([str(mesh),'--units','mm','--make','scan-cradle','--profile','p1s','--out',str(b/'out')])
            job=MissingAdvice(args)
            with self.assertRaisesRegex(StageError,'not installed'):job.run()
            d=json.loads((b/'out/pipeline-report.json').read_text())
            self.assertEqual(d['error']['stage'],'advise')
            self.assertFalse((b/'out/design').exists())


HAS_ADVICE=('advise' in subprocess.run([sys.executable,str(ROOT.parent/'scan-correct/correct.py'),'--help'],capture_output=True,text=True).stdout)
@unittest.skipUnless(os.environ.get('BLENDER') and HAS_ADVICE,'requires Blender and scan-correct advise')
class BlenderIntegration(unittest.TestCase):
    def run_pipeline(self,b,mesh,name,extra=()):
        args=parser().parse_args([str(mesh),'--make','scan-cradle','--reference','20','12','8','--profile','p1s-0.4-hardened',
                                 '--param','grid_mm=1','--param','margin_mm=4','--out',str(b/name),*extra])
        job=Pipeline(args);return job.run()

    def test_lumpy_box_to_checked_stl_and_repeatable_report(self):
        from fixtures import lumpy_box
        with tempfile.TemporaryDirectory() as tmp:
            b=Path(tmp);mesh=lumpy_box(b/'source')
            one=self.run_pipeline(b,mesh,'one',['--units','mm'])
            two=self.run_pipeline(b,mesh,'two',['--units','mm'])
            self.assertEqual(one['status'],'complete')
            self.assertFalse(one['dispatchAuthorized'])
            self.assertEqual((b/'one/pipeline-report.json').read_bytes(),(b/'two/pipeline-report.json').read_bytes())
            self.assertNotEqual((b/'one/timings.json').read_bytes(),(b/'two/timings.json').read_bytes())
            final=json.loads((b/'one/correct-result.json').read_text())['final']['boxExtentsMm']
            for actual,target in zip(final,[20,12,8]):self.assertAlmostEqual(actual,target,delta=.05)
            artifact=b/'one'/one['checkedArtifact']['path']
            self.assertEqual(artifact.suffix,'.stl')
            manifest=json.loads((b/'one/manifest.json').read_text())
            self.assertEqual(manifest['artifact'],{**one['checkedArtifact'],'mediaType':'model/stl','units':'mm'})
            self.assertFalse(manifest['acceptedByHuman'])
            order=[x['stage'] for x in one['stages']]
            self.assertLess(order.index('match'),order.index('design'))
            self.assertFalse(list((b/'one').rglob('*.3mf')))
            for stage in one['stages']:
                for item in stage['inputs']+stage['outputs']:
                    import hashlib
                    self.assertEqual(hashlib.sha256((b/'one'/item['path']).read_bytes()).hexdigest(),item['sha256'])

    @unittest.skipUnless(importlib.util.find_spec('pxr') and importlib.util.find_spec('PIL'),'requires converter usd-core/Pillow runtime')
    def test_usdz_conversion_and_stills_forwarded(self):
        from fixtures import lumpy_box,usdz_from_obj
        import base64
        with tempfile.TemporaryDirectory() as tmp:
            b=Path(tmp);mesh=usdz_from_obj(lumpy_box(b/'source'),b/'capture.usdz')
            stills=b/'stills';stills.mkdir()
            stills.joinpath('detail.png').write_bytes(base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aKz8AAAAASUVORK5CYII='))
            d=self.run_pipeline(b,mesh,'usdz',['--stills',str(stills)])
            self.assertEqual(d['status'],'complete')
            converted=json.loads((b/'usdz/convert-result.json').read_text())
            self.assertTrue(converted['metricQualified'])
            self.assertTrue(any(o['path'].endswith('.mtl') for o in converted['outputs']))
            self.assertTrue(any(o['path'].endswith('.png') for o in converted['outputs']))
            self.assertIsNotNone(json.loads((b/'usdz/advise-result.json').read_text())['closeupAdvice']['regionClassification'])
            correction=json.loads((b/'usdz/correct-result.json').read_text())
            self.assertEqual(correction['detailStills'][0]['id'],'still-1')
            self.assertEqual(correction['detailStills'][0]['name'],'still-1.png')


    def test_failed_correction_tool_stops_before_design(self):
        from fixtures import lumpy_box
        with tempfile.TemporaryDirectory() as tmp:
            b=Path(tmp);mesh=lumpy_box(b/'source');script=b/'bad.json'
            script.write_text('[{"name":"cut_feature","arguments":{}}]')
            proc=subprocess.run([sys.executable,str(ROOT/'make.py'),str(mesh),'--units','mm','--make','scan-cradle',
                                 '--script',str(script),'--profile','p1s-0.4-hardened','--out',str(b/'out')],capture_output=True,text=True)
            self.assertEqual(proc.returncode,2,proc.stderr)
            report=json.loads((b/'out/pipeline-report.json').read_text())
            self.assertEqual(report['error']['stage'],'correct');self.assertFalse((b/'out/design').exists())
            self.assertTrue(json.loads((b/'out/correct-result.json').read_text())['toolFailures'])


class OptionalToolContracts(unittest.TestCase):
    def test_planner_statuses_and_match_before_generate(self):
        from unittest.mock import patch
        from fixtures import lumpy_box
        import shutil,hashlib
        class ContractTools(Pipeline):
            plan_status='ready'
            gate_verdict='printable'
            def call(self,name,tool,args,**kwargs):
                self.active=name
                def option(key):return Path(args[args.index(key)+1])
                if name=='advise' and args==['--help']:return 'tools run advise'
                if name=='repair':
                    out=option('--out');out.mkdir();(out/'repaired.obj').write_text('synthetic');return '{}'
                if name=='measure':return '{"faces":12}'
                if name=='advise':
                    out=option('--out');out.mkdir();(out/'advice.json').write_text('{}')
                    return '{"closeupAdvice":{"targets":[]}}'
                if name=='correct':
                    out=option('--out');out.mkdir()
                    for f in ['corrected.stl','corrected.obj','tool-calls.jsonl']:(out/f).write_text('')
                    (out/'report.json').write_text('{}')
                    return '{"status":"complete","toolFailures":[]}'
                if name=='plan':
                    result={'status':self.plan_status,'templateId':'scan-cradle','params':{}};option('--out').write_text(json.dumps(result));return json.dumps(result)
                if name=='design':
                    out=option('--out');out.mkdir();(out/'part.stl').write_bytes(b'synthetic');(out/'manifest.json').write_text(json.dumps({'units':'mm','previewOnly':True,'outputSha256':{'part.stl':hashlib.sha256(b'synthetic').hexdigest()}}));return '{}'
                if name=='printability':return json.dumps({'verdict':self.gate_verdict,'input':{'sha256':hashlib.sha256(b'synthetic').hexdigest()}})
                raise AssertionError((name,args))
        with tempfile.TemporaryDirectory() as tmp:
            b=Path(tmp);mesh=lumpy_box(b/'source')
            tools=b/'tools';(tools/'design-planner').mkdir(parents=True);(tools/'design-planner/planner.py').touch()
            (tools/'templates').mkdir();shutil.copy(ROOT.parent/'templates/catalog.json',tools/'templates/catalog.json')
            replies=b/'replies.json';replies.write_text('[]')
            for status in ('needs-input','no-fit','ready','unknown-gate'):
                args=parser().parse_args([str(mesh),'--units','mm','--make','a stand for it','--planner-script',str(replies),
                                         '--profile','p1s','--out',str(b/status)])
                job=ContractTools(args,tools=tools);job.plan_status='ready' if status=='unknown-gate' else status
                if status=='unknown-gate':
                    job.gate_verdict='unknown'
                    with self.assertRaisesRegex(StageError,'fails gate'):job.run()
                    self.assertFalse((b/status/'manifest.json').exists())
                elif status!='ready':
                    with self.assertRaisesRegex(StageError,'needs input'):job.run()
                    self.assertFalse((b/status/'design').exists())
                else:
                    d=job.run();self.assertEqual(d['status'],'complete')
                    order=[x['stage'] for x in d['stages']]
                    self.assertLess(order.index('match'),order.index('design'))
                    match=json.loads((b/status/'match-result.json').read_text())
                    self.assertIn('not implemented',match['registryFitBase'])

    def test_all_named_template_parameter_flags_are_catalog_driven(self):
        with tempfile.TemporaryDirectory() as tmp:
            b=Path(tmp);mesh=b/'input.obj';mesh.write_text('v 0 0 0\n')
            args=parser().parse_args([str(mesh),'--units','mm','--make','scan-cradle','--profile','p1s','--out',str(b/'out')])
            job=Pipeline(args)
            for name in ('scan-cradle','wall-mount','protective-sleeve','edge-clip'):
                self.assertEqual(job.template_arguments(name,{'clearance_mm':.4,'up':'-Y'}),['--clearance-mm=0.4','--up=-Y'])
                with self.assertRaises(ValueError):job.template_arguments(name,{'out':'escape'})
                with self.assertRaises(ValueError):job.template_arguments(name,{'wall_mm':True})


if __name__=='__main__':unittest.main()
