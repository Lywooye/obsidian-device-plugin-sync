import assert from "node:assert/strict";
import test from "node:test";
import {
  PLUGIN_ID, parsePolicy, planExclusions, pluginPath, serializePolicy,
  type Policy,
} from "../src/model";

const path = (id: string) => pluginPath(".obsidian", id);
const policy = (): Policy => ({
  schema: 1,
  revision: 4,
  authorityId: "desktop-installation-1",
  devices: [{ id: "phone-1", name: "手机", kind: "phone", excludedPluginIds: ["desktop-only"] }],
  plugins: [{ id: "desktop-only", name: "Desktop only" }, { id: "shared", name: "共享插件" }],
});
const document = (value: unknown) => `# Rules\n\n\`\`\`json\n${JSON.stringify(value)}\n\`\`\`\n`;

test("policy round-trips without changing names, exclusions or revision", () => {
  const original = policy();
  assert.deepEqual(parsePolicy(serializePolicy(original)), original);
  assert.deepEqual(parsePolicy(serializePolicy(original).replaceAll("\n", "\r\n")), original);
});

test("rejects corrupt, missing and ambiguous JSON blocks", () => {
  assert.throws(() => parsePolicy("# Rules without JSON"));
  assert.throws(() => parsePolicy("```json\n{broken}\n```"));
  assert.throws(() => parsePolicy(document(policy()) + document(policy())));
});

test("rejects unsupported schema and unsafe revision numbers", () => {
  assert.throws(() => parsePolicy(document({ ...policy(), schema: 2 })));
  for (const revision of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, "4", null]) {
    assert.throws(() => parsePolicy(document({ ...policy(), revision })));
  }
  assert.equal(parsePolicy(document({ ...policy(), revision: 0 })).revision, 0);
});

test("rejects duplicate plugin, device and per-device exclusion IDs", () => {
  const plugins = policy();
  plugins.plugins.push({ ...plugins.plugins[0] });
  assert.throws(() => parsePolicy(document(plugins)));
  const devices = policy();
  devices.devices.push({ ...devices.devices[0] });
  assert.throws(() => parsePolicy(document(devices)));
  const exclusions = policy();
  exclusions.devices[0].excludedPluginIds.push("desktop-only");
  assert.throws(() => parsePolicy(document(exclusions)));
});

test("rejects dangerous IDs, unknown keys, unknown plugins and manager exclusion", () => {
  for (const id of ["__proto__", "prototype", "constructor", "toString", "../escape", "a/b", "a\\b"]) {
    assert.throws(() => parsePolicy(document({ ...policy(), authorityId: id })));
    assert.throws(() => parsePolicy(document({ ...policy(), plugins: [{ id, name: "Invalid" }] })));
    const invalidDevice = policy();
    invalidDevice.devices[0].id = id;
    assert.throws(() => parsePolicy(document(invalidDevice)));
  }
  assert.throws(() => parsePolicy(document({ ...policy(), typo: true })));
  assert.throws(() => parsePolicy(document(JSON.parse(JSON.stringify(policy()).replace('"schema":1', '"schema":1,"__proto__":{}')))));
  const unknown = policy();
  unknown.devices[0].excludedPluginIds = ["unregistered"];
  assert.throws(() => parsePolicy(document(unknown)));
  const self = policy();
  self.plugins.push({ id: PLUGIN_ID, name: "Manager" });
  assert.doesNotThrow(() => parsePolicy(document(self)));
  self.devices[0].excludedPluginIds = [PLUGIN_ID];
  assert.throws(() => parsePolicy(document(self)));
});

test("rejects invalid shapes, names and device kind", () => {
  for (const value of [null, [], {}, { ...policy(), devices: {} }, { ...policy(), plugins: null }]) {
    assert.throws(() => parsePolicy(document(value)));
  }
  for (const name of ["", "  ", "name\nsecond line"]) {
    const invalid = policy();
    invalid.plugins[0].name = name;
    assert.throws(() => parsePolicy(document(invalid)));
  }
  const invalid = policy();
  assert.throws(() => parsePolicy(document({ ...invalid, devices: [{ ...invalid.devices[0], kind: "watch" }] })));
});

test("plugin paths support custom configuration directories but never traversal or self exclusion", () => {
  assert.equal(pluginPath(".obsidian-phone", "hello_world-2"), ".obsidian-phone/plugins/hello_world-2");
  assert.equal(pluginPath("配置/.手机", "example"), "配置/.手机/plugins/example");
  for (const config of ["", "/.obsidian", ".obsidian/", "../outside", "a/../b", "a//b", "a/./b", "C:\\obsidian", "a\u0000b"]) {
    assert.throws(() => pluginPath(config, "safe-plugin"));
  }
  for (const id of ["", "..", "../escape", "a/b", "a\\b", "constructor", "prototype", "__proto__", PLUGIN_ID]) {
    assert.throws(() => pluginPath(".obsidian", id));
  }
});

test("adds only missing plugin exclusions while retaining external order and ownership", () => {
  const current = ["Private", path("old"), "Drafts", path("external")];
  const owned = [path("old")];
  const originalCurrent = [...current];
  const originalOwned = [...owned];
  const plan = planExclusions(current, owned, ["old", "new", "external"], ".obsidian");
  assert.deepEqual(plan.before, current);
  assert.deepEqual(plan.after, [...current, path("new")]);
  assert.deepEqual(plan.add, [path("new")]);
  assert.deepEqual(plan.remove, []);
  assert.deepEqual(plan.ownedAfter, [path("old"), path("new")]);
  assert.deepEqual(plan.externallyExcluded, [path("external")]);
  assert.deepEqual(current, originalCurrent);
  assert.deepEqual(owned, originalOwned);
});

test("removing a policy excludes only exact owned entries, preserving external entries", () => {
  const current = ["First", path("owned"), path("external"), "Last"];
  const plan = planExclusions(current, [path("owned")], [], ".obsidian");
  assert.deepEqual(plan.after, ["First", path("external"), "Last"]);
  assert.deepEqual(plan.remove, [path("owned")]);
  assert.deepEqual(plan.ownedAfter, []);
});

test("ancestor exclusion covers a plugin without acquiring ownership", () => {
  for (const ancestor of [".obsidian", ".obsidian/plugins"]) {
    const plan = planExclusions(["Notes", ancestor], [], ["desktop-only"], ".obsidian");
    assert.deepEqual(plan.after, ["Notes", ancestor]);
    assert.deepEqual(plan.add, []);
    assert.deepEqual(plan.ownedAfter, []);
    assert.deepEqual(plan.externallyExcluded, [path("desktop-only")]);
    assert.ok(plan.warnings.length > 0);
  }
});

test("unnormalized external paths stop planning instead of pretending native coverage", () => {
  for (const existing of [`${path("example")}/`, ".obsidian/", ".obsidian/plugins/", "a//b"]) {
    assert.throws(() => planExclusions([existing], [], ["example"], ".obsidian"), /Sync 设置中检查/);
  }
});

test("sibling prefix and descendant exclusions do not cover the requested plugin directory", () => {
  const current = [".obsidian-other", path("test-long"), `${path("test")}/data.json`];
  const plan = planExclusions(current, [], ["test"], ".obsidian");
  assert.deepEqual(plan.add, [path("test")]);
  assert.deepEqual(plan.after, [...current, path("test")]);
});

test("external ancestors retire redundant owned entries and warn when sync stays excluded", () => {
  const current = [path("old"), ".obsidian/plugins", "Private"];
  const retainedPolicy = planExclusions(current, [path("old")], ["old"], ".obsidian");
  assert.deepEqual(retainedPolicy.after, [".obsidian/plugins", "Private"]);
  assert.deepEqual(retainedPolicy.ownedAfter, []);
  assert.deepEqual(retainedPolicy.externallyExcluded, [path("old")]);
  const removedPolicy = planExclusions(current, [path("old")], [], ".obsidian");
  assert.deepEqual(removedPolicy.remove, [path("old")]);
  assert.ok(removedPolicy.warnings.some((warning) => warning.includes("不会恢复同步")));
});

test("missing, changed and out-of-scope owned paths block application", () => {
  assert.throws(() => planExclusions([], [path("missing")], [], ".obsidian"), /重置管理记录/);
  assert.throws(() => planExclusions([`${path("changed")}/`], [path("changed")], [], ".obsidian"), /Sync 设置中检查/);
  for (const owned of ["Private", ".obsidian-mobile/plugins/example", ".obsidian/plugins", ".obsidian/plugins/example/data.json"]) {
    assert.throws(() => planExclusions([owned], [owned], [], ".obsidian"));
  }
  assert.throws(() => planExclusions([path("old")], [path("old"), path("old")], [], ".obsidian"));
});

test("a completed plan is stable when computed again", () => {
  const first = planExclusions(["Private", path("old")], [path("old")], ["new"], ".obsidian");
  const second = planExclusions(first.after, first.ownedAfter, ["new"], ".obsidian");
  assert.deepEqual(second.after, first.after);
  assert.deepEqual(second.add, []);
  assert.deepEqual(second.remove, []);
  assert.deepEqual(second.ownedAfter, first.ownedAfter);
});

test("planner refuses manager exclusion and duplicate desired plugins", () => {
  assert.throws(() => planExclusions([], [], [PLUGIN_ID], ".obsidian"));
  assert.throws(() => planExclusions([], [], ["example", "example"], ".obsidian"));
  assert.throws(() => planExclusions([`.obsidian/plugins/${PLUGIN_ID}`], [`.obsidian/plugins/${PLUGIN_ID}`], [], ".obsidian"));
});
