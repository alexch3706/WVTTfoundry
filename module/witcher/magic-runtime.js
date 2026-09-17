import { greaterFocusSnapshot, magicDefenseTotal, magicDefenseBonus } from './magic-focus-rules.js';
import { castEnhancementSnapshot, depletionChanges } from './magic-enhancements.js';
import {
  placeOfPowerBenefits,
  leyLineBenefits,
  leyDamageFormula,
  leyLineMishapPlan,
} from './magic-power-rules.js';
import { validateLeyContact, synchronizeLeyBorrowed } from './magic-learning.js';
import { endMagicSource } from './magic-source-cleanup.js';
import {
  magicCastingRules,
  magicEffectCommit,
  magicConditionRules,
  magicAttackEffectChance,
} from './magic-effect-hooks.js';
import { validateMagicChoices } from './magic-choices.js';
import { magicTargetingProfile, validateMagicTargetCount } from './magic-targeting.js';
import { ritualTargetingBlock } from './magic-ritual-effects.js';
import { forgottenMagic } from './magic-hex-runtime.js';
import { magicCreatureDefenseAdjustment } from './magic-creature-profiles.js';
import { amuletCastPermission } from './magic-gear-rules.js';
import { BASIC_SPELL_KEYS, preflightSpell, executeBasicSpell } from './magic-execution.js';
import { SYSTEM_ID } from './config.js';
import { RuleError, beats, hitLocations, locate, resolveDamageSequence } from './rules.js';
import { MAGIC, magicInfo } from './magic-catalog.js';
import {
  SIGN_KEYS,
  magicCostPlan,
  magicalFumble,
  elementalBacklash,
  signParameters,
  magicDefenses,
  magicDuration,
  magicMaintenance,
  counterMagicCost,
} from './magic-rules.js';
import {
  magicTradition,
  magicVigor,
  magicFocus,
  selectedMagicFocus,
  validateCasting,
  magicShield,
  maintainedMagic,
  addMagicEffect,
  removeMagicEffects,
  magicEffectLabel,
  IMPLEMENTED_MAGIC,
} from './magic-state.js';
import { actorSnapshot, itemSnapshot } from './documents.js';
import { registerCommand, authorizedActor, runCommand } from './authority.js';
import {
  actionPlan,
  check,
  checkHTML,
  dice,
  chat,
  commitActor,
  actorFromUuid,
  turnIdentity,
  escapeHTML as e,
  validateManualCheck,
} from './runtime.js';
import { equippedSchoolPerks } from './school-gear.js';
import { resolveWoundArm } from './wound-rules.js';
import { validateWeaponGrip, isMagicalFocus } from './inventory.js';
import { damageHTML, damageState, prepareDamage, planDamageChanges, combatModifier } from './combat.js';
import { immuneTo } from './monster-rules.js';
import { magicalWoundTreatment, woundFingerprint } from './wound-actions.js';
import {
  validateMagicRegion,
  createMagicRegion,
  magicSceneScale,
  magicTokenOrigin,
} from './magic-regions.js';
import { refreshMagicZones, trapTarget, activeMagicZone, magicTrapCycle } from './magic-zones.js';
import { magicRepeatCycle, magicUpkeepPaid } from './magic-lifecycle.js';

export { IMPLEMENTED_MAGIC } from './magic-state.js';
const clone = (x) => foundry.utils.deepClone(x);
const now = () => game.time.worldTime;
const roundKey = () => (game.combat?.started ? `${game.combat.id}:${game.combat.round}` : '');
const savedCheck = ({ rolls, ...result }) => result;
const number = (value, name = 'Modifier') => {
  const result = Number(value ?? 0);
  if (!Number.isFinite(result)) throw new RuleError(`${name} must be a finite number.`);
  return result;
};
const gmOnly = (user) => {
  if (!user.isGM) throw new RuleError('The GM applies magical effects.');
};
const fingerprint = (item) => JSON.stringify(item.system.magic);
const currentSpent = (actor) =>
  roundKey() && actor.system.magic?.roundKey === roundKey() ? actor.system.magic.spent : 0;
export { fingerprint as magicFingerprint };

export function learnedMagic(actor, itemId) {
  const item = actor.items.get(itemId);
  if (item?.type !== 'magic')
    throw new RuleError('Drag learned magic from its compendium onto this actor first.');
  const magic = magicInfo(item.system.magic.key);
  if (forgottenMagic(actor.system, magic?.key))
    throw new RuleError('This magic is forgotten until Hex of Forgetfulness is removed or suppressed.');
  if (!magic || !IMPLEMENTED_MAGIC.has(magic.key))
    throw new RuleError('This entry does not yet have a completed casting procedure.');
  const grant = item.flags?.[SYSTEM_ID]?.magicAmulet;
  const amulet = grant ? actor.items.get(grant.amuletId) : null;
  if (grant) {
    if (grant.key !== magic.key) throw new RuleError('The amulet grant does not match this spell.');
    amuletCastPermission(actor.system, amulet, magic.key);
  }
  const borrowed = item.flags?.[SYSTEM_ID]?.leyBorrowed;
  if (borrowed) {
    const knownMagic = [...actor.items]
      .filter(
        (row) =>
          row.type === 'magic' &&
          !row.flags?.[SYSTEM_ID]?.leyBorrowed &&
          !row.flags?.[SYSTEM_ID]?.magicAmulet &&
          !forgottenMagic(actor.system, row.system.magic.key)
      )
      .map((row) => row.system.magic.key);
    if (
      borrowed.sourceUuid !== actor.system.magic?.leyConnection?.sourceUuid ||
      !leyLineBenefits(actor.system, magic, { knownMagic }).borrowedMagic.includes(magic.key)
    )
      throw new RuleError('The actual Air Ley Line no longer grants this spell.');
  }
  return { item, magic: clone(magic), amulet };
}

export function resolvedMagic(magic, power) {
  if (magic.kind === 'sign') return signParameters(magic.key, power);
  const duration = magicDuration(magic, power);
  return {
    key: magic.key,
    power,
    rangeMeters: magic.range.distance,
    area: magic.area,
    defenses: magic.defenses,
    durationRounds: duration.rounds,
    durationSeconds: duration.seconds,
    active: duration.active,
    ...magic.effect.params,
    damageFormula: magic.effect.damageFormula,
    damageType: magic.effect.damageType,
  };
}

export function magicAreaSpec(actor, magic, power, choices = {}) {
  if (['spell', 'invocation'].includes(magic.kind)) {
    const profile = magicTargetingProfile(magic, {
      choices: { coneAngle: actor.system.magic.coneAngle, ...choices },
      spellCastingRank: actor.system.skills.spellCasting,
    });
    if (profile.targetMode === 'point')
      return {
        shape: 'circle',
        radius: 0.25,
        origin: 'ranged',
        range: profile.rangeM,
        volume: 'ground',
        includeCaster: true,
        wallRestriction: 'sight',
        pointOnly: true,
      };
    if (profile.targetMode !== 'area' && !profile.requireStraightLine) return null;
    return {
      ...profile.area,
      origin: profile.origin === 'caster' ? 'caster' : 'ranged',
      range: profile.origin === 'caster' ? 0 : profile.rangeM,
      angle: profile.area.angle ?? actor.system.magic.coneAngle,
      angleSource: magic.area?.angle ? 'rule' : 'table',
      volume: 'level',
      includeCaster: !profile.exclusions.includes('caster'),
      wallRestriction: 'sight',
    };
  }
  const resolved = resolvedMagic(magic, power),
    shape = resolved.area?.shape;
  if (magic.key === 'supirre')
    return {
      shape: 'circle',
      radius: 0.25,
      origin: 'ranged',
      range: resolved.rangeMeters,
      volume: 'ground',
      includeCaster: true,
      wallRestriction: false,
    };
  if (!shape || shape === 'none') return null;
  const ranged =
    magic.kind !== 'sign' &&
    shape !== 'cone' &&
    (!/Radius/i.test(magic.range.text) || resolved.area.radius !== magic.range.distance);
  return {
    ...resolved.area,
    origin: ranged ? 'ranged' : 'caster',
    range: ranged ? magic.range.distance : 0,
    angle: resolved.area.angle ?? actor.system.magic.coneAngle,
    angleSource: resolved.area.angle ? 'rule' : 'table',
    volume: magic.key === 'aard-sweep' ? 'sphere' : magic.key === 'yrden' ? 'ground' : 'level',
    includeCaster:
      magic.kind === 'sign' ? magic.key === 'yrden' : shape !== 'cone' && magic.key !== 'static-storm',
    wallRestriction: 'move',
  };
}

async function casterTokenFor(actor, uuid) {
  if (!uuid) throw new RuleError('Select this actor’s token on the scene.');
  const token = await foundry.utils.fromUuid(uuid);
  if (token?.actor?.uuid !== actor.uuid || !token.parent)
    throw new RuleError('The caster token no longer matches this actor.');
  return token;
}
export function magicTokenDistance(source, target) {
  if (source.parent?.id !== target.parent?.id)
    throw new RuleError('Magic targets must be on the same scene.');
  const scale = magicSceneScale(source.parent),
    a = magicTokenOrigin(source),
    b = magicTokenOrigin(target);
  // Native geometry uses scene pixels; nearest token boundaries account for large creatures.
  const grid = source.parent.grid.size;
  const dx = Math.max(0, Math.abs(a.x - b.x) - ((source.width + target.width) * grid) / 2);
  const dy = Math.max(0, Math.abs(a.y - b.y) - ((source.height + target.height) * grid) / 2);
  const dz = Math.abs(a.elevation - b.elevation);
  return Math.hypot(dx / scale.pixelsPerMetre, dy / scale.pixelsPerMetre, dz * scale.metresPerUnit);
}
export function withinMagicRadius(source, target, radius) {
  if (source.parent?.id !== target.parent?.id) return false;
  const origin = magicTokenOrigin(source),
    scale = magicSceneScale(source.parent),
    grid = source.parent.grid;
  const dx = Math.max(target.x - origin.x, origin.x - target.x - target.width * grid.size, 0);
  const dy = Math.max(target.y - origin.y, origin.y - target.y - target.height * grid.size, 0);
  const bottom = target.elevation,
    top = bottom + (target.depth ?? 0) * grid.distance;
  const dz = Math.max(bottom - origin.elevation, origin.elevation - top, 0) * scale.metresPerUnit;
  return Math.hypot(dx / scale.pixelsPerMetre, dy / scale.pixelsPerMetre, dz) <= radius + 0.001;
}
function validateDirectTarget(source, target, range) {
  const distance = magicTokenDistance(source, target);
  if (distance > range + 0.001) throw new RuleError(`The target is outside this magic’s ${range}m range.`);
  const a = magicTokenOrigin(source),
    b = magicTokenOrigin(target);
  const backend = CONFIG.Canvas?.polygonBackends?.sight;
  if (
    backend?.testCollision &&
    backend.testCollision(a, b, { type: 'sight', mode: 'any', level: source.parent.levels?.get(a.level) })
  )
    throw new RuleError('A wall blocks sight of the magical target.');
  return distance;
}

function magicCard(data) {
  const rows = data.targets
    .map(
      (t) => `<li>${e(t.hidden ? 'Unseen target' : t.name)} · ${e(t.status)}
    ${t.status === 'pending' ? `<button type="button" data-magic-action="defend" data-target="${e(t.tokenUuid)}">Defense / accept</button>` : ''}
    ${t.status === 'ready' ? `<button type="button" data-magic-action="apply" data-target="${e(t.tokenUuid)}">Apply (GM)</button>` : ''}</li>`
    )
    .join('');
  return `${checkHTML(data.check)}${magicDefenseBonus(data) ? `<p>Spell defense DC ${magicDefenseTotal(data)}${data.focus?.defenseBonus ? ` · +2 Greater Focus (${e(data.focus.name)})` : ''}${data.focus?.glyphDC ? ` · +${data.focus.glyphDC} elemental glyph` : ''}; casting check unchanged.</p>` : ''}<p>${data.power} power · ${data.staCost} STA · Vigor ${data.roundSpend}/${data.vigor}${data.hpCost ? ` · overdraw ${data.hpCost} HP` : ''}</p>
    ${data.pendingReplacement ? '<p><strong>Awaiting the mandatory Air replacement.</strong></p>' : data.failed ? '<p><strong>The magic failed.</strong></p>' : `<ul>${rows}</ul>`}
    ${!data.failed && !data.applied && !data.pendingGM && data.targets.length === 0 ? '<button type="button" data-magic-action="apply">Apply magic (GM)</button>' : ''}
    ${data.fumble?.damage ? `<p>Fumble: ${data.fumble.damage} direct HP lost.</p>` : ''}
    ${!data.backlashResolved && (data.backlash?.needsElement || data.backlash?.pushMeters || data.fumble?.focusExplosion) ? '<button type="button" data-magic-action="backlash">Resolve remaining backlash (GM)</button>' : ''}
    ${!data.failed && !data.cancelled ? '<button type="button" data-magic-action="counter">Dispel / Heliotrope</button>' : ''}
    ${data.cancelled ? '<p>Magic negated.</p>' : ''}${data.resultNote ? `<p>${e(data.resultNote)}</p>` : ''}${leyCard(data)}`;
}
export async function refreshMagicCard(message, patch = {}) {
  const data = { ...message.flags[SYSTEM_ID], ...patch };
  return message.update({
    [`flags.${SYSTEM_ID}`]: data,
    content: `<article class="witcher-chat"><h3>${e(data.name)}</h3>${magicCard(data)}</article>`,
  });
}
async function magicMessage(uuid, { backlash = false } = {}) {
  const message = await foundry.utils.fromUuid(uuid);
  if (
    !message?.author?.isGM ||
    !['magic', ...(backlash ? ['magic-backlash'] : [])].includes(message.flags?.[SYSTEM_ID]?.kind)
  )
    throw new RuleError('Choose a GM-authorized magical casting card.');
  return message;
}

async function selectBacklash(element, rolls) {
  let mixedElement = null;
  if (element === 'mixed') {
    const roll = await dice('1d4');
    rolls.push(roll);
    mixedElement = ['earth', 'air', 'fire', 'water'][roll.total - 1];
  }
  return elementalBacklash(element, { mixedElement });
}

/** Shared spending applies to casting, counter-magic and upkeep. */
export function magicSpending(actor, magic, power, options = {}, plan = { changes: {}, modifier: 0 }) {
  const state = actorSnapshot(actor),
    focus = options.maintenance
      ? 0
      : options.amuletId
        ? 2
        : magicCastingRules(state, {
            focus: magicFocus(state, state.items, options.focusId, magic?.kind),
            kind: magic?.kind,
          }).focus;
  const cost = magicCostPlan({
    magic: options.counter || options.maintenance ? null : magic,
    power,
    focus,
    spent: currentSpent(actor),
    vigor: magicVigor(state, magic),
    stamina: plan.changes['system.sta.value'] ?? actor.system.sta.value,
    dimeritium: state.magic?.dimeritiumContact || state.effects.some((effect) => effect.key === 'Dimeritium'),
  });
  if (options.amuletId) {
    amuletCastPermission(state, actor.items.get(options.amuletId), magic?.key || options.magicKey, {
      staminaCost: cost.staCost,
      vigor: cost.vigor,
    });
    if (cost.hpCost)
      throw new RuleError('An amulet requires sufficient Vigor for this round; overdraw is unavailable.');
  }
  if (cost.hpCost && !options.overdraw)
    throw new RuleError(`This would cost ${cost.hpCost} HP beyond Vigor. Explicitly allow overexertion.`);
  return {
    cost,
    changes: {
      ...plan.changes,
      'system.sta.value': cost.staAfter,
      'system.magic.roundKey': roundKey(),
      'system.magic.spent': cost.roundAfter,
      ...(cost.hpCost ? { 'system.hp.value': actor.system.hp.value - cost.hpCost } : {}),
      ...(cost.exhausted
        ? {
            'system.conditions': [...new Set([...actor.system.conditions, 'stunned'])],
            'system.magic.exhaustedRecovery': 20,
          }
        : {}),
    },
  };
}

const leyPending = (actor) => actor.system.magic?.leyConnection?.pending ?? [];
function noPendingLey(actor) {
  if (leyPending(actor).length)
    throw new RuleError('Resolve the pending Ley Line replacement or forced casting first.');
}
function projectedMagicState(actor, changes) {
  const state = actorSnapshot(actor);
  for (const [path, value] of Object.entries(changes)) {
    if (!path.startsWith('system.')) continue;
    const keys = path.slice(7).split('.'),
      last = keys.pop();
    let at = state;
    for (const key of keys) at = at[key] ??= {};
    at[last] = clone(value);
  }
  return state;
}
/** Merge additional Ley consequences with already planned ordinary fumbles, HP,
 * exhausted conditions and consumed effects. Air/Fire jobs are saved before any
 * further choices and never silently counted as resolved. */
export function planAdditionalLey(actor, data, changes, cost, result = {}) {
  if (!actor.system.magic?.leyConnection?.active || (!cost.elementalBacklash && !result.fumble)) return null;
  const projected = projectedMagicState(actor, changes);
  const plan = leyLineMishapPlan(projected, {
    time: now(),
    cast: { castId: data.castId, magic: data.magic, staCost: cost.staCost },
    id: `ley-${data.castId}`,
  });
  Object.assign(changes, plan.changes);
  data.leyMishap = {
    element: actor.system.magic.leyConnection.element,
    tradition: magicTradition(actor.system),
    consequences: clone(plan.jobs),
  };
  const required = plan.jobs.filter((job) => ['replaceSpell', 'repeatSpell'].includes(job.type));
  if (required.length) {
    const connection = clone(changes['system.magic.leyConnection'] ?? projected.magic.leyConnection);
    connection.pending = [
      ...(connection.pending ?? []),
      ...required.map((job) => ({
        ...job,
        id: `${data.castId}:${job.type}`,
        originalCastId: data.castId,
        actorUuid: actor.uuid,
        tokenUuid: data.tokenUuid,
        sourceItemUuid: data.itemUuid || '',
        magicKey: data.magic.key,
        power: data.power ?? cost.power,
        check: clone(data.check),
        choices: clone(data.choices ?? {}),
        createdAt: now(),
        version: 0,
      })),
    ];
    changes['system.magic.leyConnection'] = connection;
    data.leyJobId = connection.pending.at(-1).id;
    if (required.some((job) => job.type === 'replaceSpell')) {
      data.failed = true;
      data.pendingReplacement = true;
    }
  }
  return plan;
}
function leyCard(data) {
  if (!data.leyMishap) return '';
  const element = data.leyMishap.element,
    tradition = data.leyMishap.tradition;
  const note = ['priest', 'druid'].includes(tradition)
    ? 'Vigor −2 for six hours (cumulative).'
    : {
        earth: 'Connection severed; the next connection to this line has DC +2.',
        air: 'The original spell is replaced by a different Air spell of the same level, chosen by the GM; it goes off even after a fumble.',
        fire: 'A mandatory additional action recasts the same spell at a random target, for the same spell STA plus 3 STA and a −3 check penalty.',
        water: 'GM-controlled hallucinations last until disconnection and up to one minute afterward.',
      }[element];
  return (
    `<p>Ley Line: ${e(note)}</p>` +
    (data.leyJobId
      ? `<button type="button" data-magic-ley="resolve" data-actor="${e(data.actorUuid)}" data-job="${e(data.leyJobId)}">Resolve Ley Line spell (GM)</button>`
      : '')
  );
}
function savedLeyJob(actor, jobId, version) {
  const job = leyPending(actor).find((row) => row.id === jobId);
  if (!job) throw new RuleError('This Ley Line consequence has already been resolved.');
  if (version !== undefined && version !== job.version)
    throw new RuleError('This Ley Line choice changed. Reopen its card.');
  return clone(job);
}
async function chooseLeySpell({ actorUuid, jobId, magicKey }, { user }) {
  gmOnly(user);
  const actor = await authorizedActor(actorUuid, user),
    job = savedLeyJob(actor, jobId);
  if (job.magicChosen) return job;
  const magic = magicInfo(job.type === 'repeatSpell' ? job.magicKey : magicKey);
  if (!magic || !IMPLEMENTED_MAGIC.has(magic.key))
    throw new RuleError('Choose an implemented catalog spell.');
  if (
    job.type === 'replaceSpell' &&
    (magic.kind !== 'spell' ||
      magic.element !== 'air' ||
      magic.tier !== job.tier ||
      magic.key === job.magicKey)
  )
    throw new RuleError('Air requires a different Air spell of the same level.');
  job.replacementKey = magic.key;
  job.magicChosen = true;
  job.version++;
  let roll;
  if (job.type === 'repeatSpell') {
    const source = await casterTokenFor(actor, job.tokenUuid);
    const profile = magicTargetingProfile(magic, {
      choices: { coneAngle: actor.system.magic.coneAngle, ...job.choices },
      spellCastingRank: actor.system.skills.spellCasting,
    });
    const range = Math.max(profile.rangeM || 0, profile.radiusM || 0, profile.area.distance || 0);
    const candidates = [...source.parent.tokens].filter((token) => {
      if (!token.actor || (profile.exclusions.includes('caster') && token.actor.uuid === actor.uuid))
        return false;
      try {
        return validateDirectTarget(source, token, range) <= range;
      } catch {
        return false;
      }
    });
    if (!candidates.length)
      throw new RuleError(
        'No actual target exists in this spell’s range. The GM must resolve this exceptional case before a forced cast can be made.'
      );
    if (candidates.length > 1) roll = await dice(`1d${candidates.length}`);
    job.targetUuid = candidates[(roll?.total ?? 1) - 1].uuid;
    job.targetPool = candidates.map((token) => token.uuid);
    job.targetRoll = roll?.total ?? 1;
  }
  const connection = clone(actor.system.magic.leyConnection);
  connection.pending = connection.pending.map((row) => (row.id === job.id ? job : row));
  return commitActor(actor, { 'system.magic.leyConnection': connection }, [], async () => {
    await chat(
      actor,
      'Ley Line casting choice',
      `<p>${e(magic.name)}${job.targetUuid ? ` → ${e((await foundry.utils.fromUuid(job.targetUuid)).name)} (random target ${job.targetRoll}/${job.targetPool.length})` : ' replaces the original spell'}.</p>`,
      { rolls: roll ? [roll] : [] }
    );
    return job;
  });
}
async function executeLeySpell(payload, { user, id }) {
  gmOnly(user);
  const actor = await authorizedActor(payload.actorUuid, user),
    job = savedLeyJob(actor, payload.jobId, payload.version);
  if (!job.magicChosen || !Number.isInteger(payload.version))
    throw new RuleError('Resolve and save the actual Ley Line spell choice first.');
  const magic = magicInfo(job.replacementKey),
    repeat = job.type === 'repeatSpell';
  const values = {
    ...(payload.values ?? {}),
    choices: clone(payload.values?.choices ?? job.choices),
    power: repeat ? job.power : Number(payload.values?.power ?? magic.cost.min),
  };
  const prepared = await prepareCastTargets(
    actor,
    magic,
    { ...payload, tokenUuid: job.tokenUuid },
    values,
    values.power,
    user
  );
  if (repeat) {
    const selected = await foundry.utils.fromUuid(job.targetUuid);
    if (!selected?.actor)
      throw new RuleError('The saved random target no longer exists; a GM ruling is required.');
    const profile = magicTargetingProfile(magic, {
      choices: { coneAngle: actor.system.magic.coneAngle, ...values.choices },
      spellCastingRank: actor.system.skills.spellCasting,
    });
    if (profile.targetMode === 'point') {
      const origin = magicTokenOrigin(selected),
        scale = magicSceneScale(selected.parent);
      if (
        Math.hypot(prepared.area.placement.x - origin.x, prepared.area.placement.y - origin.y) /
          scale.pixelsPerMetre >
        0.01
      )
        throw new RuleError('Place the forced spell at the saved random target’s position.');
    } else if (
      !prepared.targets.some((token) => token.uuid === job.targetUuid) &&
      !prepared.area?.targetIds?.includes(selected.id)
    )
      throw new RuleError('The forced spell must include its saved random target.');
  }
  await validateMagicChoices(magic, values.choices, {
    caster: actor,
    targets: prepared.targets.map((token) => token.actor),
    user,
    resolveUuid: foundry.utils.fromUuid,
  });
  const arm = resolveWoundArm(actor.system, [...actor.items], values.woundArm, 'optional');
  const castingRules = magicCastingRules(actor.system, {
    kind: magic.kind,
    element: magic.element,
    tradition: magicTradition(actor.system),
    damaging: !!magic.effect.damageFormula,
  });
  const data = {
    kind: 'magic',
    castId: id,
    name: magic.name,
    actorUuid: actor.uuid,
    tokenUuid: job.tokenUuid,
    itemUuid: job.sourceItemUuid,
    itemId: (await foundry.utils.fromUuid(job.sourceItemUuid))?.id || '',
    magicKey: magic.key,
    magic: clone(magic),
    power: values.power,
    element: magic.element,
    choices: values.choices,
    resolved: prepared.resolved,
    castingRules,
    ley: leyLineBenefits(actor.system, magic),
    check: clone(job.check),
    staCost: job.originalSTA,
    hpCost: 0,
    roundSpend: currentSpent(actor),
    vigor: magicVigor(actorSnapshot(actor), magic),
    castTime: now(),
    castRound: roundKey(),
    area: prepared.area
      ? {
          placement: prepared.area.placement,
          origin: prepared.area.origin,
          spec: prepared.area.area,
          data: prepared.area.data,
          sceneId: prepared.scene.id,
        }
      : null,
    targets: prepared.targets.map((token) => ({
      tokenUuid: token.uuid,
      actorUuid: token.actor.uuid,
      name: token.name,
      hidden: !!token.hidden,
      status: 'pending',
    })),
    failed: false,
    applied: false,
    cancelled: false,
    authorId: user.id,
    forcedLey: true,
    leySourceCastId: job.originalCastId,
    fumble: {},
    backlash: null,
  };
  await preflightTargets(data, actor, prepared.targets);
  const changes = {},
    rolls = [];
  if (repeat) {
    validateCasting(actorSnapshot(actor), [...actor.items], magic, { continuing: true, arm });
    validateManualCheck(values, actor);
    const luck = number(values.luck);
    if (!Number.isInteger(luck) || luck < 0 || luck > actor.system.luck.value)
      throw new RuleError('Invalid Luck expenditure.');
    if (actor.system.sta.value < 3 + job.originalSTA)
      throw new RuleError(
        'The mandatory Fire recast needs its original spell STA plus 3 STA. There is not enough STA; the GM must resolve this exhaustion case, and no free cast is granted.'
      );
    const spending = magicSpending(
      actor,
      magic,
      job.originalSTA,
      { maintenance: true, overdraw: true },
      {
        changes: {
          'system.sta.value': actor.system.sta.value - 3,
          'system.combat.extra': actor.system.combat.extra + 1,
        },
        modifier: -3,
      }
    );
    Object.assign(changes, spending.changes);
    changes['system.luck.value'] = actor.system.luck.value - luck;
    const result = await check(
      actor.skillBase('spellCasting', {
        stat: 'will',
        arm,
        modifier: number(values.modifier) + luck - 3 + castingRules.bonus + combatModifier(actor).modifier,
      }).total,
      { manualDice: values.manualDice, actor, context: { skill: 'spellCasting' } }
    );
    rolls.push(...result.rolls);
    const boosted = magicCastingRules(actor.system, {
      kind: magic.kind,
      element: magic.element,
      naturalDie: result.dice[0],
      damaging: !!magic.effect.damageFormula,
    });
    if (boosted.fumbleSeverity) result.fumble = Math.max(result.fumble, boosted.fumbleSeverity);
    data.check = savedCheck(result);
    data.backlash =
      spending.cost.elementalBacklash || result.fumble >= 7 ? await selectBacklash('fire', rolls) : null;
    data.fumble = magicalFumble({ fumble: result.fumble, element: 'fire' });
    data.failed = !data.fumble.spellSucceeds;
    data.hpCost = spending.cost.hpCost;
    data.roundSpend = spending.cost.roundAfter;
    if (data.fumble.damage)
      changes['system.hp.value'] = (changes['system.hp.value'] ?? actor.system.hp.value) - data.fumble.damage;
    if (data.backlash?.condition)
      changes['system.conditions'] = [
        ...new Set([...(changes['system.conditions'] ?? actor.system.conditions), data.backlash.condition]),
      ];
    if ((changes['system.hp.value'] ?? actor.system.hp.value) <= 0 && (data.hpCost || data.fumble.damage))
      changes['system.pendingDeathSaves'] = actor.system.pendingDeathSaves + 1;
    if (castingRules.consumeOnCommit.length) {
      const removed = removeMagicEffects(projectedMagicState(actor, changes), (effect) =>
        castingRules.consumeOnCommit.includes(effect.id)
      );
      changes['system.effects'] = removed.effects;
      changes['system.conditions'] = removed.conditions;
    }
    data.resultNote = 'Mandatory Ley Line extra action: 3 STA and −3; ordinary fumbles only.';
  } else
    data.resultNote =
      'Air Ley Line replacement: original casting STA paid once; the replacement goes off even after the original fumble.';
  const connection = clone(actor.system.magic.leyConnection);
  connection.pending = connection.pending.filter((row) => row.id !== job.id);
  changes['system.magic.leyConnection'] = connection;
  const original = [...game.messages].find((message) => message.flags?.[SYSTEM_ID]?.leyJobId === job.id);
  let created;
  try {
    return await commitActor(actor, changes, [], async () => {
      created = await chat(actor, `${magic.name} · Ley Line`, magicCard(data), { rolls, flags: data });
      if (original)
        await refreshMagicCard(original, {
          leyJobId: '',
          pendingReplacement: false,
          resultNote: `Ley Line consequence resolved by ${magic.name}.`,
        });
      return created;
    });
  } catch (error) {
    if (created) await created.delete();
    throw error;
  }
}

/** Shared authoritative targeting for normal casts and stored releases. */
async function prepareCastTargets(actor, magic, payload, values, power, user, name = magic.name) {
  const source = await casterTokenFor(actor, payload.tokenUuid),
    scene = source.parent;
  const resolved = resolvedMagic(magic, power),
    spec = magicAreaSpec(actor, magic, power, values.choices);
  const targeting = ['spell', 'invocation'].includes(magic.kind)
    ? magicTargetingProfile(magic, {
        choices: { coneAngle: actor.system.magic.coneAngle, ...(values.choices ?? {}) },
        spellCastingRank: actor.system.skills.spellCasting,
      })
    : null;
  if (targeting?.requiredChoices.length)
    throw new RuleError(
      `Resolve targeting choices: ${targeting.requiredChoices.map((choice) => choice.key).join(', ')}.`
    );
  let area = null,
    targets = [];
  if (spec) {
    if (!payload.area) throw new RuleError('Place the area before casting.');
    area = validateMagicRegion({
      scene,
      casterToken: source,
      spec,
      placement: payload.area.placement,
      expectedOrigin: payload.area.origin,
      requester: user,
      override: payload.area.override,
      name,
    });
    if (!spec.pointOnly && !['yrden', 'magic-trap', 'supirre'].includes(magic.key))
      targets = area.targetIds.map((targetId) => scene.tokens.get(targetId));
    if (targeting?.selection === 'chosen')
      targets = targets.filter((token) => payload.targetUuids?.includes(token.uuid));
  } else if (
    targeting?.actorSelf ||
    (!targeting && magic.range.targeting === 'self') ||
    (targeting?.targetMode === 'special' && magic.key === 'divine-wisdom') ||
    magic.key === 'codi-bywyd'
  )
    targets = [];
  else {
    if (!Array.isArray(payload.targetUuids)) throw new RuleError('Select the actual target tokens.');
    if (targeting && ['actor', 'actors'].includes(targeting.targetMode))
      validateMagicTargetCount(targeting, payload.targetUuids);
    else if (payload.targetUuids.length !== 1)
      throw new RuleError('Select exactly one target for this magic.');
    targets = await Promise.all(
      payload.targetUuids.map(async (uuid) => {
        const target = await foundry.utils.fromUuid(uuid);
        if (!target?.actor) throw new RuleError('The target token no longer exists.');
        validateDirectTarget(source, target, targeting?.rangeM ?? resolved.rangeMeters);
        return target;
      })
    );
  }
  if (values.aimed) {
    if (!['igni', 'fire-stream'].includes(magic.key))
      throw new RuleError('This magic does not permit aimed body locations.');
    if (magic.key === 'igni' && (targets.length !== 1 || magicTokenDistance(source, targets[0]) > 0.001))
      throw new RuleError('Aimed Igni requires one target at point-blank contact.');
    for (const target of targets) locate(hitLocations(actorSnapshot(target.actor)), values.aimed);
  }
  for (const target of targets) {
    const blocked = ritualTargetingBlock(source, target, {
      magic: true,
      solidEffect:
        magic.effect.damageType === 'piercing' ||
        magic.effect.damageType === 'bludgeoning' ||
        magic.effect.damageType === 'slashing',
    });
    if (blocked) throw new RuleError(blocked.reason);
  }
  if (targeting?.application === 'persistentZone') targets = [];
  return { source, scene, resolved, area, targets };
}

/** Called by authoritative item/procedure executors after validating their own receipt.
 * A stored release creates ordinary defense/apply cards without inventing a new cast or STA cost. */
export async function releaseStoredMagic({
  caster,
  magicKey,
  sourceItemUuid,
  castId,
  checkTotal,
  targetUuids = [],
  tokenUuid,
  area,
  choices = {},
  power,
  sourceName,
}) {
  if (!game.user.isGM) throw new RuleError('Only the GM may release stored magic.');
  const magic = magicInfo(magicKey);
  if (!magic || !IMPLEMENTED_MAGIC.has(magic.key))
    throw new RuleError('This stored spell’s runtime is not yet complete. Nothing was released.');
  if (!Number.isFinite(checkTotal) || !castId)
    throw new RuleError('A stored release needs its recorded opposition total and unique source receipt.');
  const item = await foundry.utils.fromUuid(sourceItemUuid);
  if (!item || item.parent?.uuid !== caster.uuid)
    throw new RuleError('The stored source item is no longer held by this caster.');
  const values = { power: power ?? magic.cost.min, choices };
  const prepared = await prepareCastTargets(
    caster,
    magic,
    { tokenUuid, targetUuids, area },
    values,
    values.power,
    game.user
  );
  await validateMagicChoices(magic, choices, {
    caster,
    targets: prepared.targets.map((token) => token.actor),
    user: game.user,
    resolveUuid: foundry.utils.fromUuid,
  });
  const data = {
    kind: 'magic',
    castId,
    name: sourceName ?? magic.name,
    actorUuid: caster.uuid,
    tokenUuid,
    itemUuid: sourceItemUuid,
    itemId: item.id,
    magicKey,
    magic: clone(magic),
    power: values.power,
    choices: clone(choices),
    resolved: prepared.resolved,
    check: { base: checkTotal, total: checkTotal, dice: [], fumble: 0, source: 'stored' },
    staCost: values.power,
    hpCost: 0,
    roundSpend: currentSpent(caster),
    vigor: magicVigor(caster.system, magic),
    castTime: now(),
    castRound: roundKey(),
    area: prepared.area
      ? {
          placement: prepared.area.placement,
          origin: prepared.area.origin,
          spec: prepared.area.area,
          data: prepared.area.data,
          sceneId: prepared.scene.id,
        }
      : null,
    targets: prepared.targets.map((token) => ({
      tokenUuid: token.uuid,
      actorUuid: token.actor.uuid,
      name: token.name,
      hidden: !!token.hidden,
      status: 'pending',
    })),
    authorId: game.user.id,
    failed: false,
    cancelled: false,
    applied: false,
    storedRelease: true,
    fumble: {},
  };
  await preflightTargets(data, caster, prepared.targets);
  const message = await chat(caster, data.name, magicCard(data), { flags: data });
  return {
    status: 'pendingDefense',
    message,
    receipt: { messageUuid: message.uuid, castId },
    rollback: () => message.delete(),
  };
}

async function preflightTargets(data, caster, targets) {
  const actors = new Map(targets.map((token) => [token.actor.uuid, token]));
  if (!actors.size)
    return preflightSpell(data, { caster, target: caster, row: { defense: { check: { total: 0 } } } });
  for (const token of actors.values()) {
    await preflightSpell(data, {
      caster,
      target: token.actor,
      row: { tokenUuid: token.uuid, defense: { check: { total: 0 } } },
    });
  }
}

async function executeCast(payload, { user, id }) {
  const actor = await authorizedActor(payload.actorUuid, user),
    { item, magic, amulet } = learnedMagic(actor, payload.itemId);
  noPendingLey(actor);
  if (payload.expected !== fingerprint(item))
    throw new RuleError('The magic entry changed. Reopen its card.');
  if (payload.turn !== turnIdentity())
    throw new RuleError('The combat turn changed. Reopen the casting dialog.');
  if (magic.key === 'dispel')
    throw new RuleError('Use Dispel on an incoming casting card or an active effect.');
  const values = { ...(payload.values ?? {}), amuletId: amulet?.id || '' },
    power = number(values.power, 'Power');
  validateManualCheck(values, actor);
  const handGesture = magic.kind === 'sign' || actor.system.skills.spellCasting < 9;
  const arm = resolveWoundArm(
    actor.system,
    [...actor.items],
    values.woundArm,
    handGesture ? 'one' : 'optional'
  );
  if (actor.system.magic?.leyConnection?.active && !(await validateLeyContact(actor)))
    throw new RuleError(
      'The caster is no longer touching the connected Ley Line. Disconnect before casting.'
    );
  validateCasting(actorSnapshot(actor), actorSnapshot(actor).items, magic, { arm, amulet: !!amulet });
  if (['quen', 'active-shield'].includes(magic.key) && magicShield(actor.system))
    throw new RuleError('Wait for the current Quen shield to end before recasting.');
  const { source, scene, resolved, area, targets } = await prepareCastTargets(
    actor,
    magic,
    payload,
    values,
    power,
    user,
    item.name
  );
  const ley = leyLineBenefits(actor.system, magic);
  const powerSource = placeOfPowerBenefits(actor.system, magic, now());
  const castingRules = magicCastingRules(actor.system, {
    kind: magic.kind,
    element: magic.element,
    tradition: magicTradition(actor.system),
    damaging: !!magic.effect.damageFormula,
  });
  if (magic.kind !== 'sign' && !['magic-healing'].includes(magic.key)) {
    await validateMagicChoices(magic, values.choices ?? {}, {
      caster: actor,
      targets: targets.map((token) => token.actor),
      user,
      resolveUuid: foundry.utils.fromUuid,
    });
    await preflightTargets(
      { magic, magicKey: magic.key, power, choices: values.choices ?? {}, check: { total: 0 }, castingRules },
      actor,
      targets
    );
  }
  const reaction = values.reactionId
    ? actor.system.combat.reactions.find(
        (r) => r.id === values.reactionId && r.key === 'criticalSpellcasting' && r.turn === turnIdentity()
      )
    : null;
  if (
    values.reactionId &&
    (!reaction ||
      magic.kind !== 'sign' ||
      !equippedSchoolPerks(actorSnapshot(actor)).some(
        (perk) => perk.key === reaction.key && perk.sourceItemId === reaction.sourceItemId
      ))
  )
    throw new RuleError('This Sign reaction is no longer available.');
  const plan = actionPlan(actor, {
    full: magic.key === 'magic-trap',
    extra: !!values.extra,
    forfeit: !!values.forfeit,
    reaction: !!reaction,
  });
  const { cost, changes } = magicSpending(actor, magic, power, values, plan);
  const focusState = actorSnapshot(actor);
  const selectedFocus = amulet
    ? null
    : selectedMagicFocus(focusState, focusState.items, values.focusId, magic.kind);
  const enhancementFocus = castEnhancementSnapshot(actor, magic, selectedFocus, values);
  const greaterFocus = amulet ? null : greaterFocusSnapshot(selectedFocus, magic);
  const focus =
    greaterFocus ||
    enhancementFocus.glyphs.sources.length ||
    enhancementFocus.depletion ||
    enhancementFocus.prolongation
      ? { ...greaterFocus, ...enhancementFocus }
      : null;
  const luck = number(values.luck);
  if (!Number.isInteger(luck) || luck < 0 || luck > actor.system.luck.value)
    throw new RuleError('Invalid Luck expenditure.');
  let modifier =
    number(values.modifier) +
    plan.modifier +
    luck +
    combatModifier(actor).modifier +
    castingRules.bonus +
    powerSource.castingBonus +
    ley.castingBonus;
  if (values.aimed && targets[0])
    modifier += locate(hitLocations(actorSnapshot(targets[0].actor)), values.aimed).aim;
  const result = await check(actor.skillBase('spellCasting', { stat: 'will', modifier, arm }).total, {
    ...{
      manualDice: values.manualDice,
    },
    actor: actor,
  });
  const boosted = magicCastingRules(actor.system, {
    kind: magic.kind,
    element: magic.element,
    naturalDie: result.dice?.[0],
    damaging: !!magic.effect.damageFormula,
  });
  if (boosted.fumbleSeverity) result.fumble = Math.max(result.fumble, boosted.fumbleSeverity);
  if (castingRules.consumeOnCommit.length) {
    const removed = removeMagicEffects(actor.system, (effect) =>
      castingRules.consumeOnCommit.includes(effect.id)
    );
    changes['system.effects'] = removed.effects;
    changes['system.conditions'] = removed.conditions;
  }
  const rolls = [...result.rolls];
  // A critical-treatment use replaces HP healing and has no rolled duration.
  if (
    focus?.prolongation &&
    magic.duration.formula &&
    !(magic.key === 'magic-healing' && values.healingWoundId)
  ) {
    const first = await dice(magic.duration.formula),
      second = await dice(magic.duration.formula);
    rolls.push(first, second);
    focus.prolongationDuration = Math.max(first.total, second.total);
  }
  const element = ['priest', 'druid'].includes(magicTradition(actor.system))
    ? 'mixed'
    : magic.element === 'unspecified'
      ? values.element || 'unspecified'
      : magic.element;
  if (!['unspecified', 'mixed', 'earth', 'air', 'fire', 'water'].includes(element))
    throw new RuleError('Invalid elemental ruling.');
  const needsElement = element === 'unspecified' && (result.fumble >= 7 || cost.elementalBacklash);
  const backlash =
    result.fumble >= 7 || cost.elementalBacklash
      ? needsElement
        ? { needsElement: true }
        : await selectBacklash(element, rolls)
      : null;
  const fumble = magicalFumble({
    fumble: result.fumble,
    element: needsElement ? 'mixed' : element,
    mixedElement: backlash?.element,
    kind: magic.kind,
    ritualCost: cost.staCost,
  });
  if (fumble.damage)
    changes['system.hp.value'] = (changes['system.hp.value'] ?? actor.system.hp.value) - fumble.damage;
  if (backlash?.condition)
    changes['system.conditions'] = [
      ...new Set([...(changes['system.conditions'] ?? actor.system.conditions), backlash.condition]),
    ];
  if ((changes['system.hp.value'] ?? actor.system.hp.value) <= 0 && (cost.hpCost || fumble.damage))
    changes['system.pendingDeathSaves'] = actor.system.pendingDeathSaves + 1;
  changes['system.luck.value'] = actor.system.luck.value - luck;
  if (reaction)
    changes['system.combat.reactions'] = actor.system.combat.reactions.filter((r) => r.id !== reaction.id);
  const data = {
    kind: 'magic',
    castId: id,
    name: item.name,
    actorUuid: actor.uuid,
    tokenUuid: source.uuid,
    itemUuid: item.uuid,
    itemId: item.id,
    amuletId: amulet?.id || '',
    magicKey: magic.key,
    magic,
    element,
    power,
    resolved,
    castingRules,
    focus,
    ley,
    choices: clone(values.choices ?? {}),
    check: savedCheck(result),
    staCost: cost.staCost,
    hpCost: cost.hpCost,
    roundSpend: cost.roundAfter,
    vigor: cost.vigor,
    castTime: now(),
    castRound: roundKey(),
    area: area
      ? {
          placement: area.placement,
          origin: area.origin,
          spec: area.area,
          data: area.data,
          sceneId: scene.id,
          override: area.override,
        }
      : null,
    targets: targets.map((token) => ({
      tokenUuid: token.uuid,
      actorUuid: token.actor.uuid,
      name: token.name,
      hidden: !!token.hidden,
      status: 'pending',
    })),
    aimed: values.aimed || '',
    healingWoundId: values.healingWoundId || '',
    authorId: user.id,
    failed: !fumble.spellSucceeds,
    applied: false,
    cancelled: false,
    fumble,
    backlash,
    sourceCheckBase: actor.skillBase('spellCasting', { stat: 'will', arm }).total,
  };
  if (data.healingWoundId) {
    const wound = targets[0]?.actor.items.get(data.healingWoundId);
    if (magic.key !== 'magic-healing' || wound?.type !== 'wound')
      throw new RuleError('Select a critical wound on the healing target.');
    magicalWoundTreatment(targets[0].actor, wound, data.check.total);
    data.healingWoundExpected = woundFingerprint(wound);
  }
  planAdditionalLey(actor, data, changes, cost, result);
  if (magic.key === 'fire-stream' && !data.failed)
    changes['system.effects'] = [
      ...(changes['system.effects'] ?? actor.system.effects),
      effectFor({ ...data, messageUuid: '' }, { magic: { casterEffect: true }, initialCast: clone(data) }),
    ];
  return commitActor(actor, changes, [], async () => {
    const message = await chat(actor, `${item.name} · magic`, magicCard(data), { rolls, flags: data });
    if (magic.key === 'fire-stream' && !data.failed) {
      try {
        const effects = clone(actor.system.effects),
          stream = effects.find((effect) => effect.magic?.castId === id);
        stream.magic.messageUuid = message.uuid;
        stream.initialCast.messageUuid = message.uuid;
        await actor.update({ 'system.effects': effects });
      } catch (error) {
        await message.delete();
        throw error;
      }
    }
    return message;
  });
}

async function executeDefense({ messageUuid, targetUuid, values = {}, turn }, { user }) {
  const message = await magicMessage(messageUuid),
    data = clone(message.flags[SYSTEM_ID]);
  if (data.failed || data.cancelled) throw new RuleError('This magic is no longer awaiting defenses.');
  const row = data.targets.find((target) => target.tokenUuid === targetUuid);
  if (!row || row.status !== 'pending') throw new RuleError('This target already has a defense result.');
  const actor = await authorizedActor(row.actorUuid, user);
  if (turn !== turnIdentity()) throw new RuleError('The combat turn changed. Reopen the defense.');
  validateManualCheck(values, actor);
  const defense = values.defense,
    allowed = magicDefenses(data.magic, { includeCounters: false });
  if (defense === 'accept') {
    if (!user.isGM && !actor.isOwner) throw new RuleError('Only the target owner can accept magic.');
    row.status = 'ready';
    row.defense = { kind: 'accept', check: { total: 0, base: 0, dice: [], fumble: 0 } };
    return refreshMagicCard(message, { targets: data.targets });
  }
  if (defense === 'passive') {
    if (!allowed.some((key) => ['dodge', 'athletics', 'block'].includes(key)))
      throw new RuleError('This magic uses its printed mental or fixed defense.');
    const helpless = actor.system.conditions.some((condition) =>
      ['stunned', 'unconscious'].includes(condition)
    );
    if (!helpless && !user.isGM) throw new RuleError('The GM sets an unaware target’s passive DC.');
    const dc = helpless ? 10 : number(values.dc, 'Passive DC');
    if (dc < 0) throw new RuleError('Passive DC cannot be negative.');
    row.status = beats(magicDefenseTotal(data), dc) ? 'ready' : 'defended';
    row.defense = { kind: 'passive', check: { total: dc, base: dc, dice: [], fumble: 0, source: 'passive' } };
    return refreshMagicCard(message, { targets: data.targets });
  }
  if (!allowed.includes(defense)) throw new RuleError('This magic does not allow that defense.');
  if (actor.system.conditions.some((c) => ['stunned', 'unconscious', 'dead'].includes(c)))
    throw new RuleError('This condition prevents an active magical defense.');
  const plan = actionPlan(actor, { defense: true }),
    luck = number(values.luck);
  if (!Number.isInteger(luck) || luck < 0 || luck > actor.system.luck.value)
    throw new RuleError('Invalid Luck expenditure.');
  let skill = defense === 'athletics' ? 'athletics' : defense,
    modifier =
      number(values.modifier) +
      luck +
      combatModifier(actor, { defense: true }).modifier +
      (data.ley?.defenseModifier ?? 0),
    arm = '';
  const itemChanges = [];
  if (defense === 'block') {
    const weapon = actor.items.get(values.weaponId);
    if (!weapon || !['weapon', 'shield'].includes(weapon.type) || weapon.system.reliability <= 0)
      throw new RuleError('Choose an equipped weapon or shield with usable Reliability.');
    const grip = validateWeaponGrip(actorSnapshot(actor), itemSnapshot(weapon), actorSnapshot(actor).items);
    modifier += grip.modifier;
    skill = weapon.type === 'shield' ? 'melee' : weapon.system.skill;
    arm = resolveWoundArm(actor.system, [...actor.items], values.woundArm, grip.hands === 2 ? 'both' : 'one');
  }
  const result = await check(
    actor.skillBase(skill, { modifier, arm }).total + magicCreatureDefenseAdjustment(actor.system, defense),
    {
      ...{
        manualDice: values.manualDice,
      },
      actor: actor,
    }
  );
  const success = result.total >= magicDefenseTotal(data);
  if (defense === 'block' && success) {
    const weapon = actor.items.get(values.weaponId);
    itemChanges.push({ _id: weapon.id, 'system.reliability': Math.max(0, weapon.system.reliability - 1) });
  }
  row.status = success ? 'defended' : 'ready';
  row.defense = { kind: defense, check: savedCheck(result), weaponId: values.weaponId || '' };
  return commitActor(
    actor,
    { ...plan.changes, 'system.luck.value': actor.system.luck.value - luck },
    itemChanges,
    async () => {
      const response = await chat(
        actor,
        `Defense: ${data.name}`,
        checkHTML(result) + `<p>${e(defense)}: ${success ? 'Defended.' : 'Magic reaches target.'}</p>`,
        {
          rolls: result.rolls,
          flags:
            result.fumble > 5 && ['dodge', 'athletics', 'block'].includes(defense)
              ? {
                  kind: 'defense',
                  magicDefense: true,
                  actorUuid: actor.uuid,
                  authorId: user.id,
                  defense: defense === 'block' ? 'blockWeapon' : defense,
                  weaponId: values.weaponId || '',
                  check: savedCheck(result),
                  attackRef: message.uuid,
                }
              : { kind: 'magic-defense', actorUuid: actor.uuid, check: savedCheck(result) },
        }
      );
      if (response.flags[SYSTEM_ID].magicDefense) row.defense.fumbleMessageUuid = response.uuid;
      try {
        await refreshMagicCard(message, { targets: data.targets });
      } catch (error) {
        await response.delete();
        throw error;
      }
      return response;
    }
  );
}

export function effectFor(data, details = {}) {
  const { magic: magicDetails = {}, ...other } = details;
  return {
    id: foundry.utils.randomID(),
    key: magicEffectLabel(data.magicKey),
    sourceUuid: data.actorUuid,
    expires: data.resolved.durationSeconds ? now() + data.resolved.durationSeconds : 0,
    magic: {
      key: data.magicKey,
      castId: data.castId,
      messageUuid: data.messageUuid,
      casterUuid: data.actorUuid,
      amuletId: data.amuletId || '',
      tokenUuid: data.tokenUuid,
      itemUuid: data.itemUuid,
      power: data.power,
      staCost: data.staCost,
      castingTotal: data.check.total,
      focus: clone(data.focus ?? null),
      defenseDC: magicDefenseTotal(data),
      maintenance: data.magic.duration.maintenance,
      maintenanceIntervalSeconds: data.magic.duration.maintenanceUnit === 'minute' ? 60 : 3,
      createdAt: now(),
      paidAt: now(),
      nextUpkeepAt: now() + (data.magic.duration.maintenanceUnit === 'minute' ? 60 : 3),
      castRound: roundKey(),
      ...magicDetails,
    },
    ...other,
  };
}

export async function magicDamageCard(caster, target, data, row) {
  const parameters = data.resolved;
  const magicWeapon = {
    id: data.itemId,
    name: data.name,
    type: 'weapon',
    category: 'magic',
    skill: 'spellCasting',
    damage: parameters.damageFormula,
    damageTypes: [parameters.damageType || 'elemental'],
    properties: {
      magic: true,
      element: data.element,
      ...data.operationProperties,
      magicBlockable: data.magic.defenses.includes('block'),
      environmental: true,
      fire: parameters.igniteChance ? Math.max(parameters.igniteChance, data.ley?.ignitionChance || 0) : 0,
    },
  };
  const attack = {
    weapon: magicWeapon,
    castingRules: data.castingRules,
    action: 'normal',
    style: 'normal',
    type: parameters.damageType || 'elemental',
    damageFormula: [
      data.ley?.extraDamageDice
        ? leyDamageFormula(parameters.damageFormula, data.ley.extraDamageDice)
        : parameters.damageFormula,
      ...(data.castingRules?.extraDamage ?? []),
      ...(data.focus?.glyphDamageDice ? [`${data.focus.glyphDamageDice}d6`] : []),
    ].join('+'),
    meleeBonus: 0,
    check: data.check,
    physicalCritical: !!data.magic.effect.physicalCritical && data.magic.defenses.length > 0,
    aimed: data.aimed || ['torso', 'none'].includes(parameters.location) ? data.aimed || 'torso' : '',
    actorUuid: caster.uuid,
    sourceTokenUuid: data.tokenUuid,
    targetTokenUuid: row?.tokenUuid ?? data.tokenUuid,
  };
  const damage = await prepareDamage(caster, target, attack, row?.defense ?? {});
  return chat(
    caster,
    `${data.name} → ${target.name}`,
    damageHTML(damage) + '<button type="button" data-witcher-action="apply">Apply damage (GM)</button>',
    {
      rolls: damage.rolls,
      flags: {
        kind: 'damage',
        actorUuid: caster.uuid,
        targetUuid: target.uuid,
        sourceTokenUuid: data.tokenUuid,
        targetTokenUuid: row?.tokenUuid ?? data.tokenUuid,
        attackRef: `magic:${data.executionId ?? data.castId}:${row?.tokenUuid ?? data.tokenUuid}:${data.operationIndex ?? 0}`,
        request: damage.request,
        summary: damage.results,
        wound: damage.wound,
        conditions: damage.conditions,
        effects: damage.effects,
        stun: damage.stun,
        state: damage.state,
        applied: false,
        magicCastId: data.castId,
      },
    }
  );
}

async function executeApply({ messageUuid, targetUuid }, { user }) {
  gmOnly(user);
  const message = await magicMessage(messageUuid),
    data = clone(message.flags[SYSTEM_ID]);
  if (data.failed || data.cancelled) throw new RuleError('This magic failed or was negated.');
  if (data.backlash?.needsElement)
    throw new RuleError('Resolve the pending elemental ruling before applying this magic.');
  const caster = await actorFromUuid(data.actorUuid);
  if (!caster) throw new RuleError('The caster no longer exists.');
  const row = targetUuid ? data.targets.find((target) => target.tokenUuid === targetUuid) : null;
  if (row && row.status !== 'ready') throw new RuleError('Resolve this target’s defense first.');
  if (row?.defense?.fumbleMessageUuid) {
    const defenseMessage = await foundry.utils.fromUuid(row.defense.fumbleMessageUuid);
    if (!defenseMessage?.flags?.[SYSTEM_ID]?.fumbleResolved)
      throw new RuleError('Apply the pending defensive fumble before resolving the magical hit.');
  }
  if (!row && (data.targets.length || data.applied))
    throw new RuleError('This magical result has already been applied.');
  const target = row ? await actorFromUuid(row.actorUuid) : caster;
  if (!target) throw new RuleError('The target no longer exists.');
  const receipt = `magic:${data.castId}:${row?.tokenUuid || 'self'}`;
  if (target.system.combat.applied.includes(receipt)) {
    if (row) row.status = 'applied';
    if (data.magicKey === 'supirre') await replaceListeningPoint(caster, data.castId);
    return refreshMagicCard(message, {
      targets: data.targets,
      applied: !row || data.targets.every((t) => ['applied', 'defended'].includes(t.status)),
    });
  }
  data.messageUuid = message.uuid;
  if (BASIC_SPELL_KEYS.has(data.magicKey))
    return executeBasicSpell({
      data,
      row,
      caster,
      target,
      message,
      receipt,
      effectFor,
      damageCard: magicDamageCard,
      finish: async ({ pendingGM, receipts }) => {
        if (row) row.status = pendingGM ? 'pendingGM' : 'applied';
        return refreshMagicCard(message, {
          targets: data.targets,
          pendingGM,
          worldReceipts: [...(data.worldReceipts ?? []), ...receipts],
          applied:
            !pendingGM &&
            (!row || data.targets.every((target) => ['applied', 'defended'].includes(target.status))),
        });
      },
    });
  const params = data.resolved,
    changes = { 'system.combat.applied': [...target.system.combat.applied, receipt] },
    effects = [];
  let damageCard = null,
    region = null,
    itemChanges = [],
    resultNote = '';
  const rolls = [];
  if (['igni', 'fire-stream'].includes(data.magicKey) || (data.magicKey === 'magic-trap' && row))
    damageCard = await magicDamageCard(caster, target, data, row);
  if (['quen', 'active-shield'].includes(data.magicKey)) {
    if (magicShield(target.system)) throw new RuleError('A shield is already active.');
    effects.push(effectFor(data, { shieldHP: params.shieldHP, magic: { casterEffect: true } }));
  } else if (['aard', 'aard-sweep'].includes(data.magicKey)) {
    const roll = await dice('1d100');
    rolls.push(roll);
    const prone =
        roll.total <=
        magicAttackEffectChance(caster.system, 'prone', params.proneChance, {
          spell: true,
          castingRules: data.castingRules,
        }).chance,
      conditions = [];
    if (data.magicKey === 'aard' || prone) conditions.push('staggered');
    if (prone) conditions.push('prone');
    changes['system.conditions'] = [
      ...new Set([
        ...target.system.conditions,
        ...conditions.filter((c) => !immuneTo(actorSnapshot(target), c)),
      ]),
    ];
    const struckToken = row ? await foundry.utils.fromUuid(row.tokenUuid) : null;
    if (
      prone &&
      data.magicKey === 'aard-sweep' &&
      (target.system.traits.flightSpeed > 0 || struckToken?.elevation > 0)
    )
      effects.push(
        effectFor(data, {
          key: 'Aard Sweep fall',
          magic: { pendingFall: true, affectedTokenUuid: row.tokenUuid },
          notes:
            'Confirm whether the target was flying and resolve its actual fall height; terrain elevation alone does not establish a fall.',
        })
      );
  } else if (data.magicKey === 'axii' || data.magicKey === 'somne') {
    if (!immuneTo(actorSnapshot(target), 'stunned'))
      effects.push(
        effectFor(data, {
          conditions: ['stunned'],
          magic: { stunModifier: params.stunModifier || 0, sleeping: !!params.sleeping, wake: params.wake },
        })
      );
  } else if (data.magicKey === 'puppet') {
    effects.push(
      effectFor(data, {
        magic: { controlled: true, repeatDefense: 'resistMagic' },
        notes: `Ally of ${caster.name}; Resist Magic against ${magicDefenseTotal(data)} each round to break free.`,
      })
    );
  } else if (data.magicKey === 'magic-healing') {
    if (data.healingWoundId) {
      const wound = target.items.get(data.healingWoundId);
      if (!wound || woundFingerprint(wound) !== data.healingWoundExpected)
        throw new RuleError(
          'The selected wound changed after casting. Review the treatment before applying.'
        );
      const treatment = magicalWoundTreatment(target, wound, data.check.total);
      Object.assign(changes, treatment.changes);
      itemChanges = treatment.items;
      resultNote = treatment.success
        ? `${treatment.uses}/${treatment.required} successful healing uses; no HP restored.`
        : `Spell Casting did not beat DC ${treatment.dc}; no critical-treatment progress or HP restored.`;
    } else {
      const duration = data.focus?.prolongationDuration
        ? { total: data.focus.prolongationDuration }
        : await dice('1d10');
      if (!data.focus?.prolongationDuration) rolls.push(duration);
      effects.push(
        effectFor(data, {
          expires: now() + duration.total * 3,
          magic: { healing: 3, roundsRemaining: duration.total, lastRound: '', nextAt: now() + 3 },
        })
      );
    }
  }
  try {
    if (['yrden', 'magic-trap', 'supirre'].includes(data.magicKey) && !row) {
      const token = await casterTokenFor(caster, data.tokenUuid);
      region = await createMagicRegion({
        scene: token.parent,
        casterToken: token,
        spec: data.area.spec,
        placement: data.area.placement,
        validatedCast: data.area.data
          ? {
              data: data.area.data,
              area: data.area.spec,
              origin: data.area.origin,
              placement: data.area.placement,
              override: data.area.override,
            }
          : undefined,
        expectedOrigin: data.area.origin,
        requester: user,
        override: data.area.override,
        name: data.name,
        links: { castId: data.castId, casterUuid: caster.uuid, spellUuid: data.itemUuid },
        rounds: params.durationRounds || Math.ceil(params.durationSeconds / 3),
        state: {
          key: data.magicKey,
          power: data.power,
          check: data.check,
          focus: clone(data.focus ?? null),
          staCost: data.staCost,
          createdAt: now(),
          preparedAt: now() + (data.magicKey === 'magic-trap' ? 3 : 0),
          expires: now() + params.durationSeconds + (data.magicKey === 'magic-trap' ? 3 : 0),
          castCombat: game.combat?.started
            ? { id: game.combat.id, round: game.combat.round, turn: game.combat.turn }
            : null,
          penalty: params.penalty,
          sourceCheckBase: data.sourceCheckBase,
          prepared: data.magicKey !== 'magic-trap',
          active: true,
          messageUuid: message.uuid,
        },
      });
      effects.push(
        effectFor(data, {
          expires: now() + params.durationSeconds + (data.magicKey === 'magic-trap' ? 3 : 0),
          magic: { casterEffect: true, regionUuid: region.uuid },
          notes:
            data.magicKey === 'supirre'
              ? 'Hear the linked point without an Awareness check; recast to move it.'
              : '',
        })
      );
    }
    let next = actorSnapshot(target);
    if (changes['system.conditions']) next.conditions = changes['system.conditions'];
    for (const effect of effects) next = { ...next, ...addMagicEffect(next, effect) };
    if (effects.length) {
      changes['system.effects'] = next.effects;
      changes['system.conditions'] = next.conditions;
    }
    rolls.push(...(await depletionChanges(target, data, row, changes)));
    await commitActor(target, changes, itemChanges, async () => {
      if (row) row.status = 'applied';
      await refreshMagicCard(message, {
        targets: data.targets,
        applied: !row || data.targets.every((t) => ['applied', 'defended'].includes(t.status)),
        resultNote,
      });
    });
  } catch (error) {
    if (region) await region.delete();
    if (damageCard) await damageCard.delete();
    throw error;
  }
  if (rolls.length) await chat(caster, data.name, '<p>Magical effect resolved.</p>', { rolls });
  if (region) await refreshMagicZones();
  if (data.magicKey === 'supirre') await replaceListeningPoint(caster, data.castId);
  return damageCard || message;
}

export function registerMagicCommands() {
  registerCommand('magicCast', executeCast);
  registerCommand('magicDefense', executeDefense);
  registerCommand('magicApply', executeApply);
  registerCommand('magicCounter', executeCounter);
  registerCommand('magicMaintain', executeMaintain);
  registerCommand('magicEnd', executeEnd);
  registerCommand('magicResist', executeResist);
  registerCommand('magicWake', executeWake);
  registerCommand('magicBacklash', executeBacklash);
  registerCommand('magicTrapAttack', executeTrapAttack);
  registerCommand('magicCollapse', executeCollapse);
  registerCommand('magicProtect', executeProtect);
  registerCommand('magicFall', executeFall);
  registerCommand('magicLeyChoose', chooseLeySpell);
  registerCommand('magicLeyResolve', executeLeySpell);
  Hooks.on('renderChatMessageHTML', (_message, html) =>
    html.querySelectorAll('[data-magic-ley]').forEach((button) => {
      button.hidden = !game.user.isGM;
      button.addEventListener('click', async () => {
        button.disabled = true;
        try {
          const { resolveLeyUI } = await import('./magic-ley-ui.js');
          await resolveLeyUI(button.dataset.actor, button.dataset.job);
        } catch (error) {
          ui.notifications.error(error.message);
        } finally {
          button.disabled = false;
        }
      });
    })
  );
}

export function worldMagicActors() {
  const actors = new Map(game.actors.map((actor) => [actor.uuid, actor]));
  for (const scene of game.scenes ?? [])
    for (const token of scene.tokens ?? []) if (token.actor) actors.set(token.actor.uuid, token.actor);
  return [...actors.values()];
}
async function replaceListeningPoint(caster, castId) {
  const current = caster.system.effects.find(
    (effect) => effect.magic?.castId === castId && effect.magic.key === 'supirre'
  );
  if (!current) return;
  for (const effect of [...caster.system.effects])
    if (
      effect.magic?.key === 'supirre' &&
      effect.magic.castId !== castId &&
      effect.magic.createdAt <= current.magic.createdAt
    )
      await endMagicCast(effect.magic.castId);
}
async function commitMany(plans, after) {
  if (!plans.length) return after?.();
  const [plan, ...rest] = plans;
  return commitActor(plan.actor, plan.changes, plan.items ?? [], () => commitMany(rest, after));
}

/** Source-based removal allows different casters' effects to coexist. */
export async function endMagicCast(castId, options = {}) {
  return endMagicSource(castId, options);
}

async function executeCounter({ messageUuid, reactorUuid, tokenUuid, values = {}, turn }, { user, id }) {
  if (turn !== turnIdentity()) throw new RuleError('The turn changed. Reopen the counter-magic dialog.');
  const message = await magicMessage(messageUuid),
    data = clone(message.flags[SYSTEM_ID]);
  if (data.failed || data.cancelled) throw new RuleError('This magic has already failed or been negated.');
  const actor = await authorizedActor(reactorUuid, user),
    token = await casterTokenFor(actor, tokenUuid);
  noPendingLey(actor);
  if (data.counters?.includes(actor.uuid))
    throw new RuleError('This actor already attempted to counter this casting.');
  validateManualCheck(values, actor);
  const kind = values.defense;
  const dispelItem =
    kind === 'dispel'
      ? values.dispelItemId
        ? actor.items.get(values.dispelItemId)
        : [...actor.items].find(
            (item) =>
              item.type === 'magic' &&
              item.system.magic.key === 'dispel' &&
              !item.flags?.[SYSTEM_ID]?.magicAmulet
          ) || [...actor.items].find((item) => item.type === 'magic' && item.system.magic.key === 'dispel')
      : null;
  const dispelSource = dispelItem ? learnedMagic(actor, dispelItem.id) : null;
  if (!['dispel', 'heliotrope'].includes(kind)) throw new RuleError('Choose Dispel or Heliotrope.');
  if (kind === 'dispel' && (!dispelSource || dispelSource.magic.key !== 'dispel'))
    throw new RuleError('This actor has not learned Dispel.');
  if (
    kind === 'heliotrope' &&
    !(
      actor.system.professionRanks.heliotrope ||
      actor.system.customSkills.some((s) => s.id === 'heliotrope' && s.rank > 0)
    )
  )
    throw new RuleError('This actor has not learned the Heliotrope profession skill.');
  if (
    kind === 'heliotrope' &&
    !data.targets.some(
      (target) =>
        target.actorUuid === actor.uuid && ['pending', 'ready', 'ongoingPending'].includes(target.status)
    )
  )
    throw new RuleError('Heliotrope only counters incoming magic targeting this Witcher.');
  if (kind === 'dispel') {
    const source = await foundry.utils.fromUuid(data.tokenUuid);
    const anchors = [];
    for (const row of data.targets) {
      if (row.status === 'defended') continue;
      const target = await foundry.utils.fromUuid(row.tokenUuid);
      if (
        target?.actor &&
        (!data.applied ||
          target.actor.system.effects.some((ef) => ef.magic?.castId === data.castId) ||
          [...target.actor.items].some((item) =>
            item.flags?.[SYSTEM_ID]?.magicItemEffects?.some((effect) => effect.castId === data.castId)
          ))
      )
        anchors.push(target);
    }
    if (
      !data.targets.length &&
      source &&
      (!data.applied ||
        source.actor?.system.effects.some(
          (effect) =>
            effect.magic?.castId === data.castId &&
            !effect.magic.regionUuid &&
            !effect.magic.worldReceipts?.length
        ))
    )
      anchors.push(source);
    let inRange = anchors.some((anchor) => {
      try {
        return validateDirectTarget(token, anchor, 10) <= 10;
      } catch {
        return false;
      }
    });
    for (const scene of game.scenes ?? [])
      for (const region of scene.regions ?? []) {
        const area = region.flags?.[SYSTEM_ID]?.magicArea;
        if (area?.castId !== data.castId || scene.id !== token.parent.id) continue;
        const origin = magicTokenOrigin(token),
          scale = magicSceneScale(scene);
        if (Math.hypot(origin.x - area.placement.x, origin.y - area.placement.y) / scale.pixelsPerMetre <= 10)
          inRange = true;
      }
    if (!inRange) throw new RuleError('The magical effect must be within 10m of the dispeller.');
    if (
      data.applied &&
      !worldMagicActors().some((a) => a.system.effects.some((ef) => ef.magic?.castId === data.castId))
    )
      throw new RuleError('There is no lasting magical effect to dispel.');
  }
  const state = actorSnapshot(actor);
  const arm = resolveWoundArm(state, state.items, values.woundArm, 'optional');
  if (state.magic?.leyConnection?.active && !(await validateLeyContact(actor)))
    throw new RuleError('The caster is no longer touching the connected Ley Line.');
  validateCasting(state, state.items, kind === 'dispel' ? magicInfo('dispel') : { kind: 'sign' }, {
    arm,
    amulet: !!dispelSource?.amulet,
  });
  const plan = actionPlan(actor, { defense: !data.applied || !!data.ongoingAttack });
  const { cost, changes } = magicSpending(
    actor,
    kind === 'dispel' ? magicInfo('dispel') : { key: 'heliotrope', kind: 'sign', element: 'mixed' },
    counterMagicCost(data.staCost),
    { ...values, counter: true, amuletId: dispelSource?.amulet?.id || '' },
    plan
  );
  const luck = number(values.luck);
  if (!Number.isInteger(luck) || luck < 0 || luck > actor.system.luck.value)
    throw new RuleError('Invalid Luck expenditure.');
  const result = await check(
    actor.skillBase(kind === 'dispel' ? 'spellCasting' : 'heliotrope', {
      stat: 'will',
      modifier: number(values.modifier) + plan.modifier + luck + (data.ley?.defenseModifier ?? 0),
      arm,
    }).total,
    { ...{ manualDice: values.manualDice }, actor: actor }
  );
  const rolls = [...result.rolls],
    element = 'mixed';
  const backlash = cost.elementalBacklash || result.fumble >= 7 ? await selectBacklash(element, rolls) : null;
  const fumble = magicalFumble({ fumble: result.fumble, element, mixedElement: backlash?.element });
  if (fumble.damage)
    changes['system.hp.value'] = (changes['system.hp.value'] ?? actor.system.hp.value) - fumble.damage;
  if (backlash?.condition)
    changes['system.conditions'] = [
      ...new Set([...(changes['system.conditions'] ?? actor.system.conditions), backlash.condition]),
    ];
  changes['system.luck.value'] = actor.system.luck.value - luck;
  if ((changes['system.hp.value'] ?? actor.system.hp.value) <= 0 && (cost.hpCost || fumble.damage))
    changes['system.pendingDeathSaves'] = actor.system.pendingDeathSaves + 1;
  let success =
    fumble.spellSucceeds &&
    (kind === 'heliotrope'
      ? result.total >= magicDefenseTotal(data)
      : beats(result.total, magicDefenseTotal(data)));
  const counterLey = {
    castId: id,
    actorUuid: actor.uuid,
    tokenUuid: token.uuid,
    itemUuid: dispelItem?.uuid || '',
    magic: kind === 'dispel' ? magicInfo('dispel') : { key: 'heliotrope', kind: 'sign', element: 'mixed' },
    power: cost.power,
    check: savedCheck(result),
  };
  planAdditionalLey(actor, counterLey, changes, cost, result);
  if (counterLey.pendingReplacement) success = false;
  data.counters = [...(data.counters ?? []), actor.uuid];
  const after = async () => {
    if (success && kind === 'heliotrope')
      for (const target of data.targets)
        if (target.actorUuid === actor.uuid && target.status !== 'applied') target.status = 'defended';
    if (success && kind === 'dispel') data.cancelled = true;
    const remaining = backlash?.pushMeters || fumble.focusExplosion;
    const response = await chat(
      actor,
      `${kind}: ${data.name}`,
      checkHTML(result) +
        `<p>${cost.staCost} STA. ${success ? 'Magic countered.' : 'Counter failed.'}</p>` +
        leyCard(counterLey) +
        (remaining
          ? '<button type="button" data-magic-action="backlash">Resolve remaining backlash (GM)</button>'
          : ''),
      {
        rolls,
        flags: {
          ...counterLey,
          kind: 'magic-backlash',
          castId: id,
          actorUuid: actor.uuid,
          tokenUuid: token.uuid,
          name: `${kind} backlash`,
          element,
          check: savedCheck(result),
          fumble,
          backlash,
          backlashResolved: !remaining,
          failed: true,
          targets: [],
          power: cost.power,
          staCost: cost.staCost,
          hpCost: cost.hpCost,
          roundSpend: cost.roundAfter,
          vigor: cost.vigor,
        },
      }
    );
    try {
      await refreshMagicCard(message, data);
    } catch (error) {
      await response.delete();
      throw error;
    }
    return response;
  };
  return commitActor(actor, changes, [], () =>
    success && kind === 'dispel' ? endMagicCast(data.parentCastId ?? data.castId, { after }) : after()
  );
}

async function executeMaintain({ actorUuid, effectId, values = {}, turn }, { user, id }) {
  const actor = await authorizedActor(actorUuid, user),
    effect = actor.system.effects.find((ef) => ef.id === effectId);
  noPendingLey(actor);
  if (!effect?.magic?.casterEffect || !effect.magic.maintenance || effect.magic.maintenance === 'none')
    throw new RuleError('This effect is not maintained magic.');
  if (turn !== turnIdentity()) throw new RuleError('The turn changed. Reopen the upkeep dialog.');
  if (game.combat?.started && game.combat.combatant?.actor?.uuid !== actor.uuid)
    throw new RuleError('Maintain magic on the caster’s turn.');
  if (roundKey() && effect.magic.castRound === roundKey())
    throw new RuleError('This magic has already been paid for this round.');
  if (!roundKey() && now() < (effect.magic.nextUpkeepAt ?? effect.magic.paidAt + 3))
    throw new RuleError('Advance world time to the next upkeep round.');
  const magic = magicInfo(effect.magic.key);
  if (actor.system.magic?.leyConnection?.active && !(await validateLeyContact(actor)))
    throw new RuleError('The caster is no longer touching the connected Ley Line.');
  validateCasting(actorSnapshot(actor), actorSnapshot(actor).items, magic, {
    continuing: true,
    amulet: !!effect.magic.amuletId,
  });
  const stream = magic.key === 'fire-stream';
  const plan = stream
    ? actionPlan(actor, { extra: !!values.extra, forfeit: !!values.forfeit })
    : { changes: {}, modifier: 0 };
  const { cost, changes } = magicSpending(
    actor,
    magic,
    magicMaintenance(magic, effect.magic.staCost),
    { ...values, maintenance: true, amuletId: effect.magic.amuletId || '' },
    plan
  );
  const effects = clone(actor.system.effects),
    current = effects.find((ef) => ef.id === effectId);
  current.magic = magicUpkeepPaid(current, { time: now(), combat: game.combat });
  changes['system.effects'] = effects;
  if (!stream) {
    const rolls = [];
    const element = ['priest', 'druid'].includes(magicTradition(actor.system)) ? 'mixed' : magic.element;
    const backlash = cost.elementalBacklash ? await selectBacklash(element, rolls) : null;
    if (backlash?.condition && !magicConditionRules(actor.system, backlash.condition).immune)
      changes['system.conditions'] = [
        ...new Set([...(changes['system.conditions'] ?? actor.system.conditions), backlash.condition]),
      ];
    if ((changes['system.hp.value'] ?? actor.system.hp.value) <= 0 && cost.hpCost)
      changes['system.pendingDeathSaves'] = actor.system.pendingDeathSaves + 1;
    const upkeepLey = {
      castId: id,
      actorUuid: actor.uuid,
      tokenUuid: effect.magic.tokenUuid,
      itemUuid: effect.magic.itemUuid || '',
      magic,
      power: effect.magic.power,
      check: clone(
        effect.magic.check ??
          effect.initialCast?.check ?? {
            total: effect.magic.castingTotal ?? 0,
            base: effect.magic.castingTotal ?? 0,
            dice: [],
            fumble: 0,
          }
      ),
    };
    planAdditionalLey(actor, upkeepLey, changes, cost);
    return commitActor(actor, changes, [], () =>
      chat(
        actor,
        `Maintain ${effect.key}`,
        `<p>${cost.staCost} STA paid.${cost.hpCost ? ` ${cost.hpCost} HP overdraw; ${e(element)} backlash.` : ''}</p>` +
          leyCard(upkeepLey) +
          (backlash?.pushMeters
            ? '<button type="button" data-magic-action="backlash">Resolve remaining backlash (GM)</button>'
            : ''),
        {
          rolls,
          flags: {
            ...upkeepLey,
            kind: 'magic-backlash',
            castId: id,
            actorUuid: actor.uuid,
            tokenUuid: effect.magic.tokenUuid,
            name: `${effect.key} upkeep backlash`,
            element,
            check: { total: 0, base: 0, dice: [], fumble: 0 },
            fumble: {},
            backlash,
            backlashResolved: !backlash?.pushMeters,
            failed: true,
            targets: [],
            power: cost.power,
            staCost: cost.staCost,
            hpCost: cost.hpCost,
            roundSpend: cost.roundAfter,
            vigor: cost.vigor,
          },
        }
      )
    );
  }
  const source = await casterTokenFor(actor, effect.magic.tokenUuid),
    target = await foundry.utils.fromUuid(values.targetUuid);
  if (!target?.actor) throw new RuleError('Select the target of the maintained stream.');
  validateDirectTarget(source, target, 3);
  validateManualCheck(values, actor);
  const arm = resolveWoundArm(actor.system, [...actor.items], values.woundArm, 'optional');
  const luck = number(values.luck);
  if (!Number.isInteger(luck) || luck < 0 || luck > actor.system.luck.value)
    throw new RuleError('Invalid Luck expenditure.');
  changes['system.luck.value'] = actor.system.luck.value - luck;
  let modifier = number(values.modifier) + plan.modifier + combatModifier(actor).modifier + luck;
  if (values.aimed) modifier += locate(hitLocations(actorSnapshot(target.actor)), values.aimed).aim;
  const result = await check(actor.skillBase('spellCasting', { stat: 'will', modifier, arm }).total, {
    ...{
      manualDice: values.manualDice,
    },
    actor: actor,
  });
  const initial = effect.initialCast;
  if (!initial) throw new RuleError('The sustained casting record is missing.');
  const data = {
    ...clone(initial),
    castId: id,
    check: savedCheck(result),
    staCost: cost.staCost,
    hpCost: cost.hpCost,
    roundSpend: cost.roundAfter,
    vigor: cost.vigor,
    castTime: now(),
    castRound: roundKey(),
    aimed: values.aimed || '',
    targets: [
      {
        tokenUuid: target.uuid,
        actorUuid: target.actor.uuid,
        name: target.name,
        hidden: !!target.hidden,
        status: 'pending',
      },
    ],
    applied: false,
    cancelled: false,
    failed: false,
    backlash: null,
    fumble: { damage: 0 },
    parentCastId: effect.magic.castId,
  };
  const rolls = [...result.rolls];
  data.backlash = cost.elementalBacklash || result.fumble >= 7 ? await selectBacklash('fire', rolls) : null;
  data.fumble = magicalFumble({ fumble: result.fumble, element: 'fire' });
  data.failed = !data.fumble.spellSucceeds;
  if (data.fumble.damage)
    changes['system.hp.value'] = (changes['system.hp.value'] ?? actor.system.hp.value) - data.fumble.damage;
  if (data.backlash?.condition)
    changes['system.conditions'] = [
      ...new Set([...(changes['system.conditions'] ?? actor.system.conditions), data.backlash.condition]),
    ];
  if ((changes['system.hp.value'] ?? actor.system.hp.value) <= 0 && (cost.hpCost || data.fumble.damage))
    changes['system.pendingDeathSaves'] = actor.system.pendingDeathSaves + 1;
  planAdditionalLey(actor, data, changes, cost, result);
  return commitActor(actor, changes, [], () =>
    chat(actor, 'Fire Stream · sustained attack', magicCard(data), { rolls, flags: data })
  );
}

async function executeEnd({ actorUuid, effectId }, { user }) {
  const actor = await authorizedActor(actorUuid, user),
    effect = actor.system.effects.find((ef) => ef.id === effectId);
  if (!effect?.magic) throw new RuleError('This magical effect no longer exists.');
  if (effect.magic.casterUuid !== actor.uuid && !user.isGM)
    throw new RuleError('Only the caster or GM can dismiss this magic.');
  return endMagicCast(effect.magic.castId, {
    after: () =>
      chat(
        actor,
        `End ${effect.key}`,
        effect.magic.key === 'active-shield'
          ? '<p>The shield collapses. Resolve its adjacent burst from the Magic tab.</p>'
          : '<p>The magical effect ends.</p>'
      ),
  });
}

async function executeResist({ actorUuid, effectId, values = {} }, { user }) {
  const actor = await authorizedActor(actorUuid, user),
    effect = actor.system.effects.find((ef) => ef.id === effectId);
  if (!effect?.magic?.repeatDefense && effect?.magic?.key !== 'axii')
    throw new RuleError('This effect has no repeat resistance action.');
  const cycle = magicRepeatCycle(effect, { time: now(), combat: game.combat, actorUuid: actor.uuid });
  if (effect.magic.lastResistRound === cycle)
    throw new RuleError('This effect was already resisted this round.');
  if (effect.magic.key === 'axii') {
    const { save } = await import('./runtime.js');
    const plan = actionPlan(actor, { full: true, recovery: true });
    const effects = clone(actor.system.effects);
    effects.find((ef) => ef.id === effect.id).magic.lastResistRound = cycle;
    return commitActor(actor, { ...plan.changes, 'system.effects': effects }, [], () => save(actor, 'stun'));
  }
  if (game.combat?.started && game.combat.combatant?.actor?.uuid !== actor.uuid)
    throw new RuleError('Attempt Puppet resistance on the affected actor’s turn.');
  if (!game.combat?.started && now() < effect.magic.createdAt + 3)
    throw new RuleError('Advance world time to the next resistance round.');
  validateManualCheck(values, actor);
  const luck = number(values.luck);
  if (!Number.isInteger(luck) || luck < 0 || luck > actor.system.luck.value)
    throw new RuleError('Invalid Luck expenditure.');
  const result = await check(
    actor.skillBase('resistMagic', { modifier: number(values.modifier) + luck }).total,
    { ...{ manualDice: values.manualDice }, actor: actor }
  );
  const success = result.total >= (effect.magic.defenseDC ?? magicDefenseTotal(effect.magic));
  const removed = success ? removeMagicEffects(actor.system, (ef) => ef.id === effect.id) : null;
  const effects = removed?.effects ?? clone(actor.system.effects);
  if (!success) effects.find((ef) => ef.id === effect.id).magic.lastResistRound = cycle;
  return commitActor(
    actor,
    {
      'system.effects': effects,
      'system.luck.value': actor.system.luck.value - luck,
      ...(removed ? { 'system.conditions': removed.conditions } : {}),
    },
    [],
    () =>
      chat(
        actor,
        `Resist ${effect.key}`,
        checkHTML(result) + `<p>${success ? 'Control ended.' : 'Control continues.'}</p>`,
        { rolls: result.rolls }
      )
  );
}

async function executeWake({ actorUuid, targetUuid, effectId, mode }, { user }) {
  const actor = await authorizedActor(actorUuid, user),
    target = await actorFromUuid(targetUuid);
  const effect = target?.system.effects.find((ef) => ef.id === effectId && ef.magic?.sleeping);
  if (!effect) throw new RuleError('The sleeping effect no longer exists.');
  if (mode === 'noise' && !user.isGM)
    throw new RuleError('The GM determines whether a loud noise reaches the sleeper.');
  if (effect.magic.wake === 'damage') throw new RuleError('This Somne can only be broken by damage.');
  if (mode === 'noise' && effect.magic.wake !== 'noise')
    throw new RuleError('Noise does not wake this target.');
  if (!['noise', 'action', 'fullRound'].includes(mode)) throw new RuleError('Choose a valid waking method.');
  if (mode === 'action' && effect.magic.wake === 'fullRound')
    throw new RuleError('This Somne requires a full-round waking action.');
  if (mode !== 'noise') {
    const pairs = [...game.scenes].flatMap((scene) =>
      [...scene.tokens]
        .filter((token) => token.actor?.uuid === actor.uuid)
        .flatMap((source) =>
          [...scene.tokens]
            .filter((token) => token.actor?.uuid === target.uuid)
            .map((other) => [source, other])
        )
    );
    if (!pairs.some(([source, other]) => magicTokenDistance(source, other) <= 0.001))
      throw new RuleError('The helper must be next to the sleeper.');
  }
  const plan = mode === 'noise' ? { changes: {} } : actionPlan(actor, { full: mode === 'fullRound' });
  const removed = removeMagicEffects(target.system, (ef) => ef.id === effect.id);
  const patientChanges = { 'system.effects': removed.effects, 'system.conditions': removed.conditions };
  const after = () => chat(actor, `Wake ${target.name}`, '<p>Somne ends.</p>');
  if (actor.uuid === target.uuid && mode !== 'noise')
    throw new RuleError('A sleeping actor cannot wake itself with an action.');
  if (mode === 'noise') return commitActor(target, patientChanges, [], after);
  return commitActor(actor, plan.changes, [], () => commitActor(target, patientChanges, [], after));
}

/** Forced movement stops at walls. The chosen direction is explicit for air backlash. */
export async function pushMagicToken(token, metres, angle, receipt) {
  if (token.flags?.[SYSTEM_ID]?.magicMovement?.includes(receipt)) return;
  const origin = magicTokenOrigin(token),
    scale = magicSceneScale(token.parent),
    radians = (number(angle) * Math.PI) / 180;
  const pixels = metres * scale.pixelsPerMetre,
    dx = Math.cos(radians) * pixels,
    dy = Math.sin(radians) * pixels;
  const backend = CONFIG.Canvas?.polygonBackends?.move;
  if (!backend?.testCollision) throw new RuleError('Native wall collision testing is unavailable.');
  let fraction = 1;
  const dimensions = token.parent.dimensions;
  const width = token.width * token.parent.grid.size,
    height = token.height * token.parent.grid.size;
  const offsets = [
    { x: 0, y: 0 },
    { x: -width / 2 + 1, y: -height / 2 + 1 },
    { x: width / 2 - 1, y: -height / 2 + 1 },
    { x: -width / 2 + 1, y: height / 2 - 1 },
    { x: width / 2 - 1, y: height / 2 - 1 },
  ];
  for (let step = 1; step <= 20; step++) {
    const part = step / 20,
      left = token.x + dx * part,
      top = token.y + dy * part;
    const outside =
      dimensions &&
      (left < dimensions.sceneX ||
        top < dimensions.sceneY ||
        left + width > dimensions.sceneX + dimensions.sceneWidth ||
        top + height > dimensions.sceneY + dimensions.sceneHeight);
    const collision = offsets.some((offset) =>
      backend.testCollision(
        { x: origin.x + offset.x, y: origin.y + offset.y },
        {
          x: origin.x + offset.x + dx * part,
          y: origin.y + offset.y + dy * part,
          elevation: origin.elevation,
        },
        { type: 'move', mode: 'any', level: token.parent.levels?.get(origin.level) }
      )
    );
    if (outside || collision) {
      fraction = (step - 1) / 20;
      break;
    }
  }
  await token.update({
    x: token.x + dx * fraction,
    y: token.y + dy * fraction,
    [`flags.${SYSTEM_ID}.magicMovement`]: [...(token.flags?.[SYSTEM_ID]?.magicMovement ?? []), receipt],
  });
}

async function executeBacklash({ messageUuid, values = {} }, { user }) {
  gmOnly(user);
  const message = await magicMessage(messageUuid, { backlash: true }),
    data = clone(message.flags[SYSTEM_ID]);
  if (data.backlashResolved) throw new RuleError('Backlash has already been resolved.');
  const actor = await actorFromUuid(data.actorUuid),
    token = await casterTokenFor(actor, data.tokenUuid);
  if (data.backlash?.needsElement) {
    const backlash = elementalBacklash(values.element);
    if (backlash.needsElement) throw new RuleError('Choose one earth, air, fire or water consequence.');
    if (backlash.condition)
      await actor.update({
        'system.conditions': [...new Set([...actor.system.conditions, backlash.condition])],
      });
    data.backlash = backlash;
    await refreshMagicCard(message, { backlash });
  }
  if (data.backlash?.pushMeters)
    await pushMagicToken(token, data.backlash.pushMeters, values.pushAngle, `backlash:${data.castId}`);
  if (data.fumble?.focusExplosion) {
    const receipt = `focusExplosion:${data.castId}`;
    if (!actor.system.combat.applied.includes(receipt)) {
      const foci = actor.items.filter(
        (item) => isMagicalFocus(item) && item.system.carried !== false && item.system.quantity > 0
      );
      const cards = [];
      try {
        for (const focus of foci)
          for (let unit = 0; unit < focus.system.quantity; unit++) {
            const roll = await dice('1d10');
            for (const target of token.parent.tokens.filter(
              (other) => other.actor && withinMagicRadius(token, other, 2)
            )) {
              const targetState = actorSnapshot(target.actor),
                requests = hitLocations(targetState).map((loc) => ({
                  raw: roll.total,
                  type: 'bludgeoning',
                  location: loc.id,
                  properties: { magic: true, magicBlockable: true },
                }));
              const results = resolveDamageSequence(
                requests,
                targetState,
                hitLocations(targetState),
                targetState.items
              );
              cards.push(
                await chat(
                  actor,
                  `${focus.name} explodes → ${target.name}`,
                  damageHTML({ results }) +
                    '<button type="button" data-witcher-action="apply">Apply damage (GM)</button>',
                  {
                    rolls: [roll],
                    flags: {
                      kind: 'damage',
                      actorUuid: actor.uuid,
                      targetUuid: target.actor.uuid,
                      request: requests,
                      summary: results,
                      state: damageState(target.actor),
                      conditions: [],
                      effects: [],
                      stun: null,
                      applied: false,
                      attackRef: `${receipt}:${focus.id}:${unit}:${target.id}`,
                    },
                  }
                )
              );
            }
          }
        await commitActor(
          actor,
          { 'system.combat.applied': [...actor.system.combat.applied, receipt] },
          foci.map((focus) => ({
            _id: focus.id,
            'system.quantity': 0,
            'system.equipped': false,
            'system.carried': false,
          })),
          () => refreshMagicCard(message, { backlashResolved: true })
        );
      } catch (error) {
        for (const card of cards) await card.delete();
        throw error;
      }
    }
  }
  return refreshMagicCard(message, { backlashResolved: true });
}

/** The persistent trap makes its own attack; this is not another casting or STA expenditure. */
async function executeTrapAttack({ messageUuid, targetUuid, values = {}, turn }, { user, id }) {
  const prompt = await foundry.utils.fromUuid(messageUuid),
    ready = prompt?.flags?.[SYSTEM_ID];
  if (!prompt?.author?.isGM || ready?.kind !== 'magic-trap-ready')
    throw new RuleError('Choose a current Magic Trap attack prompt.');
  if (ready.attackUsed) throw new RuleError('The trap has already attacked in this round.');
  if (turn !== turnIdentity()) throw new RuleError('The turn changed. Use the current trap prompt.');
  const region = await foundry.utils.fromUuid(ready.regionUuid),
    state = region?.flags?.[SYSTEM_ID]?.magicArea;
  if (
    !region ||
    !activeMagicZone(region) ||
    state.lastAttack?.messageUuid !== prompt.uuid ||
    state.lastAttack.used ||
    magicTrapCycle(region, game.combat) !== ready.cycle
  )
    throw new RuleError('This trap prompt is no longer current.');
  const caster = await authorizedActor(state.casterUuid, user);
  const target = trapTarget(region, targetUuid, { user });
  if (!target) throw new RuleError('No enemy is currently in the trap.');
  validateManualCheck(values, caster);
  const checkResult = await check(state.sourceCheckBase, { actor: caster, manualDice: values.manualDice });
  const magic = clone(magicInfo('magic-trap'));
  const data = {
    kind: 'magic',
    castId: id,
    parentCastId: state.castId,
    trapRegionUuid: region.uuid,
    name: 'Magic Trap attack',
    actorUuid: caster.uuid,
    tokenUuid: `Scene.${region.parent.id}.Token.${state.casterTokenId}`,
    itemId: 'magic-trap',
    magicKey: 'magic-trap',
    magic,
    element: 'mixed',
    power: state.power,
    resolved: resolvedMagic(magic, state.power),
    check: savedCheck(checkResult),
    focus: clone(state.focus ?? null),
    staCost: state.staCost,
    hpCost: 0,
    roundSpend: currentSpent(caster),
    vigor: magicVigor(caster.system),
    castTime: now(),
    castRound: roundKey(),
    targets: [
      {
        tokenUuid: target.uuid,
        actorUuid: target.actor.uuid,
        name: target.name,
        hidden: !!target.hidden,
        status: 'pending',
      },
    ],
    failed: false,
    applied: false,
    cancelled: false,
    trapAttack: true,
    fumble: { damage: 0 },
    backlash: null,
  };
  const attack = await chat(caster, data.name, magicCard(data), { rolls: checkResult.rolls, flags: data });
  try {
    await region.update({
      [`flags.${SYSTEM_ID}.magicArea.lastAttack`]: {
        ...state.lastAttack,
        used: true,
        attackUuid: attack.uuid,
      },
    });
    await prompt.update({
      [`flags.${SYSTEM_ID}.attackUsed`]: true,
      [`flags.${SYSTEM_ID}.attackUuid`]: attack.uuid,
      content: `<article class="witcher-chat"><h3>Magic Trap</h3><p>Round attack rolled.</p></article>`,
    });
  } catch (error) {
    await region.update({ [`flags.${SYSTEM_ID}.magicArea.lastAttack`]: state.lastAttack });
    await attack.delete();
    throw error;
  }
  return attack;
}

export async function promptMagicCollapse(actor, effect) {
  return chat(
    actor,
    'Active Shield · collapse',
    '<p>The shield has ended. Resolve its burst against everyone adjacent, including allies and objects: 1d6 torso damage and a 2 m push. Rooted objects and creatures heavier than 226 kg take damage without moving.</p><button type="button" data-magic-action="collapse">Resolve collapse (GM)</button>',
    {
      flags: {
        kind: 'magic-collapse',
        actorUuid: actor.uuid,
        effectId: effect.id,
        castId: effect.magic.castId,
      },
    }
  );
}

async function executeProtect({ actorUuid, effectId, targetUuid }, { user }) {
  const caster = await authorizedActor(actorUuid, user),
    effect = caster.system.effects.find(
      (ef) => ef.id === effectId && ef.magic?.key === 'active-shield' && ef.shieldHP > 0
    );
  if (!effect) throw new RuleError('Choose an active shield with remaining HP.');
  const source = await casterTokenFor(caster, effect.magic.tokenUuid),
    target = targetUuid ? await foundry.utils.fromUuid(targetUuid) : null;
  const { pressedTogether } = await import('./magic-shields.js');
  if (target && (!target.actor || target.actor.uuid === caster.uuid || !pressedTogether(source, target)))
    throw new RuleError('Choose one other person pressed against the shielded caster.');
  const plans = [];
  for (const actor of worldMagicActors()) {
    const links = actor.system.effects.filter(
      (ef) => ef.magic?.key === 'active-shield-companion' && ef.magic.castId === effect.magic.castId
    );
    if (links.length)
      plans.push({
        actor,
        changes: { 'system.effects': actor.system.effects.filter((ef) => !links.includes(ef)) },
      });
  }
  const casterEffects = clone(caster.system.effects),
    shield = casterEffects.find((ef) => ef.id === effectId);
  shield.magic.companionUuid = target?.uuid || '';
  plans.push({ actor: caster, changes: { 'system.effects': casterEffects } });
  if (target) {
    const existing = plans.find((plan) => plan.actor.uuid === target.actor.uuid);
    const effects = existing?.changes['system.effects'] ?? clone(target.actor.system.effects);
    effects.push({
      id: foundry.utils.randomID(),
      key: 'Active Shield · companion',
      expires: 0,
      magic: {
        key: 'active-shield-companion',
        castId: effect.magic.castId,
        casterUuid: caster.uuid,
        tokenUuid: source.uuid,
        companionTokenUuid: target.uuid,
        maintenance: 'none',
      },
      notes: 'Shares the caster’s remaining shield HP only while pressed together.',
    });
    if (existing) existing.changes['system.effects'] = effects;
    else plans.push({ actor: target.actor, changes: { 'system.effects': effects } });
  }
  return commitMany(plans, () =>
    chat(
      caster,
      'Active Shield',
      `<p>${target ? `${e(target.name)} shares the shield while pressed together.` : 'Companion protection ended.'}</p>`
    )
  );
}

async function executeCollapse({ actorUuid, effectId, values = {} }, { user }) {
  gmOnly(user);
  const actor = await actorFromUuid(actorUuid);
  let effect = actor?.system.effects.find((ef) => ef.id === effectId && ef.magic?.key === 'active-shield');
  if (!effect || !effect.magic.pendingCollapse) throw new RuleError('This shield has no pending collapse.');
  const token = await casterTokenFor(actor, effect.magic.tokenUuid),
    origin = magicTokenOrigin(token);
  let plan = effect.magic.collapsePlan;
  if (!plan) {
    const anchored = values.anchoredTokenUuids ?? [];
    if (!Array.isArray(anchored)) throw new RuleError('Choose the rooted or heavier-than-226-kg targets.');
    const targets = token.parent.tokens.filter(
      (other) => other.id !== token.id && other.actor && magicTokenDistance(token, other) <= 0.001
    );
    if (anchored.some((uuid) => !targets.some((target) => target.uuid === uuid)))
      throw new RuleError('An anchored target is not adjacent.');
    const roll = await dice('1d6');
    plan = {
      damage: roll.total,
      origin,
      targets: targets.map((target) => ({
        uuid: target.uuid,
        actorUuid: target.actor.uuid,
        push: !anchored.includes(target.uuid),
        angle:
          (Math.atan2(magicTokenOrigin(target).y - origin.y, magicTokenOrigin(target).x - origin.x) * 180) /
          Math.PI,
      })),
    };
    const effects = clone(actor.system.effects),
      changed = effects.find((ef) => ef.id === effectId);
    changed.magic.collapsePlan = plan;
    await commitActor(actor, { 'system.effects': effects }, [], () =>
      chat(
        actor,
        'Active Shield · burst',
        `<p>${roll.total} damage to the torso of every adjacent creature and object. Adjacent furniture and terrain objects without an Actor use this same damage roll.</p>`,
        { rolls: [roll], flags: { kind: 'magic-burst', castId: effect.magic.castId } }
      )
    );
  }
  const { magicDamageSnapshot } = await import('./magic-shields.js');
  for (const row of plan.targets) {
    const target = await foundry.utils.fromUuid(row.uuid),
      victim = await actorFromUuid(row.actorUuid);
    if (!victim) continue;
    const receipt = `collapse:${effect.magic.castId}:${row.uuid}`;
    if (
      !game.messages.some((message) => message.flags?.[SYSTEM_ID]?.attackRef === receipt) &&
      !victim.system.combat.applied.includes(`damage:${receipt}`)
    ) {
      const state = magicDamageSnapshot(victim),
        request = [
          {
            raw: plan.damage,
            type: 'elemental',
            location: 'torso',
            properties: { magic: true, magicBlockable: true },
          },
        ];
      const results = resolveDamageSequence(request, state, hitLocations(state), state.items);
      await chat(
        actor,
        `Active Shield burst → ${victim.name}`,
        damageHTML({ results }) +
          '<button type="button" data-witcher-action="apply">Apply damage (GM)</button>',
        {
          flags: {
            kind: 'damage',
            actorUuid: actor.uuid,
            targetUuid: victim.uuid,
            request,
            summary: results,
            state: damageState(victim),
            conditions: [],
            effects: [],
            stun: null,
            applied: false,
            attackRef: receipt,
          },
        }
      );
    }
    if (row.push && target) await pushMagicToken(target, 2, row.angle, receipt);
  }
  return endMagicCast(effect.magic.castId, {
    collapse: true,
    after: () => chat(actor, 'Active Shield', '<p>Collapse resolved. Apply each generated damage card.</p>'),
  });
}

async function executeFall({ actorUuid, effectId, values = {} }, { user }) {
  gmOnly(user);
  const actor = await actorFromUuid(actorUuid),
    effect = actor?.system.effects.find((ef) => ef.id === effectId && ef.magic?.pendingFall);
  if (!effect) throw new RuleError('This actor has no pending magical fall.');
  const height = number(values.height, 'Fall height');
  if (height < 0) throw new RuleError('Fall height cannot be negative.');
  const token = await foundry.utils.fromUuid(effect.magic.affectedTokenUuid);
  if (!token) throw new RuleError('The falling token no longer exists.');
  const { fallingDice } = await import('./advanced-rules.js');
  const count = fallingDice(height),
    removed = removeMagicEffects(actor.system, (ef) => ef.id === effect.id);
  const receipt = `magic-fall:${effect.id}`;
  let card = null;
  if (count) {
    const roll = await dice(`${count}d6`),
      { magicDamageSnapshot } = await import('./magic-shields.js'),
      state = magicDamageSnapshot(actor);
    const request = [
      {
        raw: roll.total,
        type: 'bludgeoning',
        location: 'torso',
        properties: { environmental: true, damageSource: 'falling', activeAtLanding: true },
      },
    ];
    const results = resolveDamageSequence(request, state, hitLocations(state), state.items);
    card = await chat(
      actor,
      'Aard Sweep · falling damage',
      damageHTML({ results }) +
        '<button type="button" data-witcher-action="apply">Apply damage (GM)</button>',
      {
        rolls: [roll],
        flags: {
          kind: 'damage',
          actorUuid: actor.uuid,
          targetUuid: actor.uuid,
          request,
          summary: results,
          state: damageState(actor),
          conditions: [],
          effects: [],
          stun: null,
          applied: false,
          attackRef: receipt,
        },
      }
    );
  }
  const elevation = token.elevation;
  try {
    if (height)
      await token.update({ elevation: elevation - height / magicSceneScale(token.parent).metresPerUnit });
    await commitActor(
      actor,
      { 'system.effects': removed.effects, 'system.conditions': removed.conditions },
      [],
      () =>
        chat(
          actor,
          'Aard Sweep fall',
          `<p>${height ? `${height}m fall resolved; apply the falling damage card.` : 'The GM confirmed that this target was grounded; no fall.'}</p>`
        )
    );
  } catch (error) {
    if (height) await token.update({ elevation });
    if (card) await card.delete();
    throw error;
  }
  return card;
}
