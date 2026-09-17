import test from 'node:test';
import assert from 'node:assert/strict';
import { workflow, clone } from './workflow-fixture.mjs';
import { SYSTEM_ID } from '../../module/witcher/config.js';
import { runCommand } from '../../module/witcher/authority.js';
import { SOCIAL_ATTACKS, SOCIAL_CONVENTIONS } from '../../module/witcher/social-rules.js';

const conventions = (overrides = {}) => ({
  ...Object.fromEntries(Object.entries(SOCIAL_CONVENTIONS).map(([key, values]) => [key, values[0]])),
  ...overrides,
});
async function setup(t, options = {}) {
  const w = await workflow(t);
  game.actors = new w.Collection([
    [w.attacker.id, w.attacker],
    [w.target.id, w.target],
  ]);
  game.messages = w.messages;
  await w.attacker.update({
    'system.reputation': 4,
    'system.coins': 250,
    'system.social': { relationships: [], reputationEffects: [] },
  });
  await w.target.update({
    'system.race': 'elf',
    'system.reputation': 1,
    'system.coins': 0,
    'system.social': { relationships: [], reputationEffects: [] },
  });
  const runtime = await import('../../module/witcher/social-runtime.js');
  runtime.registerSocialCommands();
  const participants = [
    {
      actorUuid: w.attacker.uuid,
      side: 'A',
      goal: 'Open the north gate',
      reputationSkills: ['intimidation'],
    },
    { actorUuid: w.target.uuid, side: 'B', goal: 'Keep the north gate closed' },
  ];
  const start = (fields = {}) =>
    runCommand('socialStart', {
      participants,
      ...options,
      conventions: conventions(options.conventions),
      conventionsConfirmed: true,
      ...fields,
    });
  const message = await start();
  const state = () => message.flags[SYSTEM_ID];
  const declare = (move = 'persuade', values = {}, targetUuids = [w.target.uuid], actor = w.attacker) =>
    runCommand('socialDeclare', {
      messageUuid: message.uuid,
      revision: state().revision,
      actorUuid: actor.uuid,
      move,
      targetUuids,
      values: { manualDice: '9', ...values },
    });
  const defend = (defense = 'ignore', values = {}, actor = w.target, counterAttack) =>
    runCommand('socialDefense', {
      messageUuid: message.uuid,
      revision: state().revision,
      actorUuid: actor.uuid,
      defense,
      counterAttack,
      values: { manualDice: '2', ...values },
    });
  const ruling = (kind, values = {}, actor = w.attacker, target = w.target) =>
    runCommand('socialRuling', {
      messageUuid: message.uuid,
      revision: state().revision,
      kind,
      actorUuid: actor.uuid,
      targetUuid: target.uuid,
      values,
    });
  return { ...w, runtime, participants, start, message, state, declare, defend, ruling };
}
for (const [key, move] of Object.entries(SOCIAL_ATTACKS)) {
  test(`actual ${move.name} uses its printed skill and Resolve damage, leaves HP intact`, async (t) => {
    const w = await setup(t),
      hp = w.target.system.hp.value;
    await w.declare(key);
    assert.equal(w.attacker.skillCalls.at(-1).key, move.skill);
    w.enqueue([`1d${move.die}`, 2]);
    await w.defend();
    assert.equal(w.state().participants[1].resolve, 25 - (key === 'persuade' ? 6 : 7));
    assert.equal(w.target.system.hp.value, hp);
    assert.equal(w.state().history[0].results[0].move, key);
    assert.equal(w.state().pending, null);
    await assert.rejects(w.defend(), /pending verbal defense/);
  });
}

test('Resolve formulas and half damage follow recorded choices; new arguments have fresh pools', async (t) => {
  const w = await setup(t);
  await w.attacker.update({ 'system.stats.will': 4 });
  const final = await w.start({ conventions: conventions({ halfDamage: 'exact' }) });
  const average = await w.start({ conventions: conventions({ resolveRounding: 'average' }) });
  assert.equal(final.flags[SYSTEM_ID].participants[0].maxResolve, 22);
  assert.equal(average.flags[SYSTEM_ID].participants[0].maxResolve, 20);
  await w.declare('persuade');
  w.enqueue(['1d6', 3]);
  await w.defend();
  assert.equal(w.state().participants[1].resolve, 18.5);
  assert.equal(final.flags[SYSTEM_ID].participants[1].resolve, 25);
});

test('a tied defense blocks and the explicit convention controls return damage; counters use their selected attack', async (t) => {
  const w = await setup(t);
  await w.declare('deceive', { manualDice: '5' });
  await w.defend('ignore', { manualDice: '5' });
  assert.equal(w.state().participants[0].resolve, 25);
  assert.equal(w.state().participants[1].resolve, 25);
  await w.declare('deceive', {}, [w.attacker.uuid], w.target);
  w.enqueue(['1d10', 5]);
  await w.defend('counter', { manualDice: '10, 9' }, w.attacker, 'intimidate');
  assert.equal(w.state().participants[1].resolve, 15);
  assert.equal(w.state().history[1].results[0].move, 'intimidate');
  const full = await w.start({ conventions: conventions({ tiedDefense: 'fullEffect' }) });
  await runCommand('socialDeclare', {
    messageUuid: full.uuid,
    actorUuid: w.attacker.uuid,
    move: 'deceive',
    targetUuids: [w.target.uuid],
    values: { manualDice: '5' },
  });
  w.enqueue(['1d10', 2]);
  await runCommand('socialDefense', {
    messageUuid: full.uuid,
    actorUuid: w.target.uuid,
    defense: 'ignore',
    values: { manualDice: '5' },
  });
  assert.equal(full.flags[SYSTEM_ID].participants[0].resolve, 18);
});

test('each actual group defender responds; two successful defenses both damage the attacker once', async (t) => {
  const w = await setup(t),
    other = w.makeActor('Other defender');
  game.actors.set(other.id, other);
  const message = await w.start({
    participants: [...w.participants, { actorUuid: other.uuid, side: 'B', goal: 'Keep gate closed' }],
  });
  await runCommand('socialDeclare', {
    messageUuid: message.uuid,
    actorUuid: w.attacker.uuid,
    move: 'deceive',
    targetUuids: [w.target.uuid, other.uuid],
    values: { manualDice: '2' },
  });
  await runCommand('socialDefense', {
    messageUuid: message.uuid,
    actorUuid: w.target.uuid,
    defense: 'ignore',
    values: { manualDice: '9' },
  });
  assert.equal(message.flags[SYSTEM_ID].participants[0].resolve, 25, 'all responses are collected first');
  w.enqueue(['1d10', 2], ['1d10', 3]);
  await runCommand('socialDefense', {
    messageUuid: message.uuid,
    actorUuid: other.uuid,
    defense: 'ignore',
    values: { manualDice: '9' },
  });
  assert.equal(message.flags[SYSTEM_ID].participants[0].resolve, 10);
  assert.equal(message.flags[SYSTEM_ID].history[0].results.length, 2);
});

test('GM-opposition tools cannot invent their DC; Study must strictly beat target INT times three', async (t) => {
  const w = await setup(t);
  await assert.rejects(w.declare('romance'), /GM.*opposition/);
  await w.declare('study', { manualDice: '5' });
  assert.equal(w.state().effects.length, 0, '15 ties DC15 and fails');
  const other = await w.start();
  await runCommand('socialDeclare', {
    messageUuid: other.uuid,
    actorUuid: w.attacker.uuid,
    move: 'study',
    targetUuids: [w.target.uuid],
    values: { manualDice: '6' },
  });
  assert.equal(other.flags[SYSTEM_ID].effects[0].kind, 'study');
  assert.equal(other.flags[SYSTEM_ID].effects[0].expiresTurn, 2);
});

test('Romance and a bitter ending are persistent, directed relationships', async (t) => {
  const w = await setup(t);
  await w.ruling('tool', {
    move: 'romance',
    kind: 'dc',
    dc: 14,
    reason: 'This target is receptive; table adjudication.',
  });
  await w.declare('romance');
  assert.equal(w.target.system.social.relationships[0].otherUuid, w.attacker.uuid);
  assert.equal(w.target.system.social.relationships[0].romance, 'active');
  await w.ruling('endRomance', { badly: true }, w.target, w.attacker);
  assert.equal(w.target.system.social.relationships[0].romance, 'bitter');
  assert.equal(w.attacker.system.social.relationships.length, 0);
});

test('a successful bribe affects empathetic rolls without destroying its offer; accepted transfer rolls back on receipt failure', async (t) => {
  const w = await setup(t);
  await w.ruling('tool', { move: 'bribe', kind: 'dc', dc: 14, reason: 'Greedy gatekeeper.' });
  await w.declare('bribe', { offer: 100 });
  const offer = w.state().effects.find((row) => row.kind === 'bribe');
  assert.equal(offer.bonus, 2);
  assert.equal(w.attacker.system.coins, 250);
  const request = () =>
    runCommand('socialTransferBribe', { messageUuid: w.message.uuid, exchangeId: offer.exchangeId });
  w.faults.update = (document) => document.uuid === w.message.uuid;
  await assert.rejects(request(), /Injected|restoration/);
  assert.equal(w.attacker.system.coins, 250);
  assert.equal(w.target.system.coins, 0);
  w.faults.update = null;
  await request();
  assert.equal(w.attacker.system.coins, 150);
  assert.equal(w.target.system.coins, 100);
  await assert.rejects(request(), /unpaid/);
});

test('public Ridicule keeps an audience-specific one-day Reputation reduction and base reputation unchanged', async (t) => {
  const w = await setup(t, { public: true, audienceId: 'Oxenfurt guards' });
  await w.declare('ridicule');
  w.enqueue(['1d6', 2]);
  await w.defend();
  assert.equal(w.target.system.reputation, 1);
  const effect = w.target.system.social.reputationEffects[0];
  assert.equal(effect.amount, -2);
  assert.equal(effect.audienceId, 'Oxenfurt guards');
  assert.equal(effect.expires, game.time.worldTime + 86400);
  const { socialReputation } = await import('../../module/witcher/social-rules.js');
  assert.equal(socialReputation(w.target, { audienceId: 'Oxenfurt guards', time: game.time.worldTime }), -1);
  assert.equal(socialReputation(w.target, { audienceId: 'Novigrad', time: game.time.worldTime }), 1);
  assert.equal(socialReputation(w.target, { audienceId: 'Oxenfurt guards', time: effect.expires }), 1);
});

test('combat-finishing Befriend advances exactly one friendship level and provides a real goal receipt', async (t) => {
  const w = await setup(t);
  const data = clone(w.state());
  data.participants[1].resolve = 1;
  await w.message.update({ [`flags.${SYSTEM_ID}`]: data });
  await w.declare('befriend');
  w.enqueue(['1d6', 2]);
  await w.defend();
  assert.equal(w.state().status, 'complete');
  assert.equal(w.target.system.social.relationships[0].friendship, 1);
  assert.equal(w.target.system.social.relationships[0].otherUuid, w.attacker.uuid);
  const receipt = await w.runtime.validatedSocialVictory(w.message.uuid, {
    winnerUuid: w.attacker.uuid,
    loserUuid: w.target.uuid,
    goal: 'Open the north gate',
  });
  assert.equal(receipt.exchangeId, w.state().history.at(-1).id);
  await assert.rejects(
    w.runtime.validatedSocialVictory(w.message.uuid, {
      winnerUuid: w.attacker.uuid,
      loserUuid: w.target.uuid,
      goal: 'An invented agreement',
    }),
    /no matching victory/
  );
});

test('a failed final exchange receipt restores reputation, relationships and all Resolve without rerolling earlier defenses', async (t) => {
  const w = await setup(t, { public: true, audienceId: 'Witnesses' });
  await w.declare('ridicule');
  const before = clone(w.state()),
    actorBefore = clone(w.target._source);
  w.faults.update = (document) => document.uuid === w.message.uuid;
  w.enqueue(['1d6', 2]);
  await assert.rejects(w.defend(), /Injected|restoration/);
  assert.deepEqual(w.target._source, actorBefore);
  assert.deepEqual(w.state(), before);
  w.faults.update = null;
  w.enqueue(['1d6', 2]);
  await w.defend();
  assert.equal(w.target.system.social.reputationEffects.length, 1);
});

test('cumulative effects and ordinary fumbles do not create physical wounds or damage', async (t) => {
  const w = await setup(t);
  await w.declare('intimidate');
  w.enqueue(['1d10', 2]);
  await w.defend();
  assert.equal(w.state().counters[`${w.attacker.uuid}>${w.target.uuid}`].intimidate, 1);
  await w.declare('deceive', { manualDice: '5' }, [w.attacker.uuid], w.target);
  await w.defend('ignore', { manualDice: '5' }, w.attacker);
  await w.declare('intimidate');
  w.enqueue(['1d10', 2]);
  await w.defend();
  assert.equal(w.state().participants[1].resolve, 7, '7 then 11 Resolve damage');
  await w.declare('deceive', { manualDice: '1, 7' }, [w.attacker.uuid], w.target);
  w.enqueue(['1d10', 1]);
  await w.defend('ignore', { manualDice: '5' }, w.attacker);
  assert.equal(w.target.system.hp.value, 25);
  assert.equal(
    [...w.target.items].some((item) => item.type === 'wound'),
    false
  );
});

test('Tome binding cage allows real verbal checks, while the reanimated victim forbids torture', async (t) => {
  const w = await setup(t);
  await w.target.update({ 'system.effects': [{ id: 'cage', magic: { boundCannotAttack: true } }] });
  await w.declare('deceive');
  w.enqueue(['1d10', 2]);
  await w.defend('ignore', { manualDice: '10, 5' });
  assert.equal(w.state().participants[0].resolve, 18);
  await w.target.update({
    'system.effects': [
      { id: 'corpse', magic: { rule: { key: 'reanimated-corpse' } }, modifiers: { resistCoercion: -3 } },
    ],
  });
  await assert.rejects(
    w.ruling('torture', { atMercy: true, evidence: 'A real damaging blow.' }),
    /Reanimate Corpse/
  );
});

test('unprinted tool opposition can use an actual target check; Imply consumes the recorded one-use budget', async (t) => {
  const w = await setup(t);
  await w.ruling('tool', {
    move: 'imply',
    kind: 'opposed',
    skill: 'resistCoercion',
    reason: 'The GM-selected resistance.',
  });
  await w.declare('imply', { skill: 'deceit' });
  assert(w.state().pending);
  await w.defend();
  assert.equal(w.state().effects[0].kind, 'imply');
  assert(w.state().implyUsed.includes(w.attacker.uuid));
  await w.declare('deceive', { manualDice: '5' }, [w.attacker.uuid], w.target);
  await w.defend('ignore', { manualDice: '5' }, w.attacker);
  await assert.rejects(w.declare('imply', { skill: 'deceit' }), /already/);
});

test('recognition is a plain d10 and Face-Down applies only recorded relevant skills, never Resolve damage', async (t) => {
  const w = await setup(t);
  await runCommand('socialRecognition', {
    messageUuid: w.message.uuid,
    actorUuid: w.target.uuid,
    targetUuid: w.attacker.uuid,
    manualDice: '4',
  });
  await runCommand('socialFaceDown', {
    messageUuid: w.message.uuid,
    actorUuid: w.attacker.uuid,
    targetUuid: w.target.uuid,
    values: { manualDice: '10' },
  });
  await w.defend('ignore', { manualDice: '2' });
  const effect = w.state().effects.find((row) => row.kind === 'reputation');
  assert.deepEqual(effect.skills, ['intimidation']);
  assert.equal(effect.actorUuid, w.attacker.uuid);
  assert.equal(w.state().participants[1].resolve, 25);
  await w.declare('intimidate', { manualDice: '5' });
  assert.equal(w.state().pending.targets[0].check.total, 18);
});

test('actual social standings combine with Human Trustworthy and Odious Hex exactly once', async (t) => {
  const w = await setup(t);
  await w.target.update({ 'system.race': 'human' });
  await w.ruling('context', { standing: 'hated', feared: true });
  await w.attacker.update({
    'system.effects': [{ id: 'hex', magic: { kind: 'hex', key: 'the-odious-hex' } }],
  });
  await w.declare('befriend', { manualDice: '5' });
  assert.equal(
    w.state().pending.targets[0].check.total,
    13,
    '10 base −2 Hated −1 Feared +1 Trustworthy +5 die; Odious already caps Hated'
  );
  assert.equal(
    w.state().pending.targets[0].modifiers.filter((row) => row.label === 'Human Trustworthy').length,
    1
  );
});

async function trophyFor(w, species) {
  const { artifactItemData } = await import('../../module/witcher/magic-gear-rules.js');
  const [item] = await w.attacker.createEmbeddedDocuments('Item', [
    artifactItemData('trophy', {
      species,
      activeActorUuid: w.attacker.uuid,
      helpedKillActorUuids: [w.attacker.uuid],
    }),
  ]);
  await item.update({ 'system.equipped': true });
  return item;
}

test('actual Succubus and Botchling trophies alter only their printed social standing components', async (t) => {
  const w = await setup(t);
  const succubus = await trophyFor(w, 'succubus');
  await w.ruling('context', { standing: 'hated' });
  await w.declare('befriend', { manualDice: '5' });
  assert.equal(w.state().pending.targets[0].check.total, 14, 'Hated becomes Tolerated');
  await succubus.update({ 'system.equipped': false });
  const message = await w.start();
  await trophyFor(w, 'botchling');
  await runCommand('socialRuling', {
    messageUuid: message.uuid,
    kind: 'context',
    actorUuid: w.attacker.uuid,
    targetUuid: w.target.uuid,
    values: { standing: 'equal', feared: true },
  });
  await runCommand('socialDeclare', {
    messageUuid: message.uuid,
    actorUuid: w.attacker.uuid,
    move: 'intimidate',
    targetUuids: [w.target.uuid],
    values: { manualDice: '5' },
  });
  assert.equal(
    message.flags[SYSTEM_ID].pending.targets[0].check.total,
    17,
    'existing Feared +1 bonus doubles to +2'
  );
});

test('Leshen requires the actual eligible worn trophy and an animal-permitted goal', async (t) => {
  const w = await setup(t);
  await w.target.update({ 'system.category': 'beast' });
  await assert.rejects(w.declare(), /Leshen/);
  const trophy = await trophyFor(w, 'leshen');
  await assert.rejects(w.declare(), /animal would do/);
  await w.ruling('context', { standing: 'equal', animalGoalAllowed: true });
  await trophy.update({ 'system.equipped': false });
  await assert.rejects(w.declare(), /Leshen/);
  await trophy.update({ 'system.equipped': true });
  await w.declare();
  assert(w.state().pending);
});

test('a real reanimated corpse can respond despite remaining dead and retains its printed −3 resistance', async (t) => {
  const w = await setup(t);
  await w.target.update({
    'system.conditions': ['dead'],
    'system.effects': [
      { id: 'corpse', modifiers: { resistCoercion: -3 }, magic: { rule: { key: 'reanimated-corpse' } } },
    ],
  });
  await w.declare('deceive', { manualDice: '2' });
  w.enqueue(['1d10', 2]);
  await w.defend('ignore', { manualDice: '9' });
  assert.equal(w.state().history[0].targets[0].defense.check.total, 16);
  assert(w.target.system.conditions.includes('dead'), 'verbal participation does not resurrect the corpse');
});

test('an unbound summoned demon cannot be compelled into an unbeneficial bargain by a high roll', async (t) => {
  const w = await setup(t);
  await w.target.update({ [`flags.${SYSTEM_ID}.ritualCreature`]: { unbound: true, species: 'bes' } });
  await assert.rejects(w.declare(), /beneficial/);
  await w.ruling('context', { standing: 'equal', demonDealBeneficial: true });
  await w.declare();
  assert(w.state().pending);
});

test('normal and extra verbal actions use real Foundry Combat budgets, while Study clock does not advance on extra actions', async (t) => {
  const w = await setup(t);
  // The fixture combat helper is shadowed by the encounter factory: create the tracker explicitly.
  game.combat = {
    id: 'social-combat',
    started: true,
    round: 1,
    turn: 0,
    combatant: { actor: w.attacker },
    turns: [{ actor: w.attacker }, { actor: w.target }],
  };
  const message = await w.start({
    conventions: conventions({ timing: 'foundryCombat', repeatedDefenses: 'stamina' }),
  });
  const declare = (extra = false) =>
    runCommand('socialDeclare', {
      messageUuid: message.uuid,
      actorUuid: w.attacker.uuid,
      move: 'deceive',
      targetUuids: [w.target.uuid],
      values: { manualDice: '5', extra },
    });
  const defend = () =>
    runCommand('socialDefense', {
      messageUuid: message.uuid,
      actorUuid: w.target.uuid,
      defense: 'ignore',
      values: { manualDice: '5' },
    });
  await declare();
  await defend();
  assert.equal(w.attacker.system.combat.actions, 1);
  await assert.rejects(declare(), /normal action/);
  const sta = w.attacker.system.sta.value;
  await declare(true);
  assert.equal(w.attacker.system.sta.value, sta - 3);
  assert.equal(message.flags[SYSTEM_ID].pending.targets[0].check.total, 12);
  w.enqueue(['1d10', 2]);
  await defend();
  assert.equal(w.target.system.sta.value, 24, 'second defense cost is real');
  assert.equal(message.flags[SYSTEM_ID].turnSerial, 0, 'two actions are still the same tracker turn');
  await assert.rejects(declare(true), /one extra action/);
  game.combat.round = 2;
  await runCommand('socialClock', {});
  assert.equal(message.flags[SYSTEM_ID].turnSerial, 2);
});

test('three successful combat-finishing Befriend encounters persist all three friendship levels', async (t) => {
  const w = await setup(t);
  for (let level = 1; level <= 3; level++) {
    const message = level === 1 ? w.message : await w.start();
    const data = clone(message.flags[SYSTEM_ID]);
    data.participants[1].resolve = 1;
    await message.update({ [`flags.${SYSTEM_ID}`]: data });
    await runCommand('socialDeclare', {
      messageUuid: message.uuid,
      actorUuid: w.attacker.uuid,
      move: 'befriend',
      targetUuids: [w.target.uuid],
      values: { manualDice: '9' },
    });
    w.enqueue(['1d6', 2]);
    await runCommand('socialDefense', {
      messageUuid: message.uuid,
      actorUuid: w.target.uuid,
      defense: 'ignore',
      values: { manualDice: '2' },
    });
    assert.equal(w.target.system.social.relationships[0].friendship, level);
  }
  const display = w.runtime.socialActorDisplay(w.target);
  assert.equal(display.relationships[0].otherName, w.attacker.name);
  assert.equal(display.relationships[0].friendshipLabel, 'Blood-brother');
});

test('Blindly Stubborn rerolls a failed human Resist Coercion, keeps the better result and consumes its actual session budget', async (t) => {
  const w = await setup(t);
  await w.target.update({ 'system.race': 'human' });
  await w.declare('deceive');
  w.enqueue(['1d10', 2]);
  await w.defend('ignore', { manualDice: '2', stubborn: true, rerollDice: '10, 4' });
  assert.equal(w.state().history[0].targets[0].defense.check.total, 24);
  assert.equal(w.target.flags[SYSTEM_ID].socialStubbornUses, 1);
  assert.equal(w.state().participants[0].resolve, 18);
  await w.ruling('resetStubborn', {}, w.target);
  assert.equal(w.target.flags[SYSTEM_ID].socialStubbornUses, 0);
});

test('successful Disengage follows the recorded scope and deals no Resolve damage', async (t) => {
  const w = await setup(t, { conventions: { disengage: 'encounter' } });
  await w.declare('deceive', { manualDice: '2' });
  await w.defend('disengage', { manualDice: '9' });
  assert.equal(w.state().status, 'disengaged');
  assert(w.state().participants.every((row) => row.resolve === 25));
});

test('stale and unauthorized requests cannot spend Luck or rewrite a completed defense', async (t) => {
  const w = await setup(t);
  const revision = w.state().revision;
  await w.declare();
  const before = clone(w.attacker._source);
  await assert.rejects(
    runCommand('socialDeclare', {
      messageUuid: w.message.uuid,
      revision,
      actorUuid: w.attacker.uuid,
      move: 'persuade',
      targetUuids: [w.target.uuid],
      values: { luck: 4, manualDice: '9' },
    }),
    /changed/
  );
  assert.deepEqual(w.attacker._source, before);
  const oldPermission = w.target.testUserPermission;
  w.target.testUserPermission = () => false;
  await assert.rejects(w.defend(), /own this actor/);
  w.target.testUserPermission = oldPermission;
  w.enqueue(['1d6', 2]);
  await w.defend();
  await assert.rejects(w.defend(), /pending verbal defense/);
});
