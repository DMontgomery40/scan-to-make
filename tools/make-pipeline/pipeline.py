# SPDX-License-Identifier: MIT
"""Thin subprocess stages, canonical receipts, separate volatile diagnostics."""
import hashlib
import json
import math
import os
from pathlib import Path
import signal
import subprocess
import sys
import time
import zipfile

from staging import bounded_bytes, snapshot_obj
# Same cap as tools/scan-correct adapters.image_data, so an oversized still fails at intake, not after repair.
STILL_CAP=8*1024*1024

TOOLS=Path(__file__).resolve().parents[1]
TEMPLATES={'scan-cradle':'cradle.py','wall-mount':'mount.py','protective-sleeve':'sleeve.py','edge-clip':'clip.py'}


def write_json(path,data):
    Path(path).write_text(json.dumps(data,indent=2,sort_keys=True,allow_nan=False)+'\n')


def receipt(path,root):
    path=Path(path)
    if path.is_symlink() or not path.resolve().is_relative_to(root):raise ValueError('artifact escaped private job')
    h=hashlib.sha256();size=0
    with path.open('rb') as stream:
        while data:=stream.read(1024*1024):h.update(data);size+=len(data)
    return {'path':str(path.relative_to(root)),'sha256':h.hexdigest(),'bytes':size}


def terminate_tree(process):
    """Stop the parent, snapshot descendant PIDs (including detached workers), kill."""
    try:os.killpg(process.pid,signal.SIGSTOP)
    except ProcessLookupError:return
    descendants=[]
    try:
        listing=subprocess.run(['/bin/ps','-axo','pid=,ppid='],capture_output=True,text=True,timeout=2,
                               env={'PATH':'/usr/bin:/bin'})
        children={}
        for line in listing.stdout.splitlines():
            pid,parent=map(int,line.split());children.setdefault(parent,[]).append(pid)
        queue=[process.pid]
        for parent in queue:
            for pid in children.get(parent,[]):
                try:os.kill(pid,signal.SIGSTOP)
                except ProcessLookupError:continue
                descendants.append(pid);queue.append(pid)
    finally:
        for pid in reversed(descendants):
            try:os.kill(pid,signal.SIGKILL)
            except ProcessLookupError:pass
        try:os.killpg(process.pid,signal.SIGKILL)
        except ProcessLookupError:pass


class StageError(Exception):
    def __init__(self,stage,message):self.stage,self.message=stage,message;super().__init__(stage+': '+message)


class Pipeline:
    def __init__(self,args,*,tools=TOOLS):
        self.args=args;self.tools=Path(tools).resolve();self.out=args.out.resolve()
        if not 1<=args.max_seconds<=7200 or not 1<=args.stage_seconds<=900 or not 4<=args.max_faces<=1000000 or not 1<=args.max_steps<=100:
            raise ValueError('invalid time, face or step bound')
        if not args.capture.is_file() or args.capture.suffix.lower() not in ('.usdz','.obj'):raise ValueError('existing USDZ or OBJ required')
        if args.capture.suffix.lower()=='.obj' and args.units is None:raise ValueError('OBJ requires explicit --units')
        if args.capture.suffix.lower()=='.usdz' and args.units is not None:raise ValueError('USDZ units come from authored metadata')
        if args.reference is not None and (not all(math.isfinite(v) and 0<v<=10000 for v in args.reference)):
            raise ValueError('reference dimensions must be positive finite mm, at most 10000')
        if not 1<=len(args.request)<=1000 or len(args.product)>512:raise ValueError('request/product length cap exceeded')
        if args.capture.resolve().is_relative_to(self.out):raise ValueError('output must not contain source')
        if self.out.exists() and any(self.out.iterdir()):raise ValueError('output must be fresh or empty')
        self.reference=sorted(args.reference,reverse=True) if args.reference else None
        self.started=time.monotonic();self.deadline=self.started+args.max_seconds
        self.active='intake';self.timings=[]
        self.report={'schema':'scan-to-make.make-pipeline/1','status':'failed','previewOnly':True,
                     'dispatchAuthorized':False,'provesPhysicalFit':False,
                     'referenceMm':self.reference,'referenceInputMm':args.reference,'specComparisonMetric':'boxExtentsMm',
                     'profile':args.profile,'material':args.material,'adapter':args.adapter,'request':args.request,
                     'allowSupports':args.allow_supports,
                     'limits':{'seconds':args.max_seconds,'stageSeconds':args.stage_seconds,'faces':args.max_faces,'steps':args.max_steps},
                     'capabilities':{},'toolEntrypoints':{},'warnings':[],'stages':[],'checkedArtifact':None,
                     'prd81':{'scope':'template-first local subset','registryFitBase':'not implemented','critic':'not implemented','freeformCoder':'not supported'},
                     'timings':{'path':'timings.json','excludedFromDeterministicReport':True}}

    def remaining(self):
        value=self.deadline-time.monotonic()
        if value<=0:raise StageError(self.active,'pipeline wall-clock budget exceeded')
        return min(value,self.args.stage_seconds)

    def canonical(self,value):
        if isinstance(value,dict):return {k:self.canonical(v) for k,v in value.items() if k!='elapsedSeconds'}
        if isinstance(value,list):return [self.canonical(v) for v in value]
        if isinstance(value,str):return value.replace(str(self.out),'$JOB').replace(str(self.tools),'$TOOLS')
        return value

    def environment(self,model=False):
        allowed={'PATH','HOME','TMPDIR','DISPLAY','XAUTHORITY','BLENDER','LIBGL_ALWAYS_SOFTWARE','LD_LIBRARY_PATH','SYSTEMROOT'}
        env={k:v for k,v in os.environ.items() if k in allowed}
        env.update({'PYTHONNOUSERSITE':'1','PYTHONDONTWRITEBYTECODE':'1','OMP_NUM_THREADS':'2'})
        if model and self.args.adapter!='scripted':
            key=self.args.key_env or ('ANTHROPIC_API_KEY' if self.args.adapter=='anthropic' else 'OPENAI_API_KEY')
            if key in os.environ:env[key]=os.environ[key]
        return env

    def execute(self,name,command,*,model=False,codes=(0,)):
        """Test seam is Python-only; production CLI exposes no command/sandbox override."""
        self.active=name;timeout=self.remaining();start=time.monotonic()
        entry=next((Path(arg) for arg in command[1:] if str(arg).endswith('.py') and Path(arg).is_file()),None)
        if entry is not None:
            self.report['toolEntrypoints'][name+':'+entry.name]=hashlib.sha256(entry.read_bytes()).hexdigest()
        logs=self.out/'diagnostics';logs.mkdir(exist_ok=True)
        index=len(self.timings);stdout=logs/f'{index:02d}-{name}.stdout';stderr=logs/f'{index:02d}-{name}.stderr'
        code=None
        try:
            with stdout.open('wb') as a,stderr.open('wb') as b:
                with subprocess.Popen(command,stdout=a,stderr=b,cwd=self.tools.parent,env=self.environment(model),start_new_session=True) as process:
                    try:code=process.wait(timeout=timeout)
                    except subprocess.TimeoutExpired:
                        terminate_tree(process);process.wait()
                        raise StageError(name,'subprocess wall-clock budget exceeded') from None
                    except BaseException:
                        terminate_tree(process);process.wait();raise
            self.remaining()
            if code not in codes:raise StageError(name,f'tool exited {code}; see private diagnostics')
            if stdout.stat().st_size>16*1024*1024:raise StageError(name,'tool JSON exceeds output cap')
            return stdout.read_text()
        finally:
            self.timings.append({'stage':name,'elapsedSeconds':round(time.monotonic()-start,6),'exitCode':code,
                                 'diagnostics':[receipt(p,self.out) for p in (stdout,stderr) if p.exists()]})

    def call(self,name,tool,args,**kwargs):
        return self.execute(name,[sys.executable,'-B',str(self.tools/tool),*map(str,args)],**kwargs)

    def result(self,name,data,inputs=(),outputs=(),verdict='passed'):
        if not isinstance(data,dict):raise ValueError('tool result must be a JSON object')
        target=self.out/(name+'-result.json');write_json(target,self.canonical(data))
        self.report['stages'].append({'stage':name,'verdict':verdict,
             'inputs':[receipt(p,self.out) for p in inputs],
             'outputs':[receipt(p,self.out) for p in [*outputs,target]]})
        self.persist()
        return data

    def persist(self):
        write_json(self.out/'pipeline-report.json',self.report)
        write_json(self.out/'timings.json',{'elapsedSeconds':round(time.monotonic()-self.started,6),'stages':self.timings})

    def skipped(self,name,reason):self.result(name,{'reason':reason},verdict='skipped')

    def template_arguments(self,name,params):
        catalog=json.loads((self.tools/'templates/catalog.json').read_text())
        template=next(t for t in catalog['templates'] if t['id']==name)
        fields={p['name']:p for p in template['parameters']};args=[]
        for key,value in sorted(params.items()):
            if key not in fields:raise ValueError('unknown template parameter: '+key)
            field=fields[key]
            if value is None:
                if field.get('default') is not None:raise ValueError('parameter is not nullable: '+key)
                continue
            if field['type']=='enum':
                if value not in field['choices']:raise ValueError('invalid enum parameter: '+key)
            elif type(value) not in (int,float) or not math.isfinite(value):raise ValueError('finite numeric parameter required: '+key)
            args.append(field['flag']+'='+str(value))
        return args

    def match(self,name,params,source):
        self.active='match'
        if name not in TEMPLATES:raise StageError('match','only the four supported scan templates can be generated')
        self.template_arguments(name,params)
        catalog=self.tools/'templates/catalog.json'
        self.result('match',{'status':'selected','templateId':name,'params':params,'source':source,
                            'catalogSha256':hashlib.sha256(catalog.read_bytes()).hexdigest(),
                            'registryFitBase':'not implemented; no free-remix search or offer',
                            'prd81Compliance':'local catalog subset only; full Match and critic remain open'})

    def adapter_arguments(self):
        args=['--adapter',self.args.adapter]
        for flag,value in (('--model',self.args.model),('--base-url',self.args.base_url),('--key-env',self.args.key_env)):
            if value:args.extend([flag,value])
        return args

    def snapshot(self,source,relative,limit):
        target=self.out/relative;data=bounded_bytes(source,limit);target.parent.mkdir(parents=True,exist_ok=True);target.write_bytes(data)
        return target

    def run(self):
        a=self.args;self.out.mkdir(parents=True,exist_ok=True);self.out.chmod(0o700)
        try:
            self.active='intake';start=time.monotonic()
            if a.capture.suffix.lower()=='.obj':
                mesh,inputs=snapshot_obj(a.capture,self.out/'input',a.max_faces);units=a.units
            else:
                import io
                source_bytes=bounded_bytes(a.capture)
                with zipfile.ZipFile(io.BytesIO(source_bytes)) as archive:
                    if len(archive.infolist())>256 or sum(i.file_size for i in archive.infolist())>256*1024*1024:
                        raise ValueError('USDZ member/expanded-byte cap exceeded')
                mesh=self.out/'input/capture.usdz';mesh.parent.mkdir();mesh.write_bytes(source_bytes);inputs=[mesh];units=None
            stills=[]
            if a.stills:
                if not a.stills.is_dir():raise ValueError('stills must be a directory')
                found=sorted(a.stills.iterdir())
                images=[p for p in found if p.suffix.lower() in ('.png','.jpg','.jpeg','.webp')]
                if not 1<=len(images)<=4:raise ValueError('stills directory must contain 1..4 supported images')
                for i,path in enumerate(images,1):
                    if not path.resolve().is_relative_to(a.stills.resolve()):raise ValueError('still escapes selected directory')
                    stills.append(self.snapshot(path,f'inputs/still-{i}{path.suffix.lower()}',STILL_CAP))
            script=self.snapshot(a.script,'inputs/correction-script.json',1024*1024) if a.script else None
            planner_script=self.snapshot(a.planner_script,'inputs/planner-script.json',1024*1024) if a.planner_script else None
            params={}
            for item in a.param:
                key,raw=item.split('=',1)
                if key in params:raise ValueError('duplicate template parameter')
                params[key]=json.loads(raw)
            if len(params)>32:raise ValueError('too many template parameters')
            if a.request in TEMPLATES:self.template_arguments(a.request,params)
            elif params:raise ValueError('--param is only for named templates')
            self.timings.append({'stage':'intake','elapsedSeconds':round(time.monotonic()-start,6)})
            self.result('intake',{'units':units,'sourceFormat':a.capture.suffix.lower(),'params':params},outputs=[*inputs,*stills,*([script] if script else []),*([planner_script] if planner_script else [])])
            if mesh.suffix=='.usdz':
                self.active='convert';folder=self.out/'convert';folder.mkdir()
                data=json.loads(self.call('convert',Path('capture-mesh-convert/convert.py'),[mesh,'--out',folder/'capture.obj'],codes=(0,4)))
                self.result('convert',data,[mesh],sorted(folder.iterdir()))
                if not data.get('metricQualified') or data.get('unitsAuthored') is not True:raise StageError('convert','capture is not metric-qualified')
                mesh,validated=snapshot_obj(folder/'capture.obj',self.out/'converted-input',a.max_faces)
                self.report['stages'][-1]['outputs'].extend(receipt(p,self.out) for p in validated)
                # Current correction/advice CLIs accept only these declared unit scales.
                units={1.0:'m',.01:'cm',.001:'mm'}.get(data['metersPerUnit'])
                unit_args=['--units-sidecar',self.out/'convert-result.json']
            else:
                self.skipped('convert','OBJ input: validated bytes retained without USD conversion');unit_args=['--units',units]
            repaired=self.out/'repair/repaired.obj'
            data=json.loads(self.call('repair',Path('scan-repair/repair.py'),['repair',mesh,*unit_args,'--out',repaired.parent,'--target-faces',a.max_faces]))
            self.result('repair',data,[mesh],sorted(repaired.parent.iterdir()))
            measured=json.loads(self.call('measure',Path('scan-repair/repair.py'),['measure',repaired,'--units','mm']))
            self.result('measure',measured,[repaired])
            if measured['faces']>a.max_faces:raise StageError('measure','repaired mesh exceeds face cap')
            correct=Path('scan-correct/correct.py')
            help_text=self.call('advise',correct,['--help'])
            caps=self.report['capabilities'];caps['advise']='advise' in help_text;caps['planner']=(self.tools/'design-planner/planner.py').is_file()
            if not caps['advise']:raise StageError('advise','scan-correct advise is not installed; update tools after its merge')
            advice_mesh,advice_units=(mesh,units) if units is not None else (repaired,'mm')
            if units is None:self.report['warnings'].append('Nonstandard USD unit scale: advice uses repaired geometry without UVs.')
            self.report['warnings'].append('Correction uses repaired mm geometry; scan-repair does not retain UVs. Original textured source is used for advice where units permit.')
            ref=['--reference-mm',*self.reference] if self.reference else []
            advice=json.loads(self.call('advise',correct,['advise',advice_mesh,'--units',advice_units,'--out',self.out/'advice','--resolution','128',
                          '--max-seconds',max(1,int(self.remaining())),'--max-faces',a.max_faces,*ref]))
            advice_outputs=[self.out/'advice/advice.json',*[self.out/'advice'/t['render']['path'] for t in advice['closeupAdvice']['targets']]]
            self.result('advise',advice,[advice_mesh],advice_outputs)
            if a.adapter=='scripted' and script is None:
                script=self.out/'default-correction.json'
                sequence=[{'name':'measure','arguments':{}}]
                if self.reference:sequence.append({'name':'scale_to_reference','arguments':{'target_mm':self.reference}})
                write_json(script,sequence)
                self.report['warnings'].append('Default scripted correction measures and fits declared dimensions only; it does not infer lost detail or semantic features.')
            correction_args=['run',repaired,'--units','mm','--out',self.out/'correct','--product',a.product,*self.adapter_arguments(),*ref,
                             '--max-seconds',max(1,int(self.remaining())),'--max-faces',a.max_faces,'--max-steps',a.max_steps]
            if a.adapter=='scripted':correction_args+=['--script',script]
            for still in stills:correction_args+=['--still',still]
            data=json.loads(self.call('correct',correct,correction_args,model=True))
            log=self.out/'correct/tool-calls.jsonl'
            normalized=self.out/'tool-calls.jsonl'
            normalized.write_text(''.join(json.dumps(self.canonical(json.loads(line)),sort_keys=True,allow_nan=False)+'\n' for line in log.read_text().splitlines()))
            data['toolLogSha256']=receipt(normalized,self.out)['sha256']
            self.timings[-1]['rawReports']=[receipt(self.out/'correct/report.json',self.out),receipt(log,self.out)]
            corrected=self.out/'correct/corrected.stl'
            self.result('correct',data,[repaired,*stills,*([script] if script else [])],[corrected,self.out/'correct/corrected.obj',normalized])
            if data.get('status')!='complete' or data.get('toolFailures'):raise StageError('correct','correction incomplete or contains failed tool calls')
            design=self.out/'design'
            if a.request in TEMPLATES:
                self.skipped('plan','named template selected')
                self.match(a.request,params,'explicit named template')
                data=json.loads(self.call('design',Path('templates')/a.request/TEMPLATES[a.request],[corrected,'--out',design,*self.template_arguments(a.request,params)]))
            else:
                self.active='plan'
                if not caps['planner']:raise StageError('plan','optional design-planner is not installed; use a named template')
                if a.adapter=='scripted' and planner_script is None:raise StageError('plan','free text with scripted adapter requires --planner-script')
                plan_args=['plan',a.request,'--scan',self.out/'correct-result.json','--out',self.out/'plan.json',*self.adapter_arguments(),'--max-seconds',max(1,int(self.remaining()))]
                if planner_script:plan_args+=['--script',planner_script]
                plan=json.loads(self.call('plan',Path('design-planner/planner.py'),plan_args,model=True))
                self.result('plan',plan,[self.out/'correct-result.json'],[self.out/'plan.json'],plan.get('status','unknown'))
                if plan.get('status')!='ready':raise StageError('plan','planner needs input or cannot fit request')
                self.match(plan['templateId'],plan['params'],'planner selection')
                data=json.loads(self.call('design',Path('design-planner/planner.py'),['generate',self.out/'plan.json','--mesh',corrected,'--out',design,'--max-seconds',max(1,int(self.remaining()))]))
            design_outputs=sorted(p for p in design.rglob('*') if p.is_file())
            self.result('design',data,[corrected],design_outputs)
            stls=list(design.glob('*.stl'))
            if len(stls)!=1:raise StageError('design','expected exactly one template STL')
            stl=stls[0];print_tool=Path('printability/printability.py')
            self.active='printability'
            declared=json.loads((design/'manifest.json').read_text())
            before_check=receipt(stl,self.out)
            if (declared.get('units')!='mm' or declared.get('previewOnly') is not True or
                declared.get('outputSha256',{}).get(stl.name)!=before_check['sha256']):
                raise StageError('printability','template manifest does not bind the mm preview STL')
            profile_args=['--profile',a.profile,'--material',a.material]
            data=json.loads(self.call('printability',print_tool,['check',stl,*profile_args]))
            if (data.get('input',{}).get('sha256')!=before_check['sha256'] or
                receipt(stl,self.out)!=before_check):raise StageError('printability','checked STL bytes changed or digest mismatch')
            self.result('printability',data,[stl],verdict=data.get('verdict','unknown'))
            allowed_verdicts={'printable','printable-with-supports'} if a.allow_supports else {'printable'}
            if data['verdict'] not in allowed_verdicts:
                raise StageError('printability','unchanged template frame fails gate or requires explicit --allow-supports; companion lay_flat may help; recheck transformed bytes')
            artifact=receipt(stl,self.out)
            manifest={'schema':'scan-to-make.checked-design/1','artifact':{**artifact,'mediaType':'model/stl','units':'mm'},
                      'templateManifest':receipt(design/'manifest.json',self.out),
                      'printability':receipt(self.out/'printability-result.json',self.out),
                      'verdict':data['verdict'],'profile':a.profile,'material':a.material,'allowSupports':a.allow_supports,
                      'previewOnly':True,'acceptedByHuman':False,'dispatchAuthorized':False,
                      'provesPhysicalFit':False,'orientation':'template frame unchanged',
                      'nextBoundary':'companion accepted-artifact/prepared-job flow: lay_flat, slice_stl, inspect_print_file, then human-approved dispatch'}
            write_json(self.out/'manifest.json',manifest)
            self.report.update(status='complete',checkedArtifact=artifact,manifest=receipt(self.out/'manifest.json',self.out))
            self.persist();(self.out/'summary.txt').write_text(self.summary()+'\n')
            return self.report
        except (ValueError,OSError,TypeError,KeyError,StopIteration,StageError,zipfile.BadZipFile) as exc:
            error=exc if isinstance(exc,StageError) else StageError(self.active,'invalid input/output; see private diagnostics')
            if not self.report['stages'] or self.report['stages'][-1]['stage']!=error.stage:
                self.report['stages'].append({'stage':error.stage,'verdict':'failed','inputs':[],'outputs':[]})
            else:self.report['stages'][-1]['verdict']='failed'
            diagnostics=self.out/'diagnostics';diagnostics.mkdir(exist_ok=True)
            host_error=diagnostics/'host-error.txt';host_error.write_text(type(exc).__name__+': '+str(exc)+'\n')
            self.timings.append({'stage':error.stage,'failureDiagnostic':receipt(host_error,self.out)})
            self.report['status']='failed';self.report['error']={'stage':error.stage,'message':error.message,'diagnostics':'diagnostics/host-error.txt'}
            self.persist();(self.out/'summary.txt').write_text(self.summary()+'\n')
            raise error from None

    def summary(self):
        stages=', '.join(s['stage']+': '+s['verdict'] for s in self.report['stages'])
        return f"{self.report['status']}. {stages}. Preview only."
