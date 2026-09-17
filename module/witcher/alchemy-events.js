import { SYSTEM_ID } from './config.js';
import { activeAlchemy } from './alchemy-rules.js';
import { RuleError } from './rules.js';
import { immuneTo } from './monster-rules.js';
import { registerCommand, runCommand, authorizedActor } from './authority.js';
import { commitActor, chat, prompt, input, escapeHTML as e } from './runtime.js';

/** Recoil uses native collision tests, stops at walls/scene boundaries, and never teleports. */
export function bloodRecoilPlan(source, target, dimensions) {
  if (!source || !target || source.scene?.id !== target.scene?.id)
    throw new RuleError('Display both tokens on the same scene to resolve Black Blood recoil.');
  const dx = target.center.x - source.center.x,
    dy = target.center.y - source.center.y,
    length = Math.hypot(dx, dy);
  if (!length) throw new RuleError('Separate overlapping tokens so the recoil direction is defined.');
  const distance = (2 * dimensions.size) / dimensions.distance;
  const displacement = { x: (dx / length) * distance, y: (dy / length) * distance };
  const rect = dimensions.sceneRect;
  const valid = (part) => {
    const point = { x: target.center.x + displacement.x * part, y: target.center.y + displacement.y * part };
    return (
      point.x - target.w / 2 >= rect.x &&
      point.y - target.h / 2 >= rect.y &&
      point.x + target.w / 2 <= rect.right &&
      point.y + target.h / 2 <= rect.bottom &&
      !target.checkCollision(point, { type: 'move', mode: 'any' })
    );
  };
  let low = 0,
    high = 1;
  if (valid(1)) low = 1;
  else
    for (let i = 0; i < 20; i++) {
      const mid = (low + high) / 2;
      if (valid(mid)) low = mid;
      else high = mid;
    }
  return { x: target.document.x + displacement.x * low, y: target.document.y + displacement.y * low };
}

export async function blackBloodIngestion(actor) {
  const sourceToken = actor.token ?? actor.getActiveTokens()?.[0]?.document;
  const targetToken = [...game.user.targets][0]?.document;
  if (!game.user.isGM) throw new RuleError('The GM confirms which creature actually drank the blood.');
  if (!sourceToken || !targetToken)
    throw new RuleError('Select the Black Blood drinker and target the creature that drank their blood.');
  const result = await prompt(
    'Black Blood: blood ingestion',
    `<p>${e(targetToken.actor.name)} actually drank ${e(actor.name)}’s blood. Apply poison and 2 m recoil (Core p.247).</p>`,
    { button: 'Apply ingestion' }
  );
  if (!result) return;
  return runCommand('blackBlood', {
    actorUuid: actor.uuid,
    sourceTokenUuid: sourceToken.uuid,
    targetTokenUuid: targetToken.uuid,
  });
}

export async function executeBlackBlood({ actorUuid, sourceTokenUuid, targetTokenUuid }, { user, id }) {
  if (!user?.isGM) throw new RuleError('The GM confirms blood ingestion.');
  const source = await authorizedActor(actorUuid, user);
  if (!activeAlchemy(source.system, 'black-blood')) throw new RuleError('Black Blood is no longer active.');
  const sourceDoc = await foundry.utils.fromUuid(sourceTokenUuid),
    targetDoc = await foundry.utils.fromUuid(targetTokenUuid);
  const target = targetDoc?.actor;
  if (!target || sourceDoc?.actor?.uuid !== source.uuid || target.uuid === source.uuid)
    throw new RuleError('Choose the actual blood source and another creature.');
  const recoil = bloodRecoilPlan(sourceDoc.object, targetDoc.object, canvas.dimensions);
  const receipt = `black-blood:${id}`;
  if (target.system.combat.applied.includes(receipt)) return;
  const immune = immuneTo(target.system, 'poison');
  const effects = structuredClone(target.system.effects);
  if (!immune)
    effects.push({
      id: foundry.utils.randomID(),
      key: 'Black Blood poison',
      expires: 0,
      conditions: ['poison'],
      dc: 20,
      alchemy: {
        key: 'black-blood-poison',
        kind: 'condition',
        poison: true,
        sourceUuid: source.uuid,
        addedPoison: !target.system.conditions.includes('poison'),
      },
    });
  const before = { x: targetDoc.x, y: targetDoc.y };
  return commitActor(
    target,
    {
      'system.effects': effects,
      'system.conditions': immune
        ? target.system.conditions
        : [...new Set([...target.system.conditions, 'poison'])],
      'system.combat.applied': [...target.system.combat.applied, receipt],
    },
    [],
    async () => {
      let moved = false;
      try {
        await targetDoc.update(recoil);
        moved = true;
        return await chat(
          target,
          'Black Blood',
          `<p>${immune ? 'Immune to poison.' : 'Poison: 3 HP each round; Endurance DC20 to end.'} Recoils up to 2 m, stopping at obstacles.</p>`,
          { flags: { kind: 'blackBlood', receipt, actorUuid: target.uuid } }
        );
      } catch (error) {
        if (moved) await targetDoc.update(before);
        throw error;
      }
    }
  );
}

export function registerAlchemyEvents() {
  registerCommand('blackBlood', executeBlackBlood);
}
