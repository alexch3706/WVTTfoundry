import test from 'node:test';
import assert from 'node:assert/strict';
import { workflow } from './workflow-fixture.mjs';
import { ALCHEMY_PROFILES, alchemyEffect, activeAlchemy } from '../../module/witcher/alchemy-rules.js';
import {
  alchemyArmorBonus,
  alchemyProcChance,
  alchemyRegeneration,
  alchemyEndCombatEffects,
} from '../../module/witcher/alchemy-combat-rules.js';
import { SYSTEM_ID } from '../../module/witcher/config.js';
import { derivedStats, resolveDamage, hitLocations } from '../../module/witcher/rules.js';
import { actorArmorRows } from '../../module/witcher/armor-display.js';
import { immuneTo } from '../../module/witcher/monster-rules.js';

const dose = (key) => alchemyEffect(ALCHEMY_PROFILES[key], { id: key, now: 0 });
async function effects(actor, keys) {
  await actor.update({ 'system.effects': keys.map(dose) });
}

test('Arachas recomputes every location from real inventory and Fiend ENC without modifying armor', async (t) => {
  const w = await workflow(t);
  await effects(w.target, ['arachas-decoction', 'fiend-decoction']);
  const armor = await w.importItem(w.target, 'Gambeson', { equipped: true });
  const { actorSnapshot } = await import('../../module/witcher/documents.js');
  let state = actorSnapshot(w.target),
    derived = derivedStats(state, state.items);
  const expected = Math.floor((derived.enc - derived.weight) / 10) * 2;
  assert.equal(alchemyArmorBonus(state, derived).total, expected);
  const torso = hitLocations(state).find((x) => x.id === 'torso');
  const result = resolveDamage({ raw: 100 }, state, torso, state.items);
  assert.equal(result.sp, expected + 3);
  assert.equal(result.armorChanges[0].after, 2);
  assert.equal(
    actorArmorRows(state, hitLocations(state)).find((x) => x.id === 'torso').totalSP,
    expected + 3
  );
  await armor.update({ 'system.quantity': 20 });
  state = actorSnapshot(w.target);
  derived = derivedStats(state, state.items);
  assert(alchemyArmorBonus(state, derived).total < expected);
  assert.equal(armor.system.stoppingPower, 3);
});

test('Lightning snapshots only the next committed attack, removes its toxicity and rolls back on chat failure', async (t) => {
  const w = await workflow(t),
    sword = await w.importItem(w.attacker, 'Arming Sword', { equipped: true });
  await effects(w.attacker, ['lightning', 'thunderbolt']);
  await w.attacker.update({ 'system.toxicity.value': 150 });
  w.start();
  w.faults.create = (data) => data.flags?.[SYSTEM_ID]?.kind === 'attack';
  await assert.rejects(() => w.attack(sword, { manualDice: '8' }), /Injected/);
  assert(activeAlchemy(w.attacker.system, 'lightning'));
  assert.equal(w.attacker.system.toxicity.value, 150);
  w.faults.create = null;
  const first = await w.attack(sword, { manualDice: '8' });
  assert.equal(first.flags[SYSTEM_ID].alchemyAttack.damage, 6);
  assert(!activeAlchemy(w.attacker.system, 'lightning'));
  assert.equal(w.attacker.system.toxicity.value, 75);
  w.enqueue(['2d6+4', 12]);
  await w.defend(first, { manualDice: '4' });
  assert.equal(w.damageFor(first).flags[SYSTEM_ID].request[0].raw, 18);
  const second = await w.attack(sword, { manualDice: '8' });
  assert.equal(second.flags[SYSTEM_ID].alchemyAttack.damage, 3);
});

test('accepted armor-stopped strikes suppress Swallow and stack Wyvern only once; Griffin reacts after damage', async (t) => {
  const w = await workflow(t),
    sword = await w.importItem(w.attacker, 'Arming Sword', { equipped: true });
  await effects(w.attacker, ['wyvern-decoction']);
  await effects(w.target, ['swallow', 'griffin-decoction']);
  const armor = await w.importItem(w.target, 'Gambeson', { equipped: true });
  await armor.update({ 'system.stoppingPower': 20 });
  w.start();
  const a = await w.attack(sword, { manualDice: '8' });
  w.enqueue(['2d6+4', 12]);
  await w.defend(a, { manualDice: '4' });
  const card = w.damageFor(a);
  await w.apply(card);
  assert.equal(w.target.system.hp.value, 25);
  assert.equal(w.target.system.combat.hitThisRound, true);
  assert.equal(activeAlchemy(w.attacker.system, 'wyvern-decoction').alchemy.wyvernBonus, 1);
  assert.equal(alchemyRegeneration(w.target.system, { struck: true }), 0);
  assert.equal(activeAlchemy(w.target.system, 'griffin-decoction').alchemy.armorBonus, 0);
  await assert.rejects(() => w.apply(card), /already/);
  assert.equal(activeAlchemy(w.attacker.system, 'wyvern-decoction').alchemy.wyvernBonus, 1);
  await armor.update({ 'system.stoppingPower': 0 });
  const a2 = await w.attack(sword, { manualDice: '8' });
  w.enqueue(['2d6+4', 12]);
  await w.defend(a2, { manualDice: '4' });
  await w.apply(w.damageFor(a2));
  assert.equal(activeAlchemy(w.target.system, 'griffin-decoction').alchemy.armorBonus, 2);
  assert.equal(activeAlchemy(w.attacker.system, 'wyvern-decoction').alchemy.wyvernBonus, 2);
  assert.equal(
    activeAlchemy(
      { ...w.attacker.system, effects: alchemyEndCombatEffects(w.attacker.system, 'combat') },
      'wyvern-decoction'
    ).alchemy.wyvernBonus,
    0
  );
});

test('Noon Wraith/Mongoose immunities, Cat light checks, Tempest procs end with the actual dose', async (t) => {
  const w = await workflow(t);
  await effects(w.attacker, ['noon-wraith-decoction', 'mongoose', 'cat', 'tempest']);
  for (const condition of ['stunned', 'blinded', 'prone', 'poison', 'hypnosis'])
    assert(immuneTo(w.attacker.system, condition));
  await w.attacker.update({ 'system.environment.light': 'dark' });
  assert.equal(w.attacker.skillBase('awareness').total, 10);
  assert.equal(w.attacker.skillBase('awareness', { context: { seeThroughIllusion: true } }).total, 12);
  await w.attacker.update({ 'system.environment.light': 'bright' });
  assert.equal(w.attacker.skillBase('awareness').total, 7);
  assert.equal(alchemyProcChance(w.attacker.system, 'freeze', 75), 85);
  assert.equal(alchemyProcChance(w.attacker.system, 'prone', 95), 100);
  assert.equal(alchemyProcChance(w.attacker.system, 'fire', 0), 0);
  assert.equal(alchemyProcChance(w.attacker.system, 'poison', 50), 50);
  game.time.worldTime = 7201;
  assert(!immuneTo(w.attacker.system, 'hypnosis'));
  assert(!immuneTo(w.attacker.system, 'poison'));
});

test('a halfling spends Lightning toxicity on its next attack without receiving the damage bonus', async (t) => {
  const w = await workflow(t),
    sword = await w.importItem(w.attacker, 'Arming Sword', { equipped: true });
  await w.attacker.update({
    'system.race': 'halfling',
    'system.toxicity.value': 75,
    'system.effects': [
      alchemyEffect(ALCHEMY_PROFILES.lightning, { id: 'lightning', now: 0, noBenefit: true }),
    ],
  });
  w.start();
  const a = await w.attack(sword, { manualDice: '8' });
  assert.equal(a.flags[SYSTEM_ID].alchemyAttack.damage, 0);
  assert.equal(w.attacker.system.toxicity.value, 0);
  assert.equal(w.attacker.system.effects.length, 0);
});

test('direct HP injuries trigger decoctions once while expiring temporary HP and maximum-HP clamps do not', async (t) => {
  const w = await workflow(t),
    { commitActor } = await import('../../module/witcher/runtime.js');
  await effects(w.attacker, ['griffin-decoction', 'wyvern-decoction']);
  const initial = structuredClone(w.attacker.system.effects);
  initial.find((e) => e.alchemy.key === 'wyvern-decoction').alchemy.wyvernBonus = 3;
  await w.attacker.update({ 'system.effects': initial });
  await commitActor(w.attacker, { 'system.hp.value': 18 });
  assert.equal(activeAlchemy(w.attacker.system, 'griffin-decoction').alchemy.armorBonus, 2);
  assert.equal(activeAlchemy(w.attacker.system, 'wyvern-decoction').alchemy.wyvernBonus, 0);
  const withHP = [...w.attacker.system.effects, { id: 'pool', temporaryHp: 10, modifiers: { hp: 10 } }];
  await w.attacker.update({ 'system.effects': withHP, 'system.hp.value': 28 });
  await commitActor(w.attacker, {
    'system.effects': withHP.filter((e) => e.id !== 'pool'),
    'system.hp.value': 18,
  });
  assert.equal(activeAlchemy(w.attacker.system, 'griffin-decoction').alchemy.armorBonus, 2);
  const bonus = [...w.attacker.system.effects, { id: 'anabolic', modifiers: { hp: 20 } }];
  await w.attacker.update({ 'system.effects': bonus, 'system.hp.value': 40 });
  await commitActor(w.attacker, {
    'system.effects': bonus.filter((e) => e.id !== 'anabolic'),
    'system.hp.value': 25,
  });
  assert.equal(activeAlchemy(w.attacker.system, 'griffin-decoction').alchemy.armorBonus, 2);
});

test('a saved attack from a finished combat cannot grant Wyvern bonuses in a new combat', async (t) => {
  const w = await workflow(t),
    sword = await w.importItem(w.attacker, 'Arming Sword', { equipped: true });
  await effects(w.attacker, ['wyvern-decoction']);
  w.start();
  const a = await w.attack(sword, { manualDice: '8' });
  w.enqueue(['2d6+4', 12]);
  await w.defend(a, { manualDice: '4' });
  game.combat.id = 'different-combat';
  await w.apply(w.damageFor(a));
  assert.equal(activeAlchemy(w.attacker.system, 'wyvern-decoction').alchemy.wyvernBonus, 0);
});

test('Swallow skips a struck elapsed round outside combat but resumes at the next full round', async (t) => {
  const w = await workflow(t),
    sword = await w.importItem(w.attacker, 'Arming Sword', { equipped: true });
  await effects(w.target, ['swallow']);
  await w.target.update({ 'system.hp.value': 20 });
  const armor = await w.importItem(w.target, 'Gambeson', { equipped: true });
  await armor.update({ 'system.stoppingPower': 20 });
  w.start();
  const a = await w.attack(sword, { manualDice: '8' });
  w.enqueue(['2d6+4', 12]);
  await w.defend(a, { manualDice: '4' });
  await w.apply(w.damageFor(a));
  game.combat.started = false;
  const { advanceAlchemyTime } = await import('../../module/witcher/alchemy-time.js');
  await advanceAlchemyTime(w.target, 3);
  assert.equal(w.target.system.hp.value, 20);
  await advanceAlchemyTime(w.target, 6);
  assert.equal(w.target.system.hp.value, 23);
});
