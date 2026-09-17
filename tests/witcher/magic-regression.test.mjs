/** Real command handlers with controlled document persistence. These tests do not
 * replace acceptance in a running Foundry V14 world. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { workflow, clone } from './workflow-fixture.mjs';
import { magicItemData } from '../../module/witcher/magic-catalog.js';
import { SYSTEM_ID } from '../../module/witcher/config.js';
import { runCommand } from '../../module/witcher/authority.js';

async function fixture(t) {
  const w = await workflow(t),
    oldConfig = Object.getOwnPropertyDescriptor(globalThis, 'CONFIG');
  t.after(() => {
    if (oldConfig) Object.defineProperty(globalThis, 'CONFIG', oldConfig);
    else delete globalThis.CONFIG;
  });
  globalThis.CONFIG = {
    Canvas: {
      polygonBackends: { sight: { testCollision: () => false }, move: { testCollision: () => false } },
    },
  };
  const scene = {
    id: 'magic',
    uuid: 'Scene.magic',
    grid: { size: 100, distance: 2, units: 'm' },
    tokens: new w.Collection(),
    regions: new w.Collection(),
  };
  game.scenes = new w.Collection([[scene.id, scene]]);
  game.actors = new w.Collection([
    [w.attacker.id, w.attacker],
    [w.target.id, w.target],
  ]);
  const place = (actor, x = 0) => {
    const token = {
      id: actor.id,
      uuid: `Scene.magic.Token.${actor.id}`,
      parent: scene,
      actor,
      name: actor.name,
      x,
      y: 0,
      width: 1,
      height: 1,
      elevation: 0,
      flags: {},
      getMovementOrigin() {
        return { x: this.x + 50, y: this.y + 50, elevation: this.elevation };
      },
      getSize() {
        return { width: 100, height: 100 };
      },
      async update(changes) {
        Object.assign(this, changes);
        return this;
      },
    };
    scene.tokens.set(token.id, token);
    w.docs.set(token.uuid, token);
    return token;
  };
  const source = place(w.attacker),
    targetToken = place(w.target, 200);
  for (const actor of [w.attacker, w.target])
    await actor.update({
      'system.vigor': 7,
      'system.magic': {
        tradition: 'mage',
        roundKey: '',
        spent: 0,
        coneAngle: 90,
        speech: true,
        gestures: true,
        minorGestures: true,
        exhaustedRecovery: 0,
      },
    });
  const runtime = await import('../../module/witcher/magic-runtime.js');
  runtime.registerMagicCommands();
  const { turnIdentity } = await import('../../module/witcher/runtime.js');
  const learn = async (key, actor = w.attacker) =>
    (await actor.createEmbeddedDocuments('Item', [magicItemData(key)]))[0];
  const cast = (item, values = {}, overrides = {}) =>
    runCommand('magicCast', {
      actorUuid: w.attacker.uuid,
      itemId: item.id,
      expected: runtime.magicFingerprint(item),
      turn: turnIdentity(),
      tokenUuid: source.uuid,
      targetUuids: [targetToken.uuid],
      values: { power: 2, manualDice: '5', ...values },
      ...overrides,
    });
  const accept = (message) =>
    runCommand('magicDefense', {
      messageUuid: message.uuid,
      targetUuid: targetToken.uuid,
      turn: turnIdentity(),
      values: { defense: 'accept' },
    });
  const apply = (message, targetUuid) => runCommand('magicApply', { messageUuid: message.uuid, targetUuid });
  const counter = (message, values = {}) =>
    runCommand('magicCounter', {
      messageUuid: message.uuid,
      reactorUuid: w.target.uuid,
      tokenUuid: targetToken.uuid,
      turn: turnIdentity(),
      values: { defense: 'dispel', manualDice: '8', ...values },
    });
  return {
    ...w,
    scene,
    source,
    targetToken,
    place,
    learn,
    cast,
    accept,
    applyMagic: apply,
    counter,
    turnIdentity,
    runtime,
  };
}

test('magic preflight rejects a stale item, stale turn and foreign caster token before expenditure', async (t) => {
  const w = await fixture(t),
    quen = await w.learn('quen'),
    before = clone(w.attacker._source);
  await assert.rejects(w.cast(quen, {}, { expected: 'stale' }), /entry changed/);
  await assert.rejects(w.cast(quen, {}, { turn: 'old:1:0' }), /turn changed/);
  await assert.rejects(w.cast(quen, {}, { tokenUuid: w.targetToken.uuid }), /no longer matches/);
  await assert.rejects(w.cast(quen, { manualDice: '10' }), /next d10/);
  assert.deepEqual(w.attacker._source, before);
  assert.equal(w.messages.size, 0);
  assert.equal(w.rolls.length, 0);
});

test('magic effect application compensates the actor when the casting-card update fails', async (t) => {
  const w = await fixture(t),
    quen = await w.learn('quen'),
    message = await w.cast(quen);
  const before = clone(w.attacker._source);
  w.faults.update = (candidate) => candidate === message;
  await assert.rejects(w.applyMagic(message), /Injected/);
  assert.deepEqual(w.attacker._source, before);
  assert.equal(message.flags[SYSTEM_ID].applied, false);
  w.faults.update = null;
  await w.applyMagic(message);
  assert.equal(w.attacker.system.effects.filter((effect) => effect.magic?.key === 'quen').length, 1);
  assert.equal(w.attacker.system.effects[0].shieldHP, 10);
  await assert.rejects(w.applyMagic(message), /already been applied/);
});

test('a successful magical block rolls back REL, Luck, defense budget and response on receipt failure', async (t) => {
  const w = await fixture(t),
    stream = await w.learn('fire-stream'),
    shield = await w.importItem(w.target, 'Leather Shield', { equipped: true });
  const message = await w.cast(stream, { manualDice: '2' }),
    before = clone(w.target._source),
    rel = shield.system.reliability,
    size = w.messages.size;
  w.faults.update = (candidate) => candidate === message;
  await assert.rejects(
    runCommand('magicDefense', {
      messageUuid: message.uuid,
      targetUuid: w.targetToken.uuid,
      turn: w.turnIdentity(),
      values: { defense: 'block', weaponId: shield.id, manualDice: '9', luck: 1 },
    }),
    /Injected/
  );
  assert.deepEqual(w.target._source, before);
  assert.equal(shield.system.reliability, rel);
  assert.equal(w.messages.size, size);
  assert.equal(message.flags[SYSTEM_ID].targets[0].status, 'pending');
});

test('disallowed magical defense and malformed manual roll never consume a defensive action', async (t) => {
  const w = await fixture(t),
    axii = await w.learn('axii'),
    message = await w.cast(axii),
    before = clone(w.target._source);
  for (const values of [
    { defense: 'dodge', manualDice: '8' },
    { defense: 'resistMagic', manualDice: '1,10' },
  ])
    await assert.rejects(
      runCommand('magicDefense', {
        messageUuid: message.uuid,
        targetUuid: w.targetToken.uuid,
        turn: w.turnIdentity(),
        values,
      })
    );
  assert.deepEqual(w.target._source, before);
  assert.equal(message.flags[SYSTEM_ID].targets[0].status, 'pending');
});

test('counter magic rejects a stale response turn before consuming STA or an action', async (t) => {
  const w = await fixture(t),
    axii = await w.learn('axii');
  await w.learn('dispel', w.target);
  const message = await w.cast(axii),
    before = clone(w.target._source);
  await assert.rejects(
    runCommand('magicCounter', {
      messageUuid: message.uuid,
      reactorUuid: w.target.uuid,
      tokenUuid: w.targetToken.uuid,
      turn: 'old:1:0',
      values: { defense: 'dispel', manualDice: '8' },
    }),
    /turn changed/
  );
  assert.deepEqual(w.target._source, before);
  assert.equal(message.flags[SYSTEM_ID].cancelled, false);
});

test('counter magic preserves the Dispel strict-win rule and Heliotrope tie rule', async (t) => {
  const w = await fixture(t),
    axii = await w.learn('axii');
  await w.learn('dispel', w.target);
  let message = await w.cast(axii, { power: 3, manualDice: '5' });
  await w.counter(message, { manualDice: '5' });
  assert.equal(message.flags[SYSTEM_ID].cancelled, false);
  assert.equal(w.target.system.sta.value, 23.5);
  await assert.rejects(w.counter(message), /already attempted/);
  await w.target.update({
    'system.race': 'witcher',
    'system.magic.tradition': 'witcher',
    'system.professionRanks.heliotrope': 5,
  });
  message = await w.cast(axii, { power: 3, manualDice: '5' });
  await w.counter(message, { defense: 'heliotrope', manualDice: '5' });
  assert.equal(message.flags[SYSTEM_ID].targets[0].status, 'defended');
  assert.equal(
    message.flags[SYSTEM_ID].cancelled,
    false,
    'Heliotrope protects its own target rather than cancelling every area target'
  );
});

test('a counter receipt failure restores resources and removes its uncommitted chat response', async (t) => {
  const w = await fixture(t),
    axii = await w.learn('axii');
  await w.learn('dispel', w.target);
  const message = await w.cast(axii),
    before = clone(w.target._source),
    count = w.messages.size;
  w.faults.update = (candidate) => candidate === message;
  await assert.rejects(w.counter(message, { luck: 2 }), /Injected/);
  assert.deepEqual(w.target._source, before);
  assert.equal(w.messages.size, count);
  assert.equal(message.flags[SYSTEM_ID].cancelled, false);
  assert.equal(message.flags[SYSTEM_ID].counters, undefined);
});

test('catastrophic counter fumbles persist pending backlash and a Death save', async (t) => {
  const w = await fixture(t),
    axii = await w.learn('axii');
  await w.learn('dispel', w.target);
  const message = await w.cast(axii);
  await w.target.update({ 'system.hp.value': 10 });
  w.enqueue(['1d4', 2]);
  const response = await w.counter(message, { manualDice: '1,10,2' }),
    data = response.flags[SYSTEM_ID];
  assert.equal(w.target.system.hp.value, -2);
  assert.equal(w.target.system.pendingDeathSaves, 1);
  assert.equal(data.kind, 'magic-backlash');
  assert.equal(data.backlash.pushMeters, 2);
  assert.equal(data.fumble.focusExplosion, true);
  assert.equal(data.backlashResolved, false);
  assert.match(response.content, /data-magic-action="backlash"/);
});

test('Active Shield upkeep charges once per round and applies Earth overdraw backlash', async (t) => {
  const w = await fixture(t),
    spell = await w.learn('active-shield');
  w.start();
  const message = await w.cast(spell, { power: 4 });
  await w.applyMagic(message);
  const effect = w.attacker.system.effects.find((row) => row.magic?.key === 'active-shield');
  await assert.rejects(
    runCommand('magicMaintain', {
      actorUuid: w.attacker.uuid,
      effectId: effect.id,
      turn: w.turnIdentity(),
      values: {},
    }),
    /already been paid/
  );
  game.combat.round++;
  await w.attacker.update({ 'system.vigor': 2 });
  await runCommand('magicMaintain', {
    actorUuid: w.attacker.uuid,
    effectId: effect.id,
    turn: w.turnIdentity(),
    values: { overdraw: true },
  });
  assert.equal(w.attacker.system.sta.value, 17);
  assert.equal(w.attacker.system.hp.value, 15);
  assert(w.attacker.system.conditions.includes('stunned'));
  const before = clone(w.attacker._source);
  await assert.rejects(
    runCommand('magicMaintain', {
      actorUuid: w.attacker.uuid,
      effectId: effect.id,
      turn: w.turnIdentity(),
      values: { overdraw: true },
    }),
    /already been paid/
  );
  assert.deepEqual(w.attacker._source, before);
});

test('upkeep cannot be repeatedly paid outside combat before world time advances', async (t) => {
  const w = await fixture(t),
    spell = await w.learn('active-shield'),
    message = await w.cast(spell);
  await w.applyMagic(message);
  const effect = w.attacker.system.effects.find((row) => row.magic?.key === 'active-shield');
  const request = () =>
    runCommand('magicMaintain', { actorUuid: w.attacker.uuid, effectId: effect.id, turn: '', values: {} });
  await assert.rejects(request(), /world time/);
  game.time.worldTime = 3;
  await request();
  assert.equal(w.attacker.system.sta.value, 21);
  await assert.rejects(request(), /world time/);
});

test('sustained Fire Stream keeps initial power while charging fractional upkeep and preserves manual dice', async (t) => {
  const w = await fixture(t),
    stream = await w.learn('fire-stream');
  w.start();
  await w.cast(stream, { power: 3 });
  const effect = w.attacker.system.effects.find((row) => row.magic?.key === 'fire-stream');
  game.combat.round++;
  const response = await runCommand('magicMaintain', {
    actorUuid: w.attacker.uuid,
    effectId: effect.id,
    turn: w.turnIdentity(),
    values: { targetUuid: w.targetToken.uuid, manualDice: '6', luck: 1 },
  });
  const data = response.flags[SYSTEM_ID];
  assert.equal(data.power, 3);
  assert.equal(data.resolved.damageFormula, '3d6');
  assert.equal(data.staCost, 1.5);
  assert.deepEqual(data.check.dice, [6]);
  assert.equal(data.check.source, 'manual');
  assert.equal(w.attacker.system.luck.value, 4);
  assert.equal(w.attacker.system.sta.value, 20.5);
});

test('a Fire Stream maintenance-card failure restores STA, Luck, action budget and upkeep metadata', async (t) => {
  const w = await fixture(t),
    stream = await w.learn('fire-stream');
  w.start();
  await w.cast(stream, { power: 3 });
  game.combat.round++;
  const effect = w.attacker.system.effects.find((row) => row.magic?.key === 'fire-stream'),
    before = clone(w.attacker._source);
  w.faults.create = (data) => data.flags?.[SYSTEM_ID]?.kind === 'magic';
  await assert.rejects(
    runCommand('magicMaintain', {
      actorUuid: w.attacker.uuid,
      effectId: effect.id,
      turn: w.turnIdentity(),
      values: { targetUuid: w.targetToken.uuid, manualDice: '6', luck: 1 },
    }),
    /Injected/
  );
  assert.deepEqual(w.attacker._source, before);
});

test('a serious Fire Stream maintenance fumble consumes upkeep, fails, ignites and schedules lethal consequences', async (t) => {
  const w = await fixture(t),
    stream = await w.learn('fire-stream');
  w.start();
  await w.cast(stream, { power: 3 });
  game.combat.round++;
  await w.attacker.update({ 'system.hp.value': 7 });
  const effect = w.attacker.system.effects.find((row) => row.magic?.key === 'fire-stream');
  const result = await runCommand('magicMaintain', {
    actorUuid: w.attacker.uuid,
    effectId: effect.id,
    turn: w.turnIdentity(),
    values: { targetUuid: w.targetToken.uuid, manualDice: '1,8' },
  });
  assert.equal(result.flags[SYSTEM_ID].failed, true);
  assert.equal(w.attacker.system.sta.value, 20.5);
  assert.equal(w.attacker.system.hp.value, -1);
  assert.equal(w.attacker.system.pendingDeathSaves, 1);
  assert(w.attacker.system.conditions.includes('fire'));
});

test('companion shields share the real pool only while tokens remain pressed together', async (t) => {
  const w = await fixture(t),
    shield = await w.learn('active-shield'),
    message = await w.cast(shield);
  await w.applyMagic(message);
  w.targetToken.x = 100;
  const effect = w.attacker.system.effects.find((row) => row.magic?.key === 'active-shield');
  await runCommand('magicProtect', {
    actorUuid: w.attacker.uuid,
    effectId: effect.id,
    targetUuid: w.targetToken.uuid,
  });
  const { companionShield, magicDamageSnapshot } = await import('../../module/witcher/magic-shields.js');
  assert.equal(companionShield(w.target).shield.id, effect.id);
  const snapshot = magicDamageSnapshot(w.target);
  assert.equal(snapshot.effects[0].ownerActorUuid, w.attacker.uuid);
  assert.equal(snapshot.effects[0].shieldHP, 20);
  snapshot.effects[0].shieldHP = 1;
  assert.equal(w.attacker.system.effects[0].shieldHP, 20, 'damage preview cannot mutate the shared pool');
  w.targetToken.x = 101;
  assert.equal(companionShield(w.target), null);
});

test('a companion-protection chat failure compensates links on both characters', async (t) => {
  const w = await fixture(t),
    shield = await w.learn('active-shield'),
    message = await w.cast(shield);
  await w.applyMagic(message);
  w.targetToken.x = 100;
  const effect = w.attacker.system.effects.find((row) => row.magic?.key === 'active-shield'),
    sourceBefore = clone(w.attacker._source),
    targetBefore = clone(w.target._source);
  w.faults.create = () => true;
  await assert.rejects(
    runCommand('magicProtect', {
      actorUuid: w.attacker.uuid,
      effectId: effect.id,
      targetUuid: w.targetToken.uuid,
    }),
    /Injected/
  );
  assert.deepEqual(w.attacker._source, sourceBefore);
  assert.deepEqual(w.target._source, targetBefore);
});
