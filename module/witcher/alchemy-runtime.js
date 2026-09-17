/** Authoritative ingestion, blade oils, toxicity and Last Hope procedures. */
import { SYSTEM_ID } from './config.js';
import { registerCraftingRuntime } from './alchemy-crafting-runtime.js';
import { RuleError, beats, derivedStats } from './rules.js';
import { resolveWoundArm } from './wound-rules.js';
import { hexTreatmentModifier } from './magic-hex-rules.js';
import { registerCommand, authorizedActor, runCommand } from './authority.js';
import { resolveFoundryUuid } from '../foundry-compat.js';
import {
  alchemyProfile,
  alchemyKey,
  alchemyEffect,
  activeAlchemy,
  alchemyEffectActive,
  isAlchemyDose,
  toxicityPoison,
  reconcileAlchemyToxicity,
  planAlchemyExpiry,
  oilEligible,
  lastHopeLocked,
  lastHopeState,
} from './alchemy-rules.js';
import {
  owner,
  prompt,
  input,
  manualCheckInput,
  woundArmInput,
  validateManualCheck,
  check,
  checkHTML,
  chat,
  commitActor,
  actionPlan,
  turnIdentity,
  escapeHTML as e,
  errorNotice,
} from './runtime.js';

const clone = (value) => foundry.utils.deepClone(value);
const now = () => Number(game.time.worldTime);
const receiptKey = (id) => `alchemy:${id}`;
const itemFingerprint = (item) =>
  JSON.stringify({
    id: item.id,
    quantity: item.system.quantity,
    carried: item.system.carried,
    profile: alchemyProfile(item)?.key,
  });
const woundFingerprint = (item) => JSON.stringify(item.system.wound.toObject?.() ?? item.system.wound);
const applied = (actor, receipt) => actor.system.combat.applied.includes(receipt);
const recordReceipt = (actor, receipt) => [...actor.system.combat.applied, receipt];
const sourceOf = (item) => item.system.sourceUuid || item._stats?.compendiumSource || item.uuid;
const isPoison = (effect) =>
  effect.alchemy?.poison ||
  effect.conditions?.includes('poison') ||
  effect.magic?.addedConditions?.includes('poison') ||
  ['Black Venom', 'Mutagen Poison', 'Failed Witcher Potion'].includes(effect.key);
function consumptionGuard(actor, target, item, options, user) {
  if (!item || item.type !== 'alchemical' || !alchemyProfile(item))
    throw new RuleError('Choose a supported alchemical item.');
  if (item.system.carried === false || item.system.quantity < 1)
    throw new RuleError('Carry one complete dose before using it.');
  if (options.expected && options.expected !== itemFingerprint(item))
    throw new RuleError('The dose changed while the dialog was open. Reopen it.');
  if (target.system.conditions.includes('dead'))
    throw new RuleError('A dead creature cannot drink an alchemical dose.');
  if (!user.isGM && !target.testUserPermission(user, 'OWNER'))
    throw new RuleError('The GM must approve administering this dose to another user’s actor.');
  if (!actor.testUserPermission(user, 'OWNER')) throw new RuleError('You do not own the dose’s actor.');
}
function checkedAdjudication(profile, target, options, user) {
  const override = {};
  if (
    profile.durationKind === 'unspecified' ||
    (profile.durationKind === 'wound' && target.system.race === 'halfling')
  ) {
    if (
      !user.isGM ||
      !Number.isFinite(options.durationSeconds) ||
      options.durationSeconds <= 0 ||
      !String(options.adjudication ?? '').trim()
    )
      throw new RuleError(
        'The book gives no duration for this case. The GM must record a positive duration and their ruling before consuming it.'
      );
    override.durationSeconds = options.durationSeconds;
  }
  if (profile.toxicityUnspecified) {
    const recorded =
      typeof options.toxicity === 'string' && options.toxicity.trim() === '' ? NaN : Number(options.toxicity);
    if (
      !user.isGM ||
      !Number.isFinite(recorded) ||
      recorded < 0 ||
      !String(options.adjudication ?? '').trim()
    )
      throw new RuleError(
        'Cerebral Elixir has no printed toxicity. The GM must record a toxicity ruling before consuming it.'
      );
    override.toxicity = recorded;
  }
  return override;
}

function poisonNeutralization(state, effects) {
  return {
    effects: effects.filter((effect) => !isPoison(effect) && !toxicityPoison(effect)),
    conditions: (state.conditions ?? []).filter((key) => key !== 'poison'),
  };
}
function removeDoses(state, predicate, time, { forceClear = false } = {}) {
  const removed = state.effects.filter(predicate),
    effects = state.effects.filter((effect) => !removed.includes(effect));
  const result = reconcileAlchemyToxicity(state, effects, { time, forceClear });
  if (
    removed.some((effect) => isPoison(effect) && effect.alchemy?.addedPoison === true) &&
    !result.effects.some((effect) => isPoison(effect) || toxicityPoison(effect))
  )
    result.conditions = result.conditions.filter((condition) => condition !== 'poison');
  return {
    ...result,
    removed,
    hp:
      Number(state.hp.value) -
      removed.reduce((n, effect) => n + Math.max(0, Number(effect.temporaryHp) || 0), 0),
  };
}

async function capProjectedHP(actor, changes) {
  const { actorSnapshot } = await import('./documents.js');
  const state = actorSnapshot(actor),
    effects = changes['system.effects'] ?? state.effects;
  const max = derivedStats({ ...state, effects }, state.items).hpMax;
  const value = changes['system.hp.value'] ?? state.hp.value;
  if (value > max) changes['system.hp.value'] = max;
}

/** Registered command entry point. All rolls, spending, target and chat writes are
 * inside one authority operation; nested commitActor compensates both actors. */
export async function executeAlchemyUse({ actorUuid, targetUuid, itemId, options = {} }, { user, id }) {
  const actor = await authorizedActor(actorUuid, user),
    target = await authorizedActor(targetUuid ?? actorUuid, user);
  const item = actor.items.get(itemId),
    receipt = receiptKey(id);
  if (applied(actor, receipt))
    return (
      game.messages.find((message) => message.flags?.[SYSTEM_ID]?.alchemyReceipt === receipt) ?? {
        receipt,
        alreadyApplied: true,
      }
    );
  consumptionGuard(actor, target, item, options, user);
  const profile = alchemyProfile(item),
    override = checkedAdjudication(profile, target, options, user);
  const plan = actionPlan(actor, {
    actionKey: 'alchemy',
    expectedTurn: options.turn,
    extra: !!options.extra,
    forfeit: !!options.forfeit,
  });
  const changes = { 'system.combat.applied': recordReceipt(target, receipt) },
    sourceChanges = { ...plan.changes, 'system.combat.applied': recordReceipt(actor, receipt) };
  const sourceItems = [{ _id: item.id, 'system.quantity': item.system.quantity - 1 }],
    targetItems = [],
    rolls = [];
  let detail = '',
    effects = clone(target.system.effects),
    conditions = [...target.system.conditions];
  if (profile.kind === 'oil') {
    if (target.uuid !== actor.uuid)
      throw new RuleError('Apply blade oil to a weapon carried by the actor using it.');
    const weapon = actor.items.get(options.weaponId);
    if (!oilEligible(weapon)) throw new RuleError('Choose an equipped, carried slashing or piercing weapon.');
    sourceItems.push({
      _id: weapon.id,
      'system.oil': {
        name: profile.name,
        key: profile.key,
        category: profile.targetCategory,
        expires: now() + 1800,
        sourceUuid: sourceOf(item),
      },
    });
    detail = `${weapon.name}: +5 damage against ${profile.targetCategory} for 30 minutes.`;
  } else {
    if (activeAlchemy(target.system, profile.key) && profile.key !== 'white-honey')
      throw new RuleError(
        'This named alchemical benefit is already active. Let it end before applying another dose.'
      );
    let successful = true;
    if (['potion', 'decoction'].includes(profile.kind) && target.system.race !== 'witcher') {
      validateManualCheck({ manualDice: options.manualDice }, target, { dc: 18, skill: 'endurance' });
      const result = await check(target.skillBase('endurance').total, {
        manualDice: options.manualDice,
        actor: target,
        context: { dc: 18, skill: 'endurance' },
      });
      rolls.push(...result.rolls);
      successful = beats(result.total, 18);
      detail +=
        checkHTML(result) +
        `<p>Non-witcher Endurance DC18: ${successful ? 'resisted.' : 'poisoned; no potion benefit.'}</p>`;
    }
    if (!successful) {
      const poisoned =
        !activeAlchemy(target.system, 'golden-oriole') && !activeAlchemy(target.system, 'mongoose');
      if (poisoned) {
        effects.push({
          id: foundry.utils.randomID(),
          key: 'Failed Witcher Potion',
          expires: 0,
          conditions: ['poison'],
          dc: 15,
          alchemy: {
            key: 'failed-witcher-potion',
            kind: 'condition',
            poison: true,
            sourceUuid: sourceOf(item),
            addedPoison: !conditions.includes('poison'),
          },
        });
        conditions = [...new Set([...conditions, 'poison'])];
      }
    } else if (profile.key === 'white-honey') {
      const result = removeDoses(target.system, isAlchemyDose, now(), { forceClear: true });
      effects = result.effects;
      conditions = result.conditions;
      changes['system.hp.value'] = result.hp;
      detail +=
        'All active alchemical doses and their toxicity ended. Existing unrelated poison is retained.';
    } else {
      const noBenefit = profile.kind === 'elixir' && target.system.race === 'halfling';
      const effect = alchemyEffect(
        { ...profile, ...override },
        {
          id: foundry.utils.randomID(),
          now: now(),
          sourceUuid: sourceOf(item),
          noBenefit,
          durationSeconds: override.durationSeconds,
        }
      );
      if (options.adjudication) effect.alchemy.adjudication = String(options.adjudication);
      if (!noBenefit && profile.key === 'last-hope') {
        const wound = target.items.get(options.woundId);
        if (
          wound?.type !== 'wound' ||
          wound.system.wound.fatal ||
          !['untreated', 'stabilized'].includes(wound.system.wound.treatment) ||
          lastHopeLocked(wound)
        )
          throw new RuleError(
            'Choose one untreated or stabilized, nonfatal critical wound belonging to the drinker.'
          );
        if (options.woundExpected && woundFingerprint(wound) !== options.woundExpected)
          throw new RuleError('The selected wound changed. Reopen the dose dialog.');
        effect.alchemy.woundId = wound.id;
        targetItems.push({
          _id: wound.id,
          'system.wound.treatment': 'treated',
          'system.wound.turnsTreated': 0,
          'system.wound.ageRounds': 0,
          'system.wound.daysTotal': 0,
          'system.wound.daysRemaining': 0,
          'system.wound.recoveryPending': true,
          'system.wound.separateConditions': true,
          [`flags.${SYSTEM_ID}.lastHope`]: {
            phase: 'locked',
            effectId: effect.id,
            consumedAt: now(),
            source: 'A Tome of Chaos p.116',
          },
        });
        detail +=
          'The chosen critical wound is treated. It cannot heal until a Doctor reapplies it with Healing Hands DC24 and treats it again with Healing Hands.';
      }
      if (!noBenefit && profile.key === 'full-moon') changes['system.hp.value'] = target.system.hp.value + 30;
      if (!noBenefit && profile.key === 'golden-oriole') {
        const cleared = poisonNeutralization(target.system, effects);
        effects = cleared.effects;
        conditions = cleared.conditions;
        for (const wound of target.items.filter(
          (entry) => entry.type === 'wound' && entry.system.wound.poison
        ))
          targetItems.push({
            _id: wound.id,
            'system.wound.endedConditions': [
              ...new Set([...(wound.system.wound.endedConditions ?? []), 'poison']),
            ],
          });
      }
      if (!noBenefit && profile.key === 'noon-wraith-decoction')
        conditions = conditions.filter((key) => !['stunned', 'blinded', 'prone'].includes(key));
      if (!noBenefit && profile.key === 'cerebral-elixir') {
        const besEffects = [];
        for (const entry of effects) {
          const source = entry.magic?.spiritUuid || entry.magic?.casterUuid;
          const possessor = source ? await resolveFoundryUuid(source) : null;
          if (
            (entry.magic?.key === 'spirit-possession' || entry.possession?.active) &&
            (entry.magic?.species === 'bes' ||
              entry.possession?.species === 'bes' ||
              possessor?.system?.bestiary?.species === 'bes')
          )
            besEffects.push(entry);
        }
        effects = effects.filter((entry) => !besEffects.includes(entry));
        const remaining = effects.flatMap((entry) => entry.conditions ?? entry.magic?.addedConditions ?? []);
        const removed = new Set(
          besEffects.flatMap((entry) => entry.magic?.addedConditions ?? entry.conditions ?? [])
        );
        conditions = conditions.filter((key) => !removed.has(key) || remaining.includes(key));
        detail += `Bes possession protection lasts 24 hours; ${besEffects.length} recorded Bes possession effect(s) expelled.`;
      }
      effects.push(effect);
      if (noBenefit) detail += 'Halfling: no elixir benefit, but the full toxicity applies.';
      if (profile.key === 'anabolic-steroids' && !noBenefit)
        detail +=
          'Maximum HP +10 (no current HP healed), Endurance/Physique +2 for 10 minutes; aggression lasts one hour.';
    }
    const result = reconcileAlchemyToxicity(
      { ...target.system, effects: target.system.effects, conditions },
      effects,
      {
        time: now(),
        id: foundry.utils.randomID(),
        latestId: effects.filter(isAlchemyDose).at(-1)?.id,
        forceClear: profile.key === 'white-honey' && successful,
      }
    );
    Object.assign(changes, {
      'system.effects': result.effects,
      'system.conditions': result.conditions,
      'system.toxicity.value': result.toxicity,
    });
  }
  if (targetItems.length) {
    const { actorSnapshot, staminaCapChanges } = await import('./documents.js');
    const state = actorSnapshot(target),
      projected = state.items.map((entry) => {
        const update = targetItems.find((change) => change._id === entry.id);
        if (!update) return entry;
        const wound = { ...entry.wound };
        for (const [key, value] of Object.entries(update))
          if (key.startsWith('system.wound.')) wound[key.slice(13)] = value;
        return { ...entry, wound };
      });
    Object.assign(changes, staminaCapChanges(target, projected));
  }
  if (profile.key === 'white-honey') await capProjectedHP(target, changes);
  const publish = () =>
    chat(
      actor,
      `${profile.name} → ${target.name}`,
      `<p>${e(profile.source)}</p><p>${e(item.system.effectText ?? '')}</p>${detail.includes('<') ? detail : `<p>${e(detail)}</p>`}`,
      {
        rolls,
        flags: {
          kind: 'alchemyUse',
          alchemyReceipt: receipt,
          alchemyKey: profile.key,
          actorUuid: actor.uuid,
          targetUuid: target.uuid,
        },
      }
    );
  if (actor.uuid === target.uuid)
    return commitActor(actor, { ...sourceChanges, ...changes }, [...sourceItems, ...targetItems], publish);
  return commitActor(actor, sourceChanges, sourceItems, () =>
    commitActor(target, changes, targetItems, publish)
  );
}

/** Entry point used by the inventory sheet; validation is repeated by the GM. */
export async function useAlchemy(actor, item) {
  owner(actor);
  const profile = alchemyProfile(item);
  if (!profile) throw new RuleError('No supported alchemical profile.');
  const target = profile.kind === 'oil' ? actor : ([...(game.user.targets ?? [])][0]?.actor ?? actor);
  const needsGM =
    !target.isOwner ||
    profile.durationKind === 'unspecified' ||
    profile.toxicityUnspecified ||
    (profile.key === 'last-hope' && target.system.race === 'halfling');
  let content = `<p>${e(profile.name)} → ${e(target.name)}. ${e(profile.source)}. One dose and one action.</p>`;
  if (profile.kind === 'oil')
    content += input('weaponId', 'Blade', {
      options: Object.fromEntries(actor.items.filter(oilEligible).map((weapon) => [weapon.id, weapon.name])),
    });
  if (profile.key === 'last-hope' && target.system.race !== 'halfling')
    content += input('woundId', 'Critical wound', {
      options: Object.fromEntries(
        target.items
          .filter(
            (wound) =>
              wound.type === 'wound' &&
              !wound.system.wound.fatal &&
              ['untreated', 'stabilized'].includes(wound.system.wound.treatment) &&
              !lastHopeLocked(wound)
          )
          .map((wound) => [wound.id, wound.name])
      ),
    });
  if (['potion', 'decoction'].includes(profile.kind) && target.system.race !== 'witcher')
    content += '<p>Non-witcher: Endurance DC18 before receiving any potion effect.</p>' + manualCheckInput();
  if (
    profile.durationKind === 'unspecified' ||
    (profile.key === 'last-hope' && target.system.race === 'halfling')
  )
    content += input('durationSeconds', 'GM duration ruling (seconds)', { value: '', min: 1 });
  if (profile.toxicityUnspecified)
    content += input('toxicity', 'GM toxicity ruling (unprinted; enter 0 explicitly if chosen)', {
      value: '',
      type: 'text',
    });
  if (
    needsGM &&
    (profile.durationKind === 'unspecified' ||
      profile.toxicityUnspecified ||
      target.system.race === 'halfling')
  )
    content += input('adjudication', 'GM ruling and reason', { type: 'text' });
  content +=
    input('extra', 'Extra action (3 STA, −3)', { type: 'checkbox' }) +
    input('forfeit', 'Forfeit remaining strikes', { type: 'checkbox' });
  const options = await prompt('Use alchemical item', content, {
    button: needsGM && !game.user.isGM ? 'Request GM application' : 'Apply',
  });
  if (!options) return;
  options.expected = itemFingerprint(item);
  options.turn = turnIdentity();
  if (options.woundId) options.woundExpected = woundFingerprint(target.items.get(options.woundId));
  const payload = { actorUuid: actor.uuid, targetUuid: target.uuid, itemId: item.id, options };
  if (needsGM && !game.user.isGM)
    return chat(
      actor,
      `${profile.name}: GM application`,
      `<p>${e(profile.name)} → ${e(target.name)}. No dose or action spent yet.</p>` +
        `<p>Requested ruling: ${e(options.adjudication ?? 'none')}; duration ${e(options.durationSeconds ?? 'printed')} seconds; toxicity ${e(options.toxicity ?? 'printed')}.</p>` +
        '<button data-alchemy-approve>Review and apply dose (GM)</button>',
      { flags: { kind: 'alchemyApproval', payload, requestAuthor: game.user.id } }
    );
  return runCommand('alchemyUse', payload, { label: `${actor.name}: ${profile.name}` });
}

export async function expireAlchemy(actor, time = now()) {
  const plan = planAlchemyExpiry(actor.system, time);
  if (
    !actor.system.effects.some(
      (effect) => alchemyKey(effect) || isAlchemyDose(effect) || toxicityPoison(effect)
    )
  )
    return plan;
  if (
    !plan.removed.length &&
    JSON.stringify(plan.effects) === JSON.stringify(actor.system.effects) &&
    plan.toxicity === (actor.system.toxicity?.value ?? 0)
  )
    return plan;
  await capProjectedHP(actor, plan.changes);
  await commitActor(actor, plan.changes);
  return plan;
}

/** Called instead of generic poison recovery for an actual alchemical source. */
export async function recoverAlchemyPoison(
  actor,
  options = {},
  { user = game.user, id = foundry.utils.randomID() } = {}
) {
  const receipt = receiptKey(id);
  if (applied(actor, receipt)) return { receipt, alreadyApplied: true };
  const candidates = actor.system.effects.filter(
    (effect) =>
      toxicityPoison(effect) || ['failed-witcher-potion', 'black-blood-poison'].includes(effect.alchemy?.key)
  );
  const source = options.effectId
    ? candidates.find((effect) => effect.id === options.effectId)
    : candidates[0];
  if (!source) throw new RuleError('Choose an active alchemical poison source.');
  const dc =
    source.alchemy?.key === 'black-blood-poison'
      ? 20
      : source.alchemy?.key === 'failed-witcher-potion'
        ? 15
        : 18;
  const plan = actionPlan(actor, {
    actionKey: 'endCondition',
    extra: !!options.extra,
    forfeit: !!options.forfeit,
  });
  validateManualCheck({ manualDice: options.manualDice }, actor, { skill: 'endurance', dc });
  const result = await check(actor.skillBase('endurance', { modifier: plan.modifier }).total, {
    manualDice: options.manualDice,
    actor,
    context: { skill: 'endurance', dc },
  });
  const changes = { ...plan.changes, 'system.combat.applied': recordReceipt(actor, receipt) };
  if (beats(result.total, dc)) {
    const latest = source.alchemy?.lastDoseId ?? actor.system.effects.filter(isAlchemyDose).at(-1)?.id;
    const removed = removeDoses(
      actor.system,
      (effect) =>
        effect.id === source.id ||
        (source.alchemy?.key === 'black-blood-poison' && effect.alchemy?.key === 'black-blood-poison') ||
        (toxicityPoison(source) && effect.id === latest),
      now(),
      { forceClear: toxicityPoison(source) }
    );
    Object.assign(changes, {
      'system.effects': removed.effects,
      'system.conditions': removed.conditions,
      'system.toxicity.value': removed.toxicity,
      'system.hp.value': removed.hp,
    });
    if (!removed.effects.some(isPoison) && source.alchemy?.addedPoison !== false)
      changes['system.conditions'] = changes['system.conditions'].filter((key) => key !== 'poison');
    await capProjectedHP(actor, changes);
  }
  return commitActor(actor, changes, [], () =>
    chat(
      actor,
      'Alchemy poison recovery',
      checkHTML(result) +
        `<p>Endurance DC${dc}: ${beats(result.total, dc) ? 'recovered; the last potion’s effects also end for toxicity poisoning.' : 'failed.'}</p>`,
      { rolls: result.rolls, flags: { alchemyReceipt: receipt } }
    )
  );
}

export async function endAlchemyEffect(actor, effectId) {
  return runCommand(
    'alchemyEnd',
    { actorUuid: actor.uuid, effectId },
    { label: `${actor.name}: end alchemical effect` }
  );
}

export async function reapplyLastHope(
  { actorUuid, itemId, healerUuid, expected, options = {} },
  { user, id }
) {
  const actor = await authorizedActor(actorUuid, user),
    healer = await authorizedActor(healerUuid, user),
    item = actor.items.get(itemId),
    receipt = receiptKey(id);
  if (applied(actor, receipt)) return { receipt, alreadyApplied: true };
  if (
    item?.type !== 'wound' ||
    lastHopeState(item)?.phase !== 'locked' ||
    (expected && expected !== woundFingerprint(item))
  )
    throw new RuleError('Choose the unchanged critical wound treated by Last Hope.');
  if (
    !healer.system.professionRanks.healingHands &&
    !healer.system.customSkills.some((skill) => skill.id === 'healingHands' || skill.name === 'Healing Hands')
  )
    throw new RuleError('Reapplying Last Hope requires a Doctor’s Healing Hands.');
  if (!Number.isFinite(Number(options.modifier ?? 0)))
    throw new RuleError('Enter a finite treatment modifier.');
  const plan = actionPlan(healer, {
    actionKey: 'medical',
    expectedTurn: options.turn,
    extra: !!options.extra,
    forfeit: !!options.forfeit,
  });
  validateManualCheck({ manualDice: options.manualDice }, healer, { dc: 24, skill: 'healingHands' });
  const arm = resolveWoundArm(healer.system, [...healer.items], options.woundArm, 'one');
  const result = await check(
    healer.skillBase('healingHands', {
      stat: 'cra',
      arm,
      modifier:
        plan.modifier + Number(options.modifier ?? 0) + hexTreatmentModifier(actor.system, item.system.wound),
    }).total,
    { manualDice: options.manualDice, actor: healer, context: { dc: 24, skill: 'healingHands' } }
  );
  const success = beats(result.total, 24),
    changes = { 'system.combat.applied': recordReceipt(actor, receipt) },
    items = [];
  if (success) {
    items.push({
      _id: item.id,
      'system.wound.treatment': 'untreated',
      'system.wound.turnsTreated': 0,
      'system.wound.ageRounds': 0,
      'system.wound.daysRemaining': 0,
      'system.wound.daysTotal': 0,
      'system.wound.recoveryPending': false,
      'system.wound.endedConditions': [],
      'system.wound.magicUses': 0,
      [`flags.${SYSTEM_ID}.lastHope`]: {
        ...clone(lastHopeState(item)),
        phase: 'reapplied',
        doctorUuid: healer.uuid,
        reappliedAt: now(),
      },
    });
    const { staminaCapChanges, actorSnapshot } = await import('./documents.js');
    const state = actorSnapshot(actor);
    Object.assign(
      changes,
      staminaCapChanges(
        actor,
        state.items.map((entry) =>
          entry.id === item.id ? { ...entry, wound: { ...entry.wound, treatment: 'untreated' } } : entry
        )
      )
    );
    const removed = removeDoses(actor.system, (effect) => effect.id === lastHopeState(item).effectId, now());
    Object.assign(changes, {
      'system.effects': removed.effects,
      'system.conditions': removed.conditions,
      'system.toxicity.value': removed.toxicity,
    });
  }
  const publish = () =>
    chat(
      healer,
      `Last Hope: ${actor.name} · ${item.name}`,
      checkHTML(result) +
        `<p>Healing Hands DC24: ${success ? 'the critical wound is reapplied. Treat it again with Healing Hands before recovery can begin.' : 'failed; the Last Hope treatment remains.'}</p>`,
      { rolls: result.rolls, flags: { alchemyReceipt: receipt } }
    );
  if (actor.uuid === healer.uuid) return commitActor(actor, { ...plan.changes, ...changes }, items, publish);
  return commitActor(healer, plan.changes, [], () => commitActor(actor, changes, items, publish));
}

export async function lastHopeDoctor(actor, item) {
  owner(actor);
  const healers = game.actors.filter((candidate) => candidate.isOwner);
  const options = await prompt(
    'Last Hope: reapply critical wound',
    `<p>A Doctor must beat Healing Hands DC24 to reapply this injury, then treat it again normally.</p>` +
      input('healerUuid', 'Doctor', {
        options: Object.fromEntries(healers.map((candidate) => [candidate.uuid, candidate.name])),
      }) +
      input('modifier', 'Situational modifier', { value: 0 }) +
      manualCheckInput(),
    { button: 'Reapply injury' }
  );
  if (!options) return;
  const healer = await resolveFoundryUuid(options.healerUuid),
    arms = healer ? woundArmInput(healer, { optional: false }) : '';
  if (arms) {
    const selected = await prompt('Doctor: arm used', arms, { button: 'Use this arm' });
    if (!selected) return;
    options.woundArm = selected.woundArm;
  }
  options.turn = turnIdentity();
  return runCommand('alchemyLastHope', {
    actorUuid: actor.uuid,
    itemId: item.id,
    healerUuid: options.healerUuid,
    expected: woundFingerprint(item),
    options,
  });
}

export function registerAlchemyRuntime() {
  registerCraftingRuntime();
  registerCommand('alchemyUse', executeAlchemyUse);
  registerCommand('alchemyPoison', async ({ actorUuid, options = {} }, { user, id }) =>
    recoverAlchemyPoison(await authorizedActor(actorUuid, user), options, { user, id })
  );
  registerCommand('alchemyLastHope', reapplyLastHope);
  registerCommand('alchemyEnd', async ({ actorUuid, effectId }, { user, id }) => {
    if (!user.isGM) throw new RuleError('The GM records an alchemical effect ending early.');
    const actor = await authorizedActor(actorUuid, user),
      receipt = receiptKey(id),
      effect = actor.system.effects.find((entry) => entry.id === effectId && alchemyKey(entry));
    if (applied(actor, receipt)) return { receipt, alreadyApplied: true };
    if (!effect) throw new RuleError('The selected alchemical effect no longer exists.');
    const result = removeDoses(actor.system, (entry) => entry.id === effectId, now());
    const changes = {
      'system.effects': result.effects,
      'system.conditions': result.conditions,
      'system.toxicity.value': result.toxicity,
      'system.hp.value': result.hp,
      'system.combat.applied': recordReceipt(actor, receipt),
    };
    await capProjectedHP(actor, changes);
    return commitActor(actor, changes, [], () =>
      chat(
        actor,
        'Alchemical effect ended',
        `<p>${e(effect.key)} ended by the GM. Last Hope’s wound restrictions still require medical treatment.</p>`,
        { flags: { alchemyReceipt: receipt } }
      )
    );
  });
  registerCommand('alchemyApprove', async ({ messageUuid, adjudicationOptions = {} }, { user }) => {
    if (!user.isGM) throw new RuleError('The GM approves this application.');
    const message = await resolveFoundryUuid(messageUuid),
      data = message?.flags?.[SYSTEM_ID];
    if (data?.kind !== 'alchemyApproval') throw new RuleError('The item request no longer exists.');
    const author = game.users.get(data.requestAuthor),
      actor = await resolveFoundryUuid(data.payload.actorUuid);
    if (!author || !actor?.testUserPermission(author, 'OWNER'))
      throw new RuleError('The request author no longer owns this actor.');
    // Stable request ID + actor receipt makes a failed approval-card update safe to retry.
    const payload = clone(data.payload);
    for (const key of ['durationSeconds', 'toxicity', 'adjudication'])
      if (Object.hasOwn(adjudicationOptions, key)) payload.options[key] = adjudicationOptions[key];
    const result = await executeAlchemyUse(payload, { user, id: message.id });
    await message.update({ [`flags.${SYSTEM_ID}.applied`]: true });
    return result;
  });
  Hooks.on('renderChatMessageHTML', (message, html) => {
    const button = html.querySelector('[data-alchemy-approve]');
    if (!button) return;
    button.hidden = !game.user.isGM;
    button.disabled = !!message.flags?.[SYSTEM_ID]?.applied;
    button.addEventListener('click', () =>
      (async () => {
        const payload = message.flags?.[SYSTEM_ID]?.payload,
          actor = await resolveFoundryUuid(payload.actorUuid),
          target = await resolveFoundryUuid(payload.targetUuid),
          item = actor?.items.get(payload.itemId),
          profile = alchemyProfile(item);
        let content = `<p>Apply ${e(item?.name)} from ${e(actor?.name)} to ${e(target?.name)}?</p>`,
          adjudicationOptions = {};
        if (
          profile?.durationKind === 'unspecified' ||
          (profile?.key === 'last-hope' && target?.system.race === 'halfling')
        )
          content += input('durationSeconds', 'GM duration ruling (seconds)', {
            value: payload.options.durationSeconds ?? '',
            min: 1,
          });
        if (profile?.toxicityUnspecified)
          content += input('toxicity', 'GM toxicity ruling', {
            value: payload.options.toxicity ?? '',
            type: 'text',
          });
        if (
          profile?.durationKind === 'unspecified' ||
          profile?.toxicityUnspecified ||
          (profile?.key === 'last-hope' && target?.system.race === 'halfling')
        )
          content += input('adjudication', 'GM ruling and reason', {
            type: 'text',
            value: payload.options.adjudication ?? '',
          });
        adjudicationOptions = await prompt('Approve alchemical application', content, {
          button: 'Apply dose',
        });
        if (adjudicationOptions)
          await runCommand('alchemyApprove', { messageUuid: message.uuid, adjudicationOptions });
      })().catch(errorNotice)
    );
  });
}
