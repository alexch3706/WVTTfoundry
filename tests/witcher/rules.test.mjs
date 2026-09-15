import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as r from '../../module/witcher/rules.js';
import { HUMANOID_LOCATIONS, MONSTER_LOCATIONS } from '../../module/witcher/config.js';

test('p.156 fumble examples: base 13 minus 7 = 6; 10 then 4 bottoms out at zero', () => {
  assert.equal(r.resolveCheck(13, [1, 7]).total, 6);
  assert.equal(r.resolveCheck(13, [1, 10, 4]).total, 0);
  assert.equal(r.resolveCheck(13, [10, 10, 7]).total, 40);
  assert.equal(r.resolveCheck(13, [7]).total, 20);
  assert.throws(() => r.resolveCheck(13, [1, 10]));
});
test('p.57 defender wins ties, and a difficulty must be exceeded', () => {
  assert.equal(r.beats(14, 14), false);
  assert.equal(r.beats(15, 14), true);
});
test('p.155 armor example uses augmented pair, capped bonus and exact boundaries', () => {
  assert.equal(
    r.stackArmor([
      { sp: 3, kind: 'light' },
      { sp: 12, kind: 'medium' },
      { sp: 20, kind: 'heavy' },
    ]),
    24
  );
  assert.deepEqual([4, 5, 8, 9, 14, 15, 20, 21].map(r.armorBonus), [5, 4, 4, 3, 3, 2, 2, 0]);
  assert.equal(
    r.stackArmor([
      { sp: 1, kind: 'light' },
      { sp: 1, kind: 'light' },
    ]),
    2
  );
  assert.throws(() =>
    r.stackArmor([
      { sp: 20, kind: 'heavy' },
      { sp: 30, kind: 'heavy' },
    ])
  );
  assert.equal(
    r.stackArmor([
      { sp: 3, kind: 'light' },
      { sp: 5, kind: 'light' },
      { sp: 8, kind: 'light' },
    ]),
    13
  );
});
test('p.154 human and monster tables cover all ten rolls with different torso/limb boundaries', () => {
  assert.equal(r.validateLocations(HUMANOID_LOCATIONS), true);
  assert.equal(r.validateLocations(MONSTER_LOCATIONS), true);
  assert.equal(r.locate(HUMANOID_LOCATIONS, 5).id, 'rightArm');
  assert.equal(r.locate(MONSTER_LOCATIONS, 5).id, 'torso');
  assert.equal(r.locate(MONSTER_LOCATIONS, 10).id, 'tailWing');
  assert.throws(() => r.locate(MONSTER_LOCATIONS, 'leftLeg'));
  assert.throws(() =>
    r.validateLocations([{ ...MONSTER_LOCATIONS[0], max: 10 }, ...MONSTER_LOCATIONS.slice(1)])
  );
});
const armor = (sp, kind = 'light', resistances = []) => ({
  id: 'armor',
  type: 'armor',
  equipped: true,
  armorClass: kind,
  coverage: ['head', 'torso'],
  stoppingPower: sp,
  resistances,
});
test('p.154 armor is subtracted before hit location; penetration wears armor', () => {
  const result = r.resolveDamage({ raw: 20 }, {}, HUMANOID_LOCATIONS[0], [armor(12)]);
  assert.equal(result.damage, 24);
  assert.equal(result.armorChanges[0].after, 11);
  const blocked = r.resolveDamage({ raw: 12 }, {}, HUMANOID_LOCATIONS[0], [armor(12)]);
  assert.equal(blocked.damage, 0);
  assert.deepEqual(blocked.armorChanges, []);
});
test('p.155 AP ignores armor resistance; improved AP also halves SP', () => {
  const args = [{}, HUMANOID_LOCATIONS[1], [armor(12, 'medium', ['slashing'])]];
  assert.equal(r.resolveDamage({ raw: 20 }, ...args).damage, 4);
  assert.equal(r.resolveDamage({ raw: 20, properties: { armorPiercing: true } }, ...args).damage, 8);
  assert.equal(r.resolveDamage({ raw: 20, properties: { improvedArmorPiercing: true } }, ...args).damage, 14);
});
test('p.153 strong damage is doubled before armor', () => {
  assert.equal(r.resolveDamage({ raw: 12, multiplier: 2 }, {}, HUMANOID_LOCATIONS[1], [armor(15)]).damage, 9);
});
test('p.158 critical bonus bypasses armor without wearing an unpenetrated layer', () => {
  const result = r.resolveDamage({ raw: 1, criticalBonus: 5 }, {}, HUMANOID_LOCATIONS[1], [armor(30)]);
  assert.equal(result.damage, 5);
  assert.equal(result.armorChanges.length, 0);
});
test('p.162 silver monster resistance excludes fire; silver weapon adds listed damage', () => {
  const target = { silverVulnerable: true };
  const loc = MONSTER_LOCATIONS[1];
  assert.equal(r.resolveDamage({ raw: 20 }, target, loc).damage, 10);
  assert.equal(r.resolveDamage({ raw: 20, type: 'fire' }, target, loc).damage, 20);
  assert.equal(r.resolveDamage({ raw: 4, silver: 12, properties: { silver: true } }, target, loc).damage, 16);
  assert.equal(r.resolveDamage({ raw: 4, silver: 12, properties: { silver: true } }, {}, loc).damage, 4);
});
test('repeated location resolution is independent and does not mutate source data', () => {
  const request = { raw: 20 };
  const target = {};
  const items = [armor(12)];
  const before = structuredClone({ request, target, items });
  const head = r.resolveDamage(request, target, HUMANOID_LOCATIONS[0], items);
  const torso = r.resolveDamage(request, target, HUMANOID_LOCATIONS[1], items);
  assert.equal(head.damage, 24);
  assert.equal(torso.damage, 8);
  assert.deepEqual({ request, target, items }, before);
});
test('p.48 derived statistics round down and weight penalty applies once per stat', () => {
  const a = { stats: { body: 5, will: 6, ref: 8, dex: 7, spd: 6 }, hp: { value: 25 } };
  const d = r.derivedStats(a, [{ type: 'gear', quantity: 1, weight: 60 }]);
  assert.equal(d.hpMax, 25);
  assert.equal(d.stun, 5);
  assert.equal(d.overweight, 2);
  assert.equal(d.stats.ref, 6);
  assert.equal(d.stats.dex, 5);
  assert.equal(d.stats.spd, 4);
});
test('p.156 wound threshold is strict; death penalty supersedes wound penalty', () => {
  const a = { stats: { body: 8, will: 8, ref: 9, dex: 9, int: 9 }, hp: { value: 8 } };
  assert.equal(r.derivedStats(a).stats.ref, 9);
  assert.equal(r.derivedStats({ ...a, hp: { value: 7 } }).stats.ref, 4);
  assert.equal(r.derivedStats({ ...a, hp: { value: 0 } }).stats.ref, 3);
});
test('p.151 one normal action, one extra action for 3 STA; successive defenses cost STA', () => {
  const first = r.reserveAction({});
  assert.equal(first.cost, 0);
  assert.throws(() => r.reserveAction(first.budget));
  const extra = r.reserveAction(first.budget, { extra: true });
  assert.equal(extra.cost, 3);
  assert.equal(extra.modifier, -3);
  assert.throws(() => r.reserveAction(extra.budget, { extra: true }));
  const defense = r.reserveAction({}, { defense: true });
  assert.equal(defense.cost, 0);
  assert.equal(r.reserveAction(defense.budget, { defense: true }).cost, 1);
  assert.equal(r.reserveAction(defense.budget, { defense: true, activelyDodging: true }).cost, 0);
});
test('p.153 bows cannot fast fire and minor monsters cannot strong strike', () => {
  assert.equal(r.strikeProfile({ category: 'sword' }).attacks, 2);
  assert.equal(r.strikeProfile({ category: 'bow' }).attacks, 1);
  assert.equal(r.strikeProfile({ category: 'bow' }, { style: 'strong' }).multiplier, 2);
  assert.throws(() => r.strikeProfile({ category: 'crossbow' }, { style: 'strong' }));
  assert.throws(() => r.strikeProfile({ rof: 3 }, { style: 'strong', npc: true }));
  assert.equal(r.strikeProfile({ rof: 3 }, { style: 'normal', npc: true }).attacks, 3);
});
test('p.164 thrown parry is -5, normal parry -3, arrows cannot be parried', () => {
  assert.equal(r.defenseModifier('parry', 'thrown'), -5);
  assert.equal(r.defenseModifier('parry', 'sword'), -3);
  assert.throws(() => r.defenseModifier('parry', 'bow'));
  assert.throws(() => r.defenseModifier('blockWeapon', 'crossbow'));
});
test('p.164 range bands include exact limits and reject beyond extreme', () => {
  assert.deepEqual(
    [0.5, 25, 50, 100, 200].map((d) => r.rangeBracket(d, 100).modifier),
    [5, 0, -2, -4, -6]
  );
  assert.throws(() => r.rangeBracket(201, 100));
});
