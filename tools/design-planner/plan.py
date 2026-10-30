# SPDX-License-Identifier: MIT
"""Turn a typed request plus scan measurements into a validated template plan."""
import json
import time

from adapters import ReplyError

SCHEMA_VERSION = 1
MAX_REQUEST_CHARS = 1000
MAX_ANSWERS = 5
MAX_ANSWER_CHARS = 500
MAX_RATIONALE_CHARS = 600
MAX_QUESTIONS = 5
MAX_ITEM_CHARS = 300
MAX_ATTEMPTS = 4
PROPOSAL_KEYS = ('outcome','templateId','params','rationale','confidence','questions','unsupported')

SYSTEM = '''You plan a 3D-printable addition for an object the user has scanned.
Choose one template from the catalog only if it can genuinely make what the user asked for.
If no template fits, return outcome "no_fit" with templateId null and empty params, and say what is missing.
Never stretch a template to a different purpose to avoid saying no.
Use only the listed parameters of the chosen template, respecting type, units, min/max and exclusive bounds.
Omit a parameter to keep its default. Interval parameters are objects {nominalMm, lowerMm, upperMm}.
Parameters in measurementRequired describe the user's surroundings (a drawer, a cup holder, a mug): set them
only from numbers the user stated, converted to mm. Never guess them; ask instead.
Scan measurements are millimetres from the repaired mesh. bboxExtentsMm are along the mesh's own X, Y and Z
axes, which is what the `up` parameter refers to. boxExtentsMm are oriented-box extents, long to short.
If part of the request cannot be made by the chosen template (for example a hole or text it has no option for),
list that part in unsupported and ask whether to continue without it.
If the request is ambiguous, still give your best plan, lower the confidence (0 to 1) and ask short questions.
Keep the rationale to one or two sentences. Respond only by calling submit_plan.'''


def plan_tool(catalog):
    return {
        'name':'submit_plan',
        'description':'Submit the design plan: a catalog template with parameters, or an explicit no_fit.',
        'input_schema':{
            'type':'object',
            'properties':{
                'outcome':{'type':'string','enum':['plan','no_fit']},
                'templateId':{'type':['string','null'],'enum':sorted(catalog.templates)+[None]},
                'params':{'type':'object','description':'Parameter values keyed by catalog name; omit to keep defaults.'},
                'rationale':{'type':'string','maxLength':MAX_RATIONALE_CHARS},
                'confidence':{'type':'number','minimum':0,'maximum':1},
                'questions':{'type':'array','items':{'type':'string','maxLength':MAX_ITEM_CHARS},'maxItems':MAX_QUESTIONS},
                'unsupported':{'type':'array','items':{'type':'string','maxLength':MAX_ITEM_CHARS},'maxItems':MAX_QUESTIONS},
            },
            'required':list(PROPOSAL_KEYS),
            'additionalProperties':False,
        },
    }


def prompt(request, catalog, measurements, answers, feedback=None):
    context = {'request':request,'answers':list(answers),'scan':measurements,'templates':catalog.describe()}
    if feedback:
        context['previousAttempt'] = feedback
    return json.dumps(context,indent=1,allow_nan=False)


def _strings(value, label, limit):
    if not isinstance(value,list) or len(value) > MAX_QUESTIONS:
        return [f'{label} must be a list of at most {MAX_QUESTIONS} strings']
    if not all(isinstance(item,str) and item.strip() and len(item) <= limit for item in value):
        return [f'{label} items must be non-empty strings of at most {limit} characters']
    return []


def check_proposal(proposal, catalog):
    """Structural and catalog checks on the model's submit_plan arguments."""
    if not isinstance(proposal,dict):
        return ['proposal must be an object']
    errors = [f'unexpected field {key}' for key in sorted(set(proposal)-set(PROPOSAL_KEYS))]
    errors += [f'missing field {key}' for key in PROPOSAL_KEYS if key not in proposal]
    if errors:
        return errors
    outcome, template_id, params = proposal['outcome'], proposal['templateId'], proposal['params']
    if outcome not in ('plan','no_fit'):
        errors.append('outcome must be "plan" or "no_fit"')
    rationale = proposal['rationale']
    if not isinstance(rationale,str) or not rationale.strip() or len(rationale) > MAX_RATIONALE_CHARS:
        errors.append(f'rationale must be a non-empty string of at most {MAX_RATIONALE_CHARS} characters')
    confidence = proposal['confidence']
    if isinstance(confidence,bool) or not isinstance(confidence,(int,float)) or not 0 <= confidence <= 1:
        errors.append('confidence must be a number from 0 to 1')
    errors += _strings(proposal['questions'],'questions',MAX_ITEM_CHARS)
    errors += _strings(proposal['unsupported'],'unsupported',MAX_ITEM_CHARS)
    if outcome == 'no_fit':
        if template_id is not None or params != {}:
            errors.append('a no_fit outcome must have templateId null and empty params')
    elif outcome == 'plan':
        if template_id not in catalog.templates:
            errors.append(f'templateId {template_id!r} is not in the catalog')
        else:
            errors += catalog.check_params(template_id,params)
    return errors


def build_plan(request, proposal, catalog, measurements, answers, min_confidence):
    """Combine a checked proposal with catalog defaults and host-side honesty checks."""
    questions = [q.strip() for q in proposal['questions']]
    unsupported = [u.strip() for u in proposal['unsupported']]
    plan = {'schemaVersion':SCHEMA_VERSION,'previewOnly':True,'request':request,'answers':list(answers),
            'outcome':proposal['outcome'],'templateId':proposal['templateId'],'templateName':None,
            'params':{},'paramSources':{},'missingMeasurements':[],
            'rationale':proposal['rationale'].strip(),'confidence':float(proposal['confidence']),
            'questions':questions,'unsupported':unsupported,'warnings':[],
            'measurements':measurements,'catalogSha256':catalog.sha256}
    if proposal['outcome'] == 'no_fit':
        plan['status'] = 'no-fit'
        return plan
    template = catalog.template(proposal['templateId'])
    plan['templateName'] = template['name']
    plan['input'] = template['input']['kind']
    measured = catalog.measured_parameters(template['id'])
    for param in template['parameters']:
        name = param['name']
        if name in proposal['params']:
            plan['params'][name] = proposal['params'][name]
            plan['paramSources'][name] = 'planner'
        elif name in measured:
            # Example-spec values are synthetic fixtures, never a stand-in for the user's own measurement.
            plan['missingMeasurements'].append(name)
            questions.append(f'What is the {name} in mm? {param["description"]}')
        else:
            plan['params'][name] = param['default']
            plan['paramSources'][name] = 'default'
    if unsupported and not proposal['questions']:
        questions.append(f'{template["name"]} cannot make: {"; ".join(unsupported)}. Continue without it?')
    if plan['confidence'] < min_confidence and not proposal['questions']:
        questions.append(f'Is a {template["name"].lower()} what you want?')
    if template['input']['kind'] == 'repaired-scan-mesh':
        if measurements is None:
            plan['warnings'].append('No scan measurements were supplied; parameters were chosen without object size.')
        elif measurements.get('watertight') is False:
            plan['warnings'].append('The measured mesh is not watertight; this template needs a repaired, watertight mesh.')
    plan['status'] = 'needs-input' if questions or unsupported or plan['confidence'] < min_confidence else 'ready'
    return plan


def run_plan(request, catalog, adapter, measurements=None, answers=(), max_attempts=2, seconds=180,
             min_confidence=0.6):
    """Ask the model for a plan; validation errors go back to it for at most max_attempts tries."""
    if not isinstance(request,str) or not request.strip() or len(request) > MAX_REQUEST_CHARS:
        raise ValueError(f'request must be 1 to {MAX_REQUEST_CHARS} characters')
    answers = list(answers)
    if len(answers) > MAX_ANSWERS or any(not isinstance(a,str) or not a.strip() or len(a) > MAX_ANSWER_CHARS
                                         for a in answers):
        raise ValueError(f'at most {MAX_ANSWERS} answers of 1 to {MAX_ANSWER_CHARS} characters')
    if not 1 <= max_attempts <= MAX_ATTEMPTS or not 1 <= seconds <= 3600 or not 0 <= min_confidence <= 1:
        raise ValueError('invalid planner budget')
    request = request.strip()
    tool = plan_tool(catalog)
    deadline = time.monotonic()+seconds
    feedback, proposal, errors = None, None, []
    for attempt in range(1,max_attempts+1):
        remaining = deadline-time.monotonic()
        if remaining <= 0:
            raise ValueError('planner wall-clock budget exceeded')
        try:
            proposal = adapter.propose(SYSTEM,prompt(request,catalog,measurements,answers,feedback),tool,remaining)
            errors = check_proposal(proposal,catalog)
        except ReplyError as exc:
            proposal, errors = None, [str(exc)]
        if not errors:
            plan = build_plan(request,proposal,catalog,measurements,answers,min_confidence)
            plan['attempts'] = attempt
            return plan
        feedback = {'proposal':proposal,'validationErrors':errors,
                    'instruction':'The proposal was rejected. Fix every error, or return no_fit.'}
    return {'schemaVersion':SCHEMA_VERSION,'previewOnly':True,'status':'rejected','request':request,
            'answers':answers,'outcome':None,'templateId':None,'errors':errors,'lastProposal':proposal,
            'attempts':max_attempts,'measurements':measurements,'catalogSha256':catalog.sha256}


def validate_plan(plan, catalog):
    """Re-check a saved plan before generation; return a list of errors (empty when ready to generate)."""
    if not isinstance(plan,dict) or plan.get('schemaVersion') != SCHEMA_VERSION:
        return ['not a design plan (schemaVersion 1)']
    if plan.get('status') != 'ready':
        return [f'plan status is {plan.get("status")!r}; only ready plans can be generated']
    if plan.get('catalogSha256') != catalog.sha256:
        return ['plan was made against a different template catalog; plan again']
    template_id = plan.get('templateId')
    if template_id not in catalog.templates:
        return [f'templateId {template_id!r} is not in the catalog']
    return catalog.check_params(template_id,plan.get('params'),complete=True)
