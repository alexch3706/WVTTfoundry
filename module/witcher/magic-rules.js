import { RuleError } from './rules.js';

export const MAGIC_ELEMENTS = ['mixed', 'earth', 'air', 'fire', 'water'];
export const SIGN_KEYS = [
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
];

const finite = (value, label, { min = 0, integer = false } = {}) => {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value < min ||
    (integer && !Number.isInteger(value))
  )
    throw new RuleError(`${label} must be a ${integer ? 'whole ' : ''}number of at least ${min}.`);
  return value;
};
const data = (magic) => magic?.system?.magic ?? magic?.magic ?? magic;

/** Validate the chosen strength before applying a focus discount. */
export function validateMagicPower(magic, power) {
  const row = data(magic);
  if (!row || typeof row !== 'object') throw new RuleError('A magic definition is required.');
  const cost = row.cost;
  if (!cost || typeof cost !== 'object') throw new RuleError('This magic has no defined STA cost.');
  const min = finite(cost.min, 'Minimum magic cost'),
    max = finite(cost.max, 'Maximum magic cost'),
    step = finite(cost.step ?? 1, 'Magic cost step');
  finite(power, 'Chosen magic power');
  if (max < min || step <= 0 || power < min || power > max)
    throw new RuleError(`Choose a magic power between ${min} and ${max}.`);
  if (cost.options?.length) {
    if (!cost.options.includes(power))
      throw new RuleError(`Choose one of these magic powers: ${cost.options.join(', ')}.`);
  } else if (Math.abs((power - min) / step - Math.round((power - min) / step)) > 1e-8) {
    throw new RuleError(`Magic power must increase in steps of ${step}.`);
  }
  if (row.kind === 'sign' && (!Number.isInteger(power) || power < 1 || power > 7))
    throw new RuleError('A sign must have a whole power from 1 to 7.');
  return power;
}

/** Core pp.166–167. Only spell expenditure counts against Vigor; action/defense
 * surcharges are accounted for by the caller. Prior overdraw is never charged twice.
 * `focus` is the ONE eligible held focus selected by the authoritative caller.
 */
export function magicCostPlan({ magic, power, focus = 0, spent = 0, vigor, stamina, dimeritium = false }) {
  finite(power, 'Magic cost', { min: Number.MIN_VALUE });
  if (magic) validateMagicPower(magic, power);
  finite(focus, 'Focus', { integer: true });
  finite(spent, 'Magic spent this round');
  finite(vigor, 'Vigor');
  finite(stamina, 'Available STA');
  if (dimeritium) throw new RuleError('Contact with dimeritium prevents casting.');
  if (vigor === 0) throw new RuleError('Casting requires a Vigor Threshold above zero.');
  // A focus cannot lower a cost below 1. An undiscounted fractional upkeep or
  // counter cost remains fractional: Core's rounding sidebar is for derived stats.
  const staCost = focus > 0 ? Math.min(power, Math.max(1, power - focus)) : power;
  if (stamina < staCost)
    throw new RuleError(`Casting requires ${staCost} STA; only ${stamina} STA is available.`);
  const roundAfter = spent + staCost,
    overdrawBefore = Math.max(0, spent - vigor),
    overdrawAfter = Math.max(0, roundAfter - vigor),
    overdrawAdded = overdrawAfter - overdrawBefore;
  return {
    power,
    focus,
    staCost,
    roundBefore: spent,
    roundAfter,
    vigor,
    overdrawBefore,
    overdrawAfter,
    overdrawAdded,
    hpCost: overdrawAdded * 5,
    staAfter: stamina - staCost,
    exhausted: stamina === staCost,
    elementalBacklash: overdrawAdded > 0,
  };
}

/** Core pp.70,102: retain an exact half, including fractional STA. */
export function counterMagicCost(incomingSTA) {
  return finite(incomingSTA, 'Incoming magic STA cost', { min: Number.MIN_VALUE }) / 2;
}

/** Core p.102 and sign text p.115. The caller passes the initial actual STA cost;
 * this already includes a focus, so upkeep must not receive the same discount twice.
 */
export function magicMaintenance(magic, initialSTA) {
  const row = data(magic),
    mode = row?.duration?.maintenance ?? 'none';
  if (mode === 'none') return 0;
  finite(initialSTA, 'Initial STA cost', { min: Number.MIN_VALUE });
  if (mode === 'initial') return initialSTA;
  if (mode === 'half') return initialSTA / 2;
  if (mode === 'fixed') return finite(row.duration.maintenanceCost, 'Maintenance cost');
  throw new RuleError('Unknown magic maintenance mode.');
}

/** Core p.99 and Errata. Counter actions remain available even for Defense: None.
 * Availability of a particular learned spell/profession skill is checked by callers.
 */
export function magicDefenses(magic, { includeCounters = true } = {}) {
  const row = data(magic),
    choices = [];
  for (const defense of row?.defenses ?? []) {
    const key = String(defense)
      .toLowerCase()
      .replaceAll('×', 'x')
      .replace(/[\s_/-]/g, '');
    if (key === 'none' || !key) continue;
    if (key === 'dodge') choices.push('dodge', 'athletics');
    else if (['dodgeescape', 'dodgeonly'].includes(key)) choices.push('dodge');
    else if (key === 'athletics') choices.push('athletics');
    else if (key === 'block') choices.push('block');
    else if (key === 'resistmagic') choices.push('resistMagic');
    else if (key === 'spellcasting') choices.push('spellCasting');
    else if (/^(int|ref|dex|body|spd|emp|cra|will|luck)(x|\*)?3$/.test(key))
      choices.push(key.replace('*', 'x'));
    else throw new RuleError(`Unknown magical defense: ${defense}.`);
  }
  if (includeCounters) choices.push('dispel', 'heliotrope');
  return [...new Set(choices)];
}

/** Resolve elemental side effects without rolling or applying duplicate damage. */
export function elementalBacklash(element, { mixedElement = null } = {}) {
  if (!MAGIC_ELEMENTS.includes(element)) throw new RuleError('Unknown magic element.');
  if (element === 'mixed' && mixedElement === null)
    return { element, needsElement: true, condition: '', pushMeters: 0 };
  if (element === 'mixed') {
    if (!MAGIC_ELEMENTS.slice(1).includes(mixedElement))
      throw new RuleError('Mixed magic requires an earth, air, fire, or water outcome.');
    element = mixedElement;
  }
  return {
    element,
    needsElement: false,
    condition: { earth: 'stunned', air: '', fire: 'fire', water: 'frozen' }[element],
    pushMeters: element === 'air' ? 2 : 0,
  };
}

/** Core pp.166,168. `fumble` is the full exploding continuation, not the initial 1.
 * Ritual/hex mishaps replace normal spell mishaps. The GM resolves a mixed element
 * once; damage is never doubled by passing through the mixed row of the table.
 */
export function magicalFumble({
  fumble = 0,
  element = 'mixed',
  kind = 'spell',
  mixedElement = null,
  ritualCost = 0,
} = {}) {
  finite(fumble, 'Fumble total', { integer: true });
  const result = {
    spellSucceeds: fumble === 0 || fumble <= 6,
    damage: 0,
    condition: '',
    pushMeters: 0,
    needsElement: false,
    focusExplosion: false,
    explosionFormula: '',
    explosionRadius: 0,
    hexBackfireChance: 0,
  };
  if (!fumble) return result;
  if (kind === 'hex') return { ...result, spellSucceeds: false, hexBackfireChance: 50 };
  if (kind === 'ritual')
    return { ...result, spellSucceeds: false, damage: finite(ritualCost, 'Ritual STA cost') };
  result.damage = fumble;
  if (fumble >= 7) Object.assign(result, elementalBacklash(element, { mixedElement }));
  if (fumble > 9)
    Object.assign(result, { focusExplosion: true, explosionFormula: '1d10', explosionRadius: 2 });
  return result;
}

/** Resolved values for the twelve signs; no RNG, actor mutation, or Foundry globals.
 * Aard uses the literal printed base 10% + 10% for each STA; see the audit notes.
 */
export function signParameters(key, power) {
  if (!SIGN_KEYS.includes(key)) throw new RuleError('Unknown witcher sign.');
  validateMagicPower(
    { kind: 'sign', cost: { min: 1, max: 7, step: 1, options: key === 'somne' ? [2, 4, 6, 7] : [] } },
    power
  );
  const result = {
    key,
    power,
    rangeMeters: 0,
    area: { shape: 'none', distance: 0, radius: 0, angle: null },
    durationRounds: 0,
    durationSeconds: 0,
    maintenanceCost: 0,
    defenses: [],
  };
  if (['aard', 'igni'].includes(key))
    Object.assign(result, {
      rangeMeters: 2,
      area: { shape: 'cone', distance: 2, radius: 0, angle: null },
      defenses: key === 'aard' ? ['dodge'] : ['dodge', 'block'],
    });
  if (['yrden', 'magic-trap', 'aard-sweep'].includes(key))
    Object.assign(result, {
      rangeMeters: key === 'aard-sweep' ? 4 : 3,
      area: { shape: 'circle', distance: 0, radius: key === 'aard-sweep' ? 4 : 3, angle: null },
    });
  switch (key) {
    case 'yrden':
      Object.assign(result, {
        durationRounds: 5,
        penalty: Math.min(4, 1 + Math.floor((power - 1) / 2)),
        makesCorporeal: true,
      });
      break;
    case 'quen':
      Object.assign(result, { durationRounds: 10, shieldHP: power * 5, recastWhileActive: false });
      break;
    case 'aard':
      Object.assign(result, { staggered: true, proneChance: 10 + power * 10 });
      break;
    case 'igni':
      Object.assign(result, {
        damageFormula: `${power}d6`,
        damageType: 'fire',
        igniteChance: 50,
        location: 'torso',
        aimAtPointBlank: true,
      });
      break;
    case 'axii':
      Object.assign(result, {
        rangeMeters: 8,
        defenses: ['resistMagic'],
        stunned: true,
        stunModifier: -(1 + Math.floor((power - 1) / 2)),
        repeatDefense: 'stun',
      });
      break;
    case 'magic-trap':
      Object.assign(result, {
        durationRounds: power,
        preparationRounds: 1,
        damageFormula: '3d6',
        damageType: 'elemental',
        defenses: ['dodge', 'block'],
        attacksPerRound: 1,
        closestEnemyOnly: true,
      });
      break;
    case 'active-shield':
      Object.assign(result, {
        shieldHP: power * 10,
        maintenanceCost: power,
        active: true,
        preventsRunning: true,
        blocksPassage: true,
        collapseDamage: '1d6',
        collapseLocation: 'torso',
        collapsePushMeters: 2,
        maximumPushWeight: 226,
        protectedExtraTargets: 1,
      });
      break;
    case 'aard-sweep':
      Object.assign(result, {
        defenses: ['dodge'],
        proneChance: power * 10,
        staggeredOnProne: true,
        affectsFlying: true,
      });
      break;
    case 'fire-stream':
      Object.assign(result, {
        rangeMeters: 3,
        damageFormula: `${power}d6`,
        damageType: 'fire',
        igniteChance: 75,
        location: 'chosen',
        maintenanceCost: power / 2,
        active: true,
        defenses: ['dodge', 'block'],
      });
      break;
    case 'puppet':
      Object.assign(result, {
        rangeMeters: 8,
        durationRounds: power,
        controlled: true,
        repeatDefense: 'resistMagic',
        defenses: ['resistMagic'],
      });
      break;
    case 'somne':
      Object.assign(result, {
        rangeMeters: 8,
        durationSeconds: 8 * 60 * 60,
        sleeping: true,
        stunned: true,
        wakesOnDamage: true,
        wake: { 2: 'noise', 4: 'action', 6: 'fullRound', 7: 'damage' }[power],
        defenses: ['resistMagic'],
      });
      break;
    case 'supirre':
      Object.assign(result, {
        rangeMeters: power * 2,
        durationSeconds: 10 * 60,
        listening: true,
        stationary: true,
        hearingCheckRequired: false,
      });
      break;
  }
  if (result.durationRounds) result.durationSeconds = result.durationRounds * 3;
  return result;
}

export function magicDuration(magic, power) {
  const row = data(magic);
  if (row?.kind === 'sign' && SIGN_KEYS.includes(row.key)) {
    const sign = signParameters(row.key, power);
    return {
      rounds: sign.durationRounds,
      seconds: sign.durationSeconds,
      active: Boolean(sign.active),
      maintenance: sign.maintenanceCost,
    };
  }
  const rounds = finite(row?.duration?.rounds ?? 0, 'Duration rounds'),
    seconds = finite(row?.duration?.seconds ?? rounds * 3, 'Duration seconds'),
    maintenance = magicMaintenance(row, power);
  return {
    rounds,
    seconds,
    active: row?.duration?.maintenance !== undefined && row.duration.maintenance !== 'none',
    maintenance,
  };
}

/** Core p.114 / Errata: shield interception precedes armor, resistance and body
 * multipliers. Call once per hit with the shield remaining from previous hits.
 */
export function absorbQuen({ raw, shieldHP, magic = false, defenses = [], source = 'attack' }) {
  finite(raw, 'Incoming raw damage');
  finite(shieldHP, 'Remaining Quen HP');
  const bypass = ['poison', 'poisoned', 'disease', 'suffocation', 'suffocating', 'bleeding'].includes(source),
    blockable = defenses.some((d) => String(d).toLowerCase() === 'block'),
    eligible = !bypass && (!magic || blockable),
    absorbed = eligible ? Math.min(raw, shieldHP) : 0;
  return {
    absorbed,
    remaining: raw - absorbed,
    shieldHP: shieldHP - absorbed,
    broken: shieldHP > 0 && absorbed === shieldHP,
    eligible,
  };
}
