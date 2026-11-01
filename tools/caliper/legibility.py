"""Can the touch-up's model read the caliper? Renders openings from a sliced plate and asks it, blind.

    python legibility.py SLICED.3mf CALIPER.json OUT_DIR [reading ...]

Runs `claude -p` with the touch-up's model and the same isolation the companion uses. The
prompt never contains the opening; the result table compares its answer with the truth.
Development check for the Mac (needs Claude Code signed in); not part of the unit tests.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from caliper.views import assembled, load  # noqa: E402

MODEL = 'claude-opus-5-5'
SCHEMA = {'type': 'object', 'additionalProperties': False, 'required': ['reading_mm', 'tool'],
          'properties': {'reading_mm': {'type': 'number'}, 'tool': {'enum': ['caliper', 'ruler', 'none']},
                         'how': {'type': 'string'}}}
PROMPT = ('Look at the image at {path}. If a caliper (preferred) or a ruler is visible, read the measurement it shows, '
          'in millimetres, as precisely as its markings allow. Say which tool you read and, in one sentence, how you read it.')
ENV = ('HOME', 'USER', 'LOGNAME', 'PATH', 'TMPDIR', 'LANG', 'SHELL', 'CLAUDE_CONFIG_DIR')


def ask(image: Path) -> dict:
    env = {k: os.environ[k] for k in ENV if k in os.environ}
    env.update(CLAUDE_CODE_DISABLE_CLAUDE_MDS='1', CLAUDE_CODE_DISABLE_AUTO_MEMORY='1')
    out = subprocess.run(['claude', '-p', '--model', MODEL, '--tools', 'Read', '--allowedTools', 'Read', '--strict-mcp-config',
                          '--disable-slash-commands', '--setting-sources', '', '--settings', '{"disableAllHooks":true}',
                          '--json-schema', json.dumps(SCHEMA), '--output-format', 'json', PROMPT.format(path=image)],
                         cwd=image.parent, env=env, capture_output=True, text=True, timeout=600)
    if out.returncode:
        return {'error': out.stderr[-500:]}
    return json.loads(out.stdout).get('structured_output') or {'error': out.stdout[-500:]}


def main(argv):
    sliced, meta, out_dir, *readings = argv
    readings = [float(r) for r in readings] or [0.0, 6.8, 23.4, 51.2, 88.6]
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    plate = load(sliced, meta)
    closeup = os.environ.get('CLOSEUP') == '1'  # a close-up photo of the reading area, as the touch-up can ask for
    zero = plate.design.params.zero_x
    images = []
    for i, r in enumerate(readings):
        path = out / f'opening-{i + 1}{"-closeup" if closeup else ""}.png'  # file names don't give the answer away
        view = (assembled(plate, r, px_per_mm=30.0, xlim=(zero + r - 14.0, zero + r + 24.0), ylim=(-1.0, 27.0)) if closeup
                else assembled(plate, r))
        view.save(path)
        images.append(path)
    with ThreadPoolExecutor(len(images)) as pool:
        answers = list(pool.map(ask, images))
    rows = []
    for r, image, answer in zip(readings, images, answers):
        read = answer.get('reading_mm')
        ok = read is not None and abs(read - r) <= 0.2 + 1e-6
        rows.append({'image': str(image), 'truth_mm': r, 'read_mm': read, 'ok': ok, 'answer': answer})
        print(f'{image.name}: truth {r:6.1f}  read {read!s:>6}  {"OK" if ok else "WRONG"}  {answer.get("how", answer.get("error", ""))}')
    (out / 'legibility.json').write_text(json.dumps(rows, indent=2) + '\n')
    return 0 if all(row['ok'] for row in rows) else 1


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
