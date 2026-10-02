import type { DataAdapter } from 'obsidian';
import { pluginPath, type Policy } from './model';
import { text } from './i18n';

export const BACKUP_ROOT = '.device-plugin-sync-trash';
export type CleanupCandidate = { id: string; name: string };
export type Backup = CleanupCandidate & { batch: string; configDir: string; createdAt: string };
export interface CleanupHost {
  assertCurrent(): void;
  assertExcluded(path: string): void;
  assertBackupExcluded(path: string): void;
  unload(id: string): Promise<void>;
}
type Guard = () => Promise<CleanupHost>;
type Manifest = { schema: 1; configDir: string; createdAt: string; plugins: CleanupCandidate[] };
const validBatch = (batch: string) => /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(batch);
const failure = (error: unknown) => error instanceof Error ? error.message : String(error);

function validateLocation(configDir: string) {
  pluginPath(configDir, 'dps-path-check');
  if (configDir === BACKUP_ROOT || configDir.startsWith(`${BACKUP_ROOT}/`))
    throw new Error(text('备份目录与当前配置目录重叠，不能清理。', 'The backup folder overlaps your configuration folder. Cleanup is unavailable.'));
}
async function isPlugin(adapter: DataAdapter, path: string, id: string): Promise<boolean> {
  if ((await adapter.stat(path))?.type !== 'folder') return false;
  try { return JSON.parse(await adapter.read(`${path}/manifest.json`)).id === id; } catch { return false; }
}
async function ensureFolder(adapter: DataAdapter, path: string) {
  const entry = await adapter.stat(path);
  if (!entry) await adapter.mkdir(path);
  else if (entry.type !== 'folder') throw new Error(text(`这个位置不是文件夹：${path}`, `This location is not a folder: ${path}`));
}
async function movedAfterError(adapter: DataAdapter, source: string, destination: string, id: string): Promise<boolean | undefined> {
  try {
    const sourceExists = await adapter.exists(source);
    const destinationMatches = await isPlugin(adapter, destination, id);
    if (!sourceExists && destinationMatches) return true;
    if (sourceExists && !(await adapter.exists(destination))) return false;
  } catch { /* An unreadable filesystem cannot confirm either outcome. */ }
  return undefined;
}
export async function cleanupCandidates(adapter: DataAdapter, configDir: string, policy: Policy, deviceId: string): Promise<CleanupCandidate[]> {
  validateLocation(configDir);
  const ids = new Set(policy.devices.find(d => d.id === deviceId)?.excludedPluginIds ?? []);
  const result: CleanupCandidate[] = [];
  for (const plugin of policy.plugins) {
    if (!ids.has(plugin.id)) continue;
    const path = pluginPath(configDir, plugin.id);
    if (await isPlugin(adapter, path, plugin.id)) result.push({ ...plugin });
  }
  return result;
}

/** No permanent deletion: each complete folder is moved to a hidden, local backup. */
export async function moveToBackup(adapter: DataAdapter, configDir: string, selected: CleanupCandidate[], guard: Guard) {
  validateLocation(configDir);
  if (!selected.length || new Set(selected.map(p => p.id)).size !== selected.length) throw new Error(text('请先选择要清理的插件。', 'Choose the plugins to remove first.'));
  for (const plugin of selected) pluginPath(configDir, plugin.id);
  const batch = crypto.randomUUID();
  const folder = `${BACKUP_ROOT}/${batch}`;
  const manifest: Manifest = { schema: 1, configDir, createdAt: new Date().toISOString(), plugins: selected };
  let host = await guard();
  host.assertBackupExcluded(folder);
  for (const plugin of selected) host.assertExcluded(pluginPath(configDir, plugin.id));
  await ensureFolder(adapter, BACKUP_ROOT);
  if (await adapter.exists(folder)) throw new Error(text('备份位置已存在，请重试。', 'The backup location already exists. Try again.'));
  await adapter.mkdir(folder);
  // Write recovery information before moving anything, including for interrupted batches.
  await adapter.write(`${folder}/backup.json`, JSON.stringify(manifest, null, 2));
  const moved: CleanupCandidate[] = [];
  for (const plugin of selected) {
    const source = pluginPath(configDir, plugin.id);
    const destination = `${folder}/${plugin.id}`;
    let renameStarted = false;
    try {
      if (!(await isPlugin(adapter, source, plugin.id))) throw new Error(text('本机插件文件已经变化，请重新打开清理列表。', 'The local plugin files changed. Reopen the cleanup list.'));
      if (await adapter.exists(destination)) throw new Error(text('备份位置已有文件，已停止以免覆盖。', 'The backup destination is occupied. Stopped without overwriting it.'));
      host = await guard();
      host.assertExcluded(source); host.assertBackupExcluded(destination);
      await host.unload(plugin.id);
      host = await guard();
      host.assertCurrent(); host.assertExcluded(source); host.assertBackupExcluded(destination);
      renameStarted = true;
      await adapter.rename(source, destination);
      moved.push(plugin);
    } catch (error) {
      let detail = failure(error);
      if (renameStarted) {
        const confirmed = await movedAfterError(adapter, source, destination, plugin.id);
        if (confirmed) {
          moved.push(plugin);
          detail = text('文件已进入备份，但 Obsidian 刷新文件状态失败，请重启后检查。', 'Files reached the backup, but Obsidian could not refresh their status. Restart and check.');
        } else if (confirmed === undefined) detail = text('暂时无法确认是否移动成功。请保留原目录和备份，检查后再操作。', 'The move result could not be confirmed. Keep both the original folder and backup, and check them before continuing.');
      }
      return { moved, folder, error: `${plugin.name}: ${detail}` };
    }
  }
  return { moved, folder, error: null };
}

async function readManifest(adapter: DataAdapter, batch: string): Promise<Manifest> {
  if (!validBatch(batch)) throw new Error(text('备份编号不正确。', 'Invalid backup ID.'));
  const raw = JSON.parse(await adapter.read(`${BACKUP_ROOT}/${batch}/backup.json`)) as Manifest;
  if (raw?.schema !== 1 || typeof raw.configDir !== 'string' || typeof raw.createdAt !== 'string' || !Number.isFinite(Date.parse(raw.createdAt)) || !Array.isArray(raw.plugins))
    throw new Error(text('备份说明文件损坏，请保留备份文件夹并手动检查。', 'The backup record is damaged. Keep the backup folder and inspect it manually.'));
  validateLocation(raw.configDir);
  const ids = new Set<string>();
  for (const plugin of raw.plugins) {
    if (!plugin || typeof plugin.id !== 'string' || typeof plugin.name !== 'string' || ids.has(plugin.id)) throw new Error(text('备份中的插件清单不正确。', 'Invalid plugin list in the backup record.'));
    pluginPath(raw.configDir, plugin.id); ids.add(plugin.id);
  }
  return raw;
}
export async function listBackups(adapter: DataAdapter): Promise<{ backups: Backup[]; unreadable: number }> {
  if (!(await adapter.exists(BACKUP_ROOT))) return { backups: [], unreadable: 0 };
  const entries = await adapter.list(BACKUP_ROOT);
  const backups: Backup[] = []; let unreadable = 0;
  for (const folder of entries.folders) {
    const batch = folder.slice(BACKUP_ROOT.length + 1);
    if (!validBatch(batch) || folder !== `${BACKUP_ROOT}/${batch}`) { unreadable++; continue; }
    try {
      const manifest = await readManifest(adapter, batch);
      for (const plugin of manifest.plugins) {
        if (await isPlugin(adapter, `${folder}/${plugin.id}`, plugin.id)) backups.push({ ...plugin, batch, configDir: manifest.configDir, createdAt: manifest.createdAt });
      }
    } catch { unreadable++; }
  }
  return { backups: backups.sort((a, b) => b.createdAt.localeCompare(a.createdAt)), unreadable };
}
export async function restoreBackup(adapter: DataAdapter, configDir: string, backup: Backup, guard: Guard): Promise<{ warning: string | null }> {
  validateLocation(configDir);
  const manifest = await readManifest(adapter, backup.batch);
  if (manifest.configDir !== configDir || !manifest.plugins.some(p => p.id === backup.id)) throw new Error(text('这份备份不属于当前插件目录，不能自动放回。', 'This backup belongs to a different plugin folder and cannot be restored here.'));
  const source = `${BACKUP_ROOT}/${backup.batch}/${backup.id}`;
  const destination = pluginPath(configDir, backup.id);
  if (!(await isPlugin(adapter, source, backup.id))) throw new Error(text('备份文件已变化，请重新打开备份列表。', 'The backup files changed. Reopen the backup list.'));
  if (await adapter.exists(destination)) throw new Error(text('本机已经有这个插件。为避免覆盖，未放回备份。', 'This plugin already exists locally. The backup was not restored, to avoid overwriting it.'));
  const host = await guard();
  host.assertBackupExcluded(source); host.assertExcluded(destination);
  host.assertCurrent();
  try { await adapter.rename(source, destination); }
  catch (error) {
    const confirmed = await movedAfterError(adapter, source, destination, backup.id);
    if (confirmed) return { warning: text('文件已放回，但 Obsidian 刷新文件状态失败，请重启后检查。', 'Files were restored, but Obsidian could not refresh their status. Restart and check.') };
    if (confirmed === undefined) throw new Error(text('暂时无法确认是否放回成功。请保留插件目录和备份，检查后再操作。', 'The restore result could not be confirmed. Keep the plugin folder and backup, and check them before continuing.'));
    throw error;
  }
  return { warning: null };
}
