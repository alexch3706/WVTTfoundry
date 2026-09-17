import test from 'node:test';
import assert from 'node:assert/strict';
import { workflow, clone } from './workflow-fixture.mjs';
import { SYSTEM_ID } from '../../module/witcher/config.js';
import { tickMagicLifecycle } from '../../module/witcher/magic-lifecycle.js';
import { endMagicSource } from '../../module/witcher/magic-source-cleanup.js';

async function setup(t) {
  const w = await workflow(t),
    regions = new w.Collection();
  const scene = { id: 'cleanup', uuid: 'Scene.cleanup', regions, tokens: new w.Collection() };
  const faults = { deleteId: '' };
  function region(source) {
    const record = clone(source),
      id = record._id;
    const doc = {
      id,
      uuid: `${scene.uuid}.Region.${id}`,
      parent: scene,
      get flags() {
        return record.flags;
      },
      toObject: () => clone(record),
      async update(changes) {
        for (const [path, value] of Object.entries(changes)) {
          const parts = path.split('.'),
            key = parts.pop();
          let state = record;
          for (const part of parts) state = state[part] ??= {};
          if (key.startsWith('-=')) delete state[key.slice(2)];
          else state[key] = clone(value);
        }
        return this;
      },
      async delete() {
        if (faults.deleteId === id) {
          faults.deleteId = '';
          throw new Error('Injected Region delete failure');
        }
        regions.delete(id);
        w.docs.delete(this.uuid);
      },
    };
    regions.set(id, doc);
    w.docs.set(doc.uuid, doc);
    return doc;
  }
  scene.createEmbeddedDocuments = async (type, records, options) => {
    assert.equal(type, 'Region');
    assert.equal(options.keepId, true);
    return records.map(region);
  };
  const placeRegion = (id, castId, active = true) =>
    region({
      _id: id,
      name: `Saved ${id}`,
      shapes: [{ type: 'circle', x: 50, y: 50, radius: 100 }],
      behaviors: [{ _id: 'behavior', type: `${SYSTEM_ID}.magicArea`, system: {} }],
      flags: { [SYSTEM_ID]: { magicArea: { castId, active, key: 'dormyns-fog' } } },
    });
  game.actors = new w.Collection([
    [w.attacker.id, w.attacker],
    [w.target.id, w.target],
  ]);
  game.scenes = new w.Collection([[scene.id, scene]]);
  return { ...w, scene, placeRegion, cleanupFaults: faults };
}

const maintained = (castId) => ({
  id: `source-${castId}`,
  expires: 0,
  magic: {
    key: 'dormyns-fog',
    castId,
    casterEffect: true,
    maintenance: 'fixed',
    createdAt: 0,
    paidAt: 0,
    nextUpkeepAt: 3,
    maintenanceIntervalSeconds: 3,
  },
});

test('source teardown compensates actor and every original Region ID if a later deletion fails', async (t) => {
  const w = await setup(t);
  await w.attacker.update({ 'system.effects': [maintained('cast-a')] });
  const first = w.placeRegion('first', 'cast-a'),
    second = w.placeRegion('second', 'cast-a', false);
  const saved = [first.toObject(), second.toObject()],
    before = clone(w.attacker._source);
  w.cleanupFaults.deleteId = second.id;
  await assert.rejects(endMagicSource('cast-a'), /Region delete failure/);
  assert.deepEqual(w.attacker._source, before);
  assert.equal(w.scene.regions.size, 2);
  assert.deepEqual(w.scene.regions.get(first.id).toObject(), saved[0]);
  assert.deepEqual(w.scene.regions.get(second.id).toObject(), saved[1]);
  await endMagicSource('cast-a');
  assert.equal(w.scene.regions.size, 0);
  assert.equal(w.attacker.system.effects.length, 0);
});

test('several unpaid casts, native Regions and enchanted equipment roll back if the clock later fails', async (t) => {
  const w = await setup(t),
    patient = w.makeActor('Healing patient');
  game.actors.set(patient.id, patient);
  await w.attacker.update({ 'system.effects': [maintained('cast-a')] });
  await w.target.update({ 'system.effects': [maintained('cast-b')] });
  const first = w.placeRegion('first', 'cast-a'),
    second = w.placeRegion('second', 'cast-b');
  const sword = await w.importItem(w.attacker, 'Iron Long Sword');
  const originalDamage = sword.system.damage;
  await sword.update({
    'system.damage': '9d6',
    [`flags.${SYSTEM_ID}.magicItemEffects`]: [
      {
        castId: 'cast-a',
        action: 'enchant',
        previous: { 'system.damage': originalDamage },
        applied: { 'system.damage': '9d6' },
      },
    ],
  });
  await patient.update({
    'system.hp.value': 8,
    'system.effects': [
      {
        id: 'healing',
        expires: 30,
        magic: { key: 'magic-healing', healing: 3, roundsRemaining: 10, nextAt: 3 },
      },
      {
        id: 'puppet',
        expires: 30,
        magic: {
          key: 'puppet',
          castId: 'puppet',
          repeatDefense: 'resistMagic',
          castingTotal: 20,
          createdAt: 0,
        },
      },
    ],
  });
  const before = [w.attacker, w.target, patient].map((actor) => clone(actor._source));
  const regionSources = [first.toObject(), second.toObject()],
    itemSource = clone(sword.toObject());
  game.time.worldTime = 6;
  w.faults.create = (data) => data.flags?.[SYSTEM_ID]?.kind === 'magic-repeat';
  await assert.rejects(tickMagicLifecycle(), /Injected message creation failure/);
  for (const [i, actor] of [w.attacker, w.target, patient].entries())
    assert.deepEqual(actor._source, before[i]);
  assert.deepEqual(sword.toObject(), itemSource);
  for (const source of regionSources) assert.deepEqual(w.scene.regions.get(source._id).toObject(), source);
  w.faults.create = null;
  await tickMagicLifecycle();
  assert.equal(w.scene.regions.size, 0);
  assert.equal(w.attacker.system.effects.length, 0);
  assert.equal(w.target.system.effects.length, 0);
  assert.equal(sword.system.damage, originalDamage);
  assert.equal(patient.system.hp.value, 14);
});

test('ending a spell preserves the ordinary fire it ignited and another caster’s Region', async (t) => {
  const w = await setup(t);
  await w.attacker.update({ 'system.effects': [maintained('cast-a')] });
  await w.target.update({
    'system.conditions': ['fire'],
    'system.effects': [
      {
        id: 'ordinary-fire',
        conditions: ['fire'],
        expires: 0,
        magic: { key: 'aenye', castId: 'cast-a', persistsAfterSource: true, addedConditions: ['fire'] },
      },
    ],
  });
  w.placeRegion('first', 'cast-a');
  w.placeRegion('other', 'cast-b');
  game.time.worldTime = 6;
  await tickMagicLifecycle();
  assert(w.target.system.conditions.includes('fire'));
  assert.equal(w.target.system.effects[0].id, 'ordinary-fire');
  assert.equal(w.scene.regions.size, 1);
  assert(w.scene.regions.has('other'));
});
