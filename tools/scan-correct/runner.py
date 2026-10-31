# SPDX-License-Identifier: GPL-3.0-or-later
"""Bounded host-side model loop; artifacts and logs are private job data."""
import json
import base64
import hashlib
import math
from pathlib import Path
import shutil
import time

from adapters import Adapter, Scripted, image_data
from host import Worker, digest, write_json
from schema import validate
from still_images import prepare_still


SYSTEM = '''Correct a scanned object using only the bounded tools. Mesh units are declared, not measured.
Start with measure; inspect texture features and retained evidence when available. Do not trust filled regions.
Use feature-derived datums, then explicit product priors, symmetry, fairing and reference dimensions only when justified.
Every spec comparison uses boxExtentsMm, never PCA. Scaling to spec is by construction, not evidence of physical accuracy.
Classify fill heuristically before split deviation. Cuts must pass their own volume/topology checks. No printing.
You may call only named JSON tools, never code or external paths. Tool errors are observations: adapt or stop.
For edits informed by attached stills, include evidence_still_ids in tool arguments. Attribute only images actually used; IDs are model-declared evidence, not independently verified causation.
Finish with no tool calls only when the measured result is satisfactory; mention remaining assumptions.
'''


def run_job(args):
    if not 1<=args.max_steps<=100 or not 1<=args.max_seconds<=3600 or not 4<=args.max_faces<=1000000:
        raise ValueError('invalid run budget')
    if len(args.still)>4:
        raise ValueError('at most four detail stills')
    if args.reference_mm is not None:
        validate('scale_to_reference',{'target_mm':args.reference_mm})
    if len(args.product)>512:
        raise ValueError('product name too long')
    prepared = [prepare_still(path) for path in args.still]
    images = [item['image'] for item in prepared]
    if args.adapter=='scripted':
        if not args.script or Path(args.script).stat().st_size>1024*1024:
            raise ValueError('bounded --script required for scripted adapter')
        adapter = Scripted(args.script)
    else:
        adapter = Adapter(args.adapter,args.model,args.base_url,args.key_env)
    output = Path(args.out).resolve()
    output.mkdir(parents=True,exist_ok=True)
    if any(output.iterdir()):
        raise ValueError('output directory must be empty')
    output.chmod(0o700)
    stills=[]
    if images:
        (output/'stills').mkdir()
    for index,(path,image) in enumerate(zip(args.still,images),1):
        identity='still-'+str(index)
        extension={'image/png':'.png','image/jpeg':'.jpg','image/webp':'.webp'}[image[0]]
        relative='stills/'+identity+extension
        source_relative='stills/'+identity+'-source.img'
        (output/source_relative).write_bytes(prepared[index-1]['source'])
        raw=base64.b64decode(image[1])
        (output/relative).write_bytes(raw)
        stills.append({'id':identity,'name':Path(path).name,'sha256':hashlib.sha256(raw).hexdigest(),'artifact':relative,'sourceArtifact':source_relative,**prepared[index-1]['metadata']})
    still_by_id={item['id']:item for item in stills}
    worker = Worker(output/'work',seconds=args.max_seconds,max_faces=args.max_faces)
    log_path = output/'tool-calls.jsonl'
    events = []
    calls = 0
    started = time.monotonic()
    report = {'status':'failed','previewOnly':True,'provesPhysicalAccuracy':False,
              'inputUnitsDeclared':args.units,'outputUnits':'mm',
              'referenceDimensionsMm':args.reference_mm,'specComparisonMetric':'boxExtentsMm',
              'limits':{'steps':args.max_steps,'seconds':args.max_seconds,'faces':args.max_faces},
              'toolFailures':[], 'detailStills':stills,
              'assumptions':['reference match is by construction','fill classification is heuristic','still attribution is model-declared']}
    def log(item):
        with log_path.open('a') as stream:
            stream.write(json.dumps(item,sort_keys=True,allow_nan=False)+'\n')
    try:
        initial = worker.stage(args.mesh,args.units,args.texture)
        report['initial'] = initial['after']
        report['runtime'] = initial['runtime']
        report['inputs'] = json.loads((worker.directory/'inputs.json').read_text())
        log({'type':'initialize','result':initial})
        context = SYSTEM+'\nProduct: '+args.product+'\nReference long-to-short mm: '+json.dumps(args.reference_mm)+\
                  '\nInitial measurements: '+json.dumps(initial['after'])+'\nDetail still evidence IDs (images follow this order): '+json.dumps(stills)
        while True:
            reply = adapter.next(events,context,images,min(worker.remaining(),120))
            worker.remaining()
            if not isinstance(reply.get('calls'),list) or len(reply['calls'])>16:
                raise ValueError('invalid or excessive model tool calls')
            log({'type':'assistant','text':reply['text'],'calls':reply['calls']})
            if not reply['calls']:
                report['modelSummary'] = reply['text']
                break
            if calls+len(reply['calls']) > args.max_steps:
                raise ValueError('maximum tool steps exceeded')
            if len({call['id'] for call in reply['calls']}) != len(reply['calls']):
                raise ValueError('duplicate tool IDs')
            events.append({'type':'assistant','native':reply.get('native')})
            results = []
            for call in reply['calls']:
                calls += 1
                evidence=[]
                try:
                    parameters=dict(call['arguments'])
                    identifiers=parameters.pop('evidence_still_ids',[])
                    if (not isinstance(identifiers,list) or len(identifiers)>4 or
                        any(not isinstance(i,str) or i not in still_by_id for i in identifiers) or
                        len(set(identifiers))!=len(identifiers)):
                        raise ValueError('unknown, duplicate or invalid evidence still IDs')
                    evidence=[still_by_id[i] for i in identifiers]
                    result = worker.apply(call['name'],parameters)
                    error = False
                except (ValueError,OSError,KeyError,TypeError) as exc:
                    result,error = {'ok':False,'error':str(exc)},True
                    report['toolFailures'].append({'step':calls,'name':call.get('name'),'error':str(exc)})
                log({'type':'tool','step':calls,'call':call,'result':result,'evidenceStills':evidence,
                     'evidenceAttribution':'model-declared' if evidence else 'not supplied'})
                rendered = []
                if not error and call['name']=='render':
                    for relative in result['data']['artifacts']:
                        if Path(relative).name in ('pos_x.png','pos_y.png','pos_z.png','iso_pp.png'):
                            image = worker.directory/relative
                            if not image.resolve().is_relative_to(worker.directory):
                                raise ValueError('worker render escaped job directory')
                            rendered.append(image_data(image))
                results.append({'id':call['id'],'result':result,'error':error,'images':rendered})
            events.append({'type':'results','items':results})
        final = worker.apply('measure',{})
        if not final['after']['watertight']:
            raise ValueError('final mesh is not watertight')
        if args.reference_mm is not None:
            report['specErrorMm'] = [actual-target for actual,target in zip(final['after']['boxExtentsMm'],args.reference_mm)]
            if any(abs(delta)>.05 for delta in report['specErrorMm']):
                raise ValueError('final measured dimensions miss reference tolerance 0.05 mm')
        worker.export()
        for source,target in [('repaired.obj','corrected.obj'),('repaired.stl','corrected.stl')]:
            shutil.copyfile(worker.directory/'export'/source,output/target)
        worker.remaining()
        report.update({'status':'complete','final':final['after'],
                       'outputs':{name:digest(output/name) for name in ('corrected.obj','corrected.stl')}})
        log({'type':'final','result':final})
        return report
    except Exception:
        # Full details belong in private tool/worker logs. No API keys/provider error bodies.
        report['failure'] = 'job did not meet completion requirements; inspect private logs'
        raise
    finally:
        report['toolSteps'] = calls
        report['elapsedSeconds'] = round(time.monotonic()-started,3)
        if log_path.exists():
            report['toolLogSha256'] = digest(log_path)
        write_json(output/'report.json',report)
