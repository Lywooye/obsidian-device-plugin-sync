#!/usr/bin/env node
'use strict';

// Read-only audit of an installed Obsidian build. No app code is redistributed,
// no real Sync instance is invoked, and no vault or Sync database is opened.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const profile = require('../src/native-profile.json');

function readAsarEntry(archive, name) {
  const fd = fs.openSync(archive, 'r');
  try {
    const lead = Buffer.alloc(16);
    assert.equal(fs.readSync(fd, lead, 0, 16, 0), 16, 'ASAR header is truncated');
    const headerSize = lead.readUInt32LE(4);
    const jsonSize = lead.readUInt32LE(12);
    assert(jsonSize > 0 && jsonSize < 16 * 1024 * 1024, 'Unexpected ASAR header size');
    const rawHeader = Buffer.alloc(jsonSize);
    assert.equal(fs.readSync(fd, rawHeader, 0, jsonSize, 16), jsonSize);
    let entry = JSON.parse(rawHeader).files;
    const parts = name.split('/');
    parts.forEach((part, index) => {
      entry = entry[part];
      if (index < parts.length - 1) entry = entry.files;
    });
    assert(entry && !entry.unpacked && !entry.link, 'Expected a packed ASAR file');
    assert(Number.isSafeInteger(entry.size) && entry.size > 0 && entry.size < 64 * 1024 * 1024);
    const bytes = Buffer.alloc(entry.size);
    assert.equal(fs.readSync(fd, bytes, 0, entry.size, 8 + headerSize + Number(entry.offset)), entry.size);
    return bytes.toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

// This extractor intentionally recognizes only the profiled minified layout.
// A renamed class or changed layout requires review instead of guessed matching.
function extractMethods(source) {
  const methods = {};
  for (const [group, marker, prefix] of [
    ['sync', 'vne=function', 't'],
    ['filter', 'tne=function', 'e'],
  ]) {
    const start = source.indexOf(marker);
    assert(start !== -1, `Unknown ${group} class layout`);
    methods[group] = {};
    for (const name of Object.keys(profile.fingerprints[group])) {
      const assignment = `${prefix}.prototype.${name}=`;
      const found = source.indexOf(assignment, start);
      assert(found !== -1, `Missing ${group}.${name}`);
      const begin = found + assignment.length;
      assert(source.startsWith('function', begin), `Unknown function form: ${group}.${name}`);
      // All audited methods are comma-separated prototype assignments. The final
      // filter method ends immediately before the constructor is returned.
      const nextMethod = source.indexOf(`,${prefix}.prototype.`, begin);
      const classEnd = source.indexOf(`,${prefix}}`, begin);
      const ends = [nextMethod, classEnd].filter(value => value !== -1);
      assert(ends.length > 0, `Cannot delimit ${group}.${name}`);
      const end = Math.min(...ends);
      const text = source.slice(begin, end);
      assert(text.length < 20000, `Unexpected method span: ${group}.${name}`);
      methods[group][name] = text;
    }
  }
  return methods;
}

// Test-only extraction of the installed build's compiled async helpers. These
// helpers and native methods are evaluated only against synthetic VM objects.
function extractAsyncHelpers(source) {
  const declarations = [];
  for (const signature of ['function y(e,t,n,i)', 'function b(e,t)']) {
    const start = source.indexOf(signature);
    assert(start !== -1, `Missing reviewed async helper: ${signature}`);
    let depth = 0, quote = null, escaped = false, end = -1;
    for (let index = source.indexOf('{', start); index < source.length; index++) {
      const char = source[index];
      if (quote) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === quote) quote = null;
      } else if (char === '"' || char === "'") quote = char;
      else if (char === '{') depth++;
      else if (char === '}' && --depth === 0) { end = index + 1; break; }
    }
    assert(end > start && end - start < 5000, 'Unknown async helper layout');
    declarations.push(source.slice(start, end));
  }
  return declarations.join(';');
}

function probeFilter(methods) {
  const context = vm.createContext({
    Al: value => value.slice(value.lastIndexOf('/') + 1),
    Fl: value => value.slice(value.lastIndexOf('.') + 1).toLowerCase(),
    hb: ['png'], pb: ['mp3'], db: ['mp4'], fb: ['pdf'],
  });
  const prototype = {};
  for (const [name, source] of Object.entries(methods.filter)) {
    prototype[name] = vm.runInContext(`(${source})`, context, { timeout: 1000 });
    assert.equal(sha256(Function.prototype.toString.call(prototype[name])), profile.fingerprints.filter[name]);
  }
  let checks = 0;
  const equal = (actual, expected, label) => { assert.equal(actual, expected, label); checks++; };
  for (const configDir of ['.obsidian', '.obsidian-phone']) {
    const pluginDir = `${configDir}/plugins/example`;
    const original = Object.assign(Object.create(prototype), {
      configDir,
      ignoreFolders: ['Private'],
      allowTypes: new Set(['image', 'audio', 'video', 'pdf', 'unsupported']),
      allowSpecialFiles: new Set(['community-plugin', 'community-plugin-data']),
      filterCache: {},
    });
    // Detached state: native methods receive fresh arrays, sets and a fresh cache.
    const detached = Object.assign(Object.create(Object.getPrototypeOf(original)), {
      configDir: original.configDir,
      ignoreFolders: [...original.ignoreFolders, pluginDir],
      allowTypes: new Set(original.allowTypes),
      allowSpecialFiles: new Set(original.allowSpecialFiles),
      filterCache: {},
    });
    for (const file of ['main.js', 'manifest.json', 'styles.css', 'data.json']) {
      equal(original.allowSyncFile(`${pluginDir}/${file}`, false), true, 'baseline permits plugin');
      equal(detached.allowSyncFile(`${pluginDir}/${file}`, false), false, 'excluded plugin denied');
    }
    equal(detached.allowSyncFile(pluginDir, true), false, 'plugin directory itself denied');
    equal(detached.allowSyncFile(`${pluginDir}-extra/main.js`, false), true, 'similar prefix preserved');
    equal(detached.allowSyncFile(`${configDir}/plugins/device-plugin-sync/main.js`, false), true, 'manager preserved');
    equal(detached.allowSyncFile(`${configDir}/community-plugins.json`, false), true, 'enablement list preserved');
    equal(detached.allowSyncFile('Notes/check.md', false), true, 'ordinary note preserved');
    equal(detached.allowSyncFile('Private/check.md', false), false, 'existing exclusion preserved');
    equal(original.ignoreFolders.length, 1, 'original exclusion state untouched');
    equal(original.allowSpecialFiles.size, 2, 'original allow set untouched');
    const serverFiles = { candidate: { path: `${pluginDir}/main.js`, folder: false } };
    const returned = detached.changeFilter(serverFiles, filter => {
      filter.ignoreFolders = [...original.ignoreFolders];
    });
    equal(returned.length, 1, 'unexcluding requeues the existing remote candidate');
    equal(detached.allowSyncFile(`${pluginDir}/main.js`, false), true, 'filter cache invalidated');
  }
  return checks;
}

function main() {
  const args = process.argv.slice(2);
  if (args[0] === '--help') {
    console.log('Usage: node scripts/check-native.cjs [--asar /path/to/obsidian.asar | --app-js /path/to/app.js]');
    return;
  }
  assert(args.length === 0 || (args.length === 2 && ['--asar', '--app-js'].includes(args[0])), 'Invalid arguments');
  const defaultAsar = '/Applications/Obsidian.app/Contents/Resources/obsidian.asar';
  const input = path.resolve(args[1] || defaultAsar);
  const source = args[0] === '--app-js' ? fs.readFileSync(input, 'utf8') : readAsarEntry(input, 'app.js');
  if (args[0] !== '--app-js') {
    const installed = JSON.parse(readAsarEntry(input, 'package.json'));
    assert.equal(installed.version, profile.version, 'Unreviewed Obsidian version');
  }
  const methods = extractMethods(source);
  let fingerprints = 0;
  for (const [group, entries] of Object.entries(profile.fingerprints)) {
    for (const [name, expected] of Object.entries(entries)) {
      assert.equal(sha256(methods[group][name]), expected, `Unknown native fingerprint: ${group}.${name}`);
      fingerprints++;
    }
  }
  const assertions = probeFilter(methods);
  console.log(JSON.stringify({
    result: 'PASS',
    input,
    version: profile.version,
    appJsSha256: sha256(source),
    fingerprints,
    offlineFilterAssertions: assertions,
    limits: 'Source and detached filter only. No live Sync instance, mobile binary, network transfer, restart persistence or in-flight cancellation tested.',
  }, null, 2));
}

module.exports = { readAsarEntry, extractMethods, extractAsyncHelpers, probeFilter, sha256 };
if (require.main === module) {
  try { main(); } catch (error) {
    console.error(`Native compatibility audit failed: ${error.message}`);
    process.exitCode = 1;
  }
}
