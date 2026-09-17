/** Source identities shared by catalog, installation and actual rule consumers. */
export const ENHANCEMENT_SCOPE = 'witcher-rilerena';
export const CORE_RUNE_KEYS = [
  'chemobog',
  'dazhbog',
  'devanna',
  'morana',
  'perun',
  'stribog',
  'svarog',
  'triglav',
  'veles',
  'zoria',
];
export const ELEMENTAL_GLYPHS = { magic: 'mixed', air: 'air', earth: 'earth', fire: 'fire', water: 'water' };
export const TOME_GLYPHS = [
  {
    key: 'binding',
    name: 'Glyph of Binding',
    cost: 200,
    effect:
      'While worn, reduces the chance of suffering Bleeding by 30 percentage points (40 with Runewright inscription).',
  },
  {
    key: 'mending',
    name: 'Glyph of Mending',
    cost: 450,
    effect: 'While worn, each time you regain HP, regain 1 additional HP (2 with Runewright inscription).',
  },
  {
    key: 'reinforcement',
    name: 'Glyph of Reinforcement',
    cost: 100,
    effect: 'Armor SP increases by 3 (4 with Runewright inscription).',
  },
  {
    key: 'warding',
    name: 'Glyph of Warding',
    cost: 300,
    effect:
      'While worn, grants resistance to damage from an elemental source such as fire or lightning. Runewright inscription also grants +1 Resist Magic.',
  },
];
export const ENCHANTMENT_WORDS = [
  {
    key: 'burning',
    category: 'runeword',
    slots: 2,
    target: 'weapon',
    components: ['chemobog', 'dazhbog'],
    investment: 1175,
    cost: 2150,
    page: 111,
    recipePage: 113,
    effect:
      'The wielder may change this weapon’s damage to fire, bypassing physical damage resistance but respecting fire resistance and immunity. This does not ignite the target.',
  },
  {
    key: 'deflection',
    category: 'runeword',
    slots: 3,
    target: 'weapon',
    components: ['chemobog', 'perun', 'stribog'],
    investment: 1650,
    cost: 3300,
    page: 111,
    recipePage: 114,
    effect:
      'Parry a ranged attack using weapon skill base −6. On success choose a target within 10m; they take a defense action against the parry roll or become Staggered. If the wielder has Parry Arrows ranks, instead grant +2 to that ability.',
  },
  {
    key: 'depletion',
    category: 'runeword',
    slots: 3,
    target: 'weapon',
    components: ['stribog', 'triglav', 'veles'],
    investment: 1675,
    cost: 3350,
    page: 111,
    recipePage: 114,
    effect:
      'When a spell or invocation is cast using this weapon as its focus, a target who fails to defend additionally loses 1d6 STA.',
  },
  {
    key: 'placation',
    category: 'runeword',
    slots: 2,
    target: 'weapon',
    components: ['morana', 'stribog'],
    investment: 1075,
    cost: 2150,
    page: 111,
    recipePage: 113,
    effect: 'While carried, using an Adrenaline die costs 5 STA instead of 10.',
  },
  {
    key: 'preservation',
    category: 'runeword',
    slots: 2,
    target: 'weapon-or-shield',
    components: ['devanna', 'morana'],
    investment: 1150,
    cost: 2300,
    page: 111,
    recipePage: 113,
    effect: 'The weapon or shield gains +5 maximum and current Reliability while retaining existing wear.',
  },
  {
    key: 'prolongation',
    category: 'runeword',
    slots: 2,
    target: 'weapon',
    components: ['perun', 'svarog'],
    investment: 1175,
    cost: 2150,
    page: 111,
    recipePage: 113,
    effect:
      'When a spell or invocation is cast using this weapon as its focus and its duration is expressed in dice, roll duration twice and keep the higher result.',
  },
  {
    key: 'rejuvenation',
    category: 'runeword',
    slots: 3,
    target: 'weapon',
    components: ['perun', 'svarog', 'triglav'],
    investment: 1750,
    cost: 3500,
    page: 111,
    recipePage: 114,
    effect: 'When this weapon kills a creature, restore STA equal to the wielder’s REC.',
  },
  {
    key: 'shearing',
    category: 'runeword',
    slots: 2,
    target: 'weapon',
    components: ['veles', 'zoria'],
    investment: 1150,
    cost: 2300,
    page: 111,
    recipePage: 113,
    effect:
      'An attack penetrating armor or a shield deals an additional 1 damage to its SP or Reliability respectively.',
  },
  {
    key: 'balance',
    category: 'glyphword',
    slots: 2,
    target: 'armor',
    components: ['mending', 'reinforcement'],
    investment: 550,
    cost: 1100,
    page: 112,
    recipePage: 113,
    effect: 'Armor EV decreases by 1, to a minimum of 0.',
  },
  {
    key: 'beguilement',
    category: 'glyphword',
    slots: 2,
    target: 'head',
    components: ['fire', 'water'],
    investment: 1150,
    cost: 2300,
    page: 112,
    recipePage: 113,
    effect: 'While worn, grants +1 Charisma, Grooming and Style, and Leadership.',
  },
  {
    key: 'heft',
    category: 'glyphword',
    slots: 2,
    target: 'armor',
    components: ['mending', 'reinforcement'],
    investment: 550,
    cost: 1100,
    page: 112,
    recipePage: 113,
    effect: 'Armor SP increases by 2 and EV doubles; EV0 remains 0.',
  },
  {
    key: 'protection',
    category: 'glyphword',
    slots: 3,
    target: 'torso',
    components: ['earth', 'magic', 'warding'],
    investment: 1450,
    cost: 2900,
    page: 112,
    recipePage: 114,
    effect: 'While worn, grants +5 HP. Equipping and removing the armor must not repeatedly heal damage.',
  },
  {
    key: 'retribution',
    category: 'glyphword',
    slots: 3,
    target: 'armor',
    components: ['earth', 'fire', 'reinforcement'],
    investment: 1250,
    cost: 2500,
    page: 112,
    recipePage: 114,
    effect:
      'When the wearer takes damage from an attack, its attacker takes 3 damage to the torso, ignoring armor.',
  },
  {
    key: 'rotation',
    category: 'glyphword',
    slots: 2,
    target: 'legs',
    components: ['binding', 'reinforcement'],
    investment: 300,
    cost: 600,
    page: 112,
    recipePage: 113,
    effect: 'While worn, attackers gain no bonus for attacking from outside the wearer’s vision cone.',
  },
  {
    key: 'shining',
    category: 'glyphword',
    slots: 2,
    target: 'torso',
    components: ['air', 'warding'],
    investment: 875,
    cost: 1750,
    page: 112,
    recipePage: 113,
    effect:
      'Spend an action to produce daylight out to 6m for 30 minutes, affecting weaknesses and susceptibility to light and sunlight.',
  },
];
export const wordDefinition = (key) => ENCHANTMENT_WORDS.find((entry) => entry.key === key);
const normalize = (name) =>
  String(name ?? '')
    .toLowerCase()
    .replace(/[’']/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
export function enhancementIdentity(item) {
  const recorded = item?.flags?.[ENHANCEMENT_SCOPE]?.enhancement;
  if (recorded?.key && recorded?.category) return { key: recorded.key, category: recorded.category };
  const system = item?.system ?? item ?? {},
    category = system.category;
  let key = normalize(item?.name ?? system.name)
    .replace(/^glyph-of-/, '')
    .replace(/-enhancement$/, '')
    .replace(/^(runeword|glyphword)-/, '');
  if (key === 'devana') key = 'devanna';
  if (category === 'rune' && CORE_RUNE_KEYS.includes(key)) return { key, category };
  if (
    category === 'glyph' &&
    (Object.hasOwn(ELEMENTAL_GLYPHS, key) || TOME_GLYPHS.some((entry) => entry.key === key))
  )
    return { key, category };
  if (category === 'armor' && item.type === 'enhancement') return { key, category: 'physical' };
  if (wordDefinition(key)?.category === category) return { key, category };
  return null;
}

export function enhancementRule(identity, { improved = false, source = {} } = {}) {
  const { key, category } = identity;
  const rule = {
    properties: {},
    resistances: [],
    skillBonuses: [],
    sp: 0,
    reliability: 0,
    evAdd: 0,
    evMultiplier: 1,
  };
  if (category === 'physical')
    return {
      ...rule,
      properties: structuredClone(source.properties ?? {}),
      resistances: [...(source.resistances ?? [])],
      skillBonuses: structuredClone(source.skillBonuses ?? []),
      sp: Number(source.stoppingPower ?? 0),
    };
  if (category === 'rune') {
    const chance = {
      dazhbog: 'fire',
      devanna: 'bleeding',
      morana: 'poison',
      stribog: 'stagger',
      zoria: 'freeze',
    }[key];
    if (chance) rule.properties[chance] = improved ? 40 : 30;
    if (key === 'svarog') rule.properties[improved ? 'improvedArmorPiercing' : 'armorPiercing'] = true;
    if (key === 'triglav') Object.assign(rule.properties, { stunWeapon: true, stun: improved ? -2 : -1 });
    if (key === 'veles')
      Object.assign(rule.properties, { greaterFocus: true, ...(improved ? { focus: 1 } : {}) });
    if (key === 'chemobog') rule.chemobogThreshold = improved ? 3 : 4;
    if (key === 'perun') Object.assign(rule, { adrenalineExtra: 1, adrenalineRetainOne: improved });
  }
  if (category === 'glyph') {
    if (Object.hasOwn(ELEMENTAL_GLYPHS, key))
      rule.elementalGlyph = { element: ELEMENTAL_GLYPHS[key], dc: improved ? 4 : 3, damageDice: 1 };
    if (key === 'binding') rule.bleedingReduction = improved ? 40 : 30;
    if (key === 'mending') rule.healingBonus = improved ? 2 : 1;
    if (key === 'reinforcement') rule.sp = improved ? 4 : 3;
    if (key === 'warding') {
      rule.resistances.push('elemental');
      if (improved) rule.skillBonuses.push({ skill: 'resistMagic', value: 1, condition: '' });
    }
  }
  if (category === 'runeword' || category === 'glyphword') {
    rule.word = key;
    if (key === 'preservation') rule.reliability = 5;
    if (key === 'balance') rule.evAdd = -1;
    if (key === 'heft') Object.assign(rule, { sp: 2, evMultiplier: 2 });
    if (key === 'beguilement')
      rule.skillBonuses = ['charisma', 'grooming', 'leadership'].map((skill) => ({
        skill,
        value: 1,
        condition: '',
      }));
    if (key === 'protection') rule.hp = 5;
  }
  return rule;
}
