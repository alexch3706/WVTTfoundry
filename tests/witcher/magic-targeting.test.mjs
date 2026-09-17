import test from 'node:test';
import assert from 'node:assert/strict';
import { MAGIC } from '../../module/witcher/magic-catalog.js';
import {
  magicTargetingProfile,
  magicTargetingProfiles,
  validateMagicTargetCount,
} from '../../module/witcher/magic-targeting.js';

test('all180 catalog spells and invocations retain source provenance and targeting profiles', () => {
  const profiles = magicTargetingProfiles();
  assert.equal(profiles.length, 180);
  assert.equal(new Set(profiles.map((profile) => profile.key)).size, 180);
  for (const profile of profiles) {
    const magic = MAGIC.find((entry) => entry.key === profile.key);
    assert.equal(profile.source, magic.source);
    assert.equal(profile.page, magic.page);
    assert.ok(Number.isFinite(profile.rangeM) && profile.rangeM >= 0);
    assert.ok(
      ['self', 'actor', 'actors', 'area', 'object', 'point', 'effect', 'special'].includes(profile.targetMode)
    );
    assert.ok(profile.maxTargets === null || Number.isInteger(profile.maxTargets));
  }
});

test('Threads of Life selects every actor in a10m radius; single-target fire spells stay single', () => {
  const threads = magicTargetingProfile('threads-of-life');
  assert.equal(threads.targetMode, 'area');
  assert.equal(threads.origin, 'caster');
  assert.equal(threads.radiusM, 10);
  assert.equal(threads.selection, 'all');
  assert.equal(threads.maxTargets, null);
  assert.equal(threads.beneficiary, 'caster');
  for (const key of ['aenye', 'breath-of-fire']) {
    const profile = magicTargetingProfile(key);
    assert.equal(profile.targetMode, 'actor');
    assert.equal(profile.maxTargets, 1);
    assert.equal(profile.area.shape, 'none');
  }
});

test('the printed multi-target limits use their actual mode or caster skill', () => {
  assert.equal(
    magicTargetingProfile('presence-of-the-divine', { choices: { mode: 'presence' } }).actorSelf,
    true
  );
  assert.equal(
    magicTargetingProfile('presence-of-the-divine', { choices: { mode: 'fearImmunity' } }).maxTargets,
    6
  );
  assert.equal(magicTargetingProfile('silverlight').maxTargets, 5);
  assert.equal(magicTargetingProfile('sigil-of-the-hunt').maxTargets, 6);
  assert.equal(magicTargetingProfile('healing-rest', { spellCastingRank: 7 }).maxTargets, 7);
  const ice = magicTargetingProfile('tryferi-gaeaf', { spellCastingRank: 7 });
  assert.equal(ice.maxTargets, 3);
  assert.deepEqual(ice.projectiles, {
    count: 3,
    allocation: 'chosenTargets',
    repeatSameTarget: true,
    eachAttackSeparately: true,
  });
  assert.throws(() => validateMagicTargetCount(ice, ['one', 'one']), /distinct/);
  assert.throws(() => validateMagicTargetCount(ice, ['one', 'two', 'three', 'four']), /requires/);
});

test('line spells require actual intersection order and retain differing damage attenuation', () => {
  const alzur = magicTargetingProfile('alzurs-thunder', { choices: { lineWidth: 0.5 } });
  const spear = magicTargetingProfile('sagitta-aurea', { choices: { lineWidth: 0.5 } });
  assert.equal(alzur.area.shape, 'line');
  assert.equal(alzur.lineOrder, 'nearestFirst');
  assert.equal(alzur.damageDiceLostPerPriorTarget, 1);
  assert.equal(spear.damageDiceLostPerPriorTarget, 0);
  assert.equal(alzur.eachTargetDefends, true);
  assert.equal(validateMagicTargetCount(alzur, ['near', 'far']), true);
  assert.throws(
    () => validateMagicTargetCount(magicTargetingProfile('alzurs-thunder'), ['near']),
    /lineWidth/
  );
});

test('primary attacks and command areas do not become indiscriminate area damage', () => {
  const boulder = magicTargetingProfile('bekkers-rockslide');
  assert.equal(boulder.maxTargets, 1);
  assert.equal(boulder.area.shape, 'none');
  assert.equal(boulder.secondary[0].area.radius, 6);
  assert.deepEqual(boulder.secondary[0].save, { skill: 'athletics', dc: 16 });
  const wrath = magicTargetingProfile('wrath-of-nature', { choices: { terrain: 'shore' } });
  assert.equal(wrath.actorSelf, true);
  assert.equal(wrath.commandArea.radius, 60);
  assert.equal(wrath.area.shape, 'none');
  assert.equal(wrath.secondary[0].maximum, 2);
  assert.equal(wrath.secondary[0].rangeM, 20);
  assert.equal(wrath.secondary[0].projectiles, 2);
});

test('ambiguous geometries require a GM choice and alternate modes change target types', () => {
  assert.ok(
    magicTargetingProfile('retribution-of-the-raven').requiredChoices.some(
      (choice) => choice.key === 'radius'
    )
  );
  assert.ok(
    magicTargetingProfile('stammelfords-earthquake').requiredChoices.some(
      (choice) => choice.key === 'areaGeometry'
    )
  );
  assert.equal(
    magicTargetingProfile('hand-of-the-tempest', { choices: { mode: 'gust', coneAngle: 60 } }).area.angle,
    60
  );
  assert.equal(magicTargetingProfile('hand-of-the-tempest', { choices: { mode: 'launch' } }).maxTargets, 1);
  assert.equal(
    magicTargetingProfile('hand-of-the-tempest', { choices: { mode: 'manipulate' } }).targetMode,
    'object'
  );
  assert.equal(magicTargetingProfile('friend-to-wild-kind', { choices: { mode: 'calm' } }).rangeM, 5);
  assert.equal(
    magicTargetingProfile('friend-to-wild-kind', { choices: { mode: 'handleAnimals' } }).actorSelf,
    true
  );
});

test('existing crow bonding, object spells and self-beneficiary contradiction remain explicit', () => {
  const crows = magicTargetingProfile('conspiracy-of-the-mother');
  assert.equal(crows.targetMode, 'actors');
  assert.equal(crows.rangeM, 804.672);
  assert.equal(crows.maxTargets, 10);
  assert.deepEqual(crows.eligibility, ['crow']);
  assert.equal(crows.maximumBonded, 10);
  assert.equal(magicTargetingProfile('blessed-weapon').targetMode, 'object');
  const love = magicTargetingProfile('blessing-of-love');
  assert.equal(love.actorSelf, true);
  assert.match(love.notes[0], /despite/);
});
