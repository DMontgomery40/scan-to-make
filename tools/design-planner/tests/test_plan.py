# SPDX-License-Identifier: MIT
import contextlib
import copy
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest import mock

from helpers import FIXTURES, Catalog, ScriptedModel, cases, ready_plan, run_plan, scan

import planner
from plan import check_proposal, plan_tool, validate_plan


class SyntheticRequestTests(unittest.TestCase):
    """Every scripted request in fixtures/requests.json through the full planning path."""

    @classmethod
    def setUpClass(cls):
        cls.catalog = Catalog()

    def test_synthetic_requests(self):
        table = cases()
        self.assertGreaterEqual(len(table),10)
        statuses = {case['expect']['status'] for case in table}
        self.assertEqual(statuses,{'ready','needs-input','no-fit','rejected'})
        for case in table:
            with self.subTest(case['name']):
                model = ScriptedModel(case['replies'])
                plan = run_plan(case['request'],self.catalog,model,scan(case['scan']),
                                max_attempts=case.get('maxAttempts',2))
                expect = case['expect']
                self.assertEqual(plan['status'],expect['status'],plan)
                self.assertTrue(plan['previewOnly'])
                self.assertEqual(plan['catalogSha256'],self.catalog.sha256)
                for key in ('templateId','attempts','unsupported','missingMeasurements'):
                    if key in expect:
                        self.assertEqual(plan[key],expect[key])
                for name,value in expect.get('params',{}).items():
                    self.assertEqual(plan['params'][name],value,name)
                for name,value in expect.get('paramSources',{}).items():
                    self.assertEqual(plan['paramSources'][name],value,name)
                for field,key in (('questions','questionsContain'),('errors','errorsContain'),
                                  ('warnings','warningsContain')):
                    for fragment in expect.get(key,[]):
                        self.assertTrue(any(fragment in item for item in plan[field]),(fragment,plan[field]))
                if 'questionCount' in expect:
                    self.assertEqual(len(plan['questions']),expect['questionCount'])
                if 'feedbackContains' in expect:
                    retry = json.loads(model.prompts[1]['text'])['previousAttempt']
                    self.assertIn(expect['feedbackContains'],retry['validationErrors'])
                self.assertEqual(len(model.prompts),plan['attempts'])
                if plan['status'] == 'ready':
                    self.assertEqual(validate_plan(plan,self.catalog),[])
                    self.assertEqual(plan['questions'],[])
                else:
                    self.assertTrue(validate_plan(plan,self.catalog))
                if plan['status'] == 'no-fit':
                    self.assertIsNone(plan['templateId'])
                    self.assertEqual(plan['params'],{})
                if plan['status'] == 'needs-input':
                    self.assertTrue(plan['questions'])

    def test_prompt_carries_request_scan_and_catalog(self):
        model = ScriptedModel(cases()[0]['replies'])
        run_plan('a stand that holds it upright',self.catalog,model,scan('phone-repair-report.json'),
                 answers=['It should stand on my desk'])
        sent = model.prompts[0]
        context = json.loads(sent['text'])
        self.assertEqual(context['request'],'a stand that holds it upright')
        self.assertEqual(context['answers'],['It should stand on my desk'])
        self.assertEqual(context['scan']['boxExtentsMm'],[150.1,72.0,8.3])
        self.assertEqual(context['scan']['bboxExtentsMm'],[150.2,72.1,8.4])
        self.assertEqual({t['id'] for t in context['templates']},set(self.catalog.templates))
        drawer = next(t for t in context['templates'] if t['id'] == 'drawer-organizer')
        self.assertEqual(drawer['measurementRequired'],['drawerInnerWidth','drawerInnerDepth','drawerInnerHeight'])
        self.assertIn('no_fit',sent['system'])
        self.assertEqual(sent['tool']['name'],'submit_plan')

    def test_tool_schema_lists_catalog_ids_and_no_fit(self):
        schema = plan_tool(self.catalog)['input_schema']
        self.assertEqual(schema['properties']['templateId']['enum'],sorted(self.catalog.templates)+[None])
        self.assertEqual(schema['properties']['outcome']['enum'],['plan','no_fit'])
        self.assertFalse(schema['additionalProperties'])

    def test_proposal_shape_errors(self):
        good = cases()[0]['replies'][0]['submit_plan']
        self.assertEqual(check_proposal(good,self.catalog),[])
        for change,fragment in ((lambda p: p.pop('rationale'),'missing field rationale'),
                                (lambda p: p.update(extra=1),'unexpected field extra'),
                                (lambda p: p.update(confidence=1.5),'confidence must be'),
                                (lambda p: p.update(confidence=True),'confidence must be'),
                                (lambda p: p.update(outcome='maybe'),'outcome must be'),
                                (lambda p: p.update(rationale='x'*601),'rationale must be'),
                                (lambda p: p.update(questions=['']),'questions items'),
                                (lambda p: p.update(questions=['q']*6),'questions must be a list')):
            proposal = copy.deepcopy(good)
            change(proposal)
            errors = check_proposal(proposal,self.catalog)
            self.assertTrue(any(fragment in e for e in errors),(fragment,errors))

    def test_saved_plan_revalidation(self):
        plan = ready_plan(self.catalog,'wall-mount',{'screw_spacing_mm':60.0})
        self.assertEqual(validate_plan(plan,self.catalog),[])
        tampered = copy.deepcopy(plan)
        tampered['params']['screw_spacing_mm'] = 250.0
        self.assertIn('params.screw_spacing_mm = 250.0 is out of bounds: maximum is 200.0',
                      validate_plan(tampered,self.catalog))
        incomplete = copy.deepcopy(plan)
        del incomplete['params']['grid_mm']
        self.assertIn('params.grid_mm is missing',validate_plan(incomplete,self.catalog))
        stale = copy.deepcopy(plan)
        stale['catalogSha256'] = '0'*64
        self.assertIn('different template catalog',validate_plan(stale,self.catalog)[0])
        pending = copy.deepcopy(plan)
        pending['status'] = 'needs-input'
        self.assertIn('only ready plans',validate_plan(pending,self.catalog)[0])

    def test_request_and_budget_limits(self):
        model = ScriptedModel([])
        for kwargs in ({'request':''},{'request':'x'*1001},{'answers':['a']*6},{'max_attempts':0},
                       {'max_attempts':5},{'seconds':0},{'min_confidence':2}):
            arguments = {'request':'a stand','answers':(),'max_attempts':2,'seconds':60,'min_confidence':.6,**kwargs}
            with self.subTest(kwargs),self.assertRaises(ValueError):
                run_plan(arguments['request'],self.catalog,model,None,arguments['answers'],
                         arguments['max_attempts'],arguments['seconds'],arguments['min_confidence'])
        self.assertEqual(model.prompts,[])


class CliTests(unittest.TestCase):
    def run_cli(self, *argv):
        stdout, stderr = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(stdout),contextlib.redirect_stderr(stderr):
            code = planner.main(list(argv))
        return code, stdout.getvalue(), stderr.getvalue()

    def test_scripted_plan_validate_and_rejection_exit_codes(self):
        table = {case['name']:case for case in cases()}
        with tempfile.TemporaryDirectory() as tmp:
            tmp = Path(tmp)
            script = tmp/'script.json'
            script.write_text(json.dumps(table['upright stand']['replies']))
            code,out,_ = self.run_cli('plan','a stand that holds it upright','--adapter','scripted',
                                      '--script',str(script),'--scan',str(FIXTURES/'phone-repair-report.json'),
                                      '--out',str(tmp/'plan.json'))
            self.assertEqual(code,0)
            self.assertEqual(json.loads(out)['status'],'ready')
            self.assertEqual(json.loads((tmp/'plan.json').read_text())['templateId'],'scan-cradle')
            code,out,_ = self.run_cli('validate',str(tmp/'plan.json'))
            self.assertEqual((code,json.loads(out)),(0,{'ready':True,'errors':[]}))

            script.write_text(json.dumps(table['out-of-bounds screw spacing is rejected']['replies']))
            code,out,_ = self.run_cli('plan','screw holes 300 mm apart','--adapter','scripted','--script',str(script))
            self.assertEqual(code,2)
            self.assertEqual(json.loads(out)['status'],'rejected')

    def test_catalog_view_and_missing_key(self):
        code,out,_ = self.run_cli('catalog')
        self.assertEqual(code,0)
        self.assertIn('wall-mount',[t['id'] for t in json.loads(out)])
        with mock.patch.dict('os.environ',{},clear=True):
            code,out,err = self.run_cli('plan','a stand','--adapter','anthropic')
        self.assertEqual((code,out),(2,''))
        self.assertIn('key environment variable absent',err)


if __name__ == '__main__':
    unittest.main()
