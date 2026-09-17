import { activeAlchemy, alchemyKey, ALCHEMY_PROFILES } from './alchemy-rules.js';
import { magicRecoveryRules } from './magic-effect-hooks.js';
import { commitActor, chat } from './runtime.js';
import { actorEnhancementBenefits } from './enhancements.js';

/** Count only whole elapsed three-second rounds, once per dose and before expiry. */
export function alchemyElapsedRecovery(state, time, { healingBonus = 0 } = {}) {
  const effects = structuredClone(state.effects ?? []);
  let healing = 0;
  const ticks = new Set();
  for (const effect of effects) {
    const key = alchemyKey(effect),
      rate = key === 'troll-decoction' ? 5 : key === 'swallow' ? 3 : 0;
    if (!rate || effect.disabled || effect.alchemy?.noBenefit) continue;
    const start =
      effect.alchemy?.lastRegenAt ??
      effect.alchemy?.startedAt ??
      (effect.expires ? effect.expires - ALCHEMY_PROFILES[key].durationSeconds : time);
    const end = Math.min(time, effect.expires || time);
    const rounds = Math.max(0, Math.floor((end - start) / 3));
    if (!rounds) continue;
    effect.alchemy = { ...effect.alchemy, key, lastRegenAt: start + rounds * 3 };
    for (let round = 1; round <= rounds; round++) {
      const tick = start + round * 3;
      const hit = effect.alchemy?.lastHitAt;
      if (key === 'swallow' && Number.isFinite(hit) && hit >= tick - 3 && hit < tick) continue;
      healing += rate;
      ticks.add(tick);
    }
  }
  return { effects, healing: healing + ticks.size * healingBonus };
}
export function markAlchemyRound(effects, time) {
  return effects.map((effect) =>
    ['swallow', 'troll-decoction'].includes(alchemyKey(effect))
      ? { ...effect, alchemy: { ...effect.alchemy, key: alchemyKey(effect), lastRegenAt: time } }
      : effect
  );
}
export async function advanceAlchemyTime(actor, time) {
  const plan = alchemyElapsedRecovery(actor.system, time, {
    healingBonus: actorEnhancementBenefits(actor.items).healingBonus,
  });
  if (JSON.stringify(plan.effects) === JSON.stringify(actor.system.effects)) return;
  const activeCombat = [...(game.combats ?? (game.combat ? [game.combat] : []))].some(
    (combat) =>
      combat.started && [...(combat.combatants ?? [])].some((entry) => entry.actor?.uuid === actor.uuid)
  );
  const allowed =
    !activeCombat && !actor.system.conditions.includes('dead') && !(actor.system.pendingDeathSaves > 0);
  const healing = allowed
    ? magicRecoveryRules(actor.system, { source: 'magical', amount: plan.healing }).hpAmount
    : 0;
  const actual = Math.max(0, Math.min(healing, actor.system.hp.max - actor.system.hp.value));
  return commitActor(
    actor,
    {
      'system.effects': plan.effects,
      ...(actual ? { 'system.hp.value': actor.system.hp.value + actual } : {}),
    },
    [],
    async () => {
      if (actual)
        return chat(actor, 'Alchemy recovery', `<p>${actual} HP recovered during elapsed world time.</p>`);
    },
    { healingBonusApplied: true }
  );
}
