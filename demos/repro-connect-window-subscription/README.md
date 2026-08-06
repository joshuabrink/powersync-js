# A sync stream subscription change made inside the connect window is lost

A subscription change made while `connect()` is still creating the sync implementation is discarded,
and nothing retries it. The tab's set and the worker's set stay diverged until the subscription set
changes again or the connection restarts.

## The connect window

`ConnectionManager.connectInternal()` (`@powersync/shared-internals`):

```
connect()                   snapshots this.activeStreams ......................... (1)
                            await createSyncImplementation(...)
                              — an exclusive lock, a navigator lock and two round
                                trips to the shared worker: several milliseconds

subscription set changes    subscriptionsMayHaveChanged() runs. Its whole body is
                              this.syncStreamImplementation?.updateSubscriptions(...)
                            syncStreamImplementation is still null, so `?.`
                            silently swallows the update ......................... (2)

implementation assigned     setParams() reports the snapshot taken at (1) ........ (3)
```

The change is lost twice over: it is not in the snapshot at (1), and the one update that would have
carried it hit a null at (2).

## Running it

```bash
pnpm install
pnpm setup                            # the Chromium playwright drives
node run.mjs                          # all four arms
node run.mjs during-connect --head    # one arm, visible browser
```

`run.mjs` drives a headless Chromium through each arm and exits non-zero if any arm did not behave as
it should. It serves on port 5273 — set `REPRO_PORT` if that is taken. The full capture, including the
SDK's trace log, lands in `last-run.json` (gitignored).

```
  no-unsubscribe    unpatched  worker=[stream_a, stream_b]  tab=[stream_a, stream_b]  agree
  after-connect     unpatched  worker=[stream_a]            tab=[stream_a]            agree
  during-connect    unpatched  worker=[stream_a, stream_b]  tab=[stream_a]            DIVERGED
  during-connect    patched    worker=[stream_a]            tab=[stream_a]            agree
```

The first two arms are controls: the same unsubscribe on the same SDK is handled correctly whenever it
misses the window. The last two are one arm run against the unpatched and the patched SDK.

## What it does

`src/main.js` is ~40 lines of public API — the SDK is not monkeypatched. It subscribes to `stream_a`
and `stream_b` with `ttl: 0`, calls `db.connect()` without awaiting it, and unsubscribes `stream_b`.
The change is an unsubscribe because `handle.unsubscribe()` is fully synchronous, so it hits the window
on every run; `subscribe()` awaits a write first and is a coin flip. The lost update is the same one
either way. `ttl: 0` matters: with a TTL an unsubscribed stream is *meant* to keep syncing until it
expires. `vite.config.mjs` holds a stand-in for the PowerSync Service — the request body is built by
the client from its own state, so no real Service or data is needed to show this.

The verdict comes from `Collected stream subscriptions`, logged by `SharedSyncImplementation` inside
the worker: the last one is the set the worker was left with, and it has to match the tab's set. The
arms also print the streams requested on the wire, but do not read those as an expectation — `ttl: 0`
subscriptions may already be expired when a request is built, and every arm has been seen sending
`streams=[]`. `SyncStatus.syncStreams` is not a signal either; it lists both streams in every arm,
patched included.

## The unit tests

The same window, without a browser, against this repo's own sources:

```bash
cd ../../packages/shared-internals && pnpm vitest run tests/client/ConnectionManager.test.ts
```

Four of the five fail without the fix. The one that passes either way asserts no update is sent when
nothing changed.

## The fix

In `packages/shared-internals` on this branch; `fix/apply.mjs` applies the same edit to the compiled
copy in `node_modules` so the patched arm runs against the installed 2.1.1.

It keeps the snapshot. What changes is the dropped update: `connectInternal()` notes the identity of
the set it read at (1) and sends the current set once the implementation is ready if it changed. That
also covers a smaller second window — `syncStreamImplementation` is assigned *before* `waitForReady()`
resolves, and `SharedWebStreamingSyncImplementation.updateSubscriptions` forwards straight over Comlink
without awaiting readiness, unlike its sibling methods.

Only a set that actually changed sends an update, which is what keeps the shared worker safe:
`SharedSyncImplementation` holds the merged cross-tab set while its own `ConnectionManager.activeStreams`
stays empty, so an unconditional send from there overwrites the merged set with `[]` — an earlier
unguarded version of this patch did exactly that. Treat it as a demonstration that the diagnosis is
right rather than the final upstream shape.
