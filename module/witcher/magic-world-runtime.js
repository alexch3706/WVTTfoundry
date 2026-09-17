import { SYSTEM_ID } from './config.js';
import { RuleError } from './rules.js';
import { registerCommand, runCommand } from './authority.js';
import {
  registerWorldMagicDecisionHandlers,
  resolveWorldMagicDecision,
  expireWorldItemMagic,
} from './magic-world-effects.js';
import { serial, errorNotice } from './runtime.js';
import { isPrimaryActiveGm } from '../foundry-compat.js';

const rows = (collection) => Array.from(collection?.values?.() ?? collection ?? []);
function actors() {
  return [
    ...new Map(
      [
        ...rows(game.actors),
        ...rows(game.scenes).flatMap((scene) =>
          rows(scene.tokens)
            .map((token) => token.actor)
            .filter(Boolean)
        ),
      ].map((actor) => [actor.uuid, actor])
    ).values(),
  ];
}

/** Reversible restoration of enchanted equipment, including overlapping sources. */
export async function endWorldItemCast(castId) {
  const undo = [];
  const rollback = async () => {
    for (const [item, source] of undo.reverse())
      await item.update(
        { system: source.system, flags: source.flags },
        { diff: false, recursive: false, witcherMagicRollback: true }
      );
  };
  try {
    for (const actor of actors())
      for (const item of actor.items) {
        if (!item.flags?.[SYSTEM_ID]?.magicItemEffects?.some((effect) => effect.castId === castId)) continue;
        undo.push([item, item.toObject()]);
        await expireWorldItemMagic(item, castId);
      }
    return { rollback };
  } catch (error) {
    await rollback();
    throw error;
  }
}

export async function tickWorldItemMagic({ time = game.time.worldTime } = {}) {
  const expired = new Set();
  for (const actor of actors())
    for (const item of actor.items)
      for (const effect of item.flags?.[SYSTEM_ID]?.magicItemEffects ?? [])
        if (Number.isFinite(effect.expiresAt) && effect.expiresAt <= time) expired.add(effect.castId);
  for (const castId of expired) await endWorldItemCast(castId);
  return [...expired];
}

export function registerWorldMagicRuntime({ refreshCard }) {
  registerCommand('magicWorldDecision', async ({ messageUuid, outcome, answer }, { user }) => {
    if (!user.isGM) throw new RuleError('Only the GM resolves hidden magical information.');
    const message = await foundry.utils.fromUuid(messageUuid);
    if (!message?.author?.isGM) throw new RuleError('This is not a GM-authorized magic decision.');
    const result = await resolveWorldMagicDecision(message, { outcome, answer }, { user });
    const parent = await foundry.utils.fromUuid(message.flags[SYSTEM_ID].parentMagicMessage);
    if (!parent?.author?.isGM) return result;
    const decisions = rows(game.messages).filter(
      (entry) => entry.flags?.[SYSTEM_ID]?.parentMagicMessage === parent.uuid
    );
    const data = structuredClone(parent.flags[SYSTEM_ID]);
    for (const row of data.targets)
      if (row.status === 'pendingGM') {
        const pending = decisions.filter(
          (entry) => entry.flags[SYSTEM_ID].parentTargetUuid === row.tokenUuid
        );
        if (
          pending.length &&
          pending.every((entry) => entry.flags[SYSTEM_ID].magicDecision.status !== 'pendingGM')
        )
          row.status = pending.some((entry) => entry.flags[SYSTEM_ID].magicDecision.status === 'declined')
            ? 'declined'
            : 'applied';
      }
    data.pendingGM = decisions.some((entry) => entry.flags[SYSTEM_ID].magicDecision?.status === 'pendingGM');
    data.applied =
      !data.pendingGM &&
      data.targets.every((row) => ['applied', 'defended', 'declined'].includes(row.status));
    await refreshCard(parent, data);
    return result;
  });
  registerWorldMagicDecisionHandlers({
    submitDecision: (messageUuid, values) => runCommand('magicWorldDecision', { messageUuid, ...values }),
  });
  const schedule = () => {
    if (isPrimaryActiveGm()) serial('witcher-authority', () => tickWorldItemMagic()).catch(errorNotice);
  };
  Hooks.on('updateWorldTime', schedule);
  Hooks.on('updateCombat', schedule);
  schedule();
}
