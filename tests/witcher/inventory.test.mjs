import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  handsUsed,
  availableHands,
  validateWeaponGrip,
  validateReload,
  planInventoryChange,
  focusUse,
} from '../../module/witcher/inventory.js';

const oneHand = {
  id: 'sword',
  type: 'weapon',
  name: 'Sword',
  hands: 1,
  handsUsed: 0,
  equipped: true,
  carried: true,
  quantity: 1,
  properties: {},
};
const twoHand = { ...oneHand, id: 'greatSword', hands: 2 };
const shield = { ...oneHand, id: 'shield', type: 'shield' };
const injury = (location, treatment = 'untreated') => ({
  type: 'wound',
  wound: {
    location,
    treatment,
    modifiers: { armDisabled: 1 },
    stabilizedModifiers: { armDisabled: 1 },
    treatedModifiers: { armDisabled: 1 },
  },
});

test('printed grip remains the default; a two-handed weapon can use one hand at -3 (p.72)', () => {
  assert.equal(handsUsed(twoHand), 2);
  const grip = { ...twoHand, handsUsed: 1 };
  assert.deepEqual(validateWeaponGrip({}, grip, [grip, shield]), {
    hands: 1,
    totalHands: 2,
    availableHands: 2,
    modifier: -3,
  });
  assert.throws(() => validateWeaponGrip({}, twoHand, [twoHand, shield]), /require 3 hands/);
  assert.equal(validateWeaponGrip({}, twoHand, [twoHand]).modifier, 0);
});

test('a weapon stack occupies one grip, not one grip per copy', () => {
  const knives = { ...oneHand, quantity: 10 };
  assert.equal(validateWeaponGrip({}, knives, [knives, shield]).totalHands, 2);
});

test('ordinary focus accessories can be worn or held; taking a worn focus in hand needs a free hand and a draw action', () => {
  const amulet = { ...oneHand, id: 'amulet', type: 'gear', focusUse: 'worn', properties: { focus: 3 } };
  assert.equal(handsUsed(amulet), 0);
  assert.throws(() => planInventoryChange({}, amulet.id, { focusUse: 'held' }, [amulet, twoHand]), /3 hands/);
  const ready = planInventoryChange({}, amulet.id, { focusUse: 'held' }, [amulet, oneHand]);
  assert.equal(ready.drawsWeapon, true);
  assert.equal(handsUsed(ready.item), 1);
  assert.equal(
    planInventoryChange({}, amulet.id, { focusUse: 'worn' }, [ready.item, oneHand]).drawsWeapon,
    false
  );
  assert.throws(() => planInventoryChange({}, oneHand.id, { focusUse: 'worn' }, [oneHand]), /accessory/);
  assert.throws(
    () => planInventoryChange({}, amulet.id, { focusUse: 'invisible' }, [amulet]),
    /held or worn/
  );
});

test('old enchanted amulet records infer worn usage while ordinary old focuses remain held', () => {
  const ordinary = { ...oneHand, type: 'gear', properties: { focus: 2 } };
  const enchanted = {
    ...ordinary,
    flags: { 'witcher-rilerena': { ritualArtifact: { key: 'enchant-amulet' } } },
  };
  assert.equal(focusUse(ordinary), 'held');
  assert.equal(focusUse(enchanted), 'worn');
  assert.equal(handsUsed(enchanted), 0);
  assert.equal(
    planInventoryChange({}, enchanted.id, { equipped: true }, [enchanted, twoHand]).drawsWeapon,
    false
  );
});

test('disabled hands are counted by limb rather than by number of critical wounds', () => {
  assert.equal(availableHands({}, [injury('leftArm'), injury('leftArm', 'treated')]), 1);
  assert.equal(availableHands({}, [injury('leftArm'), injury('rightArm')]), 0);
  assert.equal(availableHands({}, [injury('leftArm', 'stabilized')]), 1);
  assert.throws(() => validateWeaponGrip({}, twoHand, [twoHand, injury('leftArm')]), /1 usable hands/);
  const adapted = { ...twoHand, handsUsed: 1 };
  assert.equal(validateWeaponGrip({}, adapted, [adapted, injury('leftArm')]).modifier, -3);
});

test('custom anatomy limits manufactured weapon grips while natural attacks consume no hands', () => {
  const actor = {
    anatomy: 'custom',
    locations: [
      { id: 'onlyArm', group: 'arm' },
      { id: 'tail', group: 'tail' },
    ],
  };
  assert.equal(availableHands(actor), 1);
  assert.throws(() => validateWeaponGrip(actor, twoHand, [twoHand]), /1 usable hands/);
  const claws = { ...oneHand, id: 'claws', properties: { natural: true } };
  assert.equal(handsUsed(claws), 0);
  assert.equal(validateWeaponGrip({}, claws, [claws, injury('leftArm'), injury('rightArm')]).modifier, 0);
});

test('a natural weapon is excluded from the grip sum beside readied weapons', () => {
  const claws = { ...oneHand, id: 'claws', properties: { natural: true } };
  assert.equal(validateWeaponGrip({}, twoHand, [twoHand, claws]).totalHands, 2);
});

test('equipping from a compendium copy requires an available grip and is recognized as a draw action', () => {
  const source = { ...oneHand, equipped: false };
  const result = planInventoryChange({}, source.id, { equipped: true }, [source, shield]);
  assert.equal(result.drawsWeapon, true);
  assert.deepEqual(result.update, { _id: 'sword', 'system.equipped': true });
  assert.equal(source.equipped, false);
  assert.throws(
    () => planInventoryChange({}, twoHand.id, { equipped: true }, [{ ...twoHand, equipped: false }, shield]),
    /require 3 hands/
  );
});

test('equipping a two-handed weapon in one hand can be requested as a single validated change', () => {
  const source = { ...twoHand, equipped: false };
  const result = planInventoryChange({}, source.id, { equipped: true, handsUsed: 1 }, [source, shield]);
  assert.equal(result.drawsWeapon, true);
  assert.equal(result.update['system.handsUsed'], 1);
  assert.equal(validateWeaponGrip({}, result.item, [result.item, shield]).modifier, -3);
});

test('quantity zero or removing an item from carried inventory unequips it atomically', () => {
  const empty = planInventoryChange({}, oneHand.id, { quantity: 0 }, [oneHand]);
  assert.deepEqual(empty.update, { _id: 'sword', 'system.quantity': 0, 'system.equipped': false });
  const dropped = planInventoryChange({}, oneHand.id, { carried: false }, [oneHand]);
  assert.equal(dropped.update['system.equipped'], false);
  assert.equal(dropped.update['system.carried'], false);
  assert.equal(dropped.drawsWeapon, false);
});

test('empty, missing, fractional or non-carried weapons cannot be equipped or attacked', () => {
  for (const change of [{ quantity: 0 }, { quantity: 0.5 }, { carried: false }, { equipped: false }]) {
    const item = { ...oneHand, ...change };
    assert.throws(() => validateWeaponGrip({}, item, [item]), /Carry and equip/);
  }
  assert.throws(() => planInventoryChange({}, 'missing', { equipped: true }, [oneHand]), /no longer/);
  assert.throws(
    () => planInventoryChange({}, oneHand.id, { equipped: true }, [{ ...oneHand, quantity: 0 }]),
    /empty item/
  );
});

test('invalid item edits cannot bypass quantity, grip or type validation', () => {
  for (const patch of [
    { quantity: -1 },
    { quantity: Infinity },
    { handsUsed: 3 },
    { handsUsed: 0.5 },
    { equipped: 'false' },
    { damage: '100d6' },
  ])
    assert.throws(() => planInventoryChange({}, oneHand.id, patch, [oneHand]));
  assert.throws(() => planInventoryChange({}, shield.id, { handsUsed: 2 }, [shield]));
});

test('an injury must never prevent unequipping the weapon that now exceeds available hands', () => {
  const result = planInventoryChange({}, twoHand.id, { equipped: false }, [twoHand, injury('leftArm')]);
  assert.equal(result.update['system.equipped'], false);
  assert.equal(result.drawsWeapon, false);
});

test('armor equip validates overlapping layers before writing inventory', () => {
  const armor = {
    id: 'a',
    name: 'Armor',
    type: 'armor',
    equipped: true,
    carried: true,
    quantity: 1,
    armorClass: 'heavy',
    coverage: ['torso'],
    stoppingPower: 20,
    ev: 3,
  };
  const duplicate = { ...armor, id: 'b', equipped: false };
  assert.throws(
    () => planInventoryChange({}, duplicate.id, { equipped: true }, [armor, duplicate]),
    /one medium and one heavy/
  );
  assert.equal(planInventoryChange({}, armor.id, { equipped: false }, [armor]).item.equipped, false);
});

const ammo = { id: 'bolts', type: 'weapon', carried: true, quantity: 10, isAmmo: true };
const crossbow = { ...oneHand, category: 'crossbow', reliability: 5, loaded: false, ammoId: ammo.id };
test('p.72 even a hand crossbow needs both usable hands to reload', () => {
  assert.equal(validateReload({}, crossbow, [crossbow, ammo]), true);
  assert.throws(() => validateReload({}, crossbow, [crossbow, ammo, shield]), /two usable hands/);
  assert.throws(() => validateReload({}, crossbow, [crossbow, ammo, injury('rightArm')]), /two usable hands/);
  const two = { ...crossbow, hands: 2 };
  assert.equal(validateReload({}, two, [two, ammo]), true);
});

test('reload requires carried ammunition, an unloaded and usable crossbow', () => {
  for (const change of [{ loaded: true }, { jammed: true }, { reliability: 0 }, { ammoId: 'missing' }]) {
    const weapon = { ...crossbow, ...change };
    assert.throws(() => validateReload({}, weapon, [weapon, ammo]));
  }
  for (const change of [{ carried: false }, { quantity: 0 }, { isAmmo: false }])
    assert.throws(() => validateReload({}, crossbow, [crossbow, { ...ammo, ...change }]));
  assert.equal(ammo.quantity, 10, 'Loading validates stock; firing owns ammunition consumption.');
});

test('Tools weapons and Manticore Shield can be equipped from their actual compendium records', () => {
  const records = JSON.parse(
    readFileSync(new URL('../../data/witcher/supplement-tools.json', import.meta.url))
  );
  for (const record of records.filter((entry) => ['weapon', 'shield'].includes(entry.type))) {
    const result = planInventoryChange({}, record._id, { equipped: true }, [record]);
    assert.equal(result.drawsWeapon, true, record.name);
    assert.equal(result.item.equipped, true);
    assert.equal(handsUsed(result.item), 1);
  }
});
