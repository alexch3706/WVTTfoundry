/** Core pp.246–251; A Tome of Chaos pp.115–116, 147.
 * Pure source profiles and lifecycle plans. No Foundry document imports.
 */
import { SYSTEM_ID } from './config.js';

const slug = (value) =>
  String(value ?? '')
    .normalize('NFKD')
    .replace(/[’']/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
const rows = [
  ['Black Blood', '69c3791908d73a77', 60, 25],
  ['Blizzard', '24e20ec895f5d6f2', 30, 75],
  ['Cat', '0aae86abedc63811', 7200, 25],
  ['Full Moon', '265652399a2baa7a', 1800, 75, { hp: 30 }],
  ['Golden Oriole', 'f6a4e551557a67f0', 1800, 50],
  ['Killer Whale', 'f932a86abbe71261', 1800, 25],
  ['Maribor Forest', '9e7a8c152e0b5132', 45, 50],
  ['Petri’s Filter', '594367c7d28ec72f', 45, 75, { spellCasting: 2, hexWeaving: 2, ritualCrafting: 2 }],
  ['Swallow', '96650a851385000c', 60, 50],
  ['Tawny Owl', '0e611b55dacd7b77', 60, 50],
  ['Thunderbolt', 'b8e8f6807bb533fa', 45, 75, { physicalDamage: 3 }],
  ['White Honey', 'cd5789e8bba2826d', 0, 0],
];
const decoctions = [
  ['Arachas', '4fdb9b8703d97242'],
  ['Fiend', '44aa0801e9ded109', { encMultiplier: 2 }],
  ['Grave Hag', '556aef85063c1ef0'],
  ['Griffin', 'd18c04e47b37f733'],
  ['Katakan', '8ccd0b2643344b37'],
  ['Nekker', 'f2dd331403025bf9', { riding: 3, athletics: 3 }],
  ['Noon Wraith', '426fa00ed1b8f034'],
  ['Troll', '5d29f5041e1a6ca1'],
  ['Werewolf', '2f6f11a99d3ff039'],
  ['Wyvern', '63b833513997e67f'],
];
const oils = [
  ['Beast Oil', '4b8ed0f26cdb3cb4', 'beast'],
  ['Cursed Oil', 'f3744651ec3294c1', 'cursed'],
  ['Draconid Oil', 'ab73299495745d62', 'draconid'],
  ['Elementa Oil', '9b9c3d29eb043439', 'elementa'],
  ['Hanged Man’s Venom', '40787446f7ce7c66', 'humanoid'],
  ['Hybrid Oil', '9edbd093eee9ea23', 'hybrid'],
  ['Insectoid Oil', '679a9ebfffd1cdbb', 'insectoid'],
  ['Necrophage Oil', '97ec78568762f96e', 'necrophage'],
  ['Ogroid Oil', '3944804168890cde', 'ogroid'],
  ['Relict Oil', '5a54d0ffc9aa8d87', 'relict'],
  ['Specter Oil', '1bfff07cb5f2a003', 'specter'],
  ['Vampire Oil', '0b80555431c5444c', 'vampire'],
];
const profiles = [
  ...rows.map(([name, id, durationSeconds, toxicity, modifiers = {}]) => ({
    key: slug(name),
    name,
    id,
    kind: 'potion',
    durationSeconds,
    toxicity,
    modifiers,
    source: 'Core p.247',
  })),
  ...decoctions.map(([name, id, modifiers = {}]) => ({
    key: slug(name + ' Decoction'),
    name: name + ' Decoction',
    id,
    kind: 'decoction',
    durationSeconds: 1800,
    toxicity: 75,
    modifiers,
    source: 'Core p.248',
  })),
  ...oils.map(([name, id, targetCategory]) => ({
    key: slug(name),
    name,
    id,
    kind: 'oil',
    durationSeconds: 1800,
    toxicity: 0,
    modifiers: {},
    targetCategory,
    source: 'Core p.248',
  })),
  {
    key: 'anabolic-steroids',
    name: 'Anabolic Steroids',
    durationSeconds: 600,
    aggressionSeconds: 3600,
    toxicity: 50,
    modifiers: { hp: 10, endurance: 2, physique: 2 },
  },
  { key: 'last-hope', name: 'Last Hope', durationSeconds: 0, durationKind: 'wound', toxicity: 75 },
  {
    key: 'lightning',
    name: 'Lightning',
    durationSeconds: 0,
    durationKind: 'next-physical-attack',
    toxicity: 75,
  },
  { key: 'mongoose', name: 'Mongoose', durationSeconds: 1800, toxicity: 50 },
  { key: 'strider', name: 'Strider', durationSeconds: 86400, toxicity: 50 },
  { key: 'tempest', name: 'Tempest', durationSeconds: 0, durationKind: 'unspecified', toxicity: 50 },
  {
    key: 'cerebral-elixir',
    name: 'Cerebral Elixir',
    durationSeconds: 86400,
    toxicity: 0,
    toxicityUnspecified: true,
    source: 'A Tome of Chaos p.147',
  },
].map((profile) =>
  Object.freeze({
    kind: 'elixir',
    modifiers: {},
    source: 'A Tome of Chaos p.116',
    durationKind: 'timed',
    ...profile,
  })
);
export const ALCHEMY_PROFILES = Object.freeze(
  Object.fromEntries(profiles.map((profile) => [profile.key, profile]))
);

/** Source identity survives a renamed owned compendium item. The name fallback
 * migrates old owned items lacking import metadata; category must also agree. */
export function alchemyProfile(item) {
  const state = item?.system ?? item ?? {};
  const canonical = item?.flags?.[SYSTEM_ID]?.alchemy?.key ?? state.alchemy?.key;
  if (canonical && ALCHEMY_PROFILES[canonical]) return ALCHEMY_PROFILES[canonical];
  const source = state.sourceUuid ?? item?._stats?.compendiumSource ?? item?.flags?.core?.sourceId ?? '';
  const id = String(source).split('.').at(-1);
  return (
    profiles.find(
      (profile) => profile.id && (profile.id === id || profile.id === item?.id || profile.id === item?._id)
    ) ??
    profiles.find(
      (profile) => profile.kind === state.category && slug(item?.name ?? state.name) === profile.key
    )
  );
}
export function alchemyKey(effect) {
  return effect?.alchemy?.key ?? (profiles.find((profile) => profile.name === effect?.key)?.key || '');
}
export function alchemyEffectActive(effect, time = globalThis.game?.time?.worldTime ?? 0) {
  return (
    !!effect &&
    !effect.disabled &&
    !effect.suppressed &&
    !effect.magic?.suppressed &&
    (!effect.expires || effect.expires > time)
  );
}
export function activeAlchemy(state, key, time = globalThis.game?.time?.worldTime ?? 0) {
  return (state?.effects ?? state?.system?.effects ?? []).find(
    (effect) => alchemyKey(effect) === key && alchemyEffectActive(effect, time) && !effect.alchemy?.noBenefit
  );
}
export function hasAlchemy(state, key, time = globalThis.game?.time?.worldTime ?? 0) {
  return !!activeAlchemy(state, key, time);
}
export function toxicityLimit(state) {
  const iron = Math.max(0, Number(state.professionRanks?.ironStomach) || 0);
  return iron >= 10 ? 150 : 100 + (iron ? 5 + Math.floor((iron - 1) / 2) * 5 : 0);
}
export function isAlchemyDose(effect) {
  return !!effect.potion || ['potion', 'decoction', 'elixir'].includes(effect.alchemy?.kind);
}
export function toxicityTotal(effects, time = globalThis.game?.time?.worldTime ?? 0) {
  return effects
    .filter((effect) => isAlchemyDose(effect) && alchemyEffectActive(effect, time))
    .reduce((total, effect) => total + Math.max(0, Number(effect.toxicity) || 0), 0);
}
export function toxicityPoison(effect) {
  return effect.alchemy?.key === 'toxicity' || effect.key === 'Toxicity';
}
function otherPoison(effects) {
  return effects.some(
    (effect) =>
      !toxicityPoison(effect) &&
      (effect.alchemy?.poison ||
        effect.conditions?.includes('poison') ||
        effect.magic?.addedConditions?.includes('poison') ||
        ['Black Venom', 'Mutagen Poison', 'Failed Witcher Potion'].includes(effect.key))
  );
}
/** Deleting a toxicity source may clear its poison only when this source added it;
 * an unrelated pre-existing poison is never removed by White Honey/expiry. */
export function reconcileAlchemyToxicity(
  state,
  effects,
  { time = globalThis.game?.time?.worldTime ?? 0, id = 'toxicity', latestId, forceClear = false } = {}
) {
  const conditions = new Set(state.conditions ?? []);
  const previous = (state.effects ?? []).filter(toxicityPoison);
  const total = toxicityTotal(effects, time),
    limit = toxicityLimit(state);
  const immune =
    !!activeAlchemy({ ...state, effects }, 'golden-oriole', time) ||
    !!activeAlchemy({ ...state, effects }, 'mongoose', time);
  const poisoned = !forceClear && !immune && (total > limit || (previous.length > 0 && total >= limit));
  const next = effects.filter((effect) => !toxicityPoison(effect));
  if (poisoned) {
    const prior = previous[0];
    next.push({
      id: prior?.id ?? id,
      key: 'Toxicity',
      expires: 0,
      conditions: ['poison'],
      dc: 18,
      alchemy: {
        key: 'toxicity',
        kind: 'condition',
        poison: true,
        lastDoseId: latestId ?? prior?.alchemy?.lastDoseId ?? next.filter(isAlchemyDose).at(-1)?.id,
        addedPoison: prior?.alchemy?.addedPoison ?? !conditions.has('poison'),
      },
    });
    conditions.add('poison');
  } else if (previous.some((effect) => effect.alchemy?.addedPoison !== false) && !otherPoison(next))
    conditions.delete('poison');
  return { effects: next, conditions: [...conditions], toxicity: total };
}

/** Includes only alchemical expiry. Root's general effect lifecycle remains the
 * owner of unrelated conditions, magic and wounds. */
export function planAlchemyExpiry(state, time = globalThis.game?.time?.worldTime ?? 0) {
  const removed = (state.effects ?? []).filter(
    (effect) => alchemyKey(effect) && effect.expires > 0 && effect.expires <= time
  );
  const effects = (state.effects ?? []).filter((effect) => !removed.includes(effect));
  for (const effect of removed)
    if (
      effect.alchemy?.key === 'anabolic-steroids' &&
      !effect.alchemy.noBenefit &&
      effect.alchemy.aggressiveUntil > time
    )
      effects.push({
        ...effect,
        key: 'Anabolic Steroids · aggression',
        expires: effect.alchemy.aggressiveUntil,
        modifiers: {},
        alchemy: { ...effect.alchemy, key: 'anabolic-aggression', benefitEnded: true },
      });
  const result = reconcileAlchemyToxicity(state, effects, { time });
  const temporaryRemoved = removed.reduce((n, effect) => n + Math.max(0, Number(effect.temporaryHp) || 0), 0);
  const afterTemporary = Number(state.hp?.value ?? 0) - temporaryRemoved;
  return {
    ...result,
    removed,
    changes: {
      'system.effects': result.effects,
      'system.conditions': result.conditions,
      'system.toxicity.value': result.toxicity,
      ...(afterTemporary !== Number(state.hp?.value ?? 0) ? { 'system.hp.value': afterTemporary } : {}),
    },
  };
}

export function alchemyEffect(
  profile,
  { id, now = 0, sourceUuid = '', noBenefit = false, durationSeconds } = {}
) {
  const seconds = durationSeconds ?? profile.durationSeconds;
  return {
    id,
    key: profile.name,
    expires: seconds ? now + seconds : 0,
    potion: true,
    toxicity: profile.toxicity,
    modifiers: noBenefit ? {} : { ...profile.modifiers },
    ...(profile.key === 'full-moon' && !noBenefit ? { temporaryHp: 30 } : {}),
    alchemy: {
      key: profile.key,
      kind: profile.kind,
      sourceUuid,
      startedAt: now,
      noBenefit,
      durationKind: profile.durationKind,
      ...(profile.toxicityUnspecified ? { toxicityUnspecified: true } : {}),
      ...(profile.aggressionSeconds ? { aggressiveUntil: now + profile.aggressionSeconds } : {}),
      ...(profile.key === 'grave-hag-decoction' ? { kills: 0 } : {}),
      ...(profile.key === 'griffin-decoction' ? { armorBonus: 0 } : {}),
      ...(profile.key === 'wyvern-decoction' ? { wyvernBonus: 0 } : {}),
    },
  };
}

export function oilEligible(item) {
  const state = item?.system ?? item ?? {};
  return (
    item?.type === 'weapon' &&
    state.carried !== false &&
    !!state.equipped &&
    !['bow', 'crossbow', 'sling', 'firearm', 'shield', 'unarmed', 'brawling'].includes(state.category) &&
    (state.damageTypes ?? []).some((type) => ['slashing', 'piercing'].includes(type))
  );
}

export function lastHopeState(item) {
  return item?.flags?.[SYSTEM_ID]?.lastHope ?? null;
}
export function lastHopeLocked(item) {
  return ['locked', 'reapplied'].includes(lastHopeState(item)?.phase);
}
