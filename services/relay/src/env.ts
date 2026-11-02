import type { RelayLimiter } from "./limiter";

export interface Env {
  LIMITER: DurableObjectNamespace<RelayLimiter>;
  /** Secret: the .p8 auth key file from the Apple developer portal. */
  APNS_KEY_P8?: string;
  /** Secret: the key's 10-character Key ID. */
  APNS_KEY_ID?: string;
  /** Secret: the 10-character Apple Team ID (X7F5F9LR24). */
  TEAM_ID?: string;
  /** Var: pushes accepted per UTC day across all callers. */
  GLOBAL_DAILY_CAP?: number | string;
  /**
   * Var, normally unset (production APNs). `https://api.sandbox.push.apple.com` for development
   * tokens, or a loopback origin for the local smoke test.
   */
  APNS_ORIGIN?: string;
}
