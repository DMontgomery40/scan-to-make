# SPDX-License-Identifier: MIT
"""Private stdio adapter for Bambu's general Blender MCP route.

Each call gets a factory-startup Blender. There is no addon, listening socket,
or user scene. The trusted host supplies code, never a phone/model argument.
"""
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time

child=None


def terminate(_signum=None, _frame=None):
    if child and child.poll() is None:
        try:os.killpg(child.pid,signal.SIGKILL)
        except ProcessLookupError:pass
    if _signum is not None:raise SystemExit(2)


def execute(code):
    global child
    if not isinstance(code,str) or len(code.encode())>65536:
        raise ValueError('invalid execution request')
    parent=os.getppid()
    with tempfile.TemporaryDirectory(prefix='stm-printable-') as tmp:
        script=Path(tmp)/'command.py';script.write_text(code)
        env={k:os.environ[k] for k in ('PATH','HOME','LANG','DISPLAY','LD_LIBRARY_PATH') if k in os.environ}
        env.update({'PYTHONNOUSERSITE':'1','OMP_NUM_THREADS':'2','LIBGL_ALWAYS_SOFTWARE':'1'})
        child=subprocess.Popen([os.environ['BLENDER_STM_EXECUTABLE'],'--background','--factory-startup',
            '--threads','2','--python-exit-code','1','--python',str(script)],stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,env=env,start_new_session=True)
        deadline=time.monotonic()+120
        try:
            while True:
                if os.getppid()!=parent or time.monotonic()>deadline:
                    raise ValueError('Blender deadline or parent exit')
                try:
                    stdout,_=child.communicate(timeout=.1)
                    break
                except subprocess.TimeoutExpired:pass
            if child.returncode or len(stdout)>1024*1024:
                raise ValueError('Blender execution failed')
            return {'content':[{'type':'text','text':'Isolated Blender completed'}]}
        finally:
            terminate();child.wait();child=None


def main():
    signal.signal(signal.SIGTERM,terminate);signal.signal(signal.SIGINT,terminate)
    for raw in iter(lambda:sys.stdin.buffer.readline(131073),b''):
        if len(raw)>131072:raise ValueError('MCP message exceeds limit')
        request=json.loads(raw)
        if 'id' not in request:continue
        try:
            method=request.get('method');params=request.get('params',{})
            if method=='initialize':
                result={'protocolVersion':params.get('protocolVersion','2024-11-05'),
                    'capabilities':{'tools':{}},'serverInfo':{'name':'scan-to-make-isolated-blender','version':'0.1.0'}}
            elif method=='tools/list':
                result={'tools':[{'name':'execute_blender_code','description':'Execute trusted host code in a fresh isolated Blender process.',
                    'inputSchema':{'type':'object','properties':{'code':{'type':'string'},'user_prompt':{'type':'string'}},'required':['code'],'additionalProperties':False}}]}
            elif method=='tools/call' and params.get('name')=='execute_blender_code':
                result=execute(params.get('arguments',{}).get('code'))
            elif method=='ping':result={}
            else:raise ValueError('unsupported MCP method')
            response={'jsonrpc':'2.0','id':request['id'],'result':result}
        except Exception:
            response={'jsonrpc':'2.0','id':request['id'],'error':{'code':-32603,'message':'Isolated Blender request failed'}}
        print(json.dumps(response),flush=True)


if __name__=='__main__':
    try:main()
    finally:terminate()
