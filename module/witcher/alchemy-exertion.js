/** Core pp.48,161,247–248. Neither Core nor Tome gives a universal breath
 * duration or prolonged-running STA rate. These require recorded GM baselines. */
import { SYSTEM_ID } from './config.js';
import { RuleError } from './rules.js';
import { alchemyKey } from './alchemy-rules.js';
import { magicEnvironmentRules } from './magic-effect-hooks.js';
import { woundConditionSources } from './wounds.js';
import { registerCommand, authorizedActor, runCommand } from './authority.js';
import { owner, prompt, input, actionPlan, commitActor, chat, escapeHTML as e } from './runtime.js';

const path = `flags.${SYSTEM_ID}.alchemyExertion`;
const clone = (value) => foundry.utils.deepClone(value);
const now = () => Number(game.time.worldTime);
const stateFor = (actor) => clone(actor.flags?.[SYSTEM_ID]?.alchemyExertion ?? {});
const positive = (value) => Number.isFinite(value) && value > 0;
const onCombat = (actor) =>
  [...(game.combats ?? (game.combat ? [game.combat] : []))].some(
    (combat) =>
      combat.started &&
      (combat.combatant?.actor?.uuid === actor.uuid ||
        [...(combat.combatants ?? [])].some((entry) => entry.actor?.uuid === actor.uuid))
  );

/** Split at actual potion boundaries so an expired dose cannot grant immunity
 * for elapsed time beyond its own duration. */
export function exertionSegments(effects, key, from, to) {
  const sources = (effects ?? []).filter(
    (effect) =>
      alchemyKey(effect) === key && !effect.disabled && !effect.suppressed && !effect.alchemy?.noBenefit
  );
  const intervals = sources
    .map((effect) => [Math.max(from, effect.alchemy?.startedAt ?? from), Math.min(to, effect.expires || to)])
    .filter(([start, end]) => end > start);
  const bounds = [...new Set([from, to, ...intervals.flat()])].sort((a, b) => a - b);
  return bounds.slice(1).map((end, index) => ({
    from: bounds[index],
    to: end,
    protected: intervals.some(([start, finish]) => start <= bounds[index] && finish >= end),
  }));
}

export function breathElapsed(breath, effects, time) {
  let remaining = breath.remainingSeconds,
    exhaustedAt = breath.exhaustedAt ?? null;
  const segments = exertionSegments(effects, 'killer-whale', breath.checkedAt, time);
  for (const segment of segments) {
    if (remaining <= 0) break;
    const rate = segment.protected ? 1 / 1.5 : 1,
      duration = segment.to - segment.from;
    if (duration * rate >= remaining) {
      exhaustedAt = segment.from + remaining / rate;
      remaining = 0;
      break;
    }
    remaining -= duration * rate;
  }
  return { ...breath, checkedAt: time, remainingSeconds: Math.max(0, remaining), exhaustedAt };
}

function clearBreathSource(actor, effects, conditions, sourceId) {
  const source = effects.find((effect) => effect.id === sourceId),
    retained = effects.filter((effect) => effect.id !== sourceId);
  const other =
    retained.some(
      (effect) =>
        effect.conditions?.includes('suffocating') || effect.magic?.addedConditions?.includes('suffocating')
    ) || woundConditionSources([...actor.items], 'suffocating').length;
  return {
    effects: retained,
    conditions:
      source?.alchemy?.addedSuffocation && !other
        ? conditions.filter((condition) => condition !== 'suffocating')
        : conditions,
  };
}

export async function advanceAlchemyExertion(actor, time = now()) {
  const state = stateFor(actor);
  if (!state.breath?.active && !state.running?.active) return;
  const changes = {},
    effects = clone(actor.system.effects),
    conditions = new Set(actor.system.conditions);
  let nextEffects = effects,
    nextConditions = conditions,
    damage = 0,
    text = [];
  if (state.breath?.active && time > state.breath.checkedAt) {
    const breath = state.breath;
    const protectedAir = magicEnvironmentRules(actor.system, {
      medium: breath.cause === 'drowning' ? 'water' : 'air',
      cause: breath.cause,
    }).blockedSuffocation;
    if (protectedAir) {
      const removed = clearBreathSource(actor, nextEffects, [...nextConditions], breath.sourceId);
      nextEffects = removed.effects;
      nextConditions = new Set(removed.conditions);
      state.breath = {
        ...breath,
        checkedAt: time,
        remainingSeconds: breath.baselineSeconds,
        exhaustedAt: null,
        damageAt: time,
      };
    } else {
      state.breath = breathElapsed(breath, effects, time);
      if (state.breath.remainingSeconds <= 0) {
        if (!nextEffects.some((effect) => effect.id === breath.sourceId)) {
          nextEffects.push({
            id: breath.sourceId,
            key: 'Breath exhausted',
            expires: 0,
            conditions: ['suffocating'],
            alchemy: {
              key: 'breath-exhausted',
              kind: 'condition',
              cause: breath.cause,
              addedSuffocation: !nextConditions.has('suffocating'),
            },
          });
          nextConditions.add('suffocating');
          text.push('The recorded breath reserve is exhausted; suffocation applies (Core p.161).');
        }
        const last = breath.damageAt ?? state.breath.exhaustedAt,
          rounds = Math.max(0, Math.floor((time - last) / 3));
        state.breath.damageAt = last + rounds * 3;
        // Combat already deals the nonstacking suffocation condition once per turn.
        if (!onCombat(actor) && !actor.system.conditions.includes('dead') && rounds) damage = rounds * 3;
      }
    }
  }
  if (state.running?.active && time > state.running.checkedAt) {
    const running = state.running;
    const elapsed = exertionSegments(effects, 'werewolf-decoction', running.checkedAt, time)
      .filter((segment) => !segment.protected)
      .reduce((seconds, segment) => seconds + segment.to - segment.from, 0);
    const exact =
      (running.fractionalCost ?? 0) +
      (actor.system.traits?.infiniteStamina ? 0 : (elapsed / running.intervalSeconds) * running.staCost);
    const cost = Math.floor(exact + 1e-8),
      remaining = Math.max(0, actor.system.sta.value - cost);
    state.running = {
      ...running,
      checkedAt: time,
      fractionalCost: exact - cost,
      paid: (running.paid ?? 0) + Math.min(cost, actor.system.sta.value),
    };
    if (cost) changes['system.sta.value'] = remaining;
    if (cost && remaining === 0) {
      state.running.active = false;
      nextConditions.add('stunned');
      text.push(
        'Long-running STA reached zero; running stopped and the actor is stunned until recovery (Core p.48).'
      );
    }
  }
  Object.assign(changes, {
    [path]: state,
    'system.effects': nextEffects,
    'system.conditions': [...nextConditions],
  });
  if (damage) {
    const { planDamageChanges } = await import('./combat.js'),
      { commitDamage } = await import('./magic-shields.js');
    const planned = planDamageChanges(actor, [], [], { directHP: damage });
    const patchedEffects = new Map(
      (planned.actor['system.effects'] ?? actor.system.effects).map((effect) => [effect.id, effect])
    );
    changes['system.effects'] = nextEffects.map((effect) => patchedEffects.get(effect.id) ?? effect);
    changes['system.conditions'] = [
      ...new Set([...nextConditions, ...(planned.actor['system.conditions'] ?? [])]),
    ];
    Object.assign(planned.actor, changes);
    return commitDamage(actor, planned, planned.items, () =>
      chat(
        actor,
        'Breath and exertion',
        `<p>${damage} HP from elapsed suffocation, ignoring armor.</p>${text.map((line) => `<p>${e(line)}</p>`).join('')}`
      )
    );
  }
  return commitActor(
    actor,
    changes,
    [],
    text.length
      ? () => chat(actor, 'Breath and exertion', text.map((line) => `<p>${e(line)}</p>`).join(''))
      : undefined
  );
}

async function command({ actorUuid, mode, options = {} }, { user, id }) {
  const actor = await authorizedActor(actorUuid, user),
    state = stateFor(actor),
    receipt = `exertion:${id}`;
  if (actor.system.combat.applied.includes(receipt)) return { receipt, alreadyApplied: true };
  if (mode === 'configure') {
    if (!user.isGM || !String(options.ruling ?? '').trim())
      throw new RuleError('The GM must record the unprinted breath/run baseline and its reason.');
    if (
      !positive(options.breathSeconds) ||
      !positive(options.runIntervalSeconds) ||
      !Number.isFinite(options.runStaCost) ||
      options.runStaCost < 0
    )
      throw new RuleError('Enter a positive breath duration/run interval and nonnegative running STA cost.');
    state.baseline = {
      breathSeconds: options.breathSeconds,
      runIntervalSeconds: options.runIntervalSeconds,
      runStaCost: options.runStaCost,
      ruling: String(options.ruling),
      gmId: user.id,
    };
    return commitActor(actor, { [path]: state }, [], () =>
      chat(
        actor,
        'Breath/run baseline',
        `<p>GM ruling: ${e(state.baseline.ruling)}. Base breath ${state.baseline.breathSeconds}s; long running ${state.baseline.runStaCost} STA/${state.baseline.runIntervalSeconds}s. These are table baselines, not printed universal rates.</p>`
      )
    );
  }
  const changes = { 'system.combat.applied': [...actor.system.combat.applied, receipt] },
    sourceId = foundry.utils.randomID();
  let text;
  if (mode === 'holdBreath' || mode === 'startRunning') {
    if (!state.baseline)
      throw new RuleError(
        'The GM must first configure the unprinted base breath duration and long-running cost.'
      );
    const plan = actionPlan(actor, {
      actionKey: mode === 'startRunning' ? 'run' : 'holdBreath',
      full: mode === 'startRunning',
      reaction: mode === 'holdBreath',
      extra: !!options.extra,
      forfeit: !!options.forfeit,
    });
    Object.assign(changes, plan.changes);
    if (mode === 'holdBreath') {
      if (state.breath?.active)
        throw new RuleError('A breath clock is already active; restore air before starting another.');
      if (!['drowning', 'airless'].includes(options.cause))
        throw new RuleError(
          'This breath reserve applies to water/air deprivation, not a wound or chokehold.'
        );
      state.breath = {
        active: true,
        cause: options.cause,
        baselineSeconds: state.baseline.breathSeconds,
        remainingSeconds: state.baseline.breathSeconds,
        startedAt: now(),
        checkedAt: now(),
        sourceId,
        exhaustedAt: null,
      };
      text =
        'Breath clock started using the recorded GM baseline. Killer Whale increases covered breath time by 50%; expiration stops its extra endurance.';
    } else {
      if (state.running?.active) throw new RuleError('A long-running clock is already active.');
      if (game.combat?.started)
        throw new RuleError(
          'Use combat running during combat. This records prolonged running outside combat.'
        );
      const { activeShieldFor } = await import('./magic-shields.js');
      if (activeShieldFor(actor)) throw new RuleError('Active Shield prevents running.');
      state.running = {
        active: true,
        startedAt: now(),
        checkedAt: now(),
        intervalSeconds: state.baseline.runIntervalSeconds,
        staCost: state.baseline.runStaCost,
        fractionalCost: 0,
        paid: 0,
      };
      text =
        'Long-running clock started. Actual elapsed time spends the recorded STA rate; Werewolf Decoction waives its covered time only.';
    }
  } else if (mode === 'restoreAir' || mode === 'stopRunning') {
    // Settle the final interval before ending the source. A failed final card is
    // compensated by the enclosing source snapshot below.
    const before = actor.toObject();
    const previousMessages = new Set([...game.messages].map((message) => message.id));
    try {
      await advanceAlchemyExertion(actor, now());
      const current = stateFor(actor);
      if (mode === 'restoreAir') {
        if (!current.breath?.active) throw new RuleError('No breath clock is active.');
        const cleared = clearBreathSource(
          actor,
          actor.system.effects,
          actor.system.conditions,
          current.breath.sourceId
        );
        current.breath.active = false;
        Object.assign(changes, {
          'system.effects': cleared.effects,
          'system.conditions': cleared.conditions,
        });
        text = 'Air restored; this breath clock and its own suffocation source ended.';
      } else {
        if (!current.running?.active && state.running?.active !== true)
          throw new RuleError('No running clock is active.');
        current.running.active = false;
        text = 'Long running stopped after settling actual elapsed STA.';
      }
      changes[path] = current;
      return await commitActor(actor, changes, [], () =>
        chat(actor, 'Breath and exertion', `<p>${e(text)}</p>`)
      );
    } catch (error) {
      for (const message of [...game.messages]) if (!previousMessages.has(message.id)) await message.delete();
      await actor.update({ system: before.system, flags: before.flags });
      throw error;
    }
  } else throw new RuleError('Unknown breath/exertion action.');
  changes[path] = state;
  return commitActor(actor, changes, [], () => chat(actor, 'Breath and exertion', `<p>${e(text)}</p>`));
}

export async function openAlchemyExertion(actor, mode) {
  owner(actor);
  let content = '',
    options = {};
  if (mode === 'configure') {
    if (!game.user.isGM) throw new RuleError('The GM sets the unprinted baseline.');
    const baseline = stateFor(actor).baseline ?? {};
    content =
      '<p>The source prints modifiers, not a universal breath duration or prolonged-running STA rate. Record your table’s baseline.</p>' +
      input('breathSeconds', 'Base breath duration (seconds)', {
        value: baseline.breathSeconds ?? '',
        min: 1,
      }) +
      input('runIntervalSeconds', 'Running cost interval (seconds)', {
        value: baseline.runIntervalSeconds ?? '',
        min: 1,
      }) +
      input('runStaCost', 'STA per running interval', { value: baseline.runStaCost ?? '', min: 0 }) +
      input('ruling', 'GM ruling and reason', { type: 'text', value: baseline.ruling ?? '' });
  } else if (mode === 'holdBreath')
    content = input('cause', 'Air deprivation', {
      options: { drowning: 'Submerged in water', airless: 'No breathable air' },
    });
  else
    content = `<p>${e({ startRunning: 'Start a long-running clock?', stopRunning: 'Stop prolonged running?', restoreAir: 'Actual air supply restored?' }[mode] ?? mode)}</p>`;
  options = await prompt('Breath and prolonged running', content, { button: 'Record' });
  if (!options) return;
  return runCommand('alchemyExertion', { actorUuid: actor.uuid, mode, options });
}
export function registerAlchemyExertion() {
  registerCommand('alchemyExertion', command);
}
