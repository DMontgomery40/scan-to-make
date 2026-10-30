# SPDX-License-Identifier: MIT
"""Stand-in for the Blender executable in generate tests.

The real template CLI validates its flags and then invokes `BLENDER --background ...
--python TOOL -- REQUEST.json`. This records the request it received as the manifest,
so tests prove the planner's command line reaches the template exactly as planned.
"""
import json
import os
from pathlib import Path
import sys

args = sys.argv[1:]
tool = Path(args[args.index('--python')+1])
config = json.loads(Path(args[args.index('--')+1]).read_text())
out = Path(config['out'])
(out/'fake.stl').write_bytes(b'synthetic')
manifest = {'fakeBlender':True,'tool':tool.parent.name,'previewOnly':True,
            'config':{k:v for k,v in config.items() if k not in ('input','out')},
            'secretEnvironment':sorted(k for k in os.environ if 'API_KEY' in k)}
(out/'manifest.json').write_text(json.dumps(manifest))
