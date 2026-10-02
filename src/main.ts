import { t, setLanguage, type LanguagePreference } from './i18n';
import { apiVersion, getLanguage, Modal, Notice, Platform, Plugin, PluginSettingTab, Setting, TFile, TFolder } from 'obsidian';
import { PLUGIN_ID, POLICY_PATH, parsePolicy, serializePolicy, planExclusions, pluginPath, type Policy, type LocalState, type Plan, type Installation } from './model';
import { LOCAL_KEY, parseLocalState } from './local-state';
import { inspectSync, readNativeExclusions, type Compatibility } from './sync-adapter';
import { applyPlan, reconcileJournal, samePaths } from './transaction';
import { offerCleanupAfterApply, renderCleanupSettings } from './cleanup-ui';
import { observePluginInstalls } from './install-observer';
import { INSTALLATIONS_PATH, installationPath, serializeInstallation, parseInstallation, addNewInstallations, planNewPlugins } from './new-plugins';

const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const sessionId = String(performance.timeOrigin);
type LoadedPolicy = { policy: Policy; text: string; file: TFile };
type DeviceEdit = { base: LoadedPolicy; deviceId: string; excludedPluginIds: string[] };
const defaultExclusions = (kind: Policy['devices'][number]['kind'], plugins: Policy['plugins']) =>
  kind === 'desktop' ? [] : plugins.filter(p => p.id !== PLUGIN_ID).map(p => p.id);

export default class DevicePluginSync extends Plugin {
  local!: LocalState;
  localError = '';
  busy = false;
  tab!: DeviceSyncSettings;
  private installObserver?: { active: boolean; dispose(): void };
  get installObserverActive() { return this.installObserver?.active === true; }
  newPluginsStatus = '';
  private stopped = false;
  private automaticTimer?: number;
  automaticEnabled() { return this.local.autoNewPlugins !== false; }
  assertAutomaticCurrent(deviceId: string) {
    if (this.stopped || !this.automaticEnabled() || this.local.deviceId !== deviceId) throw new Error(t('newStopped'));
  }

  async onload() {
    try {
      const raw = this.app.loadLocalStorage(LOCAL_KEY);
      const preference = raw && typeof raw === 'object' && ['auto', 'zh', 'en'].includes(raw.language) ? raw.language as LanguagePreference : raw ? 'zh' : 'auto';
      setLanguage(preference, getLanguage());
      this.local = parseLocalState(raw);
      this.saveLocal(this.local);
    } catch (error) { this.localError = message(error); }
    this.tab = new DeviceSyncSettings(this);
    this.addSettingTab(this.tab);
    if (!this.localError) {
      const observer = await observePluginInstalls(this.app, apiVersion, this.app.vault.configDir,
        entry => this.recordInstallation(entry), error => { this.newPluginsStatus = message(error); new Notice(message(error)); });
      this.installObserver = observer;
      this.register(() => { this.stopped = true; observer.dispose(); window.clearTimeout(this.automaticTimer); });
      this.registerInterval(window.setInterval(() => this.scheduleNewPlugins(), 15000));
      this.registerEvent(this.app.vault.on('create', file => { if (file.path === POLICY_PATH || file.path.startsWith(INSTALLATIONS_PATH + '/')) this.scheduleNewPlugins(); }));
      this.registerEvent(this.app.vault.on('modify', file => { if (file.path === POLICY_PATH || file.path.startsWith(INSTALLATIONS_PATH + '/')) this.scheduleNewPlugins(); }));
      this.app.workspace.onLayoutReady(() => this.scheduleNewPlugins());
    }
  }

  scheduleNewPlugins() {
    if (this.stopped) return;
    window.clearTimeout(this.automaticTimer);
    this.automaticTimer = window.setTimeout(() => { void this.checkNewPlugins(); }, 300);
  }
  baseline(policy: Policy) {
    if (!this.local.deviceId) return;
    this.saveLocal({ ...this.local, newPluginBaseline: { deviceId: this.local.deviceId, pluginIds: policy.plugins.map(p => p.id) } });
  }
  async recordInstallation(plugin: Policy['plugins'][number], manual = false) {
    if (this.stopped || (!manual && this.local.autoNewPlugins === false)) return;
    const deviceId = this.local.deviceId;
    const loaded = await this.loadPolicy();
    if (this.stopped || (!manual && !this.automaticEnabled())) return;
    if (this.local.deviceId !== deviceId) throw new Error(t('bindingChangedEditor'));
    const device = loaded?.policy.devices.find(d => d.id === deviceId);
    if (!loaded || !device || (Platform.isMobile && device.kind === 'desktop')) throw new Error(t('newNeedsBinding'));
    if (loaded.policy.plugins.some(p => p.id === plugin.id)) return;
    // Establish the baseline before publishing this new ID, including on the first run after binding.
    if (this.local.newPluginBaseline?.deviceId !== device.id) this.baseline(loaded.policy);
    const record: Installation = { schema: 1, installationId: this.local.installationId, deviceId: device.id,
      plugin: { id: plugin.id, name: plugin.name.slice(0, 160) } };
    installationPath(record);
    if (!this.local.installationQueue?.some(r => r.plugin.id === plugin.id))
      this.saveLocal({ ...this.local, installationQueue: [...(this.local.installationQueue ?? []), record] });
    this.scheduleNewPlugins();
  }
  async readInstallations(): Promise<Installation[]> {
    const adapter = this.app.vault.adapter;
    if (!(await adapter.exists(INSTALLATIONS_PATH))) return [];
    const records: Installation[] = [];
    for (const folder of (await adapter.list(INSTALLATIONS_PATH)).folders) {
      for (const path of (await adapter.list(folder)).files) {
        if (path.endsWith('.md')) records.push(parseInstallation(await adapter.read(path), path));
      }
    }
    return records;
  }
  async writeInstallations(deviceId: string) {
    for (const record of [...(this.local.installationQueue ?? [])]) {
      this.assertAutomaticCurrent(deviceId);
      const path = installationPath(record);
      const parts = path.split('/');
      for (let i = 1; i < parts.length; i++) {
        const folder = parts.slice(0, i).join('/');
        this.assertAutomaticCurrent(deviceId);
        if (!this.app.vault.getAbstractFileByPath(folder)) {
          try { await this.app.vault.createFolder(folder); }
          catch (error) { if (!(this.app.vault.getAbstractFileByPath(folder) instanceof TFolder)) throw error; }
        }
      }
      this.assertAutomaticCurrent(deviceId);
      if (!this.app.vault.getAbstractFileByPath(path)) await this.app.vault.create(path, serializeInstallation(record));
      const existing = parseInstallation(await this.app.vault.adapter.read(path), path);
      if (existing.deviceId !== record.deviceId) throw new Error(t('installationInvalid'));
      this.saveLocal({ ...this.local, installationQueue: this.local.installationQueue?.filter(r => r.plugin.id !== record.plugin.id) });
    }
  }
  async checkNewPlugins() {
    if (this.stopped || this.busy || this.localError || this.local.autoNewPlugins === false) return;
    this.busy = true;
    const beforeStatus = this.newPluginsStatus;
    try {
      let loaded = await this.loadPolicy();
      const device = loaded?.policy.devices.find(d => d.id === this.local.deviceId);
      if (!loaded || !device || (Platform.isMobile && device.kind === 'desktop')) { this.newPluginsStatus = t('newNeedsBinding'); return; }
      if (this.local.newPluginBaseline?.deviceId !== device.id) this.baseline(loaded.policy);
      await this.writeInstallations(device.id);
      const next = addNewInstallations(loaded.policy, await this.readInstallations());
      this.assertAutomaticCurrent(device.id);
      if (next.revision !== loaded.policy.revision) {
        const base = loaded;
        await this.app.vault.process(base.file, current => {
          this.assertAutomaticCurrent(device.id);
          if (current !== base.text) throw new Error(t('policyChangedEditor'));
          return serializePolicy(next);
        });
        loaded = (await this.loadPolicy())!;
      }
      this.assertAutomaticCurrent(device.id);
      const unseen = loaded.policy.plugins.filter(p => !this.local.newPluginBaseline!.pluginIds.includes(p.id));
      if (!unseen.length) { this.newPluginsStatus = t('newUpToDate'); return; }
      if (this.local.pending) throw new Error(t('unfinished'));
      const compatibility = await inspectSync(this.app, apiVersion, Platform.isMobile, this.app.vault.configDir, this.local.mobileExperimentalVersion === apiVersion);
      if (!compatibility.writable || !compatibility.adapter) throw new Error(compatibility.reason);
      if (this.stopped || this.local.deviceId !== device.id || !this.automaticEnabled()) return;
      const latest = await this.loadPolicy();
      this.assertAutomaticCurrent(device.id);
      if (Platform.isMobile && this.local.mobileExperimentalVersion !== apiVersion) throw new Error(t('mobileReadonly'));
      if (!latest || latest.text !== loaded.text) throw new Error(t('policyChangedPreview'));
      const { ids, plan } = planNewPlugins(compatibility.adapter.read(), this.local, loaded.policy, this.app.vault.configDir);
      if (!samePaths(plan.before, plan.after)) {
        await applyPlan(compatibility.adapter, plan, this.local, state => this.saveLocal({ ...this.local,
          // A partial update must not claim that the whole matrix was applied.
          ownedPaths: state.ownedPaths, baselineExclusions: state.baselineExclusions,
          pending: state.pending, lastApplied: undefined }), loaded.policy.revision, sessionId);
      }
      this.baseline(loaded.policy);
      this.newPluginsStatus = plan.warnings.length ? plan.warnings.join(' ') : t('newApplied', { count: ids.length });
      new Notice(this.newPluginsStatus);
    } catch (error) { this.newPluginsStatus = t('newWaiting', { error: message(error) }); }
    finally { this.busy = false; if (this.newPluginsStatus !== beforeStatus) this.tab.display(); }
  }

  saveLocal(value: LocalState) {
    this.app.saveLocalStorage(LOCAL_KEY, value);
    this.local = value;
  }
  saveTransaction(value: LocalState) {
    this.saveLocal({ ...this.local, ownedPaths: value.ownedPaths, baselineExclusions: value.baselineExclusions,
      pending: value.pending, lastApplied: value.lastApplied });
  }
  async run(work: () => Promise<void>) {
    if (this.busy) { new Notice(t('busy')); return; }
    this.busy = true;
    try { await work(); } catch (error) { new Notice(message(error), 10000); }
    finally { this.busy = false; this.tab.display(); }
  }
  async loadPolicy(): Promise<LoadedPolicy | null> {
    const file = this.app.vault.getAbstractFileByPath(POLICY_PATH);
    if (!file) return null;
    if (!(file instanceof TFile)) throw new Error(t('policyNotFile'));
    const text = await this.app.vault.read(file);
    return { file, text, policy: parsePolicy(text) };
  }
  async catalog(): Promise<Policy['plugins']> {
    const root = `${this.app.vault.configDir}/plugins`;
    if (!(await this.app.vault.adapter.exists(root))) return [];
    const entries = await this.app.vault.adapter.list(root);
    const result: Policy['plugins'] = [];
    for (const dir of entries.folders) {
      const id = dir.split('/').pop()!;
      if (id === PLUGIN_ID) continue;
      try {
        pluginPath(this.app.vault.configDir, id);
        const manifest = JSON.parse(await this.app.vault.adapter.read(`${dir}/manifest.json`));
        if (manifest.id === id && typeof manifest.name === 'string') result.push({ id, name: manifest.name.slice(0, 160) });
      } catch { /* Invalid/unreadable manifests are not candidates for automatic path writes. */ }
    }
    return result.sort((a, b) => a.name.localeCompare(b.name));
  }
  async initialize() {
    if (Platform.isMobile) throw new Error(t('initializeDesktop'));
    if (await this.loadPolicy()) throw new Error(t('policyExists'));
    const computer = this.local.installationId;
    const plugins = await this.catalog();
    const policy: Policy = { schema: 1, revision: 1, authorityId: computer,
      devices: [
        { id: computer, name: t('myComputer'), kind: 'desktop', excludedPluginIds: [] },
        { id: crypto.randomUUID(), name: t('myPhone'), kind: 'phone', excludedPluginIds: defaultExclusions('phone', plugins) },
        { id: crypto.randomUUID(), name: t('myTablet'), kind: 'tablet', excludedPluginIds: defaultExclusions('tablet', plugins) },
      ], plugins };
    const folder = POLICY_PATH.slice(0, POLICY_PATH.lastIndexOf('/'));
    const existing = this.app.vault.getAbstractFileByPath(folder);
    if (!existing) await this.app.vault.createFolder(folder);
    else if (!(existing instanceof TFolder)) throw new Error(t('policyFolderConflict'));
    await this.app.vault.create(POLICY_PATH, serializePolicy(policy));
    this.saveLocal({ ...this.local, deviceId: computer, newPluginBaseline: { deviceId: computer, pluginIds: policy.plugins.map(p => p.id) } });
    this.scheduleNewPlugins();
    new Notice(t('created'));
  }
  async publish(base: LoadedPolicy, draft: Policy) {
    if (Platform.isMobile || this.local.installationId !== base.policy.authorityId) throw new Error(t('onlyManager'));
    const next = { ...draft, revision: base.policy.revision + 1 };
    const text = serializePolicy(next);
    await this.app.vault.process(base.file, current => {
      if (current !== base.text) throw new Error(t('policyChangedEditor'));
      return text;
    });
    new Notice(t('published', { revision: next.revision }));
  }
  devicePolicy(edit: DeviceEdit): Policy {
    if (!Platform.isMobile || this.local.deviceId !== edit.deviceId) throw new Error(t('bindingChangedEditor'));
    const next = clone(edit.base.policy);
    const device = next.devices.find(d => d.id === edit.deviceId);
    if (!device || device.kind === 'desktop') throw new Error(t('chooseMobile'));
    if (!samePaths([...device.excludedPluginIds].sort(), [...edit.excludedPluginIds].sort())) {
      device.excludedPluginIds = [...edit.excludedPluginIds];
      next.revision++;
    }
    serializePolicy(next); // Validate IDs and revision before either policy or native writes.
    return next;
  }
  async publishDevice(edit: DeviceEdit): Promise<LoadedPolicy> {
    const policy = this.devicePolicy(edit);
    const latest = await this.loadPolicy();
    if (!latest || latest.text !== edit.base.text) throw new Error(t('policyChangedEditor'));
    if (policy.revision === edit.base.policy.revision) return latest;
    const text = serializePolicy(policy);
    await this.app.vault.process(edit.base.file, current => {
      this.devicePolicy(edit);
      if (current !== edit.base.text) throw new Error(t('policyChangedEditor'));
      return text;
    });
    return { policy, text, file: edit.base.file };
  }
  async preview(restore = false, edit?: DeviceEdit) {
    const loaded = restore ? null : edit?.base ?? await this.loadPolicy();
    if (!restore && !loaded) throw new Error(t('noPolicy'));
    if (edit) this.devicePolicy(edit);
    const device = loaded?.policy.devices.find(d => d.id === this.local.deviceId);
    if (!restore && !device) throw new Error(t('chooseDeviceFirst'));
    if (this.local.pending) throw new Error(t('unfinished'));
    const current = readNativeExclusions(this.app);
    const plan = planExclusions(current, this.local.ownedPaths, restore ? [] : edit?.excludedPluginIds ?? device!.excludedPluginIds, this.app.vault.configDir);
    const compatibility = await inspectSync(this.app, apiVersion, Platform.isMobile, this.app.vault.configDir, this.local.mobileExperimentalVersion === apiVersion);
    new PreviewModal(this, loaded, plan, compatibility, restore, edit).open();
  }
}

class DeviceSyncSettings extends PluginSettingTab {
  generation = 0;
  constructor(readonly plugin: DevicePluginSync) { super(plugin.app, plugin); }
  display() { void this.render(this.containerEl); }
  async render(container: HTMLElement) {
    setLanguage(this.plugin.local?.language ?? 'zh', getLanguage());
    const generation = ++this.generation;
    container.empty(); container.addClass('dps');
    container.createEl('h2', { text: 'Device Selective Sync' });
    container.createEl('p', { text: t('intro') });
    if (this.plugin.localError) {
      container.createEl('p', { text: this.plugin.localError, cls: 'dps-warning' });
      return;
    }
    new Setting(container).setName(t('language')).setDesc(t('languageDesc'))
      .addDropdown(d => d.addOptions({ auto: t('languageAuto'), zh: '简体中文', en: 'English' })
        .setValue(this.plugin.local.language ?? 'zh').onChange(value => {
          this.plugin.saveLocal({ ...this.plugin.local, language: value as LanguagePreference });
          this.display();
        }));
    try {
      const [loaded, compatibility] = await Promise.all([
        this.plugin.loadPolicy(), inspectSync(this.app, apiVersion, Platform.isMobile, this.app.vault.configDir, this.plugin.local.mobileExperimentalVersion === apiVersion),
      ]);
      if (generation !== this.generation) return;
      container.createEl('p', { text: compatibility.reason, cls: 'dps-status' });
      if (Platform.isMobile && (compatibility.experimentalEligible || this.plugin.local.mobileExperimentalVersion === apiVersion)) {
        new Setting(container).setName(t('mobileExperimental')).setDesc(t('mobileExperimentalDesc'))
          .addToggle(t => t.setValue(this.plugin.local.mobileExperimentalVersion === apiVersion).onChange(value => {
            this.plugin.saveLocal({ ...this.plugin.local, mobileExperimentalVersion: value ? apiVersion : undefined }); this.display();
          }));
      }
      new Setting(container).setName(t('refreshName')).addButton(b => b.setButtonText(t('refresh')).onClick(() => this.display()));
      const diagnostic = container.createEl('details');
      diagnostic.createEl('summary', { text: t('diagnostics') });
      diagnostic.createEl('pre', { text: compatibility.diagnostics });
      if (!loaded) {
        container.createEl('p', { text: t('policyMissing', { path: POLICY_PATH }) });
        if (!Platform.isMobile) new Setting(container).setName(t('initializeName'))
          .addButton(b => b.setButtonText(t('initialize')).onClick(() => void this.plugin.run(() => this.plugin.initialize())));
        this.renderRecovery(container);
        return;
      }
      container.createEl('p', { text: t('policyStatus', { revision: loaded.policy.revision }) });
      let selected = this.plugin.local.deviceId ?? '';
      new Setting(container).setName(t('deviceName')).setDesc(t('deviceDesc'))
        .addDropdown(d => {
          d.addOption('', t('selectDevice'));
          for (const device of loaded.policy.devices) {
            if (!Platform.isMobile || device.kind !== 'desktop') d.addOption(device.id, device.name);
          }
          d.setValue(selected).onChange(value => { selected = value; });
        }).addButton(b => b.setButtonText(t('useDevice')).onClick(() => void this.plugin.run(async () => {
          if (!selected) throw new Error(t('missingDevice'));
          if (Platform.isMobile && loaded.policy.devices.find(d => d.id === selected)?.kind === 'desktop') throw new Error(t('chooseMobile'));
          if (this.plugin.local.pending || this.plugin.local.ownedPaths.length) throw new Error(t('bindingOwned'));
          const latest = await this.plugin.loadPolicy();
          if (!latest || latest.text !== loaded.text) throw new Error(t('policyChangedEditor'));
          this.plugin.saveLocal({ ...this.plugin.local, deviceId: selected, lastApplied: undefined,
            newPluginBaseline: { deviceId: selected, pluginIds: latest.policy.plugins.map(p => p.id) } });
          this.plugin.scheduleNewPlugins();
        })));
      if (!Platform.isMobile && loaded.policy.authorityId === this.plugin.local.installationId) {
        new Setting(container).setName(t('editAllName')).setDesc(t('editAllDesc'))
          .addButton(b => b.setButtonText(t('editAll')).onClick(() => void this.plugin.run(async () => {
            new PolicyEditor(this.plugin, loaded, await this.plugin.catalog()).open();
          })));
      }
      const local = this.plugin.local;
      const device = loaded.policy.devices.find(d => d.id === local.deviceId);
      new Setting(container).setName(t('autoNewName')).setDesc(t('autoNewDesc'))
        .addToggle(toggle => toggle.setValue(local.autoNewPlugins !== false).onChange(value => {
          this.plugin.saveLocal({ ...this.plugin.local, autoNewPlugins: value });
          if (value) this.plugin.scheduleNewPlugins();
          this.display();
        }));
      container.createEl('p', { text: this.plugin.installObserverActive ? t('installObserverReady') : t('installObserverUnavailable') });
      if (this.plugin.newPluginsStatus) container.createEl('p', { text: this.plugin.newPluginsStatus });
      new Setting(container).setName(t('registerInstalledName')).setDesc(t('registerInstalledDesc'))
        .addButton(b => b.setButtonText(t('registerInstalled')).setDisabled(!device || local.autoNewPlugins === false)
          .onClick(() => void this.plugin.run(async () => {
            const latest = await this.plugin.loadPolicy();
            if (!latest || !this.plugin.local.deviceId) throw new Error(t('chooseDeviceFirst'));
            const known = new Set(latest.policy.plugins.map(p => p.id));
            const candidates = (await this.plugin.catalog()).filter(p => !known.has(p.id));
            new RegisterInstallationsModal(this.plugin, candidates, this.plugin.local.deviceId).open();
          })))
        .addButton(b => b.setButtonText(t('checkNewNow')).onClick(() => void this.plugin.checkNewPlugins()));
      if (Platform.isMobile) {
        new Setting(container).setName(t('editOwnName')).setDesc(t('editOwnDesc'))
          .addButton(b => b.setButtonText(t('editOwn')).setDisabled(!device || device.kind === 'desktop').onClick(() => void this.plugin.run(async () => {
            if (!device || device.kind === 'desktop') throw new Error(t('chooseMobile'));
            new PolicyEditor(this.plugin, loaded, [], device.id).open();
          })));
      }
      container.createEl('p', { text: device ? t('deviceStatus', { name: device.name, count: device.excludedPluginIds.length }) : t('unbound') });
      if (local.lastApplied) {
        let matches = false;
        try { matches = samePaths(readNativeExclusions(this.app), local.lastApplied.paths); } catch { /* Status only. */ }
        const restored = local.lastApplied.revision === -1;
        container.createEl('p', { text: t('appliedStatus', { action: restored ? t('resumedAction') : t('appliedAction', { revision: local.lastApplied.revision }), date: local.lastApplied.appliedAt, status: matches ? t('settingsMatch') : t('settingsDiffer'), restart: local.lastApplied.sessionId !== sessionId && matches ? t('settingsAfterRestart') : '' }) });
      }
      new Setting(container).setName(t('reviewName')).setDesc(t('reviewDesc'))
        .addButton(b => b.setButtonText(t('review')).setDisabled(!device).onClick(() => void this.plugin.run(() => this.plugin.preview())));
      this.renderRecovery(container);
    } catch (error) { container.createEl('p', { text: message(error), cls: 'dps-warning' }); this.renderRecovery(container); }
  }
  renderRecovery(container: HTMLElement) {
    if (!this.plugin.local) return;
    renderCleanupSettings(container, this.plugin);
    new Setting(container).setName(t('restoreName')).setDesc(t('restoreDesc'))
      .addButton(b => b.setButtonText(t('reviewRestore')).onClick(() => void this.plugin.run(() => this.plugin.preview(true))));
    const details = container.createEl('details'); details.createEl('summary', { text: t('troubleshooting') });
    if (this.plugin.local.pending) new Setting(details).setName(t('unfinishedName')).setDesc(t('unfinishedDesc'))
      .addButton(b => b.setButtonText(t('checkUnfinished')).onClick(() => void this.plugin.run(async () => {
        this.plugin.saveLocal(reconcileJournal(this.plugin.local, readNativeExclusions(this.app)));
        new Notice(t('journalReconciled'));
      })));
    let agreed = false;
    new Setting(details).setName(t('resetRecords')).setDesc(t('resetRecordsDesc'))
      .addToggle(t => t.onChange(value => { agreed = value; }))
      .addButton(b => b.setButtonText(t('resetRecordsButton')).onClick(() => void this.plugin.run(async () => {
        if (!agreed) throw new Error(t('confirmResetRecords'));
        this.plugin.saveLocal({ ...this.plugin.local, ownedPaths: [], pending: undefined, lastApplied: undefined });
      })));
  }
}

class PreviewModal extends Modal {
  readonly deviceId: string | null;
  constructor(readonly plugin: DevicePluginSync, readonly loaded: LoadedPolicy | null,
    readonly plan: Plan, readonly compatibility: Compatibility, readonly restore: boolean,
    readonly edit?: DeviceEdit) { super(plugin.app); this.deviceId = plugin.local.deviceId; }
  checkLocal() {
    if (!this.restore && this.plugin.local.deviceId !== this.deviceId) throw new Error(t('bindingChangedPreview'));
    if (this.plugin.local.pending) throw new Error(t('unfinished'));
    const desired = this.restore ? [] : this.edit?.excludedPluginIds ?? this.loaded!.policy.devices.find(d => d.id === this.deviceId)!.excludedPluginIds;
    const planned = planExclusions(this.plan.before, this.plugin.local.ownedPaths, desired, this.app.vault.configDir);
    if (!samePaths(planned.after, this.plan.after) || !samePaths(planned.ownedAfter, this.plan.ownedAfter))
      throw new Error(t('localChangedPreview'));
  }
  onOpen() {
    this.titleEl.setText(this.restore ? t('restoreTitle') : t('previewTitle'));
    const el = this.contentEl; el.addClass('dps');
    if (this.edit) el.createEl('p', { text: t('editPreviewDesc') });
    el.createEl('p', { text: this.compatibility.reason });
    for (const [label, paths] of [[t('willStop'), this.plan.add], [t('willResume'), this.plan.remove], [t('blockedElsewhere'), this.plan.externallyExcluded]] as const) {
      el.createEl('h3', { text: `${label} (${paths.length})` });
      const names = paths.map(path => {
        const id = path.split('/').pop();
        return this.loaded?.policy.plugins.find(plugin => plugin.id === id)?.name ?? id ?? path;
      });
      el.createEl('p', { text: names.join(', ') || t('none') });
      if (paths.length) {
        const details = el.createEl('details'); details.createEl('summary', { text: t('filePaths') });
        details.createEl('pre', { text: paths.join('\n') });
      }
    }
    for (const warning of this.plan.warnings) el.createEl('p', { text: warning, cls: 'dps-warning' });
    el.createEl('p', { text: t('previewBoundary') });
    new Setting(el).addButton(b => b.setButtonText(t('cancel')).onClick(() => this.close()))
      .addButton(b => b.setButtonText(this.edit ? t('saveApplyConfirm') : t('applyConfirm')).setCta().setDisabled(!this.compatibility.writable)
        .onClick(() => void this.plugin.run(async () => {
          this.checkLocal();
          if (!this.restore) {
            const latest = await this.plugin.loadPolicy();
            if (!latest || latest.text !== this.loaded?.text) throw new Error(t('policyChangedPreview'));
          }
          let fresh = await inspectSync(this.app, apiVersion, Platform.isMobile, this.app.vault.configDir, this.plugin.local.mobileExperimentalVersion === apiVersion);
          if (!fresh.writable || !fresh.adapter) throw new Error(fresh.reason);
          this.checkLocal();
          if (!samePaths(fresh.adapter.read(), this.plan.before)) throw new Error(t('exclusionsChanged'));
          let appliedPolicy = this.loaded;
          if (this.edit) appliedPolicy = await this.plugin.publishDevice(this.edit);
          try {
            if (this.edit) {
              const latest = await this.plugin.loadPolicy();
              if (!latest || latest.text !== appliedPolicy!.text) throw new Error(t('policyChangedAgain'));
              fresh = await inspectSync(this.app, apiVersion, Platform.isMobile, this.app.vault.configDir, this.plugin.local.mobileExperimentalVersion === apiVersion);
            }
            if (!fresh.writable || !fresh.adapter) throw new Error(fresh.reason);
            this.checkLocal();
            await applyPlan(fresh.adapter, this.plan, this.plugin.local, value => this.plugin.saveTransaction(value),
              this.restore ? -1 : appliedPolicy!.policy.revision, sessionId);
            const current = appliedPolicy ?? await this.plugin.loadPolicy();
            if (current) this.plugin.baseline(current.policy);
          } catch (error) {
            if (!this.edit) throw error;
            this.close();
            throw new Error(t('savedApplyFailed', { revision: appliedPolicy!.policy.revision, error: message(error) }));
          }
          this.close();
          new Notice(t('appliedNotice'), 10000);
          if (!this.restore && appliedPolicy) await offerCleanupAfterApply(this.plugin, appliedPolicy);
        })));
  }
  onClose() { this.contentEl.empty(); }
}

class RegisterInstallationsModal extends Modal {
  constructor(readonly plugin: DevicePluginSync, readonly candidates: Policy['plugins'], readonly deviceId: string) { super(plugin.app); }
  onOpen() {
    this.titleEl.setText(t('registerInstalled'));
    this.contentEl.createEl('p', { text: t('registerInstalledConfirmDesc') });
    const selected = new Set<string>();
    if (!this.candidates.length) this.contentEl.createEl('p', { text: t('noUnregistered') });
    for (const entry of this.candidates) new Setting(this.contentEl).setName(entry.name).setDesc(entry.id)
      .addToggle(toggle => toggle.setValue(false).onChange(value => { if (value) selected.add(entry.id); else selected.delete(entry.id); }));
    new Setting(this.contentEl).addButton(b => b.setButtonText(t('cancel')).onClick(() => this.close()))
      .addButton(b => b.setButtonText(t('registerConfirm')).setDisabled(!this.candidates.length).onClick(() => void this.plugin.run(async () => {
        if (this.plugin.local.deviceId !== this.deviceId) throw new Error(t('bindingChangedEditor'));
        if (!selected.size) throw new Error(t('chooseRegistration'));
        for (const entry of this.candidates.filter(p => selected.has(p.id))) await this.plugin.recordInstallation(entry, true);
        this.close();
        new Notice(t('registrationQueued'));
      })));
  }
  onClose() { this.contentEl.empty(); }
}

class PolicyEditor extends Modal {
  draft: Policy;
  initialDefaults: boolean;
  constructor(readonly plugin: DevicePluginSync, readonly base: LoadedPolicy, catalog: Policy['plugins'], readonly deviceId?: string) {
    super(plugin.app); this.draft = clone(base.policy);
    this.initialDefaults = false;
    if (deviceId) return; // Mobile edits the published catalog and this column only.
    // Only the old, never-published initial template receives the new defaults.
    this.initialDefaults = base.policy.revision === 1 && base.policy.devices.every(d => d.excludedPluginIds.length === 0);
    const merged = new Map(this.draft.plugins.map(p => [p.id, p]));
    const newIds = catalog.filter(p => p.id !== PLUGIN_ID && !merged.has(p.id)).map(p => p.id);
    for (const entry of catalog) merged.set(entry.id, entry);
    this.draft.plugins = [...merged.values()].sort((a, b) => a.name.localeCompare(b.name));
    for (const device of this.draft.devices) {
      if (device.kind === 'desktop') continue;
      if (this.initialDefaults) device.excludedPluginIds = defaultExclusions(device.kind, this.draft.plugins);
      else device.excludedPluginIds.push(...newIds);
    }
  }
  onOpen() { this.modalEl.addClass('dps-editor'); this.draw(); }
  draw() {
    this.titleEl.setText(t('editorTitle', { scope: this.deviceId ? t('editOwn') : t('editAll'), revision: this.base.policy.revision }));
    const el = this.contentEl; el.empty(); el.addClass('dps');
    const devices = this.deviceId ? this.draft.devices.filter(d => d.id === this.deviceId) : this.draft.devices;
    el.createEl('p', { text: t('editorDesc') });
    if (this.initialDefaults) el.createEl('p', { text: t('initialDefaults') });
    if (this.deviceId) el.createEl('p', { text: t('mobileEditorDesc') });
    if (!this.deviceId) {
      for (const device of this.draft.devices) new Setting(el).setName(t('deviceLabel', { kind: t(device.kind) }))
        .addText(t => t.setValue(device.name).onChange(value => { device.name = value; }));
      let name = ''; let kind: Policy['devices'][number]['kind'] = 'phone';
      new Setting(el).setName(t('addDeviceName')).addText(input => input.setPlaceholder(t('devicePlaceholder')).onChange(v => { name = v; }))
        .addDropdown(d => d.addOptions({ desktop: t('desktop'), phone: t('phone'), tablet: t('tablet') }).setValue(kind).onChange(v => { kind = v as typeof kind; }))
        .addButton(b => b.setButtonText(t('add')).onClick(() => {
          if (!name.trim()) { new Notice(t('nameRequired')); return; }
          this.draft.devices.push({ id: crypto.randomUUID(), name: name.trim(), kind, excludedPluginIds: defaultExclusions(kind, this.draft.plugins) }); this.draw();
        }));
    }
    const wrap = el.createDiv({ cls: 'dps-table-wrap' }); const table = wrap.createEl('table');
    const head = table.createEl('thead').createEl('tr'); head.createEl('th', { text: t('plugin') });
    for (const device of devices) {
      const column = head.createEl('th'); column.createDiv({ text: device.name });
      const actions = column.createDiv({ cls: 'dps-column-actions' });
      for (const selected of [true, false]) {
        const text = selected ? t('selectAll') : t('selectNone');
        const button = actions.createEl('button', { text, attr: { type: 'button', 'aria-label': `${device.name} ${text}` } });
        button.addEventListener('click', () => {
          device.excludedPluginIds = selected ? [] : this.draft.plugins.filter(p => p.id !== PLUGIN_ID).map(p => p.id);
          this.draw();
        });
      }
    }
    const body = table.createEl('tbody');
    for (const plugin of this.draft.plugins) {
      if (plugin.id === PLUGIN_ID) continue;
      const row = body.createEl('tr'); const label = row.createEl('td'); label.createDiv({ text: plugin.name }); label.createEl('small', { text: plugin.id });
      for (const device of devices) {
        const input = row.createEl('td').createEl('input', { type: 'checkbox', attr: { 'aria-label': t('syncCheckbox', { device: device.name, plugin: plugin.name }) } });
        input.checked = !device.excludedPluginIds.includes(plugin.id);
        input.addEventListener('change', () => {
          device.excludedPluginIds = device.excludedPluginIds.filter(id => id !== plugin.id);
          if (!input.checked) device.excludedPluginIds.push(plugin.id);
        });
      }
    }
    if (!this.draft.plugins.length) el.createEl('p', { text: this.deviceId ? t('emptyMobileCatalog') : t('emptyCatalog') });
    new Setting(el).addButton(b => b.setButtonText(t('cancel')).onClick(() => this.close()))
      .addButton(b => b.setButtonText(this.deviceId ? t('saveApply') : t('saveList')).setCta().onClick(() => void this.plugin.run(async () => {
        if (this.deviceId) await this.plugin.preview(false, { base: this.base, deviceId: this.deviceId, excludedPluginIds: [...devices[0].excludedPluginIds] });
        else await this.plugin.publish(this.base, this.draft);
        this.close();
      })));
  }
  onClose() { this.contentEl.empty(); }
}
