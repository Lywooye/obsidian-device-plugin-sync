import { t, type LanguagePreference } from './i18n';
export const POLICY_PATH = "Device Plugin Sync/Policy.md";
export const PLUGIN_ID = "device-plugin-sync";

export type Policy = {
  schema: 1;
  revision: number;
  authorityId: string;
  devices: {
    id: string;
    name: string;
    kind: "desktop" | "phone" | "tablet";
    excludedPluginIds: string[];
  }[];
  plugins: { id: string; name: string }[];
};

export type LocalState = {
  schema: 1;
  installationId: string;
  deviceId: string | null;
  mobileExperimentalVersion?: string;
  language?: LanguagePreference;
  autoNewPlugins?: boolean;
  newPluginBaseline?: { deviceId: string; pluginIds: string[] };
  installationQueue?: Installation[];
  ownedPaths: string[];
  baselineExclusions: string[] | null;
  lastApplied?: {
    revision: number;
    paths: string[];
    appliedAt: string;
    sessionId: string;
  };
  pending?: {
    before: string[];
    after: string[];
    ownedBefore: string[];
    ownedAfter: string[];
  };
};

export type Installation = {
  schema: 1;
  installationId: string;
  deviceId: string;
  plugin: Policy['plugins'][number];
};

export type Plan = {
  before: string[];
  after: string[];
  add: string[];
  remove: string[];
  ownedAfter: string[];
  externallyExcluded: string[];
  warnings: string[];
};

function record(value: unknown, keys: string[], label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error(t('objectInvalid', { label }));
  }
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) throw new Error(t('unknownField', { label, field: key }));
  }
  return value as Record<string, unknown>;
}

function safeId(value: unknown, label: string, plugin = false): string {
  const pattern = plugin ? /^[a-z0-9][a-z0-9_-]*$/ : /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
  if (typeof value !== "string" || !pattern.test(value)
    || value === "prototype" || Object.prototype.hasOwnProperty.call(Object.prototype, value)) {
    throw new Error(t('unsafeId', { label }));
  }
  return value;
}

function displayName(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(t('nameInvalid', { label }));
  }
  return value;
}

function unique(values: string[], label: string): void {
  if (new Set(values).size !== values.length) throw new Error(t('duplicates', { label }));
}

function validatePolicy(value: unknown): Policy {
  const data = record(value, ["schema", "revision", "authorityId", "devices", "plugins"], t('policyLabel'));
  if (data.schema !== 1) throw new Error(t('policySchema'));
  if (typeof data.revision !== "number" || !Number.isSafeInteger(data.revision) || data.revision < 0) {
    throw new Error(t('policyRevision'));
  }
  const authorityId = safeId(data.authorityId, "authorityId");
  if (!Array.isArray(data.plugins) || !Array.isArray(data.devices)) {
    throw new Error(t('policyArrays'));
  }
  const plugins = data.plugins.map((entry, index) => {
    const item = record(entry, ["id", "name"], `plugins[${index}]`);
    return { id: safeId(item.id, t('pluginIdLabel'), true), name: displayName(item.name, t('pluginNameLabel')) };
  });
  unique(plugins.map((plugin) => plugin.id), t('pluginsLabel'));
  const pluginIds = new Set(plugins.map((plugin) => plugin.id));
  const devices = data.devices.map<Policy["devices"][number]>((entry, index) => {
    const item = record(entry, ["id", "name", "kind", "excludedPluginIds"], `devices[${index}]`);
    const id = safeId(item.id, t('deviceIdLabel'));
    const name = displayName(item.name, t('deviceNameLabel'));
    if (item.kind !== "desktop" && item.kind !== "phone" && item.kind !== "tablet") {
      throw new Error(t('kindInvalid', { id }));
    }
    if (!Array.isArray(item.excludedPluginIds)) throw new Error(t('excludedInvalid', { id }));
    const excludedPluginIds = item.excludedPluginIds.map((entry) => {
      const pluginId = safeId(entry, t('excludedIdLabel'), true);
      if (pluginId === PLUGIN_ID) throw new Error(t('cannotExcludeSelf'));
      if (!pluginIds.has(pluginId)) throw new Error(t('excludedUnknown', { id: pluginId }));
      return pluginId;
    });
    unique(excludedPluginIds, t('excludedLabel', { id }));
    return { id, name, kind: item.kind, excludedPluginIds };
  });
  unique(devices.map((device) => device.id), t('devicesLabel'));
  return { schema: 1, revision: data.revision, authorityId, devices, plugins };
}

export function parsePolicy(markdown: string): Policy {
  const blocks = [...markdown.matchAll(/^```json[ \t]*\r?\n([\s\S]*?)^```[ \t]*\r?$/gm)];
  if (blocks.length !== 1) throw new Error(t('policyBlock'));
  let value: unknown;
  try {
    value = JSON.parse(blocks[0][1]);
  } catch {
    throw new Error(t('policyJson'));
  }
  return validatePolicy(value);
}

export function serializePolicy(policy: Policy): string {
  return `# Device Plugin Sync Policy\n\n\`\`\`json\n${JSON.stringify(validatePolicy(policy), null, 2)}\n\`\`\`\n`;
}

function relativePath(value: string): string {
  if (typeof value !== "string" || value.length === 0 || /[\\:\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(t('unsafePath'));
  }
  const path = value;
  if (path.split("/").some((part) => !part || part === "." || part === ".." || part.trim() !== part)) {
    throw new Error(t('pathOutside', { path: value }));
  }
  return path;
}

export function pluginPath(configDir: string, id: string): string {
  const config = relativePath(configDir);
  const pluginId = safeId(id, t('pluginIdLabel'), true);
  if (pluginId === PLUGIN_ID) throw new Error(t('cannotExcludeSelf'));
  return `${config}/plugins/${pluginId}`;
}

function covers(ancestor: string, path: string): boolean {
  return path === ancestor || path.startsWith(`${ancestor}/`);
}

/**
 * Ownership is exact-path bookkeeping, not a lock. If another actor removes and
 * re-adds the same owned path between observations, snapshots cannot distinguish
 * that edit. Callers must re-read before applying and offer an ownership reset.
 */
export function planExclusions(
  current: string[], owned: string[], desiredPluginIds: string[], configDir: string,
): Plan {
  const config = relativePath(configDir);
  const prefix = `${config}/plugins/`;
  let normalizedCurrent: string[];
  try {
    normalizedCurrent = current.map((path) => relativePath(path));
  } catch {
    throw new Error(t('nativeInvalidPaths'));
  }
  unique(owned, t('ownedLabel'));
  unique(desiredPluginIds, t('requestedLabel'));
  for (const path of owned) {
    let valid = false;
    try {
      valid = path.startsWith(prefix) && pluginPath(config, path.slice(prefix.length)) === path;
    } catch {
      // Corrupt ownership must stop planning instead of being silently discarded.
    }
    if (!valid) {
      throw new Error(t('ownedWrongConfig', { path }));
    }
    if (!current.includes(path)) {
      throw new Error(t('ownedRemoved', { path }));
    }
  }
  const ownedSet = new Set(owned);
  const external = current.flatMap((path, index) => ownedSet.has(path) ? [] : [normalizedCurrent[index]]);
  const desired = desiredPluginIds.map((id) => pluginPath(config, id));
  const externallyExcluded: string[] = [];
  const ownedAfter: string[] = [];
  const warnings: string[] = [];
  for (const path of desired) {
    const ancestor = external.find((entry) => covers(entry, path));
    if (ancestor) {
      externallyExcluded.push(path);
      warnings.push(t('externalBlocks', { path, ancestor }));
    } else {
      ownedAfter.push(path);
    }
  }
  const keepOwned = new Set(ownedAfter);
  const remove = owned.filter((path) => !keepOwned.has(path));
  const removeSet = new Set(remove);
  const after = current.filter((path) => !removeSet.has(path));
  const add = ownedAfter.filter((path) => !current.includes(path));
  after.push(...add);
  for (const path of remove) {
    const ancestor = external.find((entry) => covers(entry, path));
    if (ancestor && !externallyExcluded.includes(path)) {
      warnings.push(t('externalStillBlocks', { path, ancestor }));
    }
  }
  return { before: [...current], after, add, remove, ownedAfter, externallyExcluded, warnings };
}
