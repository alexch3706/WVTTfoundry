import { magicDefenseBonus } from './magic-focus-rules.js';
/** Effect execution is separate from book metadata: only completed procedures are enabled. */
import { RuleError, hitLocations } from './rules.js';
import { magicInfo } from './magic-catalog.js';
import { spellEffectPlan } from './magic-effects.js';
import { SYSTEM_ID } from './config.js';
import { addMagicEffect, magicVigor } from './magic-state.js';
import { immuneTo } from './monster-rules.js';
import { dice, commitActor, chat, escapeHTML as e } from './runtime.js';
import { depletionChanges } from './magic-enhancements.js';
import { actorEnhancementBenefits } from './enhancements.js';
import {
  magicRecoveryRules,
  unconditionalMagicModifiers,
  supportedMagicRules,
  magicAttackEffectChance,
  magicIgnitionChance,
} from './magic-effect-hooks.js';
import { executeWorldMagic, worldOperationSupport } from './magic-world-effects.js';
import { removeMagicEffects } from './magic-state.js';
import { magicTokenOrigin } from './magic-regions.js';
import { ongoingOperationSupport, ongoingEffectData, triggerMagicOngoing } from './magic-ongoing.js';

export { BASIC_SPELL_KEYS } from './magic-support.js';
const copy = (x) => foundry.utils.deepClone(x);
const seconds = (duration) => duration?.seconds || (duration?.rounds || 0) * 3;
const handlesExtraHealing = (data) =>
  ['healing-rest', 'miracle-of-lebioda'].includes(data.magicKey) ||
  (data.magicKey === 'blessing-of-healing' && data.choices?.mode === 'critical');
let executionAdapters = {};
export function registerSpellExecutionAdapters(adapters) {
  executionAdapters = { ...executionAdapters, ...adapters };
}

/** Resolve only authoritative context and the book's actual requested dice. */
export async function resolvedSpellPlan(data, { caster, target, row, preview = false }) {
  const values = {
    power: data.power,
    castTotal: data.check.total,
    defenseBonus: magicDefenseBonus(data),
    choices: data.choices ?? {},
    rolls: data.focus?.prolongationDuration ? { duration: data.focus.prolongationDuration } : {},
    defenseTotal: row?.defense?.check?.total ?? 0,
    defenseFumbled: row?.defense?.check?.fumble > 0 ? 1 : 0,
    spellCastingRank: caster.system.skills.spellCasting,
    targetVigor: magicVigor(target.system),
    priorTargets: Math.max(0, data.targets?.findIndex((entry) => entry.tokenUuid === row?.tokenUuid) ?? 0),
  };
  const rolls = [];
  for (let attempt = 0; attempt < 8; attempt++) {
    const plan = spellEffectPlan(data.magicKey, values);
    if (plan.ready) return { plan, rolls };
    if (plan.requirements.some((requirement) => requirement.type !== 'roll'))
      throw new RuleError(
        `This procedure still needs: ${plan.requirements.map((requirement) => requirement.key).join(', ')}.`
      );
    for (const requirement of plan.requirements) {
      const roll = preview ? { total: requirement.min ?? 1 } : await dice(requirement.formula);
      rolls.push(roll);
      values.rolls[requirement.key] = roll.total;
    }
  }
  throw new RuleError('The magic procedure could not resolve its effect dice.');
}

const integratedRules = new Set(
  supportedMagicRules([
    'modifiers',
    'derived',
    'attack',
    'defense',
    'ablation',
    'damage',
    'damageCommit',
    'healing',
    'recovery',
    'condition',
    'casting',
    'castingCommit',
    'effectChance',
  ])
);
// Adenydd has a registered native glide command and landing-damage consumer.
integratedRules.add('glide');

export async function preflightSpell(data, context) {
  if (handlesExtraHealing(data)) {
    const { preflightExtraHealing } = await import('./magic-healing-extra.js');
    return preflightExtraHealing(data, context);
  }
  const { plan } = await resolvedSpellPlan(data, { ...context, preview: true });
  const unsupported = plan.operations.filter((operation) => !basicOperationSupported(operation));
  if (unsupported.length)
    throw new RuleError(
      `This choice needs an unfinished procedure: ${unsupported.map((operation) => operation.rule?.key ?? operation.action ?? operation.type).join(', ')}. No STA has been spent.`
    );
  return plan;
}

export function immediateOperationSupported(operation) {
  if (operation.timing && operation.timing !== 'immediate') return false;
  if (operation.save || operation.trigger || operation.predicate) return false;
  if (operation.rule && !integratedRules.has(operation.rule.key)) return false;
  if (operation.type === 'move') return executionAdapters.supportsMove?.(operation) === true;
  if (worldOperationSupport(operation) && operation.type !== 'zone') return true;
  if (operation.type === 'damage') {
    const hits = operation.onHit
      ? Array.isArray(operation.onHit)
        ? operation.onHit
        : [operation.onHit]
      : [];
    return (
      !operation.fromItem &&
      !operation.piercingLine &&
      !operation.onPenetration &&
      ['normal', 'ignore', undefined].includes(operation.armor) &&
      hits.every((child) => child.type === 'condition' && immediateOperationSupported(child))
    );
  }
  if (operation.type === 'modifier')
    return (
      !operation.traits &&
      !operation.minimumOriginalSkillRank &&
      !operation.usesPerDay &&
      !operation.allRollsBonus
    );
  if (operation.type === 'condition') return !operation.cause && !operation.requiresWater;
  if (operation.type === 'resource')
    return (
      (!operation.temporary || (operation.resource === 'luck' && operation.duration?.until === 'spent')) &&
      !operation.retainPreviousValue &&
      ['add', 'set', undefined].includes(operation.mode)
    );
  if (operation.type === 'heal') return !operation.requiresCompletedRest;
  return false;
}

export function basicOperationSupported(operation) {
  // The ongoing helper can resolve a supplied escape event; the live restraint
  // still needs its durability, attack targeting and escape controls.
  if (operation.type === 'shield' && (operation.hp || operation.escape || operation.breakFree))
    return executionAdapters.supportsRestraint?.(operation) === true;
  if (operation.type === 'zone')
    return (
      executionAdapters.supportsZone?.(operation) === true ||
      (['circle', 'rectangle', 'cone', 'line'].includes(operation.shape?.shape) &&
        operation.operations?.length > 0 &&
        operation.operations.every(
          (child) =>
            child.target !== 'caster' &&
            ongoingOperationSupport(child, { supportsImmediate: immediateOperationSupported })
        ))
    );
  if (
    operation.rule &&
    !integratedRules.has(operation.rule.key) &&
    !['mentalRecovery', 'illnessRecovery', 'repeatMagicDefense', 'activeActions'].includes(operation.rule.key)
  )
    return false;
  return (
    immediateOperationSupported(operation) ||
    ongoingOperationSupport(operation, { supportsImmediate: immediateOperationSupported })
  );
}

/** Per-target application; source receipts avoid duplicating caster buffs across area targets. */
export async function executeBasicSpell({
  data,
  row,
  caster,
  target,
  message,
  receipt,
  effectFor,
  damageCard,
  finish,
  operationsOverride,
  returnTransaction = false,
}) {
  if (!operationsOverride && handlesExtraHealing(data)) {
    const { executeExtraHealing } = await import('./magic-healing-extra.js');
    return executeExtraHealing({
      data,
      row,
      caster,
      target,
      message,
      receipt,
      effectFor,
      finish,
      returnTransaction,
    });
  }
  const { plan, rolls } = operationsOverride
    ? { plan: { operations: operationsOverride, duration: data.magic.duration }, rolls: [] }
    : await resolvedSpellPlan(data, { caster, target, row });
  for (const operation of plan.operations)
    if (!basicOperationSupported(operation))
      throw new RuleError('This magical effect still requires an additional procedure.');
  const plans = new Map(),
    cards = [],
    worldResults = [],
    scheduledEffects = [],
    initialResults = [],
    restraintResults = [];
  const sourceToken = await foundry.utils.fromUuid(data.tokenUuid);
  const affectedToken = row?.tokenUuid ? await foundry.utils.fromUuid(row.tokenUuid) : sourceToken;
  const getPlan = (actor) => {
    let entry = plans.get(actor.uuid);
    if (!entry) {
      entry = {
        actor,
        changes: {},
        items: [],
        before: copy(actor._source?.system ?? actor.system.toObject()),
        state: copy(actor.system.toObject()),
      };
      plans.set(actor.uuid, entry);
    }
    return entry;
  };
  const rootPlan = getPlan(target);
  rootPlan.changes['system.combat.applied'] = [...target.system.combat.applied, receipt];
  const pendingConditions = [];
  try {
    for (const [index, operation] of plan.operations.entries()) {
      const actor = operation.target === 'caster' ? caster : target,
        entry = getPlan(actor);
      const opReceipt = `magic-op:${data.executionId ?? data.castId}:${index}:${actor.uuid}`;
      if (actor.system.combat.applied.includes(opReceipt)) continue;
      entry.changes['system.combat.applied'] = [
        ...(entry.changes['system.combat.applied'] ?? actor.system.combat.applied),
        opReceipt,
      ];
      const duration = seconds(operation.duration),
        makeEffect = (details) =>
          effectFor(data, {
            expires: duration ? game.time.worldTime + duration : 0,
            ...details,
            magic: { operation: copy(operation), ...(details?.magic ?? {}) },
          });
      if (operation.type === 'zone') {
        const createZone =
          executionAdapters.supportsZone?.(operation) === true
            ? executionAdapters.createSpecialZone
            : executionAdapters.createZone;
        if (!createZone) throw new RuleError('The native continuing-area adapter has not been registered.');
        const existing = [...sourceToken.parent.regions].find(
          (region) =>
            region.flags?.[SYSTEM_ID]?.magicArea?.castId === data.castId &&
            region.flags?.[SYSTEM_ID]?.magicArea?.operationIndex === index
        );
        if (!existing)
          worldResults.push(
            await createZone(operation, {
              data,
              row,
              caster,
              target: actor,
              sourceToken,
              operationIndex: index,
              message,
            })
          );
      } else if (operation.type === 'shield' && executionAdapters.supportsRestraint?.(operation)) {
        if (!executionAdapters.createRestraint || !executionAdapters.armRestraint)
          throw new RuleError('The complete physical restraint adapter is unavailable.');
        const grapple = entry.state.effects.find(
          (effect) => effect.magic?.castId === data.castId && effect.conditions?.includes('grappled')
        );
        if (!grapple && immuneTo(entry.state, 'grappled')) continue;
        if (!grapple) throw new RuleError('The restraint needs its actual source-linked grapple effect.');
        const result = await executionAdapters.createRestraint(operation, {
          data,
          row,
          caster,
          target: actor,
          sourceToken,
          message,
          effectId: grapple.id,
        });
        worldResults.push(result);
        restraintResults.push(result);
      } else if (operation.type === 'move' && executionAdapters.supportsMove?.(operation)) {
        if (!executionAdapters.executeMove)
          throw new RuleError('The native movement executor is unavailable.');
        worldResults.push(
          await executionAdapters.executeMove(operation, {
            data,
            row,
            caster,
            target: actor,
            sourceToken,
            affectedToken,
            operationIndex: index,
            message,
          })
        );
      } else if (ongoingOperationSupport(operation, { supportsImmediate: immediateOperationSupported })) {
        const scheduled = ongoingEffectData([operation], {
          caster,
          target: actor,
          castId: data.castId,
          castTotal: data.check.total,
          focus: copy(data.focus ?? null),
          sourceMagic: data.magic,
          duration: operation.duration,
          scene: sourceToken.parent,
          effectId: foundry.utils.randomID(),
          time: game.time.worldTime,
          initialCast: data,
          oneShot: !!operation.save && (!operation.timing || operation.timing === 'immediate'),
          tokenUuid: data.tokenUuid,
          messageUuid: message.uuid,
          point: data.area?.placement,
        });
        scheduled.key = data.name;
        Object.assign(scheduled.magic, { tokenUuid: data.tokenUuid, messageUuid: message.uuid });
        Object.assign(entry.state, addMagicEffect(entry.state, scheduled));
        entry.changes['system.effects'] = entry.state.effects;
        scheduledEffects.push({ actor, effectId: scheduled.id });
      } else if (worldOperationSupport(operation)) {
        const result = await executeWorldMagic(operation, {
          caster,
          target: actor,
          targets: [target],
          sourceMagic: { ...data.magic, name: data.name },
          castId: data.castId,
          castTotal: data.check.total,
          duration: operation.duration,
          scene: sourceToken.parent,
          casterToken: sourceToken,
          point: data.points?.[operation.point] ?? data.area?.placement ?? magicTokenOrigin(affectedToken),
          choices: data.choices,
          resolveUuid: foundry.utils.fromUuid,
          rollFormula: dice,
          postMessage: (source) =>
            ChatMessage.create({
              ...source,
              flags: {
                ...source.flags,
                [SYSTEM_ID]: {
                  ...source.flags?.[SYSTEM_ID],
                  parentMagicMessage: message.uuid,
                  parentTargetUuid: row?.tokenUuid ?? '',
                },
              },
            }),
        });
        worldResults.push(result);
      } else if (operation.type === 'damage') {
        const modified = {
          ...data,
          resolved: {
            ...data.resolved,
            damageFormula: operation.formula,
            damageType: operation.damageType,
            location: operation.location === 'random' ? '' : operation.location,
          },
          magic: {
            ...data.magic,
            effect: { ...data.magic.effect, physicalCritical: !!operation.physicalCritical },
          },
          operationProperties: {
            bypassArmor: operation.armor === 'ignore',
            ignoreShield: operation.shield === 'ignore',
            ignoreLocationMultiplier: operation.location === 'none',
            element: operation.element ?? data.element,
            damageSource: operation.damageSource,
          },
          operationIndex: data.executionId ? `${data.executionId}:${index}` : index,
        };
        const card = await damageCard(caster, actor, modified, row);
        cards.push(card);
        for (const hit of operation.onHit
          ? Array.isArray(operation.onHit)
            ? operation.onHit
            : [operation.onHit]
          : []) {
          if (immuneTo(entry.state, hit.condition)) continue;
          let chance = magicAttackEffectChance(caster.system, hit.condition, hit.chance ?? 100, {
            spell: true,
            castingRules: data.castingRules,
          }).chance;
          if (hit.condition === 'bleeding' && hit.chance !== undefined)
            chance = Math.max(0, chance - actorEnhancementBenefits(actor.items).bleedingReduction);
          if (hit.condition === 'fire') {
            if ((hit.chance ?? 100) > 0 && data.ley?.ignitionChance === 100) chance = 100;
            chance = magicIgnitionChance(entry.state, chance, { separateAttack: true }).chance;
          }
          if (chance < 100) {
            const rolled = await dice('1d100');
            rolls.push(rolled);
            if (rolled.total > chance) continue;
          }
          pendingConditions.push({
            card,
            condition: hit.condition,
            effect: makeEffect({
              conditions: [hit.condition],
              magic: { operation: copy(hit), persistsAfterSource: hit.condition === 'fire' },
            }),
          });
        }
      } else if (operation.type === 'condition') {
        const condition = operation.condition;
        if (operation.action === 'add' && immuneTo(entry.state, condition)) continue;
        let chance = magicAttackEffectChance(caster.system, condition, operation.chance, {
          spell: true,
          castingRules: data.castingRules,
        }).chance;
        if (condition === 'bleeding')
          chance = Math.max(0, chance - actorEnhancementBenefits(actor.items).bleedingReduction);
        if (condition === 'fire') {
          if ((operation.chance ?? 100) > 0 && data.ley?.ignitionChance === 100) chance = 100;
          chance = magicIgnitionChance(entry.state, chance, { separateAttack: true }).chance;
        }
        if (chance < 100) {
          const roll = await dice('1d100');
          rolls.push(roll);
          if (roll.total > chance) continue;
        }
        if (operation.action === 'remove') {
          entry.state.conditions = entry.state.conditions.filter((key) => key !== condition);
          entry.changes['system.conditions'] = entry.state.conditions;
          continue;
        }
        const effect = makeEffect({
          conditions: [condition],
          magic: { persistsAfterSource: condition === 'fire' && data.magicKey !== 'eternal-judgement' },
        });
        if (cards.length && actor.uuid === target.uuid)
          pendingConditions.push({ card: cards.at(-1), condition, effect });
        else {
          Object.assign(entry.state, addMagicEffect(entry.state, effect));
          entry.changes['system.effects'] = entry.state.effects;
          entry.changes['system.conditions'] = entry.state.conditions;
        }
      } else if (operation.type === 'modifier') {
        const effect = makeEffect({
          modifiers: unconditionalMagicModifiers(operation),
          notes: operation.hiddenFromTarget
            ? 'Discovery: told by someone, or Awareness vs DC16 when seeing a reflection.'
            : '',
        });
        Object.assign(entry.state, addMagicEffect(entry.state, effect));
        entry.changes['system.effects'] = entry.state.effects;
      } else if (operation.type === 'resource' || operation.type === 'heal') {
        const resource = operation.resource ?? 'hp';
        if (!['hp', 'sta', 'luck'].includes(resource)) throw new RuleError('Unsupported magical resource.');
        let amount = operation.amount;
        if (typeof amount === 'string' && amount !== 'maximum') {
          const negative = amount.startsWith('-'),
            roll = await dice(negative ? amount.slice(1) : amount);
          rolls.push(roll);
          amount = roll.total * (negative ? -1 : 1);
        }
        const field = `system.${resource}.value`,
          before = entry.changes[field] ?? actor.system[resource].value;
        if (operation.type === 'heal') {
          if (actor.system.conditions.includes('dead')) continue;
          if (!magicRecoveryRules(entry.state, { source: 'magical' }).hpAllowed) continue;
          entry.changes[field] =
            amount === 'maximum'
              ? actor.system[resource].max
              : Math.min(actor.system[resource].max, before + amount);
        } else if (resource !== 'sta' || !actor.system.traits.infiniteStamina)
          entry.changes[field] = operation.mode === 'set' ? amount : before + amount;
        if (entry.changes[field] < before && ['hp', 'sta'].includes(resource)) {
          const awake = removeMagicEffects(
            entry.state,
            (effect) => effect.magic?.sleeping || effect.magic?.key === 'axii'
          );
          entry.state.effects = awake.effects;
          entry.state.conditions = awake.conditions;
          entry.changes['system.effects'] = awake.effects;
          entry.changes['system.conditions'] = awake.conditions;
        }
        if (resource === 'hp' && entry.changes[field] <= 0)
          entry.changes['system.pendingDeathSaves'] = actor.system.pendingDeathSaves + 1;
        if (resource === 'sta' && entry.changes[field] <= 0)
          entry.changes['system.conditions'] = [
            ...new Set([
              ...(entry.changes['system.conditions'] ?? actor.system.conditions),
              'stunned',
              'unconscious',
            ]),
          ];
      }
    }
    if (data.magic.duration.maintenance !== 'none' || (worldResults.length && seconds(plan.duration) > 0)) {
      const entry = getPlan(caster);
      const owned = entry.state.effects.find(
        (effect) => effect.magic?.castId === data.castId && effect.magic?.casterEffect
      );
      if (
        !owned &&
        !caster.system.effects.some(
          (effect) => effect.magic?.castId === data.castId && effect.magic?.casterEffect
        )
      ) {
        const marker = effectFor(data, {
          expires: seconds(plan.duration) ? game.time.worldTime + seconds(plan.duration) : 0,
          magic: { casterEffect: true, worldReceipts: worldResults.map((result) => result.receipt) },
        });
        entry.state.effects.push(marker);
        entry.changes['system.effects'] = entry.state.effects;
      }
    }
    if (pendingConditions.length && cards.length) {
      for (const card of [...new Set(pendingConditions.map((entry) => entry.card))]) {
        const conditionsForCard = pendingConditions.filter((entry) => entry.card === card),
          packet = card.flags[SYSTEM_ID];
        if (packet.summary.some((result) => result.afterShield > 0 && !result.immune)) {
          const state = { effects: [], conditions: target.system.conditions };
          for (const pending of conditionsForCard)
            Object.assign(state, addMagicEffect(state, pending.effect));
          await card.update({
            [`flags.${SYSTEM_ID}.conditions`]: [
              ...(packet.conditions ?? []),
              ...conditionsForCard.map((entry) => entry.condition),
            ],
            [`flags.${SYSTEM_ID}.effects`]: [...(packet.effects ?? []), ...state.effects],
          });
        }
      }
    }
    rolls.push(...(await depletionChanges(target, data, row, rootPlan.changes)));
    const entries = [...plans.values()];
    const commit = async (index) =>
      index === entries.length
        ? (async () => {
            for (const result of restraintResults) await executionAdapters.armRestraint(result.receipt);
            for (const result of worldResults) await result.afterCommit?.();
            for (const scheduled of scheduledEffects)
              initialResults.push(
                await triggerMagicOngoing(scheduled.actor, {
                  id: `cast:${data.castId}:${scheduled.effectId}`,
                  kind: 'cast',
                  actorUuid: scheduled.actor.uuid,
                  tokenUuid: row?.tokenUuid,
                  effectId: scheduled.effectId,
                  cycle: data.castRound || `time:${game.time.worldTime}`,
                })
              );
            if (rolls.length)
              cards.push(
                await chat(caster, data.name, `<p>${e(data.name)}: effect dice resolved.</p>`, { rolls })
              );
            return finish?.({
              pendingGM: worldResults.some((result) => result.status === 'pendingGM'),
              receipts: worldResults.map((result) => result.receipt),
            });
          })()
        : commitActor(entries[index].actor, entries[index].changes, entries[index].items, () =>
            commit(index + 1)
          );
    await commit(0);
  } catch (error) {
    for (const result of initialResults.reverse()) await result.rollback();
    for (const result of worldResults.reverse()) await result.rollback();
    // Nested initial-cast procedures snapshot the installed effect. Restore the outer
    // pre-cast actor states last, after unwinding those nested receipts.
    for (const entry of [...plans.values()].reverse()) await entry.actor.update({ system: entry.before });
    for (const card of cards) await card.delete();
    throw error;
  }
  if (returnTransaction)
    return {
      status: worldResults.some((result) => result.status === 'pendingGM') ? 'pendingGM' : 'applied',
      receipt: { castId: data.castId, messageUuids: cards.map((card) => card.uuid) },
      rollback: async () => {
        for (const result of [...initialResults].reverse()) await result.rollback();
        for (const result of [...worldResults].reverse()) await result.rollback();
        for (const entry of [...plans.values()].reverse()) await entry.actor.update({ system: entry.before });
        for (const card of cards) await card.delete();
      },
    };
  return cards[0] ?? message;
}
