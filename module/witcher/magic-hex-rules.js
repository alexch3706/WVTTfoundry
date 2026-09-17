import { RuleError, resolveCheck } from './rules.js';

export function activeHexes(state = {}) {
  return new Set(
    (state.effects ?? [])
      .filter((effect) => effect.magic?.kind === 'hex' && !effect.magic.suppressed && !effect.disabled)
      .map((effect) => effect.magic.key)
  );
}
export function hexDiceRules(state = {}, context = {}) {
  const hexes = activeHexes(state);
  return {
    fumbleFaces:
      hexes.has('the-devils-luck') && (context.stressed || context.deadline || context.dc > 15)
        ? [1, 2]
        : [1],
    twice: hexes.has('the-evil-eye'),
  };
}
function chain(values) {
  return values.length > 0 && values.at(-1) !== 10 && values.slice(0, -1).every((value) => value === 10);
}
export function parseHexManualCheck(input, rules) {
  if (input === undefined || input === null || input === '') return null;
  if (typeof input !== 'string') throw new RuleError('Enter actual d10 dice as text.');
  if (!input.trim()) return null;
  const groups = input
    .trim()
    .split(';')
    .map((group) => group.split(',').map((part) => part.trim()));
  if (groups.length > 2 || groups.some((group) => group.some((part) => !/^(?:[1-9]|10)$/.test(part))))
    throw new RuleError(
      'Enter d10 values separated by commas; separate Evil Eye’s second fumble chain with a semicolon.'
    );
  const first = groups[0].map(Number),
    second = groups[1]?.map(Number);
  const fumble = rules.fumbleFaces.includes(first[0]);
  if (fumble || first[0] === 10) {
    if (!chain(first.slice(1)))
      throw new RuleError('Enter the next d10 to complete the first exploding chain.');
  } else if (first.length !== 1) throw new RuleError('This initial d10 has no follow-up roll.');
  if (fumble && rules.twice) {
    if (!second || !chain(second))
      throw new RuleError('Evil Eye requires two complete fumble continuations, for example 1,5;10,3.');
  } else if (second) throw new RuleError('This check does not require a second fumble continuation.');
  return { dice: first, second };
}
export function resolveHexCheck(base, first, second, rules) {
  if (!rules.fumbleFaces.includes(first[0])) return resolveCheck(base, first);
  if (!chain(first.slice(1)) || (rules.twice && !chain(second ?? [])))
    throw new RuleError('Incomplete hex fumble dice.');
  const continuation = [first.slice(1), ...(rules.twice ? [second] : [])];
  const totals = continuation.map((dice) => dice.reduce((sum, value) => sum + value, 0));
  const chosen = totals.indexOf(Math.max(...totals));
  return {
    base,
    dice: [first[0], ...continuation[chosen]],
    fumbleDice: continuation,
    contribution: -totals[chosen],
    total: Math.max(0, base - totals[chosen]),
    fumble: totals[chosen],
    critical: false,
  };
}

export function hexSkillModifier(state, skill, context = {}) {
  const hexes = activeHexes(state);
  return (
    (hexes.has('the-eternal-itch') && skill === 'seduction' && context.intimacy ? -5 : 0) +
    (hexes.has('the-hex-of-the-beast') && skill === 'wildernessSurvival' && context.animalHandling ? -3 : 0) +
    (hexes.has('the-odious-hex') &&
    ['seduction', 'charisma', 'persuasion', 'leadership'].includes(skill) &&
    context.socialStanding
      ? -Math.min(2, ({ equal: 0, tolerated: 1, hated: 2 }[context.socialStanding] ?? 0) + 1)
      : 0)
  );
}
export function hexPassiveModifiers(state, time = 0) {
  const effects = (state.effects ?? []).filter((effect) => activeHexes({ effects: [effect] }).size);
  const nightmare = effects.some(
    (effect) => effect.magic.key === 'the-nightmare' && effect.magic.nightsFailed >= 3
  );
  const need = effects.filter((effect) => effect.magic.key === 'unending-need');
  const hungry = need.some((effect) => effect.magic.needFoodUntil > time);
  const tired = need.some((effect) => effect.magic.sleepDeprived);
  return {
    ...(nightmare || tired ? { allActions: (nightmare ? -2 : 0) + (tired ? -3 : 0) } : {}),
    ...(nightmare || hungry ? { staMultiplier: (nightmare ? 0.5 : 1) * (hungry ? 0.5 : 1) } : {}),
  };
}
export function hexRestPlan(state, { sleepHours = 8, meals = 3, time = 0, nightmareTotals = {} } = {}) {
  if (!Number.isFinite(sleepHours) || sleepHours < 0 || !Number.isInteger(meals) || meals < 0)
    throw new RuleError('Record actual uninterrupted sleep hours and number of meals.');
  const effects = structuredClone(state.effects ?? []);
  let recoveryAllowed = true;
  const nights = [];
  for (const effect of effects) {
    if (!activeHexes({ effects: [effect] }).size) continue;
    if (effect.magic.key === 'the-nightmare') {
      const total = nightmareTotals[effect.id];
      if (!Number.isFinite(total))
        throw new RuleError('Resolve this night’s Resist Coercion against each Nightmare first.');
      const passed = total > effect.magic.castingTotal;
      effect.magic.nightsFailed = passed ? 0 : (effect.magic.nightsFailed ?? 0) + 1;
      recoveryAllowed &&= passed;
      nights.push({
        effectId: effect.id,
        passed,
        nightsFailed: effect.magic.nightsFailed,
        dc: effect.magic.castingTotal,
      });
    }
    if (effect.magic.key === 'unending-need') {
      effect.magic.sleepDeprived = sleepHours < 10;
      effect.magic.needFoodUntil = meals < 5 ? time + 86400 : 0;
    }
  }
  return { effects, recoveryAllowed, nights };
}
export function hexCriticalWound(state, wound, catalog) {
  if (!wound || wound.bonesOfGlass || !activeHexes(state).has('bones-of-glass')) return wound;
  const replacement = {
    'Cracked Ribs': ['complex', 2],
    'Fractured Leg': ['difficult', 0],
    'Fractured Arm': ['difficult', 1],
    'Minor Head Wound': ['difficult', 5],
  }[wound.name];
  if (!replacement) return wound;
  const [severity, index] = replacement;
  return {
    ...structuredClone(catalog[severity][index]),
    severity,
    key: `${severity}-${index}`,
    group: wound.group,
    location: wound.location,
    treatment: 'untreated',
    bonesOfGlass: true,
    notes: `Bones of Glass replaced ${wound.name}; medical stabilization/treatment −3 while the hex remains.`,
  };
}
export function hexTreatmentModifier(state, wound) {
  return activeHexes(state).has('bones-of-glass') &&
    ['Broken Ribs', 'Compound Arm Fracture', 'Compound Leg Fracture', 'Skull Fracture'].includes(wound.name)
    ? -3
    : 0;
}
