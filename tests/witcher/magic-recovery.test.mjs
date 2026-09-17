import test from 'node:test';
import assert from 'node:assert/strict';
import { workflow } from './workflow-fixture.mjs';
import { SYSTEM_ID } from '../../module/witcher/config.js';
import { magicInfo } from '../../module/witcher/magic-catalog.js';
import { spellEffectPlan } from '../../module/witcher/magic-effects.js';
import { installMagicOngoing } from '../../module/witcher/magic-ongoing.js';
import { registerMagicRecovery } from '../../module/witcher/magic-recovery.js';
import { runCommand } from '../../module/witcher/authority.js';
import { save } from '../../module/witcher/runtime.js';

async function setup(t) {
  const w = await workflow(t),
    actor = w.target;
  const { registerContinuingMagicRuntime } = await import('../../module/witcher/magic-ongoing-runtime.js');
  game.actors = new w.Collection([
    [w.attacker.id, w.attacker],
    [actor.id, actor],
  ]);
  game.scenes = new w.Collection();
  const magic = magicInfo('cursed-illness');
  const dc = actor.skillBase('endurance').total + 5;
  await actor.update({
    'system.conditions': ['stunned'],
    'system.effects': [
      {
        id: 'illness-condition',
        conditions: ['stunned'],
        magic: { key: magic.key, castId: 'illness', addedConditions: ['stunned'] },
      },
    ],
  });
  registerContinuingMagicRuntime();
  registerMagicRecovery();
  const installed = await installMagicOngoing(
    actor,
    [spellEffectPlan(magic, { castTotal: dc, power: 4 }).operations[1]],
    { caster: w.attacker, castId: 'illness', castTotal: dc, sourceMagic: magic }
  );
  w.start();
  game.combat.combatant = { actor };
  const request = () =>
    runCommand('magicRecoveryRequest', { actorUuid: actor.uuid, effectId: installed.effect.id });
  const resolve = (manualDice) => {
    const effect = actor.system.effects.find((row) => row.id === installed.effect.id);
    const pending = Object.values(effect.magic.ongoing.pending)[0];
    return runCommand('magicOngoingSave', {
      actorUuid: actor.uuid,
      sourceUuid: actor.uuid,
      effectId: effect.id,
      pendingId: pending.id,
      values: { manualDice },
    });
  };
  return { ...w, actor, request, resolve, installed };
}

test('illness sheet command creates one real save; tied DC fails, normal action is paid, later success removes only its source', async (t) => {
  const w = await setup(t);
  await w.request();
  const before = w.messages.size;
  await w.request();
  assert.equal(w.messages.size, before);
  await w.resolve('5');
  assert(w.actor.system.conditions.includes('stunned'));
  assert.equal(w.actor.system.combat.actions, 1);
  await w.request();
  await assert.rejects(w.resolve('9'), /action/i);
  game.combat.round++;
  await w.actor.update({
    'system.effects': [
      ...w.actor.system.effects,
      { id: 'unrelated', conditions: ['poison'], key: 'Unrelated poison' },
    ],
    'system.conditions': [...w.actor.system.conditions, 'poison'],
  });
  await w.resolve('6');
  assert.equal(w.actor.system.conditions.includes('stunned'), false);
  assert(w.actor.system.conditions.includes('poison'));
  assert(w.actor.system.effects.some((effect) => effect.id === 'unrelated'));
});
test('ordinary stun recovery cannot bypass the invocation’s required Endurance check', async (t) => {
  const w = await setup(t);
  const result = await save(w.actor, 'stun');
  assert.equal(result, false);
  assert(w.actor.system.conditions.includes('stunned'));
  assert.equal(w.rolls.length, 0);
});
test('failed recovery prompt persistence leaves no phantom pending check', async (t) => {
  const w = await setup(t);
  w.faults.create = () => true;
  await assert.rejects(w.request(), /Injected/);
  const source = w.actor.system.effects.find((effect) => effect.id === w.installed.effect.id);
  assert.deepEqual(source.magic.ongoing.pending, {});
  assert.equal(w.actor.system.combat.actions, 0);
});
