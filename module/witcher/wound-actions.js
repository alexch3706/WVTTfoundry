import { hexTreatmentModifier, hexCriticalWound } from './magic-hex-rules.js';
import { SYSTEM_ID } from './config.js';
import { lastHopeLocked, lastHopeState } from './alchemy-rules.js';
import { RuleError, beats } from './rules.js';
import { WOUNDS } from './wounds.js';
import { woundInfo, woundItemData } from './wound-catalog.js';
import {
  healingRequirements,
  recoveryPlan,
  advanceWoundDays,
  woundLocationChoices,
  recoveryContext,
  recoveryClockChanged,
  resolveWoundArm,
} from './wound-rules.js';
import { actorSnapshot, staminaCapChanges } from './documents.js';
import { resolveFoundryUuid } from '../foundry-compat.js';
import { registerCommand, authorizedActor, runCommand } from './authority.js';
import {
  owner,
  prompt,
  input,
  dice,
  check,
  checkHTML,
  chat,
  commitActor,
  actionPlan,
  turnIdentity,
  manualCheckInput,
  woundArmInput,
  validateManualCheck,
  escapeHTML as e,
  save,
  errorNotice,
} from './runtime.js';

const woundData = (item) => item.system.wound.toObject?.() ?? item.system.wound;
export const woundFingerprint = (item) => JSON.stringify(woundData(item));
const requireGM = (user) => {
  if (!user.isGM) throw new RuleError('The GM records treatment performed outside this workflow.');
};
const whole = (value, minimum = 1) => {
  if (!Number.isInteger(value) || value < minimum) throw new RuleError('Enter a valid whole number.');
  return value;
};
const requirements = (w) => {
  if (w.fatal) throw new RuleError('This fatal injury cannot be stabilized, treated or healed.');
  return healingRequirements(w.severity);
};
const assertCurrent = (item, expected) => {
  if (!item || item.type !== 'wound') throw new RuleError('The critical wound no longer exists.');
  if (expected !== woundFingerprint(item))
    throw new RuleError('The wound changed while the dialog was open. Reopen its card.');
};
const updateFields = (item, changes) => ({
  _id: item.id,
  ...Object.fromEntries(Object.entries(changes).map(([key, value]) => ['system.wound.' + key, value])),
});

function woundStaminaChanges(actor, item, changes) {
  const state = actorSnapshot(actor);
  const projected = state.items.map((i) =>
    i.id === item.id ? { ...i, wound: { ...i.wound, ...changes } } : i
  );
  return staminaCapChanges(actor, projected);
}

function startRecovery(actor, item, options, user) {
  const w = woundData(item),
    state = actorSnapshot(actor);
  const plan = recoveryPlan(state, state.items, { ...w, itemId: item.id });
  const projected = state.items.map((i) =>
    i.id === item.id ? { ...i, wound: { ...i.wound, treatment: 'treated' } } : i
  );
  let days = plan.days;
  if (options.duration !== undefined) {
    requireGM(user);
    if (w.permanent || w.severity === 'deadly')
      throw new RuleError('Deadly injuries have lasting consequences, not a printed recovery timer.');
    days = whole(options.duration);
  }
  return {
    treatment: 'treated',
    turnsTreated: 0,
    ageRounds: 0,
    separateConditions: true,
    recoveryBody: plan.body ?? 0,
    daysTotal: days ?? 0,
    daysRemaining: days ?? 0,
    recoveryContext: recoveryContext(state, projected),
    recoveryPending: days === null && !w.permanent && w.severity !== 'deadly',
  };
}

/** A successful Healing spell advances one critical-treatment use, never HP. */
export function magicalWoundTreatment(actor, item, checkTotal) {
  if (item?.type !== 'wound') throw new RuleError('Choose an existing critical wound.');
  if (lastHopeLocked(item))
    throw new RuleError(
      'Last Hope requires Doctor reapplication and subsequent Healing Hands treatment before this wound can heal.'
    );
  const w = woundData(item),
    req = requirements(w);
  if (!['untreated', 'stabilized'].includes(w.treatment))
    throw new RuleError('This injury is already treated.');
  if (!beats(checkTotal, req.magicDC)) return { success: false, dc: req.magicDC, changes: {}, items: [] };
  const uses = Number(w.magicUses || 0) + 1;
  if (uses > req.magicUses) throw new RuleError('The wound has already received all required healing uses.');
  const fields =
    uses === req.magicUses ? { ...startRecovery(actor, item, {}, {}), magicUses: uses } : { magicUses: uses };
  return {
    success: true,
    dc: req.magicDC,
    uses,
    required: req.magicUses,
    changes: woundStaminaChanges(actor, item, fields),
    items: [updateFields(item, fields)],
  };
}

/** Legacy condition flags had no source attribution. Clear only the flags
 * explicitly confirmed by the GM, and never another active wound's effects. */
function legacyConditions(actor, item, options, user) {
  const keys = options.clearLegacy ?? [];
  if (!Array.isArray(keys) || keys.some((key) => !['bleeding', 'poison', 'suffocating'].includes(key)))
    throw new RuleError('Invalid legacy condition selection.');
  if (!keys.length) return {};
  requireGM(user);
  const w = woundData(item);
  if (w.separateConditions || keys.some((key) => !w[key]))
    throw new RuleError('These conditions do not belong to this legacy wound.');
  const other = actor.items.filter(
    (i) => i.type === 'wound' && i.id !== item.id && i.system.wound.treatment === 'untreated'
  );
  return {
    'system.conditions': actor.system.conditions.filter(
      (key) => !keys.includes(key) || other.some((i) => i.system.wound[key])
    ),
  };
}

async function performWoundAction(actor, item, action, options, user) {
  const lastHope = lastHopeState(item);
  if (lastHope?.phase === 'locked')
    throw new RuleError('Use the medical button to reapply Last Hope’s wound with Healing Hands DC24 first.');
  if (lastHope?.phase === 'reapplied' && !(action === 'medical' && options.kind === 'treat'))
    throw new RuleError('This reapplied Last Hope injury must be treated again with Healing Hands.');
  const w = woundData(item),
    req = requirements(w);
  let changes = {},
    actorChanges = {},
    text = '',
    rolls = [];
  const itemMetadata = {};
  if (action === 'markStabilized') {
    requireGM(user);
    if (w.treatment !== 'untreated') throw new RuleError('Only an untreated wound can be stabilized.');
    changes = { treatment: 'stabilized', ageRounds: 0, separateConditions: true };
    text = 'Stabilization recorded by the GM. Recovery has not started.';
  } else if (action === 'markTreated') {
    requireGM(user);
    if (!['untreated', 'stabilized'].includes(w.treatment))
      throw new RuleError('This wound has already been treated.');
    changes = startRecovery(actor, item, options, user);
    text = 'Completed treatment recorded by the GM.';
  } else if (action === 'magic') {
    requireGM(user);
    if (!['untreated', 'stabilized'].includes(w.treatment))
      throw new RuleError('This wound has already been treated.');
    const uses = whole(options.uses),
      total = Number(w.magicUses || 0) + uses;
    if (total > req.magicUses) throw new RuleError('The successful healing uses exceed the required total.');
    changes = { magicUses: total };
    if (total === req.magicUses) changes = { ...changes, ...startRecovery(actor, item, options, user) };
    text = `${uses} successful Healing spell use(s) recorded, ${total} / ${req.magicUses}; Spell Casting must beat DC ${req.magicDC}. No HP restored and no spell resources spent by this counter.`;
  } else if (action === 'heal') {
    requireGM(user);
    if (w.treatment !== 'treated') throw new RuleError('Treat the wound before marking it healed.');
    changes = { treatment: 'healed', daysRemaining: 0, recoveryPending: false, separateConditions: true };
    text = w.permanent
      ? 'Healed; lasting consequences remain while this wound card is present.'
      : 'Healed; the card remains as history without active penalties.';
  } else if (action === 'days') {
    if (w.treatment !== 'treated' || w.permanent || w.severity === 'deadly')
      throw new RuleError('Only a treated, temporary injury has a recovery clock.');
    const days = whole(options.days);
    const state = actorSnapshot(actor);
    if (options.mode === 'set') {
      requireGM(user);
      changes = {
        daysRemaining: days,
        daysTotal: days,
        recoveryPending: false,
        recoveryContext: recoveryContext(state, state.items),
      };
      text = `GM set ${days} days remaining.`;
    } else {
      if (options.mode !== 'advance') throw new RuleError('Unknown recovery-clock action.');
      if (w.recoveryPending) throw new RuleError('The GM must set the recovery duration first.');
      if (recoveryClockChanged(w, state, state.items))
        return commitActor(actor, {}, [updateFields(item, { recoveryPending: true })], () =>
          chat(
            actor,
            item.name,
            '<p>Critical Healing modifiers changed. No days were deducted; the GM must review this recovery duration.</p>'
          )
        );
      changes = advanceWoundDays(w, days);
      text = `${days} recovery day(s) passed for this wound. ${changes.daysRemaining} remaining.`;
    }
  } else if (action === 'medical') {
    if (!['untreated', 'stabilized'].includes(w.treatment))
      throw new RuleError('This wound has already been treated.');
    if (options.turn !== turnIdentity())
      throw new RuleError('The combat turn changed. Reopen the medical dialog.');
    if (!['stabilize', 'stabilizeHands', 'treat'].includes(options.kind))
      throw new RuleError('Unknown medical action.');
    if (options.kind !== 'treat' && w.treatment !== 'untreated')
      throw new RuleError('This wound is already stabilized.');
    const healer = await authorizedActor(options.healerUuid, user);
    const skill = options.kind === 'stabilize' ? 'firstAid' : 'healingHands';
    if (
      skill === 'healingHands' &&
      !healer.system.customSkills.some((s) => s.id === 'healingHands' || s.name === 'Healing Hands') &&
      !healer.system.professionRanks.healingHands
    )
      throw new RuleError('The healer needs the Doctor’s Healing Hands skill.');
    if (!Number.isFinite(options.modifier)) throw new RuleError('Invalid treatment modifier.');
    // Validate physical dice even if this action only advances the treatment rounds.
    validateManualCheck({ manualDice: options.manualDice }, healer, { dc: req.dc });
    const arm = resolveWoundArm(healer.system, [...healer.items], options.woundArm, 'one');
    const plan = actionPlan(healer);
    let ready = true;
    if (options.kind === 'treat') {
      const rounds = whole(options.rounds);
      if (game.combat?.started && rounds !== 1)
        throw new RuleError('Record one treatment round per combat action.');
      if (rounds > req.rounds - Number(w.turnsTreated || 0))
        throw new RuleError('Too many treatment rounds.');
      const total = Number(w.turnsTreated || 0) + rounds;
      ready = total >= req.rounds;
      changes = { turnsTreated: ready ? 0 : total };
      text = `${total} / ${req.rounds} treatment rounds.`;
    }
    if (ready) {
      const result = await check(
        healer.skillBase(skill, {
          stat: 'cra',
          modifier: options.modifier + plan.modifier + hexTreatmentModifier(actor.system, w),
          arm,
        }).total,
        { manualDice: options.manualDice, actor: healer, context: { dc: req.dc, skill } }
      );
      rolls = result.rolls;
      const success = beats(result.total, req.dc);
      text += checkHTML(result) + `<p>DC ${req.dc}: ${success ? 'Successful.' : 'Failed.'}</p>`;
      if (success) {
        changes =
          options.kind === 'treat'
            ? startRecovery(actor, item, options, user)
            : { treatment: 'stabilized', ageRounds: 0, separateConditions: true };
        actorChanges = legacyConditions(actor, item, options, user);
        if (options.kind === 'treat' && lastHope?.phase === 'reapplied')
          itemMetadata[`flags.${SYSTEM_ID}.lastHope`] = {
            ...foundry.utils.deepClone(lastHope),
            phase: 'released',
            treatedAt: game.time.worldTime,
          };
      }
    }
    const publish = () => chat(healer, `Treatment: ${actor.name} · ${item.name}`, text, { rolls });
    actorChanges = { ...actorChanges, ...woundStaminaChanges(actor, item, changes) };
    if (healer.uuid === actor.uuid) {
      const combined = { ...plan.changes, ...actorChanges };
      if (plan.changes['system.sta.value'] !== undefined)
        combined['system.sta.value'] = Math.min(
          plan.changes['system.sta.value'],
          actorChanges['system.sta.value']
        );
      return commitActor(actor, combined, [{ ...updateFields(item, changes), ...itemMetadata }], publish);
    }
    // Nested compensation restores healer spending if the patient's write or chat fails.
    return commitActor(healer, plan.changes, [], () =>
      commitActor(actor, actorChanges, [{ ...updateFields(item, changes), ...itemMetadata }], publish)
    );
  } else throw new RuleError('Unknown wound action.');
  if (changes.treatment && ['stabilized', 'treated', 'healed'].includes(changes.treatment))
    actorChanges = legacyConditions(actor, item, options, user);
  actorChanges = { ...actorChanges, ...woundStaminaChanges(actor, item, changes) };
  return commitActor(actor, actorChanges, [updateFields(item, changes)], () =>
    chat(actor, item.name, `<p>${e(text)}</p>`)
  );
}

function legacyInput(actor, item) {
  const w = woundData(item);
  if (!game.user.isGM || w.separateConditions) return '';
  const keys = ['bleeding', 'poison', 'suffocating'].filter(
    (key) => w[key] && actor.system.conditions.includes(key)
  );
  return keys.length
    ? '<p>This older wound has untracked condition flags. Clear a flag only if no other injury or effect causes it.</p>' +
        keys
          .map((key) => input('clear_' + key, 'Also clear separately marked ' + key, { type: 'checkbox' }))
          .join('')
    : '';
}
function durationInput(actor, item) {
  if (!game.user.isGM || item.system.wound.permanent) return '';
  const state = actorSnapshot(actor),
    plan = recoveryPlan(state, state.items, { ...woundData(item), itemId: item.id });
  return (
    (plan.reason
      ? `<p>${e(plan.reason)}</p>`
      : `<p>Recovery after treatment: ${plan.days} days at BODY ${plan.body}.</p>`) +
    input('duration', 'GM recovery duration override (days; blank = calculated / pending)', {
      value: '',
      min: 1,
    })
  );
}

export async function woundAction(actor, item, action) {
  owner(actor);
  if (!item || item.type !== 'wound') throw new RuleError('Choose a critical wound.');
  if (action === 'medical' && lastHopeState(item)?.phase === 'locked') {
    const { lastHopeDoctor } = await import('./alchemy-runtime.js');
    return lastHopeDoctor(actor, item);
  }
  const w = woundData(item),
    req = requirements(w),
    expected = woundFingerprint(item),
    turn = turnIdentity();
  let content = `<p><strong>${e(item.name)}</strong> · ${e(w.location)}</p>`,
    button = 'Record';
  if (['markStabilized', 'markTreated', 'magic', 'heal'].includes(action)) requireGM(game.user);
  if (action === 'medical') {
    const candidates = game.actors.filter((a) => a.isOwner);
    if (!candidates.some((a) => a.uuid === actor.uuid)) candidates.push(actor);
    content +=
      input('healerUuid', 'Healer', {
        value: actor.uuid,
        options: Object.fromEntries(candidates.map((a) => [a.uuid, a.name])),
      }) +
      input('kind', 'Action', {
        options: {
          ...(w.treatment === 'untreated'
            ? { stabilize: 'Stabilize · First Aid', stabilizeHands: 'Stabilize · Healing Hands' }
            : {}),
          treat: 'Treat · Healing Hands',
        },
      }) +
      `<p>Stabilization: one check, DC ${req.dc}. Treatment: ${req.rounds} rounds, then one Healing Hands check, DC ${req.dc}. First Aid does not start recovery.</p>` +
      input('rounds', 'Treatment rounds spent', {
        value: 1,
        min: 1,
        max: game.combat?.started ? 1 : Math.max(1, req.rounds - Number(w.turnsTreated || 0)),
      }) +
      input('modifier', 'Situational modifier', { value: 0 }) +
      manualCheckInput() +
      durationInput(actor, item) +
      legacyInput(actor, item);
    button = 'Apply medical action';
  } else if (action === 'markStabilized')
    content +=
      '<p>Record successful stabilization already resolved at the table. This does not start recovery.</p>' +
      legacyInput(actor, item);
  else if (action === 'markTreated')
    content +=
      '<p>Record completed treatment already resolved at the table.</p>' +
      durationInput(actor, item) +
      legacyInput(actor, item);
  else if (action === 'magic')
    content +=
      `<p>Record successful Healing spell uses only: Spell Casting must beat DC ${req.magicDC}. Required: ${req.magicUses}. Current: ${w.magicUses || 0}. This counter does not cast spells, spend STA, or restore HP.</p>` +
      input('uses', 'Successful uses to add', {
        value: 1,
        min: 1,
        max: req.magicUses - Number(w.magicUses || 0),
      }) +
      durationInput(actor, item) +
      legacyInput(actor, item);
  else if (action === 'heal')
    content +=
      `<p>${w.permanent ? 'Lasting consequences remain. This does not restore lost body parts.' : 'Remove temporary penalties and keep this card as history.'}</p>` +
      legacyInput(actor, item);
  else if (action === 'days')
    content +=
      input('mode', 'Recovery clock', {
        value: w.recoveryPending ? 'set' : 'advance',
        options: {
          advance: 'Advance this wound’s recovery',
          ...(game.user.isGM ? { set: 'GM: set days remaining' } : {}),
        },
      }) + input('days', 'Days', { value: 1, min: 1 });
  else throw new RuleError('Unknown wound action.');
  const values = await prompt('Critical wound: ' + item.name, content, {
    button,
    validate:
      action === 'medical'
        ? async (values) =>
            validateManualCheck(values, await resolveFoundryUuid(values.healerUuid), { dc: req.dc })
        : undefined,
  });
  if (!values) return;
  if (action === 'medical') {
    const healer = await resolveFoundryUuid(values.healerUuid);
    if (!healer) throw new RuleError('The healer no longer exists.');
    const arms = woundArmInput(healer, { optional: false });
    if (arms) {
      const chosen = await prompt(
        'Medical action: ' + healer.name,
        '<p>Choose the arm or arms used to perform this treatment.</p>' + arms,
        { button: 'Apply medical action' }
      );
      if (!chosen) return;
      values.woundArm = chosen.woundArm;
    }
  }
  const options = {
    ...values,
    turn,
    modifier: Number(values.modifier || 0),
    rounds: Number(values.rounds || 0),
    uses: Number(values.uses || 0),
    days: Number(values.days || 0),
    clearLegacy: ['bleeding', 'poison', 'suffocating'].filter((key) => values['clear_' + key]),
  };
  if (values.duration !== undefined && String(values.duration).trim() !== '')
    options.duration = Number(values.duration);
  else delete options.duration;
  return runCommand(
    'woundAction',
    { actorUuid: actor.uuid, itemId: item.id, action, options, expected },
    { label: `${actor.name}: ${item.name}` }
  );
}

export async function addWound(actor, itemData) {
  owner(actor);
  const w = { ...itemData.system?.wound, name: itemData.system?.wound?.name || itemData.name },
    info = woundInfo(w);
  if (!info) throw new RuleError('This is not a recognized Core critical wound template.');
  const state = actorSnapshot(actor);
  if (w.organ && state.organless)
    throw new RuleError(
      'This creature has no vulnerable organs. Resolve the critical’s replacement damage instead.'
    );
  const locations = woundLocationChoices(state, info);
  if (!locations.length) throw new RuleError('This creature has no suitable hit location for this injury.');
  const values = await prompt(
    'Add critical wound',
    `<p>${e(itemData.name)} → ${e(actor.name)}. Adds a new untreated injury; does not repeat the original hit’s damage or Stun save.</p>` +
      input('location', 'Injured location', {
        value: locations[0].id,
        options: Object.fromEntries(locations.map((l) => [l.id, l.label])),
      }),
    { button: 'Add wound' }
  );
  if (!values) return [];
  const result = await runCommand(
    'addWound',
    { actorUuid: actor.uuid, key: info.key, location: values.location },
    { label: `${actor.name}: add ${itemData.name}` }
  );
  return typeof result === 'string' ? await resolveFoundryUuid(result) : result;
}

export function registerWoundActions() {
  registerCommand('removeWound', async ({ actorUuid, itemId, expected }, { user }) => {
    const actor = await authorizedActor(actorUuid, user),
      item = actor.items.get(itemId);
    assertCurrent(item, expected);
    if (lastHopeLocked(item))
      throw new RuleError('Last Hope’s injury cannot be removed before the Doctor reapplies and treats it.');
    return commitActor(actor, staminaCapChanges(actor), [], async () => {
      const removed = await actor.deleteEmbeddedDocuments('Item', [item.id]);
      if (!removed?.length) throw new RuleError('Removing the wound was cancelled.');
    });
  });
  registerCommand('woundAction', async ({ actorUuid, itemId, action, options = {}, expected }, { user }) => {
    const actor = await authorizedActor(actorUuid, user),
      item = actor.items.get(itemId);
    assertCurrent(item, expected);
    return performWoundAction(actor, item, action, options, user);
  });
  registerCommand('addWound', async ({ actorUuid, key, location }, { user }) => {
    const actor = await authorizedActor(actorUuid, user),
      info = woundInfo({ key });
    if (!info) throw new RuleError('Unknown critical wound template.');
    const index = Number(info.key.split('-')[1]);
    const w = hexCriticalWound(
      actor.system,
      {
        ...structuredClone(WOUNDS[info.severity][index]),
        key: info.key,
        severity: info.severity,
        group: info.group,
        location,
        treatment: 'untreated',
      },
      WOUNDS
    );
    const state = actorSnapshot(actor);
    if (w.organ && state.organless)
      throw new RuleError('Organless creatures cannot receive this organ injury.');
    if (!woundLocationChoices(state, w).some((l) => l.id === location))
      throw new RuleError('The selected injury location no longer exists.');
    const rolls = [];
    if (w.stunEveryFormula) {
      const roll = await dice(w.stunEveryFormula);
      w.stunEvery = roll.total;
      rolls.push(roll);
    }
    if (w.extraRoll) {
      const roll = await dice(w.extraRoll);
      w.extraResult = roll.total;
      w.notes = `Teeth lost: ${roll.total}`;
      rolls.push(roll);
    }
    const created = await actor.createEmbeddedDocuments('Item', [woundItemData(w)]),
      item = created?.[0];
    if (!item) throw new RuleError('Creating the wound was cancelled.');
    try {
      const changes = staminaCapChanges(actor);
      if (w.fatal) changes['system.conditions'] = [...new Set([...actor.system.conditions, 'dead'])];
      if (w.deathSave) changes['system.pendingDeathSaves'] = actor.system.pendingDeathSaves + 1;
      await commitActor(actor, changes, [], () =>
        chat(actor, 'Critical wound added', `<p>${e(item.name)} · ${e(location)}. ${e(w.notes || '')}</p>`, {
          rolls,
        })
      );
    } catch (error) {
      await actor.deleteEmbeddedDocuments('Item', [item.id]);
      throw error;
    }
    if (w.deathSave) {
      try {
        await save(actor, 'death', { receipt: `wound:${item.id}:death` });
      } catch (error) {
        errorNotice(error);
      }
    }
    return item;
  });
  registerCommand(
    'woundRest',
    async (
      { actorUuid, days, strenuous = false, sleepHours = 8, meals = 3, nightmareDice = {} },
      { user }
    ) => {
      const actor = await authorizedActor(actorUuid, user);
      if (game.combat?.started) throw new RuleError('End combat before advancing days of rest.');
      whole(days);
      if (typeof strenuous !== 'boolean') throw new RuleError('Invalid rest activity.');
      return actor.rest({ days, strenuous, sleepHours, meals, nightmareDice });
    }
  );
}
