# SPDX-License-Identifier: GPL-3.0-or-later
"""Model-free advice CLI orchestration; all geometry/rendering stays isolated."""
import json
from pathlib import Path
import shutil
from host import Worker,write_json
from schema import validate


def advise_job(args):
    if not 1<=args.max_targets<=6 or not 64<=args.resolution<=512:
        raise ValueError('advice target/resolution bounds are 1..6 and 64..512')
    if args.reference_mm is not None:
        validate('scale_to_reference',{'target_mm':args.reference_mm})
    labels={}
    if args.axis_labels:
        path=Path(args.axis_labels)
        if path.stat().st_size>4096:raise ValueError('axis labels too large')
        labels=json.loads(path.read_text())
        if (not isinstance(labels,dict) or set(labels)-{'pos_x','neg_x','pos_y','neg_y','pos_z','neg_z'} or
            any(not isinstance(v,str) or not 1<=len(v)<=80 or not v.isprintable() for v in labels.values())):
            raise ValueError('invalid axis labels')
    out=Path(args.out).resolve();out.mkdir(parents=True,exist_ok=True)
    if any(out.iterdir()):raise ValueError('output directory must be empty')
    out.chmod(0o700)
    worker=Worker(out/'work',seconds=args.max_seconds,max_faces=args.max_faces)
    initial=worker.stage(args.mesh,args.units,args.texture)
    result=worker._run('advise',{'reference_mm':args.reference_mm,'max_targets':args.max_targets,
                                'resolution':args.resolution,'axis_labels':labels})['data']
    result['inputs']=json.loads((worker.directory/'inputs.json').read_text())
    result['boxExtentsMm']=initial['after']['boxExtentsMm']
    for target in result['targets']:
        relative=target['render']['path'];source=worker.directory/relative
        if not source.resolve().is_relative_to(worker.directory):raise ValueError('advice render escaped job')
        destination=out/relative;destination.parent.mkdir(parents=True,exist_ok=True)
        shutil.copyfile(source,destination)
    report={'closeupAdvice':result}
    write_json(out/'advice.json',report)
    return report
