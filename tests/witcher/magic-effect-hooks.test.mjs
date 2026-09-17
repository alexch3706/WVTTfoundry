import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAGIC_RULE_HOOKS,
  MAGIC_HOOK_SITES,
  supportedMagicRules,
  magicRuleEntries,
  unconditionalMagicModifiers,
  magicModifierSummary,
  magicDerivedRules,
  magicMovementDerived,
  magicSkillRules,
  magicAttackRules,
  magicDefenseRules,
  magicActionRules,
  magicCastingRules,
  magicRecoveryRules,
  magicConditionRules,
  magicIgnitionChance,
  magicAttackEffectChance,
  magicDamageRules,
  magicMovementRules,
  magicEnvironmentRules,
  magicEffectCommit,
  magicEquipmentModifiers,
  magicWeaponModifiers,
} from '../../module/witcher/magic-effect-hooks.js';
import { spellEffectPlan, supportProfiles, flattenOperations } from '../../module/witcher/magic-effects.js';

function effects(key, choices = {}, extra = {}) {
  const plan = spellEffectPlan(key, { castTotal: 24, choices, rolls: { duration: 3 }, ...extra });
  assert.equal(plan.ready, true, `${key}: ${JSON.stringify(plan.requirements)}`);
  return flattenOperations(plan.operations)
    .filter((operation) => operation.type === 'modifier')
    .map((operation, index) => ({
      id: `${key}:${index}`,
      modifiers: unconditionalMagicModifiers(operation),
      magic: { key, operation },
    }));
}
const state = (...rows) => ({ effects: rows.flat(), skills: {}, environment: {} });
const ruleEffect = (key, params = {}) => ({
  id: key,
  magic: { operation: { type: 'modifier', modifiers: {}, rule: { key, ...params } } },
});

test('rule support requires every installed consumer; empty installation promotes nothing', () => {
  assert.deepEqual(supportedMagicRules(), []);
  assert.deepEqual(supportedMagicRules(['healing']), ['preventHPRecovery']);
  assert.ok(!supportedMagicRules(['attack', 'defense']).includes('empoweredMelee'));
  assert.ok(supportedMagicRules(['attack', 'defense', 'ablation']).includes('empoweredMelee'));
  const printed = new Set(Object.values(supportProfiles()).flatMap((profile) => profile.requiredRules));
  for (const key of Object.keys(MAGIC_RULE_HOOKS)) assert.ok(printed.has(key), key);
  for (const sites of Object.values(MAGIC_RULE_HOOKS))
    for (const site of sites) assert.ok(MAGIC_HOOK_SITES[site], site);
  assert.ok(!supportedMagicRules(Object.keys(MAGIC_HOOK_SITES)).includes('silenced'));
  assert.ok(!supportedMagicRules(Object.keys(MAGIC_HOOK_SITES)).includes('disease'));
});

test('rule readers ignore disabled, suppressed, expired and nested future operations', () => {
  const active = ruleEffect('immuneToKnockdown');
  const nested = { id: 'future', magic: { operation: { type: 'item', onHit: active.magic.operation } } };
  assert.deepEqual(
    magicRuleEntries(
      state(
        active,
        { ...active, disabled: true },
        { ...active, magic: { ...active.magic, suppressed: true } },
        { ...active, magic: { ...active.magic, expired: true } },
        nested
      )
    ).map((row) => row.effectId),
    [active.id]
  );
});

test('numeric summary replaces the legacy loop and never counts persisted canonical modifiers twice', () => {
  const glamour = effects('glamour'),
    champion = effects('champion-of-the-river');
  const actor = state(glamour, champion, { id: 'potion', modifiers: { charisma: 2, staMultiplier: 0.75 } });
  const summary = magicModifierSummary(actor);
  assert.equal(summary.modifiers.charisma, 5);
  assert.equal(summary.modifiers.allActions, 5);
  assert.equal(summary.nonSkillRollBonus, 5);
  assert.equal(summary.modifiers.staMultiplier, 0.75);
});

test('contextual skill/stat modifiers are withheld unless their authoritative predicate is supplied', () => {
  const actor = state(effects('friend-to-wild-kind', { mode: 'handleAnimals' }));
  assert.deepEqual(actor.effects[0].modifiers, {});
  assert.deepEqual(magicModifierSummary(actor).unresolved, ['animalHandling']);
  assert.equal(
    magicModifierSummary(actor, { predicates: { animalHandling: false } }).modifiers.wildernessSurvival,
    undefined
  );
  assert.equal(
    magicModifierSummary(actor, { predicates: { animalHandling: true } }).modifiers.wildernessSurvival,
    3
  );
});

test('Divine Inspiration requires a learned skill, explicit use and an unused daily allowance', () => {
  const actor = state(effects('divine-inspiration', { skill: 'athletics' }));
  actor.skills.athletics = 0;
  assert.equal(
    magicModifierSummary(actor, { dayKey: 'day1', useLimitedBonus: true }).modifiers.athletics,
    undefined
  );
  actor.skills.athletics = 1;
  assert.deepEqual(magicModifierSummary(actor).unresolved, ['dayKey']);
  assert.equal(magicModifierSummary(actor, { dayKey: 'day1' }).modifiers.athletics, undefined);
  assert.equal(magicModifierSummary(actor, { dayKey: 'day1', useLimitedBonus: true }).modifiers.athletics, 2);
  actor.effects[0].magic.dailyUse = { dayKey: 'day1', count: 1 };
  assert.equal(
    magicModifierSummary(actor, { dayKey: 'day1', useLimitedBonus: true }).modifiers.athletics,
    undefined
  );
  assert.equal(magicModifierSummary(actor, { dayKey: 'day2', useLimitedBonus: true }).modifiers.athletics, 2);
});

test('Dark Mirror transfers its actual rolled statistic reductions into base derivation exactly once', () => {
  const actor = state(
    effects(
      'bekkers-dark-mirror',
      { firstStat: 'body', secondStat: 'will', mirror: 'Item.mirror' },
      { rolls: { firstReduction: 3, secondReduction: 2 } }
    )
  );
  assert.deepEqual(magicDerivedRules(actor).baseAdjustments, { body: -3, will: -2 });
  assert.deepEqual(magicModifierSummary(actor).modifiers, { body: -3, will: -2 });
  // Integrator moves these amounts from mods to base, preserving the same total.
  const base = { body: 7, will: 7 },
    summary = magicModifierSummary(actor).modifiers;
  for (const [key, value] of Object.entries(magicDerivedRules(actor).baseAdjustments)) {
    base[key] += value;
    summary[key] -= value;
  }
  assert.equal(Math.floor((base.body + base.will) / 2) * 5, 20);
  assert.deepEqual(summary, { body: 0, will: 0 });
});

test('Light Feet grants printed +15 Run and +3 Leap once even with custom movement overrides', () => {
  const actor = state(effects('light-feet'));
  assert.equal(magicModifierSummary(actor).modifiers.spd, 5);
  const result = magicMovementDerived(actor, { stats: { spd: 10 }, run: 60, leap: 12 }, { run: 30, leap: 6 });
  assert.equal(result.run, 45);
  assert.equal(result.leap, 9);
  assert.equal(result.stats.spd, 10);
  assert.throws(() => magicMovementDerived(actor, {}), /without the movement/);
});

test('Slip Stream changes swimming SPD and attack/defense penalties, without broad water immunity', () => {
  const actor = state(effects('slip-stream'));
  actor.environment.underwater = true;
  assert.equal(magicDerivedRules(actor).statOverrides.spd, 12);
  assert.equal(magicDerivedRules(actor, { swimming: false }).statOverrides.spd, undefined);
  assert.equal(magicAttackRules(actor, { melee: true }).ignoreUnderwaterPenalty, true);
  assert.equal(magicDefenseRules(actor).ignoreUnderwaterPenalty, true);
  assert.equal(magicMovementRules(actor).ignoreUnderwaterPenalty, false);
  assert.equal(
    magicEnvironmentRules(actor, { medium: 'water', cause: 'drowning' }).blockedSuffocation,
    false
  );
});

test('Blood of the Mountain prohibits melee parry and doubles SP/REL ablation without stacking itself', () => {
  const actor = state(effects('blood-of-the-mountain'), effects('blood-of-the-mountain'));
  const melee = magicAttackRules(actor, { melee: true });
  assert.equal(melee.cannotBeParried, true);
  assert.equal(melee.ablationMultiplier, 2);
  assert.equal(magicDefenseRules({}, { attackRules: melee }).canParry, false);
  assert.equal(magicAttackRules(actor, { melee: false }).ablationMultiplier, 1);
  assert.equal(magicAttackRules(actor, { melee: false }).cannotBeParried, false);
  assert.equal(magicConditionRules(actor, 'knockdown').immune, true);
  assert.equal(magicConditionRules(actor, 'prone', { voluntary: true }).immune, false);
});

test('condition immunity normalizes rule names without granting immunity to every social check', () => {
  const actor = state(
    ruleEffect('conditionImmunity', { conditions: ['stun', 'staggered', 'hallucinating', 'nauseated'] }),
    effects('presence-of-the-divine', { mode: 'fearImmunity' })
  );
  for (const key of ['stunned', 'stagger', 'hallucination', 'nausea'])
    assert.equal(magicConditionRules(actor, key).immune, true, key);
  assert.equal(magicConditionRules(actor, 'fear').immune, true);
  assert.equal(magicConditionRules(actor, 'intimidated').immune, false);
});

test('Cloak resolves individual detection, Yrden/Moondust partial visibility and ending on a hit', () => {
  const actor = state(effects('cloak'));
  assert.equal(magicSkillRules(actor, 'stealth').bonus, 10);
  assert.equal(magicAttackRules(actor).bonus, 5);
  assert.equal(magicDefenseRules(actor, { detected: true }).bonus, 3);
  assert.equal(magicSkillRules(actor, 'stealth', { detected: true }).bonus, 10);
  assert.equal(magicSkillRules(actor, 'stealth', { visibilityCauses: ['yrden'] }).bonus, 5);
  assert.equal(magicAttackRules(actor, { visibilityCauses: ['moondust'] }).bonus, 3);
  assert.deepEqual(magicDamageRules(actor, { attackHit: true }).endOnAttackHit, ['cloak:0']);
  assert.deepEqual(magicDamageRules(actor, { attackHit: false }).endOnAttackHit, []);
  actor.effects.push(ruleEffect('negateInvisibility'));
  assert.equal(magicSkillRules(actor, 'stealth').bonus, 0);
  assert.equal(magicDefenseRules(actor).bonus, 0);
});

test('Fergus and Herbalism offer whole-check substitutions only in their exact context', () => {
  const actor = state(effects('fergus-demise'), effects('herbalism'));
  assert.deepEqual(magicSkillRules(actor, 'intimidation').substitutions, []);
  assert.deepEqual(
    magicSkillRules(actor, 'intimidation', { predicates: { interrogateSelectedTarget: true } }).substitutions,
    [{ skill: 'spellCasting', effectId: 'fergus-demise:0' }]
  );
  assert.equal(
    magicSkillRules(actor, 'alchemy', { predicates: { plantOnlyElixirCraftingOrRecovery: true } })
      .substitutions[0].skill,
    'spellCasting'
  );
  assert.deepEqual(
    magicSkillRules(actor, 'charisma', { predicates: { interrogateSelectedTarget: true } }).substitutions,
    []
  );
});

test('Empower applies only to the next spell, preserves choice and makes a natural-one fumble severity ten', () => {
  for (const mode of ['chance', 'casting', 'damage']) {
    const actor = state(effects('empower', { mode }));
    const result = magicCastingRules(actor, { kind: 'spell', damaging: true, naturalDie: 1 });
    assert.deepEqual(result.consumeOnCommit, ['empower:0']);
    assert.equal(result.fumbleSeverity, 10);
    assert.equal(result.bonus, mode === 'casting' ? 2 : 0);
    assert.deepEqual(result.extraDamage, mode === 'damage' ? ['2d6'] : []);
    assert.equal(result.effectChance, mode === 'chance' ? 100 : null);
    assert.deepEqual(magicCastingRules(actor, { kind: 'invocation' }).consumeOnCommit, []);
    assert.deepEqual(magicCastingRules(actor, { kind: 'spell', damaging: false }).extraDamage, []);
  }
});

test('a totem supplies Focus 4 without stacking it onto a stronger held focus', () => {
  const actor = state(ruleEffect('focusMinimum', { value: 4 }));
  assert.equal(magicCastingRules(actor).focus, 4);
  assert.equal(magicCastingRules(actor, { focus: 2 }).focus, 4);
  assert.equal(magicCastingRules(actor, { focus: 5 }).focus, 5);
});

test('casting permissions are effect-specific and Hold Tongue preserves rank-seven and witcher casting', () => {
  const silenced = state(effects('hold-tongue'));
  assert.equal(magicCastingRules(silenced, { tradition: 'mage', spellCastingRank: 6 }).blocked, true);
  assert.equal(magicCastingRules(silenced, { tradition: 'mage', spellCastingRank: 7 }).blocked, false);
  assert.equal(magicCastingRules(silenced, { tradition: 'witcher', spellCastingRank: 3 }).blocked, false);
  const actor = state(ruleEffect('castingPermission'));
  assert.equal(magicCastingRules(actor).blocked, true);
  assert.equal(magicCastingRules(actor, { permittedEffectIds: ['unrelated'] }).blocked, true);
  assert.equal(
    magicCastingRules(actor, { initiallyResistedEffectIds: ['castingPermission'] }).blocked,
    false
  );
});

test('Brand of Withering blocks all HP healing and Blaze blocks Recovery before spending its action', () => {
  const actor = state(effects('brand-of-withering'));
  for (const source of ['natural', 'magical', 'alchemical']) {
    assert.equal(magicRecoveryRules(actor, { source, amount: 12 }).hpAmount, 0);
  }
  assert.equal(magicRecoveryRules(state(), { source: 'magical', amount: 12 }).hpAmount, 12);
  assert.equal(
    magicRecoveryRules(state(ruleEffect('noRecoveryAction')), { action: 'recover' }).actionAllowed,
    false
  );
});

test('magical resistance shares the ordinary resistance category and never quarters it again', () => {
  const actor = state(effects('champion-of-the-river'));
  assert.equal(
    magicDamageRules(actor, { damageType: 'slashing', alreadyResistant: true }).resistanceMultiplier,
    0.5
  );
  assert.equal(magicDamageRules(actor, { damageType: 'fire' }).resistant, true);
  const physical = state(
    ruleEffect('resistance', { damageSources: ['slashing', 'piercing', 'bludgeoning'] })
  );
  assert.equal(magicDamageRules(physical, { damageType: 'fire' }).resistant, false);
  assert.equal(magicDamageRules(physical, { damageType: 'piercing' }).resistant, true);
  assert.equal(magicDamageRules(state(), { alreadyResistant: true }).resistanceMultiplier, 0.5);
});

test('Silverlight prevents one lethal reduction while keeping penalty protection after consumption', () => {
  const actor = state(effects('silverlight'));
  const result = magicDamageRules(actor, { hpAfter: -12 });
  assert.equal(result.hpAfter, 1);
  assert.equal(result.protectionEffectId, 'silverlight:0');
  const committed = magicEffectCommit(actor, { protectionEffectId: result.protectionEffectId });
  assert.equal(actor.effects[0].magic.preventDeathUsed, undefined);
  assert.equal(magicDamageRules(committed, { hpAfter: -2 }).hpAfter, -2);
  assert.equal(magicDerivedRules(committed).ignoreWoundPenalties, true);
  assert.equal(magicDerivedRules(committed).ignoreDeathPenalties, true);
  assert.throws(
    () => magicEffectCommit(committed, { protectionEffectId: result.protectionEffectId }),
    /already/
  );
});

test('gliding requires the effect at landing; one horizontal meter is available per vertical meter', () => {
  const actor = state(effects('adenydd'));
  assert.equal(magicMovementRules(actor, { verticalDescent: 12 }).maximumGlideHorizontal, 12);
  assert.equal(magicDamageRules(actor, { source: 'falling', activeAtLanding: true }).preventDamage, true);
  assert.equal(magicDamageRules(actor, { source: 'falling', activeAtLanding: false }).preventDamage, false);
  assert.equal(magicDamageRules(actor, { source: 'attack', activeAtLanding: true }).preventDamage, false);
});

test('Harmless Fire protects only its chosen fire contact and never a separate fire attack', () => {
  const actor = state(
    effects('harmless-fire', { fire: 'fireA' }),
    effects('raise-flame', { fire: 'fireA', mode: 'intensify' })
  );
  assert.equal(magicDamageRules(actor, { source: 'fireContact', fireId: 'fireA' }).preventDamage, true);
  assert.equal(magicDamageRules(actor, { source: 'fireContact', fireId: 'fireB' }).preventDamage, false);
  assert.equal(
    magicDamageRules(actor, { source: 'fireContact', fireId: 'fireA', separateAttack: true }).preventDamage,
    false
  );
  assert.equal(magicDamageRules(actor, { fireId: 'fireA' }).adjustment, 1);
  assert.equal(magicDamageRules(actor, { fireId: 'fireB' }).adjustment, 0);
  assert.equal(magicIgnitionChance(actor, 50, { fireId: 'fireA', spread: true }).chance, 0);
});

test('Coating of Fire promotes positive ignition chances and open flames, but creates no unrelated ignition', () => {
  const actor = state(effects('coating-of-fire'));
  assert.equal(magicIgnitionChance(actor, 25).chance, 100);
  assert.equal(magicIgnitionChance(actor, 0).chance, 0);
  assert.equal(magicIgnitionChance(actor, 0, { openFlame: true }).chance, 100);
  actor.effects.push(ruleEffect('conditionImmunity', { conditions: ['fire'] }));
  assert.equal(magicIgnitionChance(actor, 25).chance, 0);
});

test('Taiga adds its printed 50 points and Empower promotes existing spell effects only', () => {
  const actor = state(
    ruleEffect('attackEffectChance', { effect: 'frozen', additionalChance: 50, predicate: 'chosenAlly' })
  );
  assert.equal(magicAttackEffectChance(actor, 'frozen', 25, { predicates: { chosenAlly: true } }).chance, 75);
  assert.equal(
    magicAttackEffectChance(actor, 'frozen', 75, { predicates: { chosenAlly: true } }).chance,
    100
  );
  assert.equal(magicAttackEffectChance(actor, 'fire', 25, { predicates: { chosenAlly: true } }).chance, 25);
  assert.deepEqual(magicAttackEffectChance(actor, 'frozen').unresolved, ['chosenAlly']);
  assert.equal(
    magicAttackEffectChance(state(), 'fire', 50, { spell: true, castingRules: { effectChance: 100 } }).chance,
    100
  );
  assert.equal(
    magicAttackEffectChance(state(), 'fire', 0, { spell: true, castingRules: { effectChance: 100 } }).chance,
    0
  );
});

test('water breathing does not prevent strangulation or poison, while clean air filters its named hazards', () => {
  const actor = state(effects('auroras-breath'));
  assert.equal(magicEnvironmentRules(actor, { medium: 'water', cause: 'drowning' }).blockedSuffocation, true);
  assert.equal(
    magicEnvironmentRules(actor, { medium: 'water', cause: 'strangulation' }).blockedSuffocation,
    false
  );
  assert.equal(magicEnvironmentRules(actor, { cause: 'airbornePoison' }).blockedSuffocation, false);
  const fresh = state(effects('freshen-air'));
  assert.equal(magicEnvironmentRules(fresh, { cause: 'airbornePoison' }).blockedSuffocation, true);
  assert.equal(magicEnvironmentRules(fresh, { cause: 'drowning' }).blockedSuffocation, false);
});

test('weather shelter and White Flame expose the precise environmental protections', () => {
  const actor = state(
    effects('uriens-shelter'),
    ruleEffect('sunlightVulnerabilityMultiplier', { multiplier: 2 })
  );
  const result = magicEnvironmentRules(actor);
  assert.equal(result.immuneToHeat, true);
  assert.deepEqual(result.protections, ['extremeHeat', 'extremeCold', 'rain', 'snow']);
  assert.equal(result.sunlightPenaltyMultiplier, 2);
});

test('Bastion caps SPD at two and permits a single movement plus ending/paying for the effect', () => {
  const actor = state(effects('elgans-bastion'));
  assert.equal(magicDerivedRules(actor).statCaps.spd, 2);
  assert.equal(magicMovementRules(actor).blocked, false);
  assert.equal(magicActionRules(actor, { action: 'move', movementActionsUsed: 1 }).blocked, true);
  for (const action of ['attack', 'cast', 'run', 'recover'])
    assert.equal(magicActionRules(actor, { action }).blocked, true, action);
  for (const action of ['move', 'endMagic', 'maintain'])
    assert.equal(magicActionRules(actor, { action }).blocked, false, action);
});

test('commit plans remove only named effects and leave source snapshots immutable', () => {
  const actor = state(effects('empower', { mode: 'casting' }), effects('cloak'), effects('silverlight'));
  const before = structuredClone(actor);
  const result = magicEffectCommit(actor, {
    consume: ['empower:0'],
    end: ['cloak:0'],
    protectionEffectId: 'silverlight:0',
  });
  assert.deepEqual(actor, before);
  assert.deepEqual(
    result.effects.map((effect) => effect.id),
    ['silverlight:0']
  );
  assert.deepEqual(result.removedEffectIds, ['empower:0', 'cloak:0']);
});

test('Rusting penalizes worn armor once and only attacks made with the rusted weapon', () => {
  const armor = {
    id: 'armorA',
    type: 'armor',
    system: { equipped: true },
    flags: { 'witcher-rilerena': { rust: { castId: 'rust' } } },
  };
  const second = { ...armor, id: 'armorB' };
  assert.deepEqual(magicEquipmentModifiers([armor, second]).modifiers, { ref: -2, dex: -2, spd: -2 });
  assert.deepEqual(magicEquipmentModifiers([{ ...armor, system: { equipped: false } }]).modifiers, {});
  const weapon = { ...armor, type: 'weapon' };
  assert.equal(magicWeaponModifiers(weapon).attackBonus, -2);
  assert.equal(magicWeaponModifiers({ ...weapon, flags: {} }).attackBonus, 0);
  assert.equal(magicWeaponModifiers(armor).attackBonus, 0);
});
