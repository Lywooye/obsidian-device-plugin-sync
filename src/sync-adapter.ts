import { t } from './i18n';
import profile from './native-profile.json';
import { PLUGIN_ID } from './model';
import { samePaths, type ExclusionAdapter } from './transaction';

type NativeFilter = {
  configDir: string; ignoreFolders: string[]; allowTypes: Set<string>;
  allowSpecialFiles: Set<string>; filterCache: Record<string, boolean>;
  allowSyncFile(path: string, folder: boolean): boolean;
};
type NativeSync = {
  dirty: boolean; initialized: boolean; dataLoaded: boolean; db: unknown; vaultId: string;
  filter: NativeFilter; setIgnoreFolders(paths: string[]): void; saveData(): Promise<void>;
};
export interface Compatibility {
  writable: boolean; experimentalEligible?: boolean; reason: string; diagnostics: string; adapter?: ExclusionAdapter;
}
const pathsFrom = (value: unknown): string[] => {
  if (!Array.isArray(value) || value.some(p => typeof p !== 'string') || new Set(value).size !== value.length)
    throw new Error(t('nativeInvalid'));
  return [...value];
};
async function digest(fn: unknown): Promise<string> {
  if (typeof fn !== 'function') return 'missing';
  const hash = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(Function.prototype.toString.call(fn)));
  return Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2, '0')).join('');
}

// Private Sync writes are confined to this module. Never patch the engine or its DB.
export async function inspectSync(app: unknown, version: string, mobile: boolean, configDir: string, mobileExperimental = false): Promise<Compatibility> {
  const report: Record<string, unknown> = { apiVersion: version, platform: mobile ? 'mobile' : 'desktop', profile: profile.version };
  const fail = (reason: string): Compatibility => ({ writable: false, reason, diagnostics: JSON.stringify(report, null, 2) });
  try {
    const host = app as { internalPlugins?: { getEnabledPluginById?(id: string): unknown } };
    const sync = host.internalPlugins?.getEnabledPluginById?.('sync') as NativeSync | undefined;
    if (!sync) return fail(t('syncUnavailable'));
    if (sync.initialized !== true || sync.dataLoaded !== true || !sync.db || typeof sync.vaultId !== 'string' || !sync.vaultId)
      return fail(t('syncNotReady'));
    if (version !== profile.version) return fail(t('versionUnsupported', { version, supported: profile.version }));
    const filter = sync.filter;
    if (!filter || filter.configDir !== configDir || !(filter.allowTypes instanceof Set) || !(filter.allowSpecialFiles instanceof Set))
      return fail(t('filterMismatch'));
    pathsFrom(filter.ignoreFolders);
    const mismatches: string[] = [];
    const observed: Record<string, string> = {};
    const references: { object: Record<string, unknown>; name: string; fn: unknown }[] = [];
    for (const [group, signatures] of Object.entries(profile.fingerprints)) {
      const object = group === 'sync' ? sync : filter;
      for (const [name, expected] of Object.entries(signatures)) {
        const owner = object as unknown as Record<string, unknown>;
        const fn = owner[name];
        references.push({ object: owner, name, fn });
        const actual = await digest(fn);
        observed[`${group}.${name}`] = actual;
        if (actual !== expected) mismatches.push(`${group}.${name}`);
      }
    }
    const referencesMatch = () => references.every(({ object, name, fn }) => object[name] === fn);
    if (!referencesMatch()) return fail(t('methodsChangedRefresh'));
    const setter = sync.setIgnoreFolders;
    const saveNative = sync.saveData;
    report.fingerprints = observed;
    if (mismatches.length) return fail(t('fingerprintsMismatch', { methods: mismatches.join(', ') }));
    probeFilter(filter, configDir);
    report.detachedFilterProbe = 'passed';
    // A matching desktop source is not proof of the separately shipped mobile build.
    if (mobile && !mobileExperimental) return { ...fail(t('mobileReadonly')), experimentalEligible: true };
    const adapter: ExclusionAdapter = {
      read: () => pathsFrom(sync.filter.ignoreFolders),
      async write(before, after) {
        // Recheck after asynchronous hashing and immediately before the synchronous setter.
        const checked = await inspectSync(app, version, mobile, configDir, mobileExperimental);
        if (!checked.writable) throw new Error(checked.reason);
        if (!referencesMatch()) throw new Error(t('methodsChanged'));
        if (host.internalPlugins?.getEnabledPluginById?.('sync') !== sync || sync.filter !== filter)
          throw new Error(t('syncChanged'));
        if (!samePaths(pathsFrom(filter.ignoreFolders), before)) throw new Error(t('exclusionsChanged'));
        pathsFrom(after);
        setter.call(sync, [...after]);
        // setIgnoreFolders schedules a debounced save; await the original save operation itself.
        if (sync.dirty !== true) throw new Error(t('saveUnconfirmed'));
        const saving = saveNative.call(sync);
        if (!saving || typeof saving.then !== 'function') throw new Error(t('saveInterface'));
        try { await saving; } catch { throw new Error(t('saveFailed')); }
        if (!samePaths(pathsFrom(filter.ignoreFolders), after)) throw new Error(t('savedThenChanged'));
      },
    };
    return { writable: true, reason: t('compatible'),
      diagnostics: JSON.stringify(report, null, 2), adapter };
  } catch (error) {
    return fail(t('compatibilityFailed', { error: error instanceof Error ? error.message : String(error) }));
  }
}

export function readNativeExclusions(app: unknown): string[] {
  const host = app as { internalPlugins?: { getEnabledPluginById?(id: string): unknown } };
  const sync = host.internalPlugins?.getEnabledPluginById?.('sync') as NativeSync | undefined;
  if (!sync?.dataLoaded || !sync.filter) throw new Error(t('cannotReadSync'));
  return pathsFrom(sync.filter.ignoreFolders);
}

function probeFilter(source: NativeFilter, configDir: string): void {
  const isolated = Object.assign(Object.create(Object.getPrototypeOf(source)), {
    configDir, allowTypes: new Set(source.allowTypes),
    allowSpecialFiles: new Set(['community-plugin', 'community-plugin-data']),
    ignoreFolders: [], filterCache: {},
  }) as NativeFilter;
  const target = `${configDir}/plugins/dps-compatibility-probe`;
  const files = ['main.js', 'manifest.json', 'styles.css', 'data.json'];
  for (const file of files) if (!isolated.allowSyncFile(`${target}/${file}`, false)) throw new Error(t('probeBaseline'));
  isolated.ignoreFolders = [target];
  isolated.filterCache = {};
  for (const file of files) if (isolated.allowSyncFile(`${target}/${file}`, false)) throw new Error(t('probeExclusion'));
  for (const path of [`${target}-sibling/main.js`, `${configDir}/plugins/${PLUGIN_ID}/main.js`, 'dps-compatibility-probe.md'])
    if (!isolated.allowSyncFile(path, false)) throw new Error(t('probeUnrelated'));
}
