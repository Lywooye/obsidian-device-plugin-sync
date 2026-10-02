import assert from 'node:assert/strict';
import test from 'node:test';
import { validateInstallation, installationPath, serializeInstallation, parseInstallation, addNewInstallations, planNewPlugins } from '../src/new-plugins';
import type { Installation, LocalState, Policy } from '../src/model';

const policy = (): Policy => ({ schema: 1, revision: 7, authorityId: 'source',
  plugins: [{ id: 'old-blocked', name: 'Old blocked' }, { id: 'old-allowed', name: 'Old allowed' }],
  devices: [
    { id: 'computer', name: 'Computer', kind: 'desktop', excludedPluginIds: ['old-blocked'] },
    { id: 'other-computer', name: 'Other computer', kind: 'desktop', excludedPluginIds: [] },
    { id: 'phone', name: 'Phone', kind: 'phone', excludedPluginIds: ['old-allowed'] },
    { id: 'tablet', name: 'Tablet', kind: 'tablet', excludedPluginIds: ['old-blocked'] },
  ] });
const receipt = (deviceId = 'phone', installationId = 'install-phone', id = 'new-plugin'): Installation => ({
  schema: 1, deviceId, installationId, plugin: { id, name: 'New plugin' },
});
const state = (): LocalState => ({ schema: 1, installationId: 'install-phone', deviceId: 'phone',
  ownedPaths: ['.obsidian/plugins/old-blocked'], baselineExclusions: ['Private'],
  newPluginBaseline: { deviceId: 'phone', pluginIds: ['old-blocked', 'old-allowed'] },
});

test('new plugin receipts round-trip with immutable device/install/path identities', () => {
  const record = receipt(); const path = installationPath(record);
  assert.equal(path, 'Device Plugin Sync/Installations/install-phone/new-plugin.md');
  assert.deepEqual(parseInstallation(serializeInstallation(record), path), record);
  assert.throws(() => parseInstallation(serializeInstallation(record), path.replace('install-phone', 'another-install')));
  assert.throws(() => parseInstallation(serializeInstallation(record), path.replace('new-plugin.md', 'another-plugin.md')));
  assert.throws(() => parseInstallation('```json\n{invalid}\n```', path));
  assert.throws(() => parseInstallation(serializeInstallation(record) + serializeInstallation(record), path));
});

test('new plugin receipts reject invalid IDs, names, manager self, and unsupported schema', () => {
  for (const patch of [{ schema: 2 }, { installationId: '../outside' }, { deviceId: '__proto__' }, { deviceId: '' },
    { plugin: { id: 'device-plugin-sync', name: 'Manager' } }, { plugin: { id: '../alpha', name: 'A' } },
    { plugin: { id: 'valid', name: '' } }, { plugin: { id: 'valid', name: 'line\nbreak' } }, { plugin: { id: 'valid', name: 'x'.repeat(161) } }]) {
    assert.throws(() => validateInstallation({ ...receipt(), ...patch }));
  }
});

test('a phone installation allows every computer and its source phone, while other mobile devices start blocked', () => {
  const before = policy(); const result = addNewInstallations(before, [receipt()]);
  assert.equal(result.revision, 8); assert.equal(before.revision, 7); assert.equal(before.plugins.length, 2);
  assert.deepEqual(result.plugins.at(-1), receipt().plugin);
  for (const device of result.devices) {
    assert.equal(device.excludedPluginIds.includes('new-plugin'), device.id === 'tablet');
    assert.deepEqual(device.excludedPluginIds.filter(id => id !== 'new-plugin'), before.devices.find(d => d.id === device.id)!.excludedPluginIds);
  }
});

test('a computer installation blocks all mobile devices without changing older selections', () => {
  const before = policy(); const result = addNewInstallations(before, [receipt('computer')]);
  for (const device of result.devices) {
    assert.equal(device.excludedPluginIds.includes('new-plugin'), device.kind !== 'desktop');
    assert.deepEqual(device.excludedPluginIds.filter(id => id !== 'new-plugin'), before.devices.find(d => d.id === device.id)!.excludedPluginIds);
  }
});

test('multiple installation receipts permit each mobile source, choose a deterministic name, and add one revision', () => {
  const phone = { ...receipt('phone', 'aaa'), plugin: { id: 'new-plugin', name: 'Name A' } };
  const tablet = { ...receipt('tablet', 'zzz'), plugin: { id: 'new-plugin', name: 'Name Z' } };
  const first = addNewInstallations(policy(), [tablet, phone, phone]);
  const reversed = addNewInstallations(policy(), [phone, tablet]);
  assert.deepEqual(first, reversed); assert.equal(first.revision, 8);
  assert.equal(first.plugins.at(-1)!.name, 'Name A');
  assert.ok(first.devices.every(device => !device.excludedPluginIds.includes('new-plugin')));
});

test('existing plugin choices win over late receipts and removed-device receipts are ignored', () => {
  const original = policy();
  assert.deepEqual(addNewInstallations(original, [receipt('phone', 'late', 'old-blocked')]), original);
  assert.deepEqual(addNewInstallations(original, [receipt('removed-device')]), original);
  const added = addNewInstallations(original, [receipt('computer')]);
  assert.deepEqual(addNewInstallations(added, [receipt('phone', 'late')]), added);
});

test('automatic planning touches only new IDs and preserves older unapplied choices and external exclusions', () => {
  const next = addNewInstallations(policy(), [receipt('computer')]);
  // Policy now wants old-allowed blocked and old-blocked allowed; both older
  // choices intentionally remain unapplied during a new-plugin-only update.
  const current = ['Private', '.obsidian/plugins/external', '.obsidian/plugins/old-blocked'];
  const result = planNewPlugins(current, state(), next, '.obsidian');
  assert.deepEqual(result.ids, ['new-plugin']);
  assert.deepEqual(result.plan.add, ['.obsidian/plugins/new-plugin']);
  assert.deepEqual(result.plan.remove, []);
  assert.deepEqual(result.plan.after, [...current, '.obsidian/plugins/new-plugin']);
  assert.deepEqual(result.plan.ownedAfter, ['.obsidian/plugins/old-blocked', '.obsidian/plugins/new-plugin']);
});

test('allowed new IDs require no change; pre-existing external exclusions remain owned externally', () => {
  const fromPhone = addNewInstallations(policy(), [receipt('phone')]);
  const current = ['Private', '.obsidian/plugins/old-blocked'];
  assert.deepEqual(planNewPlugins(current, state(), fromPhone, '.obsidian').plan.after, current);
  const fromComputer = addNewInstallations(policy(), [receipt('computer')]);
  const external = [...current, '.obsidian/plugins/new-plugin'];
  const result = planNewPlugins(external, state(), fromComputer, '.obsidian');
  assert.deepEqual(result.plan.after, external);
  assert.deepEqual(result.plan.ownedAfter, state().ownedPaths);
  assert.deepEqual(result.plan.externallyExcluded, ['.obsidian/plugins/new-plugin']);
});

test('automatic planning requires a matching established device baseline and validates owned paths', () => {
  const next = addNewInstallations(policy(), [receipt('computer')]);
  for (const patch of [{ deviceId: null }, { deviceId: 'missing' }, { newPluginBaseline: undefined },
    { newPluginBaseline: { deviceId: 'tablet', pluginIds: [] } }]) {
    assert.throws(() => planNewPlugins(['.obsidian/plugins/old-blocked'], { ...state(), ...patch }, next, '.obsidian'));
  }
  assert.throws(() => planNewPlugins([], state(), next, '.obsidian'));
});

test('new-plugin planning preserves old owned paths and order when an external parent now covers them', () => {
  const source: Policy = { schema: 1, revision: 3, authorityId: 'computer',
    plugins: [{ id: 'old', name: 'Old' }, { id: 'new', name: 'New' }],
    devices: [{ id: 'phone', name: 'Phone', kind: 'phone', excludedPluginIds: ['new'] }] };
  const current = ['.obsidian/plugins/old', '.obsidian/plugins'];
  const local: LocalState = { schema: 1, installationId: 'local-phone', deviceId: 'phone',
    baselineExclusions: null, ownedPaths: ['.obsidian/plugins/old'], newPluginBaseline: { deviceId: 'phone', pluginIds: ['old'] } };
  const result = planNewPlugins(current, local, source, '.obsidian');
  assert.deepEqual(result.ids, ['new']); assert.deepEqual(result.plan.after, current);
  assert.deepEqual(result.plan.remove, []); assert.deepEqual(result.plan.ownedAfter, ['.obsidian/plugins/old']);
  assert.deepEqual(result.plan.externallyExcluded, ['.obsidian/plugins/new']);
});
