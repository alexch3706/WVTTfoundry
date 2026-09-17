import { trophyRulesFor } from './magic-trophies.js';
import { alchemyProcChance } from './alchemy-combat-rules.js';
/** Pure, contextual rules for persisted spell modifiers. No Foundry documents,
 * random rolls, clock reads, or writes occur here. See docs/witcher/magic-effect-hooks.md.
 *
 * Persist the original modifier operation at effect.magic.operation. Consumers
 * must install EVERY named site before advertising a rule as automated.
 */
const copy = (value) => structuredClone(value);
const finite = (value, fallback = 0) => (Number.isFinite(Number(value)) ? Number(value) : fallback);
const unique = (values) => [...new Set(values)];
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

export const MAGIC_HOOK_SITES = Object.freeze({
  modifiers: 'combinedModifiers/skillBase: replace the effects-only modifier accumulation',
  derived: 'derivedStats: apply base overrides before derivation and penalty exemptions before division',
  skill: 'skillBase: choose substitution and contextual bonuses before the roll',
  attack: 'combat attack: validate action and add contextual attack bonus',
  defense: 'combat defense: filter parry and add contextual defense bonus',
  ablation: 'combat damage/block: scale both armor SP and weapon/shield REL wear',
  casting: 'validateCasting/magicSpending: restrictions, effective focus and next-spell benefits',
  castingCommit: 'magic cast transaction: consume Empower only when the cast commits',
  damage: 'damage resolution: resistance before location multiplier; HP floor after total damage',
  damageCommit: 'damage transaction: consume Silverlight protection and end Cloak on an attack hit',
  healing: 'every HP recovery entry point: apply healing prohibition before mutation',
  recovery: 'Recovery action: validate before action expenditure',
  condition: 'every condition application: consult immunity, not just condition display',
  movement: 'movement/run/glide/fall action validation and distance computation',
  environment: 'environment and suffocation resolution: consult protections',
  ignition: 'ignition roll: adjust an existing positive chance or open-flame exposure',
  roll: 'all non-skill rolls: add all-roll bonuses once, including damage rolls',
  action: 'all action declarations: enforce movement-only or hostility restrictions',
  perception: 'awareness/vision: resolve detection and illusion visibility',
  effectChance: 'spell effects and weapon on-hit effects: apply chance bonuses before rolling',
});

// These are complete pure decisions. Passing a site asserts that its consumer
// actually obeys the result; an unintegrated helper is never enough for promotion.
export const MAGIC_RULE_HOOKS = Object.freeze({
  preventHPRecovery: ['healing'],
  empoweredMelee: ['attack', 'defense', 'ablation'],
  immuneToKnockdown: ['condition', 'movement'],
  swimming: ['derived', 'attack', 'defense', 'movement'],
  breatheWaterAndAir: ['environment'],
  immuneToFear: ['condition'],
  glide: ['movement', 'damage'],
  breathableAir: ['environment'],
  cleanAir: ['environment'],
  weatherProtection: ['environment'],
  fireDamageAdjustment: ['damage'],
  flammable: ['ignition'],
  harmlessFire: ['damage', 'ignition'],
  skillSubstitution: ['skill'],
  invisibility: ['skill', 'attack', 'defense', 'damageCommit', 'perception'],
  negateInvisibility: ['skill', 'attack', 'defense', 'perception'],
  bastionRestrictions: ['derived', 'action', 'movement'],
  noRecoveryAction: ['recovery'],
  resistance: ['damage'],
  sunlightVulnerabilityMultiplier: ['environment'],
  silverlight: ['derived', 'damage', 'damageCommit'],
  focusMinimum: ['casting'],
  statOverride: ['derived'],
  unhinderedUnderwaterActions: ['attack', 'defense', 'movement'],
  extremeHeatImmunity: ['environment'],
  conditionImmunity: ['condition', 'environment'],
  attackEffectChance: ['effectChance'],
  empowerNextSpell: ['casting', 'castingCommit', 'effectChance', 'damage'],
  castingPermission: ['casting'],
  seeThroughIllusions: ['perception'],
});

/** Never call with all sites merely because this module exports them. */
export function supportedMagicRules(installedSites = []) {
  const sites = new Set(installedSites);
  return Object.entries(MAGIC_RULE_HOOKS)
    .filter(([, required]) => required.every((site) => sites.has(site)))
    .map(([key]) => key);
}

/** @returns {{effectId:string,effect:object,operation:object,rule:object|null}[]} */
export function magicRuleEntries(state = {}) {
  const rows = [];
  for (const effect of state.effects ?? []) {
    if (effect.disabled || effect.magic?.suppressed || effect.magic?.expired) continue;
    const operations = effect.magic?.operations ?? (effect.magic?.operation ? [effect.magic.operation] : []);
    for (const operation of operations) {
      // Do not recursively apply future onHit/save/active-action operations now.
      if (operation?.type !== 'modifier') continue;
      rows.push({ effectId: effect.id ?? effect._id ?? '', effect, operation, rule: operation.rule ?? null });
    }
  }
  return rows;
}

function matching(state, key) {
  return magicRuleEntries(state).filter((entry) => entry.rule?.key === key);
}
function predicate(operation, context, unresolved) {
  if (!operation.predicate) return true;
  const value = context.predicates?.[operation.predicate];
  if (typeof value !== 'boolean') {
    unresolved.push(operation.predicate);
    return false;
  }
  return value;
}
function merge(out, modifiers) {
  for (const [key, value] of Object.entries(modifiers ?? {})) {
    if (!Number.isFinite(value)) continue;
    if (key === 'headMultiplier') out[key] = Math.max(out[key] ?? 0, value);
    else if (key.endsWith('Multiplier')) out[key] = (out[key] ?? 1) * value;
    else out[key] = (out[key] ?? 0) + value;
  }
}

/** Only safe unconditional values belong in the existing effect.modifiers map. */
export function unconditionalMagicModifiers(operation = {}) {
  if (operation.predicate || operation.minimumOriginalSkillRank !== undefined || operation.usesPerDay)
    return {};
  return Object.fromEntries(
    Object.entries(operation.modifiers ?? {}).filter(([, value]) => Number.isFinite(value))
  );
}

/** Replaces, rather than supplements, the existing loop over effect.modifiers.
 * Includes ordinary potion/mutagen effects so existing behavior is retained.
 * Predicate values must come from authoritative action context, not spell data.
 */
export function magicModifierSummary(state = {}, context = {}) {
  const modifiers = {},
    traits = {},
    unresolved = [],
    applicableEffectIds = [];
  let initiativeBonus = 0,
    nonSkillRollBonus = 0,
    visionRange = null;
  for (const effect of state.effects ?? []) {
    if (effect.disabled || effect.magic?.suppressed || effect.magic?.expired) continue;
    if (
      (effect.alchemy || effect.potion) &&
      effect.expires &&
      effect.expires <= (globalThis.game?.time?.worldTime ?? 0)
    )
      continue;
    const entries = magicRuleEntries({ effects: [effect] });
    if (!entries.length) {
      const ordinary = { ...effect.modifiers };
      // Legacy Thunderbolt used generic damage; the accepted attack now snapshots it.
      if (effect.alchemy?.key === 'thunderbolt' || effect.key === 'Thunderbolt') {
        delete ordinary.damage;
        delete ordinary.physicalDamage;
      }
      merge(modifiers, ordinary);
      continue;
    }
    for (const { operation } of entries) {
      if (!predicate(operation, context, unresolved)) continue;
      if (operation.minimumOriginalSkillRank !== undefined) {
        const keys = Object.keys(operation.modifiers ?? {});
        if (!keys.every((key) => finite(state.skills?.[key]) >= operation.minimumOriginalSkillRank)) continue;
      }
      if (operation.usesPerDay) {
        if (context.dayKey === undefined) {
          unresolved.push('dayKey');
          continue;
        }
        const use = effect.magic?.dailyUse;
        if (use?.dayKey === context.dayKey && finite(use.count) >= operation.usesPerDay) continue;
        if (context.useLimitedBonus !== true) continue;
      }
      merge(modifiers, operation.modifiers);
      Object.assign(traits, operation.traits ?? {});
      initiativeBonus += finite(operation.initiativeBonus);
      // allActions already enters skill rolls. This field is exclusively for
      // damage/initiative/save/other rolls that do not go through skillBase.
      nonSkillRollBonus += finite(operation.allRollsBonus);
      if (Number.isFinite(operation.visionRange))
        visionRange = Math.min(visionRange ?? Infinity, operation.visionRange);
      applicableEffectIds.push(effect.id ?? effect._id ?? '');
    }
  }
  return {
    modifiers,
    traits,
    initiativeBonus,
    nonSkillRollBonus,
    visionRange,
    unresolved: unique(unresolved),
    applicableEffectIds: unique(applicableEffectIds),
  };
}

/** Overrides are applied BEFORE derived stats. Base adjustments transfer the
 * exact temporary bonus out of mods and into base, never adding it twice. */
export function magicDerivedRules(state = {}, context = {}) {
  const statOverrides = {},
    statCaps = {},
    baseAdjustments = {},
    derivedBonuses = {};
  let ignoreWoundPenalties = false,
    ignoreDeathPenalties = false;
  for (const { operation, rule } of magicRuleEntries(state)) {
    if (operation.affectsDerived)
      for (const [key, value] of Object.entries(operation.modifiers ?? {}))
        if (Number.isFinite(value)) baseAdjustments[key] = finite(baseAdjustments[key]) + value;
    if (operation.derivedOverrides) Object.assign(derivedBonuses, operation.derivedOverrides);
    if (rule?.key === 'statOverride') statOverrides[rule.stat] = rule.value;
    if (rule?.key === 'swimming' && (context.swimming ?? state.environment?.underwater))
      statOverrides.spd = rule.spdOverride;
    if (rule?.key === 'bastionRestrictions') statCaps.spd = Math.min(statCaps.spd ?? Infinity, rule.maxSPD);
    if (rule?.key === 'silverlight') {
      ignoreWoundPenalties ||= !!rule.ignoreWoundThresholdPenalties;
      ignoreDeathPenalties ||= !!rule.ignoreDeathStatePenalties;
    }
  }
  return {
    statOverrides,
    statCaps,
    baseAdjustments,
    derivedBonuses,
    ignoreWoundPenalties,
    ignoreDeathPenalties,
  };
}

/** Light Feet's printed +15 Run/+3 Leap is a single benefit, including custom
 * derived overrides. Call after ordinary derivation with a second derivation
 * that omits ONLY the Light Feet SPD bonus; ordinary users never add twice. */
export function magicMovementDerived(state, derived, withoutMovementBonus = null) {
  const rows = magicRuleEntries(state).filter(({ operation }) => operation.avoidDoubleDerivation);
  if (!rows.length) return copy(derived);
  if (!withoutMovementBonus)
    throw new TypeError('A derivation without the movement spell SPD bonus is required.');
  const next = copy(derived);
  next.run =
    withoutMovementBonus.run +
    rows.reduce((sum, row) => sum + finite(row.operation.derivedOverrides?.runBonus), 0);
  next.leap =
    withoutMovementBonus.leap +
    rows.reduce((sum, row) => sum + finite(row.operation.derivedOverrides?.leapBonus), 0);
  return next;
}

function visibility(state, context) {
  const cloaks = matching(state, 'invisibility');
  const negated = matching(state, 'negateInvisibility').length > 0 || context.invisibilityNegated === true;
  if (!cloaks.length || negated)
    return { invisible: false, stealth: 0, attack: 0, defense: 0, endsOnHit: [] };
  let stealth = 0,
    attack = 0,
    defense = 0;
  for (const { rule } of cloaks) {
    const partial =
      context.partialVisibility === true ||
      rule.partialVisibility?.causes?.some((key) => context.visibilityCauses?.includes(key));
    const profile = partial ? rule.partialVisibility : context.detected === true ? rule.afterDetection : rule;
    stealth = Math.max(stealth, finite(profile.stealthBonus, rule.stealthBonus));
    attack = Math.max(attack, finite(profile.attackBonus));
    defense = Math.max(defense, finite(profile.defenseBonus));
  }
  return {
    invisible: true,
    stealth,
    attack,
    defense,
    endsOnHit: cloaks.filter(({ rule }) => rule.endsOnHit).map(({ effectId }) => effectId),
  };
}

/** A substitution changes the WHOLE skill check, including its statistic. */
export function magicSkillRules(state, skill, context = {}) {
  const unresolved = [],
    substitutions = [];
  for (const { rule, effectId } of magicRuleEntries(state)) {
    if (rule?.key !== 'skillSubstitution' || rule.skill !== skill) continue;
    if (predicate(rule, context, unresolved)) substitutions.push({ skill: rule.substitute, effectId });
  }
  const bonuses = magicModifierSummary(state, context),
    hidden = visibility(state, context);
  return {
    substitutions,
    bonus: skill === 'stealth' ? hidden.stealth : 0,
    seeThroughIllusions: matching(state, 'seeThroughIllusions').length > 0,
    traits: bonuses.traits,
    visionRange: bonuses.visionRange,
    unresolved: unique([...unresolved, ...bonuses.unresolved]),
  };
}

export function magicAttackRules(state, context = {}) {
  const hidden = visibility(state, context),
    isMelee = context.melee === true;
  const empowered = isMelee ? matching(state, 'empoweredMelee') : [];
  const underwater = !!(context.underwater ?? state.environment?.underwater);
  const swimming = matching(state, 'swimming').some(({ rule }) => rule.ignoreUnderwaterAttackPenalty);
  const unhindered = matching(state, 'unhinderedUnderwaterActions').length > 0;
  const action = magicActionRules(state, { ...context, action: 'attack' });
  return {
    bonus: hidden.attack,
    invisible: hidden.invisible,
    cannotBeParried: empowered.some(({ rule }) => rule.cannotBeParried),
    ablationMultiplier: Math.max(
      trophyRulesFor(state).ablationMultiplier ?? 1,
      ...empowered.map(({ rule }) => finite(rule.ablationMultiplier, 1))
    ),
    ignoreUnderwaterPenalty: underwater && (swimming || unhindered),
    blocked: action.blocked,
    reasons: action.reasons,
  };
}

export function magicDefenseRules(state, context = {}) {
  const hidden = visibility(state, context),
    underwater = !!(context.underwater ?? state.environment?.underwater);
  return {
    bonus: hidden.defense,
    canParry: !context.attackRules?.cannotBeParried,
    ignoreUnderwaterPenalty:
      underwater &&
      (matching(state, 'swimming').some(({ rule }) => rule.ignoreUnderwaterDefensePenalty) ||
        matching(state, 'unhinderedUnderwaterActions').length > 0),
  };
}

export function magicActionRules(state, context = {}) {
  const reasons = [];
  for (const { rule } of magicRuleEntries(state)) {
    if (
      rule?.key === 'bastionRestrictions' &&
      !['move', 'singleMovementAction', 'endMagic', 'maintain'].includes(context.action)
    )
      reasons.push('Elgan’s Bastion permits only one Movement Action on the actor’s turn.');
    if (
      rule?.key === 'bastionRestrictions' &&
      ['move', 'singleMovementAction'].includes(context.action) &&
      context.movementActionsUsed > 0
    )
      reasons.push('Elgan’s Bastion permits only one Movement Action.');
    if (rule?.key === 'noRecoveryAction' && context.action === 'recover')
      reasons.push('This magic prevents the Recovery Action.');
  }
  return { blocked: reasons.length > 0, reasons };
}

export function magicCastingRules(state, context = {}) {
  const reasons = [],
    unresolved = [],
    consumeOnCommit = [],
    extraDamage = [];
  let focusMinimum = 0,
    bonus = Number(
      context.element &&
        trophyRulesFor(state, context).elementalCasting?.element === context.element &&
        ['spell', 'sign'].includes(context.kind)
        ? trophyRulesFor(state).elementalCasting.bonus
        : 0
    ),
    effectChance = null,
    fumbleSeverity = 0;
  for (const { rule, effectId } of magicRuleEntries(state)) {
    if (rule?.key === 'focusMinimum') focusMinimum = Math.max(focusMinimum, finite(rule.value));
    if (rule?.key === 'castingPermission') {
      const allowed =
        context.permittedEffectIds?.includes(effectId) ||
        context.initiallyResistedEffectIds?.includes(effectId) ||
        context.permissions?.[effectId] === true;
      if (!allowed)
        reasons.push(
          'This caster has no permission or successful initial defense against the anti-magic field.'
        );
    }
    // Partial decisions are still useful, but silenced/suppressMagic are NOT in
    // the support manifest: their repeat-defense/item-suppression hooks are separate.
    if (
      rule?.key === 'silenced' &&
      rule.noMagicIfTraditions?.includes(context.tradition) &&
      finite(context.spellCastingRank, state.skills?.spellCasting) < rule.spellCastingBelow
    )
      reasons.push('Hold Tongue prevents this caster’s spoken magic.');
    if (rule?.key === 'empowerNextSpell' && context.kind === 'spell') {
      bonus += finite(rule.castingBonus);
      if (rule.effectChance !== undefined) effectChance = Math.max(effectChance ?? 0, rule.effectChance);
      if (rule.extraDamage && context.damaging === true) extraDamage.push(rule.extraDamage);
      if (rule.extraDamage && context.damaging === undefined) unresolved.push('damaging');
      if (context.naturalDie === 1)
        fumbleSeverity = Math.max(fumbleSeverity, finite(rule.naturalOneFumbleSeverity));
      if (rule.consumeOnNextCast) consumeOnCommit.push(effectId);
    }
  }
  return {
    blocked: reasons.length > 0,
    reasons,
    focusMinimum,
    focus: Math.max(finite(context.focus), focusMinimum),
    bonus,
    effectChance,
    extraDamage,
    fumbleSeverity,
    consumeOnCommit: unique(consumeOnCommit),
    unresolved: unique(unresolved),
  };
}

export function magicRecoveryRules(state, context = {}) {
  const compressedDead =
    !!(state.flags ?? state.parent?.flags)?.['witcher-rilerena']?.artifactCompression?.active &&
    state.hp?.value <= 0;
  const blocked =
    compressedDead ||
    matching(state, 'preventHPRecovery').some(({ rule }) =>
      context.source === 'magical' ? rule.magical : rule.natural
    );
  const action = magicActionRules(state, { ...context, action: context.action ?? '' });
  return {
    hpAllowed: !blocked,
    hpAmount: blocked ? 0 : Math.max(0, finite(context.amount)),
    actionAllowed: !action.blocked,
    reasons: [
      ...(blocked
        ? [
            compressedDead
              ? 'A killed compressed creature cannot be revived by ordinary healing.'
              : 'Brand of Withering prevents HP recovery.',
          ]
        : []),
      ...action.reasons,
    ],
  };
}

const conditionAliases = Object.freeze({
  knockdown: 'prone',
  knockedDown: 'prone',
  stagger: 'staggered',
  stun: 'stunned',
  hallucination: 'hallucinating',
  nauseated: 'nausea',
});
export function magicConditionRules(state, condition, context = {}) {
  const key = conditionAliases[condition] ?? condition;
  const sources = [];
  for (const { rule, effectId } of magicRuleEntries(state)) {
    if (
      rule?.key === 'conditionImmunity' &&
      rule.conditions?.some((value) => (conditionAliases[value] ?? value) === key)
    )
      sources.push(effectId);
    if (rule?.key === 'immuneToKnockdown' && key === 'prone' && context.voluntary !== true)
      sources.push(effectId);
    if (rule?.key === 'immuneToFear' && ['fear', 'frightened'].includes(key)) sources.push(effectId);
  }
  const trophy = trophyRulesFor(state);
  if (trophy.immunities.includes(key)) sources.push(`trophy:${trophy.itemId}`);
  return { condition: key, immune: sources.length > 0, sources: unique(sources) };
}

export function magicIgnitionChance(state, chance, context = {}) {
  let value = clamp(finite(chance), 0, 100);
  const sources = [];
  for (const { rule, effectId } of magicRuleEntries(state)) {
    if (
      rule?.key === 'harmlessFire' &&
      context.fireId === rule.fireId &&
      context.separateAttack !== true &&
      rule.noSpread
    ) {
      if (context.spread === true) return { chance: 0, sources: [effectId] };
    }
    if (rule?.key !== 'flammable') continue;
    if ((value > 0 && rule.positiveIgnitionChanceBecomes) || (context.openFlame && rule.openFlameIgnites)) {
      value = 100;
      sources.push(effectId);
    }
  }
  value = Math.max(0, value - (trophyRulesFor(state).ignitionChanceReduction ?? 0));
  if (magicConditionRules(state, 'fire').immune) value = 0;
  return { chance: value, sources };
}

export function magicAttackEffectChance(state, effect, baseChance = 0, context = {}) {
  let chance = clamp(finite(baseChance), 0, 100);
  const unresolved = [];
  for (const { rule } of magicRuleEntries(state)) {
    if (rule?.key === 'attackEffectChance' && rule.effect === effect && predicate(rule, context, unresolved))
      chance += finite(rule.additionalChance);
  }
  // Empower changes an existing spell effect's chance; it creates no new effect.
  if (context.spell && baseChance > 0 && Number.isFinite(context.castingRules?.effectChance))
    chance = Math.max(chance, context.castingRules.effectChance);
  return { chance: alchemyProcChance(state, effect, clamp(chance, 0, 100)), unresolved: unique(unresolved) };
}

/** Resistance is a boolean category, not another stacked factor: OR it with
 * armor/innate resistance, then halve once. Silverlight is applied AFTER damage.
 * The returned protectionEffectId must be consumed in the HP transaction.
 */
export function magicDamageRules(state, context = {}) {
  let resistant =
      !!trophyRulesFor(state).resistance && trophyRulesFor(state).resistance === context.damageType,
    preventDamage = false,
    adjustment = 0;
  const sources = [];
  for (const { rule, effectId } of magicRuleEntries(state)) {
    if (
      rule?.key === 'resistance' &&
      (rule.damageSources === 'all' ||
        rule.damageSources?.includes(context.damageType) ||
        rule.damageSources?.includes(context.element))
    ) {
      resistant = true;
      sources.push(effectId);
    }
    if (
      rule?.key === 'glide' &&
      context.source === 'falling' &&
      context.activeAtLanding === true &&
      rule.negateFallingDamageIfActiveAtLanding
    )
      preventDamage = true;
    if (
      rule?.key === 'harmlessFire' &&
      context.fireId === rule.fireId &&
      context.separateAttack !== true &&
      context.source === 'fireContact' &&
      rule.noContactDamage
    )
      preventDamage = true;
    if (rule?.key === 'fireDamageAdjustment' && context.fireId === rule.fireId)
      adjustment += finite(rule.amount);
  }
  const protection =
    Number.isFinite(context.hpAfter) && context.hpAfter < 1
      ? matching(state, 'silverlight').find(
          ({ rule, effect }) => finite(effect.magic?.preventDeathUsed) < finite(rule.preventDeathUses)
        )
      : null;
  return {
    resistant,
    resistanceMultiplier: resistant || context.alreadyResistant ? 0.5 : 1,
    preventDamage,
    adjustment,
    sources: unique(sources),
    hpAfter: protection ? 1 : context.hpAfter,
    protectionEffectId: protection?.effectId ?? null,
    endOnAttackHit: context.attackHit === true ? visibility(state, context).endsOnHit : [],
  };
}

export function magicMovementRules(state, context = {}) {
  const derived = magicDerivedRules(state, context),
    reasons = [];
  let ignoreUnderwaterPenalty = matching(state, 'unhinderedUnderwaterActions').length > 0;
  let maximumGlideHorizontal = null;
  for (const { rule } of magicRuleEntries(state)) {
    if (rule?.key === 'glide' && Number.isFinite(context.verticalDescent))
      maximumGlideHorizontal = Math.max(
        maximumGlideHorizontal ?? 0,
        Math.max(0, context.verticalDescent) * rule.horizontalPerVertical
      );
  }
  const action = magicActionRules(state, { ...context, action: context.action ?? 'move' });
  reasons.push(...action.reasons);
  return {
    blocked: reasons.length > 0,
    reasons,
    ignoreUnderwaterPenalty,
    speedOverride: derived.statOverrides.spd ?? null,
    speedCap: derived.statCaps.spd ?? null,
    maximumGlideHorizontal,
    immuneToKnockdown: magicConditionRules(state, 'prone').immune,
  };
}

export function magicEnvironmentRules(state, context = {}) {
  let breathable = false,
    cleanAir = false,
    immuneToHeat = false,
    sunlightPenaltyMultiplier = 1;
  const protections = new Set(),
    sources = [];
  for (const { rule, effectId } of magicRuleEntries(state)) {
    if (rule?.key === 'breatheWaterAndAir' && context.medium === 'water') {
      breathable = true;
      sources.push(effectId);
    }
    if (rule?.key === 'breathableAir') {
      breathable = true;
      sources.push(effectId);
    }
    if (rule?.key === 'cleanAir') {
      cleanAir = true;
      (rule.removes ?? []).forEach((key) => protections.add(key));
    }
    if (rule?.key === 'weatherProtection') (rule.conditions ?? []).forEach((key) => protections.add(key));
    if (rule?.key === 'extremeHeatImmunity') immuneToHeat = true;
    if (rule?.key === 'conditionImmunity') (rule.conditions ?? []).forEach((key) => protections.add(key));
    if (rule?.key === 'sunlightVulnerabilityMultiplier')
      sunlightPenaltyMultiplier = Math.max(sunlightPenaltyMultiplier, finite(rule.multiplier, 1));
  }
  immuneToHeat ||= protections.has('extremeHeat');
  const blockedSuffocation = ['drowning', 'airless'].includes(context.cause)
    ? breathable
    : ['smoke', 'airbornePoison', 'taintedAir'].includes(context.cause) && protections.has(context.cause);
  return {
    breathable,
    cleanAir,
    immuneToHeat,
    protections: [...protections],
    blockedSuffocation,
    sunlightPenaltyMultiplier,
    sources: unique(sources),
  };
}

/** Transaction-ready state only; caller persists with its normal rollback and
 * condition-ownership mechanism. Never blindly replace source-linked conditions.
 */
export function magicEffectCommit(state, { consume = [], protectionEffectId = null, end = [] } = {}) {
  const removed = new Set([...consume, ...end]);
  const effects = copy(state.effects ?? []).filter((effect) => !removed.has(effect.id ?? effect._id));
  if (protectionEffectId) {
    const effect = effects.find((row) => (row.id ?? row._id) === protectionEffectId);
    if (!effect || !matching({ effects: [effect] }, 'silverlight').length)
      throw new TypeError('The Silverlight protection is no longer present.');
    const limit = matching({ effects: [effect] }, 'silverlight')[0].rule.preventDeathUses;
    if (finite(effect.magic.preventDeathUsed) >= finite(limit))
      throw new TypeError('Silverlight has already prevented death.');
    effect.magic.preventDeathUsed = finite(effect.magic.preventDeathUsed) + 1;
  }
  return { effects, removedEffectIds: [...removed] };
}

/** Rust's printed armor penalty is imposed once while ANY affected armor is
 * worn. SP/REL loss itself is owned by the world-item executor. */
export function magicEquipmentModifiers(items = [], { systemId = 'witcher-rilerena' } = {}) {
  const rusted = items.filter(
    (item) => item.type === 'armor' && (item.system ?? item).equipped && item.flags?.[systemId]?.rust
  );
  return {
    modifiers: rusted.length ? { ref: -2, dex: -2, spd: -2 } : {},
    rustedArmorIds: rusted.map((item) => item.id ?? item._id),
  };
}

export function magicWeaponModifiers(item, { systemId = 'witcher-rilerena' } = {}) {
  const rusted = ['weapon', 'shield'].includes(item?.type) && !!item?.flags?.[systemId]?.rust;
  return { attackBonus: rusted ? -2 : 0, reasons: rusted ? ['Rusting: attack −2.'] : [] };
}
