import test from 'node:test';
import assert from 'node:assert/strict';
import { workflow } from './workflow-fixture.mjs';
import { glidePlan, registerMagicMovement } from '../../module/witcher/magic-movement.js';
import { spellEffectPlan } from '../../module/witcher/magic-effects.js';
import { resolveDamage } from '../../module/witcher/rules.js';
import { magicEnvironmentRules } from '../../module/witcher/magic-effect-hooks.js';
import { runCommand } from '../../module/witcher/authority.js';
const glideEffect = () => ({
  id: 'glide',
  magic: { key: 'adenydd', operation: spellEffectPlan('adenydd', { castTotal: 20 }).operations[0] },
});

async function setup(t) {
  const w = await workflow(t);
  const before = globalThis.CONFIG;
  t.after(() => {
    if (before === undefined) delete globalThis.CONFIG;
    else globalThis.CONFIG = before;
  });
  globalThis.CONFIG = {
    Region: {
      documentClass: class {
        constructor(data, { parent }) {
          Object.assign(this, data, { parent });
        }
      },
    },
  };
  const scene = { id: 'scene', grid: { size: 100, distance: 2, units: 'm' }, tokens: [] };
  const token = {
    id: 'token',
    uuid: 'Scene.scene.Token.token',
    documentName: 'Token',
    parent: scene,
    actor: w.attacker,
    x: 100,
    y: 100,
    elevation: 20,
    level: 'ground',
    toObject() {
      return { x: this.x, y: this.y, elevation: this.elevation, level: 'ground' };
    },
    getMovementOrigin(s) {
      return { x: s.x + 50, y: s.y + 50, elevation: s.elevation };
    },
    object: { checkCollision: () => false },
    async update(changes) {
      Object.assign(this, changes);
    },
  };
  game.combat = null;
  canvas.scene = scene;
  w.docs.set(token.uuid, token);
  w.attacker.system.effects = [glideEffect()];
  registerMagicMovement();
  const payload = () => ({
    actorUuid: w.attacker.uuid,
    tokenUuid: token.uuid,
    descent: 4,
    placement: { x: 350, y: 150 },
    expectedOrigin: { x: token.x + 50, y: token.y + 50, elevation: token.elevation, level: 'ground' },
    expectedTurn: '',
  });
  return { ...w, token, payload };
}

test('actual glide command changes token position and elevation; failed persistence restores both', async (t) => {
  const w = await setup(t);
  await runCommand('magicGlide', w.payload());
  assert.deepEqual([w.token.x, w.token.y, w.token.elevation], [300, 100, 16]);
  w.faults.create = () => true;
  await assert.rejects(
    runCommand('magicGlide', { ...w.payload(), placement: { x: 550, y: 150 } }),
    /Injected/
  );
  assert.deepEqual([w.token.x, w.token.y, w.token.elevation], [300, 100, 16]);
});
test('glide rechecks active effect, printed distance, walls and stale origin', async (t) => {
  const w = await setup(t);
  assert.throws(() => glidePlan(w.token, 4, { x: 351, y: 150 }), /at most/);
  w.token.object.checkCollision = () => true;
  await assert.rejects(runCommand('magicGlide', w.payload()), /wall/);
  w.token.object.checkCollision = () => false;
  await assert.rejects(runCommand('magicGlide', { ...w.payload(), expectedOrigin: { x: 0 } }), /moved/);
  w.attacker.system.effects = [];
  await assert.rejects(runCommand('magicGlide', w.payload()), /No active spell/);
  assert.equal(w.token.elevation, 20);
});
test('active glide protects landing before armor and Quen, but not a ledge impact or an expired spell', () => {
  const state = {
    effects: [glideEffect(), { id: 'quen', shieldHP: 10, magic: { key: 'quen' } }],
    traits: {},
    conditions: [],
  };
  const location = { id: 'torso', group: 'torso', multiplier: 1, sp: 4 };
  const impact = {
    raw: 20,
    type: 'bludgeoning',
    properties: { environmental: true, damageSource: 'falling', activeAtLanding: true },
  };
  const result = resolveDamage(impact, state, location);
  assert.equal(result.damage, 0);
  assert.equal(result.shield, null);
  assert.equal(result.naturalChange.after, 4);
  assert(
    resolveDamage(
      { ...impact, properties: { ...impact.properties, activeAtLanding: false } },
      state,
      location
    ).damage > 0
  );
  state.effects.shift();
  assert(resolveDamage(impact, state, location).damage > 0);
});
test('breathable-air protections distinguish lack of air from physical choking', () => {
  const state = {
    effects: [{ magic: { operation: { type: 'modifier', rule: { key: 'breatheWaterAndAir' } } } }],
  };
  assert.equal(magicEnvironmentRules(state, { medium: 'water', cause: 'drowning' }).blockedSuffocation, true);
  assert.equal(
    magicEnvironmentRules(state, { medium: 'water', cause: 'unspecified' }).blockedSuffocation,
    false
  );
  assert.equal(magicEnvironmentRules(state, { medium: 'air', cause: 'airless' }).blockedSuffocation, false);
});
