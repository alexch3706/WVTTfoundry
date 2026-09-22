import { trophyRulesFor } from './magic-trophies.js';
import { activeAlchemy } from './alchemy-rules.js';
import { alchemyDamageEffects } from './alchemy-combat-rules.js';
import { actorEnhancementBenefits, enhancementBenefits } from './enhancements.js';
import { immuneTo } from './monster-rules.js';
import { ritualActionRestriction, compressedDeathChanges } from './magic-ritual-effects.js';
import { activeHexes, hexDiceRules, parseHexManualCheck, resolveHexCheck } from './magic-hex-rules.js';
import { magicActionRules, magicDamageRules, magicEffectCommit } from './magic-effect-hooks.js';
import { SYSTEM_ID } from './config.js';
import { resolveCheck, parseManualCheck, RuleError, reserveAction, attackSequence } from './rules.js';
import { resolveFoundryUuid } from '../foundry-compat.js';
import { injuredArmChoices, resolveWoundArm } from './wound-rules.js';
import { woundModifiers } from './wounds.js';

export const escapeHTML = (value) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  );
export const owner = (actor) => {
  if (!actor?.isOwner) throw new RuleError('You must own this actor.');
  return actor;
};
export const actorFromUuid = async (uuid) => {
  const doc = await resolveFoundryUuid(uuid);
  return doc?.documentName === 'Token' ? doc.actor : doc;
};
export const errorNotice = (error) => {
  console.error(`${SYSTEM_ID} |`, error);
  ui.notifications.error(error.message);
};
const queues = new Map();
export function serial(key, operation) {
  const task = (queues.get(key) ?? Promise.resolve()).catch(() => {}).then(operation);
  queues.set(key, task);
  task
    .finally(() => {
      if (queues.get(key) === task) queues.delete(key);
    })
    .catch(() => {});
  return task;
}

function restoreField(source, key) {
  const value = foundry.utils.getProperty(source, key);
  if (value === undefined) {
    const split = key.lastIndexOf('.');
    return [key.slice(0, split + 1) + '-=' + key.slice(split + 1), null];
  }
  return [key, foundry.utils.deepClone(value)];
}

/** Await each persistence operation and restore the exact changed fields on failure. */
export async function commitActor(
  actor,
  changes = {},
  itemChanges = [],
  after,
  { healingBonusApplied = false } = {}
) {
  const protections = [];
  itemChanges = foundry.utils.deepClone(itemChanges);
  for (const update of itemChanges) {
    const item = actor.items.get(update._id);
    if (
      !item ||
      !Number.isFinite(update['system.reliability']) ||
      update['system.reliability'] >= item.system.reliability ||
      Object.hasOwn(update, 'system.maxReliability')
    )
      continue;
    const threshold = enhancementBenefits(item).chemobogThreshold;
    if (threshold > 6) continue;
    const roll = await dice('1d6');
    const prevented = roll.total >= threshold;
    if (prevented) update['system.reliability'] = item.system.reliability;
    protections.push({ item, roll, prevented, threshold });
  }
  if (
    !healingBonusApplied &&
    Number.isFinite(changes['system.hp.value']) &&
    changes['system.hp.value'] > actor.system.hp.value
  ) {
    const effects = changes['system.effects'] ?? actor.system.effects;
    const oldTemporary = actor.system.effects.reduce(
      (sum, effect) => sum + Number(effect.temporaryHp || 0),
      0
    );
    const newTemporary = effects.reduce((sum, effect) => sum + Number(effect.temporaryHp || 0), 0);
    if (newTemporary <= oldTemporary) {
      const bonus = actorEnhancementBenefits(actor.items).healingBonus;
      if (bonus)
        changes['system.hp.value'] = Math.min(actor.system.hp.max, changes['system.hp.value'] + bonus);
    }
  }
  if (Array.isArray(changes['system.conditions']))
    changes['system.conditions'] = changes['system.conditions'].filter(
      (condition) => actor.system.conditions.includes(condition) || !immuneTo(actor.system, condition)
    );
  const imbuementPath = `flags.${SYSTEM_ID}.amuletImbuement`;
  if (
    actor.flags?.[SYSTEM_ID]?.amuletImbuement &&
    !Object.hasOwn(changes, imbuementPath) &&
    Object.keys(changes).some(
      (key) =>
        key.startsWith('system.combat.') &&
        !['system.combat.applied', 'system.combat.hitThisRound'].includes(key)
    )
  ) {
    const { amuletImbuementInterruption } = await import('./magic-amulet-crafting.js');
    Object.assign(changes, amuletImbuementInterruption(actor, 'combat action or defense'));
  }
  if (Number.isFinite(changes['system.hp.value']) && changes['system.hp.value'] < actor.system.hp.value) {
    const protection = magicDamageRules(actor.system, { hpAfter: changes['system.hp.value'] });
    if (protection.protectionEffectId) {
      changes['system.hp.value'] = protection.hpAfter;
      changes['system.effects'] = magicEffectCommit(
        { ...actor.system, effects: changes['system.effects'] ?? actor.system.effects },
        { protectionEffectId: protection.protectionEffectId }
      ).effects;
      if (changes['system.pendingDeathSaves'] === actor.system.pendingDeathSaves + 1)
        changes['system.pendingDeathSaves'] = actor.system.pendingDeathSaves;
    }
    const loss = Math.max(0, actor.system.hp.value - changes['system.hp.value']);
    const effects = foundry.utils.deepClone(changes['system.effects'] ?? actor.system.effects);
    const oldPool = actor.system.effects.reduce(
      (sum, effect) => sum + Math.max(0, Number(effect.temporaryHp) || 0),
      0
    );
    const nextPool = effects.reduce((sum, effect) => sum + Math.max(0, Number(effect.temporaryHp) || 0), 0);
    // Direct damage (overdrawing magic, fumbles, severing a tongue) also triggers
    // decoctions. Resource expiry/capping is not an injury. Damage plans already
    // update these fields, so preserve their recorded result instead of doubling it.
    const hpBonus = (list) => list.reduce((sum, effect) => sum + Number(effect.modifiers?.hp || 0), 0);
    const lostMaximum = Math.max(0, hpBonus(actor.system.effects) - hpBonus(effects));
    const capLoss = lostMaximum
      ? Math.max(0, actor.system.hp.value - (actor.system.hp.max - lostMaximum))
      : 0;
    const injury = Math.max(0, loss - Math.max(oldPool - nextPool, capLoss));
    if (injury) {
      const triggered = alchemyDamageEffects(actor.system, effects, { damage: injury });
      for (const [key, field] of [
        ['griffin-decoction', 'armorBonus'],
        ['wyvern-decoction', 'wyvernBonus'],
      ]) {
        const previous = activeAlchemy(actor.system, key);
        const current = previous && effects.find((effect) => effect.id === previous.id);
        if (current && Number(current.alchemy?.[field] || 0) === Number(previous.alchemy?.[field] || 0)) {
          const next = triggered.find((effect) => effect.id === current.id);
          current.alchemy = next.alchemy;
        }
      }
    }
    let remaining = Math.max(0, loss - Math.max(0, oldPool - nextPool));
    for (const effect of effects) {
      if (!(effect.temporaryHp > 0) || remaining <= 0) continue;
      const absorbed = Math.min(effect.temporaryHp, remaining);
      effect.temporaryHp -= absorbed;
      remaining -= absorbed;
    }
    if (JSON.stringify(effects) !== JSON.stringify(changes['system.effects'] ?? actor.system.effects))
      changes['system.effects'] = effects;
    const { removeMagicEffects } = await import('./magic-state.js');
    const removed = removeMagicEffects(
      {
        effects: changes['system.effects'] ?? actor.system.effects,
        conditions: changes['system.conditions'] ?? actor.system.conditions,
      },
      (effect) => effect.magic?.sleeping || effect.magic?.key === 'axii'
    );
    if (removed.removed.length) {
      changes['system.effects'] = removed.effects;
      changes['system.conditions'] = removed.conditions;
    }
    const compressed = compressedDeathChanges(actor, changes['system.hp.value']);
    if (compressed['system.conditions'])
      compressed['system.conditions'] = [
        ...new Set([
          ...(changes['system.conditions'] ?? actor.system.conditions),
          ...compressed['system.conditions'],
        ]),
      ];
    Object.assign(changes, compressed);
  }
  const before = Object.fromEntries(Object.keys(changes).map((k) => restoreField(actor._source, k)));
  const beforeItems = itemChanges.map((change) => {
    const item = actor.items.get(change._id);
    if (!item) throw new RuleError('Equipment changed while this action was pending.');
    return {
      _id: item.id,
      ...Object.fromEntries(
        Object.keys(change)
          .filter((k) => k !== '_id')
          .map((k) => restoreField(item._source, k))
      ),
    };
  });
  let actorWritten = false;
  let protectionCard;
  try {
    if (Object.keys(changes).length) {
      await actor.update(changes);
      actorWritten = true;
    }
    if (itemChanges.length) await actor.updateEmbeddedDocuments('Item', itemChanges);
    if (protections.length)
      protectionCard = await chat(
        actor,
        'Chemobog',
        protections
          .map(
            ({ item, roll, prevented, threshold }) =>
              `<p>${escapeHTML(item.name)}: ${roll.total} vs ${threshold}–6; ${prevented ? 'weapon damage prevented' : 'weapon takes damage'}.</p>`
          )
          .join(''),
        { rolls: protections.map((entry) => entry.roll) }
      );
    if (after) return await after();
    return protectionCard;
  } catch (error) {
    const recovery = [];
    if (protectionCard) recovery.push(protectionCard.delete());
    if (actorWritten) recovery.push(actor.update(before));
    // Embedded operations can partially succeed, so restore every affected field.
    if (beforeItems.length) recovery.push(actor.updateEmbeddedDocuments('Item', beforeItems));
    const outcomes = await Promise.allSettled(recovery);
    if (outcomes.some((r) => r.status === 'rejected'))
      ui.notifications.error(
        'Action failed and rollback was incomplete. The GM must inspect actor resources and equipment.'
      );
    throw error;
  }
}

export function input(
  name,
  label,
  { value = '', type = 'number', options, min, max, step = 1, checked = false } = {}
) {
  const e = escapeHTML;
  const element = options
    ? `<select name="${e(name)}">${Object.entries(options)
        .map(
          ([key, label]) =>
            `<option value="${e(key)}" ${String(key) === String(value) ? 'selected' : ''}>${e(label)}</option>`
        )
        .join('')}</select>`
    : type === 'checkbox'
      ? `<input name="${e(name)}" type="checkbox" ${checked ? 'checked' : ''}>`
      : `<input name="${e(name)}" type="${e(type)}" value="${e(value)}" ${min !== undefined ? `min="${min}"` : ''} ${max !== undefined ? `max="${max}"` : ''} step="${step}">`;
  return `<label class="witcher-field"><span>${e(label)}</span>${element}</label>`;
}
export function manualCheckInput({ required = false } = {}) {
  return (
    input('manualDice', required ? 'Physical d10 (required for active checks)' : 'Manual d10 (optional)', {
      type: 'text',
    }) +
    `<p class="notes">${required ? 'This actor uses physical combat dice. Passive DCs need no die.' : 'Leave empty to roll automatically.'} Enter dice only, separated by commas: 7; 10,6; or 1,10,4. Include every follow-up die; stats and modifiers are added automatically. With Evil Eye, separate the second fumble chain by a semicolon: 1,5;10,3.</p>`
  );
}
export function woundArmInput(actor, { optional = true } = {}) {
  const choices = injuredArmChoices(actor.system, [...actor.items]);
  if (!choices || !Object.keys(choices).length) return '';
  return (
    input('woundArm', 'Arm used for this action', {
      options: { ...(optional ? { '': 'No arm used' } : {}), ...choices, both: 'Both arms' },
    }) +
    '<p class="notes">The selected arm determines injury penalties. Two-handed weapons always use both arms.</p>'
  );
}
export function validateManualCheck(values, actor = null, context = {}) {
  if (context.manualRequired && values.defense !== 'passive' && !String(values.manualDice ?? '').trim())
    throw new RuleError(
      'This actor uses physical combat dice. Enter the complete d10 result before submitting.'
    );
  const dice = actor
    ? parseHexManualCheck(
        values.manualDice,
        hexDiceRules(actor.system, { stressed: !!globalThis.game?.combat?.started, ...context })
      )
    : parseManualCheck(values.manualDice);
  if (dice && values.defense === 'passive')
    throw new RuleError('Passive DC does not roll a die. Clear Manual d10 or choose an active defense.');
}
export function prompt(title, content, { button = 'Roll', width = 480, validate } = {}) {
  return new Promise((resolve) => {
    const formValues = (form) => {
      const values = Object.fromEntries(new FormData(form));
      for (const el of form.querySelectorAll('input[type=checkbox]')) values[el.name] = el.checked;
      return values;
    };
    const DialogClass = globalThis.Dialog ?? foundry.appv1.api.Dialog;
    class ValidatedDialog extends DialogClass {
      async submit(button, event) {
        const element = this.element?.[0] ?? this.element;
        if (button === this.data.buttons.submit) {
          const form = element?.querySelector('form');
          if (form?.reportValidity() === false) return;
          try {
            if (form && validate) await validate(formValues(form));
          } catch (error) {
            ui.notifications.error(error.message);
            return;
          }
        }
        return super.submit(button, event);
      }
    }
    new ValidatedDialog(
      {
        title,
        content: `<form class="witcher-dialog">${content}</form>`,
        buttons: {
          submit: {
            label: button,
            callback: (html) => {
              const element = html[0] ?? html;
              const form = element.querySelector('form');
              if (!form.reportValidity()) return false;
              resolve(formValues(form));
            },
          },
          cancel: { label: 'Cancel', callback: () => resolve(null) },
        },
        default: 'submit',
        close: () => resolve(null),
      },
      { width }
    ).render(true);
  });
}
export async function dice(formula) {
  if (!Roll.validate(formula)) throw new RuleError(`Invalid roll formula: ${formula}`);
  const roll = await new Roll(formula).evaluate();
  if (!Number.isFinite(roll.total)) throw new RuleError('The dice did not produce a number.');
  return roll;
}
export async function check(base, { manualDice, actor = null, context = {} } = {}) {
  const rules = hexDiceRules(actor?.system, { stressed: !!globalThis.game?.combat?.started, ...context });
  const entered = parseHexManualCheck(manualDice, rules);
  if (entered)
    return { ...resolveHexCheck(base, entered.dice, entered.second, rules), rolls: [], source: 'manual' };
  const rolls = [await dice('1d10')],
    first = [rolls[0].total];
  const continueChain = async () => {
    const chain = [];
    do {
      const roll = await dice('1d10');
      rolls.push(roll);
      chain.push(roll.total);
    } while (chain.at(-1) === 10);
    return chain;
  };
  const fumble = rules.fumbleFaces.includes(first[0]);
  if (fumble || first[0] === 10) first.push(...(await continueChain()));
  const second = fumble && rules.twice ? await continueChain() : null;
  return { ...resolveHexCheck(base, first, second, rules), rolls, source: 'automatic' };
}

export async function chat(actor, title, content, { rolls = [], flags = {}, whisper, id } = {}) {
  const data = {
    ...(id ? { _id: id } : {}),
    speaker: ChatMessage.getSpeaker({ actor }),
    content: `<article class="witcher-chat"><h3>${escapeHTML(title)}</h3>${content}</article>`,
    rolls,
    flags: { [SYSTEM_ID]: flags },
  };
  if (whisper) data.whisper = whisper;
  else ChatMessage.applyRollMode(data, game.settings.get('core', 'rollMode'));
  return ChatMessage.create(data, { keepId: !!id });
}
export function checkHTML(result) {
  return `<p class="witcher-total">${result.total}</p><p>Base ${result.base}; d10: ${result.dice.join(', ')}${result.source === 'manual' ? ' <strong>(manual entry)</strong>' : ''}${result.fumble ? '; fumble ' + result.fumble : ''}${result.fumbleDice?.length > 1 ? `; Evil Eye: ${result.fumbleDice.map((chain) => chain.join(', ')).join(' / ')} (worse result used)` : ''}</p>`;
}
export function turnIdentity() {
  const combat = game.combat;
  return combat?.started ? `${combat.id}:${combat.round}:${combat.turn}` : '';
}
export function actionPlan(actor, options = {}) {
  owner(actor);
  if (
    actor.system.effects?.some(
      (effect) => effect.magic?.healingRest && !effect.disabled && !effect.magic.suppressed
    )
  )
    throw new RuleError(
      'Healing Rest keeps this living creature in a coma for one full day. It cannot take actions or make active defenses.'
    );
  if (!options.defense && actor.system.magic?.leyConnection?.pending?.length)
    throw new RuleError(
      'Resolve the mandatory Ley Line consequence on the magic card before taking another action.'
    );
  const ritualRestriction = ritualActionRestriction(actor, options.actionKey ?? 'action');
  if (ritualRestriction) throw new RuleError(ritualRestriction);
  const restriction = magicActionRules(actor.system, {
    action:
      options.actionKey ||
      (options.weapon ? 'attack' : options.defense ? 'defense' : options.recovery ? 'recover' : 'action'),
    movementActionsUsed: actor.system.combat.movementActions || 0,
  });
  if (restriction.blocked) throw new RuleError(restriction.reasons.join(' '));
  const conditions = actor.system.conditions;
  if (conditions.includes('dead')) throw new RuleError('A dead actor cannot act.');
  if (!options.recovery && conditions.some((c) => ['stunned', 'unconscious', 'pinned'].includes(c)))
    throw new RuleError('Only recovery or escape is possible in this condition.');
  const combat = game.combat,
    active = !!combat?.started;
  if (options.expectedTurn !== undefined && options.expectedTurn !== turnIdentity())
    throw new RuleError('The turn changed while this dialog was open. Choose your action again.');
  if (options.reaction) return { changes: {}, cost: 0, modifier: 0 };
  if (!options.defense && actor.system.combat.reactions?.some((r) => r.turn === turnIdentity()))
    throw new RuleError('Resolve or decline the immediate school armor reaction in chat first.');
  if (active && !options.defense && combat.combatant?.actor?.uuid !== actor.uuid)
    throw new RuleError('Advance the combat tracker to this actor’s turn first.');
  const roundKey = active ? `${combat.id}:${combat.round}` : '';
  const turnKey = turnIdentity();
  const budget = foundry.utils.deepClone(actor.system.combat);
  if (!active || budget.roundKey !== roundKey) {
    budget.defenses = 0;
    budget.npcWeaponId = '';
    budget.npcStrikes = 0;
  }
  if (!active || (!options.defense && budget.key !== turnKey)) {
    Object.assign(budget, {
      actions: 0,
      extra: 0,
      remaining: 0,
      full: false,
      attackAction: '',
      strikeIndex: 0,
    });
  }
  if (!options.weapon && !options.defense && budget.remaining > 0) {
    if (!options.forfeit) throw new RuleError('Finish or forfeit your remaining strikes first.');
    budget.remaining = 0;
  }
  const result = options.weapon
    ? attackSequence(budget, options.weapon, options)
    : reserveAction(budget, { ...options, activelyDodging: conditions.includes('activelyDodging') });
  result.budget = { ...budget, ...result.budget };
  if (actor.system.traits.infiniteStamina) result.cost = 0;
  if (result.cost > actor.system.sta.value) throw new RuleError('Not enough Stamina.');
  return {
    ...result,
    changes: {
      ...Object.fromEntries(Object.entries(result.budget).map(([k, v]) => ['system.combat.' + k, v])),
      'system.combat.roundKey': roundKey,
      ...(!options.defense ? { 'system.combat.key': turnKey } : {}),
      'system.sta.value': actor.system.sta.value - result.cost,
    },
  };
}
export async function skillRoll(
  actor,
  key,
  { modifier = 0, stat, dialog = true, title, arm = '', sight = false, context = {} } = {}
) {
  owner(actor);
  let luck = 0;
  if (dialog) {
    const values = await prompt(
      title ?? key,
      input('modifier', 'Situational modifier', { value: modifier }) +
        input('luck', 'Luck spent', { value: 0, min: 0, max: actor.system.luck.value }) +
        woundArmInput(actor) +
        (activeAlchemy(actor.system, 'cat')
          ? input('seeThroughIllusion', 'Seeing through an illusion (Cat +2)', { type: 'checkbox' })
          : '') +
        (key === 'seduction' && activeHexes(actor.system).has('the-eternal-itch')
          ? input('intimacy', 'Intimate contact (Eternal Itch)', { type: 'checkbox' })
          : '') +
        (key === 'wildernessSurvival' && activeHexes(actor.system).has('the-hex-of-the-beast')
          ? input('animalHandling', 'Handling an animal (Hex of the Beast)', { type: 'checkbox' })
          : '') +
        (['seduction', 'charisma', 'persuasion', 'leadership'].includes(key) &&
        activeHexes(actor.system).has('the-odious-hex')
          ? input(
              'socialStanding',
              'Standing before Odious Hex (including own race); resulting social penalty is included',
              {
                options: {
                  equal: 'Equal → Tolerated (−1)',
                  tolerated: 'Tolerated → Hated (−2)',
                  hated: 'Hated (−2)',
                },
              }
            )
          : '') +
        (activeHexes(actor.system).has('the-devils-luck')
          ? input('stressed', 'High stress or deadline (Devil’s Luck)', { type: 'checkbox' }) +
            input('dc', 'Known difficulty, if applicable', { value: '', min: 0 })
          : '') +
        (key === 'awareness' &&
        actor.items.some((i) => i.type === 'wound' && woundModifiers(i.system.wound)?.sightAwareness)
          ? input('sight', 'Visual Awareness (apply eye injury)', { type: 'checkbox', checked: true })
          : '')
    );
    if (!values) return;
    modifier = Number(values.modifier);
    luck = Number(values.luck);
    arm = resolveWoundArm(actor.system, [...actor.items], values.woundArm);
    sight = !!values.sight;
    context = {
      ...context,
      intimacy: !!values.intimacy,
      seeThroughIllusion: !!values.seeThroughIllusion,
      animalHandling: !!values.animalHandling,
      socialStanding: values.socialStanding,
      stressed: !!values.stressed || !!game.combat?.started,
      dc: values.dc === '' ? undefined : Number(values.dc),
    };
  }
  if (!Number.isInteger(luck) || luck < 0 || luck > actor.system.luck.value)
    throw new RuleError('Invalid Luck expenditure.');
  const result = await check(
    actor.skillBase(key, { stat, modifier: modifier + luck, arm, sight, context }).total,
    { actor, context: { ...context, skill: key } }
  );
  if (luck) await actor.update({ 'system.luck.value': actor.system.luck.value - luck });
  await chat(actor, title ?? key, checkHTML(result), { rolls: result.rolls });
  return result;
}

export async function save(actor, kind, { modifier = 0, luck = 0, receipt } = {}) {
  owner(actor);
  if (receipt && actor.system.combat.applied.includes(receipt)) return;
  if (!['stun', 'death', 'body'].includes(kind)) throw new RuleError('Unknown save.');
  if (luck && kind !== 'death') throw new RuleError('Luck can only modify a Death save.');
  if (!Number.isInteger(luck) || luck < 0 || luck > actor.system.luck.value)
    throw new RuleError('Invalid Luck expenditure.');
  const { magicalStunRecovery, magicStunSavePlan } = await import('./magic-lifecycle.js');
  const magicalRecovery = kind === 'stun' ? magicalStunRecovery(actor.system) : null;
  if (kind === 'stun' && (magicalRecovery.blocked || actor.system.magic?.exhaustedRecovery > 0)) {
    await chat(
      actor,
      'Stun recovery',
      `<p>${escapeHTML(magicalRecovery.reason || `Recover ${actor.system.magic.exhaustedRecovery} more STA using Recovery Actions before the Stun save.`)}</p>`
    );
    return false;
  }
  const threshold =
    (kind === 'death'
      ? actor.system.derived.deathTarget - actor.system.deathSaves
      : kind === 'stun'
        ? actor.system.derived.stun
        : actor.system.derived.stats.body) +
    modifier +
    (magicalRecovery?.modifier ?? 0) +
    (kind === 'stun' && trophyRulesFor(actor.system).stunWithoutPenaltyBonus ? 1 : 0) +
    luck;
  const roll = await dice('1d10');
  const success = roll.total < threshold;
  const conditions = new Set(actor.system.conditions);
  const changes = {};
  if (kind === 'death') {
    changes['system.deathSaves'] = actor.system.deathSaves + 1;
    changes['system.pendingDeathSaves'] = Math.max(0, actor.system.pendingDeathSaves - 1);
    changes['system.luck.value'] = actor.system.luck.value - luck;
    if (!success) conditions.add('dead');
  } else if (kind === 'stun') {
    if (!success) conditions.add('stunned');
    else if (!conditions.has('unconscious') || actor.system.unconsciousRecovery >= 20) {
      conditions.delete('stunned');
      conditions.delete('unconscious');
      const ended = magicStunSavePlan(actor.system, { success: true });
      if (ended.removed.length) changes['system.effects'] = ended.effects;
    }
  }
  changes['system.conditions'] = [...conditions];
  if (receipt) changes['system.combat.applied'] = [...actor.system.combat.applied, receipt];
  await commitActor(actor, changes, [], () =>
    chat(
      actor,
      `${kind} save`,
      `<p>${roll.total} &lt; ${threshold}: <strong>${success ? 'Success' : 'Failure'}</strong></p>`,
      { rolls: [roll] }
    )
  );
  return success;
}
