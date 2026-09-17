import test from 'node:test';
import assert from 'node:assert/strict';
import { workflow } from './workflow-fixture.mjs';
import { ALCHEMY_PROFILES, alchemyEffect } from '../../module/witcher/alchemy-rules.js';
import { SYSTEM_ID } from '../../module/witcher/config.js';
import { prepareAlchemyVision } from '../../module/witcher/alchemy-vision.js';
import { alchemyElapsedRecovery, advanceAlchemyTime } from '../../module/witcher/alchemy-time.js';
import { executeBlackBlood, bloodRecoilPlan } from '../../module/witcher/alchemy-events.js';
import {
  gainAdrenaline,
  executeAdrenalineHP,
  endAdrenalineCombat,
  adrenalineState,
} from '../../module/witcher/adrenaline.js';
const dose = (key) => alchemyEffect(ALCHEMY_PROFILES[key], { id: key, now: 0 });

test('Cat prepares native darkvision without changing source and respects a native fog cap', () => {
  const source = { sight: { enabled: true, visionMode: 'basic', range: 0 }, detectionModes: {}, flags: {} };
  const token = { ...structuredClone(source), actor: { system: { effects: [dose('cat')] } } };
  prepareAlchemyVision(token);
  assert.equal(token.sight.visionMode, 'darkvision');
  assert.equal(token.sight.range, Infinity);
  assert.deepEqual(source.sight, { enabled: true, visionMode: 'basic', range: 0 });
  token.flags[SYSTEM_ID] = { fogVision: { sources: ['fog'], limit: 5 } };
  prepareAlchemyVision(token);
  assert.equal(token.sight.range, 5);
  assert.equal(token.detectionModes.basicSight.range, 5);
  const next = { ...structuredClone(source), actor: { system: { effects: [] } } };
  assert.equal(prepareAlchemyVision(next), false);
  assert.equal(next.sight.range, 0);
});

test('elapsed recovery stops at dose expiry, preserves partial rounds and commits once', async (t) => {
  const w = await workflow(t);
  await w.attacker.update({ 'system.effects': [dose('swallow')], 'system.hp.value': 1 });
  const first = alchemyElapsedRecovery(w.attacker.system, 4);
  assert.equal(first.healing, 3);
  assert.equal(alchemyElapsedRecovery({ ...w.attacker.system, effects: first.effects }, 5).healing, 0);
  await advanceAlchemyTime(w.attacker, 4);
  assert.equal(w.attacker.system.hp.value, 4);
  await advanceAlchemyTime(w.attacker, 4);
  assert.equal(w.attacker.system.hp.value, 4);
  const end = alchemyElapsedRecovery(w.attacker.system, 1000);
  assert.equal(end.healing, 57);
  assert.equal(alchemyElapsedRecovery({ ...w.attacker.system, effects: end.effects }, 2000).healing, 0);
});

test('Black Blood uses actual ingestion, poison immunity, collision-limited recoil and compensated writes', async (t) => {
  const w = await workflow(t);
  await w.attacker.update({ 'system.effects': [dose('black-blood')] });
  const scene = { id: 'scene' },
    dimensions = { size: 100, distance: 2, sceneRect: { x: 0, y: 0, right: 1000, bottom: 1000 } };
  const token = (actor, x) => {
    const doc = {
      uuid: 'Token.' + actor.id,
      actor,
      x,
      y: 200,
      async update(changes) {
        Object.assign(this, changes);
        this.object.center.x = this.x + 50;
      },
    };
    doc.object = {
      document: doc,
      scene,
      w: 100,
      h: 100,
      center: { x: x + 50, y: 250 },
      checkCollision: (point) => point.x > 425,
    };
    w.docs.set(doc.uuid, doc);
    return doc;
  };
  const src = token(w.attacker, 100),
    dst = token(w.target, 300);
  canvas.dimensions = dimensions;
  const move = bloodRecoilPlan(src.object, dst.object, dimensions);
  assert(Math.abs(move.x - 375) < 0.001);
  const args = { actorUuid: w.attacker.uuid, sourceTokenUuid: src.uuid, targetTokenUuid: dst.uuid };
  w.faults.create = (data) => data.flags?.[SYSTEM_ID]?.kind === 'blackBlood';
  await assert.rejects(() => executeBlackBlood(args, { user: game.user, id: 'dose' }), /Injected/);
  assert.equal(dst.x, 300);
  assert(!w.target.system.conditions.includes('poison'));
  w.faults.create = null;
  await executeBlackBlood(args, { user: game.user, id: 'dose' });
  assert(w.target.system.conditions.includes('poison'));
  assert.equal(w.target.system.effects.at(-1).dc, 20);
  const count = w.target.system.effects.length;
  await executeBlackBlood(args, { user: game.user, id: 'dose' });
  assert.equal(w.target.system.effects.length, count);
});

test('optional adrenaline caps at BODY, doubles Maribor gain once, pays STA and expires residual HP', async (t) => {
  const w = await workflow(t);
  w.start();
  game.settings.get = (scope, key) => (key === 'adrenaline' ? true : 'publicroll');
  await w.attacker.update({ 'system.effects': [dose('maribor-forest')] });
  await gainAdrenaline(w.attacker, 'crit1', { critical: true });
  await gainAdrenaline(w.attacker, 'crit1', { critical: true });
  assert.equal(adrenalineState(w.attacker).dice, 2);
  await gainAdrenaline(w.attacker, 'crit2', { critical: true });
  await gainAdrenaline(w.attacker, 'crit3', { critical: true });
  assert.equal(adrenalineState(w.attacker).dice, 5);
  w.enqueue(['2d6', 7]);
  await executeAdrenalineHP({ actorUuid: w.attacker.uuid, count: 2 }, { user: game.user });
  assert.equal(w.attacker.system.sta.value, 5);
  assert.equal(w.attacker.system.hp.value, 32);
  assert.equal(adrenalineState(w.attacker).dice, 3);
  const { commitActor } = await import('../../module/witcher/runtime.js');
  await commitActor(w.attacker, { 'system.hp.value': 28 });
  assert.equal(w.attacker.system.effects.find((x) => x.adrenaline).temporaryHp, 3);
  await endAdrenalineCombat(w.attacker, 'combat');
  assert.equal(w.attacker.system.hp.value, 25);
  assert.equal(adrenalineState(w.attacker).dice, 0);
});
