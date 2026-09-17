import { magicRecoveryRules } from './magic-effect-hooks.js';
import { SYSTEM_ID } from './config.js';
import { RuleError } from './rules.js';
import { removeMagicEffects } from './magic-state.js';
import { chat, commitActor, errorNotice, escapeHTML as e, serial } from './runtime.js';
import { isPrimaryActiveGm } from '../foundry-compat.js';
import {
  activeHealingRest,
  healingRestActionRestriction,
  healingRestCompletionPlan,
} from './magic-healing-extra.js';
import { endMagicSource } from './magic-source-cleanup.js';

const clone = (value) => structuredClone(value);
const values = (collection) => collection?.contents ?? Array.from(collection ?? []);
const maintained = (effect) =>
  effect.magic?.casterEffect && effect.magic.maintenance && effect.magic.maintenance !== 'none';
let collapseCallback;

function validTime(time) {
  if (!Number.isFinite(time))
    throw new RuleError('A finite world time is required for magic lifecycle updates.');
  return time;
}

function combatRound(combat) {
  return combat?.started && Number.isInteger(combat.round) ? `${combat.id}:${combat.round}` : '';
}

function roundNumber(cycle, combatId) {
  const prefix = `${combatId}:`;
  if (typeof cycle !== 'string' || !cycle.startsWith(prefix)) return null;
  const round = Number(cycle.slice(prefix.length));
  return Number.isInteger(round) ? round : null;
}

function actorCombat(combat, actorUuid) {
  if (!combat?.started) return null;
  const activeActor = combat.actorUuid ?? combat.combatant?.actor?.uuid;
  const present =
    combat.actorPresent ??
    (combat.combatants ? values(combat.combatants).some((entry) => entry.actor?.uuid === actorUuid) : true);
  return {
    id: combat.id,
    round: combat.round,
    turn: combat.turn,
    active: activeActor === actorUuid,
    present,
  };
}

/** Assign the returned full metadata object after a successful, compensated upkeep payment. */
export function magicUpkeepPaid(effect, { time, combat } = {}) {
  validTime(time);
  const interval = upkeepInterval(effect);
  return {
    ...clone(effect.magic ?? {}),
    paidAt: time,
    nextUpkeepAt: time + interval,
    castRound: combatRound(combat),
    upkeepDue: false,
    upkeepCycle: '',
    upkeepDeadline: 0,
  };
}

function upkeepInterval(effect) {
  const interval = effect.magic?.maintenanceIntervalSeconds ?? 3;
  if (!Number.isFinite(interval) || interval < 3)
    throw new RuleError('Magic upkeep requires a valid printed maintenance interval.');
  return interval;
}

/** One resistance opportunity per round, including outside combat. */
export function magicRepeatCycle(effect, { time, combat, actorUuid } = {}) {
  validTime(time);
  if (actorUuid && !actorCombat(combat, actorUuid)?.present) combat = null;
  if (combatRound(combat)) return combatRound(combat);
  const createdAt = Number.isFinite(effect.magic?.createdAt) ? effect.magic.createdAt : 0;
  return `time:${Math.max(0, Math.floor((time - createdAt) / 3))}`;
}

/** Ordinary Stun recovery cannot remove Somne; Axii supplies its printed save penalty. */
export function magicalStunRecovery(state, { effectId } = {}) {
  const healingRest = activeHealingRest(state);
  const sleep = (state.effects ?? []).filter((effect) => effect.magic?.sleeping);
  const mental = (state.effects ?? []).filter((effect) =>
    (effect.magic?.operations ?? [effect.magic?.operation]).some(
      (operation) => operation?.rule?.key === 'mentalRecovery'
    )
  );
  const illness = (state.effects ?? []).some(
    (effect) =>
      !effect.disabled &&
      !effect.magic?.suppressed &&
      effect.magic?.key === 'cursed-illness' &&
      (effect.conditions?.includes('stunned') ||
        (effect.magic.operations ?? []).some((operation) => operation.rule?.key === 'illnessRecovery'))
  );
  const axii = (state.effects ?? []).filter(
    (effect) => effect.magic?.key === 'axii' && (!effectId || effect.id === effectId)
  );
  return {
    blocked: !!healingRest || sleep.length > 0 || mental.length > 0 || illness,
    reason: healingRest
      ? healingRestActionRestriction(state)
      : sleep.length
        ? 'Somne ends through its permitted waking method, damage, or expiration; an ordinary Stun save does not wake the sleeper.'
        : mental.length
          ? 'This magical Stun ends through its printed unmodified INT roll. Use the saved continuing-magic recovery card on the affected creature’s turn.'
          : illness
            ? 'Cursed Illness ends through an Endurance check exceeding its original casting total. Use Recover from Cursed Illness on the Magic tab.'
            : '',
    modifier: axii.reduce((penalty, effect) => Math.min(penalty, Number(effect.magic.stunModifier) || 0), 0),
    effectIds: axii.map((effect) => effect.id),
    sleepingEffectIds: sleep.map((effect) => effect.id),
  };
}

/** Merge with the normal Stun save's result. It removes only successfully resisted Axii sources. */
export function magicStunSavePlan(state, { success, effectId } = {}) {
  const recovery = magicalStunRecovery(state, { effectId });
  if (!success || recovery.blocked || !recovery.effectIds.length)
    return {
      effects: clone(state.effects ?? []),
      conditions: [...(state.conditions ?? [])],
      removed: [],
      ...recovery,
    };
  const selected = new Set(recovery.effectIds);
  return { ...removeMagicEffects(state, (effect) => selected.has(effect.id)), ...recovery };
}

/** Actual HP or STA damage wakes every Somne source, preserving unrelated stun sources. */
export function wakeMagicOnDamage(state, damage = 0) {
  const amount =
    typeof damage === 'number' ? damage : Number(damage?.hpDamage ?? 0) + Number(damage?.staDamage ?? 0);
  if (!Number.isFinite(amount) || amount < 0)
    throw new RuleError('Actual waking damage must be a non-negative number.');
  if (amount === 0)
    return { effects: clone(state.effects ?? []), conditions: [...(state.conditions ?? [])], removed: [] };
  return removeMagicEffects(state, (effect) => !!effect.magic?.sleeping);
}

function maintenancePlan(effect, { time, combat, actorUuid }) {
  const magic = effect.magic,
    interval = upkeepInterval(effect),
    turn = interval === 3 ? actorCombat(combat, actorUuid) : null;
  const paidAt = Number.isFinite(magic.paidAt)
    ? magic.paidAt
    : Number.isFinite(magic.createdAt)
      ? magic.createdAt
      : time;
  if (turn?.present) {
    if (!turn.active) return { changed: false, ended: false };
    const paidRound = roundNumber(magic.castRound, turn.id);
    const dueRound = roundNumber(magic.upkeepCycle, turn.id);
    if (paidRound !== null && turn.round <= paidRound) return { changed: false, ended: false };
    if (dueRound !== null && turn.round < dueRound) return { changed: false, ended: false };
    if (
      (magic.upkeepDue && dueRound !== null && turn.round > dueRound) ||
      (paidRound !== null && turn.round > paidRound + 1)
    )
      return { changed: false, ended: true };
    if (magic.upkeepDue && dueRound === turn.round) return { changed: false, ended: false };
    magic.upkeepDue = true;
    magic.upkeepCycle = `${turn.id}:${turn.round}`;
    magic.upkeepDeadline = time + 3;
    return { changed: true, ended: false };
  }
  const nextAt = Number.isFinite(magic.nextUpkeepAt) ? magic.nextUpkeepAt : paidAt + interval;
  if (time < nextAt) return { changed: false, ended: false };
  if (time >= nextAt + interval) return { changed: false, ended: true };
  if (magic.upkeepDue && magic.upkeepCycle === `time:${nextAt}`) return { changed: false, ended: false };
  magic.upkeepDue = true;
  magic.upkeepCycle = `time:${nextAt}`;
  magic.upkeepDeadline = nextAt + interval;
  return { changed: true, ended: false };
}

function healingPlan(effect, state, time) {
  const magic = effect.magic,
    amount = Number(magic.healing);
  if (!(amount > 0) || !Number.isFinite(amount)) return { ticks: 0, hp: 0 };
  const remaining = Number(magic.roundsRemaining);
  if (!Number.isInteger(remaining) || remaining < 0 || !Number.isFinite(magic.nextAt))
    throw new RuleError('A healing spell is missing its saved round count or next healing time.');
  const through = effect.expires > 0 ? Math.min(time, effect.expires) : time;
  const ticks = Math.min(remaining, Math.max(0, Math.floor((through - magic.nextAt) / 3) + 1));
  if (!ticks) return { ticks: 0, hp: 0 };
  magic.roundsRemaining -= ticks;
  magic.nextAt += ticks * 3;
  return { ticks, hp: state.conditions?.includes('dead') ? 0 : amount * ticks };
}

function repeatPrompt(effect, { time, combat, actorUuid }) {
  if (effect.magic.repeatDefense !== 'resistMagic') return null;
  const turn = actorCombat(combat, actorUuid),
    cycle = magicRepeatCycle(effect, { time, combat, actorUuid });
  if (turn?.present) {
    if (!turn.active) return null;
    const castRound = roundNumber(effect.magic.castRound, turn.id);
    if (castRound !== null && turn.round <= castRound) return null;
    const previous = roundNumber(effect.magic.lastResistPromptRound, turn.id);
    if (previous !== null && previous >= turn.round) return null;
  } else {
    if (!Number.isFinite(effect.magic.createdAt) || time < effect.magic.createdAt + 3) return null;
    const previous = Number(String(effect.magic.lastResistPromptRound ?? '').replace(/^time:/, ''));
    const current = Number(cycle.replace(/^time:/, ''));
    if (Number.isFinite(previous) && previous >= current) return null;
  }
  if (effect.magic.lastResistRound === cycle || effect.magic.lastResistPromptRound === cycle) return null;
  effect.magic.lastResistPromptRound = cycle;
  return {
    kind: 'puppet',
    effectId: effect.id,
    castId: effect.magic.castId,
    cycle,
    castingTotal: effect.magic.castingTotal,
  };
}

/** Pure lifecycle plan. Final healing ticks are consumed before expired effects are removed. */
export function planMagicLifecycle(state, { time, combat, actorUuid, maxHP = state.hp?.max } = {}) {
  validTime(time);
  let next = { ...state, effects: clone(state.effects ?? []), conditions: [...(state.conditions ?? [])] };
  let hpValue = Number(state.hp?.value ?? 0);
  const healing = [],
    prompts = [],
    collapse = [],
    expiredIds = [],
    endedCastIds = [];
  const remove = new Set();
  for (const effect of next.effects) {
    const magic = effect.magic;
    if (!magic || magic.regionUuid || magic.ongoing?.managed || magic.healingRest) continue; // Special lifecycles complete before removal.
    const healed = healingPlan(effect, state, time);
    if (healed.ticks) {
      const before = hpValue;
      if (!Number.isFinite(maxHP)) throw new RuleError('A healing target needs its current maximum HP.');
      hpValue = Math.max(
        hpValue,
        Math.min(
          maxHP,
          hpValue + magicRecoveryRules(state, { source: 'magical', amount: healed.hp }).hpAmount
        )
      );
      healing.push({ effectId: effect.id, ticks: healed.ticks, amount: Math.max(0, hpValue - before) });
    }
    let reason = effect.expires > 0 && effect.expires <= time ? 'expired' : '';
    if (magic.healing && magic.roundsRemaining === 0) reason ||= 'healing complete';
    if (maintained(effect) && maintenancePlan(effect, { time, combat, actorUuid }).ended)
      reason ||= 'upkeep not paid';
    if (
      magic.key === 'active-shield' &&
      !magic.collapseResolved &&
      (reason || effect.shieldHP <= 0 || magic.pendingCollapse)
    ) {
      effect.shieldHP = 0;
      effect.expires = 0;
      magic.pendingCollapse = true;
      magic.maintenance = 'none';
      magic.upkeepDue = false;
      if (!magic.collapsePrompted)
        collapse.push({ effectId: effect.id, castId: magic.castId, reason: reason || 'shield exhausted' });
      continue;
    }
    if (reason) {
      remove.add(effect.id);
      expiredIds.push(effect.id);
      if (magic.casterEffect && magic.castId) endedCastIds.push(magic.castId);
      continue;
    }
    const prompt = repeatPrompt(effect, { time, combat, actorUuid });
    if (prompt) prompts.push(prompt);
  }
  if (remove.size) next = { ...next, ...removeMagicEffects(next, (effect) => remove.has(effect.id)) };
  return {
    effects: next.effects,
    conditions: next.conditions,
    hpValue,
    healing,
    prompts,
    collapse,
    expiredIds,
    endedCastIds: [...new Set(endedCastIds)],
    changed:
      hpValue !== Number(state.hp?.value ?? 0) ||
      JSON.stringify(next.effects) !== JSON.stringify(state.effects ?? []) ||
      JSON.stringify(next.conditions) !== JSON.stringify(state.conditions ?? []),
  };
}

function magicActors() {
  const actors = new Map(values(game.actors).map((actor) => [actor.uuid, actor]));
  for (const scene of values(game.scenes))
    for (const token of values(scene.tokens)) if (token.actor) actors.set(token.actor.uuid, token.actor);
  return [...actors.values()];
}

async function puppetReminder(actor, prompt) {
  const ownerIds = values(game.users)
    .filter((user) => user.active && (user.isGM || actor.testUserPermission(user, 'OWNER')))
    .map((user) => user.id);
  return chat(
    actor,
    'Puppet · resist control',
    `<p>This round, resist the casting total ${e(prompt.castingTotal)} to break control.</p>` +
      `<button type="button" data-magic-action="resist" data-effect="${e(prompt.effectId)}">Resist Puppet</button>`,
    { whisper: ownerIds, flags: { ...prompt, kind: 'magic-repeat', actorUuid: actor.uuid } }
  );
}

/** UNSERIALIZED: safe to await inside a running authoritative command. */
export async function tickMagicLifecycle({
  combat = game.combat,
  time = Number(game.time?.worldTime ?? 0),
  onCollapse = collapseCallback,
} = {}) {
  if (!isPrimaryActiveGm()) throw new RuleError('Only the elected GM updates ongoing magic.');
  validTime(time);
  const preparePlans = () =>
    Promise.all(
      magicActors().map(async (actor) => {
        const rest = await healingRestCompletionPlan(actor, time);
        const state = {
          ...actor.system,
          effects: rest.effects,
          conditions: rest.conditions,
          hp: { ...actor.system.hp, value: rest.hpValue },
        };
        const plan = planMagicLifecycle(state, { time, combat, actorUuid: actor.uuid });
        plan.changed ||= rest.completed.length > 0;
        return { actor, plan, rest };
      })
    );
  let plans = await preparePlans();
  // An unpaid caster effect ends all effects from its cast; leave unrelated spells alone.
  const ended = new Set(plans.flatMap(({ plan }) => plan.endedCastIds));
  const completed = [],
    createdMessages = [],
    cleanupTransactions = [];
  const apply = async (index) => {
    if (index === plans.length) return;
    const { actor, plan, rest } = plans[index];
    if (onCollapse)
      for (const pending of plan.collapse) {
        const effect = plan.effects.find((candidate) => candidate.id === pending.effectId);
        if (effect) {
          effect.magic.collapsePrompted = true;
          plan.changed = true;
        }
      }
    if (!plan.changed && !plan.prompts.length) return apply(index + 1);
    const changes = { ...rest.changes, 'system.effects': plan.effects, 'system.conditions': plan.conditions };
    if (plan.hpValue !== actor.system.hp.value) changes['system.hp.value'] = plan.hpValue;
    return commitActor(actor, changes, rest.items, async () => {
      if (rest.completed.length)
        createdMessages.push(
          await chat(
            actor,
            'Healing Rest completed',
            `<p>The full day has passed. ${
              rest.completed[0].living
                ? `${rest.completed[0].hpAllowed ? 'Health Points restored to maximum.' : 'HP recovery is blocked by another effect.'} ${rest.items.length} treated critical wound(s) healed; permanent penalties remain.`
                : 'The subject is no longer living and receives no healing.'
            }</p>`,
            {
              flags: {
                kind: 'magic-healing-rest-completed',
                actorUuid: actor.uuid,
                completed: rest.completed,
              },
            }
          )
        );
      for (const prompt of plan.prompts) createdMessages.push(await puppetReminder(actor, prompt));
      if (onCollapse)
        for (const pending of plan.collapse) {
          const effect = actor.system.effects.find((candidate) => candidate.id === pending.effectId);
          if (!effect) continue;
          const message = await onCollapse(actor, effect, { reason: pending.reason });
          if (message?.delete) createdMessages.push(message);
        }
      completed.push(actor.uuid);
      return apply(index + 1);
    });
  };
  try {
    for (const castId of ended)
      cleanupTransactions.push(await endMagicSource(castId, { returnTransaction: true }));
    // Recompute after teardown. Reusing the old plans could reinstall Region
    // occupancy effects or use HP caps from an expired enchanted item.
    if (ended.size) plans = await preparePlans();
    await apply(0);
  } catch (error) {
    await Promise.allSettled(createdMessages.map((message) => message.delete()));
    for (const transaction of cleanupTransactions.reverse()) await transaction.rollback();
    throw error;
  }
  return {
    updatedActors: [
      ...new Set([...completed, ...cleanupTransactions.flatMap((transaction) => transaction.actorUuids)]),
    ],
    healing: plans.flatMap(({ actor, plan }) =>
      plan.healing.map((healing) => ({ actorUuid: actor.uuid, ...healing }))
    ),
  };
}

/** Hooks enqueue work and return immediately; exported ticks do not enqueue recursively. */
export function registerMagicLifecycle({ onCollapse } = {}) {
  if (onCollapse !== undefined && typeof onCollapse !== 'function')
    throw new RuleError('The Active Shield collapse handler must be a function.');
  collapseCallback = onCollapse;
  const schedule = () => {
    if (isPrimaryActiveGm()) serial('witcher-authority', () => tickMagicLifecycle()).catch(errorNotice);
  };
  Hooks.on('updateWorldTime', schedule);
  Hooks.on('updateCombat', (_combat, changes) => {
    if ('round' in changes || 'turn' in changes) schedule();
  });
  Hooks.on('updateActor', (_actor, changes) => {
    if (
      ['effects', 'conditions', 'hp', 'sta'].some(
        (key) => key in (changes.system ?? {}) || `system.${key}` in changes
      )
    )
      schedule();
  });
  Hooks.on('canvasReady', schedule);
  Hooks.once('ready', schedule);
}
