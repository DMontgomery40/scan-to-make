import { generateKeyPairSync } from "node:crypto";
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// A throwaway P-256 key stands in for the APNs .p8 key; tests verify signatures with its public half.
const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          APNS_KEY_P8: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
          APNS_KEY_ID: "TESTKEY123",
          TEAM_ID: "X7F5F9LR24",
          TEST_APNS_PUBLIC_KEY: publicKey.export({ type: "spki", format: "pem" }).toString(),
        },
      },
    }),
  ],
});
