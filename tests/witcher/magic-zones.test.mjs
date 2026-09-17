import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SYSTEM_ID } from '../../module/witcher/config.js';
import { MAGIC_REGION_FLAG, magicRegionState } from '../../module/witcher/magic-regions.js';
import {
  activeMagicZone,
  refreshMagicZones,
  registerMagicZones,
  tickMagicZones,
  trapCandidates,
  trapTarget,
} from '../../module/witcher/magic-zones.js';

function fixture(t) {
  const names = ['game', 'foundry', 'ChatMessage', 'Hooks', 'CONFIG', 'ui'];
  const saved = new Map(names.map((name) => [name, globalThis[name]]));
  t.after(() => {
    for (const [name, value] of saved)
      if (value === undefined) delete globalThis[name];
      else globalThis[name] = value;
  });
  const collection = () => {
    const entries = [];
    entries.get = (id) => entries.find((entry) => entry.id === id);
    entries.contents = entries;
    return entries;
  };
  const actors = collection(),
    scenes = collection(),
    messages = collection(),
    users = collection();
  const gm = { id: 'gm', isGM: true, active: true, isActiveGM: true };
  users.push(gm);
  users.activeGM = gm;
  const hooks = new Map(),
    once = new Map(),
    calls = { actorUpdates: [], regionUpdates: [], deleted: [], chats: [], errors: [] };
  const setPath = (object, path, value) => {
    const parts = path.split('.');
    const key = parts.pop();
    let target = object;
    for (const part of parts) target = target[part] ??= {};
    target[key] = structuredClone(value);
  };
  const getProperty = (object, path) => path.split('.').reduce((value, key) => value?.[key], object);
  globalThis.foundry = {
    utils: { deepClone: structuredClone, getProperty },
    data: { regionBehaviors: { RegionBehaviorType: class {} } },
  };
  globalThis.game = {
    actors,
    scenes,
    messages,
    users,
    user: gm,
    time: { worldTime: 0 },
    combat: null,
    settings: { get: () => 'publicroll' },
  };
  globalThis.CONFIG = { RegionBehavior: { dataModels: {} } };
  globalThis.ui = { notifications: { error: (message) => calls.errors.push(message) } };
  globalThis.Hooks = {
    on(name, handler) {
      if (!hooks.has(name)) hooks.set(name, []);
      hooks.get(name).push(handler);
    },
    once(name, handler) {
      once.set(name, handler);
    },
  };
  globalThis.ChatMessage = {
    getSpeaker: ({ actor }) => ({ actor: actor.id }),
    applyRollMode: () => {},
    async create(data) {
      const message = {
        ...structuredClone(data),
        id: `message${messages.length}`,
        uuid: `ChatMessage.message${messages.length}`,
        async delete() {
          const index = messages.indexOf(this);
          if (index >= 0) messages.splice(index, 1);
        },
      };
      messages.push(message);
      calls.chats.push(message);
      return message;
    },
  };
  const scene = (id = 'scene') => {
    const document = {
      id,
      tokens: collection(),
      regions: collection(),
      grid: { size: 100, distance: 2, units: 'm' },
      levels: new Map([['ground', { isView: true }]]),
    };
    scenes.push(document);
    return document;
  };
  const actor = (id, { synthetic = false, effects = [] } = {}) => {
    const source = { system: { effects: structuredClone(effects) } };
    const document = {
      id,
      uuid: synthetic ? `Scene.scene.Token.${id}.Actor.${id}` : `Actor.${id}`,
      name: id,
      system: source.system,
      _source: source,
      async update(changes) {
        if (this.failUpdate) {
          this.failUpdate = false;
          throw new Error('Simulated actor persistence failure');
        }
        calls.actorUpdates.push({ uuid: this.uuid, changes: structuredClone(changes) });
        for (const [key, value] of Object.entries(changes)) setPath(this._source, key, value);
        this.system = this._source.system;
        return this;
      },
    };
    if (!synthetic) actors.push(document);
    return document;
  };
  const token = (parent, id, actorDoc, { x = 0, y = 0, disposition = 1, inside = [] } = {}) => {
    const state = { x, y, elevation: 0, depth: 0, width: 1, height: 1, level: 'ground', disposition };
    const document = {
      id,
      uuid: `Scene.${parent.id}.Token.${id}`,
      name: id,
      parent,
      actor: actorDoc,
      disposition,
      _source: state,
      inside: new Set(inside),
      getSize: () => ({ width: 100, height: 100 }),
      getContainmentTestPoints: () => [{ x: state.x + 50, y: state.y + 50 }],
      testInsideRegion(region) {
        return this.inside.has(region.id);
      },
    };
    parent.tokens.push(document);
    return document;
  };
  const region = (parent, id, caster, state = {}) => {
    const document = {
      id,
      uuid: `Scene.${parent.id}.Region.${id}`,
      parent,
      restriction: { enabled: false },
      flags: {
        [MAGIC_REGION_FLAG]: {
          magicArea: {
            key: 'yrden',
            active: true,
            castId: `cast-${id}`,
            casterUuid: caster.actor.uuid,
            casterTokenId: caster.id,
            spec: {
              shape: 'circle',
              radius: 3,
              volume: 'ground',
              includeCaster: true,
              wallRestriction: false,
            },
            origin: { x: 50, y: 50, elevation: 0, level: 'ground' },
            placement: { x: 50, y: 50, rotation: 0 },
            expires: 15,
            penalty: 2,
            ...state,
          },
        },
      },
      async update(changes) {
        if (this.failUpdate) {
          this.failUpdate = false;
          throw new Error('Simulated Region persistence failure');
        }
        calls.regionUpdates.push(changes);
        for (const [key, value] of Object.entries(changes)) setPath(this, key, value);
        return this;
      },
      async delete() {
        calls.deleted.push(this.uuid);
        const index = parent.regions.indexOf(this);
        if (index >= 0) parent.regions.splice(index, 1);
      },
    };
    parent.regions.push(document);
    return document;
  };
  return { actors, scenes, messages, users, gm, hooks, once, calls, actor, scene, token, region };
}

function arrangement(t, trap = false) {
  const f = fixture(t),
    scene = f.scene(),
    caster = f.token(scene, 'caster', f.actor('caster'));
  const region = f.region(
    scene,
    'zone',
    caster,
    trap
      ? {
          key: 'magic-trap',
          prepared: true,
          preparedAt: 3,
          createdAt: 0,
          expires: 18,
          power: 5,
          spec: {
            shape: 'circle',
            radius: 3,
            volume: 'ground',
            includeCaster: false,
            wallRestriction: false,
          },
        }
      : {}
  );
  return { ...f, scene, caster, region };
}

test('Yrden enters once, exits by source, and preserves unrelated effects and manual Yrden entries', async (t) => {
  const f = arrangement(t),
    other = { id: 'other', key: 'Yrden', modifiers: { spd: -1 } };
  const target = f.token(f.scene, 'target', f.actor('target', { effects: [other] }), { inside: ['zone'] });
  await refreshMagicZones();
  assert.equal(target.actor.system.effects.length, 2);
  const effect = target.actor.system.effects[1];
  assert.equal(effect.key, 'Yrden');
  assert.equal(effect.magic.key, 'yrden-zone');
  assert.equal(effect.magic.regionUuid, f.region.uuid);
  assert.deepEqual(effect.modifiers, { ref: -2, spd: -2 });
  assert.equal(effect.sourceUuid, f.caster.actor.uuid);
  const updates = f.calls.actorUpdates.length;
  await refreshMagicZones();
  assert.equal(
    f.calls.actorUpdates.length,
    updates,
    'Repeated native movement/entry events do not write or duplicate effects.'
  );
  target.inside.clear();
  await refreshMagicZones();
  assert.deepEqual(target.actor.system.effects, [other]);
});

test('two linked tokens share one source effect until both leave the circle', async (t) => {
  const f = arrangement(t),
    actor = f.actor('linked');
  const first = f.token(f.scene, 'first', actor, { inside: ['zone'] });
  const second = f.token(f.scene, 'second', actor, { inside: ['zone'] });
  await refreshMagicZones();
  assert.equal(actor.system.effects.length, 1);
  assert.deepEqual(actor.system.effects[0].magic.tokenIds, ['first', 'second']);
  first.inside.clear();
  await refreshMagicZones();
  assert.deepEqual(actor.system.effects[0].magic.tokenIds, ['second']);
  second.inside.clear();
  await refreshMagicZones();
  assert.deepEqual(actor.system.effects, []);
});

test('unlinked synthetic actors get independent effects even when their actor IDs match', async (t) => {
  const f = arrangement(t);
  const firstActor = f.actor('first', { synthetic: true }),
    secondActor = f.actor('second', { synthetic: true });
  firstActor.id = secondActor.id = 'same-base-id';
  f.token(f.scene, 'first', firstActor, { inside: ['zone'] });
  f.token(f.scene, 'second', secondActor);
  await refreshMagicZones();
  assert.equal(firstActor.system.effects.length, 1);
  assert.equal(secondActor.system.effects.length, 0);
});

test('overlapping Yrden sources retain provenance while only the strongest penalty applies', async (t) => {
  const f = arrangement(t),
    stronger = f.region;
  const weaker = {
    ...stronger,
    id: 'weak',
    uuid: 'Scene.scene.Region.weak',
    flags: structuredClone(stronger.flags),
  };
  magicRegionState(weaker).penalty = 1;
  magicRegionState(weaker).castId = 'weak-cast';
  f.scene.regions.push(weaker);
  const target = f.token(f.scene, 'target', f.actor('target'), { inside: ['zone', 'weak'] });
  await refreshMagicZones();
  assert.equal(target.actor.system.effects.length, 2);
  assert.deepEqual(
    target.actor.system.effects.map((effect) => effect.modifiers),
    [{ ref: -2, spd: -2 }, {}]
  );
  assert.equal(target.actor.system.effects[1].magic.suppressedOverlap, true);
  target.inside.delete('zone');
  await refreshMagicZones();
  assert.deepEqual(target.actor.system.effects[0].modifiers, { ref: -1, spd: -1 });
  assert.equal(target.actor.system.effects[0].magic.suppressedOverlap, false);
});

test('refreshing one supplied scene still preserves valid zone sources in other scenes', async (t) => {
  const f = arrangement(t),
    otherScene = f.scenes[0];
  const second = { ...otherScene, id: 'second', tokens: [], regions: [] };
  f.scenes.push(second);
  const target = f.token(otherScene, 'target', f.actor('target'), { inside: ['zone'] });
  await refreshMagicZones();
  await refreshMagicZones({ scenes: [second] });
  assert.equal(target.actor.system.effects.length, 1);
});

test('deleting a zone removes its occupants and caster tracker without touching other magic', async (t) => {
  const f = arrangement(t),
    caster = f.caster.actor;
  caster.system.effects.push({
    id: 'tracker',
    key: 'Yrden',
    magic: { casterEffect: true, regionUuid: f.region.uuid },
  });
  caster.system.effects.push({
    id: 'quen',
    key: 'Quen',
    magic: { casterEffect: true, key: 'quen' },
    shieldHP: 10,
  });
  const target = f.token(f.scene, 'target', f.actor('target'), { inside: ['zone'] });
  await refreshMagicZones();
  await f.region.delete();
  await refreshMagicZones();
  assert.equal(target.actor.system.effects.length, 0);
  assert.deepEqual(
    caster.system.effects.map((effect) => effect.id),
    ['quen']
  );
});

test('a failed actor write rolls back previously reconciled actors without partial penalties', async (t) => {
  const f = arrangement(t),
    first = f.actor('first'),
    second = f.actor('second');
  f.token(f.scene, 'first', first, { inside: ['zone'] });
  f.token(f.scene, 'second', second, { inside: ['zone'] });
  second.failUpdate = true;
  await assert.rejects(() => refreshMagicZones(), /persistence failure/);
  assert.deepEqual(first.system.effects, []);
  assert.deepEqual(second.system.effects, []);
  await refreshMagicZones();
  assert.equal(first.system.effects.length, 1);
  assert.equal(second.system.effects.length, 1);
});

test('empty zones expire by world time and Supirre never grants an Awareness modifier', async (t) => {
  const f = arrangement(t);
  magicRegionState(f.region).key = 'supirre';
  f.caster.actor.system.effects.push({
    id: 'listen',
    key: 'Supirre',
    magic: { casterEffect: true, regionUuid: f.region.uuid },
    notes: 'Hear a distant point.',
  });
  await refreshMagicZones();
  assert.equal(f.caster.actor.system.effects[0].modifiers, undefined);
  assert.equal(f.scene.regions.length, 1);
  game.time.worldTime = 15;
  const result = await tickMagicZones();
  assert.deepEqual(result.expired, [f.region.uuid]);
  assert.equal(f.scene.regions.length, 0);
  assert.deepEqual(f.caster.actor.system.effects, []);
});

test('inactive and expired zones are never mechanically active', (t) => {
  const f = arrangement(t);
  assert.equal(activeMagicZone(f.region), true);
  magicRegionState(f.region).active = false;
  assert.equal(activeMagicZone(f.region), false);
  magicRegionState(f.region).active = true;
  assert.equal(activeMagicZone(f.region, 15), false);
});

test('a trap selects the nearest hostile by footprint and revalidates movement before attacking', (t) => {
  const f = arrangement(t, true);
  const near = f.token(f.scene, 'near', f.actor('near'), { x: 100, disposition: -1, inside: ['zone'] });
  const far = f.token(f.scene, 'far', f.actor('far'), { x: 180, disposition: -1, inside: ['zone'] });
  assert.equal(trapTarget(f.region), near);
  assert.throws(() => trapTarget(f.region, far), /closest enemy/);
  near.inside.clear();
  assert.equal(trapTarget(f.region), far);
  assert.throws(() => trapTarget(f.region, near), /outside.*ally/);
});

test('Puppet allies do not trigger a trap; a controlled enemy follows its controller’s allegiance', (t) => {
  const f = arrangement(t, true),
    puppet = f.actor('puppet', {
      effects: [{ magic: { controlled: true, casterUuid: f.caster.actor.uuid }, expires: 10 }],
    });
  f.token(f.scene, 'puppet', puppet, { x: 50, disposition: -1, inside: ['zone'] });
  const enemy = f.token(f.scene, 'enemy', f.actor('enemy'), { x: 150, disposition: -1, inside: ['zone'] });
  assert.equal(trapTarget(f.region), enemy);
  game.time.worldTime = 11;
  assert.equal(trapTarget(f.region).id, 'puppet', 'Expired mind control no longer changes allegiance.');
});

test('neutral/unknown dispositions require GM selection without allowing a more distant known enemy', (t) => {
  const f = arrangement(t, true),
    neutral = f.token(f.scene, 'neutral', f.actor('neutral'), { x: 50, disposition: 0, inside: ['zone'] });
  const enemy = f.token(f.scene, 'enemy', f.actor('enemy'), { x: 100, disposition: -1, inside: ['zone'] });
  assert.throws(() => trapTarget(f.region), /GM must choose/);
  assert.equal(trapTarget(f.region, neutral), neutral);
  assert.equal(
    trapTarget(f.region, enemy),
    enemy,
    'GM may identify the closer neutral token as a non-enemy.'
  );
  assert.throws(() => trapTarget(f.region, neutral, { user: { isGM: false } }), /GM must identify/);
  const farther = f.token(f.scene, 'farther', f.actor('farther'), {
    x: 180,
    disposition: -1,
    inside: ['zone'],
  });
  assert.throws(() => trapTarget(f.region, farther), /closest enemy/);
  assert.equal(trapCandidates(f.region)[0].token, neutral);
});

test('trap preparation requires a complete round and the active duration then lasts power rounds', async (t) => {
  const f = arrangement(t, true);
  Object.assign(magicRegionState(f.region), { prepared: false, power: 1, preparedAt: 3, expires: 6 });
  f.token(f.scene, 'enemy', f.actor('enemy'), { disposition: -1, inside: ['zone'] });
  game.time.worldTime = 2.99;
  await tickMagicZones();
  assert.equal(f.calls.chats.length, 0);
  assert.throws(() => trapTarget(f.region), /preparation/);
  game.time.worldTime = 3;
  const result = await tickMagicZones();
  assert.deepEqual(result.prepared, [f.region.uuid]);
  assert.equal(f.calls.chats.length, 1);
  assert.equal(f.scene.regions.length, 1);
  game.time.worldTime = 6;
  await tickMagicZones();
  assert.equal(f.scene.regions.length, 0);
});

test('a trap posts one GM-only prompt per caster round, including retries and repeated events', async (t) => {
  const f = arrangement(t, true);
  f.token(f.scene, 'enemy', f.actor('enemy'), { disposition: -1, inside: ['zone'] });
  const casterCombatant = { id: 'caster-combatant', tokenId: 'caster' };
  game.combat = {
    id: 'combat',
    started: true,
    scene: f.scene,
    combatants: [casterCombatant],
    combatant: casterCombatant,
    round: 2,
    turn: 1,
  };
  Object.assign(magicRegionState(f.region), { castCombat: { id: 'combat', round: 1, turn: 1 } });
  game.time.worldTime = 3;
  await tickMagicZones();
  await tickMagicZones();
  assert.equal(f.calls.chats.length, 1);
  const card = f.calls.chats[0];
  assert.deepEqual(card.whisper, ['gm']);
  assert.equal(card.flags[SYSTEM_ID].kind, 'magic-trap-ready');
  assert.equal(card.flags[SYSTEM_ID].cycle, 'combat:2');
  assert.equal(card.flags[SYSTEM_ID].attackUsed, false);
  assert.match(card.content, /data-magic-action="trap"/);
  assert.equal(magicRegionState(f.region).lastAttack.messageUuid, card.uuid);
  game.combat.round = 3;
  await tickMagicZones();
  assert.equal(f.calls.chats.length, 2);
});

test('trap prompts wait for its caster’s turn and never fire in the casting round', async (t) => {
  const f = arrangement(t, true);
  f.token(f.scene, 'enemy', f.actor('enemy'), { disposition: -1, inside: ['zone'] });
  const caster = { id: 'caster-combatant', tokenId: 'caster' },
    enemy = { id: 'enemy-combatant', tokenId: 'enemy' };
  game.combat = {
    id: 'combat',
    started: true,
    scene: f.scene,
    combatants: [caster, enemy],
    combatant: caster,
    round: 1,
    turn: 0,
  };
  magicRegionState(f.region).castCombat = { id: 'combat', round: 1, turn: 0 };
  game.time.worldTime = 3;
  await tickMagicZones();
  assert.equal(f.calls.chats.length, 0);
  game.combat.round = 2;
  game.combat.combatant = enemy;
  game.combat.turn = 1;
  await tickMagicZones();
  assert.equal(f.calls.chats.length, 0);
});

test('unknown trap targets produce a GM choice card without silently selecting neutral creatures', async (t) => {
  const f = arrangement(t, true);
  f.token(f.scene, 'neutral', f.actor('neutral'), { disposition: 0, inside: ['zone'] });
  game.time.worldTime = 3;
  await tickMagicZones();
  assert.equal(f.calls.chats[0].flags[SYSTEM_ID].needsGMTarget, true);
  assert.equal(f.calls.chats[0].flags[SYSTEM_ID].targetTokenUuid, '');
});

test('prompt receipt failure deletes its chat card so retry creates exactly one usable prompt', async (t) => {
  const f = arrangement(t, true);
  f.token(f.scene, 'enemy', f.actor('enemy'), { disposition: -1, inside: ['zone'] });
  game.time.worldTime = 3;
  f.region.failUpdate = true;
  await assert.rejects(() => tickMagicZones(), /Region persistence failure/);
  assert.equal(f.messages.length, 0);
  assert.equal(magicRegionState(f.region).lastAttack, undefined);
  await tickMagicZones();
  assert.equal(f.messages.length, 1);
});

test('only the elected GM may reconcile or tick zones', async (t) => {
  arrangement(t);
  game.user.isActiveGM = false;
  await assert.rejects(() => refreshMagicZones(), /elected GM/);
  await assert.rejects(() => tickMagicZones(), /elected GM/);
});

test('registration covers creation, movement, deletion, empty-zone expiration and native V14 events', (t) => {
  const f = arrangement(t);
  registerMagicZones();
  for (const key of [
    'updateToken',
    'createToken',
    'deleteToken',
    'deleteRegion',
    'updateRegion',
    'updateCombat',
    'updateWorldTime',
    'canvasReady',
  ])
    assert.ok(f.hooks.has(key), key);
  assert.ok(f.once.has('ready'));
  assert.ok(CONFIG.RegionBehavior.dataModels['witcher-rilerena.magicArea']);
});
