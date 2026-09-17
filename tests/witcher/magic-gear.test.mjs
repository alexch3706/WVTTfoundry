import test from 'node:test';
import assert from 'node:assert/strict';
import { SYSTEM_ID } from '../../module/witcher/config.js';
import { magicInfo, magicItemData } from '../../module/witcher/magic-catalog.js';
import { runCommand } from '../../module/witcher/authority.js';
import { turnIdentity } from '../../module/witcher/runtime.js';
import { workflow, clone } from './workflow-fixture.mjs';
import {
  TROPHIES,
  artifactItemData,
  ritualArtifact,
  amuletImbuementCost,
  amuletGrantedItems,
  amuletCastPermission,
  activeTrophy,
  trophyBenefits,
  pendantSuppressionPlan,
  amuletDrawbackPlan,
  createMagicGearAdapters,
  magicGearComponentRequirements,
  synchronizeMagicGear,
  registerMagicGear,
  tickMagicGear,
} from '../../module/witcher/magic-gear.js';
import {
  amuletComponents,
  amuletSequencePlan,
  amuletImbuementInterruption,
} from '../../module/witcher/magic-amulet-crafting.js';
import { magicGearDocuments } from '../../tools/witcher/build-magic-gear.mjs';

const state = () => ({ effects: [], conditions: [], magic: { tradition: 'mage' } });
const worn = (data, id = 'artifact') => ({
  ...data,
  id,
  uuid: `Actor.hero.Item.${id}`,
  system: { ...data.system, equipped: true },
});
test('the Tome contains33 distinct trophy profiles; only the actual eligible, touched trophy grants its benefit', () => {
  assert.equal(Object.keys(TROPHIES).length, 33);
  const trophy = worn(
    artifactItemData('trophy', {
      species: 'werewolf',
      activeActorUuid: 'Actor.hero',
      helpedKillActorUuids: ['Actor.hero'],
    })
  );
  assert.equal(activeTrophy([trophy], 'Actor.hero'), trophy);
  assert.deepEqual(trophyBenefits([trophy], 'Actor.hero').modifiers, { physique: 2, wildernessSurvival: 2 });
  assert.deepEqual(trophyBenefits([trophy], 'Actor.other').modifiers, {});
  trophy.system.equipped = false;
  assert.equal(activeTrophy([trophy], 'Actor.hero'), null);
  assert.equal(trophyBenefits([trophy], 'Actor.hero').reputation, 1);
});
test('trophy reputation caps at4, conditional casting requires the element, and damage effects require real HP damage', () => {
  const make = (species, id) =>
    worn(
      artifactItemData('trophy', { species, activeActorUuid: 'hero', helpedKillActorUuids: ['hero'] }),
      id
    );
  assert.equal(
    trophyBenefits(
      Array.from({ length: 6 }, (_, i) => artifactItemData('trophy', { species: 'bear' })),
      'hero'
    ).reputation,
    4
  );
  assert.equal(
    trophyBenefits([make('slyzard', 's')], 'hero', { element: 'fire', kind: 'sign' }).modifiers.spellCasting,
    2
  );
  assert.equal(
    trophyBenefits([make('slyzard', 's')], 'hero', { element: 'earth', kind: 'spell' }).modifiers
      .spellCasting,
    undefined
  );
  assert.equal(
    trophyBenefits([make('wyvern', 'w')], 'hero', { hit: true, hpDamage: 0 }).attackEffects.length,
    0
  );
  assert.equal(trophyBenefits([make('wyvern', 'w')], 'hero', { hpDamage: 1 }).attackEffects[0].chance, 25);
  assert.throws(() => activeTrophy([make('bear', 'a'), make('panther', 'b')], 'hero'), /Only one/);
});
test('amulets store real spells, require one drawback for multiple spells and never invent consumable charges', () => {
  const data = artifactItemData('amulet', {
    storedMagic: [{ key: 'aenye' }, { key: 'dispel' }],
    drawback: 'hp',
    complete: true,
  });
  const item = worn(data),
    granted = amuletGrantedItems(item);
  assert.equal(item.system.properties.focus, 2);
  assert.equal(item.system.cost, 750);
  assert.equal(granted.length, 2);
  assert.deepEqual(granted[0].flags[SYSTEM_ID].magicAmulet, { amuletId: 'artifact', key: 'aenye' });
  assert.equal(ritualArtifact(item).charges, undefined);
  assert.throws(() => artifactItemData('amulet', { slots: 2 }), /drawback/);
  assert.throws(() => amuletImbuementCost(magicInfo('quen'), 2), /spells or invocations/);
  const maintained = { kind: 'spell', cost: { min: 3, max: 3, step: 1 }, duration: { maintenance: 'half' } };
  assert.deepEqual(amuletImbuementCost(maintained, 3), {
    power: 3,
    initialSTA: 3,
    maintenanceSTA: 1.5,
    totalSTA: 9,
    focus: 0,
  });
});
test('amulet permission rechecks actual worn source, stored key, dimeritium and sufficient Vigor', () => {
  const item = worn(artifactItemData('amulet', { storedMagic: [{ key: 'aenye' }], complete: true }));
  const s = state();
  s.magic.tradition = 'priest';
  assert.equal(amuletCastPermission(s, item, 'aenye', { staminaCost: 3, vigor: 3 }).permitMageSpell, true);
  assert.throws(() => amuletCastPermission(s, item, 'aenye', { staminaCost: 3, vigor: 2 }), /Vigor/);
  assert.throws(() => amuletCastPermission(s, item, 'dispel'), /does not grant/);
  item.system.equipped = false;
  assert.throws(() => amuletCastPermission(s, item, 'aenye'), /equipped/);
  item.system.equipped = true;
  s.magic.dimeritiumContact = true;
  assert.throws(() => amuletCastPermission(s, item, 'aenye'), /Dimeritium/);
});
test('amulet drawback begins while worn and remains exactly24hours after removal without a sliding expiry', () => {
  const item = worn(
    artifactItemData('amulet', {
      storedMagic: [{ key: 'aenye' }, { key: 'dispel' }],
      drawback: 'headache',
      complete: true,
    })
  );
  const s = state();
  s.effects = amuletDrawbackPlan(s, [item], 100, () => 'drawback');
  assert.deepEqual(s.effects[0].modifiers, { int: -1, will: -1, ref: -1 });
  assert.equal(s.effects[0].expires, 0);
  item.system.equipped = false;
  s.effects = amuletDrawbackPlan(s, [item], 200, () => 'extra');
  assert.equal(s.effects[0].expires, 86600);
  s.effects = amuletDrawbackPlan(s, [item], 1000, () => 'extra');
  assert.equal(s.effects[0].expires, 86600);
  item.system.equipped = true;
  s.effects = amuletDrawbackPlan(s, [item], 1001, () => 'extra');
  assert.equal(s.effects.length, 1);
  assert.equal(s.effects[0].expires, 0);
});
test('pendant suppresses real hex sources and restores them while preserving another source’s condition ownership', () => {
  const pendant = worn(artifactItemData('hexPendant', { expiresAt: 1000 }));
  const s = state();
  s.conditions = ['poison'];
  s.effects = [
    {
      id: 'hex',
      key: 'Hex',
      conditions: ['poison'],
      modifiers: { allActions: -1 },
      magic: { kind: 'hex', key: 'the-eternal-itch', addedConditions: ['poison'] },
    },
    { id: 'other', conditions: ['poison'], magic: { addedConditions: [] } },
  ];
  const suppressed = pendantSuppressionPlan(s, [pendant], 100);
  assert.equal(suppressed.effects.find((row) => row.id === 'hex').magic.suppressed, true);
  assert.deepEqual(suppressed.conditions, ['poison']);
  assert.deepEqual(suppressed.effects.find((row) => row.id === 'other').magic.addedConditions, ['poison']);
  const restored = pendantSuppressionPlan({ ...s, ...suppressed }, [], 101);
  assert.equal(restored.effects.find((row) => row.id === 'hex').magic.suppressed, false);
  assert.deepEqual(restored.conditions, ['poison']);
  assert.equal(restored.effects.filter((row) => row.id === 'hex').length, 1);
  assert.equal(s.effects[0].magic.suppressed, undefined);
});
test('maintenance timing remains an explicit GM ruling rather than an invented automatic4-round delay', () => {
  const active = magicInfo('afans-mirror');
  assert(active);
  const entry = { key: active.key, itemId: 'spell', power: active.cost.min };
  assert.throws(() => amuletSequencePlan([entry], { time: 100 }), /GM must record/);
  const sequence = amuletSequencePlan([entry], {
    time: 100,
    upkeepMode: 'same-round',
    upkeepRuling: 'Pay the costs together.',
  });
  assert.equal(sequence.readyAt, 145);
  assert.equal(
    sequence.storedMagic[0].totalSTA,
    active.cost.min + sequence.storedMagic[0].maintenanceSTA * 4
  );
  assert.equal(amuletComponents(4)[1].quantity, 4);
});

test('same-round amulet upkeep includes all four payments in Vigor and requires explicit overdraw', async (t) => {
  const w = await fixture(t, ['afans-mirror'], { vigor: 3 });
  await w.begin({ upkeepMode: 'same-round', upkeepRuling: 'Costs paid together this round.' });
  game.time.worldTime = 45;
  const cost = amuletImbuementCost(magicInfo('afans-mirror'), 3);
  await assert.rejects(w.command('magicAmuletCast'), /HP beyond Vigor/);
  assert.equal(w.actor.system.sta.value, 100);
  w.enqueue(['1d4', 1]);
  await w.command('magicAmuletCast', { values: { manualDice: '6', overdraw: true } });
  assert.equal(w.actor.system.sta.value, 100 - cost.totalSTA);
  assert.equal(w.actor.system.hp.value, 25 - (cost.totalSTA - 3) * 5);
  assert.equal(w.actor.flags[SYSTEM_ID].amuletImbuement.receipts[0].upkeep.length, 4);
});
test('explicit four-round amulet timing debits upkeep each real round and cannot be paid twice in one round', async (t) => {
  const w = await fixture(t, ['afans-mirror'], { vigor: 3 });
  await w.begin({ upkeepMode: 'four-rounds', upkeepRuling: 'Four actual upkeep rounds.' });
  game.time.worldTime = 45;
  await w.command('magicAmuletCast');
  await assert.rejects(w.command('magicAmuletUpkeep'), /next upkeep round/);
  for (let i = 0; i < 4; i++) {
    game.time.worldTime += 3;
    await w.command('magicAmuletUpkeep');
  }
  const cost = amuletImbuementCost(magicInfo('afans-mirror'), 3);
  assert.equal(w.actor.system.sta.value, 100 - cost.totalSTA);
  assert.equal(w.actor.system.hp.value, 25);
  assert.equal(w.actor.flags[SYSTEM_ID].amuletImbuement.stage, 'checking');
});
test('amulet Ritual Crafting fumble applies its actual total ritual expenditure as HP damage', async (t) => {
  const w = await fixture(t);
  await w.begin();
  game.time.worldTime = 45;
  await w.command('magicAmuletCast');
  const paid = w.actor.flags[SYSTEM_ID].amuletImbuement.paidSTA;
  await w.command('magicAmuletFinish', { values: { manualDice: '1,4' } });
  assert.equal(w.actor.system.hp.value, 25 - paid);
  assert.equal(w.actor.flags[SYSTEM_ID].amuletImbuement.stage, 'failed');
  assert.equal(
    w.actor.items.some((item) => ritualArtifact(item)?.key === 'enchant-amulet'),
    false
  );
});

function addScene(w) {
  let next = 0;
  const scene = {
    id: 'ritual',
    uuid: 'Scene.ritual',
    grid: { size: 100, distance: 2, units: 'm' },
    tokens: new w.Collection(),
    tiles: new w.Collection(),
    async createEmbeddedDocuments(type, records) {
      const collection = type === 'Token' ? this.tokens : this.tiles;
      return records.map((data) => {
        const id = data._id || `doc${++next}`;
        const doc = {
          ...clone(data),
          id,
          uuid: `${this.uuid}.${type}.${id}`,
          documentName: type,
          parent: this,
          ...(type === 'Token'
            ? {
                actor: game.actors.get(data.actorId),
                width: data.width ?? 1,
                height: data.height ?? 1,
                elevation: data.elevation ?? 0,
                level: data.level ?? 'ground',
              }
            : {}),
          toObject() {
            return { ...clone(data), _id: this.id, x: this.x, y: this.y };
          },
          async delete() {
            collection.delete(this.id);
            w.docs.delete(this.uuid);
          },
        };
        collection.set(id, doc);
        w.docs.set(doc.uuid, doc);
        return doc;
      });
    },
  };
  game.scenes.set(scene.id, scene);
  w.docs.set(scene.uuid, scene);
  return scene;
}
test('Crystal Skull creates a real bestiary animal/token and rejects mental commands beyond50m', async (t) => {
  const w = await fixture(t),
    scene = addScene(w);
  const [caster] = await scene.createEmbeddedDocuments('Token', [{ actorId: w.actor.id, x: 0, y: 0 }]);
  const [skull] = await w.actor.createEmbeddedDocuments('Item', [
    artifactItemData('crystalSkull', { animal: 'cat', castId: 'crafted-cat' }),
  ]);
  registerMagicGear({
    worldContext: () => ({
      resolveActorProfile: async () => ({
        name: 'Cat',
        type: 'npc',
        system: { stats: { ref: 7 }, skills: {} },
      }),
      createActor: async (data) => {
        const animal = w.makeActor(data.name, data);
        game.actors.set(animal.id, animal);
        await animal.update({ flags: data.flags });
        animal.ownership = { player: 3 };
        animal.prototypeToken = { width: 1, height: 1 };
        animal.delete = async () => {
          game.actors.delete(animal.id);
          w.docs.delete(animal.uuid);
        };
        return animal;
      },
    }),
  });
  await runCommand('magicSkullActivate', {
    actorUuid: w.actor.uuid,
    itemId: skull.id,
    tokenUuid: caster.uuid,
  });
  const artifact = ritualArtifact(skull),
    animal = w.docs.get(artifact.animalActorUuid),
    token = w.docs.get(artifact.tokenUuid);
  assert(animal);
  assert(token);
  assert.equal(token.actor, animal);
  assert.equal(skull.system.carried, false);
  await runCommand('magicSkullCommand', {
    actorUuid: w.actor.uuid,
    itemId: skull.id,
    tokenUuid: caster.uuid,
    order: 'Stay.',
  });
  token.x = 3000;
  await assert.rejects(
    runCommand('magicSkullCommand', {
      actorUuid: w.actor.uuid,
      itemId: skull.id,
      tokenUuid: caster.uuid,
      order: 'Stay.',
    }),
    /within50m/
  );
});
test('skull animal death leaves a real inert skull marker, requires retrieval, and never loses its original animal identity', async (t) => {
  const w = await fixture(t),
    scene = addScene(w);
  const animal = w.makeActor('Skull cat');
  game.actors.set(animal.id, animal);
  const [caster, token] = await scene.createEmbeddedDocuments('Token', [
    { actorId: w.actor.id, x: 0, y: 0 },
    { actorId: animal.id, x: 100, y: 0 },
  ]);
  const [skull] = await w.actor.createEmbeddedDocuments('Item', [
    artifactItemData('crystalSkull', {
      animal: 'cat',
      active: true,
      animalActorUuid: animal.uuid,
      tokenUuid: token.uuid,
    }),
  ]);
  await animal.update({
    [`flags.${SYSTEM_ID}.crystalSkull`]: { itemUuid: skull.uuid, ownerActorUuid: w.actor.uuid },
    'system.conditions': ['dead'],
  });
  await tickMagicGear();
  assert.equal(scene.tokens.has(token.id), false);
  assert.equal(scene.tiles.size, 1);
  assert.equal(ritualArtifact(skull).charged, false);
  assert.equal(ritualArtifact(skull).animalActorUuid, animal.uuid);
  await runCommand('magicSkullRetrieve', {
    actorUuid: w.actor.uuid,
    itemId: skull.id,
    tokenUuid: caster.uuid,
  });
  assert.equal(skull.system.carried, true);
  assert.equal(scene.tiles.size, 0);
  assert.equal(ritualArtifact(skull).charged, false);
});
test('pendant expiry snapshots actual nearby targets, and a later GM burst cannot follow moving tokens', async (t) => {
  const w = await fixture(t),
    scene = addScene(w);
  const [caster, target] = await scene.createEmbeddedDocuments('Token', [
    { actorId: w.actor.id, x: 0, y: 0 },
    { actorId: w.target.id, x: 100, y: 0 },
  ]);
  const [pendant] = await w.actor.createEmbeddedDocuments('Item', [
    artifactItemData('hexPendant', { expiresAt: 10 }),
  ]);
  await pendant.update({ 'system.equipped': true });
  await w.actor.update({
    'system.effects': [{ id: 'existing', key: 'Hex', magic: { kind: 'hex', key: 'the-eternal-itch' } }],
  });
  game.time.worldTime = 10;
  await tickMagicGear();
  assert.deepEqual(ritualArtifact(pendant).burstTargets, [caster.uuid, target.uuid]);
  target.x = 5000;
  await runCommand('magicPendantBurst', {
    actorUuid: w.actor.uuid,
    itemId: pendant.id,
    tokenUuid: caster.uuid,
    hexKeys: ['the-eternal-itch'],
  });
  assert(w.target.system.effects.some((effect) => effect.magic?.key === 'the-eternal-itch'));
  await assert.rejects(
    runCommand('magicPendantBurst', {
      actorUuid: w.actor.uuid,
      itemId: pendant.id,
      tokenUuid: caster.uuid,
      hexKeys: ['the-eternal-itch'],
    }),
    /no unresolved/
  );
});

async function fixture(t, keys = ['aenye'], options = {}) {
  const w = await workflow(t);
  const actor = w.attacker;
  await actor.update({
    'system.magic': {
      tradition: 'mage',
      speech: true,
      gestures: true,
      minorGestures: true,
      spent: 0,
      roundKey: '',
    },
    'system.vigor': options.vigor ?? 20,
    'system.sta.value': 100,
    'system.skills.ritualCrafting': 10,
  });
  game.actors = new w.Collection([
    [actor.id, actor],
    [w.target.id, w.target],
  ]);
  game.scenes = new w.Collection();
  const token = { uuid: 'Scene.ritual.Token.caster', documentName: 'Token', actor };
  w.docs.set(token.uuid, token);
  const [ritual, ...spells] = await actor.createEmbeddedDocuments(
    'Item',
    ['enchant-amulet', ...keys].map(magicItemData)
  );
  const components = await actor.createEmbeddedDocuments(
    'Item',
    amuletComponents(keys.length).map((req) => ({
      name: req.name,
      type: 'gear',
      system: { quantity: req.quantity + 3 },
    }))
  );
  const allocations = Object.fromEntries(
    amuletComponents(keys.length).map((req, i) => [req.id, { itemId: components[i].id }])
  );
  registerMagicGear();
  const begin = (extra = {}) =>
    runCommand('magicAmuletBegin', {
      actorUuid: actor.uuid,
      itemId: ritual.id,
      entries: spells.map((spell) => ({
        itemId: spell.id,
        key: spell.system.magic.key,
        power: magicInfo(spell.system.magic.key).cost.min,
      })),
      allocations,
      drawback: keys.length > 1 ? 'hp' : '',
      turn: turnIdentity(),
      ...extra,
    });
  const command = (name, extra = {}) => {
    const seq = actor.flags[SYSTEM_ID].amuletImbuement;
    return runCommand(name, {
      actorUuid: actor.uuid,
      sequenceId: seq.id,
      version: seq.version,
      tokenUuid: token.uuid,
      turn: turnIdentity(),
      values: { manualDice: '6' },
      ...extra,
    });
  };
  return { ...w, actor, ritual, spells, components, begin, command, token };
}
test('real sequence enforces15-round preparation, spends full STA/components and creates an amulet only after actual DC18 check', async (t) => {
  const w = await fixture(t);
  await w.begin();
  await assert.rejects(w.command('magicAmuletCast'), /15 rounds/);
  assert.equal(w.components[0].system.quantity, 4);
  game.time.worldTime = 45;
  await w.command('magicAmuletCast');
  assert.equal(w.actor.system.sta.value, 100 - magicInfo('aenye').cost.min);
  assert.equal(w.components[0].system.quantity, 3);
  assert.equal(w.components[3].system.quantity, 4);
  assert.equal(w.actor.flags[SYSTEM_ID].amuletImbuement.stage, 'checking');
  assert.equal(w.actor.items.filter((item) => ritualArtifact(item)?.key === 'enchant-amulet').length, 0);
  await w.command('magicAmuletFinish');
  assert.equal(w.actor.flags[SYSTEM_ID].amuletImbuement.stage, 'complete');
  const amulet = w.actor.items.find((item) => ritualArtifact(item)?.key === 'enchant-amulet');
  assert.deepEqual(
    ritualArtifact(amulet).storedMagic.map((row) => row.key),
    ['aenye']
  );
  await synchronizeMagicGear(w.actor);
  assert.equal(
    w.actor.items.filter((item) => item.flags[SYSTEM_ID]?.magicAmulet?.amuletId === amulet.id).length,
    1
  );
});
test('failed chat persistence compensates STA, components and sequence progress; retry is safe', async (t) => {
  const w = await fixture(t);
  await w.begin();
  game.time.worldTime = 45;
  const before = w.actor.toObject(),
    counts = w.components.map((item) => item.system.quantity);
  w.faults.create = () => true;
  await assert.rejects(w.command('magicAmuletCast'), /Injected/);
  assert.deepEqual(w.actor.toObject(), before);
  assert.deepEqual(
    w.components.map((item) => item.system.quantity),
    counts
  );
  w.faults.create = null;
  await w.command('magicAmuletCast');
  assert.equal(w.actor.flags[SYSTEM_ID].amuletImbuement.index, 1);
});
test('a repeated or stale amulet step cannot spend twice or silently cast the next spell', async (t) => {
  const w = await fixture(t, ['aenye', 'blinding-dust']);
  await w.begin();
  game.time.worldTime = 45;
  const version = w.actor.flags[SYSTEM_ID].amuletImbuement.version;
  await w.command('magicAmuletCast');
  const sta = w.actor.system.sta.value;
  await assert.rejects(w.command('magicAmuletCast', { version }), /already resolved/);
  assert.equal(w.actor.system.sta.value, sta);
  const patch = amuletImbuementInterruption(w.actor, 'attack');
  assert.equal(patch[`flags.${SYSTEM_ID}.amuletImbuement`].stage, 'failed');
  await w.actor.update(patch);
  await assert.rejects(w.command('magicAmuletCast'), /no longer active/);
});
test('final failed persistence removes the created artifact and permits one clean retry', async (t) => {
  const w = await fixture(t);
  await w.begin();
  game.time.worldTime = 45;
  await w.command('magicAmuletCast');
  w.faults.create = () => true;
  await assert.rejects(w.command('magicAmuletFinish'), /Injected/);
  assert.equal(w.actor.flags[SYSTEM_ID].amuletImbuement.stage, 'checking');
  assert.equal(w.actor.items.filter((item) => ritualArtifact(item)?.key === 'enchant-amulet').length, 0);
  w.faults.create = null;
  await w.command('magicAmuletFinish');
  assert.equal(w.actor.items.filter((item) => ritualArtifact(item)?.key === 'enchant-amulet').length, 1);
});

test('an actual weapon attack interrupts amulet imbuement in the same transaction and a failed attack restores it', async (t) => {
  const w = await fixture(t, ['aenye', 'blinding-dust']);
  const sword = await w.importItem(w.actor, 'Arming Sword', { equipped: true });
  await w.begin();
  game.time.worldTime = 45;
  await w.command('magicAmuletCast');
  assert.equal(w.actor.flags[SYSTEM_ID].amuletImbuement.stage, 'imbuing');
  const paid = w.actor.flags[SYSTEM_ID].amuletImbuement.paidSTA;
  w.start();
  w.faults.create = () => true;
  await assert.rejects(w.attack(sword, { manualDice: '5' }), /Injected/);
  assert.equal(w.actor.flags[SYSTEM_ID].amuletImbuement.stage, 'imbuing');
  w.faults.create = null;
  await w.attack(sword, { manualDice: '5' });
  assert.equal(w.actor.flags[SYSTEM_ID].amuletImbuement.stage, 'failed');
  assert.equal(w.actor.flags[SYSTEM_ID].amuletImbuement.paidSTA, paid);
  await assert.rejects(w.command('magicAmuletCast'), /no longer active/);
  assert.equal(
    w.actor.items.some((item) => ritualArtifact(item)?.key === 'enchant-amulet'),
    false
  );
});
test('stored spell fumble fails the sequence, applies actual HP damage and keeps spent components spent', async (t) => {
  const w = await fixture(t);
  await w.begin();
  game.time.worldTime = 45;
  await w.command('magicAmuletCast', { values: { manualDice: '1,7' } });
  assert.equal(w.actor.flags[SYSTEM_ID].amuletImbuement.stage, 'failed');
  assert.equal(w.actor.system.hp.value, 18);
  assert(w.actor.system.conditions.includes('fire'));
  assert.equal(w.components[0].system.quantity, 3);
});
test('amulet crafting rejects stale turns and changed spell definitions before spending', async (t) => {
  const w = await fixture(t);
  await w.begin();
  game.time.worldTime = 45;
  await assert.rejects(w.command('magicAmuletCast', { turn: 'old:1:0' }), /turn changed/);
  await w.spells[0].update({ 'system.magic.cost.min': 1 });
  await assert.rejects(w.command('magicAmuletCast'), /entry changed/);
  assert.equal(w.actor.system.sta.value, 100);
});
test('skull recharge retains the exact inert skull and consumes2 Fifth Essence, without another animal skull', async (t) => {
  const w = await fixture(t),
    [skull] = await w.actor.createEmbeddedDocuments('Item', [
      artifactItemData('crystalSkull', { animal: 'cat', charged: false }),
    ]);
  const choices = { animal: 'cat', rechargeItemId: skull.id };
  const requirements = magicGearComponentRequirements({
    actor: w.actor,
    magic: magicInfo('create-crystal-skull'),
    choices,
  });
  assert.deepEqual(
    requirements.map((req) => [req.kind, req.quantity]),
    [
      ['retain', 1],
      ['consume', 2],
    ]
  );
  const adapter = createMagicGearAdapters().crystalSkull;
  await assert.rejects(adapter.preflight({ actor: w.actor, choices, allocations: {} }), /exact inert/);
  await adapter.preflight({ actor: w.actor, choices, allocations: { 'inert-skull': { itemId: skull.id } } });
  const result = await adapter.prepare({ rechargeItemId: skull.id }, { actor: w.actor, time: 100 });
  assert.equal(result.plans[0].items[0][`flags.${SYSTEM_ID}.ritualArtifact`].charged, true);
  assert.equal(ritualArtifact(skull).charged, false);
});
test('trophy attunement failure compensates both item flags and derived modifier effects', async (t) => {
  const w = await fixture(t),
    [item] = await w.actor.createEmbeddedDocuments('Item', [
      artifactItemData('trophy', { species: 'werewolf', helpedKillActorUuids: [w.actor.uuid] }),
    ]);
  await item.update({ 'system.equipped': true });
  const effects = clone(w.actor.system.effects);
  w.faults.create = () => true;
  await assert.rejects(
    runCommand('magicTrophyAttune', { actorUuid: w.actor.uuid, itemId: item.id }),
    /Injected/
  );
  assert.deepEqual(w.actor.system.effects, effects);
  assert.equal(ritualArtifact(item).activeActorUuid, '');
  w.faults.create = null;
  await runCommand('magicTrophyAttune', { actorUuid: w.actor.uuid, itemId: item.id });
  assert.equal(w.actor.system.effects.find((effect) => effect.magic?.trophyBenefit).modifiers.physique, 2);
});
test('artifact compendium has45 stable unique records and incomplete artifacts require actual setup', () => {
  const records = magicGearDocuments();
  assert.equal(records.length, 45);
  assert.equal(new Set(records.map((row) => row._id)).size, 45);
  assert.deepEqual(magicGearDocuments(), records);
  const amulets = records.filter((row) => ritualArtifact(row)?.key === 'enchant-amulet');
  assert.equal(amulets.length, 4);
  assert(amulets.every((row) => ritualArtifact(row).pendingSetup && !ritualArtifact(row).complete));
  assert.equal(records.find((row) => row.name === 'Runewright’s Tools').system.cost, 550);
});
test('acquired amulet setup validates actual slots and compensates granted items when final persistence fails', async (t) => {
  const w = await fixture(t),
    [amulet] = await w.actor.createEmbeddedDocuments('Item', [
      artifactItemData('amulet', { slots: 2, pendingSetup: true }),
    ]);
  const payload = {
    actorUuid: w.actor.uuid,
    itemId: amulet.id,
    values: {
      drawback: 'sta',
      storedMagic: [
        { key: 'aenye', power: 5 },
        { key: 'dispel', power: 1 },
      ],
    },
  };
  await assert.rejects(
    runCommand('magicArtifactConfigure', {
      ...payload,
      values: { ...payload.values, storedMagic: [payload.values.storedMagic[0]] },
    }),
    /exactly 2/
  );
  w.faults.create = () => true;
  await assert.rejects(runCommand('magicArtifactConfigure', payload), /Injected/);
  assert.equal(ritualArtifact(amulet).pendingSetup, true);
  assert.equal(w.actor.items.filter((row) => row.flags[SYSTEM_ID]?.magicAmulet).length, 0);
  w.faults.create = null;
  await runCommand('magicArtifactConfigure', payload);
  assert.equal(ritualArtifact(amulet).complete, true);
  assert.equal(w.actor.items.filter((row) => row.flags[SYSTEM_ID]?.magicAmulet).length, 2);
});
