# SPDX-License-Identifier: GPL-3.0-or-later
"""Trusted worker lifecycle: stage assets, invoke isolated Blender, commit checkpoints."""
import hashlib
import importlib.util
import json
import os
import re
from pathlib import Path
import shlex
import signal
import subprocess
import sys
import time

from schema import validate

ROOT = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('repair_cli',ROOT.parent/'scan-repair'/'repair.py')
repair = importlib.util.module_from_spec(spec)
spec.loader.exec_module(repair)


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def write_json(path, value):
    Path(path).write_text(json.dumps(value,indent=2,sort_keys=True,allow_nan=False)+'\n')


def bounded_process(command, timeout, env, cwd):
    with subprocess.Popen(command,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,
                          env=env,cwd=cwd,start_new_session=True,close_fds=True) as process:
        try:
            stdout,stderr = process.communicate(timeout=timeout)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid,signal.SIGKILL)
            process.communicate()
            raise ValueError('worker wall-clock budget exceeded') from None
        if process.returncode:
            # Blender diagnostics remain in the private job directory, not model-facing errors.
            Path(cwd,'worker-error.log').write_text(stdout+stderr)
            raise ValueError('Blender operation failed; see private worker-error.log')


class Worker:
    def __init__(self, directory, seconds=300, max_faces=200000):
        if not 1 <= seconds <= 3600 or not 4 <= max_faces <= 1000000:
            raise ValueError('invalid worker budget')
        self.directory = Path(directory).resolve()
        self.directory.mkdir(parents=True,exist_ok=True)
        self.deadline = time.monotonic()+seconds
        self.max_faces = max_faces
        self.blender = repair.find_blender()
        self.counter = 0

    def remaining(self):
        remaining = self.deadline-time.monotonic()
        if remaining <= 0:
            raise ValueError('wall-clock budget exceeded')
        return remaining

    def stage(self, mesh, units, texture=None):
        mesh = Path(mesh).resolve()
        if mesh.suffix.lower() not in ('.obj','.stl') or units not in ('mm','cm','m'):
            raise ValueError('OBJ/STL and declared units required')
        assets = self.directory/'input'
        if assets.exists():
            raise ValueError('input staging directory must be fresh')
        planned,roles = {},{}

        def snapshot(path, limit):
            with path.open('rb') as stream:
                data = stream.read(limit+1)
            if len(data)>limit:
                raise ValueError('oversized input asset')
            return data

        def collect(path, role):
            # The role comes from the OBJ reference, not an inferred filename type.
            if role=='material' and path.suffix.lower()!='.mtl':
                raise ValueError('mtllib targets must use the .mtl suffix')
            resolved = path.resolve()
            if not resolved.is_relative_to(mesh.parent):
                raise ValueError('input material/texture escapes source directory')
            if not resolved.is_file():
                raise ValueError('missing input asset')
            relative = path.relative_to(mesh.parent)
            if relative in roles:
                if roles[relative]!=role:
                    raise ValueError('input asset has conflicting reference roles')
                return
            if len(roles)>=32:
                raise ValueError('too many input assets')
            roles[relative] = role
            data = snapshot(resolved,128*1024*1024)
            if role in ('obj','material'):
                for line in data.decode('utf-8').splitlines():
                    fields = shlex.split(line,comments=True)
                    if not fields:
                        continue
                    if role=='material':
                        if fields[0] not in ('newmtl','Kd','Ka','Ks','Ke','Ns','Ni','d','Tr','illum','Tf','map_Kd'):
                            raise ValueError('unsupported material directive; only base-colour assets are staged')
                        if fields[0]=='map_Kd' and not (len(fields)==2 or
                            (len(fields)==4 and fields[1]=='-clamp' and fields[2] in ('on','off'))):
                            raise ValueError('unsupported base-colour material mapping')
                    if fields[0]=='mtllib' or (role=='material' and fields[0]=='map_Kd'):
                        if fields[0]=='mtllib' and len(fields)!=2:
                            raise ValueError('one MTL filename per declaration required')
                        # Converter-generated paths need no quoting/escaping/expansion.
                        # Reject ambiguous declarations rather than let importer parsing differ.
                        if line.split()!=fields or not re.fullmatch(r'[A-Za-z0-9_./-]+',fields[-1]):
                            raise ValueError('unsafe or ambiguous input asset reference')
                        dependency = Path(fields[-1])
                        if dependency.is_absolute() or '..' in dependency.parts:
                            raise ValueError('unsafe input asset reference')
                        collect(path.parent/dependency,'material' if fields[0]=='mtllib' else 'image')
            planned[relative] = data

        collect(mesh,'obj' if mesh.suffix.lower()=='.obj' else 'mesh')
        override = None
        if texture:
            # An explicit caller-selected override is separate from untrusted MTL references.
            image = Path(texture).resolve()
            if not image.is_file():
                raise ValueError('missing texture override')
            name = Path('texture-override'+image.suffix.lower())
            if name in planned or len(planned)>=32:
                raise ValueError('texture override collides with staged assets or exceeds cap')
            planned[name] = snapshot(image,32*1024*1024)
            override = assets/name
        # Nothing is copied until the entire reference graph passes validation.
        assets.mkdir()
        for relative,data in planned.items():
            target = assets/relative
            target.parent.mkdir(parents=True,exist_ok=True)
            target.write_bytes(data)
        manifest = {str((assets/name).relative_to(self.directory)):hashlib.sha256(data).hexdigest()
                    for name,data in planned.items()}
        write_json(self.directory/'inputs.json',manifest)
        return self._run('initialize',{'mesh':str(assets/mesh.name),
                         'scale':{'mm':1,'cm':10,'m':1000}[units],
                         'texture':str(override) if override else None})

    def apply(self,name,args):
        validate(name,args)
        return self._run(name,args)

    def _run(self,name,args):
        self.counter += 1
        config = {'operation':name,'args':args,'directory':str(self.directory),
                  'max_faces':self.max_faces,'sequence':self.counter}
        request = self.directory/'request.json'
        result = self.directory/'result.json'
        write_json(request,config)
        result.unlink(missing_ok=True)
        env = {key:value for key,value in os.environ.items() if key in
               ('PATH','DISPLAY','XAUTHORITY','LIBGL_ALWAYS_SOFTWARE','LD_LIBRARY_PATH')}
        env.update({'HOME':str(self.directory),'PYTHONNOUSERSITE':'1','OMP_NUM_THREADS':'2'})
        command = [sys.executable,'-I',str(ROOT/'sandbox.py'),self.blender,'--background',
                   '--factory-startup','--disable-autoexec','--python-exit-code','1',
                   '--python',str(ROOT/'worker.py'),'--',str(request)]
        bounded_process(command,min(self.remaining(),120),env,self.directory)
        response = json.loads(result.read_text())
        if not response.get('ok'):
            raise ValueError(response.get('error','worker failed'))
        pending = self.directory/'pending.blend'
        if pending.exists():
            pending.replace(self.directory/'state.blend')
        return response

    def export(self):
        return self._run('export',{})
