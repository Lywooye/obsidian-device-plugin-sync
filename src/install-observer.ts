import { PLUGIN_ID, pluginPath } from './model';

const INSTALL_VERSION = '1.13.7';
const INSTALL_FINGERPRINT = '1d4053d0d73d2dcc35d2d2e8ff53d439351d988d9080a67ceb754cf41ad24d25';
type InstalledPlugin = { id: string; name: string };
type Manager = {
  manifests: Record<string, unknown>;
  installPlugin: (...args: unknown[]) => Promise<unknown>;
};
type Adapter = {
  exists(path: string): Promise<boolean>;
  read(path: string): Promise<string>;
};
type Observation = { active: boolean; dispose(): void };

function pluginInfo(value: unknown): InstalledPlugin | null {
  if (!value || typeof value !== 'object') return null;
  const { id, name } = value as Partial<InstalledPlugin>;
  if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9_-]*$/.test(id)
    || id === PLUGIN_ID || id === 'prototype' || Object.prototype.hasOwnProperty.call(Object.prototype, id)
    || typeof name !== 'string' || !name.trim() || /[\u0000-\u001f\u007f]/.test(name)) return null;
  return { id, name };
}

// The native installer identifies an intentional local installation. Directory
// changes alone cannot distinguish one from a file downloaded by Sync.
export async function observePluginInstalls(
  app: unknown,
  version: string,
  configDir: string,
  onInstalled: (plugin: InstalledPlugin) => Promise<void> | void,
  onError: (error: unknown) => void,
): Promise<Observation> {
  const inactive = (): Observation => ({ active: false, dispose() {} });
  if (version !== INSTALL_VERSION) return inactive();
  const host = app as { plugins?: Manager; vault?: { configDir?: string; adapter?: Adapter } } | null;
  const manager = host?.plugins;
  const vault = host?.vault;
  const adapter = vault?.adapter;
  if (!manager || !manager.manifests || typeof manager.manifests !== 'object' || Array.isArray(manager.manifests)
    || typeof manager.installPlugin !== 'function' || vault?.configDir !== configDir
    || typeof adapter?.exists !== 'function' || typeof adapter?.read !== 'function') return inactive();
  const original = manager.installPlugin;
  const descriptor = Object.getOwnPropertyDescriptor(manager, 'installPlugin');
  if (descriptor && (!('value' in descriptor) || !descriptor.writable)) return inactive();
  try {
    pluginPath(configDir, 'installation-observer-check');
    const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(Function.prototype.toString.call(original)));
    const hash = Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('');
    if (hash !== INSTALL_FINGERPRINT || manager.installPlugin !== original
      || host?.plugins !== manager || host.vault !== vault || vault.adapter !== adapter) return inactive();
  } catch { return inactive(); }

  let active = true;
  const inFlight = new Set<string>();
  const current = () => active && host?.plugins === manager && host.vault === vault
    && vault.adapter === adapter && vault.configDir === configDir && manager.installPlugin === wrapped;
  const report = (error: unknown) => {
    if (active) { try { onError(error); } catch { /* An observer must not break installation. */ } }
  };
  function wrapped(this: Manager, ...args: unknown[]): Promise<unknown> {
    let candidate: InstalledPlugin | null = null;
    try { candidate = pluginInfo(args[2]); } catch (error) { report(error); }
    let absent: Promise<boolean> | undefined;
    let path = '';
    if (current() && this === manager && candidate && !inFlight.has(candidate.id)
      && !Object.prototype.hasOwnProperty.call(manager.manifests, candidate.id)) {
      path = pluginPath(configDir, candidate.id);
      inFlight.add(candidate.id);
      try {
        // Start the existence check before invoking the original installer. Do
        // not await it here: the caller must receive the original Promise.
        absent = Promise.resolve(adapter!.exists(path)).then(exists => exists === false, error => { report(error); return false; });
      } catch (error) { report(error); inFlight.delete(candidate.id); }
    }
    let result: Promise<unknown>;
    try { result = Reflect.apply(original, this, args); }
    catch (error) {
      if (candidate && absent) inFlight.delete(candidate.id);
      throw error;
    }
    if (candidate && absent) {
      void result.then(async () => {
        if (!await absent || !current()) return;
        if (!await adapter!.exists(`${path}/manifest.json`) || !await adapter!.exists(`${path}/main.js`)) return;
        const installed = pluginInfo(JSON.parse(await adapter!.read(`${path}/manifest.json`)));
        if (!installed || installed.id !== candidate.id || !(await adapter!.read(`${path}/main.js`)).trim() || !current()) return;
        await onInstalled(installed);
      }, () => undefined).catch(report).finally(() => inFlight.delete(candidate.id));
    }
    return result;
  }
  try {
    Object.defineProperty(manager, 'installPlugin', descriptor
      ? { ...descriptor, value: wrapped }
      : { value: wrapped, configurable: true, writable: true, enumerable: true });
  } catch { active = false; return inactive(); }
  return {
    get active() { return current(); },
    dispose() {
      active = false;
      if (manager.installPlugin !== wrapped) return;
      try {
        if (descriptor) Object.defineProperty(manager, 'installPlugin', descriptor);
        else delete (manager as Partial<Manager>).installPlugin;
      } catch (error) { try { onError(error); } catch { /* Disposal must remain safe. */ } }
    },
  };
}
