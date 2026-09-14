import "./mock-globals.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { CyberpunkActor } from "../module/actor/actor.js";
import { makeD10Roll, Multiroll } from "../module/dice.js";
import { MANUAL_SAVE_TEMPLATE } from "../module/combat/manual-save-roll.js";
import { getDeathSaveState, getStunSaveState, isSaveRollSuccessful, resolveSavePromptsForTarget } from "../module/combat/save-resolver.js";
import { isSaveRollSuccessful as autoSaveSuccessful } from "../module/combat/save-chat-listeners.js";

const translations = {
  SaveSuccess: "Success", SaveFailure: "Failure", SaveNotRequired: "Not required",
  SaveStunLabel: "Stun/Shock Save", SaveDeathLabel: "Death Save",
  SaveFormula: "BODY {body} − {penalty} = {threshold}"
};

function harness(t, total) {
  const previous = Object.fromEntries(["Roll", "game", "foundry", "ChatMessage", "ui"].map(key => [key, globalThis[key]]));
  t.after(() => {
    for(const [key, value] of Object.entries(previous)) {
      if(value === undefined) delete globalThis[key];
      else globalThis[key] = value;
    }
  });
  const calls = { formulas: [], evaluated: 0, messages: [], templates: [], notifications: [] };
  class Die {
    constructor() {
      Object.assign(this, {
        number: 1, faces: 10, total, expression: "1d10",
        results: [{ result: total }]
      });
    }
    getResultLabel(result) { return String(result.result); }
  }
  globalThis.Roll = class {
    constructor(formula) {
      calls.formulas.push(formula);
      this.formula = formula;
      this.terms = this.dice = [new Die()];
    }
    async evaluate() {
      calls.evaluated++;
      this.total = total;
      return this;
    }
  };
  globalThis.game = {
    user: { id: "player" },
    i18n: {
      localize: key => translations[key.replace("CYBERPUNK.", "")] || key,
      format(key, args) {
        return this.localize(key).replace(/\{(\w+)\}/g, (_match, name) => args[name]);
      }
    }
  };
  globalThis.foundry = {
    dice: { terms: { Die } },
    utils: { mergeObject: (target, source) => Object.assign(target, source) },
    applications: { handlebars: { renderTemplate: async (path, data) => {
      calls.templates.push({ path, data });
      return JSON.stringify(data);
    } } }
  };
  globalThis.ChatMessage = {
    getSpeaker: ({ actor }) => ({ actor: actor.id, alias: actor.name }),
    create: async data => { calls.messages.push(data); return { id: "chat-save", ...data }; }
  };
  globalThis.ui = { notifications: {
    info: message => calls.notifications.push(message),
    warn: message => calls.notifications.push(message)
  } };
  return calls;
}

function actorWith({ damage = 13, body = 6, ...extraSystem } = {}) {
  const actor = Object.create(CyberpunkActor.prototype);
  actor.id = "save-actor";
  actor.name = "Save actor";
  actor.system = { damage, stats: { bt: { total: body } }, ...extraSystem };
  actor.update = () => { throw new Error("Manual save must not modify actor data"); };
  actor.updateEmbeddedDocuments = actor.update;
  actor.setFlag = actor.update;
  return actor;
}

for(const [total, expectedStun, expectedDeath] of [[1, true, true], [3, true, true], [6, false, true], [10, false, false]]) {
  test(`manual roll ${total}: independently reports correct Stun/Death results including equality`, async t => {
    const calls = harness(t, total);
    const actor = actorWith();
    const originalSystem = structuredClone(actor.system);
    const result = await actor.rollStunDeath();
    assert.equal(result.id, "chat-save", "actor method returns the awaited chat result");
    assert.deepEqual(calls.formulas, ["1d10"], "one nonexploding die and no dummy threshold rolls");
    assert.equal(calls.evaluated, 1);
    assert.equal(calls.messages.length, 1);
    assert.equal(calls.templates[0].path, MANUAL_SAVE_TEMPLATE);
    const { saves, roll } = calls.templates[0].data;
    assert.equal(roll.total, total);
    assert.deepEqual(saves.map(save => save.threshold), [3, 6]);
    for(const [index, expected] of [expectedStun, expectedDeath].entries()) {
      assert.equal(saves[index].passed, expected);
      assert.equal(saves[index].label, expected ? "Success" : "Failure");
      assert.equal(saves[index].resultClass, expected ? "outcome-hit" : "outcome-miss");
      assert.equal(saves[index].required, true);
      assert.equal("isCrit" in saves[index], false);
      assert.equal("isFumble" in saves[index], false);
    }
    assert.deepEqual(calls.messages[0].speaker, { actor: "save-actor", alias: "Save actor" });
    assert.deepEqual(calls.messages[0].rolls, [roll]);
    assert.equal(calls.messages[0].flags, undefined, "does not mark pending combat saves resolved");
    assert.deepEqual(actor.system, originalSystem);
  });
}

test("a natural ten passes when the save threshold is ten: no implicit fumble", async t => {
  const calls = harness(t, 10);
  await actorWith({ body: 13 }).rollStunDeath();
  assert.deepEqual(calls.templates[0].data.saves.map(save => save.passed), [true, true]);
});

test("Death is not presented as a failed save before Mortal wounds or while stabilized", async t => {
  const calls = harness(t, 10);
  for(const data of [{ damage: 0 }, { damage: 12 }, { damage: 13, deathSave: { stabilized: true } }]) {
    await actorWith(data).rollStunDeath();
    const death = calls.templates.at(-1).data.saves[1];
    assert.equal(death.required, false);
    assert.equal(death.passed, undefined);
    assert.equal(death.label, "Not required");
    assert.equal(death.resultClass, "outcome-not-fired");
    assert.ok(death.notRequiredReason);
  }
});

test("FBC and already-dead actors do not roll or create a result", async t => {
  const calls = harness(t, 1);
  for(const data of [{ isFBC: true }, { damage: 41 }, { deathSave: { dead: true } }]) {
    assert.equal(await actorWith(data).rollStunDeath(), undefined);
  }
  assert.equal(calls.notifications.length, 3);
  assert.deepEqual(calls.formulas, []);
  assert.deepEqual(calls.messages, []);
});

test("missing or invalid BODY and wound data cannot generate misleading save results", async t => {
  const calls = harness(t, 1);
  const cases = [
    { damage: null }, { damage: "" }, { damage: -1 }, { damage: 1.5 },
    { body: null }, { body: "" }, { body: 0 }, { body: 6.5 }, { body: NaN }
  ];
  for(const data of cases) await actorWith(data).rollStunDeath();
  const missingDamage = actorWith();
  delete missingDamage.system.damage;
  await missingDamage.rollStunDeath();
  assert.equal(calls.notifications.length, cases.length + 1);
  assert.deepEqual(calls.formulas, []);
  assert.deepEqual(calls.messages, []);
});

test("sheet thresholds share canonical damage-save penalties, including uninjured and minimum thresholds", () => {
  const actor = actorWith({ damage: 0 });
  assert.equal(actor.stunThreshold(), 6, "uninjured does not add a fictitious +1 BODY");
  assert.equal(actor.deathThreshold(), 6, "pre-Mortal death threshold never gains a positive wound bonus");
  for(const damage of [1, 5, 9, 13, 17, 37]) {
    actor.system.damage = damage;
    const prompts = resolveSavePromptsForTarget({
      target: { snapshot: actor.system },
      damage: { previousDamage: damage - 1, nextDamage: damage, damageDelta: 1 }
    }).saves;
    assert.equal(actor.stunThreshold(), prompts.find(save => save.type === "stun").threshold);
    assert.equal(actor.stunThreshold(), getStunSaveState(actor).threshold);
    assert.equal(actor.deathThreshold(), getDeathSaveState(actor).threshold);
    const deathPrompt = prompts.find(save => save.type === "death");
    if(deathPrompt) assert.equal(actor.deathThreshold(), deathPrompt.threshold);
  }
  actor.system.stats.bt.total = 2;
  assert.equal(actor.stunThreshold(), 1);
  assert.equal(actor.deathThreshold(), 1);
  assert.equal(autoSaveSuccessful, isSaveRollSuccessful, "manual and automatic checks use the same function");
});

test("dedicated save template has explicit comparison and semantic results, without critical/min-max styling", () => {
  const template = readFileSync(new URL("../templates/chat/save-roll.hbs", import.meta.url), "utf8");
  assert.match(template, /\{\{resultClass\}\}/);
  assert.match(template, /\{\{label\}\}/);
  assert.match(template, /\{\{#if passed\}\}≤\{\{else\}\}&gt;/);
  assert.doesNotMatch(template, /\b(?:crit|fumble|isCrit|isFumble|min|max|diceInfo)\b/);
});

test("ordinary attack Multiroll still uses exploding d10 and high-is-good critical/fumble feedback", async t => {
  const calls = harness(t, 10);
  await new Multiroll("Attack").addRoll(makeD10Roll([5])).defaultExecute();
  assert.deepEqual(calls.formulas, ["1d10x10 + 5"]);
  assert.equal(calls.templates[0].data.rolls[0].isCrit, true);
  assert.equal(calls.templates[0].data.rolls[0].isFumble, false);
  assert.match(calls.templates[0].data.rolls[0].diceInfo[0].subrolls[0].classes, /\bmax\b/);
});
