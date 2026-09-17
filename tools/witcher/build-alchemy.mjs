/** Reproducible Tome alchemy source records. Quantities on p.116 were read
 * from the actual PDF glyphs against Core p.142, not inferred from OCR.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '../..');
export const TOME_ALCHEMY_PACK = 'tome-alchemy';
export const TOME_ALCHEMY_SOURCE = 'A Tome of Chaos v1.01';
export const TOME_PDF_SHA256 = '239d63bdf0e7bcd70f062fafb84b6b63dfa110aea62e3e28368a78a9c20a5c88';
export const tomeAlchemyId = (key) =>
  createHash('sha256').update(`witcher-rilerena:${TOME_ALCHEMY_PACK}:${key}`).digest('hex').slice(0, 16);
const itemUuid = (pack, id) => `Compendium.witcher-rilerena.${pack}.Item.${id}`;
const clone = (value) => structuredClone(value);
const scope = 'witcher-rilerena';
const e = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (s) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[s]
  );

export const TOME_ELIXIRS = Object.freeze([
  {
    key: 'anabolic-steroids',
    name: 'Anabolic Steroids',
    toxicity: 50,
    cost: 165,
    durationSeconds: 600,
    durationKind: 'timed',
    secondaryDurationSeconds: 3600,
    effect:
      'For 10 minutes, maximum HP increases by 10 and Endurance and Physique checks gain +2. The drinker is also extremely aggressive toward everyone for 1 hour.',
    dc: 16,
    craftTime: '1/2 Hour',
    craftSeconds: 1800,
    formulaCost: 330,
    glyphs: ['Rebis', 'Caelum', 'Quebrith', 'Hydragenum', 'Hydragenum'],
    formulaTable: 1,
    formulaRow: 1,
  },
  {
    key: 'last-hope',
    name: 'Last Hope',
    toxicity: 75,
    cost: 200,
    durationSeconds: 0,
    durationKind: 'until-doctor-reopens-and-treats',
    effect:
      'Treat one existing critical wound. That wound cannot heal until a Doctor succeeds at Healing Hands DC24 to reopen it, then treats it again with Healing Hands.',
    dc: 22,
    craftTime: '1 Hour',
    craftSeconds: 3600,
    formulaCost: 400,
    glyphs: ['Sol', 'Sol', 'Vitriol', 'Aether', 'Aether', 'Vermilion', 'Vermilion', 'Vermilion'],
    formulaTable: 2,
    formulaRow: 1,
  },
  {
    key: 'lightning',
    name: 'Lightning',
    toxicity: 75,
    cost: 75,
    durationSeconds: 0,
    durationKind: 'next-physical-attack',
    effect: 'Add 3 damage to the drinker’s next physical attack. The entry does not state a time limit.',
    dc: 16,
    craftTime: '15 Minutes',
    craftSeconds: 900,
    formulaCost: 150,
    glyphs: ['Vitriol', 'Vitriol', 'Vermilion', 'Vermilion', 'Hydragenum', 'Hydragenum'],
    formulaTable: 1,
    formulaRow: 2,
  },
  {
    key: 'mongoose',
    name: 'Mongoose',
    toxicity: 50,
    cost: 50,
    durationSeconds: 1800,
    durationKind: 'timed',
    effect: 'The drinker is immune to the poisoned condition for 30 minutes.',
    dc: 15,
    craftTime: '15 Minutes',
    craftSeconds: 900,
    formulaCost: 100,
    glyphs: ['Rebis', 'Rebis', 'Aether', 'Aether', 'Fulgur', 'Fulgur'],
    formulaTable: 1,
    formulaRow: 3,
  },
  {
    key: 'strider',
    name: 'Strider',
    toxicity: 50,
    cost: 64,
    durationSeconds: 86400,
    durationKind: 'timed',
    effect: 'The drinker does not need sleep for 24 hours.',
    dc: 16,
    craftTime: '15 Minutes',
    craftSeconds: 900,
    formulaCost: 128,
    glyphs: ['Rebis', 'Rebis', 'Aether', 'Fulgur', 'Caelum'],
    formulaTable: 1,
    formulaRow: 4,
  },
  {
    key: 'tempest',
    name: 'Tempest',
    toxicity: 50,
    cost: 52,
    durationSeconds: 0,
    durationKind: 'unspecified',
    effect:
      'Increase an existing chance to inflict Fire, Freeze or Prone with an attack or spell by 10 percentage points. The entry supplies no duration; record a table ruling before applying a timed effect.',
    dc: 15,
    craftTime: '15 Minutes',
    craftSeconds: 900,
    formulaCost: 104,
    glyphs: ['Vitriol', 'Aether', 'Quebrith', 'Caelum', 'Hydragenum'],
    formulaTable: 1,
    formulaRow: 5,
  },
]);

function flags(page, table, row, extra = {}) {
  return {
    [scope]: {
      sourceRow: { book: TOME_ALCHEMY_SOURCE, pdfPage: page + 1, table, row },
      ...extra,
    },
  };
}
function baseSystem(page) {
  return { quantity: 1, carried: true, equipped: false, source: TOME_ALCHEMY_SOURCE, page };
}
function elixirDocument(entry, index) {
  const general =
    'Elixirs can be consumed by non-witchers. Halflings gain no benefit but still suffer toxicity. Toxicity above 100% affects a non-witcher as it does a witcher (Tome p.115).';
  return {
    _id: tomeAlchemyId(`elixir:${entry.key}`),
    name: entry.name,
    type: 'alchemical',
    img: 'icons/svg/potion.svg',
    system: {
      ...baseSystem(116),
      category: 'elixir',
      consumable: true,
      availability: 'R',
      cost: entry.cost,
      weight: 0.1,
      toxicity: entry.toxicity,
      // Existing system Item.duration is in three-second rounds, not seconds.
      duration: entry.durationSeconds / 3,
      effectText: entry.effect,
      notes: general,
      description: `<p>${e(entry.effect)}</p><p>${e(general)}</p><p>Source: ${TOME_ALCHEMY_SOURCE}, pp.115–116. Toxicity: ${entry.toxicity}%.</p>`,
      properties: {},
      resistances: [],
    },
    flags: flags(116, 0, index + 1, {
      alchemy: {
        key: entry.key,
        kind: 'elixir',
        durationKind: entry.durationKind,
        durationSeconds: entry.durationSeconds,
        ...(entry.secondaryDurationSeconds
          ? { secondaryDurationSeconds: entry.secondaryDurationSeconds }
          : {}),
      },
      ...(entry.durationKind === 'unspecified' ? { durationUnspecified: true } : {}),
    }),
  };
}

/** Only pure-substance records qualify as generic substance identities. Named
 * botanical/monster ingredients keep their own identity when a recipe names them. */
function substanceReference(components, name) {
  const item = components.find((entry) => entry.name === name && entry.system.category === 'pureSubstance');
  if (!item || item.system.substance !== name) throw new Error(`Missing canonical pure substance: ${name}`);
  return itemUuid('components', item._id);
}
function namedReference(records, name, pack) {
  const matches = records.filter((entry) => entry.name === name);
  if (matches.length !== 1) throw new Error(`Expected one ${name} in ${pack}; got ${matches.length}.`);
  return itemUuid(pack, matches[0]._id);
}
function formulaDocument(entry, { components, equipment }) {
  const quantities = new Map();
  for (const substance of entry.glyphs) quantities.set(substance, (quantities.get(substance) ?? 0) + 1);
  const materials = [...quantities].map(([name, quantity]) => ({
    name,
    quantity,
    substance: name,
    uuid: substanceReference(components, name),
  }));
  // Tome p.116 explicitly requires this in addition to every graphical recipe.
  materials.push({
    name: 'Alcohest',
    quantity: 1,
    substance: '',
    uuid: namedReference(equipment, 'Alcohest', 'equipment'),
  });
  return {
    _id: tomeAlchemyId(`formula:${entry.key}`),
    name: `${entry.name} Formula`,
    type: 'diagram',
    img: 'icons/svg/book.svg',
    system: {
      ...baseSystem(116),
      skill: 'alchemy',
      craftDC: entry.dc,
      craftTime: entry.craftTime,
      // Both printed tables, including Last Hope DC22, are headed Journeyman.
      craftLevel: 'journeyman',
      cost: entry.formulaCost,
      weight: 0,
      investment: 0,
      productName: entry.name,
      productQuantity: 1,
      productUuid: itemUuid(TOME_ALCHEMY_PACK, tomeAlchemyId(`elixir:${entry.key}`)),
      materials,
      notes:
        'Requires an Alchemy Set. Each batch consumes one bottle of Alcohest in addition to the listed alchemical substances (Tome p.116).',
      description: `<p>Creates one dose of ${e(entry.name)}. Alchemy DC${entry.dc}; ${e(entry.craftTime)}.</p><p>${materials.map((row) => `${e(row.name)} ×${row.quantity}`).join('; ')}.</p><p>Source: ${TOME_ALCHEMY_SOURCE}, p.116. Graphical ingredients checked against the Core p.142 substance legend. Formula weight and investment are not printed.</p>`,
    },
    flags: flags(116, entry.formulaTable, entry.formulaRow, {
      alchemy: { key: entry.key, kind: 'formula', craftSeconds: entry.craftSeconds },
      weightUnspecified: true,
      investmentUnspecified: true,
      sourceSymbols: {
        verified: true,
        method: 'visual-pdf',
        page: 116,
        legend: 'Core v1.35 p.142',
        sequence: [...entry.glyphs],
        pdfSha256: TOME_PDF_SHA256,
      },
    }),
  };
}

export function penitentMutagenDocument() {
  return {
    _id: tomeAlchemyId('mutagen:penitent'),
    name: 'Penitent Mutagen',
    type: 'alchemical',
    img: 'icons/svg/blood.svg',
    system: {
      ...baseSystem(210),
      category: 'mutagen',
      consumable: true,
      cost: 0,
      weight: 0,
      craftDC: 18,
      bonuses: { vigor: 2 },
      effectText: '+2 Vigor Threshold.',
      notes:
        'Minor mutation: glowing white markings. Blue mutagen. Apply the actual mutagen preparation/consumption rules (Core p.251).',
      priceText: 'The source does not provide weight or market price.',
      description:
        '<p>Blue mutagen: +2 Vigor Threshold. Alchemy DC18. Minor mutation: glowing white markings.</p><p>Source: A Tome of Chaos v1.01, p.210. Weight and market price are not printed.</p>',
      properties: {},
      resistances: [],
    },
    flags: flags(210, 1, 2, {
      alchemy: { key: 'penitent', kind: 'mutagen' },
      mutagenColor: 'blue',
      weightUnspecified: true,
      priceUnspecified: true,
      sourceOmissions: ['weight', 'marketPrice'],
    }),
  };
}

export function cerebralElixirDocument() {
  const effect =
    'Protects against possession by a bes for 24 hours. Drinking it while possessed by a bes immediately forces that bes out. For a summoning, consume it at the beginning of the ritual.';
  return {
    _id: tomeAlchemyId('elixir:cerebral-elixir'),
    name: 'Cerebral Elixir',
    type: 'alchemical',
    img: 'icons/svg/potion.svg',
    system: {
      ...baseSystem(147),
      category: 'elixir',
      consumable: true,
      availability: 'R',
      weight: 0.1,
      cost: 0,
      toxicity: 0,
      duration: 28800,
      effectText: effect,
      notes:
        'The source does not print toxicity or market price. The numeric zero fields are schema placeholders, not a rule that the elixir is free or non-toxic. Possession protection applies specifically to a bes.',
      description: `<p>${e(effect)}</p><p>Source: ${TOME_ALCHEMY_SOURCE}, p.147. Toxicity and market price are not printed.</p>`,
      properties: {},
      resistances: [],
    },
    flags: flags(147, 0, 1, {
      alchemy: {
        key: 'cerebral-elixir',
        kind: 'elixir',
        durationSeconds: 86400,
        durationKind: 'timed',
        toxicityUnspecified: true,
      },
      toxicityUnspecified: true,
      priceUnspecified: true,
      sourceOmissions: ['toxicity', 'marketPrice'],
    }),
  };
}

/** A named ingredient is supplied as such; no alchemical substance, price or
 * weight is inferred for the otherwise unlisted feline brain. */
export function felineBrainDocument() {
  return {
    _id: tomeAlchemyId('component:feline-brain'),
    name: 'Feline Brain',
    type: 'component',
    img: 'icons/svg/item-bag.svg',
    system: {
      ...baseSystem(147),
      category: 'ingredient',
      weight: 0,
      cost: 0,
      substance: '',
      notes:
        'Named ingredient for Cerebral Elixir. The source does not provide a substance classification, weight or market price.',
      description: `<p>One feline brain, used as a named ingredient in the Cerebral Elixir formula (${TOME_ALCHEMY_SOURCE}, p.147).</p><p>Substance, weight and market price are not printed.</p>`,
    },
    flags: flags(147, 1, 1, {
      weightUnspecified: true,
      priceUnspecified: true,
      substanceUnspecified: true,
      sourceOmissions: ['weight', 'marketPrice', 'substance'],
    }),
  };
}

function cerebralFormulaDocument({ components, equipment, alchemy }) {
  const materials = [
    ['Alcohest', 3, equipment, 'equipment'],
    ['Feline Brain', 1, [felineBrainDocument()], TOME_ALCHEMY_PACK],
    ['Hallucinogen', 1, alchemy, 'alchemy'],
    ['Hellebore Petals', 3, components, 'components'],
    ['Mandrake Root', 5, components, 'components'],
    ['Crow’s Eye', 3, components, 'components'],
    ['Wolfsbane', 4, components, 'components'],
    ['Silver', 1, components, 'components'],
    ['Han Fiber', 4, components, 'components'],
  ].map(([name, quantity, records, pack]) => ({
    name,
    quantity,
    substance: '',
    uuid: namedReference(records, name, pack),
  }));
  return {
    _id: tomeAlchemyId('formula:cerebral-elixir'),
    name: 'Cerebral Elixir Formula',
    type: 'diagram',
    img: 'icons/svg/book.svg',
    system: {
      ...baseSystem(147),
      skill: 'alchemy',
      craftDC: 22,
      craftTime: '10 Hours',
      craftLevel: 'master',
      cost: 1332,
      investment: 666,
      weight: 0,
      productName: 'Cerebral Elixir',
      productQuantity: 1,
      productUuid: itemUuid(TOME_ALCHEMY_PACK, tomeAlchemyId('elixir:cerebral-elixir')),
      materials,
      notes:
        'Requires an Alchemy Set. These are named ingredients: matching only their alchemical substance does not replace them. The printed three bottles of Alcohest are the complete requirement.',
      description: `<p>Creates one Cerebral Elixir. Master Alchemy DC22; 10 hours.</p><p>${materials.map((row) => `${e(row.name)} ×${row.quantity}`).join('; ')}.</p><p>Source: ${TOME_ALCHEMY_SOURCE}, p.147. Investment: 666; formula price: 1332. Formula weight is not printed.</p>`,
    },
    flags: flags(147, 1, 1, {
      alchemy: { key: 'cerebral-elixir', kind: 'formula', craftSeconds: 36000 },
      weightUnspecified: true,
    }),
  };
}

export async function tomeAlchemyDocuments(root = ROOT) {
  const load = async (pack) =>
    JSON.parse(await readFile(path.join(root, 'data/witcher', `${pack}.json`), 'utf8'));
  const [components, equipment, alchemy] = await Promise.all([
    load('components'),
    load('equipment'),
    load('alchemy'),
  ]);
  return [
    ...TOME_ELIXIRS.map(elixirDocument),
    ...TOME_ELIXIRS.map((entry) => formulaDocument(entry, { components, equipment })),
    penitentMutagenDocument(),
    cerebralElixirDocument(),
    cerebralFormulaDocument({ components, equipment, alchemy }),
    felineBrainDocument(),
  ].map(clone);
}
export async function buildAlchemy(root = ROOT) {
  const entries = await tomeAlchemyDocuments(root),
    destination = path.join(root, 'data/witcher');
  await mkdir(destination, { recursive: true });
  await writeFile(
    path.join(destination, `${TOME_ALCHEMY_PACK}.json`),
    JSON.stringify(entries, null, 2) + '\n'
  );
  return entries;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  console.log(`${TOME_ALCHEMY_PACK}: ${(await buildAlchemy()).length} entries`);
