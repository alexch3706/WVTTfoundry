/** Controlled document/authority fixtures; no running Foundry server is claimed. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SYSTEM_ID } from '../../module/witcher/config.js';
import { addMagicEffect } from '../../module/witcher/magic-state.js';
import {
  createTalfrynRoots,
  armTalfrynRoots,
  refreshMagicRestraints,
  escapeTalfrynRoots,
  damageTalfrynRoots,
  talfrynRestraintSupported,
} from '../../module/witcher/magic-restraints.js';
const clone = (value) => structuredClone(value);
const operation = {
  type: 'shield',
  name: 'Binding roots',
  purpose: 'restraint',
  hp: 15,
  onDestroy: 'endEffect',
  escape: { skill: 'dodge', dc: 20 },
};
function fixture(t) {
  const names = ['game', 'foundry', 'Actor', 'ChatMessage', 'Hooks', 'ui'],
    prior = new Map(names.map((name) => [name, globalThis[name]]));
  t.after(() => {
    for (const [name, value] of prior)
      value === undefined ? delete globalThis[name] : (globalThis[name] = value);
  });
  const docs = new Map(),
    actors = new Map(),
    tokens = new Map(),
    messages = new Map();
  let next = 0;
  const fault = { chat: false, actor: false };
  const set = (object, path, value) => {
    const parts = path.split('.'),
      last = parts.pop();
    for (const part of parts) object = object[part] ??= {};
    if (last.startsWith('-=')) delete object[last.slice(2)];
    else object[last] = clone(value);
  };
  const doc = (data, kind, parent, collection) => {
    const id = String(++next),
      uuid = parent ? `${parent.uuid}.${kind}.${id}` : `${kind}.${id}`,
      source = clone(data);
    const object = {
      id,
      uuid,
      documentName: kind,
      parent,
      _source: source,
      isOwner: true,
      name: data.name,
      type: data.type,
      items: [],
      testUserPermission: () => true,
      get system() {
        return this._source.system;
      },
      get flags() {
        return this._source.flags ?? {};
      },
      toObject() {
        return clone(this._source);
      },
      async update(changes) {
        for (const [path, value] of Object.entries(changes)) set(this._source, path, value);
        return this;
      },
      async delete() {
        docs.delete(uuid);
        collection?.delete(id);
      },
    };
    if (kind === 'Actor') {
      object._source.system = {
        conditions: [],
        effects: [],
        traits: {},
        magic: {},
        sta: { value: 30, max: 30 },
        hp: { value: 40, max: 40 },
        combat: { reactions: [], remaining: 0, applied: [] },
        ...data.system,
      };
      object.skillBase = (_skill, { modifier = 0 } = {}) => ({ total: (object.base ?? 10) + modifier });
      object.getTokenDocument = async (fields) => ({
        toObject: () => ({ actorId: id, actorLink: true, ...fields }),
      });
    }
    if (kind === 'Token')
      Object.assign(object, {
        actor: actors.get(data.actorId),
        actorId: data.actorId,
        x: data.x ?? 0,
        y: data.y ?? 0,
        width: data.width ?? 1,
        height: data.height ?? 1,
        elevation: data.elevation ?? 0,
        level: data.level ?? 'level',
      });
    docs.set(uuid, object);
    collection?.set(id, object);
    return object;
  };
  const gm = { id: 'gm', isGM: true, isActiveGM: true, active: true },
    player = { id: 'player', isGM: false };
  globalThis.game = {
    user: gm,
    users: { activeGM: gm },
    actors,
    scenes: [],
    time: { worldTime: 0 },
    combat: null,
    settings: { get: () => 'publicroll' },
  };
  globalThis.foundry = {
    utils: {
      deepClone: clone,
      getProperty: (object, path) => path.split('.').reduce((value, key) => value?.[key], object),
      randomID: () => `id${++next}`,
      fromUuid: async (uuid) => docs.get(uuid),
    },
  };
  globalThis.Actor = {
    create: async (data) => {
      if (fault.actor) throw new Error('Actor failure');
      return doc(data, 'Actor', null, actors);
    },
  };
  globalThis.ChatMessage = {
    getSpeaker: () => ({}),
    applyRollMode: () => {},
    create: async (data) => {
      if (fault.chat) throw new Error('Chat failure');
      return doc(data, 'ChatMessage', null, messages);
    },
  };
  globalThis.ui = { notifications: { error() {} } };
  globalThis.Hooks = { on() {} };
  const scene = {
    id: 'scene',
    uuid: 'Scene.scene',
    tokens,
    async createEmbeddedDocuments(kind, data) {
      assert.equal(kind, 'Token');
      return data.map((record) => doc(record, kind, scene, tokens));
    },
  };
  game.scenes = [scene];
  const caster = doc({ name: 'Mage', type: 'character', system: {} }, 'Actor', null, actors),
    target = doc({ name: 'Bound creature', type: 'character', system: {} }, 'Actor', null, actors);
  const casterToken = doc({ actorId: caster.id, x: 0 }, 'Token', scene, tokens),
    targetToken = doc({ actorId: target.id, x: 100 }, 'Token', scene, tokens);
  const context = {
    data: { magicKey: 'talfryns-prison', castId: 'cast-one', check: { total: 20 } },
    row: { tokenUuid: targetToken.uuid },
    caster,
    target,
    sourceToken: casterToken,
    message: { uuid: 'ChatMessage.cast' },
    effectId: 'bound-source',
  };
  const bind = () => {
    const next = addMagicEffect(target.system, {
      id: 'bound-source',
      key: 'Talfryn’s Prison',
      conditions: ['grappled'],
      magic: { key: 'talfryns-prison', castId: 'cast-one', casterUuid: caster.uuid, addedConditions: [] },
    });
    Object.assign(target.system, next);
  };
  return {
    docs,
    actors,
    tokens,
    messages,
    context,
    caster,
    target,
    gm,
    player,
    fault,
    bind,
    rootCount: () => [...actors.values()].filter((actor) => actor.flags[SYSTEM_ID]?.magicRestraint).length,
  };
}
test('restraint capability is exact and does not enable unrelated durability or escape mechanics', () => {
  assert.equal(talfrynRestraintSupported(operation), true);
  assert.equal(talfrynRestraintSupported({ ...operation, hp: 50 }), false);
  assert.equal(talfrynRestraintSupported({ ...operation, escape: { skill: 'athletics', dc: 20 } }), false);
});
test('creation produces actual 15HP zero-SP roots and a token but requires the grapple effect to commit before arming', async (t) => {
  const f = fixture(t),
    result = await createTalfrynRoots(operation, f.context),
    roots = f.docs.get(result.receipt.actorUuid);
  assert.equal(roots.system.hp.value, 15);
  assert.equal(roots.system.locations[0].sp, 0);
  assert.equal(f.docs.get(result.receipt.tokenUuid).actor, roots);
  assert.equal(f.target.system.effects.length, 0);
  await assert.rejects(() => armTalfrynRoots(result.receipt), /actual source-linked grapple/);
  assert.equal(roots.flags[SYSTEM_ID].magicRestraint.active, false);
  f.bind();
  await armTalfrynRoots(result.receipt);
  assert.equal(roots.flags[SYSTEM_ID].magicRestraint.active, true);
  await assert.rejects(() => createTalfrynRoots(operation, f.context), /already created/);
});
test('damage affects only root HP, rejects duplicate events and frees only this source at the15HP threshold', async (t) => {
  const f = fixture(t),
    result = await createTalfrynRoots(operation, f.context);
  f.bind();
  await armTalfrynRoots(result.receipt);
  const roots = f.docs.get(result.receipt.actorUuid);
  Object.assign(
    f.target.system,
    addMagicEffect(f.target.system, {
      id: 'other-root',
      conditions: ['grappled'],
      magic: { castId: 'another', addedConditions: [] },
    })
  );
  await damageTalfrynRoots(
    { rootsUuid: roots.uuid, amount: 14, evidence: 'Actual sword damage roll', damageEvent: 'hit1' },
    { user: f.gm, id: 'cmd1' }
  );
  await refreshMagicRestraints();
  assert.equal(roots.system.hp.value, 1);
  assert.equal(f.target.system.hp.value, 40);
  assert.equal(f.rootCount(), 1);
  await assert.rejects(
    () =>
      damageTalfrynRoots(
        { rootsUuid: roots.uuid, amount: 14, evidence: 'Repeated same hit', damageEvent: 'hit1' },
        { user: f.gm, id: 'cmd2' }
      ),
    /already applied/
  );
  await damageTalfrynRoots(
    { rootsUuid: roots.uuid, amount: 1, evidence: 'Second actual damage', damageEvent: 'hit2' },
    { user: f.gm, id: 'cmd3' }
  );
  await refreshMagicRestraints();
  assert.equal(f.rootCount(), 0);
  assert.deepEqual(
    f.target.system.effects.map((effect) => effect.id),
    ['other-root']
  );
  assert.ok(f.target.system.conditions.includes('grappled'));
  assert.equal(f.target.system.hp.value, 40);
});
test('actual damage workflow to the roots object also releases the source and cannot damage the captive', async (t) => {
  const f = fixture(t),
    result = await createTalfrynRoots(operation, f.context);
  f.bind();
  await armTalfrynRoots(result.receipt);
  const roots = f.docs.get(result.receipt.actorUuid);
  await roots.update({ 'system.hp.value': 0 });
  await refreshMagicRestraints();
  assert.equal(f.rootCount(), 0);
  assert.deepEqual(f.target.system.conditions, []);
  assert.equal(f.target.system.hp.value, 40);
});
test('Dodge/Escape uses the original casting total, ties fail and an actual exploding manual check can escape', async (t) => {
  const f = fixture(t),
    result = await createTalfrynRoots(operation, f.context);
  f.bind();
  await armTalfrynRoots(result.receipt);
  f.target.base = 13;
  await escapeTalfrynRoots({ rootsUuid: result.receipt.actorUuid, manualDice: '7' }, { user: f.player });
  assert.ok(f.target.system.conditions.includes('grappled'));
  f.target.base = 10;
  await escapeTalfrynRoots({ rootsUuid: result.receipt.actorUuid, manualDice: '10,1' }, { user: f.player });
  await refreshMagicRestraints();
  assert.deepEqual(f.target.system.conditions, []);
  assert.equal(f.rootCount(), 0);
});
test('a removed spell source deletes its roots while another unrelated grapple remains', async (t) => {
  const f = fixture(t),
    result = await createTalfrynRoots(operation, f.context);
  f.bind();
  await armTalfrynRoots(result.receipt);
  f.target.system.effects = [{ id: 'ordinary-grapple', conditions: ['grappled'] }];
  await refreshMagicRestraints();
  assert.equal(f.rootCount(), 0);
  assert.equal(f.target.system.effects[0].id, 'ordinary-grapple');
  assert.ok(f.target.system.conditions.includes('grappled'));
});
test('failed control receipt creation compensates both newly created roots documents', async (t) => {
  const f = fixture(t);
  f.fault.chat = true;
  await assert.rejects(() => createTalfrynRoots(operation, f.context), /Chat failure/);
  assert.equal(f.rootCount(), 0);
  assert.equal(f.tokens.size, 2);
  assert.equal(f.target.system.effects.length, 0);
});
test('the cast transaction can compensate an armed roots object after a failed final receipt', async (t) => {
  const f = fixture(t),
    result = await createTalfrynRoots(operation, f.context);
  f.bind();
  await armTalfrynRoots(result.receipt);
  // The owner restores its actor snapshot; the world adapter restores only its own documents.
  f.target.system.effects = [];
  f.target.system.conditions = [];
  await result.rollback();
  assert.equal(f.rootCount(), 0);
  assert.equal(f.tokens.size, 2);
  assert.equal(f.messages.size, 0);
});
test('failed damage chat receipt restores roots HP and permits retrying the uncommitted damage event', async (t) => {
  const f = fixture(t),
    result = await createTalfrynRoots(operation, f.context);
  f.bind();
  await armTalfrynRoots(result.receipt);
  f.fault.chat = true;
  await assert.rejects(
    () =>
      damageTalfrynRoots(
        { rootsUuid: result.receipt.actorUuid, amount: 15, evidence: 'Actual damage', damageEvent: 'hit' },
        { user: f.gm, id: 'cmd' }
      ),
    /Chat failure/
  );
  const roots = f.docs.get(result.receipt.actorUuid);
  assert.equal(roots.system.hp.value, 15);
  assert.deepEqual(roots.flags[SYSTEM_ID].magicRestraint.damageReceipts, []);
  assert.equal(roots.flags[SYSTEM_ID].magicRestraint.broken, undefined);
  assert.ok(f.target.system.conditions.includes('grappled'));
});
