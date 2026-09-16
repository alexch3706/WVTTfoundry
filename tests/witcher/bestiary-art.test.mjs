import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { BESTIARY_ART } from '../../module/witcher/bestiary-art.js';
import { collectReleaseFiles } from '../../tools/witcher/build-release.mjs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const read = (file) => fs.readFile(new URL('../../' + file, import.meta.url));
const json = async (file) => JSON.parse(await read(file));
const actors = await json('data/witcher/bestiary.json');
const art = await json('data/witcher/bestiary-art.json');
const prefix = 'systems/witcher-rilerena/';

test('every bestiary portrait and prototype token resolves to a packaged asset and migration identity', async () => {
  const files = new Set(await collectReleaseFiles(root, await json('system.json')));
  assert.equal(art.actors.length, actors.length);
  assert.deepEqual(Object.keys(BESTIARY_ART).sort(), actors.map((a) => a._id).sort());
  assert.equal(new Set(art.actors.map((a) => a.id)).size, actors.length);
  for (const actor of actors) {
    const entry = art.actors.find((a) => a.id === actor._id);
    const catalog = BESTIARY_ART[actor._id];
    assert.equal(catalog.name, actor.name);
    assert.equal(entry.name, actor.name);
    assert.equal(actor.img, catalog.portrait);
    assert.equal(actor.prototypeToken.texture.src, catalog.token);
    assert.equal(actor.flags['witcher-rilerena'].bestiaryId, actor._id);
    for (const key of ['portrait', 'token']) {
      assert.equal(catalog[key], prefix + entry[key]);
      assert.ok(files.has(entry[key]), `${actor.name}: missing packaged ${key}`);
    }
  }
});

test('round tokens and cropped portraits embed the actual raster and require no remote image fetch', async () => {
  for (const entry of art.actors) {
    const original = await read(entry.image ?? entry.portrait);
    assert.equal(original.subarray(0, 4).toString(), 'RIFF');
    assert.equal(original.subarray(8, 12).toString(), 'WEBP');
    const [x, y, size] = entry.viewport;
    assert.ok(size > 0 && x >= 0 && y >= 0 && x + size <= entry.width && y + size <= entry.height);
    for (const file of [entry.token, ...(entry.portraitViewport ? [entry.portrait] : [])]) {
      const svg = (await read(file)).toString();
      const urls = [...svg.matchAll(/(?:xlink:)?href="([^"]+)"/g)].map((m) => m[1]);
      assert.equal(urls.length, 1, file);
      assert.ok(urls[0].startsWith('data:image/webp;base64,'), file);
      assert.deepEqual(Buffer.from(urls[0].split(',')[1], 'base64'), original, file);
      assert.doesNotMatch(svg, /<script|<foreignObject|\bonload=/i);
      if (file === entry.token) {
        assert.match(svg, /width="512" height="512"/);
        assert.match(svg, /clip-path="url\(#portrait\)"/);
      }
    }
  }
});

test('book art has page provenance; all eight generated replacements retain their prompts', async () => {
  const prompts = (await json('data/witcher/generated-art-prompts.json')).prompts;
  const generated = art.actors.filter((a) => a.source.kind === 'generated');
  assert.equal(generated.length, 8);
  assert.deepEqual(generated.map((a) => a.source.promptKey).sort(), Object.keys(prompts).sort());
  for (const entry of art.actors) {
    const source = entry.source;
    if (source.kind === 'generated') {
      assert.ok(prompts[source.promptKey]?.length > 100, entry.name);
    } else {
      assert.equal(source.kind, 'book');
      assert.ok(art.reviewedBooks.includes(source.book), entry.name);
      assert.equal(source.pdfPage, source.printedPage + 1);
      assert.ok(source.printedPage > 0 && Number.isInteger(source.imageXref));
      if (source.sharedWith) assert.ok(actors.some((a) => a.name === source.sharedWith));
    }
  }
});
