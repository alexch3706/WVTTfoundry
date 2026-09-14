import { buildActorCombatSnapshot } from "./combat-snapshot.js";
import {
  buildAoERegionData,
  buildSuppressiveFireRegionData,
  getPrimaryRegionShape,
  getRegionDocument,
  getTokenCenter,
  pixelsToSceneUnits,
  placeCombatRegion,
  regionContainsToken
} from "./region-zones.js";

export const AOE_TEMPLATE_CHOICE = Object.freeze({
  template: "template",
  normal: "normal",
  canceled: "canceled"
});

export const SUPPRESSIVE_TEMPLATE_CHOICE = Object.freeze({
  template: "template",
  normal: "normal",
  canceled: "canceled"
});

export async function promptUseAoETemplate(item) {
  const aoeType = item?.system?.aoe?.type;
  const name = aoeType ? `${aoeType} Template` : "Cone Template";

  return new Promise((resolve) => {
    new Dialog({
      title: "Area of Effect Attack",
      content: `<p>Do you want to draw a ${name.toLowerCase()} for this attack or roll normally against selected targets?</p>`,
      buttons: {
        template: {
          label: `Draw ${name}`,
          callback: () => resolve(AOE_TEMPLATE_CHOICE.template)
        },
        normal: {
          label: "Normal Roll",
          callback: () => resolve(AOE_TEMPLATE_CHOICE.normal)
        },
        cancel: {
          label: "Cancel Attack",
          callback: () => resolve(AOE_TEMPLATE_CHOICE.canceled)
        }
      },
      default: "template",
      close: () => resolve(AOE_TEMPLATE_CHOICE.canceled)
    }).render(true);
  });
}

export const promptUseShotgunTemplate = promptUseAoETemplate;

export async function promptAutoshotgunShellCount(item, maxShells) {
  const boundedMax = Math.max(0, Math.floor(Number(maxShells) || 0));
  if(boundedMax <= 0) {
    ui.notifications?.warn("Autoshotgun has no available shells to fire.");
    return null;
  }

  return new Promise((resolve) => {
    new Dialog({
      title: "Autoshotgun Full Auto",
      content: `
        <form>
          <div class="form-group">
            <label>Shells Fired (Max ${boundedMax}):</label>
            <input type="number" id="autoshotgunShells" value="${boundedMax}" min="1" max="${boundedMax}" />
          </div>
        </form>
      `,
      buttons: {
        confirm: {
          label: "Place Patterns",
          callback: (html) => {
            const rawValue = parseInt(html.find("#autoshotgunShells").val(), 10);
            const shellCount = Math.max(1, Math.min(boundedMax, Number.isFinite(rawValue) ? rawValue : boundedMax));
            resolve(shellCount);
          }
        },
        cancel: {
          label: "Cancel",
          callback: () => resolve(null)
        }
      },
      default: "confirm",
      close: () => resolve(null)
    }).render(true);
  });
}

export async function drawAutoshotgunPatternsAndGetTargets(item, attackerToken, shellCount, options = {}) {
  const drawPattern = typeof options.drawPattern === "function"
    ? options.drawPattern
    : (patternItem, patternAttackerToken) => drawAoETemplateAndGetTargets(patternItem, patternAttackerToken);
  const patterns = [];
  const count = Math.max(0, Math.floor(Number(shellCount) || 0));

  for(let index = 0; index < count; index++) {
    const shellIndex = index + 1;
    const placement = await drawPattern(item, attackerToken, shellIndex);
    if(placement?.canceled === true) {
      return {
        patterns,
        canceled: true,
        canceledShellIndex: shellIndex
      };
    }
    const affectedTargets = Array.isArray(placement)
      ? placement
      : placement?.affectedTargets || [];
    const template = extractAutoshotgunTemplateEvidence(placement, affectedTargets);

    patterns.push({
      shellIndex,
      template,
      affectedTargets: affectedTargets.map(target => buildAutoshotgunTargetEvidence(target)),
      ...(!template ? {
        warnings: [{
          code: "autoshotgun-pattern-canceled",
          severity: "warning",
          message: `Autoshotgun shell ${shellIndex} has no template evidence; resolve this shell manually.`
        }]
      } : {})
    });
  }

  return { patterns };
}

export function buildAoETemplateTargetingOptions({ selectedTargets = [], affectedTargets = [], hazardZone = undefined } = {}) {
  const selected = Array.from(selectedTargets || []).map(target => markShotgunTargetSelection(target, true));
  const affected = Array.from(affectedTargets || []).map(target => markShotgunAffectedToken(target));
  const template = buildShotgunTemplateContext(affected, selected);
  const raycastTargets = mergeShotgunRaycastTargets(selected, affected);

  return {
    targets: selected,
    template,
    hazardZone: buildAoEHazardZone(hazardZone || template, affected.length),
    raycastTargets
  };
}

export const buildShotgunTemplateTargetingOptions = buildAoETemplateTargetingOptions;

function extractAutoshotgunTemplateEvidence(placement, affectedTargets = []) {
  const affectedTemplate = affectedTargets.find(target => target?.tactical?.template)?.tactical?.template;
  if(affectedTemplate) {
    return clonePlainData(affectedTemplate);
  }
  const hazardZone = placement?.hazardZone;
  if(!hazardZone) {
    return undefined;
  }
  return clonePlainData({
    templateUuid: hazardZone.templateUuid,
    templateId: hazardZone.templateId,
    regionUuid: hazardZone.regionUuid,
    regionId: hazardZone.regionId,
    type: hazardZone.type,
    origin: hazardZone.origin,
    direction: hazardZone.direction,
    angle: hazardZone.angle,
    width: hazardZone.width,
    distance: hazardZone.distance,
    inclusion: hazardZone.inclusion
  });
}

function buildAutoshotgunTargetEvidence(target) {
  const actor = target?.actor || target?.document?.actor;
  const tactical = compactPlainObject({
    template: clonePlainData(target?.tactical?.template),
    cover: clonePlainData(target?.tactical?.cover),
    raycast: clonePlainData(target?.tactical?.raycast)
  });

  return compactPlainObject({
    id: target?.id,
    uuid: target?.uuid,
    tokenUuid: target?.tokenUuid || target?.document?.uuid || target?.uuid,
    actorUuid: target?.actorUuid || actor?.uuid,
    name: target?.name,
    center: clonePlainData(target?.center),
    bounds: clonePlainData(target?.bounds),
    snapshot: clonePlainData(target?.snapshot) || buildActorCombatSnapshot(actor, { includeEquipment: true }),
    distance: clonePlainData(target?.distance),
    tactical: Object.keys(tactical).length > 0 ? tactical : undefined,
    pendingDecisions: clonePlainData(target?.pendingDecisions),
    manualResolution: clonePlainData(target?.manualResolution),
    warnings: clonePlainData(target?.warnings)
  });
}

function markShotgunTargetSelection(target, selected) {
  return {
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
    ...(target || {}),
    selected,
    tactical: {
      ...(target?.tactical || {}),
      selected
    }
  };
}

function markShotgunAffectedToken(target) {
  const affected = markShotgunTargetSelection(target, false);
  const templateDistance = target?.tactical?.template?.targetDistance;
  if(Number.isFinite(Number(templateDistance)) && !affected.distance) {
    affected.distance = {
      value: Number(templateDistance),
      units: "m",
      source: "template"
    };
  }
  return affected;
}

function buildShotgunTemplateContext(affectedTargets, selectedTargets = []) {
  const templateEvidence = affectedTargets.find(target => target?.tactical?.template)?.tactical?.template;
  if(!templateEvidence) {
    return undefined;
  }
  const {
    targetDistance,
    ...template
  } = templateEvidence;
  return {
    ...template,
    affectedTargets: affectedTargets.map(target => stripSelectedOverlapDistance(target, selectedTargets))
  };
}

function buildAoEHazardZone(template, affectedTokenCount = 0) {
  if(!template) {
    return undefined;
  }
  return {
    kind: template.type === "cone" ? "shotgun-cone" : template.type,
    templateUuid: template.templateUuid,
    templateId: template.templateId,
    regionUuid: template.regionUuid,
    regionId: template.regionId,
    type: template.type,
    origin: clonePlainData(template.origin),
    direction: template.direction,
    angle: template.angle,
    width: template.width,
    distance: template.distance,
    inclusion: template.inclusion,
    affectedTokenCount,
    lifecycle: template.lifecycle || "transient"
  };
}

function clonePlainData(value) {
  if(value === undefined || value === null) {
    return value;
  }
  try {
    return JSON.parse(JSON.stringify(value));
  }
  catch {
    return undefined;
  }
}

function compactPlainObject(data = {}) {
  return Object.fromEntries(
    Object.entries(data).filter(([, value]) => value !== undefined)
  );
}

function stripSelectedOverlapDistance(target, selectedTargets) {
  const key = shotgunTargetKey(target);
  if(!key || !target?.distance || !selectedTargets.some(selected => shotgunTargetKey(selected) === key)) {
    return target;
  }
  const {
    distance,
    ...targetWithoutDistance
  } = target;
  return {
    ...targetWithoutDistance,
    tactical: {
      ...(targetWithoutDistance.tactical || {}),
      templateDistance: distance
    }
  };
}

function mergeShotgunRaycastTargets(selectedTargets, affectedTargets) {
  const merged = [];
  const seen = new Set();
  for(const target of [...selectedTargets, ...affectedTargets]) {
    const key = shotgunTargetKey(target);
    if(key && seen.has(key)) {
      const existingIndex = merged.findIndex(existing => shotgunTargetKey(existing) === key);
      if(existingIndex >= 0) {
        merged[existingIndex] = mergeShotgunTargetEvidence(merged[existingIndex], target);
      }
      continue;
    }
    if(key) {
      seen.add(key);
    }
    merged.push(target);
  }
  return merged;
}

function mergeShotgunTargetEvidence(selectedTarget, affectedTarget) {
  const affectedTemplate = affectedTarget?.tactical?.template;
  if(!affectedTemplate) {
    return selectedTarget;
  }
  return {
    ...selectedTarget,
    tactical: {
      ...(selectedTarget?.tactical || {}),
      template: affectedTemplate,
      selected: true
    }
  };
}

function shotgunTargetKey(target = {}) {
  return target.id || target.tokenUuid || target.actorUuid || target.uuid || target.document?.uuid || target.actor?.uuid;
}

export async function drawAoETemplateAndGetTargets(item, attackerToken) {
  const failPlacement = (error, message = "Area-of-effect placement failed. Attack canceled; please try again.") => {
    if(error) console.error("AoE Region placement failed:", error);
    globalThis.ui?.notifications?.warn(message);
    return { affectedTargets: [], canceled: true };
  };

  if(!globalThis.canvas?.ready) {
    return failPlacement(undefined, "Canvas is not ready. Attack canceled; cannot place an area of effect.");
  }

  const attackerOrigin = getTokenCenter(attackerToken);
  if(!attackerOrigin) {
    return failPlacement(undefined, "Attacker token origin not found. Attack canceled.");
  }

  const aoe = item?.system?.aoe || {};
  const aoeType = String(aoe.type || "cone").toLowerCase();
  const aoeDistance = Number(aoe.value) || 10;
  const directional = ["cone", "line", "ray"].includes(aoeType);

  try {
    const regionData = buildAoERegionData({
      type: aoeType,
      distance: aoeDistance,
      width: aoe.width,
      height: aoe.height,
      angle: aoe.angle ?? 45,
      origin: attackerOrigin,
      name: `${item?.name || "Attack"} Area of Effect`,
      color: globalThis.game?.user?.color,
      userId: globalThis.game?.user?.id
    });
    const placed = await placeCombatRegion(regionData, {
      create: false,
      ...(directional ? { anchorOrigin: attackerOrigin } : {})
    });
    if(!placed) return { affectedTargets: [], canceled: true };

    const region = getRegionDocument(placed);
    const shape = getPrimaryRegionShape(region);
    if(!shape || typeof region?.testPoint !== "function") {
      return failPlacement(undefined, "Placed area of effect could not be read. Attack canceled; please try again.");
    }

    const templateEvidence = buildRegionTemplateEvidence(region, shape, aoeType, aoeDistance);
    const attackerId = tokenIdentity(attackerToken);
    const affectedTargets = Array.from(globalThis.canvas?.tokens?.placeables || [])
      .filter(token => {
        if(directional && attackerId && tokenIdentity(token) === attackerId) return false;
        return regionContainsToken(region, token);
      })
      .map(token => {
        const center = getTokenCenter(token);
        const targetDistance = center
          ? pixelsToSceneUnits(Math.hypot(center.x - templateEvidence.origin.x, center.y - templateEvidence.origin.y))
          : undefined;
        token.tactical = token.tactical || {};
        token.tactical.template = compactPlainObject({
          ...templateEvidence,
          targetDistance
        });
        return token;
      });

    return {
      affectedTargets,
      hazardZone: buildAoEHazardZone(templateEvidence, affectedTargets.length)
    };
  } catch(error) {
    return failPlacement(error);
  }
}

function buildRegionTemplateEvidence(region, shape, type, fallbackDistance) {
  const regionId = region?.id || region?._id;
  const regionUuid = region?.uuid;
  const origin = {
    x: Number(shape?.x) || 0,
    y: Number(shape?.y) || 0
  };
  const measuredDistance = shape?.radius ?? shape?.length
    ?? (shape?.type === "rectangle" ? Math.max(Number(shape.width) || 0, Number(shape.height) || 0) : undefined);
  const measuredWidth = shape?.type === "line" || shape?.type === "rectangle"
    ? shape.width
    : measuredDistance;

  return compactPlainObject({
    templateUuid: regionUuid,
    templateId: regionId,
    regionUuid,
    regionId,
    type,
    origin,
    direction: Number(shape?.rotation) || 0,
    angle: shape?.angle === undefined ? undefined : Number(shape.angle),
    width: measuredWidth === undefined ? fallbackDistance : pixelsToSceneUnits(measuredWidth),
    distance: measuredDistance === undefined ? fallbackDistance : pixelsToSceneUnits(measuredDistance),
    inclusion: "intersected",
    lifecycle: "transient"
  });
}

function tokenIdentity(token) {
  return token?.id || token?.document?.id || token?._id || token?.document?._id;
}

export async function promptUseSuppressiveFireTemplate(weapon, maxRounds, { templateOnly = false } = {}) {
  const boundedMaxRounds = Math.max(1, Math.floor(Number(maxRounds) || 1));
  return new Promise((resolve) => {
    let content = `
      <form>
        <div class="form-group">
          <label>Rounds Fired (Max ${boundedMaxRounds}):</label>
          <input type="number" id="suppressiveRounds" value="${boundedMaxRounds}" min="1" max="${boundedMaxRounds}" />
        </div>
        <div class="form-group">
          <label>Zone Width (meters):</label>
          <input type="number" id="suppressiveWidth" value="2" min="1" />
        </div>
      </form>
    `;

    new Dialog({
      title: "Suppressive Fire",
      content: content,
      buttons: {
        template: {
          label: "Draw Corridor Template",
          callback: (html) => {
            const requestedRounds = Number.parseInt(html.find('#suppressiveRounds').val(), 10);
            const requestedWidth = Number.parseFloat(html.find('#suppressiveWidth').val());
            const roundsFired = Math.max(1, Math.min(
              boundedMaxRounds,
              Number.isFinite(requestedRounds) ? requestedRounds : boundedMaxRounds
            ));
            const zoneWidth = Math.max(1, Number.isFinite(requestedWidth) ? requestedWidth : 2);
            resolve({ choice: SUPPRESSIVE_TEMPLATE_CHOICE.template, roundsFired, zoneWidth });
          }
        },
        ...(!templateOnly ? { normal: {
          label: "Normal Attack",
          callback: () => resolve({ choice: SUPPRESSIVE_TEMPLATE_CHOICE.normal })
        }} : {}),
        cancel: {
          label: "Cancel Attack",
          callback: () => resolve({ choice: SUPPRESSIVE_TEMPLATE_CHOICE.canceled })
        }
      },
      default: "template",
      close: () => resolve({ choice: SUPPRESSIVE_TEMPLATE_CHOICE.canceled })
    }).render(true);
  });
}

const ACTIVE_SUPPRESSIVE_TRANSACTIONS = new WeakSet();

export async function placePersistentSuppressiveFireTemplate(attackerToken, weaponItem, bulletsFired, zoneWidth, maxDistance, { consumeAmmo = false } = {}) {
  const failPlacement = (error, message = "Suppressive-fire zone placement failed. Attack canceled; please try again.") => {
    if(error) console.error("Suppressive-fire Region placement failed:", error);
    globalThis.ui?.notifications?.warn(message);
    return false;
  };

  if(!globalThis.canvas?.ready) {
    return failPlacement(undefined, "Canvas is not ready. Attack canceled; cannot place a suppressive-fire zone.");
  }

  const origin = getTokenCenter(attackerToken);
  if(!origin) {
    return failPlacement(undefined, "Attacker token origin not found. Attack canceled.");
  }

  const scene = globalThis.canvas.scene;
  const beforeAmmo = Number(weaponItem?.system?.shotsLeft);
  const rounds = Number(bulletsFired);
  const validAmmo = () => Number.isInteger(rounds) && rounds > 0
    && Number.isInteger(beforeAmmo) && beforeAmmo >= rounds
    && Number.isInteger(Number(weaponItem?.system?.rof)) && Number(weaponItem.system.rof) >= rounds;
  if(consumeAmmo) {
    if(!validAmmo() || typeof weaponItem?.update !== "function") {
      return failPlacement(undefined, "Suppressive-fire ammunition is unavailable or insufficient. Review the attack again.");
    }
    if(ACTIVE_SUPPRESSIVE_TRANSACTIONS.has(weaponItem)) {
      return failPlacement(undefined, "A suppressive-fire attack with this weapon is already in progress.");
    }
    if(typeof scene?.createEmbeddedDocuments !== "function" || typeof scene?.regions?.get !== "function") {
      return failPlacement(undefined, "The Scene cannot safely create and verify a suppressive-fire zone. Attack canceled.");
    }
    ACTIVE_SUPPRESSIVE_TRANSACTIONS.add(weaponItem);
  }

  try {
    const tokenDocument = attackerToken?.document || attackerToken;
    const actor = attackerToken?.actor || tokenDocument?.actor;
    const regionData = buildSuppressiveFireRegionData({
      attackerTokenId: attackerToken?.id || tokenDocument?.id,
      attackerTokenUuid: tokenDocument?.uuid || attackerToken?.uuid,
      attackerActorId: actor?.id,
      attackerActorUuid: actor?.uuid,
      weaponItemId: weaponItem?.id,
      weaponItemUuid: weaponItem?.uuid,
      damageFormula: weaponItem?.system?.damage || "1d6",
      bulletsFired,
      zoneWidth,
      maxDistance,
      origin,
      combatRound: globalThis.game?.combat?.round || 0,
      combatTurn: globalThis.game?.combat?.turn || 0,
      combatId: globalThis.game?.combat?.id || "",
      color: globalThis.game?.user?.color,
      userId: globalThis.game?.user?.id
    });
    const placed = await placeCombatRegion(regionData, {
      // Transactional callers draw a transient preview first. Persisting an
      // armed Region before charging ammo would leave an uncharged hazard if
      // the user changed the weapon during placement or the write failed.
      create: !consumeAmmo,
      anchorOrigin: origin
    });
    if(!consumeAmmo || !placed) return Boolean(placed);
    if(globalThis.canvas.scene !== scene || Number(weaponItem.system.shotsLeft) !== beforeAmmo || !validAmmo()) {
      return failPlacement(undefined, "Scene or ammunition changed during placement. Nothing was spent; review the attack again.");
    }
    return await commitSuppressivePlacement({ scene, placed, regionData, weaponItem, beforeAmmo, rounds, failPlacement });
  } catch(error) {
    if(error?.nonRetryable) {
      globalThis.ui?.notifications?.error?.(error.message);
      throw error;
    }
    return failPlacement(error);
  } finally {
    if(consumeAmmo) ACTIVE_SUPPRESSIVE_TRANSACTIONS.delete(weaponItem);
  }
}

async function commitSuppressivePlacement({ scene, placed, regionData, weaponItem, beforeAmmo, rounds, failPlacement }) {
  const scope = globalThis.game?.system?.id || "cyberpunk2020";
  const preview = getRegionDocument(placed);
  if(typeof preview?.toObject !== "function") {
    return failPlacement(undefined, "The suppressive-fire preview could not be read. Nothing was spent.");
  }
  const stagedData = preview.toObject();
  const suppression = regionData.flags[scope].suppressiveFire;
  delete stagedData._id;
  stagedData.flags ??= {};
  stagedData.flags[scope] ??= {};
  delete stagedData.flags[scope].suppressiveFire;
  stagedData.flags[scope].suppressiveFirePending = true;

  let region;
  try {
    [region] = await scene.createEmbeddedDocuments("Region", [stagedData]);
  } catch(error) {
    // A failed acknowledgement can arrive after persistence. Without a
    // returned document we cannot prove which Region to remove: do not retry.
    throw suppressiveTransactionError("Region creation could not be confirmed. Check the Scene for a pending suppressive-fire zone before trying again. No ammunition update was requested.", error);
  }
  if(!region?.id || scene.regions.get(region.id) !== region) {
    throw suppressiveTransactionError("The created suppressive-fire Region could not be verified. Ask the GM to check pending zones before trying again. No ammunition update was requested.");
  }
  if(Number(weaponItem.system.shotsLeft) !== beforeAmmo) {
    await removeSuppressiveRegion(scene, region);
    return failPlacement(undefined, "Ammunition changed while creating the zone. The pending zone was removed; no ammunition was spent.");
  }

  const afterAmmo = beforeAmmo - rounds;
  let chargeError;
  try {
    await weaponItem.update({ "system.shotsLeft": afterAmmo });
  } catch(error) {
    chargeError = error;
  }
  const observedAmmo = Number(weaponItem.system.shotsLeft);
  if(observedAmmo !== afterAmmo) {
    await removeSuppressiveRegion(scene, region);
    if(observedAmmo !== beforeAmmo) {
      throw suppressiveTransactionError("The pending suppressive-fire zone was removed, but the ammunition update has an uncertain result. Ask the GM to reconcile ammunition before trying again.", chargeError);
    }
    return failPlacement(chargeError, "Ammunition could not be spent. The pending zone was removed; the attack was canceled.");
  }

  let activationError;
  try {
    await region.update({
      [`flags.${scope}.suppressiveFire`]: suppression,
      [`flags.${scope}.-=suppressiveFirePending`]: null
    });
  } catch(error) {
    activationError = error;
  }
  const liveRegion = scene.regions.get(region.id);
  if(liveRegion?.flags?.[scope]?.suppressiveFire) {
    // Both writes may have persisted despite a rejected acknowledgement.
    // Treat the verified zone + debit as success, never charge a second time.
    if(chargeError || activationError) {
      globalThis.ui?.notifications?.warn?.("Suppressive fire was placed and ammunition spent, although a write reported an error. Do not repeat this attack.");
    }
    return true;
  }

  await removeSuppressiveRegion(scene, region);
  if(Number(weaponItem.system.shotsLeft) !== afterAmmo) {
    throw suppressiveTransactionError("The failed suppressive-fire zone was removed, but ammunition changed before the refund. No ammunition was overwritten; ask the GM to reconcile it before trying again.", activationError);
  }
  let refundError;
  try {
    await weaponItem.update({ "system.shotsLeft": beforeAmmo });
  } catch(error) {
    refundError = error;
  }
  if(Number(weaponItem.system.shotsLeft) !== beforeAmmo) {
    throw suppressiveTransactionError("The failed suppressive-fire zone was removed, but its ammunition refund could not be confirmed. Ask the GM to reconcile ammunition before trying again.", refundError || activationError);
  }
  return failPlacement(activationError, "The suppressive-fire zone could not be activated. The pending zone was removed and ammunition restored.");
}

async function removeSuppressiveRegion(scene, region) {
  if(!scene.regions.get(region.id)) return;
  let deletionError;
  try {
    await region.delete();
  } catch(error) {
    deletionError = error;
  }
  if(scene.regions.get(region.id)) {
    throw suppressiveTransactionError(`Suppressive-fire rollback failed for ${region.uuid || region.id}. Ask the GM to remove this pending zone and check ammunition; do not repeat the attack.`, deletionError);
  }
}

function suppressiveTransactionError(message, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.nonRetryable = true;
  return error;
}
