/** Build and inspect an installable package. Requires Node 22 and Python 3. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const SYSTEM_ID = 'witcher-rilerena';
const SOURCE_ROOT = path.resolve(import.meta.dirname, '../..');
const RUNTIME_ROOTS = ['module/witcher', 'templates/witcher'];
const FIXED_FILES = [
  'system.json',
  'css/witcher.css',
  'module/foundry-compat.js',
  'module/actor/actor-sheet-render.js',
  'docs/witcher/install.md',
  'docs/witcher/forge-checklist.md',
  'docs/witcher/bestiary.md',
  'docs/witcher/supplements.md',
  'docs/witcher/implementation-status.md',
];
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
const LEVELDB_FILE = /^(?:CURRENT|MANIFEST-\d+|OPTIONS-\d+|\d+\.(?:ldb|sst|log))$/;

export function validateReleaseManifest(manifest, pkg, { tag, repository } = {}) {
  assert.equal(manifest.id, SYSTEM_ID, 'Wrong Foundry installation directory / system ID');
  assert(SEMVER.test(manifest.version), 'Release version must be a semantic version without build metadata');
  for (const identifier of manifest.version.split('-').slice(1).join('-').split('.'))
    assert(!/^0\d+$/.test(identifier), 'Numeric prerelease identifiers cannot have leading zeroes');
  assert.equal(pkg.version, manifest.version, 'package.json and system.json versions differ');
  assert.equal(pkg.name, SYSTEM_ID, 'package.json name differs from system ID');
  const releaseTag = `v${manifest.version}`;
  assert.equal(tag ?? releaseTag, releaseTag, 'Git tag must equal v<system.json version>');
  assert.equal(manifest.compatibility?.minimum, '14', 'Release requires Foundry V14');
  assert.equal(
    manifest.compatibility?.maximum,
    '14',
    'Release must not claim untested later Foundry versions'
  );
  assert.match(
    manifest.url,
    /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/,
    'Invalid repository URL'
  );
  if (repository)
    assert.equal(
      manifest.url,
      `https://github.com/${repository}`,
      'Manifest points to a different repository'
    );
  const releaseBase = `${manifest.url}/releases/download/${releaseTag}`;
  assert.equal(
    manifest.download,
    `${releaseBase}/${SYSTEM_ID}.zip`,
    'Download URL does not match this version'
  );
  const pinnedManifest = `${releaseBase}/system.json`;
  const prerelease = manifest.version.includes('-');
  assert(
    manifest.manifest === pinnedManifest ||
      (!prerelease && manifest.manifest === `${manifest.url}/releases/latest/download/system.json`),
    'Prereleases require a pinned manifest URL; stable manifest must be pinned or releases/latest'
  );
  return { tag: releaseTag, version: manifest.version, prerelease, pinnedManifest };
}

async function regularFile(root, relative) {
  assert(
    !path.isAbsolute(relative) && !relative.split('/').includes('..'),
    `Unsafe package path: ${relative}`
  );
  const absolute = path.join(root, relative);
  // Check each ancestor as well as the file: a symlinked directory must not import outside content.
  const parts = relative.split('/');
  for (let i = 1; i <= parts.length; i++) {
    const stat = await fs.lstat(path.join(root, ...parts.slice(0, i)));
    assert(!stat.isSymbolicLink(), `Symlinks are not package inputs: ${relative}`);
    assert(i === parts.length ? stat.isFile() : stat.isDirectory(), `Not a regular file: ${relative}`);
  }
  return absolute;
}

async function runtimeFiles(root, relative) {
  const directory = await fs.lstat(path.join(root, relative));
  assert(directory.isDirectory() && !directory.isSymbolicLink(), `Invalid runtime directory: ${relative}`);
  const files = [];
  for (const entry of await fs.readdir(path.join(root, relative), { withFileTypes: true })) {
    const file = `${relative}/${entry.name}`;
    assert(!entry.isSymbolicLink(), `Symlinks are not package inputs: ${file}`);
    if (entry.isDirectory()) files.push(...(await runtimeFiles(root, file)));
    else if (entry.isFile() && /\.(?:js|hbs)$/.test(file)) files.push(file);
  }
  return files;
}

export async function collectReleaseFiles(root, manifest) {
  const files = new Set(FIXED_FILES);
  for (const directory of RUNTIME_ROOTS)
    for (const file of await runtimeFiles(root, directory)) files.add(file);
  const packNames = new Set();
  for (const pack of manifest.packs ?? []) {
    assert.match(pack.path, /^packs\/witcher\/[a-z0-9-]+$/, `Invalid pack directory: ${pack.name}`);
    assert.equal(pack.path, `packs/witcher/${pack.name}`, 'Pack name/path mismatch');
    assert.equal(pack.system, SYSTEM_ID, 'Pack belongs to another system');
    assert(['Item', 'Actor'].includes(pack.type), 'Unsupported pack document type');
    assert(!packNames.has(pack.name), `Duplicate pack: ${pack.name}`);
    packNames.add(pack.name);
    const names = await fs.readdir(path.join(root, pack.path));
    const dbFiles = names.filter((name) => LEVELDB_FILE.test(name));
    assert(dbFiles.includes('CURRENT'), `${pack.name}: missing LevelDB CURRENT`);
    assert(
      dbFiles.some((name) => /\.(?:ldb|sst|log)$/.test(name)),
      `${pack.name}: missing LevelDB data`
    );
    const current = (await fs.readFile(await regularFile(root, `${pack.path}/CURRENT`), 'utf8')).trim();
    assert(
      /^MANIFEST-\d+$/.test(current) && dbFiles.includes(current),
      `${pack.name}: broken CURRENT pointer`
    );
    for (const name of dbFiles) files.add(`${pack.path}/${name}`);
  }
  assert(packNames.size, 'An installable release requires compendiums');
  for (const file of [...(manifest.esmodules ?? []), ...(manifest.styles ?? [])])
    assert(files.has(file), `Manifest entry is outside the runtime whitelist: ${file}`);
  assert(manifest.esmodules?.includes('module/witcher/main.js'), 'Missing Witcher entry point');
  for (const file of files) {
    const absolute = await regularFile(root, file);
    if (!file.endsWith('.js')) continue;
    const code = await fs.readFile(absolute, 'utf8');
    for (const match of code.matchAll(/(?:\bfrom\s*|\bimport\s*\(?\s*)['"]([^'"]+)['"]/g)) {
      const target = match[1];
      assert(target.startsWith('.'), `Unbundled import in ${file}: ${target}`);
      const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(file), target));
      assert(files.has(resolved), `Runtime import is absent from package: ${file} → ${target}`);
    }
  }
  return [...files].sort();
}

// Python's standard library creates a real ZIP, then opens it again and compares
// every member to the staged input. No archive dependency or system zip binary is needed.
const ZIP_SCRIPT = String.raw`
import json, pathlib, sys, zipfile
stage, output = map(pathlib.Path, sys.argv[1:3])
files = json.load(sys.stdin)
with zipfile.ZipFile(output, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
    for name in files:
        info = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
        info.compress_type = zipfile.ZIP_DEFLATED
        info.external_attr = 0o100644 << 16
        archive.writestr(info, (stage / name).read_bytes())
with zipfile.ZipFile(output) as archive:
    assert archive.namelist() == files, 'Archive member list differs from whitelist'
    assert archive.testzip() is None, 'Archive CRC verification failed'
    for name in files:
        assert archive.read(name) == (stage / name).read_bytes(), 'Archive data mismatch: ' + name
    print(json.dumps({'files': archive.namelist(), 'uncompressedBytes': sum(i.file_size for i in archive.infolist())}))
`;

export async function buildRelease({ root = SOURCE_ROOT, outDir, tag, repository } = {}) {
  root = path.resolve(root);
  const manifest = JSON.parse(await fs.readFile(path.join(root, 'system.json'), 'utf8'));
  const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
  const release = validateReleaseManifest(manifest, pkg, { tag, repository });
  const files = await collectReleaseFiles(root, manifest);
  outDir = path.resolve(outDir ?? path.join(root, 'dist', release.tag));
  await fs.mkdir(outDir, { recursive: true });
  const stage = await fs.mkdtemp(path.join(os.tmpdir(), 'witcher-release-'));
  const zipPath = path.join(outDir, `${SYSTEM_ID}.zip`);
  try {
    for (const file of files) {
      await fs.mkdir(path.dirname(path.join(stage, file)), { recursive: true });
      await fs.copyFile(path.join(root, file), path.join(stage, file));
    }
    assert.deepEqual(
      JSON.parse(await fs.readFile(path.join(stage, 'system.json'), 'utf8')),
      manifest,
      'Manifest changed while the package was being staged; rebuild from one version'
    );
    const result = spawnSync('python3', ['-c', ZIP_SCRIPT, stage, zipPath], {
      input: JSON.stringify(files),
      encoding: 'utf8',
      maxBuffer: 8 * 1024 * 1024,
    });
    assert.equal(result.status, 0, result.error?.message ?? result.stderr);
    const inspection = JSON.parse(result.stdout);
    const manifestPath = path.join(outDir, 'system.json');
    await fs.copyFile(path.join(stage, 'system.json'), manifestPath);
    const checksumLines = [];
    for (const asset of [zipPath, manifestPath]) {
      const hash = createHash('sha256')
        .update(await fs.readFile(asset))
        .digest('hex');
      checksumLines.push(`${hash}  ${path.basename(asset)}`);
    }
    await fs.writeFile(path.join(outDir, 'SHA256SUMS'), checksumLines.join('\n') + '\n');
    const report = { ...release, ...inspection, archive: path.basename(zipPath), checksums: checksumLines };
    await fs.writeFile(path.join(outDir, 'release-report.json'), JSON.stringify(report, null, 2) + '\n');
    return { ...report, outDir, zipPath, manifestPath };
  } finally {
    await fs.rm(stage, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2),
    options = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = { '--root': 'root', '--out': 'outDir', '--tag': 'tag', '--repository': 'repository' }[
      args[i]
    ];
    assert(key && args[i + 1], `Unknown or incomplete option: ${args[i]}`);
    options[key] = args[i + 1];
  }
  const result = await buildRelease(options);
  console.log(`Verified ${result.files.length} archive members: ${result.zipPath}`);
  console.log(`Install manifest: ${result.pinnedManifest}`);
}
