/** Shining (Tome112): native daylight source and source-owned sunlight exposure. */
import { SYSTEM_ID } from './config.js';
import { RuleError } from './rules.js';
import { enhancementBenefits } from './enhancements.js';
import { registerCommand, authorizedActor, runCommand } from './authority.js';
import { actionPlan, commitActor, chat, serial, errorNotice } from './runtime.js';
import { isPrimaryActiveGm, getTokenCenterPoint } from '../foundry-compat.js';
import { magicSceneScale } from './magic-regions.js';

const values = (collection) => collection?.contents ?? [...(collection ?? [])];
const copy = (value) => structuredClone(value);
const state = (light) => light.flags?.[SYSTEM_ID]?.shining;
const now = () => Number(game.time.worldTime);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const sourceData = (document) => document.toObject?.() ?? copy(document._source ?? document);

export function shiningDaylight(state, time = globalThis.game?.time?.worldTime ?? 0) {
  return (state?.effects ?? []).some(
    (effect) =>
      effect.enhancement?.shiningDaylight && !effect.disabled && (!effect.expires || effect.expires > time)
  );
}
function wearable(token, itemId) {
  const item = token?.actor?.items?.get(itemId);
  return (
    item?.type === 'armor' &&
    item.system.equipped &&
    item.system.carried !== false &&
    item.system.quantity > 0 &&
    enhancementBenefits(item).words.includes('shining')
  );
}
export function shiningLightData(token, itemId, { id, expires = now() + 1800 } = {}) {
  const scene = token.parent,
    scale = magicSceneScale(scene),
    center = getTokenCenterPoint(token);
  if (!center) throw new RuleError('Shining requires a placed token with a native center point.');
  return {
    _id: id,
    name: `Shining — ${token.name ?? token.actor?.name ?? 'armor'}`,
    x: Math.round(center.x),
    y: Math.round(center.y),
    elevation: center.elevation,
    levels: [token.level ?? sourceData(token).level],
    walls: true,
    vision: false,
    hidden: false,
    locked: true,
    config: {
      bright: 6 / scale.metresPerUnit,
      dim: 0,
      angle: 360,
      attenuation: 0,
      luminosity: 1,
      alpha: 0,
      negative: false,
      darkness: { min: 0, max: 1 },
    },
    flags: {
      [SYSTEM_ID]: {
        shining: {
          actorUuid: token.actor.uuid,
          tokenId: token.id,
          itemId,
          expires,
          radiusMetres: 6,
          sunlight: true,
          volumeConvention: 'current-scene-level',
        },
      },
    },
  };
}

/** Test native wall-constrained light, token footprint and V14 scene level. */
export function shiningContains(light, token) {
  if (!token.actor || light.hidden || state(light)?.expires <= now()) return false;
  const levels = values(light.levels),
    level = token.level ?? sourceData(token).level;
  if (levels.length && !levels.includes(level)) return false;
  const shape = light.object?.lightSource?.shape;
  if (typeof shape?.contains !== 'function')
    throw new RuleError(
      'The native Shining light source is not ready. View this scene before resolving daylight exposure.'
    );
  const points = token.getContainmentTestPoints?.(sourceData(token)) ?? [getTokenCenterPoint(token)];
  return points.some((point) => point && shape.contains(point.x, point.y));
}

function exposurePlan(actor, sources) {
  const before = actor.system.effects ?? [],
    ordinary = before.filter((effect) => !effect.enhancement?.shiningDaylight);
  const unique = [...new Map(sources.map((row) => [row.uuid, row])).values()].sort((a, b) =>
    a.uuid.localeCompare(b.uuid)
  );
  const effects = unique.length
    ? [
        ...ordinary,
        {
          id: `shining-${actor.id}`,
          key: 'Shining Daylight',
          expires: Math.max(...unique.map((row) => row.expires)),
          enhancement: { shiningDaylight: true, sources: unique },
        },
      ]
    : ordinary;
  return same(before, effects) ? null : { before: copy(before), effects };
}

/** Cleanup and overlap reconciliation. Returns rollback for a surrounding action. */
export async function reconcileShining({ scenes = values(game.scenes), strictScene = null } = {}) {
  const undo = [],
    exposure = new Map(),
    trackedActors = new Map();
  const rollback = async () => {
    const errors = [];
    for (const action of [...undo].reverse())
      try {
        await action();
      } catch (error) {
        errors.push(error);
      }
    if (errors.length) throw new AggregateError(errors, 'Shining rollback was incomplete.');
  };
  try {
    for (const scene of scenes) {
      const viewed = globalThis.canvas?.ready && canvas.scene?.id === scene.id;
      if (strictScene === scene.id && !viewed)
        throw new RuleError('View the Shining token’s scene on a ready V14 canvas.');
      const valid = [];
      for (const light of values(scene.lights).filter((entry) => state(entry))) {
        const data = state(light),
          token = scene.tokens.get(data.tokenId);
        if (
          data.expires <= now() ||
          !token ||
          token.actor?.uuid !== data.actorUuid ||
          !wearable(token, data.itemId)
        ) {
          const previous = sourceData(light);
          undo.push(() =>
            scene.lights.get(light.id)
              ? null
              : scene.createEmbeddedDocuments('AmbientLight', [previous], { keepId: true })
          );
          await scene.deleteEmbeddedDocuments('AmbientLight', [light.id]);
          continue;
        }
        const expected = shiningLightData(token, data.itemId, { id: light.id, expires: data.expires });
        const changed = {};
        for (const field of ['x', 'y', 'elevation', 'levels']) {
          const current = field === 'levels' ? values(light.levels) : light[field];
          if (!same(current, expected[field])) changed[field] = expected[field];
        }
        if (Object.keys(changed).length) {
          const previous = sourceData(light),
            inverse = Object.fromEntries(Object.keys(changed).map((field) => [field, previous[field]]));
          undo.push(() => light.update(inverse));
          await light.update(changed);
        }
        if (viewed) {
          light.object?.initializeLightSource?.();
          valid.push(light);
        }
      }
      // Native light geometry belongs to the viewed canvas. Preserve off-scene
      // sources until that scene is viewed, but remove expired/deleted sources below.
      const liveUuids = new Set(
        values(scene.lights)
          .filter((entry) => state(entry))
          .map((entry) => entry.uuid)
      );
      for (const token of values(scene.tokens)) {
        const actor = token.actor;
        if (!actor) continue;
        trackedActors.set(actor.uuid, actor);
        const list = exposure.get(actor.uuid) ?? [];
        if (viewed) {
          for (const light of valid)
            if (shiningContains(light, token))
              list.push({ uuid: light.uuid, sceneId: scene.id, expires: state(light).expires });
        } else {
          for (const effect of actor.system.effects ?? [])
            if (effect.enhancement?.shiningDaylight)
              list.push(
                ...effect.enhancement.sources.filter(
                  (entry) => entry.sceneId === scene.id && liveUuids.has(entry.uuid) && entry.expires > now()
                )
              );
        }
        exposure.set(actor.uuid, list);
      }
    }
    for (const actor of values(game.actors))
      if ((actor.system.effects ?? []).some((effect) => effect.enhancement?.shiningDaylight))
        trackedActors.set(actor.uuid, actor);
    for (const [uuid, actor] of trackedActors) {
      const plan = exposurePlan(actor, exposure.get(uuid) ?? []);
      if (!plan) continue;
      undo.push(() => actor.update({ 'system.effects': plan.before }));
      await actor.update({ 'system.effects': plan.effects });
    }
    return { rollback };
  } catch (error) {
    await rollback();
    throw error;
  }
}

export async function activateShining(actor, item, token = null) {
  token ??= actor.getActiveTokens?.(true, true)?.[0];
  token = token?.document ?? token;
  if (!token) throw new RuleError('Place and select this actor’s token on the scene.');
  return runCommand('shining', {
    actorUuid: actor.uuid,
    itemId: item.id,
    sceneId: token.parent.id,
    tokenId: token.id,
  });
}

export function registerShining() {
  registerCommand('shining', async (payload, { user }) => {
    const actor = await authorizedActor(payload.actorUuid, user),
      scene = game.scenes.get(payload.sceneId),
      token = scene?.tokens.get(payload.tokenId);
    if (token?.actor?.uuid !== actor.uuid || !wearable(token, payload.itemId))
      throw new RuleError('Shining requires this actor’s placed token and worn Shining torso armor.');
    if (!canvas.ready || canvas.scene?.id !== scene.id)
      throw new RuleError(
        'The active GM must view the Shining scene to initialize native daylight exposure.'
      );
    if (
      values(game.scenes).some((entry) =>
        values(entry.lights).some(
          (light) => state(light)?.actorUuid === actor.uuid && state(light).expires > now()
        )
      )
    )
      throw new RuleError(
        'This actor already has active Shining daylight; identical glyphwords do not stack.'
      );
    const action = actionPlan(actor, { actionKey: 'shining' }),
      id = foundry.utils.randomID();
    const data = shiningLightData(token, payload.itemId, { id });
    let exposure;
    try {
      return await commitActor(actor, action.changes, [], async () => {
        const [light] = await scene.createEmbeddedDocuments('AmbientLight', [data], { keepId: true });
        light.object?.initializeLightSource?.();
        exposure = await reconcileShining({ strictScene: scene.id });
        return chat(
          actor,
          'Shining daylight',
          '<p>An action activates 6m of daylight for 30 minutes. Light follows the worn armor, respects native light walls and affects represented sunlight weaknesses (including Katakan regeneration). The printed radius has no height; this source uses the token’s scene level.</p>'
        );
      });
    } catch (error) {
      if (exposure) await exposure.rollback();
      if (scene.lights.get(id)) await scene.deleteEmbeddedDocuments('AmbientLight', [id]);
      throw error;
    }
  });
  const refresh = () => {
    if (isPrimaryActiveGm()) serial('witcher-authority', () => reconcileShining()).catch(errorNotice);
  };
  for (const hook of [
    'canvasReady',
    'updateWorldTime',
    'updateToken',
    'deleteToken',
    'updateItem',
    'deleteItem',
    'createWall',
    'updateWall',
    'deleteWall',
    'deleteAmbientLight',
  ])
    Hooks.on(hook, refresh);
}
