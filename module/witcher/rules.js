import { HUMANOID_LOCATIONS, MONSTER_LOCATIONS, STATS } from './config.js';
import { combinedModifiers } from './wounds.js';
import { heatFactor } from './advanced-rules.js';
import { immuneTo, isIncorporeal, suppressed } from './monster-rules.js';

export class RuleError extends Error {}
const n = (v, fallback = 0) => (Number.isFinite(Number(v)) ? Number(v) : fallback);
export const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

/** Printed pp.57,156: a fumble discards the initial one and subtracts the continuation. */
export function resolveCheck(base, dice) {
  if (
    !Number.isFinite(base) ||
    !Array.isArray(dice) ||
    !dice.length ||
    dice.some((d) => !Number.isInteger(d) || d < 1 || d > 10)
  )
    throw new RuleError('Invalid d10 check');
  const first = dice[0];
  const continued = first === 1 || first === 10;
  if (continued && (dice.length < 2 || dice.at(-1) === 10 || dice.slice(1, -1).some((d) => d !== 10)))
    throw new RuleError('Incomplete exploding die sequence');
  if (!continued && dice.length !== 1) throw new RuleError('Unexpected continuation');
  const continuation = dice.slice(1).reduce((a, b) => a + b, 0);
  const contribution = first === 1 ? -continuation : dice.reduce((a, b) => a + b, 0);
  return {
    base,
    dice: [...dice],
    contribution,
    total: Math.max(0, base + contribution),
    fumble: first === 1 ? continuation : 0,
    critical: first === 10,
  };
}

/** Physical d10 results, including every continuation required by Core p.57. */
export function parseManualCheck(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') throw new RuleError('Manual d10 must be a comma-separated list of dice.');
  const text = value.trim();
  if (!text) return null;
  const parts = text.split(',').map((part) => part.trim());
  if (parts.some((part) => !/^(?:[1-9]|10)$/.test(part)))
    throw new RuleError('Enter whole d10 values from 1 to 10, separated by commas (for example 10,6).');
  const dice = parts.map(Number);
  if ([1, 10].includes(dice[0])) {
    if (dice.length < 2 || dice.at(-1) === 10)
      throw new RuleError('Add the next d10 after the initial 1 or 10 and after every further 10.');
    if (dice.slice(1, -1).some((die) => die !== 10))
      throw new RuleError('The chain ends at the first follow-up die below 10. Remove the extra dice.');
  } else if (dice.length !== 1) throw new RuleError('An initial d10 from 2 to 9 has no follow-up dice.');
  return dice;
}
export const beats = (roll, difficulty) => n(roll) > n(difficulty);
export function criticalSeverity(margin) {
  for (const [threshold, level, bonus] of [
    [15, 'deadly', 10],
    [13, 'difficult', 8],
    [10, 'complex', 5],
    [7, 'simple', 3],
  ]) {
    if (margin >= threshold) return { level, bonus, margin };
  }
  return null;
}

export function hitLocations(actor = {}) {
  const table =
    actor.anatomy === 'custom'
      ? actor.locations
      : actor.anatomy === 'monster'
        ? MONSTER_LOCATIONS
        : HUMANOID_LOCATIONS;
  if (!table?.length) throw new RuleError('A hit-location table is required');
  return table.map((l) => ({ ...l, ...(actor.locations?.find((x) => x.id === l.id) ?? {}) }));
}
export function validateLocations(table) {
  const ids = new Set();
  for (const l of table) {
    if (!/^[a-zA-Z][a-zA-Z0-9]*$/.test(l.id) || ids.has(l.id))
      throw new RuleError('Locations must have unique identifiers');
    ids.add(l.id);
    if (
      ![l.min, l.max, l.aim, l.multiplier].every(Number.isFinite) ||
      l.min < 1 ||
      l.max > 10 ||
      l.min > l.max ||
      l.multiplier < 0
    )
      throw new RuleError('Invalid hit location');
  }
  for (let roll = 1; roll <= 10; roll++)
    if (table.filter((l) => roll >= l.min && roll <= l.max).length !== 1)
      throw new RuleError(`Hit location roll ${roll} must match exactly one location`);
  return true;
}
export function locate(table, rollOrId) {
  validateLocations(table);
  const weak = typeof rollOrId === 'string' && rollOrId.endsWith(':weak');
  if (weak) rollOrId = rollOrId.slice(0, -5);
  const result = table.find((l) =>
    typeof rollOrId === 'string' ? l.id === rollOrId : rollOrId >= l.min && rollOrId <= l.max
  );
  if (!result) throw new RuleError('The target does not have this hit location');
  if (weak && !result.weakName) throw new RuleError('This location has no listed weak spot.');
  return { ...result, ...(weak ? { weakSpot: true, label: `${result.label}: ${result.weakName}` } : {}) };
}

/** Printed p.155, including the worked 3 + 12 + 20 = 24 example. */
export function armorBonus(difference) {
  difference = Math.abs(difference);
  return difference <= 4 ? 5 : difference <= 8 ? 4 : difference <= 14 ? 3 : difference <= 20 ? 2 : 0;
}
export function stackArmor(layers) {
  const worn = layers.filter((l) => l.kind !== 'natural');
  if (
    worn.length > 3 ||
    worn.filter((l) => l.kind === 'heavy').length > 1 ||
    worn.filter((l) => l.kind === 'medium').length > 1
  )
    throw new RuleError(
      'Maximum three worn armor layers, including at most one medium and one heavy (p.154)'
    );
  const values = layers
    .map((l) => Math.max(0, n(l.sp)))
    .filter((x) => x > 0)
    .sort((a, b) => a - b);
  if (!values.length) return 0;
  return values
    .slice(1)
    .reduce(
      (combined, next) =>
        Math.max(combined, next) + Math.min(Math.min(combined, next), armorBonus(combined - next)),
      values[0]
    );
}
export function armorAt(items, location) {
  return items
    .filter((i) => i.type === 'armor' && i.equipped && i.coverage?.includes(location.id))
    .map((i) => ({
      id: i.id,
      kind: i.armorClass,
      sp: n(i.sp?.[location.id] ?? i.stoppingPower),
      resistances: i.resistances ?? [],
    }));
}
export function armorEncumbrance(items) {
  const worn = items.filter((i) => (i.type === 'armor' || i.type === 'shield') && i.equipped);
  const locations = new Set(worn.flatMap((i) => i.coverage ?? []));
  let layering = 0;
  for (const loc of locations) {
    const layers = worn.filter((i) => i.type === 'armor' && i.coverage?.includes(loc));
    stackArmor(layers.map((i) => ({ kind: i.armorClass, sp: i.stoppingPower })));
    if (layers.length > 1)
      layering = Math.max(
        layering,
        layers.reduce((v, l) => v + (l.armorClass === 'medium' ? 1 : l.armorClass === 'heavy' ? 2 : 0), 0)
      );
  }
  return worn.reduce((sum, i) => sum + n(i.ev), 0) + layering;
}

/** A pure result: the caller persists planned changes once, after GM confirmation. */
export function resolveDamage(
  {
    raw,
    silver = 0,
    type = 'slashing',
    properties = {},
    multiplier = 1,
    nonlethal = false,
    cover = 0,
    criticalBonus = 0,
  },
  target,
  location,
  items = []
) {
  if (![raw, silver, multiplier, cover, criticalBonus].every(Number.isFinite) || raw < 0 || silver < 0)
    throw new RuleError('Invalid damage values');
  const layers = armorAt(items, location);
  const natural = {
    kind: 'natural',
    id: location.id,
    sp: Math.max(0, n(location.weakSpot ? location.weakSp : location.sp)),
    resistances: location.weakSpot ? [] : (target.naturalResistances ?? []),
  };
  const worn = properties.bypassArmor ? 0 : stackArmor(layers);
  // Natural armor is a separate inherent protection; it does not consume a clothing layer.
  const originalSp = (properties.bypassArmor ? 0 : natural.sp + (target.race === 'dwarf' ? 2 : 0)) + worn;
  const sp = properties.improvedArmorPiercing ? Math.ceil(originalSp / 2) : originalSp;
  const isSilverTarget = target.silverVulnerable === true;
  const rolled = Math.max(0, (raw + (isSilverTarget ? silver : 0)) * multiplier);
  const afterCover = Math.max(0, rolled - Math.max(0, cover));
  const afterArmor = Math.max(0, afterCover - sp);
  let resisted = afterArmor;
  const armorResistant = [...layers.flatMap((l) => l.resistances), ...natural.resistances].includes(type);
  // p.154: repeated resistance to the same damage type does not stack. The
  // separate non-silver monster resistance (p.162) still halves damage again.
  const resistedByArmor =
    armorResistant &&
    !properties.armorPiercing &&
    !properties.improvedArmorPiercing &&
    !properties.bypassArmor;
  if (resistedByArmor || target.resistances?.includes(type)) resisted /= 2;
  const immune = immuneTo(target, type) || (nonlethal && target.traits?.infiniteStamina);
  if (immune) resisted = 0;
  else {
    if (
      isSilverTarget &&
      !properties.silver &&
      type !== 'fire' &&
      !(properties.meteorite && target.meteoriteVulnerable)
    )
      resisted /= 2;
    if (target.vulnerabilities?.includes(type)) resisted *= 2;
  }
  const mods = combinedModifiers(target, items);
  const locationMultiplier =
    (location.group === 'head' || /head/i.test(location.id)) && mods.headMultiplier
      ? Math.max(location.multiplier, mods.headMultiplier)
      : location.multiplier;
  const localized = Math.max(0, Math.floor(resisted * locationMultiplier));
  // A critical's separate bonus can bypass intact armor, but cannot itself
  // trigger staged penetration. The wearer must take damage through the armor.
  const penetrated = afterArmor > 0 && localized > 0 && !immune;
  const wear =
    properties.bypassArmor || isIncorporeal(target)
      ? 0
      : properties.fixedAblation !== undefined
        ? n(properties.fixedAblation)
        : ((penetrated ? 1 + n(properties.ablation) : 0) + n(properties.alwaysAblate)) *
          n(properties.wearMultiplier, 1);
  return {
    location: { ...location, multiplier: locationMultiplier },
    raw,
    silver: isSilverTarget ? silver : 0,
    multiplier,
    rolled,
    cover,
    afterCover,
    sp,
    afterArmor,
    resisted,
    localized,
    immune,
    criticalBonus: immune ? 0 : criticalBonus,
    damage: immune ? 0 : localized + criticalBonus,
    nonlethal,
    armorChanges: layers
      .map((l) => ({ id: l.id, location: location.id, before: l.sp, after: Math.max(0, l.sp - wear) }))
      .filter((l) => l.before !== l.after),
    naturalChange: {
      location: location.id,
      field: location.weakSpot ? 'weakSp' : 'sp',
      before: natural.sp,
      after: Math.max(0, natural.sp - wear),
    },
    penetrated,
    clearsStun: !immune && localized + criticalBonus > 0,
  };
}

export function meleeBonus(body) {
  return body <= 2
    ? -4
    : body <= 4
      ? -2
      : body <= 6
        ? 0
        : body <= 8
          ? 2
          : body <= 10
            ? 4
            : body <= 12
              ? 6
              : 8;
}
export function derivedStats(actor, items = []) {
  const mods = combinedModifiers(actor, items);
  const base = Object.fromEntries(
    STATS.map((k) => [k, Math.max(k === 'luck' ? 0 : 1, n(actor.stats?.[k], 5))])
  );
  for (const effect of actor.effects ?? [])
    if (effect.mutagen)
      for (const key of STATS) {
        const bonus = n(effect.modifiers?.[key]);
        base[key] += bonus;
        mods[key] = n(mods[key]) - bonus;
      }
  if (actor.race === 'witcher') {
    base.ref += 1;
    base.dex += 1;
    base.emp = Math.max(1, base.emp - 4);
  }
  if (
    actor.traits?.landStats &&
    !actor.environment?.underwater &&
    !actor.effects?.some((e) => e.key === 'Flight')
  )
    for (const k of ['ref', 'dex', 'spd']) base[k] = actor.traits.landStats;
  if (actor.effects?.some((e) => e.key === 'Flight') && actor.traits?.flightSpeed)
    base.spd = actor.traits.flightSpeed;
  if (actor.environment?.light === 'moonlight')
    mods.allActions = n(mods.allActions) + n(actor.traits?.moonlightPenalty);
  if (actor.category === 'elementa' && suppressed(actor, 'Dimeritium'))
    for (const k of STATS) mods[k] = n(mods[k]) - 2;
  const physical = Math.floor((base.body + base.will) / 2);
  const hpMax = (n(actor.overrides?.hp) || physical * 5) + n(mods.hp);
  const staMax = actor.traits?.infiniteStamina
    ? 0
    : Math.floor(
        ((n(actor.overrides?.sta) || physical * 5) + n(mods.sta)) *
          n(mods.staMultiplier, 1) *
          (actor.environment?.heat ? heatFactor(items) : 1)
      );
  const enc = Math.max(
    0,
    ((n(actor.overrides?.enc) || base.body * 10 + (actor.race === 'dwarf' ? 25 : 0)) + n(mods.enc)) *
      n(mods.encMultiplier, 1)
  );
  const weight =
    items
      .filter((i) => i.carried !== false)
      .reduce((sum, i) => sum + n(i.weight) * Math.max(0, n(i.quantity, 1)), 0) +
    Math.max(0, n(actor.coins)) * 0.001;
  const overweight = Math.max(0, Math.floor((weight - enc) / 5));
  const ev = Math.max(0, armorEncumbrance(items) - n(actor.ignoredEV));
  const conditions = new Set(actor.conditions ?? []);
  const wound = actor.hp?.value < hpMax / 5;
  const dying = actor.hp?.value <= 0;
  const current = { ...base };
  for (const key of STATS) {
    let modifier = n(mods[key]);
    if (['ref', 'dex', 'spd'].includes(key)) modifier -= overweight;
    if (['ref', 'dex'].includes(key)) modifier -= ev;
    if (conditions.has('frozen')) modifier -= key === 'spd' ? 3 : key === 'ref' ? 1 : 0;
    if (conditions.has('intoxicated') && ['ref', 'dex', 'int'].includes(key)) modifier -= 2;
    current[key] = Math.max(
      key === 'luck' ? 0 : 1,
      Math.floor(
        ((base[key] + modifier) * n(mods[key + 'Multiplier'], 1)) /
          (dying ? 3 : wound && ['ref', 'dex', 'int', 'will'].includes(key) ? 2 : 1)
      )
    );
  }
  return {
    base,
    stats: current,
    mods,
    hpMax,
    staMax,
    stun: Math.max(
      1,
      Math.floor(((n(actor.overrides?.stun) || Math.min(10, physical)) + n(mods.stun)) / (dying ? 3 : 1))
    ),
    deathTarget: n(actor.overrides?.stun) || Math.min(10, physical),
    rec: Math.max(
      1,
      Math.floor(
        (((n(actor.overrides?.rec) || physical) + n(mods.rec)) * n(mods.recMultiplier, 1)) / (dying ? 3 : 1)
      )
    ),
    enc,
    weight,
    overweight,
    ev,
    wound,
    dying,
    run: actor.effects?.some((e) => e.key === 'Flight')
      ? current.spd * 3
      : n(actor.overrides?.run)
        ? (actor.overrides.run * current.spd) / actor.stats.spd
        : current.spd * 3,
    leap: Math.floor(
      actor.effects?.some((e) => e.key === 'Flight')
        ? (current.spd * 3) / 5
        : n(actor.overrides?.leap)
          ? (actor.overrides.leap * current.spd) / actor.stats.spd
          : (current.spd * 3) / 5
    ),
    meleeBonus: (n(actor.overrides?.meleeBonus) || meleeBonus(current.body)) + n(mods.meleeBonus),
    punch: `1d6${meleeBonus(current.body) >= 0 ? '+' : ''}${meleeBonus(current.body)}`,
    kick: `1d6+${4 + meleeBonus(current.body)}`,
    woundThreshold: Math.floor(hpMax / 5),
  };
}

export function rangeBracket(distance, range) {
  if (!Number.isFinite(distance) || distance < 0 || !Number.isFinite(range) || range <= 0)
    throw new RuleError('A measured distance and positive weapon range are required');
  if (distance <= 0.5) return { name: 'Point blank', dc: 10, modifier: 5 };
  for (const [factor, name, dc, modifier] of [
    [0.25, 'Close', 15, 0],
    [0.5, 'Medium', 20, -2],
    [1, 'Long', 25, -4],
    [2, 'Extreme', 30, -6],
  ])
    if (distance <= range * factor) return { name, dc, modifier };
  throw new RuleError('Target is beyond twice the listed range');
}
export function strikeProfile(
  weapon,
  { style = 'fast', action = 'normal', npc = false, underwater = false } = {}
) {
  if (!['normal', 'fast', 'strong'].includes(style)) throw new RuleError('Unknown strike style.');
  if (npc && style !== 'normal')
    throw new RuleError('Minor NPCs/monsters use weapon ROF, not fast/strong strikes (p.153)');
  if (weapon.category === 'crossbow' && style !== 'normal')
    throw new RuleError('Crossbows do not use fast or strong strikes');
  if (['bomb', 'trap', 'naturalRanged'].includes(weapon.category) && style !== 'normal')
    throw new RuleError('This attack does not use fast or strong strikes.');
  if (!['normal', 'punch', 'kick'].includes(action))
    return {
      attacks: action === 'joint' ? 2 : 1,
      modifier: action === 'joint' || action === 'charge' ? -3 : 0,
      multiplier: action === 'charge' ? 2 : action === 'pommel' || action === 'pushKick' ? 0.5 : 1,
    };
  if (npc) {
    const rof = n(weapon.rof, 1);
    if (!Number.isInteger(rof) || rof < 1)
      throw new RuleError('A creature attack needs a positive whole ROF.');
    const melee = !['bow', 'crossbow', 'thrown', 'bomb', 'trap', 'naturalRanged'].includes(weapon.category);
    return { attacks: underwater && melee ? 1 : rof, modifier: 0, multiplier: 1 };
  }
  return {
    attacks:
      style === 'fast' && !['bow', 'crossbow', 'bomb', 'trap'].includes(weapon.category) && !underwater
        ? 2
        : 1,
    modifier: style === 'strong' ? -3 : 0,
    multiplier: style === 'strong' ? 2 : 1,
  };
}
export function defenseModifier(type, attackCategory) {
  if (type === 'parry' && ['bow', 'crossbow'].includes(attackCategory))
    throw new RuleError('Bow and crossbow projectiles cannot be parried (p.164)');
  if (
    ['blockWeapon', 'blockArm'].includes(type) &&
    ['bow', 'crossbow', 'thrown', 'bomb', 'naturalRanged'].includes(attackCategory)
  )
    throw new RuleError('Only a shield can block a ranged attack (p.164)');
  return type === 'parry' ? (['thrown', 'bomb'].includes(attackCategory) ? -5 : -3) : 0;
}
export function reserveAction(
  budget,
  { extra = false, full = false, strikes = 1, defense = false, activelyDodging = false } = {}
) {
  const next = {
    actions: n(budget.actions),
    extra: n(budget.extra),
    defenses: n(budget.defenses),
    full: !!budget.full,
  };
  if (defense) {
    next.defenses++;
    return { budget: next, cost: activelyDodging || next.defenses === 1 ? 0 : 1, modifier: 0 };
  }
  if (next.full) throw new RuleError('The full-round action has used this turn (p.151).');
  if (full && (extra || next.actions || next.extra))
    throw new RuleError('A full-round action requires your entire turn (p.151).');
  if (extra) {
    if (next.extra >= 1) throw new RuleError('Only one extra action per turn (p.151)');
    next.extra++;
    return { budget: next, cost: 3, modifier: -3 };
  }
  if (next.actions >= 1) throw new RuleError('Your normal action is already spent');
  next.actions = 1;
  next.full = full;
  return { budget: next, cost: 0, modifier: 0, full, strikes };
}

/**
 * Reserve one strike, not an entire set of dice. The caller supplies the current
 * turn budget and persists this result together with ammunition and Luck.
 * p.153 and the official Sage's Answers, part 5: a common NPC chooses one attack
 * per round and repeats that attack up to its ROF; paying STA cannot reset ROF.
 * https://rtalsoriangames.com/2018/08/20/the-sages-answers-part-5/
 */
export function attackSequence(budget, weapon, options = {}) {
  const {
    style = 'fast',
    action = 'normal',
    npc = false,
    extra = false,
    full = false,
    forfeit = false,
  } = options;
  const profile = strikeProfile(weapon, options);
  const weaponId = weapon.id ?? weapon._id;
  if (!weaponId) throw new RuleError('An attack needs a stable weapon identifier.');
  const continuing = n(budget.remaining) > 0 && !forfeit;
  if (continuing) {
    if (style !== budget.style || action !== (budget.attackAction || 'normal'))
      throw new RuleError('Finish or forfeit the remaining strikes before changing the attack style.');
    if (npc && weaponId !== (budget.npcWeaponId || budget.weaponId))
      throw new RuleError('A creature repeats one chosen attack up to its ROF (p.153).');
    if (!npc && (profile.attacks < 2 || full))
      throw new RuleError('This weapon cannot make a remaining fast strike.');
    if (npc && n(budget.npcStrikes) >= profile.attacks)
      throw new RuleError('This creature has used its attack ROF for the round.');
    const strikeIndex = n(budget.strikeIndex, 1) + 1;
    return {
      budget: {
        ...budget,
        remaining: n(budget.remaining) - 1,
        weaponId,
        strikeIndex,
        ...(npc ? { npcWeaponId: weaponId, npcStrikes: n(budget.npcStrikes) + 1 } : {}),
      },
      cost: 0,
      modifier: n(budget.extraPenalty),
      profile,
      continuing: true,
      strikeIndex,
    };
  }
  if (npc && (budget.npcWeaponId || n(budget.npcStrikes)))
    throw new RuleError(
      'This creature has already chosen its attack for the round; an extra action cannot reset ROF.'
    );
  const reservation = reserveAction(budget, { extra, full, strikes: profile.attacks });
  return {
    ...reservation,
    budget: {
      ...budget,
      ...reservation.budget,
      remaining: profile.attacks - 1,
      weaponId,
      style,
      attackAction: action,
      extraPenalty: reservation.modifier,
      strikeIndex: 1,
      ...(npc ? { npcWeaponId: weaponId, npcStrikes: 1 } : {}),
    },
    profile,
    continuing: false,
    strikeIndex: 1,
  };
}

/** p.48: BODY applies to melee and thrown weapons; listed natural damage is final. */
export function weaponDamageBonus(weapon, bonus) {
  if (
    weapon.type === 'shield' ||
    weapon.properties?.natural ||
    weapon.properties?.fixedDamage ||
    weapon.properties?.environmental ||
    weapon.properties?.brawling ||
    ['bow', 'crossbow', 'naturalRanged', 'bomb', 'trap'].includes(weapon.category)
  )
    return 0;
  return n(bonus);
}

/** p.72 Brawling effect; p.164 shield attack and p.48 hand-to-hand table. */
export function weaponDamageFormula(weapon, { punch = '1d6', body = 5 } = {}) {
  if (weapon.type === 'shield') {
    const rows = weapon.armorClass === 'heavy' ? 4 : weapon.armorClass === 'medium' ? 2 : 0;
    const bonus = meleeBonus(n(body, 5) + rows * 2);
    return `1d6${bonus >= 0 ? '+' : ''}${bonus}`;
  }
  if (weapon.properties?.brawling) return `(${punch}) + (${weapon.damage})`;
  return weapon.damage;
}

export function shieldStrike(weapon, body) {
  if (weapon.type !== 'shield') throw new RuleError('Choose a shield to make a shield attack.');
  return {
    ...weapon,
    type: 'weapon',
    category: 'bludgeon',
    skill: 'melee',
    stat: 'ref',
    damage: weaponDamageFormula(weapon, { body }),
    damageTypes: ['bludgeoning'],
    properties: { ...weapon.properties, brawling: false, fixedDamage: true, nonlethal: false },
  };
}
export function skillImprovementCost(current, difficult = false) {
  if (!Number.isInteger(current) || current < 0 || current >= 10)
    throw new RuleError('Skill ranks must be 0–9 to improve');
  return Math.max(1, current) * (difficult ? 2 : 1);
}
export function criticalHealingDays(body, severity) {
  return severity === 'deadly'
    ? null
    : Math.max(1, ({ simple: 8, complex: 12, difficult: 15 }[severity] ?? NaN) - body);
}
export function skillHeal(roll, { kind = 'firstAid', rest = true, rec = 0 } = {}) {
  return beats(roll, 14)
    ? Math.max(0, Math.floor((rec + (kind === 'healingHands' ? 3 : 0)) * (rest ? 1 : 0.5)))
    : 0;
}
