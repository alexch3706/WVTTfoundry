import { defaultAreaLookup, getRangeBracketForDistance, getMaxRangeBracketDistance, rangeDCs, ranges, btmFromBT, strengthDamageBonus } from "../lookups.js";
import { COMBAT_CHAT_STATUS, COMBAT_WARNING_SEVERITY, MANUAL_RESOLUTION_REASON } from "./combat-outcome.js";
import { resolveArmor } from "./armor-resolver.js";
import { getKeyTechniqueBonus, getRequiresPrerequisite } from "./martial-arts-data.js";
import { buildFullAutoAttackEvidence, buildFullAutoTargetAction } from "./ranged-automatic-fire.js";
import { buildMultiHitLocationAction } from "./ranged-hit-location.js";
import { normalizeReliability, findCombatSkill } from "../item/item-contract.js";
import { preflightCombatItemData } from "./item-preflight.js";

const RANGED_MODIFIERS = Object.freeze([
  { code: "aimRounds", label: "Aiming", term: "@modifier.aimRounds", value: options => Number(options.aimRounds || 0), include: value => value !== 0 },
  { code: "targetArea", label: "Aimed Location", term: "@modifier.targetArea", value: options => options.targetArea ? -4 : 0, include: value => value !== 0 },
  { code: "targetsCount", label: "Targets Count", term: "@modifier.targetsCount", value: options => Number(options.targetsCount || 0), include: value => value !== 0 },
  { code: "ambush", label: "Ambush", term: "@modifier.ambush", value: options => options.ambush ? 5 : 0, include: value => value !== 0 },
  { code: "blinded", label: "Blinded", term: "@modifier.blinded", value: options => options.blinded ? -3 : 0, include: value => value !== 0 },
  { code: "dualWield", label: "Dual Wield", term: "@modifier.dualWield", value: options => options.dualWield ? -3 : 0, include: value => value !== 0 },
  { code: "fastDraw", label: "Fast Draw", term: "@modifier.fastDraw", value: options => options.fastDraw ? -3 : 0, include: value => value !== 0 },
  { code: "hipfire", label: "Hipfire", term: "@modifier.hipfire", value: options => options.hipfire ? -2 : 0, include: value => value !== 0 },
  { code: "ricochet", label: "Ricochet", term: "@modifier.ricochet", value: options => options.ricochet ? -5 : 0, include: value => value !== 0 },
  { code: "running", label: "Running", term: "@modifier.running", value: options => options.running ? -3 : 0, include: value => value !== 0 },
  { code: "turningToFace", label: "Turning To Face", term: "@modifier.turningToFace", value: options => options.turningToFace ? -2 : 0, include: value => value !== 0 },
  { code: "extraMod", label: "Extra Modifier", term: "@modifier.extraMod", value: options => Number(options.extraMod || 0), include: value => value !== 0 }
]);

const MISSING_LOCATION_BLOCKS = Object.freeze(["hit-location", "target-damage", "target-armor", "target-saves"]);
const AMMO_BLOCKS = Object.freeze(["attacker-ammo"]);
const TARGET_UPDATE_BLOCKS = Object.freeze(["target-damage", "target-armor", "target-saves"]);
const SHOTGUN_ATTACK_TYPES = Object.freeze(["shotgun", "autoshotgun"]);
const SHOTGUN_BRACKETS = Object.freeze({
  pointBlank: Object.freeze({ patternWidthMeters: 1, damageKeys: Object.freeze(["pointBlank", "close"]) }),
  close: Object.freeze({ patternWidthMeters: 1, damageKeys: Object.freeze(["close", "pointBlank"]) }),
  medium: Object.freeze({ patternWidthMeters: 2, damageKeys: Object.freeze(["medium"]) }),
  far: Object.freeze({ patternWidthMeters: 3, damageKeys: Object.freeze(["far", "long"]) })
});

/**
 * Martial action classification.
 * Each entry maps a lowercase action key to its behavior category.
 * @type {Object<string, string>}
 */
const MARTIAL_ACTION_CLASSIFICATIONS = Object.freeze({
  strike:     "damageOnly",
  kick:       "damageOnly",
  dodge:      "nonDamage",
  blockparry: "nonDamage",
  disarm:      "nonDamage",
  sweeptrip:   "grappleFamily",
  grapple:     "grappleFamily",
  hold:        "grappleFamily",
  choke:       "grappleFamily",
  throw:       "grappleFamily",
  escape:      "grappleFamily",
});

/**
 * Human-readable labels for martial prerequisite action keys.
 * Used in user-facing manual-resolution messages.
 * Keys are lowercased for case-insensitive lookup.
 * @type {Object<string, string>}
 */
const MARTIAL_PREREQ_LABELS = Object.freeze({
  grapple: "Grapple",
  hold: "Hold",
  blockparry: "Block/Parry",
  dodge: "Dodge"
});

/**
 * Check whether a grapple-family martial action\'s prerequisites are confirmed
 * by the target\'s combat state.
 *
 * @param {Object} targetSnapshot - Target actor snapshot (may include combatState).
 * @param {string[]} prereqs - Array of prerequisite action keys (OR relationship).
 * @returns {{ confirmed: boolean, missing: string[] }}
 *   confirmed: true if ANY prerequisite is confirmed by combatState.
 *   missing: array of prerequisite keys not confirmed.
 */
export function checkGrapplePrerequisites(targetSnapshot, prereqs) {
  if (!Array.isArray(prereqs) || prereqs.length === 0) {
    return { confirmed: true, missing: [] };
  }
  if (!targetSnapshot) {
    return { confirmed: false, missing: [...prereqs] };
  }

  const combatState = targetSnapshot.combatState || {};

  const PREREQ_TO_STATE_FLAG = {
    grapple: "grappled",
    hold: "held",
    blockparry: "blockedParried",
    dodge: "dodgeActive"
  };

  const confirmed = prereqs.some(prereq => {
    const normalizedPrereq = String(prereq || "").toLowerCase().trim();
    if (!normalizedPrereq) return false;
    const stateFlag = PREREQ_TO_STATE_FLAG[normalizedPrereq];
    return stateFlag && combatState[stateFlag] === true;
  });

  if (confirmed) {
    return { confirmed: true, missing: [] };
  }

  return { confirmed: false, missing: [...prereqs] };
}

export function resolveJamOutcome(isFumble, fireMode, reliability, weaponName = "Weapon") {
  if (!isFumble) {
    return { isJam: false };
  }

  const lowerFireMode = String(fireMode || "").toLowerCase();
  if (lowerFireMode !== "fullauto" && lowerFireMode !== "threeroundburst") {
    return { isJam: false };
  }

  const rel = String(normalizeReliability(reliability) || "").toLowerCase();
  if (rel === "veryreliable") {
    return { isJam: false };
  }

  if (rel === "unreliable") {
    return {
      isJam: true,
      jamSeverity: "unreliable",
      warnings: [{
        code: "weapon-jam",
        severity: COMBAT_WARNING_SEVERITY.warning,
        message: `"${weaponName}" jammed and damaged; repair required before next shot.`
      }],
      pendingDecisions: [{
        type: "jam",
        severity: "unreliable",
        message: `"${weaponName}" damaged and requires repair (repair skill or gunsmith).`
      }]
    };
  }

  // Default to Standard (also handles missing/unknown reliability)
  return {
    isJam: true,
    jamSeverity: "standard",
    warnings: [{
      code: "weapon-jam",
      severity: COMBAT_WARNING_SEVERITY.warning,
      message: `"${weaponName}" jammed; clear stoppage before next shot.`
    }],
    pendingDecisions: [{
      type: "jam",
      severity: "standard",
      message: `Clear "${weaponName}" stoppage (weapon skill check or referee action).`
    }]
  };
}

export async function resolveSingleShotRangedAttack(context, options = {}, roller = undefined) {
  const itemDataIssue = preflightCombatItemData(context);
  if (itemDataIssue) return itemDataIssue;
  const action = clonePlainData(context.action || {});
  action.targetArea = action.targetArea || action.options?.targetArea;
  const rawRange = normalizeRange(action.range);
  
  let baseRange = rawRange;
  if (baseRange === ranges.auto && context.targets?.length > 0) {
    const firstTargetDist = context.targets[0]?.distance?.value;
    if (firstTargetDist !== undefined && Number.isFinite(Number(firstTargetDist))) {
      const weaponRange = Number(context.weapon?.snapshot?.range);
      baseRange = getRangeBracketForDistance(Number(firstTargetDist), weaponRange);
    } else {
      baseRange = ranges.close;
    }
  }
  
  const targetNumber = rangeDCs[baseRange] || action.targetNumber;

  const fireMode = String(action.fireMode || "").toLowerCase();
  const targetCount = Array.isArray(context.targets) ? context.targets.length : 0;

  let roundsFired = 1;
  let roundsFiredPerTarget = undefined;

  if (fireMode === "threeroundburst") {
    const rawShotsLeft = normalizeAmmoState(context.weapon?.snapshot?.shotsLeft);
    roundsFired = rawShotsLeft.valid ? Math.min(rawShotsLeft.value, 3) : 3;
    if (roundsFired <= 0 && rawShotsLeft.valid) {
      roundsFired = 0;
    }
  } else if (fireMode === "fullauto") {
    const rawShotsLeft = normalizeAmmoState(context.weapon?.snapshot?.shotsLeft);
    const rof = Math.max(0, Number(context.weapon?.snapshot?.rof) || 0);
    const maxRoundsFired = rawShotsLeft.valid ? Math.min(rawShotsLeft.value, rof) : rof;
    const finalMaxRoundsFired = (maxRoundsFired <= 0 && rawShotsLeft.valid) ? 0 : maxRoundsFired;

    if (targetCount > 1) {
      roundsFiredPerTarget = Math.floor(finalMaxRoundsFired / targetCount);
      roundsFired = roundsFiredPerTarget * targetCount;
    } else {
      roundsFired = finalMaxRoundsFired;
    }
  }
  action.roundsFired = roundsFired;

  let targets = [];
  let modifierEvidence;
  let attackRoll;
  let actionWarnings = [];
  let actionPendingDecisions = [];

  if (fireMode === "fullauto" && targetCount > 1) {
    let jamAborted = false;
    for (const [idx, target] of (context.targets || []).entries()) {
      if (jamAborted) {
        targets.push({
          target: clonePlainData(target),
          attack: {
            hit: false,
            hitCount: 0,
            notFired: true,
            roundsFired: 0,
            roundsFiredPerTarget,
            warnings: [{
              code: "full-auto-jam-aborted",
              severity: COMBAT_WARNING_SEVERITY.warning,
              message: typeof game !== "undefined" && game?.i18n?.localize ? game.i18n.localize("CYBERPUNK.TargetNotFiredWeaponJam") : "Target not fired upon due to weapon jam"
            }]
          },
          hits: [],
          saves: [],
          plannedUpdates: { embeddedItemUpdates: [], chatStatus: COMBAT_CHAT_STATUS.preview },
          manualResolution: { required: false },
          warnings: cloneArray(target.warnings)
        });
        continue;
      }

      const targetAction = buildFullAutoTargetAction(action, idx, roundsFiredPerTarget);
      if (rawRange === ranges.auto && target?.distance?.value !== undefined && Number.isFinite(Number(target.distance.value))) {
        const weaponRange = Number(context.weapon?.snapshot?.range);
        targetAction.range = getRangeBracketForDistance(Number(target.distance.value), weaponRange);
        targetAction.targetNumber = rangeDCs[targetAction.range] || targetAction.targetNumber;
      }
      const targetModifierEvidence = buildModifierEvidence(targetAction, context.weapon);
      const baseTargetAttackEvidence = buildFullAutoAttackEvidence({
        modifiers: targetModifierEvidence,
        roundsFired: roundsFiredPerTarget,
        roundsFiredPerTarget,
      });
      const targetAttackRequest = buildAttackRollRequest(
        { ...context, action: targetAction },
        targetModifierEvidence
      );
      const targetAttackRoll = normalizeAttackRoll(
        await roll(roller, targetAttackRequest),
        targetAttackRequest
      );

      if (idx === 0) {
        modifierEvidence = targetModifierEvidence;
        attackRoll = targetAttackRoll;
      }

      // Jam check after each attack roll in multi-target full auto
      const isFumble = !!targetAttackRoll.isFumble;
      const jamResult = resolveJamOutcome(
        isFumble,
        fireMode,
        context.weapon?.snapshot?.reliability,
        context.weapon?.name || "Weapon"
      );

      let forceMiss = false;

      if (jamResult.isJam) {
        targetAttackRoll.isJam = true;
        actionWarnings = [...actionWarnings, ...jamResult.warnings];
        actionPendingDecisions = [...actionPendingDecisions, ...jamResult.pendingDecisions];
        jamAborted = true;
        forceMiss = true;
      } else if (isFumble) {
        // Natural 1 is an automatic miss regardless of modifiers
        forceMiss = true;
      }

      if (forceMiss || jamAborted) {
        targets.push({
          target: clonePlainData(target),
          attack: {
            roll: clonePlainData(targetAttackRoll),
            targetNumber: targetAction.targetNumber || targetNumber,
            hit: false,
            margin: 0,
            warnings: [],
            ...baseTargetAttackEvidence
          },
          hits: [],
          saves: [],
          plannedUpdates: { embeddedItemUpdates: [], chatStatus: COMBAT_CHAT_STATUS.preview },
          manualResolution: { required: false },
          warnings: cloneArray(target.warnings)
        });
        continue;
      }

      targets.push(await buildTargetOutcome(
        target,
        targetAttackRoll,
        targetAction.targetNumber || targetNumber,
        targetAction,
        context.weapon,
        roller,
        options,
        roundsFiredPerTarget,
        baseTargetAttackEvidence
      ));
    }
  } else {
    // Single roll for all targets, using baseRange for the roll modifiers
    const baseAction = clonePlainData(action);
    if (rawRange === ranges.auto) baseAction.range = baseRange;
    modifierEvidence = buildModifierEvidence(baseAction, context.weapon);
    const attackRequest = buildAttackRollRequest(context, modifierEvidence);
    attackRoll = normalizeAttackRoll(await roll(roller, attackRequest), attackRequest);

    // Jam check after attack roll (single-target or shared-roll modes)
    const isFumble = !!attackRoll.isFumble;
    const jamResult = resolveJamOutcome(
      isFumble,
      fireMode,
      context.weapon?.snapshot?.reliability,
      context.weapon?.name || "Weapon"
    );

    let forceMiss = false;

    if (jamResult.isJam) {
      attackRoll.isJam = true;
      actionWarnings = [...actionWarnings, ...jamResult.warnings];
      actionPendingDecisions = [...actionPendingDecisions, ...jamResult.pendingDecisions];
      forceMiss = true;
    } else if (isFumble) {
      // Natural 1 is an automatic miss regardless of modifiers
      forceMiss = true;
    }

    for (const target of (context.targets || [])) {
      let targetSpecificNumber = targetNumber;
      if (rawRange === ranges.auto && target?.distance?.value !== undefined && Number.isFinite(Number(target.distance.value))) {
        const weaponRange = Number(context.weapon?.snapshot?.range);
        const bracket = getRangeBracketForDistance(Number(target.distance.value), weaponRange);
        targetSpecificNumber = rangeDCs[bracket] || targetNumber;
      }

      if (forceMiss) {
        targets.push({
          target: clonePlainData(target),
          attack: {
            roll: clonePlainData(attackRoll),
            targetNumber: targetSpecificNumber,
            hit: false,
            margin: 0,
            warnings: []
          },
          hits: [],
          saves: [],
          plannedUpdates: { embeddedItemUpdates: [], chatStatus: COMBAT_CHAT_STATUS.preview },
          manualResolution: { required: false },
          warnings: cloneArray(target.warnings)
        });
        continue;
      }
      targets.push(await buildTargetOutcome(
        target,
        attackRoll,
        targetSpecificNumber,
        action,
        context.weapon,
        roller,
        options,
        roundsFired
      ));
    }
  }

  const manualTargets = targets.filter(target => target.manualResolution?.required);

  const ammoPlanning = buildAmmoPlanning(context.weapon, roundsFired);

  return {
    action: {
      ...action,
      range: rawRange,
      modifiers: modifierEvidence
    },
    attacker: clonePlainData(context.attacker || {}),
    weapon: clonePlainData(context.weapon || {}),
    targets,
    pendingDecisions: actionPendingDecisions,
    manualResolution: buildOutcomeManualResolution([
      ...manualTargets.map(target => target.manualResolution),
      ammoPlanning.manualResolution
    ].filter(Boolean)),
    ammo: ammoPlanning.ammo,
    plannedUpdates: ammoPlanning.plannedUpdates,
    chat: {
      status: COMBAT_CHAT_STATUS.preview
    },
    warnings: [...ammoPlanning.warnings, ...actionWarnings]
  };
}

export async function resolveAutoshotgunFullAutoAttack(context, options = {}, roller = undefined) {
  const itemDataIssue = preflightCombatItemData(context);
  if (itemDataIssue) return itemDataIssue;
  const action = clonePlainData(context.action || {});
  const patterns = Array.isArray(action.autoshotgunPatterns) ? action.autoshotgunPatterns : [];
  const shellCount = patterns.length;
  const shellCountManualOutcome = validateAutoshotgunShellCount(context, shellCount);
  if(shellCountManualOutcome) {
    return shellCountManualOutcome;
  }
  const patternEvidenceManualOutcome = validateAutoshotgunPatternEvidence(context, patterns);
  if(patternEvidenceManualOutcome) {
    return patternEvidenceManualOutcome;
  }
  const ammoPlanning = buildAmmoPlanning(context.weapon, shellCount);
  const targetOutcomesByKey = new Map();
  const shellEvidence = [];
  const warnings = [
    ...(ammoPlanning.warnings || []),
    ...buildAutoshotgunPatternAdjacencyWarnings(patterns)
  ];
  const pendingManualResolutions = [ammoPlanning.manualResolution].filter(Boolean);

  for(const [index, pattern] of patterns.entries()) {
    const shellIndex = Number(pattern?.shellIndex) || index + 1;
    const shellPenalty = -2 * index;
    const shellAction = buildAutoshotgunShellAction(action, pattern, shellIndex, shellPenalty);
    const modifierEvidence = buildModifierEvidence(shellAction, context.weapon);
    const attackRequest = buildAttackRollRequest({ ...context, action: shellAction }, modifierEvidence);
    const attackRoll = normalizeAttackRoll(await roll(roller, attackRequest), attackRequest);
    const targetNumber = shellAction.targetNumber || rangeDCs[normalizeRange(shellAction.range)] || action.targetNumber;
    const isFumble = !!attackRoll.isFumble;
    const isHit = !isFumble && attackRoll.total >= targetNumber;
    const affectedTargets = Array.isArray(pattern?.affectedTargets) ? pattern.affectedTargets : [];

    const shellRecord = {
      shellIndex,
      penalty: shellPenalty,
      pattern: buildAutoshotgunPatternEvidence(pattern?.template),
      attack: {
        roll: clonePlainData(attackRoll),
        targetNumber,
        hit: isHit,
        margin: isHit ? attackRoll.total - targetNumber : 0,
        modifiers: clonePlainData(modifierEvidence)
      },
      affectedTargetCount: affectedTargets.length
    };
    shellEvidence.push(shellRecord);

    if(!isHit || affectedTargets.length === 0) {
      continue;
    }

    for(const affectedTarget of affectedTargets) {
      const shellTarget = buildAutoshotgunShellTarget(affectedTarget, pattern?.template);
      const singleHitOutcome = await buildTargetOutcome(
        shellTarget,
        attackRoll,
        targetNumber,
        shellAction,
        context.weapon,
        roller,
        options,
        1,
        {
          autoshotgun: {
            shellIndex,
            penalty: shellPenalty,
            pattern: buildAutoshotgunPatternEvidence(pattern?.template)
          }
        }
      );
      mergeAutoshotgunTargetOutcome(targetOutcomesByKey, singleHitOutcome, {
        shellIndex,
        penalty: shellPenalty,
        pattern: buildAutoshotgunPatternEvidence(pattern?.template)
      });
    }
  }

  const targets = [...targetOutcomesByKey.values()];
  const manualTargets = targets.filter(target => target.manualResolution?.required);

  return {
    action: {
      ...action,
      roundsFired: shellCount,
      autoshotgun: {
        shellCount,
        shells: shellEvidence
      }
    },
    attacker: clonePlainData(context.attacker || {}),
    weapon: clonePlainData(context.weapon || {}),
    targets,
    pendingDecisions: [],
    manualResolution: buildOutcomeManualResolution([
      ...pendingManualResolutions,
      ...manualTargets.map(target => target.manualResolution)
    ].filter(Boolean)),
    ammo: ammoPlanning.ammo,
    plannedUpdates: ammoPlanning.plannedUpdates,
    chat: {
      status: COMBAT_CHAT_STATUS.preview
    },
    warnings
  };
}

function validateAutoshotgunShellCount(context, shellCount) {
  const rof = Number(context.weapon?.snapshot?.rof);
  if(!Number.isFinite(rof) || rof <= 0) {
    return buildAutoshotgunManualOutcome(context, "Autoshotgun full-auto requires a positive weapon ROF.");
  }
  if(shellCount > rof) {
    return buildAutoshotgunManualOutcome(context, `Autoshotgun declared shell count (${shellCount}) exceeds weapon ROF (${rof}).`);
  }

  const ammoState = normalizeAmmoState(context.weapon?.snapshot?.shotsLeft);
  if(!ammoState.valid) {
    return buildAutoshotgunManualOutcome(context, "Weapon ammo state is unavailable; resolve autoshotgun shell count manually.", ammoState.evidence);
  }
  if(shellCount > ammoState.value) {
    return buildAutoshotgunManualOutcome(context, `Autoshotgun declared shell count (${shellCount}) exceeds available ammo (${ammoState.value}).`);
  }
  return undefined;
}

function validateAutoshotgunPatternEvidence(context, patterns) {
  const missingPattern = patterns.find(pattern => !pattern?.template);
  if(!missingPattern) {
    return undefined;
  }
  return buildAutoshotgunManualOutcome(
    context,
    `Autoshotgun shell ${missingPattern.shellIndex || patterns.indexOf(missingPattern) + 1} is missing template evidence; resolve this shell manually.`,
    undefined,
    patterns.flatMap(pattern => cloneArray(pattern?.warnings))
  );
}

function buildAutoshotgunManualOutcome(context, message, ammoEvidence = undefined, additionalWarnings = []) {
  const ammoState = normalizeAmmoState(context.weapon?.snapshot?.shotsLeft);
  const before = ammoState.valid ? ammoState.value : ammoEvidence ?? ammoState.evidence;
  return {
    action: clonePlainData(context.action || { type: "ranged", fireMode: "FullAuto" }),
    attacker: clonePlainData(context.attacker || {}),
    weapon: clonePlainData(context.weapon || {}),
    targets: [],
    pendingDecisions: [],
    manualResolution: {
      required: true,
      reason: MANUAL_RESOLUTION_REASON.missingRuleData,
      message,
      blockedUpdateCategories: [...AMMO_BLOCKS, ...TARGET_UPDATE_BLOCKS]
    },
    ammo: {
      before,
      delta: 0,
      after: before,
      source: "weapon.snapshot.shotsLeft"
    },
    plannedUpdates: {
      itemUpdates: [],
      chatStatus: COMBAT_CHAT_STATUS.manual
    },
    chat: {
      status: COMBAT_CHAT_STATUS.manual
    },
    warnings: [
      {
        code: "autoshotgun-shell-count-invalid",
        severity: COMBAT_WARNING_SEVERITY.warning,
        message
      },
      ...cloneArray(additionalWarnings)
    ]
  };
}

function buildAutoshotgunShellAction(action, pattern, shellIndex, shellPenalty) {
  const options = clonePlainData(action.options || {});
  const existingExtraMod = Number(options.extraMod || 0);
  return {
    ...clonePlainData(action),
    fireMode: "SemiAuto",
    roundsFired: 1,
    autoshotgunShell: {
      shellIndex,
      penalty: shellPenalty,
      pattern: buildAutoshotgunPatternEvidence(pattern?.template)
    },
    options: {
      ...options,
      extraMod: existingExtraMod + shellPenalty
    }
  };
}

function buildAutoshotgunPatternAdjacencyWarnings(patterns) {
  const warnings = [];
  for(let index = 1; index < patterns.length; index++) {
    const previousOrigin = patterns[index - 1]?.template?.origin;
    const currentOrigin = patterns[index]?.template?.origin;
    if(!previousOrigin || !currentOrigin) {
      continue;
    }
    const dx = Number(currentOrigin.x) - Number(previousOrigin.x);
    const dy = Number(currentOrigin.y) - Number(previousOrigin.y);
    if(!Number.isFinite(dx) || !Number.isFinite(dy)) {
      continue;
    }
    const distance = Math.hypot(dx, dy);
    if(distance > 1) {
      warnings.push({
        code: "autoshotgun-pattern-adjacency",
        severity: COMBAT_WARNING_SEVERITY.warning,
        message: `Autoshotgun shell ${index + 1} pattern origin is ${distance.toFixed(2)}m from the previous shell; rules expect patterns within 1m.`
      });
    }
  }
  return warnings;
}

function buildAutoshotgunShellTarget(target, template) {
  const targetDistance = template?.targetDistance;
  const distance = Number.isFinite(Number(targetDistance))
    ? {
        value: Number(targetDistance),
        units: target?.distance?.units || "m",
        source: target?.distance?.source || "template"
      }
    : clonePlainData(target?.distance);

  return compactPlainObject({
    ...clonePlainData(target || {}),
    distance,
    tactical: {
      ...(clonePlainData(target?.tactical || {})),
      template: buildAutoshotgunTemplateContext(template)
    }
  });
}

function buildAutoshotgunTemplateContext(template) {
  if(!template) {
    return undefined;
  }
  return compactPlainObject({
    templateUuid: template.templateUuid,
    templateId: template.templateId,
    type: template.type,
    origin: clonePlainData(template.origin),
    direction: template.direction,
    angle: template.angle,
    width: template.width ?? template.distance,
    distance: template.distance,
    targetDistance: template.targetDistance,
    inclusion: template.inclusion
  });
}

function buildAutoshotgunPatternEvidence(template) {
  return buildAutoshotgunTemplateContext(template);
}

function mergeAutoshotgunTargetOutcome(targetOutcomesByKey, shellOutcome, shellEvidence) {
  const key = targetOutcomeKey(shellOutcome?.target);
  const hits = (shellOutcome.hits || []).map(hit => ({
    ...hit,
    autoshotgun: {
      shellIndex: shellEvidence.shellIndex,
      penalty: shellEvidence.penalty,
      pattern: clonePlainData(shellEvidence.pattern)
    }
  }));

  if(!targetOutcomesByKey.has(key)) {
    targetOutcomesByKey.set(key, {
      ...shellOutcome,
      hits,
      attack: {
        ...shellOutcome.attack,
        autoshotgun: {
          shells: [clonePlainData(shellOutcome.attack)]
        }
      }
    });
    return;
  }

  const existing = targetOutcomesByKey.get(key);
  existing.hits.push(...hits);
  existing.warnings.push(...(shellOutcome.warnings || []));
  existing.plannedUpdates.embeddedItemUpdates.push(...(shellOutcome.plannedUpdates?.embeddedItemUpdates || []));
  existing.attack.hit = existing.attack.hit || shellOutcome.attack?.hit === true;
  existing.attack.hitCount = existing.hits.length;
  existing.attack.autoshotgun.shells.push(clonePlainData(shellOutcome.attack));
  if(shellOutcome.manualResolution?.required) {
    existing.manualResolution = shellOutcome.manualResolution;
  }
}

function targetOutcomeKey(target = {}) {
  return target.id || target.tokenUuid || target.actorUuid || target.uuid || target.name || JSON.stringify(target);
}

/**
 * Resolve a melee or martial action — produces a CombatOutcome with opposed
 * roll resolution per target.
 *
 * @param {Object} context CombatActionContext with type "melee" or "martial".
 *   For "melee": context.weapon.snapshot.attackSkill is required (validated by guard).
 *   For "martial": context.action.meleeAction is required (validated by guard);
 *                  weapon.attackSkill is NOT required (skill comes from martial art selection).
 * @param {Object} [options] Reserved for future resolver options.
 * @param {Function} [roller] Deterministic roller for fixture support.
 * @returns {Object} CombatOutcome with opposed rolls per target.
 */
export async function resolveMeleeAction(context, options = {}, roller = undefined) {
  const itemDataIssue = preflightCombatItemData(context);
  if (itemDataIssue) return itemDataIssue;
  const action = clonePlainData(context.action || {});
  const targets = await Promise.all((context.targets || []).map(async target =>
    await resolveMeleeTargetOutcome(target, context, options, roller)
  ));
  const manualTargets = targets.filter(t => t.manualResolution?.required);

  // Collect per-target pendingDecisions into root pendingDecisions
  const allPending = targets
    .filter(t => Array.isArray(t.pendingDecisions))
    .flatMap(t => t.pendingDecisions);

  // Derive martialCategory directly from context action (not from targets —
  // category is determined by meleeAction alone, independent of target count)
  const meleeActionKey = String(context.action?.meleeAction || "").toLowerCase().trim();
  const martialCategory = context.action?.type === "martial"
    ? MARTIAL_ACTION_CLASSIFICATIONS[meleeActionKey] || "damageOnly"
    : undefined;

  return {
    action: {
      ...action,
      ...(martialCategory ? { martialCategory } : {})
    },
    attacker: clonePlainData(context.attacker || {}),
    weapon: clonePlainData(context.weapon || {}),
    targets,
    pendingDecisions: allPending,
    manualResolution: buildOutcomeManualResolution([
      ...manualTargets.map(t => t.manualResolution)
    ].filter(Boolean)),
    ammo: {},
    plannedUpdates: {
      itemUpdates: [],
      chatStatus: COMBAT_CHAT_STATUS.preview
    },
    chat: {
      status: COMBAT_CHAT_STATUS.preview
    },
    warnings: []
  };
}

/**
 * Resolve opposed melee for one target.
 *
 * @param {Object} target Pre-normalized target with snapshot.
 * @param {Object} context CombatActionContext with type "melee" or "martial".
 * @param {Object} options Resolver options (reserved for future).
 * @param {Function} roller Deterministic roller.
 * @returns {Object} CombatTargetOutcome with opposed roll and optional damage.
 */
async function resolveMeleeTargetOutcome(target, context, options, roller) {
  const targetWarnings = cloneArray(target.warnings);
  let manualResolution = target.manualResolution
    ? clonePlainData(target.manualResolution)
    : { required: false };

  // 1. Early exit for manual-resolution targets
  if (manualResolution.required) {
    return meleeManualTarget(target, manualResolution, targetWarnings);
  }

  // 2. Resolve attacker skill
  let attackSkill = context.weapon?.snapshot?.attackSkill;
  const isMartial = context.action?.type === "martial";
  if (isMartial) {
    attackSkill = context.action.options?.martialArt || "brawling";
  }
  if (!attackSkill) attackSkill = "melee";

  const attacker = context.attacker;
  const attackerRef = attacker?.snapshot?.stats?.ref?.total || 0;
  const attackerSkillLevel = getSkillValueCaseInsensitive(attacker?.snapshot?.skills, attackSkill);

  // 2a. Key technique bonus (martial arts only)
  const meleeAction = String(context.action?.meleeAction || "").toLowerCase().trim();
  const keyTechniqueBonus = isMartial ? getKeyTechniqueBonus(attackSkill, meleeAction) : 0;

  // 2b. Determine martial category
  const martialCategory = isMartial
    ? (MARTIAL_ACTION_CLASSIFICATIONS[meleeAction] || "damageOnly")
    : undefined;

  const attackRequest = {
    id: "attack",
    formula: "1d10x10 + @stats.ref.total + @skill." + attackSkill,
    terms: ["1d10x10", "@stats.ref.total", "@skill." + attackSkill],
    rollData: {
      stats: { ref: { total: attackerRef } },
      skill: { [attackSkill]: attackerSkillLevel }
    }
  };
  const attackRoll = normalizeMeleeRoll(await roll(roller, attackRequest));

  // 2c. Add key technique bonus to attack roll total
  attackRoll.keyTechniqueBonus = keyTechniqueBonus;
  attackRoll.total += keyTechniqueBonus;
  if (martialCategory !== undefined) {
    attackRoll.martialCategory = martialCategory;
  }

  // 3. Defender opposed roll (case-insensitive skill lookup)
  const defenderSkill = resolveDefenderMeleeSkill(target, context, attackSkill);
  const defenderRef = target.snapshot?.stats?.ref?.total || 0;
  const defenderSkillLevel = getSkillValueCaseInsensitive(target.snapshot?.skills, defenderSkill);

  const defendRequest = {
    id: "defend",
    formula: "1d10x10 + @stats.ref.total + @skill." + defenderSkill,
    terms: ["1d10x10", "@stats.ref.total", "@skill." + defenderSkill],
    rollData: {
      stats: { ref: { total: defenderRef } },
      skill: { [defenderSkill]: defenderSkillLevel }
    }
  };
  const defendRoll = normalizeMeleeRoll(await roll(roller, defendRequest));

  // 4. Opposed result — fumble is automatic miss
  let hit = !attackRoll.isFumble && attackRoll.total > defendRoll.total;
  let margin = hit ? attackRoll.total - defendRoll.total : 0;

  // 5. Damage resolution on hit (only for damageOnly martial actions or non-martial melee)
  let hits = [];
  const plannedUpdates = { embeddedItemUpdates: [], chatStatus: COMBAT_CHAT_STATUS.preview };
  let targetManualResolution = { required: false };

  const resolveDamage = hit && (!isMartial || martialCategory === "damageOnly");

  if (resolveDamage) {
    const locationResult = await resolveHitLocation(target, context.action, roller);
    if (locationResult.manualResolution) {
      targetManualResolution = clonePlainData(locationResult.manualResolution);
    }
    targetWarnings.push(...locationResult.warnings);

    if (locationResult.hit) {
      const hitDetail = await resolveMeleeHitDamage(
        locationResult.hit,
        context,
        target,
        options,
        roller,
        plannedUpdates
      );
      hits.push(hitDetail);
    }
  }

  // 6. Prerequisite enforcement (martial actions with prerequisites)
  let targetPendingDecisions = [];
  if (isMartial) {
    const prereqs = getRequiresPrerequisite(attackSkill, meleeAction);
    if (prereqs && prereqs.length > 0 && martialCategory === "grappleFamily") {
      const prereqCheck = checkGrapplePrerequisites(target.snapshot, prereqs);

      if (prereqCheck.confirmed) {
        // Prerequisite is satisfied — suppress the pending decision
        // Action proceeds normally, no warning needed
      } else {
        // Prerequisite not confirmed — block the outcome with manual resolution
        const actionLabel = context.action?.meleeAction || meleeAction || "Unknown";
        targetPendingDecisions.push({
          reason: "prerequisite-check",
          message: `${actionLabel} requires ${prereqs.map(p => MARTIAL_PREREQ_LABELS[p.toLowerCase().trim()] || p).join(" or ")} — verify prerequisite is active before applying this outcome.`,
          action: meleeAction,
          requires: prereqs
        });

        // Override hit and margin — the opposed roll happened but the
        // outcome is blocked pending manual confirmation.
        hit = false;
        margin = 0;
        targetManualResolution = {
          ...targetManualResolution,
          required: true,
          reason: "prerequisite-unconfirmed",
          message: `${actionLabel} cannot be resolved: prerequisite ${prereqs.map(p => MARTIAL_PREREQ_LABELS[p.toLowerCase().trim()] || p).join(" or ")} is not confirmed on target ${target.name || target.actorUuid || "unknown"}. Verify grapple/hold state manually or set combatState.`,
          action: meleeAction,
          requires: prereqs,
          missing: prereqCheck.missing,
          combatState: target.snapshot?.combatState || {}
        };
      }
    } else if (prereqs && prereqs.length > 0) {
      // Non-grappleFamily actions (disarm, block/parry, dodge) still fire
      // pendingDecisions warnings but are NOT blocked by manual-resolution.
      const actionLabel = context.action?.meleeAction || meleeAction || "Unknown";
      targetPendingDecisions.push({
        reason: "prerequisite-check",
        message: `${actionLabel} requires ${prereqs.map(p => MARTIAL_PREREQ_LABELS[p.toLowerCase().trim()] || p).join(" or ")} — verify prerequisite is active before applying this outcome.`,
        action: meleeAction,
        requires: prereqs
      });
    }
  }

  return {
    target: clonePlainData(target),
    attack: {
      roll: attackRoll,
      opposedRoll: defendRoll,
      hit,
      margin,
      warnings: []
    },
    hits,
    saves: [],
    plannedUpdates,
    manualResolution: targetManualResolution,
    warnings: targetWarnings,
    ...(targetPendingDecisions.length > 0 ? { pendingDecisions: targetPendingDecisions } : {})
  };
}

/**
 * Build a CombatHitRecord for one melee hit (mirrors damage section of buildTargetOutcome).
 */
async function resolveMeleeHitDamage(hitLocationResult, context, target, options, roller, plannedUpdates) {
  const weapon = context.weapon?.snapshot || {};
  const targetSnapshot = target.snapshot || {};

  // Raw damage = weapon die + strengthDamageBonus(attacker BT)
  const attackerBT = context.attacker?.snapshot?.stats?.bt?.total || 0;
  const strengthBonus = strengthDamageBonus(attackerBT);
  const damageRequest = { id: "damage", formula: weapon.damage };
  const damageRoll = await roll(roller, damageRequest);
  const rawDamage = Math.max(1, damageRoll.total + strengthBonus);

  // Armor (same pattern as ranged buildTargetOutcome)
  const weaponAP = !!weapon.ap;
  const manualActionCover = context.action?.cover || context.action?.options?.cover;
  const armor = resolveArmor(weaponAP, targetSnapshot, hitLocationResult.location, {
    cover: manualActionCover,
    meleeDamageType: context.action?.type === "martial" ? "blunt" : weapon.meleeDamageType
  });
  const effectiveStoppingPower = armor.effectiveStoppingPower;
  const coverMitigation = Math.min(rawDamage, armor.cover?.effectiveStoppingPower || 0);
  const remainingAfterCover = rawDamage - coverMitigation;
  const personalMitigation = Math.min(remainingAfterCover, armor.personalArmor?.effectiveStoppingPower || 0);
  const armorMitigation = coverMitigation + personalMitigation;
  const penetratingDamageBeforeAP = rawDamage - armorMitigation;
  let penetratingDamage = penetratingDamageBeforeAP;

  if (armor.cover?.present && rawDamage > armor.cover.effectiveStoppingPower) {
    armor.warnings.push({
      code: "cover-penetrated",
      severity: COMBAT_WARNING_SEVERITY.warning,
      message: "Cover was penetrated! Remember to manually ablate the cover structure."
    });
  }

  const penetrated = rawDamage > armor.effectiveStoppingPower;

  if(armor.armorPiercing && penetratingDamage > 0) {
    penetratingDamage = Math.floor(penetratingDamage / 2);
  }

  const isHeadHit = String(hitLocationResult.location || "").toLowerCase().replace(/[^a-z]/g, "") === "head" &&
                    !target?.snapshot?.isFBC;
  const penetratingDamageBeforeMultiplier = penetratingDamage;

  if(isHeadHit) {
    penetratingDamage *= 2;
  }

  // BTM
  const bodyTypeDamage = resolveBodyTypeDamage(penetratingDamage, resolveTargetBodyType(target, hitLocationResult.location), penetrated);

  // Staged penetration
  const stagedPenetration = buildStagedPenetrationEvidence({
    enabled: resolveStagedPenetrationEnabled(context.action, options),
    penetrated: rawDamage > effectiveStoppingPower,
    rawDamage,
    armor,
    target
  });

  // Collect staged penetration updates (same pattern as buildTargetOutcome)
  if (stagedPenetration.plannedUpdate) {
    for (const update of stagedPenetration.plannedUpdate.updates) {
      const armorId = update._id;
      const updatePath = Object.keys(update).find(k => k !== "_id");
      const targetSnapshotCopy = clonePlainData(targetSnapshot);
      const armorItem = targetSnapshotCopy.equippedArmor?.find(a => a.id === armorId);
      if (armorItem) {
        const armorSystem = armorItem.system || armorItem;
        const coverageKey = Object.keys(armorSystem.coverage || {}).find(
          k => k.toLowerCase() === hitLocationResult.location.toLowerCase()
        );
        if (coverageKey) {
          if (!armorSystem.coverage[coverageKey]) armorSystem.coverage[coverageKey] = {};
          armorSystem.coverage[coverageKey].ablation = update[updatePath];
        }
      } else {
        const cyberwareItem = targetSnapshotCopy.equippedCyberware?.find(c => c.id === armorId);
        if (cyberwareItem) {
          const cyberwareSystem = cyberwareItem.system || cyberwareItem;
          cyberwareSystem.ablation = update[updatePath];
        }
      }
      plannedUpdates.embeddedItemUpdates.push({
        actorUuid: stagedPenetration.plannedUpdate.actorUuid,
        type: "Item",
        updates: [{
          _id: armorId,
          [updatePath]: update[updatePath]
        }]
      });
    }
  }

  const hitDetail = {
    ...hitLocationResult,
    damageRoll: {
      id: damageRoll.id,
      formula: damageRoll.formula || damageRequest.formula,
      total: damageRoll.total,
      die: clonePlainData(damageRoll.die || {}),
      seed: damageRoll.seed
    },
    rawDamage,
    effectiveStoppingPower,
    armorPiercing: armor.armorPiercing,
    armorMitigation,
    penetratingDamage,
    armorPiercingEvidence: armor.armorPiercing
      ? {
          ...(armor.armorPiercingEvidence || {}),
          penetratingDamageBeforeAP,
          penetratingDamageAfterAP: penetratingDamage
        }
      : undefined,
    bodyTypeModifier: bodyTypeDamage.bodyTypeModifier,
    bodyTypeMitigation: bodyTypeDamage.bodyTypeMitigation,
    minimumDamageApplied: bodyTypeDamage.minimumDamageApplied,
    finalDamage: bodyTypeDamage.finalDamage,
    strengthDamageBonus: strengthBonus,
    armor: armor,
    stagedPenetration: stagedPenetration.evidence,
    warnings: cloneArray(armor.warnings || [])
  };

  if(isHeadHit) {
    if(!hitDetail.specialCases) hitDetail.specialCases = [];
    hitDetail.specialCases.push({
      code: "head-hit-double-damage",
      damageMultiplier: 2,
      damageBeforeMultiplier: penetratingDamageBeforeMultiplier,
      damageAfterMultiplier: penetratingDamage
    });
  }

  if (stagedPenetration.warning) {
    hitDetail.warnings.push(stagedPenetration.warning);
  }

  return hitDetail;
}

/**
 * Resolve defender's response skill for opposed melee.
 * Uses case-insensitive matching against defender snapshot skills.
 */
function resolveDefenderMeleeSkill(target, context, attackerAttackSkill) {
  const targetSkills = target.snapshot?.skills || {};
  const actionType = context?.action?.type || "melee";

  if (actionType === "martial") {
    // Martial arts: defender always uses Brawling
    const brawlingKey = Object.keys(targetSkills).find(k => k.toLowerCase() === "brawling");
    return brawlingKey || "Brawling";
  }

  // Melee: try matching skill, then brawling, then melee, then fencing
  const matchingKey = Object.keys(targetSkills).find(
    k => k.toLowerCase() === String(attackerAttackSkill || "").toLowerCase()
  );
  if (matchingKey) return matchingKey;

  const brawlingKey = Object.keys(targetSkills).find(k => k.toLowerCase() === "brawling");
  if (brawlingKey) return brawlingKey;

  const meleeKey = Object.keys(targetSkills).find(k => k.toLowerCase() === "melee");
  if (meleeKey) return meleeKey;

  return "Brawling"; // final fallback — resolves to level 0 if missing
}

/**
 * Normalize a melee/martial roll result — same as normalizeAttackRoll without ranged-specific fields.
 */
function normalizeMeleeRoll(rollResult) {
  return {
    id: rollResult.id,
    formula: rollResult.formula,
    total: rollResult.total,
    die: clonePlainData(rollResult.die || {}),
    seed: rollResult.seed,
    isCritical: !!rollResult.isCritical || rollResult.die?.natural === 10,
    isFumble: !!rollResult.isFumble || rollResult.die?.natural === 1
  };
}

/**
 * Build a manual-resolution target outcome for melee.
 */
function meleeManualTarget(target, manualResolution, targetWarnings) {
  return {
    target: clonePlainData(target),
    attack: {},
    hits: [],
    saves: [],
    plannedUpdates: { embeddedItemUpdates: [], chatStatus: COMBAT_CHAT_STATUS.preview },
    manualResolution: clonePlainData(manualResolution) || { required: false },
    warnings: cloneArray(targetWarnings)
  };
}

/**
 * Get a skill's numeric value from a snapshot skills object, matching case-insensitively.
 */
function getSkillValueCaseInsensitive(skills = {}, skillName) {
  return getSkillValue(findCombatSkill(skills, skillName));
}

export function resolveBodyTypeDamage(penetratingDamage, bodyType, penetrated = false) {
  const normalizedPenetratingDamage = normalizeDamageAmount(penetratingDamage);
  const bodyTypeModifier = btmFromBT(normalizeBodyType(bodyType));
  if(normalizedPenetratingDamage <= 0 && !penetrated) {
    return {
      penetratingDamage: 0,
      bodyTypeModifier,
      bodyTypeMitigation: 0,
      finalDamage: 0,
      minimumDamageApplied: false
    };
  }

  const reducedDamage = normalizedPenetratingDamage - bodyTypeModifier;
  if(reducedDamage <= 0 || (penetrated && normalizedPenetratingDamage <= 0)) {
    return {
      penetratingDamage: Math.max(0, normalizedPenetratingDamage),
      bodyTypeModifier,
      bodyTypeMitigation: Math.max(0, normalizedPenetratingDamage - 1),
      finalDamage: 1,
      minimumDamageApplied: true
    };
  }

  return {
    penetratingDamage: normalizedPenetratingDamage,
    bodyTypeModifier,
    bodyTypeMitigation: bodyTypeModifier,
    finalDamage: reducedDamage,
    minimumDamageApplied: false
  };
}

function normalizeDamageAmount(value) {
  const numericValue = Number(value);
  return Number.isFinite(numericValue) && numericValue > 0 ? numericValue : 0;
}

function normalizeBodyType(value) {
  const numericValue = Number(value);
  return Number.isFinite(numericValue) && numericValue > 0 ? numericValue : 0;
}

function buildOutcomeManualResolution(manualResolutions) {
  if(manualResolutions.length === 0) {
    return {
      required: false
    };
  }

  const blockedUpdateCategories = new Set();
  for(const manualResolution of manualResolutions) {
    for(const category of manualResolution.blockedUpdateCategories || []) {
      blockedUpdateCategories.add(category);
    }
  }

  return {
    required: true,
    reason: manualResolutions[0].reason || MANUAL_RESOLUTION_REASON.missingRuleData,
    message: manualResolutions.length === 1 ? manualResolutions[0].message : Array.from(new Set(manualResolutions.map(r => r.message).filter(Boolean))).join("\\n") || "One or more targets require manual resolution before this outcome can be committed.",
    blockedUpdateCategories: [...blockedUpdateCategories]
  };
}

function buildAmmoPlanning(weapon, roundsFired = 1) {
  const ammoState = normalizeAmmoState(weapon?.snapshot?.shotsLeft);
  const plannedUpdates = {
    itemUpdates: [],
    chatStatus: COMBAT_CHAT_STATUS.preview
  };

  if(!ammoState.valid) {
    return {
      ammo: {
        before: ammoState.evidence,
        delta: 0,
        after: ammoState.evidence,
        source: "weapon.snapshot.shotsLeft"
      },
      plannedUpdates,
      manualResolution: ammoManualResolution("Weapon ammo state is unavailable; resolve ammo manually."),
      warnings: [
        ammoWarning("missing-ammo-state", "Weapon ammo state is unavailable; resolve ammo manually.")
      ]
    };
  }

  const shotsLeft = ammoState.value;
  if(shotsLeft <= 0) {
    return {
      ammo: {
        before: shotsLeft,
        delta: 0,
        after: shotsLeft,
        source: "weapon.snapshot.shotsLeft"
      },
      plannedUpdates,
      manualResolution: ammoManualResolution("Weapon has insufficient ammo; resolve ammo manually."),
      warnings: [
        ammoWarning("insufficient-ammo", "Weapon has insufficient ammo; resolve ammo manually.")
      ]
    };
  }

  const actualRounds = Math.min(shotsLeft, roundsFired);
  const delta = -actualRounds;
  const after = shotsLeft - actualRounds;
  const ammo = {
    before: shotsLeft,
    delta,
    after,
    source: "weapon.snapshot.shotsLeft"
  };

  if(!weapon?.itemUuid) {
    return {
      ammo,
      plannedUpdates,
      manualResolution: ammoManualResolution("Attacking weapon item UUID is unavailable; resolve ammo manually."),
      warnings: [
        ammoWarning("missing-ammo-update-target", "Attacking weapon item UUID is unavailable; resolve ammo manually.")
      ]
    };
  }

  plannedUpdates.itemUpdates.push({
    itemUuid: weapon.itemUuid,
    update: {
      "system.shotsLeft": after
    }
  });

  return {
    ammo,
    plannedUpdates,
    warnings: []
  };
}

export function normalizeAmmoState(rawShotsLeft) {
  if(rawShotsLeft === undefined || rawShotsLeft === null) {
    return {
      valid: false,
      evidence: null
    };
  }

  if(typeof rawShotsLeft === "string" && rawShotsLeft.trim() === "") {
    return {
      valid: false,
      evidence: rawShotsLeft
    };
  }

  if(typeof rawShotsLeft === "boolean") {
    return {
      valid: false,
      evidence: rawShotsLeft
    };
  }

  const value = Number(rawShotsLeft);
  if(!Number.isFinite(value) || !Number.isInteger(value)) {
    return {
      valid: false,
      evidence: rawShotsLeft
    };
  }

  return {
    valid: true,
    value
  };
}

function ammoManualResolution(message) {
  return {
    required: true,
    reason: MANUAL_RESOLUTION_REASON.missingRuleData,
    message,
    blockedUpdateCategories: [...AMMO_BLOCKS]
  };
}

function ammoWarning(code, message) {
  return {
    code,
    severity: COMBAT_WARNING_SEVERITY.warning,
    message
  };
}

async function resolveRangedDamageRoll(action, weapon, roller, target = null) {
  const attackType = normalizeAttackType(weapon?.snapshot?.attackType);
  const isShotgun = SHOTGUN_ATTACK_TYPES.includes(attackType);
  let formula = String(weapon?.snapshot?.damage ?? "").trim();
  let shotgunEvidence = undefined;
  let manualResolution = undefined;

  if (isShotgun) {
    const shotgunContext = resolveShotgunDamageContext(weapon, target);
    manualResolution = shotgunContext.manualResolution;
    if(!manualResolution) {
      formula = shotgunContext.formula;
      shotgunEvidence = {
        templateId: shotgunContext.template?.templateId,
        templateUuid: shotgunContext.template?.templateUuid,
        included: shotgunContext.template?.inclusion === "intersected",
        inclusion: shotgunContext.template?.inclusion,
        measuredDistance: shotgunContext.measuredDistance,
        bracket: shotgunContext.bracket,
        damageFormula: formula,
        patternWidthMeters: shotgunContext.patternWidthMeters,
        source: "fnff-shotgun-template"
      };
    }
  }

  const range = normalizeRange(action?.range);
  const damageRequest = {
    id: "damage",
    formula
  };

  if (manualResolution) {
    return { formula, manualResolution };
  }

  const maximizeDamage = isShotgun
    ? shotgunEvidence?.bracket === "pointBlank"
    : range === ranges.pointBlank;

  if(!maximizeDamage) {
    return {
      formula,
      shotgun: shotgunEvidence,
      damageRoll: await roll(roller, damageRequest)
    };
  }

  const maximumDamage = calculateMaximumDamage(formula);
  if(maximumDamage === null) {
    return {
      formula,
      damageRoll: await roll(roller, damageRequest),
      warning: {
        code: "point-blank-max-damage-unsupported-formula",
        severity: COMBAT_WARNING_SEVERITY.warning,
        message: `Point-blank maximum damage could not parse "${formula}"; rolled damage normally.`
      },
      shotgun: shotgunEvidence
    };
  }

  return {
    formula,
    damageRoll: {
      id: "damage",
      formula,
      total: maximumDamage.total,
      die: {
        results: maximumDamage.results
      },
      maximized: true
    },
    shotgun: shotgunEvidence
  };
}

function normalizeAttackType(attackType) {
  return String(attackType || "").toLowerCase().trim();
}

function resolveShotgunDamageContext(weapon, target) {
  const template = target?.tactical?.template;
  const measuredDistance = resolveShotgunMeasuredDistance(target);
  const templateIssue = getShotgunTemplateIssue(template);
  if(templateIssue) {
    return { manualResolution: shotgunManualResolution(templateIssue) };
  }
  if(!measuredDistance || !Number.isFinite(Number(measuredDistance.value))) {
    return { manualResolution: shotgunManualResolution("Missing finite measured distance for shotgun spread.") };
  }
  if(measuredDistance.units && measuredDistance.units !== "m") {
    return { manualResolution: shotgunManualResolution("Shotgun spread distance must be normalized to meters before resolution.") };
  }

  const weaponRange = Number(weapon?.snapshot?.range);
  const distanceValue = Number(measuredDistance.value);
  const attackType = normalizeAttackType(weapon?.snapshot?.attackType);
  if(attackType === "autoshotgun" && distanceValue > getMaxRangeBracketDistance(weaponRange, ranges.long)) {
    return { manualResolution: shotgunManualResolution("Extreme-range shotgun pattern damage is not defined; resolve autoshotgun damage manually.") };
  }
  const bracket = distanceValue <= getMaxRangeBracketDistance(weaponRange, ranges.pointBlank)
    ? "pointBlank"
    : distanceValue <= getMaxRangeBracketDistance(weaponRange, ranges.close)
      ? "close"
      : distanceValue <= getMaxRangeBracketDistance(weaponRange, ranges.medium)
        ? "medium"
        : "far";
  const bracketConfig = SHOTGUN_BRACKETS[bracket];
  const formula = selectShotgunDamageFormula(weapon?.snapshot?.rangeDamages, bracketConfig.damageKeys);
  if(!formula) {
    return { manualResolution: shotgunManualResolution(`Missing shotgun damage formula for ${bracket} range.`) };
  }

  return {
    template,
    measuredDistance,
    bracket,
    patternWidthMeters: bracketConfig.patternWidthMeters,
    formula
  };
}

function resolveShotgunMeasuredDistance(target) {
  const templateDistance = target?.tactical?.template?.targetDistance;
  if(templateDistance !== undefined && templateDistance !== null) {
    return compactPlainObject({
      value: templateDistance,
      units: target?.distance?.units || "m",
      source: target?.distance?.source || "template"
    });
  }
  if(target?.distance?.value !== undefined && target?.distance?.value !== null) {
    return clonePlainData(target.distance);
  }
  return undefined;
}

function getShotgunTemplateIssue(template) {
  if(!template) {
    return undefined; // Allows fallback to target.distance
  }
  if(!template.type || !template.origin || !template.inclusion) {
    return "Missing template geometry, attacker/template origin, or inclusion evidence for shotgun spread.";
  }
  if(template.inclusion !== "intersected") {
    return "Shotgun template inclusion is ambiguous and requires manual resolution.";
  }
  return undefined;
}

function selectShotgunDamageFormula(rangeDamages, damageKeys) {
  if(!rangeDamages || typeof rangeDamages !== "object") {
    return undefined;
  }
  for(const key of damageKeys) {
    const formula = String(rangeDamages[key] || "").trim();
    if(formula) {
      return formula;
    }
  }
  return undefined;
}

function shotgunManualResolution(message) {
  return {
    required: true,
    reason: MANUAL_RESOLUTION_REASON.missingRuleData,
    message,
    blockedUpdateCategories: [...TARGET_UPDATE_BLOCKS]
  };
}

function calculateMaximumDamage(formula) {
  const compactFormula = String(formula || "").replace(/\s+/g, "");
  if(!compactFormula || !/^[+-]?(?:\d*d\d+|\d+)(?:[+-](?:\d*d\d+|\d+))*$/i.test(compactFormula)) {
    return null;
  }

  const terms = compactFormula.match(/[+-]?(?:\d*d\d+|\d+)/gi) || [];
  const results = [];
  let total = 0;

  for(const term of terms) {
    const sign = term.startsWith("-") ? -1 : 1;
    const unsignedTerm = term.replace(/^[+-]/, "");
    const diceMatch = unsignedTerm.match(/^(\d*)d(\d+)$/i);
    if(diceMatch) {
      if(sign < 0) {
        return null;
      }
      const count = diceMatch[1] ? Number(diceMatch[1]) : 1;
      const faces = Number(diceMatch[2]);
      if(!Number.isInteger(count) || count <= 0 || !Number.isInteger(faces) || faces <= 0) {
        return null;
      }
      for(let i = 0; i < count; i++) {
        results.push(sign * faces);
      }
      total += sign * count * faces;
      continue;
    }

    const constant = Number(unsignedTerm);
    if(!Number.isFinite(constant)) {
      return null;
    }
    total += sign * constant;
  }

  return { total, results };
}

async function buildTargetOutcome(target, attackRoll, targetNumber, action, weapon, roller, resolverOptions = {}, roundsFired = 1, attackEvidence = {}) {
  const margin = attackRoll.total - targetNumber;
  const hit = margin >= 0;
  const targetWarnings = cloneArray(target.warnings);
  let manualResolution = target.manualResolution
    ? clonePlainData(target.manualResolution)
    : { required: false };
  let hits = [];
  const plannedUpdates = {
    embeddedItemUpdates: [],
    chatStatus: COMBAT_CHAT_STATUS.preview
  };

  const fireMode = String(action.fireMode || "").toLowerCase();
  let burstHitsRoll = null;
  let hitCount = 0;

  if(hit && !manualResolution.required) {
    let numHits = 1;
    if (fireMode === "threeroundburst") {
      const burstHitsRequest = {
        id: "burst_hits",
        formula: "1d3"
      };
      burstHitsRoll = await roller(burstHitsRequest);
      numHits = Math.min(burstHitsRoll.total, roundsFired);
    } else if (fireMode === "suppressive" || fireMode === "suppressivefire") {
      numHits = Math.max(0, Math.floor(Number(roundsFired) || 0));
    } else if (fireMode === "fullauto") {
      numHits = Number.isFinite(roundsFired) && roundsFired > 0 ? Math.max(1, Math.min(roundsFired, margin)) : 0;
    }
    hitCount = numHits;

    const targetSnapshotCopy = clonePlainData(target.snapshot || {});
    const accumulatedAblations = {};
    let accumulatedCoverAblation = 0;

    for (let i = 0; i < numHits; i++) {
      const locationResult = await resolveHitLocation(target, buildMultiHitLocationAction(action, i), roller);
      if(locationResult.manualResolution) {
        if (!manualResolution.required) {
          manualResolution = clonePlainData(locationResult.manualResolution);
        } else {
          const categories = new Set([
            ...(manualResolution.blockedUpdateCategories || []),
            ...(locationResult.manualResolution.blockedUpdateCategories || [])
          ]);
          manualResolution.blockedUpdateCategories = [...categories];
        }
      }
      targetWarnings.push(...locationResult.warnings);

      if(locationResult.hit) {
        const hitDetail = locationResult.hit;

        const damageResult = await resolveRangedDamageRoll(action, weapon, roller, target);
        if (damageResult.manualResolution) {
          manualResolution = clonePlainData(damageResult.manualResolution);
          hits.push(hitDetail);
          break;
        }

        const damageRoll = damageResult.damageRoll;
        hitDetail.shotgun = damageResult.shotgun;

        const weaponAP = !!weapon?.snapshot?.ap;
        const coverInput = selectRangedCoverInput(action, target);
        if(coverInput && Number.isFinite(Number(coverInput.stoppingPower ?? coverInput.sp))) {
          coverInput.ablation = accumulatedCoverAblation;
        }
        const armor = resolveArmor(weaponAP, targetSnapshotCopy, hitDetail.location, { cover: coverInput });
        const effectiveStoppingPower = armor.effectiveStoppingPower;

        const rawDamage = damageRoll.total;
        const coverMitigation = Math.min(rawDamage, armor.cover?.effectiveStoppingPower || 0);
        const remainingAfterCover = rawDamage - coverMitigation;
        const personalMitigation = Math.min(remainingAfterCover, armor.personalArmor?.effectiveStoppingPower || 0);
        const armorMitigation = coverMitigation + personalMitigation;
        const penetratingDamageBeforeAP = rawDamage - armorMitigation;
        let penetratingDamage = penetratingDamageBeforeAP;

        if (armor.cover?.present && rawDamage > armor.cover.effectiveStoppingPower) {
          armor.warnings.push({
            code: "cover-penetrated",
            severity: COMBAT_WARNING_SEVERITY.warning,
            message: "Cover was penetrated! Remember to manually ablate the cover structure."
          });
        }

        const penetrated = rawDamage > effectiveStoppingPower;

        if(armor.armorPiercing && penetratingDamage > 0) {
          penetratingDamage = Math.floor(penetratingDamage / 2);
        }

        const isHeadHit = String(hitDetail.location || "").toLowerCase().replace(/[^a-z]/g, "") === "head" &&
                          !target?.snapshot?.isFBC;
        const penetratingDamageBeforeMultiplier = penetratingDamage;

        if(isHeadHit) {
          penetratingDamage *= 2;
        }

        const bodyTypeDamage = resolveBodyTypeDamage(penetratingDamage, resolveTargetBodyType(target, hitDetail.location), penetrated);

        const stagedPenetration = buildStagedPenetrationEvidence({
          enabled: resolveStagedPenetrationEnabled(action, resolverOptions),
          penetrated: rawDamage > effectiveStoppingPower,
          rawDamage,
          armor,
          target
        });

        if(stagedPenetration.evidence?.cover?.ablation?.after !== undefined) {
          accumulatedCoverAblation = stagedPenetration.evidence.cover.ablation.after;
        }

        if(stagedPenetration.plannedUpdate) {
          for (const update of stagedPenetration.plannedUpdate.updates) {
            const armorId = update._id;
            const updatePath = Object.keys(update).find(k => k !== "_id");

            const ablationKey = `${armorId}-${updatePath}`;
            accumulatedAblations[ablationKey] = {
              actorUuid: stagedPenetration.plannedUpdate.actorUuid,
              type: "Item",
              _id: armorId,
              updatePath,
              value: update[updatePath]
            };

            const armorItem = targetSnapshotCopy.equippedArmor?.find(a => a.id === armorId);
            if(armorItem) {
              const armorSystem = armorItem.system || armorItem;
              const coverageKey = Object.keys(armorSystem.coverage || {}).find(
                k => k.toLowerCase() === hitDetail.location.toLowerCase()
              );
              if(coverageKey) {
                if(!armorSystem.coverage[coverageKey]) {
                  armorSystem.coverage[coverageKey] = {};
                }
                armorSystem.coverage[coverageKey].ablation = update[updatePath];
              }
            } else {
              const cyberwareItem = targetSnapshotCopy.equippedCyberware?.find(c => c.id === armorId);
              if(cyberwareItem) {
                const cyberwareSystem = cyberwareItem.system || cyberwareItem;
                if (updatePath.startsWith("system.fbcHitLocations.")) {
                  const pathParts = updatePath.split('.');
                  if (pathParts.length >= 4) {
                    const key = pathParts[2];
                    if (cyberwareSystem.fbcHitLocations && cyberwareSystem.fbcHitLocations[key]) {
                      cyberwareSystem.fbcHitLocations[key].ablation = update[updatePath];
                    }
                  }
                } else if (updatePath.startsWith("system.coverage.")) {
                  const pathParts = updatePath.split('.');
                  if (pathParts.length >= 4) {
                    const key = pathParts[2];
                    if (cyberwareSystem.coverage && cyberwareSystem.coverage[key]) {
                      cyberwareSystem.coverage[key].ablation = update[updatePath];
                    }
                  }
                } else {
                  cyberwareSystem.ablation = update[updatePath];
                }
              }
            }
          }
        }

        if(stagedPenetration.warning) {
          hitDetail.warnings.push(stagedPenetration.warning);
        }
        if(damageResult.warning) {
          hitDetail.warnings.push(damageResult.warning);
        }

        hitDetail.damageRoll = {
          id: damageRoll.id,
          formula: damageRoll.formula || damageResult.formula,
          total: damageRoll.total,
          die: clonePlainData(damageRoll.die || {}),
          seed: damageRoll.seed,
          ...(damageRoll.maximized ? { maximized: true } : {})
        };
        hitDetail.rawDamage = rawDamage;
        hitDetail.effectiveStoppingPower = effectiveStoppingPower;
        hitDetail.armorPiercing = armor.armorPiercing;
        hitDetail.armorMitigation = armorMitigation;
        hitDetail.penetratingDamage = penetratingDamage;
        hitDetail.armorPiercingEvidence = {
          ...(armor.armorPiercingEvidence || {}),
          penetratingDamageBeforeAP,
          penetratingDamageAfterAP: penetratingDamage
        };
        hitDetail.bodyTypeModifier = bodyTypeDamage.bodyTypeModifier;
        hitDetail.bodyTypeMitigation = bodyTypeDamage.bodyTypeMitigation;
        hitDetail.minimumDamageApplied = bodyTypeDamage.minimumDamageApplied;
        hitDetail.finalDamage = bodyTypeDamage.finalDamage;
        hitDetail.armor = armor;
        hitDetail.stagedPenetration = stagedPenetration.evidence;
        hitDetail.cover = buildCoverHitEvidence({
          cover: armor.cover,
          rawDamage,
          coverMitigation,
          stagedPenetration: stagedPenetration.evidence
        });
        hitDetail.warnings.push(...armor.warnings);

        if(isHeadHit) {
          if(!hitDetail.specialCases) hitDetail.specialCases = [];
          hitDetail.specialCases.push({
            code: "head-hit-double-damage",
            damageMultiplier: 2,
            damageBeforeMultiplier: penetratingDamageBeforeMultiplier,
            damageAfterMultiplier: penetratingDamage
          });
        }

        hits.push(hitDetail);
      }
    }

    for (const record of Object.values(accumulatedAblations)) {
      plannedUpdates.embeddedItemUpdates.push({
        actorUuid: record.actorUuid,
        type: record.type,
        updates: [
          {
            _id: record._id,
            [record.updatePath]: record.value
          }
        ]
      });
    }
  }

  return {
    target: clonePlainData(target),
    attack: {
      roll: clonePlainData(attackRoll),
      targetNumber,
      hit,
      margin,
      warnings: [],
      ...clonePlainData(attackEvidence),
      hitCount,
      ...(burstHitsRoll ? { burstHitsRoll: clonePlainData(burstHitsRoll) } : {})
    },
    hits,
    saves: [],
    plannedUpdates,
    manualResolution,
    warnings: targetWarnings
  };
}

function resolveTargetBodyType(target, locationKey) {
  if (locationKey && target?.snapshot?.hitLocations?.[locationKey]?.type === "cybernetic") {
    return 0;
  }
  return target.snapshot?.stats?.bt?.total ?? target.snapshot?.stats?.body?.total ?? 0;
}

function selectRangedCoverInput(action, target) {
  const tacticalCover = target?.tactical?.cover;
  const manualActionCover = action?.cover || action?.options?.cover;
  if(tacticalCover && tacticalCover.applies !== false) {
    return clonePlainData(tacticalCover);
  }
  return clonePlainData(manualActionCover);
}

function buildCoverHitEvidence({ cover, rawDamage, coverMitigation, stagedPenetration }) {
  if(!cover?.provided && !cover?.present) {
    return undefined;
  }
  const ablation = stagedPenetration?.cover?.ablation;
  return compactPlainObject({
    present: !!cover.present,
    provided: cover.provided === true,
    applied: cover.applied === true || !!cover.present,
    bypassed: cover.bypassed === true,
    bypassReason: cover.bypassReason,
    protectedLocations: clonePlainData(cover.protectedLocations),
    baseStoppingPower: cover.baseStoppingPower,
    rawStoppingPower: cover.rawStoppingPower,
    effectiveStoppingPower: cover.effectiveStoppingPower,
    mitigation: coverMitigation,
    source: cover.source,
    transient: cover.transient,
    penetrated: !!cover.present && rawDamage > Number(cover.effectiveStoppingPower || 0),
    ablation: clonePlainData(ablation)
  });
}

function resolveStagedPenetrationEnabled(action, resolverOptions) {
  const configured = action.options?.stagedPenetration ?? action.stagedPenetration ?? resolverOptions.stagedPenetration;
  if(configured !== undefined) {
    return !!configured;
  }
  return true;
}

function buildStagedPenetrationEvidence({ enabled, penetrated, rawDamage, armor, target }) {
  if(!enabled) {
    return {
      evidence: {
        enabled: false,
        applied: false,
        reason: "disabled"
      }
    };
  }

  const coverEffective = Number(armor.cover?.effectiveStoppingPower || 0);
  const parsedCoverAblation = Number(armor.cover?.ablation);
  const rawCoverAblation = Number.isFinite(parsedCoverAblation) ? parsedCoverAblation : 0;
  const coverPenetrated = !!armor.cover?.present && rawDamage > coverEffective;
  const coverEvidence = coverPenetrated ? {
    before: rawCoverAblation,
    after: rawCoverAblation + 1,
    applied: true
  } : undefined;

  const remainingAfterCover = Math.max(0, Number(rawDamage || 0) - Math.min(Number(rawDamage || 0), coverEffective));
  const personalEffective = Number(armor.personalArmor?.effectiveStoppingPower || 0);
  const penetratedPersonalArmor = remainingAfterCover > personalEffective;
  const personalLayers = armor.personalArmor?.layers || armor.layers || [];
  const hasPersonalLayers = personalLayers.length > 0;

  const affectedLayers = personalLayers.filter(layer => {
    return (layer.type === "armor" || layer.type === "cyberware") && layer.id && layer.updatePath;
  });

  if(!penetratedPersonalArmor) {
    if (affectedLayers.length > 0) {
      const outerLayer = affectedLayers[affectedLayers.length - 1];
      const outerSP = Number(outerLayer.stoppingPower || 0);
      if (remainingAfterCover > outerSP) {
        const currentAblation = Number(outerLayer.ablation) || 0;
        return {
          evidence: {
            enabled: true,
            applied: true,
            reason: "stress",
            layer: {
              id: outerLayer.id,
              name: outerLayer.name,
              ablation: {
                before: currentAblation,
                after: currentAblation + 1,
                applied: true
              }
            }
          },
          plannedUpdate: {
            actorUuid: target.actorUuid || target.snapshot?.actorUuid,
            updates: [
              {
                _id: outerLayer.id,
                [outerLayer.updatePath]: currentAblation + 1
              }
            ]
          }
        };
      }
    }

    if(coverEvidence) {
      return {
        evidence: {
          enabled: true,
          applied: true,
          reason: "penetrated-manual-cover",
          cover: {
            id: armor.cover?.id || "cover",
            name: armor.cover?.name || "Cover",
            source: armor.cover?.source || "manual cover",
            ablation: coverEvidence
          }
        }
      };
    }
    return {
      evidence: {
        enabled: true,
        applied: false,
        reason: "no-penetration"
      }
    };
  }

  if(affectedLayers.length === 0) {
    if(coverEvidence && !hasPersonalLayers) {
      return {
        evidence: {
          enabled: true,
          applied: true,
          reason: "penetrated-manual-cover",
          cover: {
            id: armor.cover?.id || "cover",
            name: armor.cover?.name || "Cover",
            source: armor.cover?.source || "manual cover",
            ablation: coverEvidence
          }
        }
      };
    }
    const message = "Staged penetration penetrated armor, but no item-backed armor coverage update path was available.";
    return {
      evidence: {
        enabled: true,
        applied: false,
        reason: "no-item-backed-armor",
        ...(coverEvidence ? { cover: { ablation: coverEvidence } } : {})
      },
      warning: {
        code: "staged-penetration-no-update-target",
        severity: COMBAT_WARNING_SEVERITY.warning,
        message
      }
    };
  }

  const outerLayer = affectedLayers[affectedLayers.length - 1];
  const affectedLayerEvidence = affectedLayers.map(layer => {
    const before = Number(layer.ablation || 0);
    return {
      itemId: layer.id,
      coverageKey: layer.coverageKey,
      updatePath: layer.updatePath,
      before,
      after: before + 1
    };
  });

  if(!target.actorUuid) {
    const message = "Staged penetration penetrated armor, but target actor UUID is unavailable for an embedded item update.";
    return {
      evidence: {
        enabled: true,
        applied: false,
        reason: "missing-target-actor-uuid",
        itemId: outerLayer.id,
        coverageKey: outerLayer.coverageKey,
        updatePath: outerLayer.updatePath,
        affectedLayers: affectedLayerEvidence,
        ...(coverEvidence ? { cover: { ablation: coverEvidence } } : {})
      },
      warning: {
        code: "staged-penetration-missing-actor-uuid",
        severity: COMBAT_WARNING_SEVERITY.warning,
        message
      }
    };
  }

  const updates = affectedLayers.map((layer, index) => {
    const evidence = affectedLayerEvidence[index];
    return {
      _id: layer.id,
      [layer.updatePath]: evidence.after
    };
  });

  return {
    evidence: {
      enabled: true,
      applied: true,
      reason: coverEvidence ? "penetrated-manual-cover-and-item-backed-armor" : "penetrated-item-backed-armor",
      itemId: outerLayer.id,
      coverageKey: outerLayer.coverageKey,
      updatePath: outerLayer.updatePath,
      before: Number(outerLayer.ablation || 0),
      after: Number(outerLayer.ablation || 0) + 1,
      affectedLayers: affectedLayerEvidence,
      ...(coverEvidence ? { cover: { ablation: coverEvidence } } : {})
    },
    plannedUpdate: {
      actorUuid: target.actorUuid,
      type: "Item",
      updates
    }
  };
}

async function resolveHitLocation(target, action, roller) {
  const hitLocations = target.snapshot?.hitLocations;
  if(action.targetArea) {
    const locationEntry = findHitLocationEntry(action.targetArea, hitLocations);
    return {
      hit: {
        location: action.targetArea,
        locationLabel: locationEntry?.label,
        locationRoll: {
          formula: "aimed location",
          location: action.targetArea
        },
        warnings: []
      },
      warnings: []
    };
  }

  if(!hitLocations || Object.keys(hitLocations).length === 0) {
    return missingHitLocationResult();
  }

  const locationRequest = {
    id: "location",
    formula: "1d10 hit location"
  };
  const locationRoll = normalizeLocationRoll(await roll(roller, locationRequest), locationRequest);
  const location = mapLocation(locationRoll, hitLocations);

  if(!location) {
    return missingHitLocationResult();
  }

  return {
    hit: {
      location,
      locationLabel: hitLocations[location]?.label,
      locationRoll: {
        ...locationRoll,
        location
      },
      warnings: []
    },
    warnings: []
  };
}

function missingHitLocationResult() {
  return {
    manualResolution: {
      required: true,
      reason: MANUAL_RESOLUTION_REASON.missingRuleData,
      message: "Target hit-location model is unavailable; resolve hit location manually.",
      blockedUpdateCategories: [...MISSING_LOCATION_BLOCKS]
    },
    warnings: [
      {
        code: "missing-hit-location-model",
        severity: COMBAT_WARNING_SEVERITY.warning,
        message: "Target hit-location model is unavailable; resolve hit location manually."
      }
    ]
  };
}

function buildAttackRollRequest(context, modifierEvidence) {
  const attackSkill = context.weapon?.snapshot?.attackSkill;
  const attackSkillValue = attackSkill ? Number(getSkillValue(findCombatSkill(context.attacker?.snapshot?.skills, attackSkill))) || 0 : 0;
  const skillTerm = attackSkill ? `@attackSkillBonus` : undefined;
  const terms = [
    "1d10x10",
    "@stats.ref.total",
    skillTerm,
    ...modifierEvidence
      .filter(modifier => modifier.term && modifier.code !== "weaponAccuracy")
      .map(modifier => modifier.term),
    "@weapon.accuracy"
  ].filter(Boolean);

  return {
    id: "attack",
    formula: terms.join(" + "),
    terms,
    rollData: {
      stats: {
        ref: {
          total: Number(context.attacker?.snapshot?.stats?.ref?.total) || 0
        }
      },
      attackSkillBonus: attackSkillValue,
      modifier: Object.fromEntries(modifierEvidence.map(modifier => [modifier.code, Number.isFinite(modifier.value) ? modifier.value : 0])),
      weapon: {
        accuracy: Number(context.weapon?.snapshot?.accuracy) || 0
      }
    }
  };
}

function buildModifierEvidence(action, weapon) {
  const options = {
    ...(action.options || {}),
    targetArea: action.targetArea || action.options?.targetArea
  };
  const range = normalizeRange(action.range);
  const evidence = [
    {
      code: "range",
      label: "Range",
      value: range,
      targetNumber: rangeDCs[range] || action.targetNumber
    },
    {
      code: "fireMode",
      label: "Fire Mode",
      value: action.fireMode
    }
  ];

  for(const modifier of RANGED_MODIFIERS) {
    let value = modifier.value(options);
    if(!Number.isFinite(value)) value = 0;
    if(modifier.include(value)) {
      evidence.push({
        code: modifier.code,
        label: modifier.label,
        value,
        term: modifier.term
      });
    }
  }

  const fireMode = String(action.fireMode || "").toLowerCase();
  if (
    fireMode === "threeroundburst"
    && (range === ranges.close || range === ranges.medium)
    && Number(action.roundsFired || 0) >= 3
  ) {
    evidence.push({
      code: "threeRoundBurst",
      label: "Three-Round Burst",
      value: 3,
      term: "@modifier.threeRoundBurst"
    });
  } else if (fireMode === "fullauto") {
    const rawShotsLeft = normalizeAmmoState(weapon?.snapshot?.shotsLeft);
    const rof = Math.max(0, Number(weapon?.snapshot?.rof) || 0);
    const shotsLeft = rawShotsLeft.valid ? rawShotsLeft.value : rof;
    const bullets = action.roundsFiredPerTarget !== undefined ? action.roundsFiredPerTarget : Math.max(0, Math.min(shotsLeft, rof));

    let multiplier = 0;
    if (range === ranges.close || range === ranges.pointBlank) {
      multiplier = 1;
    } else {
      multiplier = -1;
    }

    let value = multiplier * Math.floor(bullets / 10);
    if(!Number.isFinite(value)) value = 0;
    if(value !== 0) {
      evidence.push({
        code: "fullAuto",
        label: "Full Auto",
        value,
        term: "@modifier.fullAuto"
      });
    }
  }

  evidence.push({
    code: "weaponAccuracy",
    label: "Weapon Accuracy",
    value: Number(weapon?.snapshot?.accuracy) || 0,
    term: "@weapon.accuracy"
  });

  return evidence;
}

function normalizeAttackRoll(rollResult, request) {
  const die = clonePlainData(rollResult.die || {});
  const natural = die.natural;

  return {
    id: rollResult.id,
    formula: rollResult.formula || request.formula,
    terms: clonePlainData(rollResult.terms || request.terms),
    total: rollResult.total,
    die,
    seed: rollResult.seed,
    isCritical: rollResult.isCritical ?? natural === 10,
    isFumble: rollResult.isFumble ?? natural === 1
  };
}

function normalizeLocationRoll(rollResult, request) {
  return {
    id: rollResult.id,
    formula: rollResult.formula || request.formula,
    total: rollResult.total,
    die: clonePlainData(rollResult.die || {}),
    seed: rollResult.seed,
    ...(rollResult.location !== undefined ? { location: rollResult.location } : {})
  };
}

function mapLocation(locationRoll, hitLocations) {
  const requestedLocation = locationRoll.location || defaultAreaLookup[locationRoll.die?.natural] || defaultAreaLookup[locationRoll.total];
  return findHitLocationEntry(requestedLocation, hitLocations)?.key;
}

function findHitLocationEntry(requestedLocation, hitLocations = {}) {
  if(!requestedLocation) {
    return undefined;
  }

  const requested = String(requestedLocation).toLowerCase();
  const entry = Object.entries(hitLocations).find(([key, value]) => {
    return key.toLowerCase() === requested || String(value?.label || "").toLowerCase() === requested;
  });
  if(!entry) {
    return undefined;
  }
  return {
    key: entry[0],
    label: entry[1]?.label
  };
}

async function roll(roller, request) {
  if(typeof roller !== "function") {
    throw new Error("Structured combat resolution requires a deterministic roller until Foundry rolling is wired.");
  }
  return await roller(request);
}

export async function resolveSuppressiveFireDamageOutcome(context = {}, options = {}, roller = undefined) {
  const hitCount = Math.max(0, Math.floor(Number(context.hitCount) || 0));
  const action = {
    type: "ranged",
    fireMode: "Suppressive",
    ...(clonePlainData(context.action || {}) || {}),
    roundsFired: hitCount,
    suppressiveHits: hitCount
  };
  const weapon = clonePlainData(context.weapon || {});
  const target = clonePlainData(context.target || context.targets?.[0] || {});
  const itemDataIssue = preflightCombatItemData({ ...context, action, weapon, targets: [target] }, { damageOnly: true });
  if (itemDataIssue) return itemDataIssue;
  const attackRoll = {
    id: "suppressive_save",
    formula: "failed suppressive fire save",
    total: 0,
    die: {},
    isCritical: false,
    isFumble: false
  };

  const targetOutcome = await buildTargetOutcome(
    target,
    attackRoll,
    0,
    action,
    weapon,
    roller,
    options,
    hitCount,
    {
      hitCount,
      suppressiveHits: hitCount
    }
  );

  return {
    action,
    attacker: clonePlainData(context.attacker || {}),
    weapon,
    targets: [targetOutcome],
    ammo: clonePlainData(context.ammo || { delta: 0 }),
    plannedUpdates: {
      itemUpdates: [],
      chatStatus: COMBAT_CHAT_STATUS.preview
    },
    manualResolution: {
      required: false
    },
    warnings: []
  };
}

function normalizeRange(range) {
  if(rangeDCs[range]) {
    return range;
  }
  return ranges[range] || range;
}

function getSkillValue(skill) {
  if(skill === undefined || skill === null) {
    return 0;
  }
  if(typeof skill === "number") {
    return skill;
  }
  return skill.total ?? skill.level ?? skill.value ?? 0;
}

function cloneArray(data) {
  return Array.isArray(data) ? clonePlainData(data) : [];
}

function clonePlainData(data) {
  if(data === undefined) {
    return undefined;
  }
  return JSON.parse(JSON.stringify(data));
}

function compactPlainObject(data = {}) {
  return Object.fromEntries(
    Object.entries(data).filter(([, value]) => value !== undefined)
  );
}
