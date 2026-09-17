import test from 'node:test';
import assert from 'node:assert/strict';
import { workflow, clone } from './workflow-fixture.mjs';
import { magicItemData } from '../../module/witcher/magic-catalog.js';
import { SYSTEM_ID } from '../../module/witcher/config.js';
import { runCommand } from '../../module/witcher/authority.js';
import { readFileSync } from 'node:fs';
import { artifactItemData, amuletGrantedItems } from '../../module/witcher/magic-gear-rules.js';
import {
  makeAttachment,
  rebuildEnhancementUpdate,
  extraSlotUpdate,
  validateAttachmentTarget,
} from '../../module/witcher/enhancements.js';

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

test('an actual Core amulet must be held; one selected focus discounts STA without stacking or lowering power', async (t) => {
  const w = await magicWorkflow(t);
  await w.attacker.update({
    'system.race': 'human',
    'system.magic.tradition': 'mage',
    'system.skills.spellCasting': 9,
  });
  const catalog = JSON.parse(readFileSync(new URL('../../data/witcher/equipment.json', import.meta.url)));
  const [gem, simple] = await w.attacker.createEmbeddedDocuments(
    'Item',
    ['Amulet, Gemstone', 'Amulet, Simple'].map((name) => catalog.find((item) => item.name === name))
  );
  const equip = (item, patch) =>
    runCommand('inventory', { actorUuid: w.attacker.uuid, itemId: item.id, patch });
  const spell = await w.learn('aenye');
  await equip(gem, { equipped: true, focusUse: 'worn' });
  const before = w.attacker.system.sta.value;
  await assert.rejects(w.cast(spell, { power: 5, focusId: gem.id }), /held/);
  assert.equal(w.attacker.system.sta.value, before);
  await equip(gem, { focusUse: 'held' });
  await equip(simple, { equipped: true });
  const message = await w.cast(spell, { power: 5, focusId: gem.id });
  assert.equal(message.flags[SYSTEM_ID].power, 5);
  assert.equal(message.flags[SYSTEM_ID].staCost, 2);
  assert.equal(w.attacker.system.sta.value, before - 2);
  await assert.rejects(w.cast(spell, { power: 5, focusId: [gem.id, simple.id] }), /focus/);
  await w.attacker.update({ 'system.effects': [] });
  const dust = await w.learn('blinding-dust');
  const minimum = await w.cast(dust, { power: 3, focusId: gem.id });
  assert.equal(minimum.flags[SYSTEM_ID].staCost, 1);
});

test('a worn enchanted amulet leaves a hand free and its stored spell uses only its own Focus2', async (t) => {
  const w = await magicWorkflow(t);
  await w.attacker.update({ 'system.race': 'human', 'system.magic.tradition': 'mage' });
  const staff = await w.importItem(w.attacker, 'Crystal Staff');
  await runCommand('inventory', {
    actorUuid: w.attacker.uuid,
    itemId: staff.id,
    patch: { equipped: true, handsUsed: 1 },
  });
  const [amulet] = await w.attacker.createEmbeddedDocuments('Item', [
    artifactItemData('amulet', { storedMagic: [{ key: 'aenye' }], complete: true }),
  ]);
  await runCommand('inventory', { actorUuid: w.attacker.uuid, itemId: amulet.id, patch: { equipped: true } });
  const [spell] = await w.attacker.createEmbeddedDocuments('Item', amuletGrantedItems(amulet));
  const message = await w.cast(spell, { power: 5, focusId: staff.id });
  assert.equal(message.flags[SYSTEM_ID].staCost, 3);
  assert.equal(
    message.flags[SYSTEM_ID].focus,
    null,
    'stored amulet magic cannot borrow the held staff Greater Focus'
  );
  assert.equal(w.attacker.system.sta.value, 22);
  await runCommand('inventory', {
    actorUuid: w.attacker.uuid,
    itemId: amulet.id,
    patch: { equipped: false },
  });
  await assert.rejects(w.cast(spell, { power: 5 }), /equipped amulet/);
});

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

async function greaterFocusWorkflow(t, name = 'Crystal Staff') {
  const w = await magicWorkflow(t);
  await w.attacker.update({ 'system.race': 'human', 'system.magic.tradition': 'mage' });
  const catalog = JSON.parse(
    readFileSync(
      new URL(`../../data/witcher/${name === 'Crystal Staff' ? 'weapons' : 'relics'}.json`, import.meta.url)
    )
  );
  const [focus] = await w.attacker.createEmbeddedDocuments('Item', [
    catalog.find((item) => item.name === name),
  ]);
  await runCommand('inventory', {
    actorUuid: w.attacker.uuid,
    itemId: focus.id,
    patch: { equipped: true, handsUsed: 1 },
  });
  return { ...w, focus };
}

test('Greater Focus affects real spell defense, not its raw check; a saved DC survives inventory changes', async (t) => {
  const w = await greaterFocusWorkflow(t),
    spell = await w.learn('aenye');
  const message = await w.cast(spell, { power: 5, focusId: w.focus.id, manualDice: '5' });
  const cast = message.flags[SYSTEM_ID];
  assert.equal(cast.check.total, 15);
  assert.equal(cast.focus.defenseBonus, 2);
  assert.equal(cast.staCost, 2);
  assert.match(message.content, /defense DC 17/);
  await w.focus.update({ 'system.equipped': false, 'system.properties.greaterFocus': false });
  await runCommand('magicDefense', {
    messageUuid: message.uuid,
    targetUuid: w.targetToken.uuid,
    turn: w.turnIdentity(),
    values: { defense: 'dodge', manualDice: '6' },
  });
  assert.equal(
    message.flags[SYSTEM_ID].targets[0].status,
    'ready',
    '16 fails against saved 17, though it exceeds raw 15'
  );
  w.enqueue(['1d10', 6], ['4d6', 14], ['1d100', 80]);
  const damage = await w.applyMagic(message, w.targetToken.uuid);
  await w.apply(damage);
  assert.equal(w.target.system.hp.value, 18, 'the real hit still damages the target');
  await assert.rejects(w.cast(spell, { power: 5, focusId: w.focus.id }), /focus/i);
});

test('a tied Greater Focus defense succeeds and its +2 does not create a physical critical margin', async (t) => {
  const w = await greaterFocusWorkflow(t),
    spell = await w.learn('cenlly-graig');
  const first = await w.cast(spell, { power: 3, focusId: w.focus.id, manualDice: '5' });
  await runCommand('magicDefense', {
    messageUuid: first.uuid,
    targetUuid: w.targetToken.uuid,
    turn: w.turnIdentity(),
    values: { defense: 'dodge', manualDice: '7' },
  });
  assert.equal(first.flags[SYSTEM_ID].targets[0].status, 'defended');
  const second = await w.cast(spell, { power: 3, focusId: w.focus.id, manualDice: '9' });
  await runCommand('magicDefense', {
    messageUuid: second.uuid,
    targetUuid: w.targetToken.uuid,
    turn: w.turnIdentity(),
    values: { defense: 'dodge', manualDice: '3' },
  });
  w.enqueue(['1d10', 6], ['6d6', 18]);
  const damage = await w.applyMagic(second, w.targetToken.uuid);
  assert.equal(
    damage.flags[SYSTEM_ID].wound,
    null,
    'raw margin 6, not artificially raised to critical margin 8'
  );
});

test('Greater-only Moon Blade is a selectable focus with no STA discount; an unselected staff grants nothing', async (t) => {
  const w = await greaterFocusWorkflow(t, 'Moon Blade'),
    spell = await w.learn('aenye');
  const plain = await w.cast(spell, { power: 5 });
  assert.equal(plain.flags[SYSTEM_ID].focus, null);
  const focused = await w.cast(spell, { power: 5, focusId: w.focus.id });
  assert.equal(focused.flags[SYSTEM_ID].staCost, 5);
  assert.equal(focused.flags[SYSTEM_ID].focus.defenseBonus, 2);
});

test('the actual Fire-only Succubus Wand keeps its Focus discount for other elements without granting Greater Focus', async (t) => {
  const w = await greaterFocusWorkflow(t, 'Succubus’ Wand');
  const fire = await w.cast(await w.learn('aenye'), { power: 5, focusId: w.focus.id });
  assert.equal(fire.flags[SYSTEM_ID].focus.defenseBonus, 2);
  assert.equal(fire.flags[SYSTEM_ID].staCost, 1);
  const earth = await w.cast(await w.learn('cenlly-graig'), { power: 3, focusId: w.focus.id });
  assert.equal(earth.flags[SYSTEM_ID].focus.defenseBonus, 0);
  assert.equal(earth.flags[SYSTEM_ID].staCost, 1);
});

for (const [kind, manualDice, expected] of [
  ['dispel', '7', false],
  ['dispel', '8', true],
  ['heliotrope', '7', true],
]) {
  test(`Greater Focus target DC is used by actual ${kind} with die ${manualDice}`, async (t) => {
    const w = await greaterFocusWorkflow(t),
      spell = await w.learn('aenye');
    const message = await w.cast(spell, { power: 5, focusId: w.focus.id });
    await w.target.update({
      'system.vigor': 7,
      'system.magic.tradition': kind === 'heliotrope' ? 'witcher' : 'mage',
      'system.professionRanks.heliotrope': 5,
    });
    await w.learn('dispel', w.target);
    await runCommand('magicCounter', {
      messageUuid: message.uuid,
      reactorUuid: w.target.uuid,
      tokenUuid: w.targetToken.uuid,
      turn: w.turnIdentity(),
      values: { defense: kind, manualDice },
    });
    assert.equal(
      kind === 'dispel'
        ? message.flags[SYSTEM_ID].cancelled
        : message.flags[SYSTEM_ID].targets[0].status === 'defended',
      expected
    );
  });
}

test('Greater Focus does not improve a failed casting fumble', async (t) => {
  const w = await greaterFocusWorkflow(t),
    spell = await w.learn('aenye');
  const message = await w.cast(spell, { power: 5, focusId: w.focus.id, manualDice: '1, 7' });
  assert.equal(message.flags[SYSTEM_ID].check.total, 3);
  assert.equal(message.flags[SYSTEM_ID].check.fumble, 7);
  assert.equal(message.flags[SYSTEM_ID].failed, true);
});

test('focused critical healing still uses its raw casting check against treatment DC', async (t) => {
  const w = await greaterFocusWorkflow(t);
  const { woundItemData } = await import('../../module/witcher/wound-catalog.js');
  const [wound] = await w.target.createEmbeddedDocuments('Item', [
    woundItemData({ key: 'simple-0', location: 'leftLeg' }),
  ]);
  w.targetToken.x = 100;
  const spell = await w.learn('magic-healing');
  const message = await w.cast(spell, {
    power: 5,
    focusId: w.focus.id,
    manualDice: '4',
    healingWoundId: wound.id,
  });
  assert.equal(message.flags[SYSTEM_ID].check.total, 14);
  assert.equal(message.flags[SYSTEM_ID].focus.defenseBonus, 2);
  await w.accept(message);
  await w.applyMagic(message, w.targetToken.uuid);
  assert.equal(
    wound.system.wound.magicUses ?? 0,
    0,
    '14 ties treatment DC14; Greater Focus does not make it16'
  );
});

test('Greater-only focusing items carried at a catastrophic fumble explode once with receipt rollback', async (t) => {
  const w = await greaterFocusWorkflow(t, 'Moon Blade');
  w.targetToken.x = 100;
  const message = await w.cast(await w.learn('aenye'), {
    power: 5,
    focusId: w.focus.id,
    manualDice: '1, 10, 2',
  });
  assert.equal(message.flags[SYSTEM_ID].fumble.focusExplosion, true);
  w.enqueue(['1d10', 4]);
  w.faults.update = (document) => document.uuid === message.uuid;
  await assert.rejects(runCommand('magicBacklash', { messageUuid: message.uuid }), /Injected/);
  assert.equal(w.focus.system.quantity, 1);
  assert.equal([...w.messages].filter((row) => row.flags[SYSTEM_ID]?.kind === 'damage').length, 0);
  w.faults.update = null;
  w.enqueue(['1d10', 4]);
  await runCommand('magicBacklash', { messageUuid: message.uuid });
  assert.equal(w.focus.system.quantity, 0);
  const cards = [...w.messages].filter((row) => row.flags[SYSTEM_ID]?.kind === 'damage');
  assert.equal(cards.length, 2, 'one real focusing item damages each actor in its 2m area');
  await assert.rejects(runCommand('magicBacklash', { messageUuid: message.uuid }), /already/);
  assert.equal([...w.messages].filter((row) => row.flags[SYSTEM_ID]?.kind === 'damage').length, cards.length);
});

async function installCastingGlyph(w, name = 'Glyph of Fire', armorName = 'Nilfgaardian Helm') {
  const catalog = ['witcher-gear', 'equipment'].flatMap((file) =>
    JSON.parse(readFileSync(new URL(`../../data/witcher/${file}.json`, import.meta.url)))
  );
  const armor = await w.importItem(w.attacker, armorName);
  const [glyph] = await w.attacker.createEmbeddedDocuments('Item', [
    catalog.find((item) => item.name === name),
  ]);
  if (!w.attacker.items.some((item) => item.name === 'Crafting Tools'))
    await w.attacker.createEmbeddedDocuments('Item', [
      catalog.find((item) => item.name === 'Crafting Tools'),
    ]);
  const { registerEnhancements } = await import('../../module/witcher/enhancement-runtime.js');
  registerEnhancements();
  await runCommand('enhancement', {
    actorUuid: w.attacker.uuid,
    op: 'inscribe',
    sourceId: glyph.id,
    targetId: armor.id,
    stoneWeight: 'consumed',
  });
  assert.equal(glyph.system.quantity, 0, 'the actual stone is consumed by inscription');
  await runCommand('inventory', { actorUuid: w.attacker.uuid, itemId: armor.id, patch: { equipped: true } });
  const attachment = armor.system.attachments.at(-1);
  return { armor, attachment, choice: { itemId: armor.id, attachmentId: attachment.id, mode: 'dc' } };
}

// Word creation/skill/time/components have their own enhancement workflow suite;
// these cases start with a real, legally attached word and exercise its casting consumer.
async function attachCastingWord(w, key) {
  if (key === 'depletion') await w.focus.update(extraSlotUpdate(w.focus));
  validateAttachmentTarget(w.focus, { category: 'runeword', key });
  const catalog = JSON.parse(
    readFileSync(new URL('../../data/witcher/tome-enhancements.json', import.meta.url))
  );
  const word = catalog.find(
    (item) => item.type === 'enhancement' && item.flags?.[SYSTEM_ID]?.enhancement?.key === key
  );
  assert(word, key);
  const attachment = makeAttachment(word, { id: `cast-${key}`, now: 0 });
  await w.focus.update(rebuildEnhancementUpdate(w.focus, [attachment]));
  return attachment;
}

test('actual inscribed worn glyphs add saved spell DC with the recorded stacking rule, while raw casting stays unchanged', async (t) => {
  const w = await greaterFocusWorkflow(t),
    first = await installCastingGlyph(w),
    second = await installCastingGlyph(w, 'Glyph of Fire', 'Nilfgaardian Greaves');
  const spell = await w.learn('aenye'),
    choices = [first.choice, second.choice];
  const before = clone(w.attacker._source);
  await assert.rejects(
    w.cast(spell, { power: 5, focusId: w.focus.id, glyphs: choices, glyphStacking: 'one' }),
    /one glyph/
  );
  assert.deepEqual(w.attacker._source, before);
  const message = await w.cast(spell, {
    power: 5,
    focusId: w.focus.id,
    glyphs: choices,
    glyphStacking: 'all',
  });
  const data = message.flags[SYSTEM_ID];
  assert.equal(data.check.total, 15);
  assert.equal(data.focus.glyphDC, 6);
  assert.equal(data.focus.defenseBonus, 2);
  assert.equal(data.focus.glyphs.sources.length, 2);
  assert.match(message.content, /defense DC 23/);
  await first.armor.update({ 'system.equipped': false });
  await second.armor.update({ 'system.attachments': [] });
  await runCommand('magicDefense', {
    messageUuid: message.uuid,
    targetUuid: w.targetToken.uuid,
    turn: w.turnIdentity(),
    values: { defense: 'dodge', manualDice: '9' },
  });
  assert.equal(
    message.flags[SYSTEM_ID].targets[0].status,
    'ready',
    '19 loses to the saved DC23 after both glyphs disappear'
  );
});

test('a worn damage glyph adds its real d6 to damage without also increasing defense DC', async (t) => {
  const w = await greaterFocusWorkflow(t),
    glyph = await installCastingGlyph(w),
    spell = await w.learn('aenye');
  const message = await w.cast(spell, { power: 5, glyphs: [{ ...glyph.choice, mode: 'damage' }] });
  assert.equal(message.flags[SYSTEM_ID].focus.glyphDC, 0);
  assert.equal(message.flags[SYSTEM_ID].focus.glyphDamageDice, 1);
  assert.equal(message.flags[SYSTEM_ID].check.total, 15);
  await w.accept(message);
  w.enqueue(['1d10', 6], ['4d6+1d6', 20], ['1d100', 80]);
  const card = await w.applyMagic(message, w.targetToken.uuid);
  const before = w.target.system.hp.value;
  await w.apply(card);
  assert(w.target.system.hp.value < before);
  assert.equal(card.flags[SYSTEM_ID].applied, true);
});

test('glyph validation rejects duplicate, wrong-element, unworn and non-damaging choices before STA or Luck is spent', async (t) => {
  const w = await greaterFocusWorkflow(t),
    glyph = await installCastingGlyph(w),
    spell = await w.learn('aenye');
  const before = clone(w.attacker._source);
  await assert.rejects(
    w.cast(spell, { power: 5, luck: 1, glyphs: [glyph.choice, glyph.choice], glyphStacking: 'all' }),
    /same glyph/
  );
  await assert.rejects(
    w.cast(await w.learn('cenlly-graig'), { power: 3, luck: 1, glyphs: [glyph.choice] }),
    /does not match/
  );
  await glyph.armor.update({ 'system.equipped': false });
  await assert.rejects(w.cast(spell, { power: 5, luck: 1, glyphs: [glyph.choice] }), /no longer worn/);
  await glyph.armor.update({ 'system.equipped': true });
  const earth = await installCastingGlyph(w, 'Glyph of Earth', 'Nilfgaardian Greaves');
  w.targetToken.x = 100;
  await assert.rejects(
    w.cast(await w.learn('magic-healing'), {
      power: 5,
      luck: 1,
      glyphs: [{ ...earth.choice, mode: 'damage' }],
    }),
    /non-damaging/
  );
  assert.equal(w.attacker.system.sta.value, before.system.sta.value);
  assert.equal(w.attacker.system.luck.value, before.system.luck.value);
});

for (const [die, expected] of [
  ['9', false],
  ['10, 1', true],
]) {
  test(`Dispel counters the saved glyph plus Greater Focus DC with strict comparison (${die})`, async (t) => {
    const w = await greaterFocusWorkflow(t),
      glyph = await installCastingGlyph(w);
    const message = await w.cast(await w.learn('aenye'), {
      power: 5,
      focusId: w.focus.id,
      glyphs: [glyph.choice],
      manualDice: '4',
    });
    await w.target.update({ 'system.vigor': 7, 'system.magic.tradition': 'mage' });
    await w.learn('dispel', w.target);
    await runCommand('magicCounter', {
      messageUuid: message.uuid,
      reactorUuid: w.target.uuid,
      tokenUuid: w.targetToken.uuid,
      turn: w.turnIdentity(),
      values: { defense: 'dispel', manualDice: die },
    });
    assert.equal(message.flags[SYSTEM_ID].cancelled, expected, 'cast DC19: a tied19 fails to dispel');
  });
}

test('Depletion from the actual selected focus applies d6 STA on failed defense once, with damage/receipt rollback and stable provenance', async (t) => {
  const w = await greaterFocusWorkflow(t);
  await attachCastingWord(w, 'depletion');
  const message = await w.cast(await w.learn('aenye'), { power: 5, focusId: w.focus.id });
  assert.equal(message.flags[SYSTEM_ID].focus.depletion, true);
  assert.equal(message.flags[SYSTEM_ID].focus.sourceFocusId, w.focus.id);
  await w.focus.update({ 'system.attachments': [] });
  await runCommand('magicDefense', {
    messageUuid: message.uuid,
    targetUuid: w.targetToken.uuid,
    turn: w.turnIdentity(),
    values: { defense: 'dodge', manualDice: '4' },
  });
  const before = clone(w.target._source);
  w.enqueue(['1d10', 6], ['4d6', 14], ['1d100', 80], ['1d6', 4]);
  w.faults.update = (document) => document.uuid === message.uuid;
  await assert.rejects(w.applyMagic(message, w.targetToken.uuid), /Injected/);
  assert.deepEqual(w.target._source, before);
  assert.equal([...w.messages].filter((row) => row.flags?.[SYSTEM_ID]?.kind === 'damage').length, 0);
  assert.equal(message.flags[SYSTEM_ID].targets[0].status, 'ready');
  w.faults.update = null;
  w.enqueue(['1d10', 6], ['4d6', 14], ['1d100', 80], ['1d6', 4]);
  const damage = await w.applyMagic(message, w.targetToken.uuid);
  assert.equal(w.target.system.sta.value, before.system.sta.value - 4);
  assert.equal(w.target.system.hp.value, before.system.hp.value);
  await w.apply(damage);
  await assert.rejects(w.applyMagic(message, w.targetToken.uuid), /already|defense first/);
  assert.equal(w.target.system.sta.value, before.system.sta.value - 4);
});

for (const scenario of ['unselected', 'accepted', 'defended', 'infinite']) {
  test(`Depletion does not spend STA for ${scenario} casting context`, async (t) => {
    const w = await greaterFocusWorkflow(t);
    await attachCastingWord(w, 'depletion');
    if (scenario === 'infinite') await w.target.update({ 'system.traits.infiniteStamina': true });
    const message = await w.cast(await w.learn('aenye'), {
      power: 5,
      ...(scenario === 'unselected' ? {} : { focusId: w.focus.id }),
    });
    if (scenario === 'unselected') assert.equal(message.flags[SYSTEM_ID].focus, null);
    if (scenario === 'accepted') await w.accept(message);
    else
      await runCommand('magicDefense', {
        messageUuid: message.uuid,
        targetUuid: w.targetToken.uuid,
        turn: w.turnIdentity(),
        values: { defense: 'dodge', manualDice: scenario === 'defended' ? '9' : '4' },
      });
    const before = w.target.system.sta.value;
    if (scenario === 'defended')
      await assert.rejects(w.applyMagic(message, w.targetToken.uuid), /defended|defense first/);
    else {
      w.enqueue(['1d10', 6], ['4d6', 14], ['1d100', 80]);
      await w.applyMagic(message, w.targetToken.uuid);
    }
    assert.equal(w.target.system.sta.value, before);
  });
}

test('Prolongation rolls the printed duration twice at casting, preserves the higher result and never rerolls during application or retry', async (t) => {
  const w = await greaterFocusWorkflow(t);
  await attachCastingWord(w, 'prolongation');
  w.enqueue(['1d10', 3], ['1d10', 8]);
  const message = await w.cast(await w.learn('blinding-dust'), { power: 3, focusId: w.focus.id });
  assert.equal(message.flags[SYSTEM_ID].focus.prolongationDuration, 8);
  await w.focus.update({ 'system.attachments': [] });
  await w.accept(message);
  const before = clone(w.target._source);
  w.faults.update = (document) => document.uuid === message.uuid;
  await assert.rejects(w.applyMagic(message, w.targetToken.uuid), /Injected/);
  assert.deepEqual(w.target._source, before);
  w.faults.update = null;
  await w.applyMagic(message, w.targetToken.uuid);
  const effect = w.target.system.effects.find(
    (effect) => effect.magic?.castId === message.flags[SYSTEM_ID].castId
  );
  assert(effect);
  assert.equal(effect.expires, game.time.worldTime + 24);
});

test('Prolongation uses printed hour units and HP healing rounds, while a fixed duration requests no extra dice', async (t) => {
  const w = await greaterFocusWorkflow(t);
  await attachCastingWord(w, 'prolongation');
  w.enqueue(['1d6', 5], ['1d6', 2]);
  const glamour = await w.cast(await w.learn('glamour'), { power: 5, focusId: w.focus.id }, []);
  await w.applyMagic(glamour);
  assert(
    w.attacker.system.effects.some(
      (effect) => effect.magic?.castId === glamour.flags[SYSTEM_ID].castId && effect.expires === 18000
    )
  );
  w.targetToken.x = 100;
  w.enqueue(['1d10', 2], ['1d10', 7]);
  const healing = await w.cast(await w.learn('magic-healing'), { power: 5, focusId: w.focus.id });
  await w.accept(healing);
  await w.applyMagic(healing, w.targetToken.uuid);
  assert(
    w.target.system.effects.some(
      (effect) =>
        effect.magic?.castId === healing.flags[SYSTEM_ID].castId &&
        effect.expires === 21 &&
        effect.magic.roundsRemaining === 7
    )
  );
  const aenye = await w.cast(await w.learn('aenye'), { power: 5, focusId: w.focus.id });
  assert.equal(aenye.flags[SYSTEM_ID].focus.prolongation, true);
  assert.equal(aenye.flags[SYSTEM_ID].focus.prolongationDuration, undefined);
});

test('Prolongation never rolls a duration or restores HP for a critical-injury treatment use', async (t) => {
  const w = await greaterFocusWorkflow(t);
  await attachCastingWord(w, 'prolongation');
  const { woundItemData } = await import('../../module/witcher/wound-catalog.js');
  const [wound] = await w.target.createEmbeddedDocuments('Item', [
    woundItemData({ key: 'simple-0', location: 'leftLeg' }),
  ]);
  w.targetToken.x = 100;
  const before = w.target.system.hp.value;
  const message = await w.cast(await w.learn('magic-healing'), {
    power: 5,
    focusId: w.focus.id,
    healingWoundId: wound.id,
  });
  assert.equal(message.flags[SYSTEM_ID].focus.prolongationDuration, undefined);
  await w.accept(message);
  await w.applyMagic(message, w.targetToken.uuid);
  assert.equal(wound.system.wound.magicUses, 1);
  assert.equal(w.target.system.hp.value, before);
  assert.equal(
    w.target.system.effects.some((effect) => effect.magic?.healing),
    false
  );
});

test('an unselected Prolongation weapon cannot alter duration; failed selected casting persistence restores expenditure', async (t) => {
  const w = await greaterFocusWorkflow(t);
  await attachCastingWord(w, 'prolongation');
  const spell = await w.learn('blinding-dust');
  const ordinary = await w.cast(spell, { power: 3 });
  assert.equal(ordinary.flags[SYSTEM_ID].focus, null);
  await w.accept(ordinary);
  w.enqueue(['1d10', 3]);
  await w.applyMagic(ordinary, w.targetToken.uuid);
  assert(
    w.target.system.effects.some(
      (effect) => effect.magic?.castId === ordinary.flags[SYSTEM_ID].castId && effect.expires === 9
    )
  );
  const before = clone(w.attacker._source);
  w.enqueue(['1d10', 4], ['1d10', 6]);
  w.faults.create = (data) => data.flags?.[SYSTEM_ID]?.kind === 'magic';
  await assert.rejects(w.cast(spell, { power: 3, focusId: w.focus.id, luck: 1 }), /Injected/);
  assert.deepEqual(w.attacker._source, before);
});

test('a non-damaging invocation still applies Depletion after a failed actual defense and unconsciousness at zero STA', async (t) => {
  const w = await greaterFocusWorkflow(t);
  await attachCastingWord(w, 'depletion');
  await w.attacker.update({ 'system.magic.tradition': 'druid' });
  await w.target.update({ 'system.sta.value': 3 });
  const { registerContinuingMagicRuntime } = await import('../../module/witcher/magic-ongoing-runtime.js');
  registerContinuingMagicRuntime();
  const message = await w.cast(await w.learn('cursed-illness'), { power: 2, focusId: w.focus.id });
  await runCommand('magicDefense', {
    messageUuid: message.uuid,
    targetUuid: w.targetToken.uuid,
    turn: w.turnIdentity(),
    values: { defense: 'resistMagic', manualDice: '4' },
  });
  w.enqueue(['1d6', 3]);
  await w.applyMagic(message, w.targetToken.uuid);
  assert.equal(w.target.system.sta.value, 0);
  assert.equal(w.target.system.hp.value, 25);
  assert(w.target.system.conditions.includes('unconscious'));
  assert(w.target.system.conditions.includes('stunned'));
  assert(w.target.system.conditions.includes('staggered'));
});
