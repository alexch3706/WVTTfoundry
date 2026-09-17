import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import Handlebars from 'handlebars';

const root = path.resolve(import.meta.dirname, '../..');
const manifest = JSON.parse(await fs.readFile(path.join(root, 'system.json'), 'utf8'));
assert.equal(manifest.id, 'witcher-rilerena');
assert.equal(manifest.compatibility.minimum.split('.')[0], '14');
for (const file of [...manifest.esmodules, ...manifest.styles]) await fs.access(path.join(root, file));
for (const file of await fs.readdir(path.join(root, 'module/witcher'))) {
  if (!file.endsWith('.js')) continue;
  const result = spawnSync(process.execPath, ['--check', path.join(root, 'module/witcher', file)], {
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  const text = await fs.readFile(path.join(root, 'module/witcher', file), 'utf8');
  for (const match of text.matchAll(/from\s+['"]([^'"]+)['"]/g))
    if (match[1].startsWith('.')) await fs.access(path.resolve(root, 'module/witcher', match[1]));
}
for (const file of (await fs.readdir(path.join(root, 'templates/witcher'))).filter((file) =>
  file.endsWith('.hbs')
))
  Handlebars.precompile(await fs.readFile(path.join(root, 'templates/witcher', file), 'utf8'));
for (const pack of manifest.packs) {
  assert.equal(pack.system, manifest.id);
  assert.ok(['Item', 'Actor'].includes(pack.type));
  const files = await fs.readdir(path.join(root, pack.path));
  assert.ok(
    files.some((f) => f.endsWith('.ldb') || f.endsWith('.log')),
    `${pack.name}: real LevelDB files`
  );
  assert.ok(files.includes('CURRENT'), `${pack.name}: LevelDB CURRENT`);
}
console.log(
  'Manifest, module imports, JavaScript syntax, Handlebars templates, and LevelDB presence validated.'
);
