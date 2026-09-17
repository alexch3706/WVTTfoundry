/** Real execution adapters and registered collision command with controlled document persistence.
 * These tests do not claim to run a Foundry canvas or emulate native wall/Region geometry. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { workflow, clone } from './workflow-fixture.mjs';
import { SYSTEM_ID } from '../../module/witcher/config.js';
import { runCommand } from '../../module/witcher/authority.js';
import { magicInfo } from '../../module/witcher/magic-catalog.js';
import { spellEffectPlan } from '../../module/witcher/magic-effects.js';
import { magicTargetingProfile } from '../../module/witcher/magic-targeting.js';
import { magicChoiceFields, readMagicChoices } from '../../module/witcher/magic-choices.js';
let {
  fogVisionPlan,
  modifierZoneSupported,
  createModifierZone,
  refreshModifierZones,
  windMoveSupported,
  windPushPlan,
  executeWindMove,
  registerWindFog,
} = {};

const planFor = (key, values = {}) => spellEffectPlan(key, { castTotal: 20, ...values });

function patch(object, changes) {
  for (const [path, value] of Object.entries(changes)) {
    const parts = path.split('.'),
      last = parts.pop();
    let destination = object;
    for (const part of parts) destination = destination[part] ??= {};
    if (last.startsWith('-=')) delete destination[last.slice(2)];
    else destination[last] = clone(value);
  }
}

async function environment(t) {
  const f = await workflow(t),
    beforeConfig = globalThis.CONFIG;
  ({
    fogVisionPlan,
    modifierZoneSupported,
    createModifierZone,
    refreshModifierZones,
    windMoveSupported,
    windPushPlan,
    executeWindMove,
    registerWindFog,
  } = await import('../../module/witcher/magic-wind-fog.js'));
  t.after(() => (globalThis.CONFIG = beforeConfig));
  let nextId = 0;
  const hooks = new Map();
  globalThis.Hooks = { on: (name, handler) => hooks.set(name, handler) };
  const scene = {
    id: 'wind-scene',
    uuid: 'Scene.wind-scene',
    grid: { size: 100, distance: 2, units: 'm' },
    tokens: new f.Collection(),
    regions: new f.Collection(),
    levels: new Map([['ground', { isView: true }]]),
    dimensions: { sceneRect: { x: -2000, y: -2000, width: 4000, height: 4000 } },
    testSurfaceCollision: () => false,
  };
  class Region {
    constructor(data, { parent }) {
      this._source = clone(data);
      this.parent = parent;
      this.id = `region-${++nextId}`;
      this.uuid = `${parent.uuid}.Region.${this.id}`;
    }
    get flags() {
      return this._source.flags ?? {};
    }
    get name() {
      return this._source.name;
    }
    get restriction() {
      return this._source.restriction;
    }
    get attachment() {
      return this._source.attachment;
    }
    toObject() {
      return clone(this._source);
    }
    updateShapeConstraints() {}
    async update(changes) {
      patch(this._source, changes);
      return this;
    }
    async delete() {
      this.parent.regions.delete(this.id);
      f.docs.delete(this.uuid);
    }
  }
  scene.createEmbeddedDocuments = async (type, sources) => {
    assert.equal(type, 'Region');
    return sources.map((source) => {
      const region = new Region(source, { parent: scene });
      scene.regions.set(region.id, region);
      f.docs.set(region.uuid, region);
      return region;
    });
  };
  const collisionCalls = [];
  let wallX = Infinity;
  globalThis.CONFIG = {
    Region: { documentClass: Region },
    Canvas: {
      detectionModes: {
        basicSight: { type: 0 },
        lightPerception: { type: 0 },
        darkvision: { type: 0 },
        tremor: { type: 2 },
      },
      polygonBackends: {
        move: {
          testCollision(from, to, options) {
            collisionCalls.push({ from, to, options });
            return to.x >= wallX && from.x < wallX;
          },
        },
        sight: { testCollision: () => false },
      },
    },
  };
  globalThis.canvas = { ready: true, scene };
  game.scenes = new f.Collection([[scene.id, scene]]);
  game.actors = new f.Collection([
    [f.attacker.id, f.attacker],
    [f.target.id, f.target],
  ]);
  function token(id, actor, x, extra = {}) {
    const state = {
      x,
      y: 0,
      width: 1,
      height: 1,
      elevation: 0,
      depth: 0,
      level: 'ground',
      flags: {},
      sight: { enabled: true, range: null },
      detectionModes: {},
      ...clone(extra),
    };
    const document = {
      id,
      uuid: `${scene.uuid}.Token.${id}`,
      name: actor.name,
      actor,
      parent: scene,
      _source: state,
      get flags() {
        return state.flags;
      },
      get x() {
        return state.x;
      },
      get y() {
        return state.y;
      },
      get elevation() {
        return state.elevation;
      },
      get level() {
        return state.level;
      },
      getSize: () => ({ width: 100, height: 100 }),
      getMovementOrigin: () => ({ x: state.x + 50, y: state.y + 50, elevation: state.elevation }),
      testInsideRegion(region) {
        const shape = region._source.shapes[0],
          center = this.getMovementOrigin();
        return Math.hypot(center.x - shape.x, center.y - shape.y) <= shape.radius;
      },
      toObject: () => clone(state),
      async update(changes) {
        if (document.failUpdate) {
          document.failUpdate = false;
          throw new Error('Token write failed');
        }
        for (const key of ['x', 'y'])
          if (key in changes)
            assert(Number.isInteger(changes[key]), 'Native V14 Token positions are whole pixels');
        patch(state, changes);
        return this;
      },
    };
    scene.tokens.set(id, document);
    f.docs.set(document.uuid, document);
    return document;
  }
  const casterToken = token('caster', f.attacker, 0),
    targetToken = token('target', f.target, 100);
  registerWindFog();
  return { ...f, scene, casterToken, targetToken, token, collisionCalls, hooks, setWall: (x) => (wallX = x) };
}

function castContext(f, key, extra = {}) {
  const data = {
    name: magicInfo(key).name,
    magicKey: key,
    magic: magicInfo(key),
    castId: 'wind-cast',
    itemId: 'spell',
    itemUuid: `${f.attacker.uuid}.Item.spell`,
    tokenUuid: f.casterToken.uuid,
    ...extra,
  };
  return {
    data,
    caster: f.attacker,
    target: f.target,
    sourceToken: f.casterToken,
    affectedToken: f.targetToken,
    operationIndex: 1,
    message: { uuid: 'ChatMessage.cast' },
  };
}

test('source plans accept immediate operations and require the explicit Zephyr caster ruling', async (t) => {
  const f = await environment(t);
  assert.equal(planFor('zephyr').ready, false);
  const plan = planFor('zephyr', { choices: { zephyrAffectsCaster: false } });
  assert.equal(plan.ready, true);
  assert.equal(plan.operations[0].formula, '1d6');
  assert.equal(plan.operations[1].distance, 6);
  assert(windMoveSupported(plan.operations[1]));
  assert.equal(windMoveSupported({ ...plan.operations[1], timing: 'endTurn' }), false);
  assert.deepEqual(magicTargetingProfile('zephyr', { choices: { zephyrAffectsCaster: false } }).exclusions, [
    'caster',
  ]);
  assert.deepEqual(
    magicTargetingProfile('zephyr', { choices: { zephyrAffectsCaster: true } }).exclusions,
    []
  );
  assert.match(magicChoiceFields('zephyr', f.attacker), /Table ruling: Zephyr also affects caster/);
  assert.deepEqual(readMagicChoices('zephyr', { choice_zephyrAffectsCaster: false }), {
    zephyrAffectsCaster: false,
  });
  const fog = planFor('dormyns-fog', { choices: { followCaster: false } });
  assert(modifierZoneSupported(fog.operations[0]));
  assert.equal(fog.operations[0].shape.radius, 10);
  assert.equal(fog.operations[0].operations[0].visionRange, 4);
});

test('fog caps native illuminated and sight detection, preserves nonvisual senses, and restores sources', async (t) => {
  await environment(t);
  const source = {
    sight: { enabled: true, range: null },
    detectionModes: { darkvision: { enabled: true, range: 30 }, tremor: { enabled: true, range: 20 } },
    flags: {},
  };
  patch(source, fogVisionPlan(source, ['Region.one', 'Region.two'], 4, ['darkvision']));
  assert.equal(source.sight.range, 4);
  assert.equal(source.detectionModes.lightPerception.range, 4);
  assert.equal(source.detectionModes.darkvision.range, 4);
  assert.equal(source.detectionModes.tremor.range, 20);
  patch(source, fogVisionPlan(source, ['Region.two'], 4, ['darkvision']));
  assert.equal(source.sight.range, 4);
  patch(source, fogVisionPlan(source, [], 4, ['darkvision']));
  assert.equal(source.sight.range, null);
  assert.equal(source.detectionModes.lightPerception, undefined);
  assert.equal(source.detectionModes.darkvision.range, 30);
  assert.equal(source.flags[SYSTEM_ID]?.fogVision, undefined);
});

test('fog neither grants darkvision nor overwrites another range change on exit', async (t) => {
  await environment(t);
  const source = { sight: { range: 0 }, detectionModes: {}, flags: {} };
  patch(source, fogVisionPlan(source, ['Region.one'], 4));
  assert.equal(source.sight.range, 0);
  assert.equal(source.detectionModes.lightPerception.range, 4);
  source.sight.range = 12;
  patch(source, fogVisionPlan(source, ['Region.one'], 4));
  assert.equal(source.sight.range, 4);
  source.detectionModes.lightPerception.range = 2;
  patch(source, fogVisionPlan(source, [], 4));
  assert.equal(source.sight.range, 12);
  assert.equal(source.detectionModes.lightPerception.range, 2);
});

test('actual modifier Region affects caster and ally, overlaps once, restores on exit and deletion', async (t) => {
  const f = await environment(t),
    context = castContext(f, 'dormyns-fog');
  const operation = planFor('dormyns-fog', { choices: { followCaster: false } }).operations[0];
  const first = await createModifierZone(operation, context);
  assert.equal(f.target.system.effects.length, 0, 'reconcile after actor commit');
  await first.afterCommit();
  assert.equal(f.targetToken._source.sight.range, 4);
  assert.equal(f.casterToken._source.sight.range, 4);
  assert.equal(f.target.system.effects.at(-1).modifiers.awareness, -3);
  assert.equal(f.attacker.system.effects.at(-1).modifiers.awareness, -3);
  const second = await createModifierZone(operation, {
    ...context,
    data: { ...context.data, castId: 'second-cast' },
  });
  await second.afterCommit();
  assert.equal(
    f.target.system.effects.reduce((total, effect) => total + (effect.modifiers.awareness ?? 0), 0),
    -3
  );
  await f.targetToken.update({ x: 800 });
  await refreshModifierZones();
  assert.equal(f.targetToken._source.sight.range, null);
  assert.equal(f.target.system.effects.length, 0);
  for (const region of [...f.scene.regions]) await region.delete();
  await refreshModifierZones();
  assert.equal(f.casterToken._source.sight.range, null);
  assert.equal(f.attacker.system.effects.length, 0);
});

test('following fog uses V14 Region attachment and cast rollback restores all persisted changes', async (t) => {
  const f = await environment(t),
    before = f.targetToken.toObject();
  const operation = planFor('dormyns-fog', { choices: { followCaster: true } }).operations[0];
  const result = await createModifierZone(operation, castContext(f, 'dormyns-fog'));
  assert.equal([...f.scene.regions][0].attachment.token, f.casterToken.id);
  await result.afterCommit();
  await result.rollback();
  assert.equal(f.scene.regions.size, 0);
  assert.equal(f.target.system.effects.length, 0);
  assert.equal(f.targetToken._source.sight.range, before.sight.range);
  assert.deepEqual(f.targetToken._source.detectionModes, before.detectionModes);
});

test('failed fog reconciliation restores previous tokens and cast can remove its Region', async (t) => {
  const f = await environment(t);
  const operation = planFor('dormyns-fog', { choices: { followCaster: false } }).operations[0];
  const result = await createModifierZone(operation, castContext(f, 'dormyns-fog'));
  f.targetToken.failUpdate = true;
  await assert.rejects(result.afterCommit(), /Token write failed/);
  assert.equal(f.casterToken._source.sight.range, null);
  assert.equal(f.attacker.system.effects.length, 0);
  await result.rollback();
  assert.equal(f.scene.regions.size, 0);
});

test('Zephyr moves exactly6m, native sweep stops at wall, and receipts prevent duplicate movement', async (t) => {
  const f = await environment(t),
    operation = planFor('zephyr', { choices: { zephyrAffectsCaster: false } }).operations[1];
  const context = castContext(f, 'zephyr');
  const result = await executeWindMove(operation, context);
  assert.equal(f.targetToken.x, 400);
  assert.equal(result.receipt.distance, 6);
  await executeWindMove(operation, context);
  assert.equal(f.targetToken.x, 400);
  await result.rollback();
  assert.equal(f.targetToken.x, 100);
  f.setWall(300);
  const wall = windPushPlan(f.casterToken, f.targetToken, 6);
  assert.equal(wall.collision.kind, 'wall');
  assert(Math.abs(wall.distance - 2) < 0.01);
  assert(wall.changes.x < 201);
  assert(f.collisionCalls.every((call) => call.options.type === 'move' && call.options.level.isView));
  assert.equal(windPushPlan(f.casterToken, f.casterToken, 6).self, true);
});

test('push sweeps solid tokens and compensates token/message writes on failure', async (t) => {
  const f = await environment(t),
    operation = planFor('zephyr', { choices: { zephyrAffectsCaster: false } }).operations[1];
  const obstacle = f.token('obstacle', f.makeActor('Obstacle'), 310);
  const plan = windPushPlan(f.casterToken, f.targetToken, 6);
  assert.equal(plan.collision.tokenUuid, obstacle.uuid);
  assert(Math.abs(plan.distance - 2.2) < 0.01);
  f.targetToken.failUpdate = true;
  await assert.rejects(executeWindMove(operation, castContext(f, 'zephyr')), /Token write failed/);
  assert.equal(f.targetToken.x, 100);
  assert.equal(f.messages.size, 0);
  assert.deepEqual(f.targetToken.flags[SYSTEM_ID].windMovement, {});
});

test('registered GM collision command requires a ruling, builds real damage card, and refuses reuse', async (t) => {
  const f = await environment(t),
    operation = planFor('zephyr', { choices: { zephyrAffectsCaster: false } }).operations[1];
  f.setWall(310);
  const movement = await executeWindMove(operation, castContext(f, 'zephyr'));
  const message = await foundry.utils.fromUuid(movement.receipt.collisionMessageUuid);
  assert.equal(movement.status, 'pendingGM');
  await assert.rejects(
    runCommand('magicWindCollision', {
      messageUuid: message.uuid,
      values: { baseFormula: '0', weight: 'light' },
    }),
    /Record base damage/
  );
  f.enqueue(['0', 0], ['1d6', 4], ['4', 4]);
  const card = await runCommand('magicWindCollision', {
    messageUuid: message.uuid,
    values: {
      baseFormula: '0',
      weight: 'light',
      location: 'torso',
      ruling: 'No intrinsic humanoid ramming damage.',
    },
  });
  assert.equal(card.flags[SYSTEM_ID].kind, 'damage');
  assert.equal(card.flags[SYSTEM_ID].targetUuid, f.target.uuid);
  assert.equal(card.flags[SYSTEM_ID].applied, false);
  assert.equal(message.flags[SYSTEM_ID].resolved, true);
  await assert.rejects(
    runCommand('magicWindCollision', { messageUuid: message.uuid, values: {} }),
    /already resolved/
  );
  assert.equal(f.rolls.length, 0);
});

test('failed collision receipt rolls back generated damage cards and keeps original pending card', async (t) => {
  const f = await environment(t),
    operation = planFor('zephyr', { choices: { zephyrAffectsCaster: false } }).operations[1];
  f.setWall(310);
  const movement = await executeWindMove(operation, castContext(f, 'zephyr'));
  const message = await foundry.utils.fromUuid(movement.receipt.collisionMessageUuid);
  f.faults.update = (doc) => doc === message;
  f.enqueue(['0', 0], ['1d6', 4], ['1d10', 4], ['4', 4]);
  await assert.rejects(
    runCommand('magicWindCollision', {
      messageUuid: message.uuid,
      values: { baseFormula: '0', weight: 'light', location: '', ruling: 'Random location; no base damage.' },
    }),
    /Injected message update failure/
  );
  assert.equal(f.messages.size, 1);
  assert.equal(message.flags[SYSTEM_ID].resolved, false);
  assert.equal(f.rolls.length, 0, 'random location really requested its hit-location die');
});
