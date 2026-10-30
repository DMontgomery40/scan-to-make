# SPDX-License-Identifier: MIT
"""Model adapters for the planner. Each request asks for exactly one forced tool call.

API keys are read only from environment variables and are never logged or echoed.
HTTP runs in a killable subprocess so a stalled response cannot outlive its time
budget; transient failures get a bounded number of retries inside the same budget.
"""
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time
from urllib.error import HTTPError
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener

MAX_RESPONSE_BYTES = 4*1024*1024
MAX_REQUEST_SECONDS = 120
MAX_RETRIES = 5
RETRYABLE_STATUS = frozenset({408,409,425,429,500,502,503,504,529})
DEFAULTS = {
    'anthropic':{'model':'claude-opus-5-5','key_env':'ANTHROPIC_API_KEY','base_url':'https://api.anthropic.com/v1',
                 'suffix':'/messages'},
    'openai':{'model':None,'key_env':'OPENAI_API_KEY','base_url':'https://api.openai.com/v1',
              'suffix':'/chat/completions'},
}


class ModelError(ValueError):
    def __init__(self, message, retryable=False):
        super().__init__(message)
        self.retryable = retryable


class ReplyError(ModelError):
    """The model answered, but not with a usable tool call."""


class _RedirectRefused(Exception):
    pass


class _NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        raise _RedirectRefused()


def _http_child(job):
    """Runs in the child process; returns a JSON-safe result without provider details."""
    try:
        request = Request(job['url'],json.dumps(job['payload'],allow_nan=False).encode(),
                          headers=job['headers'],method='POST')
        with build_opener(_NoRedirect).open(request,timeout=job['timeout']) as response:
            raw = response.read(MAX_RESPONSE_BYTES+1)
        if len(raw) > MAX_RESPONSE_BYTES:
            return {'ok':False,'retryable':False,'reason':'response too large'}
        return {'ok':True,'value':json.loads(raw)}
    except _RedirectRefused:
        return {'ok':False,'retryable':False,'reason':'redirect refused'}
    except HTTPError as exc:
        # Status code only: provider bodies and headers can echo request details.
        return {'ok':False,'retryable':exc.code in RETRYABLE_STATUS,'reason':f'HTTP {exc.code}'}
    except OSError:
        return {'ok':False,'retryable':True,'reason':'network error'}
    except Exception:
        return {'ok':False,'retryable':False,'reason':'invalid response'}


def request_json(url, headers, payload, seconds):
    """POST JSON with a hard wall-clock bound; raise ModelError without provider details.

    The request (including the key header) travels on the child's stdin, never argv or
    environment. On timeout the child is killed, so a stalled stream cannot outlive the budget.
    """
    job = json.dumps({'url':url,'headers':headers,'payload':payload,'timeout':seconds},allow_nan=False)
    try:
        completed = subprocess.run([sys.executable,'-I',str(Path(__file__).resolve()),'--http-child'],
                                   input=job,capture_output=True,text=True,timeout=seconds)
    except subprocess.TimeoutExpired:
        raise ModelError('model request timed out',retryable=True) from None
    try:
        result = json.loads(completed.stdout)
        ok, retryable = result['ok'], result.get('retryable',False)
    except (ValueError,TypeError,KeyError):
        raise ModelError('model request process failed') from None
    if not ok:
        raise ModelError(f'model API request failed ({result["reason"]}; provider details withheld)',
                         retryable=retryable)
    return result['value']


def endpoint(base, suffix):
    parsed = urlsplit(base)
    if (parsed.scheme not in ('https','http') or not parsed.hostname or parsed.username or
            parsed.password or parsed.query or parsed.fragment or
            (parsed.scheme == 'http' and parsed.hostname not in ('localhost','127.0.0.1','::1'))):
        raise ValueError('model base URL must be HTTPS (HTTP only on loopback), without credentials or query')
    return base.rstrip('/')+suffix


class ProviderAdapter:
    def __init__(self, provider, model=None, base_url=None, key_env=None, transport=request_json,
                 retries=2, max_tokens=2048, sleep=time.sleep):
        if provider not in DEFAULTS:
            raise ValueError('unknown provider adapter')
        if not 0 <= retries <= MAX_RETRIES:
            raise ValueError(f'retries must be within [0, {MAX_RETRIES}]')
        defaults = DEFAULTS[provider]
        self.provider = provider
        self.model = model or defaults['model']
        if not self.model:
            raise ValueError('OpenAI-compatible adapter requires an explicit model ID')
        key_env = key_env or defaults['key_env']
        if not re.fullmatch(r'[A-Z_][A-Z0-9_]*',key_env):
            raise ValueError('key environment variable name must be uppercase letters, digits and underscores')
        self.key = os.environ.get(key_env)
        if not self.key:
            raise ValueError('model API key environment variable absent; no key provisioning performed')
        self.url = endpoint(base_url or defaults['base_url'],defaults['suffix'])
        self.transport = transport
        self.retries = retries
        self.max_tokens = max_tokens
        self.sleep = sleep

    def _send(self, headers, payload, deadline):
        for attempt in range(self.retries+1):
            remaining = deadline-time.monotonic()
            if remaining <= 0:
                raise ModelError('model wall-clock budget exceeded')
            try:
                return self.transport(self.url,headers,payload,min(remaining,MAX_REQUEST_SECONDS))
            except ModelError as exc:
                delay = 2**attempt
                if not exc.retryable or attempt == self.retries or time.monotonic()+delay >= deadline:
                    raise
                self.sleep(delay)

    def propose(self, system, text, tool, seconds):
        """Send one planning request and return the forced tool call's arguments."""
        deadline = time.monotonic()+seconds
        if self.provider == 'anthropic':
            payload = {'model':self.model,'max_tokens':self.max_tokens,'system':system,
                       'messages':[{'role':'user','content':[{'type':'text','text':text}]}],
                       'tools':[tool],'tool_choice':{'type':'tool','name':tool['name']}}
            headers = {'Content-Type':'application/json','x-api-key':self.key,'anthropic-version':'2023-06-01'}
        else:
            payload = {'model':self.model,'max_tokens':self.max_tokens,
                       'messages':[{'role':'system','content':system},{'role':'user','content':text}],
                       'tools':[{'type':'function','function':{'name':tool['name'],'description':tool['description'],
                                                               'parameters':tool['input_schema']}}],
                       'tool_choice':{'type':'function','function':{'name':tool['name']}}}
            headers = {'Content-Type':'application/json','Authorization':'Bearer '+self.key}
        raw = self._send(headers,payload,deadline)
        try:
            if self.provider == 'anthropic':
                calls = [block['input'] for block in raw['content']
                         if block['type'] == 'tool_use' and block['name'] == tool['name']]
            else:
                message = raw['choices'][0]['message']
                calls = [json.loads(call['function']['arguments']) for call in message.get('tool_calls') or []
                         if call['function']['name'] == tool['name']]
        except (KeyError,IndexError,TypeError,AttributeError,ValueError):
            raise ReplyError('malformed model reply; provider details withheld') from None
        if len(calls) != 1 or not isinstance(calls[0],dict):
            raise ReplyError(f'model reply did not contain exactly one {tool["name"]} call')
        return calls[0]


class ScriptedModel:
    """Offline stand-in for tests and dry runs: replays fixed replies in order.

    Each reply is {"submit_plan": {...}} for a tool call or {"text": "..."} for a reply
    without one. Every prompt received is kept in `prompts` for inspection.
    """

    def __init__(self, replies):
        if not isinstance(replies,list) or len(replies) > 100:
            raise ValueError('scripted replies must be a list of at most 100 items')
        self.replies = replies
        self.prompts = []

    @classmethod
    def from_file(cls, path):
        path = Path(path)
        if path.stat().st_size > 1024*1024:
            raise ValueError('script file too large')
        return cls(json.loads(path.read_text()))

    def propose(self, system, text, tool, seconds):
        self.prompts.append({'system':system,'text':text,'tool':tool})
        if len(self.prompts) > len(self.replies):
            raise ModelError('scripted replies exhausted')
        reply = self.replies[len(self.prompts)-1]
        if isinstance(reply,dict) and set(reply) == {tool['name']} and isinstance(reply[tool['name']],dict):
            return reply[tool['name']]
        raise ReplyError(f'model reply did not contain exactly one {tool["name"]} call')


if __name__ == '__main__' and sys.argv[1:] == ['--http-child']:
    sys.stdout.write(json.dumps(_http_child(json.loads(sys.stdin.read()))))
