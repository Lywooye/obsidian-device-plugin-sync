import assert from 'node:assert/strict';
import test from 'node:test';
import { planExclusions, pluginPath, type LocalState } from '../src/model';
import { applyPlan, reconcileJournal, samePaths, type ExclusionAdapter } from '../src/transaction';

const path = (id: string) => pluginPath('.obsidian', id);
const local = (): LocalState => ({
  schema: 1, installationId: 'installation-1', deviceId: 'phone-1',
  ownedPaths: [path('old')], baselineExclusions: null,
});
const before = () => ['Private', path('old'), 'Work'];
const plan = () => planExclusions(before(), [path('old')], ['new'], '.obsidian');

function harness(initial = before()) {
  let current = [...initial];
  let stored: LocalState | undefined;
  const saves: LocalState[] = [];
  const events: string[] = [];
  const writes: { before: string[]; after: string[] }[] = [];
  const adapter: ExclusionAdapter = {
    read: () => [...current],
    async write(expected, after) {
      events.push('write');
      writes.push({ before: [...expected], after: [...after] });
      if (!samePaths(current, expected)) throw new Error('concurrent drift');
      current = [...after];
    },
  };
  return {
    adapter, saves, writes, events,
    current: () => [...current],
    drift: (next: string[]) => { current = [...next]; },
    stored: () => stored,
    save: (value: LocalState) => {
      events.push(value.pending ? 'journal' : 'commit');
      stored = structuredClone(value);
      saves.push(structuredClone(value));
    },
  };
}

test('apply journals before native write and commits exact ownership after readback', async () => {
  const h = harness();
  const state = local();
  const original = structuredClone(state);
  const desired = plan();
  const result = await applyPlan(h.adapter, desired, state, h.save, 7, 'session-1');
  assert.deepEqual(h.events, ['journal', 'write', 'commit']);
  assert.deepEqual(h.current(), ['Private', 'Work', path('new')]);
  assert.deepEqual(result.ownedPaths, [path('new')]);
  assert.deepEqual(result.baselineExclusions, before());
  assert.deepEqual(h.saves[0].pending, {
    before: before(), after: desired.after, ownedBefore: [path('old')], ownedAfter: [path('new')],
  });
  assert.equal(result.pending, undefined);
  assert.equal(result.lastApplied?.revision, 7);
  assert.equal(result.lastApplied?.sessionId, 'session-1');
  assert.deepEqual(result.lastApplied?.paths, desired.after);
  assert.ok(Number.isFinite(Date.parse(result.lastApplied!.appliedAt)));
  assert.deepEqual(state, original);
});

test('journal save failure prevents every native write', async () => {
  const h = harness();
  await assert.rejects(applyPlan(h.adapter, plan(), local(), () => {
    throw new Error('journal storage unavailable');
  }, 7, 'session-1'), /journal storage unavailable/);
  assert.deepEqual(h.current(), before());
  assert.equal(h.writes.length, 0);
  assert.equal(h.stored(), undefined);
});

test('native failure before mutation retains the journal and recovers previous ownership', async () => {
  const h = harness();
  h.adapter.write = async () => { throw new Error('native write rejected'); };
  await assert.rejects(applyPlan(h.adapter, plan(), local(), h.save, 7, 'session-1'), /native write rejected/);
  assert.equal(h.saves.length, 1);
  assert.deepEqual(h.current(), before());
  assert.ok(h.stored()!.pending);
  const recovered = reconcileJournal(h.stored()!, h.current());
  assert.deepEqual(recovered.ownedPaths, [path('old')]);
  assert.equal(recovered.pending, undefined);
  assert.equal(recovered.lastApplied, undefined);
});

test('native failure after mutation never rolls back and recovers new ownership', async () => {
  const h = harness();
  const write = h.adapter.write;
  h.adapter.write = async (expected, after) => {
    await write(expected, after);
    throw new Error('native persistence failed');
  };
  await assert.rejects(applyPlan(h.adapter, plan(), local(), h.save, 7, 'session-1'), /native persistence failed/);
  assert.equal(h.writes.length, 1);
  assert.deepEqual(h.current(), plan().after);
  const recovered = reconcileJournal(h.stored()!, h.current());
  assert.deepEqual(recovered.ownedPaths, [path('new')]);
  assert.equal(recovered.pending, undefined);
});

test('commit storage failure leaves a recoverable pending journal without another native write', async () => {
  const h = harness();
  const save = (value: LocalState) => {
    if (!value.pending) throw new Error('commit storage full');
    h.save(value);
  };
  await assert.rejects(applyPlan(h.adapter, plan(), local(), save, 7, 'session-1'), /commit storage full/);
  assert.equal(h.writes.length, 1);
  assert.equal(h.saves.length, 1);
  assert.ok(h.stored()!.pending);
  assert.deepEqual(h.current(), plan().after);
  assert.deepEqual(reconcileJournal(h.stored()!, h.current()).ownedPaths, [path('new')]);
});

test('concurrent drift before journaling stops without saving or writing', async () => {
  const h = harness([...before(), 'External']);
  await assert.rejects(applyPlan(h.adapter, plan(), local(), h.save, 7, 'session-1'), /已改变/);
  assert.equal(h.writes.length, 0);
  assert.equal(h.saves.length, 0);
  assert.deepEqual(h.current(), [...before(), 'External']);
});

test('concurrent drift between journal and setter preserves external changes', async () => {
  const h = harness();
  const save = (value: LocalState) => {
    h.save(value);
    h.drift([...before(), 'External']);
  };
  await assert.rejects(applyPlan(h.adapter, plan(), local(), save, 7, 'session-1'), /concurrent drift/);
  assert.deepEqual(h.current(), [...before(), 'External']);
  assert.ok(h.stored()!.pending);
  assert.throws(() => reconcileJournal(h.stored()!, h.current()), /无法确认上次操作的结果/);
});

test('drift after native write prevents commit and automatic rollback', async () => {
  const h = harness();
  const write = h.adapter.write;
  h.adapter.write = async (expected, after) => {
    await write(expected, after);
    h.drift([...after, 'External']);
  };
  await assert.rejects(applyPlan(h.adapter, plan(), local(), h.save, 7, 'session-1'), /保存后读到的同步设置与预期不同/);
  assert.equal(h.writes.length, 1);
  assert.equal(h.saves.length, 1);
  assert.deepEqual(h.current(), [...plan().after, 'External']);
  assert.throws(() => reconcileJournal(h.stored()!, h.current()), /无法确认上次操作的结果/);
});

test('unfinished journal blocks a second transaction before any side effect', async () => {
  const h = harness();
  const state = local();
  state.pending = { before: before(), after: plan().after, ownedBefore: [path('old')], ownedAfter: [path('new')] };
  await assert.rejects(applyPlan(h.adapter, plan(), state, h.save, 8, 'session-1'), /上次操作没有完成/);
  assert.equal(h.writes.length, 0);
  assert.equal(h.saves.length, 0);
});

test('later apply preserves the first baseline and does not acquire an external exact path', async () => {
  const initial = [...before(), path('external')];
  const h = harness(initial);
  const state = { ...local(), baselineExclusions: ['Original external exclusion'] };
  const desired = planExclusions(initial, state.ownedPaths, ['external', 'new'], '.obsidian');
  const result = await applyPlan(h.adapter, desired, state, h.save, 8, 'session-1');
  assert.deepEqual(result.baselineExclusions, ['Original external exclusion']);
  assert.deepEqual(result.ownedPaths, [path('new')]);
  assert.deepEqual(h.current(), ['Private', 'Work', path('external'), path('new')]);
  const restored = planExclusions(h.current(), result.ownedPaths, [], '.obsidian');
  assert.deepEqual(restored.after, ['Private', 'Work', path('external')]);
});

test('reconcile accepts exact before or after only, without mutating its journal', () => {
  const state: LocalState = {
    ...local(),
    lastApplied: { revision: 3, paths: before(), appliedAt: '2026-09-27T00:00:00.000Z', sessionId: 'old-session' },
    pending: { before: before(), after: plan().after, ownedBefore: [path('old')], ownedAfter: [path('new')] },
  };
  const original = structuredClone(state);
  assert.deepEqual(reconcileJournal(state, before()).ownedPaths, [path('old')]);
  const recovered = reconcileJournal(state, plan().after);
  assert.deepEqual(recovered.ownedPaths, [path('new')]);
  assert.equal(recovered.lastApplied, undefined);
  recovered.ownedPaths.push(path('other'));
  assert.deepEqual(state, original);
  assert.throws(() => reconcileJournal(state, [...plan().after].reverse()), /无法确认上次操作的结果/);
  assert.throws(() => reconcileJournal(state, ['Unexpected']), /无法确认上次操作的结果/);
  assert.deepEqual(state, original);
});

test('reconcile without a journal changes neither ownership nor last-applied data', () => {
  const state = local();
  assert.equal(reconcileJournal(state, ['External']), state);
  assert.deepEqual(state.ownedPaths, [path('old')]);
});
