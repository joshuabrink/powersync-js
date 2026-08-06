// Scratch driver: open the page once and stream the console out, to see where it stops. It does not
// touch the patch — apply or revert it yourself with fix/apply.mjs first.
//
//   node debug.mjs [window|after|never]
import { chromium } from 'playwright';
import { createServer } from 'vite';

const when = process.argv[2] ?? 'window';
const BASE = `http://localhost:${Number(process.env.REPRO_PORT ?? 5273)}`;

const server = await createServer({ configFile: new URL('vite.config.mjs', import.meta.url).pathname });
await server.listen();
const browser = await chromium.launch({ headless: true });
const page = await (await browser.newContext()).newPage();
page.on('console', (m) => console.log(`[page ${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => console.log(`[pageerror] ${e.stack ?? e.message}`));
page.on('requestfailed', (r) => console.log(`[requestfailed] ${r.url()} ${r.failure()?.errorText}`));
await page.goto(`${BASE}/?when=${when}`, { waitUntil: 'domcontentloaded' });
for (let i = 0; i < 20; i++) {
  await new Promise((r) => setTimeout(r, 1000));
  const state = await page.evaluate(() => ({
    done: window.__repro?.done,
    events: window.__repro?.events?.length,
    error: window.__repro?.error
  }));
  console.log(`t+${i + 1}s`, JSON.stringify(state));
  if (state.done) break;
}
const report = await page.evaluate('window.__repro');
console.log('--- events ---');
console.log(report.events.join('\n'));
console.log('--- sdk log (subscription + control lines) ---');
console.log(
  report.sdkLog
    .filter((l) => /subscription|Collected|powersync_control|UpdateSubscriptions|update_subscriptions/i.test(l))
    .join('\n')
);
console.log('--- requests ---');
for (const r of await (await page.request.get(`${BASE}/powersync/__requests`)).json()) {
  console.log(`+${r.at}ms  [${r.streams.join(', ')}]`);
}
await browser.close();
await server.close();
process.exit(0);
