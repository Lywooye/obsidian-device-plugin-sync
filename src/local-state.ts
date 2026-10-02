import { t } from './i18n';
import type { LocalState } from './model';
import { validateJournal } from './transaction';
import { validateInstallation } from './new-plugins';
const KEY = 'device-plugin-sync:local:v1';
export { KEY as LOCAL_KEY };
const safeId = (x: unknown): x is string => typeof x === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(x) && x !== 'prototype' && !Object.prototype.hasOwnProperty.call(Object.prototype, x);
const strings = (x: unknown): x is string[] => Array.isArray(x) && x.every(v => typeof v === 'string') && new Set(x).size === x.length;
export function parseLocalState(raw: unknown): LocalState {
  if (raw === null || raw === undefined) return { schema: 1, language: 'auto', installationId: crypto.randomUUID(), deviceId: null, ownedPaths: [], baselineExclusions: null };
  if (typeof raw !== 'object' || Array.isArray(raw) || Object.getPrototypeOf(raw) !== Object.prototype) throw new Error(t('localDamaged'));
  const x = raw as Partial<LocalState>;
  if (x.schema !== 1 || !safeId(x.installationId) ||
      !(x.deviceId === null || safeId(x.deviceId)) || !strings(x.ownedPaths) ||
      !(x.baselineExclusions === null || strings(x.baselineExclusions))) throw new Error(t('localInvalid'));
  if (x.mobileExperimentalVersion !== undefined && typeof x.mobileExperimentalVersion !== 'string') throw new Error(t('experimentalInvalid'));
  if (x.pending !== undefined && (!x.pending || typeof x.pending !== 'object' || !strings(x.pending.before) || !strings(x.pending.after) || !strings(x.pending.ownedBefore) || !strings(x.pending.ownedAfter)))
    throw new Error(t('pendingInvalid'));
  if (x.lastApplied !== undefined && (!x.lastApplied || typeof x.lastApplied !== 'object' || x.lastApplied.revision < -1 || !Number.isSafeInteger(x.lastApplied.revision) || !strings(x.lastApplied.paths) ||
      typeof x.lastApplied.appliedAt !== 'string' || !Number.isFinite(Date.parse(x.lastApplied.appliedAt)) || typeof x.lastApplied.sessionId !== 'string' || x.lastApplied.sessionId.length === 0)) throw new Error(t('appliedInvalid'));
  if (x.language !== undefined && !['auto', 'zh', 'en'].includes(x.language)) throw new Error(t('languageInvalid'));
  if (x.autoNewPlugins !== undefined && typeof x.autoNewPlugins !== 'boolean') throw new Error(t('localInvalid'));
  if (x.newPluginBaseline !== undefined && (!x.newPluginBaseline || !safeId(x.newPluginBaseline.deviceId)
    || !strings(x.newPluginBaseline.pluginIds) || !x.newPluginBaseline.pluginIds.every(safeId))) throw new Error(t('localInvalid'));
  if (x.installationQueue !== undefined) {
    if (!Array.isArray(x.installationQueue)) throw new Error(t('localInvalid'));
    x.installationQueue.forEach(validateInstallation);
  }
  validateJournal(x as LocalState);
  return { ...structuredClone(x), language: x.language ?? 'zh' } as LocalState;
}
