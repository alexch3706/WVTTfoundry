import test from 'node:test';
import assert from 'node:assert/strict';
import { workflow, clone } from './workflow-fixture.mjs';
import { SYSTEM_ID } from '../../module/witcher/config.js';
import { runCommand } from '../../module/witcher/authority.js';
import { alchemyEffect, ALCHEMY_PROFILES } from '../../module/witcher/alchemy-rules.js';

async function setup(t) {
  const w = await workflow(t),
    runtime = await import('../../module/witcher/alchemy-exertion.js');
  runtime.registerAlchemyExertion();
  const act = (mode, options = {}) =>
    runCommand('alchemyExertion', { actorUuid: w.attacker.uuid, mode, options });
  await act('configure', {
    breathSeconds: 10,
    runIntervalSeconds: 6,
    runStaCost: 2,
    ruling: 'Test table: ten-second base breath and two STA per six running seconds',
  });
  return { ...w, runtime, act };
}

test('Killer Whale gives actual 50% longer breath and exhaustion deals nonstacking round damage once', async (t) => {
  const w = await setup(t);
  await w.attacker.update({
    'system.effects': [alchemyEffect(ALCHEMY_PROFILES['killer-whale'], { id: 'whale', now: 0 })],
  });
  await w.act('holdBreath', { cause: 'drowning' });
  game.time.worldTime = 12;
  await w.runtime.advanceAlchemyExertion(w.attacker);
  assert(!w.attacker.system.conditions.includes('suffocating'));
  assert.equal(w.attacker.flags[SYSTEM_ID].alchemyExertion.breath.remainingSeconds, 2);
  game.time.worldTime = 15;
  await w.runtime.advanceAlchemyExertion(w.attacker);
  assert(w.attacker.system.conditions.includes('suffocating'));
  assert.equal(w.attacker.system.hp.value, 25);
  game.time.worldTime = 21;
  await w.runtime.advanceAlchemyExertion(w.attacker);
  assert.equal(w.attacker.system.hp.value, 19);
  await w.runtime.advanceAlchemyExertion(w.attacker);
  assert.equal(w.attacker.system.hp.value, 19);
  await w.act('restoreAir');
  assert(!w.attacker.system.conditions.includes('suffocating'));
  assert.equal(w.attacker.flags[SYSTEM_ID].alchemyExertion.breath.active, false);
});

test('Killer Whale expires during breath holding without granting its bonus to later elapsed seconds', async (t) => {
  const w = await setup(t),
    effect = alchemyEffect(ALCHEMY_PROFILES['killer-whale'], { id: 'whale', now: 0 });
  effect.expires = 6;
  await w.attacker.update({ 'system.effects': [effect] });
  await w.act('holdBreath', { cause: 'airless' });
  game.time.worldTime = 12;
  await w.runtime.advanceAlchemyExertion(w.attacker);
  assert.equal(w.attacker.flags[SYSTEM_ID].alchemyExertion.breath.remainingSeconds, 0);
  assert.equal(w.attacker.flags[SYSTEM_ID].alchemyExertion.breath.exhaustedAt, 12);
});

test('Werewolf waives real timed long-running STA while active, then normal configured cost resumes', async (t) => {
  const w = await setup(t),
    effect = alchemyEffect(ALCHEMY_PROFILES['werewolf-decoction'], { id: 'wolf', now: 0 });
  effect.expires = 6;
  await w.attacker.update({ 'system.effects': [effect] });
  await w.act('startRunning');
  game.time.worldTime = 6;
  await w.runtime.advanceAlchemyExertion(w.attacker);
  assert.equal(w.attacker.system.sta.value, 25);
  game.time.worldTime = 12;
  await w.runtime.advanceAlchemyExertion(w.attacker);
  assert.equal(w.attacker.system.sta.value, 23);
  await w.runtime.advanceAlchemyExertion(w.attacker);
  assert.equal(w.attacker.system.sta.value, 23);
  await w.act('stopRunning');
  assert.equal(w.attacker.flags[SYSTEM_ID].alchemyExertion.running.active, false);
});

test('baseline is GM owned and elapsed exhaustion/chat failure restores clock and HP for safe retry', async (t) => {
  const w = await setup(t);
  await w.act('holdBreath', { cause: 'drowning' });
  const before = clone(w.attacker.toObject());
  game.time.worldTime = 16;
  w.faults.create = () => true;
  await assert.rejects(w.runtime.advanceAlchemyExertion(w.attacker), /Injected message/);
  assert.equal(w.attacker.system.hp.value, before.system.hp.value);
  assert.deepEqual(w.attacker.flags, before.flags);
  assert(!w.attacker.system.conditions.includes('suffocating'));
  w.faults.create = null;
  await w.runtime.advanceAlchemyExertion(w.attacker);
  assert.equal(w.attacker.system.hp.value, 19);
});

test('restoring air preserves a separate magical suffocation source; combat clock leaves damage to the turn tick', async (t) => {
  const w = await setup(t);
  await w.attacker.update({
    'system.effects': [
      {
        id: 'spell',
        key: 'Suffocate',
        expires: 0,
        conditions: ['suffocating'],
        magic: { key: 'suffocate', addedConditions: ['suffocating'] },
      },
    ],
    'system.conditions': ['suffocating'],
  });
  await w.act('holdBreath', { cause: 'drowning' });
  w.start();
  game.time.worldTime = 16;
  await w.runtime.advanceAlchemyExertion(w.attacker);
  assert.equal(w.attacker.system.hp.value, 25);
  await w.act('restoreAir');
  assert(w.attacker.system.conditions.includes('suffocating'));
  assert(w.attacker.system.effects.some((effect) => effect.id === 'spell'));
});
