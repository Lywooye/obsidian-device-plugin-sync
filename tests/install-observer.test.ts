import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import vm from 'node:vm';
import { observePluginInstalls } from '../src/install-observer';

const audit = require('../scripts/check-native.cjs') as {
  readAsarEntry(path: string, entry: string): string;
  extractAsyncHelpers(source: string): string;
  sha256(source: string): string;
};
const version = '1.13.7';
const fingerprint = '1d4053d0d73d2dcc35d2d2e8ff53d439351d988d9080a67ceb754cf41ad24d25';
const archive = process.env.OBSIDIAN_ASAR || '/Applications/Obsidian.app/Contents/Resources/obsidian.asar';
let skipNative: string | false = false;
let source = '';
let installer = '';
if (!fs.existsSync(archive)) skipNative = 'No installed Obsidian ASAR; set OBSIDIAN_ASAR to run the installer fixture.';
else if (JSON.parse(audit.readAsarEntry(archive, 'package.json')).version !== version) skipNative = 'Installed Obsidian is outside the 1.13.7 installer profile.';
else {
  source = audit.readAsarEntry(archive, 'app.js');
  const marker = 't.prototype.installPlugin=';
  const begin = source.indexOf(marker);
  assert(begin >= 0, 'The reviewed native installer must exist.');
  installer = source.slice(begin + marker.length, source.indexOf(',t.prototype.', begin + marker.length));
  assert.equal(audit.sha256(installer), fingerprint);
}
const flush = async () => { for (let index = 0; index < 5; index++) await new Promise(resolve => setImmediate(resolve)); };
const info = { id: 'new-plugin', name: 'New Plugin', version: '1.0.0' };
const directory = '.obsidian/plugins/new-plugin';
type Dynamic = Record<string, any>;

// The installed native function runs against synthetic files, network responses,
// notices and plugin objects. Its copyrighted source is never copied into the repo.
function fixture(options: {
  manifest?: unknown; missing?: string[]; existingFolder?: boolean;
  existingManifest?: boolean; writeError?: Error; downloadGate?: Promise<void>;
} = {}) {
  assert(source && installer);
  const files = new Map<string, string>();
  const folders = new Set(['.obsidian/plugins']);
  if (options.existingFolder) folders.add(directory);
  const requests: unknown[][] = [];
  const adapter: Dynamic = {
    exists: async (path: string) => folders.has(path) || files.has(path),
    read: async (path: string) => {
      if (!files.has(path)) throw new Error(`Missing fixture file: ${path}`);
      return files.get(path)!;
    },
    write: async (path: string, text: string) => {
      if (options.writeError) throw options.writeError;
      files.set(path, text);
    },
  };
  const app: Dynamic = { vault: {
    configDir: '.obsidian', adapter, exists: adapter.exists,
    createFolder: async (path: string) => { folders.add(path); },
  } };
  const context = vm.createContext({
    Promise, console: { error() {}, log() {} }, setTimeout() { return 0; },
    eL: 'manifest.json', tL: 'main.js', nL: 'styles.css', f4: /sourceMappingURL/g, v4: '\n/* fixture */',
    Aw: class { containerEl = { addClass() {}, removeClass() {} }; setMessage() {} hide() {} },
    y4: new Proxy({}, { get: () => () => 'fixture notice' }),
    Py: (...args: unknown[]) => { requests.push(args); return args[2]; },
    zy: (name: string) => ({ text: (async () => {
      if (options.downloadGate) await options.downloadGate;
      if (options.missing?.includes(name)) throw new Error(`Missing download: ${name}`);
      if (name === 'manifest.json') return JSON.stringify(options.manifest ?? info);
      return name === 'main.js' ? 'fixture code' : '.fixture {}';
    })() }),
  });
  vm.runInContext(audit.extractAsyncHelpers(source), context, { timeout: 1000 });
  vm.runInContext('const originalY = y; y = function(...args) { const promise = originalY(...args); globalThis.lastNativePromise = promise; return promise; };', context);
  const native = vm.runInContext(`(${installer})`, context, { timeout: 1000 });
  const manager: Dynamic = Object.assign(Object.create({ installPlugin: native }), {
    app, manifests: options.existingManifest ? { [info.id]: { ...info } } : {},
    plugins: {}, updates: {}, didChange() {}, getPluginFolder: () => '.obsidian/plugins',
    loadManifest: async (path: string) => {
      const manifest = JSON.parse(await adapter.read(`${path}/manifest.json`));
      manager.manifests[manifest.id] = manifest;
    },
    disablePlugin: async () => {}, enablePlugin: async () => {},
  });
  app.plugins = manager;
  return { app, manager, adapter, files, folders, requests, native, context };
}

test('unknown version, shape and native fingerprint do not install a wrapper', async () => {
  const unknown = async () => {};
  const app = { plugins: { manifests: {}, installPlugin: unknown }, vault: { configDir: '.obsidian', adapter: { exists: async () => false, read: async () => '' } } };
  for (const [host, currentVersion, config] of [[app, '99.0.0', '.obsidian'], [{}, version, '.obsidian'], [app, version, '.other'], [app, version, '.obsidian']] as const) {
    const observer = await observePluginInstalls(host, currentVersion, config, () => assert.fail(), () => assert.fail());
    assert.equal(observer.active, false);
    observer.dispose();
    assert.equal(app.plugins.installPlugin, unknown);
  }
});

test('verified native installer reports a new local plugin and preserves its original Promise, receiver and arguments', { skip: skipNative }, async () => {
  const f = fixture();
  const installed: unknown[] = [];
  const observer = await observePluginInstalls(f.app, version, '.obsidian', plugin => { installed.push(plugin); }, error => { throw error; });
  assert.equal(observer.active, true);
  const result = f.manager.installPlugin('owner/repo', '1.0.0', info);
  assert.equal(result, f.context.lastNativePromise, 'Return exactly the native Promise, not a chained replacement.');
  await result;
  await flush();
  assert.deepEqual(installed, [{ id: info.id, name: info.name }]);
  assert.deepEqual(f.requests, [['owner/repo', '1.0.0', 'manifest.json'], ['owner/repo', '1.0.0', 'main.js'], ['owner/repo', '1.0.0', 'styles.css']]);
  observer.dispose();
  assert.equal(observer.active, false);
  assert.equal(f.manager.installPlugin, f.native);
  assert.equal(Object.hasOwn(f.manager, 'installPlugin'), false, 'Restore the inherited method without leaving a shadow property.');
});

test('existing manifests, existing folders and direct Sync file arrival are not new local installations', { skip: skipNative }, async () => {
  for (const options of [{ existingManifest: true }, { existingFolder: true }]) {
    const f = fixture(options);
    const installed: unknown[] = [];
    const observer = await observePluginInstalls(f.app, version, '.obsidian', plugin => { installed.push(plugin); }, () => assert.fail());
    await f.manager.installPlugin('owner/repo', '1.0.0', info);
    await flush();
    assert.deepEqual(installed, []);
    observer.dispose();
  }
  const f = fixture();
  const observer = await observePluginInstalls(f.app, version, '.obsidian', () => assert.fail('Sync arrival is not a local installation.'), () => assert.fail());
  f.folders.add(directory);
  f.files.set(`${directory}/manifest.json`, JSON.stringify(info));
  f.files.set(`${directory}/main.js`, 'Synced code');
  f.manager.manifests[info.id] = info;
  f.manager.didChange();
  await flush();
  observer.dispose();
});

test('native swallowed download failures and manifest mismatch do not report successful installation', { skip: skipNative }, async () => {
  for (const options of [{ missing: ['manifest.json'] }, { missing: ['main.js'] }, { manifest: { ...info, id: 'different-plugin' } }]) {
    const f = fixture(options);
    const installed: unknown[] = [];
    const observer = await observePluginInstalls(f.app, version, '.obsidian', plugin => { installed.push(plugin); }, () => assert.fail());
    await f.manager.installPlugin('owner/repo', '1.0.0', info);
    await flush();
    assert.deepEqual(installed, []);
    observer.dispose();
  }
});

test('native rejection remains the original error and observers cannot break a completed install', { skip: skipNative }, async () => {
  const error = new Error('Native write failed.');
  const failed = fixture({ writeError: error });
  const failureObserver = await observePluginInstalls(failed.app, version, '.obsidian', () => assert.fail(), () => assert.fail());
  const promise = failed.manager.installPlugin('owner/repo', '1.0.0', info);
  assert.equal(promise, failed.context.lastNativePromise);
  await assert.rejects(promise, caught => caught === error);
  await flush();
  failureObserver.dispose();
  const f = fixture();
  const errors: unknown[] = [];
  const callbackError = new Error('Registration failed.');
  const observer = await observePluginInstalls(f.app, version, '.obsidian', async () => { throw callbackError; }, caught => { errors.push(caught); throw new Error('Error handler failed.'); });
  await f.manager.installPlugin('owner/repo', '1.0.0', info);
  await flush();
  assert.deepEqual(errors, [callbackError]);
  assert.equal(f.files.has(`${directory}/main.js`), true);
  observer.dispose();
});

test('dispose prevents late callbacks and does not replace a later wrapper', { skip: skipNative }, async () => {
  let release!: () => void;
  const f = fixture({ downloadGate: new Promise<void>(resolve => { release = resolve; }) });
  const installed: unknown[] = [];
  const observer = await observePluginInstalls(f.app, version, '.obsidian', plugin => { installed.push(plugin); }, () => assert.fail());
  const wrapped = f.manager.installPlugin;
  const result = f.manager.installPlugin('owner/repo', '1.0.0', info);
  const later = function(this: unknown, ...args: unknown[]) { return Reflect.apply(wrapped, this, args); };
  f.manager.installPlugin = later;
  assert.equal(observer.active, false, 'A replaced hook is no longer reported as active.');
  observer.dispose();
  assert.equal(f.manager.installPlugin, later);
  release();
  await result;
  await flush();
  assert.deepEqual(installed, []);
});

test('a borrowed installer preserves its receiver and disposing restores an original own descriptor', { skip: skipNative }, async () => {
  const f = fixture(), other = fixture();
  Object.defineProperty(f.manager, 'installPlugin', { value: f.native, writable: true, configurable: true, enumerable: false });
  const descriptor = Object.getOwnPropertyDescriptor(f.manager, 'installPlugin');
  const observer = await observePluginInstalls(f.app, version, '.obsidian', () => assert.fail('A different receiver is not observed.'), () => assert.fail());
  const result = f.manager.installPlugin.call(other.manager, 'owner/repo', '1.0.0', info);
  assert.equal(result, f.context.lastNativePromise);
  await result;
  await flush();
  assert.equal(other.files.has(`${directory}/main.js`), true);
  assert.equal(f.files.size, 0);
  observer.dispose();
  assert.deepEqual(Object.getOwnPropertyDescriptor(f.manager, 'installPlugin'), descriptor);
});

test('malformed manifest getters keep native Promise rejection semantics', { skip: skipNative }, async () => {
  const f = fixture();
  const error = new Error('Manifest getter failed.');
  const errors: unknown[] = [];
  const invalid = { get id() { throw error; }, name: 'Bad' };
  const observer = await observePluginInstalls(f.app, version, '.obsidian', () => assert.fail(), caught => { errors.push(caught); });
  const result = f.manager.installPlugin('owner/repo', '1.0.0', invalid);
  assert.equal(result, f.context.lastNativePromise);
  await assert.rejects(result, caught => caught === error);
  await flush();
  assert.deepEqual(errors, [error]);
  observer.dispose();
});

test('unsafe IDs, invalid names and the manager itself are ignored without changing native behavior', { skip: skipNative }, async () => {
  for (const invalid of [{ id: '../escape', name: 'Bad' }, { id: 'prototype', name: 'Bad' }, { id: 'device-plugin-sync', name: 'Manager' }, { ...info, name: 'Bad\nName' }]) {
    const f = fixture({ manifest: invalid });
    const installed: unknown[] = [];
    const observer = await observePluginInstalls(f.app, version, '.obsidian', plugin => { installed.push(plugin); }, () => assert.fail());
    await f.manager.installPlugin('owner/repo', '1.0.0', invalid);
    await flush();
    assert.deepEqual(installed, []);
    assert.equal(f.requests.length, 3, 'The observer does not block or alter the native installation.');
    observer.dispose();
  }
});

test('failed pre-install checks and replaced app references suppress classification', { skip: skipNative }, async () => {
  const f = fixture();
  const installed: unknown[] = [], errors: unknown[] = [];
  const exists = f.adapter.exists;
  f.adapter.exists = async (path: string) => {
    if (path === directory) throw new Error('Cannot inspect existing folder.');
    return exists(path);
  };
  const observer = await observePluginInstalls(f.app, version, '.obsidian', plugin => { installed.push(plugin); }, error => { errors.push(error); });
  await f.manager.installPlugin('owner/repo', '1.0.0', info);
  await flush();
  assert.equal(errors.length, 1);
  assert.deepEqual(installed, []);
  observer.dispose();

  let release!: () => void;
  const pending = fixture({ downloadGate: new Promise<void>(resolve => { release = resolve; }) });
  const pendingObserver = await observePluginInstalls(pending.app, version, '.obsidian', () => assert.fail(), () => assert.fail());
  const result = pending.manager.installPlugin('owner/repo', '1.0.0', info);
  pending.app.plugins = {};
  release();
  await result;
  await flush();
  pendingObserver.dispose();
});
