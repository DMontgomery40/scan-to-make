declare namespace Cloudflare {
  interface Env {
    LIMITER: DurableObjectNamespace<import("../src/limiter").RelayLimiter>;
    APNS_KEY_P8?: string;
    APNS_KEY_ID?: string;
    TEAM_ID?: string;
    GLOBAL_DAILY_CAP?: number | string;
    APNS_ORIGIN?: string;
    /** SPKI PEM of the test key in vitest.config.ts. */
    TEST_APNS_PUBLIC_KEY: string;
  }
  interface Exports {
    default: Fetcher;
  }
}
