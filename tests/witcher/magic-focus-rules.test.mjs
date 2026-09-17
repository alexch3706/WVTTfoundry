import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { greaterFocusSnapshot, magicDefenseTotal } from '../../module/witcher/magic-focus-rules.js';
import { spellEffectPlan } from '../../module/witcher/magic-effects.js';

const catalog = (file) =>
  JSON.parse(readFileSync(new URL(`../../data/witcher/${file}.json`, import.meta.url)));
test('actual source relics restrict Greater Focus to exactly their printed elements', () => {
  const relics = catalog('relics');
  const expected = {
    Devine: ['air'],
    Caroline: ['water'],
    'The Abyss Guard': ['water'],
    'Succubus’ Wand': ['fire'],
    Fate: ['water', 'fire'],
    'Moon Blade': ['earth', 'air', 'fire', 'water', 'mixed', 'unspecified'],
    Maugrim: ['earth', 'water'],
  };
  for (const [name, elements] of Object.entries(expected)) {
    const item = relics.find((row) => row.name === name);
    assert(item, name);
    for (const element of ['earth', 'air', 'fire', 'water', 'mixed', 'unspecified']) {
      const focus = greaterFocusSnapshot(item, { element });
      assert.equal(focus.defenseBonus, elements.includes(element) ? 2 : 0, `${name}: ${element}`);
      assert.equal(magicDefenseTotal({ focus, check: { total: 18 } }), elements.includes(element) ? 20 : 18);
    }
  }
});
test('ordinary Focus grants no DC bonus and an unknown qualifier cannot become unrestricted', () => {
  assert.equal(greaterFocusSnapshot(catalog('weapons').find((item) => item.name === 'Staff')), null);
  const staff = catalog('weapons').find((item) => item.name === 'Crystal Staff');
  assert.equal(greaterFocusSnapshot(staff, { element: 'mixed' }).defenseBonus, 2);
  staff.system.effectText = 'Greater Focus (unknown element)';
  assert.equal(greaterFocusSnapshot(staff, { element: 'air' }).defenseBonus, 0);
  assert.equal(magicDefenseTotal({ check: { total: 18 } }), 18, 'old casts remain unmodified');
});
test('Greater Focus changes resistance DCs while raw healing, fortune and opposed damage quantities stay unchanged', () => {
  const cast = { castTotal: 18, defenseBonus: 2 };
  const roots = spellEffectPlan('talfryns-prison', cast).operations;
  assert.equal(roots.find((op) => op.type === 'shield').escape.dc, 20);
  assert.equal(roots.find((op) => op.type === 'shield').hp, 15);
  assert.equal(spellEffectPlan('cursed-illness', { ...cast, power: 4 }).operations[1].rule.dc, 20);
  const hail = spellEffectPlan('merigolds-hailstorm', cast).operations[0].operations[0];
  assert.equal(hail.save.dc, 20);
  assert.equal(hail.formula, '2d6');
  const healing = spellEffectPlan('magic-healing', {
    ...cast,
    choices: { mode: 'critical', wound: 'wound' },
  });
  assert.equal(healing.operations[0].castingTotal, 18);
  for (const key of ['blessing-of-fortune', 'anialwch']) {
    const inputs = { ...cast, defenseTotal: 16, defenseFumbled: 0 };
    assert.deepEqual(
      spellEffectPlan(key, inputs).operations,
      spellEffectPlan(key, { ...inputs, defenseBonus: 0 }).operations,
      key
    );
  }
});
