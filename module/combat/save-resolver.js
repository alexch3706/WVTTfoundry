const SAVE_PROMPT_WARNING_SEVERITY = "warning";
const MORTAL_WOUND_LEVEL = 4;
const MORTAL_7_WOUND_LEVEL = 11;

/**
 * Build pending Stun/Shock and Death Save prompts from plain target outcome data.
 *
 * This module deliberately has no Foundry dependency. It consumes the same
 * damage/wound evidence that state planning and chat already use.
 *
 * @param {Object} targetOutcome CombatTargetOutcome-like plain data.
 * @returns {{saves: Array<Object>, warnings: Array<Object>}}
 */
export function resolveSavePromptsForTarget(targetOutcome = {}) {
  if(targetOutcome?.manualResolution?.required) {
    return emptyResult();
  }

  if(targetOutcome?.target?.snapshot?.isFBC === true) {
    return emptyResult();
  }

  if(targetOutcome?.attack && targetOutcome.attack.hit === false) {
    return emptyResult();
  }

  if(targetOutcome?.attack?.save?.passed === true) {
    return emptyResult();
  }

  const damageEvidence = resolveDamageEvidence(targetOutcome);
  if(damageEvidence.warning) {
    return {
      saves: [],
      warnings: [damageEvidence.warning]
    };
  }

  const bodyType = resolveBodyType(targetOutcome);
  if(bodyType.warning) {
    return {
      saves: [],
      warnings: [bodyType.warning]
    };
  }

  const previousDamageVal = damageEvidence.previousDamage !== undefined ? damageEvidence.previousDamage : 0;
  const woundState = buildWoundState(damageEvidence.nextDamage);
  const deathSaveState = resolveDeathSaveState(targetOutcome, damageEvidence, woundState);
  if(deathSaveState.dead) {
    return {
      saves: [],
      warnings: [saveWarning("target-already-dead", "Target is dead or Mortal 7+; do not generate a new Death Save prompt.")]
    };
  }

  const saves = [];
  if(damageEvidence.damageDelta > 0) {
    const hits = targetOutcome?.hits || [];
    if (hits.length === 0) {
      saves.push(buildStunPrompt(bodyType.value, woundState, damageEvidence));
    } else {
      let currentDamage = previousDamageVal;
      for (const hit of hits) {
        const woundDamage = hit.woundDamage !== undefined ? hit.woundDamage : hit.finalDamage;
        if (woundDamage > 0) {
          const hitDamageEvidence = {
            previousDamage: currentDamage,
            nextDamage: currentDamage + woundDamage,
            damageDelta: woundDamage
          };
          const hitWoundState = buildWoundState(hitDamageEvidence.nextDamage);
          saves.push(buildStunPrompt(bodyType.value, hitWoundState, hitDamageEvidence));
          currentDamage = hitDamageEvidence.nextDamage;
        }
      }
    }
  }

  if(shouldBuildAttackDeathPrompt(woundState, damageEvidence, deathSaveState)) {
    saves.push(buildDeathPrompt(bodyType.value, woundState, damageEvidence));
  }

  return {
    saves,
    warnings: []
  };
}

export function requiresRecurringDeathSave(actorOrSystem = {}) {
  const system = resolveSystemData(actorOrSystem);
  const damage = normalizeDamageValue(system?.damage);
  if(damage === undefined) {
    return false;
  }
  const woundState = buildWoundState(damage);
  return woundState.level >= MORTAL_WOUND_LEVEL
    && !isActorDeadForDeathSaves(actorOrSystem)
    && !isActorStabilizedForDeathSaves(actorOrSystem);
}

export function isActorDeadForDeathSaves(actorOrSystem = {}) {
  const system = resolveSystemData(actorOrSystem);
  const damage = normalizeDamageValue(system?.damage);
  if(damage !== undefined && buildWoundState(damage).level >= MORTAL_7_WOUND_LEVEL) {
    return true;
  }
  return readBooleanPath(system, [
    "deathSave.dead",
    "deathSave.failed",
    "deathSave.isDead",
    "deathState.dead",
    "deathState.failed",
    "woundState.dead",
    "dead",
    "isDead"
  ]);
}

export function isActorStabilizedForDeathSaves(actorOrSystem = {}) {
  const system = resolveSystemData(actorOrSystem);
  return readBooleanPath(system, [
    "deathSave.stabilized",
    "deathSave.isStabilized",
    "deathState.stabilized",
    "woundState.stabilized",
    "stabilized",
    "isStabilized"
  ]);
}

export function getDeathSaveState(actorOrSystem = {}) {
  const system = resolveSystemData(actorOrSystem);
  const damage = normalizeDamageValue(system?.damage);
  const woundState = buildWoundState(damage || 0);
  const bodyType = Number(system?.stats?.bt?.total ?? system?.stats?.body?.total);
  const mortalLevel = mortalLevelForWoundState(woundState.level);
  return {
    dead: isActorDeadForDeathSaves(actorOrSystem),
    stabilized: isActorStabilizedForDeathSaves(actorOrSystem),
    damage,
    woundState,
    mortalLevel,
    bodyType: Number.isFinite(bodyType) && bodyType > 0 ? bodyType : undefined,
    threshold: Number.isFinite(bodyType) && bodyType > 0 ? Math.max(1, bodyType - mortalLevel) : undefined,
    penalty: mortalLevel
  };
}

/** Current Stun threshold, using the same wound penalties as damage prompts. */
export function getStunSaveState(actorOrSystem = {}) {
  const { damage, woundState, bodyType } = getDeathSaveState(actorOrSystem);
  const penalty = stunPenaltyForWoundState(woundState.level);
  return {
    damage,
    woundState,
    bodyType,
    penalty,
    threshold: bodyType !== undefined ? Math.max(1, bodyType - penalty) : undefined
  };
}

export function resolveSaveThreshold(save = {}) {
  const value = Number(save.threshold ?? save.targetNumber);
  return Number.isFinite(value) ? value : undefined;
}

/** Saves are roll-under-or-equal, unlike ordinary attack and skill checks. */
export function isSaveRollSuccessful(rollTotal, save = {}) {
  const threshold = resolveSaveThreshold(save);
  const total = Number(rollTotal);
  return threshold !== undefined && Number.isFinite(total) && total <= threshold;
}

function emptyResult() {
  return {
    saves: [],
    warnings: []
  };
}

function resolveDamageEvidence(targetOutcome) {
  if(targetOutcome?.damage) {
    const previousDamage = normalizeDamageValue(targetOutcome.damage.previousDamage);
    const nextDamage = normalizeDamageValue(targetOutcome.damage.nextDamage);
    const damageDelta = normalizeDamageValue(targetOutcome.damage.damageDelta);
    if(previousDamage === undefined || nextDamage === undefined || damageDelta === undefined) {
      return {
        warning: saveWarning("missing-target-damage-state", "Target damage state is unavailable; resolve Stun/Shock and Death Saves manually.")
      };
    }
    return {
      previousDamage,
      nextDamage,
      damageDelta
    };
  }

  const currentDamage = normalizeDamageValue(targetOutcome?.target?.snapshot?.damage);
  if(currentDamage === undefined) {
    return {
      warning: saveWarning("missing-target-damage-state", "Target damage state is unavailable; resolve Stun/Shock and Death Saves manually.")
    };
  }

  const damageDelta = sumHitWoundDamage(targetOutcome?.hits);
  if(damageDelta.invalid) {
    return {
      warning: saveWarning("invalid-wound-damage", "Wound damage must be a non-negative integer before Stun/Shock and Death Saves can be planned.")
    };
  }

  return {
    previousDamage: currentDamage,
    nextDamage: currentDamage + damageDelta.value,
    damageDelta: damageDelta.value
  };
}

function sumHitWoundDamage(hits = []) {
  if(!Array.isArray(hits)) {
    return { value: 0 };
  }
  let total = 0;
  for(const hit of hits) {
    const value = hit?.woundDamage ?? hit?.finalDamage;
    if(value === undefined || value === null || value === "") {
      continue;
    }
    const damage = Number(value);
    if(!Number.isFinite(damage) || damage < 0 || !Number.isInteger(damage)) {
      return { invalid: true };
    }
    total += damage;
  }
  return { value: total };
}

function resolveBodyType(targetOutcome) {
  const value = targetOutcome?.target?.snapshot?.stats?.bt?.total
    ?? targetOutcome?.target?.snapshot?.stats?.body?.total;
  const bodyType = Number(value);
  if(!Number.isFinite(bodyType) || bodyType <= 0 || !Number.isInteger(bodyType)) {
    return {
      warning: saveWarning("missing-target-body-type", "Target Body Type is unavailable; resolve Stun/Shock and Death Saves manually.")
    };
  }
  return { value: bodyType };
}

function buildStunPrompt(bodyType, woundState, damageEvidence) {
  const penalty = stunPenaltyForWoundState(woundState.level);
  const threshold = Math.max(1, bodyType - penalty);
  return {
    type: "stun",
    status: "pending",
    reason: "damage-taken",
    bodyType,
    threshold,
    targetNumber: threshold,
    penalty,
    woundState,
    evidence: cloneDamageEvidence(damageEvidence)
  };
}

function buildDeathPrompt(bodyType, woundState, damageEvidence) {
  const mortalLevel = mortalLevelForWoundState(woundState.level);
  const threshold = Math.max(1, bodyType - mortalLevel);
  return {
    type: "death",
    status: "pending",
    reason: "mortal-wound",
    bodyType,
    threshold,
    targetNumber: threshold,
    penalty: mortalLevel,
    mortalLevel,
    woundState,
    evidence: cloneDamageEvidence(damageEvidence)
  };
}

function shouldBuildAttackDeathPrompt(woundState, damageEvidence, deathSaveState) {
  if(woundState.level < MORTAL_WOUND_LEVEL || damageEvidence.damageDelta <= 0) {
    return false;
  }
  if(deathSaveState.stabilized) {
    return false;
  }
  const previousDamageVal = damageEvidence.previousDamage !== undefined ? damageEvidence.previousDamage : 0;
  const previousWoundState = buildWoundState(previousDamageVal);
  return previousWoundState.level < MORTAL_WOUND_LEVEL;
}

function resolveDeathSaveState(targetOutcome, damageEvidence, woundState) {
  const snapshot = targetOutcome?.target?.snapshot || {};
  const actorState = {
    system: {
      ...snapshot,
      damage: damageEvidence.nextDamage
    }
  };
  return {
    dead: isActorDeadForDeathSaves(actorState) || woundState.level >= MORTAL_7_WOUND_LEVEL,
    stabilized: isActorStabilizedForDeathSaves(actorState)
  };
}

function stunPenaltyForWoundState(level) {
  if(level <= 1) {
    return 0;
  }
  return level - 1;
}

function mortalLevelForWoundState(level) {
  return Math.max(0, level - 4);
}

function buildWoundState(damage) {
  const level = damage <= 0 ? 0 : Math.ceil(damage / 4);
  return {
    level,
    label: woundStateLabel(level)
  };
}

function resolveSystemData(actorOrSystem = {}) {
  return actorOrSystem?.system || actorOrSystem || {};
}

function readBooleanPath(source = {}, paths = []) {
  return paths.some(path => {
    const value = readPath(source, path);
    return value === true || value === "true" || value === 1 || value === "1";
  });
}

function readPath(source = {}, path = "") {
  let current = source;
  for(const part of path.split(".")) {
    if(current == null || typeof current !== "object") {
      return undefined;
    }
    current = current[part];
  }
  return current;
}

function woundStateLabel(level) {
  if(level === 0) {
    return "Uninjured";
  }
  if(level === 1) {
    return "Light";
  }
  if(level === 2) {
    return "Serious";
  }
  if(level === 3) {
    return "Critical";
  }
  return `Mortal ${level - 4}`;
}

function normalizeDamageValue(value) {
  const numericValue = Number(value);
  return Number.isFinite(numericValue) && numericValue >= 0 ? numericValue : undefined;
}

function cloneDamageEvidence(damageEvidence) {
  return {
    previousDamage: damageEvidence.previousDamage,
    nextDamage: damageEvidence.nextDamage,
    damageDelta: damageEvidence.damageDelta
  };
}

function saveWarning(code, message) {
  return {
    code,
    severity: SAVE_PROMPT_WARNING_SEVERITY,
    message
  };
}
