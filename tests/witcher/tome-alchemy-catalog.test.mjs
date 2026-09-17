import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { tomeAlchemyDocuments, tomeAlchemyId } from '../../tools/witcher/build-alchemy.mjs';
import { allocateMaterials } from '../../module/witcher/crafting.js';

const scope = 'witcher-rilerena';
const documents = await tomeAlchemyDocuments();
const byName = (name) => documents.find((item) => item.name === name);
// Independent transcription from the actual p.116 image, checked against Core142.
const source = [
  ['Anabolic Steroids', 50, 165, 16, '1/2 Hour', 330, { Rebis: 1, Caelum: 1, Quebrith: 1, Hydragenum: 2 }],
  ['Last Hope', 75, 200, 22, '1 Hour', 400, { Sol: 2, Vitriol: 1, Aether: 2, Vermilion: 3 }],
  ['Lightning', 75, 75, 16, '15 Minutes', 150, { Vitriol: 2, Vermilion: 2, Hydragenum: 2 }],
  ['Mongoose', 50, 50, 15, '15 Minutes', 100, { Rebis: 2, Aether: 2, Fulgur: 2 }],
  ['Strider', 50, 64, 16, '15 Minutes', 128, { Rebis: 2, Aether: 1, Fulgur: 1, Caelum: 1 }],
  [
    'Tempest',
    50,
    52,
    15,
    '15 Minutes',
    104,
    { Vitriol: 1, Aether: 1, Quebrith: 1, Caelum: 1, Hydragenum: 1 },
  ],
];

test('Tome alchemy pack is reproducible with distinct stable product and formula identities', async () => {
  assert.equal(documents.length, 16);
  assert.equal(new Set(documents.map((item) => item._id)).size, 16);
  for (const item of documents) assert.match(item._id, /^[a-f0-9]{16}$/);
  const stored = await fs.readFile(new URL('../../data/witcher/tome-alchemy.json', import.meta.url), 'utf8');
  assert.equal(stored, JSON.stringify(documents, null, 2) + '\n');
  assert.equal(byName('Last Hope')._id, tomeAlchemyId('elixir:last-hope'));
  assert.notEqual(byName('Last Hope')._id, byName('Last Hope Formula')._id);
});

test('p.116 graphical formulas preserve every glyph unit and the extra bottle of Alcohest', () => {
  for (const [name, toxicity, price, dc, time, formulaPrice, glyphs] of source) {
    const elixir = byName(name),
      formula = byName(`${name} Formula`);
    assert.equal(elixir.system.toxicity, toxicity, name);
    assert.equal(elixir.system.cost, price, name);
    assert.equal(elixir.system.weight, 0.1, name);
    assert.equal(formula.system.craftDC, dc, name);
    assert.equal(formula.system.craftTime, time, name);
    assert.equal(formula.system.craftLevel, 'journeyman', name);
    assert.equal(formula.system.cost, formulaPrice, name);
    assert.deepEqual(
      Object.fromEntries(formula.system.materials.map((row) => [row.name, row.quantity])),
      { ...glyphs, Alcohest: 1 },
      name
    );
    assert.deepEqual(
      formula.system.materials.filter((row) => row.substance).map((row) => row.name),
      Object.keys(glyphs),
      name
    );
    assert.equal(formula.flags[scope].sourceSymbols.verified, true);
    assert.equal(formula.flags[scope].sourceSymbols.method, 'visual-pdf');
    assert.equal(formula.flags[scope].sourceRow.pdfPage, 117);
  }
});

test('all product and material UUIDs resolve to actual pack items', async () => {
  const packs = { 'tome-alchemy': documents };
  for (const name of ['components', 'equipment', 'alchemy'])
    packs[name] = JSON.parse(
      await fs.readFile(new URL(`../../data/witcher/${name}.json`, import.meta.url), 'utf8')
    );
  const resolve = (uuid) => {
    const match = /^Compendium\.witcher-rilerena\.([^.]+)\.Item\.([^.]+)$/.exec(uuid);
    assert.ok(match, uuid);
    const item = packs[match[1]].find((entry) => entry._id === match[2]);
    assert.ok(item, uuid);
    return item;
  };
  for (const formula of documents.filter((item) => item.type === 'diagram')) {
    assert.equal(resolve(formula.system.productUuid).name, formula.system.productName);
    for (const row of formula.system.materials) {
      const material = resolve(row.uuid);
      assert.equal(material.name, row.name);
      if (row.substance) assert.equal(material.system.category, 'pureSubstance');
    }
  }
});

test('named Cerebral ingredients cannot be replaced by an arbitrary same-substance ingredient', () => {
  const formula = byName('Cerebral Elixir Formula').system;
  assert.equal(formula.craftDC, 22);
  assert.equal(formula.craftLevel, 'master');
  assert.equal(formula.craftTime, '10 Hours');
  assert.equal(formula.investment, 666);
  assert.equal(formula.cost, 1332);
  assert.deepEqual(
    formula.materials.map((row) => [row.name, row.quantity]),
    [
      ['Alcohest', 3],
      ['Feline Brain', 1],
      ['Hallucinogen', 1],
      ['Hellebore Petals', 3],
      ['Mandrake Root', 5],
      ['Crow’s Eye', 3],
      ['Wolfsbane', 4],
      ['Silver', 1],
      ['Han Fiber', 4],
    ]
  );
  assert.ok(formula.materials.every((row) => row.substance === ''));
  const stock = formula.materials.map((row, i) => ({
    id: String(i),
    name: row.name,
    sourceUuid: row.uuid,
    quantity: row.quantity,
    carried: true,
  }));
  assert.equal(allocateMaterials(formula.materials, stock).length, 9);
  const wrongStock = stock.map((item) =>
    item.name === 'Hellebore Petals'
      ? { ...item, name: 'Arbitrary Aether', sourceUuid: '', substance: 'Aether' }
      : item
  );
  assert.throws(() => allocateMaterials(formula.materials, wrongStock), /Hellebore Petals/);
});

test('timed doses use three-second rounds while missing lifetime and toxicity remain explicit', () => {
  for (const [name, rounds] of [
    ['Anabolic Steroids', 200],
    ['Mongoose', 600],
    ['Strider', 28800],
    ['Cerebral Elixir', 28800],
  ])
    assert.equal(byName(name).system.duration, rounds);
  assert.equal(byName('Anabolic Steroids').flags[scope].alchemy.secondaryDurationSeconds, 3600);
  assert.equal(byName('Tempest').flags[scope].durationUnspecified, true);
  assert.equal(byName('Lightning').flags[scope].alchemy.durationKind, 'next-physical-attack');
  assert.equal(byName('Last Hope').flags[scope].alchemy.durationKind, 'until-doctor-reopens-and-treats');
  assert.equal(byName('Cerebral Elixir').flags[scope].toxicityUnspecified, true);
  assert.equal(byName('Cerebral Elixir').flags[scope].alchemy.toxicityUnspecified, true);
  assert.equal(byName('Cerebral Elixir').flags[scope].priceUnspecified, true);
  assert.match(byName('Cerebral Elixir').system.effectText, /bes/);
  assert.equal(byName('Feline Brain').flags[scope].substanceUnspecified, true);
});

test('Penitent mutagen uses the printed blue +2 Vigor/DC18 row', () => {
  const item = byName('Penitent Mutagen');
  assert.equal(item.system.page, 210);
  assert.equal(item.system.craftDC, 18);
  assert.deepEqual(item.system.bonuses, { vigor: 2 });
  assert.equal(item.flags[scope].mutagenColor, 'blue');
  assert.match(item.system.notes, /glowing white markings/);
  assert.equal(item.flags[scope].weightUnspecified, true);
  assert.equal(item.flags[scope].priceUnspecified, true);
});
