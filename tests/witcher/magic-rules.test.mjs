import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SIGN_KEYS,
  absorbQuen,
  counterMagicCost,
  elementalBacklash,
  magicCostPlan,
  magicDefenses,
  magicDuration,
  magicMaintenance,
  magicalFumble,
  signParameters,
  validateMagicPower,
} from '../../module/witcher/magic-rules.js';

const sign = (key = 'igni') => ({ key, kind: 'sign', cost: { min: 1, max: 7, step: 1, options: [] } });
const cost = (overrides = {}) =>
  magicCostPlan({ magic: sign(), power: 3, vigor: 5, stamina: 20, ...overrides });

test('Core p.166: Vigor accounts for successive spells in the same round', () => {
  const first = cost();
  assert.equal(first.roundAfter, 3);
  assert.equal(first.hpCost, 0);
  const second = cost({ spent: first.roundAfter, stamina: first.staAfter });
  assert.equal(second.roundAfter, 6);
  assert.equal(second.overdrawAdded, 1);
  assert.equal(second.hpCost, 5);
  assert.equal(second.elementalBacklash, true);
  assert.equal(second.staAfter, 14);
  const third = cost({ power: 2, spent: second.roundAfter, stamina: second.staAfter });
  assert.equal(third.overdrawBefore, 1);
  assert.equal(third.overdrawAfter, 3);
  assert.equal(third.overdrawAdded, 2);
  assert.equal(third.hpCost, 10, 'prior overdraw is never charged again');
  assert.equal(cost({ power: 2, spent: 0 }).hpCost, 0, 'a new round resets channelled magic');
});

test('Core p.167: one focus lowers STA and Vigor load but preserves chosen sign strength', () => {
  const plan = cost({ power: 7, focus: 2 });
  assert.equal(plan.power, 7);
  assert.equal(plan.staCost, 5);
  assert.equal(plan.roundAfter, 5);
  assert.equal(plan.hpCost, 0);
  assert.equal(signParameters('igni', plan.power).damageFormula, '7d6');
  assert.equal(cost({ power: 1, focus: 4 }).staCost, 1);
  assert.equal(cost({ power: 3, focus: 4 }).staCost, 1);
  assert.throws(() => cost({ focus: -1 }), /Focus/);
  assert.throws(() => cost({ focus: [1, 2] }), /Focus/);
});

test('casting validates resources, bounds and explicit Somne power options without mutations', () => {
  const magic = { ...sign('somne'), cost: { min: 2, max: 7, step: 1, options: [2, 4, 6, 7] } };
  const before = structuredClone(magic);
  assert.equal(validateMagicPower(magic, 4), 4);
  assert.equal(validateMagicPower({ system: { magic } }, 6), 6);
  assert.throws(() => validateMagicPower(magic, 3), /one of these/);
  assert.throws(() => validateMagicPower(sign(), 8), /between/);
  assert.throws(() => validateMagicPower(sign(), 1.5), /steps/);
  assert.throws(() => cost({ stamina: 2 }), /requires 3 STA/);
  assert.throws(() => cost({ dimeritium: true }), /dimeritium/);
  assert.throws(() => cost({ vigor: 0 }), /Vigor/);
  for (const value of [NaN, Infinity, -1, '3']) assert.throws(() => cost({ power: value }));
  assert.deepEqual(magic, before);
  const exhausted = cost({ stamina: 3 });
  assert.equal(exhausted.staAfter, 0);
  assert.equal(exhausted.exhausted, true);
});

test('Core pp.70,102,115: half-STA costs remain exact, without a second focus discount', () => {
  assert.equal(counterMagicCost(7), 3.5);
  assert.equal(counterMagicCost(1), 0.5);
  assert.equal(magicMaintenance({ duration: { maintenance: 'initial' } }, 5), 5);
  assert.equal(magicMaintenance({ duration: { maintenance: 'half' } }, 5), 2.5);
  assert.equal(magicMaintenance({ duration: { maintenance: 'half' } }, 1), 0.5);
  assert.equal(magicMaintenance({ duration: { maintenance: 'none' } }), 0);
  assert.equal(magicMaintenance({ duration: { maintenance: 'fixed', maintenanceCost: 2 } }, 6), 2);
  const half = magicCostPlan({ power: 0.5, vigor: 5, stamina: 20 });
  assert.equal(half.staCost, 0.5);
  assert.equal(half.staAfter, 19.5);
  assert.equal(
    magicCostPlan({ power: 0.5, focus: 1, vigor: 5, stamina: 20 }).staCost,
    0.5,
    'focus never increases a cost'
  );
  assert.throws(() => counterMagicCost(0), /Incoming magic/);
  assert.throws(() => magicMaintenance({ duration: { maintenance: 'unknown' } }, 1), /Unknown/);
});

test('Core p.99: Dodge allows Dodge/Escape and Athletics; None still permits counter magic', () => {
  assert.deepEqual(magicDefenses({ defenses: ['dodge', 'block'] }), [
    'dodge',
    'athletics',
    'block',
    'dispel',
    'heliotrope',
  ]);
  assert.deepEqual(magicDefenses({ defenses: ['None'] }), ['dispel', 'heliotrope']);
  assert.deepEqual(magicDefenses({ defenses: ['Resist Magic'] }), ['resistMagic', 'dispel', 'heliotrope']);
  assert.deepEqual(magicDefenses({ defenses: ['Dodge/Escape'] }, { includeCounters: false }), ['dodge']);
  assert.deepEqual(magicDefenses({ defenses: ['Athletics'] }, { includeCounters: false }), ['athletics']);
  assert.deepEqual(magicDefenses({ defenses: ['WILL x 3'] }, { includeCounters: false }), ['willx3']);
  assert.deepEqual(magicDefenses({ defenses: ['dodge', 'dodge', 'athletics'] }, { includeCounters: false }), [
    'dodge',
    'athletics',
  ]);
  assert.throws(() => magicDefenses({ defenses: ['parry'] }), /Unknown magical defense/);
});

test('Core p.166: low magical fumbles deal continuation damage while still resolving the spell', () => {
  assert.equal(magicalFumble().spellSucceeds, true);
  assert.equal(magicalFumble({ element: 'unspecified' }).spellSucceeds, true);
  assert.equal(magicalFumble({ fumble: 2, element: 'unspecified' }).damage, 2);
  assert.throws(() => magicalFumble({ fumble: 8, element: 'unspecified' }), /Unknown magic element/);
  for (let fumble = 1; fumble <= 6; fumble++) {
    const result = magicalFumble({ fumble, element: 'fire' });
    assert.equal(result.spellSucceeds, true);
    assert.equal(result.damage, fumble);
    assert.equal(result.condition, '');
    assert.equal(result.focusExplosion, false);
  }
});

test('Core p.166: high magical fumbles fail and produce exactly one elemental consequence', () => {
  for (const [element, condition, pushMeters] of [
    ['earth', 'stunned', 0],
    ['air', '', 2],
    ['fire', 'fire', 0],
    ['water', 'frozen', 0],
  ]) {
    const result = magicalFumble({ fumble: 9, element });
    assert.equal(result.spellSucceeds, false);
    assert.equal(result.damage, 9);
    assert.equal(result.condition, condition);
    assert.equal(result.pushMeters, pushMeters);
    assert.equal(result.needsElement, false);
    assert.equal(result.focusExplosion, false);
  }
  const unresolved = magicalFumble({ fumble: 8, element: 'mixed' });
  assert.equal(unresolved.needsElement, true);
  assert.equal(unresolved.damage, 8);
  const selected = magicalFumble({ fumble: 8, element: 'mixed', mixedElement: 'water' });
  assert.equal(selected.condition, 'frozen');
  assert.equal(selected.damage, 8, 'the mixed table does not double the listed damage');
  assert.equal(selected.needsElement, false);
  assert.throws(() => elementalBacklash('mixed', { mixedElement: 'mixed' }), /requires an earth/);
});

test('overexertion applies elemental consequences independently of a check fumble', () => {
  const plan = cost({ power: 7, vigor: 5 });
  assert.equal(plan.hpCost, 10);
  assert.equal(plan.elementalBacklash, true);
  assert.deepEqual(elementalBacklash('fire'), {
    element: 'fire',
    needsElement: false,
    condition: 'fire',
    pushMeters: 0,
  });
  assert.equal(magicalFumble({ fumble: 0, element: 'fire' }).damage, 0);
});

test('Core p.166: an exploding magical fumble above9 requests focus destruction and a2m bomb', () => {
  const result = magicalFumble({ fumble: 24, element: 'air' });
  assert.equal(result.spellSucceeds, false);
  assert.equal(result.damage, 24);
  assert.equal(result.pushMeters, 2);
  assert.equal(result.focusExplosion, true);
  assert.equal(result.explosionFormula, '1d10');
  assert.equal(result.explosionRadius, 2);
  assert.throws(() => magicalFumble({ fumble: 2.5 }), /whole/);
});

test('Core p.168: ritual and hex fumbles replace ordinary magical mishaps', () => {
  const ritual = magicalFumble({ fumble: 20, kind: 'ritual', element: 'fire', ritualCost: 7 });
  assert.equal(ritual.damage, 7);
  assert.equal(ritual.condition, '');
  assert.equal(ritual.focusExplosion, false);
  assert.equal(ritual.spellSucceeds, false);
  const hex = magicalFumble({ fumble: 2, kind: 'hex', element: 'fire' });
  assert.equal(hex.hexBackfireChance, 50);
  assert.equal(hex.damage, 0);
  assert.equal(hex.condition, '');
  assert.equal(hex.spellSucceeds, false);
});

test('Core pp.114–115: Yrden and Axii increase only for each complete pair beyond the first STA', () => {
  const progression = [1, 1, 2, 2, 3, 3, 4];
  for (const [index, value] of progression.entries()) {
    const power = index + 1;
    assert.equal(signParameters('yrden', power).penalty, value);
    assert.equal(signParameters('axii', power).stunModifier, -value);
  }
  const yrden = signParameters('yrden', 7);
  assert.equal(yrden.area.radius, 3);
  assert.equal(yrden.durationRounds, 5);
  assert.equal(yrden.makesCorporeal, true);
  assert.equal(signParameters('axii', 3).repeatDefense, 'stun');
});

test('Core pp.114–115: Aard and Aard Sweep preserve their different printed knockdown behavior', () => {
  for (const power of [1, 4, 7]) {
    const aard = signParameters('aard', power),
      sweep = signParameters('aard-sweep', power);
    assert.equal(aard.proneChance, 10 + power * 10);
    assert.equal(aard.staggered, true);
    assert.equal(aard.area.shape, 'cone');
    assert.equal(aard.area.angle, null, 'the book does not specify a cone angle');
    assert.equal(sweep.proneChance, power * 10);
    assert.equal(sweep.staggeredOnProne, true);
    assert.equal(sweep.staggered, undefined);
    assert.equal(sweep.area.radius, 4);
    assert.equal(sweep.affectsFlying, true);
  }
});

test('Core pp.114–115: fire signs differ in ignition chance, aiming, range and upkeep', () => {
  const igni = signParameters('igni', 5),
    stream = signParameters('fire-stream', 5);
  assert.equal(igni.damageFormula, '5d6');
  assert.equal(igni.igniteChance, 50);
  assert.equal(igni.location, 'torso');
  assert.equal(igni.aimAtPointBlank, true);
  assert.equal(igni.area.distance, 2);
  assert.equal(stream.damageFormula, '5d6');
  assert.equal(stream.igniteChance, 75);
  assert.equal(stream.location, 'chosen');
  assert.equal(stream.rangeMeters, 3);
  assert.equal(stream.maintenanceCost, 2.5);
  assert.equal(stream.active, true);
});

test('Core pp.114–115: both Quen forms have distinct shields, durations and collapse consequences', () => {
  const quen = signParameters('quen', 4),
    active = signParameters('active-shield', 4);
  assert.equal(quen.shieldHP, 20);
  assert.equal(quen.durationRounds, 10);
  assert.equal(quen.recastWhileActive, false);
  assert.equal(active.shieldHP, 40);
  assert.equal(active.maintenanceCost, 4);
  assert.equal(active.preventsRunning, true);
  assert.equal(active.blocksPassage, true);
  assert.equal(active.collapseDamage, '1d6');
  assert.equal(active.collapsePushMeters, 2);
  assert.equal(active.maximumPushWeight, 226);
  assert.equal(active.protectedExtraTargets, 1);
});

test('Core p.115: Magic Trap uses one closest-enemy attack per round, Puppet offers repeated resistance', () => {
  const trap = signParameters('magic-trap', 6),
    puppet = signParameters('puppet', 6);
  assert.equal(trap.preparationRounds, 1);
  assert.equal(trap.damageFormula, '3d6');
  assert.equal(trap.durationRounds, 6);
  assert.equal(trap.attacksPerRound, 1);
  assert.equal(trap.closestEnemyOnly, true);
  assert.equal(puppet.durationRounds, 6);
  assert.equal(puppet.rangeMeters, 8);
  assert.equal(puppet.repeatDefense, 'resistMagic');
});

test('Tome p.101: Somne has four defined wake conditions and an eight-hour clock', () => {
  for (const [power, wake] of [
    [2, 'noise'],
    [4, 'action'],
    [6, 'fullRound'],
    [7, 'damage'],
  ]) {
    const result = signParameters('somne', power);
    assert.equal(result.wake, wake);
    assert.equal(result.wakesOnDamage, true);
    assert.equal(result.durationSeconds, 28800);
    assert.equal(result.stunned, true);
    assert.deepEqual(result.defenses, ['resistMagic']);
  }
  for (const power of [1, 3, 5]) assert.throws(() => signParameters('somne', power), /one of these/);
});

test('Tome p.101: Supirre range scales2m perSTA and does not require Awareness at the linked point', () => {
  for (let power = 1; power <= 7; power++) {
    const result = signParameters('supirre', power);
    assert.equal(result.rangeMeters, power * 2);
    assert.equal(result.durationSeconds, 600);
    assert.equal(result.stationary, true);
    assert.equal(result.hearingCheckRequired, false);
  }
});

test('all12 signs resolve deterministic durations without inventing expiries for repeat saves', () => {
  assert.equal(SIGN_KEYS.length, 12);
  for (const key of SIGN_KEYS) {
    const power = key === 'somne' ? 2 : 1;
    assert.deepEqual(signParameters(key, power), signParameters(key, power));
    assert.equal(typeof magicDuration(sign(key), power).seconds, 'number');
  }
  assert.deepEqual(magicDuration(sign('quen'), 3), {
    rounds: 10,
    seconds: 30,
    active: false,
    maintenance: 0,
  });
  assert.deepEqual(magicDuration(sign('fire-stream'), 3), {
    rounds: 0,
    seconds: 0,
    active: true,
    maintenance: 1.5,
  });
  assert.deepEqual(magicDuration(sign('axii'), 3), { rounds: 0, seconds: 0, active: false, maintenance: 0 });
  assert.equal(magicDuration({ duration: { rounds: 2, maintenance: 'none' } }, 3).seconds, 6);
  assert.throws(() => signParameters('invented', 1), /Unknown/);
});

test('Core p.114: Quen intercepts raw damage and passes only the remainder to armor', () => {
  assert.deepEqual(absorbQuen({ raw: 23, shieldHP: 15 }), {
    absorbed: 15,
    remaining: 8,
    shieldHP: 0,
    broken: true,
    eligible: true,
  });
  assert.deepEqual(absorbQuen({ raw: 10, shieldHP: 15 }), {
    absorbed: 10,
    remaining: 0,
    shieldHP: 5,
    broken: false,
    eligible: true,
  });
  assert.equal(absorbQuen({ raw: 15, shieldHP: 15 }).broken, true);
  assert.equal(
    absorbQuen({ raw: 15, shieldHP: 0 }).broken,
    false,
    'an already exhausted shield does not burst again'
  );
  let shieldHP = 12;
  const remainders = [5, 9, 6].map((raw) => {
    const result = absorbQuen({ raw, shieldHP });
    shieldHP = result.shieldHP;
    return result.remaining;
  });
  assert.deepEqual(remainders, [0, 2, 6], 'multiple hits share the same finite shield');
});

test('Core p.114: Quen cannot intercept unblockable magic or internal damage', () => {
  const blockable = absorbQuen({ raw: 10, shieldHP: 20, magic: true, defenses: ['dodge', 'block'] });
  assert.equal(blockable.absorbed, 10);
  const unblockable = absorbQuen({ raw: 10, shieldHP: 20, magic: true, defenses: ['dodge'] });
  assert.equal(unblockable.absorbed, 0);
  assert.equal(unblockable.remaining, 10);
  assert.equal(unblockable.eligible, false);
  for (const source of ['poison', 'disease', 'suffocation', 'bleeding']) {
    const result = absorbQuen({ raw: 4, shieldHP: 10, source });
    assert.equal(result.absorbed, 0);
    assert.equal(result.shieldHP, 10);
  }
  assert.throws(() => absorbQuen({ raw: -1, shieldHP: 4 }), /raw damage/);
});
