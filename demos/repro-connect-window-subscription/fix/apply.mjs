// Applies the candidate fix to the installed SDK, and reverts it again.
//
//   node fix/apply.mjs apply
//   node fix/apply.mjs revert
//
// `ConnectionManager.connectInternal()` snapshots `this.activeStreams` before it awaits the
// creation of the sync implementation, and `subscriptionsMayHaveChanged()` is a no-op while
// `this.syncStreamImplementation` is still null. A subscribe() that lands in that connect window is
// lost twice over: it is not in the snapshot, and nothing re-sends it.
//
// The fix notes the identity of the set that was read, and sends the current set once the
// implementation is ready if it changed. Comparing is what keeps the shared worker safe: nothing
// subscribes on its own ConnectionManager, so its set never changes and no update is sent from here.
//
// See fix/fix.patch for the same edit against the SDK sources.
import { copyFile, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';

const SUFFIX = 'lib/client/ConnectionManager.js';

// @powersync/shared-internals is a transitive dependency of @powersync/web, so where it lands
// depends on the package manager. npm and yarn hoist it to the top of node_modules; pnpm leaves it
// under .pnpm and only links what was directly depended on. Look in both rather than assuming.
async function findTarget() {
  const hoisted = new URL(`../node_modules/@powersync/shared-internals/${SUFFIX}`, import.meta.url);
  if (await exists(hoisted)) return hoisted;

  const store = new URL('../node_modules/.pnpm/', import.meta.url);
  const entries = (await readdir(store).catch(() => [])).filter((d) => d.startsWith('@powersync+shared-internals@'));
  const found = [];
  for (const entry of entries) {
    const candidate = new URL(`${entry}/node_modules/@powersync/shared-internals/${SUFFIX}`, store);
    if (await exists(candidate)) found.push(candidate);
  }
  if (found.length > 1) {
    throw new Error(`more than one @powersync/shared-internals is installed, so patching one proves nothing:\n  ${found.map((u) => u.pathname).join('\n  ')}`);
  }
  if (!found.length) throw new Error('could not find @powersync/shared-internals — run `pnpm install` first');
  return found[0];
}

const TARGET = await findTarget();
const BACKUP = new URL(`${TARGET.href}.orig`);

// pnpm may hardlink a package's files straight from its global store, so writing to one in place
// would edit every project on the machine that shares it. Always replace the file, never truncate.
async function replace(target, contents) {
  await rm(target, { force: true });
  await writeFile(target, contents);
}

// Note what the set looked like before it is read below, so a change made from here until the
// implementation is ready can be noticed.
const FROM_SNAPSHOT = `                this.pendingConnectionOptions = null;`;
const TO_SNAPSHOT = `                this.pendingConnectionOptions = null;
                const subscriptionsAtStart = this.subscriptionIdentity;`;

// Do not drop the change on the `?.`. The syncStreamInitPromise check also covers the rest of the
// connect: an implementation that exists but is not ready yet can still drop the update one layer
// down. Either way connectInternal() sends the current set once it is ready.
const FROM_GUARD = `    subscriptionsMayHaveChanged() {
        this.syncStreamImplementation?.updateSubscriptions(this.activeStreams);
    }`;
const TO_GUARD = `    get subscriptionIdentity() {
        return [...this.locallyActiveSubscriptions.keys()].join('\\n');
    }
    subscriptionsMayHaveChanged() {
        // FIX: nothing to send to yet, or an implementation that is still coming up.
        if (this.syncStreamInitPromise) {
            return;
        }
        this.syncStreamImplementation?.updateSubscriptions(this.activeStreams);
    }`;

// The update itself. It only fires if the set actually changed on this ConnectionManager, which is
// what keeps the shared worker's merged cross-tab set from being overwritten with [].
const FROM_UPDATE = `                await this.syncStreamImplementation.waitForReady();
                resolve();`;
const TO_UPDATE = `                await this.syncStreamImplementation.waitForReady();
                // FIX: a subscribe() or unsubscribe() landed while the implementation was being
                // created. It is missing from the set read above, and its own update had nothing to
                // reach, so send the current set now.
                if (this.subscriptionIdentity !== subscriptionsAtStart) {
                    this.syncStreamImplementation.updateSubscriptions(this.activeStreams);
                }
                resolve();`;

async function exists(url) {
  try {
    await stat(url);
    return true;
  } catch {
    return false;
  }
}

export async function apply() {
  if (!(await exists(BACKUP))) await copyFile(TARGET, BACKUP);
  let source = await readFile(BACKUP, 'utf8');
  for (const [from, to] of [
    [FROM_SNAPSHOT, TO_SNAPSHOT],
    [FROM_GUARD, TO_GUARD],
    [FROM_UPDATE, TO_UPDATE]
  ]) {
    if (!source.includes(from)) throw new Error(`patch target not found:\n${from}`);
    source = source.replace(from, to);
  }
  await replace(TARGET, source);
  return 'applied';
}

export async function revert() {
  if (await exists(BACKUP)) await replace(TARGET, await readFile(BACKUP));
  return 'reverted';
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const command = process.argv[2];
  if (command === 'apply') console.log(await apply());
  else if (command === 'revert') console.log(await revert());
  else {
    console.error('usage: node fix/apply.mjs apply|revert');
    process.exitCode = 1;
  }
}
