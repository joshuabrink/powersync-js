import { defineConfig } from 'vite';

/**
 * A stand-in for the PowerSync Service. It does one useful thing: it records the body of every
 * POST /powersync/sync/stream, so the repro can assert on the stream list the SDK actually asked
 * for. The request body is built by the client from its own state, so this is enough to show the
 * defect without a real Service, a real Sync Config or real data.
 */
function standInPowerSyncService() {
  /** @type {{ at: number, streams: string[], raw: any }[]} */
  const requests = [];
  let startedAt = 0;

  const read = (req) =>
    new Promise((resolve) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => resolve(body));
    });

  return {
    name: 'stand-in-powersync-service',
    configureServer(server) {
      startedAt = Date.now();

      server.middlewares.use('/powersync/sync/stream', async (req, res) => {
        const raw = await read(req);
        let parsed = {};
        try {
          parsed = JSON.parse(raw);
        } catch {
          /* ignore */
        }
        // The stream list lives under `streams.subscriptions` in the v2 sync request.
        const subs = parsed?.streams?.subscriptions ?? parsed?.subscriptions ?? [];
        requests.push({
          at: Date.now() - startedAt,
          streams: subs.map((s) => `${s.stream ?? s.name}${s.parameters ? JSON.stringify(s.parameters) : ''}`),
          raw: parsed
        });

        res.writeHead(200, {
          'content-type': 'application/x-ndjson',
          'cache-control': 'no-store',
          connection: 'keep-alive'
        });
        // Enough of a response for the client to consider the stream established. We deliberately
        // send no data: the point of the repro is what the client ASKED for.
        res.write(JSON.stringify({ token_expires_in: 3600 }) + '\n');
        const keepalive = setInterval(() => {
          res.write(JSON.stringify({ token_expires_in: 3600 }) + '\n');
        }, 5000);
        req.on('close', () => clearInterval(keepalive));
      });

      // The repro reads this to see what the SDK requested.
      server.middlewares.use('/powersync/__requests', (_req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(requests));
      });

      server.middlewares.use('/powersync/__reset', (_req, res) => {
        requests.length = 0;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"ok":true}');
      });
    }
  };
}

// strictPort, so a port already in use fails loudly instead of moving the page somewhere the
// driver is not looking. Override with REPRO_PORT if 5273 is taken.
export const PORT = Number(process.env.REPRO_PORT ?? 5273);

export default defineConfig({
  plugins: [standInPowerSyncService()],
  server: { port: PORT, strictPort: true },
  optimizeDeps: { exclude: ['@journeyapps/wa-sqlite', '@powersync/web'] },
  worker: { format: 'es' }
});
