import { SYSTEM_ID } from './config.js';
import { RuleError, beats, skillImprovementCost } from './rules.js';
import { MAGIC, magicInfo, magicItemData } from './magic-catalog.js';
import { magicTradition, magicVigor } from './magic-state.js';
import { forgottenMagic } from './magic-hex-runtime.js';
import { elementalBacklash } from './magic-rules.js';
import { placeOfPowerPlan, leyLineBenefits } from './magic-power-rules.js';
export {
  placeOfPowerPlan,
  placeOfPowerBenefits,
  leyLineBenefits,
  leyDamageFormula,
  leyLineMishapPlan,
} from './magic-power-rules.js';
import { registerCommand, runCommand, authorizedActor } from './authority.js';
import { isPrimaryActiveGm, resolveFoundryUuid } from '../foundry-compat.js';
import {
  actionPlan,
  check,
  checkHTML,
  dice,
  chat,
  commitActor,
  prompt,
  input,
  manualCheckInput,
  escapeHTML as e,
  turnIdentity,
  errorNotice,
  serial,
} from './runtime.js';

const DAY = 86400,
  HOUR = 3600;
const copy = (value) => structuredClone(value);
const list = (value) => value?.contents ?? Array.from(value ?? []);
const now = () => Number(game.time.worldTime);
const idFor = () => foundry.utils.randomID();
let adapters = {};
const numeric = (value, label, min = 0) => {
  const result = Number(value);
  if (!Number.isFinite(result) || result < min)
    throw new RuleError(`${label} must be a number of at least ${min}.`);
  return result;
};
const integer = (value, label, min = 0) => {
  const result = numeric(value, label, min);
  if (!Number.isInteger(result)) throw new RuleError(`${label} must be a whole number.`);
  return result;
};

export const LEARNING_TIERS = Object.freeze({
  novice: { ip: 10, seconds: 4 * DAY, dc: 14, checks: 2 },
  journeyman: { ip: 20, seconds: 7 * DAY, dc: 18, checks: 4 },
  master: { ip: 30, seconds: 21 * DAY, dc: 22, checks: 6 },
  archpriest: { ip: 40, seconds: 35 * DAY, dc: 24, checks: 8 },
});
export function learningRequirements(value, { tierRuling = '' } = {}) {
  const magic = typeof value === 'string' ? magicInfo(value) : value;
  if (!magic) throw new RuleError('Choose a catalog magic entry to learn.');
  const tier = { low: 'novice', medium: 'journeyman', high: 'master' }[magic.tier] ?? magic.tier;
  const resolved = LEARNING_TIERS[tier] ? tier : tierRuling;
  if (!LEARNING_TIERS[resolved])
    throw new RuleError(
      'The learning table does not classify this entry. The GM must record its learning tier.'
    );
  return {
    ...LEARNING_TIERS[resolved],
    tier: resolved,
    rulingRequired: !LEARNING_TIERS[tier],
    skill: magic.kind === 'hex' ? 'hexWeaving' : magic.kind === 'ritual' ? 'ritualCrafting' : 'spellCasting',
  };
}
export function learningEligibility(state, magic) {
  const tradition = magicTradition(state);
  if (
    (state.effects ?? []).some(
      (effect) =>
        effect.magic?.kind === 'hex' &&
        effect.magic.key === 'hex-of-forgetfulness' &&
        !effect.disabled &&
        !effect.magic.suppressed
    )
  )
    return { allowed: false, reason: 'Hex of Forgetfulness prevents learning new magic.' };
  if (state.magic?.birthEligible !== true)
    return {
      allowed: false,
      reason: 'Record that this character started with Vigor above zero (Core p.123).',
    };
  const permitted =
    {
      mage: ['spell', 'sign', 'ritual', 'hex'],
      priest: ['invocation', 'sign', 'ritual', 'hex'],
      druid: ['invocation', 'sign', 'ritual', 'hex'],
      witcher: ['sign'],
      talent: [],
    }[tradition] ?? [];
  return {
    allowed: permitted.includes(magic.kind),
    reason: permitted.includes(magic.kind) ? '' : 'This tradition cannot learn that kind of magic.',
  };
}

/** Study checks have no invented successful-check interval. Only failures force
 * the next day; minimum total study duration remains mandatory. */
export function beginLearningPlan(state, magic, { id, source, time, tierRuling = '', ruling = '' } = {}) {
  const eligibility = learningEligibility(state, magic);
  if (!eligibility.allowed) throw new RuleError(eligibility.reason);
  const requirements = learningRequirements(magic, { tierRuling });
  if (requirements.rulingRequired && !String(ruling).trim())
    throw new RuleError('Record the GM’s learning-tier ruling.');
  if (!id || !source?.description?.trim())
    throw new RuleError('A real teacher or tome must be recorded as the learning source.');
  numeric(time, 'World time', -Infinity);
  if ((state.magic?.learning ?? []).some((row) => row.key === magic.key && row.status === 'studying'))
    throw new RuleError('This magic is already being studied.');
  const restricted = Math.min(requirements.ip, numeric(state.magic?.magicIP ?? 0, 'Restricted magic IP'));
  const ordinary = requirements.ip - restricted;
  if (numeric(state.ip ?? 0, 'IP') < ordinary)
    throw new RuleError(`Learning requires ${requirements.ip} IP.`);
  const record = {
    id,
    key: magic.key,
    name: magic.name,
    status: 'studying',
    source: copy(source),
    requirements,
    ruling,
    startedAt: time,
    readyAt: time + requirements.seconds,
    nextCheckAt: time,
    successes: 0,
    failures: 0,
    attempts: [],
    paid: { ordinary, restricted },
  };
  return {
    record,
    changes: {
      'system.ip': (state.ip ?? 0) - ordinary,
      'system.magic.magicIP': (state.magic?.magicIP ?? 0) - restricted,
      'system.magic.learning': [...copy(state.magic?.learning ?? []), record],
    },
  };
}
export function learningCheckPlan(record, { total, time, nextDayAt } = {}) {
  if (record.status !== 'studying') throw new RuleError('This learning project is not active.');
  numeric(time, 'World time', -Infinity);
  numeric(total, 'Learning total', -Infinity);
  if (time < record.nextCheckAt) throw new RuleError('A failed learning check must wait until the next day.');
  if (record.successes >= record.requirements.checks)
    throw new RuleError('All learning checks are complete; finish the remaining study time.');
  const success = beats(total, record.requirements.dc),
    next = copy(record);
  next.attempts.push({ time, total, success });
  if (success) next.successes++;
  else {
    next.failures++;
    next.readyAt += DAY;
    next.nextCheckAt = nextDayAt ?? (Math.floor(time / DAY) + 1) * DAY;
    if (!(next.nextCheckAt > time)) throw new RuleError('The next study day must begin after this attempt.');
  }
  return {
    record: next,
    success,
    complete: next.successes >= next.requirements.checks && time >= next.readyAt,
  };
}
export function finishLearningPlan(record, time) {
  if (record.status !== 'studying') throw new RuleError('This learning project is no longer active.');
  if (record.successes < record.requirements.checks)
    throw new RuleError('More successful learning checks are required.');
  if (time < record.readyAt)
    throw new RuleError(`Study requires ${record.readyAt - time} more seconds of world time.`);
  return { ...copy(record), status: 'complete', completedAt: time };
}

export function magicSkillImprovementPlan(state, skill) {
  if (!['spellCasting', 'ritualCrafting', 'hexWeaving'].includes(skill))
    throw new RuleError(
      'This restricted-pool action covers the three casting skills; the GM adjudicates other magical skills.'
    );
  const rank = state.skills?.[skill] ?? 0,
    cost = skillImprovementCost(rank, true);
  const restricted = Math.min(cost, numeric(state.magic?.magicIP ?? 0, 'Restricted magic IP'));
  const ordinary = cost - restricted;
  if ((state.ip ?? 0) < ordinary) throw new RuleError(`Improvement requires ${cost} IP.`);
  return {
    cost,
    changes: {
      [`system.skills.${skill}`]: rank + 1,
      'system.ip': (state.ip ?? 0) - ordinary,
      'system.magic.magicIP': (state.magic?.magicIP ?? 0) - restricted,
    },
  };
}

async function sourceDocument(uuid, kind) {
  const source = await resolveFoundryUuid(uuid),
    config = source?.flags?.[SYSTEM_ID]?.magicSource;
  if (source?.documentName !== 'Region' || config?.kind !== kind)
    throw new RuleError('Select a GM-configured native Region for this magical source.');
  return { source, config };
}
async function sourceContact(actor, tokenUuid, source) {
  const token = await resolveFoundryUuid(tokenUuid);
  if (
    token?.documentName !== 'Token' ||
    token.actor?.uuid !== actor.uuid ||
    token.parent?.uuid !== source.parent?.uuid ||
    typeof token.testInsideRegion !== 'function' ||
    !token.testInsideRegion(source)
  )
    throw new RuleError('The caster must be physically inside the magical source Region.');
  return token;
}
export async function validateLeyContact(actor) {
  const connection = actor.system.magic?.leyConnection;
  if (!connection?.active) return false;
  try {
    const { source, config } = await sourceDocument(connection.sourceUuid, 'ley');
    if (config.element !== connection.element) return false;
    await sourceContact(actor, connection.tokenUuid, source);
    return true;
  } catch {
    return false;
  }
}

function findProject(actor, id) {
  const records = copy(actor.system.magic.learning ?? []),
    index = records.findIndex((record) => record.id === id);
  if (index < 0) throw new RuleError('The learning project no longer exists.');
  return { records, record: records[index], index };
}
async function startLearning(payload, { user, id }) {
  const actor = await authorizedActor(payload.actorUuid, user),
    magic = magicInfo(payload.magicKey);
  if (!magic) throw new RuleError('Unknown magic.');
  if (list(actor.items).some((item) => item.type === 'magic' && item.system.magic.key === magic.key))
    throw new RuleError('This actor already knows this magic.');
  if (!user.isGM)
    throw new RuleError('The GM records the teacher/tome, birth eligibility, and any learning-tier ruling.');
  const state = actor.system.toObject();
  if (payload.birthEligible === true) state.magic.birthEligible = true;
  const plan = beginLearningPlan(state, magic, {
    id,
    time: now(),
    source: payload.source,
    tierRuling: payload.tierRuling,
    ruling: payload.ruling,
  });
  if (payload.birthEligible === true) plan.changes['system.magic.birthEligible'] = true;
  return commitActor(actor, plan.changes, [], () =>
    chat(
      actor,
      `Study ${magic.name}`,
      `<p>${e(payload.source.description)} · ${plan.record.requirements.ip} IP spent. ${plan.record.requirements.checks} checks, DC ${plan.record.requirements.dc}; earliest finish world time ${plan.record.readyAt}.</p>`,
      { flags: { kind: 'magic-learning', actorUuid: actor.uuid, projectId: id } }
    )
  );
}
async function attemptLearning({ actorUuid, projectId, values = {} }, { user }) {
  const actor = await authorizedActor(actorUuid, user),
    { records, record, index } = findProject(actor, projectId);
  const eligibility = learningEligibility(actor.system, magicInfo(record.key));
  if (!eligibility.allowed) throw new RuleError(eligibility.reason);
  learningCheckPlan(record, { total: 0, time: now() }); // Preflight before rolling/spending Luck.
  const luck = integer(values.luck ?? 0, 'Luck');
  if (luck > actor.system.luck.value) throw new RuleError('Not enough Luck.');
  const result = await check(
    actor.skillBase(record.requirements.skill, {
      modifier: numeric(values.modifier ?? 0, 'Modifier', -Infinity) + luck + (record.source.formula ? 2 : 0),
    }).total,
    { ...{ manualDice: values.manualDice }, actor: actor }
  );
  const outcome = learningCheckPlan(record, { total: result.total, time: now() });
  records[index] = outcome.record;
  return commitActor(
    actor,
    { 'system.magic.learning': records, 'system.luck.value': actor.system.luck.value - luck },
    [],
    () =>
      chat(
        actor,
        `Learning: ${record.name}`,
        checkHTML(result) +
          `<p>${outcome.success ? 'Successful study check.' : 'Failed: add one day of study and wait until the next day before retrying.'}</p>`,
        { rolls: result.rolls }
      )
  );
}
async function improveMagicSkill({ actorUuid, skill }, { user }) {
  const actor = await authorizedActor(actorUuid, user),
    plan = magicSkillImprovementPlan(actor.system, skill);
  return commitActor(actor, plan.changes, [], () =>
    chat(
      actor,
      'Magical skill improved',
      `<p>${e(skill)} increases one rank for ${plan.cost} IP, spending restricted magic IP first.</p>`
    )
  );
}
async function finishLearning({ actorUuid, projectId }, { user }) {
  const actor = await authorizedActor(actorUuid, user),
    { records, record, index } = findProject(actor, projectId);
  const eligibility = learningEligibility(actor.system, magicInfo(record.key));
  if (!eligibility.allowed) throw new RuleError(eligibility.reason);
  records[index] = finishLearningPlan(record, now());
  if (list(actor.items).some((item) => item.type === 'magic' && item.system.magic.key === record.key))
    throw new RuleError('This actor already has that magic; review the duplicate with the GM.');
  let created = [];
  try {
    return await commitActor(actor, { 'system.magic.learning': records }, [], async () => {
      created = await actor.createEmbeddedDocuments('Item', [magicItemData(record.key)]);
      return chat(
        actor,
        `Learned ${record.name}`,
        '<p>Required checks and study time completed; the learned magic is on the character sheet.</p>'
      );
    });
  } catch (error) {
    if (created.length)
      await actor.deleteEmbeddedDocuments(
        'Item',
        created.map((item) => item.id)
      );
    throw error;
  }
}

async function defaultBacklash(actor, { element, damage = 0 }) {
  const backlash = elementalBacklash(element),
    changes = {};
  if (damage) {
    changes['system.hp.value'] = actor.system.hp.value - damage;
    if (changes['system.hp.value'] <= 0)
      changes['system.pendingDeathSaves'] = actor.system.pendingDeathSaves + 1;
  }
  if (backlash.condition)
    changes['system.conditions'] = [...new Set([...actor.system.conditions, backlash.condition])];
  return { changes, backlash, pending: !!backlash.pushMeters };
}
function backlashCard(actor, token, id, title, consequence, result, content = '') {
  const checkData = result
    ? Object.fromEntries(Object.entries(result).filter(([key]) => key !== 'rolls'))
    : { total: 0, base: 0, dice: [], fumble: 0 };
  return chat(
    actor,
    title,
    content +
      (consequence.pending
        ? '<button type="button" data-magic-action="backlash">Resolve air backlash (GM)</button>'
        : ''),
    {
      rolls: result?.rolls ?? [],
      flags: {
        kind: 'magic-backlash',
        castId: id,
        actorUuid: actor.uuid,
        tokenUuid: token.uuid,
        name: title,
        element: consequence.backlash?.element,
        check: checkData,
        fumble: { focusExplosion: false },
        backlash: consequence.backlash,
        backlashResolved: !consequence.pending,
        failed: true,
        targets: [],
        power: 0,
        staCost: 0,
        hpCost: 0,
        roundSpend: 0,
        vigor: magicVigor(actor.system),
      },
    }
  );
}
async function configureSource({ sourceUuid, kind, element, monthSeconds }, { user }) {
  if (!user.isGM) throw new RuleError('Only the GM can designate a Place of Power or Ley Line.');
  const source = await resolveFoundryUuid(sourceUuid);
  if (source?.documentName !== 'Region') throw new RuleError('Choose a native Scene Region.');
  if (!['place', 'ley'].includes(kind) || !['earth', 'air', 'fire', 'water'].includes(element))
    throw new RuleError('Choose a source kind and element.');
  const config = {
    kind,
    element,
    ...(kind === 'place' ? { monthSeconds: numeric(monthSeconds, 'Calendar month duration', 1) } : {}),
  };
  return source.update({ [`flags.${SYSTEM_ID}.magicSource`]: config });
}
async function concentratePower({ actorUuid, sourceUuid, tokenUuid, mode, turn, values = {} }, { user, id }) {
  const actor = await authorizedActor(actorUuid, user),
    { source, config } = await sourceDocument(sourceUuid, 'place');
  const token = await sourceContact(actor, tokenUuid, source);
  if (!['attune', 'essence'].includes(mode))
    throw new RuleError('Choose attunement or Fifth Essence extraction.');
  if (magicVigor(actor.system) <= 0)
    throw new RuleError('Only a magically potent character can draw from a Place of Power.');
  const previous = actor.system.magic.powerFocus,
    active = game.combat?.started;
  const same =
    previous?.sourceUuid === sourceUuid && previous?.mode === mode && previous?.tokenUuid === tokenUuid;
  const plan = actionPlan(actor, { full: true, expectedTurn: turn });
  let progress;
  if (active) {
    if (same && previous.lastRound === game.combat.round)
      throw new RuleError('This full turn of concentration has already been recorded.');
    const continuous =
      same && previous.combatId === game.combat.id && previous.lastRound === game.combat.round - 1;
    progress = {
      sourceUuid,
      tokenUuid,
      mode,
      combatId: game.combat.id,
      lastRound: game.combat.round,
      turns: continuous ? previous.turns + 1 : 1,
    };
  } else {
    if (same && now() < previous.readyAt)
      throw new RuleError(`Concentrate for ${previous.readyAt - now()} more seconds of world time.`);
    progress = same
      ? { ...copy(previous), turns: 3 }
      : { sourceUuid, tokenUuid, mode, turns: 0, readyAt: now() + 9 };
  }
  if (progress.turns < 3)
    return commitActor(actor, { ...plan.changes, 'system.magic.powerFocus': progress }, [], () =>
      chat(
        actor,
        'Focus on a Place of Power',
        `<p>${active ? `${progress.turns}/3 full turns recorded.` : 'Concentrate for three full turns (9 seconds); advance world time before finishing.'}</p>`
      )
    );
  const uses = copy(actor.system.magic.powerUses ?? []),
    index = uses.findIndex((entry) => entry.sourceUuid === sourceUuid);
  const options = {
    sourceUuid,
    element: config.element,
    mode,
    time: now(),
    monthSeconds: config.monthSeconds,
  };
  let outcome = placeOfPowerPlan(uses[index], options),
    result = null,
    damage = null;
  if (outcome.needsEndurance) {
    result = await check(
      actor.skillBase('endurance', { modifier: numeric(values.modifier ?? 0, 'Modifier', -Infinity) }).total,
      { ...{ manualDice: values.manualDice }, actor: actor }
    );
    if (!beats(result.total, outcome.dc)) damage = await dice('5d6');
    outcome = placeOfPowerPlan(uses[index], {
      ...options,
      enduranceTotal: result.total,
      damageRoll: damage?.total ?? 0,
    });
  }
  const consequence = outcome.backlash
    ? await (adapters.planBacklash ?? defaultBacklash)(actor, {
        element: config.element,
        damage: outcome.damage,
        reason: 'place-of-power',
        sourceUuid,
      })
    : { changes: {}, pending: false };
  const changes = { ...plan.changes, ...consequence.changes, 'system.magic.powerFocus': {} };
  if (index < 0) uses.push(outcome.record);
  else uses[index] = outcome.record;
  changes['system.magic.powerUses'] = uses;
  if (outcome.magicIP) changes['system.magic.magicIP'] = (actor.system.magic.magicIP ?? 0) + outcome.magicIP;
  if (outcome.benefit)
    changes['system.effects'] = [
      ...copy(actor.system.effects),
      {
        id,
        key: `Place of Power: ${config.element}`,
        expires: outcome.benefit.expires,
        modifiers: {},
        magic: { key: 'place-of-power', placeOfPower: { ...outcome.benefit, sourceUuid } },
      },
    ];
  const itemChanges = [],
    created = [];
  let essenceData = null;
  if (outcome.essence) {
    const existing = list(actor.items).find(
      (item) => item.type === 'component' && item.name === 'Fifth Essence'
    );
    if (existing) itemChanges.push({ _id: existing.id, 'system.quantity': existing.system.quantity + 5 });
    else {
      const pack = game.packs.get(`${SYSTEM_ID}.components`),
        document = await pack?.getDocument('e13821c5ce96c17f');
      if (!document)
        throw new RuleError('The canonical Fifth Essence component is missing from its compendium.');
      essenceData = document.toObject();
      delete essenceData._id;
      essenceData.system.quantity = 5;
    }
  }
  try {
    return await commitActor(actor, changes, itemChanges, async () => {
      if (essenceData) created.push(...(await actor.createEmbeddedDocuments('Item', [essenceData])));
      const content = `<p>${outcome.magicIP ? 'Gain10 restricted magic IP and the one-hour elemental benefit.' : 'Extract5 Fifth Essence.'}${outcome.damage ? ` Repeated draw: ${outcome.damage} direct HP lost and elemental backlash.` : ''}</p>`;
      if (consequence.pending)
        return backlashCard(
          actor,
          token,
          id,
          'Place of Power',
          consequence,
          { ...result, rolls: [...(result?.rolls ?? []), ...(damage ? [damage] : [])] },
          content
        );
      return chat(actor, 'Place of Power', (result ? checkHTML(result) : '') + content, {
        rolls: [...(result?.rolls ?? []), ...(damage ? [damage] : [])],
      });
    });
  } catch (error) {
    if (created.length)
      await actor.deleteEmbeddedDocuments(
        'Item',
        created.map((item) => item.id)
      );
    throw error;
  }
}
async function connectLey({ actorUuid, sourceUuid, tokenUuid, turn, values = {} }, { user, id }) {
  const actor = await authorizedActor(actorUuid, user),
    tradition = magicTradition(actor.system);
  if (!['mage', 'priest', 'druid'].includes(tradition))
    throw new RuleError('Only mages, priests and druids can open a Ley Line connection (Tome p.9).');
  if (magicVigor(actor.system) <= 0) throw new RuleError('The caster has no available Vigor to connect.');
  const { source, config } = await sourceDocument(sourceUuid, 'ley'),
    token = await sourceContact(actor, tokenUuid, source);
  if (actor.system.magic.leyConnection?.active)
    throw new RuleError('Disconnect the current Ley Line before opening another.');
  if (actor.system.magic.leyConnection?.pending?.length)
    throw new RuleError('Resolve the pending Ley Line spell before making a new connection.');
  const plan = actionPlan(actor, { expectedTurn: turn, extra: !!values.extra, forfeit: !!values.forfeit });
  const previous = actor.system.magic.leyConnection,
    dc =
      previous?.sourceUuid === sourceUuid ? (previous.dc ?? 16) : (previous?.history?.[sourceUuid]?.dc ?? 16);
  const result = await check(
    actor.skillBase('spellCasting', {
      stat: 'will',
      modifier: plan.modifier + numeric(values.modifier ?? 0, 'Modifier', -Infinity),
    }).total,
    { ...{ manualDice: values.manualDice }, actor: actor }
  );
  const success = beats(result.total, dc);
  let backlashElement = config.element;
  if (!success && ['priest', 'druid'].includes(tradition)) {
    const random = await dice('1d4');
    result.rolls.push(random);
    backlashElement = ['earth', 'air', 'fire', 'water'][random.total - 1];
  }
  const consequence = success
    ? { changes: {}, pending: false }
    : await (adapters.planBacklash ?? defaultBacklash)(actor, {
        element: backlashElement,
        damage: 0,
        reason: 'ley-connection',
        sourceUuid,
      });
  const changes = {
    ...plan.changes,
    ...consequence.changes,
    'system.magic.leyConnection': {
      sourceUuid,
      tokenUuid,
      element: config.element,
      active: success,
      dc,
      history: copy(previous?.history ?? {}),
      connectedAt: now(),
    },
  };
  let borrowed;
  try {
    return await commitActor(actor, changes, [], async () => {
      borrowed = await synchronizeLeyBorrowed(actor);
      return consequence.pending
        ? backlashCard(actor, token, id, 'Ley Line connection', consequence, result, checkHTML(result))
        : chat(
            actor,
            'Ley Line connection',
            checkHTML(result) +
              `<p>DC${dc}: ${success ? `Connected to ${e(config.element)}.` : 'Connection failed: elemental backlash, no additional damage.'}</p>`,
            { rolls: result.rolls }
          );
    });
  } catch (error) {
    await borrowed?.rollback();
    throw error;
  }
}
async function disconnectLey({ actorUuid }, { user }) {
  const actor = await authorizedActor(actorUuid, user),
    connection = actor.system.magic.leyConnection;
  if (!connection?.active) throw new RuleError('There is no active Ley Line connection.');
  const changes = {
    'system.magic.leyConnection': {
      ...copy(connection),
      active: false,
      disconnectedAt: now(),
      ...(connection.hallucinating ? { hallucinationsEndBy: now() + 60 } : {}),
    },
  };
  if (connection.hallucinating)
    changes['system.effects'] = copy(actor.system.effects).map((effect) =>
      effect.magic?.leyHallucinationSource === connection.sourceUuid
        ? { ...effect, expires: now() + 60 }
        : effect
    );
  let borrowed;
  try {
    return await commitActor(actor, changes, [], async () => {
      borrowed = await synchronizeLeyBorrowed(actor);
      return chat(
        actor,
        'Ley Line disconnected',
        `<p>The connection ends.${connection.hallucinating ? ' The GM ends the remaining hallucinations within one minute.' : ''}</p>`
      );
    });
  } catch (error) {
    await borrowed?.rollback();
    throw error;
  }
}

/** Temporary Air access uses real Items tagged with their actual source Region.
 * The known-spell tiers exclude these borrowed Items and amulet grants. */
export async function synchronizeLeyBorrowed(actor) {
  const existing = list(actor.items).filter((item) => item.flags?.[SYSTEM_ID]?.leyBorrowed);
  const known = list(actor.items).filter(
    (item) =>
      item.type === 'magic' &&
      !item.flags?.[SYSTEM_ID]?.leyBorrowed &&
      !item.flags?.[SYSTEM_ID]?.magicAmulet &&
      !forgottenMagic(actor.system, item.system.magic.key)
  );
  const sourceUuid = actor.system.magic.leyConnection?.sourceUuid;
  const eligible = leyLineBenefits(
    actor.system,
    { kind: 'spell', element: 'air' },
    { knownMagic: known.map((item) => item.system.magic.key) }
  ).borrowedMagic;
  const native = new Set(known.map((item) => item.system.magic.key));
  const desired = eligible.filter((key) => !native.has(key));
  const stale = existing.filter(
    (item) =>
      !desired.includes(item.system.magic.key) || item.flags[SYSTEM_ID].leyBorrowed.sourceUuid !== sourceUuid
  );
  const needed = desired
    .filter((key) => !existing.some((item) => !stale.includes(item) && item.system.magic.key === key))
    .map((key) => {
      const data = magicItemData(key);
      data.flags = {
        ...data.flags,
        [SYSTEM_ID]: { ...data.flags?.[SYSTEM_ID], leyBorrowed: { sourceUuid, key } },
      };
      return data;
    });
  let created = [],
    deleted = [];
  const rollback = async () => {
    if (created.length)
      await actor.deleteEmbeddedDocuments(
        'Item',
        created.map((item) => item.id),
        { witcherLeyBorrowed: true }
      );
    if (deleted.length)
      await actor.createEmbeddedDocuments('Item', deleted, { keepId: true, witcherLeyBorrowed: true });
  };
  try {
    if (needed.length)
      created = await actor.createEmbeddedDocuments('Item', needed, { witcherLeyBorrowed: true });
    if (stale.length) {
      deleted = stale.map((item) => item.toObject());
      await actor.deleteEmbeddedDocuments(
        'Item',
        stale.map((item) => item.id),
        { witcherLeyBorrowed: true }
      );
    }
    return { rollback };
  } catch (error) {
    await rollback();
    throw error;
  }
}

export function magicLearningDisplay(actor, time = now()) {
  const magic = actor.system.magic ?? {};
  return {
    ip: actor.system.ip,
    magicIP: magic.magicIP ?? 0,
    birthEligible: magic.birthEligible === true,
    projects: (magic.learning ?? []).map((record) => ({
      ...copy(record),
      canCheck:
        record.status === 'studying' &&
        record.successes < record.requirements.checks &&
        time >= record.nextCheckAt,
      canFinish:
        record.status === 'studying' &&
        record.successes >= record.requirements.checks &&
        time >= record.readyAt,
      remainingSeconds: Math.max(0, record.readyAt - time),
    })),
    powerFocus: copy(magic.powerFocus ?? {}),
    leyConnection: copy(magic.leyConnection ?? {}),
  };
}

async function chooseActorToken(actor) {
  const controlled = list(globalThis.canvas?.tokens?.controlled)
    .map((token) => token.document)
    .filter((token) => token.actor?.uuid === actor.uuid);
  const tokens = controlled.length
    ? controlled
    : list(globalThis.canvas?.scene?.tokens).filter((token) => token.actor?.uuid === actor.uuid);
  if (!tokens.length) throw new RuleError('Place this actor’s token on the viewed scene.');
  if (tokens.length === 1) return tokens[0];
  const chosen = await prompt(
    'Choose caster token',
    input('tokenId', 'Token', { options: Object.fromEntries(tokens.map((token) => [token.id, token.name])) }),
    { button: 'Choose' }
  );
  return chosen ? tokens.find((token) => token.id === chosen.tokenId) : null;
}
export async function magicLearningAction(actor, action, projectId = '') {
  const turn = turnIdentity();
  if (action === 'learn') {
    if (!game.user.isGM) throw new RuleError('The GM starts study after confirming the teacher or tome.');
    const options = Object.fromEntries(
      MAGIC.map((magic) => [magic.key, `${magic.name} (${magic.kind}, ${magic.tier})`])
    );
    const values = await prompt(
      'Begin learning magic',
      input('magicKey', 'Magic', { options }) +
        input('source', 'Teacher / tome and where it is available', { type: 'text' }) +
        input('formula', 'Specific spell formula source (+2 learning checks, Tome p.118)', {
          type: 'checkbox',
        }) +
        input('birthEligible', 'Character started with Vigor above zero', {
          type: 'checkbox',
          checked: actor.system.magic.birthEligible === true,
        }) +
        input('tierRuling', 'GM tier if not classified in Core table', {
          options: {
            '': 'Use printed tier',
            novice: 'Novice',
            journeyman: 'Journeyman',
            master: 'Master',
            archpriest: 'Arch Priest',
          },
        }) +
        input('ruling', 'Reason for a tier ruling (if needed)', { type: 'text' }) +
        '<p>Spend restricted magic IP first, then ordinary IP. The minimum study time and checks apply before the item is learned.</p>',
      { button: 'Spend IP and begin' }
    );
    if (!values) return;
    return runCommand('magicLearnStart', {
      actorUuid: actor.uuid,
      ...values,
      source: { description: values.source, formula: !!values.formula, approvedBy: game.user.id },
    });
  }
  if (action === 'study') {
    const values = await prompt(
      'Learning check',
      manualCheckInput() +
        input('modifier', 'Situational modifier', { value: 0 }) +
        input('luck', 'Luck', { value: 0, min: 0, max: actor.system.luck.value })
    );
    if (!values) return;
    return runCommand('magicLearnCheck', { actorUuid: actor.uuid, projectId, values });
  }
  if (action === 'finish') return runCommand('magicLearnFinish', { actorUuid: actor.uuid, projectId });
  if (action === 'improve') {
    const values = await prompt(
      'Improve a magical skill',
      input('skill', 'Skill', {
        options: {
          spellCasting: 'Spell Casting',
          ritualCrafting: 'Ritual Crafting',
          hexWeaving: 'Hex Weaving',
        },
      }) + '<p>Uses the normal doubled improvement cost; restricted magic IP is spent first.</p>',
      { button: 'Spend IP and improve' }
    );
    if (!values) return;
    return runCommand('magicImproveSkill', { actorUuid: actor.uuid, skill: values.skill });
  }
  if (action === 'disconnect') return runCommand('magicLeyDisconnect', { actorUuid: actor.uuid });
  const token = await chooseActorToken(actor);
  if (!token) return;
  if (action === 'configure') {
    if (!game.user.isGM) throw new RuleError('Only the GM configures magical sources.');
    const regions = list(token.parent.regions);
    if (!regions.length)
      throw new RuleError('Draw the Place of Power or Ley Line as a native Scene Region first.');
    const values = await prompt(
      'Configure magical source',
      input('sourceUuid', 'Native Region', {
        options: Object.fromEntries(regions.map((region) => [region.uuid, region.name])),
      }) +
        input('kind', 'Source', { options: { place: 'Place of Power', ley: 'Ley Line' } }) +
        input('element', 'Element', {
          options: { earth: 'Earth', air: 'Air', fire: 'Fire', water: 'Water' },
        }) +
        input('monthDays', 'Calendar month length in days (Place of Power only)', { value: '', min: 1 }),
      { button: 'Configure source' }
    );
    if (!values) return;
    return runCommand('magicSourceConfigure', { ...values, monthSeconds: Number(values.monthDays) * DAY });
  }
  if (!['power', 'connect'].includes(action)) throw new RuleError('Unknown magic learning action.');
  const kind = action === 'power' ? 'place' : 'ley';
  const regions = list(token.parent.regions).filter(
    (region) => region.flags?.[SYSTEM_ID]?.magicSource?.kind === kind && token.testInsideRegion(region)
  );
  if (!regions.length) throw new RuleError('Move into a GM-configured source Region first.');
  const values = await prompt(
    action === 'power' ? 'Draw from a Place of Power' : 'Connect to a Ley Line',
    input('sourceUuid', 'Source', {
      options: Object.fromEntries(regions.map((region) => [region.uuid, region.name])),
    }) +
      (action === 'power'
        ? input('mode', 'Benefit', {
            options: {
              attune: 'Elemental benefit and 10 magic IP',
              essence: 'Extract5 Fifth Essence instead',
            },
          })
        : '') +
      manualCheckInput() +
      input('modifier', 'Check modifier', { value: 0 }) +
      (action === 'power'
        ? '<p>Uses three full turns. Repeated draws before one calendar month require Endurance, with5d6 HP and elemental backlash on failure.</p>'
        : '<p>Uses one action. DC16 Spell Casting; a failure causes elemental backlash without additional damage.</p>'),
    { button: action === 'power' ? 'Concentrate / finish' : 'Connect' }
  );
  if (!values) return;
  return runCommand(action === 'power' ? 'magicPowerConcentrate' : 'magicLeyConnect', {
    actorUuid: actor.uuid,
    tokenUuid: token.uuid,
    sourceUuid: values.sourceUuid,
    mode: values.mode,
    turn,
    values,
  });
}

/** Call once at ready. UI buttons may call magicLearningAction directly, or use
 * data-magic-learning/data-actor/data-project on a chat card. */
export function registerMagicLearning(options = {}) {
  adapters = options;
  registerCommand('magicLearnStart', startLearning);
  registerCommand('magicLearnCheck', attemptLearning);
  registerCommand('magicLearnFinish', finishLearning);
  registerCommand('magicImproveSkill', improveMagicSkill);
  registerCommand('magicSourceConfigure', configureSource);
  registerCommand('magicPowerConcentrate', concentratePower);
  registerCommand('magicLeyConnect', connectLey);
  registerCommand('magicLeyDisconnect', disconnectLey);
  Hooks.on('renderChatMessageHTML', (message, html) => {
    html.querySelectorAll('[data-magic-learning]').forEach((button) =>
      button.addEventListener('click', async () => {
        button.disabled = true;
        try {
          const actor = await resolveFoundryUuid(
            button.dataset.actor ?? message.flags?.[SYSTEM_ID]?.actorUuid
          );
          await magicLearningAction(
            actor,
            button.dataset.magicLearning,
            button.dataset.project ?? message.flags?.[SYSTEM_ID]?.projectId
          );
        } catch (error) {
          errorNotice(error);
        } finally {
          button.disabled = false;
        }
      })
    );
  });
  const auditContact = (token) => {
    if (!isPrimaryActiveGm() || !token.actor) return;
    const actor = token.actor,
      connection = actor.system.magic?.leyConnection;
    if (connection?.active && connection.tokenUuid === token.uuid)
      serial('witcher-authority', async () => {
        if (!(await validateLeyContact(actor)))
          await disconnectLey({ actorUuid: actor.uuid }, { user: game.user });
      }).catch(errorNotice);
    const focus = actor.system.magic?.powerFocus;
    if (focus?.tokenUuid === token.uuid && focus.sourceUuid)
      serial('witcher-authority', async () => {
        try {
          const { source } = await sourceDocument(focus.sourceUuid, 'place');
          await sourceContact(actor, token.uuid, source);
        } catch {
          await actor.update({ 'system.magic.powerFocus': {} });
        }
      }).catch(errorNotice);
  };
  Hooks.on('updateToken', (token, changes) => {
    if (['x', 'y', 'elevation', 'level'].some((key) => Object.hasOwn(changes, key))) auditContact(token);
  });
  Hooks.on('deleteToken', auditContact);
  const updateBorrowed = (actor) => {
    if (isPrimaryActiveGm() && actor?.system?.magic?.leyConnection)
      serial('witcher-authority', () => synchronizeLeyBorrowed(actor)).catch(errorNotice);
  };
  for (const hook of ['createItem', 'updateItem', 'deleteItem'])
    Hooks.on(hook, (item, changes, options = {}) => {
      if (
        !options.witcherLeyBorrowed &&
        !changes?.witcherLeyBorrowed &&
        !item.flags?.[SYSTEM_ID]?.leyBorrowed
      )
        updateBorrowed(item.parent);
    });
  Hooks.on('updateActor', (actor, changes) => {
    if (changes['system.effects'] || changes.system?.effects || changes['system.magic.leyConnection'])
      updateBorrowed(actor);
  });
  Hooks.on('deleteRegion', (region) => {
    if (!isPrimaryActiveGm()) return;
    for (const actor of game.actors ?? []) {
      if (
        actor.system.magic?.leyConnection?.sourceUuid === region.uuid &&
        actor.system.magic.leyConnection.active
      )
        serial('witcher-authority', () =>
          disconnectLey({ actorUuid: actor.uuid }, { user: game.user })
        ).catch(errorNotice);
    }
  });
}
