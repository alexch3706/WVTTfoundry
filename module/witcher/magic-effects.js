import { magicInfo, MAGIC } from './magic-catalog.js';
import { CONDITIONS, SKILLS, STATS } from './config.js';
import { RuleError } from './rules.js';

/** Pure procedures, not a claim that a Foundry executor supports every operation. */
const registry = new Map();
const clone = (value) => structuredClone(value);
const choice = (key, type, options = {}) => ({ key, type, required: true, ...options });
const select = (key, options, extra = {}) => choice(key, 'enum', { options, ...extra });
const numeric = (key, min = 0, extra = {}) => choice(key, 'number', { min, ...extra });
const text = (key, extra = {}) => choice(key, 'string', extra);
const target = (key, type = 'actor', extra = {}) => choice(key, type, extra);
const op = (type, params = {}, destination = 'target', timing = 'immediate') => ({
  type,
  target: destination,
  timing,
  ...params,
});
const damage = (formula, params = {}, destination = 'target') =>
  op(
    'damage',
    {
      formula,
      damageType: 'elemental',
      armor: 'normal',
      location: 'random',
      physicalCritical: false,
      ...params,
    },
    destination
  );
const condition = (key, params = {}, destination = 'target') =>
  op('condition', { condition: key, action: 'add', chance: 100, ...params }, destination);
const modifier = (modifiers, params = {}, destination = 'target') =>
  op('modifier', { modifiers, ...params }, destination);
const rule = (key, params = {}, destination = 'target') =>
  op('modifier', { modifiers: {}, rule: { key, ...params } }, destination);
const narrative = (procedure, params = {}) => op('narrative', { procedure, adjudicator: 'gm', ...params });
const move = (distance, params = {}, destination = 'target') =>
  op('move', { distance, unit: 'm', mode: 'push', collision: 'ramming', ...params }, destination);
const reveal = (fields, params = {}, destination = 'target') =>
  op('reveal', { fields, ...params }, destination);
const heal = (amount, params = {}, destination = 'target') =>
  op('heal', { amount, resource: 'hp', ...params }, destination);
const resource = (resourceKey, amount, params = {}, destination = 'target') =>
  op('resource', { resource: resourceKey, amount, mode: 'add', ...params }, destination);
const zone = (shape, operations, params = {}) =>
  op('zone', { shape, operations, stationary: true, ...params }, 'area');
const save = (skill, dc, onFailure, params = {}) => ({ skill, dc, onFailure, ...params });
const active = (operations, cost, params = {}) =>
  op(
    'modifier',
    { modifiers: {}, rule: { key: 'activeActions', operations, maintenanceCost: cost, ...params } },
    'caster'
  );

function define(key, kinds, build, { choices = [], triggers = [], notes = [] } = {}) {
  const magic = magicInfo(key);
  if (!magic || !['spell', 'invocation'].includes(magic.kind))
    throw new Error(`Unknown spell or invocation: ${key}`);
  if (registry.has(key)) throw new Error(`Duplicate magic effect procedure: ${key}`);
  registry.set(key, { key, kinds, build, choices, triggers, notes });
}

function contextFor(magic, values, requirements) {
  const choices = values.choices ?? {};
  const rolls = values.rolls ?? {};
  const needed = (key, value, descriptor) => {
    if (value === undefined || value === null || value === '') {
      if (!requirements.some((entry) => entry.key === key && entry.type === descriptor.type))
        requirements.push({ key, ...descriptor });
      return descriptor.placeholder ?? 0;
    }
    if (descriptor.type === 'roll' || descriptor.type === 'contextNumber') {
      if (!Number.isFinite(Number(value)) || (descriptor.type === 'roll' && !Number.isInteger(Number(value))))
        throw new RuleError(`${key} must be finite.`);
      if (descriptor.min !== undefined && Number(value) < descriptor.min)
        throw new RuleError(`${key} must be at least ${descriptor.min}.`);
      if (descriptor.max !== undefined && Number(value) > descriptor.max)
        throw new RuleError(`${key} must not exceed ${descriptor.max}.`);
      return Number(value);
    }
    return value;
  };
  return {
    magic,
    choices,
    rolls,
    power: values.power ?? magic.cost.min,
    castTotal: values.castTotal,
    defenseDC: values.castTotal + (values.defenseBonus ?? 0),
    get: (key) => choices[key],
    number: (key, options = {}) => needed(key, values[key], { type: 'contextNumber', ...options }),
    roll: (key, formula, options = {}) => needed(key, rolls[key], { type: 'roll', formula, ...options }),
    duration: durationFor(magic, values, requirements),
  };
}

function durationFor(magic, values, requirements) {
  const result = clone(magic.duration);
  if (magic.key === 'magic-healing' && values.choices?.mode === 'critical')
    return { text: 'One critical-treatment use', rounds: 0, seconds: 0, maintenance: 'none' };
  if (magic.key === 'seirff-haul' && values.choices?.durationRounds)
    return {
      text: 'GM-resolved duration',
      rounds: values.choices.durationRounds,
      seconds: values.choices.durationRounds * 3,
      maintenance: 'none',
    };
  if (result.formula && !result.unresolvedUnit) {
    const unit = /Hours?/i.test(result.text) ? 'hours' : /Rounds?/i.test(result.text) ? 'rounds' : null;
    if (!unit) return result;
    const value = values.rolls?.duration;
    const dice = /^(\d+)d(\d+)([+-]\d+)?$/.exec(result.formula);
    const min = dice ? Number(dice[1]) + Number(dice[3] ?? 0) : 1;
    const max = dice ? Number(dice[1]) * Number(dice[2]) + Number(dice[3] ?? 0) : undefined;
    if (value === undefined)
      requirements.push({ type: 'roll', key: 'duration', formula: result.formula, min, max });
    else {
      if (!Number.isInteger(value) || value < min || (max !== undefined && value > max))
        throw new RuleError('The duration roll is outside the printed dice range.');
      result.seconds = value * (unit === 'hours' ? 3600 : 3);
      result.rounds = unit === 'rounds' ? value : 0;
    }
  }
  return result;
}

function validateChoices(descriptors, input, requirements) {
  for (const descriptor of descriptors) {
    if (descriptor.when && input[descriptor.when.key] !== descriptor.when.equals) continue;
    const value = input[descriptor.key];
    if (value === undefined || value === null || value === '') {
      if (descriptor.required)
        requirements.push({ ...descriptor, type: 'choice', inputType: descriptor.type });
      continue;
    }
    if (descriptor.mustEqual !== undefined && value !== descriptor.mustEqual)
      throw new RuleError(`${descriptor.key} does not satisfy this spell’s prerequisite.`);
    if (descriptor.differentFrom && value === input[descriptor.differentFrom])
      throw new RuleError(`${descriptor.key} must differ from ${descriptor.differentFrom}.`);
    if (descriptor.type === 'enum' && !descriptor.options.includes(value))
      throw new RuleError(`Invalid ${descriptor.key}.`);
    if (descriptor.type === 'number') {
      if (!Number.isFinite(value) || (descriptor.integer && !Number.isInteger(value)))
        throw new RuleError(`${descriptor.key} must be a valid number.`);
      if (descriptor.min !== undefined && value < descriptor.min)
        throw new RuleError(`${descriptor.key} is below its minimum.`);
      if (descriptor.max !== undefined && value > descriptor.max)
        throw new RuleError(`${descriptor.key} exceeds its maximum.`);
    }
    if (descriptor.type === 'boolean' && typeof value !== 'boolean')
      throw new RuleError(`${descriptor.key} must be true or false.`);
    if (['string', 'actor', 'item', 'point', 'effect'].includes(descriptor.type) && typeof value !== 'string')
      throw new RuleError(`${descriptor.key} requires a selected identifier or text.`);
  }
}

export function requiredChoices(value) {
  const key = typeof value === 'string' ? value : value?.key;
  return clone(registry.get(key)?.choices ?? []);
}

export function spellEffectPlan(value, values = {}) {
  const magic = magicInfo(typeof value === 'string' ? value : value?.key);
  const spec = registry.get(magic?.key);
  if (!spec) throw new RuleError('This magic has no audited effect procedure.');
  if (!Number.isFinite(values.castTotal)) throw new RuleError('Supply the authoritative casting total.');
  if (!Number.isInteger(values.defenseBonus ?? 0) || (values.defenseBonus ?? 0) < 0)
    throw new RuleError(
      'Supply a nonnegative whole defense DC bonus from validated focus and glyph sources.'
    );
  const power = values.power ?? magic.cost.min;
  if (!Number.isFinite(power) || power < 0) throw new RuleError('Magic power must be a nonnegative number.');
  if (magic.cost.max > 0 && (power < magic.cost.min || power > magic.cost.max))
    throw new RuleError('Magic power is outside its printed STA range.');
  if (magic.cost.options.length && !magic.cost.options.includes(power))
    throw new RuleError('Select a printed STA option.');
  const requirements = [];
  validateChoices(spec.choices, values.choices ?? {}, requirements);
  const context = contextFor(magic, values, requirements);
  const operations = spec
    .build(context)
    .map((operation) => ({ duration: clone(context.duration), ...operation }));
  const ready = requirements.length === 0;
  return {
    key: magic.key,
    source: magic.source,
    page: magic.page,
    duration: context.duration,
    ready,
    requirements,
    operations: ready ? operations : [],
    adjudications: ready ? flattenOperations(operations).filter((entry) => entry.type === 'narrative') : [],
    requiredExecutorKinds: [...spec.kinds],
    ongoingTriggers: [...spec.triggers],
    notes: [...spec.notes],
  };
}

export const OPERATION_KINDS = new Set([
  'damage',
  'heal',
  'condition',
  'modifier',
  'resource',
  'move',
  'shield',
  'zone',
  'summon',
  'transform',
  'dispel',
  'restoreWound',
  'item',
  'reveal',
  'narrative',
]);
export function flattenOperations(operations) {
  const result = [];
  function visit(value) {
    if (!value || typeof value !== 'object') return;
    if (typeof value.type === 'string' && OPERATION_KINDS.has(value.type)) result.push(value);
    for (const child of Object.values(value)) {
      if (Array.isArray(child)) child.forEach(visit);
      else if (child && typeof child === 'object') visit(child);
    }
  }
  operations.forEach(visit);
  return result;
}

// Direct damage, statuses, and stat changes. These procedures have no narrative substitutes.
define('blinding-dust', ['condition'], () => [condition('blinded')]);
define('glamour', ['modifier'], () => [modifier({ seduction: 3, charisma: 3, leadership: 3 }, {}, 'caster')]);
define('cenlly-graig', ['damage'], (c) => [
  damage(`${Math.min(10, Math.max(0, c.castTotal - c.number('defenseTotal')))}d6`, {
    damageType: 'piercing',
    physicalCritical: true,
  }),
]);
define('earthen-spike', ['damage', 'item'], () => [
  damage('5d6', { damageType: 'piercing', physicalCritical: true }),
  op('item', { action: 'createCover', hp: 20, destruction: 'hp', persists: true }, 'area'),
]);
define('koraths-breath', ['condition'], (c) => [
  condition('blinded', { duration: { rounds: c.roll('blindRounds', '1d6', { min: 1, max: 6 }) } }),
]);
define('aenye', ['damage', 'condition'], () => [
  damage('4d6', { damageType: 'fire' }),
  condition('fire', { chance: 75 }),
]);
define(
  'brand-of-fire',
  ['damage', 'item'],
  (c) => [
    damage('1d6', { damageType: 'fire', location: c.get('location') }),
    op('item', { action: 'recordScar', text: c.get('mark'), location: c.get('location'), permanent: true }),
  ],
  { choices: [text('mark'), text('location', { mustBeExposed: true })] }
);
define('magic-flare', ['condition', 'reveal'], (c) => [
  condition('blinded', { duration: { rounds: c.roll('blindRounds', '1d6', { min: 1, max: 6 }) } }),
  reveal(['light'], { visibleDistance: 10000 }, 'area'),
]);
define('tanio-ilchar', ['condition'], () => [condition('fire')]);
define('wave-of-fire', ['damage', 'condition'], () => [
  damage('2d6', { damageType: 'fire' }),
  condition('fire', { chance: 50 }),
]);
define('carys-hail', ['damage', 'condition'], (c) => [
  damage(`${Math.min(5, Math.max(0, c.castTotal - c.number('defenseTotal')))}d6`, {
    physicalCritical: true,
    element: 'ice',
    attacks: 1,
  }),
  condition('frozen', { chance: 25 }),
]);
define(
  'rhewi',
  ['condition', 'modifier'],
  (c) => (c.get('living') ? [condition('frozen')] : [rule('immovableObject')]),
  { choices: [choice('living', 'boolean')] }
);
define('anialwch', ['damage', 'resource'], () => [
  damage('4d6', { armor: 'ignore', shield: 'ignore', location: 'none', elementalInternal: true }),
  resource('sta', '-4d6', { separateRoll: true }),
]);
define('waves-of-the-naglfar', ['damage', 'condition'], () => [
  damage('4d6', { element: 'ice' }),
  condition('frozen'),
]);
define('primal-reservoir', ['modifier'], () => [modifier({ meleeBonus: 2, int: -2 })]);
define('blessing-of-love', ['modifier'], () => [modifier({ charisma: 3, seduction: 3 }, {}, 'caster')]);
define('waters-of-clearance', ['condition'], () => [
  condition('intoxicated', { action: 'remove', cause: 'alcoholOrAlchemicalIntoxicant' }),
]);
define('cleansing-fire', ['damage', 'condition'], () => [
  damage('3d6', { damageType: 'fire' }),
  condition('fire'),
]);
define('blemish', ['modifier'], (c) => [
  modifier(
    { seduction: -3, charisma: -3, leadership: -3 },
    { hiddenFromTarget: true, discovery: { told: true, reflection: save('awareness', 16, []) } }
  ),
]);
define('light-feet', ['modifier'], () => [
  modifier(
    { spd: 5 },
    { derivedOverrides: { runBonus: 15, leapBonus: 3 }, avoidDoubleDerivation: true },
    'caster'
  ),
]);
define('breath-of-fire', ['damage', 'condition'], () => [
  damage('3d6', { damageType: 'fire' }),
  condition('fire'),
]);
define(
  'water-jet',
  ['damage', 'condition'],
  (c) => [damage('4d6', { damageType: c.get('damageType'), physicalCritical: true }), condition('prone')],
  { choices: [select('damageType', ['slashing', 'piercing', 'bludgeoning']), target('waterSource', 'point')] }
);
define(
  'disrupt-focus',
  ['item'],
  (c) => [op('item', { action: 'suppressFocus', itemId: c.get('focusItem'), value: 0 }, 'item')],
  { choices: [target('focusItem', 'item', { requiresProperty: 'focus' })] }
);
define('light-of-penance', ['resource'], (c) => [
  resource('sta', c.number('targetVigor', { min: 0 }) >= 1 ? '-4d6' : '-2d6'),
]);
define(
  'divine-inspiration',
  ['modifier'],
  (c) => [modifier({ [c.get('skill')]: 2 }, { usesPerDay: 1, minimumOriginalSkillRank: 1 })],
  { choices: [select('skill', Object.keys(SKILLS))] }
);
define(
  'brand-of-withering',
  ['modifier'],
  () => [rule('preventHPRecovery', { natural: true, magical: true })],
  { triggers: ['beforeHealing'] }
);
define(
  'blood-of-the-mountain',
  ['modifier'],
  () => [rule('empoweredMelee', { cannotBeParried: true, ablationMultiplier: 2 }), rule('immuneToKnockdown')],
  { triggers: ['attack', 'ablation', 'forcedMovement'] }
);
define(
  'slip-stream',
  ['modifier'],
  () => [
    rule(
      'swimming',
      { spdOverride: 12, ignoreUnderwaterAttackPenalty: true, ignoreUnderwaterDefensePenalty: true },
      'caster'
    ),
  ],
  { triggers: ['movement', 'attack', 'defense'] }
);
define('auroras-breath', ['modifier'], () => [rule('breatheWaterAndAir', {}, 'caster')], {
  triggers: ['suffocation'],
});
define('holy-light', ['reveal'], () => [
  reveal(['illumination'], { intensity: 'torch', heat: false, ignites: false }, 'caster'),
]);
define('diagnostic-spell', ['reveal'], () => [reveal(['hp', 'wounds', 'disease', 'poison'])]);
define('threads-of-life', ['reveal'], () => [reveal(['hp', 'wounds'], {}, 'targets')]);
define('natures-sight', ['reveal'], () => [
  reveal(['unnaturalCreatures'], { distance: 50, throughObstacles: true }, 'caster'),
]);
define('blessing-of-fortune', ['resource'], (c) => [
  resource('luck', Math.min(5, Math.max(0, Math.floor((c.castTotal - 12) / 2))), {
    temporary: true,
    duration: { until: 'spent' },
  }),
]);
define(
  'sharpen-senses',
  ['modifier', 'condition'],
  () => [
    modifier({ awareness: 2 }, { traits: { nightVision: true, scentTracking: true } }, 'caster'),
    condition('staggered', { trigger: 'brightLightOrVeryLoudNoise' }, 'caster'),
  ],
  { triggers: ['sensoryExposure'] }
);
define(
  'blessed-weapon',
  ['item'],
  (c) => [
    op('item', { action: 'property', itemId: c.get('weapon'), property: 'balanced', value: true }, 'item'),
  ],
  { choices: [target('weapon', 'item', { meleeOnly: true })] }
);
define(
  'presence-of-the-divine',
  ['modifier', 'reveal'],
  (c) =>
    c.get('mode') === 'presence'
      ? [modifier({ intimidation: 4 }, {}, 'caster'), reveal(['boomingVoice'], {}, 'caster')]
      : [rule('immuneToFear', { maxTargets: 6 }, 'targets')],
  { choices: [select('mode', ['presence', 'fearImmunity'])] }
);
define(
  'voice-of-the-counselor',
  ['modifier', 'reveal'],
  (c) => [
    modifier({ leadership: 4 }, {}, 'caster'),
    reveal(
      [c.get('voice') === 'booming' ? 'boomingVoice' : 'privateWhisper'],
      { selectedListener: c.get('listener') },
      'caster'
    ),
  ],
  {
    choices: [
      select('voice', ['booming', 'whisper']),
      target('listener', 'actor', { when: { key: 'voice', equals: 'whisper' } }),
    ],
  }
);

export function plannedMagicKeys() {
  return [...registry.keys()];
}
function procedureVariants(spec) {
  let variants = [{}];
  for (const field of spec.choices) {
    const options =
      field.type === 'enum'
        ? field.options
        : field.type === 'boolean'
          ? [false, true]
          : [field.type === 'number' ? Math.max(field.min ?? 0, 1) : field.key];
    variants = variants.flatMap((variant) => options.map((value) => ({ ...variant, [field.key]: value })));
  }
  const magic = magicInfo(spec.key);
  const powers = magic.cost.options.length ? magic.cost.options : [magic.cost.min];
  return variants.flatMap((values) =>
    powers.map((power) =>
      spec.build({
        magic,
        choices: values,
        rolls: {},
        power,
        castTotal: 25,
        defenseDC: 25,
        duration: magic.duration,
        get: (key) => values[key],
        number: (_key, options = {}) => Math.max(options.min ?? 0, Math.min(options.max ?? 10, 10)),
        roll: (_key, _formula, options = {}) => Math.max(options.min ?? 1, 1),
      })
    )
  );
}
export function supportProfiles() {
  return Object.fromEntries(
    [...registry].map(([key, spec]) => {
      const nested = flattenOperations(procedureVariants(spec).flat());
      const requiredRules = [
        ...new Set(nested.filter((entry) => entry.rule?.key).map((entry) => entry.rule.key)),
      ].sort();
      const requiredActions = [
        ...new Set(nested.filter((entry) => entry.action).map((entry) => `${entry.type}:${entry.action}`)),
      ].sort();
      const actualKinds = [...new Set([...spec.kinds, ...nested.map((entry) => entry.type)])].sort();
      return [
        key,
        {
          key,
          requiredExecutorKinds: actualKinds,
          requiredRules,
          requiredActions,
          choices: clone(spec.choices),
          ongoingTriggers: [...spec.triggers],
          notes: [...spec.notes],
        },
      ];
    })
  );
}
export function keysForExecutorKinds(kinds, { rules = [], actions = [], triggers = [] } = {}) {
  const supported = new Set(kinds),
    supportedRules = new Set(rules),
    supportedActions = new Set(actions),
    supportedTriggers = new Set(triggers);
  return Object.values(supportProfiles())
    .filter(
      (spec) =>
        spec.requiredExecutorKinds.every((kind) => supported.has(kind)) &&
        spec.requiredRules.every((key) => supportedRules.has(key)) &&
        spec.requiredActions.every((key) => supportedActions.has(key)) &&
        spec.ongoingTriggers.every((key) => supportedTriggers.has(key))
    )
    .map((spec) => spec.key);
}

// Core: utility magic, zones, and persistent procedures.
define('afans-mirror', ['summon'], (c) => [
  op(
    'summon',
    {
      profile: 'illusoryCaster',
      count: c.roll('copies', '1d10', { min: 1, max: 10 }),
      tangible: false,
      controller: 'caster',
      controlAction: 'none',
      maxDistanceFromCaster: 10,
    },
    'area'
  ),
]);
define(
  'dispel',
  ['dispel'],
  (c) => [
    op('dispel', {
      effectId: c.get('effect'),
      castingTotal: c.castTotal,
      originalCastingTotal: c.number('originalCastingTotal'),
      succeeds: c.castTotal > c.number('originalCastingTotal'),
      cost: c.number('originalSTA', { min: 0 }) / 2,
      kinds: ['spell', 'sign', 'invocation', 'ritual', 'hex'],
      mayCounterImmediateAttack: true,
    }),
  ],
  { choices: [target('effect', 'effect')] }
);
define(
  'magic-compass',
  ['reveal', 'narrative'],
  (c) => [
    reveal(['direction'], { destination: c.get('destination') }, 'caster'),
    narrative('identifyDirection', {
      destination: c.get('destination'),
      mustHaveVisited: c.get('destination') !== 'north',
    }),
  ],
  { choices: [text('destination')] }
);
define(
  'mind-manipulation',
  ['modifier', 'narrative'],
  (c) => [
    rule('imposedEmotion', { emotion: c.get('emotion') }),
    narrative('roleplayEmotion', { emotion: c.get('emotion'), doesNotGrantMindControl: true }),
  ],
  { choices: [select('emotion', ['hatred', 'love', 'depression', 'euphoria'])] }
);
define(
  'summon-staff',
  ['item'],
  (c) => [
    op(
      'item',
      {
        action: 'relocate',
        itemId: c.get('staff'),
        destination: c.get('destination'),
        maximumHoursSinceVisit: 24,
        recall: c.get('mode') === 'recall',
      },
      'item'
    ),
  ],
  {
    choices: [
      target('staff', 'item'),
      select('mode', ['send', 'recall']),
      target('destination', 'point', { when: { key: 'mode', equals: 'send' } }),
    ],
  }
);
define(
  'telepathy',
  ['reveal', 'modifier'],
  (c) => [
    reveal(
      ['telepathicCommunication'],
      { languageIndependent: true, participant: c.get('participant'), covert: c.get('mode') === 'listen' },
      'caster'
    ),
    rule('telepathyDetection', {
      witcherMedallion: 'vibrate',
      perRoundSkill: 'magicTraining',
      dc: c.defenseDC,
      covertOnly: c.get('mode') === 'listen',
    }),
  ],
  { choices: [target('participant'), select('mode', ['communicate', 'listen'])], triggers: ['startTurn'] }
);
define(
  'codi-bywyd',
  ['item'],
  (c) => [
    op(
      'item',
      {
        action: 'growPlant',
        plant: c.get('plant'),
        seedItemId: c.get('seed'),
        fromSeed: true,
        size: 'small',
        matureAfterRounds: 1,
        treesExcluded: true,
      },
      'area'
    ),
  ],
  {
    choices: [
      text('plant'),
      target('seed', 'item', { consumable: true }),
      choice('smallNonTreePlant', 'boolean', {
        mustEqual: true,
        label: 'The selected item is a seed of this small plant (not a tree)',
      }),
    ],
  }
);
define(
  'luthiens-quill',
  ['item'],
  (c) => [
    op(
      'item',
      { action: 'inscribe', text: c.get('inscription'), surface: c.get('surface'), livingForbidden: true },
      'item'
    ),
  ],
  { choices: [text('inscription'), target('surface', 'item')] }
);
define(
  'magic-healing',
  ['heal', 'restoreWound'],
  (c) =>
    c.get('mode') === 'hp'
      ? [heal(3, { timing: 'startTurn', maxHP: true, stacking: 'spellRules' })]
      : [
          op('restoreWound', {
            action: 'successfulMagicUse',
            woundId: c.get('wound'),
            castingTotal: c.castTotal,
            hpHealing: 0,
            uses: 1,
          }),
        ],
  {
    choices: [
      select('mode', ['hp', 'critical']),
      target('wound', 'item', { when: { key: 'mode', equals: 'critical' } }),
    ],
    triggers: ['startTurn'],
  }
);
define(
  'talfryns-prison',
  ['condition', 'shield'],
  (c) => [
    condition('grappled'),
    op('shield', {
      name: 'Binding roots',
      hp: 15,
      purpose: 'restraint',
      onDestroy: 'endEffect',
      escape: save('dodge', c.defenseDC, [], { action: 'escape', onSuccess: 'endEffect' }),
    }),
  ],
  { triggers: ['escapeAttempt', 'damageRestraint'] }
);
define(
  'adenydd',
  ['modifier'],
  () => [rule('glide', { horizontalPerVertical: 1, negateFallingDamageIfActiveAtLanding: true }, 'caster')],
  { triggers: ['falling', 'landing'] }
);
define(
  'air-pocket',
  ['zone', 'modifier'],
  () => [
    zone({ shape: 'circle', radius: 1 }, [rule('breathableAir', {}, 'occupants')], { throughWater: true }),
  ],
  { triggers: ['enter', 'exit', 'suffocation'] }
);
define('bronwyns-gust', ['damage', 'move'], (c) => [
  damage('1d6', { damageType: 'bludgeoning', physicalCritical: true }),
  move(Math.max(0, c.castTotal - c.number('defenseTotal'))),
]);
define(
  'freshen-air',
  ['zone', 'modifier'],
  () => [
    zone(
      { shape: 'circle', radius: 4 },
      [rule('cleanAir', { removes: ['smoke', 'airbornePoison', 'taintedAir'] }, 'occupants')],
      { centeredOnCaster: true }
    ),
  ],
  { triggers: ['enter', 'exit', 'airborneEffect'] }
);
define(
  'uriens-shelter',
  ['zone', 'modifier'],
  () => [
    zone(
      { shape: 'circle', radius: 8 },
      [
        rule(
          'weatherProtection',
          { conditions: ['extremeHeat', 'extremeCold', 'rain', 'snow'] },
          'occupants'
        ),
      ],
      { centeredOnCaster: true }
    ),
  ],
  { triggers: ['enter', 'exit', 'environment'] }
);
define(
  'static-storm',
  ['zone', 'damage'],
  () => [
    zone(
      { shape: 'circle', radius: 5 },
      [
        damage(
          '2',
          {
            element: 'electricity',
            location: 'none',
            predicate: 'hasMetalWeaponOrArmor',
            timing: 'startTurn',
          },
          'occupants'
        ),
      ],
      { centeredOnCaster: true, excludesCaster: true }
    ),
  ],
  { triggers: ['startTurn'] }
);
define(
  'telekinesis',
  ['move'],
  (c) => [
    op(
      'move',
      {
        mode: 'manipulate',
        objectId: c.get('object'),
        maxENC: 5 * c.number('spellCastingRank', { min: 0 }),
        distance: 5,
        unit: 'm',
        asIfHeld: true,
      },
      'item'
    ),
  ],
  { choices: [target('object', 'item')], triggers: ['turnAction'] }
);
define(
  'zephyr',
  ['damage', 'move'],
  (c) => {
    c.get('zephyrAffectsCaster');
    return [
      damage('1d6', { damageType: 'bludgeoning', physicalCritical: true }, 'targets'),
      move(6, { direction: 'awayFromCaster' }, 'targets'),
    ];
  },
  {
    choices: [
      choice('zephyrAffectsCaster', 'boolean', {
        label: 'Table ruling: Zephyr also affects caster',
        reason:
          'Core p.103 does not explicitly exempt the caster. Record the table’s ruling: when included, the caster suffers the damage but remains at the burst origin, which has no outward push direction. Allies in the area are affected either way.',
      }),
    ],
  }
);
define('aine-verseos', ['zone', 'reveal'], () => [
  zone({ shape: 'circle', radius: 4 }, [reveal(['illumination'], { intensity: 'bright' }, 'area')], {
    centeredOnCaster: true,
  }),
]);
define(
  'cadfans-grasp',
  ['item', 'damage', 'condition'],
  (c) =>
    c.get('mode') === 'heatHeldItem'
      ? [
          op(
            'item',
            {
              action: 'forceDropOrDamage',
              itemId: c.get('item'),
              alternative: damage('2d6', { damageType: 'fire', location: 'holdingLimb' }),
            },
            'item'
          ),
        ]
      : [
          op(
            'item',
            {
              action: 'weaponBonus',
              itemId: c.get('item'),
              extraDamage: '2d6',
              damageType: 'fire',
              onHit: condition('fire', { chance: 50 }),
            },
            'item'
          ),
        ],
  {
    choices: [select('mode', ['heatHeldItem', 'empowerWeapon']), target('item', 'item', { metalOnly: true })],
    triggers: ['holdingItem', 'weaponHit'],
  }
);
define(
  'raise-flame',
  ['zone', 'modifier'],
  (c) =>
    c.get('mode') === 'spread'
      ? [
          zone({ existingArea: c.get('fire') }, [
            op(
              'move',
              {
                mode: 'spreadFire',
                distance: 2,
                unit: 'm',
                timing: 'startTurn',
                direction: c.get('direction'),
              },
              'area'
            ),
          ]),
        ]
      : [
          rule(
            'fireDamageAdjustment',
            { amount: c.get('mode') === 'intensify' ? 1 : -1, fireId: c.get('fire') },
            'area'
          ),
        ],
  {
    choices: [
      target('fire', 'point'),
      select('mode', ['spread', 'dampen', 'intensify']),
      text('direction', { when: { key: 'mode', equals: 'spread' } }),
    ],
    triggers: ['startTurn', 'fireDamage'],
  }
);
define(
  'control-water',
  ['modifier', 'narrative'],
  (c) => [
    rule(
      'waterCurrent',
      {
        waterId: c.get('water'),
        mode: c.get('mode'),
        swimmerSpeedMultiplier: c.get('mode') === 'slowSwimmer' ? 0.5 : undefined,
        shipSpeedMultiplier: c.get('mode') === 'speedShip' ? 1.5 : undefined,
        castingDC: c.get('dc'),
        passed: c.castTotal > c.get('dc'),
      },
      'area'
    ),
    narrative('setWaterFlow', { mode: c.get('mode'), dc: c.get('dc') }),
  ],
  {
    choices: [
      target('water', 'point'),
      select('mode', ['slowSwimmer', 'speedShip', 'slowCurrent', 'haltCurrent', 'redirect']),
      numeric('dc', 0, { gm: true }),
    ],
    triggers: ['movement'],
  }
);
define(
  'curse-of-sedna',
  ['zone', 'condition'],
  (c) => [
    zone(
      { shape: 'circle', radius: 5 },
      [
        condition(
          'suffocating',
          {
            timing: 'startTurn',
            save: save('swimming', c.defenseDC, [condition('suffocating')], {
              onSuccess: 'surface',
              repeat: 'eachRound',
            }),
            requiresWater: true,
          },
          'occupants'
        ),
      ],
      { vortexSizeText: '4m area; exact shape unspecified' }
    ),
  ],
  { triggers: ['startTurn'] }
);
define(
  'dormyns-fog',
  ['zone', 'modifier'],
  (c) => [
    zone({ shape: 'circle', radius: 10 }, [modifier({ awareness: -3 }, { visionRange: 4 }, 'occupants')], {
      centeredOnCaster: true,
      followCaster: c.get('followCaster'),
      stationary: !c.get('followCaster'),
    }),
  ],
  {
    choices: [
      choice('followCaster', 'boolean', {
        label: 'Table convention: fog follows caster',
        required: true,
        reason:
          'The printed spell does not settle whether the fog follows its caster. Record the agreed table convention: checked follows the caster; unchecked stays at the casting point.',
      }),
    ],
    triggers: ['enter', 'exit', 'vision'],
  }
);
define(
  'downpour',
  ['zone', 'condition'],
  () => [
    zone(
      { shape: 'circle', radius: 10 },
      [condition('fire', { action: 'remove', timing: 'enter', includeTerrain: true }, 'occupants')],
      { extinguishesFireEffects: true }
    ),
  ],
  { triggers: ['enter', 'fireCreated'] }
);
define(
  'ice-slick',
  ['zone', 'condition'],
  (c) => [
    zone({ shape: 'rectangle', width: 2, height: 2 }, [
      condition(
        'prone',
        {
          timing: 'enter',
          save: save('athletics', c.defenseDC, [condition('prone')], { onSuccess: 'none' }),
        },
        'occupants'
      ),
    ]),
  ],
  { triggers: ['crossArea'] }
);
define(
  'puro-dwr',
  ['item'],
  (c) => [
    op(
      'item',
      {
        action: 'purifyWater',
        waterId: c.get('water'),
        volume: 1,
        unit: 'm3',
        removes: ['poison', 'disease'],
        excludesLivingCreatures: true,
        recontaminatesAfterExpiry: true,
      },
      'area'
    ),
  ],
  { choices: [target('water', 'point')] }
);
define(
  'eilharts-technique',
  ['reveal', 'modifier', 'narrative'],
  (c) => [
    reveal(['oneAnswer'], { question: c.get('question'), compulsory: true }),
    ...(c.number('defenseFumbled', { min: 0, max: 1 })
      ? [modifier({ int: -1 }, { permanent: true, duration: { permanent: true } })]
      : []),
    narrative('answerFromTargetKnowledge', { question: c.get('question'), count: 1 }),
  ],
  { choices: [text('question')] }
);
define(
  'illusion',
  ['zone', 'reveal', 'narrative'],
  (c) => [
    zone({ shape: 'chosen', description: c.get('illusion'), maximumDistance: 20 }, [
      reveal(['visualIllusion'], { tangible: false, sound: false, smell: false }, 'observers'),
    ]),
    narrative('depictIllusion', { description: c.get('illusion') }),
  ],
  { choices: [text('illusion')] }
);
define(
  'teleportation',
  ['move', 'narrative'],
  (c) => [
    op(
      'move',
      {
        mode: 'teleport',
        destination: c.get('destination'),
        casterOnly: true,
        carriedItems: true,
        passengers: false,
        dc: 15,
        passed: c.castTotal > 15,
        failureDistanceMiles: c.castTotal <= 15 ? c.roll('miles', '1d6', { min: 1, max: 6 }) : 0,
        failureDirection: 'gmRandom',
      },
      'caster'
    ),
    ...(c.get('known')
      ? []
      : [
          narrative('resolveBlindTeleport', {
            sourcePage: 105,
            destination: c.get('destination'),
            approvedByGM: c.get('blindDestinationApproved'),
          }),
        ]),
  ],
  {
    choices: [
      target('destination', 'point'),
      choice('known', 'boolean'),
      choice('blindDestinationApproved', 'boolean', { gm: true, when: { key: 'known', equals: false } }),
    ],
  }
);
define(
  'elgans-theory',
  ['item', 'modifier'],
  (c) => [
    op(
      'item',
      {
        action: 'magnetize',
        itemId: c.get('object'),
        radius: 2,
        attracts: 'metal',
        detach: save('physique', 18, [], { onSuccess: 'detach' }),
        attachedMassCountsTowardENC: true,
      },
      'item'
    ),
  ],
  {
    choices: [target('object', 'item', { metalOnly: true })],
    triggers: ['metalEntersRadius', 'detachAttempt'],
  }
);
define(
  'rhwystr-graig',
  ['item'],
  (c) => [
    op(
      'item',
      {
        action: 'createCover',
        shape: { width: 2, height: 3 },
        sp: 30,
        facing: c.get('facing'),
        location: c.get('point'),
        persists: true,
      },
      'area'
    ),
  ],
  { choices: [target('point', 'point'), numeric('facing', 0, { max: 360 })] }
);
define(
  'stammelfords-earthquake',
  ['zone', 'modifier', 'condition', 'item', 'narrative'],
  (c) => [
    zone(
      { shape: c.get('shape'), size: 10 },
      [
        modifier({ ref: -2, spd: -3 }, {}, 'occupants'),
        condition(
          'suffocating',
          {
            timing: 'startTurn',
            save: save('athletics', c.get('athleticsDC'), [condition('suffocating')], {
              onSuccess: 'climbOut',
            }),
            buried: true,
          },
          'occupants'
        ),
      ],
      { terrainRemainsBroken: true }
    ),
    op('item', { action: 'collapseStructures', size: 'small', chance: 10 }, 'area'),
    narrative('setEarthquakeAthleticsDCAndShape', {
      dc: c.get('athleticsDC'),
      shape: c.get('shape'),
      reason: 'Effect omits Athletics DC and does not define 10m area shape.',
    }),
  ],
  {
    choices: [numeric('athleticsDC', 0, { gm: true }), select('shape', ['circle', 'square'], { gm: true })],
    triggers: ['enter', 'exit', 'startTurn'],
  }
);
define('alzurs-thunder', ['damage', 'condition'], (c) => [
  damage(`${Math.max(0, 8 - c.number('priorTargets', { min: 0 }))}d6`, {
    element: 'electricity',
    piercingLine: true,
  }),
  condition('fire', { chance: 75 }),
]);
define(
  'gwynt-troelli',
  ['zone', 'modifier', 'move'],
  (c) => [
    zone(
      { shape: 'circle', radius: 10 },
      [
        rule(
          'projectileBarrier',
          { defenseDC: c.defenseDC, onFailure: move(8, { direction: 'random', target: 'projectile' }) },
          'occupants'
        ),
      ],
      { centeredOnCaster: true }
    ),
  ],
  { triggers: ['projectileEntersArea'] }
);
define(
  'suffocate',
  ['condition', 'damage'],
  () => [
    condition('staggered'),
    condition('suffocating', { damageHandledBySpell: true }),
    damage('1d10', {
      timing: 'startTurn',
      armor: 'ignore',
      shield: 'ignore',
      damageSource: 'suffocation',
      location: 'none',
      endsOnCasterWeaponHit: true,
    }),
  ],
  { triggers: ['startTurn', 'casterWeaponHit'] }
);
define(
  'demetias-crest-surge',
  ['shield'],
  (c) => [
    op(
      'shield',
      {
        purpose: 'elementBarrier',
        blocksElement: 'water',
        remainingBlocks: 2 * c.number('spellCastingRank', { min: 0 }),
        destroysProjectiles: true,
        preventsLivingEntry: true,
        radius: c.get('radius'),
      },
      'caster'
    ),
  ],
  {
    choices: [numeric('radius', 0, { max: 10, gm: true })],
    triggers: ['waterSpell', 'projectileEntersArea', 'livingCreatureEntersArea'],
    notes: ['Range is 10m; the text does not separately define the shield radius. Require a GM ruling.'],
  }
);
define(
  'flaming-vortex',
  ['zone', 'move', 'damage', 'condition'],
  (c) => [
    zone(
      { shape: 'circle', radius: 1 },
      [
        damage(
          '5d6',
          {
            damageType: 'fire',
            timing: 'crossTarget',
            save: save('dodge', c.defenseDC, [], { onSuccess: 'avoidAttack', comparison: 'atLeast' }),
          },
          'occupants'
        ),
        condition('fire', { chance: 50, timing: 'hit' }, 'occupants'),
      ],
      { maximumDistance: 10, controlledMovementPerTurn: c.number('spellCastingRank', { min: 0 }), unit: 'm' }
    ),
  ],
  { triggers: ['casterTurn', 'crossTarget'] }
);
define(
  'seirff-haul',
  ['condition', 'modifier', 'narrative'],
  (c) => [
    condition('grappled'),
    condition('fire'),
    rule('escalatingEscape', {
      skill: 'dodge',
      dc: c.defenseDC,
      increasePerFailure: 1,
      endsAllEffects: true,
      duration: { rounds: c.get('durationRounds') },
    }),
    narrative('resolvePrintedDurationOmission', { printed: '2d10', rounds: c.get('durationRounds') }),
  ],
  { choices: [numeric('durationRounds', 1, { integer: true, gm: true })], triggers: ['escapeAttempt'] }
);
define(
  'merigolds-hailstorm',
  ['zone', 'damage'],
  (c) => [
    zone({ shape: 'circle', radius: 30 }, [
      damage(
        '2d6',
        {
          physicalCritical: true,
          element: 'ice',
          timing: 'startTurn',
          save: save('dodge', c.defenseDC, [], { onSuccess: 'avoidAttack', comparison: 'atLeast' }),
        },
        'occupants'
      ),
    ]),
  ],
  { triggers: ['startTurn'] }
);
define(
  'mental-command',
  ['modifier', 'narrative'],
  (c) => [
    rule('compelledOrder', {
      command: c.get('command'),
      defenseBonus: c.get('againstNature') ? 5 : 0,
      endsWhen: 'taskCompleted',
      repeatSave: {
        skill: 'resistMagic',
        dc: c.defenseDC,
        timing: 'targetTurn',
        initialDelayRounds: c.roll('resistAfter', '1d6', { min: 1, max: 6 }),
        intervalFormula: '1d6',
        onSuccess: 'endEffect',
        sourcePage: 107,
      },
    }),
    narrative('interpretCompelledOrder', { command: c.get('command'), exactCompliance: true }),
  ],
  {
    choices: [text('command'), choice('againstNature', 'boolean', { gm: true })],
    triggers: ['actionDeclaration', 'taskCompleted', 'targetTurn'],
    notes: [
      'Core p.107 sidebar permits another Resist Magic attempt every 1d6 rounds; the original casting total remains the DC.',
    ],
  }
);
define(
  'standing-portal',
  ['zone', 'move', 'restoreWound', 'narrative'],
  (c) => [
    zone(
      { shape: 'rectangle', width: 1, height: 2 },
      [op('move', { mode: 'teleport', destination: c.get('destination'), mustFit: true }, 'occupants')],
      {
        point: c.get('entrance'),
        placementRange: 10,
        onCloseThroughBody: {
          type: 'restoreWound',
          action: 'inflictDismemberment',
          location: 'intersectedPart',
        },
      }
    ),
    ...(c.get('known')
      ? []
      : [narrative('resolveBlindTeleport', { sourcePage: 105, approvedDestination: c.get('destination') })]),
  ],
  {
    choices: [target('entrance', 'point'), target('destination', 'point'), choice('known', 'boolean')],
    triggers: ['crossPortal', 'portalEnds'],
  }
);
define(
  'polymorphism',
  ['transform'],
  (c) => [
    op(
      'transform',
      {
        form: c.get('form'),
        physicalStatisticsFromForm: true,
        preserveMentalStatistics: true,
        mergeEquipment: true,
        endsByRecasting: true,
        dimeritiumPreventsReversal: true,
      },
      'caster'
    ),
  ],
  { choices: [select('form', ['serpent', 'cat', 'bird', 'dog'])] }
);
define(
  'transmutation',
  ['item'],
  (c) => [
    op(
      'item',
      {
        action: 'transmute',
        itemId: c.get('item'),
        material: c.get('material'),
        amount: 1,
        perfectGem: c.get('mode') === 'perfectGem',
        cannotCreateDimeritium: true,
        noDimeritiumContact: true,
        permanent: true,
      },
      'item'
    ),
  ],
  {
    choices: [
      target('item', 'item'),
      select('mode', ['metal', 'perfectGem']),
      text('material', { when: { key: 'mode', equals: 'metal' } }),
    ],
  }
);
define(
  'dervish',
  ['zone', 'modifier', 'damage', 'move'],
  (c) => [
    zone(
      { shape: 'circle', radius: 2 },
      [
        damage('1d6', { damageType: 'bludgeoning', physicalCritical: true, timing: 'enter' }, 'occupants'),
        move(6, { direction: 'awayFromCaster', timing: 'enter' }, 'occupants'),
      ],
      { followsCaster: true, excludesCaster: true }
    ),
    rule(
      'dervishRestrictions',
      {
        cannotRun: true,
        cannotAttackOut: true,
        projectileDC: c.defenseDC,
        deflectDistance: 8,
        deflectDirection: 'random',
      },
      'caster'
    ),
  ],
  { triggers: ['enter', 'casterMoves', 'projectileAttack'] }
);
define(
  'lightning-storm',
  ['zone', 'damage', 'condition'],
  (c) => [
    zone(
      { shape: 'circle', radius: 20 },
      [
        damage(
          '8d6',
          {
            element: 'electricity',
            location: 'torso',
            timing: 'startTurn',
            selectionChance: 35,
            save: save('dodge', c.defenseDC, [], { onSuccess: 'avoidAttack', comparison: 'atLeast' }),
            onHit: condition('fire', { chance: 75 }),
          },
          'occupants'
        ),
      ],
      { excludesCaster: true }
    ),
  ],
  { triggers: ['startTurn'] }
);
define(
  'melgars-fire',
  ['zone', 'damage', 'condition'],
  (c) => [
    zone(
      { shape: 'circle', radius: 40 },
      [
        damage(
          '4d6',
          {
            damageType: 'fire',
            timing: 'startTurn',
            selectionChance: 75,
            save: save(['dodge', 'block'], c.defenseDC, [], { onSuccess: 'avoidAttack' }),
            onHit: condition('fire', { chance: 75 }),
          },
          'occupants'
        ),
      ],
      { excludesCaster: true }
    ),
  ],
  { triggers: ['startTurn'] }
);
define(
  'mirror-effect',
  ['damage', 'item', 'modifier'],
  (c) => [
    damage('10d6', {
      element: 'light',
      multiplier: ['moonlight', 'overcast'].includes(c.get('light')) ? 0.5 : 1,
      requiresSunOrMoonlight: true,
    }),
    rule('lightBeamDefense', {
      windCannotDeflect: true,
      blockingItemDestroyed: true,
      parryRequiresReflectiveSurface: true,
      reflectedDirection: 'random',
      parryingItemStillTakesDamage: true,
    }),
  ],
  { choices: [select('light', ['sunlight', 'overcast', 'moonlight'])], triggers: ['block', 'parry'] }
);
define(
  'part-water',
  ['zone', 'move'],
  (c) => [
    zone(
      { shape: 'rectangle', width: c.get('width'), height: c.get('length'), verticalHeight: c.get('depth') },
      [
        move(
          0,
          { mode: 'displaceWithWater', destination: 'nearestOutside', affectsCaster: true },
          'occupants'
        ),
      ],
      { replacesWaterWithAir: true, orientation: c.get('orientation'), crossingDoesNotDisrupt: true }
    ),
  ],
  {
    choices: [
      numeric('width', 0, { max: 10 }),
      numeric('length', 0, { max: 100 }),
      numeric('depth', 0, { max: 10 }),
      text('orientation'),
    ],
  }
);
define(
  'tryferi-gaeaf',
  ['damage', 'condition', 'shield'],
  (c) => [
    damage('5d6', {
      element: 'ice',
      physicalCritical: true,
      attacks: Math.floor(c.number('spellCastingRank', { min: 0 }) / 2),
      resolveEachSeparately: true,
      allocateTargets: true,
      onPenetration: [
        condition('frozen'),
        damage('2', { armor: 'ignore', timing: 'startTurn', location: 'none' }),
        op('shield', {
          purpose: 'embeddedIce',
          hp: 20,
          onDestroy: 'endEmbeddedEffects',
          breakFree: save('physique', 20, [], { onSuccess: 'endEmbeddedEffects' }),
        }),
      ],
    }),
  ],
  { triggers: ['penetratingHit', 'startTurn', 'removeEmbeddedIce'] }
);

// Core invocations preserve healing stages, repeated defenses, and deity-specific limits.
define(
  'boiling-blood',
  ['modifier', 'narrative'],
  (c) => [
    rule('animalAggression', {
      victim: c.get('victim'),
      requiresAnimalOrNonsapientMonster: true,
      castingDC: c.number('targetWill', { min: 0 }) * 3,
    }),
    narrative('directEnragedCreature', { victim: c.get('victim'), untilExpiry: true }),
  ],
  { choices: [target('victim')] }
);
define(
  'cursed-illness',
  ['condition', 'modifier'],
  (c) => [
    condition(c.power === 2 ? 'staggered' : c.power === 4 ? 'stunned' : 'poison'),
    rule('illnessRecovery', {
      skill: 'endurance',
      dc: c.defenseDC,
      endsAllSpellConditions: true,
      duration: { until: 'successfulEndurance' },
    }),
  ],
  { triggers: ['enduranceSave'] }
);
define(
  'friend-to-wild-kind',
  ['modifier', 'narrative'],
  (c) =>
    c.get('mode') === 'handleAnimals'
      ? [modifier({ wildernessSurvival: 3 }, { predicate: 'animalHandling' }, 'caster')]
      : [
          rule('animalDisposition', {
            disposition: 'calm',
            castingDC: c.number('targetWill', { min: 0 }) * 3,
          }),
          narrative('calmAnimal', { targetMustBeAnimal: true }),
        ],
  { choices: [select('mode', ['handleAnimals', 'calm'])] }
);
define('natures-gift', ['item'], (c) => [
  op(
    'item',
    { action: 'createFood', dailyRations: c.power, requiresSoil: true, duration: { permanent: true } },
    'area'
  ),
]);
define(
  'sigil-of-the-hidden',
  ['zone', 'modifier', 'shield'],
  () => [
    zone(
      { shape: 'unspecified', size: 3 },
      [modifier({ stealth: 5 }, { visualCover: 'complete', preventsMovement: true }, 'occupants')],
      { destroyedByRecast: true, hp: 10 }
    ),
  ],
  { triggers: ['enter', 'exit', 'damageVegetation'] }
);
define(
  'blessing-of-healing',
  ['heal', 'restoreWound'],
  (c) =>
    c.get('mode') === 'hp'
      ? [heal(3, { timing: 'startTurn' })]
      : [
          op('restoreWound', {
            action: 'successfulMagicUse',
            woundId: c.get('wound'),
            uses: 1,
            castingTotal: c.castTotal,
            hpHealing: 0,
          }),
        ],
  {
    choices: [
      select('mode', ['hp', 'critical']),
      target('wound', 'item', { when: { key: 'mode', equals: 'critical' } }),
    ],
    triggers: ['startTurn'],
  }
);
define(
  'shape-nature',
  ['summon', 'item'],
  (c) => [
    op(
      'summon',
      {
        profile: 'golem',
        sourceTree: c.get('tree'),
        controller: 'caster',
        revertsOnExpiry: true,
        lootOnDeath: { timber: '2d10' },
      },
      'area'
    ),
  ],
  { choices: [target('tree', 'point', { size: 'small' })] }
);
define(
  'song-of-the-sky',
  ['zone', 'modifier', 'condition', 'damage'],
  (c) => [
    zone(
      { shape: 'circle', radius: 50 },
      c.get('weather') === 'rainstorm'
        ? [condition('fire', { action: 'remove' }, 'occupants')]
        : c.get('weather') === 'windstorm'
          ? [modifier({ dex: -2 }, { predicate: 'rangedAttack' }, 'occupants')]
          : c.get('weather') === 'lightningStorm'
            ? [
                damage(
                  '8d6',
                  {
                    element: 'electricity',
                    location: 'torso',
                    timing: 'startTurn',
                    selectionChance: 35,
                    save: save('dodge', c.defenseDC, [], { onSuccess: 'avoidAttack', comparison: 'atLeast' }),
                    onHit: condition('fire', { chance: 75 }),
                  },
                  'occupants'
                ),
              ]
            : [rule('weather', { weather: c.get('weather') }, 'area')],
      { centeredOnCaster: true }
    ),
  ],
  {
    choices: [select('weather', ['clear', 'cloudy', 'rainstorm', 'windstorm', 'lightningStorm'])],
    triggers: ['environment', 'startTurn'],
  }
);
define(
  'vaults-of-knowledge',
  ['reveal', 'narrative'],
  (c) => [
    reveal(['perfectRecall'], { subject: c.get('memory'), previouslyKnownOnly: true }, 'caster'),
    narrative('restoreRememberedInformation', { subject: c.get('memory'), notNewKnowledge: true }),
  ],
  { choices: [text('memory')] }
);
define(
  'web-of-lies',
  ['condition', 'modifier'],
  () => [
    condition('stunned'),
    rule('mentalRecovery', {
      roll: '1d10',
      comparison: 'strictlyLess',
      attribute: 'int',
      timing: 'targetTurn',
      frequency: 'oncePerRound',
      onSuccess: 'endEffect',
    }),
  ],
  { triggers: ['targetTurn'] }
);
define('holy-fortification', ['dispel'], () => [
  op('dispel', {
    action: 'repeatOriginalDefenses',
    effects: 'allAffectingTarget',
    removeOnlyOnSuccessfulSave: true,
  }),
]);
define(
  'light-of-truth',
  ['modifier', 'narrative'],
  (c) => [
    rule('truthCompulsion', {
      repeatSkill: 'resistMagic',
      repeatAgainst: 'newSpellCasting',
      timing: 'eachRound',
      truthfulAnswersOnlyOnFailedDefense: true,
    }),
    narrative('answerQuestionsTruthfully', { questions: c.get('questions') }),
  ],
  { choices: [text('questions')], triggers: ['startTurn'] }
);
define(
  'divine-portal',
  ['zone', 'move', 'restoreWound'],
  (c) => [
    zone(
      { shape: 'rectangle', width: 1, height: 2 },
      [op('move', { mode: 'teleport', destination: c.get('destination'), mustFit: true }, 'occupants')],
      {
        point: c.get('entrance'),
        placementRange: 10,
        duration: { rounds: 1 },
        onCloseThroughBody: {
          type: 'restoreWound',
          action: 'inflictDismemberment',
          location: 'intersectedPart',
        },
      }
    ),
  ],
  {
    choices: [target('entrance', 'point'), target('destination', 'point', { knownOnly: true })],
    triggers: ['crossPortal', 'portalEnds'],
  }
);
define(
  'divine-wisdom',
  ['reveal', 'narrative'],
  (c) => [
    reveal(
      ['answer'],
      { question: c.get('question'), passed: c.castTotal > c.get('dc'), predictsFuture: false },
      'caster'
    ),
    narrative('answerDivineAugury', {
      question: c.get('question'),
      dc: c.get('dc'),
      passed: c.castTotal > c.get('dc'),
    }),
  ],
  { choices: [text('question'), numeric('dc', 0, { gm: true })] }
);
define(
  'blessing-of-death',
  ['resource', 'modifier'],
  () => [
    resource('hp', 0, { mode: 'set', retainPreviousValue: true, enterDeathState: true }),
    rule('recoverBlessingOfDeath', {
      skills: ['firstAid', 'healingHands'],
      dc: 16,
      restoresPreviousHP: true,
    }),
  ],
  { triggers: ['medicalTreatment'] }
);
define(
  'eternal-judgement',
  ['condition', 'modifier'],
  () => [
    condition('fire'),
    rule('eternalFire', {
      fireDamageMultiplier: 2,
      extinguishBy: ['magic', 'threeRoundsCompletelySubmerged'],
      contactSpreadsOrdinaryFire: true,
      ordinaryFireExtinguishAction: 'fullRound',
    }),
  ],
  { triggers: ['fireDamage', 'extinguishAttempt', 'contact', 'submergedRound'] }
);
define(
  'freyas-bravery',
  ['zone', 'modifier', 'resource'],
  () => [
    zone(
      { shape: 'circle', radius: 20 },
      [
        modifier({ hp: 25 }, {}, 'selectedOccupants'),
        resource('hp', 25, { temporary: true, reconcileOnExpiry: true }, 'selectedOccupants'),
        rule('immuneToFear', {}, 'selectedOccupants'),
      ],
      {
        followsCaster: true,
        excludeUnselected: true,
        lingeringOnExit: '1d6 rounds',
        refreshLingeringOnReentry: true,
      }
    ),
  ],
  { triggers: ['enter', 'exit', 'expiry'] }
);
define(
  'healing-rest',
  ['condition', 'heal', 'restoreWound'],
  (c) => [
    condition(
      'unconscious',
      {
        cannotAct: true,
        unawareOfTouchMovementAndAttack: true,
        duration: { seconds: 86400 },
        maximumTargets: c.number('spellCastingRank', { min: 0 }),
      },
      'targets'
    ),
    heal('maximum', { timing: 'expiry', requiresCompletedRest: true }, 'targets'),
    op(
      'restoreWound',
      { action: 'healTreatedWounds', timing: 'expiry', preservePermanentPenalties: true },
      'targets'
    ),
  ],
  { triggers: ['expiry'] }
);
define(
  'luck-of-the-father',
  ['resource', 'modifier'],
  (c) => [
    resource(
      'luck',
      3 * c.number('spellCastingRank', { min: 0 }),
      { mode: 'temporaryPool', name: 'divineLuck' },
      'caster'
    ),
    rule('spendDivineLuck', { ownRolls: true, allyOrEnemyRange: 10, mayPenalize: true }, 'caster'),
  ],
  { triggers: ['beforeRoll'] }
);
define(
  'white-flame',
  ['zone', 'condition', 'dispel', 'modifier', 'reveal'],
  (c) => [
    zone({ shape: 'circle', radius: 10 }, [
      condition('frozen', { action: 'remove' }, 'occupants'),
      op('dispel', { element: 'water', existingEffects: true }, 'area'),
      rule('waterCastingBarrier', { mustBeat: c.defenseDC }, 'area'),
      rule('sunlightVulnerabilityMultiplier', { multiplier: 2 }, 'occupants'),
      reveal(['illumination'], { intensity: 'bright', burns: false }, 'area'),
    ]),
  ],
  { triggers: ['enter', 'waterCast', 'sunlightPenalty'] }
);

// Tome novice/journeyman magic.
define(
  'alchemical-recovery',
  ['item'],
  (c) => [
    op(
      'item',
      {
        action: 'recoverAlchemySubstance',
        projectId: c.get('project'),
        substance: c.get('substance'),
        quantity: 1,
        oncePerProject: true,
        combinesWithNormalRecovery: true,
      },
      'item'
    ),
  ],
  { choices: [target('project', 'item'), text('substance')] }
);
define('detect-ley-line', ['reveal', 'narrative'], () => [
  reveal(['nearestLeyLineDirection', 'leyLineElement'], { maximumMiles: 1 }, 'caster'),
  narrative('identifyNearestLeyLine', { maximumMiles: 1 }),
]);
define('fergus-demise', ['modifier'], () => [
  rule(
    'skillSubstitution',
    { skill: 'intimidation', substitute: 'spellCasting', predicate: 'interrogateSelectedTarget' },
    'caster'
  ),
]);
define(
  'hold-tongue',
  ['modifier'],
  () => [
    rule('silenced', {
      noSpeech: true,
      noMagicIfTraditions: ['mage', 'priest', 'druid'],
      spellCastingBelow: 7,
      repeatSave: {
        skill: 'resistMagic',
        versus: 'newSpellCasting',
        timing: 'endRound',
        onSuccess: 'endEffect',
      },
    }),
  ],
  { triggers: ['speech', 'beforeCast', 'endRound'] }
);
define(
  'magic-screen',
  ['zone', 'reveal', 'narrative'],
  (c) => [
    zone(
      { shape: 'rectangle', width: 2, height: 2, verticalHeight: 2 },
      [
        reveal(
          ['visualIllusion'],
          {
            description: c.get('appearance'),
            observerSaveWithin: 4,
            save: save('resistMagic', c.defenseDC, [], { onSuccess: 'seeThrough', comparison: 'atLeast' }),
          },
          'observers'
        ),
      ],
      { duration: { until: 'dispelledOrItemRemoved' }, endsWhenAnyItemRemoved: true }
    ),
    narrative('depictObjectIllusion', { description: c.get('appearance') }),
  ],
  {
    choices: [text('appearance')],
    triggers: ['observerWithin4m', 'itemRemoved'],
    notes: [
      'Duration field says Immediate, but effect text explicitly persists until dispelled or an item leaves. This procedure follows the effect text.',
    ],
  }
);
define(
  'reopen-portal',
  ['zone', 'move'],
  (c) => [
    op(
      'zone',
      {
        action: 'reopenPortal',
        portalId: c.get('portal'),
        requiredDC: c.get('portalType') === 'permanent' ? 16 : 20,
        passed: c.castTotal > (c.get('portalType') === 'permanent' ? 16 : 20),
        maximumTraceAgeSeconds: c.get('portalType') === 'standingTrace' ? 30 : null,
        duration: { rounds: 1 },
      },
      'area'
    ),
  ],
  {
    choices: [target('portal', 'point'), select('portalType', ['permanent', 'standingTrace'])],
    triggers: ['crossPortal'],
  }
);
define(
  'savollas-method',
  ['item', 'reveal'],
  (c) => [
    op(
      'item',
      {
        action: 'prepareMutagenExtraction',
        corpseId: c.get('corpse'),
        skills: ['alchemy', 'witcherTraining'],
        dc: 14,
      },
      'item'
    ),
    reveal(['mutagen'], { glowing: true }),
  ],
  { choices: [target('corpse', 'item')] }
);
define(
  'cryfhau',
  ['item'],
  (c) => [
    op(
      'item',
      {
        action: 'increaseCoverSP',
        coverId: c.get('cover'),
        amount: 5,
        mayExceedOriginalSP: true,
        oncePerArea: true,
        shape: { width: 2, height: 2, verticalHeight: 2 },
        permanent: true,
      },
      'item'
    ),
  ],
  { choices: [target('cover', 'point')] }
);
define(
  'earthen-pillar',
  ['item'],
  (c) => [
    op(
      'item',
      {
        action: 'createCover',
        shape: { width: 2, height: 2, verticalHeight: 2 },
        sp: 10,
        point: c.get('point'),
        requiresEarth: true,
        persists: true,
      },
      'area'
    ),
  ],
  { choices: [target('point', 'point')] }
);
define(
  'soften-earth',
  ['zone', 'modifier'],
  () => [
    zone(
      { shape: 'rectangle', width: 6, height: 6, verticalHeight: 6 },
      [modifier({ dodge: -2, athletics: -2 }, {}, 'occupants')],
      { terrain: 'mudOrQuicksand', requires: 'earthOrSand' }
    ),
  ],
  { triggers: ['enter', 'exit'] }
);
define(
  'bronwyns-bow',
  ['item', 'damage'],
  (c) => [
    op(
      'item',
      {
        action: 'launch',
        itemId: c.get('projectile'),
        allowed: ['thrownWeapon', 'arrow', 'bolt', 'bomb'],
        skill: 'spellCasting',
        range: 50,
        retainItemEffects: true,
      },
      'item'
    ),
    damage(c.get('projectileType') === 'arrowOrBolt' ? '4d6' : c.get('damageFormula'), {
      fromItem: c.get('projectile'),
      physicalCritical: c.get('projectileType') !== 'bomb',
    }),
  ],
  {
    choices: [
      target('projectile', 'item'),
      select('projectileType', ['arrowOrBolt', 'thrownWeapon', 'bomb']),
      text('damageFormula', { required: false, fromAuthoritativeItem: true }),
    ],
  }
);
define(
  'dust-coating',
  ['zone', 'reveal', 'modifier'],
  () => [
    zone({ shape: 'rectangle', width: 10, height: 10, verticalHeight: 10 }, [
      reveal(['invisibleCreatures'], { duration: { rounds: 1 } }, 'occupants'),
    ]),
    rule('negateInvisibility', { selectedTargetOnly: true }),
  ],
  { triggers: ['invisibility'] }
);
define(
  'magnify-odor',
  ['zone', 'condition', 'modifier'],
  (c) => [
    zone(
      { shape: 'rectangle', width: 6, height: 6, verticalHeight: 6 },
      [
        condition(
          'nausea',
          {
            timing: 'enterOrStartTurn',
            duration: { seconds: 60 },
            save: save('endurance', c.defenseDC, [condition('nausea', { duration: { seconds: 60 } })]),
          },
          'occupants'
        ),
        rule(
          'permeatingOdor',
          {
            trackingBonus: 2,
            requiresScentTracking: true,
            suppressOwnScentTracking: true,
            duration: { seconds: 604800 },
            endsIfCompletelySubmerged: true,
            includesPossessions: true,
          },
          'occupants'
        ),
      ],
      { requiresExistingScent: true }
    ),
  ],
  { triggers: ['enter', 'startTurn', 'scentTracking', 'submerged'] }
);
define(
  'coating-of-fire',
  ['modifier'],
  () => [rule('flammable', { openFlameIgnites: true, positiveIgnitionChanceBecomes: 100 })],
  { triggers: ['ignitionChance', 'openFlameContact'] }
);
define(
  'harmless-fire',
  ['zone', 'modifier'],
  (c) => [
    zone({ shape: 'rectangle', width: 2, height: 2, verticalHeight: 2 }, [
      rule(
        'harmlessFire',
        {
          fireId: c.get('fire'),
          noContactDamage: true,
          noSpread: true,
          protectsAgainstSeparateFireAttacks: false,
        },
        'area'
      ),
    ]),
  ],
  { choices: [target('fire', 'point')], triggers: ['fireContact', 'fireSpread'] }
);
define(
  'vahilas-smoke',
  ['condition', 'modifier'],
  () => [
    condition('blinded'),
    condition('suffocating'),
    rule('repeatMagicDefense', {
      skill: 'dodge',
      versus: 'newSpellCasting',
      action: 'normal',
      timing: 'targetTurn',
      onSuccess: 'endAllEffects',
    }),
  ],
  { triggers: ['targetTurn'] }
);
define(
  'web-of-ice',
  ['item', 'reveal'],
  (c) => [
    op(
      'item',
      {
        action: 'pairedAlarm',
        surfaceId: c.get('surface'),
        duplicateOwner: 'caster',
        onSurfaceInteraction: 'breakBoth',
        onDuplicateBroken: 'meltOriginal',
        discoveryDC: 18,
        discoverySkill: 'awareness',
      },
      'item'
    ),
  ],
  { choices: [target('surface', 'point')], triggers: ['surfaceInteraction', 'duplicateBroken'] }
);
define(
  'cloak',
  ['modifier'],
  () => [
    rule(
      'invisibility',
      {
        stealthBonus: 10,
        attackBonus: 5,
        defenseBonus: 5,
        afterDetection: { attackBonus: 3, defenseBonus: 3 },
        partialVisibility: {
          causes: ['yrden', 'moondust'],
          stealthBonus: 5,
          attackBonus: 3,
          defenseBonus: 3,
        },
        endsOnHit: true,
        includesCarriedObjects: true,
      },
      'caster'
    ),
  ],
  { triggers: ['awareness', 'attack', 'defense', 'casterHit', 'yrden', 'moondust'] }
);
define(
  'dormyns-chamber',
  ['shield', 'modifier'],
  () => [
    op('shield', {
      purpose: 'prison',
      hp: 40,
      stationary: true,
      preventsTargetingBothDirections: true,
      soundproof: true,
    }),
    rule('cannotCrossPrisonBarrier'),
  ],
  { triggers: ['targetSelection', 'movement', 'sound', 'damageBarrier'] }
);
define(
  'empower',
  ['modifier'],
  (c) => [
    rule(
      'empowerNextSpell',
      {
        mode: c.get('mode'),
        effectChance: c.get('mode') === 'chance' ? 100 : undefined,
        castingBonus: c.get('mode') === 'casting' ? 2 : undefined,
        extraDamage: c.get('mode') === 'damage' ? '2d6' : undefined,
        extraDamageRequiresAlreadyDamagingSpell: true,
        naturalOneFumbleSeverity: 10,
        consumeOnNextCast: true,
      },
      'caster'
    ),
  ],
  { choices: [select('mode', ['chance', 'casting', 'damage'])], triggers: ['beforeCast', 'castingFumble'] }
);
define(
  'spectral-tether',
  ['modifier'],
  () => [
    rule('spectralTether', {
      prevents: ['incorporeality', 'invisibility', 'teleportation'],
      maxDistanceFromCaster: 10,
      repeatSave: {
        skill: 'resistMagic',
        versus: 'newSpellCasting',
        action: 'normal',
        timing: 'targetTurn',
        onSuccess: 'endEffect',
      },
    }),
  ],
  { triggers: ['movement', 'teleport', 'invisibility', 'incorporeality', 'targetTurn'] }
);
define(
  'elgans-bastion',
  ['shield', 'modifier'],
  () => [
    op('shield', { purpose: 'cover', sp: 30, coversAllDirections: true }, 'caster'),
    rule('bastionRestrictions', { maxSPD: 2, allowedActions: ['singleMovementAction'] }, 'caster'),
  ],
  { triggers: ['actionDeclaration', 'damage'] }
);
define('javeds-swarm', ['summon'], () => [
  op(
    'summon',
    {
      profile: 'insectHorde',
      controller: 'caster',
      stats: { spd: 7, hp: 15 },
      skills: { attack: 14, dodge: 14 },
      attacks: [
        damage('1d6', {
          location: 'torso',
          armor: 'ignoreWornArmor',
          onHit: condition('poison'),
          maxTargets: 1,
        }),
      ],
    },
    'area'
  ),
]);
define(
  'trap-portal',
  ['zone', 'reveal', 'modifier'],
  (c) => [
    reveal(['portalDestination'], { portalId: c.get('portal') }, 'caster'),
    op(
      'zone',
      {
        action: 'redirectPortal',
        portalId: c.get('portal'),
        destination: c.get('destination'),
        maxMilesFromOriginal: 1,
        endAfterPassages: 1,
        evidenceDurationSeconds: 2592000,
        detection: [
          { skill: 'magicTraining', dc: 16, automaticIfTrained: true },
          { skill: 'education', dc: 20 },
        ],
      },
      'area'
    ),
  ],
  {
    choices: [target('portal', 'point'), target('destination', 'point')],
    triggers: ['observePortal', 'portalPassage'],
  }
);
define('bekkers-rockslide', ['damage', 'condition', 'zone'], (c) => [
  damage('6d6', {
    damageType: 'bludgeoning',
    physicalCritical: true,
    location: 'torso',
    defenses: ['reposition'],
  }),
  condition('prone'),
  zone(
    { shape: 'circle', radius: 6 },
    [
      damage(
        '4d6',
        {
          damageType: 'bludgeoning',
          physicalCritical: true,
          location: 'torso',
          save: save('athletics', 16, [], { onSuccess: 'avoidAttack' }),
          onHit: condition('prone'),
        },
        'occupants'
      ),
    ],
    { timing: 'impact', targetCentered: true }
  ),
]);
define(
  'ball-lightning',
  ['summon', 'damage', 'restoreWound'],
  () => [
    op(
      'summon',
      {
        profile: 'lightningOrb',
        controller: 'caster',
        expiresOnFirstHit: true,
        attacks: [
          damage('3d6', {
            element: 'electricity',
            location: 'torso',
            onHit: op('restoreWound', {
              action: 'temporaryWoundEffect',
              woundKey: 'difficult-4',
              duration: { seconds: 600 },
            }),
          }),
        ],
        subsequentAttackAction: 'normal',
        newCastingCheckEachAttack: true,
      },
      'area'
    ),
  ],
  { triggers: ['casterTurn', 'orbHit'] }
);
define(
  'invisible-ribbon',
  ['damage', 'modifier', 'narrative'],
  (c) => [
    damage('3d6', { damageType: 'slashing', physicalCritical: true }),
    rule('concealedAttackOrigin', { skill: c.get('perceptionSkill'), dc: 20 }),
    narrative('resolvePerceptionSkillName', { printed: 'Perception', selected: c.get('perceptionSkill') }),
  ],
  { choices: [select('perceptionSkill', ['awareness', 'customPerception'], { gm: true })] }
);
define(
  'touch-of-lightning',
  ['item', 'damage', 'narrative'],
  (c) => [
    op(
      'item',
      {
        action: 'chargeElectricalTrap',
        itemId: c.get('object'),
        formula: `${Math.min(8, 1 + c.get('extraRounds'))}d6`,
        damageType: 'elemental',
        element: 'electricity',
        hitLocation: 'firstTouchingLocation',
        maintenanceCostPerExtraRound: 5,
        extraRounds: c.get('extraRounds'),
        expiresAfterSeconds: 86400,
        clearsIfMovedBeforeTouched: true,
        discovery: { skill: c.get('perceptionSkill'), dc: 20 },
      },
      'item'
    ),
    narrative('resolvePerceptionSkillName', { printed: 'Perception', selected: c.get('perceptionSkill') }),
  ],
  {
    choices: [
      target('object', 'item', { metalOnly: true }),
      numeric('extraRounds', 0, { max: 7, integer: true }),
      select('perceptionSkill', ['awareness', 'customPerception'], { gm: true }),
    ],
    triggers: ['objectMoved', 'firstTouch'],
  }
);
define(
  'cinder-door',
  ['item'],
  (c) => [
    op(
      'item',
      {
        action: 'ablateCover',
        coverId: c.get('cover'),
        formula: '4d6',
        timing: 'eachMaintainedRound',
        requiresFlammable: true,
        shape: { width: 2, height: 2, verticalHeight: 2 },
        collapsesAtZeroSP: true,
        quiet: true,
      },
      'item'
    ),
  ],
  { choices: [target('cover', 'point')], triggers: ['maintainedRound'] }
);
define(
  'mages-forge',
  ['item', 'zone', 'modifier'],
  () => [
    zone(
      { shape: 'forge', portable: false },
      [rule('tinkersForge', { cannotPurifyDimeritium: true }, 'area')],
      { duration: { seconds: 86400 } }
    ),
    op(
      'item',
      {
        action: 'purifyIngots',
        automaticCraftingRecovery: true,
        dimeritiumExcluded: true,
        purifiedIngotsRemainOrdinaryMetal: true,
      },
      'items'
    ),
  ],
  { triggers: ['craftingRecovery'] }
);
define(
  'smiths-touch',
  ['modifier', 'item'],
  () => [
    rule('shapeMetalByHand', { excludesDimeritium: true }, 'caster'),
    active(
      [
        op(
          'item',
          {
            action: 'damageEquipment',
            attackSkill: 'brawling',
            formula: '3d6',
            armorDamage: 'ablation',
            weaponDamage: 'reliability',
            defenses: ['dodge'],
          },
          'item'
        ),
      ],
      10,
      { action: 'normal' }
    ),
  ],
  { triggers: ['turnAction'] }
);

define(
  'invaerne',
  ['zone', 'modifier'],
  (c) => [
    zone({ shape: 'circle', radius: 30 }, [rule('environment', { condition: 'snowIce' }, 'occupants')], {
      duration: { seconds: c.get('coldEnvironment') ? 604800 : 3600 },
    }),
  ],
  {
    choices: [choice('coldEnvironment', 'boolean', { gm: true })],
    triggers: ['enter', 'exit', 'environment'],
  }
);
define(
  'rusting',
  ['item', 'modifier'],
  (c) => [
    op(
      'item',
      {
        action: 'rust',
        mode: c.get('equipment'),
        formula: '2d6',
        damage: c.get('equipment') === 'armor' ? 'ablation' : 'reliability',
        affectsAllWornArmor: c.get('equipment') === 'armor',
        itemId: c.get('item'),
        ifBlockedByShield: 'damageBlockingShieldInstead',
        penalties: c.get('equipment') === 'armor' ? { ref: -2, dex: -2, spd: -2 } : { attacks: -2 },
        penaltiesOnlyWhileUsed: true,
        removeRust: { skill: 'crafting', dc: 14, seconds: 3600, maxItems: 10 },
        duration: { permanent: true },
      },
      'item'
    ),
  ],
  {
    choices: [
      select('equipment', ['armor', 'weapon', 'shield']),
      target('item', 'item', { required: false }),
    ],
    triggers: ['equip', 'unequip', 'craftingRepair'],
  }
);
define(
  'essence-of-potion',
  ['item'],
  (c) => [
    op(
      'item',
      {
        action: 'copyConsumable',
        sourceItem: c.get('potion'),
        consumeComponent: { name: 'Essence of Water', quantity: 1 },
        outputQuantity: 1,
        allowed: ['decoction', 'potion', 'elixir'],
        oncePerSourceDose: true,
        markSourceAffected: true,
      },
      'item'
    ),
  ],
  { choices: [target('potion', 'item')] }
);
define(
  'bekkers-dark-mirror',
  ['modifier', 'item'],
  (c) => [
    modifier(
      {
        [c.get('firstStat')]: -c.roll('firstReduction', '1d6', { min: 1, max: 6 }),
        [c.get('secondStat')]: -c.roll('secondReduction', '1d6', { min: 1, max: 6 }),
      },
      { affectsDerived: true, requiresReflection: true, endsOnDestructionOf: c.get('mirror') }
    ),
    op(
      'item',
      { action: 'captureReflection', itemId: c.get('mirror'), targetCastsNoReflection: true },
      'item'
    ),
  ],
  {
    choices: [
      select('firstStat', STATS),
      select('secondStat', STATS, { differentFrom: 'firstStat' }),
      target('mirror', 'item', { reflective: true }),
    ],
    triggers: ['mirrorDestroyed'],
  }
);
define(
  'steal-spell',
  ['dispel', 'modifier'],
  (c) => [
    op('dispel', {
      action: 'takeControl',
      effectId: c.get('spell'),
      maximumTier: 'journeyman',
      contestedSkill: 'spellCasting',
      succeeds: c.castTotal > c.number('opposedTotal'),
      newTarget: c.get('newTarget'),
      originalRangeApplies: true,
      selfSpellBecomesCaster: true,
      attackTotal: c.castTotal,
      transferMaintenanceToCaster: true,
    }),
  ],
  { choices: [target('spell', 'effect'), target('newTarget')], triggers: ['opponentCasts'] }
);
define(
  'crystal-stasis',
  ['modifier', 'condition', 'shield'],
  () => [
    rule('crystallization', {
      phases: [
        { targetTurn: 1, modifiers: { attack: -3, defense: -3, spd: -3 } },
        { targetTurn: 2, immobilized: true },
        { targetTurn: 3, condition: 'unconscious', unaging: true, dispelOnlyRelease: true },
      ],
      requiredMaintainedRounds: 3,
      interruptionBeforeCompletion: 'reverseAll',
      afterCompletionRequiresMaintenance: false,
    }),
    op('shield', { purpose: 'crystalPrison', destructionNotDefinedByBook: true, release: 'dispelOnly' }),
  ],
  { triggers: ['targetTurn', 'maintenanceInterrupted'] }
);
define(
  'shape-earth',
  ['item', 'narrative'],
  (c) => [
    op(
      'item',
      {
        action: 'buildStructure',
        point: c.get('point'),
        description: c.get('structure'),
        maxSize: { width: 20, height: 20, verticalHeight: 20 },
        sp: c.get('sp'),
        buildSeconds: 600,
        materialsMustExistAtSite: true,
        complexity: 'simple',
        permanent: true,
      },
      'area'
    ),
    narrative('approveSimpleStructureAndMaterialSP', { structure: c.get('structure'), sp: c.get('sp') }),
  ],
  { choices: [target('point', 'point'), text('structure'), numeric('sp', 5, { max: 30, gm: true })] }
);
define(
  'gwyntog',
  ['zone', 'modifier', 'move'],
  () => [
    zone({ shape: 'circle', radius: 40, maximumRadius: true }, [
      move(0, { mode: 'fallFromCurrentAltitude', predicate: 'flying', timing: 'enter' }, 'occupants'),
      rule(
        'windstorm',
        {
          rangedAttacksMiss: true,
          projectileLanding: 'gm',
          movementSave: { skill: 'athletics', dc: 20, onFailure: 'noMoveOrRunAction' },
        },
        'occupants'
      ),
    ]),
  ],
  { triggers: ['enter', 'rangedAttack', 'moveAction'] }
);
define(
  'hand-of-the-tempest',
  ['move', 'damage', 'condition', 'zone'],
  (c) =>
    c.get('mode') === 'launch'
      ? [
          move(14, {
            mode: 'verticalLaunch',
            maximumWeight: 1000,
            defenses: ['reposition'],
            fallAt: 'endOfNextTargetTurn',
            onLanding: [damage('7d6', { damageType: 'bludgeoning', location: 'torso' }), condition('prone')],
            collisionVictimTakesSameDamage: true,
          }),
        ]
      : c.get('mode') === 'gust'
        ? [
            zone({ shape: 'cone', distance: 14, angle: c.get('coneAngle') }, [
              move(14, { requiresRepositionOutsideArea: true }, 'occupants'),
            ]),
          ]
        : [
            op(
              'move',
              {
                mode: 'manipulate',
                objectId: c.get('object'),
                maximumWeight: 1000,
                range: 20,
                asIfHeld: true,
              },
              'item'
            ),
          ],
  {
    choices: [
      select('mode', ['launch', 'gust', 'manipulate']),
      numeric('coneAngle', 1, { max: 360, gm: true, when: { key: 'mode', equals: 'gust' } }),
      target('object', 'item', { when: { key: 'mode', equals: 'manipulate' } }),
    ],
    triggers: ['endOfNextTargetTurn', 'landing'],
  }
);
define(
  'blaze-of-the-korath',
  ['zone', 'resource', 'modifier', 'condition'],
  () => [
    zone({ shape: 'circle', radius: 40, maximumRadius: true }, [
      resource('sta', '-2d6', { timing: 'castAndEnterOnOwnTurnOrStartTurn' }, 'occupants'),
      rule('noRecoveryAction', {}, 'occupants'),
      rule(
        'zeroSTARecovery',
        { condition: 'unconscious', minimumRecoveredSTA: 20, requiresStunSave: true },
        'occupants'
      ),
    ]),
  ],
  { triggers: ['cast', 'enterOnOwnTurn', 'startTurn', 'recoveryAction', 'zeroSTA'] }
);
define(
  'living-fire',
  ['summon'],
  (c) => [
    op(
      'summon',
      {
        profile: 'livingFire',
        sourceFire: c.get('fire'),
        controller: 'caster',
        initiative: 'caster',
        stats: { spd: 5 },
        traits: { incorporeal: true },
        magic: { spells: ['aenye', 'wave-of-fire', 'flaming-vortex'], castingBase: 16, unlimitedSTA: true },
        noExtraActions: true,
        destroyedWhenFireExtinguished: true,
      },
      'area'
    ),
  ],
  { choices: [target('fire', 'point')], triggers: ['fireExtinguished'] }
);
define(
  'ainfras-extraction',
  ['resource', 'modifier'],
  (c) => [
    resource('sta', '-8d6'),
    rule(
      'immediateFreeCast',
      { spellKey: c.get('followup'), choices: ['rhewi', 'ice-slick', 'water-jet'], staCost: 0, once: true },
      'caster'
    ),
  ],
  { choices: [select('followup', ['rhewi', 'ice-slick', 'water-jet'])], triggers: ['immediateFollowup'] }
);
define(
  'deluge-of-ys',
  ['zone', 'damage', 'condition', 'item'],
  (c) => [
    zone(
      { shape: 'rectangle', width: 20, height: 20, verticalHeight: 20 },
      [
        damage('5d6', { damageType: 'bludgeoning', location: 'torso', physicalCritical: true }, 'occupants'),
        condition('prone', { save: save('physique', 24, [condition('prone')]) }, 'occupants'),
      ],
      { waterBehavior: c.get('enclosed') ? 'fillAndRemainSubmerged' : 'disperseThisTurn' }
    ),
    ...(c.get('enclosed') ? [op('item', { action: 'breakUnreinforcedBarriers' }, 'area')] : []),
  ],
  { choices: [choice('enclosed', 'boolean', { gm: true })] }
);
define(
  'duplicitous-darkness',
  ['modifier'],
  () => [
    modifier({ deceit: 2 }),
    rule('mentalPrivacy', {
      blocks: ['magicalTruthCompulsion', 'telepathicSpying'],
      detection: { skill: 'awareness', dc: 20 },
    }),
  ],
  { triggers: ['truthCompulsion', 'telepathicSpying'] }
);
define(
  'blessing-of-abundance',
  ['modifier'],
  () => [
    rule(
      'doubleLootRoll',
      {
        rollEachQuantityTwice: true,
        keep: 'higher',
        appliesTo: 'entireNextLootSource',
        consumeAfterSource: true,
      },
      'caster'
    ),
  ],
  { triggers: ['lootRoll'] }
);
define(
  'seek-the-seekers',
  ['reveal', 'modifier'],
  () => [
    rule(
      'divinationWarning',
      {
        radius: 10,
        revealsDivinerFace: true,
        observerDetection: { skills: ['education', 'magicTraining'], dc: 20 },
        warnsIfObserverRealizesDetection: true,
      },
      'caster'
    ),
  ],
  { triggers: ['divinationTargetsArea'] }
);
define(
  'quill-of-the-divine',
  ['modifier', 'narrative'],
  (c) =>
    c.power === 14
      ? [
          rule('retrogradeAmnesia', { duration: { permanent: true } }),
          narrative('identifySuppressedMemories'),
        ]
      : [
          rule('implantedMemory', {
            description: c.get('memory'),
            defenseBonusUnlessAmnesiac: 5,
            duration: { permanent: true },
          }),
          narrative('integrateImplantedMemory', { description: c.get('memory') }),
        ],
  { choices: [text('memory', { required: false })], triggers: ['memoryRecall'] }
);
define(
  'sagitta-aurea',
  ['damage', 'dispel', 'modifier'],
  () => [
    damage('7d6', {
      element: 'divineLight',
      piercingLine: true,
      eachTargetDefends: true,
      alsoDamagesPossessingDemon: true,
    }),
    op('dispel', { action: 'expelPossessingDemon', predicate: 'hit' }),
    rule('suppressDemonAbilities', { predicate: 'demonDamaged', duration: { rounds: 1 } }),
  ],
  { triggers: ['demonDamaged', 'demonAbility'] }
);
define(
  'blessed-herd',
  ['summon', 'modifier'],
  (c) => [
    op(
      'summon',
      {
        profile: c.get('mode') === 'swift' ? 'horse' : 'warhorse',
        count: c.get('count'),
        maximumControlled: 10,
        appearsWithinSeconds: 3600,
        stats: c.get('mode') === 'swift' ? { spd: 24 } : {},
        skills: c.get('mode') === 'swift' ? { athletics: 20 } : {},
        traits:
          c.get('mode') === 'strong'
            ? { controlModifier: 2, naturalArmor: 20, cannotLayerBarding: true }
            : {},
        chosenRidersBonus: { riding: 5 },
      },
      'area'
    ),
  ],
  { choices: [select('mode', ['swift', 'strong']), numeric('count', 1, { max: 10, integer: true })] }
);
define(
  'blood-of-the-berserker',
  ['transform'],
  () => [
    op(
      'transform',
      {
        form: 'greatBear',
        useHigherOfOriginalOrFormStatsAndSkills: true,
        mergeEquipment: true,
        gainFormAbilities: true,
        suppressProfessionAbilities: true,
        suppressMagic: true,
        carryDamageAndWoundsBothWays: true,
        minimumHPOnReturnIfDamageOtherwiseLethal: 1,
      },
      'caster'
    ),
  ],
  { triggers: ['transform', 'returnFromForm'] }
);
define(
  'champion-of-the-river',
  ['modifier'],
  () => [
    modifier(
      { allActions: 5 },
      { allRollsBonus: 5, avoidDoubleApplyingActionBonus: true, requiresAnointmentWithRiverWater: true }
    ),
    rule('resistance', { damageSources: 'all' }),
  ],
  { triggers: ['roll', 'damage'] }
);
define(
  'feast-of-plenty',
  ['heal', 'restoreWound', 'condition', 'modifier'],
  (c) => [
    heal('6d6', { maximumTargets: c.get('servings'), trigger: 'eatFeast' }, 'targets'),
    op('restoreWound', { action: 'treatAll', trigger: 'eatFeast', requiresLivingTarget: true }, 'targets'),
    condition('poison', { action: 'remove', trigger: 'eatFeast' }, 'targets'),
    rule('removeDisease', { trigger: 'eatFeast' }, 'targets'),
  ],
  {
    choices: [
      numeric('servings', 20, { integer: true }),
      choice('allFoodLocallyGathered', 'boolean', { mustEqual: true }),
    ],
    triggers: ['eatFeast'],
  }
);
define(
  'miracle-of-lebioda',
  ['restoreWound'],
  (c) => [
    op('restoreWound', {
      action: 'eraseCompletely',
      woundId: c.get('wound'),
      removesPermanentConsequence: true,
      regrowsAnatomy: true,
      count: 1,
      targetMustBeLiving: true,
    }),
  ],
  { choices: [target('wound', 'item')] }
);
define(
  'omens-of-the-future',
  ['modifier'],
  (c) => [
    rule(
      'foreseenFumble',
      {
        numbers: [
          c.roll('omen1', '1d10 reroll 1 or 10', { min: 2, max: 9 }),
          c.roll('omen2', '1d10 reroll 1 or 10', { min: 2, max: 9 }),
          c.roll('omen3', '1d10 reroll 1 or 10', { min: 2, max: 9 }),
        ],
        range: 20,
        mayReplaceMatchingNaturalD10WithFumble: true,
        actionCost: 'none',
        consumedPerUse: false,
      },
      'caster'
    ),
  ],
  {
    triggers: ['nearbyD10Roll'],
    notes: ['The book does not require three different results or consume them after use.'],
  }
);
define(
  'retribution-of-the-raven',
  ['zone', 'modifier'],
  (c) => [
    zone(
      { shape: 'circle', radius: c.get('radius') },
      [
        rule(
          'suppressMagic',
          {
            items: true,
            runes: true,
            glyphs: true,
            focuses: true,
            curses: true,
            trophies: true,
            relics: true,
          },
          'area'
        ),
        rule(
          'castingPermission',
          { permitted: 'selectedOrInitiallyResisted', initialDefenseTotal: c.defenseDC },
          'occupants'
        ),
      ],
      { cannotBeDispelled: true }
    ),
  ],
  {
    choices: [numeric('radius', 0, { max: 20, gm: true })],
    triggers: ['enter', 'exit', 'beforeCast', 'magicItemUse'],
    notes: ['Range says20m but does not label it a radius. Require a table ruling for region size.'],
  }
);
define(
  'silverlight',
  ['modifier'],
  () => [
    rule(
      'silverlight',
      {
        maximumTargets: 5,
        ignoreWoundThresholdPenalties: true,
        ignoreDeathStatePenalties: true,
        firstReductionBelowOneHP: 'setToOne',
        preventDeathUses: 1,
        expires: 'nextSunrise',
      },
      'targets'
    ),
  ],
  { triggers: ['derivedPenalties', 'damage', 'sunrise'] }
);
define('herbalism', ['modifier'], () => [
  rule(
    'skillSubstitution',
    { skill: 'alchemy', substitute: 'spellCasting', predicate: 'plantOnlyElixirCraftingOrRecovery' },
    'caster'
  ),
]);
define(
  'sigil-of-bounty',
  ['item'],
  (c) => [
    op(
      'item',
      {
        action: c.get('mode'),
        restoreFood: c.get('mode') === 'refreshFood',
        forageYieldMultiplier: c.get('mode') === 'forageYield' ? 2 : undefined,
        plantSizeMultiplier: c.get('mode') === 'fertileSoil' ? 2 : undefined,
        growthTimeMultiplier: c.get('mode') === 'fertileSoil' ? 0.5 : undefined,
        itemId: c.get('object'),
      },
      'item'
    ),
  ],
  {
    choices: [select('mode', ['refreshFood', 'forageYield', 'fertileSoil']), target('object', 'item')],
    triggers: ['forage', 'plantGrowth'],
  }
);
define(
  'web-of-roots',
  ['zone', 'condition', 'shield', 'modifier'],
  (c) => [
    zone(
      { shape: 'circle', radius: 10 },
      [
        active(
          [
            op(
              'modifier',
              {
                modifiers: {},
                rule: {
                  key: 'rootManeuver',
                  options: ['grapple', 'trip', 'disarm'],
                  castingTotal: c.castTotal,
                  defenseRequired: true,
                  rangeFromTree: 10,
                },
              },
              'target'
            ),
          ],
          1,
          { mayMaintainExistingGrappleInstead: true }
        ),
      ],
      { centerObject: c.get('tree') }
    ),
    op('shield', {
      purpose: 'bindingRoots',
      hp: 15,
      escape: { skill: 'dodge', versus: 'newSpellCasting' },
      onDestroy: 'releaseGrapple',
    }),
  ],
  { choices: [target('tree', 'point')], triggers: ['maintainedRound', 'escapeAttempt', 'damageRoots'] }
);
define(
  'word-of-summoning',
  ['summon', 'modifier'],
  (c) => [
    op(
      'summon',
      {
        profile: c.get('animal'),
        size: c.power === 2 ? 'small' : c.power === 5 ? 'medium' : 'large',
        arrivalRounds: c.roll('arrival', '1d6', { min: 1, max: 6 }),
        attitude: 'friendly',
        helpsUnlessMistreated: true,
        attitudeOnExpiry: 'neutral',
        oncePerAreaPerDay: true,
      },
      'area'
    ),
  ],
  { choices: [text('animal', { gm: true, mustMatchPrintedSize: true })] }
);
define(
  'bigelows-befoulment',
  ['item', 'modifier', 'condition'],
  (c) => [
    op(
      'item',
      {
        action: 'contaminateFood',
        shape: { width: 2, height: 2, verticalHeight: 2 },
        itemId: c.get('food'),
        onConsumption: [
          rule('disease', {
            onsetWithinSeconds: 3600,
            modifiers: { allActions: -2, staMultiplier: 0.75 },
            nauseaSave: { skill: 'endurance', dc: 14, when: 'gmCalls' },
            cure: { skill: 'healingHands', dc: 15, thenFullNightsRest: true },
          }),
          ...(c.power === 10 ? [condition('poison')] : []),
        ],
        permanent: true,
      },
      'item'
    ),
  ],
  {
    choices: [target('food', 'item')],
    triggers: ['consumeFood', 'gmDiseaseSave', 'medicalTreatment', 'rest'],
  }
);
define(
  'sigil-of-the-hunt',
  ['modifier', 'narrative'],
  (c) => [
    rule(
      'animalMark',
      {
        mark: c.get('mark'),
        maxTargets: 6,
        animalsInitialAttitude: c.get('mark') === 'safe' ? 'friendly' : 'predatoryAttackOnSight',
        monstersInitialAttitude: c.get('mark') === 'safe' ? 'neutral' : 'predatoryAttackOnSight',
        identifyMark: { skill: 'education', dc: 16 },
      },
      'targets'
    ),
    narrative('applyAnimalDisposition', { mark: c.get('mark') }),
  ],
  { choices: [select('mark', ['safe', 'prey'])], triggers: ['animalEncounter', 'monsterEncounter'] }
);

const terrainChoices = ['fields', 'mountains', 'underground', 'forest', 'swamp', 'shore', 'desert', 'tundra'];
define(
  'druidic-totem',
  ['item', 'zone', 'modifier', 'heal', 'resource'],
  (c) => {
    const effects = {
      fields: [rule('statOverride', { stat: 'spd', value: 12 }, 'caster')],
      mountains: [rule('resistance', { damageSources: ['bludgeoning', 'slashing', 'piercing'] }, 'caster')],
      underground: [modifier({ stealth: 4 }, { traits: { superiorNightVision: true } }, 'caster')],
      forest: [rule('localFruitRegeneration', { hpPerRound: 3, durationSeconds: 3600 }, 'caster')],
      swamp: [rule('conditionImmunity', { conditions: ['poison', 'disease'] }, 'caster')],
      shore: [rule('breatheWaterAndAir', {}, 'caster'), rule('unhinderedUnderwaterActions', {}, 'caster')],
      desert: [
        rule('extremeHeatImmunity', {}, 'caster'),
        rule('alwaysFindWater', {}, 'caster'),
        resource('sta', 'maximum', { trigger: 'drinkLocalWater', frequency: 'oncePerDay' }, 'caster'),
      ],
      tundra: [
        rule('conditionImmunity', { conditions: ['snowIce', 'fire', 'frozen'] }, 'caster'),
        rule('resistance', { damageSources: ['fire', 'ice'] }, 'caster'),
      ],
    };
    return [
      op(
        'item',
        { action: 'sacrifice', itemId: c.get('focus'), requiredOrigin: 'riteOfOakAndMistletoe' },
        'item'
      ),
      op(
        'item',
        { action: 'createTotem', height: 2, hp: 20, maxActive: 1, oldTotemBecomesNonmagicalPlant: true },
        'area'
      ),
      zone({ shape: 'circle', radius: 1609.344 }, [
        rule('focusMinimum', { value: 4 }, 'caster'),
        rule('friendlyAnimals', { includesAllies: true }, 'caster'),
        ...(effects[c.get('terrain')] ?? []),
      ]),
    ];
  },
  {
    choices: [select('terrain', terrainChoices), target('focus', 'item')],
    triggers: ['enter', 'exit', 'consumeLocalFruit', 'drinkLocalWater', 'environment'],
  }
);
define(
  'wrath-of-nature',
  ['zone', 'modifier', 'damage', 'move', 'condition', 'shield', 'item'],
  (c) => {
    const total = c.castTotal;
    const effects = {
      fields: [
        op(
          'zone',
          {
            action: 'createOrMoveTornado',
            shape: { width: 4, height: 4, verticalHeight: 4 },
            summonWithin: 10,
            movePerTurn: 10,
            onCross: [
              damage('4d6', {
                location: 'torso',
                save: save('athletics', c.defenseDC, [], { onSuccess: 'avoidAttack' }),
                onHit: move(10, { direction: 'gm' }),
              }),
            ],
          },
          'area'
        ),
      ],
      mountains: [
        damage('6d6', {
          element: 'electricity',
          location: 'torso',
          defenses: ['dodge', 'reposition'],
          onHit: condition('fire', { chance: 50 }),
        }),
      ],
      underground: [
        damage('5d6', {
          damageType: 'piercing',
          physicalCritical: true,
          defenses: ['dodge', 'reposition', 'block'],
        }),
        op(
          'item',
          {
            action: 'createCover',
            shape: { width: 2, height: 2, verticalHeight: 2 },
            sp: 20,
            persists: true,
          },
          'area'
        ),
      ],
      forest: [
        op(
          'item',
          {
            action: 'createOrCommandRoots',
            immobile: true,
            longReach: true,
            maneuvers: ['grapple', 'trip', 'disarm', 'choke', 'pin'],
            brawlingBase: Math.max(16, c.number('spellCastingBase', { min: 0 })),
            commandEachExisting: true,
          },
          'area'
        ),
      ],
      swamp: [
        zone(
          { shape: 'circle', radius: 6 },
          [rule('disease', { save: { skill: 'endurance', dc: c.defenseDC } }, 'occupants')],
          { ignitesOnOpenFlame: { damage: '5d6', location: 'torso', fireChance: 75 } }
        ),
      ],
      shore: [
        damage('3d6', {
          attacks: 2,
          allocateAmongMaxTargets: 2,
          range: 20,
          defenses: ['dodge', 'reposition'],
          onHit: move(6),
        }),
      ],
      desert: [
        zone({ shape: 'circle', radius: 6 }, [
          condition('blinded', { duration: { rounds: 5 }, defenses: ['dodge', 'reposition'] }, 'occupants'),
          condition('fire', { predicate: 'failedSameDefense' }, 'occupants'),
        ]),
      ],
      tundra: [
        op('shield', {
          purpose: 'icePrison',
          hp: 10,
          fireDamageToBreak: 5,
          excessDamageToTorso: true,
          prohibitsActions: true,
          prohibitsMovement: true,
          defenses: ['dodge', 'reposition', 'resistMagic'],
          breakFree: { skill: 'physique', dc: 16 },
        }),
      ],
    };
    return [
      zone(
        { shape: 'circle', radius: 60 },
        [active(effects[c.get('terrain')] ?? [], 6, { action: 'fullRound', useCastingTotal: total })],
        { centeredOnCaster: true }
      ),
    ];
  },
  {
    choices: [select('terrain', terrainChoices)],
    triggers: ['casterTurn', 'openFlameContact', 'escapeAttempt'],
  }
);
define(
  'shade-of-bleobheris',
  ['modifier', 'narrative'],
  () => [
    rule(
      'pacified',
      {
        removeFromInitiative: true,
        cannotTakeHostileActions: true,
        negateSocialStandingAndMonstrousHeritagePenalties: true,
        animalsDocile: true,
        repeatSave: { skill: 'resistMagic', versus: 'newSpellCasting', action: 'normal' },
        endsIfAttacked: true,
      },
      'targets'
    ),
    narrative('applyPacificationAndSuspendPrejudice'),
  ],
  { triggers: ['hostileAction', 'repeatDefense', 'attacked', 'socialCheck'] }
);
define(
  'winds-of-the-taiga',
  ['zone', 'condition', 'modifier'],
  () => [
    zone({ shape: 'circle', radius: 1609.344 }, [
      condition('blinded', { predicate: 'notChosenAlly' }, 'occupants'),
      rule('environment', { condition: 'snowIce', predicate: 'notChosenAlly' }, 'occupants'),
      rule(
        'attackEffectChance',
        { effect: 'frozen', additionalChance: 50, predicate: 'chosenAlly' },
        'occupants'
      ),
    ]),
  ],
  { triggers: ['enter', 'exit', 'attackHit'] }
);
define(
  'sanctuary-of-the-black-grove',
  ['zone', 'reveal', 'move'],
  () => [
    zone({ shape: 'circle', radius: 1609.344 }, [
      reveal(
        ['viewThroughTrees'],
        { requiresTouchingTree: true, simultaneousViews: true, casterOnly: true },
        'caster'
      ),
      op(
        'move',
        { mode: 'treeTeleport', chosenAlliesOnly: true, startAndEndMustBeTreesWithinArea: true },
        'occupants'
      ),
    ]),
  ],
  { triggers: ['touchTree', 'enterTree'] }
);
define(
  'conspiracy-of-the-mother',
  ['summon', 'modifier', 'reveal'],
  (c) => [
    op(
      'summon',
      {
        profile: 'crow',
        count: c.get('count'),
        maxBonded: 10,
        duration: { permanent: true },
        stats: { int: 7, ref: 7, dex: 7 },
        skillRanks: { sleightOfHand: 7 },
        clawDamage: '2d6',
        sapient: true,
        attitude: 'obeysUnlessAbused',
        telepathyRange: 20,
        alwaysKnowsCasterLocation: true,
      },
      'area'
    ),
    reveal(['crowMemories'], { requiresPhysicalTouch: true }, 'caster'),
  ],
  { choices: [numeric('count', 1, { max: 10, integer: true })], triggers: ['touchCrow', 'telepathy'] }
);
define(
  'well-of-knowledge',
  ['item', 'modifier'],
  () => [
    op(
      'item',
      {
        action: 'createBlessedBasin',
        charges: 20,
        onDrink: [
          modifier({ awareness: 4 }, { initiativeBonus: 4 }),
          rule('conditionImmunity', { conditions: ['staggered', 'stunned', 'hallucinating'] }),
          rule('seeThroughIllusions'),
          modifier({ vigor: 4, resistMagic: -4 }, { predicate: 'vigorBeforeDrinkingAtLeastOne' }),
        ],
        effectDurationSeconds: 86400,
        beneficiaryCooldownSeconds: 604800,
        leavesSigilOnExpiry: true,
      },
      'area'
    ),
  ],
  { triggers: ['drinkFromBasin'] }
);
define(
  'corpse-restoration',
  ['reveal', 'narrative'],
  (c) => [
    reveal(['corpseAppearanceAtDeath', 'injuriesAtDeath'], {
      corpseId: c.get('corpse'),
      tangibleGhostlyFlesh: true,
      onlyAvailableParts: true,
      maximumPartSeparation: 4,
    }),
    narrative('reconstructAvailableCorpseParts', {
      corpseId: c.get('corpse'),
      preserveOriginalInjuries: true,
    }),
  ],
  { choices: [target('corpse', 'item')] }
);
define('storm-of-souls', ['summon'], (c) => [
  op(
    'summon',
    {
      profile: 'wraith',
      count: c.roll('wraiths', '1d6+4', { min: 5, max: 10 }),
      disposition: 'hostileToEveryone',
      controllable: false,
      mayAttackCasterAndAllies: true,
    },
    'area'
  ),
]);
