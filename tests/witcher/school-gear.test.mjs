import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  equippedSchoolPerks,
  isWitcherWeapon,
  adjustSchoolCritical,
  schoolReactions,
} from '../../module/witcher/school-gear.js';

const armor = (key, more = {}) => ({
  id: key,
  name: `${key} armor`,
  type: 'armor',
  equipped: true,
  carried: true,
  quantity: 1,
  ability: { key },
  ...more,
});
const weapon = {
  id: 'sword',
  name: 'Renamed school sword',
  type: 'weapon',
  witcherWeapon: true,
  school: 'wolf',
};
const shield = {
  id: 'shield',
  name: 'Manticore Shield',
  type: 'shield',
  witcherWeapon: true,
  school: 'manticore',
};
const wearer = (...items) => ({ items, race: 'human' });
const critical = (extra = {}) => ({ trigger: 'critical', criticalCaused: true, weapon, ...extra });
const defense = (extra = {}) => ({
  trigger: 'defense',
  defense: 'parry',
  attackTotal: 20,
  defenseTotal: 25,
  weapon,
  ...extra,
});

test('only equipped, carried armor with positive quantity grants a school perk', () => {
  const state = wearer(
    armor('criticalFlurry'),
    armor('criticalMomentum', { equipped: false }),
    armor('criticalRiposte', { carried: false }),
    armor('criticalBlock', { quantity: 0 }),
    armor('criticalDecimation', { type: 'gear' })
  );
  assert.deepEqual(
    equippedSchoolPerks(state).map((p) => p.key),
    ['criticalFlurry']
  );
  assert.equal(isWitcherWeapon(weapon), true);
  assert.equal(isWitcherWeapon(shield), true);
  assert.equal(isWitcherWeapon({ ...weapon, witcherWeapon: false }), false);
  assert.equal(isWitcherWeapon({ ...weapon, type: 'gear' }), false);
  assert.equal(isWitcherWeapon({ name: 'Witcher’s Steel Sword', type: 'weapon' }), false);
});

test('document-shaped equipment and flattened snapshots produce the same perk data', () => {
  const plain = armor('criticalFlurry');
  const document = { id: plain.id, name: plain.name, type: plain.type, system: plain };
  assert.deepEqual(equippedSchoolPerks(wearer(document)), equippedSchoolPerks(wearer(plain)));
  assert.equal(isWitcherWeapon({ type: 'weapon', system: weapon }), true);
});

test('Ursine armor upgrades a Witcher critical by one tier without changing the roll margin', () => {
  const state = wearer(armor('criticalDecimation'));
  for (const [before, after, bonus] of [
    ['simple', 'complex', 5],
    ['complex', 'difficult', 8],
    ['difficult', 'deadly', 10],
  ]) {
    const input = { level: before, bonus: 3, margin: 7 };
    const result = adjustSchoolCritical(state, weapon, input);
    assert.equal(result.level, after);
    assert.equal(result.bonus, bonus);
    assert.equal(result.margin, 7);
    assert.equal(result.schoolAdjustment.capped, false);
    assert.equal(input.level, before, 'helper must not modify the original packet');
  }
  const capped = adjustSchoolCritical(state, weapon, { level: 'deadly', bonus: 10, margin: 18 });
  assert.equal(capped.level, 'deadly');
  assert.equal(capped.schoolAdjustment.capped, true);
  assert.match(capped.schoolAdjustment.note, /no critical tier above Deadly/);
  assert.equal(adjustSchoolCritical(state, weapon, null), null);
  assert.deepEqual(
    adjustSchoolCritical(
      state,
      { ...weapon, witcherWeapon: false },
      { level: 'simple', bonus: 3, margin: 7 }
    ),
    { level: 'simple', bonus: 3, margin: 7 }
  );
});

test('Cat critical grants one choice of Disarm or Trip with no extra action cost', () => {
  const state = wearer(armor('criticalFlurry', { school: 'cat' }));
  const [reaction] = schoolReactions(state, critical({ eventId: 'damage-123' }));
  assert.deepEqual(
    reaction.choices.map((choice) => choice.action),
    ['disarm', 'trip']
  );
  assert.equal(reaction.choiceCount, 1);
  assert.equal(reaction.additionalStamina, 0);
  assert.equal(reaction.additionalPenalty, 0);
  assert.equal(reaction.spendAction, false);
  assert.equal(reaction.eventId, 'damage-123');
  assert.equal(schoolReactions(state, critical({ criticalCaused: false })).length, 0);
  assert.equal(schoolReactions(state, critical({ weapon: { ...weapon, witcherWeapon: false } })).length, 0);
  assert.equal(
    schoolReactions(state, critical()).length,
    1,
    'a human using another school’s sword qualifies'
  );
});

test('Viper defensive critical needs a Parry margin strictly greater than four', () => {
  const state = wearer(armor('criticalRiposte'));
  for (const defenseTotal of [20, 23, 24])
    assert.equal(schoolReactions(state, defense({ defenseTotal })).length, 0);
  assert.equal(schoolReactions(state, defense({ defenseTotal: 25 })).length, 1);
  assert.equal(schoolReactions(state, defense({ defense: 'blockWeapon' })).length, 0);
  assert.equal(schoolReactions(state, defense({ defense: 'dodge' })).length, 0);
  assert.equal(schoolReactions(state, defense({ defenseTotal: undefined })).length, 0);
  const [reaction] = schoolReactions(state, defense());
  assert.equal(reaction.choices[0].singleStrike, true);
  assert.equal(reaction.choices[0].weaponRequirement, 'held');
});

test('Manticore Block/Parry grants one shield attack whose hit pushes the attacker four metres prone', () => {
  const state = wearer(armor('criticalBlock'));
  for (const mode of ['blockShield', 'blockWeapon', 'parry']) {
    const [reaction] = schoolReactions(state, defense({ weapon: shield, defense: mode }));
    assert.equal(reaction.choices[0].targetConstraint, 'triggeringAttacker');
    assert.equal(reaction.choices[0].weaponRequirement, 'manticoreShield');
    assert.deepEqual(reaction.choices[0].onHit, { knockbackMeters: 4, conditions: ['prone'] });
  }
  assert.equal(schoolReactions(state, defense({ weapon: shield, defense: 'dodge' })).length, 0);
  assert.equal(schoolReactions(state, defense({ weapon: { ...shield, school: 'bear' } })).length, 0);
  assert.equal(schoolReactions(state, defense()).length, 0);
});

test('Wolf gives one held-weapon strike; Griffin grants a Sign reaction with its normal magic cost', () => {
  const [wolf] = schoolReactions(wearer(armor('criticalMomentum')), critical());
  assert.equal(wolf.choices.length, 1);
  assert.equal(wolf.choices[0].singleStrike, true);
  assert.equal(wolf.choices[0].style, 'normal');
  assert.equal(wolf.choices[0].weaponRequirement, 'held');
  const [griffin] = schoolReactions(wearer(armor('criticalSpellcasting')), critical());
  assert.equal(griffin.deferred, false);
  assert.equal(griffin.choices[0].cost, 'signOnly');
  assert.equal(griffin.additionalStamina, 0);
  assert.equal(griffin.additionalPenalty, 0);
});

test('a real critical caused by a school reaction can grant the next immediate reaction', () => {
  const state = wearer(armor('criticalMomentum'));
  const next = schoolReactions(state, critical({ reactionOrigin: 'previous-event', eventId: 'next-event' }));
  assert.equal(next.length, 1);
  assert.equal(next[0].eventId, 'next-event');
  assert.equal(next[0].immediate, true);
});
