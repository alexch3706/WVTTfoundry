import test from 'node:test';
import assert from 'node:assert/strict';
import { workflow, clone } from './workflow-fixture.mjs';
import { SYSTEM_ID } from '../../module/witcher/config.js';
import { magicInfo, magicItemData } from '../../module/witcher/magic-catalog.js';
import { runCommand } from '../../module/witcher/authority.js';
import { installMagicOngoing, triggerMagicOngoing } from '../../module/witcher/magic-ongoing.js';
let executeBasicSpell, executeContinuingAttack;

async function setup(t) {
  const w = await workflow(t, { separatePrepared: true });
  const oldConfig = globalThis.CONFIG;
  t.after(() => {
    if (oldConfig === undefined) delete globalThis.CONFIG;
    else globalThis.CONFIG = oldConfig;
  });
  globalThis.CONFIG = { Canvas: { polygonBackends: { sight: { testCollision: () => false } } } };
  const scene = {
    id: 'ongoing',
    uuid: 'Scene.ongoing',
    grid: { size: 100, distance: 2, units: 'm' },
    tokens: new w.Collection(),
    regions: new w.Collection(),
  };
  game.scenes = new w.Collection([[scene.id, scene]]);
  game.actors = new w.Collection([
    [w.attacker.id, w.attacker],
    [w.target.id, w.target],
  ]);
  w.docs.set(scene.uuid, scene);
  function place(actor, x = 0) {
    const token = {
      id: actor.id,
      uuid: `${scene.uuid}.Token.${actor.id}`,
      parent: scene,
      actor,
      x,
      y: 0,
      width: 1,
      height: 1,
      elevation: 0,
      flags: {},
      getMovementOrigin() {
        return { x: this.x + 50, y: 50, elevation: 0 };
      },
      getSize() {
        return { width: 100, height: 100 };
      },
    };
    scene.tokens.set(token.id, token);
    w.docs.set(token.uuid, token);
    return token;
  }
  const source = place(w.attacker),
    target = place(w.target, 200);
  await w.attacker.update({
    'system.magic': { tradition: 'mage', spent: 0, roundKey: '' },
    'system.vigor': 10,
  });
  await w.target.update({ 'system.magic': { tradition: '', spent: 0, roundKey: '' } });
  const runtime = await import('../../module/witcher/magic-runtime.js');
  runtime.registerMagicCommands();
  const { registerConsequences } = await import('../../module/witcher/consequences.js');
  registerConsequences();
  ({ executeBasicSpell } = await import('../../module/witcher/magic-execution.js'));
  const ongoingRuntime = await import('../../module/witcher/magic-ongoing-runtime.js');
  ({ executeContinuingAttack } = ongoingRuntime);
  ongoingRuntime.registerContinuingMagicRuntime();
  const magic = magicInfo('aenye');
  const context = {
    caster: w.attacker,
    targets: [w.target],
    scene,
    tokenUuid: source.uuid,
    sourceMagic: magic,
    castId: 'ongoing-cast',
    castTotal: 18,
    initialCast: { power: 5, staCost: 5 },
    pending: { id: 'turn-1' },
    event: { id: 'action-1', cycle: 'combat:1' },
  };
  const operation = {
    type: 'damage',
    formula: '2d6',
    damageType: 'elemental',
    location: 'torso',
    armor: 'normal',
    defenses: ['dodge', 'reposition', 'block'],
  };
  const pendingFor = (actor) => {
    const effect = actor.system.effects.find(
      (entry) => entry.magic?.ongoing && Object.keys(entry.magic.ongoing.pending).length
    );
    assert(effect, 'Actual pending source effect');
    const pending = Object.values(effect.magic.ongoing.pending)[0];
    return { actorUuid: actor.uuid, sourceUuid: actor.uuid, effectId: effect.id, pendingId: pending.id };
  };
  const saves = (actor, values) => runCommand('magicOngoingSave', { ...pendingFor(actor), values });
  const damageCards = () => [...w.messages].filter((message) => message.flags[SYSTEM_ID]?.kind === 'damage');
  return {
    ...w,
    source,
    targetToken: target,
    scene,
    place,
    magic,
    context,
    operation,
    pendingFor,
    saves,
    damageCards,
    runtime,
  };
}

function enableRegions(w) {
  w.scene.levels = new Map([['ground', { id: 'ground', isView: true }]]);
  canvas.ready = true;
  canvas.scene = w.scene;
  for (const token of w.scene.tokens) {
    token.level = 'ground';
    token.testInsideRegion = (region) => {
      const shape = region.shapes[0],
        p = token.getMovementOrigin();
      return Math.hypot(shape.x - p.x, shape.y - p.y) <= shape.radius;
    };
  }
  let next = 0;
  class RegionFixture {
    constructor(data, { parent }) {
      Object.assign(this, clone(data));
      this.parent = parent;
      this.id = `region${++next}`;
      this.uuid = `${parent.uuid}.Region.${this.id}`;
      this.documentName = 'Region';
    }
    updateShapeConstraints() {}
    toObject() {
      const { parent, ...data } = this;
      return clone(data);
    }
    async update(changes) {
      for (const [path, value] of Object.entries(changes)) {
        const parts = path.split('.'),
          key = parts.pop();
        let object = this;
        for (const part of parts) object = object[part] ??= {};
        if (key.startsWith('-=')) delete object[key.slice(2)];
        else object[key] = clone(value);
      }
      return this;
    }
    async delete() {
      w.scene.regions.delete(this.id);
      w.docs.delete(this.uuid);
    }
  }
  CONFIG.Region = { documentClass: RegionFixture };
  w.scene.createEmbeddedDocuments = async (type, records) => {
    assert.equal(type, 'Region');
    return records.map((record) => {
      const region = new RegionFixture(record, { parent: w.scene });
      w.scene.regions.set(region.id, region);
      w.docs.set(region.uuid, region);
      return region;
    });
  };
}

test('a continuing attack offers each target an actual defense and removes its completed one-shot procedure', async (t) => {
  const w = await setup(t),
    other = w.makeActor('Second target');
  game.actors.set(other.id, other);
  w.place(other, 300);
  const receipt = await executeContinuingAttack([w.operation], { ...w.context, targets: [w.target, other] });
  assert.equal(receipt.status, 'awaitingDefenses');
  assert.equal(w.damageCards().length, 0);
  assert.equal(w.target.system.hp.value, 25);
  assert.equal(other.system.hp.value, 25);
  w.enqueue(['2d6', 8]);
  await w.saves(w.target, { skill: 'athletics', manualDice: '3' });
  assert.equal(w.damageCards().length, 1);
  assert.equal(w.damageCards()[0].flags[SYSTEM_ID].targetUuid, w.target.uuid);
  assert.equal(w.target.system.effects.filter((effect) => effect.magic?.oneShot).length, 0);
  await w.saves(other, { skill: 'dodge', manualDice: '9' });
  assert.equal(w.damageCards().length, 1);
  assert.equal(other.system.effects.filter((effect) => effect.magic?.oneShot).length, 0);
  await w.apply(w.damageCards()[0]);
  if (!w.damageCards()[0].flags[SYSTEM_ID].applied) await w.apply(w.damageCards()[0]);
  assert.equal(w.target.system.hp.value, 17);
  assert.equal(other.system.hp.value, 25);
});

test('a defense fumble is resolved before damage and resuming never rolls or pays twice', async (t) => {
  const w = await setup(t);
  w.start();
  await executeContinuingAttack([w.operation], w.context);
  const payload = w.pendingFor(w.target);
  const first = await runCommand('magicOngoingSave', {
    ...payload,
    values: { skill: 'dodge', manualDice: '1, 7', luck: 1 },
  });
  assert.equal(first.status, 'awaitingFumble');
  assert.equal(w.damageCards().length, 0);
  assert.equal(w.target.system.luck.value, 4);
  const defenses = w.target.system.combat.defenses;
  await assert.rejects(
    runCommand('magicOngoingSave', { ...payload, values: { manualDice: '9' } }),
    /fumble/i
  );
  const fumble = [...w.messages].find((message) => message.flags[SYSTEM_ID]?.kind === 'defense');
  assert(fumble);
  await runCommand('resolveFumble', { messageUuid: fumble.uuid });
  assert.equal(fumble.flags[SYSTEM_ID].fumbleResolved, true);
  w.enqueue(['2d6', 7]);
  await runCommand('magicOngoingSave', { ...payload, values: {} });
  assert.equal(w.damageCards().length, 1);
  assert.equal(w.target.system.combat.defenses, defenses);
  assert.equal(w.target.system.luck.value, 4);
  assert.equal(w.rolls.length, 0);
});

test('fresh casting attacks use the entered new total; low fumbles hurt caster and severe fumbles create no saves', async (t) => {
  const w = await setup(t);
  await executeContinuingAttack([w.operation], {
    ...w.context,
    actionRule: { newCastingCheckEachAttack: true },
    values: { manualDice: '6' },
  });
  const effect = w.target.system.effects.find((entry) => entry.magic?.oneShot);
  assert.equal(Object.values(effect.magic.ongoing.pending)[0].dc, 16);
  const severe = await executeContinuingAttack([w.operation], {
    ...w.context,
    pending: { id: 'turn-2' },
    actionRule: { newCastingCheckEachAttack: true },
    values: { manualDice: '1, 8' },
  });
  assert.equal(severe.status, 'failed');
  assert.equal(w.attacker.system.hp.value, 17);
  assert(w.attacker.system.conditions.includes('fire'));
  assert.equal(w.target.system.effects.filter((entry) => entry.magic?.oneShot).length, 1);
  assert.equal(w.damageCards().length, 0);
});

test('failure to persist an attack prompt restores all targets and removes its new attack cards', async (t) => {
  const w = await setup(t),
    other = w.makeActor('Second target');
  game.actors.set(other.id, other);
  w.place(other, 300);
  const before = clone(w.target._source);
  let prompts = 0;
  w.faults.create = (data) => data.flags?.[SYSTEM_ID]?.magicOngoing && ++prompts === 2;
  await assert.rejects(
    executeContinuingAttack([w.operation], { ...w.context, targets: [w.target, other] }),
    /Injected/
  );
  assert.deepEqual(w.target._source, before);
  assert.equal(other.system.effects.length, 0);
  assert.equal(w.messages.size, 0);
});

test('an immediate printed save is offered at initial cast and final persistence failure restores its source and prompt', async (t) => {
  const w = await setup(t);
  const source = await ChatMessage.create({ content: 'source', flags: { [SYSTEM_ID]: {} } });
  const data = {
    magic: w.magic,
    magicKey: w.magic.key,
    name: w.magic.name,
    castId: 'instant-save',
    actorUuid: w.attacker.uuid,
    tokenUuid: w.source.uuid,
    power: 5,
    check: { total: 18 },
  };
  const op = { ...w.operation, save: { skill: 'athletics', dc: 16, onSuccess: 'avoidAttack' }, duration: {} };
  const before = clone(w.target._source);
  const args = {
    data,
    row: { tokenUuid: w.targetToken.uuid },
    caster: w.attacker,
    target: w.target,
    message: source,
    receipt: 'initial',
    effectFor: w.runtime.effectFor,
    damageCard: w.runtime.magicDamageCard,
    operationsOverride: [op],
  };
  await assert.rejects(
    executeBasicSpell({
      ...args,
      finish: async () => {
        throw new Error('Final card failure');
      },
    }),
    /Final card failure/
  );
  assert.deepEqual(w.target._source, before);
  assert.equal(w.messages.size, 1);
  await executeBasicSpell(args);
  assert.equal(Object.values(w.target.system.effects[0].magic.ongoing.pending)[0].dc, 16);
  assert.equal(w.damageCards().length, 0);
  await w.saves(w.target, { skill: 'athletics', manualDice: '7' });
  assert.equal(w.target.system.effects.length, 0);
});

test('the saved active-action command checks sight before payment and creates defenses using its saved attack total', async (t) => {
  const w = await setup(t);
  w.start();
  const installed = await installMagicOngoing(
    w.attacker,
    [
      {
        type: 'modifier',
        target: 'caster',
        modifiers: {},
        rule: {
          key: 'activeActions',
          useCastingTotal: 18,
          action: 'normal',
          operations: [{ ...w.operation, range: 10, maxTargets: 1 }],
        },
      },
    ],
    { ...w.context, target: w.attacker, duration: { rounds: 3 } }
  );
  await triggerMagicOngoing(w.attacker, {
    id: 'first-action',
    kind: 'turnAction',
    actorUuid: w.attacker.uuid,
    effectId: installed.effect.id,
    cycle: 'combat:1',
  });
  const payload = { ...w.pendingFor(w.attacker), values: { targetUuids: [w.target.uuid] } };
  CONFIG.Canvas.polygonBackends.sight.testCollision = () => true;
  await assert.rejects(runCommand('magicOngoingAction', payload), /line of sight/);
  assert.equal(w.attacker.system.combat.actions, 0);
  CONFIG.Canvas.polygonBackends.sight.testCollision = () => false;
  await runCommand('magicOngoingAction', payload);
  assert.equal(w.attacker.system.combat.actions, 1);
  assert.equal(w.damageCards().length, 0);
  const pending = Object.values(w.target.system.effects[0].magic.ongoing.pending)[0];
  assert.equal(pending.dc, 18);
  assert.equal(w.attacker.skillCalls.length, 0, 'Original casting total does not roll again');
  await assert.rejects(runCommand('magicOngoingAction', payload), /no longer pending/);
});

test('accepting an ongoing hit works while stunned and consumes no defense or Luck', async (t) => {
  const w = await setup(t);
  w.start();
  await w.target.update({ 'system.conditions': ['stunned'] });
  await executeContinuingAttack([w.operation], w.context);
  await assert.rejects(w.saves(w.target, { skill: 'dodge', manualDice: '5' }), /prevents an active defense/);
  w.enqueue(['2d6', 6]);
  await w.saves(w.target, { skill: 'accept', luck: 5 });
  assert.equal(w.target.system.combat.defenses, 0);
  assert.equal(w.target.system.luck.value, 5);
  assert.equal(w.damageCards().length, 1);
});

test('native persistent areas prompt once at cast, once per elapsed round, and retain unresolved last-round saves until completed', async (t) => {
  const w = await setup(t);
  const { createContinuingZone } = await import('../../module/witcher/magic-ongoing-runtime.js');
  const { tickMagicZones } = await import('../../module/witcher/magic-zones.js');
  const { triggerMagicOngoingRegion } = await import('../../module/witcher/magic-ongoing.js');
  enableRegions(w);
  const message = await ChatMessage.create({ flags: { [SYSTEM_ID]: {} } });
  const data = {
    magic: w.magic,
    magicKey: w.magic.key,
    name: w.magic.name,
    castId: 'region-cast',
    tokenUuid: w.source.uuid,
    itemId: 'learned',
    check: { total: 18 },
    area: { placement: w.targetToken.getMovementOrigin() },
  };
  const operation = {
    type: 'zone',
    shape: { shape: 'circle', radius: 2 },
    placementRange: 20,
    excludesCaster: true,
    duration: { rounds: 1 },
    operations: [
      {
        ...w.operation,
        timing: 'castAndEnterOnOwnTurnOrStartTurn',
        save: { skill: 'athletics', dc: 16, onSuccess: 'avoidAttack' },
      },
    ],
  };
  const result = await createContinuingZone(operation, {
    data,
    caster: w.attacker,
    sourceToken: w.source,
    operationIndex: 0,
    message,
  });
  const region = w.docs.get(result.receipt.regionUuid);
  assert(region);
  assert.equal(Object.keys(region.flags[SYSTEM_ID].magicOngoing.pending).length, 1);
  await triggerMagicOngoingRegion(region, {
    name: 'tokenEnter',
    data: { token: w.targetToken, combat: game.combat },
  });
  assert.equal(
    Object.keys(region.flags[SYSTEM_ID].magicOngoing.pending).length,
    1,
    'Native enter callback cannot duplicate initial contact'
  );
  game.time.worldTime = 3;
  await tickMagicZones();
  assert.equal(Object.keys(region.flags[SYSTEM_ID].magicOngoing.pending).length, 2);
  assert.equal(region.flags[SYSTEM_ID].magicArea.active, false);
  assert.equal(w.scene.regions.size, 1, 'Last-round defense source stays available');
  await tickMagicZones();
  assert.equal(Object.keys(region.flags[SYSTEM_ID].magicOngoing.pending).length, 2);
  for (const pending of Object.values(region.flags[SYSTEM_ID].magicOngoing.pending))
    await runCommand('magicOngoingSave', {
      actorUuid: w.target.uuid,
      sourceUuid: region.uuid,
      effectId: region.uuid,
      pendingId: pending.id,
      values: { skill: 'athletics', manualDice: '7' },
    });
  await tickMagicZones();
  assert.equal(w.scene.regions.size, 0);
  assert.equal(w.damageCards().length, 0);
});

test('Heliotrope reacts to the new continuing attack and resolves its saved procedure without another defense or damage', async (t) => {
  const w = await setup(t);
  await w.target.update({
    'system.race': 'witcher',
    'system.magic.tradition': 'witcher',
    'system.professionRanks.heliotrope': 5,
    'system.vigor': 7,
  });
  w.start();
  const result = await executeContinuingAttack([w.operation], w.context);
  const card = w.docs.get(result.receipt.attackMessageUuid);
  const { turnIdentity } = await import('../../module/witcher/runtime.js');
  await runCommand('magicCounter', {
    messageUuid: card.uuid,
    reactorUuid: w.target.uuid,
    tokenUuid: w.targetToken.uuid,
    turn: turnIdentity(),
    values: { defense: 'heliotrope', manualDice: '8' },
  });
  assert.equal(card.flags[SYSTEM_ID].targets[0].status, 'defended');
  const before = clone(w.target._source.system.combat);
  await w.saves(w.target, {});
  assert.equal(w.damageCards().length, 0);
  assert.deepEqual(w.target._source.system.combat, before);
  assert.equal(w.target.system.effects.filter((entry) => entry.magic?.oneShot).length, 0);
});

test('Static Storm casts once into an actual Region, asks the GM about unclassified metal equipment, and deals its printed round damage', async (t) => {
  const w = await setup(t);
  enableRegions(w);
  const { tickMagicZones } = await import('../../module/witcher/magic-zones.js');
  const { turnIdentity } = await import('../../module/witcher/runtime.js');
  const [spell] = await w.attacker.createEmbeddedDocuments('Item', [magicItemData('static-storm')]);
  await w.importItem(w.target, 'Iron Long Sword', { equipped: false });
  const point = { x: 50, y: 50, elevation: 0, level: 'ground' };
  const message = await runCommand('magicCast', {
    actorUuid: w.attacker.uuid,
    itemId: spell.id,
    expected: w.runtime.magicFingerprint(spell),
    turn: turnIdentity(),
    tokenUuid: w.source.uuid,
    targetUuids: [],
    area: { placement: point, origin: point },
    values: { power: 5, manualDice: '5' },
  });
  assert.equal(w.attacker.system.sta.value, 20);
  assert.deepEqual(
    message.flags[SYSTEM_ID].targets,
    [],
    'Persistent area creation has no additional initial defense'
  );
  w.enqueue(['2d6', 2]);
  await runCommand('magicApply', { messageUuid: message.uuid });
  assert.equal(w.scene.regions.size, 1);
  assert.equal(w.damageCards().length, 0);
  const region = [...w.scene.regions][0];
  assert.equal(region.flags[SYSTEM_ID].magicArea.expires, 6);
  game.time.worldTime = 3;
  await tickMagicZones();
  const pending = Object.values(region.flags[SYSTEM_ID].magicOngoing.pending)[0];
  assert.equal(pending.kind, 'decision');
  assert.equal(pending.actorUuid, w.target.uuid);
  assert.equal(Object.values(region.flags[SYSTEM_ID].magicOngoing.pending).length, 1, 'Caster is excluded');
  w.enqueue(['2', 2]);
  await runCommand('magicOngoingAction', {
    actorUuid: w.target.uuid,
    sourceUuid: region.uuid,
    effectId: region.uuid,
    pendingId: pending.id,
    values: { applies: true },
  });
  assert.equal(w.damageCards().length, 1);
  await w.apply(w.damageCards()[0]);
  if (!w.damageCards()[0].flags[SYSTEM_ID].applied) await w.apply(w.damageCards()[0]);
  assert.equal(w.target.system.hp.value, 23);
  assert.equal(w.attacker.system.hp.value, 25);
  await tickMagicZones();
  assert.equal(w.damageCards().length, 1, 'The elapsed round cannot execute twice');
});

test('Web of Lies permits only its once-per-turn unmodified INT recovery and preserves ordinary stunned sources', async (t) => {
  const w = await setup(t);
  const { turnIdentity, save } = await import('../../module/witcher/runtime.js');
  await w.attacker.update({ 'system.magic.tradition': 'priest' });
  const [spell] = await w.attacker.createEmbeddedDocuments('Item', [magicItemData('web-of-lies')]);
  const message = await runCommand('magicCast', {
    actorUuid: w.attacker.uuid,
    itemId: spell.id,
    expected: w.runtime.magicFingerprint(spell),
    turn: turnIdentity(),
    tokenUuid: w.source.uuid,
    targetUuids: [w.targetToken.uuid],
    values: { power: 3, manualDice: '5' },
  });
  await runCommand('magicDefense', {
    messageUuid: message.uuid,
    targetUuid: w.targetToken.uuid,
    turn: turnIdentity(),
    values: { defense: 'resistMagic', manualDice: '3' },
  });
  await runCommand('magicApply', { messageUuid: message.uuid, targetUuid: w.targetToken.uuid });
  assert(w.target.system.conditions.includes('stunned'));
  assert.equal(
    await save(w.target, 'stun'),
    false,
    'Ordinary Stun save cannot bypass the printed INT procedure'
  );
  const source = w.target.system.effects.find((effect) => effect.magic?.ongoing);
  await triggerMagicOngoing(w.target, {
    id: 'mental-turn-1',
    kind: 'startTurn',
    actorUuid: w.target.uuid,
    effectId: source.id,
    cycle: 'combat:1',
  });
  const first = w.pendingFor(w.target);
  await runCommand('magicOngoingSave', { ...first, values: { manualDice: '10', luck: 5, modifier: 100 } });
  assert(
    w.target.system.conditions.includes('stunned'),
    '10 is one failed unmodified d10, not an exploding skill check'
  );
  assert.equal(w.target.system.luck.value, 5);
  await assert.rejects(
    runCommand('magicOngoingSave', { ...first, values: { manualDice: '1' } }),
    /no longer pending/
  );
  await w.target.update({
    'system.effects': [
      ...w.target.system.effects,
      { id: 'unrelated-stun', key: 'Other Stun', conditions: ['stunned'], modifiers: {}, expires: 0 },
    ],
  });
  await triggerMagicOngoing(w.target, {
    id: 'mental-turn-2',
    kind: 'startTurn',
    actorUuid: w.target.uuid,
    effectId: source.id,
    cycle: 'combat:2',
  });
  await w.saves(w.target, { manualDice: '4' });
  assert.equal(
    w.target.system.effects.some((effect) => effect.magic?.castId === message.flags[SYSTEM_ID].castId),
    false
  );
  assert(w.target.system.conditions.includes('stunned'), 'An independent Stun source remains');
  assert.equal(w.target.system.effects.length, 1);
});

for (const spec of [
  {
    key: 'merigolds-hailstorm',
    power: 15,
    formula: '2d6',
    damage: 8,
    randomLocation: true,
    casterAffected: true,
  },
  { key: 'lightning-storm', power: 25, formula: '8d6', damage: 20, selection: 35, fire: true },
  {
    key: 'melgars-fire',
    power: 25,
    formula: '4d6',
    damage: 12,
    selection: 75,
    fire: true,
    randomLocation: true,
    duration: ['2d6', 2],
  },
])
  test(`${spec.key} creates its actual area and defends the printed round attack before damage`, async (t) => {
    const w = await setup(t);
    enableRegions(w);
    const { tickMagicZones } = await import('../../module/witcher/magic-zones.js');
    const { turnIdentity } = await import('../../module/witcher/runtime.js');
    await w.attacker.update({ 'system.vigor': 50, 'system.overrides.sta': 100, 'system.sta.value': 100 });
    const [spell] = await w.attacker.createEmbeddedDocuments('Item', [magicItemData(spec.key)]);
    const origin = { x: 50, y: 50, elevation: 0, level: 'ground' };
    const message = await runCommand('magicCast', {
      actorUuid: w.attacker.uuid,
      itemId: spell.id,
      expected: w.runtime.magicFingerprint(spell),
      turn: turnIdentity(),
      tokenUuid: w.source.uuid,
      targetUuids: [],
      area: { placement: origin, origin },
      values: { power: spec.power, manualDice: '5' },
    });
    assert.deepEqual(message.flags[SYSTEM_ID].targets, []);
    if (spec.duration) w.enqueue(spec.duration);
    await runCommand('magicApply', { messageUuid: message.uuid });
    assert.equal(w.scene.regions.size, 1);
    const region = [...w.scene.regions][0];
    assert.equal(w.damageCards().length, 0);
    game.time.worldTime = 3;
    if (spec.selection) w.enqueue(['1d100', spec.selection]);
    await tickMagicZones();
    const pending = Object.values(region.flags[SYSTEM_ID].magicOngoing.pending);
    assert.equal(pending.length, spec.casterAffected ? 2 : 1);
    const targetSave = pending.find((row) => row.actorUuid === w.target.uuid);
    assert.equal(targetSave.kind, 'save');
    assert.equal(targetSave.dc, 15);
    assert.equal(w.damageCards().length, 0);
    // The ordinary damage path rolls hit location before damage.
    if (spec.randomLocation) w.enqueue(['1d10', 2]);
    w.enqueue([spec.formula, spec.damage]);
    if (spec.fire) w.enqueue(['1d100', 75]);
    await runCommand('magicOngoingSave', {
      actorUuid: w.target.uuid,
      sourceUuid: region.uuid,
      effectId: region.uuid,
      pendingId: targetSave.id,
      values: { skill: 'dodge', manualDice: '3' },
    });
    assert.equal(w.damageCards().length, 1);
    const damage = w.damageCards()[0];
    assert.equal(damage.flags[SYSTEM_ID].summary[0].damage, spec.damage);
    assert.equal(damage.flags[SYSTEM_ID].summary[0].location.id, 'torso');
    await w.apply(damage);
    if (!damage.flags[SYSTEM_ID].applied) await w.apply(damage);
    assert.equal(w.target.system.hp.value, 25 - spec.damage);
    if (spec.fire) {
      assert(w.target.system.conditions.includes('fire'));
      assert(w.target.system.effects.some((effect) => effect.magic?.persistsAfterSource));
      await w.runtime.endMagicCast(message.flags[SYSTEM_ID].castId);
      assert(
        w.target.system.conditions.includes('fire'),
        'Ordinary resulting fire survives ending its storm'
      );
    }
  });

test('Suffocate deals only its printed 1d10 per turn, bypasses Quen, and ends the whole cast when its caster is struck by a weapon', async (t) => {
  const w = await setup(t);
  const { turnIdentity } = await import('../../module/witcher/runtime.js');
  const { tickActor } = await import('../../module/witcher/activities.js');
  await w.attacker.update({ 'system.vigor': 20 });
  await w.target.update({
    'system.effects': [
      {
        id: 'original-quen',
        key: 'Quen',
        shieldHP: 10,
        conditions: [],
        modifiers: {},
        magic: { key: 'quen', castId: 'other-quen' },
      },
    ],
  });
  const [spell] = await w.attacker.createEmbeddedDocuments('Item', [magicItemData('suffocate')]);
  const message = await runCommand('magicCast', {
    actorUuid: w.attacker.uuid,
    itemId: spell.id,
    expected: w.runtime.magicFingerprint(spell),
    turn: turnIdentity(),
    tokenUuid: w.source.uuid,
    targetUuids: [w.targetToken.uuid],
    values: { power: 14, manualDice: '5' },
  });
  await runCommand('magicDefense', {
    messageUuid: message.uuid,
    targetUuid: w.targetToken.uuid,
    turn: turnIdentity(),
    values: { defense: 'resistMagic', manualDice: '3' },
  });
  await runCommand('magicApply', { messageUuid: message.uuid, targetUuid: w.targetToken.uuid });
  assert(w.target.system.conditions.includes('suffocating'));
  assert(w.target.system.conditions.includes('staggered'));
  w.enqueue(['1d10', 6]);
  await triggerMagicOngoing(w.target, {
    id: 'suffocate-turn-1',
    kind: 'startTurn',
    actorUuid: w.target.uuid,
    tokenUuid: w.targetToken.uuid,
    cycle: 'combat:1',
  });
  const damage = w.damageCards()[0];
  assert.equal(damage.flags[SYSTEM_ID].request[0].properties.damageSource, 'suffocation');
  await w.apply(damage);
  if (!damage.flags[SYSTEM_ID].applied) await w.apply(damage);
  assert.equal(w.target.system.hp.value, 19);
  assert.equal(w.target.system.effects.find((effect) => effect.id === 'original-quen').shieldHP, 10);
  await tickActor(w.target, 'suffocate-ordinary-tick');
  assert.equal(w.target.system.hp.value, 19, 'Ordinary suffocation does not add another 3 HP');
  const sword = await w.importItem(w.target, 'Iron Long Sword', { equipped: true });
  w.start();
  game.combat.combatant.actor = w.target;
  const attack = await runCommand('attack', {
    actorUuid: w.target.uuid,
    targetUuid: w.attacker.uuid,
    itemId: sword.id,
    expectedTurn: w.turn(),
    values: {
      action: 'normal',
      style: 'fast',
      location: 'torso',
      type: 'slashing',
      modifier: 0,
      luck: 0,
      cover: 0,
      extra: false,
      manualDice: '5',
    },
  });
  w.enqueue([sword.system.damage, 6]);
  await runCommand('defend', {
    messageUuid: attack.uuid,
    expectedTurn: w.turn(),
    values: { defense: 'passive', dc: 10, modifier: 0, luck: 0, gang: 1 },
  });
  const hit = w.damageFor(attack);
  assert(hit);
  await w.apply(hit);
  if (!hit.flags[SYSTEM_ID].applied) await w.apply(hit);
  assert.equal(w.target.system.conditions.includes('suffocating'), false);
  assert.equal(w.target.system.conditions.includes('staggered'), false);
  for (const actor of [w.target, w.attacker])
    assert.equal(
      actor.system.effects.some((effect) => effect.magic?.castId === message.flags[SYSTEM_ID].castId),
      false
    );
});

async function restraintWorld(w) {
  Actor.create = async (data) => {
    const actor = w.makeActor(data.name, data);
    await actor.update({ flags: clone(data.flags ?? {}) });
    game.actors.set(actor.id, actor);
    actor.getTokenDocument = async (fields) => ({ toObject: () => ({ actorId: actor.id, ...fields }) });
    actor.delete = async () => {
      game.actors.delete(actor.id);
      w.docs.delete(actor.uuid);
    };
    return actor;
  };
  w.scene.createEmbeddedDocuments = async (type, records) => {
    assert.equal(type, 'Token');
    return records.map((data) => {
      const token = w.place(game.actors.get(data.actorId), data.x);
      Object.assign(token, clone(data));
      token.delete = async () => {
        w.scene.tokens.delete(token.id);
        w.docs.delete(token.uuid);
      };
      return token;
    });
  };
  const restraints = await import('../../module/witcher/magic-restraints.js');
  restraints.registerMagicRestraints();
  return restraints;
}
async function castBookMagic(w, key, { power, accept = true } = {}) {
  const { turnIdentity } = await import('../../module/witcher/runtime.js');
  const [item] = await w.attacker.createEmbeddedDocuments('Item', [magicItemData(key)]);
  const self = magicInfo(key).range.targeting === 'self';
  const message = await runCommand('magicCast', {
    actorUuid: w.attacker.uuid,
    itemId: item.id,
    expected: w.runtime.magicFingerprint(item),
    turn: turnIdentity(),
    tokenUuid: w.source.uuid,
    targetUuids: self ? [] : [w.targetToken.uuid],
    values: { power: power ?? magicInfo(key).cost.min, manualDice: '5' },
  });
  const row = message.flags[SYSTEM_ID].targets[0];
  if (accept && !self)
    await runCommand('magicDefense', {
      messageUuid: message.uuid,
      targetUuid: row.tokenUuid,
      turn: turnIdentity(),
      values: { defense: 'accept' },
    });
  return {
    message,
    row,
    apply: () => runCommand('magicApply', { messageUuid: message.uuid, targetUuid: row?.tokenUuid }),
  };
}

test('Talfryn actual cast creates one 15 HP roots token; escape must beat saved casting and preserves an unrelated grapple', async (t) => {
  const w = await setup(t),
    restraints = await restraintWorld(w);
  const cast = await castBookMagic(w, 'talfryns-prison');
  assert.equal(w.attacker.system.sta.value, 22);
  await cast.apply();
  const roots = [...game.actors].find((actor) => actor.flags[SYSTEM_ID]?.magicRestraint);
  assert(roots);
  assert.equal(roots.system.hp.value, 15);
  assert.equal(w.scene.tokens.size, 3);
  assert.equal(roots.flags[SYSTEM_ID].magicRestraint.active, true);
  assert(w.target.system.conditions.includes('grappled'));
  const sourceId = roots.flags[SYSTEM_ID].magicRestraint.effectId;
  assert(
    w.target.system.effects.some(
      (effect) => effect.id === sourceId && effect.magic.castId === cast.message.flags[SYSTEM_ID].castId
    )
  );
  await w.target.update({
    'system.effects': [
      ...w.target.system.effects,
      { id: 'other-grapple', key: 'Other roots', conditions: ['grappled'] },
    ],
  });
  const tie = cast.message.flags[SYSTEM_ID].check.total - w.target.skillBase('dodge').total;
  assert(tie >= 2 && tie <= 9);
  await runCommand('magicRestraintEscape', { rootsUuid: roots.uuid, manualDice: String(tie) });
  assert(w.target.system.effects.some((effect) => effect.id === sourceId));
  await runCommand('magicRestraintEscape', { rootsUuid: roots.uuid, manualDice: String(tie + 1) });
  await restraints.refreshMagicRestraints();
  assert.equal(w.docs.has(roots.uuid), false);
  assert.equal(w.scene.tokens.size, 2);
  assert(w.target.system.conditions.includes('grappled'));
  assert(w.target.system.effects.some((effect) => effect.id === 'other-grapple'));
  assert.equal(
    w.target.system.effects.some((effect) => effect.id === sourceId),
    false
  );
});

test('Talfryn actual cast destruction removes only the roots and restraint without hurting its target', async (t) => {
  const w = await setup(t),
    restraints = await restraintWorld(w);
  const cast = await castBookMagic(w, 'talfryns-prison');
  await cast.apply();
  const roots = [...game.actors].find((actor) => actor.flags[SYSTEM_ID]?.magicRestraint);
  await runCommand('magicRestraintDamage', {
    rootsUuid: roots.uuid,
    amount: 14,
    evidence: 'Sword damage 14',
    damageEvent: 'first-hit',
  });
  await restraints.refreshMagicRestraints();
  assert.equal(roots.system.hp.value, 1);
  assert(w.target.system.conditions.includes('grappled'));
  await runCommand('magicRestraintDamage', {
    rootsUuid: roots.uuid,
    amount: 1,
    evidence: 'Sword damage 1',
    damageEvent: 'second-hit',
  });
  await restraints.refreshMagicRestraints();
  assert.equal(w.target.system.hp.value, 25);
  assert.equal(w.target.system.conditions.includes('grappled'), false);
  assert.equal(w.scene.tokens.size, 2);
  assert.equal(w.docs.has(roots.uuid), false);
});

test('Talfryn failed final cast receipt restores target and removes created roots and controls; a retry applies once', async (t) => {
  const w = await setup(t);
  await restraintWorld(w);
  const cast = await castBookMagic(w, 'talfryns-prison');
  const before = clone(w.target._source),
    messagesBefore = w.messages.size;
  w.faults.update = (document, changes) =>
    document.uuid === cast.message.uuid &&
    changes[`flags.${SYSTEM_ID}`]?.targets?.some((row) => row.status === 'applied');
  await assert.rejects(cast.apply(), /Injected/);
  assert.deepEqual(w.target._source, before);
  assert.equal(game.actors.size, 2);
  assert.equal(w.scene.tokens.size, 2);
  assert.equal(w.messages.size, messagesBefore);
  w.faults.update = null;
  await cast.apply();
  assert.equal(game.actors.size, 3);
  assert.equal(w.scene.tokens.size, 3);
  await assert.rejects(cast.apply(), /already|resolved|defense/i);
});

test('Adenydd actual cast grants glide and protects landing; ending the source restores ordinary falling damage', async (t) => {
  const w = await setup(t);
  const { registerMagicMovement } = await import('../../module/witcher/magic-movement.js');
  const { directWeaponDamage } = await import('../../module/witcher/consequences.js');
  const { turnIdentity } = await import('../../module/witcher/runtime.js');
  enableRegions(w);
  registerMagicMovement();
  Object.assign(w.source, {
    elevation: 20,
    toObject() {
      return { x: this.x, y: this.y, elevation: this.elevation, level: this.level };
    },
    getMovementOrigin(data = this) {
      return { x: data.x + 50, y: data.y + 50, elevation: data.elevation };
    },
    object: { checkCollision: () => false },
    async update(changes) {
      Object.assign(this, changes);
    },
  });
  const cast = await castBookMagic(w, 'adenydd');
  await cast.apply();
  assert.equal(w.attacker.system.sta.value, 21);
  assert(
    w.attacker.system.effects.some(
      (effect) => effect.magic.key === 'adenydd' && effect.magic.operation?.rule?.key === 'glide'
    )
  );
  await runCommand('magicGlide', {
    actorUuid: w.attacker.uuid,
    tokenUuid: w.source.uuid,
    descent: 4,
    placement: { x: 250, y: 50 },
    expectedOrigin: { ...w.source.getMovementOrigin(), level: 'ground' },
    expectedTurn: turnIdentity(),
  });
  assert.deepEqual([w.source.x, w.source.y, w.source.elevation], [200, 0, 16]);
  const fall = () =>
    directWeaponDamage(
      w.attacker,
      w.attacker,
      {
        id: 'fall',
        name: 'Falling damage',
        damage: '2d6',
        damageTypes: ['bludgeoning'],
        properties: { environmental: true, natural: true, damageSource: 'falling', activeAtLanding: true },
      },
      { location: 'torso' }
    );
  w.enqueue(['2d6', 8]);
  const protectedFall = await fall();
  assert.equal(protectedFall.flags[SYSTEM_ID].summary[0].damage, 0);
  await w.apply(protectedFall);
  assert.equal(w.attacker.system.hp.value, 25);
  await w.runtime.endMagicCast(cast.message.flags[SYSTEM_ID].castId);
  await assert.rejects(
    runCommand('magicGlide', {
      actorUuid: w.attacker.uuid,
      tokenUuid: w.source.uuid,
      descent: 4,
      placement: { x: 450, y: 50 },
      expectedOrigin: { ...w.source.getMovementOrigin(), level: 'ground' },
      expectedTurn: turnIdentity(),
    }),
    /No active spell/
  );
  w.enqueue(['2d6', 8]);
  const ordinaryFall = await fall();
  assert.equal(ordinaryFall.flags[SYSTEM_ID].summary[0].damage, 8);
  await w.apply(ordinaryFall);
  if (!ordinaryFall.flags[SYSTEM_ID].applied) await w.apply(ordinaryFall);
  assert.equal(w.attacker.system.hp.value, 17);
});

for (const [power, condition] of [
  [2, 'staggered'],
  [4, 'stunned'],
  [6, 'poison'],
])
  test(`Cursed Illness ${power} STA actual cast applies ${condition}; its paid Endurance recovery ends the source`, async (t) => {
    const w = await setup(t);
    const { registerMagicRecovery } = await import('../../module/witcher/magic-recovery.js');
    registerMagicRecovery();
    await w.attacker.update({ 'system.magic.tradition': 'druid' });
    const cast = await castBookMagic(w, 'cursed-illness', { power });
    await cast.apply();
    assert.equal(w.attacker.system.sta.value, 25 - power);
    assert(w.target.system.conditions.includes(condition));
    const effect = w.target.system.effects.find((effect) => effect.magic?.ongoing?.managed);
    assert(effect);
    w.start();
    game.combat.combatant.actor = w.target;
    await runCommand('magicRecoveryRequest', { actorUuid: w.target.uuid, effectId: effect.id });
    const needed = cast.message.flags[SYSTEM_ID].check.total - w.target.skillBase('endurance').total + 1;
    assert(needed >= 2 && needed <= 9);
    await w.saves(w.target, { manualDice: String(needed) });
    assert.equal(w.target.system.combat.actions, 1);
    assert.equal(w.target.system.conditions.includes(condition), false);
    assert.equal(
      w.target.system.effects.some((effect) => effect.magic?.castId === cast.message.flags[SYSTEM_ID].castId),
      false
    );
  });

test('an ordinary equipped weapon can attack the real Talfryn roots through combat and release its captive', async (t) => {
  const w = await setup(t),
    restraints = await restraintWorld(w);
  const cast = await castBookMagic(w, 'talfryns-prison');
  await cast.apply();
  const roots = [...game.actors].find((actor) => actor.flags[SYSTEM_ID]?.magicRestraint);
  const sword = await w.importItem(w.attacker, 'Iron Long Sword', { equipped: true });
  w.start();
  const attack = await runCommand('attack', {
    actorUuid: w.attacker.uuid,
    targetUuid: roots.uuid,
    itemId: sword.id,
    expectedTurn: w.turn(),
    values: {
      action: 'normal',
      style: 'fast',
      location: 'roots',
      type: 'slashing',
      modifier: 0,
      luck: 0,
      cover: 0,
      extra: false,
      manualDice: '5',
    },
  });
  w.enqueue([sword.system.damage, 15]);
  await runCommand('defend', {
    messageUuid: attack.uuid,
    expectedTurn: w.turn(),
    values: { defense: 'passive', dc: 10, modifier: 0, luck: 0, gang: 1 },
  });
  const damage = w.damageFor(attack);
  assert(damage);
  assert.equal(damage.flags[SYSTEM_ID].targetUuid, roots.uuid);
  await w.apply(damage);
  if (!damage.flags[SYSTEM_ID].applied) await w.apply(damage);
  await restraints.refreshMagicRestraints();
  assert.equal(w.docs.has(roots.uuid), false);
  assert.equal(w.target.system.conditions.includes('grappled'), false);
  assert.equal(w.target.system.hp.value, 25);
});

async function windFogWorld(w) {
  enableRegions(w);
  w.scene.dimensions = { sceneRect: { x: -2000, y: -2000, width: 4000, height: 4000 } };
  w.scene.testSurfaceCollision = () => false;
  CONFIG.Canvas.detectionModes = {
    basicSight: { type: 0 },
    lightPerception: { type: 0 },
    darkvision: { type: 0 },
  };
  CONFIG.Canvas.polygonBackends.move = { testCollision: () => false };
  for (const token of w.scene.tokens)
    Object.assign(token, {
      sight: { enabled: true, range: null },
      detectionModes: {},
      depth: 0,
      toObject() {
        return clone({
          x: this.x,
          y: this.y,
          elevation: this.elevation,
          level: this.level,
          width: this.width,
          height: this.height,
          depth: this.depth,
          sight: this.sight,
          detectionModes: this.detectionModes,
          flags: this.flags,
        });
      },
      getMovementOrigin(data = this) {
        return { x: data.x + 50, y: data.y + 50, elevation: data.elevation };
      },
      async update(changes) {
        for (const [path, value] of Object.entries(changes)) {
          const parts = path.split('.'),
            key = parts.pop();
          let object = this;
          for (const part of parts) object = object[part] ??= {};
          if (key.startsWith('-=')) delete object[key.slice(2)];
          else object[key] = clone(value);
        }
      },
    });
  const wind = await import('../../module/witcher/magic-wind-fog.js');
  wind.registerWindFog();
  return wind;
}
async function castAreaMagic(w, key, choices) {
  const { turnIdentity } = await import('../../module/witcher/runtime.js');
  const [item] = await w.attacker.createEmbeddedDocuments('Item', [magicItemData(key)]);
  const origin = { ...w.source.getMovementOrigin(), level: 'ground' };
  const message = await runCommand('magicCast', {
    actorUuid: w.attacker.uuid,
    itemId: item.id,
    expected: w.runtime.magicFingerprint(item),
    turn: turnIdentity(),
    tokenUuid: w.source.uuid,
    targetUuids: [],
    area: { placement: origin, origin },
    values: { power: magicInfo(key).cost.min, manualDice: '5', choices },
  });
  return message;
}

test('Zephyr actual area casting damages and pushes selected occupants 6m, respecting the recorded caster ruling', async (t) => {
  const w = await setup(t);
  await windFogWorld(w);
  await w.targetToken.update({ x: 50 });
  const message = await castAreaMagic(w, 'zephyr', { zephyrAffectsCaster: false });
  assert.equal(message.flags[SYSTEM_ID].targets.length, 1);
  assert.equal(message.flags[SYSTEM_ID].targets[0].actorUuid, w.target.uuid);
  assert.equal(message.flags[SYSTEM_ID].targets[0].status, 'pending');
  const { turnIdentity } = await import('../../module/witcher/runtime.js');
  await runCommand('magicDefense', {
    messageUuid: message.uuid,
    targetUuid: w.targetToken.uuid,
    turn: turnIdentity(),
    values: { defense: 'accept' },
  });
  w.enqueue(['1d10', 2], ['1d6', 4]);
  await runCommand('magicApply', { messageUuid: message.uuid, targetUuid: w.targetToken.uuid });
  assert.equal(w.targetToken.x, 350);
  assert.equal(w.source.x, 0);
  const damage = w.damageCards()[0];
  assert(damage);
  await w.apply(damage);
  if (!damage.flags[SYSTEM_ID].applied) await w.apply(damage);
  assert.equal(w.target.system.hp.value, 21);
  assert.equal(w.attacker.system.hp.value, 25);
});

test('Dormyn actual cast reconciles both actors and native sight after commit, then ending the source restores them', async (t) => {
  const w = await setup(t),
    wind = await windFogWorld(w);
  const message = await castAreaMagic(w, 'dormyns-fog', { followCaster: false });
  assert.equal(message.flags[SYSTEM_ID].targets.length, 0);
  const beforeAwareness = w.target.skillBase('awareness').total;
  await runCommand('magicApply', { messageUuid: message.uuid });
  assert.equal(w.scene.regions.size, 1);
  assert.equal(w.targetToken.sight.range, 4);
  assert.equal(w.source.sight.range, 4);
  assert.equal(w.target.skillBase('awareness').total, beforeAwareness - 3);
  assert(w.attacker.system.effects.some((effect) => effect.magic?.key === 'modifier-zone'));
  await w.runtime.endMagicCast(message.flags[SYSTEM_ID].castId);
  await wind.refreshModifierZones();
  assert.equal(w.scene.regions.size, 0);
  assert.equal(w.targetToken.sight.range, null);
  assert.equal(w.source.sight.range, null);
  assert.equal(w.target.skillBase('awareness').total, beforeAwareness);
});

test('Dormyn final receipt failure compensates the Region, every affected Actor and native sight', async (t) => {
  const w = await setup(t);
  await windFogWorld(w);
  const message = await castAreaMagic(w, 'dormyns-fog', { followCaster: false });
  const beforeCaster = clone(w.attacker._source.system),
    beforeTarget = clone(w.target._source.system);
  w.faults.update = (document, changes) =>
    document.uuid === message.uuid && changes[`flags.${SYSTEM_ID}`]?.applied === true;
  await assert.rejects(runCommand('magicApply', { messageUuid: message.uuid }), /Injected/);
  assert.equal(w.scene.regions.size, 0);
  assert.deepEqual(w.attacker._source.system, beforeCaster);
  assert.deepEqual(w.target._source.system, beforeTarget);
  assert.equal(w.targetToken.sight.range, null);
  assert.equal(w.source.sight.range, null);
  w.faults.update = null;
  await runCommand('magicApply', { messageUuid: message.uuid });
  assert.equal(w.scene.regions.size, 1);
  assert.equal(w.targetToken.sight.range, 4);
});

test('Dormyn unpaid upkeep ends its Region and restores native sight instead of reapplying an orphaned fog', async (t) => {
  const w = await setup(t),
    wind = await windFogWorld(w);
  const { tickMagicLifecycle } = await import('../../module/witcher/magic-lifecycle.js');
  const message = await castAreaMagic(w, 'dormyns-fog', { followCaster: false });
  await runCommand('magicApply', { messageUuid: message.uuid });
  game.time.worldTime = 3;
  await tickMagicLifecycle();
  await wind.refreshModifierZones();
  assert.equal(w.targetToken.sight.range, 4);
  const marker = w.attacker.system.effects.find(
    (effect) => effect.magic?.casterEffect && effect.magic.castId === message.flags[SYSTEM_ID].castId
  );
  assert.equal(marker.magic.upkeepDue, true);
  game.time.worldTime = 6;
  await tickMagicLifecycle();
  await wind.refreshModifierZones();
  assert.equal(w.scene.regions.size, 0);
  assert.equal(w.targetToken.sight.range, null);
  assert.equal(w.source.sight.range, null);
  assert.equal(
    w.target.system.effects.some((effect) => effect.magic?.key === 'modifier-zone'),
    false
  );
});

test('a fresh continuing attack check replaces a stored numeric save with an opposed check whose ties defend', async (t) => {
  const w = await setup(t);
  const result = await executeContinuingAttack([{ ...w.operation, save: { skill: 'dodge', dc: 20 } }], {
    ...w.context,
    values: { manualDice: '5' },
    actionRule: { newCastingCheckEachAttack: true },
  });
  const attack = w.docs.get(result.receipt.attackMessageUuid);
  assert.equal(attack.flags[SYSTEM_ID].check.total, 15);
  const pending = Object.values(
    w.target.system.effects.find((effect) => effect.magic?.ongoing?.managed).magic.ongoing.pending
  )[0];
  assert.equal(pending.dc, 15);
  assert.equal(pending.comparison, 'atLeast');
  await w.saves(w.target, { skill: 'dodge', manualDice: '5' });
  assert.equal(w.damageCards().length, 0);
});

test('a player can submit either agreed Dormyn area convention, while absent or nonboolean choices are rejected', async (t) => {
  const w = await setup(t);
  const { validateMagicChoices, magicChoiceFields } = await import('../../module/witcher/magic-choices.js');
  const magic = magicInfo('dormyns-fog');
  const context = {
    caster: w.attacker,
    targets: [],
    user: { id: 'player', isGM: false },
    resolveUuid: foundry.utils.fromUuid,
  };
  for (const followCaster of [true, false])
    assert.deepEqual(await validateMagicChoices(magic, { followCaster }, context), { followCaster });
  await assert.rejects(validateMagicChoices(magic, {}, context), /Complete the spell choices/);
  await assert.rejects(validateMagicChoices(magic, { followCaster: 'false' }, context), /true or false/);
  assert.match(magicChoiceFields(magic, w.attacker), /Table convention: fog follows caster/);
});
