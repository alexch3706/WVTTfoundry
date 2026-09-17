import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  TOME_GLYPHS,
  ENCHANTMENT_WORDS,
  enhancementIdentity,
} from '../../module/witcher/enhancement-catalog.js';

const ROOT = path.resolve(import.meta.dirname, '../..');
export const ENHANCEMENT_PACK = 'tome-enhancements';
export const enhancementId = (key) =>
  createHash('sha256').update(`witcher-rilerena:${ENHANCEMENT_PACK}:${key}`).digest('hex').slice(0, 16);
const uuid = (pack, id) => `Compendium.witcher-rilerena.${pack}.Item.${id}`;
const source = 'A Tome of Chaos v1.01';
const scope = 'witcher-rilerena';
const base = (page) => ({ source, page, quantity: 1, carried: true, equipped: false, cost: 0, weight: 0 });
const flags = (key, category, page, extra = {}) => ({
  [scope]: {
    enhancement: { key, category },
    sourceRow: { book: source, pdfPage: page + 1 },
    weightUnspecified: true,
    ...extra,
  },
});
const title = (key) => key[0].toUpperCase() + key.slice(1);

export async function enhancementDocuments(root = ROOT) {
  const core = JSON.parse(await readFile(path.join(root, 'data/witcher/witcher-gear.json'), 'utf8'));
  const components = JSON.parse(await readFile(path.join(root, 'data/witcher/components.json'), 'utf8'));
  const glyphs = TOME_GLYPHS.map((entry) => ({
    _id: enhancementId(`glyph:${entry.key}`),
    name: entry.name,
    type: 'enhancement',
    img: 'icons/svg/upgrade.svg',
    system: {
      ...base(110),
      category: 'glyph',
      cost: entry.cost,
      effectText: entry.effect,
      properties: {},
      resistances: [],
      notes:
        'Weight is not printed. Ordinary inscription uses Crafting Tools; improved inscription uses Runewright’s Tools and takes 30 minutes (Tome p.120).',
      description: `<p>${entry.effect}</p><p>${source}, pp.110,120. Weight is not printed.</p>`,
    },
    flags: flags(entry.key, 'glyph', 110),
  }));
  const stone = (key, category) => {
    const local = glyphs.find((entry) => enhancementIdentity(entry)?.key === key);
    if (local && category === 'glyph')
      return { name: local.name, uuid: uuid(ENHANCEMENT_PACK, local._id), quantity: 1, substance: '' };
    const item = core.find((entry) => {
      const identity = enhancementIdentity(entry);
      return identity?.key === key && identity.category === category;
    });
    if (!item) throw new Error(`Missing ${category}: ${key}`);
    return { name: item.name, uuid: uuid('witcher-gear', item._id), quantity: 1, substance: '' };
  };
  const words = ENCHANTMENT_WORDS.map((entry) => ({
    _id: enhancementId(`word:${entry.key}`),
    name: `${entry.category === 'runeword' ? 'Runeword' : 'Glyphword'}: ${title(entry.key)}`,
    type: 'enhancement',
    img: 'icons/svg/upgrade.svg',
    system: {
      ...base(entry.page),
      category: entry.category,
      effectText: entry.effect,
      properties: {},
      resistances: [],
      description: `<p>${entry.effect}</p><p>Requires ${entry.slots} slots. The word replaces its component stones, blocks other runes/glyphs, and its benefit does not stack with the same word on another item. Must be etched with its diagram and Runewright’s Tools.</p><p>${source}, pp.${entry.page},${entry.recipePage}. Finished-word price and weight are not printed.</p>`,
      notes:
        'Installed enchantment record; not a consumable loose stone. Use the enchantment diagram to craft it onto equipment.',
    },
    flags: flags(entry.key, entry.category, entry.page, {
      priceUnspecified: true,
      enchantmentRecipeRequired: true,
    }),
  }));
  const diagrams = ENCHANTMENT_WORDS.map((entry) => ({
    _id: enhancementId(`diagram:${entry.key}`),
    name: `${entry.category === 'runeword' ? 'Runeword' : 'Glyphword'}: ${title(entry.key)} Diagram`,
    type: 'diagram',
    img: 'icons/svg/book.svg',
    system: {
      ...base(entry.recipePage),
      skill: 'crafting',
      craftDC: entry.slots === 2 ? 15 : 21,
      craftLevel: entry.slots === 2 ? 'journeyman' : 'master',
      craftTime: '1 Hour',
      investment: entry.investment,
      cost: entry.cost,
      productName: words.find((word) => word.flags[scope].enhancement.key === entry.key).name,
      productQuantity: 1,
      productUuid: uuid(ENHANCEMENT_PACK, enhancementId(`word:${entry.key}`)),
      materials: entry.components.map((key) => stone(key, entry.category === 'runeword' ? 'rune' : 'glyph')),
      notes:
        'Requires Runewright’s Tools and eligible equipment. Installed required stones may contribute. On failure, one immediate check at the same DC can recover one chosen rune/glyph; all others are lost. Use the dedicated enchantment workflow.',
      description: `<p>${entry.effect}</p><p>${source}, pp.${entry.recipePage}. One hour; ${entry.slots} slots. The result is etched onto existing equipment, not created as a loose stone.</p>`,
    },
    flags: flags(entry.key, 'word-diagram', entry.recipePage, { enhancementProcedure: 'word' }),
  }));
  const materials = [
    ['Meteorite', 4],
    ['Infused Dust', 2],
  ].map(([name, quantity]) => {
    const item = components.find((entry) => entry.name === name);
    if (!item) throw new Error(`Missing slot component: ${name}`);
    return { name, quantity, uuid: uuid('components', item._id), substance: '' };
  });
  const slot = {
    _id: enhancementId('diagram:extra-slot'),
    name: 'Enhancement Slot Diagram',
    type: 'diagram',
    img: 'icons/svg/book.svg',
    system: {
      ...base(114),
      skill: 'crafting',
      craftDC: 25,
      craftLevel: 'master',
      craftTime: '4 Hours',
      investment: 684,
      cost: 1368,
      productName: 'Extra rune/glyph slot on existing equipment',
      productQuantity: 1,
      productUuid: '',
      materials,
      effectText:
        'Add one rune/glyph-only slot to a weapon or armor at full Reliability/SP, to a maximum of three total slots.',
      notes:
        'Requires Crafting Tools. Every covered armor location must be at full SP. This modifies an existing item; it does not create a loose enhancement. Use the dedicated enhancement workflow.',
      description: `<p>${source}, p.114. Master diagram; Crafting DC25; 4 hours; Meteorite4 and Infused Dust2. The additional slot only accepts runes/glyphs. Maximum three slots.</p>`,
    },
    flags: flags('extra-slot', 'slot-diagram', 114, { enhancementProcedure: 'slot' }),
  };
  return [...glyphs, ...words, ...diagrams, slot];
}
export async function buildEnhancements(root = ROOT) {
  const entries = await enhancementDocuments(root);
  const destination = path.join(root, 'data/witcher');
  await mkdir(destination, { recursive: true });
  await writeFile(
    path.join(destination, `${ENHANCEMENT_PACK}.json`),
    JSON.stringify(entries, null, 2) + '\n'
  );
  return entries;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  console.log(`${ENHANCEMENT_PACK}: ${(await buildEnhancements()).length} entries`);
