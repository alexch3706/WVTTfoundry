/** Printed Tome creature data for actual ritual-created Actors. Special ability cards
 * distinguish their GM procedures from the existing automatic damage/condition rules. */
import { HUMANOID_LOCATIONS, MONSTER_LOCATIONS, SKILLS, SYSTEM_ID } from './config.js';
import { RuleError } from './rules.js';

const SOURCE = 'A Tome of Chaos v1.01';
const copy = (value) => structuredClone(value);
const source = (value) => (value?.toObject ? value.toObject() : copy(value?._source ?? value));
const escape = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  );
export const MAGIC_CREATURE_PROFILES = Object.freeze(['living-armor', 'corpse-amalgam']);
const weaponSkills = [
  'brawling',
  'melee',
  'smallBlades',
  'staffSpear',
  'swordsmanship',
  'archery',
  'crossbow',
];

function ability(
  name,
  text,
  page,
  { automation = 'gm', key = name.toLowerCase().replace(/[^a-z]/g, ''), category = 'ability' } = {}
) {
  return {
    name,
    type: 'ability',
    img: 'icons/svg/book.svg',
    system: {
      quantity: 1,
      weight: 0,
      carried: false,
      source: SOURCE,
      page,
      category,
      effectText: text,
      description: `<p>${escape(text)}</p><p>${automation === 'gm' ? 'GM procedure: resolve this ability using the printed instructions on this card.' : 'The relevant numeric profile, immunity, damage or recovery rules are included in this Actor.'}</p>`,
      ability: { key, mode: 'passive' },
    },
    flags: { [SYSTEM_ID]: { creatureProcedure: { key, automation } } },
  };
}
function fist({ name, damage, reliability, page, crushing = false }) {
  return {
    name,
    type: 'weapon',
    img: 'icons/svg/sword.svg',
    system: {
      quantity: 1,
      weight: 0,
      cost: 0,
      carried: false,
      equipped: true,
      source: SOURCE,
      page,
      damage,
      damageTypes: ['bludgeoning'],
      category: 'natural',
      skill: 'brawling',
      stat: 'ref',
      accuracy: 0,
      hands: 0,
      range: crushing ? 2 : 0,
      rof: 2,
      reliability,
      maxReliability: reliability,
      properties: {
        natural: true,
        fixedDamage: true,
        ...(crushing ? { longReach: true, cannotParry: true, wearMultiplier: 2 } : {}),
      },
      effectText: crushing ? 'Long Reach; Crushing Force' : '',
      description: `<p>${crushing ? 'Long Reach; cannot be parried; double ablation from Crushing Force.' : 'Complete printed fist damage; do not add BODY damage again.'}</p>`,
    },
  };
}
function profile({
  key,
  name,
  page,
  stats,
  bases,
  hp,
  sta,
  stun,
  rec,
  enc,
  run,
  leap,
  category,
  locations,
  traits,
  immunities,
  resistances = [],
  defenses,
}) {
  const feralInt = 7;
  const skills = Object.fromEntries(
    Object.entries(bases).map(([skill, base]) => [
      skill,
      base - (['awareness', 'wildernessSurvival'].includes(skill) ? feralInt : stats[SKILLS[skill][1]]),
    ])
  );
  if (Object.values(skills).some((rank) => !Number.isFinite(rank) || rank < 0))
    throw new Error('Invalid printed creature skill base.');
  return {
    name,
    type: 'monster',
    img: key === 'living-armor' ? 'icons/svg/shield.svg' : 'icons/svg/skull.svg',
    prototypeToken: {
      name,
      actorLink: false,
      bar1: { attribute: 'hp' },
      bar2: { attribute: sta === null ? null : 'sta' },
      sight: { angle: 360 },
      texture: { src: key === 'living-armor' ? 'icons/svg/shield.svg' : 'icons/svg/skull.svg' },
    },
    system: {
      source: SOURCE,
      page,
      category,
      race: 'other',
      stats: { ...stats, luck: 0 },
      skills,
      hp: { value: hp, max: hp },
      sta: { value: sta ?? 0, max: sta ?? 0 },
      luck: { value: 0, max: 0 },
      vigor: 0,
      overrides: { hp, sta: sta ?? 0, stun: stun ?? 0, rec, enc, run, leap },
      anatomy: 'custom',
      locations: copy(locations),
      organless: true,
      silverVulnerable: true,
      naturalResistances: [...resistances],
      immunities: [...immunities],
      traits: { feralInt, unreasoning: true, ...traits },
      effects: [],
      conditions: [],
      customSkills: [],
      bestiary: {
        species: key,
        intelligence: 'Feral',
        printedSkills: copy(bases),
        printedDefenses: copy(defenses),
        published: { hp, sta, stun, rec, enc, run, leap },
        procedureSourcePages: [page, page + 1],
      },
      biography: `<p>${SOURCE}, pp.${page}–${page + 1}. Created by a ritual and loyal to its creator. Special ability cards identify GM procedures that have no automated command.</p>`,
    },
    items: [],
    effects: [],
    flags: { [SYSTEM_ID]: { magicCreature: { profile: key, source: SOURCE, pages: [page, page + 1] } } },
  };
}

/** Three actual component sources; their worn Item SP is the sole armor source. */
export function livingArmorComponents(items) {
  if (!Array.isArray(items) || items.length !== 3)
    throw new RuleError('Animate Armor requires the actual head, torso and leg armor items.');
  const armor = items.map(source);
  if (armor.some((item) => item.type !== 'armor' || !Array.isArray(item.system?.coverage)))
    throw new RuleError('Every animated armor component must be an actual armor Item.');
  const required = ['head', 'torso', 'rightArm', 'leftArm', 'rightLeg', 'leftLeg'];
  for (const location of required) {
    const layers = armor.filter((item) => item.system.coverage.includes(location));
    if (layers.length !== 1) throw new RuleError(`The armor suit must cover ${location} exactly once.`);
    const item = layers[0],
      value = item.system.sp?.[location] ?? item.system.stoppingPower;
    if (!Number.isFinite(value) || value < 0)
      throw new RuleError('The animated armor must have actual current SP for every location.');
  }
  return armor.map((item) => {
    const result = copy(item);
    delete result._id;
    delete result._stats;
    delete result.folder;
    result.system.quantity = 1;
    result.system.equipped = true;
    result.system.carried = true;
    result.system.properties = { ...result.system.properties, restrictedVision: false };
    result.flags = {
      ...result.flags,
      [SYSTEM_ID]: { ...result.flags?.[SYSTEM_ID], animatedArmorBody: true },
    };
    return result;
  });
}

export function magicCreatureProfile(key, { armorItems } = {}) {
  if (key === 'living-armor') {
    const stats = { int: 1, ref: 8, dex: 6, body: 8, spd: 4, emp: 1, cra: 1, will: 4 };
    const data = profile({
      key,
      name: 'Living Armor',
      page: 204,
      stats,
      bases: {
        awareness: 14,
        wildernessSurvival: 13,
        brawling: 16,
        athletics: 10,
        stealth: 10,
        physique: 16,
        intimidation: 10,
        resistMagic: 14,
        dodge: 12,
        ...Object.fromEntries(weaponSkills.map((skill) => [skill, 16])),
      },
      hp: 60,
      sta: null,
      stun: null,
      rec: 6,
      enc: 80,
      run: 12,
      leap: 2,
      category: 'elementa',
      locations: HUMANOID_LOCATIONS,
      traits: { nightVision: true, infiniteStamina: true, mindless: true },
      immunities: ['poison', 'bleeding', 'charm', 'fear', 'stunned', 'coercion'],
      defenses: { dodge: 12, reposition: 10, block: 16 },
    });
    data.items = [
      ...livingArmorComponents(armorItems),
      fist({ name: 'Fist', damage: '1d6+2', reliability: 15, page: 205 }),
      ability(
        'Living Armor',
        'The three body armor items provide location SP and their printed resistances. Repair their SP as normal armor; HP recovery does not repair SP. Additional armor cannot be worn. Restricted Vision is ignored. A limb with zero SP is severed and unusable.',
        205
      ),
      ability(
        'Golem Heart',
        'After torso armor reaches zero SP, the next torso hit strikes the exposed heart and sets HP to zero. The heart cannot be aimed at before the torso armor is destroyed.',
        205,
        { category: 'vulnerability' }
      ),
      ability(
        'Weapon Master',
        'Weapon skill bases are 16. Weapons wielded in one hand have ROF 2; weapons wielded in two hands have ROF 1. The ordinary Athletics base remains 10; apply base 16 only when it is used as a weapon attack skill.',
        205
      ),
      ability(
        'Overreach',
        'On its own turn, the armor may sacrifice 10 HP to make one additional attack with its wielded weapon. If this brings HP to zero or less, it dies after that attack.',
        205
      ),
      ability(
        'Dimeritium Bomb',
        'In a dimeritium bomb area, all rolls take −2 and Overreach is unavailable. The bomb does not remove the animation.',
        205,
        { category: 'vulnerability' }
      ),
    ];
    data.system.bestiary.printedArmor = 'actual animated armor components';
    return data;
  }
  if (key === 'corpse-amalgam') {
    const data = profile({
      key,
      name: 'Corpse Amalgam',
      page: 200,
      stats: { int: 1, ref: 8, dex: 6, body: 12, spd: 6, emp: 1, cra: 1, will: 8 },
      bases: {
        awareness: 10,
        wildernessSurvival: 7,
        brawling: 16,
        athletics: 11,
        stealth: 10,
        physique: 20,
        endurance: 17,
        intimidation: 16,
        resistMagic: 17,
        dodge: 12,
      },
      hp: 100,
      sta: 50,
      stun: 10,
      rec: 10,
      enc: 120,
      run: 18,
      leap: 4,
      category: 'specter',
      locations: MONSTER_LOCATIONS.map((location) => ({
        ...location,
        multiplier: Math.min(1, location.multiplier),
      })),
      traits: { crushingForce: true },
      immunities: ['poison', 'bleeding', 'charm', 'prone', 'fear', 'stunned', 'coercion'],
      resistances: ['bludgeoning', 'piercing'],
      defenses: { dodge: 12, reposition: 13, block: 16 },
    });
    data.system.effects.push({
      id: 'corpse-amalgam-truly-undead',
      key: 'Truly Undead',
      modifiers: {},
      conditions: [],
      expires: 0,
      magic: {
        innateCreature: true,
        operation: { type: 'modifier', rule: { key: 'preventHPRecovery', natural: true, magical: true } },
      },
      notes: 'Tome p.201: cannot regain HP through natural healing, spells or healing items.',
    });
    data.items = [
      fist({ name: 'Fists', damage: '5d6', reliability: 10, page: 201, crushing: true }),
      ability(
        'Truly Undead',
        'HP cannot be restored by ordinary recovery, healing magic or healing items.',
        201,
        { automation: 'profile' }
      ),
      ability(
        'Amalgamated Form',
        'An anatomical hit that would multiply damage instead deals normal damage; locations with a reduced multiplier keep that reduction.',
        201,
        { automation: 'profile' }
      ),
      ability(
        'Bound Spirits',
        'A critical wound instead removes one bound corpse: the normal hit damage applies, then 10 additional damage, and a hostile Wraith appears. It fights with the amalgam and follows the necromancer. Do not also apply an ordinary critical injury.',
        201
      ),
      ability(
        'Temporary Sapience',
        'Without an action, roll 1d10 and reroll a 1. INT and CRA become that result for 10 rounds and the amalgam becomes sapient while remaining controlled. For an unpossessed skill used during this interval, roll 1d6 to determine its value.',
        201
      ),
      ability(
        '360 Degree Vision',
        'The creature sees in all directions; its vision cone is 360 degrees.',
        201,
        { automation: 'profile' }
      ),
      ability(
        'Horrid Wail',
        'Use one action. Every living creature within 10 m attempts Resist Magic against DC 16; a failed check causes Staggered.',
        201
      ),
      ability(
        'Dimeritium Bomb',
        'The bestiary lists a susceptibility to dimeritium bombs but prints no specific replacement consequence. The GM must adjudicate its effect.',
        200,
        { category: 'vulnerability' }
      ),
    ];
    data.system.bestiary.printedArmor = 0;
    return data;
  }
  throw new RuleError('This ritual creature has no audited printed profile.');
}

/** Add to a defense only, before situational/armor modifiers; do not change ordinary Athletics. */
export function magicCreatureDefenseAdjustment(state, kind) {
  if (state.bestiary?.species === 'corpse-amalgam' && ['reposition', 'athletics'].includes(kind)) return 2;
  return 0;
}
