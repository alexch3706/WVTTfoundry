import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { workflow, clone } from './workflow-fixture.mjs';
import { SYSTEM_ID } from '../../module/witcher/config.js';
import { runCommand } from '../../module/witcher/authority.js';
import {
  activeAlchemy,
  alchemyProfile,
  lastHopeState,
  ALCHEMY_PROFILES,
  alchemyEffect,
  planAlchemyExpiry,
} from '../../module/witcher/alchemy-rules.js';
import { woundItemData } from '../../module/witcher/wound-catalog.js';

const records = ['witcher-gear', 'tome-alchemy'].flatMap((name) =>
  JSON.parse(fs.readFileSync(new URL(`../../data/witcher/${name}.json`, import.meta.url)))
);
async function setup(t) {
  const w = await workflow(t);
  const runtime = await import('../../module/witcher/alchemy-runtime.js');
  runtime.registerAlchemyRuntime();
  const wounds = await import('../../module/witcher/wound-actions.js');
  wounds.registerWoundActions();
  game.actors = new w.Collection([
    [w.attacker.id, w.attacker],
    [w.target.id, w.target],
  ]);
  for (const actor of [w.attacker, w.target])
    await actor.update({ 'system.race': 'witcher', 'system.toxicity': { value: 0, max: 100 } });
  w.dose = async (name, actor = w.attacker) => {
    const source = records.find((entry) => entry.name === name);
    assert(source, `Catalog item ${name}`);
    return (await actor.createEmbeddedDocuments('Item', [source]))[0];
  };
  w.use = (item, { actor = w.attacker, target = actor, ...options } = {}) =>
    runCommand('alchemyUse', { actorUuid: actor.uuid, targetUuid: target.uuid, itemId: item.id, options });
  w.wound = async (actor, key = 'simple-0') =>
    (await actor.createEmbeddedDocuments('Item', [woundItemData({ key, location: 'leftLeg' })]))[0];
  return { ...w, runtime, wounds };
}

test('source identity survives a renamed Full Moon dose and expiry removes only unspent temporary HP', async (t) => {
  const w = await setup(t),
    item = await w.dose('Full Moon');
  item.name = 'Renamed family recipe';
  await item.update({ 'system.sourceUuid': `Compendium.${SYSTEM_ID}.witcher-gear.Item.265652399a2baa7a` });
  await w.use(item);
  assert.equal(item.system.quantity, 0);
  assert.equal(w.attacker.system.hp.value, 55);
  const effects = clone(w.attacker.system.effects);
  effects.find((effect) => effect.key === 'Full Moon').temporaryHp = 22;
  await w.attacker.update({ 'system.hp.value': 47, 'system.effects': effects });
  game.time.worldTime = 1800;
  await w.runtime.expireAlchemy(w.attacker);
  assert.equal(w.attacker.system.hp.value, 25);
  assert.equal(w.attacker.system.toxicity.value, 0);
  assert.equal(activeAlchemy(w.attacker.system, 'full-moon'), undefined);
});

test('toxic overdose Endurance DC18 removes the actual latest dose and its bonus, preserving an earlier dose', async (t) => {
  const w = await setup(t),
    moon = await w.dose('Full Moon'),
    thunder = await w.dose('Thunderbolt');
  await w.use(moon);
  await w.use(thunder);
  assert.equal(w.attacker.system.toxicity.value, 150);
  assert(w.attacker.system.conditions.includes('poison'));
  await runCommand('alchemyPoison', { actorUuid: w.attacker.uuid, options: { manualDice: '9' } });
  assert.equal(w.attacker.system.toxicity.value, 75);
  assert(!activeAlchemy(w.attacker.system, 'thunderbolt'));
  assert(activeAlchemy(w.attacker.system, 'full-moon'));
  assert(!w.attacker.system.conditions.includes('poison'));
  assert.equal(w.rolls.length, 0);
});

test('White Honey clears toxicity poisoning and remaining Full Moon HP but leaves unrelated poison sources', async (t) => {
  const w = await setup(t);
  await w.attacker.update({
    'system.conditions': ['poison'],
    'system.effects': [{ id: 'venom', key: 'Black Venom', dc: 16, expires: 0 }],
  });
  await w.use(await w.dose('Full Moon'));
  await w.use(await w.dose('Thunderbolt'));
  await w.use(await w.dose('White Honey'));
  assert.equal(w.attacker.system.toxicity.value, 0);
  assert.equal(w.attacker.system.hp.value, 25);
  assert(w.attacker.system.conditions.includes('poison'));
  assert.equal(w.attacker.system.effects.length, 1);
  assert.equal(w.attacker.system.effects[0].id, 'venom');
});

test('expired doses end their attributed toxicity poison without a recovery roll', async (t) => {
  const w = await setup(t);
  await w.use(await w.dose('Full Moon'));
  await w.use(await w.dose('Thunderbolt'));
  game.time.worldTime = 46;
  await w.runtime.expireAlchemy(w.attacker);
  assert.equal(w.attacker.system.toxicity.value, 75);
  assert(!w.attacker.system.conditions.includes('poison'));
});

test('failed non-witcher ingestion consumes dose, offers ordinary DC15 poison recovery and grants no benefit', async (t) => {
  const w = await setup(t);
  await w.attacker.update({ 'system.race': 'human' });
  const item = await w.dose('Full Moon');
  await w.use(item, { manualDice: '2' });
  assert.equal(item.system.quantity, 0);
  assert.equal(w.attacker.system.hp.value, 25);
  assert.equal(w.attacker.system.toxicity.value, 0);
  assert(w.attacker.system.conditions.includes('poison'));
  assert(!activeAlchemy(w.attacker.system, 'full-moon'));
  await runCommand('alchemyPoison', { actorUuid: w.attacker.uuid, options: { manualDice: '6' } });
  assert(!w.attacker.system.conditions.includes('poison'));
  assert.equal(w.attacker.system.effects.length, 0);
});

test('halflings receive elixir toxicity, no bonuses; Anabolic Steroids raises maximum HP without healing', async (t) => {
  const w = await setup(t);
  await w.attacker.update({ 'system.race': 'halfling' });
  await w.use(await w.dose('Anabolic Steroids'));
  assert.equal(w.attacker.system.toxicity.value, 50);
  assert.equal(w.attacker.system.hp.max, 25);
  assert.equal(w.attacker.system.hp.value, 25);
  assert(!activeAlchemy(w.attacker.system, 'anabolic-steroids'));
  await w.target.update({ 'system.race': 'human', 'system.hp.value': 8 });
  await w.use(await w.dose('Anabolic Steroids'), { target: w.target });
  assert.equal(w.target.system.hp.max, 35);
  assert.equal(w.target.system.hp.value, 8);
  game.time.worldTime = 600;
  await w.runtime.expireAlchemy(w.target);
  assert.equal(w.target.system.hp.max, 25);
  assert.equal(w.target.system.hp.value, 8);
  assert(w.target.system.effects.some((effect) => effect.alchemy?.key === 'anabolic-aggression'));
  game.time.worldTime = 3600;
  await w.runtime.expireAlchemy(w.target);
  assert.equal(w.target.system.toxicity.value, 0);
});

test('cross-actor chat failure restores both action/quantity and target effects', async (t) => {
  const w = await setup(t),
    item = await w.dose('Full Moon');
  w.start();
  const before = clone(w.attacker.system),
    targetBefore = clone(w.target.system);
  w.faults.create = () => true;
  await assert.rejects(w.use(item, { target: w.target }), /Injected message/);
  assert.equal(item.system.quantity, 1);
  assert.deepEqual(w.attacker.system, before);
  assert.deepEqual(w.target.system, targetBefore);
  w.faults.create = null;
  await w.use(item, { target: w.target });
  assert.equal(item.system.quantity, 0);
  assert.equal(w.target.system.hp.value, 55);
});

test('dose write failure cannot leave a target benefit or spend the source action', async (t) => {
  const w = await setup(t),
    item = await w.dose('Fiend Decoction');
  w.start();
  const original = item.update.bind(item);
  let fail = true;
  item.update = async (changes) => {
    if (fail && changes['system.quantity'] === 0) {
      fail = false;
      throw new Error('dose persistence failed');
    }
    return original(changes);
  };
  await assert.rejects(w.use(item, { target: w.target }), /dose persistence failed/);
  assert.equal(item.system.quantity, 1);
  assert(!activeAlchemy(w.target.system, 'fiend-decoction'));
  assert.equal(w.attacker.system.combat.actions, 0);
});

test('stable authoritative receipt makes an approval-card retry consume exactly one dose', async (t) => {
  const w = await setup(t),
    item = await w.dose('Tawny Owl');
  await item.update({ 'system.quantity': 2 });
  const payload = { actorUuid: w.attacker.uuid, targetUuid: w.target.uuid, itemId: item.id, options: {} };
  const first = await w.runtime.executeAlchemyUse(payload, { user: game.user, id: 'stable-request' });
  const second = await w.runtime.executeAlchemyUse(payload, { user: game.user, id: 'stable-request' });
  assert.equal(first.uuid, second.uuid);
  assert.equal(item.system.quantity, 1);
  assert.equal(w.target.system.effects.filter((effect) => effect.key === 'Tawny Owl').length, 1);
});

test('actual GM approval retry after card persistence failure does not reconsume or reapply the dose', async (t) => {
  const w = await setup(t),
    item = await w.dose('Tawny Owl');
  await item.update({ 'system.quantity': 2 });
  const message = await ChatMessage.create({
    flags: {
      [SYSTEM_ID]: {
        kind: 'alchemyApproval',
        requestAuthor: 'player',
        payload: { actorUuid: w.attacker.uuid, targetUuid: w.target.uuid, itemId: item.id, options: {} },
      },
    },
  });
  w.faults.update = (card) => card.id === message.id;
  await assert.rejects(
    runCommand('alchemyApprove', { messageUuid: message.uuid }),
    /Injected message update/
  );
  assert.equal(item.system.quantity, 1);
  assert.equal(w.target.system.effects.filter((effect) => effect.key === 'Tawny Owl').length, 1);
  w.faults.update = null;
  await runCommand('alchemyApprove', { messageUuid: message.uuid });
  assert.equal(item.system.quantity, 1);
  assert.equal(message.flags[SYSTEM_ID].applied, true);
});

test('unowned recipient cannot be mutated through an unapproved player use command', async (t) => {
  const w = await setup(t),
    item = await w.dose('Swallow'),
    player = game.users.get('player');
  w.target.testUserPermission = (user) => user.isGM;
  await assert.rejects(
    w.runtime.executeAlchemyUse(
      { actorUuid: w.attacker.uuid, targetUuid: w.target.uuid, itemId: item.id, options: {} },
      { user: player, id: 'no-permission' }
    ),
    /own/
  );
  assert.equal(item.system.quantity, 1);
  assert.equal(w.target.system.effects.length, 0);
});

test('blade oil uses a real eligible carried weapon; rejected or failed writes never consume its dose', async (t) => {
  const w = await setup(t),
    oil = await w.dose('Necrophage Oil'),
    sword = await w.importItem(w.attacker, 'Arming Sword', { equipped: true });
  await assert.rejects(w.use(oil, { weaponId: 'missing' }), /slashing or piercing/);
  assert.equal(oil.system.quantity, 1);
  await w.use(oil, { weaponId: sword.id });
  assert.equal(oil.system.quantity, 0);
  assert.equal(sword.system.oil.category, 'necrophage');
  assert.equal(sword.system.oil.expires, 1800);
});

test('Last Hope critical injury remains blocked until DC24 reapplication and a fresh Healing Hands treatment', async (t) => {
  const w = await setup(t),
    injury = await w.wound(w.target),
    dose = await w.dose('Last Hope');
  await w.use(dose, { target: w.target, woundId: injury.id });
  assert.equal(injury.system.wound.treatment, 'treated');
  assert.equal(lastHopeState(injury).phase, 'locked');
  const before = injury.system.wound.daysRemaining;
  await assert.rejects(
    runCommand('woundAction', {
      actorUuid: w.target.uuid,
      itemId: injury.id,
      action: 'heal',
      options: {},
      expected: JSON.stringify(injury.system.wound),
    }),
    /Last Hope/
  );
  assert.throws(() => w.wounds.magicalWoundTreatment(w.target, injury, 30), /Last Hope/);
  assert.equal(injury.system.wound.daysRemaining, before);
  await w.attacker.update({ 'system.professionRanks.healingHands': 10, 'system.stats.cra': 10 });
  await runCommand('alchemyLastHope', {
    actorUuid: w.target.uuid,
    itemId: injury.id,
    healerUuid: w.attacker.uuid,
    options: { manualDice: '5', modifier: 0 },
  });
  assert.equal(injury.system.wound.treatment, 'untreated');
  assert.equal(lastHopeState(injury).phase, 'reapplied');
  assert.equal(w.target.system.toxicity.value, 0);
  assert.throws(() => w.wounds.magicalWoundTreatment(w.target, injury, 30), /Last Hope/);
  const { turnIdentity } = await import('../../module/witcher/runtime.js');
  await runCommand('woundAction', {
    actorUuid: w.target.uuid,
    itemId: injury.id,
    action: 'medical',
    expected: JSON.stringify(injury.system.wound),
    options: {
      kind: 'treat',
      healerUuid: w.attacker.uuid,
      manualDice: '5',
      modifier: 0,
      rounds: 2,
      turn: turnIdentity(),
    },
  });
  assert.equal(injury.system.wound.treatment, 'treated');
  assert.equal(lastHopeState(injury).phase, 'released');
  assert(injury.system.wound.daysRemaining > 0);
});

test('Last Hope chat failure restores wound metadata and dose; failed DC24 leaves treated wound intact', async (t) => {
  const w = await setup(t),
    injury = await w.wound(w.target),
    item = await w.dose('Last Hope');
  w.faults.create = () => true;
  await assert.rejects(w.use(item, { target: w.target, woundId: injury.id }), /Injected message/);
  assert.equal(item.system.quantity, 1);
  assert.equal(injury.system.wound.treatment, 'untreated');
  assert.equal(lastHopeState(injury), null);
  w.faults.create = null;
  await w.use(item, { target: w.target, woundId: injury.id });
  await w.attacker.update({ 'system.professionRanks.healingHands': 1 });
  await runCommand('alchemyLastHope', {
    actorUuid: w.target.uuid,
    itemId: injury.id,
    healerUuid: w.attacker.uuid,
    options: { manualDice: '2', modifier: 0 },
  });
  assert.equal(injury.system.wound.treatment, 'treated');
  assert.equal(lastHopeState(injury).phase, 'locked');
});

test('Tome unknown duration/toxicity require an explicit GM ruling before consumption', async (t) => {
  const w = await setup(t),
    tempest = await w.dose('Tempest'),
    cerebral = await w.dose('Cerebral Elixir');
  await assert.rejects(w.use(tempest), /no duration/);
  await assert.rejects(w.use(cerebral), /no printed toxicity/);
  assert.equal(tempest.system.quantity, 1);
  assert.equal(cerebral.system.quantity, 1);
  await w.use(tempest, { durationSeconds: 3600, adjudication: 'GM table ruling: one hour' });
  assert.equal(activeAlchemy(w.attacker.system, 'tempest').expires, 3600);
  await w.use(cerebral, { toxicity: 25, adjudication: 'GM table ruling: 25 toxicity' });
  assert.equal(activeAlchemy(w.attacker.system, 'cerebral-elixir').toxicity, 25);
});

test('Black Blood recovery uses DC20 and clears its sources without removing another poison', async (t) => {
  const w = await setup(t);
  await w.attacker.update({
    'system.conditions': ['poison'],
    'system.effects': [
      {
        id: 'bb',
        key: 'Black Blood Poison',
        expires: 0,
        conditions: ['poison'],
        alchemy: { key: 'black-blood-poison', kind: 'condition', poison: true, addedPoison: true },
      },
      { id: 'venom', key: 'Black Venom', expires: 0, dc: 16 },
    ],
  });
  await runCommand('alchemyPoison', { actorUuid: w.attacker.uuid, options: { manualDice: '9' } });
  assert(
    w.attacker.system.effects.some((effect) => effect.id === 'bb'),
    '19 fails DC20'
  );
  await w.attacker.update({ 'system.skills.endurance': 8 });
  await runCommand('alchemyPoison', { actorUuid: w.attacker.uuid, options: { manualDice: '8' } });
  assert(!w.attacker.system.effects.some((effect) => effect.id === 'bb'));
  assert(w.attacker.system.conditions.includes('poison'));
});

test('ending Black Blood poisoning cannot clear a separate toxicity overdose', async (t) => {
  const w = await setup(t);
  await w.use(await w.dose('Full Moon'));
  await w.use(await w.dose('Thunderbolt'));
  await w.attacker.update({
    'system.skills.endurance': 8,
    'system.effects': [
      ...w.attacker.system.effects,
      {
        id: 'blood',
        key: 'Black Blood Poison',
        expires: 0,
        conditions: ['poison'],
        alchemy: { key: 'black-blood-poison', kind: 'condition', poison: true, addedPoison: false },
      },
    ],
  });
  await runCommand('alchemyPoison', {
    actorUuid: w.attacker.uuid,
    options: { effectId: 'blood', manualDice: '8' },
  });
  assert(w.attacker.system.effects.some((effect) => effect.key === 'Toxicity'));
  assert(w.attacker.system.conditions.includes('poison'));
  assert.equal(w.attacker.system.toxicity.value, 150);
});

test('Cerebral Elixir removes only an actual Bes possession marker', async (t) => {
  const w = await setup(t),
    item = await w.dose('Cerebral Elixir');
  await w.attacker.update({
    'system.effects': [
      {
        id: 'bes',
        key: 'Bes Possession',
        expires: 0,
        magic: { key: 'spirit-possession', species: 'bes', controlled: true, addedConditions: [] },
      },
      {
        id: 'specter',
        key: 'Spirit Possession',
        expires: 0,
        magic: { key: 'spirit-possession', species: 'specter', controlled: true, addedConditions: [] },
      },
    ],
  });
  await w.use(item, { toxicity: 0, adjudication: 'GM ruling for unprinted toxicity' });
  assert(!w.attacker.system.effects.some((effect) => effect.id === 'bes'));
  assert(w.attacker.system.effects.some((effect) => effect.id === 'specter'));
});

test('all 25 doses in one Smelling Salts bottle can be used and the 26th is rejected', async (t) => {
  const w = await setup(t),
    source = JSON.parse(fs.readFileSync(new URL('../../data/witcher/alchemy.json', import.meta.url))).find(
      (item) => item.name === 'Smelling Salts'
    );
  const [item] = await w.attacker.createEmbeddedDocuments('Item', [source]);
  game.user.targets = new Set();
  const { useItem } = await import('../../module/witcher/activities.js');
  for (let count = 0; count < 25; count++) await useItem(w.attacker, item);
  assert.equal(item.system.quantity, 0);
  await assert.rejects(useItem(w.attacker, item), /No item remains/);
});

test('Last Hope survives natural recovery and Healing Rest until its medical procedure is completed', async (t) => {
  const w = await setup(t),
    injury = await w.wound(w.target);
  await w.use(await w.dose('Last Hope'), { target: w.target, woundId: injury.id });
  await w.target.rest({ days: 10, sleepHours: 8, meals: 3 });
  assert.equal(injury.system.wound.treatment, 'treated');
  assert.equal(lastHopeState(injury).phase, 'locked');
  await w.target.update({
    'system.effects': [
      ...w.target.system.effects,
      {
        id: 'rest',
        key: 'Healing Rest',
        expires: 86400,
        magic: {
          key: 'healing-rest',
          castId: 'test-rest',
          healingRest: { startedAt: 0, endsAt: 86400 },
          addedConditions: [],
        },
      },
    ],
  });
  const { healingRestCompletionPlan } = await import('../../module/witcher/magic-healing-extra.js');
  const plan = await healingRestCompletionPlan(w.target, 86400);
  assert(!plan.items.some((change) => change._id === injury.id));
});
