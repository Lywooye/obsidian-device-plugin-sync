import { apiVersion, Modal, Notice, Platform, Setting, type App, type TFile } from 'obsidian';
import { samePaths } from './transaction';
import { inspectSync, readNativeExclusions } from './sync-adapter';
import { inspectCleanupHost } from './cleanup-adapter';
import { cleanupCandidates, moveToBackup, listBackups, restoreBackup, type CleanupCandidate, type Backup } from './cleanup';
import type { Policy, LocalState } from './model';
import { text } from './i18n';

type Snapshot = { policy: Policy; text: string; file: TFile };
interface Owner {
  app: App; local: LocalState;
  run(work: () => Promise<void>): Promise<void>;
  loadPolicy(): Promise<Snapshot | null>;
}
const reason = (error: unknown) => error instanceof Error ? error.message : String(error);
async function compatibleHost(plugin: Owner) {
  if (plugin.local.pending) throw new Error(text('请先到“故障处理”检查上次未完成的操作。', 'Check the unfinished operation in Troubleshooting first.'));
  const result = await inspectSync(plugin.app, apiVersion, Platform.isMobile, plugin.app.vault.configDir, plugin.local.mobileExperimentalVersion === apiVersion);
  if (!result.writable) throw new Error(result.reason);
  return inspectCleanupHost(plugin.app, apiVersion);
}
function checkApplied(plugin: Owner, loaded: Snapshot, deviceId: string) {
  const last = plugin.local.lastApplied;
  if (plugin.local.deviceId !== deviceId || !last || last.revision !== loaded.policy.revision || !samePaths(last.paths, readNativeExclusions(plugin.app)))
    throw new Error(text('请先应用这台设备最新的同步选择，再清理本机插件。', 'Apply the latest choices on this device before removing local plugins.'));
}
export async function offerCleanup(plugin: Owner, loaded: Snapshot, automatic = true) {
  const deviceId = plugin.local.deviceId;
  if (!deviceId) throw new Error(text('请先选择本机对应的设备。', 'Choose this device first.'));
  checkApplied(plugin, loaded, deviceId);
  const candidates = await cleanupCandidates(plugin.app.vault.adapter, plugin.app.vault.configDir, loaded.policy, deviceId);
  if (!candidates.length) {
    if (!automatic) new Notice(text('没有需要清理的本机插件。未选择同步的插件已经不在本机，或没有可识别的安装文件。', 'No local plugins need cleanup. Excluded plugins are already absent or have no recognizable installation files.'));
    return;
  }
  new CleanupModal(plugin, loaded, deviceId, candidates).open();
}
export function renderCleanupSettings(container: HTMLElement, plugin: Owner) {
  new Setting(container).setName(text('清理本机不再同步的插件', 'Remove local plugins excluded from sync'))
    .setDesc(text('已经应用选择后，可以移走本机已有的插件，并保留可找回的备份。不会自动清理。', 'After applying your choices, you can remove existing local plugins while keeping a recoverable backup. Nothing is removed automatically.'))
    .addButton(b => b.setButtonText(text('选择要清理的插件', 'Choose plugins to remove')).onClick(() => void plugin.run(async () => {
      const loaded = await plugin.loadPolicy();
      if (!loaded) throw new Error(text('没有找到同步清单。', 'No sync list was found.'));
      await offerCleanup(plugin, loaded, false);
    })));
  new Setting(container).setName(text('找回清理过的插件', 'Restore removed plugin files'))
    .setDesc(text('把本机备份放回插件目录。不改变同步选择，也不会自动启用插件。', 'Move a local backup back to the plugin folder. Sync choices stay the same, and plugins are not enabled automatically.'))
    .addButton(b => b.setButtonText(text('查看本机备份', 'View local backups')).onClick(() => void plugin.run(async () => {
      const result = await listBackups(plugin.app.vault.adapter);
      new BackupModal(plugin, result.backups, result.unreadable).open();
    })));
}

class CleanupModal extends Modal {
  constructor(readonly plugin: Owner, readonly loaded: Snapshot, readonly deviceId: string, readonly candidates: CleanupCandidate[]) { super(plugin.app); }
  onOpen() {
    this.titleEl.setText(text('要清理本机不再同步的插件吗？', 'Remove the excluded plugins from this device?'));
    const el = this.contentEl; el.addClass('dps');
    el.createEl('p', { text: text('同步选择已应用。下面这些插件已设为不同步，但文件仍在这台设备上。保留它们也可以。', 'Your sync choices have been applied. These plugins are excluded from sync, but their files are still on this device. You can keep them.') });
    el.createEl('p', { text: text('清理会停止所选插件，并把整个插件文件夹（包括设置）移到本机备份。备份不会同步，但仍占用空间。', 'Cleanup stops the selected plugins and moves their complete folders, including settings, into a local backup. Backups do not sync and still take up disk space.') });
    el.createEl('p', { text: text('清理前需要暂停官方 Sync，并等待当前同步结束，避免影响正在传输的文件。若还没暂停，先点“保留本机插件”，到 Sync 设置中暂停，再回本插件点“选择要清理的插件”。检查清理结果后，再自行恢复同步。', 'Pause official Sync and wait for the current sync to finish before cleanup, so files being transferred are not affected. If sync is still running, choose “Keep local plugins”, pause it in Sync settings, then return here and choose “Choose plugins to remove”. Resume sync after checking the result.') });
    const selected = new Set<string>(); let agreed = false; let confirm: { setDisabled(value: boolean): unknown };
    const update = () => confirm?.setDisabled(!agreed || !selected.size);
    for (const plugin of this.candidates) new Setting(el).setName(plugin.name).setDesc(plugin.id)
      .addToggle(t => t.setValue(false).onChange(value => { if (value) selected.add(plugin.id); else selected.delete(plugin.id); update(); }));
    new Setting(el).setName(text('我确认移走所选插件及其本机设置，保留备份。', 'I confirm moving the selected plugins and their local settings into a backup.'))
      .addToggle(t => t.setValue(false).onChange(value => { agreed = value; update(); }));
    new Setting(el).addButton(b => b.setButtonText(text('保留本机插件', 'Keep local plugins')).onClick(() => this.close()))
      .addButton(b => {
        confirm = b; b.setButtonText(text('移走所选插件（保留备份）', 'Remove selected plugins (keep backup)')).setDisabled(true).onClick(() => void this.plugin.run(async () => {
          if (!agreed || !selected.size) return;
          const chosen = this.candidates.filter(p => selected.has(p.id));
          const guard = async () => {
            const host = await compatibleHost(this.plugin);
            const latest = await this.plugin.loadPolicy();
            if (!latest || latest.text !== this.loaded.text) throw new Error(text('同步清单已更新，请重新应用后再清理。', 'The sync list changed. Apply it again before cleanup.'));
            checkApplied(this.plugin, this.loaded, this.deviceId);
            host.assertCurrent(); return host;
          };
          const result = await moveToBackup(this.app.vault.adapter, this.app.vault.configDir, chosen, guard);
          this.close();
          const details = new Modal(this.app);
          details.titleEl.setText(text('本机清理结果', 'Local cleanup result'));
          details.contentEl.createEl('p', { text: text(`已移走 ${result.moved.length} 个插件。备份保存在：`, `Removed ${result.moved.length} plugins. Backup location:`) });
          details.contentEl.createEl('code', { text: result.folder });
          if (result.moved.length) details.contentEl.createEl('p', { text: result.moved.map(p => p.name).join(', ') });
          const remaining = chosen.filter(p => !result.moved.some(done => done.id === p.id));
          if (remaining.length) details.contentEl.createEl('p', { text: text(`未确认移走：${remaining.map(p => p.name).join('、')}`, `Not confirmed removed: ${remaining.map(p => p.name).join(', ')}`) });
          if (result.error) details.contentEl.createEl('p', { text: text(`清理已停止：${result.error}。已移走的插件仍可从备份找回。`, `Cleanup stopped: ${result.error}. Plugins already moved can still be restored from the backup.`) });
          details.contentEl.createEl('p', { text: text('如需找回，请打开“查看本机备份”。插件列表可能需要重新打开 Obsidian 才刷新。确认结果后，再恢复官方 Sync。', 'Use “View local backups” to restore files. The installed-plugin list may need an Obsidian restart to refresh. Resume official Sync after checking the result.') });
          new Setting(details.contentEl).addButton(b => b.setButtonText(text('知道了', 'Done')).onClick(() => details.close()));
          details.open();
        }));
      });
  }
  onClose() { this.contentEl.empty(); }
}

class BackupModal extends Modal {
  constructor(readonly plugin: Owner, readonly backups: Backup[], readonly unreadable: number) { super(plugin.app); }
  onOpen() {
    this.titleEl.setText(text('找回清理过的插件', 'Restore removed plugin files'));
    const el = this.contentEl; el.addClass('dps');
    el.createEl('p', { text: text('先暂停官方 Sync 并等待当前同步结束。这个插件仍需设为不同步，才能放回备份。已有同名插件时不会覆盖。', 'Pause official Sync and wait for it to finish. The plugin must still be excluded from sync before its backup can be restored. An existing plugin will never be overwritten.') });
    el.createEl('p', { text: text('放回后不会自动启用，也不会改变同步选择。若原来已启用，重启 Obsidian 后可能再次加载；请在社区插件设置中检查。', 'Restoring files does not enable the plugin or change sync choices. A previously enabled plugin may load again after restarting Obsidian; check Community plugins.') });
    if (!this.backups.length) el.createEl('p', { text: text('本机没有可找回的插件备份。', 'There are no plugin backups to restore on this device.') });
    if (this.unreadable) el.createEl('p', { text: text(`有 ${this.unreadable} 份备份说明无法读取，请保留备份文件夹并手动检查。`, `${this.unreadable} backup records could not be read. Keep the backup folders and inspect them manually.`) });
    for (const backup of this.backups) new Setting(el).setName(backup.name).setDesc(`${backup.id} · ${backup.createdAt}`)
      .addButton(b => b.setButtonText(text('放回这个插件', 'Restore this plugin')).onClick(() => void this.plugin.run(async () => {
        const result = await restoreBackup(this.app.vault.adapter, this.app.vault.configDir, backup, () => compatibleHost(this.plugin));
        this.close();
        new Notice(result.warning ?? text(`${backup.name} 的文件已放回。同步选择和启用列表没有改变。`, `${backup.name} files were restored. Sync choices and the enabled-plugin list were not changed.`), 10000);
      })));
    new Setting(el).addButton(b => b.setButtonText(text('关闭', 'Close')).onClick(() => this.close()));
  }
  onClose() { this.contentEl.empty(); }
}

export async function offerCleanupAfterApply(plugin: Owner, loaded: Snapshot) {
  try { await offerCleanup(plugin, loaded); }
  catch (error) { new Notice(text(`同步选择已应用，但未能打开清理列表：${reason(error)}`, `Sync choices were applied, but the cleanup list could not be opened: ${reason(error)}`)); }
}
