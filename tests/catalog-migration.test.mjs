import assert from "node:assert/strict";
import test from "node:test";
import {
  planCatalogItemUpdate, previewCatalogMigration, applyCatalogMigration, getCatalogReference
} from "../module/item/catalog-migration.js";

const scope = "cyberpunk2020-rilerena";
const reference = `Compendium.${scope}.pistols.Item.abcdefghijklmnop`;
const original = {
  _id: "worldweapon000001", name: "Pistol", type: "weapon", _stats: { compendiumSource: reference },
  system: { range: "50m", damage: "2d6", shots: "10", weight: 1, shotsLeft: 3, equipped: false }, flags: {}
};
const catalog = {
  _id: "abcdefghijklmnop", name: "Pistol", type: "weapon",
  system: { range: 50, damage: "2d6", shots: 10, shotsLeft: 10, weight: null, equipped: true,
    attackSkill: "Handgun", automation: { status: "ready", reasons: [] } },
  flags: { [scope]: { catalog: { version: 1, sourceName: "Pistol", sourceValues: { range: "50m", damage: "2d6", shots: "10", weight: 1 } } } }
};

function patch(source, update) {
  for(const [field, value] of Object.entries(update)) {
    const segments = field.split(".");
    let target = source;
    for(const key of segments.slice(0, -1)) target = target[key] ??= {};
    target[segments.at(-1)] = structuredClone(value);
  }
}

function document(source, uuid = "Actor.test.Item.worldweapon000001") {
  const state = structuredClone(source);
  return { type: state.type, name: state.name, uuid, toObject: () => structuredClone(state),
    async update(update) { patch(state, update); }, state };
}

function environment(items) {
  const user = { id: "gm", isGM: true, active: true, isActiveGM: true };
  return { user, users: { activeGM: user, contents: [user] }, items: { contents: items }, actors: [], scenes: [] };
}

test("catalog merge repairs definitions without reloading or equipping the weapon", () => {
  const plan = planCatalogItemUpdate(original, catalog);
  assert.equal(plan.update["system.range"], 50);
  assert.equal(plan.update["system.shots"], 10);
  assert.equal(plan.update["system.attackSkill"], "Handgun");
  assert.equal(plan.update["system.weight"], null);
  assert.ok(!Object.hasOwn(plan.update, "system.shotsLeft"));
  assert.ok(!Object.hasOwn(plan.update, "system.equipped"));
  const updated = structuredClone(original);
  patch(updated, plan.update);
  assert.deepEqual(planCatalogItemUpdate(updated, catalog).update, {}, "migration must be idempotent");
});

test("custom mechanical values survive and require review instead of being certified", () => {
  const source = structuredClone(original);
  source.system.damage = "4d6+1";
  source.system.range = 75;
  source.name = "My personalized pistol";
  const target = structuredClone(catalog);
  target.name = "Corrected Pistol";
  const plan = planCatalogItemUpdate(source, target);
  assert.equal(plan.update["system.damage"], undefined);
  assert.equal(plan.update["system.range"], undefined);
  assert.equal(plan.update.name, undefined);
  assert.equal(plan.update["system.automation"].status, "manual");
  assert.deepEqual(plan.conflicts.map(entry => entry.field).sort(), ["damage", "range"]);
  patch(source, plan.update);
  assert.deepEqual(planCatalogItemUpdate(source, target).update, {});
});

test("armor definition merge preserves ablation, installed location, SDP and humanity loss", () => {
  const source = { ...structuredClone(original), type: "cyberware", system: {
    coverage: { Torso: { stoppingPower: 12, ablation: 4 } }, location: "lArm", sdp: 8, humanityLoss: 6
  } };
  const target = { ...structuredClone(catalog), type: "cyberware", system: {
    coverage: { Torso: { stoppingPower: 18, ablation: 0, layer: "hard" } }, location: "", sdp: 30, humanityLoss: 0
  } };
  target.flags[scope].catalog.sourceValues = { coverage: { Torso: { stoppingPower: 12, ablation: 0 } } };
  const plan = planCatalogItemUpdate(source, target);
  assert.equal(plan.update["system.coverage.Torso.stoppingPower"], 18);
  assert.ok(Object.keys(plan.update).every(key => !/ablation|humanityLoss|\.sdp$|\.location$/.test(key)));
});

test("only explicit links to this system are eligible", () => {
  assert.equal(getCatalogReference({ _stats: { compendiumSource: "Compendium.other.weapons.Item.abcdefghijklmnop" } }), undefined);
  assert.equal(getCatalogReference({ flags: { core: { sourceId: reference.replace(".Item.", ".") } } }), reference.replace(".Item.", "."));
  const source = structuredClone(original);
  delete source._stats;
  assert.equal(planCatalogItemUpdate(source, catalog).status, "unlinked");
});

test("preview is read-only and apply rechecks persisted item values", async () => {
  const item = document(original);
  const game = environment([item]);
  const resolve = async () => document(catalog, reference);
  const before = item.toObject();
  const preview = await previewCatalogMigration({ game, resolve });
  assert.deepEqual(item.toObject(), before);
  assert.equal(preview.updates, 1);
  const result = await applyCatalogMigration(preview, { game, resolve });
  assert.equal(result.updated, 1);
  assert.equal(item.state.system.shotsLeft, 3);
  assert.equal(item.state.system.equipped, false);
  assert.equal((await previewCatalogMigration({ game, resolve })).updates, 0);
});

test("stale previews and rejected writes never pass as completed migrations", async () => {
  const item = document(original);
  const game = environment([item]);
  const resolve = async () => document(catalog, reference);
  const preview = await previewCatalogMigration({ game, resolve });
  item.state.system.shotsLeft = 2;
  await assert.rejects(applyCatalogMigration(preview, { game, resolve }), /changed after preview/);
  assert.equal(item.state.system.range, "50m");
  const fresh = await previewCatalogMigration({ game, resolve });
  item.update = async () => {};
  await assert.rejects(applyCatalogMigration(fresh, { game, resolve }), /not fully persisted/);
});

test("synthetic token items are included while linked token actors are not duplicated", async () => {
  const item = document(original);
  const synthetic = document(original, "Scene.s.Token.t.Actor.a.Item.worldweapon000001");
  const game = environment([]);
  game.actors = [{ items: [item] }];
  game.scenes = [{ tokens: [{ actorLink: true, actor: { items: [item] } }, { actorLink: false, actor: { items: [synthetic] } }] }];
  const preview = await previewCatalogMigration({ game, resolve: async () => document(catalog, reference) });
  assert.equal(preview.updates, 2);
});

test("apply requires the primary active GM and an unmodified reviewed patch", async () => {
  const item = document(original), game = environment([item]);
  const resolve = async () => document(catalog, reference);
  const preview = await previewCatalogMigration({ game, resolve });
  preview.entries[0].update["system.shotsLeft"] = 10;
  await assert.rejects(applyCatalogMigration(preview, { game, resolve }), /preview was modified/);
  game.user = { id: "player", isGM: false };
  await assert.rejects(applyCatalogMigration(preview, { game, resolve }), /primary active GM/);
});

test("aliased coverage keys cannot create fresh undamaged copies of an existing armor location", () => {
  for(const location of ["torso", "TORSO", "t-orso"]) {
    const source = { ...structuredClone(original), type: "armor", system: { coverage: { [location]: { stoppingPower: 20, ablation: 4 } } } };
    const target = { ...structuredClone(catalog), type: "armor", system: { coverage: { Torso: { stoppingPower: 20, ablation: 0, layer: "soft" } }, automation: { status: "ready", reasons: [] } } };
    const plan = planCatalogItemUpdate(source, target);
    assert.equal(plan.update["system.coverage.Torso.stoppingPower"], undefined);
    assert.equal(plan.update["system.coverage.Torso.layer"], undefined);
    assert.equal(plan.update["system.automation"].status, "manual");
  }
});

test("top-level cyberware armor damage cannot be lost by adding fresh per-zone coverage", () => {
  const source = { ...structuredClone(original), type: "cyberware", system: { stoppingPower: 20, ablation: 4 } };
  const target = { ...structuredClone(catalog), type: "cyberware", system: { coverage: { Torso: { stoppingPower: 20, ablation: 0, layer: "hard" } }, automation: { status: "ready", reasons: [] } } };
  const plan = planCatalogItemUpdate(source, target);
  assert.equal(plan.update["system.coverage.Torso.stoppingPower"], undefined);
  assert.equal(plan.update["system.automation"].status, "manual");
});

test("a GM manual override persists, while an unchanged older catalog manual status may be updated", () => {
  const source = structuredClone(original);
  source.system.automation = { status: "manual", reasons: ["GM house rule"] };
  let plan = planCatalogItemUpdate(source, catalog);
  assert.equal(plan.update["system.automation"], undefined);
  patch(source, plan.update);
  assert.deepEqual(planCatalogItemUpdate(source, catalog).update, {});
  const oldCatalog = structuredClone(original);
  oldCatalog.system.automation = { status: "manual", reasons: ["Old catalog missing range"] };
  oldCatalog.flags[scope] = { catalog: { version: 1, automationValues: structuredClone(oldCatalog.system.automation) } };
  plan = planCatalogItemUpdate(oldCatalog, catalog);
  assert.equal(plan.update["system.automation"].status, "ready");
});

test("manual overrides combined with mechanical conflicts remain idempotent after apply", async () => {
  const source = structuredClone(original);
  source.system.damage = "4d6";
  source.system.automation = { status: "manual", reasons: ["GM house rule"] };
  const item = document(source), game = environment([item]), resolve = async () => document(catalog, reference);
  const preview = await previewCatalogMigration({ game, resolve });
  assert.equal((await applyCatalogMigration(preview, { game, resolve })).updated, 1);
  assert.equal(item.state.system.damage, "4d6");
  assert.equal(item.state.system.automation.reasons.length, 2);
  assert.equal((await previewCatalogMigration({ game, resolve })).updates, 0);
});
