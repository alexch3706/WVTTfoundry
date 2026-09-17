import { MAGIC, magicInfo } from './magic-catalog.js';
import { RuleError } from './rules.js';

const copy = (value) => structuredClone(value);
const keys = (text) => new Set(text.trim().split(/\s+/));
const self = keys(`glamour magic-compass adenydd natures-sight holy-light vaults-of-knowledge
  polymorphism sharpen-senses light-feet auroras-breath slip-stream cloak empower elgans-bastion
  blessing-of-abundance blood-of-the-berserker omens-of-the-future luck-of-the-father blessing-of-love
  detect-ley-line seek-the-seekers herbalism`);
const objects = keys(`luthiens-quill telekinesis cadfans-grasp raise-flame control-water puro-dwr
  elgans-theory transmutation alchemical-recovery reopen-portal savollas-method cryfhau harmless-fire web-of-ice
  disrupt-focus trap-portal touch-of-lightning cinder-door essence-of-potion blessed-weapon sigil-of-bounty
  bigelows-befoulment corpse-restoration`);
const points = keys(`afans-mirror codi-bywyd natures-gift rhwystr-graig shape-nature demetias-crest-surge
  earthen-pillar mages-forge shape-earth living-fire druidic-totem well-of-knowledge storm-of-souls`);
const specials = keys(`summon-staff teleportation standing-portal divine-portal divine-wisdom blessed-herd
  word-of-summoning feast-of-plenty`);
const areaOriginsAtCaster = keys(`koraths-breath freshen-air uriens-shelter static-storm zephyr aine-verseos
  magic-flare wave-of-fire dormyns-fog gwynt-troelli merigolds-hailstorm waves-of-the-naglfar dervish
  lightning-storm melgars-fire freyas-bravery white-flame wrath-of-nature shade-of-bleobheris
  winds-of-the-taiga sanctuary-of-the-black-grove`);
const exclusions = {
  'static-storm': ['caster'],
  'lightning-storm': ['caster'],
  'melgars-fire': ['caster'],
};

function baseProfile(magic) {
  const rangeM = Number(magic.range.distance ?? 0) * (magic.range.unit === 'mile' ? 1609.344 : 1);
  const area = copy(magic.area ?? { shape: 'none' });
  let targetMode = magic.range.targeting === 'self' ? 'self' : area.shape !== 'none' ? 'area' : 'actor';
  if (self.has(magic.key)) targetMode = 'self';
  if (objects.has(magic.key)) targetMode = 'object';
  if (points.has(magic.key)) targetMode = 'point';
  if (specials.has(magic.key)) targetMode = 'special';
  return {
    key: magic.key,
    source: magic.source,
    page: magic.page,
    targetMode,
    actorSelf: targetMode === 'self',
    rangeM,
    printedRange: magic.range.text,
    minTargets: ['actor', 'self'].includes(targetMode) ? 1 : 0,
    maxTargets: targetMode === 'area' ? null : ['actor', 'self'].includes(targetMode) ? 1 : 0,
    selection: targetMode === 'area' ? 'all' : ['actor', 'self'].includes(targetMode) ? 'one' : 'none',
    origin: areaOriginsAtCaster.has(magic.key) ? 'caster' : 'point',
    area,
    radiusM: area.shape === 'circle' ? area.radius : null,
    exclusions: [...(exclusions[magic.key] ?? [])],
    requiredChoices: [],
    notes: [],
  };
}
function actorTargets(profile, maxTargets, { minTargets = 1, selection = 'chosen', ...extra } = {}) {
  return Object.assign(profile, {
    targetMode: maxTargets === 1 ? 'actor' : 'actors',
    actorSelf: false,
    minTargets,
    maxTargets,
    selection,
    area: { shape: 'none' },
    radiusM: null,
    ...extra,
  });
}
function selfTarget(profile) {
  return Object.assign(profile, {
    targetMode: 'self',
    actorSelf: true,
    minTargets: 1,
    maxTargets: 1,
    selection: 'one',
    origin: 'caster',
  });
}
function actorArea(profile, radius, { origin = 'caster', selection = 'all', ...extra } = {}) {
  return Object.assign(profile, {
    targetMode: 'area',
    actorSelf: false,
    minTargets: 0,
    maxTargets: null,
    selection,
    origin,
    radiusM: radius,
    area: { shape: 'circle', radius, angle: null },
    ...extra,
  });
}
function requireChoice(profile, choices, key, descriptor) {
  const value = choices[key];
  if (value === undefined || value === null || value === '') {
    profile.requiredChoices.push({ key, ...descriptor });
    return undefined;
  }
  if (descriptor.options && !descriptor.options.includes(value))
    throw new RuleError(`Invalid ${key} for ${profile.key}.`);
  if (
    descriptor.type === 'number' &&
    (!Number.isFinite(value) ||
      (descriptor.min !== undefined && value < descriptor.min) ||
      (descriptor.max !== undefined && value > descriptor.max))
  )
    throw new RuleError(`Invalid ${key} for ${profile.key}.`);
  return value;
}

/** Source-audited targeting, independent of which effect executors are currently enabled. */
export function magicTargetingProfile(key, { choices = {}, spellCastingRank } = {}) {
  const magic = magicInfo(typeof key === 'string' ? key : key?.key);
  if (!magic || !['spell', 'invocation'].includes(magic.kind))
    throw new RuleError('This targeting profile is for a catalog spell or invocation.');
  const profile = baseProfile(magic);
  if (
    ['static-storm', 'merigolds-hailstorm', 'lightning-storm', 'melgars-fire', 'dormyns-fog'].includes(
      magic.key
    )
  )
    profile.application = 'persistentZone';
  if (profile.area.shape === 'cone')
    profile.area.angle =
      requireChoice(profile, choices, 'coneAngle', {
        type: 'number',
        min: 1,
        max: 360,
        gm: true,
        reason: 'The book prints cone length but does not define an angle.',
      }) ?? null;
  switch (magic.key) {
    case 'zephyr': {
      const affectsCaster = requireChoice(profile, choices, 'zephyrAffectsCaster', {
        type: 'boolean',
        options: [false, true],
        reason: 'Core p.103 does not explicitly exempt the caster. Use the declared table ruling.',
      });
      profile.exclusions = affectsCaster === true ? [] : ['caster'];
      profile.notes.push(
        `Table ruling: caster ${affectsCaster === true ? 'takes the 1d6 damage and stays at the burst origin' : 'is excluded'}. Allies remain affected.`
      );
      break;
    }
    case 'dispel':
    case 'steal-spell':
      Object.assign(profile, {
        targetMode: 'effect',
        minTargets: 0,
        maxTargets: 0,
        selection: 'none',
        actorSelf: false,
      });
      break;
    case 'telepathy':
      profile.roles = [{ role: 'participant', kind: 'actor', maximum: 1, rangeM: 10 }];
      break;
    case 'boiling-blood':
      profile.eligibility = ['animalOrNonsapientMonster'];
      profile.roles = [
        {
          role: 'victim',
          kind: 'actor',
          maximum: 1,
          rangeM: null,
          note: 'A separate commanded victim; the printed 8m range selects the enraged animal.',
        },
      ];
      break;
    case 'fergus-demise':
      actorTargets(profile, 1);
      profile.beneficiary = 'caster';
      profile.roles = [{ role: 'interrogationSubject', kind: 'actor', maximum: 1, rangeM: 2 }];
      break;
    case 'friend-to-wild-kind': {
      const mode = requireChoice(profile, choices, 'mode', {
        type: 'enum',
        options: ['handleAnimals', 'calm'],
      });
      if (mode === 'handleAnimals') selfTarget(profile);
      else if (mode === 'calm') {
        actorTargets(profile, 1);
        profile.rangeM = 5;
        profile.eligibility = ['animal'];
      }
      break;
    }
    case 'presence-of-the-divine': {
      const mode = requireChoice(profile, choices, 'mode', {
        type: 'enum',
        options: ['presence', 'fearImmunity'],
      });
      if (mode === 'presence') selfTarget(profile);
      else if (mode === 'fearImmunity') actorTargets(profile, 6);
      break;
    }
    case 'voice-of-the-counselor': {
      selfTarget(profile);
      const voice = requireChoice(profile, choices, 'voice', {
        type: 'enum',
        options: ['booming', 'whisper'],
      });
      if (voice === 'whisper') profile.roles = [{ role: 'listener', kind: 'actor', maximum: 1, rangeM: 10 }];
      break;
    }
    case 'blessing-of-love':
      profile.notes.push('Core p.111 explicitly names the caster as beneficiary despite printing Range 5m.');
      break;
    case 'threads-of-life':
      actorArea(profile, 10, { rangeM: 0, beneficiary: 'caster', includeCaster: true });
      profile.notes.push(
        'The effect explicitly says every target within the spell radius; the Range line is 10m.'
      );
      break;
    case 'natures-sight':
      profile.observation = {
        radiusM: 50,
        selection: 'all',
        eligibility: 'unnaturalCreatures',
        throughObstacles: true,
      };
      break;
    case 'detect-ley-line':
      profile.observation = { radiusM: 1609.344, selection: 'nearest', eligibility: 'leyLine' };
      break;
    case 'seek-the-seekers':
      profile.observation = { radiusM: 10, selection: 'all', eligibility: 'divinationTargets' };
      break;
    case 'healing-rest':
      if (!Number.isInteger(spellCastingRank) || spellCastingRank < 0) {
        actorTargets(profile, null);
        profile.requiredChoices.push({
          key: 'spellCastingRank',
          type: 'contextNumber',
          min: 0,
          integer: true,
        });
      } else actorTargets(profile, spellCastingRank);
      profile.eligibility = ['living'];
      break;
    case 'silverlight':
      actorTargets(profile, 5);
      break;
    case 'sigil-of-the-hunt':
      actorTargets(profile, 6);
      break;
    case 'conspiracy-of-the-mother':
      actorTargets(profile, 10);
      profile.eligibility = ['crow'];
      profile.maximumBonded = 10;
      profile.notes.push(
        'Existing crows within half a mile are summoned and bonded; range is not an arbitrary point for creating a new creature.'
      );
      break;
    case 'tryferi-gaeaf':
      if (!Number.isInteger(spellCastingRank) || spellCastingRank < 0) {
        actorTargets(profile, null);
        profile.requiredChoices.push({
          key: 'spellCastingRank',
          type: 'contextNumber',
          min: 0,
          integer: true,
        });
      } else {
        actorTargets(profile, Math.floor(spellCastingRank / 2));
        profile.projectiles = {
          count: Math.floor(spellCastingRank / 2),
          allocation: 'chosenTargets',
          repeatSameTarget: true,
          eachAttackSeparately: true,
        };
      }
      break;
    case 'alzurs-thunder':
    case 'sagitta-aurea':
      actorTargets(profile, null, { selection: 'all', origin: 'caster' });
      profile.area = { shape: 'line', distance: profile.rangeM, width: null };
      profile.lineOrder = 'nearestFirst';
      profile.eachTargetDefends = true;
      profile.requireStraightLine = true;
      profile.damageDiceLostPerPriorTarget = magic.key === 'alzurs-thunder' ? 1 : 0;
      profile.area.width =
        requireChoice(profile, choices, 'lineWidth', {
          type: 'number',
          min: Number.EPSILON,
          gm: true,
          reason:
            'The book does not specify a beam width; the GM must confirm which tokens the straight line intersects.',
        }) ?? null;
      break;
    case 'sigil-of-the-hidden':
      Object.assign(profile, {
        targetMode: 'area',
        actorSelf: false,
        maxTargets: null,
        minTargets: 0,
        selection: 'all',
        origin: 'caster',
        area: { shape: 'unspecified', size: 3 },
        radiusM: null,
      });
      profile.requiredChoices.push({
        key: 'areaGeometry',
        type: 'shape',
        gm: true,
        reason: 'Core p.110 says 3m area without defining radius or shape.',
      });
      break;
    case 'song-of-the-sky':
      actorArea(profile, 50);
      profile.notes.push(
        'Core p.111 describes weather directly around the caster; Range50m gives its operating extent.'
      );
      profile.modes = ['clear', 'cloudy', 'rainstorm', 'windstorm', 'lightningStorm'];
      if (choices.weather === 'lightningStorm') profile.exclusions = ['caster'];
      break;
    case 'retribution-of-the-raven':
      actorArea(
        profile,
        requireChoice(profile, choices, 'radius', {
          type: 'number',
          min: Number.EPSILON,
          max: 20,
          gm: true,
          reason: 'Tome p.95 prints 20m but does not call it a radius.',
        }) ?? null
      );
      profile.notes.push(
        'Shape/radius require a recorded GM interpretation; do not silently treat the printed range as a radius.'
      );
      profile.roles = [{ role: 'permittedCasters', kind: 'actor', maximum: null, withinArea: true }];
      break;
    case 'curse-of-sedna':
      profile.area = { shape: 'unspecified', size: 4 };
      profile.secondary = [
        {
          targetMode: 'area',
          origin: 'point',
          area: { shape: 'circle', radius: 5 },
          selection: 'all',
          trigger: 'eachRound',
        },
      ];
      profile.requiredChoices.push({
        key: 'areaGeometry',
        type: 'shape',
        gm: true,
        reason: 'The 4m whirlpool is not described as a radius; the 5m Swimming-check zone is separate.',
      });
      break;
    case 'stammelfords-earthquake':
      profile.requiredChoices.push({
        key: 'areaGeometry',
        type: 'shape',
        gm: true,
        reason: 'Core p.105 says a 10m area without radius or shape.',
      });
      break;
    case 'bekkers-rockslide':
      actorTargets(profile, 1);
      profile.secondary = [
        {
          targetMode: 'area',
          origin: 'target',
          area: { shape: 'circle', radius: 6 },
          selection: 'all',
          trigger: 'impact',
          save: { skill: 'athletics', dc: 16 },
        },
      ];
      profile.notes.push(
        'The primary boulder attacks one target with Reposition defense; fragments have their own 6m radius and Athletics DC16.'
      );
      break;
    case 'dust-coating':
      profile.secondary = [
        {
          targetMode: 'actor',
          maximum: 1,
          withinArea: true,
          selection: 'chosen',
          purpose: 'maintainedDustCoating',
        },
      ];
      break;
    case 'flaming-vortex':
      Object.assign(profile, {
        targetMode: 'point',
        minTargets: 0,
        maxTargets: 0,
        selection: 'none',
        origin: 'point',
        radiusM: 1,
        area: { shape: 'circle', radius: 1 },
        rangeM: 10,
      });
      profile.secondary = [
        {
          targetMode: 'area',
          origin: 'movingVortex',
          area: { shape: 'circle', radius: 1 },
          selection: 'all',
          trigger: 'crossTarget',
        },
      ];
      break;
    case 'part-water':
      profile.notes.push(
        'The channel can be at most 10m by100m by10m in any orientation; Range10m Radius is separate from that channel geometry.'
      );
      profile.includeCaster = true;
      break;
    case 'hand-of-the-tempest': {
      const mode = requireChoice(profile, choices, 'mode', {
        type: 'enum',
        options: ['launch', 'gust', 'manipulate'],
      });
      if (mode === 'launch') actorTargets(profile, 1, { acceptsObject: true, maximumWeightKg: 1000 });
      if (mode === 'manipulate')
        Object.assign(profile, {
          targetMode: 'object',
          minTargets: 0,
          maxTargets: 0,
          selection: 'none',
          maximumWeightKg: 1000,
        });
      if (mode === 'gust') {
        Object.assign(profile, {
          targetMode: 'area',
          minTargets: 0,
          maxTargets: null,
          selection: 'all',
          origin: 'caster',
          area: {
            shape: 'cone',
            distance: 14,
            angle:
              requireChoice(profile, choices, 'coneAngle', { type: 'number', min: 1, max: 360, gm: true }) ??
              null,
          },
        });
      }
      break;
    }
    case 'web-of-roots':
      Object.assign(profile, {
        targetMode: 'object',
        minTargets: 0,
        maxTargets: 0,
        selection: 'none',
        eligibility: ['tree'],
      });
      profile.secondary = [
        {
          targetMode: 'actor',
          maximum: 1,
          origin: 'tree',
          rangeM: 10,
          trigger: 'maintainedRound',
          selection: 'chosen',
        },
      ];
      break;
    case 'wrath-of-nature': {
      // The 60m circle is a command area, not 60m of simultaneous attack damage.
      Object.assign(profile, {
        targetMode: 'self',
        actorSelf: true,
        minTargets: 1,
        maxTargets: 1,
        selection: 'one',
        origin: 'caster',
        commandArea: { shape: 'circle', radius: 60 },
        area: { shape: 'none' },
        radiusM: null,
      });
      const terrain = requireChoice(profile, choices, 'terrain', {
        type: 'enum',
        options: ['fields', 'mountains', 'underground', 'forest', 'swamp', 'shore', 'desert', 'tundra'],
      });
      const commands = {
        fields: {
          targetMode: 'point',
          creationRangeM: 10,
          movementM: 10,
          area: { shape: 'rectangle', width: 4, height: 4, verticalHeight: 4 },
          selection: 'allIntersected',
          origin: 'movingTornado',
        },
        mountains: { targetMode: 'actor', maximum: 1 },
        underground: { targetMode: 'actor', maximum: 1 },
        forest: { targetMode: 'point', laterCommandEachRootGroup: true, reach: 'longReach' },
        swamp: { targetMode: 'area', selection: 'all', area: { shape: 'circle', radius: 6 } },
        shore: {
          targetMode: 'actors',
          maximum: 2,
          minimum: 1,
          rangeM: 20,
          origin: 'waterspout',
          projectiles: 2,
          requiresWaterSource: true,
        },
        desert: { targetMode: 'area', selection: 'all', area: { shape: 'circle', radius: 6 } },
        tundra: { targetMode: 'actor', maximum: 1 },
      };
      profile.secondary = terrain ? [{ ...commands[terrain], trigger: 'fullRoundAction' }] : [];
      break;
    }
    case 'freyas-bravery':
      profile.selection = 'chosen';
      profile.notes.push(
        'Only selected creatures receive the benefit; leaving starts a separate 1d6-round grace period.'
      );
      break;
    case 'winds-of-the-taiga':
      profile.roles = [
        {
          role: 'chosenAllies',
          kind: 'actor',
          maximum: null,
          withinArea: true,
          result: 'exemptFromStormAndGainFreezingChance',
        },
      ];
      break;
    case 'sanctuary-of-the-black-grove':
      profile.selection = 'chosen';
      profile.roles = [{ role: 'linkedAllies', kind: 'actor', maximum: null, withinArea: true }];
      break;
    case 'druidic-totem':
      profile.observation = { radiusM: 1609.344, origin: 'totem', beneficiary: 'caster' };
      profile.maximumActiveObjects = 1;
      break;
    case 'well-of-knowledge':
      profile.secondary = [
        {
          targetMode: 'actor',
          maximum: 1,
          trigger: 'drink',
          charges: 20,
          beneficiaryCooldownSeconds: 604800,
        },
      ];
      break;
    case 'feast-of-plenty':
      profile.secondary = [
        {
          targetMode: 'actors',
          maximum: choices.servings ?? null,
          trigger: 'eatFeast',
          selection: 'actualEaters',
        },
      ];
      profile.roles = [{ role: 'feast', kind: 'object', maximum: 1, rangeM: 2 }];
      profile.requiredChoices.push(
        ...(Number.isInteger(choices.servings) && choices.servings >= 20
          ? []
          : [{ key: 'servings', type: 'number', min: 20, integer: true }])
      );
      break;
    case 'standing-portal':
    case 'divine-portal':
      profile.roles = [
        { role: 'entrance', kind: 'point', rangeM: 10 },
        { role: 'destination', kind: 'point', rangeM: null, rememberedOrBlindTeleportProcedure: true },
      ];
      profile.secondary = [
        {
          targetMode: 'area',
          area: { shape: 'rectangle', width: 1, height: 2 },
          selection: 'crossingEntities',
          mustFit: true,
        },
      ];
      break;
    case 'teleportation':
      profile.actorSelf = true;
      profile.roles = [
        { role: 'destination', kind: 'point', rangeM: null, rememberedOrBlindTeleportProcedure: true },
      ];
      profile.exclusions = ['passengers'];
      break;
    case 'javeds-swarm':
    case 'ball-lightning':
      profile.secondary = [{ targetMode: 'actor', maximum: 1, trigger: 'summonedAttack' }];
      profile.roles = [{ role: 'creationPoint', kind: 'point', rangeM: profile.rangeM }];
      profile.targetMode = 'point';
      profile.minTargets = 0;
      profile.maxTargets = 0;
      profile.selection = 'none';
      break;
    case 'smiths-touch':
      selfTarget(profile);
      profile.secondary = [
        {
          targetMode: 'object',
          maximum: 1,
          rangeM: 2,
          trigger: 'brawlingAttack',
          eligibility: 'metalEquipmentExceptDimeritium',
        },
      ];
      break;
  }
  if (profile.actorSelf) profile.origin = 'caster';
  if (profile.requiredChoices.some((choice) => choice.key === 'areaGeometry') && choices.areaGeometry) {
    const geometry = choices.areaGeometry;
    if (!['circle', 'rectangle', 'cone'].includes(geometry.shape))
      throw new RuleError('Choose a supported actual area shape for the recorded GM ruling.');
    const dimensions =
      geometry.shape === 'circle'
        ? [geometry.radius]
        : geometry.shape === 'rectangle'
          ? [geometry.width, geometry.height]
          : [geometry.distance, geometry.angle];
    if (dimensions.some((dimension) => !Number.isFinite(dimension) || dimension <= 0))
      throw new RuleError('The GM area ruling must include positive dimensions.');
    profile.area = copy(geometry);
    profile.radiusM = geometry.shape === 'circle' ? geometry.radius : null;
    profile.requiredChoices = profile.requiredChoices.filter((choice) => choice.key !== 'areaGeometry');
    profile.notes.push('This geometry is a recorded table ruling, not a printed shape specification.');
  }
  return profile;
}

export function magicTargetingProfiles(context = {}) {
  return MAGIC.filter((magic) => ['spell', 'invocation'].includes(magic.kind)).map((magic) =>
    magicTargetingProfile(magic.key, context)
  );
}

/** Validate counts only; actual distance/geometry and eligibility belong to authoritative scene checks. */
export function validateMagicTargetCount(profile, targets) {
  if (profile.requiredChoices.length)
    throw new RuleError(
      `Resolve targeting choices: ${profile.requiredChoices.map((entry) => entry.key).join(', ')}.`
    );
  const ids = targets.map((target) => (typeof target === 'string' ? target : (target.uuid ?? target.id)));
  if (ids.some((id) => !id) || new Set(ids).size !== ids.length)
    throw new RuleError('Select distinct actual targets; projectile allocation is a separate step.');
  if (ids.length < profile.minTargets || (profile.maxTargets !== null && ids.length > profile.maxTargets))
    throw new RuleError(
      `${profile.key} requires ${profile.minTargets}${profile.maxTargets === profile.minTargets ? '' : ` to ${profile.maxTargets ?? 'all eligible'}`} target(s).`
    );
  return true;
}
