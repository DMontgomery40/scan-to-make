import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, rename, rm } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { z } from 'zod';

const FIVE_MINUTES = 300_000;
const TOKEN_LIFETIME = 30 * 24 * 60 * 60 * 1000;
const MAX_STORE_BYTES = 128 * 1024;
const scopeSchema = z.enum(['generation:health', 'generation:create', 'projects:read', 'projects:write', 'captures:read', 'captures:import', 'prepared-jobs:read', 'prepared-jobs:prepare', 'prints:approve', 'printer-handoff:use']);
export type RemoteScope = z.infer<typeof scopeSchema>;
const scopesSchema = z
  .array(scopeSchema)
  .min(1)
  .max(9)
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
const configurationSchema = z.strictObject({
  host: hostSchema,
  allowedLogins: z
    .array(loginSchema)
    .min(1)
    .max(16)
    .refine((x) => new Set(x).size === x.length),
});
export type RemoteConfiguration = z.infer<typeof configurationSchema>;
const timeSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const deviceSchema = z.strictObject({
  deviceId: z.uuid(),
  deviceName: z.string().min(1).max(80),
  login: loginSchema,
  tokenHash: digestSchema,
  scopes: scopesSchema,
  expiresAt: timeSchema,
});
const stateSchema = z.strictObject({
  version: z.literal(1),
  configuration: configurationSchema,
  codes: z
    .array(
      z.strictObject({
        codeHash: digestSchema,
        login: loginSchema,
        scopes: scopesSchema,
        expiresAt: timeSchema,
      })
    )
    .max(8),
  devices: z.array(deviceSchema).max(64),
  attempts: z
    .array(
      z.strictObject({
        login: loginSchema,
        startedAt: timeSchema,
        count: z.number().int().min(1).max(5),
      })
    )
    .max(16),
});
type State = z.infer<typeof stateSchema>;
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
async function readState(directory: string): Promise<State> {
  await checkDirectory(directory);
  const file = await open(
    join(directory, 'auth.json'),
    constants.O_RDONLY | constants.O_NOFOLLOW
  );
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
    return stateSchema.parse(
      JSON.parse(bytes.subarray(0, length).toString('utf8'))
    );
  } finally {
    await file.close();
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
  allowsLogin(login: string) {
    return this.configuration.allowedLogins.includes(login);
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
      version: 1,
      configuration: checked,
      codes: [],
      devices: [],
      attempts: [],
    });
    return new RemoteAuthStore(directory, checked, clock);
  }
  static async open(directory: string, clock = Date.now) {
    try {
      const state = await readState(directory);
      return new RemoteAuthStore(directory, state.configuration, clock);
    } catch {
      throw new RemoteAuthFailure('auth-unavailable');
    }
  }
  private now() {
    return timeSchema.parse(this.clock());
  }
  private async read() {
    const state = await readState(this.directory);
    if (
      JSON.stringify(state.configuration) !== JSON.stringify(this.configuration)
    )
      throw new Error('Configuration changed; restart required');
    return state;
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
      const state = await this.read(),
        now = this.now();
      state.codes = state.codes.filter((x) => x.expiresAt > now);
      state.devices = state.devices.filter((x) => x.expiresAt > now);
      state.attempts = state.attempts.filter((x) => now < x.startedAt + 60_000);
      const result = action(state, now);
      await writeState(this.directory, state);
      return result;
    } catch (error) {
      if (error instanceof RemoteAuthFailure) throw error;
      throw new RemoteAuthFailure('auth-unavailable');
    } finally {
      if (locked) await rm(lock, { recursive: true });
    }
  }
  async createPairing(
    login: string,
    scopes: RemoteScope[] = ['generation:health', 'generation:create']
  ) {
    loginSchema.parse(login);
    const checkedScopes = scopesSchema.parse(scopes);
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
        baseUrl: `https://${this.host}`,
        code,
        expiresAt,
      };
      return { ...payload, qrPayload: JSON.stringify(payload) };
    });
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
  async exchange(login: string, input: unknown) {
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
        login,
        tokenHash: hash(token),
        scopes: code.scopes,
        expiresAt,
      });
      return {
        protocolVersion: '0.1.0',
        deviceId,
        token,
        expiresAt,
        scopes: code.scopes,
      };
    });
  }
  async authorize(
    login: string,
    deviceId: string | undefined,
    token: string | undefined,
    scope: RemoteScope
  ) {
    try {
      const state = await this.read();
      const device = state.devices.find(
        (x) => x.deviceId === deviceId && x.login === login
      );
      if (
        !this.allowsLogin(login) ||
        !device ||
        !token ||
        !/^[A-Za-z0-9_-]{43}$/.test(token) ||
        device.expiresAt <= this.now() ||
        !matches(token, device.tokenHash)
      )
        throw new RemoteAuthFailure('unauthorized');
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
