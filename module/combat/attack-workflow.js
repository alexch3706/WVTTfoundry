import { normalizeSelectedTargets, normalizeTacticalTargets } from "./target-normalizer.js";
import { detectAndPromptTacticalRaycasts } from "./tactical-raycast.js";
import { measureTokenDistance } from "../foundry-compat.js";
import { getMaxRangeBracketDistance, ranges } from "../lookups.js";
import { parseManualAttackDie } from "./attack-die-entry.js";
import {
  buildAoETemplateTargetingOptions,
  drawAoETemplateAndGetTargets,
  drawAutoshotgunPatternsAndGetTargets,
  placePersistentSuppressiveFireTemplate,
  promptAutoshotgunShellCount,
  promptUseSuppressiveFireTemplate
} from "./template-placement.js";

/** Read-only preparation for the form: no prompts, rolls, templates or updates. */
export function buildInitialAttackTargets(attackerToken, selectedTargets = [], measure = measureTokenDistance) {
  return addMeasuredDistances(normalizeSelectedTargets(selectedTargets), attackerToken, selectedTargets, measure);
}

export function supportsAreaTargeting(weapon, structured = true) {
  const system = weapon?.system || {};
  return structured && weapon.isRanged() && String(system.attackType).toLowerCase() !== "autoshotgun"
    && Boolean(system.aoe?.type || String(system.weaponType).toLowerCase() === "shotgun"
      || String(system.attackType).toLowerCase() === "shotgun");
}

/** Execute only the follow-up steps required by the submitted attack mode. */
export async function executeAttackFromForm(context, overrides = {}) {
  const { weapon, attackerToken, selectedTargets = [], resolverOptions = null } = context;
  const deps = {
    detectAndPromptTacticalRaycasts, measureTokenDistance, buildAoETemplateTargetingOptions,
    drawAoETemplateAndGetTargets, drawAutoshotgunPatternsAndGetTargets,
    placePersistentSuppressiveFireTemplate, promptAutoshotgunShellCount,
    promptUseSuppressiveFireTemplate, ...overrides
  };
  const { targetingMode = "selected", manualAttackDie, ...submitted } = context.fireOptions || {};
  const fireOptions = { ...submitted };
  const structured = resolverOptions !== null;
  const ranged = weapon.isRanged();
  const attackType = String(weapon.system?.attackType || "").trim().toLowerCase();
  const mode = String(fireOptions.fireMode || "").toLowerCase();
  // Physical dice and mode validation must precede even transient placement.
  const attackDieOptions = {};
  if(structured && String(manualAttackDie ?? "").trim()) {
    parseManualAttackDie(manualAttackDie);
    attackDieOptions.manualAttackDie = manualAttackDie;
  }
  if(weapon.warnInvalidCombatData?.(fireOptions)) return { canceled: true };
  if(!["selected", "template"].includes(targetingMode)
    || (targetingMode === "template" && !supportsAreaTargeting(weapon, structured))) {
    throw new Error("Area-template targeting is unavailable for this attack.");
  }

  if(structured && ranged && mode === "suppressive") {
    const shotsLeft = Number(weapon.system.shotsLeft);
    const maximum = Math.min(shotsLeft, Number(weapon.system.rof));
    if(!attackerToken) throw new Error("Select the attacker's token before placing a suppressive-fire zone.");
    if(!Number.isInteger(maximum) || maximum < 1) throw new Error("No ammunition is available for suppressive fire.");
    const choice = await deps.promptUseSuppressiveFireTemplate(weapon, maximum, { templateOnly: true });
    if(choice?.choice !== "template") return { canceled: true };
    // A canceled prompt must not fall through into a normal weapon roll.
    if(weapon.warnInvalidCombatData?.(fireOptions) || Number(weapon.system.shotsLeft) !== shotsLeft) {
      throw new Error("Weapon ammunition changed. Review the attack again.");
    }
    const placed = await deps.placePersistentSuppressiveFireTemplate(
      attackerToken, weapon, choice.roundsFired, choice.zoneWidth,
      getMaxRangeBracketDistance(weapon.system.range, "RangeClose"), { consumeAmmo: true }
    );
    if(!placed) return { canceled: true };
    return { status: "zone-placed" };
  }

  let targeting;
  let rawTargets = selectedTargets;
  if(structured && ranged && targetingMode === "template") {
    const placement = await deps.drawAoETemplateAndGetTargets(weapon, attackerToken);
    if(!placement || placement.canceled) return { canceled: true };
    targeting = deps.buildAoETemplateTargetingOptions({
      selectedTargets,
      affectedTargets: Array.isArray(placement) ? placement : placement.affectedTargets || [],
      hazardZone: placement.hazardZone
    });
    rawTargets = targeting.raycastTargets;
    if(targeting.hazardZone) fireOptions.hazardZone = targeting.hazardZone;
    // The form explains that template targets use their measured distances.
    fireOptions.range = ranges.auto;
  }

  let targetTokens;
  if(structured && ranged) {
    try {
      targetTokens = await deps.detectAndPromptTacticalRaycasts(attackerToken, rawTargets);
    } catch(error) {
      console.warn("Tactical raycast failure:", error);
      targetTokens = rawTargets.map(markRaycastFailureManual);
    }
    targetTokens = normalizeTacticalTargets({ targets: targetTokens, ...(targeting?.template ? { template: targeting.template } : {}) });
  } else {
    targetTokens = normalizeSelectedTargets(rawTargets);
  }
  targetTokens = addMeasuredDistances(targetTokens, attackerToken, rawTargets, deps.measureTokenDistance);
  if(targeting) fireOptions.targetsCount = targetTokens.length;

  if(structured && attackType === "autoshotgun" && mode === "fullauto") {
    if(!attackerToken) throw new Error("Select the attacker's token before placing autoshotgun patterns.");
    const maximum = Math.min(Number(weapon.system.shotsLeft), Number(weapon.system.rof));
    const shellCount = await deps.promptAutoshotgunShellCount(weapon, maximum);
    if(!shellCount) return { canceled: true };
    const placement = await deps.drawAutoshotgunPatternsAndGetTargets(weapon, attackerToken, shellCount);
    if(!placement || placement.canceled) return { canceled: true };
    fireOptions.autoshotgunPatterns = placement.patterns;
  }
  if(weapon.warnInvalidCombatData?.(fireOptions)) return { canceled: true };
  return weapon.__weaponRoll(fireOptions, targetTokens, { structured, ...resolverOptions, ...attackDieOptions });
}

function addMeasuredDistances(targets, attackerToken, rawTargets, measure) {
  if(!attackerToken) return targets;
  for(const target of targets) {
    if(target.distance?.source === "template") continue;
    const raw = rawTargets.find(entry => (target.tokenUuid && (entry.document?.uuid || entry.tokenUuid || entry.uuid) === target.tokenUuid)
      || (target.id && (entry.id || entry.document?.id) === target.id));
    if(!raw) continue;
    const distance = measure(attackerToken, raw);
    if(distance === undefined) continue;
    target.distance = { value: distance, units: globalThis.canvas?.grid?.units || "m", source: "standard-grid" };
  }
  return targets;
}

function markRaycastFailureManual(target) {
  return {
    document: target?.document, actor: target?.actor, id: target?.id, uuid: target?.uuid,
    actorUuid: target?.actorUuid || target?.actor?.uuid,
    tokenUuid: target?.tokenUuid || target?.document?.uuid,
    name: target?.name, center: target?.center, bounds: target?.bounds, snapshot: target?.snapshot,
    ...target,
    manualResolution: {
      ...(target.manualResolution || {}), required: true,
      reason: target.manualResolution?.reason || "pending-user-decision",
      message: target.manualResolution?.message || "Tactical raycast failed; resolve cover/barrier interaction manually.",
      blockedUpdateCategories: [...new Set([...(target.manualResolution?.blockedUpdateCategories || []), "target-damage", "target-armor", "target-saves"])]
    },
    warnings: [...(target.warnings || []), { code: "manual-tactical-raycast", severity: "warning", message: "Tactical raycast failed; resolve cover/barrier interaction manually." }]
  };
}
