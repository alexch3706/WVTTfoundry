import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { buildInitialAttackTargets, executeAttackFromForm, supportsAreaTargeting } from "../module/combat/attack-workflow.js";
import { rangedModifiers } from "../module/lookups.js";

function setup(system = {}) {
  const events = [];
  const weapon = {
    system: { weaponType: "Rifle", attackType: "Ranged", shotsLeft: 20, rof: 10, range: 100, ...system },
    isRanged: () => true,
    __getFireModes: () => ["SemiAuto", "Suppressive"],
    warnInvalidCombatData: () => false,
    async update(change) { events.push(["ammo", change]); },
    async __weaponRoll(options, targets, resolver) { events.push(["roll", options, targets, resolver]); return { status: "resolved" }; }
  };
  const target = {
    id: "target", document: { uuid: "Scene.s.Token.target", id: "target" },
    actor: { uuid: "Actor.target", system: { damage: 0, stats: { bt: { total: 6 } } }, items: [] }
  };
  const context = { weapon, selectedTargets: [target], attackerToken: { id: "attacker" }, resolverOptions: {}, fireOptions: { fireMode: "SemiAuto", range: "RangeClose" } };
  const deps = {
    measureTokenDistance: () => 5,
    detectAndPromptTacticalRaycasts: async (_attacker, targets) => { events.push(["cover"]); return targets; },
    promptUseSuppressiveFireTemplate: async () => { throw new Error("Unexpected suppression prompt"); },
    drawAoETemplateAndGetTargets: async () => { throw new Error("Unexpected area template"); },
    promptAutoshotgunShellCount: async () => { throw new Error("Unexpected shell prompt"); }
  };
  return { context, deps, events, weapon, target };
}

test("opening an attack measures targets without follow-up dialogs or mutation", () => {
  const { context, target } = setup();
  const before = structuredClone(target);
  const refs = buildInitialAttackTargets(context.attackerToken, [target], () => 8);
  assert.equal(refs[0].distance.value, 8);
  assert.deepEqual(target, before);
  const source = readFileSync(new URL("../module/actor/actor-sheet.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /promptUseAoETemplate|promptAttackDieEntry|detectAndPromptTacticalRaycasts/);
  assert.match(source, /onConfirm: fireOptions => executeAttackFromForm/);
});

test("normal fire never asks about suppression even when the weapon supports it", async () => {
  const { context, deps, events } = setup();
  await executeAttackFromForm(context, deps);
  assert.deepEqual(events.map(e => e[0]), ["cover", "roll"]);
  assert.equal(events[1][2][0].distance.value, 5);
});

test("only the corridor-capable form exposes Suppressive in fidelity mode", () => {
  const { weapon } = setup();
  assert.deepEqual(rangedModifiers(weapon)[0][0].choices, ["SemiAuto"]);
  assert.deepEqual(rangedModifiers(weapon, [], { suppressiveTemplateAvailable: true })[0][0].choices, ["SemiAuto", "Suppressive"]);
});

test("shotgun selected-target mode does not ask about or draw a template", async () => {
  const { context, deps, events, weapon } = setup({ weaponType: "Shotgun" });
  assert.equal(supportsAreaTargeting(weapon), true);
  await executeAttackFromForm(context, deps);
  assert.deepEqual(events.map(e => e[0]), ["cover", "roll"]);
});

test("canceling a chosen area template does not roll or spend ammo", async () => {
  const { context, deps, events } = setup({ attackType: "Shotgun" });
  context.fireOptions.targetingMode = "template";
  deps.drawAoETemplateAndGetTargets = async () => ({ canceled: true });
  assert.deepEqual(await executeAttackFromForm(context, deps), { canceled: true });
  assert.deepEqual(events, []);
});

test("template targeting uses affected target identities and measured ranges", async () => {
  const { context, deps, events, target } = setup({ attackType: "Shotgun" });
  context.fireOptions.targetingMode = "template";
  const affected = { ...target, id: "affected", document: { id: "affected", uuid: "Scene.s.Token.affected" }, distance: { value: 18, source: "template", units: "m" } };
  deps.drawAoETemplateAndGetTargets = async () => ({ affectedTargets: [affected], hazardZone: { type: "cone" } });
  deps.buildAoETemplateTargetingOptions = ({ affectedTargets, hazardZone }) => ({ raycastTargets: affectedTargets, hazardZone });
  await executeAttackFromForm(context, deps);
  const [, options, targets] = events.find(e => e[0] === "roll");
  assert.equal(options.range, "RangeAuto");
  assert.equal(options.hazardZone.type, "cone");
  assert.equal(options.targetsCount, 1, "count reflects final template targets, not the former selection");
  assert.equal(targets[0].tokenUuid, "Scene.s.Token.affected");
  assert.equal(targets[0].distance.value, 18, "template range must not be overwritten using the former selected target");
  assert.equal(options.targetingMode, undefined);
});

test("canceling suppression config or placement never falls through into normal fire", async () => {
  for(const choice of [{ choice: "canceled" }, { choice: "normal" }, { choice: "template", roundsFired: 4, zoneWidth: 2 }]) {
    const { context, deps, events } = setup();
    context.fireOptions.fireMode = "Suppressive";
    deps.promptUseSuppressiveFireTemplate = async (_weapon, max, options) => {
      assert.equal(max, 10); assert.equal(options.templateOnly, true); return choice;
    };
    deps.placePersistentSuppressiveFireTemplate = async () => false;
    assert.deepEqual(await executeAttackFromForm(context, deps), { canceled: true });
    assert.deepEqual(events, []);
  }
});

test("chosen suppression delegates zone and ammunition to one transaction without a second debit", async () => {
  const { context, deps, events } = setup();
  context.fireOptions.fireMode = "Suppressive";
  deps.promptUseSuppressiveFireTemplate = async () => ({ choice: "template", roundsFired: 4, zoneWidth: 2 });
  deps.placePersistentSuppressiveFireTemplate = async (_attacker, _weapon, rounds, width, _range, options) => {
    assert.equal(options.consumeAmmo, true);
    events.push(["zone", rounds, width]); return true;
  };
  assert.deepEqual(await executeAttackFromForm(context, deps), { status: "zone-placed" });
  assert.deepEqual(events, [["zone", 4, 2]]);
});

test("stale suppression ammo aborts before corridor creation", async () => {
  const { context, deps, events, weapon } = setup();
  context.fireOptions.fireMode = "Suppressive";
  deps.promptUseSuppressiveFireTemplate = async () => {
    weapon.system.shotsLeft = 2; return { choice: "template", roundsFired: 4, zoneWidth: 2 };
  };
  await assert.rejects(executeAttackFromForm(context, deps), /ammunition changed/);
  assert.deepEqual(events, []);
});

test("inline manual d10 reaches the roller; invalid input aborts before follow-up prompts", async () => {
  const { context, deps, events } = setup();
  context.fireOptions.manualAttackDie = "10,7";
  await executeAttackFromForm(context, deps);
  const result = events.find(e => e[0] === "roll");
  assert.equal(result[3].manualAttackDie, "10,7");
  assert.equal(result[1].manualAttackDie, undefined);
  events.length = 0;
  context.fireOptions.manualAttackDie = "10";
  await assert.rejects(executeAttackFromForm(context, deps), /follow-up/);
  assert.deepEqual(events, []);
});

test("invalid weapon data blocks all follow-up steps", async () => {
  const { context, deps, events, weapon } = setup();
  weapon.warnInvalidCombatData = () => true;
  assert.deepEqual(await executeAttackFromForm(context, deps), { canceled: true });
  assert.deepEqual(events, []);
});

test("raycast failures keep target updates manual instead of bypassing cover", async () => {
  const { context, deps, events } = setup();
  deps.detectAndPromptTacticalRaycasts = async () => { throw new Error("expected test failure"); };
  await executeAttackFromForm(context, deps);
  const targets = events.find(e => e[0] === "roll")[2];
  assert.equal(targets[0].manualResolution.required, true);
  assert.ok(targets[0].manualResolution.blockedUpdateCategories.includes("target-saves"));
});

test("autoshotgun full-auto prompts only after the mode is chosen; cancel stops the attack", async () => {
  const { context, deps, events, weapon } = setup({ attackType: "Autoshotgun", weaponType: "Shotgun" });
  assert.equal(supportsAreaTargeting(weapon), false);
  context.fireOptions.fireMode = "FullAuto";
  deps.promptAutoshotgunShellCount = async () => 2;
  deps.drawAutoshotgunPatternsAndGetTargets = async () => ({ canceled: true });
  assert.deepEqual(await executeAttackFromForm(context, deps), { canceled: true });
  assert.deepEqual(events.map(e => e[0]), ["cover"]);
});

test("nonstructured attacks retain legacy roll behavior and never ask tactical questions", async () => {
  const { context, deps, events } = setup();
  context.resolverOptions = null;
  await executeAttackFromForm(context, deps);
  assert.deepEqual(events.map(e => e[0]), ["roll"]);
  assert.equal(events[0][3].structured, false);
});
