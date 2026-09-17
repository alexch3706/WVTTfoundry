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
    target = place(w.target, 200);
  await w.attacker.update({
    'system.race': 'witcher',
    'system.vigor': 7,
    'system.magic': { tradition: 'witcher', roundKey: '', spent: 0, coneAngle: 90, exhaustedRecovery: 0 },
  });
  await w.target.update({ 'system.magic': { tradition: '', roundKey: '', spent: 0, exhaustedRecovery: 0 } });
  const runtime = await import('../../module/witcher/magic-runtime.js');
  runtime.registerMagicCommands();
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
      values: { power: 1, manualDice: '5', ...values },
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
  return { ...w, source, targetToken: target, scene, place, learn, cast, accept, applyMagic, turnIdentity };
}

test('Quen spends magic STA once, absorbs before SP and allows recasting only after its pool is exhausted', async (t) => {
  const w = await magicWorkflow(t),
    quen = await w.learn('quen');
  const message = await w.cast(quen, { power: 2 });
  assert.equal(w.attacker.system.sta.value, 23);
  await w.applyMagic(message);
  assert.equal(w.attacker.system.effects[0].shieldHP, 10);
  await assert.rejects(w.cast(quen), /current Quen/);
  await assert.rejects(w.applyMagic(message), /already been applied/);
  assert.equal(w.attacker.system.sta.value, 23);
});

test('casting and its chat persistence are compensated together on failure', async (t) => {
  const w = await magicWorkflow(t),
    quen = await w.learn('quen');
  const before = clone(w.attacker._source);
  w.faults.create = (data) => data.flags?.[SYSTEM_ID]?.kind === 'magic';
  await assert.rejects(w.cast(quen, { power: 3, luck: 1 }), /Injected/);
  assert.deepEqual(w.attacker._source, before);
});

test('Axii opposed resistance supports manually entered dice and refuses a repeated defense', async (t) => {
  const w = await magicWorkflow(t),
    axii = await w.learn('axii');
  const message = await w.cast(axii, { power: 3, manualDice: '7' });
  await runCommand('magicDefense', {
    messageUuid: message.uuid,
    targetUuid: w.targetToken.uuid,
    turn: w.turnIdentity(),
    values: { defense: 'resistMagic', manualDice: '3' },
  });
  assert.equal(message.flags[SYSTEM_ID].targets[0].status, 'ready');
  await w.applyMagic(message, w.targetToken.uuid);
  assert(w.target.system.conditions.includes('stunned'));
  assert.equal(w.target.system.effects[0].magic.stunModifier, -2);
  await assert.rejects(
    runCommand('magicDefense', {
      messageUuid: message.uuid,
      targetUuid: w.targetToken.uuid,
      turn: w.turnIdentity(),
      values: { defense: 'resistMagic', manualDice: '9' },
    }),
    /already/
  );
});

test('Vigor is accumulated across a round; only new excess costs HP', async (t) => {
  const w = await magicWorkflow(t),
    axii = await w.learn('axii');
  w.start();
  await w.cast(axii, { power: 5 });
  await assert.rejects(w.cast(axii, { power: 4, extra: true }), /10 HP/);
  await w.cast(axii, { power: 4, extra: true, overdraw: true });
  assert.equal(w.attacker.system.sta.value, 13);
  assert.equal(w.attacker.system.hp.value, 15);
  assert.equal(w.attacker.system.magic.spent, 9);
});

test('Somne rejects unprinted power before rolling or spending', async (t) => {
  const w = await magicWorkflow(t),
    somne = await w.learn('somne');
  const before = clone(w.attacker._source);
  await assert.rejects(w.cast(somne, { power: 3 }), /Choose one/);
  assert.deepEqual(w.attacker._source, before);
});

test('shared Active Shield spends the caster pool once when its companion is hit, and ends protection when separated', async (t) => {
  const w = await magicWorkflow(t),
    sign = await w.learn('active-shield');
  w.targetToken.x = 100;
  const cast = await w.cast(sign, { power: 1 });
  await w.applyMagic(cast);
  const shield = w.attacker.system.effects.find((ef) => ef.magic.key === 'active-shield');
  await runCommand('magicProtect', {
    actorUuid: w.attacker.uuid,
    effectId: shield.id,
    targetUuid: w.targetToken.uuid,
  });
  const { magicDamageSnapshot, commitDamage } = await import('../../module/witcher/magic-shields.js');
  const { resolveDamageSequence, hitLocations } = await import('../../module/witcher/rules.js');
  const { planDamageChanges } = await import('../../module/witcher/combat.js');
  let state = magicDamageSnapshot(w.target);
  const result = resolveDamageSequence(
    [{ raw: 6, type: 'slashing', location: 'torso' }],
    state,
    hitLocations(state),
    state.items
  );
  assert.equal(result[0].damage, 0);
  assert.equal(result[0].shield.ownerUuid, w.attacker.uuid);
  await commitDamage(w.target, planDamageChanges(w.target, result));
  assert.equal(w.attacker.system.effects.find((ef) => ef.id === shield.id).shieldHP, 4);
  assert.equal(w.target.system.hp.value, 25);
  w.targetToken.x = 300;
  state = magicDamageSnapshot(w.target);
  assert.equal(
    resolveDamageSequence(
      [{ raw: 6, type: 'slashing', location: 'torso' }],
      state,
      hitLocations(state),
      state.items
    )[0].shield,
    null
  );
});

test('damage wakes Somne, while a wholly absorbed hit preserves sleep and suppresses critical injury', async (t) => {
  const w = await magicWorkflow(t);
  const { resolveDamageSequence, hitLocations } = await import('../../module/witcher/rules.js');
  const { planDamageChanges } = await import('../../module/witcher/combat.js');
  await w.target.update({
    'system.conditions': ['stunned'],
    'system.effects': [
      {
        id: 'sleep',
        conditions: ['stunned'],
        magic: { key: 'somne', sleeping: true, addedConditions: ['stunned'] },
      },
      { id: 'shield', shieldHP: 10, magic: { key: 'quen' } },
    ],
  });
  let state = w.target.system;
  let results = resolveDamageSequence(
    [{ raw: 6, type: 'slashing', location: 'torso', criticalBonus: 3 }],
    state,
    hitLocations(state)
  );
  assert.equal(results[0].criticalBonus, 0);
  assert.equal(results[0].clearsStun, false);
  let planned = planDamageChanges(w.target, results);
  assert(planned.actor['system.conditions'].includes('stunned'));
  assert(planned.actor['system.effects'].some((ef) => ef.id === 'sleep'));
  results = resolveDamageSequence(
    [{ raw: 16, type: 'slashing', location: 'torso' }],
    state,
    hitLocations(state)
  );
  planned = planDamageChanges(w.target, results);
  assert(!planned.actor['system.conditions'].includes('stunned'));
  assert(!planned.actor['system.effects'].some((ef) => ef.id === 'sleep'));
});

test('Axii recovery uses its penalty and removes the actual source effect on success', async (t) => {
  const w = await magicWorkflow(t),
    axii = await w.learn('axii');
  const cast = await w.cast(axii, { power: 3 });
  await w.accept(cast);
  await w.applyMagic(cast, w.targetToken.uuid);
  const effect = w.target.system.effects[0];
  w.enqueue(['1d10', 3]);
  await runCommand('magicResist', { actorUuid: w.target.uuid, effectId: effect.id });
  assert(w.target.system.conditions.includes('stunned'), '3 is not strictly below STUN5 - Axii2');
  game.time.worldTime += 3;
  w.enqueue(['1d10', 2]);
  await runCommand('magicResist', { actorUuid: w.target.uuid, effectId: effect.id });
  assert(!w.target.system.conditions.includes('stunned'));
  assert(!w.target.system.effects.some((ef) => ef.id === effect.id));
});

test('ordinary Stun recovery cannot end Somne or magical exhaustion before twenty recovered STA', async (t) => {
  const w = await magicWorkflow(t),
    { save } = await import('../../module/witcher/runtime.js');
  await w.target.update({
    'system.conditions': ['stunned'],
    'system.effects': [{ id: 'sleep', magic: { key: 'somne', sleeping: true } }],
  });
  assert.equal(await save(w.target, 'stun'), false);
  await w.target.update({ 'system.effects': [], 'system.magic.exhaustedRecovery': 15 });
  assert.equal(await save(w.target, 'stun'), false);
  assert.equal(w.rolls.length, 0);
  assert(w.target.system.conditions.includes('stunned'));
});

test('Aenye runs through its opposed cast, damage card, fire chance, and idempotent HP application', async (t) => {
  const w = await magicWorkflow(t);
  await w.attacker.update({ 'system.race': 'human', 'system.magic.tradition': 'mage' });
  const aenye = await w.learn('aenye'),
    cast = await w.cast(aenye, { power: 5, manualDice: '9' });
  await runCommand('magicDefense', {
    messageUuid: cast.uuid,
    targetUuid: w.targetToken.uuid,
    turn: w.turnIdentity(),
    values: { defense: 'dodge', manualDice: '2' },
  });
  w.enqueue(['1d10', 6], ['4d6', 14], ['1d100', 50]);
  const card = await w.applyMagic(cast, w.targetToken.uuid);
  assert.equal(card.flags[SYSTEM_ID].kind, 'damage');
  assert.equal(card.flags[SYSTEM_ID].wound, null, 'fire magic does not inflict physical criticals');
  await w.apply(card);
  assert(w.target.system.conditions.includes('fire'));
  assert.equal(w.target.system.hp.value, 18);
  await assert.rejects(w.apply(card), /already/);
});

test('Glamour applies its actual social modifiers and recorded hours, then expires through lifecycle', async (t) => {
  const w = await magicWorkflow(t);
  await w.attacker.update({ 'system.race': 'human', 'system.magic.tradition': 'mage' });
  const item = await w.learn('glamour'),
    cast = await w.cast(item, { power: 5 });
  w.enqueue(['1d6', 2]);
  await w.applyMagic(cast);
  const buff = w.attacker.system.effects.find((ef) => ef.magic?.key === 'glamour');
  assert.equal(buff.expires, 7200);
  assert.equal(buff.modifiers.charisma, 3);
  assert.equal(w.attacker.skillBase('charisma').total, 13);
  const { tickMagicLifecycle } = await import('../../module/witcher/magic-lifecycle.js');
  game.time.worldTime = 7200;
  await tickMagicLifecycle();
  assert.equal(w.attacker.skillBase('charisma').total, 10);
});

test('Light Feet changes displayed movement once and paid upkeep persists the source', async (t) => {
  const w = await magicWorkflow(t);
  await w.attacker.update({
    'system.race': 'human',
    'system.magic.tradition': 'mage',
    'system.overrides.run': 10,
    'system.overrides.leap': 2,
  });
  const spell = await w.learn('light-feet');
  const message = await w.cast(spell, { power: 2 }, []);
  await w.applyMagic(message);
  assert.equal(w.attacker.system.derived.stats.spd, 10);
  assert.equal(w.attacker.system.derived.run, 25);
  assert.equal(w.attacker.system.derived.leap, 5);
  const marker = w.attacker.system.effects.find((effect) => effect.magic?.casterEffect);
  assert(marker);
  game.time.worldTime += 3;
  game.combat = null;
  const before = w.attacker.system.sta.value;
  await runCommand('magicMaintain', {
    actorUuid: w.attacker.uuid,
    effectId: marker.id,
    turn: '',
    values: {},
  });
  assert.equal(w.attacker.system.sta.value, before - 2);
  assert.equal(
    w.attacker.system.effects.find((effect) => effect.id === marker.id).magic.paidAt,
    game.time.worldTime
  );
});

test('Anialwch bypasses armor and Quen and uses separate dice for HP and STA', async (t) => {
  const w = await magicWorkflow(t);
  await w.attacker.update({ 'system.race': 'human', 'system.magic.tradition': 'mage', 'system.vigor': 20 });
  await w.target.update({ 'system.effects': [{ id: 'ward', shieldHP: 100, magic: { key: 'quen' } }] });
  const spell = await w.learn('anialwch');
  const message = await w.cast(spell, { power: 8 });
  await w.accept(message);
  w.rolls.push({ formula: '4d6', total: 14 }, { formula: '4d6', total: 11 });
  await w.applyMagic(message, w.targetToken.uuid);
  assert.equal(w.target.system.sta.value, 14);
  const card = [...game.messages.values()].find((entry) => entry.flags?.[SYSTEM_ID]?.kind === 'damage');
  assert.equal(card.flags[SYSTEM_ID].summary[0].damage, 14);
  assert.equal(card.flags[SYSTEM_ID].summary[0].shield, null);
  assert.equal(card.flags[SYSTEM_ID].summary[0].location.multiplier, 1);
});

test('Silverlight stops one lethal reduction and direct damage wakes Somne', async (t) => {
  const w = await magicWorkflow(t);
  const { commitActor } = await import('../../module/witcher/runtime.js');
  await w.target.update({
    'system.effects': [
      {
        id: 'moon',
        magic: { operation: { type: 'modifier', rule: { key: 'silverlight', preventDeathUses: 1 } } },
      },
      { id: 'sleep', conditions: ['stunned'], magic: { sleeping: true, addedConditions: ['stunned'] } },
    ],
    'system.conditions': ['stunned'],
  });
  await commitActor(w.target, { 'system.hp.value': -10, 'system.pendingDeathSaves': 1 });
  assert.equal(w.target.system.hp.value, 1);
  assert.equal(w.target.system.pendingDeathSaves, 0);
  assert.equal(w.target.system.effects.find((effect) => effect.id === 'moon').magic.preventDeathUsed, 1);
  assert(!w.target.system.conditions.includes('stunned'));
  await commitActor(w.target, { 'system.hp.value': -5, 'system.pendingDeathSaves': 1 });
  assert.equal(w.target.system.hp.value, -5);
  assert.equal(w.target.system.pendingDeathSaves, 1);
});

test('Blessed Weapon updates the selected real inventory item and restores its property at expiry', async (t) => {
  const w = await magicWorkflow(t);
  await w.attacker.update({ 'system.race': 'human', 'system.magic.tradition': 'priest' });
  const [weapon] = await w.target.createEmbeddedDocuments('Item', [
    { name: 'Test sword', type: 'weapon', system: { category: 'sword', properties: { balanced: false } } },
  ]);
  const spell = await w.learn('blessed-weapon');
  const message = await w.cast(spell, { power: 2, choices: { weapon: weapon.uuid } });
  await w.accept(message);
  await w.applyMagic(message, w.targetToken.uuid);
  assert.equal(weapon.system.properties.balanced, true);
  assert.equal(weapon.flags[SYSTEM_ID].magicItemEffects[0].expiresAt, game.time.worldTime + 1800);
  const { tickWorldItemMagic } = await import('../../module/witcher/magic-world-runtime.js');
  game.time.worldTime += 1800;
  await tickWorldItemMagic();
  assert.equal(weapon.system.properties.balanced, false);
  assert.equal(weapon.flags[SYSTEM_ID].magicItemEffects.length, 0);
});

async function plantingWorkflow(t) {
  const w = await magicWorkflow(t);
  await w.attacker.update({ 'system.race': 'human', 'system.magic.tradition': 'mage' });
  w.scene.levels = new Map([['ground', { id: 'ground', isView: true }]]);
  canvas.ready = true;
  canvas.scene = w.scene;
  for (const token of w.scene.tokens) {
    token.level = 'ground';
    token.testInsideRegion = () => false;
  }
  CONFIG.Region = {
    documentClass: class {
      constructor(data, { parent }) {
        Object.assign(this, data, { parent });
      }
      updateShapeConstraints() {}
    },
  };
  const [seed] = await w.attacker.createEmbeddedDocuments('Item', [
    { name: 'Verbena seed', type: 'gear', system: { quantity: 1, carried: true } },
  ]);
  const item = await w.learn('codi-bywyd');
  const { magicFingerprint } = await import('../../module/witcher/magic-runtime.js');
  const castPlant = (x = 250, choices = {}) =>
    runCommand('magicCast', {
      actorUuid: w.attacker.uuid,
      itemId: item.id,
      expected: magicFingerprint(item),
      turn: w.turnIdentity(),
      tokenUuid: w.source.uuid,
      targetUuids: [],
      area: { origin: { x: 50, y: 50, elevation: 0, level: 'ground' }, placement: { x, y: 50 } },
      values: {
        power: 2,
        manualDice: '5',
        choices: { plant: 'Verbena', seed: seed.uuid, smallNonTreePlant: true, ...choices },
      },
    });
  return { ...w, seed, castPlant };
}

test('Codi Bywyd consumes the actual seed at the selected 4m point and does not grow a tree or invent harvest yield', async (t) => {
  const w = await plantingWorkflow(t);
  const stamina = w.attacker.system.sta.value;
  await assert.rejects(w.castPlant(251), /range/);
  await assert.rejects(w.castPlant(250, { smallNonTreePlant: false }), /prerequisite/);
  assert.equal(w.attacker.system.sta.value, stamina);
  const message = await w.castPlant();
  assert.equal(w.attacker.system.sta.value, stamina - 2);
  await w.applyMagic(message);
  assert.equal(w.seed.system.quantity, 0);
  const plant = [...w.attacker.items].find((item) => item.name === 'Mature Verbena');
  assert(plant);
  assert.equal(plant.system.quantity, 1);
  assert.equal(plant.system.carried, false);
  assert.equal(plant.flags[SYSTEM_ID].magicWorld.position.x, 250);
  await assert.rejects(w.castPlant(), /seed/);
});

test('failed Codi application restores its seed and removes the created plant before retry', async (t) => {
  const w = await plantingWorkflow(t),
    message = await w.castPlant();
  w.faults.update = (document) => document.uuid === message.uuid;
  await assert.rejects(w.applyMagic(message), /Injected/);
  assert.equal(w.seed.system.quantity, 1);
  assert.equal(
    w.attacker.items.some((item) => item.name === 'Mature Verbena'),
    false
  );
  w.faults.update = null;
  await w.applyMagic(message);
  assert.equal(w.seed.system.quantity, 0);
  assert.equal(w.attacker.items.filter((item) => item.name === 'Mature Verbena').length, 1);
});
