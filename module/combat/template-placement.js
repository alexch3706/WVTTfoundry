import { buildActorCombatSnapshot } from "./combat-snapshot.js";

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
  return new Promise((resolve) => {
    let template;
    let interactionFinished = false;
    let settled = false;

    const finish = (result) => {
      if(settled) return;
      settled = true;
      resolve(result);
    };

    const cleanup = () => {
      if(interactionFinished) return;
      interactionFinished = true;
      try {
        if(template?.parent) template.parent.removeChild(template);
      } catch(error) {
        console.warn("Failed to remove AoE template preview:", error);
      }
      try {
        template?.destroy?.();
      } catch(error) {
        console.warn("Failed to destroy AoE template preview:", error);
      }
      globalThis.canvas?.stage?.off?.("pointermove", onMove);
      globalThis.canvas?.stage?.off?.("pointerdown", onConfirm);
      globalThis.canvas?.app?.view?.removeEventListener?.("contextmenu", onCancel, { capture: true });
    };

    const failPlacement = (error, message = "Template placement failed. Attack canceled; please try again.") => {
      if(error) console.error("AoE template placement failed:", error);
      cleanup();
      ui.notifications?.warn(message);
      finish({ affectedTargets: [], canceled: true });
    };

    let origin;
    let gridDistance;
    let aoeType;

    const onMove = (event) => {
      if(interactionFinished) return;
      event.stopPropagation();
      const pos = event.data.getLocalPosition(canvas.tokens);
      const ray = new Ray(origin, pos);
      template.document.updateSource({ direction: Math.normalizeDegrees(Math.toDegrees(ray.angle)) });
      template.refresh();
    };

    const onCancel = (event) => {
      if(interactionFinished) return;
      event.preventDefault();
      event.stopPropagation();
      cleanup();
      finish({ affectedTargets: [], canceled: true });
    };

    const onConfirm = async (event) => {
      if(interactionFinished) return;
      event.stopPropagation();
      let createdDoc;
      try {
        const templateDocumentData = template.document.toObject();
        cleanup();

        const createdDocs = await canvas.scene.createEmbeddedDocuments("MeasuredTemplate", [templateDocumentData]);
        if (!createdDocs || createdDocs.length === 0) {
          return failPlacement(undefined);
        }

        createdDoc = createdDocs[0];
        const hazardZone = buildAoEHazardZone({
          templateUuid: createdDoc.uuid,
          templateId: createdDoc.id,
          type: aoeType,
          origin: { x: createdDoc.x, y: createdDoc.y },
          direction: createdDoc.direction,
          angle: createdDoc.angle,
          width: createdDoc.distance,
          distance: createdDoc.distance,
          inclusion: "intersected"
        }, 0);

        // Wait for the placeable object to be instantiated before hit testing.
        setTimeout(async () => {
          try {
            const templateObj = createdDoc.object;
            if (!templateObj) {
              await deleteTransientTemplateDocument(createdDoc);
              return failPlacement(undefined, "Placed template could not be read. Attack canceled; please try again.");
            }

            const tokens = canvas.tokens.placeables.filter(t => {
              // Exclude the attacker from directional AoEs like cones and rays, as they emanate outward.
              // Circular/rectangular templates like grenades can legitimately hit the attacker if dropped nearby.
              if ((aoeType === "cone" || aoeType === "ray") && t.id === attackerToken.id) {
                return false;
              }

              const tCenter = t.center || { x: t.x + (t.w/2), y: t.y + (t.h/2) };
              return templateObj.shape.contains(tCenter.x - templateObj.document.x, tCenter.y - templateObj.document.y);
            });

            const augmentedTokens = tokens.map(t => {
              const tCenter = t.center || { x: t.x + (t.w/2), y: t.y + (t.h/2) };
              const ray = new Ray(origin, tCenter);
              const distancePx = ray.distance;
              const distanceMeters = (distancePx / canvas.grid.size) * gridDistance;

              t.tactical = t.tactical || {};
              t.tactical.template = {
                templateUuid: createdDoc.uuid,
                templateId: createdDoc.id,
                type: aoeType,
                origin: { x: createdDoc.x, y: createdDoc.y },
                direction: createdDoc.direction,
                angle: createdDoc.angle,
                width: createdDoc.distance,
                distance: createdDoc.distance,
                targetDistance: distanceMeters,
                inclusion: "intersected"
              };
              return t;
            });

            await deleteTransientTemplateDocument(createdDoc);
            finish({
              affectedTargets: augmentedTokens,
              hazardZone: {
                ...hazardZone,
                affectedTokenCount: augmentedTokens.length
              }
            });
          } catch(error) {
            await deleteTransientTemplateDocument(createdDoc);
            failPlacement(error);
          }
        }, 100);
      } catch(error) {
        if(createdDoc) await deleteTransientTemplateDocument(createdDoc);
        failPlacement(error);
      }
    };

    const initialize = async () => {
      if (!globalThis.canvas?.ready) {
        return failPlacement(undefined, "Canvas is not ready. Attack canceled; cannot place template.");
      }

      // Handle both Token Document and Token placeable.
      origin = attackerToken?.center || attackerToken?.object?.center || attackerToken?.bounds?.center;
      if (!origin) {
        return failPlacement(undefined, "Attacker token origin not found. Attack canceled.");
      }

      gridDistance = canvas.scene.grid.distance;
      aoeType = item?.system?.aoe?.type || "cone";
      const aoeDistance = Number(item?.system?.aoe?.value) || 10;
      const templateData = {
        t: aoeType,
        user: game.user.id,
        distance: aoeDistance,
        direction: 0,
        x: origin.x,
        y: origin.y,
        fillColor: game.user.color || "#ff0000"
      };
      if (aoeType === "cone") templateData.angle = 45;

      const doc = new CONFIG.MeasuredTemplate.documentClass(templateData, { parent: canvas.scene });
      template = new CONFIG.MeasuredTemplate.objectClass(doc);
      await template.draw();
      if (template.layer?.preview) {
        template.layer.preview.addChild(template);
      } else if (canvas.templates?.preview) {
        canvas.templates.preview.addChild(template);
      }

      canvas.stage.on("pointermove", onMove);
      canvas.stage.on("pointerdown", onConfirm);
      canvas.app.view.addEventListener("contextmenu", onCancel, { capture: true, once: true });
    };

    initialize().catch(error => failPlacement(error));
  });
}

async function deleteTransientTemplateDocument(templateDocument) {
  if (typeof templateDocument?.delete !== "function") {
    return;
  }
  try {
    await templateDocument.delete();
  } catch (error) {
    console.warn("Failed to delete transient AoE template:", error);
  }
}

export async function promptUseSuppressiveFireTemplate(weapon, maxRounds) {
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
        normal: {
          label: "Normal Attack",
          callback: () => resolve({ choice: SUPPRESSIVE_TEMPLATE_CHOICE.normal })
        },
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

export async function placePersistentSuppressiveFireTemplate(attackerToken, weaponItem, bulletsFired, zoneWidth, maxDistance) {
  return new Promise((resolve) => {
    let template;
    let interactionFinished = false;
    let settled = false;

    const finish = (placed) => {
      if(settled) return;
      settled = true;
      resolve(placed);
    };

    const cleanup = () => {
      if(interactionFinished) return;
      interactionFinished = true;
      try {
        if(template?.parent) template.parent.removeChild(template);
      } catch(error) {
        console.warn("Failed to remove suppressive-fire preview:", error);
      }
      try {
        template?.destroy?.();
      } catch(error) {
        console.warn("Failed to destroy suppressive-fire preview:", error);
      }
      globalThis.canvas?.stage?.off?.("pointermove", onMove);
      globalThis.canvas?.stage?.off?.("pointerdown", onConfirm);
      globalThis.canvas?.app?.view?.removeEventListener?.("contextmenu", onCancel, { capture: true });
    };

    const failPlacement = (error, message = "Suppressive-fire template placement failed. Attack canceled; please try again.") => {
      if(error) console.error("Suppressive-fire template placement failed:", error);
      cleanup();
      ui.notifications?.warn(message);
      finish(false);
    };

    let origin;

    const onMove = (event) => {
      if(interactionFinished) return;
      event.stopPropagation();
      const pos = event.data.getLocalPosition(canvas.tokens);
      const ray = new Ray(origin, pos);
      template.document.updateSource({
        direction: Math.normalizeDegrees(Math.toDegrees(ray.angle))
      });
      template.refresh();
    };

    const onCancel = (event) => {
      if(interactionFinished) return;
      event.preventDefault();
      event.stopPropagation();
      cleanup();
      finish(false);
    };

    const onConfirm = async (event) => {
      if(interactionFinished) return;
      event.stopPropagation();
      try {
        const templateDocumentData = template.document.toObject();
        cleanup();
        const createdDocs = await canvas.scene.createEmbeddedDocuments("MeasuredTemplate", [templateDocumentData]);
        finish(Array.isArray(createdDocs) && createdDocs.length > 0);
      } catch(error) {
        failPlacement(error);
      }
    };

    const initialize = async () => {
      if (!globalThis.canvas?.ready) {
        return failPlacement(undefined, "Canvas is not ready. Attack canceled; cannot place template.");
      }

      origin = attackerToken?.center || attackerToken?.object?.center || attackerToken?.bounds?.center;
      if (!origin) {
        return failPlacement(undefined, "Attacker token origin not found. Attack canceled.");
      }

      // Use the builder from suppressive-fire-tracker.
      const { buildSuppressiveFireTemplateData } = await import("./suppressive-fire-tracker.js");
      const damageFormula = weaponItem.system?.damage || "1d6";
      const templateData = buildSuppressiveFireTemplateData({
        attackerTokenId: attackerToken.id,
        attackerActorId: attackerToken.actor?.id,
        weaponItemId: weaponItem.id,
        damageFormula,
        bulletsFired,
        zoneWidth,
        maxDistance,
        origin,
        combatRound: game.combat?.round || 0,
        combatTurn: game.combat?.turn || 0,
        combatId: game.combat?.id || ""
      });
      templateData.user = game.user.id;
      templateData.direction = 0;
      templateData.fillColor = game.user.color || "#ff0000";

      const doc = new CONFIG.MeasuredTemplate.documentClass(templateData, { parent: canvas.scene });
      template = new CONFIG.MeasuredTemplate.objectClass(doc);
      await template.draw();
      if (template.layer?.preview) {
        template.layer.preview.addChild(template);
      } else if (canvas.templates?.preview) {
        canvas.templates.preview.addChild(template);
      }

      canvas.stage.on("pointermove", onMove);
      canvas.stage.on("pointerdown", onConfirm);
      canvas.app.view.addEventListener("contextmenu", onCancel, { capture: true, once: true });
    };

    initialize().catch(error => failPlacement(error));
  });
}
