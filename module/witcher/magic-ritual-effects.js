import { SYSTEM_ID } from './config.js';
import { hitLocations, RuleError } from './rules.js';
import { MAGIC, magicInfo } from './magic-catalog.js';
import { addMagicEffect, removeMagicEffects, magicVigor, IMPLEMENTED_MAGIC } from './magic-state.js';
import { dice, escapeHTML as e } from './runtime.js';
import { executeWorldMagic } from './magic-world-effects.js';
import { registerCommand, runCommand, authorizedActor } from './authority.js';
import { input, prompt, errorNotice } from './runtime.js';
import { check, checkHTML, chat, commitActor, serial } from './runtime.js';
import { isPrimaryActiveGm } from '../foundry-compat.js';
import {
  previewMagicRegion,
  validateMagicRegion,
  magicTokenOrigin,
  magicSceneScale,
} from './magic-regions.js';
import { isIncorporeal, immuneTo } from './monster-rules.js';
import { tickMagicLifecycle } from './magic-lifecycle.js';
import { magicCostPlan, elementalBacklash } from './magic-rules.js';
import {
  registerMagicProcedures,
  registerMagicProcedureChat,
  hexEffectData,
  ritualRequirements,
} from './magic-procedures.js';

const clone = (value) => structuredClone(value);
const list = (value) => value?.contents ?? Array.from(value ?? []);
export const RITUAL_KEYS = Object.freeze(
  MAGIC.filter((entry) => entry.kind === 'ritual').map((entry) => entry.key)
);
const seconds = (value) => ({ seconds: value, rounds: 0, maintenance: 'none' });
const permanent = seconds(0);
export const RITUAL_REGION_BEHAVIOR = `${SYSTEM_ID}.ritualArea`;
const REGION_KINDS = new Set([
  'healingCircle',
  'vigorCircle',
  'consecrate',
  'barrier',
  'illusion',
  'guestbook',
]);
const REGION_KEYS = new Set([
  'ritual-of-life',
  'ritual-of-magic',
  'consecrate',
  'magic-barrier',
  'interactive-illusion',
  'magical-guestbook',
]);
const JAR_SPELLS = ['talfryns-prison', 'zephyr', 'tanio-ilchar', 'dormyns-fog', 'static-storm'];
const regionState = (region) => region?.flags?.[SYSTEM_ID]?.ritualArea;
const worldNow = () => Number(game.time.worldTime);
let runtimeConfiguration = {};
const localToken = (uuid) => {
  for (const scene of list(game.scenes))
    for (const token of list(scene.tokens)) if (token.uuid === uuid) return token;
  return null;
};
const necromancy = new Set([
  'cadfans-synthesis',
  'create-soul-beacon',
  'hanmarvyns-blue-dream',
  'reanimate-corpse',
]);

/** Pure, book-derived result operations. Readiness never substitutes a prose record for a mechanical executor. */
export function ritualEffectPlan(
  key,
  { choices = {}, rolls = {}, ritualRank = 0, castTotal = 0, success = true } = {}
) {
  const magic = magicInfo(key);
  if (!magic || magic.kind !== 'ritual') throw new RuleError('Unknown ritual.');
  const requirements = [],
    operations = [];
  const choice = (name, options, label = name) => {
    const value = choices[name];
    if (options ? !options.includes(value) : value === undefined || value === null || value === '')
      requirements.push({ type: 'choice', key: name, options, label });
    return value;
  };
  const roll = (name, formula) => {
    if (!Number.isFinite(rolls[name])) requirements.push({ type: 'roll', key: name, formula });
    return rolls[name];
  };
  const op = (type, details = {}) =>
    operations.push({ type, source: magic.source, page: magic.page, key, ...details });
  const narrative = (procedure, details = {}) =>
    op('narrative', { procedure, adjudicator: 'gm', ...details });
  const maintained = () =>
    op('effect', {
      target: 'caster',
      casterEffect: true,
      maintenance: magic.duration.maintenance,
      maintenanceCost: magic.duration.maintenanceCost,
      maintenanceIntervalSeconds: magic.duration.maintenanceUnit === 'minute' ? 60 : 3,
      duration: permanent,
    });
  if (!success && !['tyromancy', 'ritual-of-naming'].includes(key))
    return { key, ready: true, requirements: [], operations: [], source: magic.source, page: magic.page };

  switch (key) {
    case 'cleansing-ritual':
      op('cleanse', {
        mode: choice('mode', ['alcohol', 'poison', 'illness']),
        excludesPlague: true,
        chosenEffectIds: choice('effectIds', null, 'Choose the actual affliction sources to cleanse'),
      });
      break;
    case 'hydromancy':
    case 'pyromancy':
      maintained();
      narrative('scry-event', {
        question: choice('question'),
        mode: key === 'pyromancy' ? 'present' : choice('mode', ['past', 'present']),
        pastLimitSeconds: key === 'hydromancy' ? 172800 : 0,
        detect: { skill: 'magicTraining', dc: castTotal, onlyPresent: true },
        duration: magic.duration,
      });
      break;
    case 'magical-message':
      op('recordMessage', {
        message: choice('message'),
        durationSeconds: choice('messageSeconds'),
        triggers: choice('triggers'),
        lifelike: !!choices.perfectGemstone,
        duration: permanent,
      });
      break;
    case 'ritual-of-life':
      op('healingCircle', {
        healing: 3,
        intervalSeconds: 3,
        totalTicks: 10,
        oneOccupant: true,
        endsOnExit: true,
        duration: seconds(30),
        radius: null,
      });
      break;
    case 'ritual-of-magic':
      if (choice('mode', ['vigor', 'essence']) === 'essence')
        op('createMaterial', { name: 'Fifth Essence', quantity: roll('essence', '1d6') / 2 });
      else
        op('vigorCircle', {
          bonus: Math.floor(ritualRank / 2),
          firstMagicalOccupant: true,
          oneUse: true,
          duration: seconds(18000),
          radius: null,
        });
      break;
    case 'spell-jar':
      op('spellJar', {
        duration: seconds(roll('days', '1d6') * 86400),
        selectionFormula: '1d10/2',
        choices: ['talfryns-prison', 'zephyr', 'tanio-ilchar', 'dormyns-fog', 'static-storm'],
        trigger: 'break',
        roundingAmbiguity:
          'The printed 1d10/2 does not specify how odd results select an integer row. The GM must record the mapping convention.',
      });
      break;
    case 'spirit-seance':
      op('spiritSeance', {
        burialSiteConfirmed: choice('burialSiteConfirmed', [true]),
        deceasedUuid: choice('deceasedUuid'),
        relatedWithinMetres: 20,
        memoriesRetained: true,
        duration: permanent,
        possession: {
          attack: 'spellCasting',
          defense: 'resistMagic',
          repeatRounds: '1d6',
          againstPrinciplesBonus: 5,
          suicidalBonus: 10,
        },
      });
      break;
    case 'telecommunication':
      op('telecommunication', {
        recipientUuid: choice('recipientUuid'),
        bothParticipantsMustPerform: true,
        duration: seconds(3600),
      });
      break;
    case 'consecrate':
      op('consecrate', {
        radius: choice('radius'),
        maxRadius: 10,
        material: choice('material', ['silver', 'meteorite']),
        crossing: { skill: 'resistMagic', dc: castTotal, entering: true, leaving: true },
        blocksMonsterMagic: true,
        passesOrdinaryProjectiles: true,
        duration: permanent,
      });
      break;
    case 'magic-barrier':
      maintained();
      op('barrier', {
        radius: 5,
        hp: 50,
        hpPerExtraSTA: 5,
        blocksSolidMatter: true,
        incorporealPasses: true,
        teleportPasses: true,
        replenishesAir: true,
        airWhenStoppedRounds: 20,
        subtractEachExtraOccupant: 1,
      });
      break;
    case 'oneiromancy':
      narrative('shared-revelatory-dream', {
        question: choice('question'),
        mode: choice('mode', ['past', 'present']),
        participants: choice('participants'),
        participantMaximum: ritualRank,
        personalTruthfulBondRequired: true,
        detect: { skill: 'magicTraining', dc: castTotal, onlyPresent: true },
        duration: seconds(roll('duration', '1d10') * 3),
      });
      break;
    case 'artifact-compression':
      op('compression', {
        rangeMetres: 10,
        scale: 0.1,
        unconscious: true,
        noAging: true,
        enduranceDC: 15,
        failedSaveDamage: '6d6',
        location: 'torso',
        hpDivisor: 5,
        hpRound: 'up',
        limbBreakDC: 14,
        limbDamage: 5,
        beheadingFatal: true,
        zeroHPFatal: true,
        releaseStunned: true,
        duration: permanent,
      });
      break;
    case 'golem-crafting':
      op('summon', {
        profile: 'golem',
        count: 1,
        controllable: true,
        literalOrders: true,
        fineManipulation: false,
        duration: permanent,
      });
      break;
    case 'interactive-illusion':
      op('illusion', {
        radius: 20,
        senses: ['sight', 'sound', 'smell', 'touch'],
        controlledByCaster: true,
        hazardSave: { skills: ['resistMagic', 'endurance'], dc: 12, failure: 'stunSave' },
        lethalDamage: false,
        duration: permanent,
      });
      break;
    case 'imbue-trophy':
      op('trophy', {
        itemId: choice('trophyItemId'),
        species: choice('species'),
        helpedKillActorUuids: choice('helpedKillActorUuids'),
        mustBePreviouslyNonmagical: true,
        benefitTablePage: 124,
        duration: permanent,
      });
      break;
    case 'create-crystal-skull':
      op('crystalSkull', {
        animal: choice('animal', ['cat', 'dog', 'bird', 'serpent']),
        rechargeItemId: choices.rechargeItemId || '',
        rechargeEssenceUnits: 2,
        duration: permanent,
        itemRulesPage: 119,
      });
      break;
    case 'tyromancy':
      narrative('immediate-outcome-divination', {
        question: choice('question'),
        truthful: !!success,
        answerIfFailure: success ? null : Number(choices.dcRoll) % 2 ? 'negative' : 'positive',
        GMOnly: true,
        nearerConsequenceWhenMixed: true,
      });
      break;
    case 'animate-armor':
      op('livingArmor', {
        profile: 'living-armor',
        armorItemIds: choice('armorItemIds'),
        deriveSPFromActualArmor: true,
        nonsapient: true,
        loyalToCaster: true,
        duration: permanent,
      });
      break;
    case 'wagerers-pendant':
      op('hexPendant', {
        duration: seconds(604800),
        suppressWhileWorn: true,
        restoreOnRemoval: true,
        endIfAnyHexRemains: { breaks: true, radius: 2, hexesChosenByGM: true },
      });
      break;
    case 'beacon-of-the-unnatural':
      op('monsterBeacon', {
        hp: 20,
        heightMetres: 2,
        initialRangeMiles: 1,
        addedMilesPerYear: 1,
        attractsMonstersToNest: true,
        duration: permanent,
      });
      break;
    case 'fog-of-the-past':
      narrative('project-emotionally-strongest-local-event', {
        maximumRecordingSeconds: 300,
        loop: true,
        duration: seconds(1200),
        location: choice('location'),
      });
      break;
    case 'magical-guestbook':
      op('guestbook', {
        regionUuid: choice('regionUuid'),
        recordingDurationSeconds: 86400,
        alertActorUuids: choices.alertActorUuids ?? [],
        telepathyRangeMetres: 100,
        archivePersists: true,
        archiveReaderMinimumVigor: 1,
      });
      break;
    case 'create-place-of-power':
      op('placeOfPower', {
        element: choice('element', ['earth', 'air', 'fire', 'water']),
        twoSameElementLeyLinesConfirmed: choice('leyLinesConfirmed', [true]),
        duration: permanent,
      });
      break;
    case 'enchant-amulet':
      op('amulet', {
        storedMagicItemIds: choice('storedMagicItemIds'),
        fullCosts: true,
        maintenanceRoundsPrepaid: 4,
        focusAllowed: false,
        consecutiveSpellCastsRequired: true,
        duration: permanent,
      });
      break;
    case 'cadfans-synthesis':
      op('corpseAmalgam', {
        profile: 'corpse-amalgam',
        corpseUuids: choice('corpseUuids'),
        requiredCorpses: 10,
        killedWithinSeconds: 86400,
        literalOrders: true,
        higherReasoning: false,
        duration: permanent,
      });
      break;
    case 'create-soul-beacon':
      op('soulBeacon', {
        skullType: choice('skullType', ['humanElderfolk', 'beastMonster']),
        hp: 10,
        heightMetres: 1,
        radius: 6,
        noStacking: true,
        killedWithinSeconds: 86400,
        ritualDCModifier: -3,
        ritualCostModifier: -3,
        restlessModifier: -2,
        creatureAttackDefenseBonus: 2,
        blueDreamScentNightVision: true,
        duration: seconds(86400),
      });
      break;
    case 'hanmarvyns-blue-dream':
      op('blueDream', {
        rangeMetres: 4,
        corpseUuid: choice('corpseUuid'),
        duration: seconds(choices.hallucinogens ? 1200 : 600),
        unconscious: true,
        enduranceDC: 24,
        failure: 'deathState',
        visionDespiteFailure: true,
        corpseFinalMinutes: choices.hallucinogens ? 20 : 10,
      });
      break;
    case 'reanimate-corpse':
      maintained();
      op('reanimate', {
        corpseUuid: choice('corpseUuid'),
        halfBrainAndSpeechOrgansConfirmed: choice('organsConfirmed', [true]),
        cannotMove: true,
        resistCoercion: -3,
        tortureTormentIneffective: true,
        maintenanceCost: 3,
        maintenanceIntervalSeconds: 60,
      });
      break;
    case 'uncontrolled-summoning':
    case 'controlled-summoning':
      op('demonSummon', {
        chosen: key === 'controlled-summoning',
        actorProfileUuid: choice('demonProfileUuid'),
        offeringConfirmed: key === 'controlled-summoning' ? choice('offeringConfirmed', [true]) : false,
        trueName: choices.trueName || '',
        controlled: false,
        protected: false,
      });
      break;
    case 'ritual-of-naming':
      if (success)
        narrative('discover-specific-demon-true-name', { demonUuid: choice('demonUuid'), GMOnly: true });
      else
        op('effect', {
          target: 'caster',
          duration: permanent,
          rule: { key: 'lucifuge-mark', demonUuid: choice('demonUuid'), revealsCasterLocation: true },
          casterEffect: true,
        });
      break;
    case 'ritual-of-binding':
      op('demonBinding', {
        demonUuid: choice('demonUuid'),
        trueName: choice('trueName'),
        cageDurationSeconds: 86400,
        attackThroughOnly: 'True Staff of Binding',
        bargainUsesVerbalCombat: true,
        agreementDuration: permanent,
        escapeCheckIntervalSeconds: 1209600,
        escapeSkill: 'resistMagic',
        escapeDC: castTotal,
        secretEscapeCheck: true,
        callWithoutNewSummoning: true,
      });
      break;
    case 'ritual-of-the-goat-skin':
      op('goatMantle', {
        fortnightFastAbstinenceConfirmed: choice('fortnightConfirmed', [true]),
        protectedSpecies: ['bes', 'casglydd', 'mari-lwyd'],
        duration: permanent,
        speciesProtectionsTable: 'goetic-equipment',
      });
      break;
    default:
      throw new RuleError('The ritual has no audited result plan.');
  }
  if (choices.messageSeconds !== undefined && (!(choices.messageSeconds > 0) || choices.messageSeconds > 300))
    throw new RuleError('A Magical Message is at most five minutes long.');
  if (
    key === 'magical-message' &&
    choices.triggers !== undefined &&
    (!Array.isArray(choices.triggers) ||
      choices.triggers.length > 3 ||
      choices.triggers.some((value) => !String(value).trim()))
  )
    throw new RuleError('Choose at most three nonempty message triggers.');
  if (key === 'consecrate' && choices.radius !== undefined && (!(choices.radius > 0) || choices.radius > 10))
    throw new RuleError('Consecrate has a radius up to 10 metres.');
  if (
    key === 'oneiromancy' &&
    choices.participants !== undefined &&
    (!Array.isArray(choices.participants) ||
      new Set(choices.participants).size !== choices.participants.length ||
      choices.participants.length > ritualRank)
  )
    throw new RuleError('Oneiromancy participants must be distinct and no more than Ritual Crafting rank.');
  if (
    key === 'cadfans-synthesis' &&
    choices.corpseUuids !== undefined &&
    (!Array.isArray(choices.corpseUuids) ||
      choices.corpseUuids.length !== 10 ||
      new Set(choices.corpseUuids).size !== 10)
  )
    throw new RuleError('Cadfan’s Synthesis needs ten different recent corpses.');
  return {
    key,
    ready: !requirements.length,
    requirements,
    operations: requirements.length ? [] : operations,
    source: magic.source,
    page: magic.page,
  };
}

/** Tome pp.130–131: every earlier row in the same column also occurs. */
export function restlessSpiritsPlan(tier, result) {
  if (!['novice', 'journeyman', 'master'].includes(tier) || !Number.isInteger(result))
    throw new RuleError('Restless Spirits requires a printed tier and integer result.');
  const thresholds = { novice: [1, 6, 10], journeyman: [1, 4, 7, 9], master: [1, 3, 5, 7, 9] }[tier];
  const effects = [
    { type: 'gateway', duration: 86400, necromancyBonus: 2, triggerFaces: [1, 2, 3] },
    {
      type: 'uninvitedGuest',
      hexChosenByGM: true,
      ordinaryLiftingForbidden: true,
      endBy: ['killSpirit', 'banishSpirit'],
      seanceBloodNotRequired: true,
    },
    { type: 'wraiths', countFormula: '1d6', withinMetres: 5, violent: true, attackNearest: true },
    { type: 'haunting', removalChosenByGM: true },
    {
      type: 'penitent',
      withinMetres: 5,
      attacksCaster: true,
      returnsEveryNight: true,
      endBy: ['killed', 'banished', 'casterKilled'],
    },
  ];
  return effects.filter((_, index) => thresholds[index] !== undefined && result >= thresholds[index]);
}

export function ritualMishapPlan(
  magic,
  { fumble = 0, overdraw = false, restlessRoll, ritualCost = magic.cost.min } = {}
) {
  if (!fumble && !overdraw) return { damage: 0, operations: [] };
  if (magic.key === 'create-place-of-power' && fumble)
    return {
      damage: ritualCost,
      fumble: 10,
      operations: [{ type: 'explosion', formula: '7d6', radius: 6, destroysStone: true }],
    };
  if (necromancy.has(magic.key)) {
    if (!Number.isInteger(restlessRoll))
      return {
        damage: fumble,
        requirements: [{ type: 'roll', key: 'restless', formula: '1d10' }],
        operations: [],
      };
    return { damage: fumble, operations: restlessSpiritsPlan(magic.tier, restlessRoll) };
  }
  return { damage: 0, operations: overdraw ? [{ type: 'elementalBacklash', element: magic.element }] : [] };
}

const OPERATION_TYPES = {
  'cleansing-ritual': ['cleanse'],
  hydromancy: ['effect', 'narrative'],
  pyromancy: ['effect', 'narrative'],
  'magical-message': ['recordMessage'],
  'ritual-of-life': ['healingCircle'],
  'ritual-of-magic': ['vigorCircle', 'createMaterial'],
  'spell-jar': ['spellJar'],
  'spirit-seance': ['spiritSeance'],
  telecommunication: ['telecommunication'],
  consecrate: ['consecrate'],
  'magic-barrier': ['effect', 'barrier'],
  oneiromancy: ['narrative'],
  'artifact-compression': ['compression'],
  'golem-crafting': ['summon'],
  'interactive-illusion': ['illusion'],
  'imbue-trophy': ['trophy'],
  'create-crystal-skull': ['crystalSkull'],
  tyromancy: ['narrative'],
  'animate-armor': ['livingArmor'],
  'wagerers-pendant': ['hexPendant'],
  'beacon-of-the-unnatural': ['monsterBeacon'],
  'fog-of-the-past': ['narrative'],
  'magical-guestbook': ['guestbook'],
  'create-place-of-power': ['placeOfPower'],
  'enchant-amulet': ['amulet'],
  'cadfans-synthesis': ['corpseAmalgam'],
  'create-soul-beacon': ['soulBeacon'],
  'hanmarvyns-blue-dream': ['blueDream'],
  'reanimate-corpse': ['effect', 'reanimate'],
  'uncontrolled-summoning': ['demonSummon'],
  'controlled-summoning': ['demonSummon'],
  'ritual-of-naming': ['effect', 'narrative'],
  'ritual-of-binding': ['demonBinding'],
  'ritual-of-the-goat-skin': ['goatMantle'],
};
const BUILTIN_TYPES = new Set([
  'cleanse',
  'effect',
  'narrative',
  'recordMessage',
  'createMaterial',
  'summon',
  'telecommunication',
  'goatMantle',
  'spellJar',
  'monsterBeacon',
  'soulBeacon',
  'placeOfPower',
  'blueDream',
  'reanimate',
  'compression',
  'spiritSeance',
  'demonSummon',
  'demonBinding',
  'livingArmor',
  'corpseAmalgam',
  ...REGION_KINDS,
]);

export function ritualSupport(key, { adapters = {}, specialMishaps = false, dedicatedAmulet = false } = {}) {
  const kinds = OPERATION_TYPES[key];
  if (!kinds) return { supported: false, missing: ['ritual'] };
  const missing = kinds.filter(
    (kind) =>
      !BUILTIN_TYPES.has(kind) &&
      typeof adapters[kind]?.prepare !== 'function' &&
      !(kind === 'amulet' && dedicatedAmulet)
  );
  if (key === 'spell-jar')
    for (const spell of JAR_SPELLS) if (!IMPLEMENTED_MAGIC.has(spell)) missing.push(`storedSpell:${spell}`);
  if ((necromancy.has(key) || key === 'create-place-of-power') && !specialMishaps)
    missing.push('specialMishaps');
  if (key === 'enchant-amulet' && !dedicatedAmulet) missing.push('storedSpellSequence');
  return { supported: !missing.length, missing };
}

export function supportsRitualRuntime(key) {
  return ritualSupport(key, {
    adapters: runtimeConfiguration.adapters ?? {},
    specialMishaps: typeof runtimeConfiguration.prepareSpecialMishaps === 'function',
    dedicatedAmulet: typeof runtimeConfiguration.dedicatedProcedure === 'function',
  }).supported;
}

export function ritualSupportedOps() {
  return [...new Set(Object.values(OPERATION_TYPES).flat())].map((type) => ({
    type,
    supported:
      BUILTIN_TYPES.has(type) ||
      typeof runtimeConfiguration.adapters?.[type]?.prepare === 'function' ||
      (type === 'amulet' && typeof runtimeConfiguration.dedicatedProcedure === 'function'),
  }));
}

/** Register at ready, after the native Region behavior was registered during init. */
export async function registerRitualRuntime(configuration = {}) {
  const gear = await import('./magic-gear.js');
  runtimeConfiguration = {
    ...configuration,
    adapters: { ...gear.createMagicGearAdapters(), ...(configuration.adapters ?? {}) },
    procedureFields: gear.magicGearProcedureFields,
    procedureChoices: gear.magicGearProcedureChoices,
    componentRequirements: gear.magicGearComponentRequirements,
    prepareEntry: gear.prepareMagicGearEntry,
    dedicatedProcedure: gear.beginAmuletImbuement,
    prepareSpecialMishaps:
      configuration.prepareSpecialMishaps ??
      ((context) => prepareRitualSpecialMishap(context, runtimeConfiguration)),
  };
  registerMagicProcedures(createRitualProcedureHandlers(runtimeConfiguration));
  registerMagicProcedureChat();
  registerRitualArtifactCommands();
  return runtimeConfiguration;
}

function ritualEffect(context, operation) {
  const { actor, magic, castId, check, time } = context;
  const duration = operation.duration?.seconds ?? 0;
  return {
    id: foundry.utils.randomID(),
    key: magic.name,
    sourceUuid: actor.uuid,
    expires: duration ? time + duration : 0,
    modifiers: operation.modifiers ?? {},
    notes:
      operation.rule?.key === 'lucifuge-mark'
        ? 'This demon knows the marked caster’s location while the Lucifuge mark remains.'
        : magic.text,
    magic: {
      key: magic.key,
      kind: 'ritual',
      castId,
      casterUuid: actor.uuid,
      castingTotal: check?.total ?? 0,
      source: magic.source,
      page: magic.page,
      casterEffect: !!operation.casterEffect,
      createdAt: time,
      paidAt: time,
      castRound: game.combat?.started ? `${game.combat.id}:${game.combat.round}` : '',
      staCost: context.cost?.staCost ?? magic.cost.min,
      maintenance: operation.maintenance ?? 'none',
      maintenanceIntervalSeconds: operation.maintenanceIntervalSeconds ?? 3,
      nextUpkeepAt: time + (operation.maintenanceIntervalSeconds ?? 3),
      ...(operation.rule ? { rule: clone(operation.rule) } : {}),
      addedConditions: [],
    },
  };
}

function actualAfflictions(state, operation) {
  if (!Array.isArray(operation.chosenEffectIds)) throw new RuleError('Choose the actual affliction sources.');
  const allowedConditions = { alcohol: ['intoxicated'], poison: ['poison'], illness: ['disease'] }[
    operation.mode
  ];
  const selected = new Set(operation.chosenEffectIds);
  const sources = state.effects.filter((effect) => selected.has(effect.id));
  if (sources.length !== selected.size)
    throw new RuleError('An affliction changed during ritual preparation.');
  for (const effect of sources) {
    if (effect.plague || effect.magic?.plague || /catriona|plague/i.test(effect.key ?? ''))
      throw new RuleError('Cleansing Ritual cannot cure a plague.');
    const classification = effect.afflictionType ?? effect.magic?.operation?.rule?.key;
    const permitted =
      operation.mode === 'alcohol'
        ? ['alcohol', 'drug', 'intoxication'].includes(classification) ||
          effect.removeCondition === 'intoxicated' ||
          effect.conditions?.includes('intoxicated')
        : operation.mode === 'poison'
          ? ['poison', 'oil'].includes(classification) ||
            effect.removeCondition === 'poison' ||
            effect.conditions?.includes('poison') ||
            effect.key === 'Poison'
          : classification === 'disease' || effect.key === 'Disease';
    if (!permitted)
      throw new RuleError('The selected source is not an affliction covered by this cleansing mode.');
  }
  const next = removeMagicEffects(state, (effect) => selected.has(effect.id));
  const remainingSources = next.effects.filter((effect) =>
    allowedConditions.some(
      (condition) => effect.conditions?.includes(condition) || effect.removeCondition === condition
    )
  );
  if (!remainingSources.length)
    next.conditions = next.conditions.filter((condition) => !allowedConditions.includes(condition));
  return next;
}

function worldContext(context, configuration) {
  const extra = configuration.worldContext?.(context) ?? {};
  const casterToken = extra.casterToken ?? localToken(context.choices?.casterTokenUuid);
  return {
    ...(casterToken ? { casterToken, scene: casterToken.parent, point: magicTokenOrigin(casterToken) } : {}),
    ...extra,
    castId: context.castId,
    caster: context.actor,
    target: context.target,
    targets: context.target ? [context.target] : [],
    sourceMagic: context.magic,
    user: globalThis.game?.user,
  };
}

async function executeMany(executors) {
  const results = [];
  try {
    for (const execute of executors) {
      const result = await execute();
      if (typeof result?.rollback !== 'function')
        throw new RuleError('Ritual executor must support compensation.');
      results.push(result);
    }
  } catch (error) {
    const errors = [];
    for (const result of [...results].reverse()) {
      try {
        await result.rollback();
      } catch (failure) {
        errors.push(failure);
      }
    }
    if (errors.length)
      throw new AggregateError([error, ...errors], 'A ritual outcome failed and compensation needs review.');
    throw error;
  }
  return {
    status: results.some((result) => result.status === 'pendingGM') ? 'pendingGM' : 'applied',
    receipt: { results: results.map((result) => result.receipt) },
    async rollback() {
      const errors = [];
      for (const result of [...results].reverse())
        try {
          await result.rollback();
        } catch (error) {
          errors.push(error);
        }
      if (errors.length) throw new AggregateError(errors, 'Ritual compensation was incomplete.');
    },
  };
}

async function createArtifact(actor, data, context) {
  const [item] = await actor.createEmbeddedDocuments('Item', [
    {
      type: 'gear',
      img: 'icons/svg/item-bag.svg',
      ...data,
      system: {
        quantity: 1,
        carried: true,
        source: context.magic.source,
        page: context.magic.page,
        description: `<p>${e(context.magic.text)}</p>`,
        ...data.system,
      },
      flags: {
        ...data.flags,
        [SYSTEM_ID]: {
          ...data.flags?.[SYSTEM_ID],
          ritualArtifact: {
            key: context.magic.key,
            castId: context.castId,
            casterUuid: context.actor.uuid,
            createdAt: context.time,
            ...data.flags?.[SYSTEM_ID]?.ritualArtifact,
          },
        },
      },
    },
  ]);
  if (!item?.uuid || typeof item.delete !== 'function')
    throw new RuleError('Foundry did not create the ritual artifact.');
  return { status: 'applied', receipt: { itemUuid: item.uuid }, rollback: () => item.delete() };
}

async function resolvedPlan(context) {
  const rolls = {};
  const rollDocuments = [];
  for (let attempt = 0; attempt < 5; attempt++) {
    const plan = ritualEffectPlan(context.magic.key, {
      choices: context.choices,
      rolls,
      ritualRank: Number(context.actorState.skills?.ritualCrafting ?? 0),
      castTotal: context.check?.total ?? 0,
      success: context.success,
    });
    if (plan.ready) return { ...plan, rolls: rollDocuments };
    const missing = plan.requirements.filter((requirement) => requirement.type !== 'roll');
    if (missing.length)
      throw new RuleError(
        `The ritual still needs: ${missing.map((requirement) => requirement.label ?? requirement.key).join(', ')}.`
      );
    for (const requirement of plan.requirements) {
      const die = await dice(requirement.formula);
      rolls[requirement.key] = die.total;
      rollDocuments.push(die);
    }
  }
  throw new RuleError('The ritual effect dice could not be resolved.');
}

async function ritualProcedureFields({ actor, magic, targetUuid }) {
  const key = magic.key;
  let content = '';
  if (['hydromancy', 'pyromancy', 'oneiromancy', 'tyromancy'].includes(key))
    content += input('question', 'Event or intended course of action', { type: 'text' });
  if (key === 'magical-message') {
    content +=
      input('message', 'Recorded message', { type: 'text' }) +
      input('messageSeconds', 'Spoken length in seconds (maximum 300)', { value: 60, min: 1, max: 300 });
    for (let index = 0; index < 3; index++)
      content += input(`trigger-${index}`, `Trigger ${index + 1} (optional)`, { type: 'text' });
  }
  if (key === 'fog-of-the-past') content += input('location', 'Actual ritual location', { type: 'text' });
  if (key === 'cleansing-ritual') {
    const selected = targetUuid
      ? await (foundry.utils.fromUuid ?? globalThis.fromUuid)(targetUuid)
      : [...(game.user.targets ?? [])][0]?.document;
    const target = selected?.actor ?? selected ?? actor;
    content +=
      '<p>Select recorded affliction sources. An ordinary Poisoned or Intoxicated condition without an effect can also be cleansed.</p>';
    for (const effect of target.system.effects)
      content += input(`affliction-${effect.id}`, effect.key, { type: 'checkbox' });
  }
  if (key === 'oneiromancy') {
    content += '<p>Choose bonded participants who answered the personal questions truthfully.</p>';
    for (const candidate of list(game.actors).filter((entry) => entry.uuid !== actor.uuid))
      content += input(`participant-${candidate.uuid}`, candidate.name, { type: 'checkbox' });
  }
  if (key === 'spirit-seance')
    content +=
      input('deceasedUuid', 'Deceased Actor UUID', { type: 'text' }) +
      input('specterProfileUuid', 'Actual specter Actor profile UUID (GM selected)', { type: 'text' }) +
      input('bloodlineUuids', 'Other bloodline spirits within 20m: Actor UUIDs separated by commas', {
        type: 'text',
      }) +
      input('burialSiteConfirmed', 'At the actual burial site; all nearby related spirits included', {
        type: 'checkbox',
      }) +
      input('spiritRuling', 'GM: specter profile and burial evidence', { type: 'text' });
  if (['uncontrolled-summoning', 'controlled-summoning'].includes(key))
    content +=
      input('demonProfileUuid', 'Actual demon Actor profile UUID', { type: 'text' }) +
      input('demonSpecies', 'Demon species', {
        options: { bes: 'Bes', casglydd: 'Casglydd', 'mari-lwyd': 'Mari Lwyd', other: 'Other printed demon' },
      }) +
      input('trueName', 'Known true name (optional)', { type: 'text' }) +
      input('offeringConfirmed', 'All prescribed species offerings were supplied', { type: 'checkbox' }) +
      input('spiritRuling', 'GM: profile source, actual offerings and summoning circumstances', {
        type: 'text',
      });
  if (key === 'ritual-of-binding')
    content +=
      input('demonUuid', 'Actual named demon Actor UUID', { type: 'text' }) +
      input('trueName', 'Known true name', { type: 'text' }) +
      input('cageRegionUuid', 'Actual drawn summoning circle Region UUID', { type: 'text' }) +
      input('spiritRuling', 'GM: true name and summoning circle evidence', { type: 'text' });
  if (key === 'ritual-of-naming')
    content += input('demonUuid', 'Specific demon Actor UUID', { type: 'text' });
  if (key === 'telecommunication')
    content += input('recipientUuid', 'Other telecommunicator user', {
      options: Object.fromEntries(
        list(game.actors)
          .filter((entry) => entry.uuid !== actor.uuid)
          .map((entry) => [entry.uuid, entry.name])
      ),
    });
  if (key === 'ritual-of-the-goat-skin')
    content += input(
      'fortnightConfirmed',
      'The prescribed fortnight of fasting and abstinence was completed',
      { type: 'checkbox' }
    );
  if (key === 'cadfans-synthesis')
    content +=
      input('corpseReceipts', 'Ten actual corpse Actor UUID@deathWorldTime entries, comma-separated', {
        type: 'text',
      }) + input('corpseEvidence', 'GM: source and evidence of each death', { type: 'text' });
  if (key === 'create-place-of-power')
    content +=
      input('leyRegionA', 'First actual Ley Line Region UUID', { type: 'text' }) +
      input('leyRegionB', 'Second actual Ley Line Region UUID', { type: 'text' }) +
      input('stoneRegionUuid', 'Standing stone contact Region UUID', { type: 'text' }) +
      input('monthDays', 'Days in the world calendar month', { min: 1, value: 30 }) +
      input('leyLinesConfirmed', 'The stone stands at these same-element intersecting Ley Lines', {
        type: 'checkbox',
      });
  if (key === 'create-soul-beacon')
    content +=
      input('skullType', 'Actual skull', {
        options: { humanElderfolk: 'Human / Elderfolk', beastMonster: 'Beast / Monster' },
      }) +
      input('killedAt', 'Actual creature death world time', { value: worldNow() }) +
      input('corpseEvidence', 'GM: identity and evidence for this recent skull', { type: 'text' });
  if (['reanimate-corpse', 'hanmarvyns-blue-dream'].includes(key))
    content +=
      input('corpseUuid', 'Actual corpse Actor or Token UUID', { type: 'text' }) +
      (key === 'reanimate-corpse'
        ? input('organsConfirmed', 'At least half the brain and all organs required to speak remain', {
            type: 'checkbox',
          })
        : input('hallucinogens', 'Recipient is actually under a hallucinogen', { type: 'checkbox' }));
  if (key === 'magical-guestbook')
    for (const candidate of list(game.actors))
      content += input(`alert-${candidate.uuid}`, `Alert for ${candidate.name}`, { type: 'checkbox' });
  return content;
}

function ritualProcedureChoices({ magic, form }) {
  const choices = {};
  for (const key of [
    'question',
    'location',
    'demonUuid',
    'recipientUuid',
    'leyRegionA',
    'leyRegionB',
    'stoneRegionUuid',
    'skullType',
    'corpseEvidence',
    'corpseUuid',
    'specterProfileUuid',
    'deceasedUuid',
    'demonProfileUuid',
    'demonSpecies',
    'trueName',
    'cageRegionUuid',
    'spiritRuling',
  ])
    if (form[key]) choices[key] = String(form[key]);
  if (magic.key === 'cleansing-ritual')
    choices.effectIds = Object.entries(form)
      .filter(([key, value]) => key.startsWith('affliction-') && value === true)
      .map(([key]) => key.slice(11));
  if (magic.key === 'magical-message')
    Object.assign(choices, {
      message: form.message,
      messageSeconds: Number(form.messageSeconds),
      triggers: [0, 1, 2].map((index) => String(form[`trigger-${index}`] ?? '').trim()).filter(Boolean),
    });
  if (magic.key === 'oneiromancy')
    choices.participants = Object.entries(form)
      .filter(([key, value]) => key.startsWith('participant-') && value === true)
      .map(([key]) => key.slice(12));
  if (magic.key === 'ritual-of-the-goat-skin') choices.fortnightConfirmed = !!form.fortnightConfirmed;
  if (magic.key === 'cadfans-synthesis') {
    choices.corpseReceipts = String(form.corpseReceipts ?? '')
      .split(',')
      .map((value) => {
        const parts = value.trim().split('@');
        return { uuid: parts[0], killedAt: Number(parts[1]) };
      });
    choices.corpseUuids = choices.corpseReceipts.map((entry) => entry.uuid);
  }
  if (magic.key === 'create-place-of-power')
    Object.assign(choices, {
      leyLinesConfirmed: !!form.leyLinesConfirmed,
      monthDays: Number(form.monthDays),
    });
  if (magic.key === 'create-soul-beacon') choices.killedAt = Number(form.killedAt);
  if (magic.key === 'spirit-seance')
    Object.assign(choices, {
      burialSiteConfirmed: !!form.burialSiteConfirmed,
      bloodlineUuids: String(form.bloodlineUuids ?? '')
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean),
    });
  if (magic.key === 'controlled-summoning') choices.offeringConfirmed = !!form.offeringConfirmed;
  if (magic.key === 'reanimate-corpse') choices.organsConfirmed = !!form.organsConfirmed;
  if (magic.key === 'hanmarvyns-blue-dream') choices.hallucinogens = !!form.hallucinogens;
  if (magic.key === 'magical-guestbook')
    choices.alertActorUuids = Object.entries(form)
      .filter(([key, value]) => key.startsWith('alert-') && value === true)
      .map(([key]) => key.slice(6));
  return choices;
}

/** Real executors are injectable by operation type; missing mechanisms remain visibly unavailable. */
export function createRitualProcedureHandlers(configuration = {}) {
  const adapters = configuration.adapters ?? {};
  const support = (magic) =>
    ritualSupport(magic.key, {
      adapters,
      specialMishaps: typeof configuration.prepareSpecialMishaps === 'function',
      dedicatedAmulet: typeof configuration.dedicatedProcedure === 'function',
    });
  return {
    supportsRitual: (magic) => support(magic).supported,
    castingAdjustments: ({ actor, magic, choices }) =>
      necromancy.has(magic.key) ? ritualNecromancyBonuses(actor, localToken(choices.casterTokenUuid)) : {},
    dedicatedProcedure: configuration.dedicatedProcedure,
    componentRequirements: (context) =>
      context.magic.key === 'cadfans-synthesis'
        ? ritualRequirements(context.magic).map((entry) =>
            /corpses/i.test(entry.name) ? { ...entry, kind: 'prerequisite' } : entry
          )
        : context.magic.key === 'animate-armor'
          ? armorComponentRequirements(context)
          : context.magic.key === 'spirit-seance' && context.choices.uninvitedEffectId
            ? ritualRequirements(context.magic).filter((entry) => !/blood/i.test(entry.name))
            : context.magic.key === 'magical-message' && context.choices.perfectGemstone
              ? [{ id: 'component-0', name: 'Perfect Gemstone', quantity: 1, kind: 'consume' }]
              : configuration.componentRequirements?.(context),
    prepareEntry: (context) => prepareRitualEntry(context, configuration),
    procedureFields: async (context) =>
      (await ritualProcedureFields(context)) + ((await configuration.procedureFields?.(context)) ?? ''),
    procedureChoices: (context) => ({
      ...ritualProcedureChoices(context),
      ...(configuration.procedureChoices?.(context) ?? {}),
    }),
    async preflightRitual(context) {
      const status = support(context.magic);
      if (!status.supported) throw new RuleError(`This ritual requires: ${status.missing.join(', ')}.`);
      const plan = ritualEffectPlan(context.magic.key, {
        choices: context.choices,
        ritualRank: Number(context.actor.system.skills?.ritualCrafting ?? 0),
      });
      const missing = plan.requirements.filter((requirement) => requirement.type !== 'roll');
      if (missing.length)
        throw new RuleError(
          `Choose before preparation: ${missing.map((requirement) => requirement.label ?? requirement.key).join(', ')}.`
        );
      for (const kind of OPERATION_TYPES[context.magic.key])
        if (adapters[kind]?.preflight) await adapters[kind].preflight(context);
      if (
        REGION_KEYS.has(context.magic.key) &&
        !(context.magic.key === 'ritual-of-magic' && context.choices.mode === 'essence')
      )
        validateRitualPlacement(context);
      if (context.magic.key === 'golem-crafting') {
        const world = worldContext(context, configuration);
        if (!world.scene || !Number.isFinite(world.point?.x) || !Number.isFinite(world.point?.y))
          throw new RuleError('Choose the actual scene position of the created golem before preparation.');
      }
      await preflightSpecialRitual(context);
      if (context.magic.key === 'cleansing-ritual') {
        if (!context.target?.system)
          throw new RuleError('Choose the actor whose affliction is being cleansed.');
        actualAfflictions(context.target.system, plan.operations[0]);
      }
    },
    async planRitualResult(context) {
      const status = support(context.magic);
      if (!status.supported) throw new RuleError(`This ritual requires: ${status.missing.join(', ')}.`);
      const result = await resolvedPlan(context),
        plans = [],
        executors = [];
      const stateByActor = new Map([[context.actor.uuid, clone(context.actorState)]]);
      if (context.target?.uuid !== context.actor.uuid && context.targetState)
        stateByActor.set(context.target.uuid, clone(context.targetState));
      for (const operation of result.operations) {
        if (adapters[operation.type]) {
          const prepared = await adapters[operation.type].prepare(operation, context);
          if (!prepared || !Array.isArray(prepared.plans))
            throw new RuleError('The ritual adapter did not provide a prepared transaction.');
          plans.push(...prepared.plans);
          if (prepared.execute) executors.push(prepared.execute);
          continue;
        }
        if (
          [
            'spellJar',
            'monsterBeacon',
            'soulBeacon',
            'placeOfPower',
            'blueDream',
            'reanimate',
            'compression',
            'spiritSeance',
            'demonSummon',
            'demonBinding',
            'livingArmor',
            'corpseAmalgam',
          ].includes(operation.type)
        ) {
          const prepared = await prepareSpecialRitual(operation, context, configuration);
          plans.push(...prepared.plans);
          if (prepared.rolls) result.rolls.push(...prepared.rolls);
          if (prepared.execute) executors.push(prepared.execute);
          continue;
        }
        if (REGION_KINDS.has(operation.type)) {
          const prepared = await prepareRitualZone(operation, context, configuration);
          plans.push(...prepared.plans);
          if (prepared.execute) executors.push(prepared.execute);
          continue;
        }
        if (operation.type === 'telecommunication') {
          const recipient = await foundry.utils.fromUuid(operation.recipientUuid);
          if (!recipient?.system || recipient.uuid === context.actor.uuid)
            throw new RuleError('Choose another actual actor as the telecommunication partner.');
          const effect = ritualEffect(context, {
            target: 'caster',
            casterEffect: true,
            duration: operation.duration,
          });
          effect.magic.recipientUuid = recipient.uuid;
          const next = addMagicEffect(stateByActor.get(context.actor.uuid), effect);
          stateByActor.set(context.actor.uuid, { ...stateByActor.get(context.actor.uuid), ...next });
          plans.push({
            actor: context.actor,
            changes: { 'system.effects': next.effects, 'system.conditions': next.conditions },
          });
          executors.push(() =>
            ritualTransaction(async (tx) => {
              const message = await chat(
                context.actor,
                'Telecommunication',
                `<p>The link to ${e(recipient.name)} lasts one hour. Both participants must complete their ritual before communicating.</p><button data-ritual-telecommunication="${e(context.actor.uuid)}">Send through telecommunicator</button>`,
                {
                  flags: {
                    kind: 'ritual-telecommunication',
                    actorUuid: context.actor.uuid,
                    castId: context.castId,
                  },
                }
              );
              await tx.created(message);
              return { linkActorUuid: recipient.uuid };
            })
          );
          continue;
        }
        if (operation.type === 'goatMantle') {
          executors.push(() =>
            createArtifact(
              context.actor,
              {
                name: 'Goat Skin Mantle',
                system: {
                  weight: 0.5,
                  equipped: false,
                  notes:
                    'Wear to prevent the immediate Bes possession attempt and Casglydd claw-drag on summoning; Mari Lwyd does not assume everything in the building is offered.',
                },
                flags: {
                  [SYSTEM_ID]: {
                    ritualArtifact: { protections: clone(operation.protectedSpecies), completed: true },
                  },
                },
              },
              context
            )
          );
          continue;
        }
        if (operation.type === 'effect') {
          const actor = operation.target === 'caster' ? context.actor : context.target;
          const next = addMagicEffect(stateByActor.get(actor.uuid), ritualEffect(context, operation));
          stateByActor.set(actor.uuid, { ...stateByActor.get(actor.uuid), ...next });
          plans.push({
            actor,
            changes: { 'system.effects': next.effects, 'system.conditions': next.conditions },
          });
        } else if (operation.type === 'cleanse') {
          const next = actualAfflictions(stateByActor.get(context.target.uuid), operation);
          stateByActor.set(context.target.uuid, { ...stateByActor.get(context.target.uuid), ...next });
          plans.push({
            actor: context.target,
            changes: { 'system.effects': next.effects, 'system.conditions': next.conditions },
          });
        } else if (operation.type === 'narrative' || operation.type === 'summon') {
          executors.push(() => executeWorldMagic(operation, worldContext(context, configuration)));
        } else if (operation.type === 'recordMessage') {
          executors.push(() =>
            createArtifact(
              context.actor,
              {
                name: 'Magical Message',
                system: { description: `<p>${e(operation.message)}</p>` },
                flags: {
                  [SYSTEM_ID]: {
                    ritualArtifact: {
                      message: operation.message,
                      messageSeconds: Number(operation.durationSeconds),
                      triggers: clone(operation.triggers),
                      lifelike: operation.lifelike,
                    },
                  },
                },
              },
              context
            )
          );
        } else if (operation.type === 'createMaterial') {
          if (operation.quantity > 0)
            executors.push(() =>
              createArtifact(
                context.actor,
                {
                  name: operation.name,
                  type: 'component',
                  system: { quantity: operation.quantity, substance: 'fifthEssence' },
                },
                context
              )
            );
        } else throw new RuleError(`No ritual executor implements ${operation.type}.`);
      }
      return { plans, rolls: result.rolls, execute: () => executeMany(executors) };
    },
    async planSpecialMishap(context) {
      if (typeof configuration.prepareSpecialMishaps !== 'function')
        throw new RuleError('This ritual’s special mishap has no complete executor.');
      return configuration.prepareSpecialMishaps(context);
    },
  };
}

function guestbookImages(visitors = []) {
  return `<div>${visitors.map((entry) => `<figure><img src="${e(entry.image)}" alt="Recorded face" width="96" height="96"><figcaption>World time ${e(entry.time)}</figcaption></figure>`).join('') || '<p>No recorded faces.</p>'}</div>`;
}

async function preflightSpecialRitual(context) {
  const key = context.magic.key,
    choices = context.choices;
  if (['spirit-seance', 'uncontrolled-summoning', 'controlled-summoning', 'ritual-of-binding'].includes(key))
    await validateSpiritRitual(context);
  if (['animate-armor', 'cadfans-synthesis'].includes(key)) await validateCreatureRitual(context);
  if (
    [
      'beacon-of-the-unnatural',
      'create-soul-beacon',
      'create-place-of-power',
      'hanmarvyns-blue-dream',
      'reanimate-corpse',
      'artifact-compression',
    ].includes(key)
  ) {
    const token = localToken(choices.casterTokenUuid);
    if (!token || token.actor?.uuid !== context.actor.uuid)
      throw new RuleError('Select the actual ritual caster token.');
  }
  if (key === 'artifact-compression') {
    const token = localToken(choices.casterTokenUuid);
    if (
      !context.target?.system ||
      context.target.flags?.[SYSTEM_ID]?.artifactCompression?.active ||
      !list(token.parent.tokens).some(
        (entry) => entry.actor?.uuid === context.target.uuid && withinRitualRange(token, entry, 10)
      )
    )
      throw new RuleError('Choose an uncompressed creature actually within ten metres.');
  }
  if (key === 'create-place-of-power') {
    const token = localToken(choices.casterTokenUuid);
    const regions = await Promise.all(
      [choices.leyRegionA, choices.leyRegionB, choices.stoneRegionUuid].map((uuid) =>
        foundry.utils.fromUuid(uuid)
      )
    );
    if (
      new Set(regions.map((region) => region?.uuid)).size !== 3 ||
      regions.some(
        (region) => !region || region.parent?.id !== token.parent.id || !token.testInsideRegion(region)
      )
    )
      throw new RuleError(
        'The actual stone contact Region must intersect two distinct Ley Line Regions under the caster.'
      );
    if (
      regions
        .slice(0, 2)
        .some(
          (region) =>
            region.flags?.[SYSTEM_ID]?.magicSource?.kind !== 'ley' ||
            region.flags[SYSTEM_ID].magicSource.element !== choices.element
        )
    )
      throw new RuleError('Both actual Ley Lines must carry the chosen element.');
    if (!(Number(choices.monthDays) > 0)) throw new RuleError('Record the actual calendar month length.');
  }
  if (
    key === 'create-soul-beacon' &&
    (!context.user.isGM ||
      !String(choices.corpseEvidence ?? '').trim() ||
      !Number.isFinite(choices.killedAt) ||
      choices.killedAt > worldNow() ||
      choices.killedAt < worldNow() - 86400)
  )
    throw new RuleError('The GM must identify the skull from a creature killed within the last 24 hours.');
  if (['hanmarvyns-blue-dream', 'reanimate-corpse'].includes(key)) {
    const doc = await foundry.utils.fromUuid(choices.corpseUuid),
      corpse = doc?.actor ?? doc;
    if (!corpse?.system || !(corpse.system.conditions?.includes('dead') || corpse.system.hp.value <= 0))
      throw new RuleError('Choose the actual deceased creature.');
    if (key === 'hanmarvyns-blue-dream') {
      const casterToken = localToken(choices.casterTokenUuid);
      if (
        !list(casterToken.parent.tokens).some(
          (token) => token.actor?.uuid === context.target?.uuid && withinRitualRange(casterToken, token, 4)
        )
      )
        throw new RuleError('Blue Dream recipient must actually be within four metres.');
    }
  }
}

async function prepareSpecialRitual(operation, context, configuration) {
  await preflightSpecialRitual(context);
  if (['livingArmor', 'corpseAmalgam'].includes(operation.type))
    return prepareCreatureRitual(operation, context, configuration);
  if (['spiritSeance', 'demonSummon', 'demonBinding'].includes(operation.type))
    return prepareSpiritRitual(operation, context, configuration);
  if (operation.type === 'compression') return prepareCompression(operation, context);
  if (operation.type === 'spellJar')
    return {
      plans: [],
      execute: () =>
        createArtifact(
          context.actor,
          {
            name: 'Spell Jar',
            flags: {
              [SYSTEM_ID]: {
                ritualArtifact: {
                  expiresAt: context.time + operation.duration.seconds,
                  spells: operation.choices,
                  selection: null,
                  completed: true,
                },
              },
            },
          },
          context
        ),
    };
  if (operation.type === 'placeOfPower') {
    const stone = await foundry.utils.fromUuid(context.choices.stoneRegionUuid);
    return {
      plans: [],
      execute: () =>
        ritualTransaction(async (tx) => {
          await tx.update(stone, {
            [`flags.${SYSTEM_ID}.magicSource`]: {
              kind: 'place',
              element: operation.element,
              monthSeconds: context.choices.monthDays * 86400,
              castId: context.castId,
              casterUuid: context.actor.uuid,
            },
            name: `${operation.element} Place of Power`,
          });
          return { sourceRegionUuid: stone.uuid };
        }),
    };
  }
  if (['monsterBeacon', 'soulBeacon'].includes(operation.type))
    return {
      plans: [],
      execute: () =>
        ritualTransaction(async (tx) => {
          const casterToken = localToken(context.choices.casterTokenUuid);
          const actor = await createRitualStructure(context, operation, tx, {
            casterToken,
            scene: casterToken.parent,
          });
          await tx.update(actor, {
            [`flags.${SYSTEM_ID}.ritualStructure`]: {
              key: context.magic.key,
              castId: context.castId,
              casterUuid: context.actor.uuid,
              createdAt: context.time,
              expiresAt: operation.duration.seconds ? context.time + operation.duration.seconds : 0,
              skullType: operation.skullType,
              heightMetres: operation.heightMetres,
              attraction: operation.type === 'monsterBeacon' ? { rangeMiles: 1, addedMilesPerYear: 1 } : null,
            },
          });
          await tx.created(
            await chat(
              context.actor,
              context.magic.name,
              `<p>The ${operation.hp} HP totem is now an attackable object on the scene.</p>${operation.type === 'monsterBeacon' ? '<p>Monsters are drawn to nest within one mile, increasing by one mile each year. Record actual creatures and campaign travel through the GM attraction control.</p><button data-ritual-beacon>Record attraction (GM)</button>' : '<button data-ritual-beacon>Choose this Soul Beacon</button>'}`,
              { flags: { kind: 'ritual-beacon', actorUuid: actor.uuid, castId: context.castId } }
            )
          );
          return { objectUuid: actor.uuid };
        }),
    };
  const doc = await foundry.utils.fromUuid(context.choices.corpseUuid),
    corpse = doc.actor ?? doc;
  if (operation.type === 'blueDream') {
    const target = context.target,
      result = await check(target.skillBase('endurance').total, {
        actor: target,
        context: { skill: 'endurance', dc: 24 },
      });
    const failed = !!result.fumble || result.total <= 24;
    const effect = ritualEffect(context, { duration: operation.duration });
    effect.conditions = ['unconscious'];
    Object.assign(effect.magic, {
      corpseUuid: corpse.uuid,
      dreamSenses: !!context.adjustments?.dreamSenses,
      operation: {
        type: 'condition',
        condition: 'unconscious',
        rule: {
          key: 'blue-dream',
          parameters: {
            nightVision: !!context.adjustments?.dreamSenses,
            scentTracking: !!context.adjustments?.dreamSenses,
          },
        },
      },
    });
    const next = addMagicEffect(context.targetState ?? target.system, effect);
    const changes = {
      'system.effects': next.effects,
      'system.conditions': next.conditions,
      ...(failed
        ? {
            'system.hp.value': Math.min(0, target.system.hp.value),
            'system.pendingDeathSaves': Number(target.system.pendingDeathSaves ?? 0) + 1,
          }
        : {}),
    };
    return {
      plans: [{ actor: target, changes }],
      rolls: result.rolls,
      execute: () =>
        executeWorldMagic(
          {
            type: 'narrative',
            procedure:
              'Experience the actual final memories of this corpse from their perspective; the GM supplies their emotions and events.',
            corpseUuid: corpse.uuid,
            minutes: operation.corpseFinalMinutes,
            adjudicator: 'gm',
          },
          worldContext(context, configuration)
        ),
    };
  }
  if (operation.type === 'reanimate') {
    const effect = ritualEffect(context, { duration: permanent, modifiers: { resistCoercion: -3 } });
    effect.magic.rule = { key: 'reanimated-corpse', cannotMove: true, tortureTormentIneffective: true };
    effect.magic.maintainedBy = context.actor.uuid;
    const next = addMagicEffect(corpse.system, effect);
    return {
      plans: [
        { actor: corpse, changes: { 'system.effects': next.effects, 'system.conditions': next.conditions } },
      ],
      execute: () =>
        executeWorldMagic(
          {
            type: 'narrative',
            procedure:
              'Question the actual deceased soul. It can speak while the caster maintains this ritual, cannot move, and suffers −3 Resist Coercion. Torture and Torment do not affect it.',
            corpseUuid: corpse.uuid,
            adjudicator: 'gm',
          },
          worldContext(context, configuration)
        ),
    };
  }
  throw new RuleError('Unknown special ritual executor.');
}

function armorComponentRequirements({ actor, magic, choices }) {
  const selected = choices.armorItemIds ?? [];
  if (selected.length !== 3 || new Set(selected).size !== 3)
    throw new RuleError('Select three distinct actual head, torso and leg armor Items.');
  const categories = ['Head Armor', 'Torso Armor', 'Leg Armor'];
  return ritualRequirements(magic).map((requirement) => {
    const index = categories.findIndex((name) => name.toLowerCase() === requirement.name.toLowerCase());
    if (index < 0) return requirement;
    const item = actor.items.get(selected[index]);
    if (!item) throw new RuleError('The selected armor is no longer carried.');
    return { ...requirement, name: item.name, quantity: 1, kind: 'consume', requiredItemId: item.id };
  });
}
async function validateCreatureRitual(context) {
  const token = localToken(context.choices.casterTokenUuid);
  if (!token || token.actor?.uuid !== context.actor.uuid)
    throw new RuleError('Choose the actual creation scene and caster token.');
  if (context.magic.key === 'animate-armor') {
    const items = context.choices.armorItemIds?.map((id) => context.actor.items.get(id));
    if (
      items?.length !== 3 ||
      new Set(items.map((item) => item?.id)).size !== 3 ||
      items.some((item) => item?.type !== 'armor' || !(item.system.quantity > 0))
    )
      throw new RuleError('Choose three actual owned armor pieces.');
    const { magicCreatureProfile } = await import('./magic-creature-profiles.js');
    magicCreatureProfile('living-armor', { armorItems: items.map((item) => item.toObject()) });
    for (const requirement of armorComponentRequirements(context))
      if (
        requirement.requiredItemId &&
        context.allocations &&
        context.allocations[requirement.id]?.itemId !== requirement.requiredItemId
      )
        throw new RuleError('The materials must consume exactly the selected suit of armor.');
  } else {
    const receipts = context.choices.corpseReceipts;
    if (
      !context.user.isGM ||
      !String(context.choices.corpseEvidence ?? '').trim() ||
      receipts?.length !== 10 ||
      new Set(receipts.map((entry) => entry.uuid)).size !== 10
    )
      throw new RuleError('The GM must identify ten distinct actual corpses and death times.');
    for (const entry of receipts) {
      const actor = await foundry.utils.fromUuid(entry.uuid);
      if (
        !actor?.system ||
        !(actor.system.conditions.includes('dead') || actor.system.hp.value <= 0) ||
        actor.flags?.[SYSTEM_ID]?.ritualCorpseConsumed ||
        !Number.isFinite(entry.killedAt) ||
        entry.killedAt > worldNow() ||
        entry.killedAt < worldNow() - 86400
      )
        throw new RuleError('Each unused corpse must be actually dead and killed within the last 24 hours.');
    }
  }
}
async function prepareCreatureRitual(operation, context, configuration) {
  await validateCreatureRitual(context);
  const snapshots =
    operation.type === 'livingArmor'
      ? context.choices.armorItemIds.map((id) => context.actor.items.get(id).toObject())
      : null;
  const world = worldContext(context, configuration);
  return {
    plans: [],
    execute: () =>
      ritualTransaction(async (tx) => {
        const result = await executeWorldMagic(
          {
            type: 'summon',
            profile: operation.profile,
            count: 1,
            controllable: true,
            duration: permanent,
            literalOrders: true,
          },
          { ...world, ...(snapshots ? { armorItems: snapshots } : {}) }
        );
        tx.compensate(result.rollback);
        if (operation.type === 'corpseAmalgam')
          for (const uuid of operation.corpseUuids) {
            const corpse = await foundry.utils.fromUuid(uuid);
            await tx.update(corpse, {
              [`flags.${SYSTEM_ID}.ritualCorpseConsumed`]: {
                castId: context.castId,
                createdAt: context.time,
              },
            });
            for (const scene of list(game.scenes))
              for (const token of list(scene.tokens))
                if (token.actor?.uuid === corpse.uuid) await tx.update(token, { hidden: true });
          }
        if (context.adjustments?.creatureBonus)
          for (const row of result.receipt.summons ?? []) {
            const creature = await foundry.utils.fromUuid(row.actorUuid);
            const effect = ritualEffect(context, {
              duration: permanent,
              modifiers: {
                attack: context.adjustments.creatureBonus,
                defense: context.adjustments.creatureBonus,
              },
            });
            effect.key = 'Soul Beacon · created creature';
            const next = addMagicEffect(creature.system, effect);
            await tx.update(creature, {
              'system.effects': next.effects,
              'system.conditions': next.conditions,
            });
          }
        return { ...result.receipt };
      }),
  };
}

async function validateSpiritRitual(context) {
  const choices = context.choices,
    key = context.magic.key,
    token = localToken(choices.casterTokenUuid);
  if (
    !context.user.isGM ||
    !token ||
    token.actor?.uuid !== context.actor.uuid ||
    !String(choices.spiritRuling ?? '').trim()
  )
    throw new RuleError(
      'The GM must confirm actual spirit profiles, burial/offerings and caster scene before this ritual.'
    );
  if (
    choices.uninvitedEffectId &&
    !context.actor.system.effects.some(
      (effect) => effect.id === choices.uninvitedEffectId && effect.magic?.uninvitedGuest
    )
  )
    throw new RuleError('The selected Uninvited Guest is no longer afflicting this actor.');
  const ids =
    key === 'spirit-seance'
      ? [choices.specterProfileUuid, choices.deceasedUuid, ...(choices.bloodlineUuids ?? [])]
      : [key === 'ritual-of-binding' ? choices.demonUuid : choices.demonProfileUuid];
  for (const uuid of ids) {
    const actor = await foundry.utils.fromUuid(uuid);
    if (!actor?.system) throw new RuleError('Every selected spirit/demon must be an actual Actor document.');
  }
  if (key === 'ritual-of-binding') {
    const region = await foundry.utils.fromUuid(choices.cageRegionUuid);
    if (!region || region.parent?.id !== token.parent.id || !region.bounds || regionState(region))
      throw new RuleError('Draw and select an unenchanted summoning-circle Region on this scene.');
    const demon = await foundry.utils.fromUuid(choices.demonUuid),
      known = demon.flags?.[SYSTEM_ID]?.demonTrueName;
    if (known && known !== choices.trueName)
      throw new RuleError('The stated name is not this demon’s recorded true name.');
  }
}
async function prepareSpiritRitual(operation, context, configuration) {
  await validateSpiritRitual(context);
  return {
    plans: [],
    execute: () =>
      ritualTransaction(async (tx) => {
        const casterToken = localToken(context.choices.casterTokenUuid);
        if (operation.type === 'spiritSeance') {
          const profile = await foundry.utils.fromUuid(context.choices.specterProfileUuid),
            ids = [...new Set([operation.deceasedUuid, ...(context.choices.bloodlineUuids ?? [])])],
            spirits = [];
          for (let index = 0; index < ids.length; index++) {
            const deceased = await foundry.utils.fromUuid(ids[index]);
            const created = await spawnRitualProfile(profile, context, tx, casterToken, {
              hostile: true,
              radius: 2,
              index,
              count: ids.length,
              state: {
                deceasedUuid: deceased.uuid,
                retainsMemories: true,
                canDepartVoluntarily: true,
                uninvitedEffectId: context.choices.uninvitedEffectId,
                afflictedActorUuid: context.actor.uuid,
              },
            });
            await tx.update(created.actor, { name: `Spirit of ${deceased.name}` });
            spirits.push(created.actor.uuid);
          }
          const message = await tx.created(
            await chat(
              context.actor,
              'Spirit Seance',
              '<p>The actual spirits have appeared with their memories and sentience. They may leave voluntarily or be killed. Every summoned specter can try possession.</p><button data-ritual-spirit="possess">Attempt possession (GM)</button><button data-ritual-spirit="depart">Spirit departs (GM)</button>',
              {
                flags: {
                  kind: 'ritual-spirits',
                  castId: context.castId,
                  actorUuid: context.actor.uuid,
                  spiritUuids: spirits,
                },
              }
            )
          );
          return { spiritUuids: spirits, messageUuid: message.uuid };
        }
        if (operation.type === 'demonSummon') {
          const profile = await foundry.utils.fromUuid(operation.actorProfileUuid);
          const created = await spawnRitualProfile(profile, context, tx, casterToken, {
            hostile: true,
            radius: 2,
            state: { species: context.choices.demonSpecies, trueName: operation.trueName, unbound: true },
          });
          const protectedByMantle = goatMantleProtection(context.actor, context.choices.demonSpecies);
          const world = await executeWorldMagic(
            {
              type: 'narrative',
              procedure:
                'Resolve this actual unbound demon’s immediate arrival and printed offering/deal. It is not controlled by the summoner.',
              demonUuid: created.actor.uuid,
              species: context.choices.demonSpecies,
              protectedByMantle,
              immediateArrival: protectedByMantle
                ? 'Goat Skin Mantle prevents the printed immediate summoning consequence.'
                : 'Resolve the printed immediate Bes possession, Casglydd claw-drag, or Mari Lwyd offering claim before other actions.',
              adjudicator: 'gm',
            },
            worldContext(context, configuration)
          );
          // Include the already-created world decision in this transaction’s compensation.
          tx.compensate(world.rollback);
          return { demonUuid: created.actor.uuid, pendingArrival: true };
        }
        const demon = await foundry.utils.fromUuid(operation.demonUuid),
          original = await foundry.utils.fromUuid(context.choices.cageRegionUuid),
          data = clone(original.toObject());
        delete data._id;
        const center = {
          x: original.bounds.x + original.bounds.width / 2,
          y: original.bounds.y + original.bounds.height / 2,
        };
        const tokenData = (
          await demon.getTokenDocument({
            x: center.x,
            y: center.y,
            actorLink: true,
            level: casterToken.level,
            elevation: casterToken.elevation,
            disposition: -1,
          })
        ).toObject();
        const [token] = await casterToken.parent.createEmbeddedDocuments('Token', [tokenData]);
        await tx.created(token);
        data.name = 'Ritual of Binding · cage';
        data.behaviors = [{ name: data.name, type: RITUAL_REGION_BEHAVIOR, system: {} }];
        data.flags = {
          [SYSTEM_ID]: {
            ritualArea: {
              key: context.magic.key,
              type: 'demonCage',
              active: true,
              castId: context.castId,
              casterUuid: context.actor.uuid,
              casterTokenUuid: casterToken.uuid,
              targetUuid: demon.uuid,
              expiresAt: context.time + 86400,
              createdAt: context.time,
              crossingReceipts: [],
              operation: { ...operation },
            },
          },
        };
        const [region] = await casterToken.parent.createEmbeddedDocuments('Region', [data]);
        await tx.created(region);
        if (!token.testInsideRegion(region))
          throw new RuleError(
            'The actual demon token does not fit within the drawn summoning circle. Enlarge or reposition the circle before casting.'
          );
        const effect = ritualEffect(context, { duration: seconds(86400) });
        effect.magic.rule = { key: 'demon-cage', regionUuid: region.uuid };
        effect.magic.ritualRegionUuid = region.uuid;
        effect.magic.boundCannotAttack = true;
        const next = addMagicEffect(demon.system, effect);
        await tx.update(demon, { 'system.effects': next.effects, 'system.conditions': next.conditions });
        const message = await tx.created(
          await chat(
            context.actor,
            'Ritual of Binding',
            '<p>The demon is trapped for 24 hours. Resolve actual Verbal Combat to gain an agreement. Only a True Staff of Binding can attack through this cage.</p><button data-ritual-binding="agree">Record won agreement (GM)</button><button data-ritual-binding="call">Call bound demon</button>',
            {
              flags: {
                kind: 'ritual-binding',
                castId: context.castId,
                actorUuid: context.actor.uuid,
                demonUuid: demon.uuid,
                regionUuid: region.uuid,
                castingTotal: context.check.total,
                cageUntil: context.time + 86400,
                agreed: false,
              },
            }
          )
        );
        return { demonUuid: demon.uuid, regionUuid: region.uuid, messageUuid: message.uuid };
      }).then((result) => (operation.type === 'demonSummon' ? { ...result, status: 'pendingGM' } : result)),
  };
}
async function spiritCommand(
  { messageUuid, action, spiritUuid, targetUuid, bonus = 0, evidence = '', departureReason = 'voluntary' },
  { user }
) {
  if (!user.isGM) throw new RuleError('The GM controls the summoned spirit.');
  const message = await foundry.utils.fromUuid(messageUuid),
    data = message?.flags?.[SYSTEM_ID],
    spirit = await foundry.utils.fromUuid(spiritUuid);
  if (
    data?.kind !== 'ritual-spirits' ||
    !data.spiritUuids.includes(spiritUuid) ||
    spirit?.flags?.[SYSTEM_ID]?.ritualCreature?.castId !== data.castId
  )
    throw new RuleError('Choose a spirit from this actual seance.');
  if (action === 'depart') {
    if (!String(evidence).trim() || !['voluntary', 'killed', 'banished'].includes(departureReason))
      throw new RuleError('Record the spirit’s voluntary departure, defeat or banishment.');
    return ritualTransaction(async (tx) => {
      await tx.update(spirit, { [`flags.${SYSTEM_ID}.ritualCreature.departed`]: true });
      for (const scene of list(game.scenes))
        for (const token of list(scene.tokens))
          if (token.actor?.uuid === spirit.uuid) await tx.update(token, { hidden: true });
      for (const actor of allRitualActors()) {
        const next = removeMagicEffects(actor.system, (effect) => effect.magic?.spiritUuid === spiritUuid);
        if (next.removed.length)
          await tx.update(actor, { 'system.effects': next.effects, 'system.conditions': next.conditions });
      }
      const guest = spirit.flags[SYSTEM_ID].ritualCreature;
      if (guest.uninvitedEffectId && ['killed', 'banished'].includes(departureReason)) {
        const afflicted = await foundry.utils.fromUuid(guest.afflictedActorUuid);
        if (afflicted) {
          const next = removeMagicEffects(
            afflicted.system,
            (effect) => effect.id === guest.uninvitedEffectId && effect.magic?.uninvitedGuest
          );
          await tx.update(afflicted, {
            'system.effects': next.effects,
            'system.conditions': next.conditions,
          });
        }
      }
      return { spiritUuid, departed: true, evidence };
    });
  }
  const target = await foundry.utils.fromUuid(targetUuid);
  if (!target?.skillBase || ![0, 5, 10].includes(bonus) || (bonus && !String(evidence).trim()))
    throw new RuleError(
      'Choose an actual possession target and printed +5 principles / +10 suicidal bonus when applicable.'
    );
  const attack = await check(spirit.skillBase('spellCasting').total, {
      actor: spirit,
      context: { skill: 'spellCasting' },
    }),
    defense = await check(target.skillBase('resistMagic', { modifier: bonus }).total, {
      actor: target,
      context: { skill: 'resistMagic', dc: attack.total },
    }),
    success = !attack.fumble && (defense.fumble || attack.total > defense.total);
  const interval = success ? await dice('1d6') : null;
  return ritualTransaction(async (tx) => {
    if (success) {
      const effect = {
        id: foundry.utils.randomID(),
        key: 'Spirit Possession',
        expires: 0,
        notes:
          'Repeat Resist Magic against the original total every rolled 1d6 rounds; +5 against principles, +10 suicidal.',
        magic: {
          key: 'spirit-possession',
          castId: data.castId,
          casterUuid: spirit.uuid,
          spiritUuid,
          controlled: true,
          castingTotal: attack.total,
          repeatSeconds: interval.total * 3,
          nextSaveAt: worldNow() + interval.total * 3,
          addedConditions: [],
        },
      };
      const next = addMagicEffect(target.system, effect);
      await tx.update(target, { 'system.effects': next.effects, 'system.conditions': next.conditions });
    }
    await tx.created(
      await chat(
        spirit,
        'Spirit possession',
        checkHTML(attack) +
          checkHTML(defense) +
          `<p>${success ? 'The spirit controls the target until a successful repeat save.' : 'The target resists possession.'}</p>`,
        { rolls: [...attack.rolls, ...defense.rolls, ...(interval ? [interval] : [])] }
      )
    );
    return { targetUuid, success };
  });
}
async function spiritRepeatCommand({ actorUuid, effectId, bonus = 0, evidence = '' }, { user }) {
  const actor = await authorizedActor(actorUuid, user),
    effect = actor.system.effects.find(
      (entry) => entry.id === effectId && entry.magic?.key === 'spirit-possession'
    );
  if (
    !effect ||
    effect.magic.nextSaveAt > worldNow() ||
    ![0, 5, 10].includes(bonus) ||
    (bonus && (!user.isGM || !String(evidence).trim()))
  )
    throw new RuleError('The repeat save is not due, or the GM must confirm its special bonus.');
  const result = await check(actor.skillBase('resistMagic', { modifier: bonus }).total, {
      actor,
      context: { skill: 'resistMagic', dc: effect.magic.castingTotal },
    }),
    success = !result.fumble && result.total > effect.magic.castingTotal;
  const next = success
    ? removeMagicEffects(actor.system, (entry) => entry.id === effectId)
    : { effects: clone(actor.system.effects), conditions: clone(actor.system.conditions) };
  if (!success) {
    const saved = next.effects.find((entry) => entry.id === effectId);
    saved.magic.nextSaveAt = worldNow() + saved.magic.repeatSeconds;
    delete saved.magic.promptAt;
  }
  return commitActor(
    actor,
    { 'system.effects': next.effects, 'system.conditions': next.conditions },
    [],
    () =>
      chat(
        actor,
        'Spirit possession · repeat save',
        checkHTML(result) + `<p>${success ? 'Possession ends.' : 'The spirit remains in control.'}</p>`,
        { rolls: result.rolls }
      )
  );
}
async function bindingCommand({ messageUuid, action, values = {} }, { user }) {
  const message = await foundry.utils.fromUuid(messageUuid),
    data = message?.flags?.[SYSTEM_ID];
  if (data?.kind !== 'ritual-binding') throw new RuleError('Choose the actual binding receipt.');
  const caster = await authorizedActor(data.actorUuid, user),
    demon = await foundry.utils.fromUuid(data.demonUuid);
  if (!demon) throw new RuleError('The named demon is missing.');
  if (action === 'agree') {
    if (
      !user.isGM ||
      data.agreed ||
      data.cageUntil <= worldNow() ||
      !String(values.agreement ?? '').trim() ||
      (!String(values.verbalCombatEvidence ?? '').trim() && !values.socialMessageUuid)
    )
      throw new RuleError(
        'Before the cage expires, the GM records the actual won Verbal Combat and agreement.'
      );
    let socialReceipt = null;
    if (values.socialMessageUuid) {
      const { validatedSocialVictory } = await import('./social-runtime.js');
      socialReceipt = await validatedSocialVictory(values.socialMessageUuid, {
        winnerUuid: caster.uuid,
        loserUuid: demon.uuid,
        goal: values.agreement,
      });
      if (socialReceipt.time < data.cageUntil - 86400 || socialReceipt.time > worldNow())
        throw new RuleError('The Verbal Combat victory must occur during this binding cage.');
    }
    return ritualTransaction(async (tx) => {
      await tx.update(demon, {
        [`flags.${SYSTEM_ID}.demonBinding`]: {
          active: true,
          castId: data.castId,
          casterUuid: caster.uuid,
          castingTotal: data.castingTotal,
          agreement: values.agreement,
          evidence: values.verbalCombatEvidence,
          socialReceipt,
          nextEscapeAt: worldNow() + 1209600,
          messageUuid,
        },
      });
      await tx.update(message, { [`flags.${SYSTEM_ID}.agreed`]: true });
      return { demonUuid: demon.uuid, agreement: values.agreement };
    });
  }
  const state = demon.flags?.[SYSTEM_ID]?.demonBinding;
  if (action !== 'call' || !state?.active || state.castId !== data.castId)
    throw new RuleError('This demon has no active binding.');
  const token = localToken(values.tokenUuid);
  if (token?.actor?.uuid !== caster.uuid) throw new RuleError('Choose the binder’s actual token.');
  return ritualTransaction(async (tx) => {
    for (const scene of list(game.scenes))
      for (const old of list(scene.tokens))
        if (old.actor?.uuid === demon.uuid) await tx.update(old, { hidden: true });
    const point = magicTokenOrigin(token),
      tokenData = (
        await demon.getTokenDocument({
          x: point.x,
          y: point.y,
          elevation: token.elevation,
          level: token.level,
          actorLink: true,
          hidden: false,
        })
      ).toObject();
    const [summoned] = await token.parent.createEmbeddedDocuments('Token', [tokenData]);
    await tx.created(summoned);
    return { tokenUuid: summoned.uuid };
  });
}

export function compressedDeathChanges(actor, nextHP) {
  if (!actor.flags?.[SYSTEM_ID]?.artifactCompression?.active || nextHP > 0) return {};
  return {
    'system.conditions': [...new Set([...(actor.system.conditions ?? []), 'dead'])],
    'system.pendingDeathSaves': 0,
    'system.stabilized': false,
  };
}
async function prepareCompression(operation, context) {
  const result = await check(context.target.skillBase('endurance').total, {
    actor: context.target,
    context: { skill: 'endurance', dc: 15 },
  });
  return {
    plans: [],
    rolls: result.rolls,
    execute: () =>
      ritualTransaction(async (tx) => {
        let damageMessage;
        if (result.fumble || result.total <= 15) {
          const { magicDamageCard } = await import('./magic-runtime.js');
          const token = localToken(context.choices.casterTokenUuid),
            targetToken = list(token.parent.tokens).find(
              (entry) => entry.actor?.uuid === context.target.uuid && withinRitualRange(token, entry, 10)
            );
          damageMessage = await tx.created(
            await magicDamageCard(
              context.actor,
              context.target,
              {
                magic: { ...context.magic, defenses: [], effect: {} },
                castId: context.castId,
                itemId: context.castId,
                name: context.magic.name,
                check: context.check,
                tokenUuid: token.uuid,
                resolved: { damageFormula: '6d6', damageType: 'bludgeoning', location: 'torso' },
              },
              { tokenUuid: targetToken.uuid }
            )
          );
        }
        const message = await tx.created(
          await chat(
            context.actor,
            'Artifact Compression',
            checkHTML(result) +
              `<p>${damageMessage ? 'Apply the actual torso damage card before completing compression.' : 'The subject withstands the painful transformation.'}</p><button data-ritual-compression="compress">Complete compression</button><button data-ritual-compression="limb">Break figurine limb</button><button data-ritual-compression="release">Reverse compression</button>`,
            {
              flags: {
                kind: 'ritual-compression',
                castId: context.castId,
                actorUuid: context.actor.uuid,
                targetUuid: context.target.uuid,
                casterTokenUuid: context.choices.casterTokenUuid,
                damageMessageUuid: damageMessage?.uuid,
                createdAt: context.time,
                castingTotal: context.check.total,
                compressed: false,
                released: false,
              },
            }
          )
        );
        if (!damageMessage) await performCompression(context.actor, context.target, message, tx);
        return { messageUuid: message.uuid, damageMessageUuid: damageMessage?.uuid };
      }),
  };
}
async function performCompression(caster, target, message, tx) {
  const data = message.flags[SYSTEM_ID];
  if (target.flags?.[SYSTEM_ID]?.artifactCompression?.active || data.released || data.compressed)
    throw new RuleError('This target has already been compressed or released.');
  const tokens = list(game.scenes)
    .flatMap((scene) => list(scene.tokens))
    .filter((token) => token.actor?.uuid === target.uuid);
  const original = {
    hp: clone(target.system.hp),
    hpOverride: target.system.overrides?.hp ?? 0,
    tokens: tokens.map((token) => ({
      uuid: token.uuid,
      width: token.width,
      height: token.height,
      texture: clone(token.texture),
    })),
  };
  const effect = ritualEffect(
    {
      actor: caster,
      magic: magicInfo('artifact-compression'),
      castId: data.castId,
      check: { total: data.castingTotal },
      time: worldNow(),
    },
    { duration: permanent }
  );
  effect.conditions = ['unconscious'];
  effect.magic.noAging = true;
  const next = addMagicEffect(target.system, effect),
    hp = Math.ceil(target.system.hp.value / 5),
    max = Math.ceil(target.system.hp.max / 5);
  if (hp <= 0) next.conditions = [...new Set([...next.conditions, 'dead'])];
  await tx.update(target, {
    'system.effects': next.effects,
    'system.conditions': next.conditions,
    'system.hp.value': hp,
    'system.overrides.hp': max,
    [`flags.${SYSTEM_ID}.artifactCompression`]: {
      active: true,
      castId: data.castId,
      casterUuid: caster.uuid,
      effectId: effect.id,
      original,
      severed: [],
      messageUuid: message.uuid,
    },
  });
  for (const token of tokens)
    await tx.update(token, {
      width: Math.max(0.1, token.width / 10),
      height: Math.max(0.1, token.height / 10),
      'texture.tint': '#6ba982',
    });
  await tx.update(message, { [`flags.${SYSTEM_ID}.compressed`]: true });
}
async function compressionCommand({ messageUuid, action, values = {} }, { user }) {
  if (!user.isGM) throw new RuleError('The GM resolves physical changes to a compressed creature.');
  const message = await foundry.utils.fromUuid(messageUuid),
    data = message?.flags?.[SYSTEM_ID];
  if (data?.kind !== 'ritual-compression' || data.released)
    throw new RuleError('This compression receipt is no longer active.');
  const caster = await foundry.utils.fromUuid(data.actorUuid),
    target = await foundry.utils.fromUuid(data.targetUuid);
  if (!caster || !target) throw new RuleError('The caster or subject no longer exists.');
  return ritualTransaction(async (tx) => {
    if (action === 'compress') {
      if (data.damageMessageUuid) {
        const damage = await foundry.utils.fromUuid(data.damageMessageUuid);
        if (!damage?.flags?.[SYSTEM_ID]?.applied)
          throw new RuleError('Apply the pending 6d6 torso damage first.');
      }
      const source = localToken(data.casterTokenUuid);
      if (
        !source ||
        !list(source.parent.tokens).some(
          (token) => token.actor?.uuid === target.uuid && withinRitualRange(source, token, 10)
        )
      )
        throw new RuleError('The subject is no longer within ten metres.');
      await performCompression(caster, target, message, tx);
    } else {
      const state = clone(target.flags?.[SYSTEM_ID]?.artifactCompression);
      if (!state?.active || state.castId !== data.castId)
        throw new RuleError('The subject is no longer compressed by this ritual.');
      if (action === 'limb') {
        const location = hitLocations(target.system).find((entry) => entry.id === values.location);
        if (!location || location.group === 'torso' || state.severed.includes(location.id))
          throw new RuleError('Choose an intact actual limb or head.');
        let success = false,
          result;
        if (values.method === 'damage') {
          const damage = await foundry.utils.fromUuid(values.damageMessageUuid),
            packet = damage?.flags?.[SYSTEM_ID];
          if (
            packet?.kind !== 'damage' ||
            !packet.applied ||
            packet.targetUuid !== target.uuid ||
            !String(values.evidence ?? '').trim()
          )
            throw new RuleError(
              'Select an applied damage receipt and record the actual 5+ damage to this limb.'
            );
          if (
            !(packet.summary ?? []).some(
              (row) => row.location?.id === location.id && !row.nonlethal && row.damage >= 5
            )
          )
            throw new RuleError(
              'The applied receipt must record at least 5 HP damage to this exact figurine limb.'
            );
          success = true;
        } else {
          const breaker = await foundry.utils.fromUuid(values.breakerUuid);
          if (!breaker?.skillBase)
            throw new RuleError('Choose the creature actually trying to break the figurine.');
          result = await check(breaker.skillBase('physique').total, {
            actor: breaker,
            context: { skill: 'physique', dc: 14 },
          });
          success = !result.fumble && result.total > 14;
          await tx.created(
            await chat(
              breaker,
              'Break compressed limb',
              checkHTML(result) +
                `<p>${success ? 'The figurine limb snaps off.' : 'The limb remains intact.'}</p>`,
              { rolls: result.rolls }
            )
          );
        }
        if (success) {
          state.severed.push(location.id);
          await tx.update(target, {
            [`flags.${SYSTEM_ID}.artifactCompression`]: state,
            ...(location.group === 'head'
              ? {
                  'system.hp.value': 0,
                  'system.conditions': [...new Set([...target.system.conditions, 'dead'])],
                  'system.pendingDeathSaves': 0,
                }
              : {}),
          });
        }
      } else if (action === 'release') {
        if (
          !Number.isFinite(Number(values.hp)) ||
          Number(values.hp) > state.original.hp.max ||
          !String(values.ruling ?? '').trim()
        )
          throw new RuleError(
            'Record the GM’s restored HP amount and ruling: the book gives no formula for converting figurine damage back to normal HP.'
          );
        const { criticalWound } = await import('./wounds.js'),
          { woundItemData } = await import('./wound-catalog.js');
        const next = removeMagicEffects(target.system, (effect) => effect.id === state.effectId);
        let hp = Number(values.hp);
        for (const locationId of state.severed) {
          const location = hitLocations(target.system).find((entry) => entry.id === locationId);
          if (location?.group === 'head') continue;
          const critical = criticalWound('deadly', hitLocations(target.system), { aimed: locationId });
          const [wound] = await target.createEmbeddedDocuments('Item', [woundItemData(critical.wound)]);
          await tx.created(wound);
          hp -= critical.bonus;
        }
        const dead = target.system.conditions.includes('dead') || target.system.hp.value <= 0;
        await tx.update(target, {
          'system.effects': next.effects,
          'system.conditions': [...new Set([...next.conditions, 'stunned', ...(dead ? ['dead'] : [])])],
          'system.overrides.hp': state.original.hpOverride,
          'system.hp.value': dead ? Math.min(0, hp) : hp,
          'system.pendingDeathSaves': dead
            ? 0
            : hp <= 0
              ? Number(target.system.pendingDeathSaves ?? 0) + 1
              : target.system.pendingDeathSaves,
          [`flags.${SYSTEM_ID}.artifactCompression`]: {
            ...state,
            active: false,
            releasedAt: worldNow(),
            hpRuling: values.ruling,
          },
        });
        for (const original of state.original.tokens) {
          const token = await foundry.utils.fromUuid(original.uuid);
          if (token)
            await tx.update(token, {
              width: original.width,
              height: original.height,
              texture: original.texture,
            });
        }
        await tx.update(message, { [`flags.${SYSTEM_ID}.released`]: true });
      } else throw new RuleError('Unknown compression action.');
    }
    return { messageUuid, action };
  });
}

/** Shared with activity/verbal-combat validation; animation does not resurrect the corpse. */
export function ritualActionRestriction(actor, action) {
  if (
    (actor.system.effects ?? []).some((entry) => entry.magic?.boundCannotAttack) &&
    ['attack', 'move'].includes(action)
  )
    return 'The Ritual of Binding cage prevents the demon escaping or attacking.';
  const effect = (actor.system.effects ?? []).find((entry) => entry.magic?.rule?.key === 'reanimated-corpse');
  if (!effect) return null;
  if (['move', 'torture', 'torment'].includes(action)) return `Reanimate Corpse prevents ${action}.`;
  return null;
}

export function spellJarRow(face, convention) {
  if (!Number.isInteger(face) || face < 1 || face > 10)
    throw new RuleError('Spell Jar requires a genuine d10 face.');
  if (convention === 'odd-up') return Math.ceil(face / 2);
  if (convention === 'odd-down-minimum-one') return Math.max(1, Math.floor(face / 2));
  throw new RuleError('The GM must select an explicit table convention for the printed ambiguous 1d10/2.');
}

async function ritualJarSelect({ actorUuid, itemId, convention, reason }, { user }) {
  if (!user.isGM || !String(reason ?? '').trim())
    throw new RuleError('The GM records the Spell Jar row-mapping convention.');
  const actor = await authorizedActor(actorUuid, user),
    item = actor.items.get(itemId),
    state = item?.flags?.[SYSTEM_ID]?.ritualArtifact;
  if (state?.key !== 'spell-jar' || item.system.quantity <= 0 || state.expiresAt <= worldNow())
    throw new RuleError('This jar is missing, expended or expired.');
  if (state.selection) return state.selection;
  for (const key of JAR_SPELLS)
    if (!IMPLEMENTED_MAGIC.has(key)) throw new RuleError(`Jar outcome ${key} is not yet operational.`);
  const die = await dice('1d10'),
    row = spellJarRow(die.total, convention),
    selection = {
      face: die.total,
      row,
      key: JAR_SPELLS[row - 1],
      convention,
      reason,
      selectedAt: worldNow(),
    };
  await item.update({ [`flags.${SYSTEM_ID}.ritualArtifact.selection`]: selection });
  try {
    await chat(
      actor,
      'Spell Jar · selected outcome',
      `<p>${e(magicInfo(selection.key).name)}; d10 ${selection.face}, row ${row}. ${e(reason)}</p>`,
      { rolls: [die] }
    );
  } catch (error) {
    await item.update({ [`flags.${SYSTEM_ID}.ritualArtifact.selection`]: null });
    throw error;
  }
  return selection;
}
async function ritualJarRelease(payload, { user }) {
  const actor = await authorizedActor(payload.actorUuid, user),
    item = actor.items.get(payload.itemId),
    state = item?.flags?.[SYSTEM_ID]?.ritualArtifact;
  if (!user.isGM) throw new RuleError('The GM confirms the printed jar’s opposition and release location.');
  if (
    state?.key !== 'spell-jar' ||
    !state.selection ||
    state.expiresAt <= worldNow() ||
    item.system.quantity <= 0
  )
    throw new RuleError('This prepared jar is missing, expended or expired.');
  if (!String(payload.ruling ?? '').trim() || !Number.isFinite(payload.checkTotal))
    throw new RuleError(
      'Record the opposition total and ruling; the book does not specify a new casting check for breaking a jar.'
    );
  const { releaseStoredMagic } = await import('./magic-runtime.js');
  const result = await releaseStoredMagic({
    caster: actor,
    magicKey: state.selection.key,
    sourceItemUuid: item.uuid,
    castId: `${state.castId}:jar:${item.id}`,
    checkTotal: payload.checkTotal,
    targetUuids: payload.targetUuids,
    tokenUuid: payload.tokenUuid,
    area: payload.area,
    choices: payload.choices ?? {},
    sourceName: `Spell Jar · ${magicInfo(state.selection.key).name}`,
  });
  try {
    await item.update({
      'system.quantity': item.system.quantity - 1,
      [`flags.${SYSTEM_ID}.ritualArtifact.released`]: {
        messageUuid: result.message.uuid,
        ruling: payload.ruling,
        at: worldNow(),
      },
    });
  } catch (error) {
    await result.rollback();
    throw error;
  }
  return result.receipt;
}

export async function useRitualArtifact(actor, item) {
  const state = item.flags?.[SYSTEM_ID]?.ritualArtifact;
  if (state?.key === 'magical-message') return triggerMagicalMessage(actor, item);
  if (state?.key === 'magical-guestbook')
    return runCommand('magicGuestbookArchive', { actorUuid: actor.uuid, itemId: item.id });
  if (state?.key !== 'spell-jar') throw new RuleError('This ritual artifact has no use control.');
  if (!game.user.isGM) throw new RuleError('The GM must resolve the ambiguous jar selection and opposition.');
  let selection = state.selection;
  if (!selection) {
    const values = await prompt(
      'Spell Jar selection convention',
      '<p>The printed 1d10/2 leaves odd results ambiguous. This choice is an explicit table convention.</p>' +
        input('convention', 'Odd result mapping', {
          options: {
            'odd-up': 'Round odd halves up (equal pairs)',
            'odd-down-minimum-one': 'Round down; minimum row 1',
          },
        }) +
        input('reason', 'GM ruling', { type: 'text' })
    );
    if (!values) return null;
    selection = await runCommand('magicJarSelect', { actorUuid: actor.uuid, itemId: item.id, ...values });
  }
  const magic = magicInfo(selection.key),
    token = globalThis.canvas?.tokens?.controlled
      ?.map((entry) => entry.document)
      .find((entry) => entry.actor?.uuid === actor.uuid);
  if (!token) throw new RuleError('Control the holder token at the actual point where the jar breaks.');
  const { magicChoiceFields, readMagicChoices } = await import('./magic-choices.js'),
    { magicAreaSpec } = await import('./magic-runtime.js');
  const values = await prompt(
    'Break Spell Jar',
    input('checkTotal', 'GM opposition total', { value: 0 }) +
      input('ruling', 'Reason for this opposition and break point', { type: 'text' }) +
      magicChoiceFields(magic, actor, [...game.user.targets][0]?.actor)
  );
  if (!values) return null;
  const choices = readMagicChoices(magic, values),
    spec = magicAreaSpec(actor, magic, magic.cost.min, choices),
    area = spec ? await previewMagicRegion({ casterToken: token, spec, name: magic.name }) : null;
  if (spec && !area) return null;
  return runCommand('magicJarRelease', {
    actorUuid: actor.uuid,
    itemId: item.id,
    tokenUuid: token.uuid,
    targetUuids: [...game.user.targets].map((entry) => entry.document.uuid),
    area,
    choices,
    checkTotal: Number(values.checkTotal),
    ruling: values.ruling,
  });
}

/** Real special mishaps are prepared before resources commit; arbitrary story details remain GM decisions. */
export async function prepareRitualSpecialMishap(context, configuration = {}) {
  const rolls = [],
    plans = [],
    executors = [];
  const actualFumble = Number(context.check?.fumble ?? 0);
  let restlessRoll;
  if (necromancy.has(context.magic.key)) {
    const die = await dice('1d10');
    rolls.push(die);
    restlessRoll = die.total + (context.adjustments?.restlessModifier ?? 0);
  }
  const result = ritualMishapPlan(context.magic, {
    fumble: actualFumble,
    ritualCost: context.cost.staCost,
    overdraw:
      context.cost.elementalBacklash ||
      context.adjustments?.gatewayTriggerFaces?.includes(context.check?.dice?.[0]),
    restlessRoll,
  });
  let state = clone(context.actorState);
  if (result.damage) {
    const hp = Number(state.hp.value) - result.damage;
    plans.push({
      actor: context.actor,
      changes: {
        'system.hp.value': hp,
        ...(hp <= 0 ? { 'system.pendingDeathSaves': Number(state.pendingDeathSaves ?? 0) + 1 } : {}),
      },
    });
    state.hp.value = hp;
  }
  for (const operation of result.operations) {
    if (operation.type === 'gateway') {
      const effect = ritualEffect(context, { duration: seconds(operation.duration) });
      effect.key = 'Gateway to the Dead';
      effect.magic.key = 'gateway-to-the-dead';
      effect.magic.necromancyBonus = operation.necromancyBonus;
      effect.magic.triggerFaces = operation.triggerFaces;
      const next = addMagicEffect(state, effect);
      Object.assign(state, next);
      plans.push({
        actor: context.actor,
        changes: { 'system.effects': next.effects, 'system.conditions': next.conditions },
      });
    } else if (operation.type === 'wraiths') {
      const die = await dice(operation.countFormula);
      rolls.push(die);
      const world = worldContext(context, configuration);
      if (!world.scene || !world.casterToken)
        throw new RuleError('Necromantic mishaps need the actual caster token on a scene.');
      const scale = magicSceneScale(world.scene);
      for (let index = 0; index < die.total; index++) {
        const angle = (index / die.total) * Math.PI * 2;
        const point = {
          ...world.point,
          x: world.point.x + 3 * scale.pixelsPerMetre * Math.cos(angle),
          y: world.point.y + 3 * scale.pixelsPerMetre * Math.sin(angle),
        };
        executors.push(() =>
          executeWorldMagic(
            {
              type: 'summon',
              profile: 'wraith',
              count: 1,
              controllable: false,
              disposition: 'hostileToEveryone',
              directive: 'Attack the nearest living creature.',
              duration: permanent,
            },
            { ...world, point }
          )
        );
      }
    } else if (operation.type === 'explosion') {
      const world = worldContext(context, configuration);
      if (!world.scene || !world.casterToken)
        throw new RuleError('The standing-stone explosion needs the actual ritual scene.');
      executors.push(() =>
        ritualTransaction(async (tx) => {
          const { magicDamageCard } = await import('./magic-runtime.js');
          const stone = await foundry.utils.fromUuid(context.choices.stoneRegionUuid);
          if (stone)
            await tx.update(stone, {
              [`flags.${SYSTEM_ID}.magicSource`]: null,
              [`flags.${SYSTEM_ID}.destroyedStandingStone`]: { castId: context.castId, at: context.time },
            });
          const targets = list(world.scene.tokens).filter(
            (token) => token.actor && withinRitualRange(world.casterToken, token, 6)
          );
          for (const token of targets)
            await tx.created(
              await magicDamageCard(
                context.actor,
                token.actor,
                {
                  magic: { ...context.magic, defenses: [], effect: {} },
                  name: `${context.magic.name} · exploding stone`,
                  itemId: context.castId,
                  castId: context.castId,
                  check: context.check,
                  tokenUuid: world.casterToken.uuid,
                  resolved: { damageFormula: '7d6', damageType: 'bludgeoning', location: 'torso' },
                  operationProperties: { allLocations: true, environmental: true },
                },
                { tokenUuid: token.uuid }
              )
            );
          return { explosion: true, targets: targets.map((token) => token.uuid) };
        })
      );
    } else {
      executors.push(() =>
        ritualTransaction(async (tx) => {
          const message = await chat(
            context.actor,
            `${context.magic.name} · ${operation.type}`,
            `<p>${e(operation.type === 'elementalBacklash' ? 'Record the elemental backlash chosen for this ritual, then apply its actual condition or movement.' : operation.type === 'uninvitedGuest' ? 'An uninvited spirit afflicts the caster with a GM-chosen hex. Ordinary lifting does not remove it; summon the spirit with a blood-free Spirit Seance and kill or banish it.' : operation.type === 'haunting' ? 'Mark the haunted area and its unresolved wrong. Wraiths appear there now and return each following night until the wrong is righted.' : 'A Penitent appears within five metres, pursues the caster and returns each night until killed, banished, or the caster dies.')}</p><button data-ritual-mishap>Resolve consequence (GM)</button>${operation.type === 'haunting' ? '<button data-restless-night>Next night / resolve haunting</button>' : ''}`,
            {
              whisper: list(game.users)
                .filter((user) => user.isGM)
                .map((user) => user.id),
              flags: {
                kind: 'ritual-mishap',
                castId: context.castId,
                actorUuid: context.actor.uuid,
                tokenUuid: context.choices.casterTokenUuid,
                operation,
                resolved: false,
              },
            }
          );
          await tx.created(message);
          return { messageUuid: message.uuid, pending: operation.type };
        }).then((result) => ({ ...result, status: 'pendingGM' }))
      );
    }
  }
  return { plans, rolls, execute: () => executeMany(executors) };
}

export function ritualNecromancyBonuses(actor, casterToken) {
  const gateway = (actor.system.effects ?? []).some(
    (effect) =>
      effect.magic?.key === 'gateway-to-the-dead' && (!effect.expires || effect.expires > worldNow())
  );
  const sources = casterToken
    ? list(casterToken.parent.tokens).filter((token) => {
        const state = token.actor?.flags?.[SYSTEM_ID]?.ritualStructure;
        return (
          state?.key === 'create-soul-beacon' &&
          token.actor.system.hp.value > 0 &&
          state.expiresAt > worldNow() &&
          withinRitualRange(casterToken, token, 6)
        );
      })
    : [];
  const selectedUuid = actor.flags?.[SYSTEM_ID]?.soulBeaconUuid;
  const selected =
    sources.find((token) => token.actor.uuid === selectedUuid) ?? (sources.length === 1 ? sources[0] : null);
  if (sources.length > 1 && !selected)
    throw new RuleError(
      'Only one Soul Beacon may benefit this cast. Select an actual nearby beacon through its control card.'
    );
  const human = selected?.actor.flags[SYSTEM_ID].ritualStructure.skullType === 'humanElderfolk';
  const beast = selected?.actor.flags[SYSTEM_ID].ritualStructure.skullType === 'beastMonster';
  return {
    checkModifier: gateway ? 2 : 0,
    gatewayTriggerFaces: gateway ? [1, 2, 3] : [],
    ritualDCModifier: human ? -3 : 0,
    ritualCostModifier: human ? -3 : 0,
    restlessModifier: human ? -2 : 0,
    creatureBonus: beast ? 2 : 0,
    dreamSenses: beast,
  };
}

async function ritualMishapCommand({ messageUuid, values = {} }, { user }) {
  if (!user.isGM) throw new RuleError('The GM resolves a special ritual consequence.');
  const message = await foundry.utils.fromUuid(messageUuid),
    state = message?.flags?.[SYSTEM_ID];
  if (state?.kind !== 'ritual-mishap' || state.resolved)
    throw new RuleError('This consequence has already been resolved.');
  const actor = await authorizedActor(state.actorUuid, user),
    operation = state.operation;
  return ritualTransaction(async (tx) => {
    if (operation.type === 'elementalBacklash') {
      const backlash = elementalBacklash(values.element);
      if (backlash.needsElement) throw new RuleError('Select the actual element.');
      if (backlash.condition) {
        const effect = {
          id: foundry.utils.randomID(),
          key: 'Ritual elemental backlash',
          conditions: [backlash.condition],
          expires: 0,
          magic: {
            key: 'ritual-backlash',
            castId: state.castId,
            casterUuid: actor.uuid,
            addedConditions: [],
          },
        };
        const next = addMagicEffect(actor.system, effect);
        await tx.update(actor, { 'system.effects': next.effects, 'system.conditions': next.conditions });
      }
      if (backlash.pushMeters) {
        const token = localToken(state.tokenUuid);
        if (!token || !Number.isFinite(Number(values.angle)))
          throw new RuleError('Choose the actual caster token and air-push direction.');
        const before = { x: token.x, y: token.y, elevation: token.elevation };
        const { pushMagicToken } = await import('./magic-runtime.js');
        await tx.update(token, before); // captures the position for compensation before the public movement API
        await pushMagicToken(token, 2, Number(values.angle), `ritual:${state.castId}:backlash`);
      }
    } else if (operation.type === 'uninvitedGuest') {
      const magic = magicInfo(values.hexKey);
      if (magic?.kind !== 'hex') throw new RuleError('Select a catalog hex.');
      const effect = hexEffectData(magic, {
        id: foundry.utils.randomID(),
        castId: state.castId,
        casterUuid: actor.uuid,
        checkTotal: 0,
        createdAt: worldNow(),
      });
      effect.magic.uninvitedGuest = true;
      effect.magic.spiritSourceMessageUuid = message.uuid;
      const next = addMagicEffect(actor.system, effect);
      await tx.update(actor, { 'system.effects': next.effects, 'system.conditions': next.conditions });
    } else {
      const token = localToken(state.tokenUuid),
        profile = await foundry.utils.fromUuid(values.profileUuid);
      if (!token || !profile?.system || profile.type !== 'monster')
        throw new RuleError('Choose the actual printed creature Actor profile and caster token.');
      if (!String(values.sourceEvidence ?? '').trim())
        throw new RuleError('Record the source page and chosen creature profile.');
      const region = operation.type === 'haunting' ? await foundry.utils.fromUuid(values.regionUuid) : null;
      if (
        operation.type === 'haunting' &&
        (!region || region.parent?.id !== token.parent.id || !String(values.removalCondition ?? '').trim())
      )
        throw new RuleError('Select the actual haunted Region and the wrong that must be righted.');
      const die =
        operation.type === 'haunting'
          ? await dice({ tame: '2d6', normal: '5d6', horrible: '7d6' }[values.severity] ?? '5d6')
          : null;
      const count = die?.total ?? 1;
      for (let index = 0; index < count; index++)
        await spawnRitualProfile(
          profile,
          { actor, castId: state.castId, magic: { key: `restless-${operation.type}` }, time: worldNow() },
          tx,
          token,
          {
            hostile: true,
            radius: 3,
            index,
            count,
            state: {
              returnsNightly: true,
              targetUuid: actor.uuid,
              hauntedRegionUuid: region?.uuid,
              sourceMessageUuid: message.uuid,
            },
          }
        );
      if (region)
        await tx.update(region, {
          [`flags.${SYSTEM_ID}.ritualHaunting`]: {
            castId: state.castId,
            casterUuid: actor.uuid,
            profileUuid: profile.uuid,
            count,
            removalCondition: values.removalCondition,
            sourceEvidence: values.sourceEvidence,
            active: true,
            lastNight: '',
          },
        });
    }
    await tx.update(message, {
      [`flags.${SYSTEM_ID}.resolved`]: true,
      [`flags.${SYSTEM_ID}.resolution`]: clone(values),
    });
    return { messageUuid };
  });
}

async function spawnRitualProfile(
  profile,
  context,
  tx,
  casterToken,
  { hostile = false, radius = 0, index = 0, count = 1, state = {}, changes = {} } = {}
) {
  const data = clone(profile.toObject());
  delete data._id;
  for (const item of data.items ?? []) delete item._id;
  data.ownership = hostile ? { default: 0 } : clone(context.actor.ownership ?? {});
  data.flags = {
    ...data.flags,
    [SYSTEM_ID]: {
      ...data.flags?.[SYSTEM_ID],
      ritualCreature: {
        key: context.magic.key,
        castId: context.castId,
        casterUuid: context.actor.uuid,
        createdAt: context.time,
        ...state,
      },
    },
  };
  const actor = await tx.created(await Actor.create(data));
  if (Object.keys(changes).length) await tx.update(actor, changes);
  const point = magicTokenOrigin(casterToken),
    pixels = magicSceneScale(casterToken.parent).pixelsPerMetre;
  const angle = (index / count) * 2 * Math.PI;
  const tokenData = (
    await actor.getTokenDocument({
      x: point.x + radius * pixels * Math.cos(angle),
      y: point.y + radius * pixels * Math.sin(angle),
      elevation: point.elevation,
      level: casterToken.level,
      actorLink: true,
      disposition: hostile ? -1 : casterToken.disposition,
    })
  ).toObject();
  const [token] = await casterToken.parent.createEmbeddedDocuments('Token', [tokenData]);
  await tx.created(token);
  return { actor, token };
}

/** A scene trigger is confirmed by its GM; no automatic detection is claimed for arbitrary prose triggers. */
export function registerRitualArtifactCommands() {
  registerCommand('magicRitualMishap', ritualMishapCommand);
  registerCommand('magicSoulBeaconChoose', async ({ actorUuid, beaconUuid, tokenUuid }, { user }) => {
    const actor = await authorizedActor(actorUuid, user),
      token = localToken(tokenUuid),
      beacon = await foundry.utils.fromUuid(beaconUuid),
      state = beacon?.flags?.[SYSTEM_ID]?.ritualStructure;
    if (
      state?.key !== 'create-soul-beacon' ||
      state.expiresAt <= worldNow() ||
      beacon.system.hp.value <= 0 ||
      token?.actor?.uuid !== actor.uuid ||
      !list(token.parent.tokens).some(
        (entry) => entry.actor?.uuid === beacon.uuid && withinRitualRange(token, entry, 6)
      )
    )
      throw new RuleError('Choose a live Soul Beacon actually within six metres.');
    return actor.update({ [`flags.${SYSTEM_ID}.soulBeaconUuid`]: beacon.uuid });
  });
  registerCommand(
    'magicMonsterBeacon',
    async ({ beaconUuid, creatureUuids, yearsCompleted, evidence }, { user }) => {
      if (
        !user.isGM ||
        !String(evidence ?? '').trim() ||
        !Number.isInteger(yearsCompleted) ||
        yearsCompleted < 0
      )
        throw new RuleError('The GM records the elapsed calendar years and actual attracted creatures.');
      const beacon = await foundry.utils.fromUuid(beaconUuid),
        state = beacon?.flags?.[SYSTEM_ID]?.ritualStructure;
      if (state?.key !== 'beacon-of-the-unnatural' || beacon.system.hp.value <= 0)
        throw new RuleError('The monster beacon has been destroyed.');
      const creatures = await Promise.all(creatureUuids.map((uuid) => foundry.utils.fromUuid(uuid)));
      if (
        !creatures.length ||
        creatures.some(
          (actor) =>
            actor?.type !== 'monster' || ['beast', 'humanoid', 'object'].includes(actor.system.category)
        )
      )
        throw new RuleError('Choose actual monster Actors drawn to this beacon.');
      return ritualTransaction(async (tx) => {
        for (const actor of creatures) {
          const effect = {
            id: foundry.utils.randomID(),
            key: 'Beacon of the Unnatural · nesting attraction',
            expires: 0,
            notes: `Attracted within ${1 + yearsCompleted} miles. ${evidence}`,
            magic: {
              key: 'beacon-attraction',
              beaconUuid,
              castId: state.castId,
              casterUuid: state.casterUuid,
            },
          };
          const next = addMagicEffect(actor.system, effect);
          await tx.update(actor, { 'system.effects': next.effects, 'system.conditions': next.conditions });
        }
        await tx.created(
          await chat(
            beacon,
            'Beacon attraction',
            `<p>${1 + yearsCompleted} miles; ${e(evidence)}. Nesting creatures: ${e(creatures.map((actor) => actor.name).join(', '))}.</p>`,
            {
              whisper: list(game.users)
                .filter((entry) => entry.isGM)
                .map((entry) => entry.id),
            }
          )
        );
        return { beaconUuid, creatureUuids };
      });
    }
  );
  Hooks.on('renderChatMessageHTML', (message, html) => {
    if (message.flags?.[SYSTEM_ID]?.kind !== 'ritual-beacon') return;
    for (const button of html.querySelectorAll('[data-ritual-beacon]'))
      button.addEventListener('click', async () => {
        try {
          const beacon = await foundry.utils.fromUuid(message.flags[SYSTEM_ID].actorUuid),
            state = beacon?.flags?.[SYSTEM_ID]?.ritualStructure;
          if (state.key === 'create-soul-beacon') {
            const token = globalThis.canvas?.tokens?.controlled?.[0]?.document;
            if (!token?.actor) throw new RuleError('Control the actual necromancer token.');
            return await runCommand('magicSoulBeaconChoose', {
              actorUuid: token.actor.uuid,
              tokenUuid: token.uuid,
              beaconUuid: beacon.uuid,
            });
          }
          const values = await prompt(
            'Beacon attraction',
            input('yearsCompleted', 'Completed campaign calendar years', { value: 0, min: 0 }) +
              input('evidence', 'GM: proximity, travel and nesting events', { type: 'text' })
          );
          if (values)
            await runCommand('magicMonsterBeacon', {
              beaconUuid: beacon.uuid,
              creatureUuids: [...game.user.targets].map((entry) => entry.actor.uuid),
              yearsCompleted: Number(values.yearsCompleted),
              evidence: values.evidence,
            });
        } catch (error) {
          errorNotice(error);
        }
      });
  });
  registerCommand('magicRitualSpirit', spiritCommand);
  registerCommand('magicSpiritRepeat', spiritRepeatCommand);
  registerCommand('magicRitualBinding', bindingCommand);
  registerCommand('magicRestlessNight', async ({ messageUuid, night, ending, evidence }, { user }) => {
    if (!user.isGM || !String(evidence ?? '').trim() || (!ending && !String(night ?? '').trim()))
      throw new RuleError('The GM records the actual campaign night or the wrong being righted.');
    const message = await foundry.utils.fromUuid(messageUuid),
      data = message?.flags?.[SYSTEM_ID],
      region = await foundry.utils.fromUuid(data?.resolution?.regionUuid),
      haunting = region?.flags?.[SYSTEM_ID]?.ritualHaunting;
    if (!haunting?.active || haunting.lastNight === night)
      throw new RuleError('This haunting ended or this campaign night was already resolved.');
    return ritualTransaction(async (tx) => {
      if (ending) {
        await tx.update(region, {
          [`flags.${SYSTEM_ID}.ritualHaunting.active`]: false,
          [`flags.${SYSTEM_ID}.ritualHaunting.resolution`]: evidence,
        });
        return { ended: true };
      }
      const profile = await foundry.utils.fromUuid(haunting.profileUuid),
        caster = await foundry.utils.fromUuid(haunting.casterUuid),
        source = localToken(data.tokenUuid);
      if (!profile || !caster || !source)
        throw new RuleError('The actual haunt profile or scene source is missing.');
      const live = list(region.parent.tokens).filter(
        (token) =>
          token.actor?.flags?.[SYSTEM_ID]?.ritualCreature?.hauntedRegionUuid === region.uuid &&
          token.actor.system.hp.value > 0 &&
          !token.actor.system.conditions.includes('dead')
      );
      for (let index = live.length; index < haunting.count; index++)
        await spawnRitualProfile(
          profile,
          { actor: caster, castId: haunting.castId, magic: { key: 'restless-haunting' }, time: worldNow() },
          tx,
          source,
          {
            hostile: true,
            index,
            count: haunting.count,
            radius: 3,
            state: { hauntedRegionUuid: region.uuid, sourceMessageUuid: messageUuid },
          }
        );
      await tx.update(region, {
        [`flags.${SYSTEM_ID}.ritualHaunting.lastNight`]: night,
        [`flags.${SYSTEM_ID}.ritualHaunting.nightEvidence`]: evidence,
      });
      return { regionUuid: region.uuid, night };
    });
  });
  Hooks.on('renderChatMessageHTML', (message, html) => {
    const state = message.flags?.[SYSTEM_ID];
    if (state?.kind === 'ritual-spirits')
      for (const button of html.querySelectorAll('[data-ritual-spirit]'))
        button.addEventListener('click', async () => {
          try {
            const action = button.dataset.ritualSpirit,
              spirits = await Promise.all(state.spiritUuids.map((uuid) => foundry.utils.fromUuid(uuid)));
            const values = await prompt(
              'Spirit Seance',
              input('spiritUuid', 'Actual spirit', {
                options: Object.fromEntries(spirits.filter(Boolean).map((actor) => [actor.uuid, actor.name])),
              }) +
                (action === 'possess'
                  ? input('targetUuid', 'Possession target Actor UUID', { type: 'text' }) +
                    input('bonus', 'Printed target resistance bonus', {
                      options: { 0: 'None', 5: 'Against principles +5', 10: 'Suicidal +10' },
                    })
                  : input('departureReason', 'Actual result', {
                      options: {
                        voluntary: 'Voluntary departure',
                        killed: 'Spirit killed',
                        banished: 'Spirit banished',
                      },
                    })) +
                input('evidence', 'GM: actual circumstances', { type: 'text' })
            );
            if (values)
              await runCommand('magicRitualSpirit', {
                messageUuid: message.uuid,
                action,
                ...values,
                bonus: Number(values.bonus ?? 0),
              });
          } catch (error) {
            errorNotice(error);
          }
        });
    if (state?.kind === 'spirit-repeat')
      for (const button of html.querySelectorAll('[data-spirit-repeat]'))
        button.addEventListener('click', async () => {
          const values = await prompt(
            'Spirit resistance',
            input('bonus', 'Printed resistance bonus', {
              options: { 0: 'None', 5: 'Against principles +5', 10: 'Suicidal +10' },
            }) + input('evidence', 'GM confirmation for a special bonus', { type: 'text' })
          );
          if (values)
            runCommand('magicSpiritRepeat', {
              actorUuid: state.actorUuid,
              effectId: state.effectId,
              bonus: Number(values.bonus),
              evidence: values.evidence,
            }).catch(errorNotice);
        });
    if (state?.kind === 'ritual-binding')
      for (const button of html.querySelectorAll('[data-ritual-binding]'))
        button.addEventListener('click', async () => {
          try {
            const action = button.dataset.ritualBinding;
            let values = {};
            if (action === 'agree') {
              values = await prompt(
                'Binding agreement',
                input('agreement', 'Actual binding agreement', { type: 'text' }) +
                  input('socialMessageUuid', 'Completed Verbal Combat', {
                    options: {
                      '': 'Record an externally resolved argument',
                      ...Object.fromEntries(
                        [...game.messages]
                          .filter((entry) => entry.flags?.[SYSTEM_ID]?.kind === 'socialCombat')
                          .map((entry) => [entry.uuid, entry.flags[SYSTEM_ID].name])
                      ),
                    },
                  }) +
                  input('verbalCombatEvidence', 'Completed Verbal Combat receipt / result', { type: 'text' })
              );
              if (!values) return;
            } else {
              const token = globalThis.canvas?.tokens?.controlled?.[0]?.document;
              if (!token) throw new RuleError('Control the binder token.');
              values.tokenUuid = token.uuid;
            }
            await runCommand('magicRitualBinding', { messageUuid: message.uuid, action, values });
          } catch (error) {
            errorNotice(error);
          }
        });
    if (state?.kind === 'ritual-mishap' && state.operation?.type === 'haunting')
      for (const button of html.querySelectorAll('[data-restless-night]'))
        button.addEventListener('click', async () => {
          const values = await prompt(
            'Haunting',
            input('night', 'Unique campaign night label', { type: 'text' }) +
              input('ending', 'The wrong has been righted; end the haunting', { type: 'checkbox' }) +
              input('evidence', 'GM: events and evidence', { type: 'text' })
          );
          if (values)
            runCommand('magicRestlessNight', { messageUuid: message.uuid, ...values }).catch(errorNotice);
        });
  });
  registerCommand('magicCompression', compressionCommand);
  Hooks.on('renderChatMessageHTML', (message, html) => {
    if (message.flags?.[SYSTEM_ID]?.kind !== 'ritual-compression') return;
    for (const button of html.querySelectorAll('[data-ritual-compression]'))
      button.addEventListener('click', async () => {
        try {
          const action = button.dataset.ritualCompression;
          let values = {};
          if (action !== 'compress') {
            const target = await foundry.utils.fromUuid(message.flags[SYSTEM_ID].targetUuid);
            const fields =
              action === 'release'
                ? input('hp', 'Restored normal HP before dismemberment damage', {
                    value: target.flags[SYSTEM_ID].artifactCompression.original.hp.value,
                  }) + input('ruling', 'GM: HP conversion ruling', { type: 'text' })
                : input('location', 'Actual limb', {
                    options: Object.fromEntries(
                      hitLocations(target.system)
                        .filter((entry) => entry.group !== 'torso')
                        .map((entry) => [entry.id, entry.label])
                    ),
                  }) +
                  input('method', 'Method', {
                    options: { physique: 'Physique DC14', damage: 'Applied 5+ damage' },
                  }) +
                  input('breakerUuid', 'Breaker Actor UUID', { type: 'text' }) +
                  input('damageMessageUuid', 'Applied damage ChatMessage UUID', { type: 'text' }) +
                  input('limbDamage', 'Actual limb damage', { value: 5, min: 5 }) +
                  input('evidence', 'GM: damage evidence', { type: 'text' });
            values = await prompt('Artifact Compression', fields);
            if (!values) return;
          }
          await runCommand('magicCompression', { messageUuid: message.uuid, action, values });
        } catch (error) {
          errorNotice(error);
        }
      });
  });
  registerCommand('magicJarSelect', ritualJarSelect);
  registerCommand('magicJarRelease', ritualJarRelease);
  registerCommand('magicGuestbookArchive', async ({ actorUuid, itemId }, { user }) => {
    const actor = await authorizedActor(actorUuid, user),
      item = actor.items.get(itemId),
      state = item?.flags?.[SYSTEM_ID]?.ritualArtifact;
    if (state?.key !== 'magical-guestbook' || magicVigor(actor.system) < 1)
      throw new RuleError('A reader with at least 1 Vigor must hold the actual clay icon.');
    return chat(actor, item.name, guestbookImages(state.visitors), {
      whisper: [
        user.id,
        ...list(game.users)
          .filter((entry) => entry.isGM)
          .map((entry) => entry.id),
      ],
    });
  });
  Hooks.on('renderChatMessageHTML', (message, html) => {
    if (message.flags?.[SYSTEM_ID]?.kind !== 'ritual-mishap') return;
    for (const button of html.querySelectorAll('[data-ritual-mishap]'))
      button.addEventListener('click', async () => {
        const type = message.flags[SYSTEM_ID].operation.type;
        const fields =
          type === 'elementalBacklash'
            ? input('element', 'Element', {
                options: { earth: 'Earth', air: 'Air', fire: 'Fire', water: 'Water' },
              }) + input('angle', 'Air direction in degrees', { value: 0 })
            : type === 'uninvitedGuest'
              ? input('hexKey', 'Uninvited spirit hex', {
                  options: Object.fromEntries(
                    MAGIC.filter((entry) => entry.kind === 'hex').map((entry) => [entry.key, entry.name])
                  ),
                })
              : input('profileUuid', 'Actual creature profile Actor UUID', { type: 'text' }) +
                input('sourceEvidence', 'Source page / chosen profile', { type: 'text' }) +
                (type === 'haunting'
                  ? input('regionUuid', 'Haunted Region UUID', { type: 'text' }) +
                    input('removalCondition', 'Wrong to be righted', { type: 'text' }) +
                    input('severity', 'Haunting severity', {
                      options: { normal: 'Normal (5d6)', tame: 'Tame (2d6)', horrible: 'Horrible (7d6)' },
                    })
                  : '');
        const values = await prompt('Resolve ritual consequence', fields);
        if (values) runCommand('magicRitualMishap', { messageUuid: message.uuid, values }).catch(errorNotice);
      });
  });
  registerCommand('magicTelecommunication', async ({ actorUuid, castId, message }, { user }) => {
    const actor = await authorizedActor(actorUuid, user);
    const source = actor.system.effects.find(
      (effect) =>
        effect.magic?.key === 'telecommunication' &&
        effect.magic.castId === castId &&
        effect.expires > worldNow()
    );
    if (!source) throw new RuleError('This telecommunication ritual has ended.');
    const recipient = await foundry.utils.fromUuid(source.magic.recipientUuid);
    if (
      !recipient?.system.effects.some(
        (effect) =>
          effect.magic?.key === 'telecommunication' &&
          effect.magic.recipientUuid === actor.uuid &&
          effect.expires > worldNow()
      )
    )
      throw new RuleError(
        'The other participant must complete an active reciprocal telecommunication ritual.'
      );
    if (!String(message ?? '').trim()) throw new RuleError('Enter the actual spoken message.');
    const recipients = list(game.users)
      .filter(
        (entry) =>
          entry.isGM ||
          actor.testUserPermission(entry, 'OWNER') ||
          recipient.testUserPermission(entry, 'OWNER')
      )
      .map((entry) => entry.id);
    return chat(actor, `Telecommunication → ${recipient.name}`, `<p>${e(String(message).trim())}</p>`, {
      whisper: recipients,
      flags: { kind: 'ritual-conversation', castId, actorUuid, recipientUuid: recipient.uuid },
    });
  });
  Hooks.on('renderChatMessageHTML', (message, html) => {
    if (message.flags?.[SYSTEM_ID]?.kind !== 'ritual-telecommunication') return;
    for (const button of html.querySelectorAll('[data-ritual-telecommunication]'))
      button.addEventListener('click', async () => {
        const result = await prompt(
          'Telecommunication',
          input('message', 'Spoken message', { type: 'text' }),
          { button: 'Send' }
        );
        if (result)
          runCommand('magicTelecommunication', {
            actorUuid: message.flags[SYSTEM_ID].actorUuid,
            castId: message.flags[SYSTEM_ID].castId,
            message: result.message,
          }).catch(errorNotice);
      });
  });
  registerCommand('magicMessageTrigger', async ({ actorUuid, itemId, triggerIndex, reason }, { user }) => {
    if (!user.isGM || !String(reason ?? '').trim())
      throw new RuleError('The GM must record the actual trigger that activated the message.');
    const actor = await authorizedActor(actorUuid, user),
      item = actor.items.get(itemId),
      artifact = item?.flags?.[SYSTEM_ID]?.ritualArtifact;
    if (!artifact || artifact.key !== 'magical-message' || !(item.system.quantity > 0))
      throw new RuleError('Choose an existing Magical Message artifact.');
    if (!Number.isInteger(triggerIndex) || !artifact.triggers[triggerIndex])
      throw new RuleError('Choose one of this message’s actual triggers.');
    return ChatMessage.create({
      speaker: ChatMessage.getSpeaker({ actor }),
      content: `<h3>${e(item.name)}</h3><p>${e(artifact.message)}</p><p>${e(artifact.triggers[triggerIndex])}: ${e(reason)}</p>`,
      flags: {
        [SYSTEM_ID]: {
          kind: 'ritual-message-playback',
          itemUuid: item.uuid,
          castId: artifact.castId,
          triggerIndex,
        },
      },
    });
  });
}

export async function triggerMagicalMessage(actor, item) {
  const artifact = item.flags?.[SYSTEM_ID]?.ritualArtifact;
  const chosen = await prompt(
    'Play magical message',
    input('triggerIndex', 'Actual trigger', {
      options: Object.fromEntries((artifact?.triggers ?? []).map((trigger, index) => [index, trigger])),
    }) + input('reason', 'GM: how was the trigger fulfilled?', { type: 'text' })
  );
  if (chosen)
    return runCommand('magicMessageTrigger', {
      actorUuid: actor.uuid,
      itemId: item.id,
      triggerIndex: Number(chosen.triggerIndex),
      reason: chosen.reason,
    }).catch(errorNotice);
}

export function goatMantleProtection(actor, species) {
  return list(actor.items).some(
    (item) =>
      item.system.equipped &&
      item.system.carried !== false &&
      item.system.quantity > 0 &&
      item.flags?.[SYSTEM_ID]?.ritualArtifact?.key === 'ritual-of-the-goat-skin' &&
      item.flags[SYSTEM_ID].ritualArtifact.protections?.includes(species)
  );
}

async function prepareRitualEntry({ actor, magic }, configuration) {
  if (magic.key === 'spirit-seance') {
    const effects = actor.system.effects.filter((effect) => effect.magic?.uninvitedGuest);
    if (effects.length) {
      const answer = await prompt(
        'Spirit Seance source',
        input('uninvitedEffectId', 'Contact the spirit of an Uninvited Guest without blood', {
          options: {
            '': 'Ordinary Spirit Seance',
            ...Object.fromEntries(effects.map((effect) => [effect.id, effect.key])),
          },
        })
      );
      if (!answer) return null;
      const token = globalThis.canvas?.tokens?.controlled
        ?.map((entry) => entry.document)
        .find((entry) => entry.actor?.uuid === actor.uuid);
      return { uninvitedEffectId: answer.uninvitedEffectId, casterTokenUuid: token?.uuid };
    }
  }
  if (magic.key === 'animate-armor') {
    const armor = list(actor.items).filter((item) => item.type === 'armor' && item.system.quantity > 0),
      options = Object.fromEntries(armor.map((item) => [item.id, item.name]));
    const selected = await prompt(
      'Animate actual armor',
      input('head', 'Actual head armor', { options }) +
        input('torso', 'Actual torso armor', { options }) +
        input('legs', 'Actual leg armor', { options })
    );
    if (!selected) return null;
    const token = globalThis.canvas?.tokens?.controlled
      ?.map((entry) => entry.document)
      .find((entry) => entry.actor?.uuid === actor.uuid);
    if (!token) throw new RuleError('Control the actual caster token.');
    return { armorItemIds: [selected.head, selected.torso, selected.legs], casterTokenUuid: token.uuid };
  }
  if (magic.key === 'magical-message') {
    const chosen = await prompt(
      'Magical Message materials',
      input('material', 'Printed component option', {
        options: {
          glass: 'Glass, Fifth Essence and Quicksilver Solution',
          gemstone: 'One Perfect Gemstone (lifelike image)',
        },
      })
    );
    return chosen ? { perfectGemstone: chosen.material === 'gemstone' } : null;
  }
  if (!REGION_KEYS.has(magic.key) && magic.key !== 'golem-crafting') {
    const selected =
      globalThis.canvas?.tokens?.controlled
        ?.map((token) => token.document)
        .find((token) => token.actor?.uuid === actor.uuid) ??
      list(globalThis.canvas?.scene?.tokens).find((token) => token.actor?.uuid === actor.uuid);
    const choices = configuration.prepareEntry ? await configuration.prepareEntry({ actor, magic }) : {};
    return choices === null ? null : { ...(selected ? { casterTokenUuid: selected.uuid } : {}), ...choices };
  }
  const tokens = list(globalThis.canvas?.scene?.tokens).filter((token) => token.actor?.uuid === actor.uuid);
  const controlled = globalThis.canvas?.tokens?.controlled
    ?.map((token) => token.document)
    .find((token) => token.actor?.uuid === actor.uuid);
  const casterToken = controlled ?? (tokens.length === 1 ? tokens[0] : null);
  if (!casterToken)
    throw new RuleError('Select exactly one caster token on the viewed scene before placing the ritual.');
  const choices = { casterTokenUuid: casterToken.uuid };
  if (magic.key === 'golem-crafting') return choices;
  if (magic.key === 'magical-guestbook') {
    const regions = list(casterToken.parent.regions).filter((region) => !regionState(region));
    const values = await prompt(
      'Magical Guestbook doorway',
      '<p>Draw a Foundry Region across the actual doorway first, then select it here. Its geometry defines the doorway curtain.</p>' +
        input('regionUuid', 'Doorway Region', {
          options: Object.fromEntries(regions.map((region) => [region.uuid, region.name])),
        })
    );
    return values ? { ...choices, regionUuid: values.regionUuid } : null;
  }
  let radius = magic.key === 'magic-barrier' ? 5 : magic.key === 'interactive-illusion' ? 20 : null;
  if (magic.key === 'ritual-of-magic') {
    const selected = await prompt(
      'Ritual of Magic',
      input('mode', 'Result', { options: { vigor: 'One-use Vigor circle', essence: 'Fifth Essence' } })
    );
    if (!selected) return null;
    choices.mode = selected.mode;
    if (selected.mode === 'essence') return choices;
  }
  if (radius === null) {
    const unknownRadius = magic.key !== 'consecrate';
    if (unknownRadius && !game.user.isGM)
      throw new RuleError(
        'The book gives this circle no radius. A GM must choose and place its actual geometry.'
      );
    const values = await prompt(
      'Ritual circle',
      (unknownRadius
        ? '<p>The book does not specify this circle’s radius. Record the GM’s table convention explicitly.</p>'
        : '<p>Choose a radius up to 10 metres.</p>') +
        input('radius', 'Radius in metres', {
          value: unknownRadius ? 1 : 10,
          min: 0.1,
          max: unknownRadius ? undefined : 10,
          step: 0.1,
        }) +
        (unknownRadius
          ? input('geometryRuling', 'GM: reason for this circle size', { type: 'text' })
          : input('material', 'Consecrating material', {
              options: { silver: 'Silver', meteorite: 'Meteorite' },
            }) +
            input('traditionalVulnerabilities', 'Use traditional monster-vulnerability variant', {
              type: 'checkbox',
            }))
    );
    if (!values) return null;
    radius = Number(values.radius);
    if (!(radius > 0) || !Number.isFinite(radius) || (!unknownRadius && radius > 10))
      throw new RuleError('Choose a valid circle radius.');
    if (unknownRadius && !String(values.geometryRuling ?? '').trim())
      throw new RuleError('Record the GM’s circle-size convention.');
    Object.assign(choices, values, { radius });
  }
  const spec = {
    shape: 'circle',
    radius,
    origin: 'caster',
    volume: 'level',
    includeCaster: true,
    wallRestriction: false,
  };
  const preview = await previewMagicRegion({ casterToken, spec, name: magic.name });
  if (!preview) return null;
  return { ...choices, regionPreview: { placement: preview.placement, origin: preview.origin } };
}

function validateRitualPlacement(context) {
  const casterToken = localToken(context.choices.casterTokenUuid);
  if (!casterToken || casterToken.actor?.uuid !== context.actor.uuid)
    throw new RuleError('The ritual’s caster token changed.');
  if (context.magic.key === 'magical-guestbook') {
    const region = list(casterToken.parent.regions).find(
      (entry) => entry.uuid === context.choices.regionUuid
    );
    if (!region || regionState(region)) throw new RuleError('Choose the actual unenchanted doorway Region.');
    return { casterToken, scene: casterToken.parent, data: region.toObject(), doorway: true };
  }
  const fixed = { 'magic-barrier': 5, 'interactive-illusion': 20 }[context.magic.key];
  const radius = fixed ?? Number(context.choices.radius);
  if (
    !fixed &&
    context.magic.key !== 'consecrate' &&
    (!context.user.isGM || !String(context.choices.geometryRuling ?? '').trim())
  )
    throw new RuleError('The GM must confirm this unspecified circle radius.');
  if (context.magic.key === 'consecrate' && (!(radius > 0) || radius > 10))
    throw new RuleError('Consecrate radius must be positive and at most 10 metres.');
  const preview = context.choices.regionPreview;
  if (!preview?.origin || !preview.placement)
    throw new RuleError('Place the actual ritual circle before beginning preparation.');
  const validated = validateMagicRegion({
    scene: casterToken.parent,
    casterToken,
    spec: {
      shape: 'circle',
      radius,
      origin: 'caster',
      volume: 'level',
      includeCaster: true,
      wallRestriction: false,
    },
    placement: preview.placement,
    expectedOrigin: preview.origin,
    name: context.magic.name,
    requester: game.user,
  });
  return { ...validated, casterToken, scene: casterToken.parent };
}

async function ritualTransaction(execute) {
  const undo = [],
    documents = [];
  const tx = {
    compensate(callback) {
      undo.push(callback);
    },
    async created(document) {
      if (!document?.uuid || typeof document.delete !== 'function')
        throw new RuleError('A ritual document was not created.');
      undo.push(() => document.delete());
      documents.push(document.uuid);
      return document;
    },
    async update(document, changes) {
      const original = document.toObject?.() ?? document._source ?? document;
      const restore = {};
      for (const path of Object.keys(changes)) {
        const value = path.split('.').reduce((state, key) => state?.[key], original);
        if (value !== undefined) restore[path] = clone(value);
        else {
          const keys = path.split('.');
          keys[keys.length - 1] = '-=' + keys.at(-1);
          restore[keys.join('.')] = null;
        }
      }
      undo.push(() => document.update(restore));
      await document.update(changes);
      documents.push(document.uuid);
    },
  };
  const rollback = async () => {
    const errors = [];
    for (const action of [...undo].reverse())
      try {
        await action();
      } catch (error) {
        errors.push(error);
      }
    if (errors.length) throw new AggregateError(errors, 'Ritual document compensation failed.');
  };
  try {
    const result = await execute(tx);
    return { status: 'applied', receipt: { documentUuids: documents, ...result }, rollback };
  } catch (error) {
    try {
      await rollback();
    } catch (failure) {
      throw new AggregateError([error, failure], 'Ritual failed and document compensation needs GM review.');
    }
    throw error;
  }
}

async function prepareRitualZone(operation, context) {
  const validated = validateRitualPlacement(context);
  if (
    operation.type === 'healingCircle' &&
    !list(validated.scene.tokens).some(
      (token) => token.actor?.uuid === context.target?.uuid && token.testInsideRegion(validated.region)
    )
  )
    throw new RuleError('The selected healing subject must occupy the placed circle.');
  return {
    plans: [],
    execute: () =>
      ritualTransaction(async (tx) => {
        const state = {
          key: context.magic.key,
          type: operation.type,
          castId: context.castId,
          casterUuid: context.actor.uuid,
          casterTokenUuid: validated.casterToken.uuid,
          targetUuid: context.target?.uuid,
          operation: clone(operation),
          createdAt: context.time,
          active: true,
          expiresAt:
            operation.type === 'healingCircle'
              ? context.time + 30
              : operation.type === 'guestbook'
                ? context.time + 86400
                : 0,
          geometryRuling: context.choices.geometryRuling || '',
          traditionalVulnerabilities: !!context.choices.traditionalVulnerabilities,
          crossingReceipts: [],
          visitors: [],
          alertActorUuids: context.choices.alertActorUuids ?? [],
        };
        const regionData = clone(validated.data);
        delete regionData._id;
        regionData.name = context.magic.name;
        regionData.flags = { [SYSTEM_ID]: { ritualArea: state } };
        regionData.behaviors = [{ name: context.magic.name, type: RITUAL_REGION_BEHAVIOR, system: {} }];
        const [region] = await validated.scene.createEmbeddedDocuments('Region', [regionData]);
        await tx.created(region);
        if (operation.type === 'barrier') {
          const object = await createRitualStructure(context, operation, tx, validated);
          await tx.update(region, { [`flags.${SYSTEM_ID}.ritualArea.objectUuid`]: object.uuid });
        }
        if (operation.type === 'healingCircle') {
          const effect = ritualEffect(context, { duration: seconds(30) });
          Object.assign(effect.magic, {
            healing: 3,
            roundsRemaining: 10,
            nextAt: context.time + 3,
            ritualRegionUuid: region.uuid,
          });
          const next = addMagicEffect(context.target.system, effect);
          await tx.update(context.target, {
            'system.effects': next.effects,
            'system.conditions': next.conditions,
          });
        }
        const buttons =
          operation.type === 'vigorCircle'
            ? '<button data-ritual-region-action="focus">Focus in circle</button>'
            : operation.type === 'barrier'
              ? '<button data-ritual-region-action="repair">Restore barrier HP</button><button data-ritual-region-action="air">Toggle replenished air</button>'
              : operation.type === 'illusion'
                ? '<button data-ritual-region-action="illusionHazard">Resolve illusory hazard</button>'
                : operation.type === 'guestbook'
                  ? '<button data-ritual-region-action="read">Read guestbook</button>'
                  : '';
        const message = await chat(
          context.actor,
          context.magic.name,
          `<p>${e(context.magic.text)}</p>${buttons}<button data-ritual-region-action="end">End ritual area (GM)</button>`,
          { flags: { kind: 'ritual-region', regionUuid: region.uuid, castId: context.castId } }
        );
        await tx.created(message);
        return { regionUuid: region.uuid, castId: context.castId };
      }),
  };
}

async function createRitualStructure(context, operation, tx, validated) {
  const point = magicTokenOrigin(validated.casterToken),
    hp = operation.hp;
  const actor = await tx.created(
    await Actor.create({
      name: context.magic.name,
      type: 'monster',
      img: 'icons/svg/shield.svg',
      ownership: clone(context.actor.ownership ?? {}),
      system: {
        category: 'object',
        anatomy: 'custom',
        organless: true,
        stats: { int: 1, ref: 1, dex: 1, body: 1, spd: 0, emp: 1, cra: 1, will: 1, luck: 0 },
        overrides: { hp, sta: 0 },
        hp: { value: hp, max: hp },
        sta: { value: 0, max: 0 },
        locations: [
          {
            id: 'structure',
            label: context.magic.name,
            group: 'torso',
            min: 1,
            max: 10,
            multiplier: 1,
            sp: 0,
            maxSp: 0,
          },
        ],
        notes: context.magic.text,
      },
      flags: {
        [SYSTEM_ID]: {
          ritualStructure: { key: context.magic.key, castId: context.castId, casterUuid: context.actor.uuid },
        },
      },
    })
  );
  const tokenData = (
    await actor.getTokenDocument({ x: point.x, y: point.y, elevation: point.elevation, actorLink: true })
  ).toObject();
  const [token] = await validated.scene.createEmbeddedDocuments('Token', [tokenData]);
  await tx.created(token);
  return actor;
}

function ritualMonsterApplies(state, actor) {
  if (!actor || ['humanoid', 'beast', 'object'].includes(actor.system.category) || actor.type !== 'monster')
    return false;
  if (!state.traditionalVulnerabilities) return true;
  return state.operation.material === 'silver'
    ? !!actor.system.silverVulnerable
    : !actor.system.silverVulnerable;
}

/** Used by attack/casting validation; it does not infer whether a spell is a solid projectile. */
export function ritualTargetingBlock(
  sourceToken,
  targetToken,
  { magic = false, solidEffect = false, teleport = false, weapon = null } = {}
) {
  if (!sourceToken || sourceToken.parent?.id !== targetToken?.parent?.id) return null;
  for (const region of list(sourceToken.parent.regions)) {
    const state = regionState(region);
    if (!state?.active) continue;
    const from = sourceToken.testInsideRegion(region),
      to = targetToken.testInsideRegion(region);
    if (
      state.type === 'demonCage' &&
      (magic || solidEffect) &&
      (from !== to || sourceToken.actor?.uuid === state.targetUuid)
    ) {
      const actual = weapon?.system ?? weapon;
      const trueStaff =
        weapon?.flags?.[SYSTEM_ID]?.trueStaffOfBinding || actual?.properties?.trueStaffOfBinding;
      if (!trueStaff)
        return {
          regionUuid: region.uuid,
          reason:
            'Only a True Staff of Binding can penetrate this demon cage; the trapped demon cannot attack.',
        };
    }
    if (state.type === 'consecrate' && magic && !from && to && ritualMonsterApplies(state, sourceToken.actor))
      return {
        regionUuid: region.uuid,
        reason: 'Consecrate blocks this monster’s magic from entering the circle.',
      };
    if (
      state.type === 'barrier' &&
      solidEffect &&
      !teleport &&
      (from !== to ||
        (!from &&
          !to &&
          region.segmentizeMovementPath?.(
            [magicTokenOrigin(sourceToken), magicTokenOrigin(targetToken)],
            [{ x: 0, y: 0 }]
          ).length))
    )
      return { regionUuid: region.uuid, reason: 'The solid magic barrier blocks this attack.' };
  }
  return null;
}

function crossingKey(event) {
  const last = event.data.movement?.passed?.waypoints?.at(-1) ?? event.data.token;
  return `${event.region.uuid}:${event.name}:${last.x},${last.y},${last.elevation ?? 0}`;
}
function movementTeleports(event) {
  const action = event.data.movement?.passed?.waypoints?.at(-1)?.action;
  return !!globalThis.CONFIG?.Token?.movement?.actions?.[action]?.teleport;
}
function crossingBlocks(event) {
  const state = regionState(event.region),
    token = event.data.token;
  if (!state?.active || !event.data.movement || !['tokenMoveIn', 'tokenMoveOut'].includes(event.name))
    return false;
  if (state.type === 'demonCage') return token.actor?.uuid === state.targetUuid;
  if (state.type === 'barrier') return !movementTeleports(event) && !isIncorporeal(token.actor?.system ?? {});
  return state.type === 'consecrate' && ritualMonsterApplies(state, token.actor);
}

async function resolveRitualCrossing(event) {
  const region = event.region,
    state = clone(regionState(region)),
    token = event.data.token;
  if (!crossingBlocks(event)) return;
  const key = crossingKey(event),
    movementId = event.data.movement.id;
  const receipt = `${token.uuid}:${movementId}:${key}`;
  if (state.crossingReceipts?.includes(receipt)) return;
  const result =
    state.type === 'consecrate'
      ? await check(token.actor.skillBase('resistMagic').total, {
          actor: token.actor,
          context: { skill: 'resistMagic', dc: state.operation.crossing.dc },
        })
      : null;
  const success = !!result && !result.fumble && result.total > state.operation.crossing.dc;
  const message = await chat(
    token.actor,
    `${region.name} · crossing`,
    (result ? checkHTML(result) : '') +
      `<p>${success ? 'The creature crosses the consecrated boundary.' : 'The ritual boundary stops this movement.'}</p>`
  );
  try {
    await region.update({
      [`flags.${SYSTEM_ID}.ritualArea.crossingReceipts`]: [
        ...(state.crossingReceipts ?? []).slice(-99),
        receipt,
      ],
    });
  } catch (error) {
    await message.delete();
    throw error;
  }
  if (success) token.resumeMovement(movementId, key);
  else {
    // stopMovement is local to the initiating user. The authenticated GM flag asks that client to stop;
    // the GM then restores the recorded origin through the public V14 undo API.
    await token.update({ [`flags.${SYSTEM_ID}.ritualMovementStop`]: { movementId, receipt } });
    if (event.user.isSelf && token.movement?.id === movementId) token.stopMovement();
    await token.revertRecordedMovement(movementId);
  }
}

async function endRitualRegion(region) {
  const state = regionState(region);
  if (!state) return;
  for (const actor of allRitualActors()) {
    const next = removeMagicEffects(actor.system, (effect) => effect.magic?.ritualRegionUuid === region.uuid);
    if (next.removed.length)
      await actor.update({ 'system.effects': next.effects, 'system.conditions': next.conditions });
  }
  if (state.objectUuid) {
    const object = await foundry.utils.fromUuid(state.objectUuid);
    if (object) {
      for (const scene of list(game.scenes))
        for (const token of list(scene.tokens)) if (token.actorId === object.id) await token.delete();
      await object.delete();
    }
  }
  await region.delete();
}

function allRitualActors() {
  const actors = new Map(list(game.actors).map((actor) => [actor.uuid, actor]));
  for (const scene of list(game.scenes))
    for (const token of list(scene.tokens)) if (token.actor) actors.set(token.actor.uuid, token.actor);
  return [...actors.values()];
}

async function ritualRegionEvent(event) {
  const state = regionState(event.region);
  if (!state?.active) return;
  if (crossingBlocks(event)) return resolveRitualCrossing(event);
  const actor = event.data.token?.actor;
  if (state.type === 'healingCircle' && event.name === 'tokenExit' && actor?.uuid === state.targetUuid) {
    const stillInside = list(event.region.parent.tokens).some(
      (token) => token.actor?.uuid === actor.uuid && token.testInsideRegion(event.region)
    );
    if (!stillInside) return endRitualRegion(event.region);
  }
  if (state.type === 'guestbook' && ['tokenEnter', 'tokenMoveIn'].includes(event.name) && actor) {
    const entry = {
      tokenUuid: event.data.token.uuid,
      actorUuid: actor.uuid,
      name: event.data.token.name,
      image: event.data.token.texture?.src ?? actor.img,
      time: worldNow(),
      movementId: event.data.movement?.id ?? '',
    };
    if (
      state.visitors?.some(
        (previous) =>
          previous.tokenUuid === entry.tokenUuid &&
          previous.movementId === entry.movementId &&
          previous.time === entry.time
      )
    )
      return;
    await event.region.update({
      [`flags.${SYSTEM_ID}.ritualArea.visitors`]: [...(state.visitors ?? []), entry],
    });
    const casterToken = localToken(state.casterTokenUuid);
    if (
      state.alertActorUuids?.includes(actor.uuid) &&
      casterToken &&
      withinRitualRange(casterToken, event.data.token, 100)
    ) {
      const caster = casterToken.actor;
      await chat(caster, 'Magical Guestbook · alert', `<p>${e(actor.name)} passed the marked doorway.</p>`, {
        whisper: list(game.users)
          .filter((user) => user.isGM || caster.testUserPermission(user, 'OWNER'))
          .map((user) => user.id),
      });
    }
  }
}

function withinRitualRange(from, to, metres) {
  if (from.parent?.id !== to.parent?.id || from.level !== to.level) return false;
  const { pixelsPerMetre: scale, metresPerUnit } = magicSceneScale(from.parent);
  const a = magicTokenOrigin(from),
    b = magicTokenOrigin(to);
  return (
    Math.hypot(a.x - b.x, a.y - b.y, (a.elevation - b.elevation) * metresPerUnit * scale) / scale <= metres
  );
}

/** Called at init; movement pause/resume uses public Foundry V14 TokenDocument APIs. */
export function registerRitualRegions() {
  const Base = foundry.data.regionBehaviors.RegionBehaviorType;
  const dispatch = function (event) {
    if (crossingBlocks(event) && event.user.isSelf) event.data.token.pauseMovement(crossingKey(event));
    if (isPrimaryActiveGm()) serial('witcher-authority', () => ritualRegionEvent(event)).catch(errorNotice);
  };
  class RitualRegionBehavior extends Base {
    static defineSchema() {
      return {};
    }
    static events = Object.fromEntries(
      ['tokenEnter', 'tokenExit', 'tokenMoveIn', 'tokenMoveOut'].map((name) => [name, dispatch])
    );
  }
  CONFIG.RegionBehavior.dataModels[RITUAL_REGION_BEHAVIOR] = RitualRegionBehavior;
  registerCommand('magicRitualRegion', ritualRegionCommand);
  Hooks.on('renderChatMessageHTML', (message, html) => {
    if (message.flags?.[SYSTEM_ID]?.kind !== 'ritual-region') return;
    for (const button of html.querySelectorAll('[data-ritual-region-action]'))
      button.addEventListener('click', async () => {
        try {
          const action = button.dataset.ritualRegionAction;
          let form = {};
          if (action === 'focus' || action === 'illusionHazard') {
            const token = [...(game.user.targets ?? [])][0]?.document;
            if (!token) throw new RuleError('Select the actual target token.');
            form.targetTokenUuid = token.uuid;
            if (action === 'illusionHazard') {
              const selected = await prompt(
                'Illusory hazard',
                input('skill', 'Defense', {
                  options: { resistMagic: 'Resist Magic', endurance: 'Endurance' },
                })
              );
              if (!selected) return;
              Object.assign(form, selected);
            }
          } else if (action === 'repair') {
            form = await prompt(
              'Restore barrier',
              input('sta', 'Additional STA (5 barrier HP each)', { min: 1, value: 1 })
            );
            if (!form) return;
          }
          await runCommand('magicRitualRegion', {
            regionUuid: message.flags[SYSTEM_ID].regionUuid,
            action,
            values: form,
          });
        } catch (error) {
          errorNotice(error);
        }
      });
  });
  Hooks.on('updateToken', (token, changes, _options, userId) => {
    const stop =
      changes.flags?.[SYSTEM_ID]?.ritualMovementStop ?? changes[`flags.${SYSTEM_ID}.ritualMovementStop`];
    if (
      stop &&
      game.users.get(userId)?.isGM &&
      token.movement?.user?.isSelf &&
      token.movement.id === stop.movementId
    )
      token.stopMovement();
  });
  const schedule = () => {
    if (isPrimaryActiveGm()) serial('witcher-authority', tickRitualRegions).catch(errorNotice);
  };
  Hooks.on('preMoveToken', (token) => {
    if (ritualActionRestriction(token.actor ?? { system: {} }, 'move')) {
      errorNotice(new RuleError('The reanimated corpse cannot move.'));
      return false;
    }
  });
  Hooks.on('updateWorldTime', schedule);
  Hooks.on('updateActor', schedule);
  Hooks.once('ready', schedule);
  Hooks.on('deleteRegion', (region) => {
    if (!regionState(region) || !isPrimaryActiveGm()) return;
    serial('witcher-authority', async () => {
      for (const actor of allRitualActors()) {
        const next = removeMagicEffects(
          actor.system,
          (effect) => effect.magic?.ritualRegionUuid === region.uuid
        );
        if (next.removed.length)
          await actor.update({ 'system.effects': next.effects, 'system.conditions': next.conditions });
      }
      const object = regionState(region).objectUuid
        ? await foundry.utils.fromUuid(regionState(region).objectUuid)
        : null;
      if (object) {
        for (const scene of list(game.scenes))
          for (const token of list(scene.tokens)) if (token.actorId === object.id) await token.delete();
        await object.delete();
      }
    }).catch(errorNotice);
  });
  return RitualRegionBehavior;
}

/** Unserialized: callers inside witcher-authority may await it directly. */
export async function tickRitualRegions() {
  if (!isPrimaryActiveGm()) return;
  for (const actor of allRitualActors()) {
    for (const effect of actor.system.effects ?? [])
      if (
        effect.magic?.key === 'spirit-possession' &&
        effect.magic.nextSaveAt <= worldNow() &&
        effect.magic.promptAt !== effect.magic.nextSaveAt
      ) {
        const message = await chat(
          actor,
          'Spirit Possession · repeat resistance',
          '<p>Repeat Resist Magic against the original possession total.</p><button data-spirit-repeat>Resist possession</button>',
          {
            whisper: list(game.users)
              .filter((entry) => entry.isGM || actor.testUserPermission(entry, 'OWNER'))
              .map((entry) => entry.id),
            flags: {
              kind: 'spirit-repeat',
              actorUuid: actor.uuid,
              effectId: effect.id,
              dueAt: effect.magic.nextSaveAt,
            },
          }
        );
        const effects = clone(actor.system.effects);
        effects.find((entry) => entry.id === effect.id).magic.promptAt = effect.magic.nextSaveAt;
        try {
          await actor.update({ 'system.effects': effects });
        } catch (error) {
          await message.delete();
          throw error;
        }
      }
    const binding = actor.flags?.[SYSTEM_ID]?.demonBinding;
    if (binding?.active && binding.nextEscapeAt <= worldNow()) {
      let next = clone(binding),
        attempts = 0;
      while (next.active && next.nextEscapeAt <= worldNow()) {
        const result = await check(actor.skillBase('resistMagic').total, {
            actor,
            context: { skill: 'resistMagic', dc: next.castingTotal },
          }),
          escaped = !result.fumble && result.total > next.castingTotal;
        await chat(
          actor,
          'Demon binding · secret escape check',
          checkHTML(result) +
            `<p>${escaped ? 'The demon escapes its agreements.' : 'The binding holds.'}</p>`,
          {
            whisper: list(game.users)
              .filter((entry) => entry.isGM)
              .map((entry) => entry.id),
            rolls: result.rolls,
            flags: { kind: 'binding-escape', castId: next.castId, dueAt: next.nextEscapeAt },
          }
        );
        next.active = !escaped;
        next.lastEscapeAt = next.nextEscapeAt;
        next.nextEscapeAt += 1209600;
        attempts++;
        // Persist each attempt: later write failure must not silently consume a second week's result.
        await actor.update({ [`flags.${SYSTEM_ID}.demonBinding`]: next });
        if (attempts >= 100) break;
      }
    }
    const state = actor.flags?.[SYSTEM_ID]?.ritualStructure;
    if (
      state?.key === 'create-soul-beacon' &&
      state.expiresAt &&
      state.expiresAt <= worldNow() &&
      !state.expired
    ) {
      await actor.update({ [`flags.${SYSTEM_ID}.ritualStructure.expired`]: true });
    }
    const stale = new Set();
    for (const effect of actor.system.effects ?? [])
      if (effect.magic?.rule?.key === 'reanimated-corpse') {
        const caster = await foundry.utils.fromUuid(effect.magic.casterUuid);
        if (
          !caster?.system.effects.some(
            (entry) => entry.magic?.castId === effect.magic.castId && entry.magic.casterEffect
          )
        )
          stale.add(effect.id);
      }
    if (stale.size) {
      const next = removeMagicEffects(actor.system, (effect) => stale.has(effect.id));
      await actor.update({ 'system.effects': next.effects, 'system.conditions': next.conditions });
    }
  }
  for (const scene of list(game.scenes))
    for (const region of [...list(scene.regions)]) {
      const state = regionState(region);
      if (!state?.active) continue;
      if (state.expiresAt && worldNow() >= state.expiresAt) {
        if (state.type === 'healingCircle') await tickMagicLifecycle({ time: worldNow() });
        if (state.type === 'guestbook') await archiveGuestbook(region);
        else await endRitualRegion(region);
        continue;
      }
      if (state.type === 'barrier') {
        const caster = await foundry.utils.fromUuid(state.casterUuid),
          object = await foundry.utils.fromUuid(state.objectUuid);
        if (
          !caster?.system.effects.some(
            (effect) => effect.magic?.castId === state.castId && effect.magic.casterEffect
          ) ||
          !object ||
          object.system.hp.value <= 0
        ) {
          await endRitualRegion(region);
          continue;
        }
        if (Number.isFinite(state.airStoppedAt)) {
          const occupants = new Map(
            list(scene.tokens)
              .filter(
                (token) =>
                  token.actor && token.actor.system.category !== 'object' && token.testInsideRegion(region)
              )
              .map((token) => [token.actor.uuid, token.actor])
          );
          const airEnds = state.airStoppedAt + Math.max(0, 20 - Math.max(0, occupants.size - 1)) * 3;
          if (worldNow() >= airEnds)
            for (const actor of occupants.values())
              if (
                !immuneTo(actor.system, 'suffocating') &&
                !actor.system.effects.some(
                  (effect) => effect.magic?.ritualRegionUuid === region.uuid && effect.magic.airDepletion
                )
              ) {
                const effect = {
                  id: foundry.utils.randomID(),
                  key: 'Magic Barrier · no air',
                  expires: 0,
                  conditions: ['suffocating'],
                  magic: {
                    key: state.key,
                    castId: state.castId,
                    casterUuid: state.casterUuid,
                    ritualRegionUuid: region.uuid,
                    airDepletion: true,
                    addedConditions: [],
                  },
                };
                const next = addMagicEffect(actor.system, effect);
                await actor.update({ 'system.effects': next.effects, 'system.conditions': next.conditions });
              }
        }
      }
    }
}

async function archiveGuestbook(region) {
  const state = regionState(region),
    caster = await foundry.utils.fromUuid(state.casterUuid);
  if (!caster)
    throw new RuleError('The guestbook’s caster is missing; choose its archive owner before ending it.');
  const receipt = await createArtifact(
    caster,
    {
      name: 'Magical Guestbook · Clay Icon',
      flags: {
        [SYSTEM_ID]: {
          ritualArtifact: { visitors: clone(state.visitors ?? []), completed: true, readMinimumVigor: 1 },
        },
      },
    },
    { actor: caster, magic: magicInfo('magical-guestbook'), castId: state.castId, time: state.createdAt }
  );
  try {
    await region.delete();
  } catch (error) {
    await receipt.rollback();
    throw error;
  }
}

async function ritualRegionCommand({ regionUuid, action, values = {} }, { user }) {
  const region = await foundry.utils.fromUuid(regionUuid),
    state = regionState(region);
  if (!state?.active) throw new RuleError('This ritual area has ended or has already been consumed.');
  const caster = await foundry.utils.fromUuid(state.casterUuid);
  if (!caster) throw new RuleError('The ritual caster no longer exists.');
  if (action === 'focus') {
    if (state.type !== 'vigorCircle') throw new RuleError('This is not a Vigor circle.');
    const token = localToken(values.targetTokenUuid),
      actor = token?.actor;
    if (!actor?.testUserPermission(user, 'OWNER') || !token.testInsideRegion(region))
      throw new RuleError('Choose your actor actually within this circle.');
    if (magicVigor(actor.system) <= 0)
      throw new RuleError('The circle’s first user must have magical ability.');
    const effect = ritualEffect(
      {
        actor: caster,
        magic: magicInfo(state.key),
        castId: state.castId,
        check: { total: state.operation.castTotal ?? 0 },
        time: worldNow(),
      },
      { modifiers: { vigor: state.operation.bonus }, duration: seconds(18000) }
    );
    const next = addMagicEffect(actor.system, effect);
    return commitActor(
      actor,
      { 'system.effects': next.effects, 'system.conditions': next.conditions },
      [],
      async () => {
        const response = await chat(
          actor,
          'Ritual of Magic',
          `<p>+${state.operation.bonus} Vigor for five hours. The circle is expended.</p>`
        );
        try {
          await region.update({
            [`flags.${SYSTEM_ID}.ritualArea.active`]: false,
            [`flags.${SYSTEM_ID}.ritualArea.consumedBy`]: actor.uuid,
            visibility: CONST.REGION_VISIBILITY.LAYER,
            name: `${region.name} (expended)`,
          });
        } catch (error) {
          await response.delete();
          throw error;
        }
        return response;
      }
    );
  }
  if (action === 'illusionHazard') {
    if (state.type !== 'illusion') throw new RuleError('This area has no illusory hazards.');
    await authorizedActor(state.casterUuid, user);
    const token = localToken(values.targetTokenUuid),
      actor = token?.actor;
    if (!actor || !token.testInsideRegion(region) || !['resistMagic', 'endurance'].includes(values.skill))
      throw new RuleError('Choose the actual occupant and a printed defense.');
    const result = await check(actor.skillBase(values.skill).total, {
      actor,
      context: { skill: values.skill, dc: 12 },
    });
    const believed = !!result.fumble || result.total <= 12;
    const save = believed ? await dice('1d10') : null;
    const stunned = !!save && !(save.total < actor.system.derived.stun);
    return commitActor(
      actor,
      stunned ? { 'system.conditions': [...new Set([...actor.system.conditions, 'stunned'])] } : {},
      [],
      () =>
        chat(
          actor,
          'Interactive Illusion · hazard',
          checkHTML(result) +
            `<p>${!believed ? 'The target recognizes the illusion.' : stunned ? 'The target believes the danger and is stunned.' : 'The target passes the Stun save.'} No HP damage is dealt.</p>`,
          { rolls: [...result.rolls, ...(save ? [save] : [])] }
        )
    );
  }
  if (action === 'read') {
    if (state.type !== 'guestbook') throw new RuleError('This area does not record faces.');
    await authorizedActor(state.casterUuid, user);
    const token = localToken(state.casterTokenUuid);
    const bounds = region.bounds;
    const centre = bounds ? { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 } : null;
    if (!token || token.parent.id !== region.parent.id)
      throw new RuleError('The caster must be on the doorway’s scene within 100m.');
    const scale = magicSceneScale(token.parent).pixelsPerMetre,
      origin = magicTokenOrigin(token);
    if (!Number.isFinite(centre?.x) || Math.hypot(origin.x - centre.x, origin.y - centre.y) / scale > 100)
      throw new RuleError('The caster must be within 100m of the doorway.');
    return chat(caster, 'Magical Guestbook', guestbookImages(state.visitors), {
      whisper: list(game.users)
        .filter((entry) => entry.isGM || caster.testUserPermission(entry, 'OWNER'))
        .map((entry) => entry.id),
    });
  }
  await authorizedActor(state.casterUuid, user);
  if (action === 'end') {
    if (!user.isGM) throw new RuleError('The GM ends this ritual area.');
    return endRitualRegion(region);
  }
  if (state.type !== 'barrier') throw new RuleError('This ritual area does not have that control.');
  if (game.combat?.started && game.combat.combatant?.actor?.uuid !== caster.uuid)
    throw new RuleError('Change the barrier on the caster’s turn.');
  if (action === 'air') {
    const replenished = Number.isFinite(state.airStoppedAt);
    await region.update({ [`flags.${SYSTEM_ID}.ritualArea.airStoppedAt`]: replenished ? null : worldNow() });
    if (replenished)
      for (const actor of allRitualActors()) {
        const next = removeMagicEffects(
          actor.system,
          (effect) => effect.magic?.ritualRegionUuid === region.uuid && effect.magic.airDepletion
        );
        if (next.removed.length)
          await actor.update({ 'system.effects': next.effects, 'system.conditions': next.conditions });
      }
    return chat(
      caster,
      'Magic Barrier · air',
      `<p>Air replenishment ${replenished ? 'restored' : 'stopped; remaining air follows the printed occupant count'}.</p>`
    );
  }
  if (action === 'repair') {
    const amount = Number(values.sta),
      object = await foundry.utils.fromUuid(state.objectUuid);
    if (!Number.isInteger(amount) || amount < 1 || !object || object.system.hp.value <= 0)
      throw new RuleError('Choose a positive STA investment for an intact barrier.');
    const round = game.combat?.started ? `${game.combat.id}:${game.combat.round}` : '';
    const cost = magicCostPlan({
      power: amount,
      vigor: magicVigor(caster.system),
      stamina: caster.system.sta.value,
      spent: round && caster.system.magic.roundKey === round ? caster.system.magic.spent : 0,
      dimeritium: caster.system.magic.dimeritiumContact,
    });
    if (cost.hpCost)
      throw new RuleError(
        'Barrier repair overdraw needs its elemental-backlash ruling before this additional expenditure.'
      );
    const changes = {
      'system.sta.value': cost.staAfter,
      'system.magic.roundKey': round,
      'system.magic.spent': cost.roundAfter,
    };
    if (cost.exhausted) {
      changes['system.conditions'] = [...new Set([...caster.system.conditions, 'stunned'])];
      changes['system.magic.exhaustedRecovery'] = 20;
    }
    return commitActor(caster, changes, [], () =>
      commitActor(object, { 'system.hp.value': Math.min(50, object.system.hp.value + amount * 5) }, [], () =>
        chat(
          caster,
          'Magic Barrier · restored',
          `<p>${amount} STA restores up to ${amount * 5} barrier HP.</p>`
        )
      )
    );
  }
  throw new RuleError('Unknown ritual area control.');
}

export async function useCompressionRelease(actor) {
  const state = actor.flags?.[SYSTEM_ID]?.artifactCompression;
  if (!state?.active) throw new RuleError('This actor is not compressed.');
  const values = await prompt(
    'Reverse Artifact Compression',
    input('hp', 'Normal HP before deferred dismemberment damage', { value: state.original.hp.value }) +
      input('ruling', 'GM: HP restoration convention', { type: 'text' })
  );
  if (!values) return null;
  return runCommand('magicCompression', { messageUuid: state.messageUuid, action: 'release', values });
}
