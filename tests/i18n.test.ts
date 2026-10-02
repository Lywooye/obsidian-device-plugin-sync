import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';
import { setLanguage, t, text } from '../src/i18n';
import { parsePolicy, planExclusions } from '../src/model';
import { parseLocalState } from '../src/local-state';
import { inspectSync } from '../src/sync-adapter';

afterEach(() => setLanguage('zh', 'zh'));

test('automatic language follows Chinese Obsidian locales and otherwise uses English', () => {
  for (const language of ['zh', 'zh-CN', 'zh-TW']) {
    setLanguage('auto', language); assert.equal(t('cancel'), '取消');
  }
  for (const language of ['en', 'de', '']) {
    setLanguage('auto', language); assert.equal(t('cancel'), 'Cancel');
  }
  setLanguage('zh', 'en'); assert.equal(text('本机', 'This device'), '本机');
  setLanguage('en', 'zh'); assert.equal(text('本机', 'This device'), 'This device');
});

test('translated placeholders preserve user names, paths, and numbers literally', () => {
  setLanguage('en', 'en');
  assert.equal(t('syncCheckbox', { device: '工作 iPad {name}', plugin: 'Alpha $&' }), 'Sync Alpha $& on 工作 iPad {name}');
  assert.equal(t('published', { revision: 12 }), 'List saved (revision 12). Review and apply it on each device.');
});

test('validation, planning, local-state, and Sync compatibility failures have English text', async () => {
  setLanguage('en', 'en');
  assert.throws(() => parsePolicy('broken'), /list file has an invalid format/);
  assert.throws(() => planExclusions([], ['.obsidian/plugins/missing'], [], '.obsidian'), /changed or removed elsewhere/);
  assert.throws(() => parseLocalState(true), /records on this device are damaged/);
  const compatibility = await inspectSync({}, '1.13.7', false, '.obsidian');
  assert.equal(compatibility.writable, false);
  assert.match(compatibility.reason, /Enable Obsidian Sync first/);
  assert.doesNotMatch(compatibility.reason, /[\p{Script=Han}]/u);
});
