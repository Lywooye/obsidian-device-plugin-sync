import test from 'node:test';
import assert from 'node:assert/strict';
import type { DataAdapter } from 'obsidian';
import { BACKUP_ROOT, cleanupCandidates, listBackups, moveToBackup, restoreBackup, type CleanupHost } from '../src/cleanup';
import type { Policy } from '../src/model';

const policy: Policy = { schema: 1, revision: 4, authorityId: 'computer', plugins: [{ id: 'alpha', name: 'Alpha' }, { id: 'beta', name: 'Beta' }],
  devices: [{ id: 'phone', name: 'Phone', kind: 'phone', excludedPluginIds: ['alpha', 'beta'] }] };
function fixture() {
  const files = new Map<string, string>(); const folders = new Set(['.obsidian', '.obsidian/plugins']);
  const events: string[] = []; let failRename = '';
  for (const id of ['alpha', 'beta', 'device-plugin-sync']) {
    folders.add(`.obsidian/plugins/${id}`);
    files.set(`.obsidian/plugins/${id}/manifest.json`, JSON.stringify({ id }));
    files.set(`.obsidian/plugins/${id}/main.js`, `code:${id}`);
    files.set(`.obsidian/plugins/${id}/data.json`, `settings:${id}`);
  }
  files.set('.obsidian/community-plugins.json', '["alpha","beta","device-plugin-sync"]');
  const adapter = {
    exists: async (p: string) => files.has(p) || folders.has(p),
    stat: async (p: string) => folders.has(p) ? { type: 'folder' } : files.has(p) ? { type: 'file' } : null,
    read: async (p: string) => { if (!files.has(p)) throw new Error('not found'); return files.get(p)!; },
    write: async (p: string, value: string) => { files.set(p, value); events.push(`write:${p}`); },
    mkdir: async (p: string) => { assert.ok(!folders.has(p)); folders.add(p); },
    list: async (p: string) => ({ files: [...files.keys()].filter(f => f.startsWith(p + '/') && !f.slice(p.length + 1).includes('/')),
      folders: [...folders].filter(f => f.startsWith(p + '/') && !f.slice(p.length + 1).includes('/')) }),
    rename: async (from: string, to: string) => {
      events.push(`rename:${from}`); if (from.endsWith(failRename) && failRename) throw new Error('disk error');
      assert.ok(folders.has(from)); assert.ok(!folders.has(to));
      for (const f of [...folders]) if (f === from || f.startsWith(from + '/')) { folders.delete(f); folders.add(to + f.slice(from.length)); }
      for (const [f, data] of [...files]) if (f.startsWith(from + '/')) { files.delete(f); files.set(to + f.slice(from.length), data); }
    },
  } as unknown as DataAdapter;
  const host: CleanupHost = {
    assertCurrent: () => {}, assertExcluded: p => assert.match(p, /^\.obsidian\/plugins\/(alpha|beta)$/),
    assertBackupExcluded: p => assert.ok(p.startsWith(BACKUP_ROOT + '/')),
    unload: async id => { events.push(`unload:${id}`); assert.ok(folders.has(`.obsidian/plugins/${id}`)); },
  };
  return { adapter, files, folders, events, host, guard: async () => host, fail: (id: string) => { failRename = id; } };
}
test('cleanup lists only installed, excluded plugin IDs whose manifest matches', async () => {
  const h = fixture(); h.files.set('.obsidian/plugins/beta/manifest.json', '{"id":"different"}');
  assert.deepEqual(await cleanupCandidates(h.adapter, '.obsidian', policy, 'phone'), [{ id: 'alpha', name: 'Alpha' }]);
  assert.deepEqual(await cleanupCandidates(h.adapter, '.obsidian', policy, 'missing'), []);
});
test('confirmed cleanup moves selected folder and settings into local backup without changing other plugins or enabled list', async () => {
  const h = fixture(); const before = new Map(h.files);
  const result = await moveToBackup(h.adapter, '.obsidian', [policy.plugins[0]], h.guard);
  assert.equal(result.error, null); assert.deepEqual(result.moved, [policy.plugins[0]]);
  assert.equal(h.files.has('.obsidian/plugins/alpha/main.js'), false);
  for (const f of ['manifest.json', 'main.js', 'data.json']) assert.equal(h.files.get(`${result.folder}/alpha/${f}`), before.get(`.obsidian/plugins/alpha/${f}`));
  for (const [file, data] of before) if (!file.startsWith('.obsidian/plugins/alpha/')) assert.equal(h.files.get(file), data);
  assert.ok(h.events.indexOf('unload:alpha') < h.events.indexOf('rename:.obsidian/plugins/alpha'));
  assert.ok(h.events[0].startsWith('write:')); assert.equal((await listBackups(h.adapter)).backups.length, 1);
});
test('cleanup never permits itself, traversal IDs or a backup root used as the config folder', async () => {
  const h = fixture(); const before = [...h.files];
  for (const id of ['device-plugin-sync', '../beta', '/alpha', 'alpha/sub']) await assert.rejects(moveToBackup(h.adapter, '.obsidian', [{ id, name: id }], h.guard));
  await assert.rejects(moveToBackup(h.adapter, BACKUP_ROOT, [policy.plugins[0]], h.guard));
  await assert.rejects(moveToBackup(h.adapter, '.obsidian', [], h.guard));
  assert.deepEqual([...h.files], before); assert.deepEqual(h.events, []);
});
test('a changed safety guard blocks moving and retains original files', async () => {
  const h = fixture(); let calls = 0;
  const result = await moveToBackup(h.adapter, '.obsidian', [policy.plugins[0]], async () => {
    if (++calls > 1) throw new Error('Sync resumed or rules changed'); return h.host;
  });
  assert.equal(result.moved.length, 0); assert.match(result.error!, /Sync resumed/);
  assert.ok(h.files.has('.obsidian/plugins/alpha/data.json')); assert.equal(h.events.some(e => e.startsWith('rename')), false);
});
test('partial failure preserves recoverable successful moves and stops the batch', async () => {
  const h = fixture(); h.fail('beta');
  const result = await moveToBackup(h.adapter, '.obsidian', policy.plugins, h.guard);
  assert.deepEqual(result.moved, [policy.plugins[0]]); assert.match(result.error!, /disk error/);
  assert.ok(h.files.has(`${result.folder}/alpha/data.json`)); assert.ok(h.files.has('.obsidian/plugins/beta/data.json'));
  assert.deepEqual((await listBackups(h.adapter)).backups.map(b => b.id), ['alpha']);
});
test('restoring a backup returns files and settings without enabling or changing Sync', async () => {
  const h = fixture(); await moveToBackup(h.adapter, '.obsidian', [policy.plugins[0]], h.guard);
  const backup = (await listBackups(h.adapter)).backups[0]; h.events.length = 0;
  await restoreBackup(h.adapter, '.obsidian', backup, h.guard);
  assert.equal(h.files.get('.obsidian/plugins/alpha/data.json'), 'settings:alpha');
  assert.equal(h.files.get('.obsidian/community-plugins.json'), '["alpha","beta","device-plugin-sync"]');
  assert.deepEqual((await listBackups(h.adapter)).backups, []);
  assert.equal(h.events.length, 1); assert.ok(h.events[0].startsWith('rename:'));
});
test('backup restore refuses an existing plugin and mismatched config dir without overwriting', async () => {
  const h = fixture(); await moveToBackup(h.adapter, '.obsidian', [policy.plugins[0]], h.guard);
  const backup = (await listBackups(h.adapter)).backups[0];
  await assert.rejects(restoreBackup(h.adapter, '.obsidian-mobile', backup, h.guard));
  h.folders.add('.obsidian/plugins/alpha'); h.files.set('.obsidian/plugins/alpha/main.js', 'new install');
  await assert.rejects(restoreBackup(h.adapter, '.obsidian', backup, h.guard));
  assert.equal(h.files.get('.obsidian/plugins/alpha/main.js'), 'new install');
  assert.equal((await listBackups(h.adapter)).backups.length, 1);
});
test('invalid or traversal backup records cannot escape the backup folder', async () => {
  const h = fixture(); await moveToBackup(h.adapter, '.obsidian', [policy.plugins[0]], h.guard);
  const backup = (await listBackups(h.adapter)).backups[0]; const before = [...h.files];
  await assert.rejects(restoreBackup(h.adapter, '.obsidian', { ...backup, batch: '../outside' }, h.guard));
  await assert.rejects(restoreBackup(h.adapter, '.obsidian', { ...backup, id: '../outside' }, h.guard));
  assert.deepEqual([...h.files], before);
  h.files.set(`${BACKUP_ROOT}/${backup.batch}/backup.json`, '{broken');
  assert.equal((await listBackups(h.adapter)).unreadable, 1);
  await assert.rejects(restoreBackup(h.adapter, '.obsidian', backup, h.guard));
});

test('a rejected rename after the move still records the files as moved and stops the batch', async () => {
  const h = fixture(); const rename = h.adapter.rename;
  h.adapter.rename = async (from, to) => { await rename(from, to); throw new Error('watch refresh failed'); };
  const result = await moveToBackup(h.adapter, '.obsidian', policy.plugins, h.guard);
  assert.deepEqual(result.moved, [policy.plugins[0]]); assert.ok(result.error);
  assert.equal(h.files.has('.obsidian/plugins/alpha/main.js'), false); assert.ok(h.files.has('.obsidian/plugins/beta/main.js'));
  assert.equal((await listBackups(h.adapter)).backups.length, 1);
});
test('restore reports files returned even if the subsequent watcher refresh fails', async () => {
  const h = fixture(); await moveToBackup(h.adapter, '.obsidian', [policy.plugins[0]], h.guard);
  const backup = (await listBackups(h.adapter)).backups[0]; const rename = h.adapter.rename;
  h.adapter.rename = async (from, to) => { await rename(from, to); throw new Error('watch refresh failed'); };
  const result = await restoreBackup(h.adapter, '.obsidian', backup, h.guard);
  assert.ok(result.warning); assert.ok(h.files.has('.obsidian/plugins/alpha/data.json'));
  assert.deepEqual((await listBackups(h.adapter)).backups, []);
});
