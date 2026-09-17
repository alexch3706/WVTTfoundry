import { placeOfPowerBenefits, leyLineBenefits } from './magic-power-rules.js';
import { magicCastingRules, magicModifierSummary } from './magic-effect-hooks.js';
import { BASIC_SPELL_KEYS } from './magic-support.js';
import { RuleError } from './rules.js';
import { availableHands, handsUsed, isMagicalFocus, focusUse, validateWeaponGrip } from './inventory.js';
import { woundModifiers } from './wounds.js';

export const IMPLEMENTED_MAGIC = new Set([
  ...BASIC_SPELL_KEYS,
  'yrden',
  'quen',
  'aard',
  'igni',
  'axii',
  'magic-trap',
  'active-shield',
  'aard-sweep',
  'fire-stream',
  'puppet',
  'somne',
  'supirre',
  'dispel',
  'magic-healing',
]);

export const MAGIC_TRADITIONS = {
  '': 'Choose tradition',
  witcher: 'Witcher',
  mage: 'Mage',
  priest: 'Priest',
  druid: 'Druid',
  talent: 'Magical talent',
};
export function magicTradition(state) {
  if (state.magic?.tradition) return state.magic.tradition;
  if (state.race === 'witcher') return 'witcher';
  return ['mage', 'priest', 'druid'].find((key) => String(state.profession).toLowerCase() === key) ?? '';
}
export function magicVigor(state, magic = null, time = globalThis.game?.time?.worldTime ?? 0) {
  const bonus = Number(magicModifierSummary(state).modifiers.vigor ?? 0);
  if (state.magic?.dimeritiumContact || state.effects?.some((e) => e.key === 'Dimeritium')) return 0;
  return Math.max(
    0,
    Number(state.vigor || 0) +
      bonus +
      placeOfPowerBenefits(state, magic, time).vigor +
      leyLineBenefits(state, magic).vigor -
      Number(state.magic?.dimeritiumUnits || 0)
  );
}
export function selectedMagicFocus(state, items, focusId = '', kind = '') {
  if (!focusId) return null;
  const item = items.find((i) => (i.id ?? i._id) === focusId),
    s = item?.system ?? item;
  if (
    !s?.equipped ||
    s.carried === false ||
    !(s.quantity > 0) ||
    !isMagicalFocus(item) ||
    focusUse(item) !== 'held'
  )
    throw new RuleError('Select one carried, held magical focus.');
  validateWeaponGrip(state, item, items);
  const kinds = item?.flags?.['witcher-rilerena']?.focusKinds;
  if (kind && kinds && !kinds.includes(kind))
    throw new RuleError('This focus is restricted to its listed kinds of magic.');
  const tradition = magicTradition(state);
  if (tradition === 'witcher' && !(s.witcherWeapon && String(s.school).toLowerCase() === 'griffin'))
    throw new RuleError('Witchers can use the specific Griffin weapon focus, not ordinary mage focuses.');
  if (!['mage', 'priest', 'druid', 'witcher'].includes(tradition))
    throw new RuleError('This tradition cannot use a magical focus.');
  return item;
}
export function magicFocus(state, items, focusId = '', kind = '') {
  const item = selectedMagicFocus(state, items, focusId, kind);
  return Number((item?.system ?? item)?.properties?.focus || 0);
}
export function maintainedMagic(state) {
  return (state.effects ?? []).find(
    (e) => e.magic?.maintenance && e.magic.maintenance !== 'none' && e.magic.casterEffect
  );
}
export function validateCasting(state, items, magic, { continuing = false, arm = '', amulet = false } = {}) {
  const tradition = magicTradition(state);
  if (tradition === 'talent')
    throw new RuleError(
      'Magical gifts have their own abilities and cannot learn ordinary spells, invocations, or other magic (Tome p.74).'
    );
  if (!tradition) throw new RuleError('Choose a magical tradition on the Magic tab.');
  if (magicVigor(state, magic) <= 0) throw new RuleError('This actor has no available Vigor.');
  if (tradition === 'witcher' && magic.kind !== 'sign')
    throw new RuleError('Witchers can learn and cast Signs only.');
  if (tradition === 'mage' && magic.kind === 'invocation')
    throw new RuleError(
      'Mages learn spells, rituals, hexes and signs; invocations belong to priests and druids (Core p.123).'
    );
  if (['priest', 'druid'].includes(tradition) && magic.kind === 'spell' && !amulet)
    throw new RuleError(
      'Priests and druids learn invocations, rituals, hexes and signs rather than mage spells (Core p.123).'
    );
  if (!continuing && maintainedMagic(state))
    throw new RuleError('End the maintained magic before casting another spell (Core p.102).');
  if ((state.conditions ?? []).some((c) => ['dead', 'unconscious', 'stunned', 'pinned'].includes(c)))
    throw new RuleError('This condition prevents casting.');
  if (leyLineBenefits(state, magic).blocked)
    throw new RuleError('The connected Ley Line prevents casting a spell of another element.');
  const restriction = magicCastingRules(state, { tradition, kind: magic.kind });
  if (restriction.blocked) throw new RuleError(restriction.reasons.join(' '));
  const rank = Number(state.skills?.spellCasting || 0);
  const sign = magic.kind === 'sign';
  if (!sign && rank <= 6 && state.magic?.speech === false)
    throw new RuleError('This caster needs spoken incantations.');
  const handGestures = sign || rank < 9;
  if (handGestures && state.magic?.gestures === false)
    throw new RuleError('This magic requires a hand gesture.');
  if (!handGestures && state.magic?.minorGestures === false)
    throw new RuleError('This caster still needs minor body gestures.');
  const used = items.filter((i) => (i.system ?? i).equipped).reduce((n, i) => n + handsUsed(i), 0);
  if (handGestures && availableHands(state, items) <= used)
    throw new RuleError('Free a usable hand to form the magical gesture.');
  if (
    handGestures &&
    arm &&
    items.some((i) => {
      const w = (i.system ?? i).wound;
      return i.type === 'wound' && woundModifiers(w)?.armDisabled && (arm === 'both' || w.location === arm);
    })
  )
    throw new RuleError('The injured arm cannot form this gesture.');
  return { tradition, handGestures, vigor: magicVigor(state) };
}

export function magicEffectLabel(key) {
  return (
    {
      'active-shield': 'Active Shield',
      'magic-trap': 'Magic Trap',
      'fire-stream': 'Fire Stream',
      'aard-sweep': 'Aard Sweep',
    }[key] ?? String(key || 'Magic effect').replace(/(^|[- ])\w/g, (s) => s.replace('-', ' ').toUpperCase())
  );
}
export function magicShield(state) {
  return (state.effects ?? []).find(
    (e) => ['quen', 'active-shield'].includes(e.magic?.key) && e.shieldHP > 0
  );
}
export function magicEffectConditions(effects) {
  return [...new Set(effects.flatMap((e) => (e.magic ? (e.conditions ?? []) : [])))];
}

/** Remove only conditions introduced by this magic, preserving overlapping sources. */
export function removeMagicEffects(state, predicate) {
  const removed = state.effects.filter(predicate),
    effects = structuredClone(state.effects.filter((e) => !predicate(e)));
  const still = new Set(effects.flatMap((effect) => effect.conditions ?? []));
  const owned = new Set(removed.flatMap((e) => e.magic?.addedConditions ?? []));
  // Transfer ownership when the first of several sources ends. Otherwise the
  // last overlapping effect would leave a condition with no remaining source.
  for (const condition of owned) {
    const successor = effects.find((effect) => effect.magic && effect.conditions?.includes(condition));
    if (successor)
      successor.magic.addedConditions = [...new Set([...(successor.magic.addedConditions ?? []), condition])];
  }
  return {
    effects,
    conditions: state.conditions.filter((c) => !owned.has(c) || still.has(c)),
    removed,
  };
}
export function addMagicEffect(state, effect) {
  const previous = new Set(state.conditions ?? []);
  const added = (effect.conditions ?? []).filter((c) => !previous.has(c));
  return {
    effects: [...state.effects, { ...effect, magic: { ...effect.magic, addedConditions: added } }],
    conditions: [...new Set([...previous, ...(effect.conditions ?? [])])],
  };
}
