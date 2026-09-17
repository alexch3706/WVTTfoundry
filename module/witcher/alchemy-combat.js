import { SYSTEM_ID } from './config.js';
import { activeAlchemy } from './alchemy-rules.js';
import { alchemyStrikeEffects, alchemyEndCombatEffects } from './alchemy-combat-rules.js';
import { RuleError } from './rules.js';
import { registerCommand, runCommand } from './authority.js';
import { actorFromUuid, commitActor, chat, escapeHTML as e, serial, errorNotice } from './runtime.js';
import { isPrimaryActiveGm } from '../foundry-compat.js';
import { gainAdrenaline, retainAdrenaline } from './adrenaline.js';
import { rejuvenationPlan } from './enhancement-combat.js';

const eventPath = `flags.${SYSTEM_ID}.alchemyLastHit`;
const actors = () => [
  ...new Map(
    [
      ...(game.actors ?? []),
      ...[...(game.scenes ?? [])].flatMap((scene) =>
        [...scene.tokens].map((token) => token.actor).filter(Boolean)
      ),
    ].map((actor) => [actor.uuid, actor])
  ).values(),
];

export function alchemyHitRecord(message, data) {
  if (!data.summary?.some((result) => result.damage > 0 && !result.nonlethal) && !data.wound?.fatal)
    return {};
  return {
    [eventPath]: {
      receipt: `alchemy:${data.attackRef || message.uuid}`,
      attackerUuid: data.actorUuid,
      combatId: data.combatId ?? '',
      messageUuid: message.uuid,
    },
  };
}

/** Called only after a GM-accepted damage packet; effect receipts make retries safe. */
export async function applyAlchemyStrike(message, target, data) {
  const attacker = await actorFromUuid(data.actorUuid);
  if (!attacker) return;
  const struck =
    !data.magicCastId &&
    data.request?.some((request) => !request.properties?.magic && !request.properties?.environmental) &&
    data.summary.some((result) => result.afterShield > 0 && !result.immune);
  const combatId = game.combat?.started && game.combat.id === data.combatId ? data.combatId : '';
  const receipt = `alchemy:${data.attackRef || message.uuid}`;
  const effects = alchemyStrikeEffects(attacker.system, {
    receipt,
    combatId,
    struck,
  });
  if (JSON.stringify(effects) !== JSON.stringify(attacker.system.effects))
    await commitActor(attacker, { 'system.effects': effects });
  const attackMessage = data.attackRef ? await foundry.utils.fromUuid(data.attackRef) : null;
  if (combatId) {
    await gainAdrenaline(attacker, receipt, {
      critical: !!data.criticalLevel,
      weapon: attackMessage?.flags?.[SYSTEM_ID]?.weapon,
    });
    await retainAdrenaline(attacker, `perun:${receipt}`, data.adrenalineRetained);
  }
  if (target.system.conditions.includes('dead')) await offerAlchemyKill(target);
}

/** Enemy status is a GM decision: reaching zero HP alone never awards a kill. */
export async function offerAlchemyKill(victim) {
  const event = victim.flags?.[SYSTEM_ID]?.alchemyLastHit;
  if (!event || !victim.system.conditions.includes('dead')) return;
  const attacker = await actorFromUuid(event.attackerUuid);
  if (!attacker || attacker.uuid === victim.uuid) return;
  const doseIds = ['blizzard', 'grave-hag-decoction']
    .map((key) => activeAlchemy(attacker.system, key)?.id)
    .filter(Boolean);
  const rejuvenation = !!(await rejuvenationPlan(victim, event));
  if (!doseIds.length && !rejuvenation) return;
  if (game.messages.some((message) => message.flags?.[SYSTEM_ID]?.alchemyKill === event.receipt)) return;
  await chat(
    attacker,
    'Kill benefits',
    `<p>${e(victim.name)} is dead. Confirm that ${e(attacker.name)} actually caused this death with the recorded attack. A prior hit alone does not establish the cause.</p>${doseIds.length ? '<button type="button" data-witcher-alchemy-kill="enemy">Confirm enemy kill (GM)</button>' : ''}${rejuvenation ? '<button type="button" data-witcher-alchemy-kill="creature">Confirm creature kill: Rejuvenation (GM)</button>' : ''}`,

    {
      flags: {
        kind: 'alchemyKill',
        alchemyKill: event.receipt,
        victimUuid: victim.uuid,
        doseIds,
        rejuvenation,
        ...event,
      },
    }
  );
}

export async function resolveAlchemyKill(message, user, { enemy = true } = {}) {
  if (!user?.isGM || !message?.author?.isGM) throw new RuleError('The GM confirms an enemy kill.');
  const data = message.flags?.[SYSTEM_ID];
  if (data?.kind !== 'alchemyKill') throw new RuleError('Not an alchemy kill result.');
  const victim = await actorFromUuid(data.victimUuid),
    attacker = await actorFromUuid(data.attackerUuid);
  if (!victim?.system.conditions.includes('dead') || !attacker)
    throw new RuleError('The slain creature or attacker has changed.');
  if (data.applied) return message;
  if (victim.flags?.[SYSTEM_ID]?.alchemyLastHit?.receipt !== data.receipt)
    throw new RuleError('The recorded killing attack has changed.');
  const effects = alchemyStrikeEffects(
    {
      ...attacker.system,
      effects: attacker.system.effects.filter((effect) => data.doseIds?.includes(effect.id)),
    },
    {
      receipt: `kill:${data.receipt}`,
      killed: enemy,
      victimUuid: `${victim.uuid}:${data.receipt}`,
      combatId: game.combat?.started && game.combat.id === data.combatId ? data.combatId : '',
    }
  );
  const rejuvenation = data.rejuvenation ? await rejuvenationPlan(victim, data) : null;
  return commitActor(
    attacker,
    {
      ...rejuvenation?.changes,
      'system.effects': attacker.system.effects.map(
        (effect) => effects.find((next) => next.id === effect.id) ?? effect
      ),
    },
    [],
    () =>
      message.update({
        [`flags.${SYSTEM_ID}.applied`]: true,
        content: `<article class="witcher-chat"><h3>${enemy ? 'Enemy' : 'Creature'} kill confirmed</h3><p>${e(attacker.name)} → ${e(victim.name)}${rejuvenation ? ` · Rejuvenation: up to ${attacker.system.derived.rec} STA` : ''}</p></article>`,
      })
  );
}

export function registerAlchemyCombat() {
  registerCommand('alchemyKill', async ({ messageUuid, enemy = true }, { user }) =>
    resolveAlchemyKill(await foundry.utils.fromUuid(messageUuid), user, { enemy })
  );
  Hooks.on('renderChatMessageHTML', (message, html) => {
    for (const button of html.querySelectorAll('[data-witcher-alchemy-kill]')) {
      button.hidden = !game.user.isGM;
      button.addEventListener('click', () =>
        runCommand('alchemyKill', {
          messageUuid: message.uuid,
          enemy: button.dataset.witcherAlchemyKill === 'enemy',
        }).catch(errorNotice)
      );
    }
  });
  Hooks.on('updateActor', (actor, changes) => {
    if (!isPrimaryActiveGm() || !actor.system.conditions.includes('dead')) return;
    if (changes.system?.conditions || changes['system.conditions'])
      serial('witcher-authority', () => offerAlchemyKill(actor)).catch(errorNotice);
  });
  const endCombat = (combat) => {
    if (!isPrimaryActiveGm()) return;
    serial('witcher-authority', async () => {
      for (const actor of actors()) {
        const effects = alchemyEndCombatEffects(actor.system, combat.id);
        if (JSON.stringify(effects) !== JSON.stringify(actor.system.effects))
          await commitActor(actor, { 'system.effects': effects });
      }
    }).catch(errorNotice);
  };
  Hooks.on('deleteCombat', endCombat);
  Hooks.on('updateCombat', (combat, changes) => {
    if (changes.round === 0) endCombat(combat);
  });
}
