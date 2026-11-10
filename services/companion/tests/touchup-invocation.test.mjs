import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {userInfo} from 'node:os';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {prepareTouchupPass} from '../dist/touchup/inputs.js';
import {buildTouchupInvocation, systemRules, ruleSections, RULE_SECTIONS, TOUCHUP_RESULT_SCHEMA, TOUCHUP_INSTRUCTION} from '../dist/touchup/invocation.js';
import {tempDir} from './support/temp.mjs';

const fixtures = fileURLToPath(new URL('./fixtures/touchup/', import.meta.url));
async function pass() {
  const root = await tempDir('touchup-inv-');
  return prepareTouchupPass({root, objectId: 'obj', scan: [join(fixtures, 'scan.obj')], photos: [join(fixtures, 'photo.jpg')]});
}
const printer = {command: '/usr/bin/ssh', args: ['-T', 'x@127.0.0.1'], env: {MCP_TRANSPORT: 'stdio'}};
const sourceEnv = {HOME: '/Users/x', USER: 'x', PATH: '/usr/bin:/bin', BAMBU_TOKEN: 'printer-secret', ANTHROPIC_API_KEY: 'sk-secret'};
const valueOf = (args, flag) => args[args.indexOf(flag) + 1];
/** A scan sent for cleanup with no words: the pass the fixture `pass()` makes. */
const CLEANUP_RULES = systemRules({kind: 'copy'});
const FIT_RULES = systemRules({kind: 'fit', request: true});

test('args are exactly the lean worker', async () => {
  const p = await pass();
  const inv = buildTouchupInvocation({pass: p, printer, claudePath: '/usr/local/bin/claude', sourceEnv});
  assert.equal(inv.command, '/usr/local/bin/claude');
  for (const flag of ['-p', '--strict-mcp-config', '--disable-slash-commands', '--verbose']) assert.ok(inv.args.includes(flag), flag);
  assert.equal(valueOf(inv.args, '--model'), 'claude-opus-5-5');
  assert.equal(valueOf(inv.args, '--effort'), 'high');
  assert.equal(valueOf(inv.args, '--mcp-config'), inv.mcpConfigPath);
  assert.equal(valueOf(inv.args, '--tools'), 'Read,WebSearch,WebFetch');
  assert.equal(valueOf(inv.args, '--allowedTools'), 'Read,WebSearch,WebFetch,mcp__printer');
  assert.equal(valueOf(inv.args, '--output-format'), 'stream-json');
  assert.equal(valueOf(inv.args, '--json-schema'), JSON.stringify(TOUCHUP_RESULT_SCHEMA));
  assert.equal(valueOf(inv.args, '--settings'), '{"disableAllHooks":true}');
  assert.equal(valueOf(inv.args, '--append-system-prompt'), CLEANUP_RULES);
  assert.equal(inv.args.includes('--resume'), false);
  assert.ok(inv.args.at(-1).startsWith(TOUCHUP_INSTRUCTION + '\n'));
});

test('env is the allowlist plus isolation', async () => {
  const inv = buildTouchupInvocation({pass: await pass(), printer, claudePath: '/c', sourceEnv});
  assert.equal(inv.env.HOME, '/Users/x');
  assert.equal(inv.env.USER, 'x');
  assert.equal(inv.env.PATH, '/usr/bin:/bin');
  assert.equal(inv.env.CLAUDE_CODE_DISABLE_CLAUDE_MDS, '1');
  assert.equal(inv.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY, '1');
  assert.equal('BAMBU_TOKEN' in inv.env, false);
  assert.equal('ANTHROPIC_API_KEY' in inv.env, false);
});

test('a launchd-style env without USER still gets the signed-in user', async () => {
  const inv = buildTouchupInvocation({pass: await pass(), printer, claudePath: '/c', sourceEnv: {HOME: '/Users/x', PATH: '/usr/bin'}});
  assert.equal(inv.env.USER, userInfo().username);
  assert.equal(inv.env.LOGNAME, userInfo().username);
});

test('printer MCP is passed through unchanged', async () => {
  const inv = buildTouchupInvocation({pass: await pass(), printer, claudePath: '/c', sourceEnv});
  assert.deepEqual(Object.keys(inv.mcpConfig.mcpServers), ['printer']);
  assert.deepEqual(inv.mcpConfig.mcpServers.printer, {command: '/usr/bin/ssh', args: ['-T', 'x@127.0.0.1'], env: {MCP_TRANSPORT: 'stdio'}});
  assert.deepEqual(JSON.parse(await readFile(inv.mcpConfigPath, 'utf8')), inv.mcpConfig);
});

test('a printer MCP working directory is honoured through a quoted shell wrapper', async () => {
  const cwd = await tempDir("printer mcp's dir ");
  const inv = buildTouchupInvocation({pass: await pass(), printer: {command: '/bin/pwd', args: [], cwd}, claudePath: '/c', sourceEnv});
  const server = inv.mcpConfig.mcpServers.printer;
  assert.equal(server.command, '/bin/sh');
  assert.equal(server.args[0], '-c');
  const printed = execFileSync(server.command, server.args).toString().trim();
  assert.equal(execFileSync('/bin/realpath', [printed]).toString().trim(), execFileSync('/bin/realpath', [cwd]).toString().trim());
});

test('correction prompt never resumes', async () => {
  const inv = buildTouchupInvocation({pass: await pass(), printer, claudePath: '/c', sourceEnv,
    note: 'you missed the clip on the side', summary: 'Added texture to the base.', currentModel: true});
  const prompt = inv.args.at(-1);
  assert.ok(prompt.startsWith('This is the current model. Added texture to the base.\n\nChange requested: you missed the clip on the side'));
  assert.equal(inv.args.includes('--resume'), false);
});

test('cwd is the pass dir', async () => {
  const p = await pass();
  const inv = buildTouchupInvocation({pass: p, printer, claudePath: '/c', sourceEnv});
  assert.equal(inv.cwd, p.dir);
  assert.ok(inv.mcpConfigPath.startsWith(p.dir + '/'));
  const prompt = inv.args.at(-1);
  for (const path of [...p.scanPaths, p.checkpointsDir, p.outDir]) assert.ok(prompt.includes(path), path);
  assert.ok(prompt.includes(join(p.photosDir, 'photo-01.jpg')));
});

test('the user\'s instructions are the prompt, word for word', async () => {
  const p = await pass();
  const instructions = 'A clip that holds my mic on the monitor arm. The arm tube is 30 mm across.';
  const inv = buildTouchupInvocation({pass: p, printer, claudePath: '/c', sourceEnv, instructions});
  assert.ok(inv.args.at(-1).startsWith(instructions + '\n'));
  assert.equal(inv.args.at(-1).includes(TOUCHUP_INSTRUCTION), false);
});

test('a pass with no scan and no photos lists neither', async () => {
  const root = await tempDir('touchup-inv-');
  const p = await prepareTouchupPass({root, objectId: 'mount', scan: [], photos: [], requirePhotos: false});
  const prompt = buildTouchupInvocation({pass: p, printer, claudePath: '/c', sourceEnv, instructions: 'A hook.'}).args.at(-1);
  assert.equal(prompt.includes('- Scan:'), false);
  assert.equal(prompt.includes('- Photos:'), false);
  assert.ok(prompt.includes('- Output folder:'));
});

test('every STL the worker saves is in millimetres', () => {
  for (const rules of [CLEANUP_RULES, FIT_RULES]) {
    assert.match(rules, /export every STL in millimetres/);
    assert.match(rules, /Scans from the phone are in metres/);
  }
});

test('the rules ask for the fixes the photos show, not just caution', () => {
  assert.match(CLEANUP_RULES, /flatten/);
  assert.match(CLEANUP_RULES, /too faint/);
  assert.match(CLEANUP_RULES, /Keep real surface detail the photos confirm/);
  assert.equal(/never smooth captured surface/.test(CLEANUP_RULES), false, 'a lumpy surface the photos show flat must be fixable');
});

test('every pass plans how it prints, with the printer MCP\'s own fdm_design and fdm_slicing guidance, for copies and new designs alike', async () => {
  const design = 'Design the finished object the user wants, with the manufacturing plan as part of the design.';
  const slicing = 'How this printer MCP slices. Its slicer is Some Slicer.';
  for (const engine of ['blender', 'fusion']) {
    const rules = systemRules({kind: 'fit', engine, request: true}, {design, slicing});
    assert.ok(rules.endsWith(`Manufacturing guidance from the printer MCP (its fdm_design prompt):\n${design}\n\nHow the printer MCP slices (its fdm_slicing prompt):\n${slicing}`), engine);
    assert.doesNotMatch(rules, /Don't do print preparation/, 'supports and orientation are design choices now');
    assert.match(rules, /captured objects and new designs alike/);
    assert.doesNotMatch(rules, /PRINTER_FACTS|ENGINE_RULES|ENGINE_NAME/, 'no placeholder survives');
    assert.doesNotMatch(rules, /lay_flat/, 'Counterpart no longer re-orients the model');
    assert.match(rules, /with your answer's supports, off included/, 'its supports choice is what the print gets');
    assert.match(rules, /follow its slicing guidance below/);
    // PRD §8.0 item 10: how a slicer orients, supports and checks a slice comes from the MCP, never the app.
    // Every section any pass can get, together: the app's own rules name no slicer detail.
    const own = [systemRules({kind: 'fit', engine, request: true, scan: true}), systemRules({kind: 'copy', engine, request: true}), systemRules({kind: 'copy', engine, request: true, designerCopy: true})].join('\n');
    for (const section of Object.values(RULE_SECTIONS)) assert.ok(own.includes(section), section);
    for (const slicerFact of [/Bambu Studio/, /auto-orient/, /cantilever/, /orient true/, /enable_support/, /slice_stl/, /slicer_result/, /get_printer_filaments/, /get_slice_settings/, /OrcaSlicer|PrusaSlicer|Cura/])
      assert.doesNotMatch(own, slicerFact, `the app's own rules name no slicer detail: ${slicerFact}`);
    assert.doesNotMatch(own, /Manufacturing guidance from the printer MCP|How the printer MCP slices/, 'an MCP without the prompts adds nothing');
    assert.ok(systemRules({kind: 'copy', engine}, {slicing}).endsWith(`How the printer MCP slices (its fdm_slicing prompt):\n${slicing}`), 'either prompt alone');
  }
  // Every provider reads the same rules from --append-system-prompt (project-worker.ts).
  const inv = buildTouchupInvocation({pass: await pass(), printer, claudePath: '/c', sourceEnv, guidance: {design, slicing}});
  assert.ok(valueOf(inv.args, '--append-system-prompt').endsWith(slicing));
  assert.equal(valueOf(buildTouchupInvocation({pass: await pass(), printer, claudePath: '/c', sourceEnv}).args, '--append-system-prompt'), CLEANUP_RULES);
});

test('the worker loads none of the user\'s personal Claude settings', async () => {
  const inv = buildTouchupInvocation({pass: await pass(), printer, claudePath: '/c', sourceEnv});
  assert.equal(valueOf(inv.args, '--setting-sources'), '');
});

test('a correction keeps the original instructions and says the model is already in millimetres', async () => {
  const inv = buildTouchupInvocation({pass: await pass(), printer, claudePath: '/c', sourceEnv,
    instructions: 'A hook for a 25 mm handle.', note: 'make it 2 mm thicker', summary: 'Made the hook.', currentModel: true});
  const prompt = inv.args.at(-1);
  assert.ok(prompt.includes('A hook for a 25 mm handle.'));
  assert.ok(prompt.includes('Change requested: make it 2 mm thicker'));
  assert.match(prompt, /already in millimetres/);
});

test('the answer can report a failure', () => {
  assert.deepEqual(TOUCHUP_RESULT_SCHEMA.properties.status.enum, ['done', 'needs_closeup', 'failed']);
});

test('a revised request without a completed model uses original inputs without claiming millimetre STL units', async () => {
  const p = await pass();
  const prompt = buildTouchupInvocation({pass: p, printer, claudePath: '/c', sourceEnv,
    instructions: 'Copy this object.', note: 'The photos show the missing clip.'}).args.at(-1);
  assert.match(prompt, /No completed model is available yet/);
  assert.ok(prompt.includes('Original request: Copy this object.'));
  assert.ok(prompt.includes('Change requested: The photos show the missing clip.'));
  assert.equal(prompt.includes('already in millimetres'), false);
  assert.ok(prompt.includes(p.scanPaths[0]));
});

test('the worker works only with objects in its own scene', () => {
  for (const rules of [CLEANUP_RULES, FIT_RULES]) assert.match(rules, /current scene/);
});

test('a fit lookup is confirmed before fit-critical geometry', () => {
  assert.match(FIT_RULES, /manufacturer's own published dimensions/);
  assert.match(FIT_RULES, /stop with needs_closeup to confirm/);
  assert.match(FIT_RULES, /caliper photo/);
  assert.match(FIT_RULES, /come from measurements/);
});

// #427, Nov 10: a code fit pass measured the scan 29.8 deep and 150 tall against calipers of 28 and 145, judged the
// difference unimportant, designed without asking, and chose 1.5 mm a side so the cavity swallowed the inflated scan.
// The order is fixed for every engine: measurements define the interface, a disagreement stops the pass with the ask
// before any fit-critical geometry, the stated clearance is applied to the measurements, and a fit check is information.
test('a fit settles a scan disagreement with the person before any fit-critical geometry, then sizes from the measurements plus a stated clearance', () => {
  for (const engine of ['blender', 'fusion', 'code']) {
    const rules = systemRules({kind: 'fit', engine, request: true});
    const fit = rules.slice(rules.indexOf(RULE_SECTIONS.fitSizes), rules.indexOf('\n\n', rules.indexOf(RULE_SECTIONS.fitSizes)) >>> 0);
    const step = text => { const at = fit.indexOf(text); assert.ok(at >= 0, `${engine}: ${text}`); return at; };
    // In this order: measurements define the interface; compare with the scan; ask on a disagreement; size; check.
    const measured = step('come from measurements');
    const compare = step('When there is a scan, compare each measured or confirmed size with it');
    const ask = step('stop with needs_closeup before modelling any fit-critical geometry');
    const size = step('Size the interface from the measured or confirmed sizes plus a clearance you state');
    assert.ok(measured < compare && compare < ask && ask < size, `${engine}: the steps are in order`);
    assert.match(fit, /2 mm or 2%/);
    assert.match(fit, /however little you judge the difference to matter/, `${engine}: the worker's own judgement is no reason to skip the ask`);
    assert.match(fit, /names both sets of numbers/, `${engine}: the question gives the measurement and the scan reading`);
    assert.match(fit, /already answered/, `${engine}: an answered question isn't asked again`);
    assert.match(fit, /never choose the clearance to make room for the scan/i, `${engine}: the clearance isn't sized to swallow the scan`);
    assert.match(fit, /clearance per side in your summary/, `${engine}: the clearance is said`);
    assert.match(fit, /manufacturer's own published dimensions/, `${engine}: the lookup stays`);
    assert.doesNotMatch(fit, /still win over the scan/, `${engine}: no line reads as permission to skip the ask`);
    if (engine === 'code') {
      const check = step('cad_check_fit');
      assert.ok(size < check, 'the fit check comes after the size is settled');
      assert.match(fit, /as the printer MCP's cad_design prompt describes/, 'the reference and the never-resize rule are the MCP\'s');
      assert.match(fit, /report the interference and gap, with what you changed in the reference, in your changes/);
      assert.doesNotMatch(fit, /never rescale|as information/, 'no sentence duplicates cad_design');
    } else assert.doesNotMatch(fit, /cad_check_fit/);
  }
});

// F2 (review of #439): a fit from photos, a lookup or calipers alone has no scan; the comparison must not be demanded.
test('a fit with measurements and no scan is asked for no scan comparison, and a lookup is still confirmed first', async () => {
  const root = await tempDir('touchup-fit-noscan-');
  const pass = await prepareTouchupPass({root, objectId: 'fit', scan: [], photos: [], requirePhotos: false});
  for (const engine of ['blender', 'fusion', 'code']) {
    const inv = buildTouchupInvocation({pass, printer: {command: '/x'}, claudePath: '/c', kind: 'fit', engine: engine === 'blender' ? undefined : engine, documentId: 'd', handoff: {backend: 'bambu-printer-mcp', process: {command: '/x'}},
      instructions: 'A wall holder for a bottle. My calipers say 65 × 28 × 145 mm.'});
    assert.doesNotMatch(inv.args.at(-1), /- Scan:/, `${engine}: this pass has no scan`);
    const rules = inv.args[inv.args.indexOf('--append-system-prompt') + 1];
    const fit = rules.slice(rules.indexOf(RULE_SECTIONS.fitSizes), rules.indexOf('\n\n', rules.indexOf(RULE_SECTIONS.fitSizes)) >>> 0);
    // Every step that compares with or checks against a scan is conditional on there being one.
    const scanSteps = fit.split('\n').filter(line => /^\d\./.test(line) && /\b(compare|check the finished part)\b/i.test(line));
    assert.ok(scanSteps.length >= (engine === 'code' ? 2 : 1), `${engine}: the comparison (and the code engine's check) are found`);
    for (const line of scanSteps)
      assert.match(line, /^\d\. When there is a scan,/, `${engine}: ${line.slice(0, 60)}`);
    // The lookup-and-confirm ask does not depend on a scan.
    assert.match(fit, /^1\. The interface sizes come from measurements[^\n]*stop with needs_closeup to confirm them/m, `${engine}: the lookup is still confirmed`);
  }
});

test('photo evidence lists overview pages first and every real filename, including PNG inputs', async () => {
  const p = await pass();
  p.photoPaths = [join(p.photosDir, 'photo-01.jpg'), join(p.photosDir, 'photo-02.png')];
  p.photoOverviewPaths = [join(p.photosDir, 'overview-01.jpg')];
  const inv = buildTouchupInvocation({pass: p, printer, claudePath: '/c', sourceEnv});
  const prompt = inv.args.at(-1);
  for (const path of [...p.photoOverviewPaths, ...p.photoPaths]) assert.ok(prompt.includes(path), path);
  assert.ok(prompt.indexOf(p.photoOverviewPaths[0]) < prompt.indexOf(p.photoPaths[0]));
  assert.equal(prompt.includes('…'), false, 'the worker can locate each actual extension rather than guessing a range');
});

test("a copy of a designer's 3MF is told to edit that project in place and compare with the designer's file", async () => {
  const root = await tempDir('touchup-inv-designer-');
  const {writeFile} = await import('node:fs/promises');
  const working = join(root, 'model.3mf'), designer = join(root, 'scan.3mf');
  await writeFile(working, 'PK'); await writeFile(designer, 'PK');
  const p = await prepareTouchupPass({root, objectId: 'obj', scan: [working, designer], photos: [], requirePhotos: false});
  const inv = buildTouchupInvocation({pass: p, printer, claudePath: '/c', sourceEnv, instructions: 'use this caliper card exactly but add the counterpart logo', note: 'Move it up', summary: 'Logo swapped.', currentModel: false, designerCopy: true});
  const prompt = inv.args.at(-1);
  assert.match(prompt, /Designer's 3MF project to edit: .*model\.3mf \(it already has the earlier changes\)/);
  assert.match(prompt, /The designer's original 3MF, to compare against: .*scan\.3mf/);
  assert.doesNotMatch(prompt, /an STL already in millimetres/);
  const rules = valueOf(inv.args, '--append-system-prompt');
  assert.ok(rules.includes(RULE_SECTIONS.designerCopy));
  assert.equal(rules.includes(RULE_SECTIONS.colours), false, 'the multi-colour rebuild rule does not apply to a designer\'s file');
  assert.equal(rules.includes(RULE_SECTIONS.captured), false, 'a designer\'s 3MF is not a scan to clean up');
  assert.match(rules, /Never rebuild it from the merged mesh or with counterpart_make_3mf, never turn painted markings into separate parts/);
  assert.match(rules, /Never design a substitute for a model the person named/);
});

test('each pass gets the core and only the sections it needs', async () => {
  const S = RULE_SECTIONS;
  const cases = [
    ['a scan sent for cleanup with no words', {kind: 'copy'}, [S.captured]],
    ['a copy with a request', {kind: 'copy', request: true}, [S.captured, S.colours, S.namedModel]],
    ['a copy revision of its current model', {kind: 'copy', request: true}, [S.captured, S.colours, S.namedModel]],
    ["a designer's 3MF with no words", {kind: 'copy', designerCopy: true}, [S.designerCopy]],
    ["a designer's 3MF with a request", {kind: 'copy', designerCopy: true, request: true}, [S.designerCopy, S.namedModel]],
    ['a new design in Blender', {kind: 'fit', request: true}, [S.newDesign, S.fitSizes, S.colours, S.namedModel]],
    ['a new design in Fusion', {kind: 'fit', engine: 'fusion', request: true}, [S.newDesign, S.fitSizes, S.colours, S.namedModel]],
    ['a new design revision', {kind: 'fit', request: true}, [S.newDesign, S.fitSizes, S.colours, S.namedModel]],
    // docs/protocols/seats.md: a part made to fit the scanned object says where that object sits.
    ['a fit around a scanned object', {kind: 'fit', request: true, scan: true}, [S.newDesign, S.fitSizes, S.colours, S.namedModel, S.seats]],
    ['a scan cleanup never has seats', {kind: 'copy', request: true, scan: true}, [S.captured, S.colours, S.namedModel]],
  ];
  const core = systemRules({kind: 'copy'}).split(`\n\n${S.captured}`)[0];
  for (const [name, shape, present] of cases) {
    const rules = systemRules(shape);
    assert.deepEqual(ruleSections(shape).map(key => S[key]), present, name);
    for (const heading of Object.values(S)) assert.equal(rules.includes(`\n\n${heading}\n`), present.includes(heading), `${name}: ${heading}`);
    // The core is the same for every pass, apart from the engine's own line.
    assert.ok(rules.startsWith(shape.engine === 'fusion' ? 'You are making a useful 3D object' : core), name);
    assert.match(rules, /captured objects and new designs alike/, name);
    assert.doesNotMatch(rules, /PRINTER_FACTS|ENGINE_RULES|ENGINE_NAME/, name);
  }
  // The invocation builds the same shapes from its own inputs: kind (or a scan meaning a copy), the person's words, a designer's 3MF.
  const root = await tempDir('touchup-inv-shapes-');
  const empty = await prepareTouchupPass({root, objectId: 'fit', scan: [], photos: [], requirePhotos: false});
  const rulesOf = input => valueOf(buildTouchupInvocation({printer, claudePath: '/c', sourceEnv, ...input}).args, '--append-system-prompt');
  assert.equal(rulesOf({pass: await pass()}), systemRules({kind: 'copy'}));
  assert.equal(rulesOf({pass: await pass(), note: 'the cap is wrong', summary: 'Cleaned.', currentModel: true}), systemRules({kind: 'copy', request: true}));
  assert.equal(rulesOf({pass: empty, instructions: 'A hook.'}), systemRules({kind: 'fit', request: true}), 'no scan: a new design');
  assert.equal(rulesOf({pass: await pass(), kind: 'fit', instructions: 'A cap that fits this bottle.'}), systemRules({kind: 'fit', request: true, scan: true}), 'a fit around a scanned object is a new design, and says where the object sits');
  assert.equal(rulesOf({pass: await pass(), kind: 'fit', note: 'Taller.', summary: 'A holder.', currentModel: true, seats: [{rotationDeg: [0, 0, 0], translationMm: [1, 2, 3]}]}),
    systemRules({kind: 'fit', request: true, scan: true}), 'a change to it restates the seats it is given');
  assert.equal(rulesOf({pass: await pass(), kind: 'fit', note: 'Taller.', summary: 'A holder.', currentModel: true}), systemRules({kind: 'fit', request: true}), 'a change to a fit with no seats has none to restate');
  assert.equal(rulesOf({pass: await pass(), instructions: '   '}), systemRules({kind: 'copy'}), 'blank words are no request');
});

test('a captured object is recognised first, and its manufactured features are rebuilt regular', () => {
  const rules = CLEANUP_RULES.slice(CLEANUP_RULES.indexOf(RULE_SECTIONS.captured));
  assert.match(rules, /First say what the object is and name its parts/);
  assert.match(rules, /cap with ribs and a printed label/);
  assert.match(rules, /sign with separate letters standing on a base/);
  assert.match(rules, /flat faces flat, straight edges straight, cylinders round, mirrored halves mirrored/);
  assert.match(rules, /equal and evenly spaced, with their count taken from the photos/);
  assert.match(rules, /Printed graphics, labels and colour changes are ink, not shape/);
  assert.match(rules, /a raised label is a scan defect, not surface detail the photos confirm/, 'the ink rule wins over keeping confirmed detail');
  assert.match(rules, /Organic and handmade surfaces \(fabric, crochet, carving, clay\) stay as scanned/);
  assert.match(rules, /never rescales the object/);
  assert.match(rules, /tagged assumed, or estimated with toleranceMm when it sets a size/);
  assert.match(rules, /ask for a close-up of it instead of guessing/);
  // The answer can say all of that as it is: the tags, the tolerance, one line per feature, and the close-up.
  const change = TOUCHUP_RESULT_SCHEMA.properties.changes.items.properties;
  assert.ok(change.tag.enum.includes('assumed') && change.tag.enum.includes('estimated'));
  assert.ok(change.toleranceMm);
  assert.ok(TOUCHUP_RESULT_SCHEMA.properties.status.enum.includes('needs_closeup'));
  for (const elsewhere of [FIT_RULES, systemRules({kind: 'copy', designerCopy: true, request: true})]) assert.doesNotMatch(elsewhere, /ink, not shape|First say what the object is/);
});

test('a scan sent with no words gets one sentence that states the job', async () => {
  assert.match(TOUCHUP_INSTRUCTION, /^[^.]+\.$/, 'one sentence');
  assert.match(TOUCHUP_INSTRUCTION, /Clean up this scan/);
  assert.match(TOUCHUP_INSTRUCTION, /recognise what it is/);
  assert.match(TOUCHUP_INSTRUCTION, /keep its size/);
  const prompt = buildTouchupInvocation({pass: await pass(), printer, claudePath: '/c', sourceEnv}).args.at(-1);
  assert.ok(prompt.startsWith(`${TOUCHUP_INSTRUCTION}\n\nFiles:\n`));
});
