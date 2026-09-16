import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { WOUNDS } from '../../module/witcher/wounds.js';
import { woundInfo, woundItemData } from '../../module/witcher/wound-catalog.js';
import { criticalWoundDocuments } from '../../tools/witcher/build-wounds.mjs';

test('critical wound catalog covers every published row with source page and anatomical group', () => {
  const sources = Object.entries(WOUNDS).flatMap(([severity, entries]) =>
    entries.map((wound, index) => ({ ...wound, severity, key: `${severity}-${index}` }))
  );
  assert.equal(sources.length, 24);
  for (const wound of sources) {
    const info = woundInfo(wound);
    assert.equal(info.key, wound.key);
    assert.equal(info.severity, wound.severity);
    assert.ok(['leg', 'arm', 'torso', 'head'].includes(info.group));
    assert.ok([158, 159, 160].includes(info.page));
    assert.deepEqual(Object.keys(info.stages), ['untreated', 'stabilized', 'treated', 'healed']);
    for (const text of Object.values(info.stages)) assert.ok(text.trim().length > 0);
    assert.deepEqual(woundInfo({ name: wound.name, severity: wound.severity }), info);
  }
  assert.equal(woundInfo({ key: 'difficult-0' }).page, 160);
  assert.equal(woundInfo({ key: 'difficult-1' }).page, 160);
  assert.equal(woundInfo({ key: 'difficult-2' }).page, 159);
  assert.equal(woundInfo({ severity: 'simple', name: 'Custom wound' }), null);
});

test('runtime wound factory preserves acquired state and roll results without an embedded Item ID', () => {
  const state = {
    ...structuredClone(WOUNDS.complex[4]),
    severity: 'complex',
    location: 'head',
    treatment: 'treated',
    daysRemaining: 4,
    turnsTreated: 3,
    extraResult: 7,
    magicSuccesses: 2,
  };
  const document = woundItemData(state);
  assert.equal(document._id, undefined);
  assert.equal(document.type, 'wound');
  assert.equal(document.img, 'icons/svg/blood.svg');
  assert.equal(document.system.wound.key, 'complex-4');
  assert.equal(document.system.wound.group, 'head');
  assert.equal(document.system.wound.separateConditions, true);
  for (const [key, value] of Object.entries(state)) assert.deepEqual(document.system.wound[key], value);
  document.system.wound.modifiers.persuasion = -99;
  assert.equal(state.modifiers.persuasion, -3);
  assert.equal(WOUNDS.complex[4].modifiers.persuasion, -3);
  assert.throws(() => woundItemData({ name: 'Custom wound' }), /Unknown/);
  assert.equal(woundItemData({ ...state, separateConditions: false }).system.wound.separateConditions, false);
});

test('compendium templates are deterministic shared factory output with no combat or inventory state', async () => {
  const documents = criticalWoundDocuments();
  assert.equal(new Set(documents.map((document) => document._id)).size, 24);
  assert.deepEqual(documents, criticalWoundDocuments());
  for (const document of documents) {
    assert.match(document._id, /^[0-9a-f]{16}$/);
    assert.equal(document.system.wound.treatment, 'untreated');
    assert.equal(document.system.wound.location, '');
    assert.equal(document.system.equipped, false);
    assert.equal(document.system.weight, 0);
    assert.equal(document.system.cost, 0);
    assert.equal(document.system.source, 'The Witcher Core Rulebook v1.35');
    const { _id, ...source } = document;
    assert.deepEqual(source, woundItemData(document.system.wound));
  }
  const stored = JSON.parse(
    await readFile(new URL('../../data/witcher/critical-wounds.json', import.meta.url), 'utf8')
  );
  assert.deepEqual(stored, documents);
});

test('catalog differentiates stabilization, medical time, magical successes, and permanent aftermath', () => {
  for (const [index, severity] of ['simple', 'complex', 'difficult', 'deadly'].entries()) {
    const item = woundItemData({ key: `${severity}-0` });
    assert.match(item.system.description, new RegExp(`First Aid check at DC ${12 + index * 2}`));
    assert.match(
      item.system.description,
      new RegExp(`${2 + index * 2} rounds followed by one Healing Hands check`)
    );
    assert.match(
      item.system.description,
      new RegExp(`${4 + index * 2} successful healing-spell uses at Spell Casting DC ${14 + index * 2}`)
    );
    assert.match(item.system.description, /do not restore HP/);
    if (severity !== 'deadly') assert.match(item.system.description, /Stabilization does not start healing/);
  }
  for (let index = 0; index < 5; index++) {
    assert.match(woundInfo({ key: `deadly-${index}` }).stages.healed, /Permanent consequence/);
    assert.match(
      woundItemData({ key: `deadly-${index}` }).system.description,
      /no recovery duration for Deadly/
    );
  }
  const fatal = woundItemData({ key: 'deadly-5' });
  assert.match(fatal.system.description, /cannot be stabilized/);
  assert.match(fatal.system.description, /cannot be treated/);
  assert.match(fatal.system.description, /does not revive/);
  assert.doesNotMatch(fatal.system.description, /successful healing-spell uses/);
  assert.match(woundInfo({ key: 'deadly-3' }).stages.healed, /whenever the character is bleeding/);
  assert.match(woundInfo({ key: 'difficult-1' }).stages.treated, /sling.*hold an object/);
  assert.match(woundInfo({ key: 'simple-2' }).note, /exact arithmetic.*not specified/);
});
