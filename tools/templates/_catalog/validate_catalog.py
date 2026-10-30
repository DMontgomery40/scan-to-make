#!/usr/bin/env python3
"""Check tools/templates/catalog.json against the real template folders and code.

Static checks read each entrypoint with ast (no imports, no Blender): CLI
templates must declare exactly the catalogued argparse parameters with the same
types, defaults and choices, and any LIMITS table must equal the catalogued
bounds. FitSpec templates must consume exactly the catalogued keys, with
defaults equal to their contract fixture. bound_violations() then exercises the
bounds: CLIs must reject out-of-range values before Blender is looked up, and
FitSpec sizing must reject out-of-range dimensions.

Usage: python3 validate_catalog.py  (exit 1 and one line per problem on failure)
"""
from __future__ import annotations

import ast
import copy
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile

TEMPLATES = Path(__file__).resolve().parents[1]
REPO = TEMPLATES.parents[1]
CATALOG = TEMPLATES/'catalog.json'
PARAMETER_KEYS = ('name','type','units','default','min','max','description')
ENTRY_KEYS = ('id','name','summary','folder','entrypoint','runtime','licence','workflow','input',
              'outputs','previewOnly','parameterSource','parameters')
TYPES = {'float':'number','int':'integer'}
BLENDER_MISSING = 'BLENDER does not name an executable'


def load():
    return json.loads(CATALOG.read_text())


def literal(node):
    try:
        return ast.literal_eval(node)
    except ValueError:
        return None


def module_constants(path):
    tree = ast.parse(path.read_text())
    found = {}
    for node in tree.body:
        if isinstance(node,ast.Assign) and len(node.targets) == 1 and isinstance(node.targets[0],ast.Name):
            value = literal(node.value)
            if value is not None:
                found[node.targets[0].id] = value
    return tree,found


def cli_arguments(tree):
    """argparse add_argument calls: {dest: {flag, type, default, choices}}."""
    args = {}
    for node in ast.walk(tree):
        if not (isinstance(node,ast.Call) and isinstance(node.func,ast.Attribute)
                and node.func.attr == 'add_argument' and node.args):
            continue
        flag = literal(node.args[0])
        kw = {k.arg:k.value for k in node.keywords}
        dest = flag.lstrip('-').replace('-','_')
        args[dest] = {'flag':flag,
                      'type':kw['type'].id if isinstance(kw.get('type'),ast.Name) else None,
                      'default':literal(kw['default']) if 'default' in kw else None,
                      'choices':literal(kw['choices']) if 'choices' in kw else None}
    return args


def check_cli(entry, path, problems):
    tree,constants = module_constants(path)
    args = cli_arguments(tree)
    design = {k:v for k,v in args.items() if v['flag'] not in entry.get('nonDesignArguments',[])}
    names = [p['name'] for p in entry['parameters']]
    if set(design) != set(names):
        problems.append(f"{entry['id']}: catalog parameters {sorted(names)} != code {sorted(design)}")
    limits = constants.get('LIMITS')
    for p in entry['parameters']:
        code = design.get(p['name'])
        if code is None:
            continue
        where = f"{entry['id']}.{p['name']}"
        if p.get('flag') != code['flag']:
            problems.append(f'{where}: flag {p.get("flag")} != {code["flag"]}')
        expected_type = 'enum' if code['choices'] is not None else TYPES.get(code['type'])
        if p['type'] != expected_type:
            problems.append(f"{where}: type {p['type']} != {expected_type}")
        if p['default'] != code['default'] or type(p['default']) is not type(code['default']):
            problems.append(f"{where}: default {p['default']!r} != {code['default']!r}")
        if code['choices'] is not None and p.get('choices') != code['choices']:
            problems.append(f"{where}: choices {p.get('choices')} != {code['choices']}")
        if limits is not None and p['type'] in ('number','integer'):
            bounds = limits.get(p['name'])
            catalogued = (p['min'],p['max']) if p['min'] is not None or p['max'] is not None else None
            if catalogued != (tuple(bounds) if bounds else None) or p.get('exclusiveMin') or p.get('exclusiveMax'):
                problems.append(f"{where}: bounds {catalogued} != LIMITS {bounds} (inclusive)")
    if limits is not None and set(limits) - set(names):
        problems.append(f"{entry['id']}: LIMITS has uncatalogued {sorted(set(limits)-set(names))}")


def check_fitspec(entry, path, problems):
    _,constants = module_constants(path)
    keys = list(constants.get('DIM_KEYS',()))+list(constants.get('PARAMETER_KEYS',()))
    names = [p['name'] for p in entry['parameters']]
    if names != keys:
        problems.append(f"{entry['id']}: catalog parameters {names} != code {keys}")
    spec_path = REPO/entry['input']['exampleSpec']
    if not spec_path.is_file():
        problems.append(f"{entry['id']}: exampleSpec missing")
        return
    spec = json.loads(spec_path.read_text())
    if (spec.get('template'),spec.get('schemaVersion')) != (entry['input']['template'],entry['input']['schemaVersion']):
        problems.append(f"{entry['id']}: exampleSpec template/schemaVersion mismatch")
    for p in entry['parameters']:
        if p['type'] == 'interval':
            d = spec['dimensions'].get(p['name'],{})
            actual = {k:d.get(k) for k in ('nominalMm','lowerMm','upperMm')}
        else:
            actual = spec.get('parameters',{}).get(p['name'])
        if p['default'] != actual:
            problems.append(f"{entry['id']}.{p['name']}: default {p['default']} != exampleSpec {actual}")


def validate(catalog):
    problems = []
    entries = catalog.get('templates',[])
    ids = [e.get('id') for e in entries]
    if len(set(ids)) != len(ids):
        problems.append('duplicate template ids')
    folders = sorted(p.name for p in TEMPLATES.iterdir() if p.is_dir() and not p.name.startswith('_')
                     and not p.name.startswith('.'))
    support = sorted(p.name for p in TEMPLATES.iterdir() if p.is_dir() and p.name.startswith('_'))
    catalogued = sorted(Path(e.get('folder','')).name for e in entries)
    if folders != catalogued:
        problems.append(f'template folders {folders} != catalogued {catalogued}')
    if support != sorted(catalog.get('supportFolders',{})):
        problems.append(f"support folders {support} != catalogued {sorted(catalog.get('supportFolders',{}))}")
    for entry in entries:
        missing = [k for k in ENTRY_KEYS if k not in entry]
        if missing:
            problems.append(f"{entry.get('id')}: missing keys {missing}")
            continue
        folder = REPO/entry['folder']
        if Path(entry['folder']).parent != Path('tools/templates') or folder.name != entry['id']:
            problems.append(f"{entry['id']}: folder must be tools/templates/{entry['id']}")
        path = folder/entry['entrypoint']
        if not path.is_file():
            problems.append(f"{entry['id']}: entrypoint {path} missing")
            continue
        if entry['licence']:
            licence = folder/'LICENSE'
            if not licence.is_file() or 'GNU GENERAL PUBLIC LICENSE' not in licence.read_text():
                problems.append(f"{entry['id']}: GPL LICENSE file missing")
            if f"SPDX-License-Identifier: {entry['licence']}" not in path.read_text():
                problems.append(f"{entry['id']}: entrypoint lacks SPDX {entry['licence']}")
        if entry['workflow']:
            workflow = REPO/entry['workflow']
            if not workflow.is_file() or entry['folder'] not in workflow.read_text():
                problems.append(f"{entry['id']}: workflow missing or does not cover {entry['folder']}")
        if entry['previewOnly'] is not True:
            problems.append(f"{entry['id']}: previewOnly must be true")
        for p in entry['parameters']:
            absent = [k for k in PARAMETER_KEYS if k not in p]
            if absent:
                problems.append(f"{entry['id']}.{p.get('name')}: missing {absent}")
            if p.get('type') == 'enum' and not p.get('choices'):
                problems.append(f"{entry['id']}.{p.get('name')}: enum without choices")
            if p.get('min') is not None and p.get('max') is not None and p['min'] > p['max']:
                problems.append(f"{entry['id']}.{p.get('name')}: min > max")
        if any(not all(k in p for k in PARAMETER_KEYS) for p in entry['parameters']):
            continue
        if entry['parameterSource'] == 'cli':
            check_cli(entry,path,problems)
        elif entry['parameterSource'] == 'fitspec':
            check_fitspec(entry,path,problems)
        else:
            problems.append(f"{entry['id']}: unknown parameterSource")
    return problems


def out_of_range(p):
    step = 1 if p['type'] == 'integer' else 1e-6
    values = []
    if p['min'] is not None:
        values.append(p['min'] if p.get('exclusiveMin') else p['min']-step)
    if p['max'] is not None:
        values.append(p['max'] if p.get('exclusiveMax') else p['max']+step)
    return values


def run_cli(entry, args):
    with tempfile.TemporaryDirectory(prefix='catalog-') as tmp:
        source = Path(tmp)/'placeholder.obj'
        source.write_text('v 0 0 0\n')
        env = dict(os.environ,BLENDER=str(Path(tmp)/'no-blender-here'))
        return subprocess.run([sys.executable,str(REPO/entry['folder']/entry['entrypoint']),str(source),
                               '--out',str(Path(tmp)/'out'),*args],capture_output=True,text=True,env=env)


def bound_violations(entry):
    """Behavioural check that catalogued bounds are enforced by the template."""
    problems = []
    if entry['parameterSource'] == 'cli':
        run = run_cli(entry,[])
        if run.returncode != 2 or BLENDER_MISSING not in run.stderr:
            problems.append(f"{entry['id']}: defaults did not pass validation: {run.stderr.strip()}")
        for p in entry['parameters']:
            values = out_of_range(p) if p['type'] in ('number','integer') else (['not-a-choice'] if p['type'] == 'enum' else [])
            for value in values:
                run = run_cli(entry,[f"{p['flag']}={value}"])
                if run.returncode != 2 or BLENDER_MISSING in run.stderr:
                    problems.append(f"{entry['id']}.{p['name']}={value} was not rejected")
        return problems
    spec_path = importlib.util.spec_from_file_location('template_'+entry['id'].replace('-','_'),
                                                       REPO/entry['folder']/entry['entrypoint'])
    module = importlib.util.module_from_spec(spec_path)
    spec_path.loader.exec_module(module)
    base = json.loads((REPO/entry['input']['exampleSpec']).read_text())
    module.sizing(copy.deepcopy(base))
    for p in entry['parameters']:
        for value in out_of_range(p):
            spec = copy.deepcopy(base)
            if p['type'] == 'interval':
                spec['dimensions'][p['name']].update(nominalMm=value,lowerMm=value,upperMm=value)
            else:
                spec['parameters'][p['name']] = value
            try:
                module.sizing(spec)
            except ValueError:
                continue
            problems.append(f"{entry['id']}.{p['name']}={value} was not rejected")
    return problems


def main():
    catalog = load()
    problems = validate(catalog)
    if not problems:
        for entry in catalog['templates']:
            problems += bound_violations(entry)
    for problem in problems:
        print(problem,file=sys.stderr)
    if not problems:
        print(f"catalog OK: {len(catalog['templates'])} templates")
    return 1 if problems else 0


if __name__ == '__main__':
    sys.exit(main())
