import test from 'node:test';
import assert from 'node:assert/strict';
import { workflow, clone } from './workflow-fixture.mjs';
import { magicItemData } from '../../module/witcher/magic-catalog.js';
import { SYSTEM_ID } from '../../module/witcher/config.js';
import { runCommand } from '../../module/witcher/authority.js';

async function magicWorkflow(t) {
  const w = await workflow(t);
  const oldConfig = globalThis.CONFIG;
  t.after(() => {
    if (oldConfig) globalThis.CONFIG = oldConfig;
    else delete globalThis.CONFIG;
  });
  globalThis.CONFIG = {
    Canvas: {
      polygonBackends: { sight: { testCollision: () => false }, move: { testCollision: () => false } },
    },
  };
  const scene = {
    id: 'unit',
    uuid: 'Scene.unit',
    grid: { size: 100, distance: 2, units: 'm' },
    tokens: new w.Collection(),
    regions: new w.Collection(),
  };
  game.scenes = new w.Collection([[scene.id, scene]]);
  game.actors = new w.Collection([
    [w.attacker.id, w.attacker],
    [w.target.id, w.target],
  ]);
  function place(actor, x = 0, y = 0) {
    const id = actor.id,
      token = {
        id,
        uuid: `Scene.unit.Token.${id}`,
        parent: scene,
        actor,
        name: actor.name,
        x,
        y,
        width: 1,
        height: 1,
        elevation: 0,
        flags: {},
        getMovementOrigin() {
          return { x: this.x + 50, y: this.y + 50, elevation: 0 };
        },
        getSize() {
          return { width: 100, height: 100 };
        },
        async update(changes) {
          for (const [k, v] of Object.entries(changes)) {
            if (k.startsWith('flags.')) {
              this.flags[SYSTEM_ID] ??= {};
              this.flags[SYSTEM_ID][k.split('.').at(-1)] = v;
            } else this[k] = v;
          }
          return this;
        },
      };
    scene.tokens.set(id, token);
    w.docs.set(token.uuid, token);
    return token;
  }
  const source = place(w.attacker),
    target = place(w.target, 100);
  await w.attacker.update({
    'system.race': 'human',
    'system.vigor': 25,
    'system.magic': { tradition: 'druid', roundKey: '', spent: 0, coneAngle: 90, exhaustedRecovery: 0 },
  });
  await w.target.update({ 'system.magic': { tradition: '', roundKey: '', spent: 0, exhaustedRecovery: 0 } });
  const runtime = await import('../../module/witcher/magic-runtime.js');
  runtime.registerMagicCommands();
  const { BASIC_SPELL_KEYS } = await import('../../module/witcher/magic-support.js');
  const { IMPLEMENTED_MAGIC } = await import('../../module/witcher/magic-state.js');
  const keys = ['blessing-of-healing', 'healing-rest', 'miracle-of-lebioda'];
  const existing = keys.map((key) => [key, BASIC_SPELL_KEYS.has(key), IMPLEMENTED_MAGIC.has(key)]);
  for (const key of keys) {
    BASIC_SPELL_KEYS.add(key);
    IMPLEMENTED_MAGIC.add(key);
  }
  t.after(() => {
    for (const [key, basic, implemented] of existing) {
      if (!basic) BASIC_SPELL_KEYS.delete(key);
      if (!implemented) IMPLEMENTED_MAGIC.delete(key);
    }
  });
  const { registerContinuingMagicRuntime } = await import('../../module/witcher/magic-ongoing-runtime.js');
  registerContinuingMagicRuntime();
  const { turnIdentity } = await import('../../module/witcher/runtime.js');
  async function learn(key, actor = w.attacker) {
    const [item] = await actor.createEmbeddedDocuments('Item', [magicItemData(key)]);
    return item;
  }
  async function cast(item, values = {}, targetUuids = [target.uuid]) {
    return runCommand('magicCast', {
      actorUuid: w.attacker.uuid,
      itemId: item.id,
      expected: runtime.magicFingerprint(item),
      turn: turnIdentity(),
      tokenUuid: source.uuid,
      targetUuids,
      values: { power: item.system.magic.key === 'blessing-of-healing' ? 5 : 16, manualDice: '5', ...values },
    });
  }
  const accept = (message) =>
    runCommand('magicDefense', {
      messageUuid: message.uuid,
      targetUuid: target.uuid,
      turn: turnIdentity(),
      values: { defense: 'accept' },
    });
  const applyMagic = (message, targetUuid) =>
    runCommand('magicApply', { messageUuid: message.uuid, targetUuid });
  return {
    ...w,
    source,
    targetToken: target,
    scene,
    place,
    learn,
    cast,
    accept,
    applyMagic,
    turnIdentity,
    runtime,
  };
}

import { woundItemData } from '../../module/witcher/wound-catalog.js';
import { woundModifiers } from '../../module/witcher/wounds.js';
import { resolveWoundArm } from '../../module/witcher/wound-rules.js';
import { tickMagicLifecycle, magicalStunRecovery } from '../../module/witcher/magic-lifecycle.js';
import { activeHealingRest } from '../../module/witcher/magic-healing-extra.js';

const wound = async (actor, key, fields = {}) =>
  (
    await actor.createEmbeddedDocuments('Item', [
      woundItemData({ key, location: key === 'deadly-1' ? 'leftArm' : 'leftLeg', ...fields }),
    ])
  )[0];
const castApply = async (w, item, values = {}) => {
  const card = await w.cast(item, values);
  await w.accept(card);
  await w.applyMagic(card, w.targetToken.uuid);
  return card;
};

test('Blessing critical mode spends four actual castings and starts the normal BODY recovery clock without HP healing', async (t) => {
  const w = await magicWorkflow(t),
    spell = await w.learn('blessing-of-healing');
  const injury = await wound(w.target, 'simple-0');
  await w.target.update({ 'system.hp.value': 8 });
  for (let i = 1; i <= 4; i++) {
    game.time.worldTime = (i - 1) * 3;
    await castApply(w, spell, { choices: { mode: 'critical', wound: injury.uuid }, manualDice: '6' });
    assert.equal(injury.system.wound.magicUses, i);
    assert.equal(w.target.system.hp.value, 8);
    assert.equal(w.attacker.system.sta.value, 25 - i * 5);
    assert.equal(w.attacker.system.effects.length, 0, 'Critical uses do not start an upkeep/HP effect');
  }
  assert.equal(injury.system.wound.treatment, 'treated');
  assert.equal(injury.system.wound.daysRemaining, 3, 'Core 174 BODY 5 / simple injury');
});

test('Blessing critical casting must exceed DC; invalid target wound fails before STA is spent', async (t) => {
  const w = await magicWorkflow(t),
    spell = await w.learn('blessing-of-healing');
  const injury = await wound(w.target, 'simple-0');
  await castApply(w, spell, { choices: { mode: 'critical', wound: injury.uuid }, manualDice: '4' });
  assert.equal(injury.system.wound.magicUses ?? 0, 0, '14 ties DC 14 and fails');
  assert.equal(w.attacker.system.sta.value, 20);
  const ownInjury = await wound(w.attacker, 'simple-0');
  const before = clone(w.attacker._source);
  await assert.rejects(
    w.cast(spell, { choices: { mode: 'critical', wound: ownInjury.uuid } }),
    /belonging to this healing target/
  );
  assert.deepEqual(w.attacker._source, before);
});

test('Blessing HP mode heals once per round and stops when its actual 3 STA upkeep is abandoned', async (t) => {
  const w = await magicWorkflow(t),
    spell = await w.learn('blessing-of-healing');
  await w.target.update({ 'system.hp.value': 8 });
  await castApply(w, spell, { choices: { mode: 'hp' } });
  assert.equal(w.target.system.hp.value, 8);
  assert.equal(w.attacker.system.sta.value, 20);
  game.time.worldTime = 3;
  await tickMagicLifecycle();
  const { tickMagicOngoing } = await import('../../module/witcher/magic-ongoing.js');
  await tickMagicOngoing();
  assert.equal(w.target.system.hp.value, 11);
  await tickMagicOngoing();
  assert.equal(w.target.system.hp.value, 11);
  const source = w.attacker.system.effects.find((effect) => effect.magic?.casterEffect);
  await runCommand('magicMaintain', {
    actorUuid: w.attacker.uuid,
    effectId: source.id,
    turn: w.turnIdentity(),
    values: {},
  });
  assert.equal(w.attacker.system.sta.value, 17);
  game.time.worldTime = 6;
  await tickMagicLifecycle();
  await tickMagicOngoing();
  assert.equal(w.target.system.hp.value, 14);
  game.time.worldTime = 9;
  await tickMagicLifecycle();
  await tickMagicOngoing();
  assert.equal(w.target.system.hp.value, 14);
  assert.equal(w.attacker.system.effects.length, 0);
});

test('Miracle erases a severed arm and permanent penalties with a retained restored history card', async (t) => {
  const w = await magicWorkflow(t),
    spell = await w.learn('miracle-of-lebioda');
  const injury = await wound(w.target, 'deadly-1', { treatment: 'healed' });
  await w.target.update({ 'system.hp.value': 8, 'system.conditions': ['poison'] });
  assert.throws(() => resolveWoundArm(w.target.system, [...w.target.items], 'leftArm'), /cannot perform/);
  await castApply(w, spell, { choices: { wound: injury.uuid } });
  assert.equal(w.attacker.system.sta.value, 9);
  assert.equal(w.target.system.hp.value, 8, 'Miracle does not promise HP restoration');
  assert.equal(injury.system.wound.permanent, false);
  assert.deepEqual(woundModifiers(injury.system.wound), {});
  assert.equal(resolveWoundArm(w.target.system, [...w.target.items], 'leftArm'), '');
  assert.equal(injury.flags[SYSTEM_ID].miraculousRestoration.previousWound.permanent, true);
  assert(w.target.system.conditions.includes('poison'), 'An unrelated poison condition remains');
});

test('Miracle refuses dead targets before spending STA and detects changed wounds after casting', async (t) => {
  const w = await magicWorkflow(t),
    spell = await w.learn('miracle-of-lebioda');
  const injury = await wound(w.target, 'deadly-4');
  await w.target.update({ 'system.conditions': ['dead'] });
  await assert.rejects(w.cast(spell, { choices: { wound: injury.uuid } }), /living target/);
  assert.equal(w.attacker.system.sta.value, 25);
  await w.target.update({ 'system.conditions': [] });
  const card = await w.cast(spell, { choices: { wound: injury.uuid } });
  await w.accept(card);
  await injury.update({ 'system.wound.treatment': 'stabilized' });
  await assert.rejects(w.applyMagic(card, w.targetToken.uuid), /changed after casting/);
  assert.equal(injury.system.wound.permanent, true);
  assert.equal(w.target.system.combat.applied.length, 0);
});

test('Miracle actor/item restoration rolls back if its result card cannot be saved', async (t) => {
  const w = await magicWorkflow(t),
    spell = await w.learn('miracle-of-lebioda');
  const injury = await wound(w.target, 'deadly-1');
  const card = await w.cast(spell, { choices: { wound: injury.uuid } });
  await w.accept(card);
  const before = clone(injury.toObject()),
    actorBefore = clone(w.target._source);
  w.faults.create = (data) => data.flags?.[SYSTEM_ID]?.kind === 'magic-healing-result';
  await assert.rejects(w.applyMagic(card, w.targetToken.uuid), /Injected/);
  assert.deepEqual(injury.system.toObject(), before.system);
  assert.equal(injury.flags[SYSTEM_ID]?.miraculousRestoration, undefined);
  assert.deepEqual(w.target._source, actorBefore);
  w.faults.create = null;
  await w.applyMagic(card, w.targetToken.uuid);
  assert.equal(injury.system.wound.permanent, false);
});

test('Healing Rest completes after one full day, heals treated wounds only and retains permanent penalties', async (t) => {
  const w = await magicWorkflow(t),
    spell = await w.learn('healing-rest');
  const temporary = await wound(w.target, 'simple-0', { treatment: 'treated', daysRemaining: 2 });
  const permanent = await wound(w.target, 'deadly-1', { treatment: 'treated' });
  const untreated = await wound(w.target, 'complex-0');
  await w.target.update({ 'system.hp.value': 8 });
  await castApply(w, spell);
  assert(activeHealingRest(w.target.system));
  assert(magicalStunRecovery(w.target.system).blocked);
  const { actionPlan, commitActor } = await import('../../module/witcher/runtime.js');
  assert.throws(() => actionPlan(w.target, { recovery: true }), /Healing Rest/);
  await commitActor(w.target, { 'system.hp.value': 7 });
  assert(w.target.system.conditions.includes('unconscious'), 'Damage does not wake the coma');
  game.time.worldTime = 86399;
  await tickMagicLifecycle();
  assert.equal(w.target.system.hp.value, 7);
  assert.equal(temporary.system.wound.treatment, 'treated');
  game.time.worldTime = 86400;
  await tickMagicLifecycle();
  assert.equal(w.target.system.hp.value, w.target.system.hp.max);
  assert.equal(temporary.system.wound.treatment, 'healed');
  assert.equal(permanent.system.wound.treatment, 'healed');
  assert.equal(permanent.system.wound.permanent, true);
  assert(woundModifiers(permanent.system.wound).armDisabled);
  assert.equal(untreated.system.wound.treatment, 'untreated');
  assert(!w.target.system.conditions.includes('unconscious'));
  const count = w.messages.size;
  await tickMagicLifecycle();
  assert.equal(w.messages.size, count, 'The same clock event cannot heal or announce twice');
});

test('Healing Rest clock compensation restores the coma, wound clock and HP for a safe retry', async (t) => {
  const w = await magicWorkflow(t),
    spell = await w.learn('healing-rest');
  const injury = await wound(w.target, 'simple-0', { treatment: 'treated', daysRemaining: 2 });
  await w.target.update({ 'system.hp.value': 8 });
  await castApply(w, spell);
  const before = clone(w.target._source),
    injuryBefore = clone(injury.toObject());
  game.time.worldTime = 86400;
  w.faults.create = (data) => data.flags?.[SYSTEM_ID]?.kind === 'magic-healing-rest-completed';
  await assert.rejects(tickMagicLifecycle(), /Injected/);
  assert.deepEqual(w.target._source, before);
  assert.deepEqual(injury.toObject(), injuryBefore);
  w.faults.create = null;
  await tickMagicLifecycle();
  assert.equal(injury.system.wound.treatment, 'healed');
});

test('Dispel interrupts Healing Rest without granting early recovery and preserves unrelated unconsciousness', async (t) => {
  const w = await magicWorkflow(t),
    spell = await w.learn('healing-rest');
  const injury = await wound(w.target, 'simple-0', { treatment: 'treated', daysRemaining: 2 });
  await w.target.update({ 'system.hp.value': 8, 'system.conditions': ['unconscious'] });
  const card = await castApply(w, spell);
  await w.runtime.endMagicCast(card.flags[SYSTEM_ID].castId);
  game.time.worldTime = 86400;
  await tickMagicLifecycle();
  assert.equal(w.target.system.hp.value, 8);
  assert.equal(injury.system.wound.treatment, 'treated');
  assert(w.target.system.conditions.includes('unconscious'));
});

test('Healing Rest validates every living target before casting and limits their count to Spell Casting rank', async (t) => {
  const w = await magicWorkflow(t),
    spell = await w.learn('healing-rest');
  const other = w.makeActor('Second patient');
  game.actors.set(other.id, other);
  const token = w.place(other, 200);
  await w.attacker.update({ 'system.skills.spellCasting': 2 });
  await other.update({ 'system.conditions': ['dead'] });
  await assert.rejects(w.cast(spell, {}, [w.targetToken.uuid, token.uuid]), /living target/);
  assert.equal(w.attacker.system.sta.value, 25);
  await other.update({ 'system.conditions': [] });
  const third = w.makeActor('Third patient');
  game.actors.set(third.id, third);
  const thirdToken = w.place(third, 200);
  await assert.rejects(
    w.cast(spell, {}, [w.targetToken.uuid, token.uuid, thirdToken.uuid]),
    /requires 1 to 2/
  );
  assert.equal(w.attacker.system.sta.value, 25);
  const card = await w.cast(spell, {}, [w.targetToken.uuid, token.uuid]);
  for (const target of [w.targetToken, token]) {
    await runCommand('magicDefense', {
      messageUuid: card.uuid,
      targetUuid: target.uuid,
      turn: '',
      values: { defense: 'accept' },
    });
    await w.applyMagic(card, target.uuid);
  }
  assert(activeHealingRest(w.target.system));
  assert(activeHealingRest(other.system));
  assert.equal(w.attacker.system.sta.value, 9, 'One 16 STA casting affects both patients');
});

test('Miracle restores teeth recorded by an otherwise healed critical wound', async (t) => {
  const w = await magicWorkflow(t),
    spell = await w.learn('miracle-of-lebioda');
  const injury = await wound(w.target, 'complex-4', { treatment: 'healed', extraResult: 6 });
  await castApply(w, spell, { choices: { wound: injury.uuid } });
  assert.equal(injury.system.wound.extraResult, 0);
  assert.equal(injury.flags[SYSTEM_ID].miraculousRestoration.previousWound.extraResult, 6);
  assert.deepEqual(woundModifiers(injury.system.wound), {});
});
