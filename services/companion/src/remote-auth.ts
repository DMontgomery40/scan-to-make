import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
import { constants } from 'node:fs';
import { link, lstat, mkdir, open, rename, rm } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { z } from 'zod';
import {
  DEVICE_AUTH_PROTOCOL_VERSION,
  DEVICE_CREDENTIAL_LIFETIME_MS,
  DeviceCredentialSchema,
  PHONE_SCOPES,
  RemoteScopeSchema,
  type DeviceCredential,
  type RemoteScope,
} from '@scan-to-make/contracts/device-auth';
import { formatPairingLink } from '@scan-to-make/contracts/pairing-link';
import {isLanAuthority} from './lan-transport.js';

export { PHONE_SCOPES, type RemoteScope };
const FIVE_MINUTES = 300_000;
const TOKEN_LIFETIME = DEVICE_CREDENTIAL_LIFETIME_MS;
/** Refreshing again within this window returns the current expiry without a write. */
const REFRESH_INTERVAL = 60 * 60 * 1000;
const MAX_STORE_BYTES = 128 * 1024;
const scopesSchema = z
  .array(RemoteScopeSchema)
  .min(1)
  .max(10)
  .refine((x) => new Set(x).size === x.length);
const loginSchema = z
  .string()
  .min(1)
  .max(254)
  .regex(/^[\x21-\x7e]+$/);
const hostSchema = z
  .string()
  .max(253)
  .regex(/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+ts\.net$/);
const serveConfigurationSchema = z.strictObject({
  host: hostSchema,
  allowedLogins: z
    .array(loginSchema)
    .min(1)
    .max(16)
    .refine((x) => new Set(x).size === x.length),
});
const configurationSchema = z.union([
  serveConfigurationSchema,
  z.strictObject({
    transport: z.literal('lan'), host: z.string().refine(isLanAuthority),
    allowedLogins: z.tuple([z.literal('lan')]),
    certificateSha256: z.string().regex(/^[a-f0-9]{64}$/),
  }),
]);
export type RemoteConfiguration = z.infer<typeof configurationSchema>;
const timeSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const codesSchema = z
  .array(
    z.strictObject({
      codeHash: digestSchema,
      login: loginSchema,
      scopes: scopesSchema,
      expiresAt: timeSchema,
    })
  )
  .max(8);
const attemptsSchema = z
  .array(
    z.strictObject({
      login: loginSchema,
      startedAt: timeSchema,
      count: z.number().int().min(1).max(5),
    })
  )
  .max(16);
/** Version 1: a device was bound to the login (Tailscale user or `lan`) that paired it. */
const v1StateSchema = z.strictObject({
  version: z.literal(1),
  configuration: configurationSchema,
  codes: codesSchema,
  devices: z
    .array(
      z.strictObject({
        deviceId: z.uuid(),
        deviceName: z.string().min(1).max(80),
        login: loginSchema,
        tokenHash: digestSchema,
        scopes: scopesSchema,
        expiresAt: timeSchema,
      })
    )
    .max(64),
  attempts: attemptsSchema,
});
/**
 * Version 2: a device is its id and token, whatever network path carries it.
 * `pairedVia` records how it paired, for the device list; it is not checked.
 */
const deviceSchema = z.strictObject({
  deviceId: z.uuid(),
  deviceName: z.string().min(1).max(80),
  tokenHash: digestSchema,
  scopes: scopesSchema,
  pairedAt: timeSchema,
  lastRefreshedAt: timeSchema,
  expiresAt: timeSchema,
  pairedVia: z.strictObject({
    transport: z.enum(['lan', 'tailscale']),
    login: loginSchema,
  }),
});
const stateSchema = z.strictObject({
  version: z.literal(2),
  configuration: configurationSchema,
  codes: codesSchema,
  devices: z.array(deviceSchema).max(64),
  attempts: attemptsSchema,
});
type State = z.infer<typeof stateSchema>;
const transportOf = (configuration: RemoteConfiguration) =>
  'transport' in configuration ? 'lan' as const : 'tailscale' as const;
/** Keeps every v1 device, token hash, scope and expiry; v1 always paired at expiresAt - lifetime. */
function migrateV1(state: z.infer<typeof v1StateSchema>): State {
  const transport = transportOf(state.configuration);
  return {
    version: 2,
    configuration: state.configuration,
    codes: state.codes,
    devices: state.devices.map(({ login, ...device }) => {
      const pairedAt = Math.max(0, device.expiresAt - TOKEN_LIFETIME);
      return {
        deviceId: device.deviceId,
        deviceName: device.deviceName,
        tokenHash: device.tokenHash,
        scopes: device.scopes,
        pairedAt,
        lastRefreshedAt: pairedAt,
        expiresAt: device.expiresAt,
        pairedVia: { transport, login },
      };
    }),
    attempts: state.attempts,
  };
}
const exchangeSchema = z.strictObject({
  code: z.string().regex(/^[A-Za-z0-9_-]{32}$/),
  deviceName: z
    .string()
    .trim()
    .min(1)
    .max(80)
    .regex(/^[^\x00-\x1f\x7f]+$/),
});
const hash = (secret: string) =>
  createHash('sha256').update(secret).digest('hex');
const matches = (secret: string, digest: string) =>
  timingSafeEqual(Buffer.from(hash(secret), 'hex'), Buffer.from(digest, 'hex'));

export class RemoteAuthFailure extends Error {
  readonly status: number;
  constructor(
    readonly code:
      | 'unauthorized'
      | 'forbidden'
      | 'rate-limited'
      | 'auth-unavailable'
  ) {
    super(
      {
        unauthorized: 'Pairing or credential rejected',
        forbidden: 'Remote access denied',
        'rate-limited': 'Pairing limit exceeded',
        'auth-unavailable': 'Authentication unavailable',
      }[code]
    );
    this.status = {
      unauthorized: 401,
      forbidden: 403,
      'rate-limited': 429,
      'auth-unavailable': 503,
    }[code];
  }
}

async function checkDirectory(directory: string) {
  const info = await lstat(directory);
  if (
    !isAbsolute(directory) ||
    !info.isDirectory() ||
    (info.mode & 0o777) !== 0o700 ||
    (process.getuid && info.uid !== process.getuid())
  )
    throw new Error('Private owned directory required');
}
type Stored = { state: State; v1Bytes?: Buffer };
async function readPrivate(path: string): Promise<Buffer> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await file.stat();
    if (
      !info.isFile() ||
      (info.mode & 0o777) !== 0o600 ||
      (process.getuid && info.uid !== process.getuid()) ||
      info.size > MAX_STORE_BYTES
    )
      throw new Error('Invalid private state');
    const bytes = Buffer.alloc(MAX_STORE_BYTES + 1);
    let length = 0;
    while (length < bytes.length) {
      const result = await file.read(
        bytes,
        length,
        bytes.length - length,
        null
      );
      if (!result.bytesRead) break;
      length += result.bytesRead;
    }
    if (length > MAX_STORE_BYTES) throw new Error('State limit exceeded');
    return Buffer.from(bytes.subarray(0, length));
  } finally {
    await file.close();
  }
}
async function readState(directory: string): Promise<Stored> {
  await checkDirectory(directory);
  const raw = await readPrivate(join(directory, 'auth.json'));
  const value: unknown = JSON.parse(raw.toString('utf8'));
  // Any other version, including a future one, fails closed.
  const v1 = v1StateSchema.safeParse(value);
  return v1.success
    ? { state: migrateV1(v1.data), v1Bytes: raw }
    : { state: stateSchema.parse(value) };
}
/**
 * The first write after migration keeps the exact version 1 bytes, for a rollback by hand:
 * `auth.v1.json`, or `auth.v1-<sha256 prefix>.json` when an older, different backup exists.
 * The file appears complete or not at all (fsynced temp file, then a hard link).
 */
async function backupV1(directory: string, bytes: Buffer) {
  const temp = join(directory, `.${randomUUID()}.tmp`);
  const file = await open(temp, 'wx', 0o600);
  try {
    await file.writeFile(bytes);
    await file.sync();
  } finally {
    await file.close();
  }
  try {
    for (const name of ['auth.v1.json', `auth.v1-${createHash('sha256').update(bytes).digest('hex').slice(0, 12)}.json`]) {
      try {
        await link(temp, join(directory, name));
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        if ((await readPrivate(join(directory, name))).equals(bytes)) break;
        if (name !== 'auth.v1.json') throw new Error('Conflicting version 1 backup');
      }
    }
    const dir = await open(directory, constants.O_RDONLY);
    try {
      await dir.sync();
    } finally {
      await dir.close();
    }
  } finally {
    await rm(temp, { force: true });
  }
}
async function writeState(directory: string, state: State) {
  const data = JSON.stringify(stateSchema.parse(state));
  if (Buffer.byteLength(data) > MAX_STORE_BYTES)
    throw new Error('State limit exceeded');
  const path = join(directory, `.${randomUUID()}.tmp`);
  const file = await open(path, 'wx', 0o600);
  try {
    await file.writeFile(data);
    await file.sync();
  } finally {
    await file.close();
  }
  try {
    await rename(path, join(directory, 'auth.json'));
    const dir = await open(directory, constants.O_RDONLY);
    try {
      await dir.sync();
    } finally {
      await dir.close();
    }
  } finally {
    await rm(path, { force: true });
  }
}

/** Host-local administration. Never expose these methods as HTTP administration routes. */
export class RemoteAuthStore {
  private constructor(
    readonly directory: string,
    private readonly configuration: RemoteConfiguration,
    private readonly clock: () => number
  ) {}
  get host() {
    return this.configuration.host;
  }
  get transport(): 'lan' | 'tailscale' {
    return 'transport' in this.configuration ? 'lan' : 'tailscale';
  }
  get certificateSha256(): string | undefined {
    return 'certificateSha256' in this.configuration ? this.configuration.certificateSha256 : undefined;
  }
  get baseUrl() { return `https://${this.host}`; }
  allowsLogin(login: string) {
    return this.configuration.allowedLogins.some(value => value === login);
  }
  static async create(
    directory: string,
    configuration: RemoteConfiguration,
    clock = Date.now
  ) {
    const checked = configurationSchema.parse(configuration);
    if (!isAbsolute(directory))
      throw new Error('Absolute private directory required');
    await mkdir(directory, { mode: 0o700 }); // Existing state is never replaced by init.
    await checkDirectory(directory);
    await writeState(directory, {
      version: 2,
      configuration: checked,
      codes: [],
      devices: [],
      attempts: [],
    });
    return new RemoteAuthStore(directory, checked, clock);
  }
  /**
   * Opening a version 1 store migrates it to version 2 in place, keeping the v1 bytes.
   * If the lock is busy, the next successful write migrates instead; reads work either way.
   */
  static async open(directory: string, clock = Date.now) {
    let store;
    try {
      const { state, v1Bytes } = await readState(directory);
      store = new RemoteAuthStore(directory, state.configuration, clock);
      if (!v1Bytes) return store;
    } catch {
      throw new RemoteAuthFailure('auth-unavailable');
    }
    // Every later write migrates too, so a busy lock here only defers it.
    await store.mutate(() => undefined).catch(() => undefined);
    return store;
  }
  private now() {
    return timeSchema.parse(this.clock());
  }
  private async read() {
    const stored = await readState(this.directory);
    if (
      JSON.stringify(stored.state.configuration) !== JSON.stringify(this.configuration)
    )
      throw new Error('Configuration changed; restart required');
    return stored;
  }
  private async mutate<T>(
    action: (state: State, now: number) => T
  ): Promise<T> {
    let locked = false;
    const lock = join(this.directory, '.lock');
    try {
      await checkDirectory(this.directory);
      await mkdir(lock, { mode: 0o700 });
      locked = true;
      const { state, v1Bytes } = await this.read(),
        now = this.now();
      state.codes = state.codes.filter((x) => x.expiresAt > now);
      state.devices = state.devices.filter((x) => x.expiresAt > now);
      state.attempts = state.attempts.filter((x) => now < x.startedAt + 60_000);
      const result = action(state, now);
      if (v1Bytes) await backupV1(this.directory, v1Bytes);
      await writeState(this.directory, state);
      return result;
    } catch (error) {
      if (error instanceof RemoteAuthFailure) throw error;
      throw new RemoteAuthFailure('auth-unavailable');
    } finally {
      if (locked) await rm(lock, { recursive: true });
    }
  }
  /**
   * Mints a one-time invitation. With `link`, its QR is pairing link v2 (MAC-5): every
   * address the server is bound to and its public-key pin. Otherwise version 1.
   */
  async createPairing(
    login: string,
    scopes: readonly RemoteScope[] = PHONE_SCOPES,
    link?: { addresses: string[]; publicKeySha256: string; name?: string }
  ) {
    loginSchema.parse(login);
    const checkedScopes = scopesSchema.parse(scopes);
    // A bad v2 link is the caller's error (PairingLinkError), found before the store is locked.
    if (link) formatPairingLink({ version: 2, code: 'A'.repeat(32), expiresAt: Number.MAX_SAFE_INTEGER, ...link });
    if (!this.allowsLogin(login)) throw new RemoteAuthFailure('forbidden');
    return this.mutate((state, now) => {
      if (state.codes.length >= 8 || state.devices.length >= 64)
        throw new RemoteAuthFailure('rate-limited');
      const code = randomBytes(24).toString('base64url'),
        expiresAt = now + FIVE_MINUTES;
      state.codes.push({
        codeHash: hash(code),
        login,
        scopes: checkedScopes,
        expiresAt,
      });
      const payload = {
        version: 1,
        baseUrl: this.baseUrl,
        code,
        expiresAt,
        ...(this.certificateSha256 ? {certificateSha256: this.certificateSha256} : {}),
      };
      // Version 1 unless the caller supplies the v2 address list; same bytes as before.
      const qrPayload = link
        ? formatPairingLink({ version: 2, code, expiresAt, ...link })
        : formatPairingLink({
            version: 1, baseUrl: this.baseUrl, code, expiresAt,
            ...(this.certificateSha256 ? { certificateSha256: this.certificateSha256 } : {}),
          });
      return { ...payload, qrPayload };
    });
  }
  /** Host-local display check only; never grants a device credential. */
  async isPairingActive(code: string): Promise<boolean> {
    if (!/^[A-Za-z0-9_-]{32}$/.test(code)) return false;
    try {
      const { state } = await this.read();
      return state.codes.some(x => x.expiresAt > this.now() && matches(code, x.codeHash));
    } catch {
      return false;
    }
  }
  async reservePairAttempt(login: string) {
    if (!this.allowsLogin(login)) throw new RemoteAuthFailure('forbidden');
    await this.mutate((state, now) => {
      const bucket = state.attempts.find((x) => x.login === login);
      if (bucket) {
        if (bucket.count >= 5) throw new RemoteAuthFailure('rate-limited');
        bucket.count++;
      } else state.attempts.push({ login, startedAt: now, count: 1 });
    });
  }
  async exchange(login: string, input: unknown): Promise<DeviceCredential> {
    const parsed = exchangeSchema.safeParse(input);
    if (!parsed.success || !this.allowsLogin(login))
      throw new RemoteAuthFailure('unauthorized');
    return this.mutate((state, now) => {
      const index = state.codes.findIndex(
        (x) => x.login === login && matches(parsed.data.code, x.codeHash)
      );
      const code = state.codes[index];
      if (!code) throw new RemoteAuthFailure('unauthorized');
      if (state.devices.length >= 64)
        throw new RemoteAuthFailure('rate-limited');
      const token = randomBytes(32).toString('base64url'),
        deviceId = randomUUID(),
        expiresAt = now + TOKEN_LIFETIME;
      state.codes.splice(index, 1);
      state.devices.push({
        deviceId,
        deviceName: parsed.data.deviceName,
        tokenHash: hash(token),
        scopes: code.scopes,
        pairedAt: now,
        lastRefreshedAt: now,
        expiresAt,
        pairedVia: { transport: this.transport, login },
      });
      return DeviceCredentialSchema.parse({
        protocolVersion: DEVICE_AUTH_PROTOCOL_VERSION,
        deviceId,
        token,
        expiresAt,
        scopes: code.scopes,
      });
    });
  }
  /** A credential is valid only on a path whose login is allowed; device lookup ignores the path. */
  private valid(
    state: State,
    login: string,
    deviceId: string | undefined,
    token: string | undefined
  ) {
    const device = state.devices.find((x) => x.deviceId === deviceId);
    if (
      !this.allowsLogin(login) ||
      !device ||
      !token ||
      !/^[A-Za-z0-9_-]{43}$/.test(token) ||
      device.expiresAt <= this.now() ||
      !matches(token, device.tokenHash)
    )
      throw new RemoteAuthFailure('unauthorized');
    return device;
  }
  /**
   * Rolling refresh: a valid credential gets another full lifetime from now, with the
   * same token. An expired or revoked credential stays dead; pair again.
   */
  async refresh(
    login: string,
    deviceId: string | undefined,
    token: string | undefined
  ): Promise<DeviceCredential> {
    const credential = (device: State['devices'][number]) =>
      DeviceCredentialSchema.parse({
        protocolVersion: DEVICE_AUTH_PROTOCOL_VERSION,
        deviceId: device.deviceId,
        token,
        expiresAt: device.expiresAt,
        scopes: device.scopes,
      });
    // Validate without the lock first, so bad or repeated requests never contend for it.
    try {
      const { state } = await this.read();
      const device = this.valid(state, login, deviceId, token);
      if (this.now() - device.lastRefreshedAt < REFRESH_INTERVAL) return credential(device);
    } catch (error) {
      if (error instanceof RemoteAuthFailure) throw error;
      throw new RemoteAuthFailure('auth-unavailable');
    }
    return this.mutate((state, now) => {
      const device = this.valid(state, login, deviceId, token);
      device.lastRefreshedAt = now;
      device.expiresAt = now + TOKEN_LIFETIME;
      return credential(device);
    });
  }
  async authorize(
    login: string,
    deviceId: string | undefined,
    token: string | undefined,
    scope: RemoteScope
  ) {
    try {
      const { state } = await this.read();
      const device = this.valid(state, login, deviceId, token);
      if (!device.scopes.includes(scope))
        throw new RemoteAuthFailure('forbidden');
    } catch (error) {
      if (error instanceof RemoteAuthFailure) throw error;
      throw new RemoteAuthFailure('auth-unavailable');
    }
  }
  async listDevices() {
    return this.mutate((state) =>
      state.devices.map(({ tokenHash: _secret, ...device }) => device)
    );
  }
  async revoke(deviceId: string) {
    z.uuid().parse(deviceId);
    await this.mutate((state) => {
      state.devices = state.devices.filter((x) => x.deviceId !== deviceId);
    });
  }
}
