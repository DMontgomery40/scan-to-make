// Stands in for `claude -p ... --output-format stream-json` in the touch-up runner tests.
// Usage: node fake-claude.mjs <scenario>; cwd is the pass folder.
import {mkdirSync, writeFileSync, copyFileSync} from 'node:fs';
import {spawn} from 'node:child_process';
const scenario = process.argv[2];
const emit = event => process.stdout.write(JSON.stringify(event) + '\n');
const toolUse = (name = 'mcp__printer__blender_mcp_call') => emit({type: 'assistant', message: {content: [{type: 'tool_use', name, input: {}}]}});
const say = text => emit({type: 'assistant', message: {content: [{type: 'text', text}]}});
const result = (structured, extra = {}) => emit({type: 'result', subtype: 'success', is_error: false, num_turns: 4, total_cost_usd: 1.23, structured_output: structured, ...extra});
const stl = 'solid touched\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 1 0 0\nvertex 0 1 0\nendloop\nendfacet\nendsolid touched\n';
const hang = () => setInterval(() => {}, 1000);
mkdirSync('out/checkpoints', {recursive: true});
emit({type: 'system', subtype: 'init', model: 'claude-opus-5-5', apiKeySource: 'none', tools: ['Read', 'WebSearch'], plugins: [{name: 'cc-plugin-telemetry', source: 'cc-plugin-telemetry@builtin'}], mcp_servers: [{name: 'printer', status: 'connected'}]});
switch (scenario) {
  case 'done':
    toolUse('Read'); toolUse(); say('Restored the texture on the underside.'); toolUse();
    writeFileSync('out/checkpoints/01.stl', stl); writeFileSync('out/touched.stl', stl); writeFileSync('out/front.png', 'png');
    result({status: 'done', summary: 'Restored the texture on the underside.'});
    break;
  case 'multicolour':
    toolUse('mcp__printer__counterpart_make_3mf'); say('Made the pick black with yellow lettering.');
    writeFileSync('out/checkpoints/01.stl', stl); writeFileSync('out/touched.stl', stl); writeFileSync('out/touched.3mf', Buffer.from('PK\x03\x04 two parts'));
    writeFileSync('out/front.png', 'png');
    result({status: 'done', summary: 'Made the pick black with yellow lettering.',
      parts: [{name: 'body', colour: '#111111', material: 'PLA'}, {name: 'letters', colour: '#FFD200'}]});
    break;
  case 'multicolourjunk':
    toolUse('mcp__printer__counterpart_make_3mf');
    writeFileSync('out/touched.stl', stl); writeFileSync('out/touched.3mf', Buffer.from('PK\x03\x04 two parts'));
    result({status: 'done', summary: 'Two colours.',
      parts: [{name: 'body', colour: 'black'}, {colour: '#ffd200'}, 'oops', {name: 'x'.repeat(300), colour: '#FFF', material: 7}]});
    break;
  case 'needs_closeup':
    toolUse('Read');
    result({status: 'needs_closeup', closeup: 'the underside', summary: 'The underside is not visible in any photo.'});
    break;
  case 'toolcap':
    writeFileSync('out/checkpoints/01.stl', stl); writeFileSync('out/checkpoints/02.stl', stl + '\n');
    for (let i = 0; i < 130; i++) toolUse();
    hang();
    break;
  case 'hang':
    hang();
    break;
  case 'auth':
    emit({type: 'result', subtype: 'success', is_error: true, num_turns: 1, total_cost_usd: 0, result: 'Not logged in · Please run /login'});
    process.exitCode = 1;
    break;
  case 'unchanged':
    toolUse();
    copyFileSync('scan/input.stl', 'out/touched.stl');
    result({status: 'done', summary: 'Looked fine.'});
    break;
  case 'empty':
    toolUse();
    writeFileSync('out/touched.stl', '');
    result({status: 'done', summary: 'Saved.'});
    break;
  case 'brokenstl':
    toolUse();
    writeFileSync('out/checkpoints/01.stl', stl);
    { const header = Buffer.alloc(84); writeFileSync('out/touched.stl', header); }
    result({status: 'done', summary: 'Saved.'});
    break;
  case 'junkstl':
    toolUse();
    writeFileSync('out/touched.stl', 'junk');
    result({status: 'done', summary: 'Saved.'});
    break;
  case 'nocheckpoint':
    toolUse();
    writeFileSync('out/touched.stl', stl);
    result({status: 'done', summary: 'Looked fine, exported.'});
    break;
  case 'selffailed':
    toolUse();
    writeFileSync('out/checkpoints/01.stl', stl);
    result({status: 'failed', summary: 'Blender crashed while merging the beads.'});
    break;
  case 'truncatedstl':
    toolUse();
    writeFileSync('out/checkpoints/01.stl', stl);
    writeFileSync('out/touched.stl', 'solid touched\nfacet normal 0 0 1\n');
    result({status: 'done', summary: 'Saved.'});
    break;
  case 'stubborngrandchild': {
    const child = spawn(process.execPath, ['-e', "process.on('SIGTERM',()=>{});process.send('ready');setInterval(()=>{},1000)"], {stdio: ['ignore', 'ignore', 'ignore', 'ipc']});
    child.once('message', () => { writeFileSync('grandchild.pid', String(child.pid)); say('stubborn grandchild ready'); });
    hang();
    break;
  }
  default:
    throw new Error(`unknown scenario ${scenario}`);
}
