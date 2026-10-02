import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { inspectCleanupHost, CLEANUP_ROOT } from '../src/cleanup-adapter';
import profile from '../src/native-profile.json';

const audit = require('../scripts/check-native.cjs') as {
  readAsarEntry(path: string, entry: string): string;
  extractMethods(source: string): Record<string, Record<string, string>>;
  extractAsyncHelpers(source: string): string;
};
const asar = process.env.OBSIDIAN_ASAR || '/Applications/Obsidian.app/Contents/Resources/obsidian.asar';
let source: string | undefined;
let skipNative: string | false = false;
if (!fs.existsSync(asar)) skipNative = 'No installed Obsidian ASAR for native cleanup fixtures.';
else if (JSON.parse(audit.readAsarEntry(asar, 'package.json')).version !== profile.version) skipNative = 'Installed version is outside the cleanup fixture profile.';
else source = audit.readAsarEntry(asar, 'app.js');

type Dynamic = Record<string, any>;
const path = '.obsidian/plugins/alpha';
function fixture() {
  assert(source);
  const context = vm.createContext({
    Al: (value: string) => value.slice(value.lastIndexOf('/') + 1),
    Fl: (value: string) => value.slice(value.lastIndexOf('.') + 1).toLowerCase(),
    hb: ['png'], pb: ['mp3'], db: ['mp4'], fb: ['pdf'],
  });
  vm.runInContext(audit.extractAsyncHelpers(source), context);
  const extract = (name: string, start = 0) => {
    const key = `.prototype.${name}=`;
    const at = source!.indexOf(key, start);
    assert(at >= 0);
    const begin = at + key.length;
    const end = source!.indexOf(',t.prototype.', begin);
    assert(end > begin);
    return vm.runInContext(`(${source!.slice(begin, end)})`, context);
  };
  const prototype: Dynamic = {};
  for (const [name, body] of Object.entries(audit.extractMethods(source).filter)) prototype[name] = vm.runInContext(`(${body})`, context);
  const filter: Dynamic = Object.assign(Object.create(prototype), {
    configDir: '.obsidian', ignoreFolders: [path], filterCache: {},
    allowTypes: new Set(), allowSpecialFiles: new Set(['community-plugin', 'community-plugin-data']),
  });
  let unloads = 0;
  const plugin: Dynamic = { unload() { unloads++; } };
  const manager: Dynamic = {
    plugins: { alpha: plugin }, enabledPlugins: new Set(['alpha', 'device-plugin-sync']),
    unloadPlugin: extract('unloadPlugin'),
    saveConfig() { throw new Error('The shared enabled list must not be saved.'); },
    requestSaveConfig() { throw new Error('The shared enabled list must not be saved.'); },
  };
  const sync: Dynamic = {
    initialized: true, dataLoaded: true, db: {}, vaultId: 'test-vault', filter,
    pause: true, syncing: false, _sync: extract('_sync', source.indexOf('vne=function')),
  };
  const holder = { sync };
  const app = { vault: { configDir: '.obsidian' }, plugins: manager, internalPlugins: { getEnabledPluginById: () => holder.sync } };
  return { app, holder, manager, sync, filter, plugin, unloads: () => unloads };
}

test('cleanup rejects unknown versions and missing private interfaces', async () => {
  await assert.rejects(inspectCleanupHost({}, '99.0.0'));
  await assert.rejects(inspectCleanupHost({}, profile.version));
});

test('native cleanup checks exclusions and stops only the local running instance', { skip: skipNative }, async () => {
  const f = fixture();
  const host = await inspectCleanupHost(f.app, profile.version);
  host.assertExcluded(path);
  host.assertBackupExcluded(CLEANUP_ROOT);
  host.assertBackupExcluded(`${CLEANUP_ROOT}/00000000-0000-4000-8000-000000000001/alpha`);
  const enabled = [...f.manager.enabledPlugins];
  await host.unload('alpha');
  assert.equal(f.unloads(), 1);
  assert.equal(f.plugin._userDisabled, true);
  assert.equal(f.manager.plugins.alpha, undefined);
  assert.deepEqual([...f.manager.enabledPlugins], enabled);
  assert.equal(f.sync.pause, true);
});

test('cleanup rejects active Sync even after the user pressed pause', { skip: skipNative }, async () => {
  for (const values of [{ pause: false, syncing: false }, { pause: true, syncing: true }]) {
    const f = fixture();
    Object.assign(f.sync, values);
    await assert.rejects(inspectCleanupHost(f.app, profile.version), /暂停|Pause/);
    assert.equal(f.unloads(), 0);
  }
});

test('an existing parent exclusion also protects cleanup, but a similar prefix does not', { skip: skipNative }, async () => {
  const f = fixture();
  f.filter.ignoreFolders = ['.obsidian/plugins'];
  const host = await inspectCleanupHost(f.app, profile.version);
  host.assertExcluded(path);
  f.filter.ignoreFolders = ['.obsidian/plugins/alph'];
  assert.throws(() => host.assertExcluded(path));
  assert.equal(f.unloads(), 0);
});

test('cleanup cannot unload its own plugin or a path outside the plugin directory', { skip: skipNative }, async () => {
  const f = fixture();
  const host = await inspectCleanupHost(f.app, profile.version);
  await assert.rejects(host.unload('device-plugin-sync'));
  await assert.rejects(host.unload('../alpha'));
  for (const invalid of ['Notes', '.obsidian/plugins', '.obsidian/plugins/alpha/..', '.obsidian/plugins/alpha-extra']) assert.throws(() => host.assertExcluded(invalid));
  for (const invalid of ['Notes', '.obsidian/plugins/alpha', `${CLEANUP_ROOT}/../alpha`, `${CLEANUP_ROOT}/not-a-uuid/alpha`]) assert.throws(() => host.assertBackupExcluded(invalid));
  assert.equal(f.unloads(), 0);
});

test('cleanup rechecks exclusions and pause state immediately before unloading', { skip: skipNative }, async () => {
  const f = fixture();
  const host = await inspectCleanupHost(f.app, profile.version);
  f.filter.ignoreFolders = [];
  await assert.rejects(host.unload('alpha'));
  f.filter.ignoreFolders = [path];
  f.sync.pause = false;
  await assert.rejects(host.unload('alpha'), /暂停|Pause/);
  assert.equal(f.unloads(), 0);
});

test('cleanup rejects altered native methods and replacement objects', { skip: skipNative }, async () => {
  const altered = fixture();
  altered.manager.unloadPlugin = async () => undefined;
  await assert.rejects(inspectCleanupHost(altered.app, profile.version));
  for (const change of [
    (f: ReturnType<typeof fixture>) => { f.manager.unloadPlugin = async () => undefined; },
    (f: ReturnType<typeof fixture>) => { f.filter.allowSyncFile = () => false; },
    (f: ReturnType<typeof fixture>) => { f.holder.sync = { ...f.sync }; },
    (f: ReturnType<typeof fixture>) => { f.app.plugins = { ...f.manager }; },
    (f: ReturnType<typeof fixture>) => { f.sync.vaultId = 'other-vault'; },
  ]) {
    const f = fixture();
    const host = await inspectCleanupHost(f.app, profile.version);
    change(f);
    assert.throws(host.assertCurrent);
    await assert.rejects(host.unload('alpha'));
    assert.equal(f.unloads(), 0);
  }
});

test('cleanup detects a plugin callback changing shared enablement and stops before file moves', { skip: skipNative }, async () => {
  const f = fixture();
  f.plugin.unload = () => f.manager.enabledPlugins.delete('alpha');
  const host = await inspectCleanupHost(f.app, profile.version);
  await assert.rejects(host.unload('alpha'), /正常停止|stop cleanly/);
});

test('cleanup detects a plugin callback resuming Sync and stops before file moves', { skip: skipNative }, async () => {
  const f = fixture();
  f.plugin.unload = () => { f.sync.pause = false; };
  const host = await inspectCleanupHost(f.app, profile.version);
  await assert.rejects(host.unload('alpha'), /暂停|Pause/);
});
