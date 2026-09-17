import { SYSTEM_ID } from './config.js';
import { RuleError, beats } from './rules.js';
import { forgottenMagic } from './magic-hex-runtime.js';
import { magicInfo } from './magic-catalog.js';
import { magicCostPlan, magicalFumble } from './magic-rules.js';
import { magicFocus, magicVigor, magicTradition, addMagicEffect, removeMagicEffects } from './magic-state.js';
import { registerCommand, runCommand, authorizedActor } from './authority.js';
import {
  actionPlan,
  check,
  checkHTML,
  dice,
  chat,
  commitActor,
  input,
  manualCheckInput,
  prompt,
  escapeHTML as e,
  errorNotice,
  serial,
} from './runtime.js';
import { isPrimaryActiveGm, resolveFoundryUuid } from '../foundry-compat.js';

const clone = (value) => structuredClone(value);
const values = (collection) => collection?.contents ?? Array.from(collection ?? []);
const now = () => Number(game.time.worldTime);
const roundKey = () => (game.combat?.started ? `${game.combat.id}:${game.combat.round}` : '');
const data = (item) => item.system ?? item;
const normalName = (name) =>
  String(name)
    .toLowerCase()
    .replace(/[’']/g, '')
    .replace(/\b(?:a|an|the)\b/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/s$/, '');
const NECROMANCY = new Set([
  'cadfans-synthesis',
  'create-soul-beacon',
  'hanmarvyns-blue-dream',
  'reanimate-corpse',
]);
const GOETIA = new Set([
  'uncontrolled-summoning',
  'controlled-summoning',
  'ritual-of-naming',
  'ritual-of-binding',
  'ritual-of-the-goat-skin',
]);
let handlers = {};

function number(value, label, minimum = 0) {
  const result = Number(value);
  if (!Number.isFinite(result) || result < minimum)
    throw new RuleError(`${label} must be a finite number of at least ${minimum}.`);
  return result;
}

/** Core p.168: helpers reduce the final ritual DC, never interruption DCs. */
export function ritualDifficulty(
  magic,
  { mode = '', greaterDemon = false, quality = '', dcRoll } = {},
  helperCount = 0
) {
  if (!Number.isInteger(helperCount) || helperCount < 0 || helperCount > 4)
    throw new RuleError('A ritual permits at most four helpers.');
  let dc;
  if (magic.key === 'cleansing-ritual') dc = { alcohol: 12, poison: 15, illness: 18 }[mode];
  else if (['hydromancy', 'oneiromancy'].includes(magic.key)) dc = { past: 15, present: 18 }[mode];
  else if (magic.key === 'tyromancy') {
    if (!['ordinary', 'high'].includes(quality) || !Number.isInteger(dcRoll) || dcRoll < 1 || dcRoll > 6)
      throw new RuleError('Tyromancy requires the cheese quality and a secret GM d6 for its DC.');
    dc = 13 + (quality === 'high' ? -dcRoll : dcRoll);
  } else if (greaterDemon && magic.ritual?.greaterDemonDC) dc = magic.ritual.greaterDemonDC;
  else if (/^none$/i.test(magic.ritual?.dc ?? '')) return null;
  else if (/^\d+$/.test(String(magic.ritual?.dc))) dc = Number(magic.ritual.dc);
  else if (['ritual-of-naming', 'ritual-of-binding'].includes(magic.key))
    dc = Number.parseInt(magic.ritual.dc, 10);
  if (!Number.isFinite(dc)) throw new RuleError('Select the printed ritual mode before determining its DC.');
  return dc - helperCount;
}

export function ritualPreparationSeconds(magic) {
  const match = String(magic.ritual?.preparation ?? '').match(/^(\d+)\s+Rounds?$/i);
  if (!match) throw new RuleError('This ritual requires a specific preparation-time handler.');
  return Number(match[1]) * 3;
}

export function ritualInterruption(kind, { removedAt, time, returned = false } = {}) {
  if (kind === 'distracted') return { dc: 15, canContinue: true };
  if (kind === 'harmed') return { dc: 18, canContinue: true };
  if (kind === 'removed') {
    if (!Number.isFinite(removedAt) || !Number.isFinite(time))
      throw new RuleError('Record the removal and return world times.');
    return {
      dc: 16,
      canContinue: !!returned && time >= removedAt && time <= removedAt + 3,
      deadline: removedAt + 3,
    };
  }
  throw new RuleError('Unknown ritual interruption.');
}

/** Explicit quantities are consumables. Reusable tools and environmental prerequisites remain distinct. */
export function ritualRequirements(magic) {
  const text = String(magic.ritual?.components ?? '').replace(/,\s*(\(x\d+\))/gi, ' $1');
  const segments = text
    .split(/,\s*(?![^()]*\))/)
    .map((part) => part.trim())
    .filter(Boolean);
  return segments.map((part, index) => {
    const counted = part.match(/^(.*?)\s*(?:\(x(\d+)\)|x(\d+))$/i);
    const leading = part.match(/^(\d+)\s+(Corpses?)(.*)$/i);
    const quantity = counted ? Number(counted[2] ?? counted[3]) : leading ? Number(leading[1]) : 1;
    const name = counted ? counted[1].trim() : leading ? `${leading[2]}${leading[3]}`.trim() : part;
    const reusable = /telecommunicator|runewright.s tools|bloodstone dagger|true staff of binding/i.test(
      name
    );
    const prerequisite = !counted && !leading && !reusable;
    return {
      id: `component-${index}`,
      name,
      quantity,
      kind: reusable ? 'retain' : prerequisite ? 'prerequisite' : 'consume',
      printed: part,
    };
  });
}

function procedureRequirements(actor, magic, choices = {}) {
  return handlers.componentRequirements?.({ actor, magic, choices }) ?? ritualRequirements(magic);
}

/** Current inventory is rechecked at completion; client-supplied counts never determine consumption. */
export function ritualComponentPlan(items, requirements, allocations, { isGM = false } = {}) {
  const used = new Map(),
    retained = new Map();
  for (const requirement of requirements) {
    const allocation = allocations?.[requirement.id];
    if (requirement.kind === 'prerequisite') {
      if (!allocation?.confirmed || !String(allocation.note ?? '').trim())
        throw new RuleError(`Confirm the actual prerequisite: ${requirement.name}.`);
      continue;
    }
    const item = items.find((candidate) => (candidate.id ?? candidate._id) === allocation?.itemId);
    const state = item && data(item);
    if (
      !item ||
      ['magic', 'wound', 'skill', 'profession', 'ability'].includes(item.type) ||
      state.carried === false
    )
      throw new RuleError(`Choose an available inventory item for ${requirement.name}.`);
    const matches = normalName(item.name) === normalName(requirement.name);
    if (!matches && !(isGM && String(allocation.ruling ?? '').trim()))
      throw new RuleError(
        `The material does not match ${requirement.name}; a GM must record any substitution.`
      );
    const amount = requirement.quantity;
    const counts = requirement.kind === 'retain' ? retained : used;
    counts.set(item.id ?? item._id, (counts.get(item.id ?? item._id) ?? 0) + amount);
  }
  const updates = [];
  for (const id of new Set([...used.keys(), ...retained.keys()])) {
    const item = items.find((candidate) => (candidate.id ?? candidate._id) === id),
      quantity = Number(data(item).quantity);
    if (!Number.isFinite(quantity) || quantity < (used.get(id) ?? 0) + (retained.get(id) ?? 0))
      throw new RuleError(`Not enough ${item.name} remains to perform the ritual.`);
    if (used.has(id)) updates.push({ _id: id, 'system.quantity': quantity - used.get(id) });
  }
  return {
    updates,
    consumed: [...used].map(([itemId, quantity]) => ({ itemId, quantity })),
    retained: [...retained.keys()],
  };
}

export function hexEffectData(magic, { castId, casterUuid, checkTotal, createdAt, id }) {
  return {
    id,
    key: magic.name,
    sourceUuid: casterUuid,
    expires: 0,
    modifiers: magic.key === 'the-eternal-itch' ? { allActions: -1 } : {},
    notes: magic.text,
    magic: {
      key: magic.key,
      kind: 'hex',
      castId,
      casterUuid,
      castingTotal: checkTotal,
      createdAt,
      addedConditions: [],
      danger: magic.hex.danger,
      source: magic.source,
      page: magic.page,
      rule: magic.key,
    },
  };
}

/** Context-specific checks for hexes; callers must supply the actual check context. */
export function hexCheckRules(
  state,
  { skill = '', intimacy = false, animalHandling = false, stressed = false, deadline = false, dc = 0 } = {}
) {
  const hexes = new Set(
    (state.effects ?? [])
      .filter((effect) => effect.magic?.kind === 'hex' && !effect.magic.suppressed)
      .map((effect) => effect.magic.key)
  );
  return {
    modifier:
      (hexes.has('the-eternal-itch') && skill === 'seduction' && intimacy ? -5 : 0) +
      (hexes.has('the-hex-of-the-beast') && skill === 'wildernessSurvival' && animalHandling ? -3 : 0),
    fumbleFaces: hexes.has('the-devils-luck') && (stressed || deadline || dc > 15) ? [1, 2] : [1],
    fumbleTwice: hexes.has('the-evil-eye'),
    mayLearnMagic: !hexes.has('hex-of-forgetfulness'),
    socialStandingSteps: hexes.has('the-odious-hex') ? -1 : 0,
  };
}

export function hexIdentificationDC(danger, skill) {
  const table = {
    low: { education: 16, witcherTraining: 14 },
    medium: { education: 20, witcherTraining: 18 },
    high: { education: 26, witcherTraining: 22 },
  };
  const dc = table[danger]?.[skill];
  if (!dc) throw new RuleError('Identify a hex using Education or Witcher Training.');
  return dc;
}

/** The scene, calendar and narrative steps are confirmed by the GM, never inferred from a button press. */
export function hexLiftingRequirements(key) {
  const material = (name, quantity, kind = 'consume') => ({ name, quantity, kind });
  const recipes = {
    'the-hex-of-shadows': {
      procedure:
        'Under a crescent moon at its highest point, use clear water, ink and a white-myrtle branch in a clearing; hold the breath while sprinkling a circle.',
      materials: [],
    },
    'the-eternal-itch': {
      procedure:
        'Prepare the campfire, burn the bundled herbs and crumble their ashes onto the affected area while reciting the prescribed words.',
      materials: [material('Scleroderm', 1), material('Fool’s Parsley', 1), material('Bryonia', 1)],
    },
    'the-devils-luck': {
      procedure:
        'Fix a silver nail into the door frame. Hang wolvesbane tied with a virgin’s hair, burn the bundle, and stand beneath it breathing the smoke.',
      materials: [material('Wolvesbane', 2)],
    },
    'the-nightmare': {
      procedure:
        'Set five candles in a circle linked by the bones, place glowing ore beneath the head, and sleep through the entire night.',
      materials: [
        material('Candles', 5),
        material('Beast Bones', 5, 'retain'),
        material('Glowing Ore', 1, 'retain'),
      ],
    },
    'the-pestas-kiss': {
      procedure:
        'Make the infused-clay, resin-coated totem with coal eyes at Fine Arts DC14, recite its words, smash it, powder the coal eyes and consume them.',
      materials: [
        material('River Clay', 3),
        material('Coal', 1),
        material('Resin', 3),
        material('Infused Dust', 1),
      ],
      check: { skill: 'fineArts', dc: 14 },
    },
    'the-hex-of-the-beast': {
      procedure:
        'Under a full moon perform the animal-blood ceremony, burn the body bundled with the herbs, add phosphorus as fur or scales burn, and wear the recovered bones for a full day.',
      materials: [
        material('Mistletoe', 2),
        material('Phosphorus', 1),
        material('Crow’s Eye', 2),
        material('Mandrake Root', 3),
      ],
    },
    'curse-of-temperance': {
      procedure:
        'Use a bucket with 40 crowns’ worth of alcohol; in the game, immerse the head until the Suffocation effect begins, then remove it.',
      materials: [],
    },
    'the-odious-hex': {
      procedure: 'Make a personal effigy, insult it until no insults remain, then burn it.',
      materials: [material('Han Fiber', 1), material('Barley', 1), material('Fool’s Parsley', 1)],
    },
    'the-evil-eye': {
      procedure:
        'Make the Great Sea coral amulet (50 crowns; Fine Arts DC14), wear it for the entirety of a full moon, and allow it to shatter at sunrise.',
      materials: [material('Great Sea Coral', 1)],
      check: { skill: 'fineArts', dc: 14 },
    },
    'unending-need': {
      procedure:
        'Complete three full days and nights fasting on water alone, sleeping over untouched sweets; the hex ends on the fourth morning.',
      materials: [],
    },
    'bones-of-glass': {
      procedure:
        'Gather a warhorse, troll liver, wolf meat, balisse and spirits. Use warhorse blood to cook the stew for three hours; finish all stew within one hour, then finish the bottle of spirits.',
      materials: [material('Balisse Leaves', 3)],
    },
    'hex-of-forgetfulness': {
      procedure:
        'Shave the scalp, inscribe the prescribed water-and-clay sigils, hold optima matter under the tongue and remain silent for a full day and night. Remove the clay and matter; forgotten knowledge returns.',
      materials: [
        material('Essence of Water', 2),
        material('River Clay', 2),
        material('Optima Matter', 1, 'retain'),
      ],
      restrictedFocus: true,
    },
  };
  const result = recipes[key];
  if (!result) throw new RuleError('Unknown printed hex-lifting procedure.');
  return {
    ...result,
    materials: result.materials.map((entry, index) => ({ id: `lift-${index}`, ...entry })),
  };
}

function knownHex(actor, effectId) {
  const effect = actor.system.effects.find((entry) => entry.id === effectId && entry.magic?.kind === 'hex');
  const magic = magicInfo(effect?.magic.key);
  if (!effect || !magic) throw new RuleError('This source of the hex is no longer on the actor.');
  return { effect, magic };
}

async function identifyHex({ actorUuid, targetUuid, effectId, skill, options = {} }, { user }) {
  const actor = await authorizedActor(actorUuid, user);
  const target = await authorizedActor(targetUuid, user);
  const { effect, magic } = knownHex(target, effectId);
  const dc = hexIdentificationDC(magic.hex.danger, skill);
  const result = await check(
    actor.skillBase(skill, { modifier: number(options.modifier ?? 0, 'Check modifier', -Infinity) }).total,
    { manualDice: options.manualDice, actor, context: { skill, dc } }
  );
  const success = !result.fumble && beats(result.total, dc);
  const effects = clone(target.system.effects);
  if (success) {
    const saved = effects.find((entry) => entry.id === effect.id);
    saved.magic.identifiedBy = [...new Set([...(saved.magic.identifiedBy ?? []), actor.uuid])];
  }
  return commitActor(target, success ? { 'system.effects': effects } : {}, [], () =>
    chat(
      actor,
      `${magic.name} · identification`,
      checkHTML(result) +
        `<p>DC${dc}: ${success ? e(hexLiftingRequirements(magic.key).procedure) : 'The lifting method was not identified.'}</p>`,
      { rolls: result.rolls }
    )
  );
}

async function liftHex({ actorUuid, effectId, evidence = '', allocations = {}, checkTotal }, { user }) {
  if (!user.isGM || !String(evidence).trim())
    throw new RuleError('The GM must confirm and record all printed conditions for lifting this hex.');
  const actor = await authorizedActor(actorUuid, user);
  const { effect, magic } = knownHex(actor, effectId);
  if (effect.magic?.uninvitedGuest)
    throw new RuleError(
      'This hex comes from an Uninvited Guest. A blood-free Spirit Seance followed by killing or banishing that spirit is required; ordinary lifting cannot remove it.'
    );
  const requirement = hexLiftingRequirements(magic.key);
  if (
    requirement.check &&
    !beats(number(checkTotal, 'Previously completed Fine Arts check'), requirement.check.dc)
  )
    throw new RuleError(`The preceding Fine Arts check must meet DC${requirement.check.dc}.`);
  const components = ritualComponentPlan(values(actor.items), requirement.materials, allocations, {
    isGM: true,
  });
  if (requirement.restrictedFocus) {
    const item = actor.items.get(allocations['lift-2']?.itemId);
    if (item?.system.quantity !== 1)
      throw new RuleError(
        'Separate the single used Optima Matter into its own inventory stack before it becomes a restricted focus.'
      );
    components.updates.push({
      _id: item.id,
      name: `Grayed ${item.name}`,
      'system.properties.focus': 2,
      [`flags.${SYSTEM_ID}.focusKinds`]: ['hex', 'goetia', 'necromancy'],
    });
  }
  const next = removeMagicEffects(actor.system, (entry) => entry.id === effect.id);
  return commitActor(
    actor,
    { 'system.effects': next.effects, 'system.conditions': next.conditions },
    components.updates,
    () =>
      chat(
        actor,
        `${magic.name} · lifted`,
        `<p>${e(requirement.procedure)}</p><p>GM confirmation: ${e(evidence.trim())}</p>`,
        {
          flags: {
            kind: 'magic-hex-lifted',
            actorUuid,
            effectId,
            castId: effect.magic.castId,
            evidence: evidence.trim(),
            checkTotal: requirement.check ? Number(checkTotal) : null,
            consumed: components.consumed,
          },
        }
      )
  );
}

function learned(actor, id, kind) {
  const item = actor.items.get(id),
    magic = magicInfo(item?.system.magic?.key);
  if (item?.type !== 'magic' || !magic || magic.kind !== kind)
    throw new RuleError(`Choose a learned ${kind} Item on this actor.`);
  if (forgottenMagic(actor.system, magic.key))
    throw new RuleError('Forgetfulness prevents using this magic until it is relearned.');
  return { item, magic };
}

export function activeRitualPreparation(messages, actorUuid) {
  return (
    values(messages).find((message) => {
      const state = message.flags?.[SYSTEM_ID];
      return (
        message.author?.isGM &&
        state?.type === 'magic-procedure' &&
        state.kind === 'ritual' &&
        state.actorUuid === actorUuid &&
        ['preparing', 'ready', 'removed'].includes(state.status)
      );
    }) ?? null
  );
}

function projectedState(actor, changes) {
  const state = clone(actor.system);
  for (const [path, value] of Object.entries(changes)) {
    if (!path.startsWith('system.')) continue;
    const parts = path.slice(7).split('.'),
      last = parts.pop();
    let target = state;
    for (const part of parts) target = target[part] ??= {};
    target[last] = clone(value);
  }
  return state;
}

function validateRitualHandler(magic) {
  if (magic.cost.formula)
    throw new RuleError('This variable-cost ritual requires a dedicated stored-spell cost procedure.');
  if (typeof handlers.planRitualResult !== 'function' || handlers.supportsRitual?.(magic) !== true)
    throw new RuleError(
      'This ritual’s final result has not yet been implemented; no preparation or resources were consumed.'
    );
  if (
    (NECROMANCY.has(magic.key) || magic.key === 'create-place-of-power') &&
    typeof handlers.planSpecialMishap !== 'function'
  )
    throw new RuleError('This ritual needs its special mishap procedure before it can be performed.');
}

async function helperActors(uuids, user, caster) {
  if (!Array.isArray(uuids) || new Set(uuids).size !== uuids.length || uuids.length > 4)
    throw new RuleError('Choose up to four different ritual helpers.');
  const result = [];
  for (const uuid of uuids) {
    const actor = await authorizedActor(uuid, user);
    if (
      actor.uuid === caster.uuid ||
      actor.system.conditions.some((condition) => ['dead', 'unconscious', 'stunned'].includes(condition))
    )
      throw new RuleError('A helper must be another able-bodied participant.');
    result.push(actor);
  }
  return result;
}

function procedureCard(state) {
  const timing =
    state.readyAt === undefined
      ? ''
      : `<p>Preparation: ${state.preparationSeconds / 3} rounds. Ready at world time ${state.readyAt}.</p>`;
  const rule =
    state.kind === 'hex'
      ? '<p>The book does not specify one universal hex DC or defense. The GM records the actual opposition and ruling before weaving.</p>'
      : '';
  const active = ['preparing', 'ready', 'awaiting-ruling', 'removed'].includes(state.status);
  return (
    `<article class="witcher-chat"><h3>${e(state.name)}</h3><p>${e(state.status)}</p>${timing}${rule}` +
    (active
      ? `<button type="button" data-magic-procedure="finish">${state.kind === 'hex' ? 'Set ruling and weave (GM)' : 'Complete ritual'}</button>`
      : '') +
    (state.kind === 'ritual' && active
      ? '<button type="button" data-magic-procedure="interrupt">Interruption / return</button>'
      : '') +
    (active ? '<button type="button" data-magic-procedure="cancel">Cancel preparation</button>' : '') +
    (state.check ? checkHTML(state.check) : '') +
    (state.result ? `<p>${e(state.result)}</p>` : '') +
    '</article>'
  );
}

async function procedureMessage(uuid) {
  const message = await resolveFoundryUuid(uuid),
    state = message?.flags?.[SYSTEM_ID];
  if (!message?.author?.isGM || state?.type !== 'magic-procedure')
    throw new RuleError('Choose an authoritative ritual or hex card.');
  return { message, state: clone(state) };
}

async function updateProcedure(message, state) {
  return message.update({ [`flags.${SYSTEM_ID}`]: state, content: procedureCard(state) });
}

async function beginProcedure(
  { actorUuid, itemId, kind, targetUuid = '', allocations = {}, helpers = [], choices = {} },
  { user, id }
) {
  const actor = await authorizedActor(actorUuid, user),
    { item, magic } = learned(actor, itemId, kind);
  if (!['ritual', 'hex'].includes(kind)) throw new RuleError('Unknown magical procedure.');
  if (actor.system.race === 'witcher' || magicTradition(actor.system) === 'witcher')
    throw new RuleError('Witchers can learn Signs, not rituals or hexes.');
  if (kind === 'ritual') {
    if (activeRitualPreparation(game.messages, actor.uuid))
      throw new RuleError('Finish or cancel the caster’s current ritual first.');
    validateRitualHandler(magic);
    await helperActors(helpers, user, actor);
    ritualComponentPlan(values(actor.items), procedureRequirements(actor, magic, choices), allocations, {
      isGM: user.isGM,
    });
  }
  if (kind === 'hex' && !(await resolveFoundryUuid(targetUuid)))
    throw new RuleError('Choose a target actor or token for this hex.');
  if (kind === 'ritual' && handlers.preflightRitual) {
    const document = targetUuid ? await resolveFoundryUuid(targetUuid) : actor;
    await handlers.preflightRitual({
      actor,
      target: document?.actor ?? document,
      magic,
      choices,
      user,
      allocations,
      helpers,
    });
  }
  const preparationSeconds = kind === 'ritual' ? ritualPreparationSeconds(magic) : 0;
  const state = {
    type: 'magic-procedure',
    kind,
    castId: id,
    name: magic.name,
    actorUuid,
    itemId,
    itemUuid: item.uuid,
    targetUuid,
    requesterId: user.id,
    expected: JSON.stringify(item.system.magic),
    status: kind === 'ritual' ? 'preparing' : 'awaiting-ruling',
    createdAt: now(),
    preparationSeconds,
    ...(kind === 'ritual' ? { readyAt: now() + preparationSeconds } : {}),
    helpers,
    allocations,
    choices,
    source: magic.source,
    page: magic.page,
  };
  const changes = kind === 'ritual' ? actionPlan(actor, { full: true }).changes : {};
  return commitActor(actor, changes, [], () =>
    chat(actor, magic.name, procedureCard(state), {
      flags: state,
      ...(magic.key === 'tyromancy'
        ? {
            whisper: values(game.users)
              .filter((entry) => entry.isGM)
              .map((entry) => entry.id),
          }
        : {}),
    })
  );
}

function spending(actor, magic, options, initialChanges = {}, adjustments = {}) {
  if (GOETIA.has(magic.key))
    return { changes: {}, cost: { staCost: 0, hpCost: 0, elementalBacklash: false } };
  if (magic.cost.formula)
    throw new RuleError('This variable-cost ritual requires a dedicated stored-spell cost procedure.');
  const power = Math.max(1, magic.cost.min + (adjustments.ritualCostModifier ?? 0)),
    items = values(actor.items).map((item) => ({ id: item.id, type: item.type, ...item.system }));
  const restrictions = actor.items.get(options.focusId)?.flags?.[SYSTEM_ID]?.focusKinds;
  if (restrictions && ![magic.kind, magic.tradition].some((kind) => restrictions.includes(kind)))
    throw new RuleError('This focus is restricted to Hexes, Goetia and Necromancy.');
  const focus = magicFocus(actor.system, items, options.focusId ?? '');
  const cost = magicCostPlan({
    magic: adjustments.ritualCostModifier ? null : magic,
    power,
    focus,
    spent: actor.system.magic.roundKey === roundKey() && roundKey() ? actor.system.magic.spent : 0,
    vigor: magicVigor(actor.system),
    stamina: initialChanges['system.sta.value'] ?? actor.system.sta.value,
    dimeritium: actor.system.magic.dimeritiumContact,
  });
  if (cost.hpCost && !options.overdraw)
    throw new RuleError(`Explicitly allow ${cost.hpCost} HP of Vigor overexertion.`);
  if (cost.elementalBacklash && typeof handlers.planSpecialMishap !== 'function')
    throw new RuleError('The overdraw consequence handler is not available.');
  const changes = {
    ...initialChanges,
    'system.sta.value': cost.staAfter,
    'system.magic.roundKey': roundKey(),
    'system.magic.spent': cost.roundAfter,
  };
  if (cost.hpCost) changes['system.hp.value'] = actor.system.hp.value - cost.hpCost;
  if (cost.exhausted) {
    changes['system.conditions'] = [...new Set([...actor.system.conditions, 'stunned'])];
    changes['system.magic.exhaustedRecovery'] = 20;
  }
  return { changes, cost };
}

async function commitPlans(plans, after, index = 0) {
  if (index === plans.length) return after?.();
  const plan = plans[index];
  return commitActor(plan.actor, plan.changes ?? {}, plan.items ?? [], () =>
    commitPlans(plans, after, index + 1)
  );
}

function plannedResult(value, label) {
  if (Array.isArray(value)) return { plans: value };
  if (value && Array.isArray(value.plans) && (!value.execute || typeof value.execute === 'function'))
    return value;
  throw new RuleError(`${label} did not return executable changes.`);
}

async function executeResultPlans(results, after) {
  const executed = [];
  try {
    for (const result of results) {
      if (!result.execute) continue;
      const receipt = await result.execute();
      if (!receipt || typeof receipt.rollback !== 'function')
        throw new RuleError('A world ritual result must provide compensation.');
      executed.push(receipt);
    }
    return await after(executed);
  } catch (error) {
    const failures = [];
    for (const result of executed.reverse()) {
      try {
        await result.rollback();
      } catch (failure) {
        failures.push(failure);
      }
    }
    if (failures.length)
      throw new AggregateError([error, ...failures], 'Ritual failed and world compensation needs GM review.');
    throw error;
  }
}

async function finishProcedure({ messageUuid, options = {} }, { user }) {
  const { message, state } = await procedureMessage(messageUuid),
    actor = await authorizedActor(state.actorUuid, user);
  if (!['preparing', 'ready', 'awaiting-ruling'].includes(state.status))
    throw new RuleError('This procedure is no longer ready to complete.');
  if (actor.system.conditions.some((condition) => ['dead', 'unconscious', 'stunned'].includes(condition)))
    throw new RuleError('The caster cannot finish a magical procedure in this condition.');
  const { item, magic } = learned(actor, state.itemId, state.kind);
  if (JSON.stringify(item.system.magic) !== state.expected)
    throw new RuleError('The learned magic changed after preparation began.');
  let dc,
    components = { updates: [] };
  const resolvedChoices = { ...state.choices };
  const rolls = [];
  if (state.kind === 'ritual') {
    validateRitualHandler(magic);
    if (now() < state.readyAt)
      throw new RuleError(`Preparation needs ${state.readyAt - now()} more seconds of world time.`);
    await helperActors(state.helpers, user, actor);
    components = ritualComponentPlan(
      values(actor.items),
      procedureRequirements(actor, magic, state.choices),
      state.allocations,
      {
        isGM: user.isGM,
      }
    );
    if (magic.key === 'tyromancy') {
      const die = await dice('1d6');
      rolls.push(die);
      resolvedChoices.dcRoll = die.total;
    }
    dc = ritualDifficulty(magic, resolvedChoices, state.helpers.length);
  } else {
    if (!user.isGM || !String(options.ruling ?? '').trim())
      throw new RuleError('The GM must record the hex’s actual opposition and ruling.');
    dc = number(options.dc, 'Hex opposition');
    state.ruling = options.ruling.trim();
  }
  const adjustments =
    state.kind === 'ritual'
      ? ((await handlers.castingAdjustments?.({ actor, magic, choices: resolvedChoices })) ?? {})
      : {};
  if (dc !== null) dc += adjustments.ritualDCModifier ?? 0;
  const action =
    state.kind === 'hex'
      ? actionPlan(actor, { extra: !!options.extra, forfeit: !!options.forfeit })
      : { changes: {}, modifier: 0 };
  const { changes, cost } = spending(actor, magic, options, action.changes, adjustments);
  const skill = state.kind === 'ritual' ? 'ritualCrafting' : 'hexWeaving';
  const result =
    dc === null
      ? null
      : await check(
          actor.skillBase(skill, {
            modifier:
              number(options.modifier ?? 0, 'Check modifier', -Infinity) +
              action.modifier +
              (adjustments.checkModifier ?? 0),
          }).total,
          { manualDice: options.manualDice, actor, context: { skill, dc } }
        );
  if (result) rolls.push(...result.rolls);
  const fumble = magicalFumble({ kind: state.kind, fumble: result?.fumble ?? 0, ritualCost: cost.staCost });
  let success = !result || (!result.fumble && beats(result.total, dc)),
    target = state.targetUuid ? await resolveFoundryUuid(state.targetUuid) : actor;
  target = target?.actor ?? target;
  let backfire = false;
  if (state.kind === 'hex' && result.fumble) {
    const roll = await dice('1d100');
    rolls.push(roll);
    backfire = roll.total <= 50;
    if (backfire) target = actor;
  }
  if (fumble.damage && !NECROMANCY.has(magic.key) && magic.key !== 'create-place-of-power')
    changes['system.hp.value'] = (changes['system.hp.value'] ?? actor.system.hp.value) - fumble.damage;
  if ((changes['system.hp.value'] ?? actor.system.hp.value) <= 0 && ((cost.hpCost ?? 0) || fumble.damage))
    changes['system.pendingDeathSaves'] = actor.system.pendingDeathSaves + 1;
  const actorState = projectedState(actor, changes);
  const context = {
    actor,
    target,
    magic,
    check: result,
    castId: state.castId,
    choices: resolvedChoices,
    dc,
    cost,
    fumble,
    success,
    backfire,
    user,
    time: now(),
    actorState,
    adjustments,
    targetState: target?.uuid === actor.uuid ? actorState : target?.system,
  };
  const extraPlans = [];
  const preparedResults = [];
  if (
    ((NECROMANCY.has(magic.key) || magic.key === 'create-place-of-power') && result?.fumble) ||
    cost.elementalBacklash ||
    adjustments.gatewayTriggerFaces?.includes(result?.dice?.[0])
  ) {
    const special = plannedResult(await handlers.planSpecialMishap(context), 'The special magical mishap');
    extraPlans.push(...special.plans);
    preparedResults.push(special);
    rolls.push(...(special.rolls ?? []));
    for (const plan of special.plans) {
      if (plan.actor?.uuid === actor.uuid)
        context.actorState = projectedState({ system: context.actorState }, plan.changes ?? {});
      if (plan.actor?.uuid === target?.uuid)
        context.targetState = projectedState({ system: context.targetState }, plan.changes ?? {});
    }
  }
  if (state.kind === 'ritual') {
    const outcome = plannedResult(await handlers.planRitualResult(context), 'The ritual result handler');
    extraPlans.push(...outcome.plans);
    preparedResults.push(outcome);
    rolls.push(...(outcome.rolls ?? []));
  } else if (success || backfire) {
    if (!target?.system) throw new RuleError('The hex target is not an actor.');
    if (handlers.planHexResult) extraPlans.push(...(await handlers.planHexResult(context)));
    else {
      const effect = hexEffectData(magic, {
        castId: state.castId,
        casterUuid: actor.uuid,
        checkTotal: result.total,
        createdAt: now(),
        id: foundry.utils.randomID(),
      });
      const next = addMagicEffect(context.targetState, effect);
      extraPlans.push({
        actor: target,
        changes: { 'system.effects': next.effects, 'system.conditions': next.conditions },
      });
    }
  }
  const plans = [{ actor, changes, items: components.updates }, ...extraPlans];
  state.status = backfire ? 'backfired' : success ? 'completed' : 'failed';
  state.check = result ? (({ rolls, ...saved }) => saved)(result) : null;
  state.dc = dc;
  state.staCost = cost.staCost;
  state.result = backfire
    ? 'The hex afflicts its caster.'
    : success
      ? 'The procedure succeeded.'
      : state.kind === 'ritual'
        ? 'The ritual failed; completed ritual components were consumed.'
        : 'The hex failed without affecting its target.';
  return commitPlans(plans, () =>
    executeResultPlans(preparedResults, async (results) => {
      state.worldResults = results.map((result) => result.receipt ?? { status: result.status });
      if (results.some((result) => result.status === 'pendingGM')) {
        state.result =
          'The casting outcome includes a consequence or information awaiting a recorded GM decision.';
      }
      const response = await chat(
        actor,
        `${magic.name} · ${state.status}`,
        (result ? checkHTML(result) : '<p>This ritual requires no difficulty check.</p>') +
          `<p>${e(state.result)} ${cost.staCost} STA.</p>`,
        {
          rolls,
          flags: { kind: 'magic-procedure-result', castId: state.castId, actorUuid: actor.uuid },
          ...(magic.key === 'tyromancy'
            ? {
                whisper: values(game.users)
                  .filter((entry) => entry.isGM)
                  .map((entry) => entry.id),
              }
            : {}),
        }
      );
      try {
        await updateProcedure(message, state);
      } catch (error) {
        await response.delete();
        throw error;
      }
      return response;
    })
  );
}

async function interruptProcedure({ messageUuid, kind, returned = false, options = {} }, { user }) {
  const { message, state } = await procedureMessage(messageUuid),
    actor = await authorizedActor(state.actorUuid, user);
  if (state.kind !== 'ritual' || !['preparing', 'ready', 'removed'].includes(state.status))
    throw new RuleError('Only an unfinished ritual can be interrupted.');
  if (state.status === 'removed' && kind !== 'removed')
    throw new RuleError('Record the caster’s timely return before resuming preparation.');
  if (kind === 'removed' && !returned && state.status !== 'removed') {
    state.status = 'removed';
    state.removedAt = now();
    return updateProcedure(message, state);
  }
  const interruption = ritualInterruption(kind, { removedAt: state.removedAt, time: now(), returned });
  const result = interruption.canContinue
    ? await check(actor.skillBase('ritualCrafting', { modifier: Number(options.modifier || 0) }).total, {
        manualDice: options.manualDice,
        actor,
        context: { skill: 'ritualCrafting', dc: interruption.dc },
      })
    : null;
  const success = !!result && !result.fumble && beats(result.total, interruption.dc);
  if (success && kind === 'removed') state.readyAt += now() - state.removedAt;
  state.status = success ? (now() >= state.readyAt ? 'ready' : 'preparing') : 'interrupted';
  state.result = success
    ? 'Focus retained; preparation continues.'
    : 'Preparation is interrupted. No final casting roll or STA expenditure occurred.';
  state.interruptions = [...(state.interruptions ?? []), { kind, at: now(), dc: interruption.dc, success }];
  const response = await chat(
    actor,
    `${state.name} · interruption`,
    (result ? checkHTML(result) : '') + `<p>${e(state.result)}</p>`,
    { rolls: result?.rolls ?? [] }
  );
  try {
    await updateProcedure(message, state);
  } catch (error) {
    await response.delete();
    throw error;
  }
  return response;
}

async function cancelProcedure({ messageUuid }, { user }) {
  const { message, state } = await procedureMessage(messageUuid);
  await authorizedActor(state.actorUuid, user);
  if (!['preparing', 'ready', 'awaiting-ruling', 'removed'].includes(state.status))
    throw new RuleError('The procedure has already ended.');
  state.status = 'cancelled';
  state.result = 'Preparation stopped before the final casting attempt.';
  return updateProcedure(message, state);
}

/** All result callbacks return {actor,changes,items?} plans; they must not mutate documents themselves. */
export function registerMagicProcedures(configuration = {}) {
  handlers = configuration;
  registerCommand('magicProcedureBegin', beginProcedure);
  registerCommand('magicProcedureFinish', finishProcedure);
  registerCommand('magicProcedureInterrupt', interruptProcedure);
  registerCommand('magicProcedureCancel', cancelProcedure);
  registerCommand('magicHexIdentify', identifyHex);
  registerCommand('magicHexLift', liftHex);
  Hooks.on('updateWorldTime', () => {
    if (!isPrimaryActiveGm()) return;
    serial('witcher-authority', async () => {
      for (const message of values(game.messages)) {
        const state = message.flags?.[SYSTEM_ID];
        if (!message.author?.isGM || state?.type !== 'magic-procedure' || state.kind !== 'ritual') continue;
        if (state.status === 'preparing' && now() >= state.readyAt)
          await updateProcedure(message, { ...clone(state), status: 'ready' });
        if (state.status === 'removed' && now() > state.removedAt + 3)
          await updateProcedure(message, {
            ...clone(state),
            status: 'interrupted',
            result: 'The caster did not return within one round.',
          });
      }
    }).catch(errorNotice);
  });
}

/** Self-contained entry controller; new procedure cards carry their own action controls. */
export async function castProcedure(actor, item, { targetUuid = '' } = {}) {
  const magic = magicInfo(item?.system.magic?.key);
  if (!magic || !['ritual', 'hex'].includes(magic.kind)) throw new RuleError('Choose a ritual or hex.');
  if (magic.kind === 'ritual' && magic.cost.formula && handlers.dedicatedProcedure)
    return handlers.dedicatedProcedure({ actor, item, magic, targetUuid });
  const entryChoices =
    magic.kind === 'ritual' && handlers.prepareEntry
      ? await handlers.prepareEntry({ actor, magic, targetUuid })
      : {};
  if (entryChoices === null) return;
  const requirements = magic.kind === 'ritual' ? procedureRequirements(actor, magic, entryChoices) : [];
  const owned = values(actor.items).filter(
    (entry) => !['magic', 'wound', 'skill', 'profession', 'ability'].includes(entry.type)
  );
  let content = `<p>${e(magic.text)}</p>`;
  for (const requirement of requirements) {
    if (requirement.kind === 'prerequisite')
      content += input(`${requirement.id}-note`, `Actual prerequisite: ${requirement.name}`, {
        type: 'text',
      });
    else {
      content += input(
        requirement.id,
        `${requirement.quantity} × ${requirement.name}${requirement.kind === 'retain' ? ' (reusable)' : ''}`,
        {
          options: {
            '': 'Choose inventory material',
            ...Object.fromEntries(
              owned.map((entry) => [entry.id, `${entry.name} (${entry.system.quantity})`])
            ),
          },
          value: owned.find((entry) => normalName(entry.name) === normalName(requirement.name))?.id ?? '',
        }
      );
      if (game.user.isGM)
        content += input(`${requirement.id}-ruling`, 'GM: material substitution ruling (if needed)', {
          type: 'text',
        });
    }
  }
  if (magic.kind === 'ritual') {
    const helpers = values(game.actors).filter(
      (candidate) => candidate.uuid !== actor.uuid && candidate.testUserPermission(game.user, 'OWNER')
    );
    for (let index = 0; index < 4; index++)
      content += input(`helper-${index}`, `Helper ${index + 1}`, {
        options: {
          '': 'No helper',
          ...Object.fromEntries(helpers.map((candidate) => [candidate.uuid, candidate.name])),
        },
      });
  }
  content += input(
    'targetUuid',
    magic.kind === 'hex' ? 'Target Actor or Token UUID' : 'Target Actor or Token UUID (optional)',
    {
      type: 'text',
      value: targetUuid || [...(game.user.targets ?? [])][0]?.document?.uuid || '',
    }
  );
  if (magic.key === 'cleansing-ritual')
    content += input('mode', 'Cleansing target', {
      options: { alcohol: 'Alcohol / drugs', poison: 'Poison / oils', illness: 'Major illness (not plague)' },
    });
  if (['hydromancy', 'oneiromancy'].includes(magic.key))
    content += input('mode', 'Scrying', { options: { past: 'Past event', present: 'Present event' } });
  if (magic.key === 'tyromancy')
    content += input('quality', 'Cheese quality', {
      options: { ordinary: 'Ordinary', high: 'High quality' },
    });
  if (magic.ritual?.greaterDemonDC) content += input('greaterDemon', 'Greater demon', { type: 'checkbox' });
  if (magic.kind === 'ritual' && handlers.procedureFields)
    content += await handlers.procedureFields({ actor, magic, targetUuid, choices: entryChoices });
  const chosen = await prompt(`Prepare ${magic.name}`, content, { button: 'Begin' });
  if (!chosen) return;
  const allocations = Object.fromEntries(
    requirements.map((requirement) => [
      requirement.id,
      requirement.kind === 'prerequisite'
        ? { confirmed: !!chosen[`${requirement.id}-note`], note: chosen[`${requirement.id}-note`] }
        : { itemId: chosen[requirement.id], ruling: chosen[`${requirement.id}-ruling`] },
    ])
  );
  return runCommand(
    'magicProcedureBegin',
    {
      actorUuid: actor.uuid,
      itemId: item.id,
      kind: magic.kind,
      targetUuid: chosen.targetUuid || targetUuid,
      allocations,
      helpers: [0, 1, 2, 3].map((index) => chosen[`helper-${index}`]).filter(Boolean),
      choices: {
        mode: chosen.mode,
        quality: chosen.quality,
        greaterDemon: !!chosen.greaterDemon,
        ...(entryChoices ?? {}),
        ...(handlers.procedureChoices?.({ magic, form: chosen }) ?? {}),
      },
    },
    { label: `Prepare ${magic.name}` }
  );
}

/** The source effect remains on the actor until a GM confirms its actual lifting procedure. */
export async function manageHex(actor, effectId) {
  const { magic } = knownHex(actor, effectId);
  const requirement = hexLiftingRequirements(magic.key);
  const ownedActors = values(game.actors).filter((candidate) =>
    candidate.testUserPermission(game.user, 'OWNER')
  );
  const selected = await prompt(
    magic.name,
    `<p>${e(magic.text)}</p>` +
      input('action', 'Action', {
        options: {
          identify: 'Identify lifting method',
          ...(game.user.isGM ? { lift: 'Confirm completed lifting procedure (GM)' } : {}),
        },
      })
  );
  if (!selected) return;
  if (selected.action === 'identify') {
    const values = await prompt(
      'Identify hex',
      input('actorUuid', 'Identifying actor', {
        options: Object.fromEntries(ownedActors.map((candidate) => [candidate.uuid, candidate.name])),
        value: actor.uuid,
      }) +
        input('skill', 'Knowledge skill', {
          options: { education: 'Education', witcherTraining: 'Witcher Training' },
        }) +
        input('modifier', 'Check modifier', { value: 0 }) +
        manualCheckInput()
    );
    if (values)
      return runCommand('magicHexIdentify', {
        actorUuid: values.actorUuid,
        targetUuid: actor.uuid,
        effectId,
        skill: values.skill,
        options: values,
      });
    return;
  }
  let content = `<p>${e(requirement.procedure)}</p><p>Confirm the scene, elapsed time, consumed uncounted supplies and every printed condition. Counted inventory below is consumed now; do not also deduct it manually.</p>`;
  for (const material of requirement.materials) {
    content +=
      input(
        material.id,
        `${material.quantity} × ${material.name}${material.kind === 'retain' ? ' (retained)' : ''}`,
        {
          options: {
            '': 'Choose inventory material',
            ...Object.fromEntries(
              values(actor.items).map((item) => [item.id, `${item.name} (${item.system.quantity})`])
            ),
          },
          value:
            values(actor.items).find((item) => normalName(item.name) === normalName(material.name))?.id ?? '',
        }
      ) + input(`${material.id}-ruling`, 'Material substitution ruling if needed', { type: 'text' });
  }
  if (requirement.check)
    content += input('checkTotal', 'Previously completed Fine Arts total (must beat DC14)');
  content += input('evidence', 'GM: what fulfilled every printed condition?', { type: 'text' });
  const lifted = await prompt(`Lift ${magic.name}`, content, { button: 'Confirm and lift' });
  if (!lifted) return;
  return runCommand('magicHexLift', {
    actorUuid: actor.uuid,
    effectId,
    evidence: lifted.evidence,
    checkTotal: lifted.checkTotal,
    allocations: Object.fromEntries(
      requirement.materials.map((material) => [
        material.id,
        { itemId: lifted[material.id], ruling: lifted[`${material.id}-ruling`] },
      ])
    ),
  });
}

export function registerMagicProcedureChat() {
  Hooks.on('renderChatMessageHTML', (message, html) => {
    if (message.flags?.[SYSTEM_ID]?.type !== 'magic-procedure') return;
    for (const button of html.querySelectorAll('[data-magic-procedure]'))
      button.addEventListener('click', async () => {
        try {
          const action = button.dataset.magicProcedure;
          if (action === 'cancel')
            return await runCommand('magicProcedureCancel', { messageUuid: message.uuid });
          if (action === 'interrupt') {
            const selected = await prompt(
              'Ritual interruption',
              input('kind', 'Interruption', {
                options: {
                  distracted: 'Shaken / distracted (DC15)',
                  harmed: 'Physically harmed (DC18)',
                  removed: 'Removed / return (DC16)',
                },
              }) +
                input('returned', 'Returned to the ritual within one round', { type: 'checkbox' }) +
                manualCheckInput()
            );
            if (selected)
              await runCommand('magicProcedureInterrupt', {
                messageUuid: message.uuid,
                kind: selected.kind,
                returned: selected.returned,
                options: selected,
              });
            return;
          }
          const state = message.flags[SYSTEM_ID];
          const actor = await resolveFoundryUuid(state.actorUuid);
          const focuses = values(actor?.items).filter(
            (item) =>
              item.system.equipped &&
              item.system.properties?.focus > 0 &&
              item.system.quantity > 0 &&
              item.system.carried !== false
          );
          const selected = await prompt(
            `Complete ${state.name}`,
            input('modifier', 'Check modifier', { value: 0 }) +
              manualCheckInput() +
              input('focusId', 'Held focus — choose one', {
                options: {
                  '': 'No focus',
                  ...Object.fromEntries(
                    focuses.map((item) => [item.id, `${item.name} (Focus ${item.system.properties.focus})`])
                  ),
                },
              }) +
              input('overdraw', 'Allow Vigor overexertion', { type: 'checkbox' }) +
              (state.kind === 'hex'
                ? input('dc', 'GM: actual opposition total') +
                  input('ruling', 'GM: opposition/range ruling', { type: 'text' })
                : ''),
            { button: 'Complete' }
          );
          if (selected)
            await runCommand('magicProcedureFinish', { messageUuid: message.uuid, options: selected });
        } catch (error) {
          errorNotice(error);
        }
      });
  });
}
