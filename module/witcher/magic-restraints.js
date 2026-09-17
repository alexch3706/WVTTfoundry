import { magicDefenseTotal } from './magic-focus-rules.js';
/** Core v1.35 p.103: Talfryn's Prison has one real, source-linked 15 HP restraint. */
import { registerSpellExecutionAdapters } from './magic-execution.js';
import { SYSTEM_ID } from './config.js';
import { RuleError } from './rules.js';
import { removeMagicEffects } from './magic-state.js';
import { registerCommand, runCommand, authorizedActor } from './authority.js';
import {
  actionPlan,
  check,
  checkHTML,
  chat,
  commitActor,
  input,
  manualCheckInput,
  prompt,
  serial,
  errorNotice,
  escapeHTML as e,
} from './runtime.js';
import { isPrimaryActiveGm } from '../foundry-compat.js';

const copy = (value) => structuredClone(value);
const rows = (collection) => collection?.contents ?? Array.from(collection?.values?.() ?? collection ?? []);
const resolve = (uuid) => foundry.utils.fromUuid(uuid);
const stateOf = (actor) => actor?.flags?.[SYSTEM_ID]?.magicRestraint;
const rootActors = () => rows(game.actors).filter((actor) => stateOf(actor)?.key === 'talfryns-prison');
const restraintFlag = `flags.${SYSTEM_ID}.magicRestraint`;

export function talfrynRestraintSupported(operation) {
  return (
    operation?.type === 'shield' &&
    operation.name === 'Binding roots' &&
    operation.purpose === 'restraint' &&
    operation.hp === 15 &&
    operation.onDestroy === 'endEffect' &&
    operation.escape?.skill === 'dodge' &&
    Number.isFinite(operation.escape.dc)
  );
}
function sourceEffect(effect, state) {
  if (effect.magic?.castId !== state.castId) return false;
  if (state.effectId) return effect.id === state.effectId;
  return effect.conditions?.includes('grappled') || effect.magic?.operation?.condition === 'grappled';
}

/** Called inside the authoritative casting transaction before actor effects commit. */
export async function createTalfrynRoots(
  operation,
  { data, row, caster, target, sourceToken, message, effectId = '' }
) {
  if (!game.user.isGM || data.magicKey !== 'talfryns-prison' || !talfrynRestraintSupported(operation))
    throw new RuleError('This adapter only creates the printed Talfryn’s Prison restraint.');
  if (!target?.uuid || !caster?.uuid || !data.castId || !Number.isFinite(data.check?.total))
    throw new RuleError('A restraint needs an actual caster, target and recorded casting total.');
  const targetToken = await resolve(row?.tokenUuid);
  if (
    !targetToken?.actor ||
    targetToken.actor.uuid !== target.uuid ||
    targetToken.parent?.id !== sourceToken?.parent?.id
  )
    throw new RuleError('The actual restrained token must still be on the casting scene.');
  if (
    rootActors().some(
      (actor) => stateOf(actor).castId === data.castId && stateOf(actor).targetUuid === target.uuid
    )
  )
    throw new RuleError('This casting already created its roots for this target.');
  const created = [];
  const rollback = async () => {
    const errors = [];
    for (const document of [...created].reverse())
      try {
        await document.delete({ witcherRestraintRollback: true });
      } catch (error) {
        errors.push(error);
      }
    if (errors.length) throw new AggregateError(errors, 'Restraint compensation needs GM review.');
  };
  try {
    const state = {
      key: 'talfryns-prison',
      castId: data.castId,
      casterUuid: caster.uuid,
      targetUuid: target.uuid,
      targetTokenUuid: targetToken.uuid,
      sourceMessageUuid: message?.uuid ?? '',
      castingTotal: data.check.total,
      defenseDC: magicDefenseTotal(data),
      focus: copy(data.focus ?? null),
      effectId,
      active: false,
      createdAt: game.time.worldTime,
      damageReceipts: [],
    };
    const roots = await Actor.create({
      name: `Binding roots · ${targetToken.name ?? target.name}`,
      type: 'monster',
      img: 'icons/svg/net.svg',
      ownership: { default: 0 },
      system: {
        category: 'object',
        anatomy: 'custom',
        organless: true,
        stats: { int: 1, ref: 1, dex: 1, body: 1, spd: 0, emp: 1, cra: 1, will: 1, luck: 0 },
        overrides: { hp: 15, sta: 0 },
        hp: { value: 15, max: 15 },
        sta: { value: 0, max: 0 },
        locations: [
          {
            id: 'roots',
            label: 'Binding roots',
            group: 'torso',
            min: 1,
            max: 10,
            aim: 0,
            multiplier: 1,
            sp: 0,
            maxSp: 0,
          },
        ],
        notes:
          'Core v1.35 p.103. These roots break after 15 points of damage. Dodge/Escape must beat the original Spell Casting total. Damage to this object does not damage the bound creature.',
      },
      flags: { [SYSTEM_ID]: { magicRestraint: state } },
    });
    if (!roots?.uuid) throw new RuleError('Foundry did not create the actual roots object.');
    created.push(roots);
    const tokenData = (
      await roots.getTokenDocument({
        x: targetToken.x,
        y: targetToken.y,
        width: targetToken.width,
        height: targetToken.height,
        elevation: targetToken.elevation,
        level: targetToken.level,
        actorLink: true,
        disposition: 0,
        name: roots.name,
      })
    ).toObject();
    const [token] = await targetToken.parent.createEmbeddedDocuments('Token', [tokenData]);
    if (!token?.uuid) throw new RuleError('Foundry did not place the actual roots token.');
    created.push(token);
    const controls = await chat(
      caster,
      'Talfryn’s Prison · binding roots',
      `<p>${e(target.name)} is bound by roots with 15 HP and no armor. Escape with Dodge/Escape against the spell DC ${magicDefenseTotal(data)}. Attack the roots token or record actual damage to the roots below.</p><button data-magic-restraint="escape">Dodge/Escape</button><button data-magic-restraint="damage">Damage roots (GM)</button>`,
      {
        flags: {
          kind: 'magic-restraint',
          rootsUuid: roots.uuid,
          targetUuid: target.uuid,
          castId: data.castId,
        },
      }
    );
    created.push(controls);
    await roots.update({
      [`${restraintFlag}.tokenUuid`]: token.uuid,
      [`${restraintFlag}.controlMessageUuid`]: controls.uuid,
    });
    return {
      status: 'applied',
      receipt: {
        type: 'restraint',
        key: 'talfryns-prison',
        actorUuid: roots.uuid,
        tokenUuid: token.uuid,
        targetUuid: target.uuid,
        effectId,
        castId: data.castId,
        messageUuid: controls.uuid,
      },
      rollback,
    };
  } catch (error) {
    try {
      await rollback();
    } catch (failure) {
      throw new AggregateError(
        [error, failure],
        'Creating the binding roots failed and compensation was incomplete.'
      );
    }
    throw error;
  }
}

/** Invoke after the target's source-linked grapple effect commits, before final cast receipt. */
export async function armTalfrynRoots(receipt) {
  const roots = await resolve(receipt.actorUuid),
    state = stateOf(roots),
    target = await resolve(receipt.targetUuid);
  if (!state || state.castId !== receipt.castId || state.targetUuid !== receipt.targetUuid)
    throw new RuleError('The pending roots source changed before its cast committed.');
  const effect = target?.system.effects.find((entry) => sourceEffect(entry, state));
  if (!effect || !target.system.conditions.includes('grappled'))
    throw new RuleError('The actual source-linked grapple must commit before the roots become active.');
  await roots.update({ [`${restraintFlag}.active`]: true, [`${restraintFlag}.effectId`]: effect.id });
  return receipt;
}

async function removeSource(roots) {
  const state = stateOf(roots),
    target = state?.targetUuid ? await resolve(state.targetUuid) : null;
  if (!target) return;
  const next = removeMagicEffects(target.system, (effect) => sourceEffect(effect, state));
  if (next.removed.length)
    await target.update({ 'system.effects': next.effects, 'system.conditions': next.conditions });
}
async function deleteRoots(roots) {
  const state = stateOf(roots);
  for (const scene of rows(game.scenes))
    for (const token of rows(scene.tokens))
      if (token.actor?.uuid === roots.uuid || token.actorId === roots.id) await token.delete();
  await roots.delete();
  const message = await resolve(state.controlMessageUuid);
  if (message) await message.update({ [`flags.${SYSTEM_ID}.ended`]: true });
}

/** Unserialized: authority callers can await without nesting the command queue. */
export async function refreshMagicRestraints() {
  if (!isPrimaryActiveGm()) return;
  for (const roots of [...rootActors()]) {
    const state = stateOf(roots);
    if (!state.active) continue;
    const target = await resolve(state.targetUuid),
      token = await resolve(state.tokenUuid),
      targetToken = await resolve(state.targetTokenUuid);
    const sourceRemains = target?.system.effects.some((effect) => sourceEffect(effect, state));
    if (roots.system.hp.value <= 0 || state.broken || !token || !targetToken) {
      await removeSource(roots);
      await deleteRoots(roots);
    } else if (!sourceRemains) await deleteRoots(roots);
  }
}

async function activeRoots(uuid) {
  const roots = await resolve(uuid),
    state = stateOf(roots);
  if (state?.key !== 'talfryns-prison' || !state.active || state.broken || roots.system.hp.value <= 0)
    throw new RuleError('These roots are already broken, escaped or dispelled.');
  const target = await resolve(state.targetUuid);
  if (!target?.system.effects.some((effect) => sourceEffect(effect, state)))
    throw new RuleError('The restraint no longer affects this creature.');
  return { roots, state, target };
}

export async function escapeTalfrynRoots(
  { rootsUuid, manualDice, extra = false, forfeit = false },
  { user }
) {
  const { roots, state, target } = await activeRoots(rootsUuid);
  await authorizedActor(target.uuid, user);
  if (target.system.conditions.some((condition) => ['dead', 'unconscious', 'stunned'].includes(condition)))
    throw new RuleError('This creature cannot attempt an escape in its current condition.');
  const defenseDC = state.defenseDC ?? magicDefenseTotal(state);
  const action = actionPlan(target, { extra: !!extra, forfeit: !!forfeit });
  const result = await check(target.skillBase('dodge', { modifier: action.modifier }).total, {
    actor: target,
    manualDice,
    context: { skill: 'dodge', dc: defenseDC },
  });
  const success = !result.fumble && result.total > defenseDC;
  const changes = { ...action.changes };
  if (success) {
    const next = removeMagicEffects(target.system, (effect) => sourceEffect(effect, state));
    Object.assign(changes, { 'system.effects': next.effects, 'system.conditions': next.conditions });
  }
  return commitActor(target, changes, [], async () => {
    const message = await chat(
      target,
      'Escape Talfryn’s Prison',
      checkHTML(result) +
        `<p>Spell DC ${defenseDC}: ${success ? 'The creature escapes these roots.' : 'The roots still hold.'}</p>`,
      {
        rolls: result.rolls,
        flags: { kind: 'magic-restraint-escape', rootsUuid, castId: state.castId, success },
      }
    );
    if (success)
      try {
        await roots.update({ [`${restraintFlag}.broken`]: true, [`${restraintFlag}.endedBy`]: 'escaped' });
      } catch (error) {
        await message.delete();
        throw error;
      }
    return message;
  });
}

/** Direct GM bookkeeping for a real damage event; zero armor and no victim HP mutation. */
export async function damageTalfrynRoots({ rootsUuid, amount, evidence, damageEvent }, { user, id }) {
  if (!user.isGM || !String(evidence ?? '').trim() || !Number.isFinite(amount) || amount <= 0)
    throw new RuleError('The GM must record a positive amount of actual damage and its source.');
  const { roots, state } = await activeRoots(rootsUuid);
  const event = String(damageEvent || id);
  if (state.damageReceipts.includes(event))
    throw new RuleError('This damage event was already applied to these roots.');
  const before = roots.system.hp.value,
    after = Math.max(0, before - amount);
  return commitActor(
    roots,
    {
      'system.hp.value': after,
      [`${restraintFlag}.damageReceipts`]: [...state.damageReceipts, event],
      ...(after === 0 ? { [`${restraintFlag}.broken`]: true, [`${restraintFlag}.endedBy`]: 'damage' } : {}),
    },
    [],
    () =>
      chat(
        roots,
        'Damage binding roots',
        `<p>${amount} actual damage; roots HP ${before} → ${after}. ${e(evidence)}</p>`,
        {
          flags: {
            kind: 'magic-restraint-damage',
            rootsUuid,
            castId: state.castId,
            amount,
            damageEvent: event,
            evidence,
          },
        }
      )
  );
}

export function registerMagicRestraints() {
  registerSpellExecutionAdapters({
    supportsRestraint: talfrynRestraintSupported,
    createRestraint: createTalfrynRoots,
    armRestraint: armTalfrynRoots,
  });
  registerCommand('magicRestraintEscape', escapeTalfrynRoots);
  registerCommand('magicRestraintDamage', damageTalfrynRoots);
  const schedule = () => {
    if (isPrimaryActiveGm()) serial('witcher-authority', refreshMagicRestraints).catch(errorNotice);
  };
  Hooks.on('updateActor', schedule);
  Hooks.on('deleteToken', schedule);
  Hooks.on('deleteActor', (actor, options = {}) => {
    if (!stateOf(actor) || options.witcherRestraintRollback || !isPrimaryActiveGm()) return;
    serial('witcher-authority', () => removeSource(actor)).catch(errorNotice);
  });
  Hooks.on('renderChatMessageHTML', (message, html) => {
    const state = message.flags?.[SYSTEM_ID];
    if (state?.kind !== 'magic-restraint') return;
    for (const button of html.querySelectorAll('[data-magic-restraint]')) {
      button.disabled = !!state.ended;
      button.addEventListener('click', async () => {
        try {
          const damage = button.dataset.magicRestraint === 'damage';
          const values = await prompt(
            damage ? 'Damage actual binding roots' : 'Escape binding roots',
            damage
              ? input('amount', 'Actual damage to the roots (no armor)', { value: 1, min: 1 }) +
                  input('evidence', 'Damage source / roll', { type: 'text' }) +
                  input('damageEvent', 'Damage event identifier (optional)', { type: 'text' })
              : manualCheckInput() +
                  input('extra', 'Extra action (3 STA, −3 check)', { type: 'checkbox' }) +
                  input('forfeit', 'Forfeit remaining strikes', { type: 'checkbox' })
          );
          if (!values) return;
          await runCommand(damage ? 'magicRestraintDamage' : 'magicRestraintEscape', {
            rootsUuid: state.rootsUuid,
            ...values,
            ...(damage ? { amount: Number(values.amount) } : {}),
          });
        } catch (error) {
          errorNotice(error);
        }
      });
    }
  });
  schedule();
}
