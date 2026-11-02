// Invoked only through the signed app's executable. No invitation or env secrets
// are written to stdout/stderr; auth CLI stdout is consumed by the app in memory.
import {existsSync, readFileSync, mkdirSync,writeFileSync,openSync,closeSync,statSync,accessSync,constants} from 'node:fs';
import {join, dirname, isAbsolute} from 'node:path';
import {homedir, userInfo} from 'node:os';
import {fileURLToPath} from 'node:url';
import {spawn, spawnSync} from 'node:child_process';
const resources = dirname(fileURLToPath(import.meta.url));
const payload = join(resources, 'Payload');
const state = process.env.STM_STATE;
if (!state) process.exit(1);
const mode = process.argv[2];
process.umask(0o077);
if (existsSync(join(state, 'companion.env'))) process.loadEnvFile(join(state, 'companion.env'));
const env = {...process.env, PYTHONDONTWRITEBYTECODE:'1'};
const legacy = existsSync(join(state, 'app-migration.json')) ? JSON.parse(readFileSync(join(state, 'app-migration.json'), 'utf8')) : {};
const python = join(payload, 'python/bin/python3');
const source = join(payload, 'source');
Object.assign(env, {
  PATH: [join(payload, 'node/bin'),join(payload, 'python/bin'),...(legacy.workingDirectory ? [join(legacy.workingDirectory,'printers/bambu/bin'),join(legacy.workingDirectory,'printers/generic/bin')] : []),'/opt/homebrew/bin','/usr/local/bin','/usr/bin','/bin'].join(':'),
  SCAN_TO_MAKE_REMOTE_AUTH_DIR: join(state,'auth'),
  SCAN_TO_MAKE_CAPTURE_DIR: join(state,'capture'),
  // The app's signed runtime is responsible for printer LAN traffic too. This
  // pin overrides retained operator env; changing PATH alone misses absolute
  // Homebrew Node commands in existing printer-handoff.json files.
  SCAN_TO_MAKE_PRINTER_NODE: process.execPath,
  SCAN_TO_MAKE_CAPTURE_PYTHON: env.SCAN_TO_MAKE_CAPTURE_PYTHON || legacy.workerEnvironment?.SCAN_TO_MAKE_CAPTURE_PYTHON || python,
});
if (existsSync(join(state, 'tls/cert.pem'))) {
  env.SCAN_TO_MAKE_LAN_TLS_CERT = join(state, 'tls/cert.pem');
  env.SCAN_TO_MAKE_LAN_TLS_KEY = join(state, 'tls/key.pem');
}
// Optional cleanup workers are installed independently, never bundled/downloaded
// by this app. Preserve explicit paths from the existing launcher's environment.
for (const key of ['BLENDER','SCAN_TO_MAKE_SCAN_BLENDER','SCAN_TO_MAKE_SCAN_REPAIR_TOOL','SCAN_TO_MAKE_SCAN_CORRECT_TOOL']) {
  if (!env[key] && legacy.workerEnvironment?.[key]) env[key] = legacy.workerEnvironment[key];
}
const cli = join(source,'services/companion/dist/remote-auth-cli.js');

/** An executable file. Symlinks are kept as is: Claude's updater repoints ~/.local/bin/claude at each version. */
function runnable(path) {
  try { return isAbsolute(path) && statSync(path).isFile() && (accessSync(path, constants.X_OK), true); } catch { return false; }
}
/**
 * `command -v claude` in the user's login shell, as their Terminal would answer it. The shell starts
 * from a minimal environment (companion.env credentials never reach a profile), in its own process
 * group so a profile's background job can't hold it open past the deadline. Mirrors the companion's
 * loginShellPath (ai-tweak-cli.ts) instead of importing it: this runs before the companion, from
 * the app's own resources, and must keep working whatever the companion's internals look like.
 */
function loginShellClaude(home, timeoutMs = 5000) {
  let account; try { account = userInfo(); } catch { /* no account record */ }
  const shell = [env.SHELL, account?.shell, '/bin/zsh'].find(value => value && isAbsolute(value));
  const user = env.USER || account?.username || '';
  const mark = '__SCAN_TO_MAKE_CLAUDE__';
  return new Promise(resolve => {
    let out = '', settled = false, child;
    const finish = () => {
      if (settled) return; settled = true; clearTimeout(timer); child?.stdout?.destroy(); child?.unref();
      const parts = out.split(mark);
      resolve(parts.length >= 3 ? parts[1].trim() : undefined);
    };
    const timer = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ } finish(); }, timeoutMs);
    try {
      child = spawn(shell, ['-ilc', `printf '%s' ${mark}; command -v claude; printf '%s' ${mark}`], {detached:true,
        env:{HOME:home, USER:user, LOGNAME:user, SHELL:shell, PATH:'/usr/bin:/bin:/usr/sbin:/sbin', TERM:'dumb'}, stdio:['ignore','pipe','ignore']});
    } catch { finish(); return; }
    child.stdout.setEncoding('utf8').on('data', chunk => { if (out.length < 65536) out += chunk; if (out.split(mark).length >= 3) finish(); });
    child.on('error', finish); child.on('close', finish);
  });
}
/**
 * Objects (touch-ups) run the user's own Claude Code login, and the companion
 * turns them on only with an absolute SCAN_TO_MAKE_CLAUDE_PATH. An explicit absolute path from
 * companion.env wins; a relative one would stop the companion starting, so it is replaced. Otherwise:
 * the login shell's claude, then the usual install places. Nothing found leaves objects off.
 */
async function findClaude() {
  if (env.SCAN_TO_MAKE_CLAUDE_PATH && isAbsolute(env.SCAN_TO_MAKE_CLAUDE_PATH)) return;
  delete env.SCAN_TO_MAKE_CLAUDE_PATH;
  const home = env.HOME || homedir();
  const places = [await loginShellClaude(home), join(home,'.local/bin/claude'), join(home,'.claude/local/claude'), '/opt/homebrew/bin/claude', '/usr/local/bin/claude'];
  const found = places.find(path => path && runnable(path));
  if (found) env.SCAN_TO_MAKE_CLAUDE_PATH = found;
}
if (mode === 'configure') {
  if (existsSync(join(state,'auth'))) process.exit(1);
  mkdirSync(state,{recursive:true,mode:0o700});
  const address = process.argv[3];
  const port = process.env.STM_TEST_PORT || '9077';
  const cert = spawnSync(python,['-B',join(source,'deploy/companion/generate-lan-tls.py'),join(state,'tls'),address],{env,stdio:'ignore'});
  if (cert.status !== 0) process.exit(1);
  const init = spawnSync(process.execPath,[cli,'init-lan',join(state,'auth'),`https://${address}:${port}`,join(state,'tls/cert.pem')],{env,stdio:'ignore'});
  if (init.status !== 0) process.exit(1);
  if (!existsSync(join(state,'companion.env'))) writeFileSync(join(state,'companion.env'),`SCAN_TO_MAKE_GENERATION_PORT=${port}\nMCP_TRANSPORT=stdio\n`,{mode:0o600,flag:'wx'});
} else if (mode === 'devices' || mode === 'pair-capture-and-printer-handoff') {
  const extra = process.argv.slice(3);
  if (mode === 'pair-capture-and-printer-handoff' && extra.length === 0) {
    // Migration retains the transport and its allowed identities. Only LAN
    // supports pairing without a login; older Tailscale stores omit transport.
    const {configuration} = JSON.parse(readFileSync(join(state,'auth/auth.json'), 'utf8'));
    if (configuration.transport !== 'lan') extra.push(configuration.allowedLogins[0]);
  }
  const args = [cli, mode, join(state,'auth'), ...extra];
  const child = spawn(process.execPath,args,{cwd:source,env,stdio:['ignore','inherit','ignore']});
  child.on('exit', code => process.exit(code ?? 1));
} else if (mode === 'health') {
  // Cold startup includes the bounded login-shell lookup. Immediate connection
  // refusals must not exhaust readiness before that startup can finish.
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const status = await new Promise(resolve=>{
      const child=spawn(process.execPath,[join(source,'deploy/companion/healthcheck.mjs')],{env,cwd:source,stdio:'ignore'});
      child.on('error',()=>resolve(1)); child.on('exit',code=>resolve(code));
    });
    if(status === 0) process.exit(0);
    await new Promise(r=>setTimeout(r,500));
  }
  process.exit(1);
} else if (mode === 'serve') {
  // Registration may happen before approval/migration. Never bind until activated.
  while (!existsSync(join(state, 'app-agent-enabled'))) await new Promise(r=>setTimeout(r,500));
  mkdirSync(join(state,'logs'), {recursive:true,mode:0o700});
  await findClaude();
  const out=openSync(join(state,'logs/companion.log'),'a',0o600);
  const err=openSync(join(state,'logs/companion-error.log'),'a',0o600);
  const child = spawn(process.execPath,[join(source,'services/companion/dist/server-cli.js')],{cwd:source,env,stdio:['ignore',out,err]});
  closeSync(out); closeSync(err);
  for (const signal of ['SIGTERM','SIGINT']) process.on(signal,()=>child.kill(signal));
  child.on('exit',code=>process.exit(code ?? 1));
} else process.exit(1);
