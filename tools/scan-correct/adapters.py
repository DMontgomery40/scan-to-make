# SPDX-License-Identifier: GPL-3.0-or-later
"""Stdlib provider adapters. Keys stay in the host process, outside Blender/logs."""
import json
import multiprocessing
import os
from pathlib import Path
from urllib.parse import urlsplit
from urllib.request import Request, build_opener, HTTPRedirectHandler

from schema import TOOLS


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self,*args,**kwargs):
        raise ValueError('model API redirect refused')


def _http_child(pipe, url, headers, payload, timeout):
    try:
        request = Request(url,json.dumps(payload,allow_nan=False).encode(),headers=headers,method='POST')
        with build_opener(NoRedirect).open(request,timeout=timeout) as response:
            raw = response.read(4*1024*1024+1)
            if len(raw)>4*1024*1024:
                raise ValueError('model response too large')
        pipe.send({'ok':True,'value':json.loads(raw)})
    except Exception:
        # Do not log HTTP bodies, URLs, headers, keys or provider diagnostics.
        pipe.send({'ok':False})
    finally:
        pipe.close()


def request_json(url,headers,payload,seconds):
    context = multiprocessing.get_context('spawn')
    parent,child = context.Pipe(duplex=False)
    process = context.Process(target=_http_child,args=(child,url,headers,payload,seconds))
    process.start()
    child.close()
    try:
        if not parent.poll(seconds):
            raise ValueError('model wall-clock budget exceeded')
        result = parent.recv()
        if not result['ok']:
            raise ValueError('model API request failed (private provider details withheld)')
        return result['value']
    finally:
        parent.close()
        if process.is_alive():
            process.terminate()
        process.join(timeout=1)
        if process.is_alive():
            process.kill()
            process.join()


def endpoint(base, suffix):
    parsed = urlsplit(base)
    if (parsed.scheme not in ('https','http') or not parsed.hostname or parsed.username or
        parsed.password or parsed.query or parsed.fragment or
        (parsed.scheme=='http' and parsed.hostname not in ('localhost','127.0.0.1','::1'))):
        raise ValueError('model base URL must be HTTPS (HTTP only on loopback), without credentials/query')
    return base.rstrip('/')+suffix


def image_data(path):
    from still_images import prepare_still
    return prepare_still(path)['image']


class Scripted:
    def __init__(self, script):
        self.sequence = json.loads(Path(script).read_text())
        if not isinstance(self.sequence,list) or len(self.sequence)>100:
            raise ValueError('script must be a bounded tool-call list')
        self.index = 0

    def next(self, events, context, images, seconds):
        if self.index >= len(self.sequence):
            return {'text':'scripted sequence complete','calls':[]}
        call = self.sequence[self.index]
        self.index += 1
        return {'text':'scripted step','calls':[{'id':'step_'+str(self.index),**call}]}


class Adapter:
    def __init__(self, provider, model=None, base_url=None, key_env=None, transport=request_json):
        self.provider = provider
        if provider not in ('anthropic','openai'):
            raise ValueError('unknown provider adapter')
        self.model = model or ('claude-opus-5-5' if provider=='anthropic' else None)
        if not self.model:
            raise ValueError('OpenAI-compatible adapter requires an explicit model ID')
        self.key = os.environ.get(key_env or ('ANTHROPIC_API_KEY' if provider=='anthropic' else 'OPENAI_API_KEY'))
        if not self.key:
            raise ValueError('model API key environment variable absent; no key provisioning performed')
        self.url = endpoint(base_url or ('https://api.anthropic.com/v1' if provider=='anthropic' else 'https://api.openai.com/v1'),
                            '/messages' if provider=='anthropic' else '/chat/completions')
        self.transport = transport

    def next(self, events, context, images, seconds):
        try:
            return self._next(events,context,images,seconds)
        except (KeyError,IndexError,TypeError,AttributeError,EOFError) as exc:
            raise ValueError('malformed model reply; provider details withheld') from None

    def _next(self, events, context, images, seconds):
        if self.provider=='anthropic':
            content = [{'type':'text','text':context}]
            content += [{'type':'image','source':{'type':'base64','media_type':mime,'data':data}} for mime,data in images]
            messages = [{'role':'user','content':content}]
            for event in events:
                if event['type']=='assistant':
                    messages.append({'role':'assistant','content':event['native']})
                elif event['type']=='results':
                    messages.append({'role':'user','content':[{'type':'tool_result','tool_use_id':r['id'],
                                      'content':[{'type':'text','text':json.dumps(r['result'])}]+
                                      [{'type':'image','source':{'type':'base64','media_type':mime,'data':data}}
                                       for mime,data in r.get('images',[])],'is_error':r.get('error',False)} for r in event['items']]})
            payload = {'model':self.model,'max_tokens':4096,'tools':TOOLS,'messages':messages}
            raw = self.transport(self.url,{'Content-Type':'application/json','x-api-key':self.key,
                                           'anthropic-version':'2023-06-01'},payload,seconds)
            native = raw['content']
            calls = [{'id':c['id'],'name':c['name'],'arguments':c['input']} for c in native if c['type']=='tool_use']
            return {'text':'\n'.join(c['text'] for c in native if c['type']=='text'),'calls':calls,'native':native}
        content = [{'type':'text','text':context}]
        content += [{'type':'image_url','image_url':{'url':'data:'+mime+';base64,'+data}} for mime,data in images]
        messages = [{'role':'user','content':content}]
        for event in events:
            if event['type']=='assistant':
                messages.append(event['native'])
            elif event['type']=='results':
                messages.extend({'role':'tool','tool_call_id':r['id'],'content':json.dumps(r['result'])} for r in event['items'])
                rendered = [{'type':'image_url','image_url':{'url':'data:'+mime+';base64,'+data}}
                            for r in event['items'] for mime,data in r.get('images',[])]
                if rendered:
                    messages.append({'role':'user','content':rendered})
        payload = {'model':self.model,'messages':messages,'tools':[{'type':'function','function':{
                   'name':t['name'],'description':t['description'],'parameters':t['input_schema']}} for t in TOOLS]}
        raw = self.transport(self.url,{'Content-Type':'application/json','Authorization':'Bearer '+self.key},payload,seconds)
        native = raw['choices'][0]['message']
        calls = [{'id':c['id'],'name':c['function']['name'],'arguments':json.loads(c['function']['arguments'])}
                 for c in native.get('tool_calls',[])]
        # Retain provider-specific fields such as reasoning_content for Kimi compatibility.
        return {'text':native.get('content') or '','calls':calls,'native':native}
