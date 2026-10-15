import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  mkdtemp,
  readFile,
  writeFile,
  readdir,
  mkdir,
  rm,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { request as httpRequest } from 'node:http';
import {
  createGenerationWorker,
  startGenerationServer,
} from '../dist/generation.js';
import {
  verifyGenerationResponse,
  MAX_GENERATION_REQUEST_BYTES,
} from '@scan-to-make/contracts/generation';
import { createSavedProjects } from '@scan-to-make/contracts/saved-project';
import { exportAcceptedStl } from '../dist/stl-export.js';

const fit = JSON.parse(
  await readFile(
    new URL(
      '../../../packages/contracts/fixtures/drawer-tray.json',
      import.meta.url
    ),
    'utf8'
  )
);
const cup = JSON.parse(
  await readFile(
    new URL(
      '../../../packages/contracts/fixtures/tapered-holder.json',
      import.meta.url
    ),
    'utf8'
  )
);
const request = (sourceFit = fit) => ({ formatVersion: '0.1.0', sourceFit });
const hash = async (bytes) => createHash('sha256').update(bytes).digest('hex');
const ok = (x) => {
  assert.equal(x.status, 'ok');
  return x.project;
};
const example = fileURLToPath(
  new URL(
    '../../../tools/templates/drawer-organizer/examples/',
    import.meta.url
  )
);
async function fixture(t, body, timeoutMs = 2000) {
  const root = await mkdtemp(join(tmpdir(), 'generation-fixture-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const jobs = join(root, 'jobs');
  await mkdir(jobs);
  const script = join(root, 'fixture.mjs');
  await writeFile(
    script,
    `import {mkdir,readFile,writeFile,copyFile,symlink,rename} from 'node:fs/promises';
import {createHash} from 'node:crypto';
await writeFile(${JSON.stringify(join(root, 'pid.pending'))},String(process.pid));
await rename(${JSON.stringify(join(root, 'pid.pending'))},${JSON.stringify(join(root, 'pid'))});
const args=process.argv.slice(2);const out=args[args.indexOf('--out-dir')+1];
const spec=JSON.parse(await readFile(args[args.indexOf('--spec')+1],'utf8'));
const example=${JSON.stringify(example)};
await mkdir(out,{recursive:true});
${body}\n`
  );
  return {
    root,
    jobs,
    worker: createGenerationWorker({
      executable: process.execPath,
      generatorPath: script,
      temporaryRoot: jobs,
      timeoutMs,
    }),
  };
}
const copyOutput = `await copyFile(example+'/drawer-tray.stl',out+'/drawer-tray.stl');
const manifest=JSON.parse(await readFile(example+'/drawer-tray.manifest.json','utf8'));
manifest.sourceSpec={id:spec.id,revision:spec.revision,template:spec.template,schemaVersion:spec.schemaVersion};`;

test('real worker keeps nonzero revisions, returns complete source and verified deterministic STL, then cleans up', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'generation-real-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const worker = createGenerationWorker({ temporaryRoot: root });
  const edited = structuredClone(fit);
  edited.revision = 7;
  const input = request(edited);
  const pending = worker.generate(input);
  edited.parameters.dividersAcross = 4;
  const result = await pending;
  assert.equal(result.receipt.sourceFit.revision, 7);
  assert.equal(result.receipt.sourceFit.parameters.dividersAcross, 2);
  const checked = await verifyGenerationResponse(
    result,
    { ...fit, revision: 7 },
    hash
  );
  assert.equal(checked.bytes.length, 18284);
  assert.equal(checked.receipt.geometry.triangleCount, 364);
  assert.equal(
    checked.receipt.artifact.sha256,
    'd1906903d69a7028f37cb6c2590d843a44bb6c776f929dbce722f47ee1d3667e'
  );
  assert.deepEqual(await readdir(root), []);
});

test('worker refuses unknown request keys and unsupported templates before running', async () => {
  const worker = createGenerationWorker({
    generatorPath: '/does-not-exist.py',
  });
  await assert.rejects(
    worker.generate({ ...request(), command: 'evil' }),
    (e) => e.code === 'invalid-request'
  );
  await assert.rejects(
    worker.generate(request(cup)),
    (e) => e.code === 'unsupported-template'
  );
});

test('invalid manifest source, artifact mismatch and symlink output fail closed and clean jobs', async (t) => {
  for (const body of [
    `${copyOutput} manifest.sourceSpec.revision++; await writeFile(out+'/drawer-tray.manifest.json',JSON.stringify(manifest));`,
    `${copyOutput} manifest.artifact.sha256='a'.repeat(64); await writeFile(out+'/drawer-tray.manifest.json',JSON.stringify(manifest));`,
    `${copyOutput} manifest.artifact.byteLength++; await writeFile(out+'/drawer-tray.manifest.json',JSON.stringify(manifest));`,
    `${copyOutput} const bytes=Buffer.alloc(18284); manifest.artifact.sha256=createHash('sha256').update(bytes).digest('hex'); await writeFile(out+'/drawer-tray.stl',bytes); await writeFile(out+'/drawer-tray.manifest.json',JSON.stringify(manifest));`,
    `${copyOutput} await writeFile(out+'/drawer-tray.manifest.json',' '.repeat(65537));`,
    `${copyOutput} await writeFile(out+'/drawer-tray.stl',Buffer.alloc(32*1024*1024+1)); await writeFile(out+'/drawer-tray.manifest.json',JSON.stringify(manifest));`,
    `await symlink(example+'/drawer-tray.manifest.json',out+'/drawer-tray.manifest.json');`,
  ]) {
    const { worker, jobs } = await fixture(t, body);
    await assert.rejects(
      worker.generate(request()),
      (e) => e.code === 'invalid-output'
    );
    assert.deepEqual(await readdir(jobs), []);
  }
});

async function assertStopped(root, jobs) {
  assert.deepEqual(await readdir(jobs), []);
  const pidText = await readFile(join(root, 'pid'), 'utf8');
  assert.match(pidText, /^[1-9][0-9]*$/, 'fixture must publish a complete PID');
  const pid = Number(pidText);
  assert.ok(Number.isSafeInteger(pid) && pid > 1);
  assert.throws(
    () => process.kill(pid, 0),
    (e) => e.code === 'ESRCH'
  );
}
async function waitUntil(check) {
  const deadline = Date.now() + 5000;
  while (!(await check())) {
    assert.ok(Date.now() < deadline, 'condition did not settle');
    await new Promise((r) => setTimeout(r, 10));
  }
}

test('generator failure, output flood, deadline and cancellation leave no running child or job', async (t) => {
  for (const [body, code, timeout] of [
    [`throw Error('private details');`, 'generation-failed', 2000],
    [
      `process.stdout.write('x'.repeat(100000));setInterval(()=>{},1000);`,
      'generation-failed',
      2000,
    ],
    [`setInterval(()=>{},1000);`, 'generation-timeout', 300],
  ]) {
    const { worker, jobs, root } = await fixture(t, body, timeout);
    await assert.rejects(
      worker.generate(request()),
      (e) => e.code === code && !e.message.includes('private details')
    );
    await assertStopped(root, jobs);
  }
  const { worker, jobs, root } = await fixture(t, `setInterval(()=>{},1000);`);
  const controller = new AbortController();
  const pending = worker.generate(request(), controller.signal);
  const rejected = assert.rejects(
    pending,
    (e) => e.code === 'generation-failed'
  );
  await waitUntil(async () => {
    try {
      await readFile(join(root, 'pid'));
      return true;
    } catch {
      return false;
    }
  });
  controller.abort();
  await rejected;
  await assertStopped(root, jobs);
  // A pre-aborted request does not create a process or directory.
  const pre = await fixture(t, `throw Error('must not start');`);
  await assert.rejects(pre.worker.generate(request(), controller.signal));
  assert.deepEqual(await readdir(pre.jobs), []);
  await assert.rejects(
    readFile(join(pre.root, 'pid')),
    (e) => e.code === 'ENOENT'
  );
});

test('HTTP real generation integrates saved acceptance, exact export and edit invalidation without shadow fits', async (t) => {
  const server = await startGenerationServer({ port: 0 });
  t.after(() => server.close());
  const map = new Map();
  const storage = {
    async listIds() {
      return [...map.keys()];
    },
    async read(id) {
      return map.get(id) ?? null;
    },
    async compareAndSwap(id, a, b) {
      if ((map.get(id) ?? null) !== a) return false;
      map.set(id, b);
      return true;
    },
  };
  const repo = createSavedProjects(storage);
  let project = ok(
    await repo.create({
      id: fit.id,
      fit,
      brief: { object: 'Drawer', context: 'Fixture', addition: 'Tray' },
    })
  );
  project = ok(
    await repo.change(project.id, 0, {
      kind: 'patch-fit',
      patch: {
        template: 'drawer-tray',
        expectedRevision: 0,
        dimensions: {},
        parameters: { dividersAcross: 3 },
      },
    })
  );
  const http = await fetch(server.url + '/v1/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request(project.fit)),
  });
  assert.equal(http.status, 200);
  const verified = await verifyGenerationResponse(
    await http.json(),
    project.fit,
    hash
  );
  project = ok(
    await repo.change(project.id, 1, {
      kind: 'attach-preview',
      sourceFit: verified.receipt.sourceFit,
      artifact: verified.receipt.artifact,
    })
  );
  project = ok(
    await repo.change(project.id, 2, {
      kind: 'accept-preview',
      sourceFit: verified.receipt.sourceFit,
      artifact: verified.receipt.artifact,
    })
  );
  const root = await mkdtemp(join(tmpdir(), 'generation-export-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sourcePath = join(root, 'source.stl');
  await writeFile(sourcePath, verified.bytes);
  const projects = {
    async load(id) {
      const p = ok(await createSavedProjects(storage).load(id));
      return {
        formatVersion: '0.1.0',
        spec: p.fit,
        preview: p.preview && {
          specRevision: p.fit.revision,
          artifact: p.preview.artifact,
        },
        acceptedArtifact: p.acceptedArtifact && {
          specRevision: p.fit.revision,
          artifact: p.acceptedArtifact.artifact,
        },
      };
    },
  };
  const outputPath = join(root, 'export.stl');
  await exportAcceptedStl(projects, {
    projectId: project.id,
    expectedRevision: 1,
    sourcePath,
    outputPath,
  });
  assert.deepEqual([...(await readFile(outputPath))], [...verified.bytes]);
  project = ok(
    await repo.change(project.id, 3, {
      kind: 'patch-fit',
      patch: {
        template: 'drawer-tray',
        expectedRevision: 1,
        dimensions: {},
        parameters: { dividersAcross: 4 },
      },
    })
  );
  assert.equal(
    (
      await repo.change(project.id, 4, {
        kind: 'attach-preview',
        sourceFit: verified.receipt.sourceFit,
        artifact: verified.receipt.artifact,
      })
    ).status,
    'invalid-change'
  );
  await assert.rejects(
    exportAcceptedStl(projects, {
      projectId: project.id,
      expectedRevision: 1,
      sourcePath,
      outputPath: join(root, 'stale.stl'),
    }),
    /Stale/
  );
});

test('HTTP rejects foreign origins/hosts, invalid routes/methods/media, malformed and oversized bodies', async (t) => {
  let calls = 0;
  const server = await startGenerationServer({
    port: 0,
    worker: {
      async generate() {
        calls++;
        throw Error('should not run');
      },
    },
  });
  t.after(() => server.close());
  for (const [path, options, status, code] of [
    [
      '/v1/generate',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: 'https://evil.test',
        },
        body: '{}',
      },
      403,
      'forbidden',
    ],
    [
      '/v1/generate',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Sec-Fetch-Site': 'same-origin',
        },
        body: '{}',
      },
      403,
      'forbidden',
    ],
    ['/v1/generate', { method: 'GET' }, 405, 'method-not-allowed'],
    ['/other', {}, 404, 'not-found'],
    [
      '/v1/generate',
      { method: 'POST', body: '{}' },
      415,
      'unsupported-media-type',
    ],
    [
      '/v1/generate',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{',
      },
      400,
      'invalid-request',
    ],
    [
      '/v1/generate',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'x'.repeat(MAX_GENERATION_REQUEST_BYTES + 1),
      },
      413,
      'payload-too-large',
    ],
  ]) {
    const result = await fetch(server.url + path, options);
    assert.equal(result.status, status, JSON.stringify({ path, options }));
    assert.equal((await result.json()).error.code, code);
  }
  // fetch replaces Host; use raw HTTP so the boundary test sends the actual hostile header.
  const foreign = await rawHttp(
    server.url + '/v1/generate',
    { Host: 'evil.test' },
    ['{}']
  );
  assert.equal(foreign.status, 403);
  assert.equal(foreign.body.error.code, 'forbidden');
  const chunked = await rawHttp(server.url + '/v1/generate', {}, [
    'x'.repeat(MAX_GENERATION_REQUEST_BYTES),
    'x',
  ]);
  assert.equal(chunked.status, 413);
  assert.equal(chunked.body.error.code, 'payload-too-large');
  const health = await fetch(server.url + '/healthz');
  assert.deepEqual(await health.json(), {
    status: 'ok',
    protocolVersion: '0.1.0',
    templates: ['drawer-tray'],
  });
  assert.equal(calls, 0);
});

test('HTTP busy and client abort retain slot until worker cleanup, then accept another request', async (t) => {
  let entered, release;
  const started = new Promise((r) => {
    entered = r;
  });
  const cleanup = new Promise((r) => {
    release = r;
  });
  let calls = 0;
  const server = await startGenerationServer({
    port: 0,
    worker: {
      async generate(_input, signal) {
        calls++;
        if (calls > 1) throw Error('second request reached worker');
        entered();
        await new Promise((r) =>
          signal.addEventListener('abort', r, { once: true })
        );
        await cleanup;
        throw Error('aborted');
      },
    },
  });
  t.after(() => server.close());
  const controller = new AbortController();
  const first = fetch(server.url + '/v1/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request()),
    signal: controller.signal,
  }).catch(() => null);
  await started;
  controller.abort();
  await first;
  const busy = await fetch(server.url + '/v1/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request()),
  });
  assert.equal(busy.status, 429);
  assert.equal(calls, 1);
  release();
  let next;
  await waitUntil(async () => {
    next = await fetch(server.url + '/v1/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request()),
    });
    return next.status !== 429;
  });
  assert.equal(next.status, 502);
  assert.equal(calls, 2);
  assert.equal((await next.json()).error.code, 'generation-failed');
});

function rawHttp(url, headers, chunks) {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      url,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
      },
      (res) => {
        const data = [];
        res.on('data', (chunk) => data.push(chunk));
        res.on('error', reject);
        res.on('end', () =>
          resolve({
            status: res.statusCode,
            body: JSON.parse(Buffer.concat(data).toString()),
          })
        );
      }
    );
    req.on('error', reject);
    for (const chunk of chunks) req.write(chunk);
    req.end();
  });
}

test('an interrupted request body does not crash the listener and releases the slot', async (t) => {
  let calls = 0;
  const server = await startGenerationServer({
    port: 0,
    worker: {
      async generate() {
        calls++;
        throw Error('fixture');
      },
    },
  });
  t.after(() => server.close());
  const req = httpRequest(server.url + '/v1/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': 2000 },
  });
  req.on('error', () => {});
  req.write('{');
  // Receive acknowledgement of the active body before interrupting its socket.
  await waitUntil(async () => {
    const r = await fetch(server.url + '/v1/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    return r.status === 429;
  });
  req.destroy();
  let next;
  await waitUntil(async () => {
    next = await fetch(server.url + '/v1/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request()),
    });
    return next.status !== 429;
  });
  assert.equal(next.status, 502);
  assert.equal(calls, 1);
});
