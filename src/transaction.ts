import { t } from './i18n';
import type { LocalState, Plan } from './model';

export interface ExclusionAdapter {
  read(): string[];
  write(before: string[], after: string[]): Promise<void>;
}
export const samePaths = (a: string[], b: string[]) => JSON.stringify(a) === JSON.stringify(b);

// A local journal is written first so a crash cannot silently lose path ownership.
// Failure never triggers an automatic rollback of a concurrently changed Sync list.
export async function applyPlan(
  adapter: ExclusionAdapter, plan: Plan, state: LocalState,
  save: (value: LocalState) => void, revision: number, sessionId: string,
): Promise<LocalState> {
  if (state.pending) throw new Error(t('unfinished'));
  if (!samePaths(adapter.read(), plan.before)) throw new Error(t('exclusionsChanged'));
  const pending: LocalState = {
    ...state,
    baselineExclusions: state.baselineExclusions ?? [...plan.before],
    pending: { before: [...plan.before], after: [...plan.after],
      ownedBefore: [...state.ownedPaths], ownedAfter: [...plan.ownedAfter] },
  };
  save(pending);
  await adapter.write(plan.before, plan.after);
  if (!samePaths(adapter.read(), plan.after)) throw new Error(t('writeMismatch'));
  const next: LocalState = { ...pending, ownedPaths: [...plan.ownedAfter],
    lastApplied: { revision, paths: [...plan.after], appliedAt: new Date().toISOString(), sessionId } };
  delete next.pending;
  save(next);
  return next;
}

export function reconcileJournal(state: LocalState, current: string[]): LocalState {
  if (!state.pending) return state;
  validateJournal(state);
  let owned: string[];
  if (samePaths(current, state.pending.before)) owned = state.pending.ownedBefore;
  else if (samePaths(current, state.pending.after)) owned = state.pending.ownedAfter;
  else throw new Error(t('journalUnknown'));
  const next = { ...state, ownedPaths: [...owned] };
  delete next.pending;
  delete next.lastApplied;
  return next;
}

export function validateJournal(state: LocalState): void {
  const p = state.pending;
  if (!p) return;
  const includes = (all: string[], subset: string[]) => subset.every(path => all.includes(path));
  if (!samePaths(p.ownedBefore, state.ownedPaths) || !includes(p.before, p.ownedBefore) || !includes(p.after, p.ownedAfter))
    throw new Error(t('journalOwnership'));
  const externalBefore = p.before.filter(path => !p.ownedBefore.includes(path));
  const externalAfter = p.after.filter(path => !p.ownedAfter.includes(path));
  if (!samePaths(externalBefore, externalAfter) || p.ownedAfter.some(path => p.before.includes(path) && !p.ownedBefore.includes(path)))
    throw new Error(t('journalExternal'));
}
