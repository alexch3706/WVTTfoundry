import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  attackSequence,
  reserveAction,
  strikeProfile,
  weaponDamageBonus,
  weaponDamageFormula,
  shieldStrike,
  resolveDamage,
  hitLocations,
  locate,
  defenseModifier,
  criticalSeverity,
} from '../../module/witcher/rules.js';

const creatures = JSON.parse(readFileSync(new URL('../../data/witcher/bestiary.json', import.meta.url)));
const creature = (name) => {
  const actor = creatures.find((entry) => entry.name === name);
  assert.ok(actor, `Missing core bestiary entry ${name}`);
  return {
    ...structuredClone(actor.system),
    items: actor.items.map((item) => ({ id: item._id, type: item.type, ...structuredClone(item.system) })),
  };
};
const sword = { id: 'sword', type: 'weapon', category: 'sword', damage: '3d6', properties: {} };
const dagger = { ...sword, id: 'dagger', category: 'smallBlade', damage: '1d6+2' };
const torso = { id: 'torso', multiplier: 1, sp: 0 };
const armor = (sp, resistances = []) => ({
  id: 'armor',
  type: 'armor',
  equipped: true,
  coverage: ['torso', 'arm'],
  armorClass: 'light',
  stoppingPower: sp,
  resistances,
});

test('p.151/153 a fast action gives two strikes; an extra fast action costs 3 STA once and applies -3 twice', () => {
  let result = attackSequence({}, sword);
  assert.equal(result.cost, 0);
  assert.equal(result.budget.remaining, 1);
  assert.equal(result.strikeIndex, 1);
  result = attackSequence(result.budget, dagger);
  assert.equal(result.cost, 0);
  assert.equal(result.budget.remaining, 0);
  assert.equal(result.strikeIndex, 2);
  result = attackSequence(result.budget, dagger, { extra: true });
  assert.equal(result.cost, 3);
  assert.equal(result.modifier, -3);
  assert.equal(result.strikeIndex, 1);
  result = attackSequence(result.budget, sword);
  assert.equal(result.cost, 0);
  assert.equal(result.modifier, -3);
  assert.equal(result.strikeIndex, 2);
  assert.throws(() => attackSequence(result.budget, sword, { extra: true }), /one extra action/);
});

test('changing targets or readied weapons does not create another free attack action', () => {
  const first = attackSequence({}, sword);
  const second = attackSequence(first.budget, dagger);
  assert.throws(() => attackSequence(second.budget, sword), /normal action is already spent/);
  assert.equal(second.budget.weaponId, dagger.id);
  assert.equal(second.budget.actions, 1);
});

test('remaining fast strike cannot be converted into a strong strike, bow shot or full-round action', () => {
  const { budget } = attackSequence({}, sword);
  assert.throws(() => attackSequence(budget, sword, { style: 'strong' }), /Finish or forfeit/);
  assert.throws(() => attackSequence(budget, { ...sword, category: 'bow' }), /remaining fast strike/);
  assert.throws(() => attackSequence(budget, sword, { full: true }), /remaining fast strike/);
  const extra = attackSequence(budget, dagger, { style: 'strong', extra: true, forfeit: true });
  assert.equal(extra.cost, 3);
  assert.equal(extra.modifier + extra.profile.modifier, -6);
  assert.equal(extra.profile.multiplier, 2);
  assert.equal(extra.budget.remaining, 0);
});

test('the extra action may be taken before the normal action (p.151 v1.35 wording)', () => {
  const extra = attackSequence({}, sword, { style: 'strong', extra: true });
  assert.equal(extra.budget.actions, 0);
  assert.equal(extra.cost, 3);
  const normal = attackSequence(extra.budget, sword, { style: 'strong' });
  assert.equal(normal.cost, 0);
  assert.equal(normal.modifier, 0);
});

test('full-round action consumes the turn but never prevents the first free defense or later paid defenses', () => {
  const full = reserveAction({}, { full: true });
  assert.throws(() => reserveAction(full.budget, { extra: true }), /full-round/);
  assert.throws(() => reserveAction(full.budget), /full-round/);
  assert.throws(() => reserveAction({}, { extra: true, full: true }), /entire turn/);
  assert.throws(() => reserveAction({ extra: 1 }, { full: true }), /entire turn/);
  const firstDefense = reserveAction(full.budget, { defense: true });
  assert.equal(firstDefense.cost, 0);
  assert.equal(firstDefense.budget.full, true);
  const secondDefense = reserveAction(firstDefense.budget, { defense: true });
  assert.equal(secondDefense.cost, 1);
  assert.equal(reserveAction(secondDefense.budget, { defense: true }).cost, 1);
  assert.equal(reserveAction(secondDefense.budget, { defense: true, activelyDodging: true }).cost, 0);
});

test('p.153 bow gets one fast shot or one doubled strong shot; crossbow gets one normal shot', () => {
  const bow = { ...sword, category: 'bow' };
  assert.deepEqual(strikeProfile(bow), { attacks: 1, modifier: 0, multiplier: 1 });
  assert.deepEqual(strikeProfile(bow, { style: 'strong' }), { attacks: 1, modifier: -3, multiplier: 2 });
  const crossbow = { ...bow, category: 'crossbow' };
  for (const style of ['fast', 'strong']) assert.throws(() => strikeProfile(crossbow, { style }));
  assert.deepEqual(strikeProfile(crossbow, { style: 'normal' }), { attacks: 1, modifier: 0, multiplier: 1 });
  assert.throws(() => strikeProfile(sword, { style: 'invented' }), /Unknown strike/);
});

test('p.165 underwater melee permits one strike, including one doubled strong strike', () => {
  assert.equal(strikeProfile(sword, { underwater: true }).attacks, 1);
  assert.deepEqual(strikeProfile(sword, { style: 'strong', underwater: true }), {
    attacks: 1,
    modifier: -3,
    multiplier: 2,
  });
});

test('core Griffin chooses two Claws OR one Bite, and extra STA never refreshes ROF', () => {
  const griffin = creature('Griffin');
  const rawActor = creatures.find((entry) => entry.name === 'Griffin');
  const clawsId = rawActor.items.find((item) => item.name === 'Claws')._id;
  const biteId = rawActor.items.find((item) => item.name === 'Bite')._id;
  const claws = griffin.items.find((item) => item.id === clawsId);
  const bite = griffin.items.find((item) => item.id === biteId);
  const options = { npc: true, style: 'normal' };
  const first = attackSequence({}, claws, options);
  assert.equal(first.budget.remaining, 1);
  assert.throws(() => attackSequence(first.budget, bite, options), /one chosen attack/);
  const second = attackSequence(first.budget, claws, options);
  assert.equal(second.budget.npcStrikes, 2);
  assert.equal(second.budget.remaining, 0);
  assert.throws(() => attackSequence(second.budget, claws, { ...options, extra: true }), /cannot reset ROF/);
  assert.throws(() => attackSequence(second.budget, bite, { ...options, extra: true }), /cannot reset ROF/);
  assert.equal(attackSequence({}, bite, options).budget.remaining, 0);
  assert.throws(
    () => attackSequence(first.budget, bite, { ...options, extra: true, forfeit: true }),
    /cannot reset ROF/
  );
});

test('a creature can use its extra action to begin its first attack after another regular action', () => {
  const spent = reserveAction({});
  const result = attackSequence(
    spent.budget,
    { ...sword, rof: 2 },
    {
      npc: true,
      style: 'normal',
      extra: true,
    }
  );
  assert.equal(result.cost, 3);
  assert.equal(result.modifier, -3);
  assert.equal(result.budget.remaining, 1);
});

test('every imported natural attack keeps its printed damage and receives no additional BODY bonus', () => {
  let checked = 0;
  for (const actor of creatures)
    for (const item of actor.items) {
      if (item.type !== 'weapon' || !item.system.properties.natural) continue;
      checked++;
      const weapon = { type: item.type, ...item.system };
      assert.equal(weaponDamageBonus(weapon, 8), 0, `${actor.name}: ${item.name}`);
      assert.equal(weaponDamageFormula(weapon), item.system.damage);
    }
  assert.ok(checked > 30);
});

test('p.48 BODY modifies melee and thrown weapon damage, but not bow, crossbow or fixed creature formulas', () => {
  for (const category of ['sword', 'smallBlade', 'thrown'])
    assert.equal(weaponDamageBonus({ ...sword, category }, 4), 4);
  for (const category of ['bow', 'crossbow', 'naturalRanged', 'bomb', 'trap'])
    assert.equal(weaponDamageBonus({ ...sword, category }, 4), 0);
  assert.equal(weaponDamageBonus({ ...sword, properties: { fixedDamage: true } }, 8), 0);
  assert.equal(weaponDamageBonus(sword, -4), -4);
});

test('p.72 Brass Knuckles add their damage to the full Punch formula without adding BODY twice', () => {
  const brass = { ...sword, category: 'brawling', damage: '1d6', properties: { brawling: true } };
  assert.equal(weaponDamageFormula(brass, { punch: '1d6+4' }), '(1d6+4) + (1d6)');
  assert.equal(weaponDamageBonus(brass, 4), 0);
});

test('p.164 shields make lethal Melee attacks using the appropriate hand-to-hand table rows', () => {
  for (const [armorClass, expected] of [
    ['light', '1d6+0'],
    ['medium', '1d6+4'],
    ['heavy', '1d6+8'],
  ]) {
    const shield = { id: 'shield', type: 'shield', armorClass, reliability: 15, properties: {} };
    const strike = shieldStrike(shield, 5);
    assert.equal(strike.damage, expected);
    assert.equal(strike.skill, 'melee');
    assert.equal(strike.stat, 'ref');
    assert.equal(strike.properties.nonlethal, false);
    assert.equal(weaponDamageBonus(strike, 4), 0);
    assert.equal(strike.reliability, 15);
  }
  assert.equal(weaponDamageFormula({ type: 'shield', armorClass: 'medium' }, { body: 1 }), '1d6+0');
  assert.equal(weaponDamageFormula({ type: 'shield', armorClass: 'heavy' }, { body: 13 }), '1d6+8');
});

test('p.164 only shields block arrows, bolts and thrown weapons; ordinary parry is -3, thrown parry -5', () => {
  for (const category of ['bow', 'crossbow', 'thrown', 'naturalRanged']) {
    assert.throws(() => defenseModifier('blockWeapon', category), /Only a shield/);
    assert.throws(() => defenseModifier('blockArm', category), /Only a shield/);
    assert.equal(defenseModifier('blockShield', category), 0);
  }
  assert.equal(defenseModifier('parry', 'sword'), -3);
  assert.equal(defenseModifier('parry', 'thrown'), -5);
  assert.throws(() => defenseModifier('parry', 'crossbow'));
});

test('critical thresholds are exact, and critical bonus ignores armor and hit-location multiplication', () => {
  assert.deepEqual(
    [6, 7, 9, 10, 12, 13, 14, 15].map((margin) => criticalSeverity(margin)?.bonus ?? 0),
    [0, 3, 3, 5, 5, 8, 8, 10]
  );
  const result = resolveDamage({ raw: 1, criticalBonus: 10 }, {}, { ...torso, multiplier: 3 }, [armor(20)]);
  assert.equal(result.damage, 10);
  assert.equal(result.penetrated, false);
  assert.deepEqual(result.armorChanges, []);
});

test('p.154 repeated ordinary DR halves only once, while the monster silver resistance is separate', () => {
  const target = { silverVulnerable: true, resistances: ['slashing'], naturalResistances: ['slashing'] };
  const result = resolveDamage({ raw: 24 }, target, torso, [armor(4, ['slashing'])]);
  assert.equal(result.afterArmor, 20);
  assert.equal(result.damage, 5);
  const silver = resolveDamage({ raw: 24, properties: { silver: true } }, target, torso, [
    armor(4, ['slashing']),
  ]);
  assert.equal(silver.damage, 10);
});

test('p.155 staged penetration requires actual damage, not an arm hit which rounds to zero or an immune hit', () => {
  const arm = { id: 'arm', multiplier: 0.5, sp: 0 };
  const zero = resolveDamage({ raw: 5 }, {}, arm, [armor(4)]);
  assert.equal(zero.damage, 0);
  assert.equal(zero.penetrated, false);
  assert.equal(zero.clearsStun, false);
  assert.deepEqual(zero.armorChanges, []);
  const hit = resolveDamage({ raw: 6 }, {}, arm, [armor(4)]);
  assert.equal(hit.damage, 1);
  assert.equal(hit.armorChanges[0].after, 3);
});

test('the second strike uses worn armor after the first penetrating strike', () => {
  const item = armor(8);
  const first = resolveDamage({ raw: 12 }, {}, torso, [item]);
  assert.equal(first.damage, 4);
  const next = { ...item, sp: { torso: first.armorChanges[0].after } };
  const second = resolveDamage({ raw: 12 }, {}, torso, [next]);
  assert.equal(second.damage, 5);
  assert.equal(second.armorChanges[0].after, 6);
  assert.equal(item.stoppingPower, 8);
});

test('silver adds its dice once against a Drowner and never bypasses a Noonwraith physical immunity', () => {
  const drowner = creature('Drowner');
  const location = locate(hitLocations(drowner), 'torso');
  const ordinary = resolveDamage({ raw: 20 }, drowner, location, drowner.items);
  const silver = resolveDamage(
    { raw: 4, silver: 12, properties: { silver: true } },
    drowner,
    location,
    drowner.items
  );
  assert.equal(ordinary.damage, 10);
  assert.equal(silver.damage, 16);
  const wraith = creature('Noonwraith');
  const immune = resolveDamage(
    { raw: 20, silver: 12, criticalBonus: 10, properties: { silver: true } },
    wraith,
    locate(hitLocations(wraith), 'head'),
    wraith.items
  );
  assert.equal(immune.damage, 0);
  assert.equal(immune.criticalBonus, 0);
  assert.equal(immune.penetrated, false);
  assert.equal(immune.clearsStun, false);
});

test('attack planning and damage resolution leave the input state untouched', () => {
  const initial = { actions: 0, extra: 0, defenses: 2, applied: ['earlier-attack'] };
  const before = structuredClone(initial);
  const first = attackSequence(initial, sword);
  assert.deepEqual(initial, before);
  assert.equal(first.budget.defenses, 2);
  assert.deepEqual(first.budget.applied, ['earlier-attack']);
  assert.equal(reserveAction(first.budget, { defense: true }).cost, 1);
});
