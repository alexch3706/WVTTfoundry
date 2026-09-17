import { SYSTEM_ID } from './config.js';
import { enhancementBenefits, actorEnhancementBenefits } from './enhancements.js';
import { RuleError, hitLocations, locate, resolveDamage } from './rules.js';
import { registerCommand, runCommand, authorizedActor } from './authority.js';
import { commitActor, actorFromUuid, chat, escapeHTML as e, errorNotice } from './runtime.js';
import { measureTokenDistance } from '../foundry-compat.js';

export async function offerDeflection(defenseMessage, attackData) {
  if (game.messages.some((message) => message.flags?.[SYSTEM_ID]?.deflectionSource === defenseMessage.uuid))
    return;
  const defense = defenseMessage.flags[SYSTEM_ID],
    actor = await actorFromUuid(defense.actorUuid);
  return chat(
    actor,
    'Deflected projectile',
    `<p>Select a target within 10 m of ${e(actor.name)}. It receives a defense against ${defense.check.total}; failure causes Staggered.</p><button type="button" data-witcher-deflect>Deflect to targeted token</button>`,
    {
      flags: {
        kind: 'deflection',
        actorUuid: actor.uuid,
        deflectionSource: defenseMessage.uuid,
        sourceTokenUuid: attackData.targetTokenUuid,
        check: defense.check,
      },
    }
  );
}
export async function redirectProjectile({ messageUuid, targetTokenUuid }, { user, id }) {
  const message = await foundry.utils.fromUuid(messageUuid),
    data = message?.flags?.[SYSTEM_ID];
  if (!message?.author?.isGM || data?.kind !== 'deflection')
    throw new RuleError('Choose an actual successful projectile parry.');
  const actor = await authorizedActor(data.actorUuid, user);
  if (data.applied) throw new RuleError('This projectile was already redirected.');
  const source = await foundry.utils.fromUuid(data.sourceTokenUuid),
    target = await foundry.utils.fromUuid(targetTokenUuid);
  if (!source?.object || !target?.object || !target.actor || source.parent?.id !== target.parent?.id)
    throw new RuleError('Display both tokens on the same scene.');
  const distance = measureTokenDistance(source.object, target.object);
  if (source.actor?.uuid !== actor.uuid || !Number.isFinite(distance) || distance > 10)
    throw new RuleError('The deflection target must be within 10 m.');
  let card;
  try {
    card = await chat(
      actor,
      `Deflection → ${target.actor.name}`,
      `<p>Defend against ${data.check.total}. Failure causes Staggered.</p><button type="button" data-witcher-action="defend">Defend</button>`,
      {
        flags: {
          kind: 'attack',
          authorId: user.id,
          operationId: id,
          actorUuid: actor.uuid,
          targetUuid: target.actor.uuid,
          sourceTokenUuid: source.uuid,
          targetTokenUuid: target.uuid,
          deflectedProjectile: true,
          weapon: {
            id: 'deflection',
            name: 'Deflected projectile',
            type: 'weapon',
            category: 'naturalRanged',
            damage: '0',
            damageTypes: ['piercing'],
            properties: { natural: true },
            reliability: 1,
          },
          check: data.check,
          action: 'normal',
          style: 'normal',
          type: 'piercing',
          resolved: false,
        },
      }
    );
    await message.update({ [`flags.${SYSTEM_ID}.applied`]: true });
    return card;
  } catch (error) {
    if (card) await card.delete();
    throw error;
  }
}

export async function applyRetribution(message, target, data) {
  if (
    data.retribution ||
    !data.request?.some(
      (request) => !request.properties?.damageSource || request.properties.damageSource === 'attack'
    ) ||
    !actorEnhancementBenefits(target.items).retribution ||
    !data.summary.some((result) => result.damage > 0)
  )
    return;
  const attacker = await actorFromUuid(data.actorUuid);
  if (!attacker || attacker.uuid === target.uuid) return;
  const receipt = `retribution:${data.attackRef || message.uuid}`;
  if (attacker.system.combat.applied.includes(receipt)) return;
  const [{ planDamageChanges }, { commitDamage, magicDamageSnapshot }] = await Promise.all([
    import('./combat.js'),
    import('./magic-shields.js'),
  ]);
  const state = magicDamageSnapshot(attacker),
    table = hitLocations(state),
    location = table.find((entry) => entry.group === 'torso' || entry.id === 'torso');
  if (!location) throw new RuleError('Retribution needs a torso location on the attacker.');
  const result = resolveDamage(
    { raw: 3, type: 'untyped', properties: { magic: true, bypassArmor: true, damageSource: 'retribution' } },
    state,
    location,
    state.items
  );
  const plan = planDamageChanges(attacker, [result]);
  plan.actor['system.combat.applied'] = [...attacker.system.combat.applied, receipt];
  return commitDamage(attacker, plan, plan.items, () =>
    chat(
      target,
      'Retribution',
      `<p>${e(attacker.name)} takes ${result.damage} damage to ${e(location.label)}, ignoring armor.</p>`,
      { flags: { kind: 'retribution', receipt, actorUuid: attacker.uuid } }
    )
  );
}

export async function rejuvenationPlan(victim, event) {
  if (!victim.system.conditions.includes('dead')) return;
  const damage = await foundry.utils.fromUuid(event.messageUuid),
    attackRef = damage?.flags?.[SYSTEM_ID]?.attackRef;
  const attack = attackRef ? await foundry.utils.fromUuid(attackRef) : null,
    weapon = attack?.flags?.[SYSTEM_ID]?.weapon;
  if (!weapon || !enhancementBenefits(weapon).words.includes('rejuvenation')) return;
  const actor = await actorFromUuid(event.attackerUuid);
  if (!actor || actor.system.conditions.includes('dead')) return;
  const receipt = `rejuvenation:${event.receipt}:${victim.uuid}`;
  if (actor.system.combat.applied.includes(receipt)) return;
  return {
    actor,
    changes: {
      'system.sta.value': Math.min(actor.system.sta.max, actor.system.sta.value + actor.system.derived.rec),
      'system.combat.applied': [...actor.system.combat.applied, receipt],
    },
  };
}

export async function awardRejuvenation(victim, event) {
  const plan = await rejuvenationPlan(victim, event);
  if (!plan) return;
  return commitActor(plan.actor, plan.changes, [], () =>
    chat(
      plan.actor,
      'Rejuvenation',
      `<p>${e(victim.name)} slain: recover up to ${plan.actor.system.derived.rec} STA.</p>`
    )
  );
}

export function registerEnhancementCombat() {
  registerCommand('deflectProjectile', redirectProjectile);
  Hooks.on('renderChatMessageHTML', (message, html) =>
    html.querySelector('[data-witcher-deflect]')?.addEventListener('click', () => {
      const target = [...game.user.targets][0]?.document;
      if (!target) return ui.notifications.error('Target a token within 10 m.');
      runCommand('deflectProjectile', { messageUuid: message.uuid, targetTokenUuid: target.uuid }).catch(
        errorNotice
      );
    })
  );
}
