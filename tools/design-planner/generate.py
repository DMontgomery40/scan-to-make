# SPDX-License-Identifier: MIT
"""Run a ready plan's template headlessly in its own process and return the template manifest.

The planner never imports template code: each template keeps its own licence and
runtime (Blender for mesh templates, plain Python for FitSpec templates).
"""
import copy
import hashlib
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import sys

from plan import validate_plan

MAX_SECONDS = 3600
SECRET_ENV = re.compile(r'(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)',re.IGNORECASE)


def template_env():
    """Template processes need BLENDER and display settings, never provider credentials."""
    return {key:value for key,value in os.environ.items() if not SECRET_ENV.search(key)}


def _flag_value(value):
    return repr(value) if isinstance(value,float) else str(value)


def cli_command(template, params, mesh, out):
    entry = Path(template['folder'])/template['entrypoint']
    command = [sys.executable,str(entry),str(mesh),'--out',str(out)]
    for param in template['parameters']:
        value = params[param['name']]
        if value is not None:
            # --flag=value keeps negative numbers and axes such as -X from parsing as options.
            command.append(f'{param["flag"]}={_flag_value(value)}')
    return command


def fitspec(catalog, template, params, plan_digest):
    spec = copy.deepcopy(catalog.example_spec(template['id']))
    measured = set(catalog.measured_parameters(template['id']))
    spec['id'] = 'design-plan-'+plan_digest[:16]
    spec['revision'] = 0
    for param in template['parameters']:
        name, value = param['name'], params[param['name']]
        if param['type'] == 'interval':
            spec['dimensions'][name] = {**value,'source':'manual' if name in measured else 'design',
                                        'sourceId':'design-plan-'+name}
        elif param['type'] == 'integer':
            spec.setdefault('parameters',{})[name] = value
        else:
            raise ValueError(f'{template["id"]}.{name}: FitSpec parameter type {param["type"]} is not supported')
    return spec


def _kill_group(pgid):
    try:
        os.killpg(pgid,signal.SIGKILL)
    except ProcessLookupError:
        pass


def run_template(command, cwd, env, timeout):
    """Run a template as its own process-group leader and kill the whole group when it ends.

    Mesh template wrappers launch Blender with their own unbounded subprocess call, so
    killing only the direct child would leave Blender running past the budget.
    Descendants that start their own session escape the group; templates must not do that.
    """
    with subprocess.Popen(command,cwd=cwd,env=env,stdout=subprocess.PIPE,stderr=subprocess.PIPE,
                          text=True,start_new_session=True) as process:
        try:
            stdout, stderr = process.communicate(timeout=timeout)
        except BaseException:
            _kill_group(process.pid)
            process.wait()
            raise
        finally:
            _kill_group(process.pid)
    return subprocess.CompletedProcess(command,process.returncode,stdout,stderr)


def _output_stem(template):
    stems = [name[:-len('.manifest.json')] for name in template['outputs'] if name.endswith('.manifest.json')]
    if len(stems) != 1:
        raise ValueError(f'{template["id"]}: catalog outputs must name exactly one .manifest.json')
    return stems[0]


def generate(plan, catalog, out, mesh=None, seconds=900, runner=run_template):
    errors = validate_plan(plan,catalog)
    if errors:
        raise ValueError('plan cannot be generated: '+'; '.join(errors))
    if not 1 <= seconds <= MAX_SECONDS:
        raise ValueError(f'generation time budget must be within [1, {MAX_SECONDS}] seconds')
    template = catalog.template(plan['templateId'])
    kind = template['input']['kind']
    out = Path(out).resolve()
    if out.exists() and (not out.is_dir() or any(out.iterdir())):
        raise ValueError('output directory must be new or empty')
    plan_digest = hashlib.sha256(json.dumps(plan,sort_keys=True,allow_nan=False).encode()).hexdigest()
    if kind == 'repaired-scan-mesh':
        if mesh is None:
            raise ValueError(f'{template["id"]} needs the repaired mesh (--mesh)')
        mesh = Path(mesh).resolve()
        if not mesh.is_file() or mesh.suffix.lower().lstrip('.') not in template['input']['formats']:
            raise ValueError(f'mesh must be an existing {"/".join(template["input"]["formats"]).upper()} file')
        out.mkdir(parents=True,exist_ok=True)
        command = cli_command(template,plan['params'],mesh,out)
        manifest_path = out/'manifest.json'
        spec_path = None
    elif kind == 'fitspec':
        if mesh is not None:
            raise ValueError(f'{template["id"]} is sized from measurements, not a mesh')
        out.mkdir(parents=True,exist_ok=True)
        stem = _output_stem(template)
        spec_path = out/'fitspec.json'
        spec_path.write_text(json.dumps(fitspec(catalog,template,plan['params'],plan_digest),indent=2)+'\n')
        command = [sys.executable,str(Path(template['folder'])/template['entrypoint']),'generate',
                   '--spec',str(spec_path),'--out-dir',str(out),'--name',stem]
        manifest_path = out/f'{stem}.manifest.json'
    else:
        raise ValueError(f'{template["id"]}: unsupported template input kind {kind!r}')
    try:
        result = runner(command,cwd=catalog.repo,env=template_env(),timeout=seconds)
    except subprocess.TimeoutExpired:
        raise ValueError(f'{template["id"]} exceeded the {seconds} s generation budget') from None
    if result.returncode:
        detail = (result.stderr or result.stdout or '').strip()[-2000:]
        raise ValueError(f'{template["id"]} failed (exit {result.returncode}): {detail}')
    if not manifest_path.is_file():
        raise ValueError(f'{template["id"]} did not write {manifest_path.name}')
    manifest = json.loads(manifest_path.read_text())
    outputs = {str(path.relative_to(out)):hashlib.sha256(path.read_bytes()).hexdigest()
               for path in sorted(out.rglob('*')) if path.is_file()}
    receipt = {'status':'generated','previewOnly':True,'templateId':template['id'],'planSha256':plan_digest,
               'command':[str(Path(part).relative_to(catalog.repo)) if Path(part).is_absolute() and
                          Path(part).is_relative_to(catalog.repo) else part for part in command[1:]],
               'fitspec':spec_path.name if spec_path else None,'manifest':manifest,'outputs':outputs}
    (out/'design-plan.json').write_text(json.dumps(plan,indent=2,sort_keys=True,allow_nan=False)+'\n')
    return receipt
