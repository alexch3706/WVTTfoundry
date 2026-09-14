import assert from "node:assert/strict";
import test from "node:test";
import "./mock-globals.mjs";

// Exercise the actual sheet preparation methods, not source-text patterns.
// The base supplies the live Actor reference used by Foundry V14 ActorSheet.
globalThis.ActorSheet = class {
  constructor(actor, options = {}) { this.actor = actor; this.options = options; }
  async getData() { return { actor: this.actor, options: this.options }; }
};
globalThis.FormApplication = class {};
globalThis.game = {
  system: { id: "cyberpunk2020-rilerena" },
  settings: { get: () => false },
  i18n: { localize: key => key, format: (key, values) => `${key} ${Object.values(values).join(" ")}` }
};
const { CyberpunkActorSheet } = await import("../module/actor/actor-sheet.js");

function makeActor(type = "character", system = {}) {
  const skills = [
    { id: "stealth", type: "skill", name: "Stealth", system: { stat: "ref", level: 2 } },
    { id: "handgun", type: "skill", name: "Handgun", system: { stat: "ref", level: 0 } },
    { id: "awareness", type: "skill", name: "Awareness/Notice", system: { stat: "int", level: 3 } }
  ];
  const items = [...skills];
  Object.defineProperty(items, "get", { value: id => items.find(item => item.id === id) });
  return {
    type, system: { stats: { bt: { total: 6 } }, ...system }, items,
    itemTypes: { skill: skills, weapon: [], armor: [], cyberware: [], misc: [] }
  };
}

for(const actorType of ["character", "npc"]) {
  for(const [label, cache] of [
    ["missing", undefined], ["null", null], ["empty", []],
    ["deleted skills", ["stealth", "deleted", "awareness"]],
    ["duplicate IDs", ["handgun", "handgun", "awareness"]]
  ]) {
    test(`${actorType} getData sorts actual skills when cache is ${label}`, async () => {
      const actor = makeActor(actorType, { sortedSkillIDs: cache });
      const originalOrder = actor.itemTypes.skill.map(item => item.id);
      const sheet = new CyberpunkActorSheet(actor);
      const data = await sheet.getData({});
      assert.deepEqual(data.filteredSkillIDs, ["awareness", "handgun", "stealth"]);
      assert.deepEqual(data.skillDisplayList, data.filteredSkillIDs.map(id => actor.items.get(id)));
      assert.deepEqual(actor.itemTypes.skill.map(item => item.id), originalOrder, "sorting must not reorder the Item collection");
      assert.equal(data.woundStates.length, 10);
      assert.ok(data.weaponTypes);
    });
  }
}

test("getData retains a valid cache and searches current actor items", async () => {
  const actor = makeActor("character", {
    sortedSkillIDs: ["stealth", "awareness", "handgun"], transient: { skillFilter: "aWAr" }
  });
  const sheet = new CyberpunkActorSheet(actor);
  assert.deepEqual((await sheet.getData({})).filteredSkillIDs, ["awareness"]);
  actor.system.transient.skillFilter = "";
  assert.deepEqual((await sheet.getData({})).filteredSkillIDs, ["stealth", "awareness", "handgun"]);
});

test("getData handles an actor without skills", async () => {
  const actor = makeActor();
  actor.items.length = 0;
  actor.itemTypes.skill = [];
  const data = await new CyberpunkActorSheet(actor).getData({});
  assert.deepEqual(data.filteredSkillIDs, []);
  assert.deepEqual(data.skillDisplayList, []);
});

test("fallback sorting respects trained-skills-first and the selected sort mode", async () => {
  game.settings.get = () => true;
  try {
    const actor = makeActor("npc", { skillsSortedBy: "Stat", sortedSkillIDs: [] });
    const data = await new CyberpunkActorSheet(actor).getData({});
    assert.deepEqual(data.filteredSkillIDs, ["awareness", "stealth", "handgun"]);
  } finally {
    game.settings.get = () => false;
  }
});
