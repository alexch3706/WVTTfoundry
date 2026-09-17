import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  MAGIC,
  SIGNS,
  REFERENCE_MAGIC,
  MAGIC_SOURCES,
  magicInfo,
  magicItemData,
} from '../../module/witcher/magic-catalog.js';
import { MAGIC_PACKS, magicDocuments, buildMagic } from '../../tools/witcher/build-magic.mjs';

const sourceTotals = {
  [MAGIC_SOURCES.core]: { sign: 10, spell: 65, invocation: 28, ritual: 15, hex: 6 },
  [MAGIC_SOURCES.tome]: { sign: 2, spell: 54, invocation: 33, ritual: 19, hex: 6 },
};

test('Core and Tome magic inventories include their separate necromancy and goetia chapters', () => {
  assert.equal(MAGIC.length, 238);
  assert.equal(REFERENCE_MAGIC.length, 226);
  for (const [source, totals] of Object.entries(sourceTotals)) {
    for (const [kind, expected] of Object.entries(totals)) {
      assert.equal(
        MAGIC.filter((entry) => entry.source === source && entry.kind === kind).length,
        expected,
        `${source}: ${kind}`
      );
    }
  }
  assert.equal(magicInfo('corpse-restoration').kind, 'spell');
  assert.equal(magicInfo('storm-of-souls').kind, 'spell');
  assert.equal(MAGIC.filter((entry) => entry.tradition === 'necromancy').length, 6);
  assert.equal(MAGIC.filter((entry) => entry.tradition === 'goetia').length, 5);
  assert.equal(magicInfo('ritual-of-the-goat-skin').page, 146);
  assert.equal(magicInfo('ritual-of-the-goat-skin').tier, 'unspecified');
});

test('all twelve signs retain the printed defense, reach, duration, and power choices', () => {
  const expected = {
    yrden: [114, 3, 5, []],
    quen: [114, 0, 10, []],
    aard: [114, 2, 0, ['dodge']],
    igni: [114, 2, 0, ['dodge', 'block']],
    axii: [114, 8, 0, ['resistMagic']],
    'magic-trap': [115, 3, 0, ['dodge', 'block']],
    'active-shield': [115, 0, 0, []],
    'aard-sweep': [115, 4, 0, ['dodge']],
    'fire-stream': [115, 3, 0, ['dodge', 'block']],
    puppet: [115, 8, 0, ['resistMagic']],
    somne: [101, 8, 0, ['resistMagic']],
    supirre: [101, 0, 0, []],
  };
  assert.equal(SIGNS.length, Object.keys(expected).length);
  for (const [key, [page, reach, rounds, defenses]] of Object.entries(expected)) {
    const entry = magicInfo(key);
    assert.equal(entry.kind, 'sign');
    assert.equal(entry.page, page);
    assert.equal(entry.range.distance, reach);
    assert.equal(entry.duration.rounds, rounds);
    assert.deepEqual(entry.defenses, defenses);
    assert.equal(entry.cost.max, 7);
  }
  assert.deepEqual(magicInfo('somne').cost.options, [2, 4, 6, 7]);
  assert.equal(magicInfo('somne').duration.seconds, 28800);
  assert.equal(magicInfo('supirre').duration.seconds, 600);
  assert.equal(magicInfo('supirre').effect.params.rangePerSTA, 2);
});

test('sign metadata preserves the distinct knockdown, shielding, and ongoing rules', () => {
  const params = (key) => magicInfo(key).effect.params;
  assert.equal(params('aard').proneChanceBase, 10);
  assert.equal(params('aard').proneChancePerSTA, 10);
  assert.equal(params('aard-sweep').staggerAndProneChancePerSTA, 10);
  assert.equal(params('yrden').maxPenalty, 4);
  assert.equal(params('yrden').additionalSTAPerPenalty, 2);
  assert.equal(params('quen').shieldHPPerSTA, 5);
  assert.equal(params('quen').preventsRecast, true);
  assert.equal(params('active-shield').shieldHPPerSTA, 10);
  assert.equal(params('active-shield').pushMaxWeight, 226);
  assert.equal(params('active-shield').burstAffectsAllies, true);
  assert.equal(magicInfo('active-shield').duration.maintenance, 'initial');
  assert.equal(magicInfo('fire-stream').duration.maintenance, 'half');
  assert.equal(params('magic-trap').preparationRounds, 1);
  assert.equal(params('magic-trap').target, 'closestEnemy');
  assert.equal(params('puppet').repeatDefenseAgainst, 'initialCastingTotal');
  assert.deepEqual(params('somne').waking[7], ['damage']);
});

test('source omissions and contradictory labels remain visible instead of invented numbers', () => {
  assert.equal(magicInfo('somne').element, 'unspecified');
  assert.equal(magicInfo('supirre').element, 'unspecified');
  assert.equal(magicInfo('igni').area.angle, null);
  assert.equal(magicInfo('seirff-haul').duration.text, '2d10');
  assert.equal(magicInfo('seirff-haul').duration.unresolvedUnit, true);
  assert.equal(magicInfo('magic-screen').duration.conflictingText, true);
  assert.equal(magicInfo('stammelfords-earthquake').area.shape, 'unspecified');
  assert.match(magicInfo('invisible-ribbon').text, /Perception/);
  assert.equal(magicInfo('the-hex-of-shadows').defenseText, 'See casting rules');
});

test('healing and dispelling entries distinguish ordinary recovery from permanent restoration', () => {
  const healing = magicInfo('magic-healing');
  assert.equal(healing.cost.min, 5);
  assert.equal(healing.range.distance, 2);
  assert.equal(healing.duration.formula, '1d10');
  assert.equal(healing.effect.params.healPerRound, 3);
  assert.equal(healing.effect.params.criticalTreatment, true);
  assert.equal(magicInfo('healing-rest').effect.params.keepsPermanentInjury, true);
  assert.equal(magicInfo('miracle-of-lebioda').effect.params.removesPermanentInjury, true);
  assert.equal(magicInfo('feast-of-plenty').effect.params.treatsAllWounds, true);
  assert.equal(magicInfo('dispel').effect.params.costMultiplier, 0.5);
  assert.equal(magicInfo('dispel').cost.step, 0.5);
  assert.equal(magicInfo('dispel').range.distance, 10);
});

test('ritual and hex cards contain actionable reference details and correct cross-page provenance', () => {
  const barrier = magicItemData('magic-barrier');
  assert.equal(barrier.system.magic.ritual.dc, '18');
  assert.equal(barrier.system.magic.ritual.preparation, '10 Rounds');
  assert.match(barrier.system.description, /Fifth Essence \(x5\)/);
  assert.match(barrier.system.description, /Ritual Crafting DC/);
  assert.deepEqual(magicInfo('create-soul-beacon').pages, [132, 133]);
  assert.deepEqual(magicInfo('controlled-summoning').pages, [142, 143]);
  assert.equal(magicInfo('ritual-of-binding').ritual.greaterDemonDC, 27);
  assert.equal(magicInfo('hex-of-forgetfulness').hex.danger, 'high');
  assert.match(magicItemData('bones-of-glass').system.effectText, /Skull Fracture/);
});

test('catalog sources are unique, valid, and safe to turn into editable Items', () => {
  assert.equal(new Set(MAGIC.map((entry) => entry.key)).size, MAGIC.length);
  const documents = magicDocuments();
  assert.equal(new Set(documents.map((entry) => entry._id)).size, documents.length);
  for (const entry of MAGIC) {
    assert.match(entry.key, /^[a-z0-9-]+$/);
    assert.ok(entry.page > 0 && entry.page < 350);
    assert.ok(entry.text.length > 30);
    assert.ok(entry.cost.text || (Number.isFinite(entry.cost.min) && Number.isFinite(entry.cost.max)));
    assert.ok(entry.range.text && entry.duration.text);
    assert.ok(Array.isArray(entry.defenses));
    assert.ok(entry.effect.key);
  }
  const original = structuredClone(magicInfo('somne'));
  const item = magicItemData('somne');
  item.system.magic.cost.options.pop();
  item.system.magic.effect.params.waking[7].push('noise');
  assert.deepEqual(magicInfo('somne'), original);
  assert.equal(item.type, 'magic');
  assert.equal(item.system.weight, 0);
  assert.equal(item.system.carried, false);
  assert.equal(magicInfo('not-in-the-books'), null);
  assert.throws(() => magicItemData('not-in-the-books'), /known magic entry/);
});

test('build output matches committed sources and is reproducible without the private books', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'witcher-magic-catalog-'));
  try {
    const output = await buildMagic(root);
    for (const [kind, pack] of Object.entries(MAGIC_PACKS)) {
      const generated = JSON.parse(await readFile(path.join(root, 'data/witcher', `${pack}.json`), 'utf8'));
      const committed = JSON.parse(
        await readFile(new URL(`../../data/witcher/${pack}.json`, import.meta.url), 'utf8')
      );
      assert.deepEqual(generated, magicDocuments(kind));
      assert.deepEqual(committed, generated);
      assert.deepEqual(output[pack], generated);
    }
    assert.throws(() => magicDocuments('undefined-kind'), /Unknown magic kind/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
