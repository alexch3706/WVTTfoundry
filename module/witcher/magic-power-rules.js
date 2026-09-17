/** Pure book rules for sources of power; no Foundry globals or runtime imports. */
import { RuleError, beats } from './rules.js';
import { MAGIC, magicInfo } from './magic-catalog.js';
import { elementalBacklash } from './magic-rules.js';
const HOUR = 3600;
const copy = (value) => structuredClone(value);
const numeric = (value, label, min = 0) => {
  const result = Number(value);
  if (!Number.isFinite(result) || result < min)
    throw new RuleError(`${label} must be a number of at least ${min}.`);
  return result;
};
const integer = (value, label, min = 0) => {
  const result = numeric(value, label, min);
  if (!Number.isInteger(result)) throw new RuleError(`${label} must be a whole number.`);
  return result;
};
const magicTradition = (state) =>
  state.magic?.tradition ||
  (state.race === 'witcher'
    ? 'witcher'
    : (['mage', 'priest', 'druid'].find((kind) => String(state.profession).toLowerCase() === kind) ?? ''));
const addMagicEffect = (state, effect) => ({
  effects: [
    ...(state.effects ?? []),
    {
      ...effect,
      magic: {
        ...effect.magic,
        addedConditions: (effect.conditions ?? []).filter(
          (condition) => !(state.conditions ?? []).includes(condition)
        ),
      },
    },
  ],
  conditions: [...new Set([...(state.conditions ?? []), ...(effect.conditions ?? [])])],
});

/** The calendar month length is supplied by the GM/source, never assumed 30d. */
export function placeOfPowerPlan(
  previous,
  { sourceUuid, element, mode, time, monthSeconds, enduranceTotal, damageRoll = 0 } = {}
) {
  if (!['earth', 'air', 'fire', 'water'].includes(element))
    throw new RuleError('A Place of Power needs its actual element.');
  if (typeof sourceUuid !== 'string' || !sourceUuid)
    throw new RuleError('A Place of Power requires its source identifier.');
  if (!['attune', 'essence'].includes(mode))
    throw new RuleError('Choose attunement or Fifth Essence extraction.');
  numeric(time, 'World time', -Infinity);
  numeric(monthSeconds, 'One calendar month in seconds', 1);
  const repeated = !!previous && time < previous.safeAgainAt;
  const successes = repeated ? integer(previous.successes, 'Successful repeated draws') : 0;
  const dc = repeated ? 20 + successes * 4 : null;
  if (repeated && !Number.isFinite(enduranceTotal)) return { needsEndurance: true, dc };
  const success = !repeated || beats(enduranceTotal, dc),
    backlash = success ? null : elementalBacklash(element);
  if (!success && (!Number.isInteger(damageRoll) || damageRoll < 5 || damageRoll > 30))
    throw new RuleError('A failed repeated draw needs the actual 5d6 damage result.');
  return {
    needsEndurance: false,
    dc,
    success,
    damage: success ? 0 : damageRoll,
    backlash,
    record: {
      sourceUuid,
      element,
      lastUsedAt: time,
      safeAgainAt: time + monthSeconds,
      draws: (repeated ? previous.draws : 0) + 1,
      successes: successes + (repeated && success ? 1 : 0),
    },
    magicIP: mode === 'attune' ? 10 : 0,
    essence: mode === 'essence' ? 5 : 0,
    benefit: mode === 'attune' ? { element, vigor: 5, castingBonus: 2, expires: time + HOUR } : null,
  };
}

/** Temporary place bonuses are element-qualified; never grant +5 generic Vigor. */
export function placeOfPowerBenefits(state, magic, time) {
  const effects = (state.effects ?? []).filter(
    (effect) =>
      effect.magic?.placeOfPower &&
      !effect.disabled &&
      effect.expires > time &&
      !effect.magic.suppressed &&
      effect.magic.placeOfPower.element === magic?.element
  );
  return {
    vigor: effects.length ? 5 : 0,
    castingBonus: effects.length ? 2 : 0,
    sources: effects.map((effect) => effect.magic.placeOfPower.sourceUuid),
  };
}

export function leyLineBenefits(state, magic, { time = 0, knownMagic = [] } = {}) {
  const connection = state.magic?.leyConnection;
  const result = {
    connected: !!connection?.active,
    blocked: false,
    vigor: 0,
    castingBonus: 0,
    defenseModifier: 0,
    extraDamageDice: 0,
    ignitionChance: null,
    borrowedMagic: [],
  };
  if (!connection?.active) return result;
  const tradition = magicTradition(state);
  if (['priest', 'druid'].includes(tradition)) {
    result.vigor = 4;
    return result;
  }
  if (tradition !== 'mage') return { ...result, blocked: true };
  if (magic?.kind === 'spell' && magic.element !== connection.element) return { ...result, blocked: true };
  if (magic?.element !== connection.element) return result;
  if (connection.element === 'earth') result.defenseModifier = -4;
  if (connection.element === 'water') result.castingBonus = 2;
  if (connection.element === 'fire') {
    result.extraDamageDice = 2;
    result.ignitionChance = 100;
  }
  if (connection.element === 'air') {
    const tiers = new Set(
      knownMagic
        .map((value) => (typeof value === 'string' ? magicInfo(value) : value))
        .filter((entry) => entry?.kind === 'spell' && entry.element === 'air')
        .map((entry) => entry.tier)
    );
    result.borrowedMagic = MAGIC.filter(
      (entry) => entry.kind === 'spell' && entry.element === 'air' && tiers.has(entry.tier)
    ).map((entry) => entry.key);
  }
  return result;
}
export function leyDamageFormula(formula, extraDice = 2) {
  if (!/^\d+d\d+(?:[+-]\d+)?$/i.test(String(formula)))
    throw new RuleError('This damage formula needs a GM decision for the Ley Line’s extra damage dice.');
  return String(formula).replace(/^\d+/, (count) => String(Number(count) + integer(extraDice, 'Extra dice')));
}
/** Additional mishaps happen on overdraw/fumble WHILE connected, not a failed
 * initial connection attempt. Pending jobs require actual runtime resolution. */
export function leyLineMishapPlan(state, { time, cast, id } = {}) {
  const connection = state.magic?.leyConnection;
  if (!connection?.active) return { changes: {}, jobs: [] };
  const tradition = magicTradition(state),
    changes = {},
    jobs = [];
  if ((['priest', 'druid'].includes(tradition) || connection.element === 'water') && !id)
    throw new RuleError('Persisted Ley Line consequences need a stable effect identifier.');
  if (['priest', 'druid'].includes(tradition)) {
    numeric(time, 'World time', -Infinity);
    const penalty = {
      id,
      key: 'Ley Line overdraw',
      expires: time + 6 * HOUR,
      modifiers: { vigor: -2 },
      magic: { key: 'ley-line-penalty', sourceUuid: connection.sourceUuid },
    };
    changes['system.effects'] = [...copy(state.effects ?? []), penalty];
  } else if (connection.element === 'earth') {
    const dc = (connection.dc ?? 16) + 2;
    changes['system.magic.leyConnection'] = {
      ...copy(connection),
      active: false,
      dc,
      history: { ...copy(connection.history ?? {}), [connection.sourceUuid]: { dc } },
    };
  } else if (connection.element === 'air') {
    jobs.push({
      type: 'replaceSpell',
      castId: cast?.castId,
      tier: cast?.magic?.tier,
      element: 'air',
      originalSTA: cast?.staCost,
      mustResolveDespiteFumble: true,
      adjudicator: 'gm',
    });
  } else if (connection.element === 'fire') {
    jobs.push({
      type: 'repeatSpell',
      magicKey: cast?.magic?.key,
      originalSTA: cast?.staCost,
      extraAction: true,
      target: 'random',
      ordinaryFumbleOnly: true,
      adjudicator: 'gm',
    });
  } else if (connection.element === 'water') {
    const existing = state.effects?.find(
      (effect) => effect.magic?.leyHallucinationSource === connection.sourceUuid
    );
    if (!existing) {
      const added = addMagicEffect(state, {
        id,
        key: 'Ley Line hallucinations',
        expires: 0,
        conditions: ['hallucinating'],
        modifiers: {},
        magic: { key: 'ley-line-hallucinations', leyHallucinationSource: connection.sourceUuid },
      });
      changes['system.effects'] = added.effects;
      changes['system.conditions'] = added.conditions;
    }
    changes['system.magic.leyConnection'] = { ...copy(connection), hallucinating: true };
    jobs.push({
      type: 'hallucinations',
      controller: 'gm',
      untilDisconnect: true,
      maximumAfterDisconnectSeconds: 60,
    });
  }
  return { changes, jobs };
}
