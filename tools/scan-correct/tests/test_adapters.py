# SPDX-License-Identifier: GPL-3.0-or-later
import json
import os
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from adapters import Adapter, endpoint


class AdapterTests(unittest.TestCase):
    def test_anthropic_tool_result_roundtrip_without_network(self):
        requests=[]
        def transport(url,headers,payload,seconds):
            requests.append((url,headers,payload))
            return {'content':[{'type':'text','text':'inspect'},
                               {'type':'tool_use','id':'call_1','name':'measure','input':{}}]}
        with patch.dict(os.environ,{'ANTHROPIC_API_KEY':'synthetic-placeholder'}):
            adapter=Adapter('anthropic',transport=transport)
        reply=adapter.next([], 'context', [('image/png','AAAA')], 1)
        self.assertEqual(reply['calls'][0]['name'],'measure')
        adapter.next([{'type':'assistant','native':reply['native']},
                      {'type':'results','items':[{'id':'call_1','result':{'ok':False},'error':True,'images':[('image/png','AAAA')]}]}],
                      'context',[],1)
        self.assertEqual(requests[0][2]['model'],'claude-opus-5-5')
        block=requests[1][2]['messages'][-1]['content'][0]
        self.assertEqual(block['tool_use_id'],'call_1')
        self.assertTrue(block['is_error'])
        self.assertIsInstance(block['content'],list)
        self.assertEqual(block['content'][1]['type'],'image')
        self.assertEqual(requests[0][2]['messages'][0]['content'][1]['type'],'image')

    def test_openai_compatible_tool_result_preserves_kimi_fields(self):
        requests=[]
        def transport(url,headers,payload,seconds):
            requests.append(payload)
            return {'choices':[{'message':{'role':'assistant','content':None,'reasoning_content':'synthetic reasoning',
                        'tool_calls':[{'id':'m','type':'function','function':{'name':'measure','arguments':'{}'}}]}}]}
        with patch.dict(os.environ,{'KIMI_TEST_KEY':'synthetic-placeholder'}):
            adapter=Adapter('openai',model='kimi-test-id',base_url='https://example.invalid/v1',
                            key_env='KIMI_TEST_KEY',transport=transport)
        reply=adapter.next([],'context',[],1)
        adapter.next([{'type':'assistant','native':reply['native']},
                      {'type':'results','items':[{'id':'m','result':{'ok':True},'images':[('image/png','AAAA')]}]}],'context',[],1)
        self.assertEqual(requests[1]['messages'][1]['reasoning_content'],'synthetic reasoning')
        self.assertEqual(requests[1]['messages'][2]['tool_call_id'],'m')
        self.assertEqual(requests[0]['tools'][0]['type'],'function')
        self.assertEqual(requests[1]['messages'][3]['content'][0]['type'],'image_url')

    def test_malformed_provider_reply_is_a_sanitized_error(self):
        def transport(*args):
            return {'choices':[]}
        with patch.dict(os.environ,{'OPENAI_API_KEY':'synthetic-placeholder'}):
            adapter=Adapter('openai',model='test',transport=transport)
        with self.assertRaisesRegex(ValueError,'malformed'):
            adapter.next([],'context',[],1)

    def test_refuses_insecure_remote_endpoint_and_absent_key(self):
        for base in ('http://remote.invalid','https://user:secret@example.invalid','https://example.invalid?key=x'):
            with self.assertRaises(ValueError):
                endpoint(base,'/messages')
        with patch.dict(os.environ,{},clear=True),self.assertRaisesRegex(ValueError,'absent'):
            Adapter('anthropic')


if __name__=='__main__':
    unittest.main()
