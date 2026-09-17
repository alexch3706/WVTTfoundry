/** Core pp.110, 113, 173–174; A Tome of Chaos p.95.
 * These procedures use the existing critical-wound cards and treatment rules.
 */
import { RuleError, derivedStats } from './rules.js';
import { spellEffectPlan } from './magic-effects.js';
import { addMagicEffect, removeMagicEffects } from './magic-state.js';
import { magicRecoveryRules } from './magic-effect-hooks.js';
import { chat, commitActor, escapeHTML as e } from './runtime.js';
import { SYSTEM_ID } from './config.js';
import { lastHopeLocked } from './alchemy-rules.js';

const clone = (value) => foundry.utils.deepClone(value);
const woundData = (item) => item.system.wound.toObject?.() ?? item.system.wound;
const now = () => Number(game.time.worldTime);
const woundFingerprint = (item) => JSON.stringify(woundData(item));
const fullyRestored = (wound) =>
  wound.treatment === 'healed' && !wound.permanent && !(wound.key === 'complex-4' && wound.extraResult > 0);

export function handlesExtraHealing(data) {
  return (
    ['healing-rest', 'miracle-of-lebioda'].includes(data.magicKey) ||
    (data.magicKey === 'blessing-of-healing' && data.choices?.mode === 'critical')
  );
}

/** "Living" excludes a corpse and explicitly identified undead/constructed actors.
 * HP <= 0 by itself is Death State, which is still alive until a failed Death save.
 */
export function livingHealingTarget(actor) {
  const state = actor.system;
  return (
    !state.conditions.includes('dead') &&
    !['undead', 'construct', 'specter', 'object'].includes(state.category) &&
    !['living-armor', 'corpse-amalgam'].includes(state.bestiary?.species) &&
    !state.effects.some((effect) => effect.magic?.rule?.key === 'reanimated-corpse') &&
    !actor.items.some(
      (item) => item.type === 'wound' && item.system.wound.fatal && item.system.wound.treatment !== 'healed'
    )
  );
}

function selectedWound(data, target, { current = false } = {}) {
  const selected = target.items.find((item) => item.uuid === data.choices?.wound);
  if (selected?.type !== 'wound')
    throw new RuleError('Select a critical wound belonging to this healing target.');
  if (current && data.choices?.healingWoundExpected !== woundFingerprint(selected))
    throw new RuleError(
      'The selected wound changed after casting. Review it before applying the invocation.'
    );
  return selected;
}

export async function preflightExtraHealing(data, { caster, target }) {
  const { magicalWoundTreatment } = await import('./wound-actions.js');
  const plan = spellEffectPlan(data.magicKey, {
    power: data.power,
    choices: data.choices ?? {},
    castTotal: data.check.total,
    spellCastingRank: caster.system.skills.spellCasting,
  });
  if (!plan.ready) throw new RuleError('Complete this healing invocation’s choices before casting.');
  if (!livingHealingTarget(target)) throw new RuleError('This invocation requires a living target.');
  if (data.magicKey === 'healing-rest') {
    if (activeHealingRest(target.system)) throw new RuleError('The target is already in a Healing Rest.');
    return plan;
  }
  const item = selectedWound(data, target);
  if (lastHopeLocked(item))
    throw new RuleError(
      'Last Hope requires a Doctor’s Healing Hands reapplication and treatment before this critical wound can heal.'
    );
  if (data.magicKey === 'blessing-of-healing') magicalWoundTreatment(target, item, data.check.total);
  else if (fullyRestored(woundData(item)))
    throw new RuleError('This wound has already healed completely and has no lingering penalty.');
  data.choices.healingWoundExpected = woundFingerprint(item);
  return plan;
}

function healedFields({ erase = false } = {}) {
  return {
    treatment: 'healed',
    daysRemaining: 0,
    recoveryPending: false,
    separateConditions: true,
    turnsTreated: 0,
    ageRounds: 0,
    ...(erase
      ? {
          permanent: false,
          fatal: false,
          extraResult: 0,
          endedConditions: ['bleeding', 'poison', 'suffocating'],
          modifiers: {},
          stabilizedModifiers: {},
          treatedModifiers: {},
          healedModifiers: {},
          bleeding: false,
          poison: false,
          suffocating: false,
          deathSave: false,
          damagePerTurn: 0,
          stabilizedDamagePerTurn: 0,
          stunEvery: 0,
          stabilizedStunEvery: 0,
        }
      : {}),
  };
}

function woundUpdate(item, fields) {
  return {
    _id: item.id,
    ...Object.fromEntries(Object.entries(fields).map(([key, value]) => [`system.wound.${key}`, value])),
  };
}

function projectedWounds(state, items) {
  const updates = new Map(items.map((item) => [item._id, item]));
  return state.items.map((item) => {
    const update = updates.get(item.id);
    return update
      ? {
          ...item,
          wound: {
            ...item.wound,
            ...Object.fromEntries(
              Object.entries(update)
                .filter(([key]) => key.startsWith('system.wound.'))
                .map(([key, value]) => [key.slice('system.wound.'.length), value])
            ),
          },
        }
      : item;
  });
}

/** A real wound/item write, not a reminder or an unspent manual treatment counter. */
export async function executeExtraHealing({
  data,
  caster,
  target,
  receipt,
  effectFor,
  finish,
  message,
  returnTransaction = false,
}) {
  const { actorSnapshot, staminaCapChanges } = await import('./documents.js');
  const { magicalWoundTreatment } = await import('./wound-actions.js');
  if (!handlesExtraHealing(data)) throw new RuleError('Unknown additional healing procedure.');
  if (!livingHealingTarget(target)) throw new RuleError('This invocation requires a living target.');
  const changes = { 'system.combat.applied': [...target.system.combat.applied, receipt] };
  let items = [],
    text;
  if (data.magicKey === 'healing-rest') {
    if (activeHealingRest(target.system)) throw new RuleError('The target is already in a Healing Rest.');
    const effect = effectFor(data, {
      expires: now() + 86400,
      conditions: ['unconscious'],
      magic: { healingRest: { startedAt: now(), endsAt: now() + 86400 }, maintenance: 'none' },
      notes:
        'Healing Rest: a full day of coma. Touch, movement, damage and ordinary recovery do not wake the subject. Completion restores HP and heals treated critical wounds; permanent penalties remain.',
    });
    const state = addMagicEffect(target.system, effect);
    changes['system.effects'] = state.effects;
    changes['system.conditions'] = state.conditions;
    text =
      'The one-day Healing Rest has begun. Recovery occurs only after the full day, while this invocation remains in effect.';
  } else {
    const item = selectedWound(data, target, { current: true });
    if (lastHopeLocked(item))
      throw new RuleError(
        'Last Hope requires a Doctor’s Healing Hands reapplication and treatment before this critical wound can heal.'
      );
    if (data.magicKey === 'blessing-of-healing') {
      const treatment = magicalWoundTreatment(target, item, data.check.total);
      Object.assign(changes, treatment.changes);
      items = treatment.items;
      text = treatment.success
        ? `${treatment.uses}/${treatment.required} successful critical-treatment uses (DC ${treatment.dc}). No HP restored. Each further use requires another casting.`
        : `Spell Casting did not beat DC ${treatment.dc}. No treatment progress or HP restored.`;
    } else {
      if (fullyRestored(woundData(item)))
        throw new RuleError('This wound has no remaining injury or penalty to restore.');
      items = [woundUpdate(item, healedFields({ erase: true }))];
      items[0][`flags.${SYSTEM_ID}.miraculousRestoration`] = {
        castId: data.castId,
        source: 'A Tome of Chaos p.95',
        restoredAt: now(),
        previousWound: clone(woundData(item)),
      };
      Object.assign(changes, staminaCapChanges(target, projectedWounds(actorSnapshot(target), items)));
      text = `${item.name} has been entirely restored, including missing anatomy and permanent penalties. Its healed card remains as history. No HP are restored by this invocation.`;
    }
  }
  const before = clone(target._source.system);
  const beforeItems = items.map((change) => target.items.get(change._id).toObject());
  const cards = [];
  await commitActor(target, changes, items, async () => {
    try {
      cards.push(
        await chat(caster, `${data.name} → ${target.name}`, `<p>${e(text)}</p>`, {
          flags: { kind: 'magic-healing-result', castId: data.castId, actorUuid: target.uuid },
        })
      );
      return await finish?.({ pendingGM: false, receipts: [] });
    } catch (error) {
      for (const card of cards) await card.delete();
      throw error;
    }
  });
  if (returnTransaction)
    return {
      status: 'applied',
      receipt: { castId: data.castId, messageUuids: cards.map((card) => card.uuid) },
      rollback: async () => {
        for (const item of beforeItems)
          await target.items
            .get(item._id)
            .update(
              { system: item.system, flags: item.flags },
              { diff: false, recursive: false, witcherMagicRollback: true }
            );
        await target.update(
          { system: before },
          { diff: false, recursive: false, witcherMagicRollback: true }
        );
        for (const card of cards) await card.delete();
      },
    };
  return cards[0] ?? message;
}

export function activeHealingRest(state) {
  return (state.effects ?? []).find(
    (effect) => effect.magic?.healingRest && !effect.disabled && !effect.magic?.suppressed
  );
}

export function healingRestActionRestriction(state) {
  return activeHealingRest(state)
    ? 'Healing Rest places this subject in a coma for a full day. They cannot act or use ordinary recovery to wake.'
    : '';
}

/** Scheduled completion is combined with the ordinary lifecycle transaction. A
 * dispelled/removed effect never appears here and therefore grants no recovery.
 */
export async function healingRestCompletionPlan(actor, time) {
  const state = actor.system;
  const due = (state.effects ?? []).filter(
    (effect) =>
      effect.magic?.healingRest &&
      Number.isFinite(effect.magic.healingRest.endsAt) &&
      effect.magic.healingRest.endsAt <= time
  );
  if (!due.length)
    return {
      effects: state.effects,
      conditions: state.conditions,
      hpValue: state.hp.value,
      items: [],
      completed: [],
      changes: {},
    };
  const { actorSnapshot, staminaCapChanges } = await import('./documents.js');
  const removed = removeMagicEffects(state, (effect) => due.some((entry) => entry.id === effect.id));
  const living = livingHealingTarget(actor);
  const items = living
    ? actor.items
        .filter(
          (item) =>
            item.type === 'wound' &&
            item.system.wound.treatment === 'treated' &&
            !item.system.wound.fatal &&
            !lastHopeLocked(item)
        )
        .map((item) => woundUpdate(item, healedFields()))
    : [];
  const projected = projectedWounds(actorSnapshot(actor), items);
  const allowed = living && magicRecoveryRules(actorSnapshot(actor), { source: 'magical' }).hpAllowed;
  const maximum = derivedStats(
    { ...actorSnapshot(actor), effects: removed.effects, conditions: removed.conditions },
    projected
  ).hpMax;
  const hpValue = allowed ? Math.max(state.hp.value, maximum) : state.hp.value;
  const changes = staminaCapChanges(actor, projected);
  return {
    effects: removed.effects,
    conditions: removed.conditions,
    hpValue,
    items,
    changes,
    completed: due.map((effect) => ({
      effectId: effect.id,
      castId: effect.magic.castId,
      healedWoundIds: items.map((item) => item._id),
      living,
      hpAllowed: allowed,
    })),
  };
}
