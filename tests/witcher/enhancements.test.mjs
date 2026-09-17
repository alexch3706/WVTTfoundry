import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { enhancementDocuments } from '../../tools/witcher/build-enhancements.mjs';
import { enhancementIdentity } from '../../module/witcher/enhancement-catalog.js';
import {
  installStonePlan,
  physicalSetPlan,
  removePhysicalPlan,
  enhancementBenefits,
  actorEnhancementBenefits,
  elementalGlyphBonus,
  masterCraftUpdate,
  wordCraftPlan,
  rebuildEnhancementUpdate,
  makeAttachment,
  extraSlotUpdate,
} from '../../module/witcher/enhancements.js';
const S = 'witcher-rilerena';
const clone = (x) => structuredClone(x);
const core = JSON.parse(
  await fs.readFile(new URL('../../data/witcher/witcher-gear.json', import.meta.url), 'utf8')
);
const equipment = JSON.parse(
  await fs.readFile(new URL('../../data/witcher/equipment.json', import.meta.url), 'utf8')
);
const tome = await enhancementDocuments();
const stone = (name) => {
  const item = clone([...core, ...tome, ...equipment].find((entry) => entry.name === name));
  item.id = item._id;
  return item;
};
const gear = (type = 'armor', overrides = {}) => ({
  id: 'target',
  type,
  name: 'Equipment',
  flags: {},
  system: {
    quantity: 1,
    carried: true,
    equipped: true,
    enhancements: 3,
    attachments: [],
    properties: {},
    resistances: [],
    skillBonuses: [],
    weight: 2,
    stoppingPower: 10,
    sp: { torso: 7, leftArm: 10 },
    coverage: ['torso', 'leftArm'],
    ev: 1,
    maxReliability: 10,
    reliability: 7,
    damageTypes: ['slashing'],
    ...overrides,
  },
});
function apply(item, updates) {
  for (const [key, value] of Object.entries(updates)) {
    if (key === '_id') continue;
    const parts = key.split('.'),
      end = parts.pop();
    let at = item;
    for (const part of parts) at = at[part] ??= {};
    at[end] = clone(value);
  }
  return item;
}

test('Tome enhancement catalog reproducibly supplies four glyphs, fifteen words and sixteen exact diagrams', async () => {
  assert.equal(tome.length, 35);
  assert.equal(new Set(tome.map((item) => item._id)).size, 35);
  assert.equal(
    await fs.readFile(new URL('../../data/witcher/tome-enhancements.json', import.meta.url), 'utf8'),
    JSON.stringify(tome, null, 2) + '\n'
  );
  const diagrams = tome.filter((item) => item.type === 'diagram');
  assert.equal(diagrams.length, 16);
  for (const item of diagrams.filter((entry) => entry.flags[S].enhancementProcedure === 'word')) {
    const id = item.system.productUuid.split('.').at(-1);
    assert.ok(tome.some((product) => product._id === id));
    assert.equal(item.system.craftTime, '1 Hour');
    assert.equal(item.system.materials.length, item.system.craftDC === 15 ? 2 : 3);
    for (const row of item.system.materials) assert.equal(row.quantity, 1);
  }
  assert.equal(tome.find((item) => item.name === 'Runeword: Burning Diagram').system.cost, 2150);
  assert.equal(tome.find((item) => item.name === 'Runeword: Prolongation Diagram').system.investment, 1175);
  assert.equal(tome.find((item) => item.name === 'Enhancement Slot Diagram').system.productUuid, '');
  assert.equal(enhancementIdentity({ ...stone('Devanna'), name: 'Devana' }).key, 'devanna');
});

test('source-aware installation preserves stronger native and Master Crafting properties', () => {
  const sword = gear('weapon', {
    properties: { bleeding: 60, focus: 2 },
    damageTypes: ['slashing', 'bludgeoning'],
  });
  apply(sword, masterCraftUpdate(sword, 'stun', { id: 'master' }));
  apply(sword, installStonePlan(sword, stone('Devanna'), { id: 'bleed', stoneWeight: 'consumed' }).update);
  apply(sword, installStonePlan(sword, stone('Triglav'), { id: 'stun', stoneWeight: 'consumed' }).update);
  assert.equal(sword.system.properties.bleeding, 60);
  assert.equal(sword.system.properties.stun, -2);
  assert.equal(sword.system.properties.focus, 2);
  assert.equal(sword.system.reliability, 7);
  assert.equal(sword.system.weight, 2);
  apply(
    sword,
    rebuildEnhancementUpdate(
      sword,
      sword.system.attachments.filter((entry) => entry.category === 'mastercraft')
    )
  );
  assert.equal(sword.system.properties.bleeding, 60);
  assert.equal(sword.system.properties.stun, -2);
});

test('physical sets conserve portions and weight; removal preserves ablation and returns only actual parts', () => {
  const armor = gear(),
    set = stone('Chain Mail Enhancement');
  const plan = physicalSetPlan(set, [armor], { id: 'set', weights: { target: 1 } });
  assert.deepEqual(plan.remaining, { sections: ['head', 'rightArm', 'leftLeg', 'rightLeg'], weight: 2 });
  apply(armor, plan.updates[0]);
  assert.equal(armor.system.stoppingPower, 13);
  assert.deepEqual(armor.system.sp, { torso: 10, leftArm: 13 });
  armor.system.sp.torso -= 2;
  const removed = removePhysicalPlan(armor, 'set-0');
  apply(armor, removed.update);
  assert.deepEqual(armor.system.sp, { torso: 5, leftArm: 10 });
  assert.deepEqual(removed.returned.flags[S].enhancementParts, { sections: ['torso', 'leftArm'], weight: 1 });
  assert.equal(armor.system.weight, 2);
  assert.throws(
    () =>
      physicalSetPlan(set, [gear(), { ...gear(), id: 'duplicate' }], {
        id: 'bad',
        weights: { target: 1, duplicate: 1 },
      }),
    /overlapping/
  );
});

test('Runewright inscription computes actual improved properties and matching per-cast glyph options', () => {
  const weapon = gear('weapon');
  apply(
    weapon,
    installStonePlan(weapon, stone('Chemobog'), { id: 'r1', mode: 'runewright', stoneWeight: 'consumed' })
      .update
  );
  apply(
    weapon,
    installStonePlan(weapon, stone('Veles'), { id: 'r2', mode: 'runewright', stoneWeight: 'consumed' }).update
  );
  assert.equal(enhancementBenefits(weapon).chemobogThreshold, 3);
  assert.equal(weapon.system.properties.greaterFocus, true);
  assert.equal(weapon.system.properties.focus, 1);
  const armor = gear();
  apply(
    armor,
    installStonePlan(armor, stone('Glyph of Fire'), { id: 'g', mode: 'runewright', stoneWeight: 'consumed' })
      .update
  );
  assert.equal(
    elementalGlyphBonus([armor], 'fire', [{ itemId: 'target', attachmentId: 'g', mode: 'dc' }]).dc,
    4
  );
  assert.equal(
    elementalGlyphBonus([armor], 'fire', [{ itemId: 'target', attachmentId: 'g', mode: 'damage' }], {
      damaging: true,
    }).damageDice,
    1
  );
  assert.throws(
    () => elementalGlyphBonus([armor], 'mixed', [{ itemId: 'target', attachmentId: 'g', mode: 'dc' }]),
    /does not match/
  );
  assert.throws(
    () => elementalGlyphBonus([armor], 'fire', [{ itemId: 'target', attachmentId: 'g', mode: 'damage' }]),
    /non-damaging/
  );
  armor.system.equipped = false;
  assert.equal(actorEnhancementBenefits([armor]).glyphs.length, 0);
});

test('word composition reuses installed ingredients and destroys other stones without retaining their bonuses', () => {
  const sword = gear('weapon');
  for (const [id, name] of [
    ['c', 'Chemobog'],
    ['v', 'Veles'],
  ])
    apply(sword, installStonePlan(sword, stone(name), { id, stoneWeight: 'consumed' }).update);
  const plan = wordCraftPlan(sword, 'burning', [stone('Dazhbog')]);
  assert.equal(plan.installed[0].key, 'chemobog');
  assert.equal(plan.loose[0].name, 'Dazhbog');
  assert.equal(plan.destroyed[0].key, 'veles');
  const word = tome.find((entry) => entry.name === 'Runeword: Burning');
  apply(sword, rebuildEnhancementUpdate(sword, [...plan.retained, makeAttachment(word, { id: 'word' })]));
  assert.equal(sword.system.properties.greaterFocus, undefined);
  assert.deepEqual(enhancementBenefits(sword).words, ['burning']);
  assert.throws(
    () => installStonePlan(sword, stone('Perun'), { id: 'illegal', stoneWeight: 'consumed' }),
    /cannot receive/
  );
});

test('extra slots require full durability everywhere and cannot hold physical enhancements', () => {
  const armor = gear('armor', { enhancements: 0 });
  assert.throws(() => extraSlotUpdate(armor), /Every covered location/);
  armor.system.sp.torso = 10;
  apply(armor, extraSlotUpdate(armor));
  assert.equal(armor.system.enhancements, 1);
  assert.throws(
    () => physicalSetPlan(stone('Fiber Enhancement'), [armor], { id: 'x', weights: { target: 0.2 } }),
    /only hold/
  );
  apply(
    armor,
    installStonePlan(armor, stone('Glyph of Reinforcement'), { id: 'g', stoneWeight: 'consumed' }).update
  );
  assert.equal(armor.system.stoppingPower, 13);
  assert.equal(armor.system.sp.torso, 13);
});

test('legacy erased base values are never guessed during a mutation', () => {
  const sword = gear('weapon', {
    attachments: [{ id: 'old', name: 'Dazhbog', category: 'rune', system: stone('Dazhbog').system }],
  });
  assert.throws(
    () => installStonePlan(sword, stone('Perun'), { id: 'x', stoneWeight: 'consumed' }),
    /GM must reconcile/
  );
});

test('duplicate passive glyph table convention affects Binding/Mending but identical words never stack', () => {
  const left = gear(),
    right = gear();
  right.id = 'other';
  apply(
    left,
    installStonePlan(left, stone('Glyph of Mending'), { id: 'm1', stoneWeight: 'consumed' }).update
  );
  apply(
    left,
    installStonePlan(left, stone('Glyph of Mending'), {
      id: 'm2',
      mode: 'runewright',
      stoneWeight: 'consumed',
    }).update
  );
  apply(
    right,
    installStonePlan(right, stone('Glyph of Mending'), { id: 'm3', stoneWeight: 'consumed' }).update
  );
  assert.equal(actorEnhancementBenefits([left, right], { stacking: 'strongest' }).healingBonus, 2);
  assert.equal(actorEnhancementBenefits([left, right], { stacking: 'additive' }).healingBonus, 4);
  const word = tome.find((entry) => entry.name === 'Glyphword: Protection');
  left.system.attachments = [makeAttachment(word, { id: 'p1' })];
  right.system.attachments = [makeAttachment(word, { id: 'p2' })];
  assert.equal(actorEnhancementBenefits([left, right], { stacking: 'additive' }).hp, 5);
});
