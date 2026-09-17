import test from 'node:test';
import assert from 'node:assert/strict';
import { MAGIC } from '../../module/witcher/magic-catalog.js';
import { CONDITIONS } from '../../module/witcher/config.js';
import {
  spellEffectPlan,
  plannedMagicKeys,
  requiredChoices,
  supportProfiles,
  keysForExecutorKinds,
  flattenOperations,
} from '../../module/witcher/magic-effects.js';

function completeInputs(key, overrides = {}) {
  const values = { castTotal: 25, choices: {}, rolls: {}, ...overrides };
  for (const field of requiredChoices(key)) {
    if (values.choices[field.key] !== undefined) continue;
    if (field.when && values.choices[field.when.key] !== field.when.equals) continue;
    let value =
      field.type === 'enum'
        ? field.options[0]
        : field.type === 'number'
          ? Math.max(field.min ?? 0, 1)
          : field.type === 'boolean'
            ? (field.mustEqual ?? false)
            : field.key;
    if (field.differentFrom && value === values.choices[field.differentFrom]) value = field.options[1];
    values.choices[field.key] = value;
  }
  for (let pass = 0; pass < 4; pass++) {
    const plan = spellEffectPlan(key, values);
    if (plan.ready) return { values, plan };
    for (const requirement of plan.requirements) {
      if (requirement.type === 'roll') values.rolls[requirement.key] = requirement.min ?? 1;
      else if (requirement.type === 'contextNumber')
        values[requirement.key] = Math.max(requirement.min ?? 0, Math.min(requirement.max ?? 10, 10));
      else throw new Error(`Incomplete fixture ${key}: ${JSON.stringify(requirement)}`);
    }
  }
  throw new Error(`Plan failed to become ready: ${key}`);
}

test('every one of the 180 spells and invocations has an individually registered plan', () => {
  const expected = MAGIC.filter((entry) => ['spell', 'invocation'].includes(entry.kind))
    .map((entry) => entry.key)
    .sort();
  assert.deepEqual(plannedMagicKeys().sort(), expected);
  const profiles = supportProfiles();
  assert.equal(Object.keys(profiles).length, 180);
  for (const key of expected) {
    const { plan } = completeInputs(key);
    assert.equal(plan.ready, true, key);
    assert.ok(plan.operations.length > 0, key);
    const kinds = new Set(profiles[key].requiredExecutorKinds);
    for (const operation of flattenOperations(plan.operations)) {
      assert.ok(kinds.has(operation.type), `${key}: undeclared ${operation.type}`);
      if (operation.type === 'condition')
        assert.ok(
          Object.hasOwn(CONDITIONS, operation.condition),
          `${key}: unknown condition ${operation.condition}`
        );
    }
  }
});

test('plans with missing decisions, casting context, or duration dice cannot partially apply', () => {
  const choices = spellEffectPlan('water-jet', { castTotal: 20 });
  assert.equal(choices.ready, false);
  assert.equal(choices.operations.length, 0);
  assert.ok(choices.requirements.some((entry) => entry.key === 'damageType'));
  const context = spellEffectPlan('cenlly-graig', { castTotal: 20 });
  assert.ok(context.requirements.some((entry) => entry.key === 'defenseTotal'));
  assert.deepEqual(context.operations, []);
  const duration = spellEffectPlan('glamour', { castTotal: 20 });
  assert.equal(duration.requirements[0].formula, '1d6');
  assert.deepEqual(duration.operations, []);
});

test('damage margins cap dice and Carys Hail remains one attack', () => {
  const stones = spellEffectPlan('cenlly-graig', { castTotal: 35, defenseTotal: 12 });
  assert.equal(stones.operations[0].formula, '10d6');
  const ice = spellEffectPlan('carys-hail', { castTotal: 18, defenseTotal: 15 });
  assert.equal(ice.operations[0].formula, '3d6');
  assert.equal(ice.operations[0].attacks, 1);
  assert.equal(ice.operations[1].chance, 25);
  const fire = spellEffectPlan('aenye', { castTotal: 20 });
  assert.equal(fire.operations[0].formula, '4d6');
  assert.equal(fire.operations[1].chance, 75);
});

test('critical healing consumes one treatment use and never restores ordinary HP or rolls its duration', () => {
  const plan = spellEffectPlan('magic-healing', {
    castTotal: 20,
    choices: { mode: 'critical', wound: 'wound-id' },
  });
  assert.equal(plan.ready, true);
  assert.equal(plan.operations.length, 1);
  assert.equal(plan.operations[0].type, 'restoreWound');
  assert.equal(plan.operations[0].hpHealing, 0);
  assert.equal(plan.operations[0].uses, 1);
  const hp = spellEffectPlan('magic-healing', {
    castTotal: 20,
    choices: { mode: 'hp' },
    rolls: { duration: 6 },
  });
  assert.equal(hp.duration.rounds, 6);
  assert.equal(hp.operations[0].amount, 3);
  assert.equal(hp.operations[0].timing, 'startTurn');
});

test('ordinary divine recovery retains permanent injuries while Miracle of Lebioda removes them', () => {
  const rest = completeInputs('healing-rest').plan;
  const recovery = rest.operations.find((entry) => entry.type === 'restoreWound');
  assert.equal(recovery.action, 'healTreatedWounds');
  assert.equal(recovery.preservePermanentPenalties, true);
  assert.equal(recovery.timing, 'expiry');
  const miracle = completeInputs('miracle-of-lebioda').plan.operations[0];
  assert.equal(miracle.removesPermanentConsequence, true);
  assert.equal(miracle.regrowsAnatomy, true);
  assert.equal(miracle.count, 1);
});

test('equipment and target choices enforce source constraints rather than silently substituting', () => {
  assert.throws(
    () =>
      spellEffectPlan('water-jet', { castTotal: 20, choices: { damageType: 'fire', waterSource: 'river' } }),
    /Invalid damageType/
  );
  assert.throws(
    () =>
      spellEffectPlan('feast-of-plenty', {
        castTotal: 20,
        choices: { servings: 20, allFoodLocallyGathered: false },
      }),
    /prerequisite/
  );
  assert.throws(
    () =>
      spellEffectPlan('bekkers-dark-mirror', {
        castTotal: 20,
        choices: { firstStat: 'body', secondStat: 'body', mirror: 'mirror' },
      }),
    /must differ/
  );
  assert.throws(() => spellEffectPlan('cursed-illness', { castTotal: 20, power: 3 }), /printed STA option/);
  assert.throws(() => spellEffectPlan('aenye', { castTotal: 20, power: 99 }), /printed STA range/);
  assert.throws(() => spellEffectPlan('glamour', { castTotal: 20, rolls: { duration: 99 } }), /dice range/);
});

test('wind and ice procedures retain special defenses, displacement, and penetrating-hit restrictions', () => {
  const gust = spellEffectPlan('bronwyns-gust', { castTotal: 24, defenseTotal: 17 });
  assert.equal(gust.operations[1].distance, 7);
  assert.equal(gust.operations[1].collision, 'ramming');
  const rock = spellEffectPlan('bekkers-rockslide', { castTotal: 24 });
  assert.deepEqual(rock.operations[0].defenses, ['reposition']);
  assert.equal(rock.operations[2].shape.radius, 6);
  const spikes = completeInputs('tryferi-gaeaf').plan.operations[0];
  assert.equal(spikes.attacks, 5);
  assert.equal(spikes.resolveEachSeparately, true);
  assert.equal(spikes.onPenetration[0].condition, 'frozen');
  assert.equal(spikes.onPenetration[2].hp, 20);
});

test('Ball Lightning uses Concussion and preserves its retry action and one-hit lifetime', () => {
  const orb = completeInputs('ball-lightning').plan.operations[0];
  assert.equal(orb.expiresOnFirstHit, true);
  assert.equal(orb.subsequentAttackAction, 'normal');
  assert.equal(orb.attacks[0].onHit.woundKey, 'difficult-4');
  assert.equal(orb.attacks[0].onHit.duration.seconds, 600);
});

test('each terrain mode is a distinct procedure and Wrath of Nature requires full-round actions', () => {
  for (const terrain of [
    'fields',
    'mountains',
    'underground',
    'forest',
    'swamp',
    'shore',
    'desert',
    'tundra',
  ]) {
    const plan = spellEffectPlan('wrath-of-nature', {
      castTotal: 24,
      spellCastingBase: 22,
      choices: { terrain },
    });
    assert.equal(plan.ready, true, terrain);
    assert.equal(plan.operations[0].shape.radius, 60);
    assert.equal(plan.operations[0].operations[0].rule.action, 'fullRound');
  }
  const forest = spellEffectPlan('wrath-of-nature', {
    castTotal: 24,
    spellCastingBase: 22,
    choices: { terrain: 'forest' },
  });
  assert.equal(forest.operations[0].operations[0].rule.operations[0].brawlingBase, 22);
});

test('registry support filtering requires specific rule, document-action, and recurring-event executors', () => {
  const types = ['damage', 'condition', 'modifier', 'item', 'zone'];
  assert.equal(keysForExecutorKinds(types).includes('brand-of-withering'), false);
  assert.equal(
    keysForExecutorKinds(types, { rules: ['preventHPRecovery'], triggers: ['beforeHealing'] }).includes(
      'brand-of-withering'
    ),
    true
  );
  assert.equal(keysForExecutorKinds(types, { actions: ['condition:add'] }).includes('aenye'), true);
  assert.equal(keysForExecutorKinds(types).includes('aenye'), false);
  const profiles = supportProfiles();
  assert.ok(profiles['druidic-totem'].requiredRules.includes('extremeHeatImmunity'));
  assert.ok(profiles['druidic-totem'].requiredRules.includes('statOverride'));
  assert.ok(profiles['wrath-of-nature'].requiredExecutorKinds.includes('shield'));
});

test('book ambiguities require explicit decisions and remain in the plan record', () => {
  const earthquake = spellEffectPlan('stammelfords-earthquake', { castTotal: 20 });
  assert.equal(earthquake.ready, false);
  assert.ok(earthquake.requirements.some((entry) => entry.key === 'athleticsDC' && entry.gm));
  const serpents = spellEffectPlan('seirff-haul', { castTotal: 20, choices: { durationRounds: 7 } });
  assert.equal(serpents.ready, true);
  assert.equal(serpents.duration.rounds, 7);
  assert.equal(serpents.adjudications[0].procedure, 'resolvePrintedDurationOmission');
});

test('necromancy and transformations retain hostile summons, injury transfer, and restoration exceptions', () => {
  const souls = spellEffectPlan('storm-of-souls', { castTotal: 20, rolls: { duration: 4, wraiths: 8 } });
  assert.equal(souls.operations[0].count, 8);
  assert.equal(souls.operations[0].controllable, false);
  assert.equal(souls.operations[0].mayAttackCasterAndAllies, true);
  const bear = spellEffectPlan('blood-of-the-berserker', { castTotal: 20 }).operations[0];
  assert.equal(bear.carryDamageAndWoundsBothWays, true);
  assert.equal(bear.minimumHPOnReturnIfDamageOtherwiseLethal, 1);
  assert.equal(bear.suppressMagic, true);
});
