import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SYSTEM_ID } from '../../module/witcher/config.js';
import { TROPHIES, artifactItemData, MAGIC_GEAR_SOURCE } from '../../module/witcher/magic-gear-rules.js';

export function magicGearDocuments() {
  const entries = [];
  const add = (key, data) =>
    entries.push({
      _id: createHash('sha256').update(`witcher-rilerena:magic-gear:${key}`).digest('hex').slice(0, 16),
      ...data,
    });
  for (const animal of ['cat', 'dog', 'bird', 'serpent'])
    add(`crystal-skull-${animal}`, artifactItemData('crystalSkull', { animal }));
  for (const species of Object.keys(TROPHIES))
    add(`trophy-${species}`, artifactItemData('trophy', { species, pendingSetup: true }));
  add('wagerers-pendant', artifactItemData('hexPendant', { pendingSetup: true }));
  for (let slots = 1; slots <= 4; slots++)
    add(`enchanted-amulet-${slots}`, artifactItemData('amulet', { slots, pendingSetup: true }));
  for (const [key, name, page, cost] of [
    ['simple-amulet', 'Simple Amulet', 104, null],
    ['perfect-gemstone', 'Perfect Gemstone', 104, null],
    ['runewrights-tools', 'Runewright’s Tools', 120, 550],
  ])
    add(key, {
      name,
      type: 'gear',
      img: 'icons/svg/item-bag.svg',
      system: {
        quantity: 1,
        carried: true,
        equipped: false,
        cost: cost ?? 0,
        weight: 0,
        source: MAGIC_GEAR_SOURCE,
        page,
        description: `<p>Actual ${name.toLowerCase()} required by the Enchant Amulet ritual. ${key === 'runewrights-tools' ? 'Reusable tools are retained after the ritual.' : 'Consumed during imbuement.'}</p>`,
      },
      flags: {
        [SYSTEM_ID]: { weightUnspecified: true, ...(cost === null ? { priceUnspecified: true } : {}) },
      },
    });
  return entries;
}
export async function buildMagicGear(root = path.resolve(import.meta.dirname, '../..')) {
  const destination = path.join(root, 'data/witcher');
  await mkdir(destination, { recursive: true });
  const entries = magicGearDocuments();
  await writeFile(path.join(destination, 'magic-gear.json'), JSON.stringify(entries, null, 2) + '\n');
  return entries;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(`magic-gear: ${(await buildMagicGear()).length} entries`);
}
