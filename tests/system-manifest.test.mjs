import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SYSTEM_ID = "cyberpunk2020-rilerena";
// Foundry V14 BasePackage.validateId accepts letters (including uppercase),
// digits, hyphens, and underscores. Existing public pack IDs must remain
// stable because macros and third-party modules may address them directly.
const PACK_ID_PATTERN = /^[A-Za-z0-9-_]+$/;

export async function runSystemManifestTests() {
  const manifest = JSON.parse(await readFile(path.join(PROJECT_ROOT, "system.json"), "utf8"));
  const template = JSON.parse(await readFile(path.join(PROJECT_ROOT, "template.json"), "utf8"));

  assert.equal(manifest.id, SYSTEM_ID);
  assert.equal(manifest.name, undefined, "V14 manifests must use id instead of the removed name alias");
  assert.equal(manifest.templateVersion, undefined, "custom top-level manifest keys are not part of the V14 schema");
  assert.match(
    String(manifest.version || ""),
    /^\d+(?:\.\d+)*$/,
    "Foundry package versions must use dot-separated integers without SemVer prerelease suffixes"
  );
  assert.equal(manifest.compatibility?.minimum, "14.365");
  assert.equal(manifest.compatibility?.maximum, "14");
  assert.match(String(manifest.compatibility?.verified || ""), /^14(?:\.|$)/);
  assert.deepEqual(
    manifest.grid,
    { type: 1, distance: 5, units: "m", diagonals: 0 },
    "V14 system grid defaults must use the complete BaseSystem schema"
  );
  assert.equal(
    template.Actor?.templates?.skills,
    undefined,
    "legacy Actor system.skills defaults must not be reintroduced after migration"
  );
  for(const actorType of template.Actor?.types || []) {
    assert.ok(
      !template.Actor?.[actorType]?.templates?.includes("skills"),
      `${actorType} must use Item skills only`
    );
  }

  const expectedAsset = `${SYSTEM_ID}-v${manifest.version}.zip`;
  assert.ok([
    "https://raw.githubusercontent.com/alexch3706/cyberpunk2020foundry/main/system.json",
    `https://github.com/alexch3706/cyberpunk2020foundry/releases/download/v${manifest.version}/system.json`
  ].includes(manifest.manifest), "update channel must be stable main or this version's pinned test release");
  assert.ok(
    String(manifest.download || "").endsWith(`/v${manifest.version}/${expectedAsset}`),
    "download must point at the immutable release asset for this manifest version"
  );

  const packNames = new Set();
  const packPaths = new Set();
  for (const pack of manifest.packs || []) {
    assert.match(pack.name, PACK_ID_PATTERN, `invalid V14 compendium id: ${pack.name}`);
    assert.equal(pack.system, SYSTEM_ID, `pack must declare its owning system: ${pack.name}`);
    assert.ok(!packNames.has(pack.name), `duplicate compendium id: ${pack.name}`);
    assert.ok(!packPaths.has(pack.path), `duplicate compendium path: ${pack.path}`);
    packNames.add(pack.name);
    packPaths.add(pack.path);
    await assertReadable(pack.path);
  }

  for (const relativePath of [
    ...(manifest.esmodules || []),
    ...(manifest.styles || []).map(style => {
      assert.equal(typeof style, "object", "V14 styles must use canonical StyleManifest objects");
      assert.equal(typeof style?.src, "string", "every V14 style entry requires src");
      return style.src;
    }),
    ...(manifest.languages || []).map(language => language.path)
  ]) {
    await assertReadable(relativePath);
  }

  return [{ name: "manifest: V14 package metadata and paths are valid", passed: true }];
}

async function assertReadable(relativePath) {
  const resolved = path.resolve(PROJECT_ROOT, relativePath);
  assert.ok(
    resolved.startsWith(`${PROJECT_ROOT}${path.sep}`),
    `manifest path escapes the package root: ${relativePath}`
  );
  await access(resolved);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await runSystemManifestTests();
  console.log("System manifest compatibility: passed");
}
