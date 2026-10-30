#!/usr/bin/env node
/**
 * Fixture-auth HTTP driver for the authenticated self-host smoke.
 * Talks to the checkout's real generation/capture listener using the
 * source-derived Tailscale Serve forwarding headers. No live tailnet.
 */
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';

const args = parseArgs(process.argv.slice(2));
const forwarded = JSON.parse(await readFile(args['serve-fixture'], 'utf8')).expected;

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token.startsWith('--') && i + 1 < argv.length) out[token.slice(2)] = argv[++i];
    else out._.push(token);
  }
  return out;
}

function wire(base, path, { method = 'GET', headers = {}, body, auth } = {}) {
  const url = new URL(base);
  const extra = auth
    ? { authorization: `Bearer ${auth.token}`, 'x-scan-device': auth.deviceId }
    : {};
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        hostname: url.hostname,
        port: url.port,
        path,
        method,
        headers: { ...forwarded, ...extra, ...headers },
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('error', reject);
        res.on('end', () =>
          resolve({
            status: res.statusCode,
            headers: res.headers,
            bytes: Buffer.concat(chunks),
          })
        );
      }
    );
    req.on('error', reject);
    req.end(body);
  });
}

async function readWithBusyRetry(base, path, options = {}) {
  for (let attempt = 0; attempt < 50; attempt++) {
    const result = await wire(base, path, options);
    if (result.status !== 429) return result;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Capture cleanup remained busy');
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function quotedSha256(bytes) {
  return `"${sha256(bytes)}"`;
}

function requireStatus(result, expected, label) {
  if (result.status !== expected) {
    throw new Error(
      `${label}: expected HTTP ${expected}, got ${result.status} ${result.bytes.toString('utf8')}`
    );
  }
  return result;
}

async function pair(base, invitationPath, deviceName) {
  const invitation = JSON.parse(await readFile(invitationPath, 'utf8'));
  const result = await wire(base, '/v1/pair', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: invitation.code, deviceName }),
  });
  requireStatus(result, 200, `pair ${deviceName}`);
  return JSON.parse(result.bytes.toString('utf8'));
}

async function pairSyncImport() {
  const base = args.base;
  const projectText = await readFile(args.project, 'utf8');
  const project = JSON.parse(projectText);
  const usdz = await readFile(args.usdz);
  const capturePhone = await pair(base, args['capture-invite'], 'Smoke capture');
  const generationPhone = await pair(base, args['generation-invite'], 'Smoke generation');

  const created = await wire(base, `/v1/saved-projects/${project.id}`, {
    method: 'PUT',
    auth: capturePhone,
    headers: { 'content-type': 'application/json', 'if-none-match': '*' },
    body: projectText,
  });
  requireStatus(created, 201, 'portable-project sync');
  const expectedEtag = quotedSha256(Buffer.from(projectText));
  const etag = created.headers.etag;
  if (etag !== expectedEtag) {
    throw new Error(`sync ETag ${etag} !== quoted sha256 of submitted project bytes ${expectedEtag}`);
  }
  if (!deepEqual(JSON.parse(created.bytes.toString('utf8')), project)) {
    throw new Error('sync response JSON does not match the submitted snapshot');
  }

  const imported = await wire(
    base,
    `/v1/saved-projects/${project.id}/captures?projectRevision=${project.revision}`,
    {
      method: 'POST',
      auth: capturePhone,
      headers: { 'content-type': 'model/vnd.usdz+zip', 'if-match': etag },
      body: usdz,
    }
  );
  requireStatus(imported, 201, 'USDZ import');
  const payload = JSON.parse(imported.bytes.toString('utf8'));
  if (!payload.captureId || payload.binding?.projectRevision !== project.revision) {
    throw new Error('import response missing capture identity or revision binding');
  }
  if (payload.binding.capture.evidence.physicalFit !== 'unknown') {
    throw new Error('import must leave physical-fit evidence unknown');
  }
  const originalSha = payload.binding.capture.original.sha256;
  if (originalSha !== sha256(usdz)) {
    throw new Error('import binding hash does not match source USDZ bytes');
  }

  await writeFile(
    args.state,
    JSON.stringify(
      {
        project,
        projectText,
        etag,
        captureId: payload.captureId,
        originalSha,
        capturePhone,
        generationPhone,
      },
      null,
      2
    )
  );
  process.stdout.write(
    `synced project ${project.id} etag=${etag} capture=${payload.captureId} sha256=${originalSha}\n`
  );
}

async function reopenNegatives() {
  const base = args.base;
  const state = JSON.parse(await readFile(args.state, 'utf8'));
  const usdz = await readFile(args.usdz);
  const { project, projectText, etag, captureId, originalSha, capturePhone, generationPhone } = state;
  const expectedBytes = Buffer.from(projectText);
  const expectedEtag = quotedSha256(expectedBytes);

  const reopened = await readWithBusyRetry(base, `/v1/saved-projects/${project.id}`, {
    auth: capturePhone,
  });
  requireStatus(reopened, 200, 'reopen project');
  if (!reopened.bytes.equals(expectedBytes)) {
    throw new Error('reopened project bytes do not match the submitted snapshot');
  }
  if (reopened.headers.etag !== expectedEtag) {
    throw new Error(
      `reopen ETag ${reopened.headers.etag} !== quoted sha256 of snapshot bytes ${expectedEtag}`
    );
  }
  if (reopened.headers.etag !== etag) {
    throw new Error(`reopen ETag mismatch vs stored creation etag: ${reopened.headers.etag} !== ${etag}`);
  }
  if (!deepEqual(JSON.parse(reopened.bytes.toString('utf8')), project)) {
    throw new Error('reopened project JSON does not match the original snapshot');
  }

  const original = await readWithBusyRetry(
    base,
    `/v1/saved-projects/${project.id}/captures/${captureId}/artifacts/original?projectRevision=${project.revision}`,
    { auth: capturePhone, headers: { 'if-match': etag } }
  );
  requireStatus(original, 200, 'exact original download');
  if (original.headers['content-type'] !== 'model/vnd.usdz+zip') {
    throw new Error(`original media type ${original.headers['content-type']}`);
  }
  if (original.headers['x-content-sha256'] !== originalSha) {
    throw new Error(
      `X-Content-SHA256 ${original.headers['x-content-sha256']} !== binding ${originalSha}`
    );
  }
  if (!original.bytes.equals(usdz)) {
    throw new Error('downloaded original bytes do not match the source USDZ');
  }
  if (sha256(original.bytes) !== originalSha) {
    throw new Error('downloaded original hash does not match the import binding');
  }

  const wrongRead = await wire(base, `/v1/saved-projects/${project.id}`, {
    auth: generationPhone,
  });
  requireStatus(wrongRead, 403, 'generation-only project read');

  const wrongImport = await wire(
    base,
    `/v1/saved-projects/${project.id}/captures?projectRevision=${project.revision}`,
    {
      method: 'POST',
      auth: generationPhone,
      headers: { 'content-type': 'model/vnd.usdz+zip', 'if-match': etag },
      body: Buffer.from('x'),
    }
  );
  requireStatus(wrongImport, 403, 'generation-only capture import');

  const stale = await wire(
    base,
    `/v1/saved-projects/${project.id}/captures?projectRevision=${project.revision}`,
    {
      method: 'POST',
      auth: capturePhone,
      headers: {
        'content-type': 'model/vnd.usdz+zip',
        'if-match': `"${'0'.repeat(64)}"`,
      },
      body: Buffer.from('x'),
    }
  );
  requireStatus(stale, 412, 'stale If-Match import');

  process.stdout.write(
    `reopened exact snapshot and original bytes; wrong-scope=403 stale-if-match=412 sha256=${originalSha}\n`
  );
}

function deepEqual(a, b) {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((value, index) => deepEqual(value, b[index]));
  }
  if (isObject(a) && isObject(b)) {
    const keys = Object.keys(a);
    return (
      keys.length === Object.keys(b).length &&
      keys.every((key) => Object.hasOwn(b, key) && deepEqual(a[key], b[key]))
    );
  }
  return false;
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

const phase = args._[0];
if (phase === 'pair-sync-import') await pairSyncImport();
else if (phase === 'reopen-negatives') await reopenNegatives();
else throw new Error(`unknown phase: ${phase}`);
