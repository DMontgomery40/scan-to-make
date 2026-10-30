# SPDX-License-Identifier: MIT
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
import threading
import time
import unittest
from unittest.mock import patch

from helpers import Catalog

from adapters import ModelError, ProviderAdapter, ReplyError, ScriptedModel, endpoint, request_json
from plan import plan_tool

KEY = 'synthetic-placeholder-key'
ARGS = {'outcome':'no_fit','templateId':None,'params':{},'rationale':'r','confidence':.9,'questions':[],'unsupported':[]}


def anthropic_reply(arguments=ARGS):
    return {'content':[{'type':'text','text':'planning'},
                       {'type':'tool_use','id':'t1','name':'submit_plan','input':arguments}]}


def openai_reply(arguments=ARGS):
    return {'choices':[{'message':{'role':'assistant','content':None,'tool_calls':[
        {'id':'c1','type':'function','function':{'name':'submit_plan','arguments':json.dumps(arguments)}}]}}]}


class AdapterTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tool = plan_tool(Catalog())

    def adapter(self, provider, transport, **kwargs):
        env = {'ANTHROPIC_API_KEY':KEY,'OPENAI_API_KEY':KEY,'KIMI_TEST_KEY':KEY}
        with patch.dict(os.environ,env,clear=True):
            return ProviderAdapter(provider,transport=transport,sleep=lambda s: None,**kwargs)

    def test_anthropic_forces_the_plan_tool(self):
        sent = []
        def transport(url,headers,payload,seconds):
            sent.append((url,headers,payload,seconds))
            return anthropic_reply()
        result = self.adapter('anthropic',transport).propose('system text','context',self.tool,30)
        self.assertEqual(result,ARGS)
        url,headers,payload,seconds = sent[0]
        self.assertEqual(url,'https://api.anthropic.com/v1/messages')
        self.assertEqual(headers['x-api-key'],KEY)
        self.assertEqual(payload['model'],'claude-opus-5-5')
        self.assertEqual(payload['system'],'system text')
        self.assertEqual(payload['tool_choice'],{'type':'tool','name':'submit_plan'})
        self.assertEqual(payload['tools'][0]['input_schema'],self.tool['input_schema'])
        self.assertLessEqual(seconds,30)

    def test_openai_compatible_endpoint_and_key_env(self):
        sent = []
        def transport(url,headers,payload,seconds):
            sent.append((url,headers,payload))
            return openai_reply()
        adapter = self.adapter('openai',transport,model='kimi-test-id',base_url='https://example.invalid/v1/',
                               key_env='KIMI_TEST_KEY')
        self.assertEqual(adapter.propose('system','context',self.tool,30),ARGS)
        url,headers,payload = sent[0]
        self.assertEqual(url,'https://example.invalid/v1/chat/completions')
        self.assertEqual(headers['Authorization'],'Bearer '+KEY)
        self.assertEqual(payload['messages'][0],{'role':'system','content':'system'})
        self.assertEqual(payload['tool_choice'],{'type':'function','function':{'name':'submit_plan'}})
        self.assertEqual(payload['tools'][0]['function']['parameters'],self.tool['input_schema'])

    def test_bounded_retries_only_for_transient_failures(self):
        calls = []
        def flaky(url,headers,payload,seconds):
            calls.append(seconds)
            if len(calls) < 3:
                raise ModelError('model API request failed (HTTP 503)',retryable=True)
            return anthropic_reply()
        self.assertEqual(self.adapter('anthropic',flaky,retries=2).propose('s','c',self.tool,30),ARGS)
        self.assertEqual(len(calls),3)

        calls.clear()
        def down(url,headers,payload,seconds):
            calls.append(seconds)
            raise ModelError('model API request failed (HTTP 503)',retryable=True)
        with self.assertRaisesRegex(ModelError,'HTTP 503'):
            self.adapter('anthropic',down,retries=1).propose('s','c',self.tool,30)
        self.assertEqual(len(calls),2)

        calls.clear()
        def rejected(url,headers,payload,seconds):
            calls.append(seconds)
            raise ModelError('model API request failed (HTTP 400)',retryable=False)
        with self.assertRaisesRegex(ModelError,'HTTP 400'):
            self.adapter('anthropic',rejected,retries=5).propose('s','c',self.tool,30)
        self.assertEqual(len(calls),1)

    def test_retry_backoff_never_exceeds_the_budget(self):
        calls = []
        def down(url,headers,payload,seconds):
            calls.append(seconds)
            raise ModelError('model request timed out',retryable=True)
        with self.assertRaises(ModelError):
            self.adapter('anthropic',down,retries=5).propose('s','c',self.tool,.9)
        self.assertEqual(len(calls),1)

    def test_malformed_or_missing_tool_calls_are_reply_errors(self):
        for provider,reply in (('anthropic',{'content':[{'type':'text','text':'prose only'}]}),
                               ('anthropic',{'unexpected':True}),
                               ('anthropic',{'content':[anthropic_reply()['content'][1]]*2}),
                               ('openai',{'choices':[]}),
                               ('openai',{'choices':[{'message':{'content':'prose'}}]}),
                               ('openai',{'choices':[{'message':{'tool_calls':[
                                   {'function':{'name':'submit_plan','arguments':'{not json'}}]}}]})):
            with self.subTest(reply),self.assertRaises(ReplyError) as raised:
                self.adapter(provider,lambda *a,reply=reply: reply,model='m').propose('s','c',self.tool,5)
            self.assertNotIn(KEY,str(raised.exception))

    def test_configuration_refusals(self):
        for base in ('http://remote.invalid','https://user:secret@example.invalid','https://example.invalid?key=x',
                     'ftp://example.invalid'):
            with self.assertRaises(ValueError):
                endpoint(base,'/messages')
        self.assertEqual(endpoint('http://127.0.0.1:8080/v1','/messages'),'http://127.0.0.1:8080/v1/messages')
        with patch.dict(os.environ,{},clear=True),self.assertRaisesRegex(ValueError,'absent'):
            ProviderAdapter('anthropic')
        with patch.dict(os.environ,{'OPENAI_API_KEY':KEY}):
            with self.assertRaisesRegex(ValueError,'explicit model'):
                ProviderAdapter('openai')
            with self.assertRaisesRegex(ValueError,'retries'):
                ProviderAdapter('openai',model='m',retries=6)
            with self.assertRaisesRegex(ValueError,'environment variable name'):
                ProviderAdapter('openai',model='m',key_env='lower-case')
            with self.assertRaisesRegex(ValueError,'unknown provider'):
                ProviderAdapter('gemini')

    def test_scripted_model(self):
        model = ScriptedModel([{'submit_plan':ARGS},{'text':'no tool'}])
        self.assertEqual(model.propose('s','c',self.tool,1),ARGS)
        with self.assertRaises(ReplyError):
            model.propose('s','c',self.tool,1)
        with self.assertRaisesRegex(ModelError,'exhausted'):
            model.propose('s','c',self.tool,1)
        self.assertEqual(len(model.prompts),3)
        with self.assertRaises(ValueError):
            ScriptedModel([{}]*101)


class LoopbackHandler(BaseHTTPRequestHandler):
    responses = []
    received = []

    def do_POST(self):
        body = self.rfile.read(int(self.headers['Content-Length']))
        headers = {key.lower():value for key,value in self.headers.items()}
        LoopbackHandler.received.append((self.path,headers,json.loads(body)))
        status,payload,extra = LoopbackHandler.responses.pop(0)
        if status == 'stall':
            time.sleep(payload)
            return
        self.send_response(status)
        for key,value in extra.items():
            self.send_header(key,value)
        data = json.dumps(payload).encode()
        self.send_header('Content-Length',str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *args):
        pass


class LoopbackTransportTests(unittest.TestCase):
    """The real subprocess transport against a local HTTP server; no external network."""

    def setUp(self):
        LoopbackHandler.responses, LoopbackHandler.received = [], []
        self.server = ThreadingHTTPServer(('127.0.0.1',0),LoopbackHandler)
        threading.Thread(target=self.server.serve_forever,daemon=True).start()
        self.base = f'http://127.0.0.1:{self.server.server_address[1]}/v1'

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()

    def test_retry_after_service_unavailable_then_success(self):
        LoopbackHandler.responses = [(503,{'error':'secret provider detail'},{}),(200,anthropic_reply(),{})]
        with patch.dict(os.environ,{'ANTHROPIC_API_KEY':KEY}):
            adapter = ProviderAdapter('anthropic',base_url=self.base,retries=1,sleep=lambda s: None)
        self.assertEqual(adapter.propose('s','c',plan_tool(Catalog()),30),ARGS)
        self.assertEqual(len(LoopbackHandler.received),2)
        self.assertEqual(LoopbackHandler.received[0][0],'/v1/messages')

    def test_errors_withhold_provider_details_and_refuse_redirects(self):
        LoopbackHandler.responses = [(400,{'error':'secret provider detail'},{})]
        with self.assertRaises(ModelError) as raised:
            request_json(self.base+'/messages',{'Content-Type':'application/json'},{'k':1},10)
        self.assertFalse(raised.exception.retryable)
        self.assertIn('HTTP 400',str(raised.exception))
        self.assertNotIn('secret',str(raised.exception))
        LoopbackHandler.responses = [(307,{},{'Location':'https://example.invalid/steal'})]
        with self.assertRaisesRegex(ModelError,'redirect refused') as raised:
            request_json(self.base+'/messages',{'Content-Type':'application/json'},{'k':1},10)
        self.assertFalse(raised.exception.retryable)
        self.assertEqual(len(LoopbackHandler.received),2)

    def test_stalled_response_is_cut_off_at_the_budget(self):
        LoopbackHandler.responses = [('stall',3,{})]
        started = time.monotonic()
        with self.assertRaisesRegex(ModelError,'timed out') as raised:
            request_json(self.base+'/messages',{'Content-Type':'application/json'},{'k':1},1)
        self.assertLess(time.monotonic()-started,3)
        self.assertTrue(raised.exception.retryable)

    def test_key_header_reaches_the_server_but_not_errors(self):
        LoopbackHandler.responses = [(401,{'error':'bad key '+KEY},{})]
        with patch.dict(os.environ,{'ANTHROPIC_API_KEY':KEY}):
            adapter = ProviderAdapter('anthropic',base_url=self.base,retries=2,sleep=lambda s: None)
        with self.assertRaises(ModelError) as raised:
            adapter.propose('s','c',plan_tool(Catalog()),30)
        self.assertEqual(LoopbackHandler.received[0][1]['x-api-key'],KEY)
        self.assertNotIn(KEY,str(raised.exception))
        self.assertEqual(len(LoopbackHandler.received),1)


if __name__ == '__main__':
    unittest.main()
