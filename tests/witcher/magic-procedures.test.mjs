import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SYSTEM_ID } from '../../module/witcher/config.js';
import { magicInfo, magicItemData } from '../../module/witcher/magic-catalog.js';
import { runCommand } from '../../module/witcher/authority.js';
import {
  activeRitualPreparation,
  hexCheckRules,
  hexEffectData,
  hexIdentificationDC,
  hexLiftingRequirements,
  registerMagicProcedures,
  ritualComponentPlan,
  ritualDifficulty,
  ritualInterruption,
  ritualPreparationSeconds,
  ritualRequirements,
} from '../../module/witcher/magic-procedures.js';

test('ritual preparation and fixed/variable printed DCs use the book rather than caller-invented values', () => {
  assert.equal(ritualPreparationSeconds(magicInfo('ritual-of-life')), 15);
  assert.equal(ritualDifficulty(magicInfo('ritual-of-life'), {}, 4), 11);
  assert.equal(ritualDifficulty(magicInfo('cleansing-ritual'), { mode: 'alcohol' }), 12);
  assert.equal(ritualDifficulty(magicInfo('cleansing-ritual'), { mode: 'poison' }), 15);
  assert.equal(ritualDifficulty(magicInfo('cleansing-ritual'), { mode: 'illness' }), 18);
  assert.equal(ritualDifficulty(magicInfo('hydromancy'), { mode: 'past' }), 15);
  assert.equal(ritualDifficulty(magicInfo('hydromancy'), { mode: 'present' }), 18);
  assert.equal(ritualDifficulty(magicInfo('ritual-of-naming'), { greaterDemon: true }), 24);
  assert.equal(ritualDifficulty(magicInfo('ritual-of-binding'), { greaterDemon: true }), 27);
  assert.equal(ritualDifficulty(magicInfo('telecommunication')), null);
  assert.throws(() => ritualDifficulty(magicInfo('ritual-of-life'), {}, 5), /four helpers/);
  assert.throws(() => ritualDifficulty(magicInfo('cleansing-ritual')), /printed ritual mode/);
});

test('Tyromancy secretly varies DC by cheese quality and requires a genuine d6 result', () => {
  const magic = magicInfo('tyromancy');
  assert.equal(ritualDifficulty(magic, { quality: 'ordinary', dcRoll: 6 }), 19);
  assert.equal(ritualDifficulty(magic, { quality: 'high', dcRoll: 6 }), 7);
  assert.throws(() => ritualDifficulty(magic, { quality: 'ordinary' }), /secret GM d6/);
});

test('interruption checks distinguish distraction, physical damage, and return within one round', () => {
  assert.deepEqual(ritualInterruption('distracted'), { dc: 15, canContinue: true });
  assert.deepEqual(ritualInterruption('harmed'), { dc: 18, canContinue: true });
  assert.equal(ritualInterruption('removed', { removedAt: 4, time: 7, returned: true }).canContinue, true);
  assert.equal(
    ritualInterruption('removed', { removedAt: 4, time: 7.01, returned: true }).canContinue,
    false
  );
  assert.equal(ritualInterruption('removed', { removedAt: 4, time: 6, returned: false }).canContinue, false);
});

test('component requirements distinguish counted consumables, reusable tools, and actual prerequisites', () => {
  assert.deepEqual(
    ritualRequirements(magicInfo('telecommunication')).map((item) => [item.name, item.kind]),
    [['A Telecommunicator', 'retain']]
  );
  const power = ritualRequirements(magicInfo('create-place-of-power'));
  assert.equal(power[0].quantity, 40);
  assert.equal(power[0].kind, 'consume');
  assert.equal(power[1].kind, 'retain');
  const synthesis = ritualRequirements(magicInfo('cadfans-synthesis'));
  assert.equal(synthesis[0].quantity, 10);
  assert.equal(synthesis[0].kind, 'consume');
  assert.equal(ritualRequirements(magicInfo('hydromancy'))[0].kind, 'prerequisite');
});

test('inventory consumption is exact, aggregates repeated requirements, and retains reusable tools', () => {
  const items = [
    { id: 'chalk', name: 'Chalk', type: 'component', system: { quantity: 5, carried: true } },
    { id: 'tool', name: 'Telecommunicator', type: 'gear', system: { quantity: 1, carried: true } },
  ];
  const requirements = [
    { id: 'a', name: 'Chalk', quantity: 2, kind: 'consume' },
    { id: 'b', name: 'Chalk', quantity: 1, kind: 'consume' },
    { id: 'c', name: 'A Telecommunicator', quantity: 1, kind: 'retain' },
  ];
  const allocations = { a: { itemId: 'chalk' }, b: { itemId: 'chalk' }, c: { itemId: 'tool' } };
  const result = ritualComponentPlan(items, requirements, allocations);
  assert.deepEqual(result.updates, [{ _id: 'chalk', 'system.quantity': 2 }]);
  assert.deepEqual(result.retained, ['tool']);
  assert.equal(items[0].system.quantity, 5);
  items[0].system.quantity = 2;
  assert.throws(() => ritualComponentPlan(items, requirements, allocations), /Not enough/);
});

test('material substitutions require a recorded GM ruling and prerequisites must actually be identified', () => {
  const items = [{ id: 'x', name: 'Meteorite', type: 'component', system: { quantity: 5 } }];
  const req = [{ id: 'a', name: 'Silver or Meteorite', quantity: 5, kind: 'consume' }];
  assert.throws(() => ritualComponentPlan(items, req, { a: { itemId: 'x' } }), /GM must record/);
  assert.deepEqual(
    ritualComponentPlan(
      items,
      req,
      { a: { itemId: 'x', ruling: 'Printed meteorite alternative.' } },
      { isGM: true }
    ).updates,
    [{ _id: 'x', 'system.quantity': 0 }]
  );
  const water = [{ id: 'a', name: 'Bowl of water', quantity: 1, kind: 'prerequisite' }];
  assert.throws(() => ritualComponentPlan([], water, {}), /actual prerequisite/);
  assert.equal(
    ritualComponentPlan([], water, { a: { confirmed: true, note: 'Full bowl on the table.' } }).updates
      .length,
    0
  );
});

test('hex contextual penalties, altered fumbles, learning restrictions and identification DCs are explicit', () => {
  const keys = [
    'the-eternal-itch',
    'the-devils-luck',
    'the-evil-eye',
    'hex-of-forgetfulness',
    'the-hex-of-the-beast',
    'the-odious-hex',
  ];
  const state = {
    effects: keys.map((key) =>
      hexEffectData(magicInfo(key), {
        id: key,
        castId: key,
        casterUuid: 'Actor.a',
        checkTotal: 20,
        createdAt: 0,
      })
    ),
  };
  assert.equal(state.effects[0].modifiers.allActions, -1);
  assert.equal(hexCheckRules(state, { skill: 'seduction', intimacy: true }).modifier, -5);
  assert.equal(hexCheckRules(state, { skill: 'seduction' }).modifier, 0);
  assert.equal(hexCheckRules(state, { skill: 'wildernessSurvival', animalHandling: true }).modifier, -3);
  assert.deepEqual(hexCheckRules(state).fumbleFaces, [1]);
  assert.deepEqual(hexCheckRules(state, { stressed: true }).fumbleFaces, [1, 2]);
  assert.deepEqual(hexCheckRules(state, { dc: 16 }).fumbleFaces, [1, 2]);
  assert.equal(hexCheckRules(state).fumbleTwice, true);
  assert.equal(hexCheckRules(state).mayLearnMagic, false);
  assert.equal(hexCheckRules(state).socialStandingSteps, -1);
  assert.equal(hexIdentificationDC('low', 'education'), 16);
  assert.equal(hexIdentificationDC('medium', 'witcherTraining'), 18);
  assert.equal(hexIdentificationDC('high', 'education'), 26);
  assert.equal(hexIdentificationDC('high', 'witcherTraining'), 22);
});

function fixture(t, configuration = {}) {
  const names = ['game', 'foundry', 'ChatMessage', 'Roll', 'Hooks', 'ui'],
    saved = new Map(names.map((name) => [name, globalThis[name]]));
  t.after(() => {
    for (const [name, value] of saved)
      if (value === undefined) delete globalThis[name];
      else globalThis[name] = value;
  });
  const documents = new Map(),
    messages = [],
    actors = [],
    calls = { rolls: [], chats: [], outcomes: [], writes: 0 },
    gm = { id: 'gm', isGM: true, active: true, isActiveGM: true };
  let identifier = 0;
  const getProperty = (object, path) => path.split('.').reduce((result, key) => result?.[key], object);
  const setProperty = (object, path, value) => {
    const parts = path.split('.'),
      key = parts.pop();
    let target = object;
    for (const part of parts) target = target[part] ??= {};
    target[key] = structuredClone(value);
  };
  globalThis.foundry = {
    utils: {
      deepClone: structuredClone,
      getProperty,
      randomID: () => `id${++identifier}`,
      fromUuid: async (uuid) => documents.get(uuid),
    },
  };
  globalThis.game = {
    user: gm,
    users: [gm],
    actors,
    messages,
    time: { worldTime: 0 },
    combat: null,
    settings: { get: () => 'publicroll' },
  };
  globalThis.Hooks = { on: () => {} };
  globalThis.ui = { notifications: { error: () => {} } };
  globalThis.Roll = class {
    static validate() {
      return true;
    }
    constructor(formula) {
      this.formula = formula;
    }
    async evaluate() {
      calls.rolls.push(this.formula);
      this.total = calls.nextDice?.shift() ?? 5;
      return this;
    }
  };
  globalThis.ChatMessage = {
    getSpeaker: ({ actor }) => ({ actor: actor.id }),
    applyRollMode: () => {},
    async create(data) {
      if (calls.failChat) throw new Error('Chat failure');
      const message = {
        ...data,
        author: gm,
        uuid: `ChatMessage.${++identifier}`,
        async update(changes) {
          if (this.failUpdate) {
            this.failUpdate = false;
            throw new Error('Receipt failure');
          }
          for (const [path, value] of Object.entries(changes)) setProperty(this, path, value);
          return this;
        },
        async delete() {
          const index = messages.indexOf(this);
          if (index >= 0) messages.splice(index, 1);
          documents.delete(this.uuid);
        },
      };
      messages.push(message);
      documents.set(message.uuid, message);
      calls.chats.push(message);
      return message;
    },
  };
  const actor = (id, key) => {
    const learned = { ...magicItemData(key), id: 'learned', uuid: `Actor.${id}.Item.learned` };
    const items = [learned];
    items.contents = items;
    items.get = (id) => items.find((item) => item.id === id);
    const source = {
      system: {
        race: 'human',
        profession: 'mage',
        vigor: 30,
        magic: { tradition: 'mage', roundKey: '', spent: 0 },
        sta: { value: 30, max: 30 },
        hp: { value: 30, max: 30 },
        pendingDeathSaves: 0,
        traits: {},
        conditions: [],
        effects: [],
        combat: { reactions: [] },
      },
    };
    const document = {
      id,
      uuid: `Actor.${id}`,
      documentName: 'Actor',
      name: id,
      isOwner: true,
      items,
      system: source.system,
      _source: source,
      skillBase(_key, { modifier = 0 } = {}) {
        return { total: (this.base ?? 20) + modifier };
      },
      testUserPermission: () => true,
      async update(changes) {
        calls.writes++;
        for (const [path, value] of Object.entries(changes)) setProperty(this._source, path, value);
        this.system = this._source.system;
        return this;
      },
      async updateEmbeddedDocuments(_type, updates) {
        for (const update of updates) {
          const item = items.get(update._id);
          for (const [path, value] of Object.entries(update))
            if (path !== '_id') setProperty(item, path, value);
        }
      },
    };
    documents.set(document.uuid, document);
    actors.push(document);
    return document;
  };
  const components = (owner, key) => {
    const allocations = {};
    for (const requirement of ritualRequirements(magicInfo(key))) {
      if (requirement.kind === 'prerequisite') {
        allocations[requirement.id] = { confirmed: true, note: 'Present in scene.' };
        continue;
      }
      const item = {
        id: requirement.id,
        name: requirement.name,
        type: 'component',
        system: { quantity: requirement.quantity + 5, carried: true },
      };
      item._source = structuredClone(item);
      owner.items.push(item);
      allocations[requirement.id] = { itemId: item.id };
    }
    return allocations;
  };
  registerMagicProcedures({
    supportsRitual: () => true,
    planRitualResult: async (context) => {
      calls.outcomes.push(context);
      return [];
    },
    ...configuration,
  });
  return { calls, actor, components, messages, documents, actors };
}

test('unsupported ritual outcomes are blocked before preparation or resource mutations', async (t) => {
  const f = fixture(t, { supportsRitual: () => false }),
    actor = f.actor('mage', 'ritual-of-life');
  await assert.rejects(
    () => runCommand('magicProcedureBegin', { actorUuid: actor.uuid, itemId: 'learned', kind: 'ritual' }),
    /not yet been implemented/
  );
  assert.equal(f.calls.writes, 0);
  assert.equal(f.messages.length, 0);
});

test('the full ritual preparation clock must elapse, then actual inventory and STA are consumed exactly once', async (t) => {
  const f = fixture(t),
    actor = f.actor('mage', 'ritual-of-life'),
    allocations = f.components(actor, 'ritual-of-life');
  const card = await runCommand('magicProcedureBegin', {
    actorUuid: actor.uuid,
    itemId: 'learned',
    kind: 'ritual',
    allocations,
  });
  assert.equal(activeRitualPreparation(f.messages, actor.uuid), card);
  await assert.rejects(
    () => runCommand('magicProcedureFinish', { messageUuid: card.uuid, options: { manualDice: '7' } }),
    /15 more seconds/
  );
  assert.equal(actor.system.sta.value, 30);
  game.time.worldTime = 15;
  await runCommand('magicProcedureFinish', { messageUuid: card.uuid, options: { manualDice: '7' } });
  assert.equal(actor.system.sta.value, 25);
  assert.equal(actor.items.get('component-0').system.quantity, 5);
  assert.equal(card.flags[SYSTEM_ID].status, 'completed');
  assert.equal(f.calls.outcomes[0].success, true);
  await assert.rejects(
    () => runCommand('magicProcedureFinish', { messageUuid: card.uuid, options: { manualDice: '7' } }),
    /no longer ready/
  );
  assert.equal(actor.system.sta.value, 25);
});

test('a failed completed ritual consumes materials; a fumble deals ritual STA damage instead of ordinary fumble severity', async (t) => {
  const f = fixture(t),
    actor = f.actor('mage', 'ritual-of-life'),
    allocations = f.components(actor, 'ritual-of-life');
  const card = await runCommand('magicProcedureBegin', {
    actorUuid: actor.uuid,
    itemId: 'learned',
    kind: 'ritual',
    allocations,
  });
  game.time.worldTime = 15;
  await runCommand('magicProcedureFinish', { messageUuid: card.uuid, options: { manualDice: '1,9' } });
  assert.equal(card.flags[SYSTEM_ID].status, 'failed');
  assert.equal(actor.system.hp.value, 25);
  assert.equal(actor.system.sta.value, 25);
  assert.equal(actor.items.get('component-0').system.quantity, 5);
});

test('inventory changes during preparation are revalidated before rolling or spending', async (t) => {
  const f = fixture(t),
    actor = f.actor('mage', 'ritual-of-life'),
    allocations = f.components(actor, 'ritual-of-life');
  const card = await runCommand('magicProcedureBegin', {
    actorUuid: actor.uuid,
    itemId: 'learned',
    kind: 'ritual',
    allocations,
  });
  actor.items.get('component-0').system.quantity = 0;
  game.time.worldTime = 15;
  await assert.rejects(
    () => runCommand('magicProcedureFinish', { messageUuid: card.uuid, options: { manualDice: '7' } }),
    /Not enough/
  );
  assert.equal(actor.system.sta.value, 30);
  assert.equal(f.calls.outcomes.length, 0);
});

test('failed result receipt compensates all consumed inventory and resources', async (t) => {
  const f = fixture(t),
    actor = f.actor('mage', 'ritual-of-life'),
    allocations = f.components(actor, 'ritual-of-life');
  const quantity = actor.items.get('component-0').system.quantity;
  const card = await runCommand('magicProcedureBegin', {
    actorUuid: actor.uuid,
    itemId: 'learned',
    kind: 'ritual',
    allocations,
  });
  game.time.worldTime = 15;
  card.failUpdate = true;
  await assert.rejects(
    () => runCommand('magicProcedureFinish', { messageUuid: card.uuid, options: { manualDice: '7' } }),
    /Receipt failure/
  );
  assert.equal(actor.system.sta.value, 30);
  assert.equal(actor.items.get('component-0').system.quantity, quantity);
  assert.equal(card.flags[SYSTEM_ID].status, 'preparing');
  assert.equal(f.messages.length, 1);
});

test('ritual removal requires timely return and a real DC16 focus check before preparation resumes', async (t) => {
  const f = fixture(t),
    actor = f.actor('mage', 'ritual-of-life'),
    allocations = f.components(actor, 'ritual-of-life');
  const card = await runCommand('magicProcedureBegin', {
    actorUuid: actor.uuid,
    itemId: 'learned',
    kind: 'ritual',
    allocations,
  });
  game.time.worldTime = 3;
  await runCommand('magicProcedureInterrupt', { messageUuid: card.uuid, kind: 'removed' });
  assert.equal(card.flags[SYSTEM_ID].status, 'removed');
  game.time.worldTime = 6;
  await runCommand('magicProcedureInterrupt', {
    messageUuid: card.uuid,
    kind: 'removed',
    returned: true,
    options: { manualDice: '7' },
  });
  assert.equal(card.flags[SYSTEM_ID].status, 'preparing');
  assert.equal(card.flags[SYSTEM_ID].readyAt, 18);
  assert.equal(actor.system.sta.value, 30);
});

test('hex weaving requires a recorded GM opposition ruling and applies its source-linked result', async (t) => {
  const f = fixture(t),
    actor = f.actor('mage', 'the-eternal-itch'),
    target = f.actor('victim', 'quen');
  const card = await runCommand('magicProcedureBegin', {
    actorUuid: actor.uuid,
    itemId: 'learned',
    kind: 'hex',
    targetUuid: target.uuid,
  });
  await assert.rejects(
    () =>
      runCommand('magicProcedureFinish', { messageUuid: card.uuid, options: { manualDice: '7', dc: 12 } }),
    /GM must record/
  );
  await runCommand('magicProcedureFinish', {
    messageUuid: card.uuid,
    options: { manualDice: '7', dc: 12, ruling: 'GM establishes opposition and target reach.' },
  });
  assert.equal(actor.system.sta.value, 26);
  assert.equal(target.system.effects[0].modifiers.allActions, -1);
  assert.equal(target.system.effects[0].magic.casterUuid, actor.uuid);
  assert.equal(card.flags[SYSTEM_ID].ruling, 'GM establishes opposition and target reach.');
});

test('hex fumble has a 50% self-application boundary, no ordinary fumble damage, and preserves exhaustion stun', async (t) => {
  const f = fixture(t),
    actor = f.actor('mage', 'the-eternal-itch'),
    target = f.actor('victim', 'quen');
  actor.system.sta.value = 4;
  const card = await runCommand('magicProcedureBegin', {
    actorUuid: actor.uuid,
    itemId: 'learned',
    kind: 'hex',
    targetUuid: target.uuid,
  });
  f.calls.nextDice = [50];
  await runCommand('magicProcedureFinish', {
    messageUuid: card.uuid,
    options: { manualDice: '1,8', dc: 12, ruling: 'GM establishes the opposition.' },
  });
  assert.equal(card.flags[SYSTEM_ID].status, 'backfired');
  assert.equal(actor.system.hp.value, 30);
  assert.equal(actor.system.sta.value, 0);
  assert.equal(actor.system.effects[0].magic.key, 'the-eternal-itch');
  assert.ok(actor.system.conditions.includes('stunned'));
  assert.deepEqual(target.system.effects, []);
});

test('zero-STA goetic rituals can be performed without a fabricated Vigor cost', async (t) => {
  const f = fixture(t),
    actor = f.actor('summoner', 'uncontrolled-summoning');
  actor.system.vigor = 0;
  actor.system.sta.value = 0;
  const allocations = f.components(actor, 'uncontrolled-summoning');
  const card = await runCommand('magicProcedureBegin', {
    actorUuid: actor.uuid,
    itemId: 'learned',
    kind: 'ritual',
    allocations,
  });
  game.time.worldTime = 30;
  await runCommand('magicProcedureFinish', { messageUuid: card.uuid, options: { manualDice: '7' } });
  assert.equal(actor.system.sta.value, 0);
  assert.equal(actor.system.hp.value, 30);
  assert.equal(card.flags[SYSTEM_ID].status, 'completed');
});

function giveHex(actor, key, id = 'hex-source') {
  const effect = hexEffectData(magicInfo(key), {
    id,
    castId: `cast-${id}`,
    casterUuid: 'Actor.original',
    checkTotal: 23,
    createdAt: 0,
  });
  actor.system.effects.push(effect);
  return effect;
}
function liftingMaterials(actor, key) {
  return Object.fromEntries(
    hexLiftingRequirements(key).materials.map((entry) => {
      const item = {
        id: entry.id,
        name: entry.name,
        type: 'component',
        system: { quantity: entry.quantity, properties: {} },
      };
      item._source = structuredClone(item);
      actor.items.push(item);
      return [entry.id, { itemId: item.id }];
    })
  );
}

test('a caster removed from preparation cannot bypass the timely return check by claiming distraction', async (t) => {
  const f = fixture(t),
    actor = f.actor('mage', 'ritual-of-life');
  const card = await runCommand('magicProcedureBegin', {
    actorUuid: actor.uuid,
    itemId: 'learned',
    kind: 'ritual',
    allocations: f.components(actor, 'ritual-of-life'),
  });
  await runCommand('magicProcedureInterrupt', { messageUuid: card.uuid, kind: 'removed' });
  game.time.worldTime = 7;
  await assert.rejects(
    () =>
      runCommand('magicProcedureInterrupt', {
        messageUuid: card.uuid,
        kind: 'distracted',
        options: { manualDice: '9' },
      }),
    /timely return/
  );
  assert.equal(card.flags[SYSTEM_ID].status, 'removed');
});

test('the variable-cost Enchant Amulet sequence is blocked before starting an incomplete procedure', async (t) => {
  const f = fixture(t),
    actor = f.actor('mage', 'enchant-amulet');
  await assert.rejects(
    () => runCommand('magicProcedureBegin', { actorUuid: actor.uuid, itemId: 'learned', kind: 'ritual' }),
    /dedicated stored-spell cost/
  );
  assert.equal(f.calls.writes, 0);
});

test('identification uses printed knowledge DCs, records only success, and preserves the source', async (t) => {
  const f = fixture(t),
    actor = f.actor('mage', 'quen');
  giveHex(actor, 'the-eternal-itch');
  actor.base = 10;
  await runCommand('magicHexIdentify', {
    actorUuid: actor.uuid,
    targetUuid: actor.uuid,
    effectId: 'hex-source',
    skill: 'education',
    options: { manualDice: '6' },
  });
  assert.equal(actor.system.effects[0].magic.identifiedBy, undefined, 'equal to DC does not beat it');
  await runCommand('magicHexIdentify', {
    actorUuid: actor.uuid,
    targetUuid: actor.uuid,
    effectId: 'hex-source',
    skill: 'witcherTraining',
    options: { manualDice: '6' },
  });
  assert.deepEqual(actor.system.effects[0].magic.identifiedBy, [actor.uuid]);
  assert.equal(actor.system.effects.length, 1);
});

test('lifting requires recorded GM confirmation, consumes actual counted supplies and removes one source only', async (t) => {
  const f = fixture(t),
    actor = f.actor('victim', 'quen');
  giveHex(actor, 'the-eternal-itch', 'first');
  giveHex(actor, 'the-eternal-itch', 'second');
  const allocations = liftingMaterials(actor, 'the-eternal-itch');
  await assert.rejects(
    () => runCommand('magicHexLift', { actorUuid: actor.uuid, effectId: 'first', allocations }),
    /GM must confirm/
  );
  assert.equal(actor.items.get('lift-0').system.quantity, 1);
  await runCommand('magicHexLift', {
    actorUuid: actor.uuid,
    effectId: 'first',
    allocations,
    evidence: 'The campfire, herbs, recitation and ashes ceremony were completed.',
  });
  assert.equal(actor.items.get('lift-0').system.quantity, 0);
  assert.deepEqual(
    actor.system.effects.map((effect) => effect.id),
    ['second']
  );
  await assert.rejects(
    () =>
      runCommand('magicHexLift', {
        actorUuid: actor.uuid,
        effectId: 'first',
        allocations,
        evidence: 'Retry',
      }),
    /no longer/
  );
});

test('lifting validates the previously completed crafting check without fabricating a successful roll', async (t) => {
  const f = fixture(t),
    actor = f.actor('victim', 'quen');
  giveHex(actor, 'the-evil-eye');
  const allocations = liftingMaterials(actor, 'the-evil-eye');
  await assert.rejects(
    () =>
      runCommand('magicHexLift', {
        actorUuid: actor.uuid,
        effectId: 'hex-source',
        allocations,
        evidence: 'The crafted coral amulet was worn through the full moon and shattered at sunrise.',
        checkTotal: 14,
      }),
    /DC14/
  );
  assert.equal(actor.system.effects.length, 1);
  await runCommand('magicHexLift', {
    actorUuid: actor.uuid,
    effectId: 'hex-source',
    allocations,
    evidence: 'Fine Arts 18; the amulet was worn through the full moon and shattered at sunrise.',
    checkTotal: 18,
  });
  assert.equal(actor.system.effects.length, 0);
});

test('failed lifting receipt restores source effects and consumed supplies', async (t) => {
  const f = fixture(t),
    actor = f.actor('victim', 'quen');
  giveHex(actor, 'the-eternal-itch');
  const allocations = liftingMaterials(actor, 'the-eternal-itch');
  f.calls.failChat = true;
  await assert.rejects(
    () =>
      runCommand('magicHexLift', {
        actorUuid: actor.uuid,
        effectId: 'hex-source',
        allocations,
        evidence: 'All printed conditions fulfilled.',
      }),
    /Chat failure/
  );
  assert.equal(actor.system.effects.length, 1);
  assert.equal(actor.items.get('lift-0').system.quantity, 1);
});

test('lifting Forgetfulness retains and transforms its one Optima Matter into the printed restricted Focus2', async (t) => {
  const f = fixture(t),
    actor = f.actor('victim', 'quen');
  giveHex(actor, 'hex-of-forgetfulness');
  const allocations = liftingMaterials(actor, 'hex-of-forgetfulness');
  await runCommand('magicHexLift', {
    actorUuid: actor.uuid,
    effectId: 'hex-source',
    allocations,
    evidence: 'The shaved scalp, clay sigils, optima matter and silent full day and night were completed.',
  });
  assert.equal(actor.items.get('lift-0').system.quantity, 0);
  assert.equal(actor.items.get('lift-2').system.quantity, 1);
  assert.equal(actor.items.get('lift-2').system.properties.focus, 2);
  assert.deepEqual(actor.items.get('lift-2').flags[SYSTEM_ID].focusKinds, ['hex', 'goetia', 'necromancy']);
  assert.match(actor.items.get('lift-2').name, /^Grayed/);
});

test('world ritual transactions run after spending and are compensated if the final casting receipt fails', async (t) => {
  let worldPresent = false,
    observedSTA;
  const f = fixture(t, {
    planRitualResult: async ({ actor }) => ({
      plans: [],
      execute: async () => {
        observedSTA = actor.system.sta.value;
        worldPresent = true;
        return {
          status: 'applied',
          receipt: { documentUuid: 'Region.created' },
          rollback: async () => {
            worldPresent = false;
          },
        };
      },
    }),
  });
  const actor = f.actor('mage', 'ritual-of-life');
  const card = await runCommand('magicProcedureBegin', {
    actorUuid: actor.uuid,
    itemId: 'learned',
    kind: 'ritual',
    allocations: f.components(actor, 'ritual-of-life'),
  });
  game.time.worldTime = 15;
  card.failUpdate = true;
  await assert.rejects(
    () => runCommand('magicProcedureFinish', { messageUuid: card.uuid, options: { manualDice: '7' } }),
    /Receipt failure/
  );
  assert.equal(observedSTA, 25);
  assert.equal(worldPresent, false);
  assert.equal(actor.system.sta.value, 30);
  assert.equal(f.messages.length, 1);
});

test('Forgetfulness prevents both beginning and completing a forgotten ritual without consuming resources', async (t) => {
  const f = fixture(t),
    actor = f.actor('mage', 'ritual-of-life'),
    allocations = f.components(actor, 'ritual-of-life');
  const card = await runCommand('magicProcedureBegin', {
    actorUuid: actor.uuid,
    itemId: 'learned',
    kind: 'ritual',
    allocations,
  });
  const effect = giveHex(actor, 'hex-of-forgetfulness');
  effect.magic.forgotten = [{ magicKey: 'ritual-of-life' }];
  game.time.worldTime = 15;
  await assert.rejects(
    () => runCommand('magicProcedureFinish', { messageUuid: card.uuid, options: { manualDice: '7' } }),
    /Forgetfulness/
  );
  assert.equal(actor.system.sta.value, 30);
  assert.equal(card.flags[SYSTEM_ID].status, 'preparing');
  await assert.rejects(
    () =>
      runCommand('magicProcedureBegin', {
        actorUuid: actor.uuid,
        itemId: 'learned',
        kind: 'ritual',
        allocations,
      }),
    /Forgetfulness/
  );
});
test('trusted necromancy adjustments change actual STA/DC/check and Gateway2 prompts Restless without making a fumble', async (t) => {
  let mishaps = 0;
  const f = fixture(t, {
      castingAdjustments: () => ({
        ritualDCModifier: -3,
        ritualCostModifier: -3,
        checkModifier: 2,
        gatewayTriggerFaces: [1, 2, 3],
      }),
      planSpecialMishap: async (context) => {
        mishaps++;
        assert.equal(context.check.fumble, 0);
        return [];
      },
    }),
    actor = f.actor('mage', 'reanimate-corpse'),
    allocations = f.components(actor, 'reanimate-corpse');
  const card = await runCommand('magicProcedureBegin', {
    actorUuid: actor.uuid,
    itemId: 'learned',
    kind: 'ritual',
    allocations,
  });
  game.time.worldTime = 30;
  await runCommand('magicProcedureFinish', { messageUuid: card.uuid, options: { manualDice: '2' } });
  assert.equal(card.flags[SYSTEM_ID].staCost, 7);
  assert.equal(actor.system.sta.value, 23);
  assert.equal(card.flags[SYSTEM_ID].dc, 15);
  assert.equal(card.flags[SYSTEM_ID].check.total, 24);
  assert.equal(mishaps, 1);
  assert.equal(card.flags[SYSTEM_ID].status, 'completed');
  assert.equal(actor.system.hp.value, 30);
});
test('Uninvited Guest hex cannot be removed through its ordinary printed lifting procedure', async (t) => {
  const f = fixture(t),
    actor = f.actor('victim', 'quen'),
    effect = giveHex(actor, 'the-eternal-itch');
  effect.magic.uninvitedGuest = true;
  await assert.rejects(
    () =>
      runCommand('magicHexLift', {
        actorUuid: actor.uuid,
        effectId: effect.id,
        evidence: 'All normal removal steps completed.',
        allocations: liftingMaterials(actor, 'the-eternal-itch'),
      }),
    /Uninvited Guest/
  );
  assert.equal(actor.system.effects.length, 1);
});
