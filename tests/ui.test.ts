// Integration of actual main.ts with a DOM + Sync adapter mock; not real Obsidian UI/network evidence.
import test, { before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import { POLICY_PATH, parsePolicy, serializePolicy, type Installation } from '../src/model';
import { parseInstallation } from '../src/new-plugins';

const root = path.resolve(__dirname, '..');
let runtime: any;
const dom = new JSDOM('<!doctype html><body></body>');
const adapterMock = `
export const readNativeExclusions = app => [...app.sync.exclusions];
export async function inspectSync(app, version, mobile, configDir, experimental) {
  const writable = app.sync.eligible && (!mobile || experimental);
  return { writable, experimentalEligible: mobile && app.sync.eligible,
    reason: writable ? 'MOCK writable; no live verification' : 'MOCK readonly', diagnostics: '{}',
    ...(writable ? { adapter: { read: () => [...app.sync.exclusions], write: async (before, after) => {
      if (JSON.stringify(before) !== JSON.stringify(app.sync.exclusions)) throw new Error('stale mock list');
      app.sync.exclusions = [...after]; app.sync.writes++;
      if (app.sync.onWrite) await app.sync.onWrite();
      if (app.sync.failWrite) throw new Error('mock native save failed');
    } } } : {}) };
}`;
// The private adapter is separately exercised against native function fingerprints.
// UI tests use explicit paused/idle/excluded state and record only local unloads.
const cleanupAdapterMock = `
export async function inspectCleanupHost(app) {
  const assertCurrent = () => {
    if (app.sync.paused !== true || app.sync.syncing !== false) throw new Error('MOCK: pause Sync and wait until idle');
  };
  const assertExcluded = path => {
    assertCurrent();
    if (!path.startsWith('.obsidian/plugins/') || !app.sync.exclusions.some(p => path === p || path.startsWith(p + '/')))
      throw new Error('MOCK: plugin is not excluded');
  };
  const assertBackupExcluded = path => { assertCurrent(); if (!path.startsWith('.device-plugin-sync-trash/')) throw new Error('MOCK: invalid backup path'); };
  assertCurrent();
  return { assertCurrent, assertExcluded, assertBackupExcluded, unload: async id => {
    assertExcluded('.obsidian/plugins/' + id); app.unloaded.push(id);
    app.fileEvents.push('unload:' + id);
  } };
}`;
before(async () => {
  Object.assign(globalThis, { document: dom.window.document, HTMLElement: dom.window.HTMLElement, HTMLInputElement: dom.window.HTMLInputElement });
  const result = await build({ stdin: { contents: `export { default as Subject } from './src/main'; export * from './tests/fixtures/obsidian';`, resolveDir: root },
    bundle: true, write: false, platform: 'node', format: 'cjs', plugins: [{ name: 'ui-test-doubles', setup(b) {
      b.onResolve({ filter: /^obsidian$/ }, () => ({ path: path.join(root, 'tests/fixtures/obsidian.ts') }));
      b.onResolve({ filter: /^\.\/sync-adapter$/ }, () => ({ path: 'sync-adapter', namespace: 'mock' }));
      b.onResolve({ filter: /^\.\/cleanup-adapter$/ }, () => ({ path: 'cleanup-adapter', namespace: 'mock-cleanup' }));
      b.onLoad({ filter: /.*/, namespace: 'mock' }, () => ({ contents: adapterMock, loader: 'js' }));
      b.onLoad({ filter: /.*/, namespace: 'mock-cleanup' }, () => ({ contents: cleanupAdapterMock, loader: 'js' }));
    } }] });
  const mod = { exports: {} }; new Function('module', 'exports', result.outputFiles[0].text)(mod, mod.exports);
  runtime = mod.exports; runtime.installDomExtensions(dom.window); Object.assign(globalThis, { window: runtime.mockWindow });
});
beforeEach(() => { document.body.replaceChildren(); runtime.Platform.isMobile = false; runtime.language.value = 'zh'; runtime.notices.length = 0; runtime.modals.length = 0; runtime.timers.timeouts.clear(); runtime.timers.intervals.clear(); });
const flush = () => new Promise<void>(resolve => setImmediate(resolve));
function button(scope: ParentNode, text: string): HTMLButtonElement {
  const el = [...scope.querySelectorAll('button')].find(b => b.textContent === text);
  assert.ok(el, `missing button: ${text}`); return el;
}
async function click(scope: ParentNode, text: string) { button(scope, text).click(); await flush(); }
const modal = (): HTMLElement => { assert.ok(runtime.modals.length); return runtime.modals.at(-1).contentEl; };
function createApp(shared?: Map<string, string>) {
  const files = shared ?? new Map<string, string>(); const local = new Map(); const writes: string[] = [];
  if (!shared) {
    for (const id of ['alpha', 'beta', 'external', 'device-plugin-sync']) {
      files.set(`.obsidian/plugins/${id}/manifest.json`, JSON.stringify({ id, name: id }));
      files.set(`.obsidian/plugins/${id}/main.js`, `existing ${id}`);
      files.set(`.obsidian/plugins/${id}/data.json`, `{"preserve":"${id}"}`);
    }
    files.set('.obsidian/community-plugins.json', '["alpha","beta"]');
  }
  const folders = new Set(['.obsidian/plugins', ...[...files.keys()].map(p => p.slice(0, p.lastIndexOf('/')))]);
  const fileEvents: string[] = []; const unloaded: string[] = [];
  const events = new Map<string, Set<(file: { path: string }) => void>>(); const ready: (() => void)[] = [];
  const app: any = { files, folders, fileEvents, unloaded, writes, local, events, ready,
    emit: (event: string, path: string) => { for (const callback of events.get(event) ?? []) callback({ path }); },
    workspace: { onLayoutReady: (callback: () => void) => { ready.push(callback); } }, sync: { exclusions: ['Private', '.obsidian/plugins/external'], writes: 0, eligible: true, paused: false, syncing: false },
    loadLocalStorage: (key: string) => local.get(key), saveLocalStorage: (key: string, value: unknown) => local.set(key, structuredClone(value)),
    vault: { configDir: '.obsidian',
      on: (event: string, callback: (file: { path: string }) => void) => {
        if (!events.has(event)) events.set(event, new Set()); events.get(event)!.add(callback);
        return { dispose: () => events.get(event)!.delete(callback) };
      },
      getAbstractFileByPath: (p: string) => files.has(p) ? new runtime.TFile(p) : folders.has(p) ? new runtime.TFolder(p) : null,
      read: async (file: any) => files.get(file.path),
      createFolder: async (p: string) => { folders.add(p); writes.push(`folder:${p}`); },
      create: async (p: string, text: string) => { assert.ok(!files.has(p)); files.set(p, text); writes.push(p); },
      process: async (file: any, fn: (text: string) => string) => { const text = fn(files.get(file.path)!); files.set(file.path, text); writes.push(file.path); },
      adapter: { exists: async (p: string) => files.has(p) || folders.has(p),
        stat: async (p: string) => folders.has(p) ? { type: 'folder' } : files.has(p) ? { type: 'file' } : null,
        read: async (p: string) => { if (!files.has(p)) throw new Error('file not found'); return files.get(p); },
        write: async (p: string, data: string) => { files.set(p, data); fileEvents.push('write:' + p); },
        mkdir: async (p: string) => { assert.ok(!files.has(p) && !folders.has(p)); folders.add(p); fileEvents.push('mkdir:' + p); },
        rename: async (from: string, to: string) => {
          assert.ok(folders.has(from)); assert.ok(!files.has(to) && !folders.has(to));
          for (const folder of [...folders]) if (folder === from || folder.startsWith(from + '/')) { folders.delete(folder); folders.add(to + folder.slice(from.length)); }
          for (const [file, data] of [...files]) if (file.startsWith(from + '/')) { files.delete(file); files.set(to + file.slice(from.length), data); }
          fileEvents.push('rename:' + from + '->' + to);
        },
        list: async (p: string) => ({ folders: [...folders].filter(f => f.startsWith(p + '/') && !f.slice(p.length + 1).includes('/')),
          files: [...files.keys()].filter(f => f.startsWith(p + '/') && !f.slice(p.length + 1).includes('/')) }) } } };
  return app;
}
async function launch(app = createApp(), mobile = false) {
  runtime.Platform.isMobile = mobile; const plugin = new runtime.Subject(app); await plugin.onload();
  await plugin.tab.render(plugin.tab.containerEl); return { app, plugin, el: plugin.tab.containerEl as HTMLElement };
}
async function desktop() { const h = await launch(); await click(h.el, '创建同步清单'); return h; }
function existingFiles(app: any) { return [...app.files.entries()].filter(([p]) => p.startsWith('.obsidian/')); }
function syncBox(device: string, plugin: string): HTMLInputElement {
  const el = modal().querySelector<HTMLInputElement>(`input[aria-label="${device} 同步 ${plugin}"]`);
  assert.ok(el, `missing sync checkbox: ${device}/${plugin}`); return el;
}
async function columnAction(device: string, action: '全选' | '全不选') {
  const el = modal().querySelector<HTMLButtonElement>(`button[aria-label="${device} ${action}"]`);
  assert.ok(el, `missing column action: ${device}/${action}`); el.click(); await flush();
}
function columnChecked(device: string, checked: boolean, ids = ['alpha', 'beta', 'external']) {
  for (const id of ids) assert.equal(syncBox(device, id).checked, checked, `${device}/${id}`);
}

test('mock UI: startup has no Sync or vault writes; initialization only creates policy and its folder', async () => {
  const app = createApp(); const existing = existingFiles(app); const h = await launch(app);
  assert.deepEqual(existingFiles(h.app), existing); assert.equal(h.app.sync.writes, 0); assert.deepEqual(h.app.writes, []); assert.ok(!h.app.files.has(POLICY_PATH));
  await click(h.el, '创建同步清单');
  const policy = parsePolicy(h.app.files.get(POLICY_PATH));
  assert.equal(policy.revision, 1); assert.equal(policy.authorityId, h.plugin.local.installationId);
  assert.deepEqual(policy.devices.map(d => d.kind), ['desktop', 'phone', 'tablet']);
  for (const device of policy.devices) assert.deepEqual(device.excludedPluginIds, device.kind === 'desktop' ? [] : policy.plugins.map(p => p.id));
  assert.ok(!policy.plugins.some(p => p.id === 'device-plugin-sync'));
  assert.deepEqual(h.app.writes, ['folder:Device Plugin Sync', POLICY_PATH]);
  assert.equal(h.app.sync.writes, 0); assert.deepEqual(existingFiles(h.app), existing);
});

test('mock UI: matrix publishes only on click and rejects stale editor revisions', async () => {
  const h = await desktop(); await click(h.el, '选择各设备的插件');
  assert.equal(syncBox('我的手机', 'alpha').checked, false); syncBox('我的手机', 'alpha').click();
  assert.equal(syncBox('我的手机', 'alpha').checked, true);
  assert.equal(parsePolicy(h.app.files.get(POLICY_PATH)).revision, 1);
  await click(modal(), '保存清单'); const policy = parsePolicy(h.app.files.get(POLICY_PATH));
  assert.equal(policy.revision, 2); assert.deepEqual(policy.devices.find(d => d.kind === 'phone')!.excludedPluginIds, ['beta', 'external']);
  assert.deepEqual(policy.devices.find(d => d.kind === 'tablet')!.excludedPluginIds, ['alpha', 'beta', 'external']); assert.equal(h.app.sync.writes, 0);
  await click(h.el, '选择各设备的插件'); const changed = h.app.files.get(POLICY_PATH) + '\nRemote edit\n'; h.app.files.set(POLICY_PATH, changed);
  await click(modal(), '保存清单'); assert.equal(h.app.files.get(POLICY_PATH), changed);
  assert.ok(runtime.notices.some((n: string) => n.includes('同步清单已更新')));
});

test('mock UI: mobile binding is local; experiment does not apply until manual confirmation', async () => {
  const source = await desktop(); const policy = parsePolicy(source.app.files.get(POLICY_PATH));
  policy.devices.find(d => d.kind === 'phone')!.excludedPluginIds = ['alpha'];
  policy.devices.find(d => d.kind === 'tablet')!.excludedPluginIds = ['beta'];
  source.app.files.set(POLICY_PATH, serializePolicy(policy)); const shared = source.app.files.get(POLICY_PATH);
  const h = await launch(createApp(source.app.files), true); const existing = existingFiles(h.app);
  const select = h.el.querySelector<HTMLSelectElement>('[data-name="这台设备叫什么"] select')!; select.value = policy.devices.find(d => d.kind === 'phone')!.id;
  select.dispatchEvent(new dom.window.Event('change')); await click(h.el, '使用这个名称');
  await click(h.el, '查看并应用'); assert.equal(button(modal(), '确认应用').disabled, true);
  await click(modal(), '取消');
  (h.el.querySelector('[data-name="允许在这台手机或平板上修改同步设置（实验功能）"] input') as HTMLInputElement).click(); await flush();
  assert.equal(h.plugin.local.mobileExperimentalVersion, '1.13.7'); assert.equal(h.app.sync.writes, 0);
  await click(h.el, '查看并应用'); assert.match(modal().textContent!, /plugins\/alpha/); assert.doesNotMatch(modal().textContent!, /plugins\/beta/);
  await click(modal(), '确认应用');
  assert.deepEqual(h.app.sync.exclusions, ['Private', '.obsidian/plugins/external', '.obsidian/plugins/alpha']);
  assert.equal(h.app.sync.writes, 1); assert.deepEqual(existingFiles(h.app), existing); assert.equal(h.app.files.get(POLICY_PATH), shared);
  const tablet = await launch(createApp(source.app.files), true);
  assert.equal(tablet.plugin.local.mobileExperimentalVersion, undefined); assert.equal(tablet.plugin.local.deviceId, null);
  const tabletSelect = tablet.el.querySelector<HTMLSelectElement>('[data-name="这台设备叫什么"] select')!; tabletSelect.value = policy.devices.find(d => d.kind === 'tablet')!.id;
  tabletSelect.dispatchEvent(new dom.window.Event('change')); await click(tablet.el, '使用这个名称');
  await click(tablet.el, '查看并应用'); assert.match(modal().textContent!, /plugins\/beta/); assert.doesNotMatch(modal().textContent!, /plugins\/alpha/);
  assert.equal(button(modal(), '确认应用').disabled, true); assert.equal(tablet.app.sync.writes, 0);
});

for (const state of ['missing', 'corrupt'] as const) test(`mock UI: restore owned exclusions with ${state} policy preserves external rules and plugin files`, async () => {
  const h = await desktop(); const existing = existingFiles(h.app);
  h.plugin.saveLocal({ ...h.plugin.local, ownedPaths: ['.obsidian/plugins/alpha'] }); h.app.sync.exclusions.push('.obsidian/plugins/alpha');
  if (state === 'missing') h.app.files.delete(POLICY_PATH); else h.app.files.set(POLICY_PATH, 'broken policy');
  await h.plugin.tab.render(h.el); await click(h.el, '查看将恢复同步的插件');
  assert.equal(h.app.sync.writes, 0); assert.equal(button(modal(), '确认应用').disabled, false);
  await click(modal(), '确认应用');
  assert.deepEqual(h.app.sync.exclusions, ['Private', '.obsidian/plugins/external']); assert.deepEqual(h.plugin.local.ownedPaths, []);
  assert.equal(h.app.sync.writes, 1); assert.deepEqual(existingFiles(h.app), existing);
  assert.equal(h.app.files.get(POLICY_PATH), state === 'missing' ? undefined : 'broken policy');
});


test('mock UI: a changed shared policy invalidates an already-open apply preview', async () => {
  const h = await desktop(); const policy = parsePolicy(h.app.files.get(POLICY_PATH));
  policy.devices.find(d => d.kind === 'desktop')!.excludedPluginIds = ['alpha'];
  h.app.files.set(POLICY_PATH, serializePolicy(policy)); await h.plugin.tab.render(h.el);
  await click(h.el, '查看并应用'); assert.equal(button(modal(), '确认应用').disabled, false);
  const changed = h.app.files.get(POLICY_PATH) + '\nChanged after preview\n'; h.app.files.set(POLICY_PATH, changed);
  await click(modal(), '确认应用');
  assert.equal(h.app.sync.writes, 0); assert.deepEqual(h.app.sync.exclusions, ['Private', '.obsidian/plugins/external']);
  assert.equal(h.app.files.get(POLICY_PATH), changed); assert.deepEqual(h.plugin.local.ownedPaths, []);
  assert.ok(runtime.notices.some((n: string) => n.includes('同步清单已更新，请重新查看')));
});


test('mock UI: column all/none changes only its draft, persists on publish, and cancellation discards edits', async () => {
  const h = await desktop(); const original = h.app.files.get(POLICY_PATH); await click(h.el, '选择各设备的插件');
  columnChecked('我的电脑', true); columnChecked('我的手机', false); columnChecked('我的 iPad', false);
  assert.equal(modal().querySelector('input[aria-label*="device-plugin-sync"]'), null);
  await columnAction('我的手机', '全选'); columnChecked('我的手机', true);
  columnChecked('我的电脑', true); columnChecked('我的 iPad', false); assert.equal(h.app.files.get(POLICY_PATH), original);
  await columnAction('我的手机', '全不选'); columnChecked('我的手机', false);
  await columnAction('我的手机', '全选'); await click(modal(), '保存清单');
  let policy = parsePolicy(h.app.files.get(POLICY_PATH));
  assert.deepEqual(policy.devices.find(d => d.kind === 'phone')!.excludedPluginIds, []);
  assert.deepEqual(policy.devices.find(d => d.kind === 'tablet')!.excludedPluginIds, ['alpha', 'beta', 'external']);
  await click(h.el, '选择各设备的插件'); await columnAction('我的电脑', '全不选'); await click(modal(), '保存清单');
  policy = parsePolicy(h.app.files.get(POLICY_PATH));
  assert.deepEqual(policy.devices.find(d => d.kind === 'desktop')!.excludedPluginIds, ['alpha', 'beta', 'external']);
  assert.deepEqual(policy.devices.find(d => d.kind === 'phone')!.excludedPluginIds, []);
  const published = h.app.files.get(POLICY_PATH); await click(h.el, '选择各设备的插件');
  await columnAction('我的手机', '全不选'); await columnAction('我的 iPad', '全选'); await click(modal(), '取消');
  assert.equal(h.app.files.get(POLICY_PATH), published); assert.equal(h.app.sync.writes, 0);
  await click(h.el, '选择各设备的插件'); columnChecked('我的电脑', false); columnChecked('我的手机', true); columnChecked('我的 iPad', false);
});

test('mock UI: added desktop devices default allowed while added phones and tablets default excluded', async () => {
  const h = await desktop(); const original = h.app.files.get(POLICY_PATH); await click(h.el, '选择各设备的插件');
  for (const kind of ['desktop', 'phone', 'tablet']) {
    const row = modal().querySelector('[data-name="添加设备"]')!;
    const name = row.querySelector('input')!; name.value = `Extra ${kind}`; name.dispatchEvent(new dom.window.Event('change'));
    const select = row.querySelector('select')!; select.value = kind; select.dispatchEvent(new dom.window.Event('change'));
    await click(row, '添加'); columnChecked(`Extra ${kind}`, kind === 'desktop');
  }
  assert.equal(h.app.files.get(POLICY_PATH), original); await click(modal(), '保存清单');
  const policy = parsePolicy(h.app.files.get(POLICY_PATH)); assert.equal(policy.devices.length, 6);
  for (const device of policy.devices) assert.deepEqual(device.excludedPluginIds, device.kind === 'desktop' ? [] : ['alpha', 'beta', 'external']);
  assert.equal(h.app.sync.writes, 0);
});

test('mock UI: newly discovered plugins use platform defaults without replacing earlier choices', async () => {
  const h = await desktop(); const policy = parsePolicy(h.app.files.get(POLICY_PATH));
  policy.revision = 2; policy.plugins = policy.plugins.filter(p => p.id !== 'beta');
  for (const device of policy.devices) device.excludedPluginIds = device.kind === 'phone' ? ['external'] : ['alpha'];
  const original = serializePolicy(policy); h.app.files.set(POLICY_PATH, original); await h.plugin.tab.render(h.el);
  await click(h.el, '选择各设备的插件');
  assert.equal(syncBox('我的电脑', 'beta').checked, true); assert.equal(syncBox('我的手机', 'beta').checked, false); assert.equal(syncBox('我的 iPad', 'beta').checked, false);
  assert.equal(syncBox('我的电脑', 'alpha').checked, false); assert.equal(syncBox('我的手机', 'alpha').checked, true);
  assert.equal(syncBox('我的手机', 'external').checked, false); assert.equal(syncBox('我的 iPad', 'external').checked, true);
  assert.equal(h.app.files.get(POLICY_PATH), original); await click(modal(), '保存清单');
  const saved = parsePolicy(h.app.files.get(POLICY_PATH)); assert.equal(saved.revision, 3);
  assert.deepEqual(saved.plugins.map(p => p.id), ['alpha', 'beta', 'external']);
  assert.deepEqual(saved.devices.find(d => d.kind === 'desktop')!.excludedPluginIds, ['alpha']);
  assert.deepEqual(saved.devices.find(d => d.kind === 'phone')!.excludedPluginIds.sort(), ['beta', 'external']);
  assert.deepEqual(saved.devices.find(d => d.kind === 'tablet')!.excludedPluginIds.sort(), ['alpha', 'beta']);
  assert.equal(h.app.sync.writes, 0);
});

test('mock UI: untouched legacy r1 template receives mobile defaults only in the editor draft until publication', async () => {
  const h = await desktop(); const policy = parsePolicy(h.app.files.get(POLICY_PATH));
  for (const device of policy.devices) device.excludedPluginIds = [];
  const original = serializePolicy(policy); h.app.files.set(POLICY_PATH, original); await h.plugin.tab.render(h.el);
  await click(h.el, '选择各设备的插件'); columnChecked('我的电脑', true); columnChecked('我的手机', false); columnChecked('我的 iPad', false);
  assert.equal(h.app.files.get(POLICY_PATH), original); await click(modal(), '取消'); assert.equal(h.app.files.get(POLICY_PATH), original);
  await click(h.el, '选择各设备的插件'); await click(modal(), '保存清单');
  const saved = parsePolicy(h.app.files.get(POLICY_PATH)); assert.equal(saved.revision, 2);
  for (const device of saved.devices) assert.deepEqual(device.excludedPluginIds, device.kind === 'desktop' ? [] : ['alpha', 'beta', 'external']);
  assert.equal(h.app.sync.writes, 0);
});

for (const scenario of ['published r2 allows all', 'customized r1'] as const) test(`mock UI: ${scenario} choices survive opening and publishing the inverted matrix`, async () => {
  const h = await desktop(); const policy = parsePolicy(h.app.files.get(POLICY_PATH));
  policy.revision = scenario === 'published r2 allows all' ? 2 : 1;
  for (const device of policy.devices) device.excludedPluginIds = scenario === 'customized r1' && device.kind === 'phone' ? ['alpha'] : [];
  const original = serializePolicy(policy); h.app.files.set(POLICY_PATH, original); await h.plugin.tab.render(h.el);
  await click(h.el, '选择各设备的插件'); columnChecked('我的电脑', true); columnChecked('我的 iPad', true);
  assert.equal(syncBox('我的手机', 'alpha').checked, scenario !== 'customized r1'); columnChecked('我的手机', true, ['beta', 'external']);
  assert.equal(h.app.files.get(POLICY_PATH), original); await click(modal(), '保存清单');
  const saved = parsePolicy(h.app.files.get(POLICY_PATH)); assert.equal(saved.revision, policy.revision + 1);
  assert.deepEqual(saved.devices, policy.devices); assert.equal(h.app.sync.writes, 0);
});


async function mobileEditor(kind: 'phone' | 'tablet' = 'phone', optIn = true) {
  const source = await desktop(); const policy = parsePolicy(source.app.files.get(POLICY_PATH)); policy.revision = 4;
  for (const device of policy.devices) device.excludedPluginIds = [device.kind === 'phone' ? 'alpha' : device.kind === 'tablet' ? 'beta' : 'external'];
  // Shared catalog plugins are absent locally; the local-only plugin must never leak into the matrix.
  const files = new Map([
    [POLICY_PATH, serializePolicy(policy)], ['.obsidian/community-plugins.json', '["local-only"]'],
    ['.obsidian/plugins/local-only/manifest.json', '{"id":"local-only","name":"local-only"}'],
    ['.obsidian/plugins/local-only/main.js', 'untouched local code'], ['.obsidian/plugins/local-only/data.json', '{"keep":true}'],
  ]);
  const h = await launch(createApp(files), true); let catalogCalls = 0;
  h.plugin.catalog = async () => { catalogCalls++; throw new Error('mobile editor must not call local catalog'); };
  assert.equal(button(h.el, '选择本机插件').disabled, true);
  assert.equal([...h.el.querySelectorAll('option')].some(o => o.value === policy.devices.find(d => d.kind === 'desktop')!.id), false);
  const device = policy.devices.find(d => d.kind === kind)!; const select = h.el.querySelector<HTMLSelectElement>('[data-name="这台设备叫什么"] select')!;
  select.value = device.id; select.dispatchEvent(new dom.window.Event('change')); await click(h.el, '使用这个名称');
  if (optIn) { (h.el.querySelector('[data-name="允许在这台手机或平板上修改同步设置（实验功能）"] input') as HTMLInputElement).click(); await flush(); }
  return { ...h, policy, device, catalogCalls: () => catalogCalls };
}
async function editedMobilePreview(h: Awaited<ReturnType<typeof mobileEditor>>) {
  await click(h.el, '选择本机插件');
  syncBox(h.device.name, h.device.kind === 'phone' ? 'beta' : 'alpha').click();
  await click(modal(), '保存并应用');
}

for (const kind of ['phone', 'tablet'] as const) test(`mock UI: ${kind} edits only its shared-catalog column and saves only after final confirmation`, async () => {
  const h = await mobileEditor(kind); const original = h.app.files.get(POLICY_PATH); const files = existingFiles(h.app);
  await click(h.el, '选择本机插件');
  assert.equal(modal().querySelectorAll('th').length, 2); assert.equal(modal().querySelectorAll('input[type="checkbox"]').length, h.policy.plugins.length);
  assert.equal(modal().querySelector('[data-name="添加设备"]'), null);
  assert.equal(modal().querySelector('[data-name^="设备名称"]'), null); assert.equal(modal().querySelector('select'), null);
  assert.equal(modal().querySelector('input[aria-label*="local-only"]'), null);
  assert.equal(modal().querySelector('input[aria-label*="device-plugin-sync"]'), null);
  for (const plugin of h.policy.plugins) assert.equal(syncBox(h.device.name, plugin.id).checked, !h.device.excludedPluginIds.includes(plugin.id));
  for (const other of h.policy.devices.filter(d => d.id !== h.device.id)) assert.equal(modal().querySelector(`input[aria-label^="${other.name} 同步"]`), null);
  syncBox(h.device.name, kind === 'phone' ? 'beta' : 'alpha').click(); await click(modal(), '保存并应用');
  assert.equal(h.app.files.get(POLICY_PATH), original); assert.deepEqual(h.app.writes, []); assert.equal(h.app.sync.writes, 0);
  assert.equal(button(modal(), '确认保存并应用').disabled, false); await click(modal(), '确认保存并应用');
  const saved = parsePolicy(h.app.files.get(POLICY_PATH)); const expected = structuredClone(h.policy); expected.revision++;
  expected.devices.find(d => d.id === h.device.id)!.excludedPluginIds = saved.devices.find(d => d.id === h.device.id)!.excludedPluginIds;
  assert.deepEqual(saved.devices.find(d => d.id === h.device.id)!.excludedPluginIds.slice().sort(), ['alpha', 'beta']);
  assert.deepEqual(saved, expected); assert.deepEqual(h.app.writes, [POLICY_PATH]); assert.equal(h.app.sync.writes, 1);
  assert.deepEqual(h.app.sync.exclusions.slice().sort(), ['.obsidian/plugins/alpha', '.obsidian/plugins/beta', '.obsidian/plugins/external', 'Private']);
  assert.deepEqual(existingFiles(h.app), files); assert.equal(h.catalogCalls(), 0); assert.equal(h.plugin.local.lastApplied.revision, 5);
});

test('mock UI: mobile all/none and either cancel stage leave shared policy unchanged until confirmation', async () => {
  const h = await mobileEditor(); const original = h.app.files.get(POLICY_PATH);
  await click(h.el, '选择本机插件'); await columnAction(h.device.name, '全选'); columnChecked(h.device.name, true);
  await columnAction(h.device.name, '全不选'); columnChecked(h.device.name, false); await click(modal(), '取消');
  assert.equal(h.app.files.get(POLICY_PATH), original); assert.equal(h.app.sync.writes, 0);
  await click(h.el, '选择本机插件'); assert.equal(syncBox(h.device.name, 'alpha').checked, false); assert.equal(syncBox(h.device.name, 'beta').checked, true);
  await columnAction(h.device.name, '全选'); await click(modal(), '保存并应用'); await click(modal(), '取消');
  assert.equal(h.app.files.get(POLICY_PATH), original); assert.equal(h.app.sync.writes, 0);
  await click(h.el, '选择本机插件'); await columnAction(h.device.name, '全不选'); await click(modal(), '保存并应用');
  await click(modal(), '确认保存并应用'); const saved = parsePolicy(h.app.files.get(POLICY_PATH));
  assert.deepEqual(saved.devices.find(d => d.id === h.device.id)!.excludedPluginIds.slice().sort(), ['alpha', 'beta', 'external']);
  assert.deepEqual(saved.devices.filter(d => d.id !== h.device.id), h.policy.devices.filter(d => d.id !== h.device.id));
  assert.equal(h.app.sync.writes, 1); assert.equal(h.catalogCalls(), 0);
});

test('mock UI: applying an unchanged mobile column does not increment or rewrite policy revision', async () => {
  const h = await mobileEditor(); const original = h.app.files.get(POLICY_PATH);
  await click(h.el, '选择本机插件'); await click(modal(), '保存并应用'); await click(modal(), '确认保存并应用');
  assert.equal(h.app.files.get(POLICY_PATH), original); assert.deepEqual(h.app.writes, []);
  assert.equal(h.plugin.local.lastApplied.revision, 4); assert.equal(h.app.sync.writes, 1);
});

for (const gate of ['no local opt-in', 'compatibility rejected'] as const) test(`mock UI: mobile ${gate} keeps final save/apply disabled and policy untouched`, async () => {
  const h = await mobileEditor('phone', gate !== 'no local opt-in'); const original = h.app.files.get(POLICY_PATH);
  if (gate === 'compatibility rejected') h.app.sync.eligible = false;
  await editedMobilePreview(h); assert.equal(button(modal(), '确认保存并应用').disabled, true);
  await click(modal(), '确认保存并应用'); assert.equal(h.app.files.get(POLICY_PATH), original);
  assert.deepEqual(h.app.writes, []); assert.equal(h.app.sync.writes, 0);
});

for (const changed of ['policy', 'binding', 'desktop binding', 'native list', 'ownership', 'pending', 'compatibility', 'opt-in'] as const) {
  test(`mock UI: mobile ${changed} changed after preview blocks policy and native writes`, async () => {
    const h = await mobileEditor(); await editedMobilePreview(h);
    assert.equal(button(modal(), '确认保存并应用').disabled, false);
    if (changed === 'policy') h.app.files.set(POLICY_PATH, h.app.files.get(POLICY_PATH) + '\nExternal edit\n');
    if (changed === 'binding' || changed === 'desktop binding') h.plugin.saveLocal({ ...h.plugin.local, deviceId: h.policy.devices.find(d => d.kind === (changed === 'binding' ? 'tablet' : 'desktop'))!.id });
    if (changed === 'native list') h.app.sync.exclusions.push('External added while preview open');
    if (changed === 'ownership') h.plugin.saveLocal({ ...h.plugin.local, ownedPaths: ['.obsidian/plugins/external'] });
    if (changed === 'pending') h.plugin.saveLocal({ ...h.plugin.local, pending: { before: [...h.app.sync.exclusions], after: [...h.app.sync.exclusions], ownedBefore: [], ownedAfter: [] } });
    if (changed === 'compatibility') h.app.sync.eligible = false;
    if (changed === 'opt-in') h.plugin.saveLocal({ ...h.plugin.local, mobileExperimentalVersion: undefined });
    const current = h.app.files.get(POLICY_PATH); const native = [...h.app.sync.exclusions];
    await click(modal(), '确认保存并应用');
    assert.equal(h.app.files.get(POLICY_PATH), current); assert.deepEqual(h.app.writes, []);
    assert.equal(h.app.sync.writes, 0); assert.deepEqual(h.app.sync.exclusions, native);
  });
}

test('mock UI: native failure after mobile publication retains saved policy and reports local apply incomplete', async () => {
  const h = await mobileEditor(); const files = existingFiles(h.app); await editedMobilePreview(h); h.app.sync.failWrite = true;
  await click(modal(), '确认保存并应用');
  const saved = parsePolicy(h.app.files.get(POLICY_PATH)); assert.equal(saved.revision, 5);
  assert.deepEqual(saved.devices.find(d => d.id === h.device.id)!.excludedPluginIds.slice().sort(), ['alpha', 'beta']);
  assert.deepEqual(saved.devices.filter(d => d.id !== h.device.id), h.policy.devices.filter(d => d.id !== h.device.id));
  assert.equal(h.app.sync.writes, 1); assert.ok(h.plugin.local.pending); assert.equal(h.plugin.local.lastApplied, undefined);
  assert.deepEqual(existingFiles(h.app), files);
  assert.ok(runtime.notices.some((notice: string) => /选择.*已保存/.test(notice) && /(未完成|失败)/.test(notice)));
  assert.equal([...document.querySelectorAll('button')].some(b => b.textContent === '确认保存并应用'), false);
});

for (const changed of ['binding', 'compatibility', 'native list'] as const) test(`mock UI: ${changed} changing while policy save completes reports partial success without native apply`, async () => {
  const h = await mobileEditor(); await editedMobilePreview(h); const process = h.app.vault.process;
  h.app.vault.process = async (file: unknown, update: unknown) => {
    await process(file, update);
    if (changed === 'binding') h.plugin.saveLocal({ ...h.plugin.local, deviceId: h.policy.devices.find(d => d.kind === 'tablet')!.id });
    if (changed === 'compatibility') h.app.sync.eligible = false;
    if (changed === 'native list') h.app.sync.exclusions.push('Concurrent user exclusion');
  };
  await click(modal(), '确认保存并应用');
  assert.equal(parsePolicy(h.app.files.get(POLICY_PATH)).revision, 5); assert.deepEqual(h.app.writes, [POLICY_PATH]);
  assert.equal(h.app.sync.writes, 0); assert.equal(h.plugin.local.lastApplied, undefined);
  assert.deepEqual(h.app.sync.exclusions, ['Private', '.obsidian/plugins/external', ...(changed === 'native list' ? ['Concurrent user exclusion'] : [])]);
  assert.ok(runtime.notices.some((notice: string) => /选择.*已保存/.test(notice) && /没有完成/.test(notice)));
  assert.equal([...document.querySelectorAll('button')].some(b => b.textContent === '确认保存并应用'), false);
});

test('mock UI: a new English installation exposes an English editor, preview, and troubleshooting', async () => {
  runtime.language.value = 'en';
  const h = await launch();
  assert.equal(h.plugin.local.language, 'auto');
  assert.match(h.el.textContent!, /Interface language/);
  assert.match(h.el.textContent!, /Troubleshooting \(usually not needed\)/);
  assert.ok(button(h.el, 'Create sync list'));
  await click(h.el, 'Create sync list');
  const policy = parsePolicy(h.app.files.get(POLICY_PATH));
  assert.deepEqual(policy.devices.map(d => d.name), ['My computer', 'My phone', 'My iPad']);
  await click(h.el, 'Choose plugins for devices');
  assert.ok(modal().querySelector('input[aria-label="Sync alpha on My phone"]'));
  assert.ok(button(modal(), 'Select all'));
  assert.ok(button(modal(), 'Save list'));
  await click(modal(), 'Cancel');
  await click(h.el, 'Review and apply');
  assert.match(modal().textContent!, /Will stop syncing/);
  assert.match(modal().textContent!, /Will be allowed to sync again/);
  assert.ok(button(modal(), 'Apply changes'));
  await click(modal(), 'Cancel');
  const details = [...h.el.querySelectorAll('details')].find(el => el.querySelector('summary')?.textContent === 'Troubleshooting (usually not needed)')!;
  assert.equal(details.open, false);
  assert.match(details.textContent!, /Existing Sync settings stay unchanged/);
  assert.match(details.textContent!, /will not resume any plugin/);
  assert.equal(h.app.sync.writes, 0);
});

test('mock UI: changing language is local, persists, and does not change policy or device names', async () => {
  const h = await desktop(); const policy = h.app.files.get(POLICY_PATH); const writes = [...h.app.writes];
  const select = h.el.querySelector<HTMLSelectElement>('[data-name="界面语言"] select')!;
  select.value = 'en'; select.dispatchEvent(new dom.window.Event('change')); await flush();
  assert.equal(h.plugin.local.language, 'en'); assert.ok(button(h.el, 'Choose plugins for devices'));
  assert.equal(h.app.files.get(POLICY_PATH), policy); assert.deepEqual(h.app.writes, writes); assert.equal(h.app.sync.writes, 0);
  assert.ok(h.el.textContent!.includes('我的电脑'));
  const reopened = await launch(h.app); assert.equal(reopened.plugin.local.language, 'en');
  assert.ok(button(reopened.el, 'Choose plugins for devices'));
});

test('mock UI: an existing installation remains Chinese after upgrade on English Obsidian', async () => {
  const h = await desktop(); const old = { ...h.plugin.local }; delete old.language;
  h.app.local.set('device-plugin-sync:local:v1', old); runtime.language.value = 'en';
  const upgraded = await launch(h.app);
  assert.equal(upgraded.plugin.local.language, 'zh'); assert.ok(button(upgraded.el, '选择各设备的插件'));
  const select = upgraded.el.querySelector<HTMLSelectElement>('[data-name="界面语言"] select')!;
  select.value = 'auto'; select.dispatchEvent(new dom.window.Event('change')); await flush();
  assert.equal(upgraded.plugin.local.language, 'auto'); assert.ok(button(upgraded.el, 'Choose plugins for devices'));
});

const cleanupTitle = '要清理本机不再同步的插件吗？';
const cleanupConfirm = '移走所选插件（保留备份）';
function settingToggle(scope: ParentNode, name: string): HTMLInputElement {
  const row = [...scope.querySelectorAll<HTMLElement>('.mock-setting')].find(el => el.dataset.name === name);
  const input = row?.querySelector<HTMLInputElement>('input[type="checkbox"]'); assert.ok(input, `missing toggle ${name}`); return input;
}
function chooseCleanup(id = 'alpha', english = false) {
  settingToggle(modal(), id).click();
  settingToggle(modal(), english ? 'I confirm moving the selected plugins and their local settings into a backup.' : '我确认移走所选插件及其本机设置，保留备份。').click();
}
async function appliedCleanup(mobile = false, english = false) {
  if (english) runtime.language.value = 'en';
  const source = await launch(); await click(source.el, english ? 'Create sync list' : '创建同步清单');
  const policy = parsePolicy(source.app.files.get(POLICY_PATH));
  const device = policy.devices.find(d => d.kind === (mobile ? 'phone' : 'desktop'))!;
  device.excludedPluginIds = ['alpha', 'beta']; source.app.files.set(POLICY_PATH, serializePolicy(policy));
  const h = mobile ? await launch(createApp(new Map(source.app.files)), true) : source;
  h.plugin.saveLocal({ ...h.plugin.local, deviceId: device.id, ...(mobile ? { mobileExperimentalVersion: '1.13.7' } : {}) });
  await h.plugin.tab.render(h.el);
  if (mobile) {
    await click(h.el, english ? 'Choose this device’s plugins' : '选择本机插件');
    await click(modal(), english ? 'Save and apply' : '保存并应用');
    await click(modal(), english ? 'Save and apply' : '确认保存并应用');
  } else {
    await click(h.el, english ? 'Review and apply' : '查看并应用');
    await click(modal(), english ? 'Apply changes' : '确认应用');
  }
  return h;
}

for (const mobile of [false, true]) test(`mock UI: ${mobile ? 'mobile' : 'desktop'} successful apply asks about installed exclusions without selecting or deleting them`, async () => {
  const h = await appliedCleanup(mobile);
  assert.equal(runtime.modals.at(-1).titleEl.textContent, cleanupTitle);
  assert.equal(h.app.sync.writes, 1); assert.ok(h.plugin.local.lastApplied);
  assert.equal(modal().querySelectorAll('input[type="checkbox"]').length, 3);
  for (const toggle of modal().querySelectorAll<HTMLInputElement>('input[type="checkbox"]')) assert.equal(toggle.checked, false);
  assert.equal(button(modal(), cleanupConfirm).disabled, true);
  assert.equal(modal().querySelector('[data-name="external"]'), null);
  assert.equal(modal().querySelector('[data-name="device-plugin-sync"]'), null);
  assert.deepEqual(h.app.fileEvents, []); assert.deepEqual(h.app.unloaded, []);
  const files = new Map(h.app.files); await click(modal(), '保留本机插件');
  assert.equal(runtime.modals.length, 0); assert.deepEqual(h.app.files, files); assert.deepEqual(h.app.fileEvents, []);
  await click(h.el, '选择要清理的插件'); assert.equal(runtime.modals.at(-1).titleEl.textContent, cleanupTitle);
  assert.equal(button(modal(), cleanupConfirm).disabled, true);
});

test('mock UI: checking only a plugin or only confirmation never enables cleanup', async () => {
  await appliedCleanup();
  const agreed = settingToggle(modal(), '我确认移走所选插件及其本机设置，保留备份。');
  const alpha = settingToggle(modal(), 'alpha');
  alpha.click(); assert.equal(button(modal(), cleanupConfirm).disabled, true);
  agreed.click(); assert.equal(button(modal(), cleanupConfirm).disabled, false);
  alpha.click(); assert.equal(button(modal(), cleanupConfirm).disabled, true);
});

for (const state of ['running', 'paused but busy'] as const) test(`mock UI: cleanup refuses Sync ${state} before any backup or file mutation`, async () => {
  const h = await appliedCleanup(); chooseCleanup();
  h.app.sync.paused = state === 'paused but busy'; h.app.sync.syncing = true;
  const files = new Map(h.app.files); const folders = new Set(h.app.folders);
  await click(modal(), cleanupConfirm);
  assert.deepEqual(h.app.files, files); assert.deepEqual(h.app.folders, folders);
  assert.deepEqual(h.app.fileEvents, []); assert.deepEqual(h.app.unloaded, []);
  assert.ok(runtime.notices.some((notice: string) => notice.includes('pause Sync')));
  assert.equal(runtime.modals.at(-1).titleEl.textContent, cleanupTitle);
});

test('mock UI: confirmed cleanup moves only selected plugin and settings to backup without changing enabled list or Sync choices', async () => {
  const h = await appliedCleanup(); const before = new Map<string, string>(h.app.files);
  const exclusions = [...h.app.sync.exclusions]; const policy = h.app.files.get(POLICY_PATH);
  h.app.sync.paused = true; chooseCleanup(); await click(modal(), cleanupConfirm);
  assert.equal(runtime.modals.at(-1).titleEl.textContent, '本机清理结果');
  assert.match(modal().textContent!, /已移走 1 个插件/);
  const folder = modal().querySelector('code')!.textContent!;
  assert.match(folder, /^\.device-plugin-sync-trash\/[a-f0-9-]{36}$/);
  assert.equal(h.app.files.has('.obsidian/plugins/alpha/main.js'), false);
  for (const file of ['manifest.json', 'main.js', 'data.json']) assert.equal(h.app.files.get(`${folder}/alpha/${file}`), before.get(`.obsidian/plugins/alpha/${file}`));
  for (const [file, data] of before) if (!file.startsWith('.obsidian/plugins/alpha/')) assert.equal(h.app.files.get(file), data);
  assert.deepEqual(h.app.unloaded, ['alpha']); assert.deepEqual(h.app.sync.exclusions, exclusions);
  assert.equal(h.app.sync.writes, 1); assert.equal(h.app.files.get(POLICY_PATH), policy);
  assert.ok(h.app.fileEvents.indexOf('unload:alpha') < h.app.fileEvents.findIndex((event: string) => event.startsWith('rename:')));
});

for (const changed of ['policy', 'binding', 'exclusions'] as const) test(`mock UI: cleanup rechecks ${changed} after the prompt and blocks all file writes`, async () => {
  const h = await appliedCleanup(); h.app.sync.paused = true; chooseCleanup();
  if (changed === 'policy') h.app.files.set(POLICY_PATH, h.app.files.get(POLICY_PATH) + '\nUpdated remotely\n');
  if (changed === 'binding') h.plugin.saveLocal({ ...h.plugin.local, deviceId: null });
  if (changed === 'exclusions') h.app.sync.exclusions = h.app.sync.exclusions.filter((p: string) => p !== '.obsidian/plugins/alpha');
  const files = new Map(h.app.files); const folders = new Set(h.app.folders);
  await click(modal(), cleanupConfirm);
  assert.deepEqual(h.app.files, files); assert.deepEqual(h.app.folders, folders);
  assert.deepEqual(h.app.fileEvents, []); assert.deepEqual(h.app.unloaded, []);
  assert.equal(runtime.modals.at(-1).titleEl.textContent, cleanupTitle);
});

test('mock UI: English cleanup and restoration remain local, never overwrite, and never auto-enable plugins', async () => {
  const h = await appliedCleanup(false, true);
  assert.equal(runtime.modals.at(-1).titleEl.textContent, 'Remove the excluded plugins from this device?');
  assert.equal(button(modal(), 'Remove selected plugins (keep backup)').disabled, true);
  const pluginFiles = new Map<string, string>([...h.app.files].filter(([file]: [string, string]) => file.startsWith('.obsidian/plugins/alpha/')));
  const enabled = h.app.files.get('.obsidian/community-plugins.json'); const exclusions = [...h.app.sync.exclusions];
  h.app.sync.paused = true; chooseCleanup('alpha', true); await click(modal(), 'Remove selected plugins (keep backup)');
  const folder = modal().querySelector('code')!.textContent!; await click(modal(), 'Done');
  await click(h.el, 'View local backups'); assert.match(modal().textContent!, /An existing plugin will never be overwritten/);
  h.app.folders.add('.obsidian/plugins/alpha'); h.app.files.set('.obsidian/plugins/alpha/main.js', 'new local installation');
  const events = [...h.app.fileEvents]; await click(modal(), 'Restore this plugin');
  assert.equal(h.app.files.get('.obsidian/plugins/alpha/main.js'), 'new local installation');
  assert.deepEqual(h.app.fileEvents, events); assert.ok(h.app.files.has(`${folder}/alpha/data.json`));
  assert.ok(runtime.notices.some((notice: string) => notice.includes('already exists locally')));
  h.app.folders.delete('.obsidian/plugins/alpha'); h.app.files.delete('.obsidian/plugins/alpha/main.js');
  await click(modal(), 'Restore this plugin');
  for (const [file, data] of pluginFiles) assert.equal(h.app.files.get(file), data);
  assert.equal(h.app.files.has(`${folder}/alpha/main.js`), false);
  assert.deepEqual(h.app.unloaded, ['alpha']); assert.equal(h.app.files.get('.obsidian/community-plugins.json'), enabled);
  assert.deepEqual(h.app.sync.exclusions, exclusions); assert.equal(h.app.sync.writes, 1);
  await click(h.el, 'View local backups'); assert.match(modal().textContent!, /There are no plugin backups to restore/);
});

test('mock UI: absent or unidentified local plugins do not trigger the automatic cleanup prompt', async () => {
  const h = await desktop(); const policy = parsePolicy(h.app.files.get(POLICY_PATH));
  policy.devices.find(d => d.kind === 'desktop')!.excludedPluginIds = ['alpha', 'beta'];
  h.app.files.set(POLICY_PATH, serializePolicy(policy));
  h.app.folders.delete('.obsidian/plugins/alpha');
  for (const file of [...h.app.files.keys()]) if (file.startsWith('.obsidian/plugins/alpha/')) h.app.files.delete(file);
  h.app.files.set('.obsidian/plugins/beta/manifest.json', '{"id":"different"}');
  await h.plugin.tab.render(h.el); await click(h.el, '查看并应用'); await click(modal(), '确认应用');
  assert.equal(runtime.modals.length, 0); assert.equal(h.app.sync.writes, 1); assert.deepEqual(h.app.fileEvents, []);
  await click(h.el, '选择要清理的插件'); assert.equal(runtime.modals.length, 0);
  assert.ok(runtime.notices.some((notice: string) => notice.includes('没有需要清理')));
});

test('mock UI: failed apply and undoing exclusions never open the cleanup prompt', async () => {
  const h = await desktop(); const policy = parsePolicy(h.app.files.get(POLICY_PATH));
  policy.devices.find(d => d.kind === 'desktop')!.excludedPluginIds = ['alpha']; h.app.files.set(POLICY_PATH, serializePolicy(policy));
  await h.plugin.tab.render(h.el); await click(h.el, '查看并应用'); h.app.sync.failWrite = true;
  await click(modal(), '确认应用');
  assert.ok(runtime.modals.every((entry: any) => entry.titleEl.textContent !== cleanupTitle));
  assert.deepEqual(h.app.fileEvents, []); await click(modal(), '取消');
  h.app.sync.failWrite = false; h.plugin.saveLocal({ ...h.plugin.local, pending: undefined, ownedPaths: ['.obsidian/plugins/alpha'] });
  await h.plugin.tab.render(h.el); await click(h.el, '查看将恢复同步的插件'); await click(modal(), '确认应用');
  assert.equal(runtime.modals.length, 0); assert.equal(h.plugin.local.lastApplied.revision, -1);
  assert.ok(h.app.files.has('.obsidian/plugins/alpha/main.js')); assert.deepEqual(h.app.fileEvents, []);
});

function syncRuleFiles(source: any, target: any) {
  for (const [file, data] of source.files as Map<string, string>) {
    if (!file.startsWith('Device Plugin Sync/')) continue;
    target.files.set(file, data);
    const parts = file.split('/');
    for (let count = 1; count < parts.length; count++) target.folders.add(parts.slice(0, count).join('/'));
  }
}
function installLocalFixture(app: any, id: string, name = id) {
  app.folders.add(`.obsidian/plugins/${id}`);
  app.files.set(`.obsidian/plugins/${id}/manifest.json`, JSON.stringify({ id, name }));
  app.files.set(`.obsidian/plugins/${id}/main.js`, `installed code:${id}`);
  app.files.set(`.obsidian/plugins/${id}/data.json`, `settings:${id}`);
}
async function automaticMobile(source: Awaited<ReturnType<typeof desktop>>, kind: 'phone' | 'tablet' = 'phone', optIn = true) {
  const h = await launch(createApp(new Map(source.app.files)), true);
  const policy = parsePolicy(h.app.files.get(POLICY_PATH));
  h.plugin.saveLocal({ ...h.plugin.local, deviceId: policy.devices.find(d => d.kind === kind)!.id,
    ...(optIn ? { mobileExperimentalVersion: '1.13.7' } : {}) });
  await h.plugin.checkNewPlugins();
  return h;
}
async function publishNewFromComputer(source: Awaited<ReturnType<typeof desktop>>, id = 'new-desktop-plugin') {
  runtime.Platform.isMobile = false;
  installLocalFixture(source.app, id);
  await source.plugin.recordInstallation({ id, name: id });
  await source.plugin.checkNewPlugins();
  return parsePolicy(source.app.files.get(POLICY_PATH));
}

test('mock lifecycle: first upgrade check establishes a baseline without applying older choices or touching plugin files', async () => {
  const source = await desktop(); const h = await launch(createApp(new Map(source.app.files)), true);
  const policy = parsePolicy(h.app.files.get(POLICY_PATH));
  h.plugin.saveLocal({ ...h.plugin.local, deviceId: policy.devices.find(d => d.kind === 'phone')!.id, mobileExperimentalVersion: '1.13.7' });
  const files = existingFiles(h.app); const exclusions = [...h.app.sync.exclusions];
  assert.equal(h.plugin.local.newPluginBaseline, undefined);
  await h.plugin.checkNewPlugins();
  assert.deepEqual(h.plugin.local.newPluginBaseline, { deviceId: h.plugin.local.deviceId, pluginIds: policy.plugins.map(p => p.id) });
  assert.deepEqual(h.app.sync.exclusions, exclusions); assert.equal(h.app.sync.writes, 0);
  assert.deepEqual(existingFiles(h.app), files); assert.deepEqual(h.app.writes, []); assert.equal(runtime.modals.length, 0);
});

test('mock lifecycle: a locally installed phone plugin publishes a receipt and defaults to all computers plus that phone only', async () => {
  const source = await desktop(); const old = parsePolicy(source.app.files.get(POLICY_PATH));
  old.devices.push({ id: 'second-desktop', name: 'Other computer', kind: 'desktop', excludedPluginIds: ['alpha'] });
  source.app.files.set(POLICY_PATH, serializePolicy(old));
  const phone = await automaticMobile(source); const tablet = await automaticMobile(source, 'tablet');
  runtime.Platform.isMobile = true;
  installLocalFixture(phone.app, 'phone-new', 'Phone new'); const files = existingFiles(phone.app);
  await phone.plugin.recordInstallation({ id: 'phone-new', name: 'Phone new' });
  assert.equal(phone.plugin.local.installationQueue.length, 1); assert.equal(phone.app.writes.length, 0);
  await phone.plugin.checkNewPlugins();
  const updated = parsePolicy(phone.app.files.get(POLICY_PATH));
  const phoneId = phone.plugin.local.deviceId;
  for (const device of updated.devices) {
    assert.equal(device.excludedPluginIds.includes('phone-new'), device.kind !== 'desktop' && device.id !== phoneId);
    assert.deepEqual(device.excludedPluginIds.filter(id => id !== 'phone-new'), old.devices.find(d => d.id === device.id)!.excludedPluginIds);
  }
  const receiptFile = [...phone.app.files.keys()].find((file: string) => file.endsWith('/phone-new.md'))!;
  const record = parseInstallation(phone.app.files.get(receiptFile), receiptFile);
  assert.equal(record.deviceId, phoneId); assert.equal(record.installationId, phone.plugin.local.installationId);
  assert.equal(phone.plugin.local.installationQueue.length, 0); assert.equal(phone.app.sync.writes, 0);
  assert.deepEqual(existingFiles(phone.app), files); assert.equal(runtime.modals.length, 0);
  syncRuleFiles(phone.app, tablet.app); await tablet.plugin.checkNewPlugins();
  assert.equal(tablet.app.sync.writes, 1); assert.ok(tablet.app.sync.exclusions.includes('.obsidian/plugins/phone-new'));
  assert.equal(tablet.plugin.local.lastApplied, undefined); assert.equal(runtime.modals.length, 0);
});

test('mock lifecycle: a new desktop ID is applied on a phone without applying older matrix changes', async () => {
  const source = await desktop(); const policy = parsePolicy(source.app.files.get(POLICY_PATH));
  policy.devices.find(d => d.kind === 'phone')!.excludedPluginIds = ['beta'];
  source.app.files.set(POLICY_PATH, serializePolicy(policy));
  const phone = await automaticMobile(source);
  phone.app.sync.exclusions.push('.obsidian/plugins/alpha');
  phone.plugin.saveLocal({ ...phone.plugin.local, ownedPaths: ['.obsidian/plugins/alpha'],
    lastApplied: { revision: policy.revision, paths: [...phone.app.sync.exclusions], appliedAt: new Date().toISOString(), sessionId: 'previous' } });
  const files = existingFiles(phone.app);
  await publishNewFromComputer(source); syncRuleFiles(source.app, phone.app); runtime.Platform.isMobile = true;
  await phone.plugin.checkNewPlugins();
  assert.deepEqual(phone.app.sync.exclusions, ['Private', '.obsidian/plugins/external', '.obsidian/plugins/alpha', '.obsidian/plugins/new-desktop-plugin']);
  assert.deepEqual(phone.plugin.local.ownedPaths, ['.obsidian/plugins/alpha', '.obsidian/plugins/new-desktop-plugin']);
  assert.equal(phone.plugin.local.lastApplied, undefined); assert.equal(phone.app.sync.writes, 1);
  assert.deepEqual(existingFiles(phone.app), files); assert.equal(runtime.modals.length, 0);
  assert.deepEqual(phone.app.fileEvents, []); assert.deepEqual(phone.app.unloaded, []);
  await phone.plugin.checkNewPlugins(); assert.equal(phone.app.sync.writes, 1);
});

for (const gate of ['compatibility', 'mobile opt-in'] as const) test(`mock lifecycle: ${gate} keeps new IDs unprocessed so a later check can retry`, async () => {
  const source = await desktop(); const phone = await automaticMobile(source, 'phone', gate !== 'mobile opt-in');
  await publishNewFromComputer(source); syncRuleFiles(source.app, phone.app); runtime.Platform.isMobile = true;
  if (gate === 'compatibility') phone.app.sync.eligible = false;
  await phone.plugin.checkNewPlugins();
  assert.equal(phone.app.sync.writes, 0); assert.equal(phone.plugin.local.newPluginBaseline.pluginIds.includes('new-desktop-plugin'), false);
  assert.match(phone.plugin.newPluginsStatus, /MOCK readonly/);
  phone.app.sync.eligible = true; phone.plugin.saveLocal({ ...phone.plugin.local, mobileExperimentalVersion: '1.13.7' });
  await phone.plugin.checkNewPlugins();
  assert.equal(phone.app.sync.writes, 1); assert.equal(phone.plugin.local.newPluginBaseline.pluginIds.includes('new-desktop-plugin'), true);
  assert.equal(phone.plugin.local.lastApplied, undefined); assert.equal(runtime.modals.length, 0);
});

test('mock lifecycle: an unfinished operation blocks new IDs without advancing the baseline', async () => {
  const source = await desktop(); const phone = await automaticMobile(source);
  await publishNewFromComputer(source); syncRuleFiles(source.app, phone.app); runtime.Platform.isMobile = true;
  phone.plugin.saveLocal({ ...phone.plugin.local, pending: { before: [...phone.app.sync.exclusions], after: [...phone.app.sync.exclusions], ownedBefore: [], ownedAfter: [] } });
  await phone.plugin.checkNewPlugins();
  assert.equal(phone.app.sync.writes, 0); assert.equal(phone.plugin.local.newPluginBaseline.pluginIds.includes('new-desktop-plugin'), false);
  assert.match(phone.plugin.newPluginsStatus, /上次操作没有完成/);
  phone.plugin.saveLocal({ ...phone.plugin.local, pending: undefined }); await phone.plugin.checkNewPlugins();
  assert.equal(phone.app.sync.writes, 1); assert.equal(phone.plugin.local.newPluginBaseline.pluginIds.includes('new-desktop-plugin'), true);
});

test('mock lifecycle: known IDs keep saved choices and never create new installation receipts', async () => {
  const source = await desktop(); const phone = await automaticMobile(source); const policy = phone.app.files.get(POLICY_PATH);
  const baseline = structuredClone(phone.plugin.local.newPluginBaseline); const files = existingFiles(phone.app);
  await phone.plugin.recordInstallation({ id: 'alpha', name: 'Renamed by update' }); await phone.plugin.checkNewPlugins();
  assert.equal(phone.plugin.local.installationQueue, undefined); assert.equal(phone.app.files.get(POLICY_PATH), policy);
  assert.deepEqual(phone.plugin.local.newPluginBaseline, baseline); assert.deepEqual(phone.app.writes, []);
  assert.equal(phone.app.sync.writes, 0); assert.deepEqual(existingFiles(phone.app), files);
});

test('mock lifecycle: unbound installation is rejected and disabling automation does not queue or publish records', async () => {
  const unbound = await launch(); await assert.rejects(unbound.plugin.recordInstallation({ id: 'new', name: 'New' }));
  assert.equal(unbound.plugin.local.installationQueue, undefined); assert.deepEqual(unbound.app.writes, []);
  const h = await desktop(); const policy = h.app.files.get(POLICY_PATH);
  h.plugin.saveLocal({ ...h.plugin.local, autoNewPlugins: false });
  await h.plugin.recordInstallation({ id: 'new', name: 'New' }); await h.plugin.checkNewPlugins();
  assert.equal(h.plugin.local.installationQueue, undefined); assert.equal(h.app.files.get(POLICY_PATH), policy);
  assert.equal(h.app.sync.writes, 0); assert.equal(runtime.modals.length, 0);
});

test('mock lifecycle: a persisted installation queue survives a failed receipt write and retries after plugin restart', async () => {
  const h = await desktop(); await h.plugin.recordInstallation({ id: 'queued-new', name: 'Queued new' });
  const create = h.app.vault.create; h.app.vault.create = async (file: string, data: string) => {
    if (file.endsWith('/queued-new.md')) throw new Error('mock receipt storage full'); return create(file, data);
  };
  await h.plugin.checkNewPlugins();
  assert.equal(h.plugin.local.installationQueue.length, 1); assert.equal(parsePolicy(h.app.files.get(POLICY_PATH)).plugins.some(p => p.id === 'queued-new'), false);
  assert.equal(h.app.sync.writes, 0); assert.match(h.plugin.newPluginsStatus, /mock receipt storage full/);
  h.plugin.unload(); h.app.vault.create = create;
  const reopened = await launch(h.app); assert.equal(reopened.plugin.local.installationQueue.length, 1);
  await reopened.plugin.checkNewPlugins();
  assert.equal(reopened.plugin.local.installationQueue.length, 0);
  const policy = parsePolicy(h.app.files.get(POLICY_PATH)); assert.equal(policy.plugins.filter(p => p.id === 'queued-new').length, 1);
  assert.equal(reopened.plugin.local.newPluginBaseline.pluginIds.includes('queued-new'), true);
  assert.equal(h.app.sync.writes, 0); assert.equal(runtime.modals.length, 0);
});

test('mock lifecycle: unloading unregisters events and timers and prevents later automatic work', async () => {
  const h = await desktop();
  assert.equal(h.plugin.installObserverActive, false); assert.equal(h.app.ready.length, 1);
  h.app.emit('modify', POLICY_PATH); assert.ok(runtime.timers.timeouts.size > 0);
  h.plugin.unload();
  assert.equal(runtime.timers.intervals.size, 0); assert.equal(runtime.timers.timeouts.size, 0);
  assert.ok([...h.app.events.values()].every((listeners: any) => listeners.size === 0));
  const files = new Map(h.app.files); await h.plugin.recordInstallation({ id: 'after-unload', name: 'After unload' }); await h.plugin.checkNewPlugins();
  assert.deepEqual(h.app.files, files); assert.equal(h.plugin.local.installationQueue, undefined); assert.equal(h.app.sync.writes, 0);
});

for (const english of [false, true]) test(`mock UI: ${english ? 'English' : 'Chinese'} local-install registration requires explicit selection and cancellation writes nothing`, async () => {
  runtime.language.value = english ? 'en' : 'zh';
  const h = await launch(); await click(h.el, english ? 'Create sync list' : '创建同步清单');
  installLocalFixture(h.app, 'manual-new', 'Manual new');
  const register = english ? 'Register local installs' : '登记本机安装的插件';
  const confirm = english ? 'Confirm these were installed here' : '确认这些插件是在本机安装的';
  const files = new Map(h.app.files); const writes = [...h.app.writes];
  await click(h.el, register); assert.equal(runtime.modals.at(-1).titleEl.textContent, register);
  assert.equal(modal().querySelectorAll('input[type="checkbox"]').length, 1);
  assert.equal(settingToggle(modal(), 'Manual new').checked, false);
  assert.equal(modal().querySelector('[data-name="alpha"]'), null);
  await click(modal(), confirm);
  assert.equal(h.plugin.local.installationQueue, undefined); assert.deepEqual(h.app.files, files); assert.deepEqual(h.app.writes, writes);
  assert.ok(runtime.notices.some((notice: string) => notice.includes(english ? 'Select the plugins to register first' : '请先勾选要登记')));
  settingToggle(modal(), 'Manual new').click(); await click(modal(), english ? 'Cancel' : '取消');
  assert.deepEqual(h.app.files, files); assert.deepEqual(h.app.writes, writes); assert.equal(h.plugin.local.installationQueue, undefined);
  await click(h.el, register); settingToggle(modal(), 'Manual new').click(); await click(modal(), confirm);
  assert.equal(h.plugin.local.installationQueue.length, 1); assert.equal(h.plugin.local.installationQueue[0].plugin.id, 'manual-new');
  assert.deepEqual(h.app.files, files); assert.deepEqual(h.app.writes, writes); assert.equal(h.app.sync.writes, 0);
  await h.plugin.checkNewPlugins(); assert.ok(parsePolicy(h.app.files.get(POLICY_PATH)).plugins.some(p => p.id === 'manual-new'));
  assert.equal(runtime.modals.length, 0);
});

test('mock UI: manual registration is unavailable until bound and while automatic defaults are disabled', async () => {
  const source = await desktop(); const h = await launch(createApp(new Map(source.app.files)), true);
  assert.equal(button(h.el, '登记本机安装的插件').disabled, true);
  const policy = parsePolicy(h.app.files.get(POLICY_PATH));
  h.plugin.saveLocal({ ...h.plugin.local, deviceId: policy.devices.find(d => d.kind === 'phone')!.id });
  await h.plugin.tab.render(h.el);
  assert.equal(settingToggle(h.el, '自动设置新插件的同步范围').checked, true);
  assert.equal(button(h.el, '登记本机安装的插件').disabled, false);
  settingToggle(h.el, '自动设置新插件的同步范围').click(); await flush();
  assert.equal(h.plugin.local.autoNewPlugins, false); assert.equal(button(h.el, '登记本机安装的插件').disabled, true);
  assert.match(h.el.textContent!, /需要开启上面的自动设置/); assert.equal(h.app.sync.writes, 0);
});

test('mock lifecycle: automatic partial apply preserves a new install queue and UI preferences saved while native write is awaiting', async () => {
  const source = await desktop(); const phone = await automaticMobile(source);
  await publishNewFromComputer(source); syncRuleFiles(source.app, phone.app); runtime.Platform.isMobile = true;
  phone.app.sync.onWrite = async () => {
    await phone.plugin.recordInstallation({ id: 'arrived-during-write', name: 'Arrived during write' });
    phone.plugin.saveLocal({ ...phone.plugin.local, language: 'en', autoNewPlugins: false });
  };
  await phone.plugin.checkNewPlugins();
  assert.equal(phone.app.sync.writes, 1); assert.equal(phone.plugin.local.lastApplied, undefined);
  assert.equal(phone.plugin.local.language, 'en'); assert.equal(phone.plugin.local.autoNewPlugins, false);
  assert.deepEqual(phone.plugin.local.installationQueue.map((record: Installation) => record.plugin.id), ['arrived-during-write']);
  assert.ok(phone.plugin.local.newPluginBaseline.pluginIds.includes('new-desktop-plugin'));
  assert.equal(phone.plugin.local.newPluginBaseline.pluginIds.includes('arrived-during-write'), false);
  assert.equal(runtime.modals.length, 0);
});

for (const changed of ['disabled', 'unloaded', 'binding', 'mobile opt-in'] as const) test(`mock lifecycle: ${changed} during the final asynchronous policy read stops the automatic native write`, async () => {
  const source = await desktop(); const phone = await automaticMobile(source);
  await publishNewFromComputer(source); syncRuleFiles(source.app, phone.app); runtime.Platform.isMobile = true;
  const read = phone.app.vault.read; let count = 0;
  phone.app.vault.read = async (file: { path: string }) => {
    const result = await read(file);
    if (file.path === POLICY_PATH && ++count === 2) {
      if (changed === 'disabled') phone.plugin.saveLocal({ ...phone.plugin.local, autoNewPlugins: false });
      if (changed === 'unloaded') phone.plugin.unload();
      if (changed === 'binding') phone.plugin.saveLocal({ ...phone.plugin.local, deviceId: null });
      if (changed === 'mobile opt-in') phone.plugin.saveLocal({ ...phone.plugin.local, mobileExperimentalVersion: undefined });
    }
    return result;
  };
  const files = new Map(phone.app.files); const exclusions = [...phone.app.sync.exclusions];
  await phone.plugin.checkNewPlugins();
  assert.ok(count >= 2); assert.equal(phone.app.sync.writes, 0); assert.deepEqual(phone.app.sync.exclusions, exclusions);
  assert.deepEqual(phone.app.files, files); assert.equal(phone.plugin.local.newPluginBaseline.pluginIds.includes('new-desktop-plugin'), false);
  assert.equal(runtime.modals.length, 0);
});

test('mock lifecycle: disabling automation just before the shared-file update callback prevents publication', async () => {
  const h = await desktop(); await h.plugin.recordInstallation({ id: 'waiting-publish', name: 'Waiting publish' });
  const oldPolicy = h.app.files.get(POLICY_PATH); const process = h.app.vault.process;
  h.app.vault.process = async (file: { path: string }, update: (text: string) => string) => {
    h.plugin.saveLocal({ ...h.plugin.local, autoNewPlugins: false }); return process(file, update);
  };
  await h.plugin.checkNewPlugins();
  assert.equal(h.app.files.get(POLICY_PATH), oldPolicy); assert.equal(h.app.sync.writes, 0);
  assert.ok([...h.app.files.keys()].some((file: string) => file.endsWith('/waiting-publish.md')));
  assert.equal(h.plugin.local.newPluginBaseline.pluginIds.includes('waiting-publish'), false);
});

test('mock lifecycle: manual apply preserves an installation queue and preferences changed while native saving is awaiting', async () => {
  const h = await desktop(); const policy = parsePolicy(h.app.files.get(POLICY_PATH));
  policy.devices.find(d => d.kind === 'desktop')!.excludedPluginIds = ['alpha']; h.app.files.set(POLICY_PATH, serializePolicy(policy));
  h.app.sync.onWrite = async () => {
    await h.plugin.recordInstallation({ id: 'installed-during-manual-apply', name: 'Installed during manual apply' });
    h.plugin.saveLocal({ ...h.plugin.local, language: 'en', autoNewPlugins: false });
  };
  await h.plugin.tab.render(h.el); await click(h.el, '查看并应用'); await click(modal(), '确认应用');
  assert.equal(h.app.sync.writes, 1); assert.ok(h.plugin.local.lastApplied);
  assert.equal(h.plugin.local.language, 'en'); assert.equal(h.plugin.local.autoNewPlugins, false);
  assert.deepEqual(h.plugin.local.installationQueue.map((record: Installation) => record.plugin.id), ['installed-during-manual-apply']);
});

test('mock lifecycle: initialization and device binding establish baselines before the first automatic timer', async () => {
  const source = await desktop(); const policy = parsePolicy(source.app.files.get(POLICY_PATH));
  assert.deepEqual(source.plugin.local.newPluginBaseline.pluginIds, policy.plugins.map(p => p.id));
  const phone = await launch(createApp(new Map(source.app.files)), true);
  const select = phone.el.querySelector<HTMLSelectElement>('[data-name="这台设备叫什么"] select')!;
  const deviceId = policy.devices.find(d => d.kind === 'phone')!.id;
  select.value = deviceId; select.dispatchEvent(new dom.window.Event('change')); await click(phone.el, '使用这个名称');
  assert.deepEqual(phone.plugin.local.newPluginBaseline, { deviceId, pluginIds: policy.plugins.map(p => p.id) });
  phone.plugin.saveLocal({ ...phone.plugin.local, mobileExperimentalVersion: '1.13.7' });
  await publishNewFromComputer(source, 'before-first-timer'); syncRuleFiles(source.app, phone.app); runtime.Platform.isMobile = true;
  await phone.plugin.checkNewPlugins();
  assert.ok(phone.app.sync.exclusions.includes('.obsidian/plugins/before-first-timer')); assert.equal(phone.app.sync.writes, 1);
});

for (const changed of ['disabled', 'unloaded', 'binding'] as const) test(`mock lifecycle: ${changed} during installation-origin lookup does not queue a stale receipt`, async () => {
  const h = await desktop(); const read = h.app.vault.read; let first = true;
  h.app.vault.read = async (file: { path: string }) => {
    const result = await read(file);
    if (first && file.path === POLICY_PATH) {
      first = false;
      if (changed === 'disabled') h.plugin.saveLocal({ ...h.plugin.local, autoNewPlugins: false });
      if (changed === 'unloaded') h.plugin.unload();
      if (changed === 'binding') h.plugin.saveLocal({ ...h.plugin.local, deviceId: null });
    }
    return result;
  };
  const recording = h.plugin.recordInstallation({ id: 'racing-install', name: 'Racing install' });
  if (changed === 'binding') await assert.rejects(recording); else await recording;
  assert.equal(h.plugin.local.installationQueue, undefined); assert.equal(h.app.sync.writes, 0);
  assert.equal([...h.app.files.keys()].some((file: string) => file.endsWith('/racing-install.md')), false);
});
