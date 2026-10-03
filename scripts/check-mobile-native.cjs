#!/usr/bin/env node
'use strict';

// Local, read-only fixture audit. Supply an app.js extracted from a legitimately
// obtained mobile build; this script never downloads or redistributes app code.
const fs = require('node:fs');
const crypto = require('node:crypto');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const ts = require('typescript');
const profile = require('../src/native-mobile-profile.json');
const APP_JS_SHA256 = '76e645fb89913049956c6d9ad74adf339061349dda3ad98e2e3098001f84b347';
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');

function extractBundle(source) {
  assert.equal(sha256(source), APP_JS_SHA256, 'Unreviewed mobile app.js; review the source before changing this profile');
  const ast = ts.createSourceFile('app.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  assert.equal(ast.parseDiagnostics.length, 0, 'Mobile source could not be parsed');
  const declarations = new Map();
  const functions = new Map();
  const signatures = ['function y(e,t,n,i)', 'function b(e,t)', 'function ff(e)', 'function vf(e)',
    'function pf(e)', 'function fc(e)', 'function bc(e)', 'function Dv()', 'function vO(e,t,', 'function pO(e)'];
  const variableNames = new Set(['Ute', 'Pte', 'Dte', 'Ate', 'ew', 'tw', 'nw', 'iw']);
  function visit(node) {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && variableNames.has(node.name.text)) {
      assert(!declarations.has(node.name.text), `Ambiguous mobile declaration ${node.name.text}`);
      declarations.set(node.name.text, node);
    }
    if (ts.isFunctionDeclaration(node)) {
      const text = node.getText(ast);
      for (const signature of signatures) if (text.startsWith(signature)) {
        assert(!functions.has(signature), `Ambiguous mobile helper ${signature}`);
        functions.set(signature, text);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  const methods = {};
  for (const [group, className, prefix] of [['sync', 'Ute', 't'], ['filter', 'Pte', 'e']]) {
    const declaration = declarations.get(className);
    assert(declaration && declaration.initializer, `Unknown mobile ${group} class layout`);
    const wanted = new Set([...Object.keys(profile.fingerprints[group]), ...(group === 'filter' ? ['set'] : [])]);
    methods[group] = {};
    function collect(node) {
      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
        const left = node.left.getText(ast);
        for (const name of wanted) if (left === `${prefix}.prototype.${name}`) {
          assert(ts.isFunctionExpression(node.right), `Unknown mobile method form: ${group}.${name}`);
          assert(!methods[group][name], `Ambiguous mobile method: ${group}.${name}`);
          methods[group][name] = node.right.getText(ast);
        }
      }
      ts.forEachChild(node, collect);
    }
    collect(declaration.initializer);
    for (const name of wanted) assert(methods[group][name], `Missing mobile method ${group}.${name}`);
    for (const [name, expected] of Object.entries(profile.fingerprints[group])) {
      assert.equal(sha256(methods[group][name]), expected, `Unknown mobile method fingerprint: ${group}.${name}`);
    }
  }
  const helpers = {};
  for (const signature of signatures) {
    const text = functions.get(signature);
    assert(text, `Missing mobile helper ${signature}`);
    helpers[signature.slice(9, signature.indexOf('('))] = text;
  }
  const arrays = {};
  for (const name of ['Dte', 'Ate', 'ew', 'tw', 'nw', 'iw']) {
    const declaration = declarations.get(name);
    assert(declaration && declaration.initializer && ts.isArrayLiteralExpression(declaration.initializer), `Unknown mobile list ${name}`);
    arrays[name] = declaration.initializer.elements.map(element => {
      assert(ts.isStringLiteral(element), `Unknown mobile list item ${name}`);
      return element.text;
    });
  }
  return { methods, helpers, arrays };
}

function loadBundle(file) {
  assert(file, 'Set OBSIDIAN_MOBILE_APP_JS to a locally obtained mobile app.js');
  return extractBundle(fs.readFileSync(file, 'utf8'));
}

function createContext(bundle, overrides = {}) {
  // Only synthetic platform/storage services are supplied. Actual mobile helpers
  // perform path handling, type classification, key encoding, and async control.
  const context = vm.createContext({
    Set, ArrayBuffer, Uint8Array, atob, btoa,
    ...Object.fromEntries(Object.entries(bundle.arrays).map(([name, values]) => [name, [...values]])),
    ...overrides,
  });
  for (const name of ['y', 'b', 'ff', 'vf', 'pf', 'fc', 'bc', 'Dv']) {
    vm.runInContext(bundle.helpers[name], context, { timeout: 1000 });
  }
  // Obsidian extends Array.remove. This synthetic host supplies that public host
  // convention for the original KeepAwake reference-counting helper only.
  vm.runInContext('var Tv = []; Array.prototype.remove = function(value) { const index = this.indexOf(value); if (index >= 0) this.splice(index, 1); };', context, { timeout: 1000 });
  const prototypes = {};
  for (const [group, methods] of Object.entries(bundle.methods)) {
    prototypes[group] = {};
    for (const [name, text] of Object.entries(methods)) {
      prototypes[group][name] = vm.runInContext(`(${text})`, context, { timeout: 1000 });
    }
  }
  return { context, prototypes };
}

function probeFilter(bundle) {
  const { prototypes } = createContext(bundle);
  let checks = 0;
  const equal = (actual, expected, label) => { assert.equal(actual, expected, label); checks++; };
  for (const configDir of ['.obsidian', '.obsidian-phone']) {
    const filter = Object.assign(Object.create(prototypes.filter), {
      configDir, ignoreFolders: ['Private'], allowTypes: new Set(['image', 'audio', 'video', 'pdf']),
      allowSpecialFiles: new Set(['community-plugin', 'community-plugin-data']), filterCache: {},
    });
    const target = `${configDir}/plugins/example`;
    for (const file of ['main.js', 'manifest.json', 'styles.css', 'data.json']) {
      equal(filter.allowSyncFile(`${target}/${file}`, false), true, 'plugin permitted before exclusion');
    }
    const cached = filter.filterCache;
    filter.changeFilter({}, changed => { changed.ignoreFolders = ['Private', target]; });
    equal(filter.filterCache === cached, false, 'changing exclusions clears cache');
    for (const file of ['main.js', 'manifest.json', 'styles.css', 'data.json']) {
      equal(filter.allowSyncFile(`${target}/${file}`, false), false, 'plugin file excluded');
    }
    equal(filter.allowSyncFile(target, true), false, 'exact plugin folder excluded');
    equal(filter.allowSyncFile(`${target}/nested/data.json`, false), false, 'descendant excluded');
    equal(filter.allowSyncFile(`${target}-extra/main.js`, false), true, 'similar prefix permitted');
    equal(filter.allowSyncFile(`${configDir}/plugins/device-plugin-sync/main.js`, false), true, 'manager permitted');
    equal(filter.allowSyncFile(`${configDir}/community-plugins.json`, false), true, 'enablement list permitted');
    equal(filter.allowSyncFile(`${configDir}/workspace-mobile.json`, false), false, 'mobile workspace remains excluded');
    equal(filter.allowSyncFile('.device-plugin-sync-trash/example/main.js', false), false, 'hidden backup excluded');
    equal(filter.allowSyncFile('Private/check.md', false), false, 'existing exclusion preserved');
    for (const path of ['Notes/check.md', 'Notes/check.canvas', 'Notes/check.base', 'Files/a.PNG', 'Files/a.mp3', 'Files/a.webm', 'Files/a.pdf']) {
      equal(filter.allowSyncFile(path, false), true, 'ordinary supported file permitted');
    }
    equal(filter.allowSyncFile('Files/a.unknown', false), false, 'unsupported file remains excluded');
    const returned = filter.changeFilter({ a: { path: `${target}/main.js`, folder: false } }, changed => { changed.ignoreFolders = ['Private']; });
    equal(returned.length, 1, 'unexcluded remote candidate requeued');
    equal(filter.allowSyncFile(`${target}/main.js`, false), true, 'unexcluded file permitted');
    equal(filter.ignoreFolders.join(','), 'Private', 'unrelated exclusion retained');
  }
  return checks;
}

function main() {
  const file = process.env.OBSIDIAN_MOBILE_APP_JS;
  if (!file) {
    console.log(JSON.stringify({ result: 'SKIP', reason: 'Set OBSIDIAN_MOBILE_APP_JS to a locally obtained mobile app.js. No download was attempted.' }));
    return;
  }
  const bundle = loadBundle(file);
  console.log(JSON.stringify({
    result: 'PASS', version: profile.version, appJsSha256: APP_JS_SHA256,
    fingerprints: Object.values(profile.fingerprints).reduce((count, entries) => count + Object.keys(entries).length, 0),
    dependencyFingerprints: Object.fromEntries(Object.entries(bundle.helpers).map(([name, source]) => [name, sha256(source)])),
    offlineFilterAssertions: probeFilter(bundle),
    limits: 'Official Android bundle with iPhone-observed Sync method fingerprints. Synthetic storage/platform services only; no live device, IndexedDB durability, network transfer or restart tested.',
  }, null, 2));
}

module.exports = { APP_JS_SHA256, sha256, extractBundle, loadBundle, createContext, probeFilter };
if (require.main === module) {
  try { main(); } catch (error) { console.error(`Mobile compatibility audit failed: ${error.message}`); process.exitCode = 1; }
}
