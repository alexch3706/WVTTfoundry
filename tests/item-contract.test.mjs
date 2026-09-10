import test from "node:test";
import assert from "node:assert/strict";
import { validateWeaponContract, validateArmorContract, damageFormulaBounds, canonicalSkillId, normalizeReliability } from "../module/item/item-contract.js";
import { buildActorCombatSnapshot, buildWeaponCombatSnapshot } from "../module/combat/combat-snapshot.js";
import { resolveCombatAction } from "../module/combat/combat-resolver.js";
import { resolveSingleShotRangedAttack, resolveSuppressiveFireDamageOutcome, resolveJamOutcome } from "../module/combat/attack-resolver.js";
import { resolveArmor } from "../module/combat/armor-resolver.js";
import { planCombatUpdates } from "../module/combat/state-planner.js";

const readyWeapon = (patch = {}) => ({
  weaponType: "Rifle", damage: "4d6", ap: false, shots: 30, shotsLeft: 10,
  rof: 20, range: 400, accuracy: 0, reliability: "Standard",
  attackType: "Auto", attackSkill: "Rifle", fireModes: ["SemiAuto", "FullAuto"],
  automation: { status: "ready", reasons: [] }, ...patch
});

const armor = (patch = {}) => ({
  equipped: true, armorRole: "wornArmor", encumbrance: 1,
  coverage: { Torso: { stoppingPower: 20, ablation: 0, layer: "soft" } },
  automation: { status: "ready", reasons: [] }, ...patch
});

function context(system = readyWeapon(), targetArmor = []) {
  return {
    action: { type: "ranged", fireMode: "SemiAuto", range: "RangeAuto", targetArea: "Torso" },
    attacker: {
      actorUuid: "Actor.attacker", name: "Solo",
      snapshot: buildActorCombatSnapshot({
        system: { stats: { ref: { total: 8 }, bt: { total: 6 } }, damage: 0 },
        itemTypes: { skill: [{ name: "Rifle", system: { level: 6 } }] }
      })
    },
    weapon: { itemUuid: "Actor.attacker.Item.weapon", name: "Test Rifle", snapshot: buildWeaponCombatSnapshot({ system }) },
    targets: [{
      actorUuid: "Actor.target", name: "Guard", distance: { value: 80, units: "m" },
      snapshot: buildActorCombatSnapshot({
        system: { stats: { bt: { total: 6 } }, damage: 0, hitLocations: { Torso: { label: "Torso" } } },
        itemTypes: { armor: targetArmor.map((system, index) => ({ id: `armor-${index}`, name: "Test Armor", type: "armor", system })) }
      }, { includeEquipment: true })
    }]
  };
}

async function assertBlocked(input, expectedCode, resolve = (ctx, roller) => resolveCombatAction(ctx, { structured: true }, roller)) {
  const before = structuredClone(input);
  let calls = 0;
  const outcome = await resolve(input, () => { calls++; throw new Error("An invalid action must not roll"); });
  assert.equal(calls, 0);
  assert.equal(outcome.manualResolution.required, true);
  assert.equal(outcome.chat.status, "manual");
  assert.equal(outcome.ammo.delta, 0);
  assert.ok(outcome.warnings.some(warning => warning.code === expectedCode), JSON.stringify(outcome.warnings));
  const updates = planCombatUpdates(outcome);
  assert.deepEqual(updates.itemUpdates, []);
  assert.deepEqual(updates.actorUpdates, []);
  assert.deepEqual(updates.embeddedItemUpdates, []);
  assert.deepEqual(input, before, "preflight must leave the snapshot untouched");
}

test("ready weapon contract validates machine-readable data; numeric strings remain available to custom items", () => {
  assert.equal(validateWeaponContract(readyWeapon()).valid, true);
  assert.equal(validateWeaponContract(readyWeapon({ range: "400" })).valid, false);
  assert.equal(validateWeaponContract(readyWeapon({ range: "400", shotsLeft: "10", fireModes: undefined, automation: { status: "custom", reasons: [] } })).valid, true);
  assert.equal(validateWeaponContract(readyWeapon({ fireModes: [], automation: { status: "custom", reasons: [] } })).valid, false);
  assert.equal(validateWeaponContract(readyWeapon({ shotsLeft: 31 })).valid, false);
  assert.equal(validateWeaponContract(readyWeapon({ attackType: "Grenade" })).valid, false);
});

test("damage expressions preserve arithmetic and reject source annotations, table fragments and division by zero", () => {
  assert.deepEqual(damageFormulaBounds("4d6+2"), { minimum: 6, maximum: 26 });
  assert.deepEqual(damageFormulaBounds("(2d6+1)/2"), { minimum: 1.5, maximum: 6.5 });
  for (const value of ["", null, "6d10 127", "4d6 1 1", "4d6 AP", "3d6x2", "0", "-2", "2d6/(1d6-3)", "1d0"]) assert.equal(damageFormulaBounds(value), undefined, String(value));
});

test("snapshot carries catalog status and allowed modes without sharing mutable arrays", () => {
  const source = readyWeapon();
  const snapshot = buildWeaponCombatSnapshot({ system: source });
  assert.equal(snapshot.shots, 30);
  assert.deepEqual(snapshot.fireModes, ["SemiAuto", "FullAuto"]);
  snapshot.fireModes.push("Suppressive");
  snapshot.automation.reasons.push("test");
  assert.deepEqual(source.fireModes, ["SemiAuto", "FullAuto"]);
  assert.deepEqual(source.automation.reasons, []);
});

for (const [field, value, code] of [
  ["attackSkill", "ref", "missing-attack-skill"],
  ["damage", "", "invalid-weapon-damage"],
  ["range", "400m", "invalid-weapon-range"],
  ["range", null, "invalid-weapon-range"],
  ["accuracy", NaN, "invalid-weapon-accuracy"],
  ["rof", "2/10", "invalid-weapon-rof"],
  ["shotsLeft", null, "invalid-weapon-ammo"],
  ["shotsLeft", 0.5, "invalid-weapon-ammo"],
  ["ap", "EAP", "unknown-armor-penetration"],
  ["reliability", "?", "unknown-weapon-reliability"]
]) {
  test(`invalid ${field} blocks rolls, ammunition, armor and wound updates`, async () => {
    await assertBlocked(context(readyWeapon({ [field]: value })), `item-data-${code}`);
  });
}

test("manual catalog item remains blocked in relaxed fidelity mode and through direct resolver entry", async () => {
  const input = context(readyWeapon({ automation: { status: "manual", reasons: ["Source row is ambiguous"] } }));
  input.action.options = { corebookFidelityMode: false };
  await assertBlocked(input, "item-data-manual-item-data");
  await assertBlocked(input, "item-data-manual-item-data", (ctx, roller) => resolveSingleShotRangedAttack(ctx, {}, roller));
});

test("empty weapons cannot damage a target even when the supplied roll would hit", async () => {
  await assertBlocked(context(readyWeapon({ shotsLeft: 0 })), "insufficient-ammo");
});

test("unsupported fire mode is blocked before any roll", async () => {
  const input = context(readyWeapon({ fireModes: ["SemiAuto"] }));
  input.action.fireMode = "FullAuto";
  await assertBlocked(input, "item-data-unsupported-fire-mode");
  await assertBlocked(context(readyWeapon({ fireModes: [], automation: { status: "custom", reasons: [] } })), "item-data-invalid-fire-modes");
});

test("automatic distance uses the flat snapshot range and canonical/localized skills resolve to the actual level", async () => {
  for (const skillName of ["Heavy Weapons", "Armas Pesadas", "Armi Pesanti", "HeavyWeapons"]) {
    const input = context(readyWeapon({ weaponType: "Heavy", attackSkill: "HeavyWeapons" }));
    input.attacker.snapshot.skills = { [skillName]: { level: 7 } };
    const requests = [];
    const outcome = await resolveCombatAction(input, { structured: true }, request => {
      requests.push(request);
      return { id: request.id, total: request.id === "attack" ? 16 : 12, die: { natural: 6 } };
    });
    assert.equal(requests[0].rollData.attackSkillBonus, 7, skillName);
    assert.equal(outcome.targets[0].attack.targetNumber, 15, "80m is close range for a 400m weapon, not extreme for an invented 50m range");
    assert.equal(outcome.targets[0].attack.hit, true);
  }
  assert.equal(canonicalSkillId("Fusíl"), "Rifle");
});

test("source reliability abbreviations preserve VR and UR jam mechanics", () => {
  assert.equal(normalizeReliability(" ST "), "Standard");
  assert.equal(resolveJamOutcome(true, "FullAuto", "VR").isJam, false);
  assert.equal(resolveJamOutcome(true, "FullAuto", "UR").jamSeverity, "unreliable");
  assert.equal(resolveJamOutcome(true, "FullAuto", "ST").jamSeverity, "standard");
});

test("point-blank 4d6 shotgun against one SP20 torso layer produces 24 raw, 4 penetrating, 2 wounds at BT6", async () => {
  const input = context(readyWeapon({ weaponType: "Shotgun", attackType: "Shotgun", range: 50, rof: 2,
    rangeDamages: { pointBlank: "4d6", close: "4d6", medium: "3d6", far: "2d6" }, fireModes: ["SemiAuto"] }), [armor()]);
  input.targets[0].distance.value = 1;
  const requests = [];
  const outcome = await resolveCombatAction(input, { structured: true }, request => {
    requests.push(request.id);
    return { id: request.id, total: 20, die: { natural: 8 } };
  });
  const hit = outcome.targets[0].hits[0];
  assert.deepEqual(requests, ["attack"], "point-blank damage is maximized, not rolled");
  assert.equal(hit.rawDamage, 24);
  assert.equal(hit.effectiveStoppingPower, 20);
  assert.equal(hit.penetratingDamage, 4);
  assert.equal(hit.finalDamage, 2);
  assert.equal(outcome.ammo.after, 9);
  assert.equal(planCombatUpdates(outcome).actorUpdates[0].update["system.damage"], 2);
});

test("missing shotgun range profile stops the whole shot before spending ammunition", async () => {
  await assertBlocked(context(readyWeapon({ attackType: "Shotgun", rangeDamages: {} })), "item-data-invalid-shotgun-damage");
  await assertBlocked(context(readyWeapon({ attackType: "Shotgun", rangeDamages: { close: "4d6", medium: "3d6", far: "2d6" } })), "item-data-invalid-shotgun-damage");
});

test("verified autoshotgun single-shell mode uses the shotgun resolver with fidelity enabled", async () => {
  const input = context(readyWeapon({ weaponType: "Shotgun", attackType: "Autoshotgun", range: 50,
    rangeDamages: { pointBlank: "4d6", close: "4d6", medium: "3d6", far: "2d6" } }), [armor()]);
  input.action.options = { corebookFidelityMode: true };
  input.targets[0].distance.value = 1;
  const outcome = await resolveCombatAction(input, { structured: true }, request => ({ id: request.id, total: 20, die: { natural: 8 } }));
  assert.equal(outcome.manualResolution.required, false);
  assert.equal(outcome.targets[0].hits[0].rawDamage, 24);
  assert.equal(outcome.ammo.after, 9);
});

test("malformed equipped protection never silently becomes zero SP", async () => {
  const malformed = armor({ coverage: { Torso: { stoppingPower: "SP20", ablation: 0, layer: "soft" } } });
  await assertBlocked(context(readyWeapon(), [malformed]), "item-data-invalid-armor-sp");
  const resolution = resolveArmor(false, { equippedArmor: [{ system: malformed }] }, "Torso");
  assert.equal(resolution.effectiveStoppingPower, null);
  assert.equal(resolution.manualResolution.required, true);
  assert.ok(resolution.warnings.length);
  const duplicate = armor({ coverage: { Torso: { stoppingPower: 20, ablation: 0, layer: "soft" }, torso: { stoppingPower: 20, ablation: 4, layer: "soft" } } });
  await assertBlocked(context(readyWeapon(), [duplicate]), "item-data-duplicate-armor-location");
});

test("manual protective cyberware in a pattern-only target also blocks autoshotgun attacks", async () => {
  const input = context(readyWeapon());
  const target = input.targets[0];
  target.snapshot.equippedCyberware = [{ id: "cyber-armor", name: "Partial body plating", system: { equipped: true, automation: { status: "manual", reasons: ["Select location"] } } }];
  input.targets = [];
  input.action.autoshotgunPatterns = [{ affectedTargets: [target] }];
  await assertBlocked(input, "item-data-manual-item-data");
});

test("ordinary zero-SP clothing and protected objects never add passive body protection or block attacks", async () => {
  const zero = armor({ coverage: { Torso: { stoppingPower: 0, ablation: 0, layer: "" } }, encumbrance: 0 });
  assert.equal(validateArmorContract(zero).valid, true);
  for (const role of ["protectedObject", "shield", "clothing"]) {
    const item = armor({ armorRole: role, automation: { status: "manual", reasons: ["Object protection"] } });
    assert.equal(validateArmorContract(item).valid, true);
    assert.equal(resolveArmor(false, { equippedArmor: [{ system: item }] }, "Torso").effectiveStoppingPower, 0);
  }
});

test("edged-half-SP applies before armor layering without turning melee damage into ballistic AP", async () => {
  const protection = armor({ edgedHalfSP: true, coverage: { Torso: { stoppingPower: 20, ablation: 2, layer: "soft" } } });
  const snapshot = { equippedArmor: [{ system: protection }] };
  assert.equal(resolveArmor(false, snapshot, "Torso").effectiveStoppingPower, 18);
  assert.equal(resolveArmor(false, snapshot, "Torso", { meleeDamageType: "blunt" }).effectiveStoppingPower, 18);
  const edged = resolveArmor(false, snapshot, "Torso", { meleeDamageType: "edged" });
  assert.equal(edged.effectiveStoppingPower, 9);
  assert.equal(edged.armorPiercing, false);
  assert.equal(edged.layers[0].baseStoppingPower, 20);
  assert.equal(edged.layers[0].ablation, 2);
  const layered = { equippedArmor: [...snapshot.equippedArmor, { system: armor({ coverage: { Torso: { stoppingPower: 12, ablation: 0, layer: "hard" } } }) }] };
  assert.equal(resolveArmor(false, layered, "Torso", { meleeDamageType: "edged" }).effectiveStoppingPower, 17, "combine adjusted SP9 with SP12 (difference 3, proportional bonus 5)");
  const input = context(readyWeapon({ attackType: "Melee", weaponType: "Melee", attackSkill: "Melee" }), [protection]);
  input.action = { type: "melee", targetArea: "Torso" };
  await assertBlocked(input, "item-data-missing-melee-damage-type");
  input.weapon.snapshot.meleeDamageType = "edged";
  const result = await resolveCombatAction(input, { structured: true }, request => ({ id: request.id, total: request.id === "defend" ? 10 : 20, die: { natural: 6 } }));
  assert.equal(result.targets[0].hits[0].effectiveStoppingPower, 9);
  assert.equal(result.targets[0].hits[0].penetratingDamage, 11, "edged weapons do not halve damage after penetration");
  assert.equal(result.targets[0].hits[0].finalDamage, 9);
});

test("suppression damage validates only damage-relevant weapon data but still blocks unresolved target armor", async () => {
  const input = context(readyWeapon(), [armor({ automation: { status: "manual", reasons: ["Unknown SP"] } })]);
  input.weapon.snapshot = { damage: "4d6", ap: false, attackType: "Auto" };
  input.hitCount = 1;
  await assertBlocked(input, "item-data-manual-item-data", (ctx, roller) => resolveSuppressiveFireDamageOutcome(ctx, {}, roller));
});
