import { RuleError, locate } from './rules.js';

const verbal = [
  'charisma',
  'persuasion',
  'seduction',
  'leadership',
  'deceit',
  'socialEtiquette',
  'intimidation',
];
const magic = ['spellCasting', 'hexWeaving', 'ritualCrafting'];
const map = (keys, value) => Object.fromEntries(keys.map((k) => [k, value]));
const wound = (name, modifiers = {}, stabilizedModifiers = {}, treatedModifiers = {}, extra = {}) => ({
  name,
  modifiers,
  stabilizedModifiers,
  treatedModifiers,
  ...extra,
});
// Rows are ordered 2–3, 4–5, 6–8, 9–10, 11, 12 (printed pp.158–160).
export const WOUNDS = {
  simple: [
    wound(
      'Sprained Leg',
      { spd: -2, dodge: -2, athletics: -2 },
      { spd: -1, dodge: -1, athletics: -1 },
      { spd: -1 }
    ),
    wound('Sprained Arm', { armActions: -2 }, { armActions: -1 }, { physique: -1 }),
    wound(
      'Foreign Object',
      { recMultiplier: 0.25, criticalHealingMultiplier: 0.25 },
      { recMultiplier: 0.5, criticalHealingMultiplier: 0.5 },
      { rec: -2, criticalHealing: -1 },
      { organ: true }
    ),
    wound('Cracked Ribs', { body: -2 }, { body: -1 }, { enc: -10 }),
    wound(
      'Disfiguring Scar',
      map(
        verbal.filter((k) => k !== 'intimidation'),
        -3
      ),
      map(
        verbal.filter((k) => k !== 'intimidation'),
        -1
      ),
      { seduction: -1 }
    ),
    wound('Cracked Jaw', map([...verbal, ...magic], -2), map([...verbal, ...magic], -1), map(magic, -1)),
  ],
  complex: [
    wound(
      'Fractured Leg',
      { spd: -3, dodge: -3, athletics: -3 },
      { spd: -2, dodge: -2, athletics: -2 },
      { spd: -1, dodge: -1, athletics: -1 }
    ),
    wound('Fractured Arm', { armActions: -3 }, { armActions: -2 }, { armActions: -1 }),
    wound('Broken Ribs', { body: -2, ref: -1, dex: -1 }, { body: -1, ref: -1 }, { body: -1 }),
    wound(
      'Ruptured Spleen',
      {},
      {},
      { stun: -2 },
      { stunEvery: 5, stabilizedStunEvery: 10, bleeding: true, organ: true }
    ),
    wound(
      'Lost Teeth',
      map([...verbal, ...magic], -3),
      map([...verbal, ...magic], -2),
      map([...verbal, ...magic], -1),
      { extraRoll: '1d10' }
    ),
    wound('Minor Head Wound', { int: -1, will: -1, stun: -1 }, { int: -1, will: -1 }, { will: -1 }),
  ],
  difficult: [
    wound(
      'Compound Leg Fracture',
      { spdMultiplier: 0.25, dodgeMultiplier: 0.25, athleticsMultiplier: 0.25 },
      { spdMultiplier: 0.5, dodgeMultiplier: 0.5, athleticsMultiplier: 0.5 },
      { spd: -2, dodge: -2, athletics: -2 },
      { bleeding: true }
    ),
    wound(
      'Compound Arm Fracture',
      { armDisabled: 1 },
      { armDisabled: 1 },
      { armDisabled: 1 },
      { bleeding: true }
    ),
    wound(
      'Sucking Chest Wound',
      { body: -3, spd: -3 },
      { body: -2, spd: -2 },
      { body: -1, spd: -1 },
      { suffocating: true, organ: true }
    ),
    wound(
      'Torn Stomach',
      { allActions: -2 },
      { allActions: -2 },
      { allActions: -1 },
      { damagePerTurn: 4, organ: true }
    ),
    wound(
      'Concussion',
      { int: -2, ref: -2, dex: -2 },
      { int: -1, ref: -1, dex: -1 },
      { int: -1, dex: -1 },
      { stunEveryFormula: '1d6' }
    ),
    wound(
      'Skull Fracture',
      { int: -1, dex: -1, headMultiplier: 4 },
      { int: -1, dex: -1, headMultiplier: 4 },
      { headMultiplier: 4 },
      { bleeding: true }
    ),
  ],
  deadly: [
    wound(
      'Dismembered Leg',
      { spdMultiplier: 0.25, dodgeMultiplier: 0.25, athleticsMultiplier: 0.25 },
      { spdMultiplier: 0.25, dodgeMultiplier: 0.25, athleticsMultiplier: 0.25 },
      { spdMultiplier: 0.25, dodgeMultiplier: 0.25, athleticsMultiplier: 0.25 },
      { bleeding: true, permanent: true }
    ),
    wound(
      'Dismembered Arm',
      { armDisabled: 1 },
      { armDisabled: 1 },
      { armDisabled: 1 },
      { bleeding: true, permanent: true }
    ),
    wound(
      'Septic Shock',
      { staMultiplier: 0.25, int: -3, will: -3, ref: -3, dex: -3 },
      { staMultiplier: 0.5, int: -1, will: -1, ref: -1, dex: -1 },
      { sta: -5 },
      { poison: true, permanent: true, organ: true }
    ),
    wound(
      'Heart Damage',
      { staMultiplier: 0.25, spdMultiplier: 0.25, bodyMultiplier: 0.25 },
      { staMultiplier: 0.5, spdMultiplier: 0.5, bodyMultiplier: 0.5 },
      { bleedingDamage: 2 },
      { bleeding: true, deathSave: true, permanent: true }
    ),
    wound(
      'Damaged Eye',
      { sightAwareness: -5, dex: -4 },
      { sightAwareness: -3, dex: -2 },
      { sightAwareness: -1, dex: -1 },
      { bleeding: true, permanent: true }
    ),
    wound('Separated Spine / Decapitated', {}, {}, {}, { fatal: true, permanent: true }),
  ],
};
export const woundModifiers = (w) =>
  w.treatment === 'healed'
    ? w.permanent
      ? Object.keys(w.healedModifiers ?? {}).length
        ? w.healedModifiers
        : w.treatedModifiers
      : {}
    : w.treatment === 'treated'
      ? w.treatedModifiers
      : w.treatment === 'stabilized'
        ? w.stabilizedModifiers
        : w.modifiers;

/** Critical wound conditions remain independent of other bleeding/poison/choking. */
export function woundConditionSources(items = [], condition) {
  if (!['bleeding', 'poison', 'suffocating'].includes(condition)) return [];
  return items.filter((item) => {
    if (item.type !== 'wound') return false;
    const wound = (item.system ?? item).wound;
    return (
      wound?.treatment === 'untreated' && wound[condition] && !wound.endedConditions?.includes(condition)
    );
  });
}
export function woundConditions(items = []) {
  return ['bleeding', 'poison', 'suffocating'].filter(
    (condition) => woundConditionSources(items, condition).length > 0
  );
}
export function combinedModifiers(actor, items = []) {
  const out = {};
  const sets = [
    actor.statModifiers ?? {},
    ...items.filter((i) => i.type === 'wound').map((i) => woundModifiers(i.wound)),
    ...items.filter((i) => i.equipped).map((i) => i.bonuses),
    ...(actor.effects ?? []).map((e) => e.modifiers),
  ];
  for (const mods of sets)
    for (const [key, value] of Object.entries(mods ?? {})) {
      if (key === 'headMultiplier') out[key] = Math.max(out[key] ?? 0, Number(value));
      else if (key.endsWith('Multiplier')) out[key] = (out[key] ?? 1) * Number(value);
      else out[key] = (out[key] ?? 0) + Number(value);
    }
  return out;
}
export function criticalWound(
  level,
  table,
  { roll, aimed = '', greater = 1, side = 1, balanced = 0, organless = false } = {}
) {
  if (!WOUNDS[level]) throw new RuleError('Invalid critical severity');
  let index, location;
  if (aimed) {
    location = locate(table, aimed);
    const group =
      location.group ||
      (/head/i.test(aimed) ? 'head' : /torso/i.test(aimed) ? 'torso' : /leg/i.test(aimed) ? 'leg' : 'arm');
    index =
      group === 'head'
        ? greater + balanced >= 5
          ? 5
          : 4
        : group === 'torso'
          ? greater + balanced >= 5
            ? 3
            : 2
          : group === 'leg'
            ? 0
            : 1;
  } else {
    if (!Number.isInteger(roll) || roll < 2 || roll > 12)
      throw new RuleError('Critical location requires 2d6');
    const result = Math.min(12, roll + balanced);
    index = result <= 3 ? 0 : result <= 5 ? 1 : result <= 8 ? 2 : result <= 10 ? 3 : result === 11 ? 4 : 5;
    const group = index === 0 ? 'leg' : index === 1 ? 'arm' : index < 4 ? 'torso' : 'head';
    let candidates = table.filter(
      (l) => l.group === group || (!l.group && l.id.toLowerCase().includes(group))
    );
    if (!candidates.length && ['leg', 'arm'].includes(group))
      candidates = table.filter((l) => /limb|wing|tail/i.test(l.id));
    if (!candidates.length)
      throw new RuleError(`Target has no ${group} location. Reroll the critical location (p.159).`);
    location = candidates[(side - 1) % candidates.length];
  }
  const data = structuredClone(WOUNDS[level][index]);
  const replacement = organless && data.organ;
  return {
    location: { ...location },
    wound: replacement
      ? null
      : {
          ...data,
          severity: level,
          location: location.id,
          treatment: 'untreated',
          turnsTreated: 0,
          daysRemaining: 0,
        },
    bonus: replacement
      ? { simple: 5, complex: 10, difficult: 15, deadly: 20 }[level]
      : { simple: 3, complex: 5, difficult: 8, deadly: 10 }[level],
  };
}

export const FUMBLES = {
  melee: [
    'No major fumble.',
    'Staggered.',
    'Weapon stuck; one full round to free it.',
    'Weapon loses 1d10 reliability.',
    'Strike yourself; roll a hit location.',
    'Strike a random ally within reach; roll a hit location.',
  ],
  ranged: [
    'No major fumble.',
    'Ammunition or thrown weapon breaks.',
    'Ammunition or thrown weapon breaks.',
    'Bowstring loose / crossbow jammed / thrown weapon dropped; one round to fix.',
    'Bowstring loose / crossbow jammed / thrown weapon dropped; one round to fix.',
    'Ricochet strikes a random ally in range; roll a hit location.',
  ],
  armedDefense: [
    'No major fumble.',
    'Weapon loses 1d6 reliability.',
    'Weapon flies 1d6 metres in a random direction.',
    'Prone; make a Stun save.',
    'Weapon loses 2d6 reliability.',
    'Your weapon strikes you; roll a hit location.',
  ],
  unarmed: [
    'No major fumble.',
    'Staggered.',
    'Prone.',
    'Prone; make a Stun save.',
    'Prone; 1d6 nonlethal damage to head; Stun save.',
    'Prone; 1d6 lethal damage to head; Stun save.',
  ],
};
export function fumbleText(kind, severity) {
  return FUMBLES[kind]?.[severity <= 5 ? 0 : Math.min(5, severity - 5)] ?? '';
}
