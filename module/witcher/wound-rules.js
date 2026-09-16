import { RuleError, criticalHealingDays, derivedStats, hitLocations } from './rules.js';
import { combinedModifiers, woundModifiers } from './wounds.js';

export const WOUND_STAGES = ['untreated', 'stabilized', 'treated', 'healed'];
export function healingRequirements(severity) {
  const rank = ['simple', 'complex', 'difficult', 'deadly'].indexOf(severity);
  if (rank < 0) throw new RuleError('Unknown critical wound severity.');
  return { dc: 12 + rank * 2, rounds: 2 + rank * 2, magicDC: 14 + rank * 2, magicUses: 4 + rank * 2 };
}
export function woundStageLabel(w) {
  return w.treatment === 'healed' && w.permanent
    ? 'Healed · lasting consequence'
    : ({
        untreated: 'Untreated',
        stabilized: 'Stabilized',
        treated: w.permanent ? 'Treated · lasting consequence' : 'Treated · healing',
        healed: 'Healed',
      }[w.treatment] ?? 'Untreated');
}
const snapshot = (item) => ({
  id: item.id ?? item._id,
  type: item.type,
  ...(item.system?.toObject?.() ?? item.system ?? item),
});

/** Preview the BODY row after treating this wound, without mutating documents.
 * The book gives no arithmetic for Foreign Object's Critical Healing modifier:
 * retain a pending clock for an explicit GM duration rather than inventing it.
 */
export function recoveryPlan(state, items, wound) {
  healingRequirements(wound.severity);
  if (wound.fatal)
    return { body: null, days: null, reason: 'This fatal injury cannot be treated or healed.' };
  if (wound.permanent || wound.severity === 'deadly')
    return {
      body: null,
      days: null,
      reason: 'Core gives no recovery duration for deadly injuries; lasting consequences remain.',
    };
  const projected = items.map((item) => {
    const row = snapshot(item);
    return row.type === 'wound' && ((row.id === wound.itemId && wound.itemId) || row.wound === wound)
      ? { ...row, wound: { ...row.wound, treatment: 'treated' } }
      : row;
  });
  const derived = derivedStats(state, projected),
    body = derived.stats.body;
  if (!Number.isInteger(body) || body < 3 || body > 13)
    return {
      body,
      days: null,
      reason: 'The printed Critical Healing table covers BODY 3–13. The GM must set a duration.',
    };
  const mods = combinedModifiers(state, projected);
  if (Number(mods.criticalHealing ?? 0) !== 0 || Number(mods.criticalHealingMultiplier ?? 1) !== 1)
    return {
      body,
      days: null,
      reason:
        'A Critical Healing modifier is active. The book does not define its arithmetic; the GM must set the duration.',
    };
  return { body, days: criticalHealingDays(body, wound.severity), reason: '' };
}

export function recoveryContext(state, items) {
  const mods = combinedModifiers(state, items.map(snapshot));
  const flat = Number(mods.criticalHealing ?? 0),
    multiplier = Number(mods.criticalHealingMultiplier ?? 1);
  return flat === 0 && multiplier === 1 ? '' : JSON.stringify({ flat, multiplier });
}
export function recoveryClockChanged(wound, state, items) {
  return (
    wound.treatment === 'treated' &&
    !wound.permanent &&
    !wound.fatal &&
    (wound.recoveryContext ?? '') !== recoveryContext(state, items)
  );
}

export function advanceWoundDays(wound, days) {
  if (!Number.isInteger(days) || days < 1) throw new RuleError('Enter a positive whole number of days.');
  if (wound.treatment !== 'treated' || wound.permanent || wound.fatal || wound.recoveryPending) return null;
  const remaining = Math.max(0, Number(wound.daysRemaining || 0) - days);
  return { daysRemaining: remaining, ...(remaining === 0 ? { treatment: 'healed' } : {}) };
}

export function woundLocationChoices(state, wound) {
  const table = hitLocations(state);
  const matches = table.filter(
    (l) =>
      (l.group ||
        (/head/i.test(l.id) ? 'head' : /torso/i.test(l.id) ? 'torso' : /leg/i.test(l.id) ? 'leg' : 'arm')) ===
      wound.group
  );
  return matches.length
    ? matches
    : ['arm', 'leg'].includes(wound.group)
      ? table.filter((l) => /limb|wing|tail/i.test(l.id))
      : [];
}

/** Explicit action context avoids applying an injured arm or eye to unrelated checks. */
export function woundCheckModifier(items, { arm = '', sight = false } = {}) {
  return items
    .filter((i) => i.type === 'wound')
    .reduce((total, i) => {
      const w = (i.system ?? i).wound,
        mods = woundModifiers(w) ?? {};
      return (
        total +
        (sight ? Number(mods.sightAwareness ?? 0) : 0) +
        (arm && (arm === 'both' || w.location === arm) ? Number(mods.armActions ?? 0) : 0)
      );
    }, 0);
}

export function injuredArmChoices(state, items) {
  if (
    !items.some(
      (i) =>
        i.type === 'wound' &&
        (Number(woundModifiers((i.system ?? i).wound)?.armActions ?? 0) ||
          woundModifiers((i.system ?? i).wound)?.armDisabled)
    )
  )
    return null;
  const arms = woundLocationChoices(state, { group: 'arm' });
  return Object.fromEntries(arms.map((l) => [l.id, l.label]));
}

export function resolveWoundArm(state, items, arm, mode = 'optional') {
  if (mode === 'none') return '';
  const choices = injuredArmChoices(state, items);
  if (!choices) return '';
  const selected = mode === 'both' ? 'both' : arm || '';
  if (!selected && mode === 'optional') return '';
  if (!selected || (selected !== 'both' && !Object.hasOwn(choices, selected)))
    throw new RuleError('Choose the arm used for this action.');
  if (
    items.some(
      (i) =>
        i.type === 'wound' &&
        woundModifiers((i.system ?? i).wound)?.armDisabled &&
        (selected === 'both' || (i.system ?? i).wound.location === selected)
    )
  )
    throw new RuleError('This injured arm cannot perform the action.');
  return selected;
}
