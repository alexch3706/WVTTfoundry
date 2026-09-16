import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  buildRelease,
  collectReleaseFiles,
  validateReleaseManifest,
} from '../../tools/witcher/build-release.mjs';

const repo = 'https://github.com/alexch3706/WVTTfoundry';
const version = '0.9.0-dev.2';
const base = `${repo}/releases/download/v${version}`;
function manifest() {
  return {
    id: 'witcher-rilerena',
    version,
    compatibility: { minimum: '14', maximum: '14' },
    url: repo,
    manifest: `${base}/system.json`,
    download: `${base}/witcher-rilerena.zip`,
    esmodules: ['module/witcher/main.js'],
    styles: ['css/witcher.css'],
    packs: [
      {
        name: 'equipment',
        path: 'packs/witcher/equipment',
        type: 'Item',
        system: 'witcher-rilerena',
      },
    ],
  };
}
const pkg = { name: 'witcher-rilerena', version };
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'witcher-release-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  async function put(relative, content) {
    await fs.mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await fs.writeFile(path.join(root, relative), content);
  }
  const m = manifest();
  const sources = {
    'system.json': JSON.stringify(m, null, 2) + '\n',
    'package.json': JSON.stringify(pkg),
    'module/witcher/main.js': "import '../foundry-compat.js';\nimport './rules.js';\n",
    'module/witcher/rules.js': 'export const damage = 1;\n',
    'module/foundry-compat.js': 'export {};\n',
    'module/actor/actor-sheet-render.js': 'export {};\n',
    'templates/witcher/actor.hbs': '<form>{{actor.name}}</form>',
    'css/witcher.css': '.witcher { color: black; }',
    'docs/witcher/install.md': '# Install\n',
    'docs/witcher/forge-checklist.md': '# Live acceptance\n',
    'docs/witcher/bestiary.md': '# Bestiary\n',
    'docs/witcher/art-sources.md': '# Art provenance\n',
    'docs/witcher/critical-wounds.md': '# Critical wound cards\n',
    'assets/bestiary/portraits/example.webp': Buffer.from([82, 73, 70, 70]),
    'assets/bestiary/tokens/example.svg': '<svg xmlns="http://www.w3.org/2000/svg"/>',
    'assets/bestiary/source.pdf': 'source book must not ship',
    'docs/witcher/supplements.md': '# Supplement coverage\n',
    'docs/witcher/implementation-status.md': '# Known limitations\n',
    // Deliberately small packaging fixtures; compendium validity is tested by build-packs.mjs.
    'packs/witcher/equipment/CURRENT': 'MANIFEST-000001\n',
    'packs/witcher/equipment/MANIFEST-000001': Buffer.from([1, 2, 3]),
    'packs/witcher/equipment/000003.ldb': Buffer.from([0, 255, 1, 254]),
    'packs/witcher/equipment/000004.log': Buffer.from([]),
    'packs/witcher/equipment/LOCK': 'exclude lock',
    'packs/witcher/equipment/LOG': 'exclude process log',
    'module/cyberpunk.js': 'must not ship',
    'module/actor/actor.js': 'inherited implementation must not ship',
    'templates/actor.hbs': 'inherited template must not ship',
    'README.md': 'inherited Cyberpunk readme must not ship',
    'module/witcher/book.pdf': 'source PDF must not ship even inside a runtime directory',
    'data/witcher/equipment.json': 'extraction input must not ship',
    'node_modules/private/index.js': 'dependency must not ship',
    'packs/witcher/undeclared/000003.ldb': 'undeclared pack must not ship',
  };
  for (const [file, content] of Object.entries(sources)) await put(file, content);
  return { root, m, put, sources };
}

test('release links, version, tag and repository cannot identify different builds', () => {
  const valid = validateReleaseManifest(manifest(), pkg, {
    tag: `v${version}`,
    repository: 'alexch3706/WVTTfoundry',
  });
  assert.equal(valid.prerelease, true);
  assert.equal(valid.pinnedManifest, `${base}/system.json`);
  assert.throws(() => validateReleaseManifest(manifest(), { ...pkg, version: '0.9.0' }), /versions differ/);
  assert.throws(() => validateReleaseManifest(manifest(), pkg, { tag: 'v0.8.0' }), /Git tag/);
  assert.throws(
    () =>
      validateReleaseManifest(
        { ...manifest(), download: `${repo}/releases/latest/download/witcher-rilerena.zip` },
        pkg
      ),
    /Download URL/
  );
  assert.throws(
    () =>
      validateReleaseManifest(
        { ...manifest(), manifest: `${repo}/releases/latest/download/system.json` },
        pkg
      ),
    /pinned manifest/
  );
  assert.throws(
    () => validateReleaseManifest(manifest(), pkg, { repository: 'other/repo' }),
    /different repository/
  );
  const stable = {
    ...manifest(),
    version: '0.9.0',
    manifest: `${repo}/releases/latest/download/system.json`,
    download: `${repo}/releases/download/v0.9.0/witcher-rilerena.zip`,
  };
  assert.equal(validateReleaseManifest(stable, { ...pkg, version: '0.9.0' }).prerelease, false);
});

test('actual ZIP has root manifest, only declared runtime, preserved binary packs and matching hashes', async (t) => {
  const { root, sources } = await fixture(t);
  const built = await buildRelease({ root, tag: `v${version}` });
  assert(built.files.includes('system.json'));
  assert(built.files.includes('module/actor/actor-sheet-render.js'));
  assert(built.files.includes('assets/bestiary/portraits/example.webp'));
  assert(built.files.includes('assets/bestiary/tokens/example.svg'));
  assert(built.files.includes('packs/witcher/equipment/000004.log'));
  for (const file of [
    'module/cyberpunk.js',
    'module/actor/actor.js',
    'templates/actor.hbs',
    'README.md',
    'module/witcher/book.pdf',
    'assets/bestiary/source.pdf',
    'data/witcher/equipment.json',
    'node_modules/private/index.js',
    'packs/witcher/undeclared/000003.ldb',
    'packs/witcher/equipment/LOCK',
    'packs/witcher/equipment/LOG',
  ])
    assert(!built.files.includes(file), file);
  const checked = spawnSync(
    'python3',
    [
      '-c',
      `
import json, sys, zipfile
with zipfile.ZipFile(sys.argv[1]) as z:
    assert z.testzip() is None
    print(json.dumps({'names': z.namelist(), 'manifest': z.read('system.json').decode(), 'binary': list(z.read('packs/witcher/equipment/000003.ldb'))}))
`,
      built.zipPath,
    ],
    { encoding: 'utf8' }
  );
  assert.equal(checked.status, 0, checked.stderr);
  const archive = JSON.parse(checked.stdout);
  assert.deepEqual(archive.names, built.files);
  assert.equal(archive.manifest, sources['system.json']);
  assert.equal(await fs.readFile(built.manifestPath, 'utf8'), archive.manifest);
  assert.deepEqual(archive.binary, [0, 255, 1, 254]);
  const sums = (await fs.readFile(path.join(built.outDir, 'SHA256SUMS'), 'utf8')).trim().split('\n');
  for (const line of sums) {
    const [hash, file] = line.split('  ');
    assert.equal(
      createHash('sha256')
        .update(await fs.readFile(path.join(built.outDir, file)))
        .digest('hex'),
      hash
    );
  }
});

test('archive cannot silently omit a runtime dependency or manifest entry', async (t) => {
  const { root, m, put } = await fixture(t);
  await put('module/witcher/main.js', "import '../cyberpunk.js';\n");
  await assert.rejects(() => collectReleaseFiles(root, m), /Runtime import is absent/);
  await put('module/witcher/main.js', "import './rules.js';\n");
  await assert.rejects(
    () => collectReleaseFiles(root, { ...m, styles: ['css/cyberpunk.css'] }),
    /outside the runtime whitelist/
  );
});

test('unsafe manifest pack paths and symlinked content are rejected', async (t) => {
  const { root, m } = await fixture(t);
  await assert.rejects(
    () => collectReleaseFiles(root, { ...m, packs: [{ ...m.packs[0], path: '../outside' }] }),
    /Invalid pack directory/
  );
  await fs.rm(path.join(root, 'module/witcher/rules.js'));
  await fs.symlink('../cyberpunk.js', path.join(root, 'module/witcher/rules.js'));
  await assert.rejects(() => collectReleaseFiles(root, m), /Symlinks/);
});

test('LevelDB CURRENT must point at a manifest included in the package', async (t) => {
  const { root, m, put } = await fixture(t);
  await put('packs/witcher/equipment/CURRENT', 'MANIFEST-999999\n');
  await assert.rejects(() => collectReleaseFiles(root, m), /broken CURRENT pointer/);
});

test('current runtime imports and declared real compendiums fit the release whitelist', async () => {
  const root = path.resolve(import.meta.dirname, '../..');
  const m = JSON.parse(await fs.readFile(path.join(root, 'system.json'), 'utf8'));
  const files = await collectReleaseFiles(root, m);
  assert(files.includes('module/witcher/main.js'));
  for (const pack of m.packs) assert(files.includes(`${pack.path}/CURRENT`));
});
