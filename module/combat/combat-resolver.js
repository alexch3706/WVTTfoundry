import { rangeDCs, ranges } from "../lookups.js";
import { resolveSingleShotRangedAttack, normalizeAmmoState, resolveMeleeAction, resolveAutoshotgunFullAutoAttack } from "./attack-resolver.js";
import { isCorebookFidelityEnabled } from "./settings-helpers.js";
import { classifyAttackTypeSupport } from "./conformance-helpers.js";
import { COMBAT_WARNING_SEVERITY, MANUAL_RESOLUTION_REASON, COMBAT_CHAT_STATUS } from "./combat-outcome.js";
import { buildAttackDieEntryRoller } from "./attack-die-entry.js";

/**
 * Top-level combat resolver shell.
 *
 * This migration step establishes the resolver boundary while preserving legacy
 * item-centric behavior. Real mechanics resolution will replace the legacy
 * fallback incrementally in later stories.
 */

/**
 * Default runtime roller using globalThis.Roll (Foundry's dice engine).
 * Evaluates roll requests synchronously and maps results to structured rollMetadata format.
 * @param {Object} request Roll request with { id, formula, terms, rollData }
 * @returns {Object} rollMetadata with { id, formula, total, die }
 */
async function activeRoller(request = {}) {
  if (typeof globalThis.Roll !== "function") {
    throw new Error("activeRoller requires Foundry's Roll class (globalThis.Roll) to be available.");
  }

  // Strip " hit location" suffix from location formula rolls
  let formula = String(request.formula || "").replace(/\s+hit\s+location$/i, "");
  if (!formula) {
    formula = "1d10";
  }

  const roll = new globalThis.Roll(formula, request.rollData);
  await roll.evaluate();

  // Build die info from the first die term
  const firstDie = roll.dice && roll.dice.length > 0 ? roll.dice[0] : null;
  const die = {
    faces: firstDie ? firstDie.faces : 10,
    natural: firstDie && firstDie.results && firstDie.results.length > 0 ? firstDie.results[0].result : roll.total,
    results: firstDie && firstDie.results ? firstDie.results.map(r => r.result) : [roll.total],
    exploded: firstDie && firstDie.results ? firstDie.results.some(r => r.active === false) : false
  };

  return {
    id: request.id,
    formula: request.formula,
    total: roll.total,
    die
  };
}

/**
 * Resolve a combat action through the current migration shell.
 *
 * @param {Object} context Plain combat context built by a Foundry adapter.
 * @param {Object} [options] Resolver options reserved for future mechanics.
 * @param {Function} [roller] Optional deterministic roller hook reserved for tests.
 * @returns {*} The legacy fallback result for current combat paths.
 */
export async function resolveCombatAction(context, options = {}, roller = undefined) {
  // Resolve the roller: use provided roller (tests), or default activeRoller (runtime)
  const baseRoller = roller || (typeof globalThis.Roll === "function" ? activeRoller : undefined);
  const resolvedRoller = typeof baseRoller === "function"
    ? buildAttackDieEntryRoller(baseRoller, options.manualAttackDie)
    : baseRoller;

  if(options.structured === true) {
    if(canResolveAutoshotgunFullAutoContext(context, resolvedRoller)) {
      return await resolveAutoshotgunFullAutoAttack(context, options, resolvedRoller);
    }

    // ---- Exotic attack guard: block before any ranged/enemy routing ----
    if (isCorebookFidelityEnabled(context) && context?.action?.type === "ranged") {
      const rawAttackType = context?.weapon?.snapshot?.attackType;
      const support = classifyAttackTypeSupport(rawAttackType);
      if (support === "manual" || support === "partial" || support === "unknown") {
        return buildManualExoticOutcome(context, support);
      }
    }

    // Suppressive Fire is no longer resolved here. It is handled by the
    // persistent hazard tracker when tokens intersect the Region.

    const rangedManualOutcome = validateSupportedRangedContext(context, resolvedRoller);
    if(rangedManualOutcome) {
      return rangedManualOutcome;
    }
    if(canResolveSingleShotRangedContext(context, resolvedRoller)) {
      return await resolveSingleShotRangedAttack(context, options, resolvedRoller);
    }
    if(canResolveMeleeContext(context, resolvedRoller)) {
      return await resolveMeleeAction(context, options, resolvedRoller);
    }
  }

  if (typeof context?.legacy?.fallback !== "function") {
    throw new Error("Combat resolver requires a legacy fallback during migration.");
  }

  return await context.legacy.fallback({
    context,
    options,
    roller
  });
}

function canResolveAutoshotgunFullAutoContext(context, roller) {
  return typeof roller === "function"
    && String(context?.action?.type || "").toLowerCase() === "ranged"
    && String(context?.action?.fireMode || "").toLowerCase() === "fullauto"
    && String(context?.weapon?.snapshot?.attackType || "").toLowerCase().trim() === "autoshotgun"
    && Array.isArray(context?.action?.autoshotgunPatterns)
    && context.action.autoshotgunPatterns.length > 0;
}

function isSupportedSingleShotRangedContext(context) {
  const fireMode = String(context?.action?.fireMode || "").toLowerCase();
  return context?.action?.type === "ranged"
    && (fireMode === "semiauto" || fireMode === "threeroundburst" || fireMode === "fullauto");
}


function canResolveMeleeContext(context, roller) {
  const actionType = context?.action?.type || "";
  if(actionType !== "melee" && actionType !== "martial") {
    return false;
  }
  if(typeof roller !== "function") {
    return false;
  }
  if(!context?.attacker?.snapshot?.stats) {
    return false;
  }
  if(!Array.isArray(context.targets) || context.targets.length === 0) {
    return false;
  }

  if(actionType === "melee") {
    // Melee weapons always have attackSkill (Melee, Fencing, Brawling, etc.)
    if(!context?.weapon?.snapshot?.attackSkill) {
      return false;
    }
  }
  else if(actionType === "martial") {
    // Martial requires an action choice (Strike, Kick, etc.); skill comes from martial art
    if(!context?.action?.meleeAction) {
      return false;
    }
  }

  return true;
}

function canResolveSingleShotRangedContext(context, roller) {
  if(!isSupportedSingleShotRangedContext(context) || typeof roller !== "function") {
    return false;
  }

  const range = normalizeRange(context.action?.range);
  const targetNumber = rangeDCs[range] || context.action?.targetNumber;
  const hasValidTargetNumber = range === ranges.auto || Number.isFinite(Number(targetNumber));
  
  return hasValidTargetNumber
    && !!context.attacker?.snapshot?.stats
    && !!context.weapon?.snapshot?.attackSkill
    && Array.isArray(context.targets)
    && (context.targets.length > 0 || isEmptyShotgunZoneOnlyAttack(context));
}

function validateSupportedRangedContext(context, roller) {
  if(!isSupportedSingleShotRangedContext(context)) {
    return undefined;
  }

  if(typeof roller !== "function") {
    return buildManualRangedOutcome(context, "Structured ranged attacks require an available roller.", ["attack-roll"]);
  }

  const targets = Array.isArray(context.targets) ? context.targets : [];
  const fireMode = String(context.action?.fireMode || "").toLowerCase();
  if(targets.length === 0) {
    if(isEmptyShotgunZoneOnlyAttack(context)) {
      return undefined;
    }
    return buildManualRangedOutcome(context, "Select a target before resolving a ranged attack.", ["target-selection", "target-damage", "target-armor", "target-saves"]);
  }

  if(fireMode === "semiauto" && targets.length !== 1) {
    const isShotgun = String(context.weapon?.snapshot?.attackType || "").toLowerCase().trim() === "shotgun";
    if (!isShotgun) {
      return buildManualRangedOutcome(context, "Semi-auto attacks require exactly one target; resolve multiple targets as separate attacks.", ["target-selection", "target-damage", "target-armor", "target-saves"]);
    }
  }

  if(fireMode === "threeroundburst" && targets.length !== 1) {
    return buildManualRangedOutcome(context, "Three-round burst attacks require exactly one target.", ["target-selection", "target-damage", "target-armor", "target-saves"]);
  }

  if(fireMode === "fullauto") {
    const rof = Number(context.weapon?.snapshot?.rof);
    if(!Number.isFinite(rof) || rof <= 0) {
      return buildManualRangedOutcome(context, "Full-auto attacks require a positive weapon ROF.", ["attacker-ammo", "target-damage", "target-armor", "target-saves"]);
    }
    if(targets.length > 1) {
      const rawShotsLeft = normalizeAmmoState(context.weapon?.snapshot?.shotsLeft);
      const maxRoundsFired = rawShotsLeft.valid ? Math.min(rawShotsLeft.value, rof) : rof;
      const finalMaxRoundsFired = (maxRoundsFired <= 0 && rawShotsLeft.valid) ? 0 : maxRoundsFired;
      const roundsFiredPerTarget = Math.floor(finalMaxRoundsFired / targets.length);
      if(roundsFiredPerTarget < 1) {
        return buildManualRangedOutcome(context, "Full-auto multi-target attacks require at least one round per target.", ["attacker-ammo", "target-damage", "target-armor", "target-saves"]);
      }
    }
  }

  return undefined;
}

function isEmptyShotgunZoneOnlyAttack(context) {
  if(!Array.isArray(context?.targets) || context.targets.length !== 0) {
    return false;
  }
  if(String(context?.action?.type || "").toLowerCase() !== "ranged") {
    return false;
  }
  if(String(context?.action?.fireMode || "").toLowerCase() !== "semiauto") {
    return false;
  }
  if(String(context?.weapon?.snapshot?.attackType || "").toLowerCase().trim() !== "shotgun") {
    return false;
  }

  const hazardZone = context?.action?.hazardZone;
  if(!hazardZone || typeof hazardZone !== "object") {
    return false;
  }
  if(String(hazardZone.kind || "") !== "shotgun-cone") {
    return false;
  }
  if(!hazardZone.type || !hazardZone.origin || !hazardZone.inclusion) {
    return false;
  }

  return Number(hazardZone.affectedTokenCount || 0) === 0;
}

function buildManualRangedOutcome(context, message, blockedUpdateCategories) {
  const ammoState = normalizeAmmoState(context?.weapon?.snapshot?.shotsLeft);
  const ammo = ammoState.valid
    ? { before: ammoState.value, delta: 0, after: ammoState.value, source: "weapon.snapshot.shotsLeft" }
    : { before: ammoState.evidence, delta: 0, after: ammoState.evidence, source: "weapon.snapshot.shotsLeft" };

  return {
    action: context?.action ? clone(context.action) : { type: "ranged" },
    attacker: context?.attacker ? clone(context.attacker) : {},
    weapon: context?.weapon ? clone(context.weapon) : {},
    targets: (context?.targets || []).map(target => ({
      target: clone(target),
      attack: { hit: false, warnings: [] },
      hits: [],
      saves: [],
      plannedUpdates: { embeddedItemUpdates: [], chatStatus: COMBAT_CHAT_STATUS.manual },
      manualResolution: { required: false },
      warnings: clone(target?.warnings || [])
    })),
    ammo,
    plannedUpdates: {
      itemUpdates: [],
      chatStatus: COMBAT_CHAT_STATUS.manual
    },
    manualResolution: {
      required: true,
      reason: MANUAL_RESOLUTION_REASON.missingRuleData,
      message,
      blockedUpdateCategories
    },
    chat: { status: COMBAT_CHAT_STATUS.manual },
    warnings: [
      {
        code: "structured-ranged-manual-resolution",
        severity: COMBAT_WARNING_SEVERITY.warning,
        message
      }
    ]
  };
}

/**
 * Build a manual-resolution outcome for an exotic attack type.
 * @param {Object} context — Combat context
 * @param {"manual"|"partial"|"unknown"} support — Support classification
 * @returns {Object} CombatOutcome marked for manual resolution
 */
function buildManualExoticOutcome(context, support) {
  const attackerName = context?.attacker?.name || "Unknown";
  const weaponName = context?.weapon?.name || "Unknown";
  const attackType = context?.weapon?.snapshot?.attackType || "";

  const isPartial = support === "partial";
  const message = isPartial
    ? `"${attackType}" has basic resolver support but special rules are not applied. Resolve manually.`
    : `Exotic weapon type (${attackType}) requires manual resolution — special attack rules are not applied by the combat resolver.`;

  return {
    action: context?.action ? clone(context.action) : { type: "ranged" },
    attacker: {
      actorUuid: context?.attacker?.actorUuid,
      tokenUuid: context?.attacker?.tokenUuid,
      name: attackerName,
      snapshot: context?.attacker?.snapshot ? clone(context.attacker.snapshot) : undefined
    },
    weapon: {
      itemUuid: context?.weapon?.itemUuid,
      name: weaponName,
      snapshot: context?.weapon?.snapshot ? clone(context.weapon.snapshot) : { attackType }
    },
    targets: (context?.targets || []).map(t => ({
      target: {
        tokenUuid: t?.tokenUuid,
        actorUuid: t?.actorUuid,
        name: t?.name || "Unknown"
      },
      warnings: []
    })),
    ammo: { delta: 0 },
    manualResolution: {
      required: true,
      reason: MANUAL_RESOLUTION_REASON.unsupportedAction,
      message,
      blockedUpdateCategories: ["attacker-ammo", "target-damage", "target-armor", "target-saves"]
    },
    chat: { status: COMBAT_CHAT_STATUS.manual },
    warnings: [
      {
        code: "exotic-attack-type-unsupported",
        severity: "warning",
        message
      }
    ]
  };
}

function clone(obj) {
  if(obj === undefined) {
    return undefined;
  }
  return typeof foundry !== "undefined" ? foundry.utils.deepClone(obj) : JSON.parse(JSON.stringify(obj));
}

function normalizeRange(range) {
  if(rangeDCs[range]) {
    return range;
  }
  return ranges[range] || range;
}
