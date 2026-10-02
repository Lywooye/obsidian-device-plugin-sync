import assert from 'node:assert/strict';
import test from 'node:test';
import { parseLocalState } from '../src/local-state';
import { pluginPath, type LocalState } from '../src/model';

const path = (id: string) => pluginPath('.obsidian', id);
const valid = (): LocalState => ({
  schema: 1, installationId: 'installation-1', deviceId: 'phone-1',
  ownedPaths: [path('old')], baselineExclusions: ['Private'],
});
const journal = (): NonNullable<LocalState['pending']> => ({
  before: ['Private', path('old')], after: ['Private', path('new')],
  ownedBefore: [path('old')], ownedAfter: [path('new')],
});

test('missing local state initializes a new unbound installation without path ownership', () => {
  const first = parseLocalState(null);
  const second = parseLocalState(undefined);
  assert.equal(first.schema, 1);
  assert.equal(first.deviceId, null);
  assert.deepEqual(first.ownedPaths, []);
  assert.equal(first.baselineExclusions, null);
  assert.ok(first.installationId.length > 0);
  assert.notEqual(first.installationId, second.installationId);
  assert.equal(first.pending, undefined);
});

test('valid state is cloned so callers cannot mutate saved ownership or journal arrays', () => {
  const original: LocalState = {
    ...valid(), pending: journal(),
    lastApplied: { revision: 3, paths: ['Private', path('old')], appliedAt: '2026-09-27T00:00:00.000Z', sessionId: 'session-1' },
  };
  const parsed = parseLocalState(original);
  assert.deepEqual(parsed, { ...original, language: 'zh' });
  parsed.ownedPaths.length = 0;
  parsed.pending!.before.push('External');
  parsed.lastApplied!.paths.length = 0;
  assert.deepEqual(original.ownedPaths, [path('old')]);
  assert.deepEqual(original.pending!.before, ['Private', path('old')]);
  assert.deepEqual(original.lastApplied!.paths, ['Private', path('old')]);
});

test('restore revision sentinel -1 remains valid', () => {
  const state = { ...valid(), lastApplied: {
    revision: -1, paths: ['Private'], appliedAt: '2026-09-27T00:00:00.000Z', sessionId: '12345.6',
  } };
  assert.equal(parseLocalState(state).lastApplied?.revision, -1);
});

test('rejects non-object values, arrays, incomplete objects and unsupported schema', () => {
  for (const value of [true, 1, 'state', [], {}, { ...valid(), schema: 2 }, { ...valid(), ownedPaths: undefined }]) {
    assert.throws(() => parseLocalState(value));
  }
  assert.throws(() => parseLocalState(Object.create(valid())));
});

test('rejects invalid installation and device IDs', () => {
  for (const installationId of ['', 'with space', '../parent', '__proto__', 'constructor', 'prototype']) {
    assert.throws(() => parseLocalState({ ...valid(), installationId }), `installationId: ${installationId}`);
  }
  for (const deviceId of ['', '../parent', '__proto__', 'constructor', 3]) {
    assert.throws(() => parseLocalState({ ...valid(), deviceId }), `deviceId: ${deviceId}`);
  }
  assert.equal(parseLocalState({ ...valid(), deviceId: null }).deviceId, null);
});

test('rejects duplicate or non-string ownership and snapshot paths', () => {
  for (const field of ['ownedPaths', 'baselineExclusions']) {
    for (const value of [[path('old'), path('old')], [1], 'not an array']) {
      assert.throws(() => parseLocalState({ ...valid(), [field]: value }));
    }
  }
  assert.equal(parseLocalState({ ...valid(), baselineExclusions: null }).baselineExclusions, null);
});

test('provided pending and lastApplied must be valid objects, including falsy values', () => {
  for (const field of ['pending', 'lastApplied']) {
    for (const value of [null, false, 0, '', true, [], {}]) {
      assert.throws(() => parseLocalState({ ...valid(), [field]: value }), `${field}: ${JSON.stringify(value)}`);
    }
  }
});

test('journal snapshots require complete unique string arrays', () => {
  for (const key of ['before', 'after', 'ownedBefore', 'ownedAfter']) {
    for (const value of [undefined, 'not an array', [5], [path('old'), path('old')]]) {
      assert.throws(() => parseLocalState({ ...valid(), pending: { ...journal(), [key]: value } }));
    }
  }
});

test('journal cannot replace current ownership or claim an external existing exclusion', () => {
  assert.throws(() => parseLocalState({ ...valid(), pending: { ...journal(), ownedBefore: [] } }));
  assert.throws(() => parseLocalState({ ...valid(), pending: { ...journal(), ownedAfter: ['Private', path('new')] } }));
  assert.throws(() => parseLocalState({ ...valid(), pending: { ...journal(), ownedAfter: [path('missing')] } }));
});

test('journal cannot remove or reorder external exclusions', () => {
  assert.throws(() => parseLocalState({ ...valid(), pending: { ...journal(), after: [path('new')] } }));
  assert.throws(() => parseLocalState({ ...valid(), pending: {
    ...journal(), before: ['Private', 'Work', path('old')], after: ['Work', 'Private', path('new')],
  } }));
});

test('journal accepts preserving ownership, acquiring newly added paths, and restoration', () => {
  const unchanged = { ...valid(), pending: {
    before: ['Private', path('old')], after: ['Private', path('old')],
    ownedBefore: [path('old')], ownedAfter: [path('old')],
  } };
  assert.deepEqual(parseLocalState(unchanged).pending, unchanged.pending);
  assert.deepEqual(parseLocalState({ ...valid(), pending: journal() }).pending, journal());
  const restore = { ...valid(), pending: {
    before: ['Private', path('old')], after: ['Private'], ownedBefore: [path('old')], ownedAfter: [],
  } };
  assert.deepEqual(parseLocalState(restore).pending, restore.pending);
});

test('last-applied data rejects invalid revisions and malformed fields', () => {
  const applied = { revision: 3, paths: ['Private', path('old')], appliedAt: '2026-09-27T00:00:00.000Z', sessionId: 'session-1' };
  for (const revision of [-2, 1.5, Number.MAX_SAFE_INTEGER + 1, '3']) {
    assert.throws(() => parseLocalState({ ...valid(), lastApplied: { ...applied, revision } }));
  }
  for (const value of [
    { paths: ['Private', 'Private'] }, { appliedAt: 3 }, { appliedAt: 'not a date' },
    { sessionId: 3 }, { sessionId: '' },
  ]) {
    assert.throws(() => parseLocalState({ ...valid(), lastApplied: { ...applied, ...value } }));
  }
});

test('language defaults follow Obsidian for new installs and preserve Chinese on upgrade', () => {
  assert.equal(parseLocalState(null).language, 'auto');
  assert.equal(parseLocalState(valid()).language, 'zh');
  for (const language of ['auto', 'zh', 'en'] as const) {
    assert.equal(parseLocalState({ ...valid(), language }).language, language);
  }
  for (const language of ['fr', '', null, 3]) assert.throws(() => parseLocalState({ ...valid(), language }));
});
