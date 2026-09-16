import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  advanceWoundDays,
  healingRequirements,
  injuredArmChoices,
  recoveryClockChanged,
  recoveryContext,
  recoveryPlan,
  woundCheckModifier,
} from '../../module/witcher/wound-rules.js';
import { WOUNDS, combinedModifiers, woundConditions, woundModifiers } from '../../module/witcher/wounds.js';
import { criticalHealingDays, derivedStats, resolveDamage } from '../../module/witcher/rules.js';
import { availableHands, validateWeaponGrip } from '../../module/witcher/inventory.js';
import { HUMANOID_LOCATIONS } from '../../module/witcher/config.js';

const actor = (body = 8) => ({ stats: { body, will: 8 }, hp: { value: 100 } });
const injury = (severity, index, overrides = {}, id = `${severity}-${index}`) => ({
  id,
  type: 'wound',
  wound: {
    ...structuredClone(WOUNDS[severity][index]),
    severity,
    treatment: 'untreated',
    ...overrides,
  },
});

test('pp.162,174: each severity has the correct stabilization, medical, and magical requirements', () => {
  const expected = {
    simple: { dc: 12, rounds: 2, magicDC: 14, magicUses: 4 },
    complex: { dc: 14, rounds: 4, magicDC: 16, magicUses: 6 },
    difficult: { dc: 16, rounds: 6, magicDC: 18, magicUses: 8 },
    deadly: { dc: 18, rounds: 8, magicDC: 20, magicUses: 10 },
  };
  for (const [severity, requirements] of Object.entries(expected))
    assert.deepEqual(healingRequirements(severity), requirements);
  for (const value of ['minor', '', undefined, null])
    assert.throws(() => healingRequirements(value), /severity/);
});

test('wound stages replace prior modifiers and ordinary healed wounds no longer penalize characters', () => {
  const item = injury('simple', 0);
  const expected = [
    ['untreated', { spd: -2, dodge: -2, athletics: -2 }],
    ['stabilized', { spd: -1, dodge: -1, athletics: -1 }],
    ['treated', { spd: -1 }],
    ['healed', {}],
  ];
  for (const [treatment, modifiers] of expected) {
    item.wound.treatment = treatment;
    assert.deepEqual(woundModifiers(item.wound), modifiers);
    assert.deepEqual(combinedModifiers({}, [item]), modifiers);
  }
  assert.equal(item.wound.name, 'Sprained Leg');
  assert.deepEqual(item.wound.modifiers, { spd: -2, dodge: -2, athletics: -2 });
});

test('healed deadly injuries keep their permanent consequences, with an explicit aftermath override supported', () => {
  const expected = [
    { spdMultiplier: 0.25, dodgeMultiplier: 0.25, athleticsMultiplier: 0.25 },
    { armDisabled: 1 },
    { sta: -5 },
    { bleedingDamage: 2 },
    { sightAwareness: -1, dex: -1 },
  ];
  for (const [index, modifiers] of expected.entries()) {
    const item = injury('deadly', index, { treatment: 'healed', healedModifiers: {} });
    assert.deepEqual(woundModifiers(item.wound), modifiers);
    assert.deepEqual(combinedModifiers({}, [item]), modifiers);
  }
  const eye = injury('deadly', 4, { treatment: 'healed', healedModifiers: { sightAwareness: -2 } });
  assert.deepEqual(woundModifiers(eye.wound), { sightAwareness: -2 });
});

test('p.174: the entire printed BODY 3–13 recovery table is reproduced', () => {
  const rows = [
    [3, 5, 9, 12],
    [4, 4, 8, 11],
    [5, 3, 7, 10],
    [6, 2, 6, 9],
    [7, 1, 5, 8],
    [8, 1, 4, 7],
    [9, 1, 3, 6],
    [10, 1, 2, 5],
    [11, 1, 1, 4],
    [12, 1, 1, 3],
    [13, 1, 1, 2],
  ];
  for (const [body, ...days] of rows) {
    for (const [index, severity] of ['simple', 'complex', 'difficult'].entries()) {
      assert.equal(criticalHealingDays(body, severity), days[index]);
      const item = injury(severity, 0);
      assert.deepEqual(recoveryPlan(actor(body), [item], { ...item.wound, itemId: item.id }), {
        body,
        days: days[index],
        reason: '',
      });
    }
  }
  assert.equal(criticalHealingDays(8, 'deadly'), null);
});

test('the recovery clock uses BODY after treatment and retains penalties from other wounds', () => {
  const ribs = injury('complex', 2, { location: 'torso' }, 'ribs');
  const unrelated = injury('simple', 3, { location: 'torso' }, 'other-ribs');
  const before = structuredClone([ribs, unrelated]);
  assert.equal(derivedStats(actor(), [ribs]).stats.body, 6);
  assert.deepEqual(recoveryPlan(actor(), [ribs], { ...ribs.wound, itemId: ribs.id }), {
    body: 7,
    days: 5,
    reason: '',
  });
  assert.deepEqual(recoveryPlan(actor(), [ribs, unrelated], { ...ribs.wound, itemId: ribs.id }), {
    body: 5,
    days: 7,
    reason: '',
  });
  assert.deepEqual([ribs, unrelated], before, 'preview must not mutate treatment or original modifiers');
  const documents = before.map(({ id, type, wound }) => ({ _id: id, type, system: { wound } }));
  assert.deepEqual(recoveryPlan(actor(), documents, { ...ribs.wound, itemId: ribs.id }), {
    body: 5,
    days: 7,
    reason: '',
  });
});

test('permanent, fatal, and out-of-table BODY injuries never receive an invented recovery duration', () => {
  for (let index = 0; index < 6; index++) {
    const item = injury('deadly', index);
    const plan = recoveryPlan(actor(), [item], { ...item.wound, itemId: item.id });
    assert.equal(plan.days, null);
    assert.match(plan.reason, index === 5 ? /fatal/ : /lasting/);
  }
  const item = injury('complex', 0);
  for (const body of [2, 14]) {
    const plan = recoveryPlan(actor(body), [item], { ...item.wound, itemId: item.id });
    assert.equal(plan.body, body);
    assert.equal(plan.days, null);
    assert.match(plan.reason, /BODY 3–13.*GM/);
  }
  assert.throws(() => recoveryPlan(actor(), [], { severity: 'unknown' }), /Unknown critical wound severity/);
});

test('Foreign Object requires an explicit GM clock instead of unprinted Critical Healing arithmetic', () => {
  const leg = injury('complex', 0);
  for (const treatment of ['untreated', 'stabilized', 'treated']) {
    const foreign = injury('simple', 2, { treatment });
    const plan = recoveryPlan(actor(), [leg, foreign], { ...leg.wound, itemId: leg.id });
    assert.equal(plan.days, null);
    assert.match(plan.reason, /Critical Healing modifier.*GM/);
  }
  const foreign = injury('simple', 2);
  assert.equal(recoveryPlan(actor(), [foreign], { ...foreign.wound, itemId: foreign.id }).days, null);
  foreign.wound.treatment = 'healed';
  assert.deepEqual(recoveryPlan(actor(), [leg, foreign], { ...leg.wound, itemId: leg.id }), {
    body: 8,
    days: 4,
    reason: '',
  });
});

test('new, changed, and removed Critical Healing effects invalidate only affected running clocks', () => {
  const leg = injury('complex', 0, {
    treatment: 'treated',
    daysRemaining: 3,
    daysTotal: 4,
    recoveryContext: '',
  });
  const foreign = injury('simple', 2);
  assert.equal(recoveryContext(actor(), [leg]), '');
  assert.equal(recoveryClockChanged(leg.wound, actor(), [leg]), false);
  assert.deepEqual(JSON.parse(recoveryContext(actor(), [leg, foreign])), { flat: 0, multiplier: 0.25 });
  assert.equal(recoveryClockChanged(leg.wound, actor(), [leg, foreign]), true);
  leg.wound.recoveryContext = recoveryContext(actor(), [leg, foreign]);
  assert.equal(recoveryClockChanged(leg.wound, actor(), [leg, foreign]), false);
  foreign.wound.treatment = 'stabilized';
  assert.deepEqual(JSON.parse(recoveryContext(actor(), [leg, foreign])), { flat: 0, multiplier: 0.5 });
  assert.equal(recoveryClockChanged(leg.wound, actor(), [leg, foreign]), true);
  leg.wound.recoveryContext = recoveryContext(actor(), [leg, foreign]);
  foreign.wound.treatment = 'treated';
  assert.deepEqual(JSON.parse(recoveryContext(actor(), [leg, foreign])), { flat: -1, multiplier: 1 });
  assert.equal(recoveryClockChanged(leg.wound, actor(), [leg, foreign]), true);
  leg.wound.recoveryContext = recoveryContext(actor(), [leg, foreign]);
  assert.equal(recoveryClockChanged(leg.wound, actor(), [leg, foreign]), false);
  assert.equal(recoveryClockChanged(leg.wound, actor(), [leg]), true);
  foreign.wound.treatment = 'healed';
  assert.equal(recoveryContext(actor(), [leg, foreign]), '');
  assert.equal(recoveryClockChanged(leg.wound, actor(), [leg, foreign]), true);
  assert.equal(leg.wound.daysRemaining, 3, 'context review must preserve already elapsed progress');
  assert.equal(leg.wound.daysTotal, 4);
  for (const patch of [
    { treatment: 'untreated' },
    { treatment: 'stabilized' },
    { treatment: 'healed' },
    { permanent: true },
    { fatal: true },
  ])
    assert.equal(recoveryClockChanged({ ...leg.wound, ...patch }, actor(), [leg]), false);
});

test('recovery context handles Item document sources, ignores unrelated penalties, and includes external recovery modifiers', () => {
  const foreign = injury('simple', 2, { treatment: 'stabilized' });
  const document = { id: foreign.id, type: 'wound', system: { wound: foreign.wound } };
  assert.equal(recoveryContext(actor(), [foreign]), recoveryContext(actor(), [document]));
  const unrelated = injury('difficult', 5);
  assert.equal(recoveryContext(actor(), [unrelated]), '');
  const state = { ...actor(), statModifiers: { criticalHealing: -1, ref: -2 } };
  assert.deepEqual(JSON.parse(recoveryContext(state, [foreign])), { flat: -1, multiplier: 0.5 });
});

test('advancing recovery preserves the injury record and marks only completed treated wounds healed', () => {
  const item = injury('complex', 4, {
    treatment: 'treated',
    daysRemaining: 5,
    daysTotal: 5,
    extraResult: 6,
    notes: 'Six teeth lost in the ambush.',
    location: 'head',
  });
  const original = structuredClone(item.wound);
  assert.deepEqual(advanceWoundDays(item.wound, 2), { daysRemaining: 3 });
  assert.deepEqual(advanceWoundDays(item.wound, 5), { daysRemaining: 0, treatment: 'healed' });
  const healed = { ...item.wound, ...advanceWoundDays(item.wound, 99) };
  assert.equal(healed.name, 'Lost Teeth');
  assert.equal(healed.extraResult, 6);
  assert.equal(healed.notes, original.notes);
  assert.equal(healed.location, 'head');
  assert.equal(healed.daysTotal, 5);
  assert.deepEqual(woundModifiers(healed), {});
  assert.deepEqual(item.wound, original);
});

test('elapsed days never auto-complete a pending, permanent, fatal, untreated, or stabilized injury', () => {
  const wound = injury('simple', 0, { treatment: 'treated', daysRemaining: 1 }).wound;
  for (const patch of [
    { recoveryPending: true },
    { permanent: true },
    { fatal: true },
    { treatment: 'untreated' },
    { treatment: 'stabilized' },
    { treatment: 'healed' },
  ])
    assert.equal(advanceWoundDays({ ...wound, ...patch }, 100), null);
  for (const days of [0, -1, 1.5, Infinity, NaN, '1', null, undefined])
    assert.throws(() => advanceWoundDays(wound, days), /positive whole number/);
});

test('arm and sight penalties apply only to explicitly relevant check context', () => {
  const left = injury('simple', 1, { location: 'leftArm' });
  const right = injury('complex', 1, { location: 'rightArm' });
  const eye = injury('deadly', 4, { location: 'head' });
  const items = [left, right, eye];
  assert.equal(woundCheckModifier(items), 0);
  assert.equal(woundCheckModifier(items, { arm: 'leftArm' }), -2);
  assert.equal(woundCheckModifier(items, { arm: 'rightArm' }), -3);
  assert.equal(woundCheckModifier(items, { arm: 'both' }), -5);
  assert.equal(woundCheckModifier(items, { sight: true }), -5);
  assert.equal(woundCheckModifier(items, { sight: true, arm: 'leftArm' }), -7);
  left.wound.treatment = 'treated';
  right.wound.treatment = 'stabilized';
  eye.wound.treatment = 'healed';
  assert.equal(woundCheckModifier(items, { arm: 'leftArm' }), 0);
  assert.equal(woundCheckModifier(items, { arm: 'rightArm' }), -2);
  assert.equal(woundCheckModifier(items, { sight: true }), -1);
  right.wound.treatment = 'healed';
  assert.equal(woundCheckModifier(items, { arm: 'both', sight: false }), 0);
  const documents = items.map(({ type, wound }) => ({ type, system: { wound } }));
  assert.equal(woundCheckModifier(documents, { sight: true }), -1);
});

test('injured limb selection supports monster limbs and stops prompting once temporary arm penalties heal', () => {
  const limb = injury('complex', 1, { location: 'rightLimb' });
  const monster = { ...actor(), anatomy: 'monster' };
  const choices = injuredArmChoices(monster, [limb]);
  assert.equal(choices.rightLimb, 'Right limb');
  assert.equal(choices.leftLimb, 'Left limb');
  assert.equal(woundCheckModifier([limb], { arm: 'rightLimb' }), -3);
  assert.equal(woundCheckModifier([limb], { arm: 'leftLimb' }), 0);
  limb.wound.treatment = 'healed';
  assert.equal(injuredArmChoices(monster, [limb]), null);
  const human = injury('simple', 1, { location: 'leftArm' });
  assert.deepEqual(injuredArmChoices(actor(), [human]), {
    rightArm: 'Right arm',
    leftArm: 'Left arm',
  });
});

test('Skull Fracture replaces head damage with ×4, does not multiply with duplicates, and ends after healing', () => {
  const head = HUMANOID_LOCATIONS.find((location) => location.id === 'head');
  const torso = HUMANOID_LOCATIONS.find((location) => location.id === 'torso');
  const first = injury('difficult', 5, { location: 'head' }, 'first');
  const second = injury('difficult', 5, { location: 'head' }, 'second');
  assert.equal(resolveDamage({ raw: 10 }, actor(), head).damage, 30);
  for (const treatment of ['untreated', 'stabilized', 'treated']) {
    first.wound.treatment = treatment;
    assert.equal(resolveDamage({ raw: 10 }, actor(), head, [first]).damage, 40);
    assert.equal(resolveDamage({ raw: 10 }, actor(), torso, [first]).damage, 10);
  }
  assert.equal(combinedModifiers(actor(), [first, second]).headMultiplier, 4);
  assert.equal(resolveDamage({ raw: 10 }, actor(), head, [first, second]).damage, 40);
  first.wound.treatment = 'healed';
  assert.equal(resolveDamage({ raw: 10 }, actor(), head, [first, second]).damage, 40);
  second.wound.treatment = 'healed';
  assert.equal(resolveDamage({ raw: 10 }, actor(), head, [first, second]).damage, 30);
});

test('arm healing restores weapon grips but permanent arm loss continues to restrict hands', () => {
  const fracture = injury('difficult', 1, { location: 'leftArm' });
  const severed = injury('deadly', 1, { location: 'rightArm', treatment: 'healed' });
  const sword = {
    id: 'greatsword',
    type: 'weapon',
    hands: 2,
    equipped: true,
    carried: true,
    quantity: 1,
    properties: {},
  };
  for (const treatment of ['untreated', 'stabilized', 'treated']) {
    fracture.wound.treatment = treatment;
    assert.equal(availableHands(actor(), [fracture]), 1);
    assert.throws(() => validateWeaponGrip(actor(), sword, [sword, fracture]), /1 usable hands/);
  }
  fracture.wound.treatment = 'healed';
  assert.equal(availableHands(actor(), [fracture]), 2);
  assert.equal(validateWeaponGrip(actor(), sword, [sword, fracture]).availableHands, 2);
  assert.equal(availableHands(actor(), [fracture, severed]), 1);
  assert.throws(() => validateWeaponGrip(actor(), sword, [sword, fracture, severed]), /1 usable hands/);
  const another = injury('deadly', 1, { location: 'rightArm', treatment: 'treated' }, 'another');
  assert.equal(availableHands(actor(), [severed, another]), 1);
});

test('wound conditions are unique and persist until the last contributing injury is stabilized', () => {
  const bleeding = injury('complex', 3);
  const secondBleed = injury('difficult', 0);
  const poison = injury('deadly', 2);
  const suffocating = injury('difficult', 2);
  const items = [bleeding, secondBleed, poison, suffocating];
  assert.deepEqual(woundConditions(items).sort(), ['bleeding', 'poison', 'suffocating']);
  bleeding.wound.treatment = 'stabilized';
  poison.wound.treatment = 'treated';
  suffocating.wound.treatment = 'healed';
  assert.deepEqual(woundConditions(items), ['bleeding']);
  secondBleed.wound.treatment = 'stabilized';
  assert.deepEqual(woundConditions(items), []);
});
