import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import vm from 'node:vm';
import profile from '../src/native-profile.json';
import { inspectSync, readNativeExclusions } from '../src/sync-adapter';

const audit = require('../scripts/check-native.cjs') as {
  readAsarEntry(path: string, entry: string): string;
  extractMethods(source: string): Record<string, Record<string, string>>;
  extractAsyncHelpers(source: string): string;
  sha256(source: string): string;
};

const readyStub = () => ({
  initialized: true, dataLoaded: true, db: {}, vaultId: 'synthetic-remote',
  filter: { configDir: '.obsidian', allowTypes: new Set(), allowSpecialFiles: new Set(), ignoreFolders: ['Private'] },
});
const hostFor = (sync: unknown) => ({ internalPlugins: { getEnabledPluginById: (id: string) => id === 'sync' ? sync : null } });

test('missing Sync stays read-only without invoking a setter', async () => {
  for (const app of [{}, { internalPlugins: {} }, hostFor(null)]) {
    const result = await inspectSync(app, profile.version, false, '.obsidian');
    assert.equal(result.writable, false);
    assert.equal(result.adapter, undefined);
  }
});

test('unknown version and unavailable initialized state are read-only', async () => {
  const unknown = await inspectSync(hostFor(readyStub()), '99.0.0', false, '.obsidian');
  assert.equal(unknown.writable, false);
  assert.match(unknown.reason, /尚未验证/);
  for (const override of [{ initialized: false }, { dataLoaded: false }, { db: null }, { vaultId: '' }]) {
    const result = await inspectSync(hostFor({ ...readyStub(), ...override }), profile.version, false, '.obsidian');
    assert.equal(result.writable, false);
    assert.equal(result.adapter, undefined);
  }
});

test('invalid filter shapes, duplicate exclusions and mismatched config directories are read-only', async () => {
  for (const change of [{ configDir: '.other' }, { allowTypes: [] }, { allowSpecialFiles: null }, { ignoreFolders: ['Private', 'Private'] }]) {
    const sync = readyStub();
    Object.assign(sync.filter, change);
    const result = await inspectSync(hostFor(sync), profile.version, false, '.obsidian');
    assert.equal(result.writable, false);
    assert.equal(result.adapter, undefined);
  }
});

test('missing private methods fail fingerprints without changing exclusions', async () => {
  const sync = readyStub();
  const exclusions = sync.filter.ignoreFolders;
  const result = await inspectSync(hostFor(sync), profile.version, false, '.obsidian');
  assert.equal(result.writable, false);
  assert.match(result.reason, /尚未适配这台设备的 Sync 实现/);
  assert.equal(sync.filter.ignoreFolders, exclusions);
  assert.deepEqual(exclusions, ['Private']);
});

test('native exclusion reads return a copy and reject unavailable or malformed state', () => {
  const sync = readyStub();
  const result = readNativeExclusions(hostFor(sync));
  result.push('changed-copy');
  assert.deepEqual(sync.filter.ignoreFolders, ['Private']);
  assert.throws(() => readNativeExclusions({}));
  sync.filter.ignoreFolders.push('Private');
  assert.throws(() => readNativeExclusions(hostFor(sync)));
});

// Actual installed function text is read at test time and stays outside this
// repository. Every object it runs against below is synthetic, including storage.
const asar = process.env.OBSIDIAN_ASAR || '/Applications/Obsidian.app/Contents/Resources/obsidian.asar';
let source: string | undefined;
let methods: Record<string, Record<string, string>> | undefined;
let skipNative: string | false = false;
if (!fs.existsSync(asar)) skipNative = 'No installed Obsidian ASAR; set OBSIDIAN_ASAR to run native adapter fixtures.';
else {
  const installed = JSON.parse(audit.readAsarEntry(asar, 'package.json')) as { version: string };
  if (installed.version !== profile.version) skipNative = `Installed ${installed.version} is outside the ${profile.version} fixture profile.`;
  else {
    source = audit.readAsarEntry(asar, 'app.js');
    methods = audit.extractMethods(source);
    for (const [group, entries] of Object.entries(profile.fingerprints)) {
      for (const [name, expected] of Object.entries(entries)) {
        assert.equal(audit.sha256(methods[group][name]), expected, `Fixture fingerprint: ${group}.${name}`);
      }
    }
  }
}

type Dynamic = Record<string, any>;
function nativeFixture(put?: (store: string, value: Dynamic, key: string) => Promise<unknown>) {
  assert(source && methods, 'Native fixture unavailable');
  const context = vm.createContext({
    Al: (value: string) => value.slice(value.lastIndexOf('/') + 1),
    Fl: (value: string) => value.slice(value.lastIndexOf('.') + 1).toLowerCase(),
    hb: ['png'], pb: ['mp3'], db: ['mp4'], fb: ['pdf'],
    Td: () => '<synthetic-key>', sleep: () => Promise.resolve(), Tf: false,
  });
  vm.runInContext(audit.extractAsyncHelpers(source), context, { timeout: 1000 });
  const prototypes: Record<string, Dynamic> = {};
  for (const [group, entries] of Object.entries(methods)) {
    prototypes[group] = {};
    for (const [name, text] of Object.entries(entries)) {
      prototypes[group][name] = vm.runInContext(`(${text})`, context, { timeout: 1000 });
    }
  }
  const filter: Dynamic = Object.assign(Object.create(prototypes.filter), {
    configDir: '.obsidian', ignoreFolders: ['Private'],
    allowTypes: new Set(['image', 'audio', 'video', 'pdf']),
    allowSpecialFiles: new Set(['community-plugin', 'community-plugin-data']),
    filterCache: { 'Private/cached.md': false },
  });
  const writes: Dynamic[] = [];
  const sync: Dynamic = Object.assign(Object.create(prototypes.sync), {
    initialized: true, dataLoaded: true, vaultId: 'synthetic-remote', filter,
    app: { appId: 'synthetic-device' }, key: null, dirty: false,
    plugin: { enabled: false }, syncing: false, pause: false,
    localFiles: {}, serverFiles: {}, newServerFiles: [], fileRetry: {},
    trigger: () => undefined,
    requestSaveData: () => undefined,
    db: { put(store: string, value: Dynamic, key: string) {
      writes.push({ store, key, ignoreFolders: [...value.ignoreFolders] });
      return put ? put(store, value, key) : Promise.resolve();
    } },
  });
  const holder = { sync };
  const app = { internalPlugins: { getEnabledPluginById: () => holder.sync } };
  return { app, sync, filter, holder, writes };
}

test('actual native inspection passes using a detached filter without changing source state', { skip: skipNative }, async () => {
  const fixture = nativeFixture();
  const original = {
    ignores: fixture.filter.ignoreFolders, types: fixture.filter.allowTypes,
    specials: fixture.filter.allowSpecialFiles, cache: fixture.filter.filterCache,
  };
  const result = await inspectSync(fixture.app, profile.version, false, '.obsidian');
  assert.equal(result.writable, true, result.reason);
  assert.ok(result.adapter);
  assert.equal(JSON.parse(result.diagnostics).detachedFilterProbe, 'passed');
  assert.equal(fixture.filter.ignoreFolders, original.ignores);
  assert.equal(fixture.filter.allowTypes, original.types);
  assert.equal(fixture.filter.allowSpecialFiles, original.specials);
  assert.equal(fixture.filter.filterCache, original.cache);
  assert.deepEqual(fixture.filter.ignoreFolders, ['Private']);
  assert.deepEqual(fixture.filter.filterCache, { 'Private/cached.md': false });
  assert.equal(fixture.sync.dirty, false);
  assert.deepEqual(fixture.writes, []);
});

test('changed private method is read-only even when its method name is unchanged', { skip: skipNative }, async () => {
  const fixture = nativeFixture();
  let calls = 0;
  fixture.sync.setIgnoreFolders = () => { calls++; };
  const result = await inspectSync(fixture.app, profile.version, false, '.obsidian');
  assert.equal(result.writable, false);
  assert.match(result.reason, /sync.setIgnoreFolders/);
  assert.equal(calls, 0);
  assert.deepEqual(fixture.filter.ignoreFolders, ['Private']);
});

test('desktop methods cannot satisfy the mobile profile even with explicit opt-in', { skip: skipNative }, async () => {
  const fixture = nativeFixture();
  for (const optIn of [false, true]) {
    const result = await inspectSync(fixture.app, profile.version, true, '.obsidian', optIn);
    assert.equal(result.writable, false);
    assert.notEqual(result.experimentalEligible, true);
    assert.equal(result.adapter, undefined);
    assert.match(result.reason, /sync.saveData/);
    assert.equal(JSON.parse(result.diagnostics).profilePlatform, 'mobile');
  }
  assert.deepEqual(fixture.writes, []);
});

test('native save is awaited and only the synthetic storage receives the requested exclusions', { skip: skipNative }, async () => {
  let resolveWrite!: () => void;
  let markEntered!: () => void;
  const gate = new Promise<void>(resolve => { resolveWrite = resolve; });
  const entered = new Promise<void>(resolve => { markEntered = resolve; });
  const fixture = nativeFixture(() => { markEntered(); return gate; });
  const inspected = await inspectSync(fixture.app, profile.version, false, '.obsidian');
  assert.ok(inspected.adapter);
  const after = ['Private', '.obsidian/plugins/desktop-only'];
  let finished = false;
  const pending = inspected.adapter.write(['Private'], after).then(() => { finished = true; });
  await entered;
  assert.equal(finished, false);
  assert.deepEqual(fixture.filter.ignoreFolders, after);
  assert.deepEqual(fixture.writes, [{ store: 'data', key: 'data', ignoreFolders: after }]);
  resolveWrite();
  await pending;
  assert.equal(finished, true);
  assert.deepEqual(inspected.adapter.read(), after);
});

test('storage rejection propagates while preserving the changed in-memory exclusions', { skip: skipNative }, async () => {
  const fixture = nativeFixture(() => Promise.reject(new Error('synthetic storage rejection')));
  const inspected = await inspectSync(fixture.app, profile.version, false, '.obsidian');
  assert.ok(inspected.adapter);
  const after = ['Private', '.obsidian/plugins/desktop-only'];
  await assert.rejects(inspected.adapter.write(['Private'], after), /保存失败/);
  assert.deepEqual(fixture.filter.ignoreFolders, after);
  assert.equal(fixture.sync.dirty, false);
  assert.equal(fixture.writes.length, 1);
});

test('write refuses concurrently changed exclusions or invalid requested lists before mutation', { skip: skipNative }, async () => {
  const fixture = nativeFixture();
  const inspected = await inspectSync(fixture.app, profile.version, false, '.obsidian');
  assert.ok(inspected.adapter);
  fixture.filter.ignoreFolders = ['Other'];
  await assert.rejects(inspected.adapter.write(['Private'], ['New']), /同步设置已改变/);
  assert.deepEqual(fixture.filter.ignoreFolders, ['Other']);
  await assert.rejects(inspected.adapter.write(['Other'], ['Duplicate', 'Duplicate']), /重复或无效项目/);
  assert.deepEqual(fixture.filter.ignoreFolders, ['Other']);
  assert.deepEqual(fixture.writes, []);
});

test('write rechecks private fingerprints instead of trusting an earlier inspection', { skip: skipNative }, async () => {
  const fixture = nativeFixture();
  const inspected = await inspectSync(fixture.app, profile.version, false, '.obsidian');
  assert.ok(inspected.adapter);
  fixture.sync.saveData = () => { throw new Error('must never run'); };
  await assert.rejects(inspected.adapter.write(['Private'], ['Private', '.obsidian/plugins/example']), /sync.saveData/);
  assert.deepEqual(fixture.filter.ignoreFolders, ['Private']);
  assert.deepEqual(fixture.writes, []);
});

test('write rejects a different function reference even when its source fingerprint is unchanged', { skip: skipNative }, async () => {
  const fixture = nativeFixture();
  const inspected = await inspectSync(fixture.app, profile.version, false, '.obsidian');
  assert.ok(inspected.adapter);
  const original = fixture.sync.setIgnoreFolders;
  fixture.sync.setIgnoreFolders = vm.runInNewContext(`(${Function.prototype.toString.call(original)})`, {}, { timeout: 1000 });
  assert.notEqual(fixture.sync.setIgnoreFolders, original);
  assert.equal(audit.sha256(Function.prototype.toString.call(fixture.sync.setIgnoreFolders)), profile.fingerprints.sync.setIgnoreFolders);
  await assert.rejects(inspected.adapter.write(['Private'], ['Private', '.obsidian/plugins/example']), /内部状态已改变/);
  assert.deepEqual(fixture.filter.ignoreFolders, ['Private']);
  assert.deepEqual(fixture.writes, []);
});

test('write refuses an instance or filter replacement after preview', { skip: skipNative }, async () => {
  for (const replace of ['instance', 'filter']) {
    const fixture = nativeFixture();
    const replacement = nativeFixture();
    const inspected = await inspectSync(fixture.app, profile.version, false, '.obsidian');
    assert.ok(inspected.adapter);
    if (replace === 'instance') fixture.holder.sync = replacement.sync;
    else fixture.sync.filter = replacement.filter;
    await assert.rejects(inspected.adapter.write(['Private'], ['Private', '.obsidian/plugins/example']), /已重新加载/);
    assert.deepEqual(fixture.writes, []);
    assert.deepEqual(replacement.writes, []);
  }
});

test('write does not claim a no-op save confirmed persistence when a synchronous listener consumed dirty', { skip: skipNative }, async () => {
  const fixture = nativeFixture();
  fixture.sync.trigger = () => { fixture.sync.dirty = false; };
  const inspected = await inspectSync(fixture.app, profile.version, false, '.obsidian');
  assert.ok(inspected.adapter);
  const after = ['Private', '.obsidian/plugins/example'];
  await assert.rejects(inspected.adapter.write(['Private'], after));
  assert.deepEqual(fixture.filter.ignoreFolders, after);
  assert.deepEqual(fixture.writes, []);
});

test('readback detects an exclusion change while native storage was awaiting completion', { skip: skipNative }, async () => {
  let resolveWrite!: () => void;
  let markEntered!: () => void;
  const gate = new Promise<void>(resolve => { resolveWrite = resolve; });
  const entered = new Promise<void>(resolve => { markEntered = resolve; });
  const fixture = nativeFixture(() => { markEntered(); return gate; });
  const inspected = await inspectSync(fixture.app, profile.version, false, '.obsidian');
  assert.ok(inspected.adapter);
  const pending = inspected.adapter.write(['Private'], ['Private', '.obsidian/plugins/example']);
  await entered;
  fixture.filter.ignoreFolders = ['Concurrent'];
  resolveWrite();
  await assert.rejects(pending, /保存后同步设置又有变化/);
  assert.deepEqual(fixture.filter.ignoreFolders, ['Concurrent']);
});
