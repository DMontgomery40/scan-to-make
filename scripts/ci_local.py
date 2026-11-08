#!/usr/bin/env python3
"""Execute the repository's workflow run steps; explicit adapters for local setup actions."""
import argparse
import concurrent.futures
import contextlib
import hashlib
import itertools
import json
import os
from pathlib import Path
import platform
import re
import shlex
import shutil
import signal
import subprocess
import sys
import tempfile
import time

def output(argv, **kwargs):
    return subprocess.check_output(argv, text=True, **kwargs).strip()


def expand(value, context):
    def replace(match):
        key = match[1].strip()
        if key not in context:
            raise ValueError('Unsupported workflow expression: ' + key)
        return str(context[key])
    return re.sub(r'\$\{\{(.*?)\}\}', replace, str(value))


def matches(path, pattern):
    """GitHub path subset used here: *, **, ?, and ordered ! exclusions."""
    parts, i = [], 0
    while i < len(pattern):
        char = pattern[i]
        if pattern[i:i+3] == '**/':
            parts.append('(?:.*/)?'); i += 3
        elif pattern[i:i+2] == '**':
            parts.append('.*'); i += 2
        elif char == '*':
            parts.append('[^/]*'); i += 1
        elif char == '?':
            parts.append('[^/]'); i += 1
        elif char in '[]{}+':
            raise ValueError('Unsupported path filter syntax: ' + pattern)
        else:
            parts.append(re.escape(char)); i += 1
    return re.fullmatch(''.join(parts), path) is not None


def included(path, patterns):
    selected = False
    for pattern in patterns:
        negate = pattern.startswith('!')
        if matches(path, pattern[1:] if negate else pattern):
            selected = not negate
    return selected


def read_workflows(root, selector, changed=None):
    import yaml
    selected = []; matched = False
    for file in sorted((root / '.github/workflows').glob('*.yml')):
        doc = yaml.safe_load(file.read_text())
        if selector != 'all' and selector not in (file.stem, file.name, doc['name']):
            continue
        matched = True
        # PyYAML YAML 1.1 reads the unquoted Actions `on` key as True.
        event = doc.get('on', doc.get(True, {})).get('pull_request', {})
        if changed is not None:
            if 'paths' in event and not any(included(p, event['paths']) for p in changed):
                continue
            if 'paths-ignore' in event and all(included(p, event['paths-ignore']) for p in changed):
                continue
        for key, job in doc['jobs'].items():
            for unsupported in ('needs', 'services', 'container', 'uses', 'if'):
                if unsupported in job:
                    raise ValueError(f'{file.name}/{key}: unsupported job field {unsupported}')
            matrix = job.get('strategy', {}).get('matrix', {})
            if any(k in matrix for k in ('include', 'exclude')):
                raise ValueError('Matrix include/exclude requires an explicit adapter')
            values = itertools.product(*matrix.values()) if matrix else [()]
            for values_for_job in values:
                axes = dict(zip(matrix, values_for_job))
                selected.append({'workflow': file.stem, 'workflowName': doc['name'], 'key': key,
                    'matrix': axes, 'env': doc.get('env', {}), 'defaults': doc.get('defaults', {}), 'job': job})
    if not matched and selector != 'all':
        raise ValueError('No workflow matched ' + selector)
    return selected


def condition(expression, context, failed):
    if expression is None:
        return not failed
    expression = str(expression).strip()
    if expression.startswith('${{') and expression.endswith('}}'):
        expression = expression[3:-2].strip()
    if expression == 'failure()': return failed
    if expression == 'success()': return not failed
    if expression == 'always()': return True
    match = re.fullmatch(r"(steps\.[\w-]+\.outputs\.[\w-]+)\s*(==|!=)\s*'([^']*)'", expression)
    if not match: raise ValueError('Unsupported step condition: ' + expression)
    if match[1] not in context: raise ValueError('Missing step output: ' + match[1])
    equal = str(context[match[1]]) == match[3]
    return not failed and (equal if match[2] == '==' else not equal)


def read_env(path):
    result = {}; lines = path.read_text().splitlines(); i = 0
    while i < len(lines):
        line = lines[i]; i += 1
        if not line: continue
        if '<<' in line and ('=' not in line or line.index('<<') < line.index('=')):
            key, delimiter = line.split('<<', 1); values = []
            while i < len(lines) and lines[i] != delimiter:
                values.append(lines[i]); i += 1
            if i == len(lines): raise ValueError('Unclosed GITHUB_ENV value')
            i += 1; result[key] = '\n'.join(values)
        else:
            key, value = line.split('=', 1); result[key] = value
    return result


def run_command(command, cwd, env, log, seconds):
    if seconds <= 0: raise TimeoutError('Job deadline exceeded')
    with log.open('w') as handle:
        child = subprocess.Popen(['bash', '--noprofile', '--norc', '-eo', 'pipefail', '-c', command],
            cwd=cwd, env=env, stdout=handle, stderr=subprocess.STDOUT, start_new_session=True)
        try:
            return child.wait(timeout=seconds)
        except BaseException:
            os.killpg(child.pid, signal.SIGTERM)
            try: child.wait(timeout=5)
            except subprocess.TimeoutExpired:
                os.killpg(child.pid, signal.SIGKILL); child.wait()
            raise


def select_node(version, env):
    version = str(version)
    if version not in ('22', '24'): raise ValueError('Unsupported Node selection ' + version)
    candidates = [env.get('CI_LOCAL_NODE_' + version), shutil.which('node', path=env['PATH']),
        f'/opt/homebrew/opt/node@{version}/bin/node']
    for candidate in candidates:
        if candidate and Path(candidate).is_file():
            actual = output([candidate, '-p', 'process.versions.node'])
            if actual.split('.')[0] == version:
                return str(Path(candidate).absolute().parent), 'Node ' + actual
    raise ValueError(f'Node {version} unavailable; set CI_LOCAL_NODE_{version} to its executable')


def select_python(version, env, temporary):
    version = str(version)
    candidate = env.get('CI_LOCAL_PYTHON_' + version.replace('.', '_')) or shutil.which('python' + version, path=env['PATH'])
    if not candidate: raise ValueError('Python ' + version + ' unavailable')
    actual = output([candidate, '-c', 'import sys; print(".".join(map(str,sys.version_info[:2])))'])
    if actual != version: raise ValueError('Python version mismatch')
    venv = temporary / 'python'
    subprocess.run([candidate, '-m', 'venv', str(venv)], env=env, check=True)
    return str(venv / 'bin'), 'Python ' + version + ' in isolated venv'


def setup_action(step, context, env, temporary):
    action = step['uses'].split('@')[0]
    settings = {k: expand(v, context) for k, v in step.get('with', {}).items()}
    allowed = {'actions/checkout': {'persist-credentials'},
               'actions/setup-node': {'node-version', 'cache', 'cache-dependency-path'},
               'actions/setup-python': {'python-version'},
               'actions/cache': {'path', 'key'}}
    if action not in allowed or set(settings)-allowed[action]:
        raise ValueError('Unsupported action or options: ' + action)
    if action == 'actions/checkout':
        if set(settings) - {'persist-credentials'}:
            raise ValueError('Unsupported checkout options')
        return 'Current committed source snapshot; no credential persistence'
    if action in ('actions/setup-node', 'actions/setup-python'):
        if action.endswith('setup-node'):
            folder, note = select_node(settings['node-version'], env)
        else:
            folder, note = select_python(settings['python-version'], env, temporary)
        env['PATH'] = folder + os.pathsep + env['PATH']
        return note
    if action == 'actions/cache':
        # The run step still downloads and checksum-verifies the pin on a cold cache.
        target = Path(settings['path'])
        if not target.is_relative_to(temporary): raise ValueError('Cache path must be under runner.temp')
        cache = Path(env.get('CI_LOCAL_CACHE', str(Path.home()/'.cache/scan-to-make/ci-local'))) / 'actions' / hashlib.sha256(settings['key'].encode()).hexdigest()
        cache.mkdir(parents=True, exist_ok=True)
        marker = cache / '.complete'
        target.parent.mkdir(parents=True, exist_ok=True)
        target.symlink_to(cache, target_is_directory=True)
        context['steps.' + step['id'] + '.outputs.cache-hit'] = str(marker.exists()).lower()
        context.setdefault('_cache_markers', []).append(str(marker))
        return 'Local cache ' + ('hit' if marker.exists() else 'miss') + ': ' + settings['key']
    raise ValueError('Unsupported action: ' + action)


@contextlib.contextmanager
def ios_lock(label):
    """One iOS/Mac build or test at a time on this Mac (David, 2026-11-01: load average 672 with three
    simulator runs at once). Uses flock(2), so any other holder of ~/.stm-ios.lock is respected."""
    import fcntl
    path = Path(os.environ.get('STM_IOS_LOCK', str(Path.home() / '.stm-ios.lock')))
    with path.open('a+') as handle:
        try:
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            handle.seek(0); holder = handle.read().strip() or 'unknown'
            print('Waiting for the Mac iOS lock ' + str(path) + ', held by: ' + holder, flush=True)
            fcntl.flock(handle, fcntl.LOCK_EX)
        handle.seek(0); handle.truncate(); handle.write(str(os.getpid()) + ' ' + label + ' since ' + time.strftime('%H:%M:%S') + '\n'); handle.flush()
        try:
            yield
        finally:
            handle.seek(0); handle.truncate(); handle.flush()


def execute_job(spec, workspace, directory):
    runner = spec['job'].get('runs-on', '')
    if isinstance(runner, str) and runner.startswith(('macos', 'xcode-')) and platform.system() == 'Darwin':
        with ios_lock(spec['workflow'] + '/' + spec['key']):
            return run_job_steps(spec, workspace, directory)
    return run_job_steps(spec, workspace, directory)


def run_job_steps(spec, workspace, directory):
    directory.mkdir(parents=True, exist_ok=True)
    temporary = directory / 'temp'; temporary.mkdir()
    environment_file = temporary / 'github-env'; environment_file.touch()
    path_file = temporary / 'github-path'; path_file.touch()
    context = {'runner.temp': str(temporary), 'github.workspace': str(workspace),
               **{'matrix.' + k: v for k, v in spec['matrix'].items()}}
    env = dict(os.environ, CI='true', GITHUB_WORKSPACE=str(workspace), RUNNER_TEMP=str(temporary),
               GITHUB_ENV=str(environment_file), GITHUB_PATH=str(path_file))
    if platform.system() == 'Linux':
        # /tmp can have a small per-user quota. Keep pip and child-process scratch in this tracked job.
        scratch = temporary / 'tmp'; scratch.mkdir(mode=0o700)
        env['TMPDIR'] = str(scratch)
    env['PATH'] = env.get('PATH', '') + ':/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin'
    for values in (spec['env'], spec['job'].get('env', {})):
        env.update({key: expand(value, context) for key, value in values.items()})
    defaults = {**spec.get('defaults', {}).get('run', {}), **spec['job'].get('defaults', {}).get('run', {})}
    deadline = time.monotonic() + 60 * spec['job'].get('timeout-minutes', 360)
    failed = False; rows = []
    for index, step in enumerate(spec['job']['steps'], 1):
        start = time.monotonic(); command = step.get('run', step.get('uses', '')); status = 'SKIP'; note = ''
        try:
            if condition(step.get('if'), context, failed):
                if 'uses' in step:
                    note = setup_action(step, context, env, temporary); status = 'PASS'
                elif 'run' in step:
                    shell = step.get('shell', defaults.get('shell', 'bash'))
                    if shell != 'bash': raise ValueError('Unsupported shell: ' + shell)
                    command = expand(step['run'], context)
                    cwd = (workspace / expand(step.get('working-directory', defaults.get('working-directory', '.')), context)).resolve()
                    if not cwd.is_relative_to(workspace): raise ValueError('Working directory escapes snapshot')
                    step_env = dict(env, **{k: expand(v, context) for k, v in step.get('env', {}).items()})
                    limit = min(deadline - time.monotonic(), step.get('timeout-minutes', 360) * 60)
                    code = run_command(command, cwd, step_env, directory/f'{index:02}.log', limit)
                    status = 'PASS' if code == 0 else 'FAIL'; note = 'exit ' + str(code)
                    env.update(read_env(environment_file))
                    additions = path_file.read_text().splitlines()
                    if additions: env['PATH'] = os.pathsep.join(reversed(additions)) + os.pathsep + env['PATH']
                    environment_file.write_text(''); path_file.write_text('')
                else:
                    raise ValueError('Step has neither run nor uses')
        except Exception as error:
            status = 'FAIL'; note = str(error)
        if status == 'FAIL' and not step.get('continue-on-error', False): failed = True
        rows.append({'name': step.get('name', step.get('uses', f'Step {index}')), 'command': command,
                     'status': status, 'seconds': round(time.monotonic()-start, 2), 'note': note})
        print(spec['workflow'] + '/' + spec['key'] + ': ' + rows[-1]['name'] + ' ' + status, flush=True)
    if not failed:
        for marker in context.get('_cache_markers', []): Path(marker).touch()
    result = {'spec': spec, 'status': 'FAIL' if failed else 'PASS', 'steps': rows}
    pending = directory / 'result.pending'
    pending.write_text(json.dumps(result, indent=2))
    pending.replace(directory / 'result.json')
    return result


def mac_launch(manifest):
    import plistlib
    config = json.loads(manifest.read_text()); directory = Path(config['directory'])
    label = 'org.scantomake.ci.' + directory.parent.name.replace('_', '-')
    plist = directory.parent / 'job.plist'
    worker_env = {'PATH': os.environ.get('PATH', '') + ':/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin'}
    for key in ('CI_LOCAL_NODE_22', 'CI_LOCAL_NODE_24', 'CI_LOCAL_PYTHON_3_12', 'CI_LOCAL_CACHE'):
        if key in os.environ: worker_env[key] = os.environ[key]
    with plist.open('wb') as handle:
        plistlib.dump({'Label': label, 'ProgramArguments': [sys.executable, str(Path(__file__).resolve()), '--worker', str(manifest)],
            'WorkingDirectory': config['workspace'], 'StandardOutPath': str(directory.parent/'launch.log'),
            'StandardErrorPath': str(directory.parent/'launch-error.log'), 'RunAtLoad': True,
            'EnvironmentVariables': worker_env, 'Umask': 0o077}, handle)
    domain = 'gui/' + str(os.getuid())
    subprocess.run(['launchctl', 'bootstrap', domain, str(plist)], check=True)
    try:
        end = time.monotonic() + config['spec']['job'].get('timeout-minutes', 360)*60 + 60
        while not (directory/'result.json').exists():
            if time.monotonic() > end: raise TimeoutError('Mac launchd job timed out; see launch-error.log')
            state = output(['launchctl', 'print', domain+'/'+label])
            if 'state = not running' in state and 'last exit code =' in state:
                raise RuntimeError('Mac worker exited without result; see launch-error.log')
            time.sleep(1)
    finally:
        subprocess.run(['launchctl', 'bootout', domain+'/'+label], check=False, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def run_mac(spec, workspace, directory, host):
    remote = output(['ssh', host, 'mktemp -d /tmp/stm-ci-XXXXXXXX'])
    remote = output(['ssh', host, 'cd ' + shlex.quote(remote) + ' && pwd -P'])
    local = directory / 'transfer'; local.mkdir(parents=True)
    archive = local / 'source.tar'
    subprocess.run(['git', '-C', str(workspace), 'archive', '--format=tar', '-o', str(archive), 'HEAD'], check=True)
    manifest = local / 'manifest.json'
    manifest.write_text(json.dumps({'spec': spec, 'workspace': remote+'/source', 'directory': remote+'/result'}))
    subprocess.run(['scp', str(archive), str(manifest), str(Path(__file__).resolve()), host+':'+remote+'/'], check=True)
    command = 'mkdir '+shlex.quote(remote+'/source')+' && tar -xf '+shlex.quote(remote+'/source.tar')+' -C '+shlex.quote(remote+'/source')+' && python3 '+shlex.quote(remote+'/ci_local.py')+' --launch-macos '+shlex.quote(remote+'/manifest.json')
    completed = subprocess.run(['ssh', host, command])
    collect_mac_evidence(host, remote, directory/'mac')
    result_file = directory/'mac/result.json'
    if completed.returncode or not result_file.exists(): raise RuntimeError('Mac job failed to return a result; evidence at '+host+':'+remote)
    result = json.loads(result_file.read_text()); result['remoteEvidence'] = host+':'+remote
    return result


def linux_hosts():
    """Configured Linux boxes that answer SSH now; a dead box is skipped instead of failing its lane."""
    configured = [h.strip() for h in os.environ.get('CI_LOCAL_LINUX_HOSTS', 'agents-136,agents-173,agents-171').split(',') if h.strip()]
    def alive(host):
        try:
            return subprocess.run(['ssh', '-o', 'ConnectTimeout=5', '-o', 'BatchMode=yes', host, 'true'],
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=15).returncode == 0
        except subprocess.TimeoutExpired:
            return False
    with concurrent.futures.ThreadPoolExecutor(max_workers=max(1, len(configured))) as pool:
        up = [h for h, ok in zip(configured, pool.map(alive, configured)) if ok]
    for host in configured:
        if host not in up: print('ci-local: skipping unreachable Linux host ' + host, file=sys.stderr, flush=True)
    return up


LINUX_JOBS = '/var/tmp/stm-ci'


def run_linux(spec, workspace, directory, host):
    """Run an ubuntu job on a Linux box from the Mac, so the Mac only does Apple work (David, 2026-11-01:
    "i want those boxes 3 feet from being doing nothing as the project is bottlenecked by one mac box")."""
    q = shlex.quote
    remote = output(['ssh', host, 'mkdir -p '+LINUX_JOBS+' && mktemp -d '+LINUX_JOBS+'/job-XXXXXXXX'])
    if not re.fullmatch(re.escape(LINUX_JOBS)+r'/job-[A-Za-z0-9]{8}', remote): raise RuntimeError('Unexpected remote job folder: '+remote)
    try:
        local = directory / 'transfer'; local.mkdir(parents=True)
        archive = local / 'source.tar'
        subprocess.run(['git', '-C', str(workspace), 'archive', '--format=tar', '-o', str(archive), 'HEAD'], check=True)
        manifest = local / 'manifest.json'
        manifest.write_text(json.dumps({'spec': spec, 'workspace': remote+'/source', 'directory': remote+'/result'}))
        subprocess.run(['scp', '-q', str(archive), str(manifest), str(Path(__file__).resolve()), host+':'+remote+'/'], check=True)
        command = ('. ~/.config/scan-to-make/ci-local.env 2>/dev/null; mkdir '+q(remote+'/source')+' && tar -xf '+q(remote+'/source.tar')+' -C '+q(remote+'/source')
                   +' && python3 '+q(remote+'/ci_local.py')+' --worker '+q(remote+'/manifest.json')+' > '+q(remote+'/worker.log')+' 2>&1')
        completed = subprocess.run(['ssh', host, command])
        evidence = directory / 'linux'; evidence.mkdir(parents=True, exist_ok=True)
        subprocess.run(['scp', '-q', host+':'+remote+'/result/result.json', host+':'+remote+'/result/*.log', host+':'+remote+'/worker.log', str(evidence)+'/'],
            check=False, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    finally:
        # The job folder holds node_modules, venvs and Blender links; never leave it on the box.
        subprocess.run(['ssh', host, 'if command -v gio >/dev/null && gio trash -- '+q(remote)+'; then :; else mkdir -p ~/.local/share/Trash/files && mv -- '+q(remote)+' ~/.local/share/Trash/files/; fi'], check=False)
    result_file = evidence / 'result.json'
    if not result_file.exists(): raise RuntimeError('Linux job on '+host+' returned no result (exit '+str(completed.returncode)+'); see '+str(evidence))
    result = json.loads(result_file.read_text()); result['remoteEvidence'] = host
    return result


def collect_mac_evidence(host, remote, destination):
    # RUNNER_TEMP contains Python environments, Blender and Xcode derived data.
    # Keep those on the host; only transfer command logs and the atomic result.
    destination.mkdir(parents=True, exist_ok=True)
    subprocess.run(['scp', host+':'+remote+'/result/result.json',
        host+':'+remote+'/result/*.log', host+':'+remote+'/launch.log',
        host+':'+remote+'/launch-error.log', str(destination)], check=False)


def evidence_directory(requested):
    directory = (requested or Path(tempfile.mkdtemp(prefix='stm-ci-local-'))).resolve()
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    # Preserve earlier evidence and prevent stale result.json from being reused.
    if any(directory.iterdir()):
        directory = Path(tempfile.mkdtemp(prefix='run-', dir=directory))
    return directory


def summary(results, path, sha):
    text = ['# Local workflow checks', '', 'Commit: `'+sha+'`', '', '| Job | Result | Duration |', '|---|---|---|']
    if not results: text += ['', 'No workflow jobs selected; no checks ran.']
    for result in results:
        spec = result['spec']; name = spec['workflow']+'/'+spec['key']+' '+json.dumps(spec['matrix'])
        text.append('| '+name+' | '+result['status']+' | '+str(round(sum(r['seconds'] for r in result['steps']),2))+'s |')
    for result in results:
        text.extend(['', '## '+result['spec']['workflow']+'/'+result['spec']['key']+' '+json.dumps(result['spec']['matrix']), ''])
        if 'remoteEvidence' in result: text += ['Remote evidence: `'+result['remoteEvidence']+'`', '']
        for row in result['steps']:
            text += [f"**{row['status']}** {row['name']} ({row['seconds']}s). {row['note']}", '', '````bash', row['command'].rstrip(), '````', '']
    path.write_text('\n'.join(text))


def reviews(root, directory, base, author, prompt_dir):
    if author not in ('codex', 'claude', 'muse', 'gemini'): raise ValueError('review requires --author codex|claude|muse|gemini')
    if not prompt_dir: raise ValueError('Set CI_LOCAL_REVIEW_PROMPTS or --prompt-dir to the private prompt directory')
    prompts = Path(prompt_dir).expanduser()
    # Read both exact stored prompts; never copy their text into repository files.
    rubric = (prompts/'codex-review-rubric.md').read_text()
    cursor = (prompts/'cursor-bugbot-review.md').read_text()
    if not rubric.strip() or not cursor.strip(): raise ValueError('Empty review prompt')
    diff = output(['git', '-C', str(root), 'diff', base+'...HEAD'])
    task = directory/'cursor-task.txt'; task.write_text(cursor+'\n\nReview only; do not edit.\nDiff from '+base+'...HEAD:\n'+diff)
    second = ['codex', 'exec', '-s', 'read-only', '-'] if author == 'muse' else ['muse', 'exec', '--model', 'muse-wonder-full-1.0', '--reasoning-effort', 'xhigh', '--worktree', 'off', '--approval-mode', 'never', '--disable-request-user-input', '--prompt-file', str(task)]
    for name, command in [('codex-rubric', ['codex','review','--base',base]), ('cursor-cross-lab',second)]:
        with (directory/(name+'.log')).open('w') as log:
            completed = subprocess.run(command, cwd=root, input=task.read_text() if name=='cursor-cross-lab' and author=='muse' else None, text=True, stdout=log, stderr=subprocess.STDOUT)
        if completed.returncode: raise RuntimeError(name+' review process failed; inspect '+str(directory))
    (directory/'summary.md').write_text('# Local reviews\n\nBoth review processes completed. Read both logs and resolve actionable findings; process exit zero is not a clean verdict.\n')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('workflow', nargs='?', default='all')
    parser.add_argument('--changed-only', action='store_true'); parser.add_argument('--base', default='origin/main')
    parser.add_argument('--dry-run', action='store_true'); parser.add_argument('--output', type=Path)
    parser.add_argument('--mac-host', default=os.environ.get('CI_LOCAL_MAC_HOST', 'mac'))
    parser.add_argument('--author', default=os.environ.get('CI_LOCAL_AUTHOR'))
    parser.add_argument('--prompt-dir', default=os.environ.get('CI_LOCAL_REVIEW_PROMPTS', str(Path.home()/'.config/scan-to-make/review-prompts')))
    parser.add_argument('--worker', type=Path); parser.add_argument('--launch-macos', type=Path)
    parser.add_argument('--ios-lock', nargs=argparse.REMAINDER, metavar='COMMAND', help='run COMMAND holding the Mac iOS lock (~/.stm-ios.lock)')
    args = parser.parse_args()
    if args.ios_lock is not None:
        if not args.ios_lock: raise ValueError('--ios-lock needs a command')
        with ios_lock(' '.join(args.ios_lock)[:120]): return subprocess.run(args.ios_lock).returncode
    if args.worker:
        config = json.loads(args.worker.read_text()); result = execute_job(config['spec'], Path(config['workspace']), Path(config['directory'])); return result['status']=='FAIL'
    if args.launch_macos: mac_launch(args.launch_macos); return 0
    # Remote lanes run a git archive: listing workflows must not require a .git
    # directory. Executing checks and selecting changed paths still require Git.
    if args.dry_run and not args.changed_only:
        root = Path(__file__).resolve().parents[1]
        print(json.dumps(read_workflows(root, args.workflow), indent=2))
        return 0
    root = Path(output(['git', 'rev-parse', '--show-toplevel'])).resolve()
    sha = output(['git', '-C', str(root), 'rev-parse', 'HEAD'])
    if not args.dry_run and output(['git','-C',str(root),'status','--porcelain','--untracked-files=all']):
        raise ValueError('Commit source changes first, including new files, so checks and reviews use the same committed source')
    directory = evidence_directory(args.output)
    if args.workflow == 'review': reviews(root, directory, args.base, args.author, args.prompt_dir); print(directory/'summary.md'); return 0
    changed = None
    if args.changed_only:
        changed = subprocess.check_output(['git','-C',str(root),'diff','--name-only','--no-renames','-z',args.base+'...HEAD']).decode().split('\0')[:-1]
    jobs = read_workflows(root, args.workflow, changed)
    if args.dry_run:
        print(json.dumps(jobs, indent=2)); return 0
    def run_one(index, spec, host=None):
        jobdir = directory/f'{index+1:02}-{spec["workflow"]}-{spec["key"]}'
        try:
            runner = spec['job']['runs-on']
            if not isinstance(runner,str): raise ValueError('Unsupported runner labels')
            if runner.startswith(('macos', 'xcode-')) and platform.system()!='Darwin': return run_mac(spec, root, jobdir, args.mac_host)
            if runner.startswith('ubuntu') and host: return run_linux(spec, root, jobdir, host)
            if (runner.startswith('ubuntu') and platform.system()=='Linux') or (runner.startswith(('macos', 'xcode-')) and platform.system()=='Darwin'): return execute_job(spec, root, jobdir)
            if runner.startswith('ubuntu') and platform.system()=='Darwin': raise ValueError('No Linux host reachable (CI_LOCAL_LINUX_HOSTS) for '+runner)
            raise ValueError('Runner unavailable: '+runner)
        except Exception as error:
            return {'spec': spec, 'status':'FAIL', 'steps':[{'name':'Local runner','command':'','status':'FAIL','seconds':0,'note':str(error)}]}
    # On the Mac, ubuntu jobs go to the Linux boxes: one lane per reachable box, lanes in parallel, while Apple jobs run here.
    ubuntu = [i for i, spec in enumerate(jobs) if str(spec['job'].get('runs-on','')).startswith('ubuntu')]
    hosts = linux_hosts() if platform.system()=='Darwin' and ubuntu else []
    remote = ubuntu if hosts else []
    lanes = {host: remote[k::len(hosts)] for k, host in enumerate(hosts)}
    results = [None] * len(jobs)
    with concurrent.futures.ThreadPoolExecutor(max_workers=max(1, len(hosts))) as pool:
        futures = [pool.submit(lambda host, lane: [(i, run_one(i, jobs[i], host)) for i in lane], host, lane) for host, lane in lanes.items() if lane]
        for index, spec in enumerate(jobs):
            if index not in remote: results[index] = run_one(index, spec)
        for future in futures:
            for index, result in future.result(): results[index] = result
    summary(results, directory/'summary.md', sha)
    if not jobs: summary([], directory/'summary.md', sha)
    print('Summary: '+str(directory/'summary.md'))
    return int(any(r['status']=='FAIL' for r in results))


if __name__ == '__main__':
    try: sys.exit(main())
    except (ValueError, RuntimeError, subprocess.CalledProcessError) as error:
        print('ci-local: '+str(error), file=sys.stderr); sys.exit(1)
