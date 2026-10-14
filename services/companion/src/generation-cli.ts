import { startGenerationServer } from './generation.js';

const server = await startGenerationServer({
  port:
    process.env.SCAN_TO_MAKE_GENERATION_PORT === undefined
      ? 9077
      : Number(process.env.SCAN_TO_MAKE_GENERATION_PORT),
});
process.stdout.write(`Local generation ready at ${server.url}\n`);
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.once(signal, () => {
    void server.close().catch(() => {
      process.exitCode = 1;
    });
  });
