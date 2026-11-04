import { z } from 'zod';

/** Kept from the first protocol so existing phone credentials still parse. */
export const DEVICE_AUTH_PROTOCOL_VERSION = '0.1.0';
/** A credential lives this long after pairing or its last refresh; using it does not extend it. */
export const DEVICE_CREDENTIAL_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;

export const REMOTE_SCOPES = [
  'generation:health',
  'generation:create',
  'projects:read',
  'projects:write',
  'captures:read',
  'captures:import',
  'prepared-jobs:read',
  'prepared-jobs:prepare',
  'prints:approve',
  'printer-handoff:use',
  // `/v1/mcp` (docs/design/remote-mcp.md): granted only by `remote-auth-cli pair-mcp`, never to phones.
  'mcp:read',
  'mcp:design',
  'mcp:control',
  'mcp:print',
  'mcp:raw',
] as const;
export const RemoteScopeSchema = z.enum(REMOTE_SCOPES);
export type RemoteScope = z.infer<typeof RemoteScopeSchema>;

/** What pairing a phone grants by default: every route the iPhone app calls. */
export const PHONE_SCOPES = [
  'generation:health',
  'projects:read',
  'projects:write',
  'captures:read',
  'captures:import',
  'printer-handoff:use',
] as const satisfies readonly RemoteScope[];

/**
 * A device credential, as returned by `POST /v1/pair` and `POST /v1/auth/refresh`.
 * The device identity (`deviceId` + token) does not depend on the network path:
 * the same credential works over LAN, a VPN or Tailscale. The phone sends it as
 * `Authorization: Bearer <token>` with `X-Scan-Device: <deviceId>`.
 */
export const DeviceCredentialSchema = z.strictObject({
  protocolVersion: z.literal(DEVICE_AUTH_PROTOCOL_VERSION),
  deviceId: z.uuid(),
  token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  expiresAt: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  scopes: z
    .array(RemoteScopeSchema)
    .min(1)
    .max(REMOTE_SCOPES.length)
    .refine((x) => new Set(x).size === x.length),
});
export type DeviceCredential = z.infer<typeof DeviceCredentialSchema>;
