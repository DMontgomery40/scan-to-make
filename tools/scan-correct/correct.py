#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""Measured Blender correction; preview only, never physical dispatch."""
import argparse
import json
import sys
from schema import TOOLS


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command',required=True)
    commands.add_parser('tools')
    run = commands.add_parser('run')
    run.add_argument('mesh')
    run.add_argument('--units',choices=('mm','cm','m'),required=True)
    run.add_argument('--out',required=True)
    run.add_argument('--texture')
    run.add_argument('--still',action='append',default=[])
    run.add_argument('--product',default='unidentified object')
    run.add_argument('--reference-mm',nargs=3,type=float)
    run.add_argument('--adapter',choices=('anthropic','openai','scripted'),default='anthropic')
    run.add_argument('--model')
    run.add_argument('--base-url')
    run.add_argument('--script')
    run.add_argument('--key-env')
    run.add_argument('--max-steps',type=int,default=24)
    run.add_argument('--max-seconds',type=int,default=600)
    run.add_argument('--max-faces',type=int,default=200000)
    advice=commands.add_parser('advise',help='deterministic close-up targets; no model calls')
    advice.add_argument('mesh')
    advice.add_argument('--units',choices=('mm','cm','m'),required=True)
    advice.add_argument('--out',required=True)
    advice.add_argument('--texture')
    advice.add_argument('--reference-mm',nargs=3,type=float)
    advice.add_argument('--axis-labels',help='JSON map of input-axis side codes to caller-provided labels')
    advice.add_argument('--max-targets',type=int,default=3)
    advice.add_argument('--resolution',type=int,default=256)
    advice.add_argument('--max-seconds',type=int,default=300)
    advice.add_argument('--max-faces',type=int,default=200000)
    args = parser.parse_args()
    try:
        if args.command=='tools':
            print(json.dumps(TOOLS,indent=2))
        elif args.command=='advise':
            from advice import advise_job
            print(json.dumps(advise_job(args),indent=2,sort_keys=True,allow_nan=False))
        else:
            from runner import run_job
            print(json.dumps(run_job(args),indent=2))
        return 0
    except (ValueError,OSError,KeyError,TypeError) as exc:
        print(str(exc),file=sys.stderr)
        return 2


if __name__=='__main__':
    sys.exit(main())
