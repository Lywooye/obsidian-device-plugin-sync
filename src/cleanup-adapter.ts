import profile from './native-profile.json';
import { pluginPath } from './model';
import { text } from './i18n';

export const CLEANUP_ROOT = '.device-plugin-sync-trash';
const fingerprints = {
  unloadPlugin: '7800c99858c9b11d76ad5dfa001aa8281ca5b73e789a71f49a0aa623c0b5e64f',
  syncLoop: 'b3cd67d1380c6b3ef744347434916181ea0d6b98ca21708c8136c3db703d37fd',
};
type Filter = {
  configDir: string; ignoreFolders: string[];
  allowSyncFile(path: string, folder: boolean): boolean;
  [name: string]: unknown;
};
type Sync = {
  initialized: boolean; dataLoaded: boolean; db: unknown; vaultId: string;
  filter: Filter; _sync: unknown; pause: boolean; syncing: boolean;
};
type Manager = {
  plugins: Record<string, unknown>; enabledPlugins: Set<string>;
  unloadPlugin(id: string, userDisabled: boolean): Promise<void>;
};
export interface CleanupHost {
  unload(id: string): Promise<void>;
  assertCurrent(): void;
  assertExcluded(path: string): void;
  assertBackupExcluded(path: string): void;
}

async function digest(fn: unknown): Promise<string> {
  if (typeof fn !== 'function') return 'missing';
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(Function.prototype.toString.call(fn)));
  return Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2, '0')).join('');
}

// These additional private interfaces are needed only for local cleanup. A failed
// cleanup check does not disable the existing Sync exclusion controls.
export async function inspectCleanupHost(app: unknown, version: string): Promise<CleanupHost> {
  const fail = () => new Error(text('当前 Obsidian 不支持安全清理。插件已保留，请先不要手动删除。', 'This Obsidian version could not be checked for safe cleanup. Your plugins were kept.'));
  const host = app as {
    vault?: { configDir?: string }; plugins?: Manager;
    internalPlugins?: { getEnabledPluginById?(id: string): unknown };
  };
  if (version !== profile.version) throw fail();
  const manager = host.plugins;
  const sync = host.internalPlugins?.getEnabledPluginById?.('sync') as Sync | undefined;
  const configDir = host.vault?.configDir;
  if (!manager || !manager.plugins || !(manager.enabledPlugins instanceof Set)
    || !sync?.initialized || !sync.dataLoaded || !sync.db || !sync.vaultId
    || typeof configDir !== 'string' || sync.filter?.configDir !== configDir) throw fail();
  const filter = sync.filter;
  const vaultId = sync.vaultId;
  const database = sync.db;
  const registry = manager.plugins;
  const enabled = manager.enabledPlugins;
  const references = [
    { owner: manager as unknown as Record<string, unknown>, name: 'unloadPlugin', expected: fingerprints.unloadPlugin },
    { owner: sync as unknown as Record<string, unknown>, name: '_sync', expected: fingerprints.syncLoop },
    ...Object.entries(profile.fingerprints.filter).map(([name, expected]) => ({ owner: filter, name, expected })),
  ].map(entry => ({ ...entry, fn: entry.owner[entry.name] }));
  for (const entry of references) if (await digest(entry.fn) !== entry.expected) throw fail();
  const assertCurrent = () => {
    if (host.plugins !== manager || manager.plugins !== registry || manager.enabledPlugins !== enabled
      || host.vault?.configDir !== configDir || host.internalPlugins?.getEnabledPluginById?.('sync') !== sync
      || !sync.initialized || !sync.dataLoaded || sync.db !== database || sync.vaultId !== vaultId || sync.filter !== filter
      || filter.configDir !== configDir || !Array.isArray(filter.ignoreFolders)
      || filter.ignoreFolders.some(value => typeof value !== 'string')
      || references.some(entry => entry.owner[entry.name] !== entry.fn)) throw fail();
    if (sync.pause !== true || sync.syncing !== false) throw new Error(text('请先在官方 Sync 设置中暂停同步，等待当前同步结束，再重试。', 'Pause sync in the official Sync settings, wait for the current sync to finish, then try again.'));
  };
  const assertNotSynced = (path: string) => {
    assertCurrent();
    for (const [target, folder] of [[path, true], ...['main.js', 'manifest.json', 'styles.css', 'data.json'].map(name => [`${path}/${name}`, false])] as [string, boolean][]) {
      if (filter.allowSyncFile(target, folder) !== false) throw new Error(text('这些文件仍可能同步，已停止清理并保留插件。请重新应用本机的选择。', 'These files may still sync. Cleanup stopped and kept your plugins. Apply this device’s choices again.'));
    }
  };
  const assertExcluded = (path: string) => {
    assertCurrent();
    const prefix = `${configDir}/plugins/`;
    const id = path.startsWith(prefix) ? path.slice(prefix.length) : '';
    if (pluginPath(configDir, id) !== path || !filter.ignoreFolders.some(parent => path === parent || path.startsWith(`${parent}/`))) throw new Error(text('这个插件尚未停止同步，不能清理。请重新应用本机的选择。', 'This plugin is not excluded from sync. Apply this device’s choices before removing it.'));
    assertNotSynced(path);
  };
  const assertBackupExcluded = (path: string) => {
    if (path !== CLEANUP_ROOT && !/^\.device-plugin-sync-trash\/[a-f0-9-]{36}(?:\/[a-z0-9][a-z0-9_-]*)?$/.test(path)) throw fail();
    assertNotSynced(path);
  };
  assertCurrent();
  return {
    assertCurrent, assertExcluded, assertBackupExcluded,
    async unload(id) {
      const path = pluginPath(configDir, id);
      assertExcluded(path);
      const before = [...enabled];
      const unload = manager.unloadPlugin;
      // unloadPlugin only stops the running instance. In particular, never call
      // uninstallPlugin/disablePluginAndSave, which rewrite the shared enabled list.
      await unload.call(manager, id, true);
      assertCurrent();
      if (Object.prototype.hasOwnProperty.call(registry, id) || before.length !== enabled.size || before.some(value => !enabled.has(value))) {
        throw new Error(text('插件没有正常停止，已停止清理。请重启 Obsidian 后再试。', 'The plugin did not stop cleanly. Cleanup stopped. Restart Obsidian and try again.'));
      }
      assertExcluded(path);
    },
  };
}
