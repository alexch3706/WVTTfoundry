import { RuleError } from './rules.js';
import { authorizedActor, registerCommand, runCommand } from './authority.js';
import { triggerMagicOngoing } from './magic-ongoing.js';

export function hasCursedIllness(state, condition) {
  return (state.effects ?? []).some(
    (effect) =>
      !effect.disabled &&
      !effect.magic?.suppressed &&
      effect.magic?.key === 'cursed-illness' &&
      (!condition || effect.conditions?.includes(condition))
  );
}

export function requestMagicRecovery(actor, effectId) {
  return runCommand('magicRecoveryRequest', { actorUuid: actor.uuid, effectId });
}

export function registerMagicRecovery() {
  registerCommand('magicRecoveryRequest', async ({ actorUuid, effectId }, { user, id }) => {
    const actor = await authorizedActor(actorUuid, user);
    const effect = actor.system.effects.find((row) => row.id === effectId);
    if (
      !effect ||
      effect.disabled ||
      effect.magic?.suppressed ||
      effect.magic?.key !== 'cursed-illness' ||
      !effect.magic.ongoing?.managed ||
      !effect.magic.operations?.some((operation) => operation.rule?.key === 'illnessRecovery')
    )
      throw new RuleError('This effect has no Cursed Illness recovery procedure.');
    const pending = Object.values(effect.magic.ongoing.pending ?? {}).find((row) => row.kind === 'save');
    if (pending) return { messageUuid: pending.messageUuid, pending: true };
    return triggerMagicOngoing(actor, {
      id: `illness:${id}`,
      kind: 'enduranceSave',
      effectId,
      actorUuid,
      cycle: `illness:${id}`,
    });
  });
}
