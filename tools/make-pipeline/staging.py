# SPDX-License-Identifier: MIT
"""Snapshot a bounded OBJ/MTL/texture graph before any importer sees it."""
import math
from pathlib import Path, PurePosixPath
import re
import shlex

MAX_FILE=128*1024*1024
MAX_TOTAL=256*1024*1024


def bounded_bytes(path,limit=MAX_FILE):
    path=Path(path)
    if not path.is_file():raise ValueError('regular input file required')
    with path.open('rb') as stream:data=stream.read(limit+1)
    if len(data)>limit:raise ValueError('input file exceeds byte cap')
    return data


def snapshot_obj(mesh,destination,max_faces):
    mesh=Path(mesh).resolve();planned={};roles={};total=0
    def collect(path,role):
        nonlocal total
        resolved=path.resolve()
        if not resolved.is_relative_to(mesh.parent):raise ValueError('material/texture escapes source directory')
        relative=path.relative_to(mesh.parent)
        if relative in roles:
            if roles[relative]!=role:raise ValueError('conflicting asset roles')
            return
        if len(roles)>=32:raise ValueError('input asset cap exceeded')
        if role=='material' and path.suffix.lower()!='.mtl':raise ValueError('mtllib target must end in .mtl')
        data=bounded_bytes(resolved);total+=len(data)
        if total>MAX_TOTAL:raise ValueError('input graph exceeds total byte cap')
        roles[relative]=role;planned[relative]=data
        if role=='texture':return
        faces=vertices=0
        for line in data.decode('utf-8').splitlines():
            fields=shlex.split(line,comments=True)
            if not fields:continue
            directive=fields[0]
            allowed={'v','vt','vn','vp','f','l','o','g','s','usemtl','mtllib'} if role=='obj' else {
                'newmtl','Kd','Ka','Ks','Ke','Ns','Ni','d','Tr','illum','Tf','map_Kd'}
            if directive not in allowed:raise ValueError('unsupported OBJ/material directive')
            if directive=='v':
                vertices+=1
                if len(fields)<4 or not all(math.isfinite(float(x)) for x in fields[1:4]):raise ValueError('invalid vertex')
            if directive=='f':faces+=max(1,len(fields)-3)
            if faces>max_faces or vertices>max_faces*3:raise ValueError('input polygon/vertex cap exceeded')
            if directive=='mtllib' or directive=='map_Kd':
                if directive=='mtllib' and len(fields)!=2:raise ValueError('one mtllib path required')
                if directive=='map_Kd' and not (len(fields)==2 or (len(fields)==4 and fields[1]=='-clamp' and fields[2] in ('on','off'))):
                    raise ValueError('unsupported texture mapping')
                name=fields[-1];portable=PurePosixPath(name)
                if (not re.fullmatch(r'[A-Za-z0-9_./-]+',name) or portable.is_absolute() or
                    any(p in ('.','..') for p in name.split('/'))):raise ValueError('unsafe material/texture path')
                collect(path.parent/name,'material' if directive=='mtllib' else 'texture')
    collect(mesh,'obj')
    # Only publish after the entire dependency graph has been validated/snapshotted.
    destination=Path(destination)
    for relative,data in planned.items():
        target=destination/relative;target.parent.mkdir(parents=True,exist_ok=True);target.write_bytes(data)
    return destination/mesh.name,sorted(destination/p for p in planned)
