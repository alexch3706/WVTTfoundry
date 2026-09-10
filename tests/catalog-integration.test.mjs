import assert from "node:assert/strict";
import test from "node:test";
import { isDeepStrictEqual } from "node:util";
import { readCatalogSources, auditCatalogSources, normalizeCatalogSources } from "../tools/catalog.mjs";
import { buildWeaponCombatSnapshot } from "../module/combat/combat-snapshot.js";
import { resolveCombatAction } from "../module/combat/combat-resolver.js";
import { resolveArmor } from "../module/combat/armor-resolver.js";
import { damageFormulaBounds } from "../module/item/item-contract.js";
import { planCombatUpdates } from "../module/combat/state-planner.js";

const sources = await readCatalogSources();
const all = [...sources].flatMap(([pack, documents]) => documents.map(document => ({ pack, document })));

function combatContext(document) {
  return {
    action: { type: document.system.weaponType === "Melee" ? "melee" : "ranged", fireMode: "SemiAuto", range: "RangePointBlank", targetArea: "Torso" },
    weapon: { name: document.name, itemUuid: `Actor.attacker.Item.${document._id}`, snapshot: buildWeaponCombatSnapshot(document) },
    attacker: { actorUuid: "Actor.attacker", name: "Attacker", snapshot: {
      stats: { ref: { total: 8 }, bt: { total: 6 } }, damage: 0,
      skills: { [document.system.attackSkill]: { level: 6 } }
    } },
    targets: [{ name: "Target", actorUuid: "Actor.target", distance: { value: 1, units: "m" }, snapshot: {
      stats: { ref: { total: 5 }, bt: { total: 6 } }, damage: 0,
      skills: { Melee: { level: 2 }, Brawling: { level: 2 } },
      hitLocations: { Torso: { label: "Torso" } }, equippedArmor: [], equippedCyberware: []
    } }]
  };
}

function roller(request) {
  const bounds = damageFormulaBounds(request.formula);
  return { id: request.id, total: request.id === "attack" ? 30 : request.id === "defend" ? 8 : bounds?.maximum || 6, die: { natural: 8 } };
}

test("canonical catalog identity and semantic audit cover all shipped documents", async () => {
  const audit = await auditCatalogSources(sources);
  assert.equal(audit.documents, 2124);
  assert.equal(audit.byType.weapon.ready + audit.byType.weapon.manual, 607);
  assert.equal(audit.byType.armor.ready + audit.byType.armor.manual, 199);
  assert.deepEqual(audit.fatal, []);
  assert.ok(audit.byType.weapon.ready >= 220);
  assert.ok(audit.byType.armor.ready >= 120);
});

test("normalizing canonical sources again makes no changes", async () => {
  const result = await normalizeCatalogSources();
  assert.equal(result.changed, 0, "Edit ID-keyed overrides, then normalize before committing source files");
});

test("every ready weapon can resolve a real source-to-snapshot point-blank attack", async () => {
  let count = 0;
  for(const { pack, document } of all) {
    if(document.type !== "weapon" || document.system.automation?.status !== "ready") continue;
    const context = combatContext(document);
    const before = structuredClone(context);
    const outcome = await resolveCombatAction(context, { structured: true }, roller);
    assert.notEqual(outcome.manualResolution?.required, true, `${pack}/${document._id} (${document.name}): ${JSON.stringify(outcome.warnings)}`);
    assert.equal(outcome.targets[0].attack.hit, true, document.name);
    assert.ok(outcome.targets[0].hits.length, document.name);
    for(const hit of outcome.targets[0].hits) {
      assert.ok(Number.isFinite(hit.rawDamage), document.name);
      assert.ok(Number.isFinite(hit.finalDamage), document.name);
    }
    assert.ok(isDeepStrictEqual(context, before), `${document.name}: resolver changed input`);
    count++;
  }
  assert.ok(count >= 220);
});

test("every manual catalog weapon blocks all state changes before rolling", async () => {
  for(const { document } of all) {
    if(document.type !== "weapon" || document.system.automation?.status !== "manual") continue;
    const outcome = await resolveCombatAction(combatContext(document), { structured: true }, () => { throw new Error(`${document.name} must not roll`); });
    assert.equal(outcome.manualResolution?.required, true, document.name);
    const updates = planCombatUpdates(outcome);
    assert.deepEqual(updates.itemUpdates, [], document.name);
    assert.deepEqual(updates.actorUpdates, [], document.name);
    assert.deepEqual(updates.embeddedItemUpdates, [], document.name);
  }
});

test("every ready armor location uses its actual source SP and object roles never protect a body", () => {
  for(const { document } of all) {
    if(!["armor", "cyberware"].includes(document.type) || document.system.automation?.status !== "ready") continue;
    const system = { ...structuredClone(document.system), equipped: true };
    const property = document.type === "armor" ? "equippedArmor" : "equippedCyberware";
    for(const [location, segment] of Object.entries(system.coverage || {})) {
      const result = resolveArmor(false, { [property]: [{ id: document._id, name: document.name, system }] }, location);
      assert.notEqual(result.manualResolution?.required, true, document.name);
      const expected = ["protectedObject", "shield", "clothing"].includes(system.armorRole) ? 0 : Math.max(0, segment.stoppingPower - segment.ablation);
      assert.equal(result.effectiveStoppingPower, expected, `${document.name}: ${location}`);
    }
  }
});

test("real compendium shotgun against SP20 produces the reviewed point-blank result", async () => {
  const document = sources.get("shotguns").find(item => item._id === "yGI0MaMJgWsevJx1");
  const context = combatContext(document);
  context.targets[0].snapshot.equippedArmor = [{ id: "armor", name: "SP20", system: {
    equipped: true, encumbrance: 0, armorRole: "wornArmor", automation: { status: "ready", reasons: [] },
    coverage: { Torso: { stoppingPower: 20, ablation: 0, layer: "soft" } }
  } }];
  const outcome = await resolveCombatAction(context, { structured: true }, roller);
  const hit = outcome.targets[0].hits[0];
  assert.equal(hit.rawDamage, 24);
  assert.equal(hit.effectiveStoppingPower, 20);
  assert.equal(hit.penetratingDamage, 4);
  assert.equal(hit.finalDamage, 2);
  assert.equal(outcome.ammo.after, document.system.shotsLeft - 1);
});
