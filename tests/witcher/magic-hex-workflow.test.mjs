import test from 'node:test';
import assert from 'node:assert/strict';
import { workflow } from './workflow-fixture.mjs';
import { SYSTEM_ID } from '../../module/witcher/config.js';
import { hexEffectData } from '../../module/witcher/magic-procedures.js';
import { magicInfo, magicItemData } from '../../module/witcher/magic-catalog.js';
import { resolveHexEvent, forgottenMagic } from '../../module/witcher/magic-hex-runtime.js';
const hex = (key, overrides = {}) => ({
  ...hexEffectData(magicInfo(key), {
    castId: key,
    casterUuid: 'Actor.caster',
    checkTotal: 18,
    createdAt: 0,
    id: key,
  }),
  ...overrides,
});

test('actual rest uses Nightmare resistance, retains HP/STA on failure, and removes third-night penalties after success', async (t) => {
  const w = await workflow(t),
    actor = w.attacker;
  await actor.update({
    'system.effects': [hex('the-nightmare')],
    'system.hp.value': 10,
    'system.sta.value': 12,
    'system.healingEnabled': true,
    'system.healingBonus': 0,
  });
  const beforeHP = actor.system.hp.value;
  for (let n = 1; n <= 3; n++) await actor.rest({ nightmareDice: { 'the-nightmare': '1,10,6' } });
  assert.equal(actor.system.hp.value, beforeHP);
  assert.equal(actor.system.effects[0].magic.nightsFailed, 3);
  assert.equal(actor.system.derived.mods.allActions, -2);
  assert.ok(actor.system.sta.value <= actor.system.sta.max);
  await actor.rest({ nightmareDice: { 'the-nightmare': '10,10,10,5' } });
  assert.equal(actor.system.effects[0].magic.nightsFailed, 0);
  assert.equal(actor.system.sta.value, actor.system.sta.max);
  assert.ok(actor.system.hp.value > beforeHP);
});

test('rest journal failure compensates hex counters and resources', async (t) => {
  const w = await workflow(t),
    actor = w.attacker;
  await actor.update({
    'system.effects': [hex('the-nightmare')],
    'system.hp.value': 10,
    'system.sta.value': 12,
  });
  const before = actor.system.toObject();
  w.faults.create = () => true;
  await assert.rejects(actor.rest({ nightmareDice: { 'the-nightmare': '5' } }), /Injected/);
  assert.equal(actor.system.effects[0].magic.nightsFailed, before.effects[0].magic.nightsFailed);
  assert.equal(actor.system.sta.value, before.sta.value);
});

test('daily Forgetfulness marks actual owned magic and cannot be invoked twice that day', async (t) => {
  const w = await workflow(t),
    actor = w.attacker;
  const [item] = await actor.createEmbeddedDocuments('Item', [magicItemData('axii')]);
  await actor.update({ 'system.effects': [hex('hex-of-forgetfulness')] });
  const request = {
    actorUuid: actor.uuid,
    effectId: 'hex-of-forgetfulness',
    event: 'forget',
    values: { memory: 'Axii', itemId: item.id, manualDice: '1,10,8' },
  };
  await resolveHexEvent(request, { user: game.user, id: 'forget-1' });
  assert.equal(forgottenMagic(actor.system, 'axii'), true);
  await assert.rejects(resolveHexEvent(request, { user: game.user, id: 'forget-2' }), /already invoked/);
  await actor.update({ 'system.effects': [] });
  assert.equal(forgottenMagic(actor.system, 'axii'), false);
});

test('Temperance actual consumption applies both conditions and rejects player-declared GM events', async (t) => {
  const w = await workflow(t),
    actor = w.attacker;
  await actor.update({ 'system.effects': [hex('curse-of-temperance')] });
  const request = {
    actorUuid: actor.uuid,
    effectId: 'curse-of-temperance',
    event: 'intoxicant',
    values: { consumed: true },
  };
  await assert.rejects(resolveHexEvent(request, { user: { ...game.user, isGM: false }, id: 'bad' }), /GM/);
  await resolveHexEvent(request, { user: game.user, id: 'drink' });
  assert.ok(actor.system.conditions.includes('intoxicated'));
  assert.ok(actor.system.conditions.includes('nausea'));
});
