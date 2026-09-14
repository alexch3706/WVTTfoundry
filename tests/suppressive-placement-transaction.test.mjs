import assert from "node:assert/strict";
import test from "node:test";
import { placePersistentSuppressiveFireTemplate } from "../module/combat/template-placement.js";

const scope = "cyberpunk2020-rilerena";

function harness(t, hooks = {}) {
  const original = Object.fromEntries(["canvas", "game", "ui"].map(key => [key, globalThis[key]]));
  t.after(() => {
    for(const [key, value] of Object.entries(original)) {
      if(value === undefined) delete globalThis[key];
      else globalThis[key] = value;
    }
  });
  const state = { placements: [], creates: [], charges: [], activations: [], deletes: [], warnings: [], errors: [] };
  const weapon = {
    id: "weapon", uuid: "Actor.shooter.Item.weapon", system: { damage: "3d6", shotsLeft: 30, rof: 20 },
    async update(update) {
      state.charges.push(update);
      if(hooks.ammoUpdate) return hooks.ammoUpdate({ update, weapon, state });
      weapon.system.shotsLeft = update["system.shotsLeft"];
      return weapon;
    }
  };
  const scene = {
    id: "scene", regions: new Map(),
    async createEmbeddedDocuments(type, data) {
      assert.equal(type, "Region");
      state.creates.push(structuredClone(data[0]));
      assert.equal(data[0].flags[scope].suppressiveFire, undefined, "staging never creates an active, uncharged zone");
      assert.equal(data[0].flags[scope].suppressiveFirePending, true);
      const region = {
        id: "region", uuid: "Scene.scene.Region.region", flags: structuredClone(data[0].flags),
        async update(update) {
          state.activations.push(update);
          if(hooks.activation) return hooks.activation({ region, update, weapon, state });
          region.flags[scope].suppressiveFire = update[`flags.${scope}.suppressiveFire`];
          delete region.flags[scope].suppressiveFirePending;
          return region;
        },
        async delete() {
          state.deletes.push(region.id);
          if(hooks.deletion) return hooks.deletion({ region, scene, weapon, state });
          scene.regions.delete(region.id);
          return region;
        }
      };
      scene.regions.set(region.id, region);
      if(hooks.creation) await hooks.creation({ scene, region, weapon, state });
      return [region];
    }
  };
  globalThis.game = { system: { id: scope }, user: { id: "user" } };
  globalThis.canvas = {
    ready: true, scene, dimensions: { distancePixels: 10, distance: 1, size: 100 },
    regions: { placeRegion: async (data, options) => {
      state.placements.push({ data, options });
      assert.equal(options.create, false, "transaction starts with an unpersisted preview");
      if(hooks.preview) return hooks.preview({ data, options, weapon, scene, state });
      return { toObject: () => structuredClone(data) };
    } }
  };
  globalThis.ui = { notifications: {
    warn: message => state.warnings.push(message), error: message => state.errors.push(message)
  } };
  const run = () => placePersistentSuppressiveFireTemplate(
    { id: "shooter-token", center: { x: 100, y: 100 }, actor: { id: "shooter" } },
    weapon, 10, 2, 25, { consumeAmmo: true }
  );
  return { run, weapon, scene, state };
}

test("successful suppression charges once before activating its persistent Region", async t => {
  const { run, weapon, scene, state } = harness(t, {
    activation({ region, update, weapon }) {
      assert.equal(weapon.system.shotsLeft, 20, "ammo is charged before the Region becomes active");
      region.flags[scope].suppressiveFire = update[`flags.${scope}.suppressiveFire`];
      delete region.flags[scope].suppressiveFirePending;
      return region;
    }
  });
  assert.equal(await run(), true);
  assert.equal(weapon.system.shotsLeft, 20);
  assert.equal(scene.regions.get("region").flags[scope].suppressiveFire.bulletsFired, 10);
  assert.equal(state.charges.length, 1);
  assert.equal(state.deletes.length, 0);
});

test("canceling the transient preview creates no Region and spends no ammunition", async t => {
  const { run, weapon, state } = harness(t, { preview: () => null });
  assert.equal(await run(), false);
  assert.equal(weapon.system.shotsLeft, 30);
  assert.deepEqual(state.creates, []);
  assert.deepEqual(state.charges, []);
});

test("ammunition changed during the preview is never overwritten or used to create a zone", async t => {
  const { run, weapon, state } = harness(t, { preview: ({ weapon, data }) => {
    weapon.system.shotsLeft = 15;
    return { toObject: () => structuredClone(data) };
  } });
  assert.equal(await run(), false);
  assert.equal(weapon.system.shotsLeft, 15);
  assert.deepEqual(state.creates, []);
  assert.deepEqual(state.charges, []);
});

test("a Scene change during preview cancels without creating a zone on either Scene", async t => {
  const { run, state } = harness(t, { preview: ({ data }) => {
    globalThis.canvas.scene = { id: "other-scene" };
    return { toObject: () => structuredClone(data) };
  } });
  assert.equal(await run(), false);
  assert.deepEqual(state.creates, []);
  assert.deepEqual(state.charges, []);
});

test("ammunition changed during persistent creation removes the inert zone and preserves the live value", async t => {
  const { run, weapon, scene, state } = harness(t, { creation: ({ weapon }) => { weapon.system.shotsLeft = 15; } });
  assert.equal(await run(), false);
  assert.equal(weapon.system.shotsLeft, 15);
  assert.equal(scene.regions.size, 0);
  assert.equal(state.deletes.length, 1);
  assert.equal(state.charges.length, 0);
});

test("charge rejection before persistence rolls back the inert zone and allows a safe retry", async t => {
  let rejectCharge = true;
  const { run, scene, weapon, state } = harness(t, { ammoUpdate: ({ update, weapon }) => {
    if(rejectCharge) throw new Error("Rejected before write");
    weapon.system.shotsLeft = update["system.shotsLeft"];
  } });
  assert.equal(await run(), false);
  assert.equal(scene.regions.size, 0);
  assert.equal(weapon.system.shotsLeft, 30);
  assert.equal(state.activations.length, 0);
  rejectCharge = false;
  assert.equal(await run(), true);
  assert.equal(scene.regions.size, 1);
  assert.equal(weapon.system.shotsLeft, 20);
});

test("charge acknowledgement failure after persistence does not debit twice or leave an uncharged zone", async t => {
  const { run, scene, weapon, state } = harness(t, { ammoUpdate: ({ update, weapon }) => {
    weapon.system.shotsLeft = update["system.shotsLeft"];
    throw new Error("Rejected after write");
  } });
  assert.equal(await run(), true);
  assert.equal(weapon.system.shotsLeft, 20);
  assert.ok(scene.regions.get("region").flags[scope].suppressiveFire);
  assert.equal(state.charges.length, 1);
});

test("a no-op charge cannot activate a free suppressive zone", async t => {
  const { run, scene, state } = harness(t, { ammoUpdate: () => undefined });
  assert.equal(await run(), false);
  assert.equal(scene.regions.size, 0);
  assert.equal(state.activations.length, 0);
});

test("uncertain charge value is not overwritten: zone is removed and retry is blocked", async t => {
  const { run, scene, weapon, state } = harness(t, { ammoUpdate: ({ weapon }) => {
    weapon.system.shotsLeft = 17;
    throw new Error("Conflicting ammunition write");
  } });
  await assert.rejects(run, error => error.nonRetryable === true && /uncertain/.test(error.message));
  assert.equal(scene.regions.size, 0);
  assert.equal(weapon.system.shotsLeft, 17);
  assert.equal(state.charges.length, 1);
});

test("activation rejection before persistence removes the zone and refunds exactly the debit", async t => {
  const { run, scene, weapon, state } = harness(t, { activation: () => { throw new Error("Activation rejected"); } });
  assert.equal(await run(), false);
  assert.equal(scene.regions.size, 0);
  assert.equal(weapon.system.shotsLeft, 30);
  assert.deepEqual(state.charges, [{ "system.shotsLeft": 20 }, { "system.shotsLeft": 30 }]);
});

test("activation acknowledgement failure after persistence is recognized as success", async t => {
  const { run, scene, weapon, state } = harness(t, { activation: ({ region, update }) => {
    region.flags[scope].suppressiveFire = update[`flags.${scope}.suppressiveFire`];
    throw new Error("Activation acknowledgement lost");
  } });
  assert.equal(await run(), true);
  assert.ok(scene.regions.get("region").flags[scope].suppressiveFire);
  assert.equal(weapon.system.shotsLeft, 20);
  assert.equal(state.charges.length, 1);
});

test("failed zone deletion reports its exact UUID, leaves it inert and blocks retry", async t => {
  const { run, scene, weapon, state } = harness(t, {
    ammoUpdate: () => { throw new Error("Charge rejected"); },
    deletion: () => { throw new Error("Deletion rejected"); }
  });
  await assert.rejects(run, error => error.nonRetryable === true && /Scene\.scene\.Region\.region/.test(error.message));
  assert.equal(weapon.system.shotsLeft, 30);
  assert.equal(scene.regions.get("region").flags[scope].suppressiveFire, undefined);
  assert.ok(state.errors.length);
});

test("a deletion acknowledgement failure after actual deletion still counts as rolled back", async t => {
  const { run, scene } = harness(t, {
    ammoUpdate: () => { throw new Error("Charge rejected"); },
    deletion: ({ scene, region }) => { scene.regions.delete(region.id); throw new Error("Deletion acknowledgement lost"); }
  });
  assert.equal(await run(), false);
  assert.equal(scene.regions.size, 0);
});

test("failed activation never refunds over ammunition changed by another action", async t => {
  const { run, scene, weapon, state } = harness(t, { activation: ({ weapon }) => {
    weapon.system.shotsLeft = 15;
    throw new Error("Activation failed after concurrent shot");
  } });
  await assert.rejects(run, error => error.nonRetryable === true && /before the refund/.test(error.message));
  assert.equal(scene.regions.size, 0);
  assert.equal(weapon.system.shotsLeft, 15);
  assert.equal(state.charges.length, 1);
});

test("refund failure blocks retry without leaving any active or pending Region", async t => {
  const { run, scene, weapon } = harness(t, {
    activation: () => { throw new Error("Activation rejected"); },
    ammoUpdate: ({ update, weapon }) => {
      if(update["system.shotsLeft"] === 30) throw new Error("Refund rejected");
      weapon.system.shotsLeft = update["system.shotsLeft"];
    }
  });
  await assert.rejects(run, error => error.nonRetryable === true && /refund could not be confirmed/.test(error.message));
  assert.equal(scene.regions.size, 0);
  assert.equal(weapon.system.shotsLeft, 20);
});

test("creation acknowledgement failure blocks retry and never spends ammunition", async t => {
  const { run, scene, state } = harness(t, { creation: () => { throw new Error("Creation acknowledgement lost"); } });
  await assert.rejects(run, error => error.nonRetryable === true && /creation could not be confirmed/.test(error.message));
  assert.equal(state.charges.length, 0);
  assert.equal(scene.regions.get("region").flags[scope].suppressiveFire, undefined);
});

test("simultaneous placement with the same weapon is blocked before a second preview", async t => {
  let finishPreview;
  const { run, state } = harness(t, { preview: () => new Promise(resolve => { finishPreview = resolve; }) });
  const first = run();
  assert.equal(await run(), false);
  assert.equal(state.placements.length, 1);
  finishPreview(null);
  assert.equal(await first, false);
});
