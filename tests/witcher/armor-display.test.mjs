import test from 'node:test';
import assert from 'node:assert/strict';
import { armorLocationRows, actorArmorRows } from '../../module/witcher/armor-display.js';
import { HUMANOID_LOCATIONS } from '../../module/witcher/config.js';

test('broken SP stays zero; absent wear uses maximum, including coverage outside an owner anatomy', () => {
  const item = {
    type: 'armor',
    system: {
      coverage: ['torso', 'rightArm', 'tailWing', 'customPlate'],
      stoppingPower: 10,
      sp: { torso: 0, rightArm: 8, tailWing: 4 },
    },
  };
  const before = structuredClone(item);
  const rows = armorLocationRows(item, HUMANOID_LOCATIONS);
  assert.deepEqual(
    rows.map((r) => [r.id, r.current, r.maximum]),
    [
      ['torso', 0, 10],
      ['rightArm', 8, 10],
      ['tailWing', 4, 10],
      ['customPlate', 10, 10],
    ]
  );
  assert(rows[0].broken);
  assert.equal(rows[2].label, 'Tail / wing');
  assert.equal(rows[3].label, 'customPlate');
  assert.deepEqual(item, before);
});

test('current/max protection uses Witcher layering and only equipped armor, including natural and weak SP', () => {
  const armor = (maximum, current, armorClass = 'light', equipped = true) => ({
    type: 'armor',
    equipped,
    coverage: ['torso'],
    stoppingPower: maximum,
    sp: { torso: current },
    armorClass,
  });
  const state = {
    race: 'dwarf',
    items: [armor(3, 0), armor(12, 11, 'medium'), armor(20, 19, 'heavy'), armor(50, 50, 'heavy', false)],
  };
  const [row] = actorArmorRows(state, [{ id: 'torso', sp: 4, maxSp: 5, weakSp: 1, weakMaxSp: 2 }]);
  assert.equal(row.totalSP, 29); // 11+19 layer to 23; natural 4 + dwarf 2.
  assert.equal(row.maximumSP, 31); // Book example 3+12+20 layers to 24; natural 5 + dwarf 2.
  assert.equal(row.totalWeakSP, 26);
  assert.equal(row.maximumWeakSP, 28);
  assert(row.damaged);
});
