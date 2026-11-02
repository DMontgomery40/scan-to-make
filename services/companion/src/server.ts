import { z } from 'zod';
import {createObjectRoutes} from './objects/http.js';
import {createEventRoutes} from './events/http.js';
import type {EventLog} from './events/log.js';
import type {LiveActivityTokenStore} from './devices/live-activity-tokens.js';
import type {DevicePresence} from './devices/presence.js';
import {McpUpdateError, type McpUpdater} from './printing/mcp-updates.js';
import type {IcloudEnrolment} from './icloud-enrolment.js';
import {LiveActivityTokenUploadSchema} from '@scan-to-make/contracts/counterpart';
import type {ObjectService} from './objects/service.js';
import {createCaptureRoutes,type CaptureServices} from './capture-http.js';
import {createPrintHandoffRoutes,type PrintHandoffServices} from './print-handoff-http.js';
import {acquireInstanceLock} from './instance-lock.js';
import { createServer, type IncomingMessage, type RequestListener } from 'node:http';
import {createServer as createHttpsServer} from 'node:https';
import {certificatePublicKeySha256, checkLanCertificate} from './lan-transport.js';
import {authority as hostAuthority, bindable, pairingOrigins, type LanAddresses} from './lan-addresses.js';
import {advertise, instanceName, type Advert} from './bonjour.js';
import {NearbyInputError, NearbyPairing} from './nearby-pairing.js';
import type {NearbyRequest} from '@scan-to-make/contracts/nearby-pairing';
import {
  RemoteAuthFailure,
  RemoteAuthStore,
  type RemoteScope,
} from './remote-auth.js';

const MAX_PAIR_REQUEST_BYTES = 4096;
const McpUpdateRequestSchema = z.strictObject({ fresh: z.boolean().optional() });
/** `POST /v1/pair/icloud`. `installId` is the phone's installation key, the same value QR pairing sends as `installationKey`. */
const IcloudEnrolSchema = z.strictObject({
  macId: z.uuid(),
  enrolmentToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  installId: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  deviceName: z.string().trim().min(1).max(80).regex(/^[^\x00-\x1f\x7f]+$/),
  model: z.string().regex(/^[A-Za-z0-9,._ -]{1,64}$/).optional(),
});
const errors = {
  'invalid-request': [400, 'Invalid request'],
  'payload-too-large': [413, 'Request payload limit exceeded'],
  'companion-failed': [500, 'The companion could not complete the request'],
  forbidden: [403, 'Only direct local clients are supported'],
  'not-found': [404, 'Unknown companion route'],
  'method-not-allowed': [405, 'Method not allowed'],
  'unsupported-media-type': [415, 'Requests require JSON'],
} as const;
type ServerErrorCode = keyof typeof errors;

export class ServerFailure extends Error {
  readonly status: number;
  constructor(readonly code: ServerErrorCode) {
    super(errors[code][1]);
    this.status = errors[code][0];
  }
}

async function readBody(
  request: IncomingMessage,
  signal: AbortSignal,
  limit: number
): Promise<unknown> {
  const bytes = await new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let length = 0;
    const finish = (error?: Error) => {
      clearTimeout(timer);
      request.off('data', data);
      request.off('end', end);
      request.off('error', failed);
      signal.removeEventListener('abort', aborted);
      if (error) {
        request.resume();
        reject(error);
      } else resolve(Buffer.concat(chunks, length));
    };
    const data = (chunk: Buffer) => {
      length += chunk.length;
      if (length > limit) finish(new ServerFailure('payload-too-large'));
      else chunks.push(chunk);
    };
    const end = () => finish();
    const failed = () => finish(new ServerFailure('invalid-request'));
    const aborted = () => finish(new ServerFailure('invalid-request'));
    const timer = setTimeout(
      () => finish(new ServerFailure('invalid-request')),
      5000
    );
    request.on('data', data);
    request.once('end', end);
    request.once('error', failed);
    signal.addEventListener('abort', aborted, { once: true });
    if (signal.aborted) aborted();
  });
  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new ServerFailure('invalid-request');
  }
}

function singleHeader(
  request: IncomingMessage,
  name: string
): string | undefined {
  let count = 0;
  for (let i = 0; i < request.rawHeaders.length; i += 2)
    if (request.rawHeaders[i]?.toLowerCase() === name) count++;
  const value = request.headers[name];
  if (count > 1 || Array.isArray(value))
    throw new RemoteAuthFailure('forbidden');
  return value;
}

/**
 * Explicit paired TLS LAN mode or loopback-only private Serve mode.
 *
 * In LAN mode the companion always binds its configured address. With `lanAddresses`
 * (pairing v2, MAC-5) it also binds every other address that function finds, never
 * 0.0.0.0, with the same certificate: a v2 phone pins the public key, so a certificate
 * that names only the configured address serves them all, and a v1 phone's
 * whole-certificate pin keeps matching on the configured address.
 */
export async function startCompanionServer(
  options: {
    port?: number;
    remoteAuth?: RemoteAuthStore;
    lanTls?: {cert: Buffer; key: Buffer};
    capture?: CaptureServices;
    printHandoff?: PrintHandoffServices;
    /** Objects (scan or instructions → touch-up → print), when touch-ups are set up. */
    objects?: ObjectService;
    /** The event log behind GET /v1/events (PRD §8.7). */
    events?: EventLog;
    /** Live Activity tokens from phones, for the Mac app (PRD §8.8). */
    liveActivityTokens?: LiveActivityTokenStore;
    /** Last seen and model per device. */
    presence?: DevicePresence;
    /** PRD §8.10: Update for the printer MCPs. */
    mcpUpdates?: McpUpdater;
    /** PRD §5.10: enrolment through the owner's iCloud (LAN mode only). */
    icloud?: IcloudEnrolment;
    /** Extra addresses to bind beside the configured one; looked up again every `rediscoverMs`. */
    lanAddresses?: () => LanAddresses;
    /** The Mac's `.local` name, accepted as a Host and listed in v2 links. */
    localName?: string;
    rediscoverMs?: number;
    /**
     * Nearby pairing (MAC-5): the `/v1/pair/nearby` routes and, on macOS, the Bonjour
     * `_scantomake._tcp` advert under `name` (the Mac's name, also the v2 link's `n=`).
     */
    nearby?: {name: string; advertise?: typeof advertise};
    /** The Mac's name as people know it ("Mac mini"), in /healthz so the phone can say which Mac it reached. */
    name?: string;
  } = {}
): Promise<{
  url: string;
  close(): Promise<void>;
  /** Pairing link v2 origins in the order to try: only addresses this server is bound to. */
  addresses(): string[];
  /** The same addresses with their kind, for the CloudKit `CounterpartMac` record (PRD §5.10). */
  addressList(): {kind: 'lan' | 'mdns' | 'tailscale'; host: string; port: number}[];
  /** The SHA-256 of the TLS public key (v2 `k=`), in LAN mode. */
  publicKeySha256?: string;
  /** Nearby requests waiting for Allow on the Mac, and the answer (control socket). */
  nearby?: {pending(): NearbyRequest[]; answer(id: string, allow: boolean): Promise<boolean>};
}> {
  const auth = options.remoteAuth;
  const lan = auth?.transport === 'lan';
  const lanUrl = lan ? new URL(auth.baseUrl) : undefined;
  const port = options.port ?? (lanUrl ? Number(lanUrl.port || '443') : 9077);
  if (lan) {
    if (!options.lanTls) throw new Error('LAN mode requires TLS');
    if (port !== Number(lanUrl!.port || '443')) throw new Error('LAN port differs from pairing URL');
    checkLanCertificate(options.lanTls.cert, lanUrl!.hostname, auth!.certificateSha256!);
  } else if (options.lanTls) throw new Error('TLS requires explicit LAN pairing configuration');
  if (options.lanAddresses && !lan) throw new Error('Extra addresses require LAN pairing');
  if (options.nearby && !lan) throw new Error('Nearby pairing requires LAN pairing');
  // Extra listeners by address, and the Host values this server answers to.
  const extras = new Map<string, ReturnType<typeof createHttpsServer>>();
  let found: LanAddresses = { lan: [], tailscale: [] };
  const publicKeySha256 = lan ? certificatePublicKeySha256(options.lanTls!.cert) : undefined;
  const addresses = () => {
    if (!lan) return [];
    const live = (list: string[]) => list.filter(a => extras.has(a));
    return pairingOrigins(lanUrl!.hostname, port, { lan: live(found.lan), tailscale: live(found.tailscale) }, options.localName);
  };
  const macName = options.nearby ? instanceName(options.nearby.name) : undefined;
  const nearby = options.nearby ? new NearbyPairing({
    auth: auth!, login: 'lan', publicKeySha256: publicKeySha256!, link: () => ({ addresses: addresses(), name: macName }),
  }) : undefined;
  // Hosts as clients send them: on port 443 the port is left off.
  const hosts = () => new Set([
    auth?.host?.toLowerCase(),
    ...[...extras.keys()].map(a => hostAuthority(a, port)),
    ...(options.localName ? [hostAuthority(options.localName, port)] : []),
  ]);
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535)
    throw new Error('Invalid local port');
  if(options.capture&&!auth)throw new Error('Capture routes require explicit authentication');
  if(options.printHandoff&&!auth)throw new Error('Printer handoff routes require explicit authentication');
  // One companion process per capture directory: scan processing assumes its
  // jobs, workers and cancellation all live in this process.
  const instanceLock=options.capture?.scanProcessing?await acquireInstanceLock(options.capture.scanProcessing.directory):undefined;
  const captureRoutes=options.capture?createCaptureRoutes(options.capture):undefined;
  const printHandoffRoutes=options.printHandoff?createPrintHandoffRoutes(options.printHandoff):undefined;
  const objectRoutes=options.objects?createObjectRoutes(options.objects):undefined;
  const eventRoutes=options.events?createEventRoutes(options.events):undefined;
  let authority = '';
  const handler: RequestListener = async (request, response) => {
    response.setHeader('Content-Type', 'application/json');
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Connection', 'close');
    try {
      if (
        request.headers.origin !== undefined ||
        request.headers['sec-fetch-site'] !== undefined
      )
        throw new ServerFailure('forbidden');
      let login = '';
      if (auth && lan) {
        if (!hosts().has(singleHeader(request, 'host')?.toLowerCase()) ||
            Object.keys(request.headers).some(key => key === 'forwarded' || key.startsWith('x-forwarded-') || key.startsWith('tailscale-'))) {
          throw new RemoteAuthFailure('forbidden');
        }
        login = 'lan'; // The single-use invitation, then device token, authorizes this mode.
      } else if (auth) {
        login = singleHeader(request, 'tailscale-user-login') ?? '';
        if (
          singleHeader(request, 'host') !== auth.host ||
          singleHeader(request, 'x-forwarded-host') !== auth.host ||
          singleHeader(request, 'x-forwarded-proto') !== 'https' ||
          request.headers['tailscale-funnel-request'] !== undefined ||
          !auth.allowsLogin(login)
        )
          throw new RemoteAuthFailure('forbidden');
      } else if (
        request.headers.host !== authority ||
        Object.keys(request.headers).some(
          (key) =>
            key.startsWith('x-forwarded-') || key.startsWith('tailscale-')
        )
      ) {
        throw new ServerFailure('forbidden');
      }
      const credential = () => ({
        deviceId: singleHeader(request, 'x-scan-device'),
        token: singleHeader(request, 'authorization')?.match(/^Bearer ([A-Za-z0-9_-]{43})$/)?.[1],
      });
      const authorize = async (scope: RemoteScope) => {
        if (!auth) return;
        const { deviceId, token } = credential();
        await auth.authorize(login, deviceId, token, scope);
        if (deviceId) void options.presence?.seen(deviceId, singleHeader(request, 'x-scan-device-model')).catch(() => undefined);
        const name = deviceId ? singleHeader(request, 'x-scan-device-name') : undefined;
        if (deviceId && name) void auth.renameDevice(deviceId, name).catch(() => undefined);
      };
      if (request.url === '/healthz' && request.method === 'GET') {
        // Scope name kept from the first protocol so existing pairings still parse.
        await authorize('generation:health');
        // Additive: older phones read only status and protocolVersion.
        response.end(JSON.stringify({ status: 'ok', protocolVersion: '0.1.0', ...(options.name ? { name: options.name } : {}), capabilities: { genericConfirmations: !!options.objects, materialChoice: !!options.objects, projectSettings: !!options.objects, projectRename: !!options.objects, messagePhotos: !!options.objects, mcpUpdates: !!options.mcpUpdates, printCopies: !!options.objects?.printCopiesAvailable } }));
        return;
      }
      if(captureRoutes&&request.url?.startsWith('/v1/saved-projects/')){
        await captureRoutes.handle(request,response,authorize,name=>singleHeader(request,name));return;
      }
      if(objectRoutes&&(request.url==='/v1/objects'||request.url?.startsWith('/v1/objects/')||request.url?.startsWith('/v1/objects?')||request.url==='/v1/settings')){
        await objectRoutes.handle(request,response,authorize,name=>singleHeader(request,name));return;
      }
      if(eventRoutes&&(request.url==='/v1/events'||request.url?.startsWith('/v1/events?'))){
        await eventRoutes.handle(request,response,authorize);return;
      }
      if(options.liveActivityTokens&&request.url==='/v1/devices/live-activity-tokens'){
        if(request.method!=='POST')throw new ServerFailure('method-not-allowed');
        await authorize('projects:write');
        if(!/^application\/json(?:;\s*charset=utf-8)?$/i.test(request.headers['content-type']??''))throw new ServerFailure('unsupported-media-type');
        const controller=new AbortController();
        const abort=()=>controller.abort();
        response.once('close',abort);
        let input:unknown;
        try{input=await readBody(request,controller.signal,4096);}finally{response.off('close',abort);}
        const parsed=LiveActivityTokenUploadSchema.safeParse(input);
        if(!parsed.success)throw new ServerFailure('invalid-request');
        await authorize('projects:write');
        await options.liveActivityTokens.store(credential().deviceId!,parsed.data);
        response.end(JSON.stringify({stored:true}));return;
      }
      const mcpUpdate=/^\/v1\/printers\/mcp\/(mcp-[0-9a-f]{16})\/update$/.exec(request.url??'');
      if(options.mcpUpdates&&mcpUpdate){
        if(request.method!=='POST')throw new ServerFailure('method-not-allowed');
        await authorize('projects:write');
        const controller=new AbortController();
        const abort=()=>controller.abort();
        response.once('close',abort);
        let input:unknown={};
        try{if(request.headers['content-length']!=='0'&&request.headers['content-type'])input=await readBody(request,controller.signal,1024);}finally{response.off('close',abort);}
        const parsed=McpUpdateRequestSchema.safeParse(input??{});
        if(!parsed.success)throw new ServerFailure('invalid-request');
        await authorize('projects:write');
        try{
          const update=await options.mcpUpdates.update(mcpUpdate[1]!,parsed.data);
          response.end(JSON.stringify({update}));
        }catch(error){
          if(!(error instanceof McpUpdateError))throw error;
          response.statusCode=error.code==='not-found'?404:503;
          response.end(JSON.stringify({error:{code:error.code,message:error.message}}));
        }
        return;
      }
      if(printHandoffRoutes&&request.url?.startsWith('/v1/printer-handoff/')){
        await printHandoffRoutes.handle(request,response,authorize,name=>singleHeader(request,name));return;
      }
      if (auth && request.url === '/v1/auth/refresh') {
        // Rolling refresh: the same credential, valid for another full lifetime. No body.
        if (request.method !== 'POST')
          throw new ServerFailure('method-not-allowed');
        if (Number(request.headers['content-length'] ?? 0) !== 0 || request.headers['transfer-encoding'] !== undefined)
          throw new ServerFailure('invalid-request');
        const { deviceId, token } = credential();
        response.end(JSON.stringify(await auth.refresh(login, deviceId, token)));
        return;
      }
      const pairBody = async () => {
        if (
          !/^application\/json(?:;\s*charset=utf-8)?$/i.test(
            request.headers['content-type'] ?? ''
          ) ||
          (request.headers['content-encoding'] !== undefined &&
            request.headers['content-encoding'] !== 'identity')
        )
          throw new ServerFailure('unsupported-media-type');
        if (Number(request.headers['content-length'] ?? 0) > MAX_PAIR_REQUEST_BYTES)
          throw new ServerFailure('payload-too-large');
        const controller = new AbortController();
        const abort = () => controller.abort();
        response.once('close', abort);
        try {
          const input = await readBody(request, controller.signal, MAX_PAIR_REQUEST_BYTES);
          if (controller.signal.aborted)
            throw new ServerFailure('invalid-request');
          return input;
        } finally {
          response.off('close', abort);
        }
      };
      if (nearby && request.url?.startsWith('/v1/pair/nearby')) {
        // Nearby pairing, unauthenticated like /v1/pair: starting one is a pairing attempt.
        const step = ({ '/v1/pair/nearby': 'start', '/v1/pair/nearby/reveal': 'reveal', '/v1/pair/nearby/result': 'result' } as const)[request.url];
        if (!step) throw new ServerFailure('not-found');
        if (request.method !== 'POST') throw new ServerFailure('method-not-allowed');
        if (step === 'start') await auth!.reservePairAttempt(login);
        const input = await pairBody();
        const gone = new AbortController();
        const hangUp = () => gone.abort();
        response.once('close', hangUp);
        try {
          const reply = step === 'start' ? nearby.start(input)
            : step === 'reveal' ? nearby.reveal(input)
            : await nearby.result(input, gone.signal);
          if (!response.destroyed) response.end(JSON.stringify(reply));
        } catch (error) {
          throw error instanceof NearbyInputError ? new ServerFailure('invalid-request') : error;
        } finally {
          response.off('close', hangUp);
        }
        return;
      }
      if (auth && lan && options.icloud && request.url === '/v1/pair/icloud') {
        // PRD §5.10: no credential beyond the enrolment token from the owner's iCloud, over the pinned TLS.
        if (request.method !== 'POST') throw new ServerFailure('method-not-allowed');
        await auth.reservePairAttempt(login);
        const parsed = IcloudEnrolSchema.safeParse(await pairBody());
        if (!parsed.success) throw new ServerFailure('invalid-request');
        const { macId, enrolmentToken, installId, deviceName, model } = parsed.data;
        if (!await options.icloud.redeem(macId, enrolmentToken)) throw new RemoteAuthFailure('unauthorized');
        // The same credential and scopes as QR pairing; the install key replaces that install's earlier record.
        const { code } = await auth.createPairing(login);
        const issued = await auth.exchange(login, { code, deviceName, installationKey: installId });
        if (model) void options.presence?.seen(issued.deviceId, model).catch(() => undefined);
        response.end(JSON.stringify(issued));
        return;
      }
      if (!auth || request.url !== '/v1/pair')
        throw new ServerFailure('not-found');
      if (request.method !== 'POST')
        throw new ServerFailure('method-not-allowed');
      await auth.reservePairAttempt(login);
      response.end(JSON.stringify(await auth.exchange(login, await pairBody(), credential())));
    } catch (error) {
      const failure =
        error instanceof ServerFailure || error instanceof RemoteAuthFailure
          ? error
          : new ServerFailure('companion-failed');
      if (!response.destroyed) {
        response.statusCode = failure.status;
        response.end(
          JSON.stringify({
            error: { code: failure.code, message: failure.message },
          })
        );
      }
    }
  };
  let server;
  try {
    server = lan ? createHttpsServer(options.lanTls!, handler) : createServer(handler);
  } catch (error) {
    await instanceLock?.release();
    throw error;
  }
  server.headersTimeout = 5000;
  // Handoff STL uploads are bounded at 64 MiB and need longer than the small
  // JSON routes; the route body reader enforces its own matching timeout.
  // Scan uploads (tens of MB over Wi-Fi) and printer runs need longer than plain API calls.
  server.requestTimeout = printHandoffRoutes || objectRoutes ? 120000 : 5000;
  server.maxRequestsPerSocket = 1;
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, lanUrl?.hostname ?? '127.0.0.1', () => {
        server.off('error', reject);
        resolve();
      });
    });
  } catch (error) {
    await instanceLock?.release();
    throw error;
  }
  const address = server.address();
  if (!address || typeof address === 'string') {
    await instanceLock?.release();
    throw new Error('Local listener has no address');
  }
  authority = `127.0.0.1:${address.port}`;
  let closing: Promise<void> | undefined;
  // Extra addresses are best effort: a bind that fails is retried at the next look,
  // and an address that disappears loses its listener.
  let stopping = false;
  let syncing: Promise<void> | undefined;
  const closeExtra = (extra: ReturnType<typeof createHttpsServer>) => new Promise<void>(resolve => {
    extra.close(() => resolve());
    extra.closeAllConnections();
  });
  const syncExtras = async () => {
    if (!options.lanAddresses || stopping) return;
    try {
      found = options.lanAddresses();
    } catch {
      return;
    }
    const wanted = new Set([...found.lan, ...found.tailscale].filter(a => a !== lanUrl!.hostname && bindable(a)));
    for (const [address, extra] of [...extras])
      if (!wanted.has(address)) {
        extras.delete(address);
        await closeExtra(extra);
      }
    for (const address of wanted) {
      if (stopping) return;
      if (extras.has(address)) continue;
      const extra = createHttpsServer(options.lanTls!, handler);
      extra.headersTimeout = server.headersTimeout;
      extra.requestTimeout = server.requestTimeout;
      extra.maxRequestsPerSocket = 1;
      const bound = await new Promise<boolean>(resolve => {
        // A failed bind is retried at the next look; a later error must never crash the companion.
        extra.on('error', () => resolve(false));
        extra.listen(port, address, () => resolve(true));
      });
      if (!bound) continue;
      if (stopping) {
        await closeExtra(extra);
        return;
      }
      extras.set(address, extra);
    }
  };
  // One look at a time: a tick that arrives while one runs waits for it instead.
  const sync = () => (syncing ??= syncExtras().finally(() => { syncing = undefined; }));
  await sync();
  const timer = options.lanAddresses ? setInterval(() => void sync(), options.rediscoverMs ?? 30_000) : undefined;
  timer?.unref();
  // Advertised only once every listener is up, and withdrawn first on close.
  const advert: Advert | undefined = options.nearby
    ? (options.nearby.advertise ?? advertise)({ name: macName!, port, txt: { v: '1', k: publicKeySha256! } })
    : undefined;
  return {
    url: lan ? auth!.baseUrl : `http://${authority}`,
    ...(lan ? { publicKeySha256 } : {}),
    addresses,
    addressList: () => {
      if (!lan) return [];
      const live = (list: string[]) => list.filter(a => extras.has(a));
      const all = [
        ...[lanUrl!.hostname, ...live(found.lan)].map(host => ({ kind: 'lan' as const, host })),
        ...(options.localName ? [{ kind: 'mdns' as const, host: options.localName }] : []),
        ...live(found.tailscale).map(host => ({ kind: 'tailscale' as const, host })),
      ];
      return all.filter((entry, index) => all.findIndex(other => other.host.toLowerCase() === entry.host.toLowerCase()) === index)
        .slice(0, 8).map(entry => ({ ...entry, port }));
    },
    ...(nearby ? { nearby: { pending: () => nearby.pending(), answer: (id: string, allow: boolean) => nearby.answer(id, allow) } } : {}),
    close() {
      if (!closing)
        closing = (async () => {
          stopping = true;
          if (timer) clearInterval(timer);
          nearby?.close();
          await advert?.close();
          // No listener outlives close(): a look in progress finishes first, then every extra closes.
          await syncing;
          await Promise.all([...extras.values()].map(closeExtra));
          extras.clear();
          const stopped = new Promise<void>((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve()))
          );
          const capturesStopped=captureRoutes?.close();
          const handoffStopped=printHandoffRoutes?.close();
          // Object touch-ups and prints stop before the server's resources go.
          const objectsStopped=options.objects?.close();
          server.closeAllConnections();
          await stopped;
          await capturesStopped;
          await handoffStopped;
          await objectsStopped;
          await instanceLock?.release();
        })();
      return closing;
    },
  };
}
