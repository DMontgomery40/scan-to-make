#!/usr/bin/env python3
# SPDX-License-Identifier: MIT
"""Plan an addition for a scanned object from a typed request; optionally generate it."""
import argparse
import json
from pathlib import Path
import sys

sys.path.insert(0,str(Path(__file__).resolve().parent))

import measurements
from adapters import ModelError, ProviderAdapter, ScriptedModel
from catalog import CATALOG, Catalog
from generate import generate
from plan import MAX_ATTEMPTS, run_plan, validate_plan


def parser():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--catalog',type=Path,default=CATALOG,help='template catalog (default: tools/templates/catalog.json)')
    commands = p.add_subparsers(dest='command',required=True)
    commands.add_parser('catalog',help='print the model-facing catalog view')

    plan = commands.add_parser('plan',help='plan an addition from a typed request')
    plan.add_argument('request')
    plan.add_argument('--scan',type=Path,help='scan-correct/scan-repair report.json or repair.py measure output')
    plan.add_argument('--answer',action='append',default=[],help='answer to an earlier question (repeatable)')
    plan.add_argument('--adapter',choices=('anthropic','openai','scripted'),default='anthropic')
    plan.add_argument('--model')
    plan.add_argument('--base-url')
    plan.add_argument('--key-env')
    plan.add_argument('--script',type=Path,help='scripted adapter replies (JSON list)')
    plan.add_argument('--retries',type=int,default=2,help='transient HTTP retries per model request (0-5)')
    plan.add_argument('--max-attempts',type=int,default=2,help=f'plan attempts with validation feedback (1-{MAX_ATTEMPTS})')
    plan.add_argument('--max-seconds',type=int,default=180)
    plan.add_argument('--min-confidence',type=float,default=0.6)
    plan.add_argument('--out',type=Path,help='also write the plan JSON here')

    check = commands.add_parser('validate',help='check a saved plan against the current catalog')
    check.add_argument('plan',type=Path)

    make = commands.add_parser('generate',help='run a ready plan through its template')
    make.add_argument('plan',type=Path)
    make.add_argument('--out',type=Path,required=True,help='new or empty output directory')
    make.add_argument('--mesh',type=Path,help='repaired mm OBJ/STL for scan-mesh templates')
    make.add_argument('--max-seconds',type=int,default=900)
    return p


def read_plan(path):
    if path.stat().st_size > 1024*1024:
        raise ValueError('plan file too large')
    return json.loads(path.read_text())


def main(argv=None):
    args = parser().parse_args(argv)
    try:
        catalog = Catalog(args.catalog)
        if args.command == 'catalog':
            result, code = catalog.describe(), 0
        elif args.command == 'plan':
            if args.adapter == 'scripted':
                if not args.script:
                    raise ValueError('--script is required for the scripted adapter')
                adapter = ScriptedModel.from_file(args.script)
            else:
                adapter = ProviderAdapter(args.adapter,args.model,args.base_url,args.key_env,retries=args.retries)
            scan = measurements.load(args.scan) if args.scan else None
            result = run_plan(args.request,catalog,adapter,scan,args.answer,args.max_attempts,
                              args.max_seconds,args.min_confidence)
            code = 2 if result['status'] == 'rejected' else 0
            if args.out:
                args.out.write_text(json.dumps(result,indent=2,allow_nan=False)+'\n')
        elif args.command == 'validate':
            errors = validate_plan(read_plan(args.plan),catalog)
            result, code = {'ready':not errors,'errors':errors}, 0 if not errors else 2
        else:
            result = generate(read_plan(args.plan),catalog,args.out,args.mesh,args.max_seconds)
            code = 0
        print(json.dumps(result,indent=2,allow_nan=False))
        return code
    except (ModelError,ValueError,OSError,KeyError,TypeError) as exc:
        print(str(exc),file=sys.stderr)
        return 2


if __name__ == '__main__':
    sys.exit(main())
