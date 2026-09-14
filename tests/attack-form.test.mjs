import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

globalThis.FormApplication = class {
  static get defaultOptions() { return { closeOnSubmit: true }; }
  activateListeners() {}
  async close() { this.closed = true; }
};
globalThis.foundry = { utils: { mergeObject: (base, options) => ({ ...base, ...options }) } };
globalThis.game = {
  system: { id: "cyberpunk2020-rilerena" },
  i18n: { localize: key => key },
  settings: { get: () => true }
};
const errors = [];
globalThis.ui = { notifications: { error: message => errors.push(message) } };
const { ModifiersDialog } = await import("../module/dialog/modifiers.js");

function rangedGroups() {
  return [[
    { dataPath: "fireMode", defaultValue: "SemiAuto", choices: ["SemiAuto", "FullAuto", "Suppressive"] },
    { dataPath: "range", defaultValue: "RangeClose", choices: ["RangeClose", "RangeLong"] }
  ], [
    { dataPath: "aimRounds", defaultValue: 0, choices: [0, 1, 2, 3] },
    { dataPath: "targetArea", defaultValue: "", choices: ["Head"], allowBlank: true },
    { dataPath: "ambush", defaultValue: false },
    { dataPath: "coverSp", defaultValue: 0 }
  ]];
}

function dialog(options = {}) {
  const result = Object.create(ModifiersDialog.prototype);
  result.options = {
    modifierGroups: rangedGroups(), extraMod: true, targetTokens: [],
    weapon: { name: "Test shotgun" }, onConfirm: async () => ({}), ...options
  };
  return result;
}

function attack(overrides = {}) {
  return { fireMode: "SemiAuto", range: "RangeClose", aimRounds: "0", targetArea: "", ambush: false, coverSp: 0, extraMod: 0, ...overrides };
}

test("attack form owns closing instead of FormApplication closing invalid or canceled submissions", () => {
  assert.equal(ModifiersDialog.defaultOptions.closeOnSubmit, false);
});

test("only common ranged choices remain primary without mutating legacy modifierGroups API", () => {
  const groups = rangedGroups();
  const original = structuredClone(groups);
  const instance = dialog({ modifierGroups: groups });
  const first = instance.getData();
  const second = instance.getData();
  assert.deepEqual(first.primaryModifierGroups.flat().map(modifier => modifier.dataPath), ["fireMode", "range", "aimRounds", "targetArea"]);
  assert.deepEqual(first.advancedModifierGroups.flat().map(modifier => modifier.dataPath), ["ambush", "coverSp", "extraMod"]);
  assert.equal(first.advancedExpanded, false);
  assert.equal(first.modifierGroups.length, 3);
  assert.deepEqual(first, second);
  assert.deepEqual(groups, original);
  assert.equal(first.weapon.name, "Test shotgun");
  assert.deepEqual(first.targetTokens, []);
});

test("martial action, martial art and melee hit location stay primary", () => {
  const instance = dialog({ modifierGroups: [[
    { dataPath: "action", choices: [{ groupName: "Attacks", choices: ["Strike", "Kick"] }] },
    { dataPath: "martialArt", choices: [{ value: "Brawling", localKey: "SkillBrawling" }] },
    { dataPath: "targetArea", choices: ["Head"] }
  ]] });
  assert.deepEqual(instance.getData().primaryModifierGroups.flat().map(modifier => modifier.dataPath), ["action", "martialArt", "targetArea"]);
});

test("advanced fields reopen with nondefault retained input following cancellation", async () => {
  const instance = dialog({ onConfirm: async () => ({ canceled: true }) });
  await instance._updateObject({}, attack({ extraMod: "2", ambush: true, range: "RangeLong" }));
  const data = instance.getData();
  assert.equal(data.advancedExpanded, true);
  assert.equal(data.defaultValues.extraMod, "2");
  assert.equal(data.defaultValues.ambush, true);
  assert.equal(data.defaultValues.range, "RangeLong");
  assert.equal(instance.closed, undefined);
  await instance._updateObject({}, attack({ coverSp: "0", extraMod: "0" }));
  assert.equal(instance.getData().advancedExpanded, false, "numeric-string zero remains the default");
});

test("manual die validation permits retry without losing user input", async () => {
  let calls = 0;
  const instance = dialog({ manualAttackDieEnabled: true, onConfirm: async () => { calls++; } });
  const invalid = attack({ manualAttackDie: "10", extraMod: 4 });
  const priorErrors = errors.length;
  assert.equal(await instance._updateObject({}, invalid), false);
  assert.equal(calls, 0);
  assert.equal(instance.closed, undefined);
  assert.equal(errors.length, priorErrors + 1);
  assert.equal(instance.getData().manualAttackDie, "10");
  assert.equal(instance.getData().defaultValues.extraMod, 4);
  assert.equal(instance.getData().advancedExpanded, true);
  await instance._updateObject({}, attack({ manualAttackDie: "10,7" }));
  assert.equal(calls, 1);
  assert.equal(instance.closed, true);
});

test("blank physical-die input selects automatic rolling and valid entries preserve one explosion", async () => {
  for (const [input, expected] of [["", ""], ["   ", ""], [" 7 ", "7"], ["10,6", "10,6"]]) {
    let captured;
    const instance = dialog({ manualAttackDieEnabled: true, onConfirm: async values => { captured = values; } });
    await instance._updateObject({}, attack({ manualAttackDie: input }));
    assert.equal(captured.manualAttackDie, expected);
  }
});

test("concurrent and repeated submits never execute another attack", async () => {
  let complete;
  const pending = new Promise(resolve => { complete = resolve; });
  let calls = 0;
  const button = { disabled: false };
  const instance = dialog({ onConfirm: async () => { calls++; await pending; } });
  instance.form = { querySelectorAll: () => [button], setAttribute() {} };
  const first = instance._updateObject({}, attack());
  assert.equal(calls, 1);
  assert.equal(button.disabled, true);
  assert.equal(await instance._updateObject({}, attack()), false);
  assert.equal(calls, 1);
  complete();
  await first;
  assert.equal(button.disabled, false);
  assert.equal(instance.closed, true);
  await instance._updateObject({}, attack());
  assert.equal(calls, 1);
});

test("callback cancellation and failure allow retry and preserve input", async () => {
  for (const initial of [false, { canceled: true }, new Error("Retryable placement failure")]) {
    let calls = 0;
    const instance = dialog({ onConfirm: async () => {
      calls++;
      if (calls > 1) return {};
      if (initial instanceof Error) throw initial;
      return initial;
    } });
    const data = attack({ extraMod: 3, range: "RangeLong" });
    assert.equal(await instance._updateObject({}, data), false);
    assert.equal(instance.closed, undefined);
    assert.equal(instance.getData().defaultValues.extraMod, 3);
    assert.equal(instance._confirmInFlight, false);
    await instance._updateObject({}, data);
    assert.equal(calls, 2);
    assert.equal(instance.closed, true);
  }
});

test("partially committed non-retryable failures lock confirmation instead of risking another action", async () => {
  const failure = Object.assign(new Error("Partial commit requires GM review"), { nonRetryable: true });
  let calls = 0;
  const instance = dialog({ onConfirm: async () => { calls++; throw failure; } });
  const button = { disabled: false };
  const attributes = {};
  instance.form = {
    querySelectorAll: selector => selector === '[type="submit"]' ? [button] : [],
    setAttribute: (name, value) => { attributes[name] = value; }
  };
  assert.equal(await instance._updateObject({}, attack()), false);
  assert.equal(errors.at(-1), failure.message);
  assert.equal(instance._confirmed, true);
  assert.equal(instance._confirmInFlight, false);
  assert.equal(button.disabled, true);
  assert.equal(attributes["aria-busy"], "false", "locked does not imply an operation is still running");
  assert.equal(await instance._updateObject({}, attack()), false);
  assert.equal(calls, 1);
  button.disabled = false;
  instance.activateListeners([{}]);
  assert.equal(button.disabled, true, "re-rendering must not re-enable a partially committed attack");
});

test("only the last valid fire mode is remembered per weapon UUID for this client session", async () => {
  const weapon = { uuid: "Actor.remember.Item.one" };
  const first = dialog({ weapon, manualAttackDieEnabled: true });
  await first._updateObject({}, attack({ fireMode: "FullAuto", range: "RangeLong", aimRounds: 3, targetArea: "Head", ambush: true, extraMod: 5, manualAttackDie: "8" }));
  const reopened = dialog({ weapon, manualAttackDieEnabled: true });
  const data = reopened.getData();
  assert.equal(data.defaultValues.fireMode, "FullAuto");
  assert.equal(data.defaultValues.range, "RangeClose");
  assert.equal(data.defaultValues.aimRounds, 0);
  assert.equal(data.defaultValues.targetArea, "");
  assert.equal(data.defaultValues.ambush, false);
  assert.equal(data.defaultValues.extraMod, 0);
  assert.equal(data.manualAttackDie, "");
  assert.equal(dialog({ weapon: { uuid: "Actor.remember.Item.two" } }).getData().defaultValues.fireMode, "SemiAuto");
});

test("remembered fire mode is discarded when the weapon's allowed choices change", async () => {
  const weapon = { uuid: "Actor.revalidate.Item.one" };
  await dialog({ weapon })._updateObject({}, attack({ fireMode: "FullAuto" }));
  const restricted = rangedGroups();
  restricted[0][0].choices = [{ value: "SemiAuto" }];
  assert.equal(dialog({ weapon, modifierGroups: restricted }).getData().defaultValues.fireMode, "SemiAuto");
  assert.equal(dialog({ weapon }).getData().defaultValues.fireMode, "SemiAuto", "invalid memory is removed, not revived if choices later return");
});

test("invalid or canceled fire mode submissions do not replace the saved mode", async () => {
  const weapon = { uuid: "Actor.cancel.Item.one" };
  await dialog({ weapon })._updateObject({}, attack({ fireMode: "FullAuto" }));
  let calls = 0;
  const invalid = dialog({ weapon, onConfirm: async () => { calls++; } });
  assert.equal(await invalid._updateObject({}, attack({ fireMode: "InventedMode" })), false);
  assert.equal(calls, 0);
  await dialog({ weapon, onConfirm: async () => ({ canceled: true }) })._updateObject({}, attack({ fireMode: "SemiAuto" }));
  assert.equal(dialog({ weapon }).getData().defaultValues.fireMode, "FullAuto");
});

test("transient objects without a UUID never share remembered state", async () => {
  await dialog({ weapon: { id: "same-id" } })._updateObject({}, attack({ fireMode: "FullAuto" }));
  assert.equal(dialog({ weapon: { id: "same-id" } }).getData().defaultValues.fireMode, "SemiAuto");
});

test("template choice is opt-in, validates submitted targeting, and is never remembered", async () => {
  let calls = 0;
  const options = { templateTargetingAvailable: true, weapon: { uuid: "Actor.target.Item.one" }, onConfirm: async () => { calls++; } };
  const instance = dialog(options);
  assert.equal(instance.getData().defaultValues.targetingMode, "selected");
  assert.equal(await instance._updateObject({}, attack({ targetingMode: "invalid" })), false);
  assert.equal(calls, 0);
  await instance._updateObject({}, attack({ targetingMode: "template" }));
  assert.equal(calls, 1);
  assert.equal(dialog(options).getData().defaultValues.targetingMode, "selected");
  assert.equal(dialog().getData().templateTargetingAvailable, false);
});

test("template targeting disables manual range; suppression disables contradictory targeting", () => {
  const controls = {
    '[name="targetingMode"]': { value: "selected" },
    '[name="fireMode"]': { value: "SemiAuto" },
    '[name="range"]': { value: "RangeLong" },
    ".attack-template-range-hint": { hidden: true }
  };
  const callbacks = new Map();
  for (const name of ['[name="targetingMode"]', '[name="fireMode"]']) {
    controls[name].addEventListener = (_event, fn) => callbacks.set(name, fn);
  }
  const form = {
    querySelector: selector => controls[selector],
    querySelectorAll: () => [controls['[name="targetingMode"]'], controls['[name="fireMode"]']]
  };
  const instance = dialog();
  instance.form = form;
  instance.activateListeners([{}]);
  assert.equal(controls['[name="range"]'].disabled, false);
  controls['[name="targetingMode"]'].value = "template";
  callbacks.get('[name="targetingMode"]')();
  assert.equal(controls['[name="range"]'].disabled, true);
  assert.equal(controls[".attack-template-range-hint"].hidden, false);
  controls['[name="fireMode"]'].value = "Suppressive";
  callbacks.get('[name="fireMode"]')();
  assert.equal(controls['[name="targetingMode"]'].disabled, true);
  assert.equal(controls['[name="range"]'].disabled, false);
  assert.equal(controls['[name="range"]'].value, "RangeLong", "changing targeting never overwrites range selection");
  assert.equal(controls[".attack-template-range-hint"].hidden, true);
});

test("canceled template placement preserves disabled range input across a rerender", async () => {
  const instance = dialog({ templateTargetingAvailable: true, onConfirm: async () => ({ canceled: true }) });
  instance.form = {
    querySelector: selector => selector === '[name="range"]' ? { value: "RangeLong", disabled: true } : undefined
  };
  const submitted = attack({ targetingMode: "template" });
  delete submitted.range;
  await instance._updateObject({}, submitted);
  assert.equal(instance.getData().defaultValues.range, "RangeLong");
  assert.equal(instance.getData().defaultValues.targetingMode, "template");
  assert.equal(submitted.range, undefined, "UI-only retained range must not override measured template distance");
});

test("template keeps advanced modifiers collapsed, renders a weapon/target summary and labels the action", () => {
  const template = readFileSync(new URL("../templates/dialog/modifiers.hbs", import.meta.url), "utf8");
  assert.match(template, /<details class="attack-advanced" \{\{#if advancedExpanded\}\}open/);
  assert.match(template, /\{\{weapon.name\}\}/);
  assert.match(template, /attack-target-summary/);
  assert.match(template, /AttackRollAction/);
  assert.doesNotMatch(template, /CPLocal "OK"/);
});
