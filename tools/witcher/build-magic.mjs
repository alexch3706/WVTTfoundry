import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MAGIC, magicItemData } from '../../module/witcher/magic-catalog.js';

export const MAGIC_PACKS = {
  sign: 'magic-signs',
  spell: 'magic-spells',
  invocation: 'magic-invocations',
  ritual: 'magic-rituals',
  hex: 'magic-hexes',
};

/** Source keys, rather than titles or list order, keep compendium UUIDs stable. */
export function magicDocuments(kind) {
  if (kind && !Object.hasOwn(MAGIC_PACKS, kind)) throw new Error(`Unknown magic kind: ${kind}`);
  return MAGIC.filter((entry) => !kind || entry.kind === kind).map((entry) => ({
    _id: createHash('sha256').update(`witcher-rilerena:magic:${entry.key}`).digest('hex').slice(0, 16),
    ...magicItemData(entry),
  }));
}

export async function buildMagic(root = path.resolve(import.meta.dirname, '../..')) {
  const destination = path.join(root, 'data/witcher');
  await mkdir(destination, { recursive: true });
  const packs = {};
  for (const [kind, pack] of Object.entries(MAGIC_PACKS)) {
    packs[pack] = magicDocuments(kind);
    await writeFile(path.join(destination, `${pack}.json`), JSON.stringify(packs[pack], null, 2) + '\n');
  }
  return packs;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const packs = await buildMagic();
  for (const [name, entries] of Object.entries(packs)) console.log(`${name}: ${entries.length} entries`);
}
