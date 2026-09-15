import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { allocateMaterials } from '../../module/witcher/crafting.js';

const read = async (name) =>
  JSON.parse(await fs.readFile(new URL(`../../data/witcher/${name}.json`, import.meta.url), 'utf8'));
const tools = await read('supplement-tools');
const journal = await read('supplement-journal');
const audit = await read('supplement-source-audit');
const all = [...tools, ...journal];
const item = (name) => {
  const result = all.find((entry) => entry.name === name);
  assert.ok(result, `Missing supplement item: ${name}`);
  return result;
};
const data = (name) => item(name).system;
const flags = (name) => item(name).flags['witcher-rilerena'];

test('supplements cover all published equipment rows with distinct IDs and source citations', () => {
  assert.deepEqual(audit.counts, { 'supplement-tools': 46, 'supplement-journal': 90 });
  assert.equal(tools.filter((entry) => entry.type === 'weapon').length, 16);
  assert.equal(tools.filter((entry) => entry.type === 'shield').length, 1);
  assert.equal(tools.filter((entry) => entry.type === 'armor').length, 6);
  assert.equal(tools.filter((entry) => entry.type === 'diagram').length, 23);
  assert.equal(journal.filter((entry) => entry.type === 'component').length, 73);
  assert.equal(journal.filter((entry) => entry.type === 'alchemical').length, 17);
  assert.equal(new Set(all.map((entry) => entry._id)).size, 136);
  assert.equal(audit.rows.length, 136);
  for (const record of all) {
    assert.match(record._id, /^[a-f0-9]{16}$/);
    const source = record.flags['witcher-rilerena'].sourceRow;
    assert.ok(audit.rows.some((row) => row.id === record._id && row.cells.length >= 4));
    assert.equal(record.system.source, source.book);
    assert.equal(record.system.page, source.pdfPage - (source.book.endsWith('Journal') ? 1 : 0));
    assert.equal(record.system.quantity, 1);
    assert.equal(record.system.equipped, false);
  }
});

test('Tools pp.3–5: every school weapon preserves its different attack profile', () => {
  const expected = [
    // name, WA, damage, Rel, hands, range, EN, weight
    ['Ursine Steel Sword', 0, '6d6+2', 15, 1, 0, 2, 2.5],
    ['Ursine Silver Sword', 0, '3d6+2', 10, 1, 0, 2, 1.5],
    ['Ursine Crossbow', 1, '4d6+2', 5, 1, 50, 1, 0.5],
    ['Feline Steel Sword', 2, '4d6+2', 15, 1, 0, 2, 2.5],
    ['Feline Silver Sword', 2, '1d6+2', 10, 1, 0, 2, 1.5],
    ['Feline Crossbow', 1, '2d6+2', 5, 1, 50, 1, 0.5],
    ['Griffin Steel Sword', 1, '5d6+2', 15, 1, 0, 2, 2.5],
    ['Griffin Silver Sword', 1, '2d6+2', 10, 1, 0, 2, 1.5],
    ['Griffin Crossbow', 1, '2d6+2', 5, 1, 50, 1, 0.5],
    ['Manticore Steel Sword', 1, '5d6+2', 15, 1, 0, 2, 2.5],
    ['Manticore Silver Sword', 1, '2d6+2', 10, 1, 0, 2, 1.5],
    ['Manticore Shield', 0, '@shieldDamage', 20, 1, 0, 1, 2],
    ['Serpentine Steel Sword', 2, '4d6+2', 15, 1, 0, 2, 2.5],
    ['Serpentine Silver Sword', 2, '1d6+2', 10, 1, 0, 2, 1.5],
    ['Viper’s Fang', 1, '2d6+2', 10, 1, 0, 1, 0.5],
    ['Wolven Steel Sword', 1, '5d6+2', 15, 1, 0, 3, 2.5],
    ['Wolven Silver Sword', 1, '2d6+2', 10, 1, 0, 3, 1.5],
  ];
  for (const [name, ...profile] of expected) {
    const s = data(name);
    assert.deepEqual(
      [s.accuracy, s.damage, s.reliability, s.hands, s.range, s.enhancements, s.weight],
      profile,
      name
    );
    assert.equal(s.maxReliability, s.reliability);
    assert.equal(s.witcherWeapon, true);
    assert.ok(s.school);
    if (name.includes('Crossbow')) {
      assert.equal(s.skill, 'crossbow');
      assert.equal(s.stat, 'dex');
      assert.equal(s.properties.slowReload, true);
    }
  }
  assert.equal(data('Viper’s Fang').skill, 'smallBlades');
  assert.equal(data('Viper’s Fang').properties.parrying, true);
  assert.equal(data('Manticore Shield').armorClass, 'medium');
  assert.equal(data('Manticore Shield').ev, 0);
  assert.equal(data('Manticore Shield').properties.silverDamage, '3d6');
  assert.equal(data('Manticore Shield').properties.meteorite, true);
  for (const name of ['Feline Steel Sword', 'Feline Silver Sword'])
    assert.equal(data(name).properties.bleeding, 30);
  for (const name of ['Serpentine Steel Sword', 'Serpentine Silver Sword'])
    assert.equal(data(name).properties.poison, 30);
  assert.equal(data('Griffin Crossbow').properties.improvedArmorPiercing, true);
  assert.equal(data('Griffin Silver Sword').properties.focus, 1);
  assert.equal(data('Ursine Silver Sword').properties.ablating, true);
  assert.equal(data('Wolven Steel Sword').properties.improvedArmorPiercing, true);
  assert.equal(data('Wolven Silver Sword').properties.armorPiercing, true);
  assert.equal(data('Manticore Silver Sword').properties.balanced, true);
});

test('Tools armor covers five locations with the published SP, EV and distinct critical perks', () => {
  const expected = [
    ['Ursine Armor', 'heavy', 20, 3, 24, 'criticalDecimation'],
    ['Feline Armor', 'light', 6, 0, 3, 'criticalFlurry'],
    ['Griffin Armor', 'medium', 16, 1, 18, 'criticalSpellcasting'],
    ['Manticore Armor', 'medium', 12, 1, 10, 'criticalBlock'],
    ['Serpentine Armor', 'light', 8, 0, 5, 'criticalRiposte'],
    ['Wolven Armor', 'medium', 14, 1, 14, 'criticalMomentum'],
  ];
  for (const [name, ...profile] of expected) {
    const s = data(name);
    assert.deepEqual([s.armorClass, s.stoppingPower, s.ev, s.weight, s.ability.key], profile, name);
    assert.equal(s.enhancements, 2);
    assert.deepEqual(s.coverage, ['torso', 'rightArm', 'leftArm', 'rightLeg', 'leftLeg']);
    assert.deepEqual(Object.values(s.sp), Array(5).fill(s.stoppingPower));
    assert.equal(s.ability.mode, 'equipment');
    assert.match(s.effectText, /Critical /);
  }
});

test('all school diagrams resolve products and ingredients, except two explicitly unpriced source omissions', async () => {
  const index = new Map();
  for (const pack of ['components', 'supplement-tools', 'supplement-journal'])
    for (const entry of await read(pack))
      index.set(`Compendium.witcher-rilerena.${pack}.Item.${entry._id}`, entry);
  const unresolved = [];
  for (const recipe of tools.filter((entry) => entry.type === 'diagram')) {
    const s = recipe.system;
    assert.equal(s.craftLevel, 'master');
    assert.equal(s.availability, 'R');
    assert.equal(s.productQuantity, 1);
    assert.equal(index.get(s.productUuid)?.name, s.productName);
    assert.equal(index.get(s.productUuid)?.system.school, s.school);
    assert.ok(s.materials.length >= 5);
    assert.ok(s.investment > 0);
    for (const material of s.materials) {
      assert.ok(Number.isInteger(material.quantity) && material.quantity > 0);
      if (material.uuid) assert.equal(index.get(material.uuid)?.type, 'component', material.name);
      else unresolved.push({ diagram: recipe.name, material: material.name });
    }
  }
  assert.deepEqual(unresolved, [
    { diagram: 'Feline Silver Sword Diagram', material: 'Ruby Dust' },
    { diagram: 'Serpentine Silver Sword Diagram', material: 'Emerald Dust' },
  ]);
  assert.deepEqual(audit.unresolved, unresolved);
  assert.equal(data('Serpentine Armor Diagram').materials.find((m) => m.name === 'Linen').quantity, 4);
  assert.equal(
    data('Griffin Silver Sword Diagram').materials.find((m) => m.name === 'Etching Acid').quantity,
    2
  );
});

test('Tools Ursine Armor retains both printed Dark Steel rows and consumes four units', () => {
  const steel = data('Ursine Armor Diagram').materials.filter((m) => m.name === 'Dark Steel');
  assert.deepEqual(
    steel.map((m) => m.quantity),
    [2, 2]
  );
  const stock = [{ id: 'steel', name: 'Dark Steel', quantity: 4, carried: true }];
  assert.equal(allocateMaterials(steel, stock)[0].after, 0);
  assert.throws(() => allocateMaterials(steel, [{ ...stock[0], quantity: 3 }]), /Missing 1 unit/);
});

test('Journal components preserve actual substance, mass, cost and processing/foraging rules', async () => {
  const expected = [
    ['Abomination Lymph', 'Quebrith', 0.1, 152],
    ['Archespore Tendrils', 'Quebrith', 0.5, 44],
    ['Bear Fat', 'Rebis', 0.5, 90],
    ['Bullvore Brain', 'Fulgur', 1, 150],
    ['Cockatrice Carapace', 'Hydragenum', 2, 75],
    ['Crystallized Essence', 'Hydragenum', 0.1, 292],
    ['Dragon Tail', 'Hydragenum', 4, 310],
    ['Frightener Claws', 'Fulgur', 5, 205],
    ['Knocker Hair', 'Quebrith', 0.1, 33],
    ['Naezan Salts', 'Aether', 0.1, 146],
    ['Slyzard Scales', 'Fulgur', 3, 82],
    ['Vendigo Heart', 'Aether', 1, 167],
  ];
  for (const [name, ...profile] of expected) {
    const s = data(name);
    assert.deepEqual([s.substance, s.weight, s.cost], profile, name);
    assert.equal(s.substanceUnits, 1);
  }
  for (const name of ['Bear Hide', 'Boar Pelt', 'Panther Hide'])
    assert.equal(flags(name).leatherSource, true);
  assert.equal(data('Burdok Root').forageDC, 16);
  assert.equal(data('Burdok Root').forageQuantity, '1d6');
  assert.equal(data('Burdok Root').availability, 'P');
  const essence = data('Crystallized Essence');
  assert.equal(essence.ability.key, 'crushEssence');
  assert.equal(essence.craftDC, 10);
  assert.equal(essence.craftTime, '15 Minutes');
  assert.equal(essence.productQuantity, 2);
  const dust = (await read('components')).find((entry) => entry.name === 'Infused Dust');
  assert.equal(essence.productUuid, `Compendium.witcher-rilerena.components.Item.${dust._id}`);
  assert.deepEqual(
    essence.materials.map((m) => [m.name, m.quantity]),
    [['Crystallized Essence', 1]]
  );
});

test('all 17 Journal mutagens have explicit permanent modifiers, DCs and their visible mutations', () => {
  const expected = [
    ['Botchling', 'meleeBonus', 2, 18],
    ['Cockatrice', 'meleeBonus', 2, 18],
    ['Manticore', 'ref', 1, 22],
    ['Phoenix', 'meleeBonus', 3, 20],
    ['Vendigo', 'meleeBonus', 3, 20],
    ['Bear', 'hp', 10, 20],
    ['Bullvore', 'hp', 10, 20],
    ['Frightener', 'body', 1, 22],
    ['Garkain', 'hp', 10, 20],
    ['Shaelmaar', 'hp', 10, 20],
    ['Succubus', 'hp', 5, 18],
    ['Troll', 'hp', 5, 18],
    ['Bruxa', 'will', 1, 22],
    ['Elemental', 'vigor', 3, 20],
    ['Foglet', 'vigor', 2, 18],
    ['Leshen', 'will', 1, 22],
    ['Pesta', 'vigor', 2, 18],
  ];
  for (const [source, field, value, dc] of expected) {
    const name = `${source} Mutagen`,
      s = data(name);
    assert.equal(s.category, 'mutagen');
    assert.equal(s.consumable, true);
    assert.deepEqual(s.bonuses, { [field]: value });
    assert.equal(s.craftDC, dc);
    assert.ok(s.notes.length > 10);
    assert.deepEqual(flags(name).sourceOmissions, ['weight', 'marketPrice']);
  }
  assert.match(data('Elemental Mutagen').notes, /Earth:.*Fire:.*Ice:/);
  assert.equal(
    data('Troll Mutagen').bonuses.hp,
    5,
    'Journal Troll is not the Core Rock Troll +10 HP mutagen'
  );
});
