import test from 'node:test';
import assert from 'node:assert/strict';
import {
  magicCreatureProfile,
  livingArmorComponents,
  magicCreatureDefenseAdjustment,
} from '../../module/witcher/magic-creature-profiles.js';
import { magicRecoveryRules } from '../../module/witcher/magic-effect-hooks.js';
import { SKILLS } from '../../module/witcher/config.js';

const armor = () => [
  {
    _id: 'helm',
    name: 'Helmet',
    type: 'armor',
    system: {
      quantity: 0,
      coverage: ['head'],
      stoppingPower: 12,
      sp: { head: 9 },
      properties: { restrictedVision: true },
      resistances: [],
      armorClass: 'heavy',
      ev: 0,
    },
  },
  {
    _id: 'body',
    name: 'Body armor',
    type: 'armor',
    system: {
      quantity: 0,
      coverage: ['torso', 'rightArm', 'leftArm'],
      stoppingPower: 12,
      sp: { torso: 8, rightArm: 7 },
      properties: {},
      resistances: ['slashing'],
      armorClass: 'heavy',
      ev: 0,
    },
  },
  {
    _id: 'legs',
    name: 'Leg armor',
    type: 'armor',
    system: {
      quantity: 0,
      coverage: ['rightLeg', 'leftLeg'],
      stoppingPower: 10,
      properties: {},
      resistances: [],
      armorClass: 'medium',
      ev: 0,
    },
  },
];
function skillBase(data, key) {
  return (
    data.system.skills[key] +
    (['awareness', 'wildernessSurvival'].includes(key)
      ? data.system.traits.feralInt
      : data.system.stats[SKILLS[key][1]])
  );
}

test('Corpse Amalgam retains every printed numeric base and records the distinct Reposition base', () => {
  const data = magicCreatureProfile('corpse-amalgam');
  assert.equal(data.system.hp.value, 100);
  assert.equal(data.system.sta.value, 50);
  assert.equal(data.system.overrides.rec, 10);
  assert.equal(data.system.stats.body, 12);
  for (const [skill, base] of Object.entries(data.system.bestiary.printedSkills))
    assert.equal(skillBase(data, skill), base, skill);
  assert.equal(skillBase(data, 'athletics'), 11);
  assert.equal(magicCreatureDefenseAdjustment(data.system, 'athletics'), 2);
  assert.equal(magicCreatureDefenseAdjustment(data.system, 'dodge'), 0);
  assert.equal(data.items[0].system.damage, '5d6');
  assert.equal(data.items[0].system.rof, 2);
  assert.equal(data.items[0].system.range, 2);
  assert.equal(data.items[0].system.reliability, 10);
  assert(data.system.locations.every((location) => location.multiplier <= 1));
  assert.deepEqual(data.system.naturalResistances, ['bludgeoning', 'piercing']);
  assert(data.system.immunities.includes('prone'));
  assert.equal(magicRecoveryRules(data.system, { source: 'magical', amount: 10 }).hpAmount, 0);
  assert.equal(magicRecoveryRules(data.system, { source: 'natural', amount: 10 }).hpAmount, 0);
  assert.match(data.items.find((item) => item.name === 'Bound Spirits').system.description, /GM procedure/);
});

test('Living Armor uses the actual damaged armor Items as its single SP source', () => {
  const inputs = armor(),
    before = structuredClone(inputs);
  const data = magicCreatureProfile('living-armor', { armorItems: inputs });
  assert.deepEqual(inputs, before, 'Consumed component snapshots are not mutated');
  assert.equal(data.system.hp.value, 60);
  assert.equal(data.system.traits.infiniteStamina, true);
  assert.equal(data.system.bestiary.published.sta, null);
  assert.equal(data.system.bestiary.published.stun, null);
  assert(data.system.locations.every((location) => location.sp === 0));
  const items = data.items.filter((item) => item.type === 'armor');
  assert(items.every((item) => item.system.equipped && item.system.quantity === 1 && item.system.carried));
  assert.equal(items[0].system.sp.head, 9);
  assert.equal(items[1].system.sp.torso, 8);
  assert.equal(items[1].system.sp.rightArm, 7);
  assert.equal(items[0].system.properties.restrictedVision, false);
  assert.deepEqual(items[1].system.resistances, ['slashing']);
  for (const [skill, base] of Object.entries(data.system.bestiary.printedSkills))
    assert.equal(skillBase(data, skill), base, skill);
  assert.equal(data.items.find((item) => item.type === 'weapon').system.damage, '1d6+2');
  const second = magicCreatureProfile('living-armor', { armorItems: armor() });
  data.items[0].system.sp.head = 0;
  assert.equal(second.items[0].system.sp.head, 9);
});

test('missing, layered or invalid component SP never creates a substitute suit', () => {
  assert.throws(() => magicCreatureProfile('living-armor'), /actual head/);
  assert.throws(() => magicCreatureProfile('invented-creature'), /audited/);
  const invalid = armor();
  invalid[1].system.coverage = ['torso'];
  assert.throws(() => livingArmorComponents(invalid), /rightArm/);
  const layered = armor();
  layered[2].system.coverage.push('torso');
  assert.throws(() => livingArmorComponents(layered), /torso exactly once/);
  const negative = armor();
  negative[0].system.sp.head = -1;
  assert.throws(() => livingArmorComponents(negative), /current SP/);
});
