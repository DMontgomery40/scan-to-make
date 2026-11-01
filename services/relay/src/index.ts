// Counterpart Live Activity relay Worker (PRD §8.8). See README.md and docs.md.

import type { Env } from "./env";
import { handleRelay } from "./relay";

export { RelayLimiter } from "./limiter";

export default {
  fetch(request, env) {
    return handleRelay(request, env, { fetch: (input, init) => fetch(input, init), now: () => Date.now() });
  },
} satisfies ExportedHandler<Env>;
