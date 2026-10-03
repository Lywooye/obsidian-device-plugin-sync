import assert from 'node:assert/strict';
import test from 'node:test';
import { inspectSync } from '../src/sync-adapter';
import profile from '../src/native-mobile-profile.json';

const audit = require('../scripts/check-mobile-native.cjs') as {
  APP_JS_SHA256: string;
  sha256(source: string): string;
  extractBundle(source: string): Bundle;
  loadBundle(path: string): Bundle;
  createContext(bundle: Bundle, overrides?: Dynamic): { context: Dynamic; prototypes: Record<string, Dynamic> };
  probeFilter(bundle: Bundle): number;
};
type Dynamic = Record<string, any>;
type Bundle = { methods: Record<string, Record<string, string>>; helpers: Record<string, string>; arrays: Record<string, string[]> };
const input = process.env.OBSIDIAN_MOBILE_APP_JS;
const skip = input ? false : 'No OBSIDIAN_MOBILE_APP_JS supplied; mobile native fixtures are not downloaded automatically.';
// Explicitly supplied but missing/changed files fail instead of silently skipping.
const bundle = input ? audit.loadBundle(input) : undefined;

test('mobile audit refuses an unreviewed source before parsing or executing it', () => {
  assert.throws(() => audit.extractBundle('throw new Error("must never execute");'), /Unreviewed mobile app.js/);
});

function fixture(options: { put?: () => Promise<unknown>; store?: { value?: Dynamic } } = {}) {
  assert(bundle, 'Mobile native fixture unavailable');
  const store = options.store || {};
  const writes: Dynamic[] = [];
  const opens: unknown[][] = [];
  const errors: unknown[][] = [];
  const platform = { awake: 0, released: 0 };
  const db = {
    async put(table: string, value: Dynamic, key: string) {
      assert.equal(table, 'data'); assert.equal(key, 'data');
      const snapshot = structuredClone(value);
      writes.push(snapshot);
      await options.put?.();
      store.value = snapshot;
    },
    async get(table: string, key: string) {
      assert.equal(table, 'data'); assert.equal(key, 'data');
      return store.value && structuredClone(store.value);
    },
  };
  const { context, prototypes } = audit.createContext(bundle, {
    // The actual mobile IndexedDB wrapper was reviewed separately. This fixture
    // deliberately stops at its interface; it does not simulate disk durability.
    vO: async (...args: unknown[]) => { opens.push(args); return db; },
    sleep: () => Promise.resolve(), dv: true,
    Cv: {
      keepAwake: async () => { platform.awake++; },
      allowSleep: async () => { platform.released++; },
    },
    console: { log: (...args: unknown[]) => errors.push(args), error: (...args: unknown[]) => errors.push(args) },
  });
  const filter: Dynamic = Object.assign(Object.create(prototypes.filter), {
    configDir: '.obsidian', ignoreFolders: ['Private'], filterCache: {},
    allowTypes: new Set(['image', 'audio', 'video', 'pdf']),
    allowSpecialFiles: new Set(['community-plugin', 'community-plugin-data']),
  });
  const sync: Dynamic = Object.assign(Object.create(prototypes.sync), {
    initialized: true, dataLoaded: true, db, filter,
    app: { appId: 'synthetic-mobile' }, vaultId: 'synthetic-remote', vaultName: 'synthetic-vault',
    key: new Uint8Array([1, 7, 23, 255]).buffer, salt: 'synthetic-salt', encryptionVersion: 3,
    host: 'synthetic-host', deviceName: 'synthetic-phone', userId: 123, version: 4, initial: false,
    dirty: false, syncing: false, pause: false, preventSleep: false, conflictAction: 'merge',
    plugin: { enabled: false }, localFiles: {}, serverFiles: {}, newServerFiles: [], fileRetry: {},
    trigger: () => undefined, requestSaveData: () => undefined, scanFiles: () => undefined,
    setStatus: () => undefined, log: () => undefined, failedSync: () => undefined,
    vault: { getRoot: () => ({ children: [{}] }) },
    _sync: async () => false,
  });
  const holder = { sync };
  const app = { internalPlugins: { getEnabledPluginById: () => holder.sync } };
  return { app, sync, filter, holder, writes, opens, errors, platform, store, context };
}

async function writable(f: ReturnType<typeof fixture>) {
  const inspected = await inspectSync(f.app, profile.version, true, '.obsidian', true);
  assert.equal(inspected.writable, true, inspected.reason);
  assert.ok(inspected.adapter);
  return inspected.adapter;
}

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

test('official mobile bundle matches all 12 observed fingerprints and detached filter paths', { skip }, () => {
  assert(bundle);
  let count = 0;
  for (const [group, entries] of Object.entries(profile.fingerprints)) {
    for (const [name, expected] of Object.entries(entries)) {
      assert.equal(audit.sha256(bundle.methods[group][name]), expected);
      count++;
    }
  }
  assert.equal(count, 12);
  assert.equal(audit.probeFilter(bundle), 56);
});

test('actual mobile methods stay read-only until local opt-in and preserve all source state during inspection', { skip }, async () => {
  const f = fixture();
  const originals = [f.filter.ignoreFolders, f.filter.filterCache, f.filter.allowTypes, f.filter.allowSpecialFiles];
  const blocked = await inspectSync(f.app, profile.version, true, '.obsidian');
  assert.equal(blocked.writable, false); assert.equal(blocked.experimentalEligible, true);
  assert.equal(blocked.adapter, undefined);
  const allowed = await writable(f);
  assert.deepEqual(allowed.read(), ['Private']);
  assert.deepEqual([f.filter.ignoreFolders, f.filter.filterCache, f.filter.allowTypes, f.filter.allowSpecialFiles], originals);
  for (const [index, key] of ['ignoreFolders', 'filterCache', 'allowTypes', 'allowSpecialFiles'].entries()) assert.equal(f.filter[key], originals[index]);
  assert.equal(f.sync.dirty, false); assert.equal(f.writes.length, 0);
});

test('mobile profile cannot authorize a desktop inspection or an unknown version', { skip }, async () => {
  const f = fixture();
  const wrongPlatform = await inspectSync(f.app, profile.version, false, '.obsidian', true);
  assert.equal(wrongPlatform.writable, false); assert.equal(wrongPlatform.adapter, undefined);
  const wrongVersion = await inspectSync(f.app, '99.0.0', true, '.obsidian', true);
  assert.equal(wrongVersion.writable, false); assert.equal(f.writes.length, 0);
});

for (const [group, entries] of Object.entries(profile.fingerprints)) for (const name of Object.keys(entries)) {
  test(`mobile opt-in cannot bypass changed ${group}.${name}`, { skip }, async () => {
    const f = fixture();
    let invoked = false;
    (group === 'sync' ? f.sync : f.filter)[name] = () => { invoked = true; throw new Error('unverified method must not execute'); };
    const inspected = await inspectSync(f.app, profile.version, true, '.obsidian', true);
    assert.equal(inspected.writable, false); assert.equal(inspected.adapter, undefined);
    assert.equal(inspected.experimentalEligible, undefined);
    assert.equal(invoked, false); assert.equal(f.writes.length, 0);
    assert.deepEqual(f.filter.ignoreFolders, ['Private']);
  });
}

test('mobile save waits for storage completion and retains other saved Sync fields', { skip }, async () => {
  const waiting = gate(); const entered = gate();
  const f = fixture({ put: () => { entered.resolve(); return waiting.promise; } });
  const adapter = await writable(f);
  const after = ['Private', '.obsidian/plugins/desktop-only'];
  let completed = false;
  const pending = adapter.write(['Private'], after).then(() => { completed = true; });
  await entered.promise;
  assert.equal(completed, false); assert.equal(f.store.value, undefined);
  assert.deepEqual(f.writes[0].ignoreFolders, after);
  assert.equal(f.writes[0].vaultId, f.sync.vaultId); assert.equal(f.writes[0].host, f.sync.host);
  assert.equal(f.writes[0].key, 'AQcX/w==');
  waiting.resolve(); await pending;
  assert.equal(completed, true); assert.deepEqual(adapter.read(), after);
});

test('mobile storage rejection is reported without pretending the changed memory state was persisted', { skip }, async () => {
  const f = fixture({ put: async () => { throw new Error('synthetic storage rejection'); } });
  const adapter = await writable(f);
  const after = ['Private', '.obsidian/plugins/desktop-only'];
  await assert.rejects(adapter.write(['Private'], after));
  assert.equal(f.store.value, undefined); assert.equal(f.writes.length, 1);
  assert.deepEqual(f.filter.ignoreFolders, after);
});

test('mobile saveData followed by native loadData restores exclusions and key in an independent synthetic instance', { skip }, async () => {
  const f = fixture(); const adapter = await writable(f);
  const after = ['Private', '.obsidian/plugins/desktop-only'];
  await adapter.write(['Private'], after);
  const reloaded = fixture({ store: f.store });
  reloaded.filter.ignoreFolders = []; reloaded.filter.filterCache = { stale: false };
  reloaded.sync.key = new Uint8Array([0]).buffer;
  await reloaded.sync.loadData();
  assert.deepEqual(reloaded.filter.ignoreFolders, after);
  assert.deepEqual(new Uint8Array(reloaded.sync.key), new Uint8Array([1, 7, 23, 255]));
  assert.equal(reloaded.filter.allowTypes instanceof Set, true);
  assert.equal(reloaded.filter.allowSpecialFiles.has('community-plugin-data'), true);
  assert.equal(Object.keys(reloaded.filter.filterCache).length, 0);
  assert.equal(reloaded.filter.allowSyncFile('.obsidian/plugins/desktop-only/main.js', false), false);
  assert.equal(reloaded.filter.allowSyncFile('.obsidian/plugins/allowed/main.js', false), true);
  assert.equal(reloaded.opens.length, 1); assert.equal(reloaded.opens[0][0], 'synthetic-mobile-sync');
  assert.equal(reloaded.writes.length, 0); assert.equal(reloaded.errors.length, 0);
});

test('mobile write rejects concurrent exclusions before mutation and mutations while saving', { skip }, async () => {
  const first = fixture(); const firstAdapter = await writable(first);
  first.filter.ignoreFolders = ['Concurrent'];
  await assert.rejects(firstAdapter.write(['Private'], ['New']));
  assert.equal(first.writes.length, 0);
  const waiting = gate(); const entered = gate();
  const f = fixture({ put: () => { entered.resolve(); return waiting.promise; } });
  const adapter = await writable(f);
  const pending = adapter.write(['Private'], ['Private', '.obsidian/plugins/desktop-only']);
  await entered.promise; f.filter.ignoreFolders = ['Concurrent']; waiting.resolve();
  await assert.rejects(pending);
  assert.deepEqual(f.filter.ignoreFolders, ['Concurrent']);
});

test('mobile write rechecks native methods and Sync instances after preview', { skip }, async () => {
  for (const change of ['method', 'instance', 'filter']) {
    const f = fixture(); const adapter = await writable(f);
    if (change === 'method') f.sync.saveData = () => { throw new Error('must not run'); };
    else if (change === 'instance') f.holder.sync = fixture().sync;
    else f.sync.filter = fixture().filter;
    await assert.rejects(adapter.write(['Private'], ['Private', '.obsidian/plugins/desktop-only']));
    assert.equal(f.writes.length, 0);
  }
});

for (const rejects of [false, true]) test(`actual mobile requestSync releases KeepAwake after ${rejects ? 'failure' : 'success'}`, { skip }, async () => {
  const f = fixture(); let runs = 0; let failures = 0;
  f.sync.plugin.enabled = true; f.sync.preventSleep = true;
  f.sync.failedSync = () => { failures++; };
  f.sync._sync = async () => { runs++; if (rejects) throw new Error('synthetic sync failure'); return false; };
  await f.sync.requestSync();
  assert.equal(runs, 1); assert.equal(failures, rejects ? 1 : 0);
  assert.deepEqual(f.platform, { awake: 1, released: 1 });
  assert.equal(f.sync.syncing, false); assert.equal(f.sync.error, rejects);
});

test('actual mobile requestSync respects pause and refuses a concurrent loop', { skip }, async () => {
  const f = fixture(); let runs = 0;
  f.sync.plugin.enabled = true; f.sync.preventSleep = true; f.sync.pause = true;
  f.sync._sync = async () => { runs++; return false; };
  await f.sync.requestSync();
  assert.equal(runs, 0); assert.deepEqual(f.platform, { awake: 0, released: 0 });
  f.sync.pause = false; f.sync.syncing = true;
  await f.sync.requestSync();
  assert.equal(runs, 0); assert.equal(f.sync.syncing, true);
});
