import { t } from './i18n';
import { PLUGIN_ID, pluginPath, serializePolicy, planExclusions, type Installation, type Policy, type LocalState } from './model';

export const INSTALLATIONS_PATH = 'Device Plugin Sync/Installations';
const safeDevice = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(value)
  && value !== 'prototype' && !Object.prototype.hasOwnProperty.call(Object.prototype, value);

export function validateInstallation(value: unknown): Installation {
  const x = value as Installation;
  if (!x || x.schema !== 1 || !safeDevice(x.installationId) || !safeDevice(x.deviceId) || !x.plugin
    || typeof x.plugin.name !== 'string' || !x.plugin.name.trim() || x.plugin.name.length > 160 || /[\u0000-\u001f\u007f]/.test(x.plugin.name))
    throw new Error(t('installationInvalid'));
  pluginPath('.obsidian', x.plugin.id);
  return { schema: 1, installationId: x.installationId, deviceId: x.deviceId, plugin: { id: x.plugin.id, name: x.plugin.name } };
}
export function installationPath(record: Installation): string {
  const x = validateInstallation(record);
  return `${INSTALLATIONS_PATH}/${x.installationId}/${x.plugin.id}.md`;
}
export function serializeInstallation(record: Installation): string {
  return `# Device Plugin Sync installation\n\n\`\`\`json\n${JSON.stringify(validateInstallation(record), null, 2)}\n\`\`\`\n`;
}
export function parseInstallation(text: string, path: string): Installation {
  const blocks = [...text.matchAll(/^```json[ \t]*\r?\n([\s\S]*?)^```[ \t]*\r?$/gm)];
  if (blocks.length !== 1) throw new Error(t('installationInvalid'));
  const record = validateInstallation(JSON.parse(blocks[0][1]));
  if (installationPath(record) !== path) throw new Error(t('installationInvalid'));
  return record;
}

// Receipts are immutable. Once an ID is in the list, its saved choices win over every receipt.
export function addNewInstallations(policy: Policy, receipts: Installation[]): Policy {
  const next = structuredClone(policy);
  const groups = new Map<string, Installation[]>();
  for (const receipt of receipts) {
    const record = validateInstallation(receipt);
    if (record.plugin.id === PLUGIN_ID || policy.plugins.some(p => p.id === record.plugin.id)
      || !policy.devices.some(d => d.id === record.deviceId)) continue;
    groups.set(record.plugin.id, [...(groups.get(record.plugin.id) ?? []), record]);
  }
  for (const [id, entries] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
    entries.sort((a, b) => a.installationId.localeCompare(b.installationId));
    next.plugins.push(entries[0].plugin);
    for (const device of next.devices) {
      if (device.kind !== 'desktop' && !entries.some(r => r.deviceId === device.id)) device.excludedPluginIds.push(id);
    }
  }
  if (groups.size) next.revision++;
  serializePolicy(next);
  return next;
}

// Apply only IDs first observed after this device's baseline, keeping older exclusions as-is.
export function planNewPlugins(current: string[], state: LocalState, policy: Policy, configDir: string) {
  const device = policy.devices.find(d => d.id === state.deviceId);
  if (!device || state.newPluginBaseline?.deviceId !== device.id) throw new Error(t('chooseDeviceFirst'));
  const ids = policy.plugins.map(p => p.id).filter(id => id !== PLUGIN_ID && !state.newPluginBaseline!.pluginIds.includes(id));
  // Validate all existing ownership, but do not let planning prune older paths
  // merely because an external parent exclusion now covers them.
  planExclusions(current, state.ownedPaths, [], configDir);
  const newPaths = new Set(ids.map(id => pluginPath(configDir, id)));
  const newOwned = state.ownedPaths.filter(path => newPaths.has(path));
  const plan = planExclusions(current, newOwned, ids.filter(id => device.excludedPluginIds.includes(id)), configDir);
  plan.ownedAfter = [...state.ownedPaths.filter(path => !newPaths.has(path)), ...plan.ownedAfter];
  return { ids, plan };
}
