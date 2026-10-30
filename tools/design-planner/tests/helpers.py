# SPDX-License-Identifier: MIT
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
FIXTURES = Path(__file__).resolve().parent/'fixtures'
sys.path.insert(0,str(ROOT))

import measurements  # noqa: E402
from adapters import ScriptedModel  # noqa: E402
from catalog import Catalog  # noqa: E402
from plan import run_plan  # noqa: E402


def scan(name):
    return measurements.load(FIXTURES/name) if name else None


def cases():
    return json.loads((FIXTURES/'requests.json').read_text())


def ready_plan(catalog, template_id, params, confidence=0.9, scan_name=None):
    """A ready plan produced through the real planner path with a one-reply scripted model."""
    model = ScriptedModel([{'submit_plan':{'outcome':'plan','templateId':template_id,'params':params,
                                           'rationale':'Synthetic test plan.','confidence':confidence,
                                           'questions':[],'unsupported':[]}}])
    plan = run_plan('synthetic request',catalog,model,scan(scan_name))
    assert plan['status'] == 'ready', plan
    return plan


__all__ = ['Catalog','FIXTURES','ROOT','ScriptedModel','cases','ready_plan','run_plan','scan']
