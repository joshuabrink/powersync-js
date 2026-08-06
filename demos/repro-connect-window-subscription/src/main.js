import { column, LogLevels, PowerSyncDatabase, Schema, Table } from '@powersync/web';

// ---------------------------------------------------------------------------------------------
// Minimal repro: a sync stream subscription change made inside the connect window is thrown away,
// and nothing ever sends it.
//
// ConnectionManager.connectInternal() opens the connect window:
//
//   connect()                    -> after a few microtasks, snapshots `this.activeStreams` .... (1)
//                                -> await createSyncImplementation(...)   [several milliseconds:
//                                   an exclusive lock, a navigator lock, and two round trips to
//                                   the shared worker]
//   subscription set changes     -> subscriptionsMayHaveChanged() runs, and it is only
//                                   `this.syncStreamImplementation?.updateSubscriptions(...)`.
//                                   `syncStreamImplementation` is still null, so the `?.`
//                                   silently swallows the update ............................. (2)
//   implementation assigned      -> setParams() reports the snapshot from (1) ................ (3)
//
// The change is lost twice over: it is not in the snapshot, and the one update that would have
// carried it hit a null. There is no retry, so the tab's set and the worker's set diverge until
// something else changes the subscription set or the connection restarts.
//
// The change used here is an unsubscribe, because `handle.unsubscribe()` is fully synchronous —
// it reaches subscriptionsMayHaveChanged() with no awaits in between, so the window is hit every
// run instead of some of the time. The lost update is the same one either way: when the change is a
// subscribe, the symptom is a stream that reports as subscribed and never syncs; when it is an
// unsubscribe, the symptom is a stream that keeps syncing after nothing is subscribed to it.
//
// Every read below is public API. The SDK is not monkeypatched.
//
// ?when= chooses when the subscription set changes, which is the only difference between the arms:
//   window (default)  inside the connect window
//   after             once connect() has resolved — the same call, outside the window
//   never             no change at all
// ---------------------------------------------------------------------------------------------

const WHEN = new URLSearchParams(location.search).get('when') ?? 'window';

const logEl = document.getElementById('log');
const verdictEl = document.getElementById('verdict');
const t0 = performance.now();
const now = () => Math.round(performance.now() - t0);

const report = {
  events: [],
  timings: {},
  statusSamples: [],
  sdkLog: [],
  windowHit: null,
  done: false,
  error: null
};
window.__repro = report;

// Records the SDK's own logs, including the ones the shared worker broadcasts to this tab. The
// interesting lines are "Collected stream subscriptions" and the powersync_control payloads.
const logger = {
  minLevel: LogLevels.trace,
  log(record) {
    report.sdkLog.push(`${String(now()).padStart(6)}ms  [${record.level}] ${record.message}`);
  }
};

function log(message) {
  const line = `${String(now()).padStart(6)}ms  ${message}`;
  report.events.push(line);
  logEl.textContent += line + '\n';
  console.log('[repro]', line);
}

const schema = new Schema({
  items: new Table({ content: column.text, thread_id: column.text })
});

const connector = {
  fetchCredentials: async () => ({
    endpoint: `${location.origin}/powersync`,
    // The SDK does not inspect the token, and the stand-in Service does not check it.
    token: 'stand-in-token'
  }),
  uploadData: async () => {}
};

async function main() {
  const db = new PowerSyncDatabase({
    schema,
    database: { dbFilename: `repro-${Date.now()}.db` },
    logger,
    sync: { logLevel: LogLevels.trace }
  });
  window.db = db;

  await db.init();
  log('database open');

  // 1. Two streams, both subscribed while offline. `ttl: 0` means "keep this stream only while
  //    something is actively subscribed to it" — the setting a `useSyncStream`-style hook uses so
  //    that streams stop syncing when the component unmounts. It matters here because with a
  //    non-zero TTL an unsubscribed stream is meant to keep syncing until it expires, so there
  //    would be nothing to observe.
  const a = await db.syncStream('stream_a', { id: 'a' }).subscribe({ ttl: 0 });
  const b = await db.syncStream('stream_b', { id: 'b' }).subscribe({ ttl: 0 });
  log('subscribed stream_a and stream_b (ttl: 0)');

  // 2. Start connecting. Not awaited — the same thing every app does at startup.
  const connected = db.connect(connector).then(
    () => log('connect() resolved'),
    (e) => log(`connect() rejected: ${e.message}`)
  );
  report.timings.connectCalled = now();
  log(`connect() called (not awaited); unsubscribe timing: ${WHEN}`);

  // 3. Drop stream_b. unsubscribe() is synchronous, so subscriptionsMayHaveChanged() runs on the
  //    spot; whether it has an implementation to send the update to is the whole experiment.
  //
  //    when=window: one macrotask is enough to be past the snapshot at (1) and still well inside
  //    the window — building the sync implementation needs several more macrotasks after this.
  //    when=after: the same call once everything is up, so the update lands.
  if (WHEN === 'window') await sleep(0);
  else if (WHEN === 'after') await connected;
  report.windowHit = !db.connectionManager.syncStreamImplementation;
  log(`inside the connect window (no sync implementation yet): ${report.windowHit}`);

  if (WHEN === 'never') {
    log('leaving both streams subscribed');
  } else {
    b.unsubscribe();
    report.timings.unsubscribed = now();
    log('unsubscribed stream_b — only stream_a should be synced from here on');
  }

  // 5. Watch what the client reports for the next while. Nothing corrects the divergence.
  for (let i = 0; i < 16; i++) {
    await sleep(500);
    const status = db.currentStatus;
    report.statusSamples.push({
      at: now(),
      connected: status.connected,
      syncStreams: (status.syncStreams ?? []).map((s) => ({
        name: s.subscription.name,
        active: s.subscription.active,
        hasSynced: s.subscription.hasSynced
      }))
    });
  }

  report.tabSet = db.connectionManager.activeStreams.map((s) => s.name);
  log(`the tab's set: [${report.tabSet.join(', ')}]`);
  report.done = true;
  log('done');
  void a;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

main().catch((e) => {
  report.error = String(e?.stack ?? e);
  report.done = true;
  verdictEl.innerHTML = `<span class="bad">repro failed: ${e.message}</span>`;
  console.error(e);
});
