import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAGIC_REGION_BEHAVIOR,
  MAGIC_REGION_FLAG,
  createMagicRegion,
  deleteMagicRegion,
  magicRegionData,
  magicRegionEventUpdate,
  magicRegionRoundUpdate,
  magicRegionState,
  magicRegionTargets,
  magicSceneScale,
  normalizeMagicArea,
  previewMagicRegion,
  registerMagicRegionBehavior,
  updateMagicRegion,
  validateMagicRegion,
} from '../../module/witcher/magic-regions.js';

// Controlled API fixtures, not a running Foundry installation. Real V14 API contracts
// were inspected in the genuine build 365 client; Forge remains an acceptance check.
function environment(t) {
  const saved = Object.fromEntries(
    ['CONFIG', 'canvas', 'game', 'foundry', 'ui'].map((key) => [key, globalThis[key]])
  );
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete globalThis[key];
      else globalThis[key] = value;
    }
  });
  const calls = { create: [], update: [], delete: [], restrictions: [], collisions: [] };
  const scene = {
    id: 'scene1',
    grid: { size: 100, distance: 2, units: 'm' },
    levels: new Map([
      ['ground', { id: 'ground', isView: true }],
      ['upper', { id: 'upper', isView: false }],
    ]),
    tokens: [],
    async createEmbeddedDocuments(type, sources) {
      calls.create.push({ type, sources: structuredClone(sources) });
      return sources.map((data) => new RegionFixture(data, { parent: this }));
    },
  };
  class RegionFixture {
    constructor(data, { parent }) {
      Object.assign(this, structuredClone(data));
      this.parent = parent;
      this.polygonTree = {
        testPoint: (point) => {
          const shape = this.shapes[0];
          return Math.hypot(point.x - shape.x, point.y - shape.y) <= shape.radius;
        },
      };
    }
    updateShapeConstraints(options) {
      calls.restrictions.push(options);
    }
    toObject() {
      const { parent, polygonTree, ...data } = this;
      return structuredClone(data);
    }
    async update(data) {
      calls.update.push(structuredClone(data));
      return this;
    }
    async delete() {
      calls.delete.push(this);
      return this;
    }
  }
  const token = (id, changes = {}) => {
    const document = {
      id,
      uuid: `Scene.scene1.Token.${id}`,
      name: id,
      parent: scene,
      actor: { uuid: `Actor.${id}` },
      hidden: false,
      _source: { x: 100, y: 100, elevation: 0, level: 'ground', width: 1, height: 1, depth: 0 },
      getMovementOrigin(state) {
        return {
          x: state.x + 50,
          y: state.y + 50,
          elevation: state.elevation + (state.depth * scene.grid.distance) / 2,
        };
      },
      getContainmentTestPoints(state) {
        return [{ x: state.x + 50, y: state.y + 50 }];
      },
      testInsideRegion(region) {
        // Inclusion deliberately injected; tests assert delegation to native coverage,
        // not a duplicate implementation of Foundry's polygon/wall algorithms.
        this.lastRegionTest = region;
        return this.nativeInside ?? true;
      },
      ...changes,
    };
    scene.tokens.push(document);
    return document;
  };
  const caster = token('caster');
  globalThis.CONFIG = {
    Region: { documentClass: RegionFixture },
    RegionBehavior: { dataModels: {} },
    Canvas: {
      polygonBackends: {
        move: {
          testCollision(...args) {
            calls.collisions.push(args);
            return false;
          },
        },
      },
    },
  };
  globalThis.game = { user: { id: 'gm', isGM: true } };
  globalThis.canvas = { ready: true, scene, regions: { placeRegion: async () => null } };
  return { scene, caster, token, calls, RegionFixture };
}

const circle = { shape: 'circle', radius: 3, origin: 'caster', volume: 'ground' };

test('scene metres are converted from actual grid dimensions, including the normal 2 m grid', () => {
  assert.deepEqual(magicSceneScale({ grid: { size: 100, distance: 2, units: 'm' } }), {
    pixelsPerMetre: 50,
    metresPerUnit: 1,
  });
  assert.equal(magicSceneScale({ grid: { size: 80, distance: 1, units: 'метров' } }).pixelsPerMetre, 80);
  assert.throws(() => magicSceneScale({ grid: { size: 100, distance: 5, units: 'ft' } }), /metres/);
  assert.equal(
    magicSceneScale({ grid: { size: 100, distance: 5, units: 'ft' } }, { metresPerUnit: 0.3048 })
      .pixelsPerMetre,
    100 / 1.524
  );
  assert.throws(() => magicSceneScale({ grid: { size: 100, distance: 0, units: 'm' } }), /distance/);
});

test('unprinted cone angles and line widths require explicit dimensions; malformed shapes fail', () => {
  assert.throws(() => normalizeMagicArea({ shape: 'cone', distance: 2, angle: null }), /table convention/);
  assert.throws(() => normalizeMagicArea({ shape: 'line', distance: 3 }), /width/);
  assert.throws(() => normalizeMagicArea({ shape: 'circle', radius: Infinity }), /radius/);
  assert.throws(() => normalizeMagicArea({ shape: 'cone', distance: 2, angle: 361 }), /angle/);
  assert.throws(
    () => normalizeMagicArea({ shape: 'cone', distance: 2, angle: 60, volume: 'sphere' }),
    /circle/
  );
  assert.equal(normalizeMagicArea({ shape: 'ray', distance: 3, width: 1 }).shape, 'line');
});

test('Yrden builds a fixed 3 m circle at caster ground elevation without changing the scene', (t) => {
  const { scene, caster, calls } = environment(t);
  const built = magicRegionData({ scene, casterToken: caster, spec: circle, name: 'Yrden' });
  assert.deepEqual(built.data.shapes, [
    { type: 'circle', x: 150, y: 150, radius: 150, hole: false, gridBased: false },
  ]);
  assert.deepEqual(built.data.elevation, { bottom: 0, top: 0, topInclusive: true });
  assert.deepEqual(built.data.levels, ['ground']);
  assert.deepEqual(built.data.attachment, { token: null });
  assert.equal(built.data.restriction.type, 'move');
  assert.equal(calls.create.length + calls.update.length, 0);
});

test('native cone and line shape fields preserve printed dimensions and explicit rotation', (t) => {
  const { scene, caster } = environment(t);
  const build = (spec) =>
    magicRegionData({ scene, casterToken: caster, spec, placement: { x: 150, y: 150, rotation: -90 } }).data
      .shapes[0];
  assert.deepEqual(build({ shape: 'cone', distance: 2, angle: 60, angleSource: 'table' }), {
    type: 'cone',
    x: 150,
    y: 150,
    radius: 100,
    angle: 60,
    rotation: 270,
    curvature: 'round',
    hole: false,
    gridBased: false,
  });
  assert.deepEqual(build({ shape: 'line', distance: 3, width: 1 }), {
    type: 'line',
    x: 150,
    y: 150,
    length: 150,
    width: 50,
    rotation: 270,
    hole: false,
    gridBased: false,
  });
});

test('anchored origins cannot be dragged away and ranged placement enforces metres', (t) => {
  const { scene, caster } = environment(t);
  assert.throws(
    () => magicRegionData({ scene, casterToken: caster, spec: circle, placement: { x: 200, y: 150 } }),
    /origin/
  );
  const ranged = { ...circle, origin: 'ranged', range: 4 };
  assert.doesNotThrow(() =>
    magicRegionData({ scene, casterToken: caster, spec: ranged, placement: { x: 350, y: 150 } })
  );
  assert.throws(
    () => magicRegionData({ scene, casterToken: caster, spec: ranged, placement: { x: 351, y: 150 } }),
    /4 m casting range/
  );
});

test('cancelling the native V14 preview returns null without persisting documents or targets', async (t) => {
  const { caster, calls } = environment(t);
  let options;
  globalThis.canvas.regions.placeRegion = async (_data, opts) => {
    options = opts;
    return null;
  };
  assert.equal(await previewMagicRegion({ casterToken: caster, spec: circle }), null);
  assert.equal(options.create, false);
  assert.equal(options.attachToToken, false);
  assert.equal(calls.create.length + calls.update.length, 0);
});

test('anchored cone preview rotates towards the cursor while keeping the caster origin', async (t) => {
  const { scene, caster, RegionFixture } = environment(t);
  globalThis.canvas.regions.placeRegion = async (data, options) => {
    const updates = [];
    const result = options.onMove({
      shape: { updateSource: (update) => updates.push(update) },
      position: { x: 150, y: 300 },
    });
    assert.equal(result, false);
    assert.deepEqual(updates, [{ x: 150, y: 150, rotation: 90 }]);
    data.shapes[0].rotation = 90;
    const document = new RegionFixture(data, { parent: scene });
    assert.equal(options.preConfirm({ document }), true);
    return document;
  };
  const result = await previewMagicRegion({
    casterToken: caster,
    spec: { shape: 'cone', distance: 2, angle: 60, angleSource: 'table' },
  });
  assert.deepEqual(result.placement, { x: 150, y: 150, rotation: 90 });
  assert.match(result.warnings.join(' '), /table convention/);
  assert.match(result.warnings.join(' '), /does not define height/);
});

test('authority rebuilds dimensions and targets and rejects caster movement after preview', (t) => {
  const { scene, caster, calls } = environment(t);
  const result = validateMagicRegion({
    scene,
    casterToken: caster,
    spec: circle,
    placement: { x: 150, y: 150, radius: 99999, angle: 360, targetIds: ['forged'] },
  });
  assert.equal(result.data.shapes[0].radius, 150);
  assert.deepEqual(result.targetIds, ['caster']);
  assert.deepEqual(calls.restrictions, [{ save: false }]);
  assert.throws(
    () =>
      validateMagicRegion({
        scene,
        casterToken: caster,
        spec: circle,
        expectedOrigin: { x: 150, y: 150, elevation: 2, level: 'ground' },
      }),
    /caster moved/
  );
});

test('wall-aware authority requires the viewed caster scene and level', (t) => {
  const { scene, caster } = environment(t);
  globalThis.canvas.scene = { id: 'elsewhere' };
  assert.throws(() => validateMagicRegion({ scene, casterToken: caster, spec: circle }), /GM must view/);
  assert.doesNotThrow(() =>
    validateMagicRegion({ scene, casterToken: caster, spec: { ...circle, wallRestriction: false } })
  );
  globalThis.canvas.scene = scene;
  scene.levels.get('ground').isView = false;
  assert.throws(() => validateMagicRegion({ scene, casterToken: caster, spec: circle }), /GM must view/);
});

test('large tokens, walls and scene levels delegate to native token containment', (t) => {
  const { scene, caster, token } = environment(t);
  const large = token('large', {
    nativeInside: true,
    _source: { x: 900, y: 900, elevation: 0, width: 3, height: 3, depth: 0, level: 'ground' },
  });
  const behindWall = token('blocked', { nativeInside: false });
  const otherLevel = token('upstairs', { nativeInside: false, _source: { level: 'upper' } });
  const result = validateMagicRegion({
    scene,
    casterToken: caster,
    spec: { ...circle, includeCaster: false },
  });
  assert.deepEqual(result.targetIds, ['large']);
  for (const document of [caster, large, behindWall, otherLevel])
    assert.equal(document.lastRegionTest, result.region);
  assert.equal(result.candidates.find((target) => target.tokenId === 'caster').reason, 'caster-excluded');
});

test('Aard Sweep sphere excludes flying targets outside its true 3D radius, including diagonal height', (t) => {
  const { scene, caster, token } = environment(t);
  token('inside', { _source: { x: 250, y: 100, elevation: 2, depth: 0, level: 'ground' } });
  token('diagonal-outside', { _source: { x: 250, y: 100, elevation: 3.6, depth: 0, level: 'ground' } });
  token('above', { _source: { x: 100, y: 100, elevation: 4.1, depth: 0, level: 'ground' } });
  token('tall-crossing', { _source: { x: 100, y: 100, elevation: -5, depth: 2, level: 'ground' } });
  const result = validateMagicRegion({
    scene,
    casterToken: caster,
    spec: { shape: 'circle', radius: 4, volume: 'sphere', includeCaster: false },
  });
  assert.deepEqual(result.targetIds, ['inside', 'tall-crossing']);
  assert.deepEqual(result.data.elevation, { bottom: -4, top: 4, topInclusive: true });
  assert.equal(result.candidates.find((target) => target.tokenId === 'above').reason, 'outside-sphere');
});

test('players do not learn hidden token names through a local preview', (t) => {
  const { scene, caster, token } = environment(t);
  token('secret', { hidden: true });
  const result = validateMagicRegion({
    scene,
    casterToken: caster,
    spec: circle,
    requester: { isGM: false },
    preview: true,
  });
  assert.deepEqual(
    result.candidates.map((target) => target.name),
    ['caster']
  );
  const authority = validateMagicRegion({ scene, casterToken: caster, spec: circle });
  assert.deepEqual(authority.targetIds, ['caster', 'secret']);
});

test('target overrides require an identified GM, a reason, and real scene tokens', (t) => {
  const { scene, caster, token } = environment(t);
  token('boundary', { nativeInside: false });
  const args = {
    scene,
    casterToken: caster,
    spec: circle,
    override: { include: ['boundary'], exclude: ['caster'], reason: 'Reviewed miniature coverage.' },
  };
  assert.throws(() => validateMagicRegion({ ...args, requester: { isGM: false } }), /Only the GM/);
  assert.throws(
    () => validateMagicRegion({ ...args, override: { include: ['boundary'], reason: '' } }),
    /Explain/
  );
  assert.throws(
    () => validateMagicRegion({ ...args, override: { include: ['absent'], reason: 'x' } }),
    /not a token/
  );
  assert.throws(
    () =>
      validateMagicRegion({
        ...args,
        override: { include: ['boundary'], exclude: ['boundary'], reason: 'x' },
      }),
    /both/
  );
  const result = validateMagicRegion(args);
  assert.deepEqual(result.targetIds, ['boundary']);
  assert.equal(result.override.userId, 'gm');
  assert.equal(result.candidates.find((target) => target.tokenId === 'boundary').reason, 'gm-override');
});

test('a ranged area cannot be placed behind a blocking wall', (t) => {
  const { scene, caster, calls } = environment(t);
  const args = {
    scene,
    casterToken: caster,
    spec: { ...circle, origin: 'ranged', range: 10 },
    placement: { x: 200, y: 150 },
  };
  validateMagicRegion(args);
  assert.equal(calls.collisions[0][2].mode, 'any');
  assert.equal(calls.collisions[0][2].level.id, 'ground');
  globalThis.CONFIG.Canvas.polygonBackends.move.testCollision = () => true;
  assert.throws(() => validateMagicRegion(args), /wall blocks/);
});

test('persistent areas carry stable spell links, a fixed location, duration, and native behavior', async (t) => {
  const { scene, caster, calls } = environment(t);
  const region = await createMagicRegion({
    scene,
    casterToken: caster,
    spec: circle,
    name: 'Yrden',
    rounds: 5,
    links: { castId: 'cast1', casterUuid: 'Actor.caster', spellUuid: 'Actor.caster.Item.yrden' },
  });
  assert.equal(calls.create[0].type, 'Region');
  assert.equal(region.behaviors[0].type, MAGIC_REGION_BEHAVIOR);
  assert.equal(magicRegionState(region).roundsRemaining, 5);
  assert.equal(magicRegionState(region).spellUuid, 'Actor.caster.Item.yrden');
  assert.deepEqual(magicRegionState(region).occupantIds, []);
  assert.deepEqual(region.attachment, { token: null });
  assert.equal(calls.update.length, 0);
});

test('persistent mutations require the authority GM and disallow geometry edits through state helpers', async (t) => {
  const { scene, caster, calls } = environment(t);
  const region = {
    flags: { [MAGIC_REGION_FLAG]: { magicArea: { roundsRemaining: 5 } } },
    update: async (data) => calls.update.push(data),
    delete: async () => calls.delete.push(true),
  };
  await updateMagicRegion(region, { roundsRemaining: 4, active: true });
  assert.equal(calls.update[0][`flags.${MAGIC_REGION_FLAG}.magicArea.roundsRemaining`], 4);
  await assert.rejects(() => updateMagicRegion(region, { spec: { radius: 999 } }), /Unknown/);
  await assert.rejects(() => updateMagicRegion(region, { roundsRemaining: -1 }), /non-negative/);
  globalThis.game.user.isGM = false;
  await assert.rejects(() => createMagicRegion({ scene, casterToken: caster, spec: circle }), /GM/);
  await assert.rejects(() => deleteMagicRegion(region), /GM/);
  globalThis.game.user.isGM = true;
  await deleteMagicRegion(region);
  assert.equal(calls.delete.length, 1);
});

function stateRegion(state = {}) {
  return {
    flags: {
      [MAGIC_REGION_FLAG]: { magicArea: { roundsRemaining: 5, occupantIds: [], turnEvents: {}, ...state } },
    },
  };
}

test('entry/exit state plans are idempotent and leave persistence to the successful effect transaction', () => {
  const region = stateRegion();
  const event = { name: 'tokenEnter', data: { token: { id: 'enemy' } } };
  const plan = magicRegionEventUpdate(region, event);
  assert.deepEqual(plan, { duplicate: false, changes: { occupantIds: ['enemy'] } });
  assert.deepEqual(magicRegionState(region).occupantIds, []);
  Object.assign(magicRegionState(region), plan.changes);
  assert.equal(magicRegionEventUpdate(region, event).duplicate, true);
  assert.deepEqual(magicRegionEventUpdate(region, { ...event, name: 'tokenExit' }).changes, {
    occupantIds: [],
  });
});

test('native turn and round event plans deduplicate repeats and rewinds without requiring turn on round events', () => {
  const region = stateRegion();
  const event = {
    name: 'tokenTurnStart',
    data: { token: { id: 'enemy' }, combat: { id: 'combat' }, round: 4, turn: 2 },
  };
  const plan = magicRegionEventUpdate(region, event);
  Object.assign(magicRegionState(region), plan.changes);
  assert.equal(magicRegionEventUpdate(region, event).duplicate, true);
  assert.equal(
    magicRegionEventUpdate(region, { ...event, data: { ...event.data, round: 3 } }).duplicate,
    true
  );
  assert.equal(
    magicRegionEventUpdate(region, { ...event, data: { ...event.data, round: 5 } }).duplicate,
    false
  );
  assert.equal(
    magicRegionEventUpdate(region, {
      name: 'tokenRoundStart',
      data: { token: { id: 'enemy' }, combat: { id: 'combat' }, round: 5 },
    }).duplicate,
    false
  );
});

test('duration advances once per new combat round, handles jumps, and never ticks on rewind', () => {
  const region = stateRegion();
  const first = magicRegionRoundUpdate(region, { combatId: 'combat', round: 3 });
  assert.equal(first.changes.roundsRemaining, 4);
  Object.assign(magicRegionState(region), first.changes);
  assert.equal(magicRegionRoundUpdate(region, { combatId: 'combat', round: 3 }).duplicate, true);
  assert.equal(magicRegionRoundUpdate(region, { combatId: 'combat', round: 2 }).duplicate, true);
  const jump = magicRegionRoundUpdate(region, { combatId: 'combat', round: 7 });
  assert.equal(jump.changes.roundsRemaining, 0);
  assert.equal(jump.expired, true);
});

test('V14 RegionBehavior events route only to the elected authority and never execute supplied scripts', async (t) => {
  environment(t);
  globalThis.foundry = { data: { regionBehaviors: { RegionBehaviorType: class {} } } };
  const events = [];
  let authority = false;
  const Model = registerMagicRegionBehavior(async (event) => events.push(event), {
    isAuthority: () => authority,
  });
  assert.equal(globalThis.CONFIG.RegionBehavior.dataModels[MAGIC_REGION_BEHAVIOR], Model);
  assert.deepEqual(Model.defineSchema(), {});
  const event = { name: 'tokenEnter', region: stateRegion() };
  await Model.events.tokenEnter(event);
  assert.equal(events.length, 0);
  authority = true;
  await Model.events.tokenEnter(event);
  assert.deepEqual(events, [event]);
  await Model.events.tokenExit({ ...event, region: {} });
  assert.equal(events.length, 1);
});

test('Tome cubes use native centered rectangles and their printed vertical extent', (t) => {
  const { scene, token } = environment(t);
  const caster = token('mage');
  const built = magicRegionData({
    scene,
    casterToken: caster,
    spec: {
      shape: 'rectangle',
      width: 6,
      height: 6,
      verticalHeight: 6,
      origin: 'ranged',
      range: 10,
      wallRestriction: false,
    },
    placement: { x: 350, y: 150, rotation: 45 },
  });
  assert.deepEqual(built.data.shapes[0], {
    type: 'rectangle',
    x: 350,
    y: 150,
    hole: false,
    gridBased: false,
    width: 300,
    height: 300,
    anchorX: 0.5,
    anchorY: 0.5,
    rotation: 45,
  });
  assert.deepEqual(built.data.elevation, { bottom: 0, top: 6, topInclusive: true });
});
