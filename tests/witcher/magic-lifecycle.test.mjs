import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SYSTEM_ID } from '../../module/witcher/config.js';
import {
  magicalStunRecovery,
  magicStunSavePlan,
  magicUpkeepPaid,
  magicRepeatCycle,
  planMagicLifecycle,
  registerMagicLifecycle,
  tickMagicLifecycle,
  wakeMagicOnDamage,
} from '../../module/witcher/magic-lifecycle.js';

const state = (effects = [], overrides = {}) => ({
  effects,
  conditions: [],
  hp: { value: 20, max: 40 },
  ...overrides,
});
const effect = (key, magic = {}, details = {}) => ({
  id: `${key}-id`,
  key,
  expires: 0,
  magic: { key, castId: `${key}-cast`, createdAt: 0, paidAt: 0, castRound: 'combat:1', ...magic },
  ...details,
});
const healing = (rounds = 3) =>
  effect('magic-healing', { healing: 3, roundsRemaining: rounds, nextAt: 3 }, { expires: rounds * 3 });
const stream = () =>
  effect('fire-stream', { casterEffect: true, maintenance: 'halfInitial', nextUpkeepAt: 3 });
const shield = () =>
  effect('active-shield', { casterEffect: true, maintenance: 'initial', nextUpkeepAt: 3 }, { shieldHP: 20 });
const puppet = () =>
  effect('puppet', { controlled: true, repeatDefense: 'resistMagic', castingTotal: 20 }, { expires: 30 });
const combat = (round, actorUuid = 'Actor.target') => ({
  id: 'combat',
  started: true,
  round,
  turn: 1,
  actorUuid,
  actorPresent: true,
});
const applyPlan = (before, plan) => ({
  ...before,
  effects: plan.effects,
  conditions: plan.conditions,
  hp: { ...before.hp, value: plan.hpValue },
});

test('healing restores 3 HP per complete round and repeated hooks consume no extra ticks', () => {
  let current = state([healing()]);
  assert.equal(planMagicLifecycle(current, { time: 2.99 }).hpValue, 20);
  const first = planMagicLifecycle(current, { time: 3 });
  assert.equal(first.hpValue, 23);
  assert.deepEqual(first.healing, [{ effectId: 'magic-healing-id', ticks: 1, amount: 3 }]);
  assert.equal(first.effects[0].magic.nextAt, 6);
  assert.equal(first.effects[0].magic.roundsRemaining, 2);
  current = applyPlan(current, first);
  assert.equal(planMagicLifecycle(current, { time: 3 }).changed, false);
  assert.equal(planMagicLifecycle(current, { time: 4, combat: combat(2) }).changed, false);
});

test('a time jump consumes every pending healing tick including the final tick at expiry, capped at maximum HP', () => {
  const current = state([healing(4)], { hp: { value: 32, max: 40 } });
  const plan = planMagicLifecycle(current, { time: 100 });
  assert.equal(plan.hpValue, 40);
  assert.deepEqual(plan.healing, [{ effectId: 'magic-healing-id', ticks: 4, amount: 8 }]);
  assert.deepEqual(plan.effects, []);
  assert.deepEqual(plan.expiredIds, ['magic-healing-id']);
});

test('full HP does not bank healing ticks and temporary HP above the cap is never reduced', () => {
  const current = state([healing()], { hp: { value: 40, max: 40 } });
  const first = planMagicLifecycle(current, { time: 3 });
  assert.equal(first.hpValue, 40);
  assert.equal(first.effects[0].magic.roundsRemaining, 2);
  const injured = applyPlan(current, first);
  injured.hp.value = 20;
  assert.equal(planMagicLifecycle(injured, { time: 6 }).hpValue, 23);
  assert.equal(
    planMagicLifecycle(state([healing()], { hp: { value: 45, max: 40 } }), { time: 3 }).hpValue,
    45
  );
});

test('healing never resurrects a dead creature and malformed tick records fail explicitly', () => {
  const plan = planMagicLifecycle(
    state([healing(1)], { conditions: ['dead'], hp: { value: -10, max: 40 } }),
    { time: 3 }
  );
  assert.equal(plan.hpValue, -10);
  assert.deepEqual(plan.effects, []);
  const invalid = healing();
  delete invalid.magic.nextAt;
  assert.throws(() => planMagicLifecycle(state([invalid]), { time: 3 }), /saved round count/);
});

test('world time rewinds cannot replay already consumed healing ticks', () => {
  const before = state([healing()]),
    first = planMagicLifecycle(before, { time: 6 });
  const saved = applyPlan(before, first);
  assert.equal(planMagicLifecycle(saved, { time: 2 }).hpValue, 26);
  assert.equal(planMagicLifecycle(saved, { time: 6 }).changed, false);
  assert.equal(planMagicLifecycle(saved, { time: 9 }).hpValue, 29);
});

test('source-aware expiry preserves overlapping conditions and transfers ownership to their surviving source', () => {
  const first = effect('axii', { addedConditions: ['stunned'] }, { conditions: ['stunned'], expires: 3 });
  const second = effect(
    'somne',
    { sleeping: true, addedConditions: [] },
    { conditions: ['stunned'], expires: 6 }
  );
  const current = state([first, second], { conditions: ['stunned', 'prone'] });
  const atThree = planMagicLifecycle(current, { time: 3 });
  assert.deepEqual(atThree.conditions, ['stunned', 'prone']);
  assert.deepEqual(atThree.effects[0].magic.addedConditions, ['stunned']);
  const atSix = planMagicLifecycle(applyPlan(current, atThree), { time: 6 });
  assert.deepEqual(atSix.conditions, ['prone']);
});

test('lifecycle leaves nonmagical effects and region-owned effects to their own processors', () => {
  const mundane = { id: 'mundane', key: 'Poison', expires: 1 };
  const zone = effect('yrden', { casterEffect: true, regionUuid: 'Scene.s.Region.r' }, { expires: 1 });
  const plan = planMagicLifecycle(state([mundane, zone]), { time: 10 });
  assert.deepEqual(plan.effects, [mundane, zone]);
  assert.equal(plan.changed, false);
});

test('maintained magic becomes due on the caster’s next turn and ends when that payment is skipped through the following turn', () => {
  const current = state([stream()]);
  assert.equal(
    planMagicLifecycle(current, { time: 3, combat: combat(2, 'Actor.other'), actorUuid: 'Actor.target' })
      .changed,
    false
  );
  const due = planMagicLifecycle(current, { time: 3, combat: combat(2), actorUuid: 'Actor.target' });
  assert.equal(due.effects[0].magic.upkeepDue, true);
  assert.equal(due.effects[0].magic.upkeepCycle, 'combat:2');
  const saved = applyPlan(current, due);
  assert.equal(
    planMagicLifecycle(saved, { time: 4, combat: combat(2), actorUuid: 'Actor.target' }).changed,
    false
  );
  assert.equal(
    planMagicLifecycle(saved, { time: 5, combat: combat(3, 'Actor.other'), actorUuid: 'Actor.target' })
      .effects.length,
    1
  );
  const ended = planMagicLifecycle(saved, { time: 6, combat: combat(3), actorUuid: 'Actor.target' });
  assert.deepEqual(ended.effects, []);
  assert.deepEqual(ended.endedCastIds, ['fire-stream-cast']);
});

test('successful upkeep resets the payment clock and combat cycle while preserving casting metadata', () => {
  const current = stream();
  current.magic.upkeepDue = true;
  const metadata = magicUpkeepPaid(current, { time: 3, combat: combat(2) });
  assert.equal(metadata.nextUpkeepAt, 6);
  assert.equal(metadata.paidAt, 3);
  assert.equal(metadata.castRound, 'combat:2');
  assert.equal(metadata.upkeepDue, false);
  assert.equal(metadata.castId, 'fire-stream-cast');
  current.magic = metadata;
  assert.equal(
    planMagicLifecycle(state([current]), { time: 3, combat: combat(2), actorUuid: 'Actor.target' }).changed,
    false
  );
  assert.equal(
    planMagicLifecycle(state([current]), { time: 6, combat: combat(3), actorUuid: 'Actor.target' }).effects[0]
      .magic.upkeepDue,
    true
  );
});

test('out-of-combat upkeep has equivalent round timing and a large forward jump cannot grant free maintenance', () => {
  const current = state([stream()]);
  assert.equal(planMagicLifecycle(current, { time: 2 }).changed, false);
  const due = planMagicLifecycle(current, { time: 3 });
  assert.equal(due.effects[0].magic.upkeepDue, true);
  assert.equal(due.effects[0].magic.upkeepDeadline, 6);
  assert.deepEqual(planMagicLifecycle(applyPlan(current, due), { time: 6 }).effects, []);
  assert.deepEqual(planMagicLifecycle(current, { time: 100 }).effects, []);
  assert.deepEqual(
    planMagicLifecycle(current, { time: 9, combat: combat(4), actorUuid: 'Actor.target' }).effects,
    []
  );
});

test('combat rewinds do not reopen a later maintenance cycle', () => {
  const current = state([stream()]);
  const due = planMagicLifecycle(current, { time: 3, combat: combat(2), actorUuid: 'Actor.target' });
  const saved = applyPlan(current, due);
  assert.equal(
    planMagicLifecycle(saved, { time: 1, combat: combat(1), actorUuid: 'Actor.target' }).changed,
    false
  );
});

test('Reanimate Corpse pays its printed minute upkeep rather than every combat round', () => {
  const ritual = effect('reanimate-corpse', {
    casterEffect: true,
    maintenance: 'fixed',
    maintenanceIntervalSeconds: 60,
    nextUpkeepAt: 60,
  });
  const current = state([ritual]);
  assert.equal(
    planMagicLifecycle(current, { time: 3, combat: combat(2), actorUuid: 'Actor.target' }).changed,
    false
  );
  assert.equal(
    planMagicLifecycle(current, { time: 59, combat: combat(20), actorUuid: 'Actor.target' }).changed,
    false
  );
  const due = planMagicLifecycle(current, { time: 60, combat: combat(21), actorUuid: 'Actor.target' });
  assert.equal(due.effects[0].magic.upkeepDue, true);
  assert.equal(due.effects[0].magic.upkeepDeadline, 120);
  assert.equal(magicUpkeepPaid(ritual, { time: 60, combat: combat(21) }).nextUpkeepAt, 120);
});

test('broken or expired Active Shield remains as a pending collapse with no automatic movement or damage', () => {
  for (const details of [{ shieldHP: 0 }, { expires: 1 }]) {
    const ward = { ...shield(), ...details },
      current = state([ward]);
    const plan = planMagicLifecycle(current, { time: 2 });
    assert.equal(plan.effects.length, 1);
    assert.equal(plan.effects[0].shieldHP, 0);
    assert.equal(plan.effects[0].expires, 0);
    assert.equal(plan.effects[0].magic.pendingCollapse, true);
    assert.equal(plan.effects[0].magic.maintenance, 'none');
    assert.equal(plan.collapse.length, 1);
    assert.equal(plan.hpValue, 20);
  }
});

test('Puppet offers a repeat check once per target round and does not replay prompts on rewind', () => {
  const current = state([puppet()]);
  assert.equal(
    planMagicLifecycle(current, { time: 0, combat: combat(1), actorUuid: 'Actor.target' }).prompts.length,
    0
  );
  assert.equal(
    planMagicLifecycle(current, { time: 3, combat: combat(2, 'Actor.other'), actorUuid: 'Actor.target' })
      .prompts.length,
    0
  );
  const due = planMagicLifecycle(current, { time: 3, combat: combat(2), actorUuid: 'Actor.target' });
  assert.equal(due.prompts[0].cycle, 'combat:2');
  const saved = applyPlan(current, due);
  assert.equal(
    planMagicLifecycle(saved, { time: 3, combat: combat(2), actorUuid: 'Actor.target' }).prompts.length,
    0
  );
  assert.equal(
    planMagicLifecycle(saved, { time: 1, combat: combat(1), actorUuid: 'Actor.target' }).prompts.length,
    0
  );
  assert.equal(
    planMagicLifecycle(saved, { time: 6, combat: combat(3), actorUuid: 'Actor.target' }).prompts.length,
    1
  );
});

test('Puppet outside combat has one opportunity per 3 seconds, with the same receipt used by its action', () => {
  const item = puppet(),
    current = state([item]);
  assert.equal(magicRepeatCycle(item, { time: 0 }), 'time:0');
  assert.equal(magicRepeatCycle(item, { time: 3 }), 'time:1');
  assert.equal(planMagicLifecycle(current, { time: 2 }).prompts.length, 0);
  item.magic.lastResistRound = 'time:1';
  assert.equal(planMagicLifecycle(current, { time: 3 }).prompts.length, 0);
  assert.equal(planMagicLifecycle(current, { time: 6 }).prompts[0].cycle, 'time:2');
});

test('Axii recovery uses the strongest applicable penalty and successful recovery removes only Axii', () => {
  const weak = effect(
    'axii',
    { stunModifier: -1, addedConditions: ['stunned'] },
    { id: 'weak', conditions: ['stunned'] }
  );
  const strong = effect(
    'axii',
    { stunModifier: -4, addedConditions: [] },
    { id: 'strong', conditions: ['stunned'] }
  );
  const current = state([weak, strong, { id: 'other', key: 'Other' }], { conditions: ['stunned', 'prone'] });
  assert.equal(magicalStunRecovery(current).modifier, -4);
  assert.equal(magicalStunRecovery(current, { effectId: 'weak' }).modifier, -1);
  const failure = magicStunSavePlan(current, { success: false });
  assert.deepEqual(failure.conditions, current.conditions);
  const success = magicStunSavePlan(current, { success: true });
  assert.deepEqual(
    success.effects.map((item) => item.id),
    ['other']
  );
  assert.deepEqual(success.conditions, ['prone']);
});

test('Somne blocks ordinary stun recovery, and damage wakes it without clearing a separate Axii', () => {
  const sleep = effect(
    'somne',
    { sleeping: true, addedConditions: ['stunned'] },
    { conditions: ['stunned'] }
  );
  const axii = effect('axii', { stunModifier: -2, addedConditions: [] }, { conditions: ['stunned'] });
  const current = state([sleep, axii], { conditions: ['stunned'] });
  assert.equal(magicalStunRecovery(current).blocked, true);
  assert.match(magicalStunRecovery(current).reason, /ordinary Stun save/);
  assert.equal(magicStunSavePlan(current, { success: true }).effects.length, 2);
  assert.equal(wakeMagicOnDamage(current, 0).effects.length, 2);
  const awakened = wakeMagicOnDamage(current, { hpDamage: 0, staDamage: 1 });
  assert.deepEqual(
    awakened.effects.map((item) => item.magic.key),
    ['axii']
  );
  assert.deepEqual(awakened.conditions, ['stunned']);
  assert.deepEqual(awakened.effects[0].magic.addedConditions, ['stunned']);
});

test('damage wakes every Somne source but preserves a preexisting mundane stun', () => {
  const current = state(
    [effect('somne', { sleeping: true, addedConditions: [] }, { conditions: ['stunned'] })],
    { conditions: ['stunned'] }
  );
  const result = wakeMagicOnDamage(current, 1);
  assert.deepEqual(result.effects, []);
  assert.deepEqual(result.conditions, ['stunned']);
  assert.throws(() => wakeMagicOnDamage(current, -1), /non-negative/);
});

test('pure plans do not mutate caller-owned effects or conditions', () => {
  const current = state([healing(), puppet(), shield()]),
    before = structuredClone(current);
  planMagicLifecycle(current, { time: 3, combat: combat(2), actorUuid: 'Actor.target' });
  assert.deepEqual(current, before);
});

function fixture(t) {
  const names = ['game', 'foundry', 'ChatMessage', 'Hooks', 'ui'],
    saved = new Map(names.map((name) => [name, globalThis[name]]));
  t.after(() => {
    for (const [name, value] of saved)
      if (value === undefined) delete globalThis[name];
      else globalThis[name] = value;
  });
  const actors = [],
    scenes = [],
    messages = [],
    calls = { updates: [], chat: [], hooks: new Map() };
  const gm = { id: 'gm', isGM: true, active: true, isActiveGM: true },
    player = { id: 'player', isGM: false, active: true };
  const getProperty = (object, path) => path.split('.').reduce((result, key) => result?.[key], object);
  const setProperty = (object, path, value) => {
    const parts = path.split('.'),
      key = parts.pop();
    let target = object;
    for (const part of parts) target = target[part] ??= {};
    target[key] = structuredClone(value);
  };
  globalThis.foundry = { utils: { deepClone: structuredClone, getProperty } };
  globalThis.game = {
    user: gm,
    users: [gm, player],
    actors,
    scenes,
    time: { worldTime: 0 },
    combat: null,
    settings: { get: () => 'publicroll' },
  };
  globalThis.ui = { notifications: { error: () => {} } };
  globalThis.ChatMessage = {
    getSpeaker: ({ actor }) => ({ actor: actor.id }),
    applyRollMode: () => {},
    async create(data) {
      if (calls.failChat) throw new Error('Chat persistence failed');
      const message = {
        ...data,
        uuid: `ChatMessage.${messages.length}`,
        async delete() {
          const index = messages.indexOf(this);
          if (index >= 0) messages.splice(index, 1);
        },
      };
      messages.push(message);
      calls.chat.push(message);
      return message;
    },
  };
  globalThis.Hooks = {
    on: (name, handler) => calls.hooks.set(name, handler),
    once: (name, handler) => calls.hooks.set(name, handler),
  };
  const actor = (id, data, synthetic = false) => {
    const source = { system: structuredClone(data) };
    const document = {
      id,
      name: id,
      uuid: synthetic ? `Scene.scene.Token.${id}.Actor.${id}` : `Actor.${id}`,
      system: source.system,
      _source: source,
      items: [],
      testUserPermission: () => true,
      async update(changes) {
        if (this.failUpdate) {
          this.failUpdate = false;
          throw new Error('Actor persistence failed');
        }
        calls.updates.push({ uuid: this.uuid, changes: structuredClone(changes) });
        for (const [key, value] of Object.entries(changes)) setProperty(this._source, key, value);
        this.system = this._source.system;
        return this;
      },
    };
    if (!synthetic) actors.push(document);
    return document;
  };
  return { actors, scenes, messages, calls, actor, gm };
}

test('runtime heals world and synthetic actors once despite repeated combat/world-time calls', async (t) => {
  const f = fixture(t),
    first = f.actor('first', state([healing()])),
    second = f.actor('second', state([healing()]), true);
  f.scenes.push({ tokens: [{ actor: first }, { actor: second }] });
  game.time.worldTime = 3;
  await tickMagicLifecycle();
  await tickMagicLifecycle();
  assert.equal(first.system.hp.value, 23);
  assert.equal(second.system.hp.value, 23);
  assert.equal(f.calls.updates.length, 2);
});

test('Puppet reminder persists with its cycle, targets actor owners, and has the UI action contract', async (t) => {
  const f = fixture(t),
    actor = f.actor('target', state([puppet()]));
  game.time.worldTime = 3;
  await tickMagicLifecycle();
  await tickMagicLifecycle();
  assert.equal(f.messages.length, 1);
  assert.equal(actor.system.effects[0].magic.lastResistPromptRound, 'time:1');
  const card = f.messages[0];
  assert.equal(card.flags[SYSTEM_ID].kind, 'magic-repeat');
  assert.equal(card.flags[SYSTEM_ID].actorUuid, actor.uuid);
  assert.equal(card.flags[SYSTEM_ID].effectId, 'puppet-id');
  assert.deepEqual(card.whisper, ['gm', 'player']);
  assert.match(card.content, /data-magic-action="resist"/);
});

test('a reminder failure rolls back healing and the prompt marker so a retry loses no ticks', async (t) => {
  const f = fixture(t),
    actor = f.actor('target', state([healing(), puppet()]));
  game.time.worldTime = 3;
  f.calls.failChat = true;
  await assert.rejects(() => tickMagicLifecycle(), /Chat persistence failed/);
  assert.equal(actor.system.hp.value, 20);
  assert.equal(actor.system.effects[0].magic.roundsRemaining, 3);
  assert.equal(actor.system.effects[1].magic.lastResistPromptRound, undefined);
  f.calls.failChat = false;
  await tickMagicLifecycle();
  assert.equal(actor.system.hp.value, 23);
  assert.equal(f.messages.length, 1);
});

test('a later actor failure rolls back earlier effects and deletes already created reminders', async (t) => {
  const f = fixture(t),
    first = f.actor('first', state([puppet()])),
    second = f.actor('second', state([healing()]));
  game.time.worldTime = 3;
  second.failUpdate = true;
  await assert.rejects(() => tickMagicLifecycle(), /Actor persistence failed/);
  assert.equal(first.system.effects[0].magic.lastResistPromptRound, undefined);
  assert.equal(second.system.hp.value, 20);
  assert.equal(f.messages.length, 0);
});

test('Active Shield collapse invokes the injected prompt once after pending state is persisted', async (t) => {
  const f = fixture(t),
    ward = shield();
  ward.shieldHP = 0;
  const actor = f.actor('target', state([ward])),
    calls = [];
  const onCollapse = async (owner, saved, { reason }) => {
    assert.equal(owner, actor);
    assert.equal(saved.magic.pendingCollapse, true);
    assert.equal(saved.magic.collapsePrompted, true);
    calls.push(reason);
    return ChatMessage.create({ content: 'Choose adjacent targets.', flags: {} });
  };
  await tickMagicLifecycle({ onCollapse });
  await tickMagicLifecycle({ onCollapse });
  assert.deepEqual(calls, ['shield exhausted']);
  assert.equal(actor.system.effects.length, 1);
  assert.equal(actor.system.hp.value, 20);
  assert.equal(f.messages.length, 1);
});

test('collapse prompt failure leaves a retryable shield rather than consuming its burst', async (t) => {
  const f = fixture(t),
    ward = shield();
  ward.shieldHP = 0;
  const actor = f.actor('target', state([ward]));
  await assert.rejects(
    () =>
      tickMagicLifecycle({
        onCollapse: async () => {
          throw new Error('Collapse prompt failed');
        },
      }),
    /Collapse prompt failed/
  );
  assert.equal(actor.system.effects[0].magic.collapsePrompted, undefined);
  assert.equal(actor.system.effects[0].magic.pendingCollapse, undefined);
  await tickMagicLifecycle({ onCollapse: async () => {} });
  assert.equal(actor.system.effects[0].magic.collapsePrompted, true);
});

test('unpaid maintained casts remove only their own source-linked target effects', async (t) => {
  const f = fixture(t),
    caster = f.actor('caster', state([stream()]));
  const target = f.actor(
    'target',
    state([
      effect('target-effect', { castId: 'fire-stream-cast' }),
      effect('other-spell', { castId: 'other' }),
    ])
  );
  game.time.worldTime = 6;
  await tickMagicLifecycle();
  assert.deepEqual(caster.system.effects, []);
  assert.deepEqual(
    target.system.effects.map((item) => item.magic.castId),
    ['other']
  );
});

test('lifecycle mutation requires the elected GM and registration covers time, combat and broken shields', async (t) => {
  const f = fixture(t);
  registerMagicLifecycle({ onCollapse: async () => {} });
  for (const name of ['updateWorldTime', 'updateCombat', 'updateActor', 'canvasReady', 'ready'])
    assert.ok(f.calls.hooks.has(name));
  f.gm.isActiveGM = false;
  await assert.rejects(() => tickMagicLifecycle(), /elected GM/);
});
