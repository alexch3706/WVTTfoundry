import { trophyBenefits } from './magic-gear-rules.js';

/** Always resolve the actual worn item and kill eligibility; effect labels alone grant nothing. */
export function trophyRulesFor(state = {}, context = {}) {
  const actor = state.parent?.items ? state.parent : null;
  const items = state.items ?? (actor ? [...actor.items] : []);
  return trophyBenefits(items, state.uuid ?? actor?.uuid ?? '', context);
}
export const TROPHY_INSTALLED_HOOKS = Object.freeze([
  'immunities',
  'ignitionChanceReduction',
  'elementalCasting',
  'ablationMultiplier',
  'chosenResistance',
  'selectionFrequency',
  'attackEffects',
  'armorNegatedDamage',
  'stunPenaltyReduction',
  'stunWithoutPenaltyBonus',
  'thrownRangeMultiplierBonus',
  'grappleVictimEscapeModifier',
  'criticalRolls',
  'chooseCriticalResult',
]);
