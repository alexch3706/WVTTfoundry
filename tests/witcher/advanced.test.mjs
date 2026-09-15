import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mountedDamage,
  fallingDice,
  scatter,
  mountedControlLoss,
  vehicleControlLoss,
  adrenalineCost,
  rangeDifficulty,
} from '../../module/witcher/advanced-rules.js';

test('p.171: charge dice floor distance/2 and cap at five; gallop uses five', () => {
  assert.equal(mountedDamage({ distance: 1 }).dice, 0);
  assert.equal(mountedDamage({ distance: 9 }).dice, 4);
  assert.equal(mountedDamage({ distance: 30 }).dice, 5);
  assert.equal(mountedDamage({ distance: 1, galloping: true }).dice, 5);
});
test('p.171: charge weight multiplies speed dice, not the weapon’s base damage', () => {
  const result = mountedDamage({ distance: 10, weight: 'heavy', baseRoll: 12, speedRoll: 15 });
  assert.equal(result.total, 57);
  assert.notEqual(result.total, 81);
  assert.equal(mountedDamage({ weight: 'veryLight', baseRoll: 12, speedRoll: 5 }).total, 14);
});
test('p.171: falling damage uses one d6 per full two metres', () => {
  assert.deepEqual([0, 1, 2, 3, 30].map(fallingDice), [0, 0, 1, 1, 15]);
  assert.throws(() => fallingDice(-1));
});
test('p.152: scatter rotates with the direction of flight and uses rolled metres', () => {
  const forward = scatter(10, 6, { origin: { x: 0, y: 0 }, target: { x: 10, y: 0 }, pixelsPerMeter: 10 });
  assert.equal(forward.x, 70);
  assert.equal(forward.y, 0);
  const backward = scatter(1, 3, { origin: { x: 0, y: 0 }, target: { x: 10, y: 0 } });
  assert.equal(backward.x, 7);
  assert.ok(Math.abs(backward.y) < 1e-10);
});
test('p.170: both personal and mount control loss tables have separate results', () => {
  assert.equal(mountedControlLoss(4, 7).rider.athleticsDC, 15);
  assert.equal(mountedControlLoss(4, 7).animal.athleticsDC, 15);
  assert.equal(mountedControlLoss(7, 10).rider.athleticsDC, 25);
  assert.equal(mountedControlLoss(7, 10).animal.kind, 'faint');
  assert.equal(vehicleControlLoss(6).damage, '5d6');
});
test('p.152: target size modifies passive ranged DC', () => {
  assert.equal(rangeDifficulty({ dc: 15 }, 'small'), 17);
  assert.equal(rangeDifficulty({ dc: 15 }, 'huge'), 11);
});
test('p.175: each adrenaline die costs ten STA and cannot exceed the pool', () => {
  assert.deepEqual(adrenalineCost(2, 3, 25), { pool: 1, stamina: 5, dice: 2 });
  assert.throws(() => adrenalineCost(3, 2, 40));
  assert.throws(() => adrenalineCost(2, 3, 19));
});
