import { activeAlchemy, alchemyKey, alchemyEffectActive } from './alchemy-rules.js';

const n = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);

/** Core pp.247–248. These bonuses never change the stored armor or its maximum. */
export function alchemyArmorBonus(state, derived) {
  const arachas = activeAlchemy(state, 'arachas-decoction')
    ? Math.floor(Math.max(0, n(derived.enc) - n(derived.weight)) / 10) * 2
    : 0;
  const griffin = n(activeAlchemy(state, 'griffin-decoction')?.alchemy?.armorBonus);
  return { arachas, griffin, total: arachas + griffin };
}

export function alchemyImmuneTo(state, condition) {
  if (condition === 'poison' && (activeAlchemy(state, 'golden-oriole') || activeAlchemy(state, 'mongoose')))
    return true;
  if (condition === 'hypnosis' && activeAlchemy(state, 'cat')) return true;
  return (
    ['stunned', 'blinded', 'prone'].includes(condition) && !!activeAlchemy(state, 'noon-wraith-decoction')
  );
}

/** Snapshot next-strike benefits before spending them. Magic does not consume Lightning. */
export function alchemyAttackPlan(state, { physical = true } = {}) {
  const lightning =
    physical &&
    (state.effects ?? []).find((effect) => alchemyKey(effect) === 'lightning' && alchemyEffectActive(effect));
  const consume = lightning && !lightning.alchemy?.spent ? lightning.id : '';
  return {
    damage: physical
      ? (activeAlchemy(state, 'thunderbolt') ? 3 : 0) +
        n(activeAlchemy(state, 'wyvern-decoction')?.alchemy?.wyvernBonus) +
        (consume && !lightning.alchemy?.noBenefit ? 3 : 0)
      : 0,
    lightningId: consume,
  };
}

export function alchemyCriticalBonus(state) {
  return activeAlchemy(state, 'katakan-decoction') ? 3 : 0;
}

export function alchemyProcChance(state, effect, chance) {
  return Math.min(
    100,
    Math.max(0, n(chance)) +
      (chance > 0 && ['fire', 'freeze', 'frozen', 'prone'].includes(effect) && activeAlchemy(state, 'tempest')
        ? 10
        : 0)
  );
}

/** Damage triggers are applied once as part of the accepted damage transaction. */
export function alchemyDamageEffects(state, effects, { damage = 0 } = {}) {
  const result = structuredClone(effects);
  for (const [key, update] of [
    [
      'griffin-decoction',
      (a) => {
        if (damage > 5) a.armorBonus = n(a.armorBonus) + 2;
      },
    ],
    [
      'wyvern-decoction',
      (a) => {
        if (damage > 0) a.wyvernBonus = 0;
      },
    ],
  ]) {
    const active = activeAlchemy(state, key);
    const effect = active && result.find((entry) => entry.id === active.id);
    if (effect) update((effect.alchemy ??= { key }));
  }
  return result;
}

/** A strike reaching armor counts; an attack fully stopped by Quen does not. */
export function alchemyStrikeEffects(
  state,
  { receipt, combatId, struck = false, killed = false, victimUuid = '' }
) {
  const effects = structuredClone(state.effects ?? []);
  for (const key of ['wyvern-decoction', 'blizzard', 'grave-hag-decoction']) {
    const active = activeAlchemy(state, key);
    const effect = active && effects.find((entry) => entry.id === active.id);
    if (!effect) continue;
    const data = (effect.alchemy ??= { key });
    data.receipts ??= [];
    if (data.receipts.includes(receipt)) continue;
    if (key === 'wyvern-decoction' && struck && combatId) {
      data.wyvernBonus = (data.combatId === combatId ? n(data.wyvernBonus) : 0) + 1;
      data.combatId = combatId;
    }
    if (killed && victimUuid && !(data.killReceipts ?? []).includes(victimUuid)) {
      data.killReceipts = [...(data.killReceipts ?? []), victimUuid];
      if (key === 'blizzard') {
        data.triggered = true;
        effect.modifiers = { ...effect.modifiers, ref: 4 };
      }
      if (key === 'grave-hag-decoction' && combatId) {
        data.kills = (data.combatId === combatId ? n(data.kills) : 0) + 1;
        data.combatId = combatId;
      }
    }
    data.receipts.push(receipt);
  }
  return effects;
}

export function alchemyEndCombatEffects(state, combatId) {
  return (state.effects ?? []).map((effect) => {
    if (effect.alchemy?.combatId !== combatId) return effect;
    return {
      ...effect,
      alchemy: { ...effect.alchemy, kills: 0, wyvernBonus: 0, combatId: '', killReceipts: [] },
    };
  });
}

export function alchemyRegeneration(state, { struck = false, combatId = '' } = {}) {
  const hag = activeAlchemy(state, 'grave-hag-decoction');
  return (
    (activeAlchemy(state, 'troll-decoction') ? 5 : 0) +
    (activeAlchemy(state, 'swallow') && !struck ? 3 : 0) +
    (combatId && hag?.alchemy?.combatId === combatId ? n(hag.alchemy.kills) * 2 : 0)
  );
}
