import { promptCoverDecision } from "./cover-decision.js";
import { clonePlainData, compactPlainObject } from "./combat-snapshot.js";

const TARGET_UPDATE_BLOCKS = Object.freeze(["target-damage", "target-armor", "target-saves"]);

export async function detectAndPromptTacticalRaycasts(attackerToken, targetTokens) {
  const targets = Array.from(targetTokens || []);
  const canvasRef = globalThis.canvas;
  if (!canvasRef?.ready || !canvasRef?.walls) {
    return targets.map(target => withManualRaycast(target, "Raycast map context is unavailable."));
  }

  const attackerOrigin = attackerToken?.center || attackerToken?.bounds?.center;
  if (!attackerOrigin) {
    return targets.map(target => withManualRaycast(target, "Attacker token origin is unavailable for tactical raycast."));
  }

  const firstLivingTarget = findFirstLivingTarget(targets, attackerOrigin);
  const augmentedTargets = [];

  for (const target of targets) {
    const targetOrigin = target.center || target.bounds?.center;
    if (!targetOrigin) {
      augmentedTargets.push(withManualRaycast(target, "Target token origin is unavailable for tactical raycast."));
      continue;
    }

    let raycastOrigin = attackerOrigin;
    if (target.tactical?.template?.type === "circle" && target.tactical?.template?.origin) {
      raycastOrigin = target.tactical.template.origin;
    }

    let collision = null;
    const polygonBackends = globalThis.CONFIG?.Canvas?.polygonBackends || {};
    const collisionBackend = polygonBackends.move || polygonBackends.movement || polygonBackends.sight;
    try {
      if (typeof collisionBackend?.testCollision === "function") {
        collision = collisionBackend.testCollision(raycastOrigin, targetOrigin, { mode: "closest", type: "move" });
      } else {
        augmentedTargets.push(withManualRaycast(target, "Raycast collision backend is unavailable."));
        continue;
      }
    } catch (e) {
      console.warn("Tactical raycast collision backend crashed:", e);
      augmentedTargets.push(withManualRaycast(target, "Raycast collision backend crashed; resolve manually."));
      continue;
    }

    if (!collision) {
      augmentedTargets.push(withoutStaleRaycastCover(target));
      continue;
    }

    const wallDocument = getCollisionWallDocument(collision);
    const obstruction = {
      id: wallDocument?.id || "unknown-wall",
      uuid: wallDocument?.uuid || "unknown-uuid",
      type: "wall",
      name: wallDocument?.name || "Wall"
    };

    const distanceInMeters = calculateObstructionDistance(collision, raycastOrigin, canvasRef);
    if(!Number.isFinite(distanceInMeters)) {
      augmentedTargets.push(withManualRaycast(target, "Raycast obstruction distance is unavailable.", {
        origin: raycastOrigin,
        destination: targetOrigin,
        obstruction
      }));
      continue;
    }

    const decision = await promptCoverDecision(obstruction, target.name || "Target");
    if (decision.canceled) {
      augmentedTargets.push(withManualRaycast(target, "Raycast result requires GM decision before automated updates.", {
        origin: raycastOrigin,
        destination: targetOrigin,
        obstruction,
        obstructionDistance: distanceInMeters,
        firstTarget: isSameTarget(target, firstLivingTarget),
        requiresGmDecision: true
      }));
      continue;
    }

    augmentedTargets.push(withTacticalRaycast(target, {
      origin: raycastOrigin,
      destination: targetOrigin,
      obstruction,
      obstructionDistance: distanceInMeters,
      firstTarget: isSameTarget(target, firstLivingTarget),
      requiresGmDecision: false
    }, decision.cover));
  }

  return augmentedTargets;
}

/** Resolve a WallDocument from the public PolygonVertex -> EdgeSet -> object API. */
export function getCollisionWallDocument(collision) {
  const firstEdge = collision?.edges ? Array.from(collision.edges)[0] : undefined;
  const wallObject = firstEdge?.object;
  return wallObject?.document || wallObject || collision?.document;
}

function findFirstLivingTarget(targets, attackerOrigin) {
  return targets
    .filter(isLivingTarget)
    .map(target => ({
      target,
      distance: distanceBetween(attackerOrigin, target.center || target.bounds?.center)
    }))
    .filter(entry => Number.isFinite(entry.distance))
    .sort((left, right) => left.distance - right.distance)[0]?.target;
}

function isLivingTarget(target) {
  const damage = target.actor?.system?.damage || target.snapshot?.damage || {};
  const current = Number(damage.value ?? damage.current ?? 0);
  if(Number.isFinite(current) && current >= 41) {
    return false;
  }
  if(damage.deathSaveState?.dead === true) {
    return false;
  }
  return !!(target.actor || target.actorUuid || target.snapshot);
}

function distanceBetween(origin, destination) {
  if(!origin || !destination) {
    return undefined;
  }
  const dx = Number(destination.x) - Number(origin.x);
  const dy = Number(destination.y) - Number(origin.y);
  return Math.sqrt(dx * dx + dy * dy);
}

function calculateObstructionDistance(collision, attackerOrigin, canvasRef) {
  const pixelDistance = distanceBetween(attackerOrigin, collision);
  if(!Number.isFinite(pixelDistance)) {
    return undefined;
  }
  const gridSize = Number(canvasRef?.grid?.size);
  const gridDistance = Number(canvasRef?.scene?.grid?.distance);
  if(Number.isFinite(gridSize) && gridSize > 0 && Number.isFinite(gridDistance)) {
    return (pixelDistance / gridSize) * gridDistance;
  }
  return pixelDistance;
}

function withoutStaleRaycastCover(target) {
  const nextTarget = { 
    document: target?.document,
    actor: target?.actor,
    actorUuid: target?.actorUuid || target?.actor?.uuid,
    tokenUuid: target?.tokenUuid || target?.document?.uuid,
    id: target?.id,
    uuid: target?.uuid,
    name: target?.name,
    center: target?.center,
    bounds: target?.bounds,
    snapshot: target?.snapshot,
    manualResolution: target?.manualResolution,
    warnings: target?.warnings,
    ...(target || {}) 
  };
  const tactical = clonePlainData(target?.tactical) || {};
  delete tactical.raycast;
  delete tactical.cover;
  nextTarget.tactical = compactPlainObject(tactical);
  return compactPlainObject(nextTarget);
}

function withTacticalRaycast(target, raycast, cover) {
  const nextTarget = withoutStaleRaycastCover(target);
  nextTarget.tactical = compactPlainObject({
    ...(nextTarget.tactical || {}),
    raycast: clonePlainData(raycast),
    ...(cover ? { cover: clonePlainData(cover) } : {})
  });
  return compactPlainObject(nextTarget);
}

function withManualRaycast(target, message, raycast = {}) {
  const nextTarget = withTacticalRaycast(target, {
    ...raycast,
    requiresGmDecision: true
  });
  nextTarget.manualResolution = {
    ...(nextTarget.manualResolution || {}),
    required: true,
    reason: nextTarget.manualResolution?.reason || "pending-user-decision",
    message: nextTarget.manualResolution?.message || message,
    blockedUpdateCategories: mergeBlockedUpdateCategories(nextTarget.manualResolution?.blockedUpdateCategories)
  };
  nextTarget.warnings = [
    ...(nextTarget.warnings || []),
    {
      code: "manual-tactical-raycast",
      severity: "warning",
      message
    }
  ];
  return nextTarget;
}

function mergeBlockedUpdateCategories(existing = []) {
  return [...new Set([...(existing || []), ...TARGET_UPDATE_BLOCKS])];
}

function isSameTarget(left, right) {
  if(!left || !right) {
    return false;
  }
  return !!(
    (left.id && left.id === right.id) ||
    (left.uuid && left.uuid === right.uuid) ||
    (left.tokenUuid && left.tokenUuid === right.tokenUuid) ||
    (left.actorUuid && left.actorUuid === right.actorUuid)
  );
}
