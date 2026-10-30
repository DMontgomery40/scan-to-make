# SPDX-License-Identifier: MIT
"""Template catalog access and parameter validation for design plans."""
import hashlib
import json
import math
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
CATALOG = REPO/'tools'/'templates'/'catalog.json'
INTERVAL_KEYS = ('nominalMm','lowerMm','upperMm')
VALUE_TYPES = ('number','integer','enum','interval')


def is_number(value):
    return not isinstance(value,bool) and isinstance(value,(int,float)) and math.isfinite(value)


def _bound_errors(param, value, label):
    errors = []
    low, high = param.get('min'), param.get('max')
    if low is not None:
        if param.get('exclusiveMin') and value <= low:
            errors.append(f'{label} = {value} is out of bounds: must be greater than {low}')
        elif value < low:
            errors.append(f'{label} = {value} is out of bounds: minimum is {low}')
    if high is not None:
        if param.get('exclusiveMax') and value >= high:
            errors.append(f'{label} = {value} is out of bounds: must be less than {high}')
        elif value > high:
            errors.append(f'{label} = {value} is out of bounds: maximum is {high}')
    return errors


def check_value(param, value):
    """Return a list of errors for one value against its catalog parameter entry."""
    name, kind = param['name'], param['type']
    label = 'params.'+name
    if kind == 'number':
        if not is_number(value):
            return [f'{label} must be a finite number']
        return _bound_errors(param,value,label)
    if kind == 'integer':
        if isinstance(value,bool) or not isinstance(value,int):
            return [f'{label} must be an integer']
        return _bound_errors(param,value,label)
    if kind == 'enum':
        if value is None and param.get('default') is None:
            return []
        if value not in param['choices']:
            return [f'{label} must be one of {param["choices"]}']
        return []
    if kind == 'interval':
        if not isinstance(value,dict) or set(value) != set(INTERVAL_KEYS):
            return [f'{label} must be an object with exactly nominalMm, lowerMm and upperMm']
        if not all(is_number(value[key]) for key in INTERVAL_KEYS):
            return [f'{label} interval values must be finite numbers']
        errors = []
        if not value['lowerMm'] <= value['nominalMm'] <= value['upperMm']:
            errors.append(f'{label} must satisfy lowerMm <= nominalMm <= upperMm')
        for key in INTERVAL_KEYS:
            errors += _bound_errors(param,value[key],f'{label}.{key}')
        return errors
    return [f'{label} has unsupported catalog type {kind!r}']


class Catalog:
    def __init__(self, path=CATALOG, repo=None):
        self.path = Path(path).resolve()
        raw = self.path.read_bytes()
        if len(raw) > 1024*1024:
            raise ValueError('template catalog too large')
        self.sha256 = hashlib.sha256(raw).hexdigest()
        data = json.loads(raw)
        if data.get('schemaVersion') != 1 or data.get('units') != 'mm':
            raise ValueError('unsupported template catalog schema')
        # catalog.json lives at <repo>/tools/templates/catalog.json.
        self.repo = Path(repo).resolve() if repo else self.path.parents[2]
        self.templates = {}
        for entry in data['templates']:
            if entry['id'] in self.templates:
                raise ValueError('duplicate template id '+entry['id'])
            for param in entry['parameters']:
                if param['type'] not in VALUE_TYPES:
                    raise ValueError(f'{entry["id"]}.{param["name"]}: unsupported parameter type')
            self.templates[entry['id']] = entry

    def template(self, template_id):
        if template_id not in self.templates:
            raise ValueError(f'unknown template {template_id!r}')
        return self.templates[template_id]

    def example_spec(self, template_id):
        entry = self.template(template_id)
        relative = entry['input'].get('exampleSpec')
        if entry['input']['kind'] != 'fitspec' or not relative:
            return None
        return json.loads((self.repo/relative).read_text())

    def measured_parameters(self, template_id):
        """FitSpec dimensions the user must measure (the example spec does not mark them as design)."""
        spec = self.example_spec(template_id)
        if spec is None:
            return []
        return [name for name,dimension in spec['dimensions'].items() if dimension.get('source') != 'design']

    def check_params(self, template_id, params, complete=False):
        """Validate a parameter object; with complete=True every catalog parameter must be present."""
        entry = self.template(template_id)
        if not isinstance(params,dict):
            return ['params must be an object']
        known = {param['name']:param for param in entry['parameters']}
        errors = [f'params.{name} is not a parameter of {template_id}' for name in sorted(set(params)-set(known))]
        for name,param in known.items():
            if name in params:
                errors += check_value(param,params[name])
            elif complete:
                errors.append(f'params.{name} is missing')
        return errors

    def describe(self):
        """Model-facing catalog view: everything needed to choose and fill a template."""
        templates = []
        for template_id,entry in self.templates.items():
            parameters = []
            for param in entry['parameters']:
                view = {key:param[key] for key in ('name','type','units','default','min','max','description')}
                for key in ('exclusiveMin','exclusiveMax','choices'):
                    if key in param:
                        view[key] = param[key]
                parameters.append(view)
            templates.append({'id':template_id,'name':entry['name'],'summary':entry['summary'],
                              'input':entry['input']['kind'],
                              'measurementRequired':self.measured_parameters(template_id),
                              'parameters':parameters})
        return templates
