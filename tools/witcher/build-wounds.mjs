import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WOUNDS } from '../../module/witcher/wounds.js';
import { woundItemData } from '../../module/witcher/wound-catalog.js';

/** Stable IDs preserve compendium references when the source or descriptions change. */
export function criticalWoundDocuments() {
  return Object.entries(WOUNDS).flatMap(([severity, entries]) =>
    entries.map((wound, index) => {
      const key = `${severity}-${index}`;
      return {
        _id: createHash('sha256').update(`witcher-rilerena:critical-wound:${key}`).digest('hex').slice(0, 16),
        ...woundItemData({ ...wound, key, severity }),
      };
    })
  );
}

export async function buildWounds(root = path.resolve(import.meta.dirname, '../..')) {
  const destination = path.join(root, 'data/witcher/critical-wounds.json');
  const documents = criticalWoundDocuments();
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, JSON.stringify(documents, null, 2) + '\n');
  return documents;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const documents = await buildWounds();
  console.log(`critical-wounds: ${documents.length} published injury templates generated`);
}
