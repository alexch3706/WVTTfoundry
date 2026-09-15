import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {
  derivedStats,
  hitLocations,
  validateLocations,
  locate,
  resolveDamage,
} from '../../module/witcher/rules.js';
import {
  creatureRegeneration,
  immuneTo,
  isIncorporeal,
  staminaCost,
  locationChoices,
} from '../../module/witcher/monster-rules.js';

const actors = JSON.parse(
  await fs.readFile(new URL('../../data/witcher/bestiary.json', import.meta.url), 'utf8')
);
const audit = JSON.parse(
  await fs.readFile(new URL('../../data/witcher/bestiary-audit.json', import.meta.url), 'utf8')
);
const get = (name) => structuredClone(actors.find((a) => a.name === name));
const state = (name) => {
  const a = get(name);
  return { ...a.system, items: a.items.map((i) => ({ id: i._id, type: i.type, name: i.name, ...i.system })) };
};
const attack = (name, weapon) => get(name).items.find((i) => i.type === 'weapon' && i.name === weapon).system;

test('the core bestiary includes every base entry, printed variant, animal and named adventure NPC', () => {
  assert.deepEqual(
    actors.map((a) => a.name).sort(),
    [
      'Bandit',
      'Mage',
      'Scoia’tael Archer',
      'Drowner',
      'Ghoul',
      'Grave Hag',
      'Wraith',
      'Noonwraith',
      'Wolf',
      'Warg',
      'Werewolf',
      'Siren',
      'Griffin',
      'Endrega Worker',
      'Endrega Warrior',
      'Endrega Drone',
      'Endrega Queen',
      'Arachas',
      'Golem',
      'Fiend',
      'Nekker',
      'Nekker Chieftain',
      'Rock Troll',
      'Wyvern',
      'Katakan',
      'Cat',
      'Dog',
      'Bird',
      'Serpent',
      'Horse',
      'War Horse',
      'Ox',
      'Mule',
      '“Crucible” Kowal',
      'Lord Nowak',
      'Woolabag',
    ].sort()
  );
  assert.equal(audit.count, 36);
  assert.equal(new Set(actors.map((a) => a._id)).size, 36);
  for (const actor of actors) {
    assert.ok(actor.flags['witcher-rilerena'].sourcePages.length);
    assert.equal(new Set(actor.items.map((i) => i._id)).size, actor.items.length, actor.name);
    assert.ok(
      actor.items.some((i) => i.type === 'weapon'),
      actor.name
    );
    assert.ok(validateLocations(hitLocations(actor.system)), actor.name);
    for (const item of actor.items) assert.ok(item.system.source && item.system.page > 0, item.name);
  }
});
test('published monster HP, STA, STUN, REC, ENC and movement survive derived-stat preparation', () => {
  for (const actor of actors) {
    const s = state(actor.name);
    // Siren's printed stats apply in water / flight; its land penalty is separately tested.
    s.environment = { underwater: actor.name === 'Siren' };
    const actual = derivedStats(s, s.items),
      book = s.bestiary.published;
    for (const [derived, printed] of Object.entries({
      hpMax: 'hp',
      staMax: 'sta',
      stun: 'stun',
      rec: 'rec',
      enc: 'enc',
      run: 'run',
      leap: 'leap',
    }))
      assert.equal(actual[derived], book[printed] ?? 0, `${actor.name}: ${printed}`);
  }
});
test('printed Warg and Nekker Chieftain variants retain their own stats and their base attacks', () => {
  assert.equal(state('Warg').stats.ref, 5);
  assert.equal(state('Warg').hp.value, 30);
  assert.equal(attack('Warg', 'Bite').damage, '2d6');
  assert.equal(state('Nekker Chieftain').stats.dex, 8);
  assert.equal(state('Nekker Chieftain').hp.value, 20);
  assert.equal(attack('Nekker Chieftain', 'Claws').damage, '2d6');
});
test('Endrega species differ mechanically; the queen uses Arachas as p.294 directs', () => {
  assert.equal(attack('Endrega Worker', 'Claws').properties.poison, 25);
  assert.equal(attack('Endrega Warrior', 'Tail').damage, '4d6+2');
  assert.equal(attack('Endrega Warrior', 'Tail').properties.poison, 50);
  assert.equal(attack('Endrega Drone', 'Claws').properties.poison, 0);
  assert.ok(get('Endrega Drone').items.some((i) => i.system.ability?.key === 'dronesquills'));
  assert.deepEqual(state('Endrega Queen').stats, state('Arachas').stats);
  assert.equal(state('Endrega Queen').hp.value, 90);
});
test('Arachas back and Troll stomach use their printed SP and remove natural damage resistance', () => {
  for (const [name, weakSP] of [
    ['Arachas', 10],
    ['Rock Troll', 5],
  ]) {
    const s = state(name);
    const table = hitLocations(s);
    const normal = resolveDamage(
      { raw: 30, type: 'piercing', properties: { silver: true } },
      s,
      locate(table, 'torso'),
      s.items
    );
    const weak = resolveDamage(
      { raw: 30, type: 'piercing', properties: { silver: true } },
      s,
      locate(table, 'torso:weak'),
      s.items
    );
    assert.equal(normal.damage, 5);
    assert.equal(weak.damage, 30 - weakSP);
    assert.equal(weak.naturalChange.field, 'weakSp');
    assert.ok(locationChoices(table).some((l) => l.id === 'torso:weak'));
  }
});
test('Golem cannot exhaust STA, bleed, burn or be poisoned; immunity also cancels critical bonus', () => {
  const s = state('Golem');
  assert.equal(staminaCost(s, 3), 0);
  for (const type of ['fire', 'poison', 'bleeding']) assert.ok(immuneTo(s, type));
  const hit = resolveDamage(
    { raw: 100, type: 'fire', criticalBonus: 10 },
    s,
    locate(hitLocations(s), 'head'),
    s.items
  );
  assert.equal(hit.damage, 0);
  assert.equal(hit.penetrated, false);
  const nonlethal = resolveDamage(
    { raw: 100, type: 'bludgeoning', nonlethal: true },
    s,
    locate(hitLocations(s), 'torso'),
    s.items
  );
  assert.equal(nonlethal.damage, 0);
  assert.equal(attack('Golem', 'Punch').properties.wearMultiplier, 2);
  assert.ok(attack('Golem', 'Punch').properties.cannotParry);
});
test('Fury, Moondust suppression and Katakan sunlight regeneration have distinct triggers', () => {
  const ghoul = state('Ghoul');
  ghoul.hp.value = 10;
  assert.equal(creatureRegeneration(ghoul), 0);
  ghoul.hp.value = 9;
  assert.equal(creatureRegeneration(ghoul), 3);
  const wolf = state('Werewolf');
  assert.equal(creatureRegeneration(wolf), 5);
  wolf.effects = [{ key: 'Moondust' }];
  assert.equal(creatureRegeneration(wolf), 0);
  const katakan = state('Katakan');
  katakan.environment = { light: 'daylight' };
  assert.equal(creatureRegeneration(katakan), 3);
  katakan.environment.light = 'dark';
  assert.equal(creatureRegeneration(katakan), 5);
});
test('Noonwraith incorporeality is suppressed by Moondust and Yrden; fire vulnerability survives silver resistance', () => {
  const wraith = state('Noonwraith');
  assert.ok(isIncorporeal(wraith));
  assert.ok(immuneTo(wraith, 'piercing'));
  wraith.effects = [{ key: 'Yrden' }];
  assert.equal(isIncorporeal(wraith), false);
  const drowner = state('Drowner');
  const fire = resolveDamage(
    { raw: 5, type: 'fire' },
    drowner,
    locate(hitLocations(drowner), 'torso'),
    drowner.items
  );
  assert.equal(fire.damage, 10);
  assert.ok(immuneTo(drowner, 'suffocating'));
});
test('Siren land movement and Ox charge are the printed special cases', () => {
  const siren = state('Siren');
  const land = derivedStats(siren, siren.items);
  for (const k of ['ref', 'dex', 'spd']) assert.equal(land.stats[k], 2);
  assert.equal(land.run, 6);
  siren.environment = { underwater: true };
  assert.equal(derivedStats(siren, siren.items).stats.ref, 7);
  assert.equal(attack('Ox', 'Charge').damage, '8d6');
  assert.equal(attack('Ox', 'Charge').properties.knockback, 3);
  assert.equal(attack('Griffin', 'Charge').damage, '10d6');
});
