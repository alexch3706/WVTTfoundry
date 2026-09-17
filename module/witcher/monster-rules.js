import { magicConditionRules, magicRecoveryRules } from './magic-effect-hooks.js';
import { alchemyImmuneTo } from './alchemy-combat-rules.js';
/** Pure creature rules from the Core Bestiary (printed pp.270–313). */
export const PHYSICAL_DAMAGE = ['slashing', 'piercing', 'bludgeoning'];
export function monsterEffect(state, key) {
  return state.effects?.find((effect) => effect.key === key);
}
export function suppressed(state, source) {
  return !!monsterEffect(state, source) || state.conditions?.includes(source);
}
export function isIncorporeal(state) {
  if (suppressed(state, 'Moondust') || suppressed(state, 'Yrden')) return false;
  return !!(state.traits?.alwaysIncorporeal || monsterEffect(state, 'Shift'));
}
export function immuneTo(state, type) {
  return (
    magicConditionRules(state, type).immune ||
    alchemyImmuneTo(state, type) ||
    state.immunities?.includes(type) ||
    (isIncorporeal(state) && [...PHYSICAL_DAMAGE, 'bleeding', 'poison'].includes(type)) ||
    (state.traits?.amphibious && type === 'suffocating')
  );
}
export function creatureRegeneration(state) {
  if (state.conditions?.includes('dead')) return 0;
  const t = state.traits ?? {};
  let points = Number(t.regeneration ?? 0);
  if (t.moondustStopsRegeneration && suppressed(state, 'Moondust')) points = 0;
  if (
    points &&
    t.sunlightRegeneration &&
    (['daylight', 'bright'].includes(state.environment?.light) ||
      state.effects?.some(
        (effect) =>
          effect.enhancement?.shiningDaylight &&
          !effect.disabled &&
          (!effect.expires || effect.expires > (globalThis.game?.time?.worldTime ?? 0))
      ))
  )
    points = t.sunlightRegeneration;
  if (t.furyThreshold && state.hp.value < t.furyThreshold) points += t.furyRegeneration;
  return magicRecoveryRules(state, { source: 'natural', amount: points }).hpAmount;
}
export function staminaCost(state, cost) {
  return state.traits?.infiniteStamina ? 0 : cost;
}
export function crushingForce(state) {
  return state.traits?.crushingForce && !suppressed(state, 'Dimeritium');
}
export function locationChoices(table) {
  return table.flatMap((l) => [
    l,
    ...(l.weakName ? [{ ...l, id: l.id + ':weak', label: `${l.label}: ${l.weakName}` }] : []),
  ]);
}
