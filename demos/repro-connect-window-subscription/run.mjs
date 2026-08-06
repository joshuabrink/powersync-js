// Runs the repro in a real browser and prints the two sets that have to agree: the tab's set and
// the shared worker's set.
//
//   node run.mjs                                       all four arms
//   node run.mjs during-connect during-connect-fixed   only these arms
//   node run.mjs during-connect --head                 with a visible browser
//
// The arms differ in exactly two ways: whether the SDK is patched, and when the unsubscribe
// happens. The two control arms show that the unsubscribe itself is fine — it is only losing its
// race with connect() that breaks it.
import { rm, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { apply, revert } from './fix/apply.mjs';

const PORT = Number(process.env.REPRO_PORT ?? 5273);
const BASE = `http://localhost:${PORT}`;

// `name` selects an arm on the command line; `label` is what the summary prints. The last two arms
// are the same arm run against the two SDKs, so they share a label.
const ARMS = [
  // name                    label             patched  when      what it shows
  { name: 'no-unsubscribe', label: 'no-unsubscribe', patched: false, when: 'never', expect: 'agree' },
  { name: 'after-connect', label: 'after-connect', patched: false, when: 'after', expect: 'agree' },
  { name: 'during-connect', label: 'during-connect', patched: false, when: 'window', expect: 'diverge' },
  { name: 'during-connect-fixed', label: 'during-connect', patched: true, when: 'window', expect: 'agree' }
];

const argv = process.argv.slice(2);
const headed = argv.includes('--head');
const picked = argv.filter((a) => !a.startsWith('--'));
const toRun = picked.length ? ARMS.filter((a) => picked.includes(a.name)) : ARMS;

async function startVite() {
  // The patch changes files inside node_modules, so vite must not serve a cached copy of them.
  await rm(new URL('node_modules/.vite', import.meta.url), { recursive: true, force: true }).catch(() => {});
  const server = await createServer({ configFile: new URL('vite.config.mjs', import.meta.url).pathname });
  try {
    await server.listen();
  } catch (e) {
    throw new Error(`could not take port ${PORT} (${e.code ?? e.message}). Something else is on it — either free it, or re-run with REPRO_PORT=<other port>.`);
  }
  return server;
}

async function runArm(arm) {
  if (arm.patched) await apply();
  else await revert();

  const vite = await startVite();
  let browser;
  try {
    browser = await chromium.launch({ headless: !headed });
    const page = await (await browser.newContext()).newPage();
    const console_ = [];
    page.on('console', (m) => console_.push(`${m.type()}: ${m.text()}`));
    page.on('pageerror', (e) => console_.push(`pageerror: ${e.message}`));

    await page.request.get(`${BASE}/powersync/__reset`);
    await page.goto(`${BASE}/?when=${arm.when}`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction('window.__repro?.done === true', null, { timeout: 60000 });
    const report = await page.evaluate('window.__repro');
    const requests = await (await page.request.get(`${BASE}/powersync/__requests`)).json();
    return {
      arm: arm.name,
      label: arm.label,
      when: arm.when,
      patched: arm.patched,
      expect: arm.expect,
      report,
      requests,
      console: console_
    };
  } finally {
    await browser?.close();
    await vite.close();
  }
}

function summarise(run) {
  const { arm, label, when, patched, expect, report, requests } = run;
  const sort = (a) => [...a].sort();

  // The evidence. `Collected stream subscriptions` is logged by SharedSyncImplementation, inside the
  // shared worker: it is the worker's set — the subscriptions merged across every tab's port,
  // recomputed whenever a tab reports its own. A tab reports through setParams(), which is how
  // connect() hands over its snapshot, and through updateSubscriptions() after that. The last such
  // line is therefore the set the worker was left with, and it has to match the tab's set. This is
  // pure SDK control flow, so it is the same in every run. Only one tab runs here, so the merged set
  // is just this tab's.
  const workerSets = (report.sdkLog ?? [])
    .filter((l) => l.includes('Collected stream subscriptions'))
    .map((l) => {
      // The line is "<ms>  [<level>] Collected stream subscriptions, [{"name":...}]" — take the
      // array after the message, not the log level's own brackets.
      const json = l.slice(l.indexOf('[', l.indexOf('Collected stream subscriptions')));
      try {
        return JSON.parse(json).map((s) => s.name);
      } catch {
        throw new Error(`could not read the worker's set from: ${l}`);
      }
    });
  const workerSet = sort(workerSets.at(-1) ?? []);
  const tabSet = sort(report.tabSet ?? []);
  const agrees = workerSet.join(',') === tabSet.join(',');

  console.log(`\n=================== arm: ${arm} ===================`);
  console.log(`SDK ${patched ? 'patched' : 'unpatched'}; unsubscribe ${when}`);
  if (report.error) console.log(`ERROR: ${report.error}`);
  console.log(`change made inside the connect window: ${report.windowHit}`);
  console.log(`sets the worker resolved (${workerSets.length}):`);
  for (const s of workerSets) console.log(`    [${sort(s).join(', ')}]`);
  console.log(`  the worker's set (last): [${workerSet.join(', ')}]`);
  console.log(`  the tab's set:           [${tabSet.join(', ')}]`);

  // Corroboration: the streams actually requested on the wire. The exact bytes vary between runs —
  // these streams use ttl: 0, so whether an already-expired subscription survives into the request
  // body depends on where the core is in its own bookkeeping. The comparison above does not.
  console.log(`requested streams, per sync request the SDK sent (${requests.length}):`);
  for (const r of requests) console.log(`    +${r.at}ms  streams=[${r.streams.join(', ')}]`);
  const start = (report.sdkLog ?? []).find((l) => l.includes('powersync_control(start'));
  const activeStreams = start?.match(/"active_streams":(\[.*?\])(?=,"include_defaults")/)?.[1];
  if (activeStreams) console.log(`  active_streams the sync core was started with: ${activeStreams}`);

  const verdict = agrees ? 'the tab and the worker agree' : 'DIVERGED — the worker was never told about the change';
  const asExpected = agrees === (expect === 'agree');
  console.log(`VERDICT: ${verdict}${asExpected ? '' : '   <-- NOT what this arm should show'}`);
  return {
    arm,
    label,
    patched,
    agrees,
    asExpected,
    workerSet,
    tabSet,
    windowHit: report.windowHit,
    short: agrees ? 'agree' : 'DIVERGED'
  };
}

const results = [];
const raw = [];
for (const arm of toRun) {
  const run = await runArm(arm);
  raw.push(run);
  results.push(summarise(run));
}
await revert();
await writeFile(new URL('last-run.json', import.meta.url), JSON.stringify(raw, null, 2));

console.log('\n=================== summary ===================');
for (const r of results)
  console.log(
    '  ' +
      r.label.padEnd(18) +
      (r.patched ? 'patched' : 'unpatched').padEnd(11) +
      `worker=[${r.workerSet.join(', ')}]`.padEnd(29) +
      `tab=[${r.tabSet.join(', ')}]`.padEnd(26) +
      r.short
  );

if (toRun.length === ARMS.length) {
  // windowHit is checked here rather than printed: it confirms the unpatched during-connect arm
  // really had no sync implementation yet, which is what makes that row evidence rather than noise.
  const ok = results.every((r) => r.asExpected) && results.find((r) => r.arm === 'during-connect')?.windowHit;
  console.log(
    ok
      ? '\nRepro confirmed: the same unsubscribe is lost only when it races connect(), and the patch fixes it.'
      : '\nInconclusive — see the arms marked above.'
  );
  process.exitCode = ok ? 0 : 1;
}

// Chromium and vite both leave handles behind that keep the event loop alive; without this the
// process lingers and the next run cannot take port 5273.
process.exit(process.exitCode ?? 0);
