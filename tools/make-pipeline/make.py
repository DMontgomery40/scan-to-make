#!/usr/bin/env python3
# SPDX-License-Identifier: MIT
"""Bounded scan-to-checked-STL orchestration. Preview files only; never prints."""
import argparse
import json
from pathlib import Path
import sys

sys.path.insert(0,str(Path(__file__).resolve().parent))
from pipeline import Pipeline, StageError


def parser():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('capture',type=Path)
    p.add_argument('--make',required=True,dest='request',help='named template or optional planner request')
    p.add_argument('--reference',nargs=3,type=float,metavar=('W','H','D'))
    p.add_argument('--units',choices=('mm','cm','m'),help='required for OBJ; USDZ uses authored units')
    p.add_argument('--stills',type=Path,help='directory with at most four PNG/JPEG/WebP close-ups')
    p.add_argument('--out',required=True,type=Path)
    p.add_argument('--profile',required=True,help='explicit printability printer profile')
    p.add_argument('--param',action='append',default=[],metavar='NAME=JSON',help='catalogued named-template parameter')
    p.add_argument('--adapter',choices=('scripted','anthropic','openai'),default='scripted')
    p.add_argument('--script',type=Path,help='optional bounded correction tool sequence')
    p.add_argument('--planner-script',type=Path,help='scripted planner replies for free-text requests')
    p.add_argument('--model');p.add_argument('--base-url');p.add_argument('--key-env')
    p.add_argument('--product',default='unidentified object')
    p.add_argument('--material',choices=('PLA','PETG','TPU','ABS','ASA'),default='PLA')
    p.add_argument('--allow-supports',action='store_true')
    p.add_argument('--max-seconds',type=int,default=1800)
    p.add_argument('--stage-seconds',type=int,default=600)
    p.add_argument('--max-faces',type=int,default=200000)
    p.add_argument('--max-steps',type=int,default=24)
    return p


def main(argv=None):
    try:
        job=Pipeline(parser().parse_args(argv));report=job.run()
        print(json.dumps(report,indent=2,sort_keys=True,allow_nan=False))
        print(job.summary(),file=sys.stderr)
        return 0
    except StageError as exc:
        print(f'{exc.stage}: {exc.message}; inspect private pipeline-report.json and timings.json',file=sys.stderr)
        return 2
    except (ValueError,OSError,TypeError,KeyError) as exc:
        print(str(exc),file=sys.stderr);return 2


if __name__=='__main__':sys.exit(main())
