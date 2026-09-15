import { compilePack, extractPack } from '@foundryvtt/foundryvtt-cli';
import { readFile, mkdir, writeFile, rm, readdir } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

const root = path.resolve(import.meta.dirname, '../..');
const manifest = JSON.parse(await readFile(path.join(root, 'system.json'), 'utf8'));
const scratch = path.join(root, '.pack-build');
await mkdir(scratch, { recursive: true });
for (const pack of manifest.packs) {
  const source = path.join(scratch, pack.name);
  const destination = path.join(root, pack.path);
  const extracted = path.join(scratch, pack.name + '-readback');
  const items = JSON.parse(await readFile(path.join(root, 'data/witcher', pack.name + '.json'), 'utf8'));
  await rm(source, { recursive: true, force: true });
  await mkdir(source, { recursive: true });
  await rm(extracted, { recursive: true, force: true });
  for (const item of items)
    await writeFile(
      path.join(source, item._id + '.json'),
      JSON.stringify({
        ...item,
        _key: `!${pack.type === 'Actor' ? 'actors' : 'items'}!${item._id}`,
        ...(pack.type === 'Actor'
          ? { items: item.items.map((i) => ({ ...i, _key: `!actors.items!${item._id}.${i._id}` })) }
          : {}),
      })
    );
  await rm(destination, { recursive: true, force: true });
  await compilePack(source, destination, { log: false });
  await extractPack(destination, extracted, { log: false });
  const readback = await readdir(extracted);
  assert.equal(
    readback.filter((p) => p.endsWith('.json')).length,
    items.length,
    `${pack.name}: stored document count`
  );
  const documents = await Promise.all(
    readback
      .filter((p) => p.endsWith('.json'))
      .map(async (p) => JSON.parse(await readFile(path.join(extracted, p), 'utf8')))
  );
  for (const item of items) {
    const stored = documents.find((d) => d._id === item._id);
    assert.deepEqual(stored?.system, item.system, `${pack.name}/${item.name}: stored system data`);
    if (pack.type === 'Actor') {
      assert.equal(stored.items.length, item.items.length, `${item.name}: embedded item count`);
      for (const embedded of item.items)
        assert.deepEqual(
          stored.items.find((i) => i._id === embedded._id)?.system,
          embedded.system,
          `${item.name}/${embedded.name}: embedded system data`
        );
    }
  }
  console.log(`${pack.name}: ${items.length} LevelDB documents compiled and read back`);
  for (const name of ['LOG', 'LOG.old', 'LOCK']) await rm(path.join(destination, name), { force: true });
}
await rm(scratch, { recursive: true, force: true });
