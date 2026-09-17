import { SYSTEM_ID } from './config.js';
import { RuleError } from './rules.js';
import { validateMagicPower, magicMaintenance } from './magic-rules.js';
import { magicInfo, magicItemData } from './magic-catalog.js';
import { removeMagicEffects, addMagicEffect } from './magic-state.js';

const copy = (value) => structuredClone(value);
export const MAGIC_GEAR_SOURCE = 'A Tome of Chaos v1.01';
const trophy = (name, rules, text, page = 124) => ({ name, rules, text, page });
export const TROPHIES = Object.freeze({
  botchling: trophy(
    'Botchling',
    { socialStanding: 'feared', doubleExistingFearedBonus: true },
    'Become Feared; if already Feared, double its bonuses.'
  ),
  vendigo: trophy('Vendigo', { immunities: ['disease'] }, 'Immune to disease.'),
  werewolf: trophy(
    'Werewolf',
    { modifiers: { physique: 2, wildernessSurvival: 2 } },
    '+2 Physique and Wilderness Survival.'
  ),
  cockatrice: trophy(
    'Cockatrice',
    { attackEffects: [{ condition: 'staggered', chance: 10, trigger: 'hit' }] },
    'Attacks have a10% chance to stagger.'
  ),
  phoenix: trophy(
    'Phoenix',
    { ignitionChanceReduction: 50 },
    'Reduce chances to catch fire by50 percentage points, minimum0.'
  ),
  slyzard: trophy(
    'Slyzard',
    { elementalCasting: { element: 'fire', bonus: 2 } },
    '+2 Spell Casting for fire spells and signs.'
  ),
  wyvern: trophy(
    'Wyvern',
    { attackEffects: [{ condition: 'poison', chance: 25, trigger: 'damage' }] },
    'Creatures damaged by your attacks have a25% chance to be poisoned.'
  ),
  'earth-elemental': trophy(
    'Earth Elemental',
    { ablationMultiplier: 2 },
    'Attacks deal double ablation to weapons, shields and armor.'
  ),
  'fire-elemental': trophy(
    'Fire Elemental',
    { attackEffects: [{ condition: 'fire', chance: 25, trigger: 'damage' }] },
    'Creatures damaged by your attacks have a25% chance to catch fire.'
  ),
  golem: trophy('Golem', { immunities: ['bleeding'] }, 'Immune to bleeding.'),
  'ice-elemental': trophy(
    'Ice Elemental',
    { attackEffects: [{ condition: 'frozen', chance: 25, trigger: 'damage' }] },
    'Creatures damaged by your attacks have a25% chance to freeze.'
  ),
  griffin: trophy(
    'Griffin',
    { criticalRolls: 2, chooseCriticalResult: true },
    'Roll the critical-wound result twice and choose one.'
  ),
  manticore: trophy('Manticore', { poisonDCBonus: 2 }, 'Poisons you use have+2 DC to resist or remove them.'),
  succubus: trophy('Succubus', { socialStandingSteps: 1 }, 'Social standing improves by one step.'),
  arachasae: trophy('Arachasae', { immunities: ['poison'] }, 'Immune to poison.', 125),
  frightener: trophy(
    'Frightener',
    { chosenResistance: ['slashing', 'piercing', 'bludgeoning'], selectionFrequency: 'daily' },
    'Choose one physical damage resistance; may change each day.',
    125
  ),
  bullvore: trophy(
    'Bullvore',
    { necrophageRedirectIfOtherTargetInRange: true },
    'A Necrophage chooses another target in range instead of you, if one exists.',
    125
  ),
  foglet: trophy(
    'Foglet',
    { modifiers: { stealth: 2, sleightOfHand: 2 } },
    '+2 Stealth and Sleight of Hand.',
    125
  ),
  'grave-hag': trophy(
    'Grave Hag',
    { modifiers: { ritualCrafting: 2, hexWeaving: 2 } },
    '+2 Ritual Crafting and Hex Weaving.',
    125
  ),
  fiend: trophy(
    'Fiend',
    { modifiers: { spellCasting: 2, resistMagic: 2 } },
    '+2 Spell Casting and Resist Magic.',
    125
  ),
  leshen: trophy(
    'Leshen',
    { speakToAnimals: true, verbalCombatAnimals: true, cannotCompelSelfHarm: true },
    'Animals and beasts understand your speech and can be approached through verbal combat; they will not do what they would refuse for themselves.',
    125
  ),
  shaelmaar: trophy(
    'Shaelmaar',
    { elementalCasting: { element: 'earth', bonus: 2 } },
    '+2 Spell Casting for earth spells and signs.',
    125
  ),
  hym: trophy(
    'Hym',
    { armorNegatedDamage: 4 },
    'When armor negates your attack damage, deal4 damage through that armor.',
    125
  ),
  noonwraith: trophy('Noonwraith', { immunities: ['fear'] }, 'Immune to fear.', 125),
  pesta: trophy(
    'Pesta',
    {
      modifiers: { seduction: -2, persuasion: -2, grooming: -2 },
      meleeOpponentPenalty: -2,
      meleeOpponentDiseaseChance: 10,
    },
    'Melee opponents suffer−2 to actions and have a10% disease chance. The flies also impose−2 Seduction, Persuasion and Grooming and Style.',
    125
  ),
  bruxa: trophy('Bruxa', { telepathyRange: 20 }, 'Communicate telepathically within20m.', 125),
  garkain: trophy(
    'Garkain',
    { stunPenaltyReduction: 1, stunWithoutPenaltyBonus: 1 },
    'Reduce a Stun-save penalty by1; without a penalty, Stun counts1 higher.',
    125
  ),
  katakan: trophy(
    'Katakan',
    { attackEffects: [{ condition: 'bleeding', chance: 25, trigger: 'damage' }] },
    'Creatures damaged by your attacks have a25% chance to bleed.',
    125
  ),
  cyclops: trophy(
    'Cyclops',
    { optionalAttackToPreventSpellStun: true, nearestLivingTarget: true },
    'When a spell would stun you, you may attack the nearest living target to resist the stun; other spell effects still apply.',
    125
  ),
  'rock-troll': trophy(
    'Rock Trolls',
    { thrownRangeMultiplierBonus: 1 },
    'Add1 to the range multiplier of thrown weapons.',
    125
  ),
  troll: trophy(
    'Troll',
    { intoxicationDoseMultiplier: 2, noHangover: true },
    'Alcohol needs twice as much to intoxicate you; no hangover.',
    125
  ),
  bear: trophy(
    'Bear',
    { grappleVictimEscapeModifier: -2 },
    'Creatures you grapple have−2 to escape your grapple.',
    125
  ),
  panther: trophy('Panther', { climbingSpeedMultiplier: 2 }, 'Double climbing speed.', 125),
});
export const AMULET_DRAWBACKS = Object.freeze({
  hp: { hp: -5 },
  headache: { int: -1, will: -1, ref: -1 },
  sta: { sta: -10 },
});
export function ritualArtifact(item) {
  return item?.flags?.[SYSTEM_ID]?.ritualArtifact ?? null;
}
export function artifactAvailable(item) {
  const state = item?.system ?? item;
  return (
    !!item &&
    state.quantity > 0 &&
    state.carried !== false &&
    !ritualArtifact(item)?.broken &&
    !item.flags?.[SYSTEM_ID]?.magicSuppressed
  );
}
export function wornArtifact(item) {
  return artifactAvailable(item) && !!(item.system ?? item).equipped;
}

export function artifactItemData(kind, details = {}) {
  let name,
    page,
    cost = 0,
    description,
    artifact,
    properties = {};
  if (kind === 'crystalSkull') {
    if (!['cat', 'dog', 'bird', 'serpent'].includes(details.animal))
      throw new RuleError('A Crystal Skull must be a cat, dog, bird or serpent.');
    name = `Crystal Skull (${details.animal})`;
    page = 119;
    cost = 700;
    description =
      'Speak the activation word to create the same physical animal. Mental commands reach50m. On death it reverts to an inert skull; the Create Crystal Skull ritual recharges it using2 Fifth Essence.';
    artifact = {
      key: 'create-crystal-skull',
      animal: details.animal,
      charged: true,
      active: false,
      animalActorUuid: '',
      tokenUuid: '',
      ...details,
    };
  } else if (kind === 'trophy') {
    const profile = TROPHIES[details.species];
    if (!profile) throw new RuleError('Choose a printed trophy species.');
    name = `${profile.name} Trophy`;
    page = profile.page;
    description = profile.text;
    artifact = { key: 'imbue-trophy', helpedKillActorUuids: [], activeActorUuid: '', ...details };
  } else if (kind === 'hexPendant') {
    name = 'Wagerer’s Pendant';
    page = 103;
    description =
      'While worn, suppress all hex effects. Removing it restores them. At the end of one week, if the wearer still has any hex, the pendant breaks and afflicts the wearer and everyone within2m with hexes chosen by the GM.';
    artifact = { key: 'wagerers-pendant', broken: false, expiresAt: 0, ...details };
  } else if (kind === 'amulet') {
    const count = details.storedMagic?.length ?? details.slots ?? 1;
    if (!Number.isInteger(count) || count < 1 || count > 4)
      throw new RuleError('An amulet stores one to four spells/invocations.');
    if (count > 1 && !AMULET_DRAWBACKS[details.drawback] && !details.pendingSetup)
      throw new RuleError('Choose the printed drawback for an amulet with more than one spell.');
    name = `Enchanted Amulet (${count} ${count === 1 ? 'spell' : 'spells'})`;
    page = 118;
    cost = 350 + count * 200;
    description =
      'Focus2. Cast its stored magic using the wearer’s STA and sufficient Vigor, using only the amulet as focus. Priests and druids can use it to cast mage spells. The chosen multi-spell drawback persists while worn and for24hours after removal.';
    properties.focus = 2;
    artifact = { key: 'enchant-amulet', storedMagic: [], complete: false, drawback: null, ...details };
  } else throw new RuleError('Unknown ritual artifact.');
  return {
    name,
    type: 'gear',
    img: 'icons/svg/item-bag.svg',
    system: {
      quantity: 1,
      carried: true,
      equipped: false,
      cost,
      weight: 0,
      description: `<p>${description}</p>`,
      source: MAGIC_GEAR_SOURCE,
      page,
      properties,
    },
    flags: {
      [SYSTEM_ID]: {
        ritualArtifact: artifact,
        weightUnspecified: true,
        ...(cost ? {} : { priceUnspecified: true }),
      },
    },
  };
}
export function amuletImbuementCost(magic, power) {
  if (!['spell', 'invocation'].includes(magic?.kind))
    throw new RuleError('An enchanted amulet stores spells or invocations.');
  let initialSTA;
  if (magic.cost?.formula) {
    if (
      !Number.isFinite(power) ||
      power <= 0 ||
      (magic.key === 'natures-gift' && !Number.isInteger(power)) ||
      (magic.key === 'dispel' && !Number.isInteger(power * 2))
    )
      throw new RuleError('Resolve the formula’s actual positive STA cost before imbuement.');
    initialSTA = power;
  } else initialSTA = validateMagicPower(magic, power);
  const maintenanceSTA = magicMaintenance(magic, initialSTA);
  return {
    power: initialSTA,
    initialSTA,
    maintenanceSTA,
    totalSTA: initialSTA + maintenanceSTA * 4,
    focus: 0,
  };
}
export function amuletGrantedItems(amulet) {
  const artifact = ritualArtifact(amulet);
  if (artifact?.key !== 'enchant-amulet' || !artifact.complete) return [];
  return artifact.storedMagic.map((entry) => {
    const data = magicItemData(entry.key);
    data.name = `${data.name} — ${amulet.name}`;
    data.flags = {
      ...data.flags,
      [SYSTEM_ID]: {
        ...data.flags?.[SYSTEM_ID],
        magicAmulet: { amuletId: amulet.id ?? amulet._id, key: entry.key },
      },
    };
    return data;
  });
}
export function amuletCastPermission(state, amulet, key, { staminaCost, vigor } = {}) {
  const artifact = ritualArtifact(amulet);
  if (
    artifact?.key !== 'enchant-amulet' ||
    !artifact.complete ||
    !wornArtifact(amulet) ||
    !artifact.storedMagic.some((entry) => entry.key === key)
  )
    throw new RuleError('The actual equipped amulet does not grant this spell.');
  if (state.magic?.dimeritiumContact) throw new RuleError('Dimeritium prevents the amulet’s magic.');
  if (Number.isFinite(staminaCost) && (!Number.isFinite(vigor) || vigor < staminaCost))
    throw new RuleError('The wearer must have sufficient Vigor for the amulet’s spell; it cannot overdraw.');
  return {
    focus: 2,
    permitMageSpell: ['priest', 'druid'].includes(state.magic?.tradition),
    allowOverdraw: false,
  };
}

export function activeTrophy(items, actorUuid) {
  const active = items.filter(
    (item) =>
      ritualArtifact(item)?.key === 'imbue-trophy' &&
      wornArtifact(item) &&
      ritualArtifact(item).activeActorUuid === actorUuid &&
      ritualArtifact(item).helpedKillActorUuids?.includes(actorUuid)
  );
  if (active.length > 1) throw new RuleError('Only one trophy may grant a magical benefit.');
  return active[0] ?? null;
}
export function trophyBenefits(items, actorUuid, context = {}) {
  const item = activeTrophy(items, actorUuid),
    artifact = ritualArtifact(item),
    profile = TROPHIES[artifact?.species];
  const reputation = Math.min(
    4,
    items.filter((row) => ritualArtifact(row)?.key === 'imbue-trophy' && artifactAvailable(row)).length
  );
  if (!profile) return { reputation, modifiers: {}, immunities: [], attackEffects: [] };
  const rules = copy(profile.rules),
    modifiers = rules.modifiers ?? {};
  if (rules.elementalCasting?.element === context.element && ['spell', 'sign'].includes(context.kind))
    modifiers.spellCasting = (modifiers.spellCasting ?? 0) + rules.elementalCasting.bonus;
  return {
    ...rules,
    itemId: item.id ?? item._id,
    species: artifact.species,
    reputation,
    modifiers,
    immunities: rules.immunities ?? [],
    attackEffects: (rules.attackEffects ?? []).filter((effect) =>
      effect.trigger === 'hit' ? context.hit === true : context.hpDamage > 0
    ),
    ...(rules.chosenResistance
      ? { resistance: rules.chosenResistance.includes(artifact.resistance) ? artifact.resistance : null }
      : {}),
  };
}

/** The pendant suppresses sources; it does not cure/delete the hex or steal a
 * condition introduced by another source. A later removal restores the source. */
export function trophySupport(species, installedHooks = []) {
  const profile = TROPHIES[species];
  if (!profile) return { supported: false, missing: ['unknown trophy'] };
  const required = Object.keys(profile.rules).filter((key) => key !== 'modifiers');
  const missing = required.filter((key) => !installedHooks.includes(key));
  return { supported: missing.length === 0, required, missing };
}
export function pendantSuppressionPlan(state, items, time) {
  const pendant = items.find(
    (item) =>
      wornArtifact(item) &&
      ritualArtifact(item)?.key === 'wagerers-pendant' &&
      ritualArtifact(item).expiresAt > time
  );
  const active = (state.effects ?? []).filter(
    (effect) => effect.magic?.kind === 'hex' && !effect.magic.pendantSuppression
  );
  const suppressed = (state.effects ?? []).filter((effect) => effect.magic?.pendantSuppression);
  let projected = copy(state);
  if (pendant && active.length) {
    const ids = new Set(active.map((effect) => effect.id));
    const removed = removeMagicEffects(projected, (effect) => ids.has(effect.id));
    projected.effects = [
      ...removed.effects,
      ...active.map((effect) => ({
        ...copy(effect),
        conditions: [],
        magic: {
          ...copy(effect.magic),
          suppressed: true,
          pendantSuppression: {
            itemId: pendant.id ?? pendant._id,
            previousSuppressed: !!effect.magic.suppressed,
            conditions: copy(effect.conditions ?? []),
            addedConditions: copy(effect.magic.addedConditions ?? []),
          },
        },
      })),
    ];
    projected.conditions = removed.conditions;
  } else if (!pendant && suppressed.length) {
    const ids = new Set(suppressed.map((effect) => effect.id));
    projected.effects = projected.effects.filter((effect) => !ids.has(effect.id));
    for (const effect of suppressed) {
      const restored = copy(effect),
        previous = restored.magic.pendantSuppression;
      restored.magic.suppressed = previous.previousSuppressed;
      restored.conditions = previous.conditions;
      delete restored.magic.pendantSuppression;
      if (previous.previousSuppressed) {
        projected.effects.push(restored);
        continue;
      }
      Object.assign(projected, addMagicEffect(projected, restored));
    }
  }
  return { effects: projected.effects, conditions: projected.conditions, pendantId: pendant?.id ?? null };
}

export function amuletDrawbackPlan(state, items, time, idFactory) {
  const effects = copy(state.effects ?? []),
    worn = new Set();
  for (const item of items) {
    const artifact = ritualArtifact(item);
    if (
      artifact?.key !== 'enchant-amulet' ||
      !artifact.complete ||
      !wornArtifact(item) ||
      artifact.storedMagic.length < 2
    )
      continue;
    const modifiers = AMULET_DRAWBACKS[artifact.drawback];
    if (!modifiers) throw new RuleError('This amulet has no valid drawback.');
    worn.add(item.uuid ?? item.id);
    const existing = effects.find((effect) => effect.magic?.amuletDrawbackSource === (item.uuid ?? item.id));
    if (existing) {
      existing.expires = 0;
      existing.modifiers = copy(modifiers);
    } else
      effects.push({
        id: idFactory(),
        key: `${item.name}: drawback`,
        expires: 0,
        modifiers: copy(modifiers),
        magic: {
          key: 'amulet-drawback',
          amuletDrawbackSource: item.uuid ?? item.id,
          drawback: artifact.drawback,
        },
      });
  }
  for (const effect of effects)
    if (
      effect.magic?.amuletDrawbackSource &&
      !worn.has(effect.magic.amuletDrawbackSource) &&
      effect.expires === 0
    )
      effect.expires = time + 86400;
  return effects;
}
