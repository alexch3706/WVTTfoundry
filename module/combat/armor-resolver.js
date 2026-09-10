/**
 * Armor resolver for Cyberpunk 2020 combat.
 * Calculates effective stopping power (SP) at hit locations from equipped items.
 */
import { contributesBodyArmor, validateArmorContract } from "../item/item-contract.js";

const ARMOR_WARNING_SEVERITY = "warning";
const LAYER_ORDER = Object.freeze({
  cyberware: 0,
  armor: 1
});

/**
 * Extract equipped armor and cyberware layers covering a specific hit location.
 *
 * @param {Object} targetSnapshot Target actor snapshot.
 * @param {string} location Hit location name.
 * @returns {Array<Object>} Active armor layer snapshots.
 */
export function getEquippedArmorForLocation(targetSnapshot, location, options = {}) {
  const layers = [];
  if (!targetSnapshot || !location) {
    return layers;
  }

  const targetKey = String(location).toLowerCase();

  // 1. Process equipped armor items
  for (const item of targetSnapshot.equippedArmor || []) {
    const system = item.system || item;
    if (!contributesBodyArmor(system)) continue;
    if (system.equipped === false || item.equipped === false) {
      continue;
    }
    const coverageMatch = getArmorCoverageForLocation(system, targetKey);
    if (coverageMatch) {
      const { key: coverageKey, value: coverage } = coverageMatch;
      const baseSP = Number(coverage.stoppingPower !== undefined ? coverage.stoppingPower : coverage.sp || 0);
      const ablation = normalizeAblation(coverage.ablation);
      const sp = Math.max(0, baseSP - ablation);
      const edgedHalfSP = options.meleeDamageType === "edged" && system.edgedHalfSP === true;
      if ((edgedHalfSP ? Math.floor(sp / 2) : sp) > 0) {
        layers.push({
          id: item.id,
          name: item.name,
          type: "armor",
          stoppingPower: edgedHalfSP ? Math.floor(sp / 2) : sp,
          ...(edgedHalfSP ? { edgedHalfSP: true, stoppingPowerBeforeEdged: sp } : {}),
          baseStoppingPower: baseSP,
          ablation,
          coverageKey,
          updatePath: `system.coverage.${coverageKey}.ablation`,
          layer: coverage.layer || "soft",
          equipped: true,
          source: system.source || ""
        });
      }
    }
  }

  // 2. Process equipped cyberware items (e.g., Subdermal Armor / Skin Weave)
  for (const item of targetSnapshot.equippedCyberware || []) {
    const system = item.system || item;
    if (system.equipped === false || item.equipped === false) {
      continue;
    }
    if (!cyberwareCoversLocation(item, system, targetKey)) {
      continue;
    }
    const coverageMatch = getArmorCoverageForLocation(system, targetKey);
    const coverage = coverageMatch?.value;
    const baseSP = coverage
      ? Number(coverage.stoppingPower !== undefined ? coverage.stoppingPower : coverage.sp !== undefined ? coverage.sp : getCyberwareStoppingPower(item, system))
      : getCyberwareStoppingPower(item, system);
    const ablation = coverage ? normalizeAblation(coverage.ablation) : normalizeAblation(system.ablation);
    const sp = Math.max(0, baseSP - ablation);
    const edgedHalfSP = options.meleeDamageType === "edged" && system.edgedHalfSP === true;
    if ((edgedHalfSP ? Math.floor(sp / 2) : sp) > 0) {
      layers.push({
        id: item.id,
        name: item.name,
        type: "cyberware",
        stoppingPower: edgedHalfSP ? Math.floor(sp / 2) : sp,
        ...(edgedHalfSP ? { edgedHalfSP: true, stoppingPowerBeforeEdged: sp } : {}),
        baseStoppingPower: baseSP,
        ablation,
        coverageKey: coverageMatch?.key,
        updatePath: coverageMatch ? `system.${coverageMatch.pathPrefix}.${coverageMatch.key}.ablation` : "system.ablation",
        layer: coverage?.layer || getCyberwareLayer(item, system),
        equipped: true,
        source: system.source || ""
      });
    }
  }

  return layers;
}

/**
 * Resolve effective stopping power and return all layers considered.
 *
 * @param {boolean} weaponAP Whether the attacking weapon is armor-piercing.
 * @param {Object} targetSnapshot Target actor snapshot.
 * @param {string} location Hit location name.
 * @param {Object} [options] Armor resolution options.
 * @param {Object} [options.cover] Manually supplied temporary cover layer.
 * @returns {Object} Resolution details with layers, warnings, and effectiveStoppingPower.
 */
export function resolveArmor(weaponAP, targetSnapshot, location, options = {}) {
  const issues = [];
  for (const [type, items] of [["armor", targetSnapshot?.equippedArmor], ["cyberware", targetSnapshot?.equippedCyberware]]) {
    for (const item of items || []) {
      const system = item.system || item;
      if (system.equipped === false || item.equipped === false) continue;
      issues.push(...validateArmorContract(system, { type }).issues.map(issue => ({ ...issue, itemName: item.name })));
    }
  }
  if (typeof weaponAP !== "boolean") issues.push({ code: "unknown-armor-penetration", message: "Armor penetration is not a boolean; resolve special penetration manually." });
  if (issues.length) {
    return {
      layers: [], rawStoppingPower: null, effectiveStoppingPower: null,
      personalArmor: { layers: [], rawStoppingPower: null, effectiveStoppingPower: null },
      cover: { present: false }, armorPiercing: weaponAP,
      manualResolution: { required: true, reason: "missing-rule-data", issues },
      warnings: issues.map(issue => armorWarning(`item-data-${issue.code}`, `${issue.itemName ? `${issue.itemName}: ` : ""}${issue.message}`, "item-data-contract"))
    };
  }
  const personalLayers = orderArmorLayers(getEquippedArmorForLocation(targetSnapshot, location, options));
  const coverCandidate = getManualCoverLayer(options.cover, location);
  const coverLayer = coverCandidate?.applied ? coverCandidate.layer : null;
  const warnings = buildArmorWarnings(personalLayers);
  const personalRawSP = calculateProportionalStoppingPower(personalLayers);
  const coverRawSP = coverLayer ? normalizeStoppingPower(coverLayer.stoppingPower) : 0;
  const personalEffectiveSP = weaponAP ? Math.floor(personalRawSP / 2) : personalRawSP;
  const coverEffectiveSP = weaponAP ? Math.floor(coverRawSP / 2) : coverRawSP;
  const rawSP = personalRawSP + coverRawSP;
  const effectiveStoppingPower = personalEffectiveSP + coverEffectiveSP;
  const layers = coverLayer ? [...personalLayers, coverLayer] : personalLayers;

  return {
    layers,
    rawStoppingPower: rawSP,
    effectiveStoppingPower,
    personalArmor: {
      layers: personalLayers,
      rawStoppingPower: personalRawSP,
      effectiveStoppingPower: personalEffectiveSP
    },
    cover: {
      present: !!coverLayer,
      ...(coverCandidate?.evidence || {}),
      ...(coverLayer || {}),
      rawStoppingPower: coverRawSP,
      effectiveStoppingPower: coverEffectiveSP
    },
    armorPiercing: !!weaponAP,
    armorPiercingEvidence: buildArmorPiercingEvidence(weaponAP, {
      rawStoppingPower: rawSP,
      effectiveStoppingPower,
      coverRawStoppingPower: coverRawSP,
      coverEffectiveStoppingPower: coverEffectiveSP,
      personalRawStoppingPower: personalRawSP,
      personalEffectiveStoppingPower: personalEffectiveSP
    }),
    warnings
  };
}

function buildArmorPiercingEvidence(weaponAP, values) {
  return {
    applied: !!weaponAP,
    rawStoppingPower: values.rawStoppingPower,
    effectiveStoppingPower: values.effectiveStoppingPower,
    coverRawStoppingPower: values.coverRawStoppingPower,
    coverEffectiveStoppingPower: values.coverEffectiveStoppingPower,
    personalRawStoppingPower: values.personalRawStoppingPower,
    personalEffectiveStoppingPower: values.personalEffectiveStoppingPower,
    armorDivisor: weaponAP ? 2 : 1,
    penetratingDamageDivisor: weaponAP ? 2 : 1
  };
}

function calculateProportionalStoppingPower(layers) {
  if(layers.length === 0) {
    return 0;
  }

  let effectiveSP = normalizeStoppingPower(layers[0].stoppingPower);
  for(const layer of layers.slice(1)) {
    const layerSP = normalizeStoppingPower(layer.stoppingPower);
    const largerSP = Math.max(effectiveSP, layerSP);
    const smallerSP = Math.min(effectiveSP, layerSP);
    effectiveSP = largerSP + getProportionalArmorBonus(largerSP - smallerSP);
  }
  return effectiveSP;
}

function getProportionalArmorBonus(difference) {
  if(difference <= 4) {
    return 5;
  }
  if(difference <= 8) {
    return 4;
  }
  if(difference <= 14) {
    return 3;
  }
  if(difference <= 20) {
    return 2;
  }
  if(difference <= 26) {
    return 1;
  }
  return 0;
}

function orderArmorLayers(layers) {
  return layers
    .map((layer, index) => ({ layer, index }))
    .sort((left, right) => {
      const leftOrder = LAYER_ORDER[left.layer.type] ?? LAYER_ORDER.armor;
      const rightOrder = LAYER_ORDER[right.layer.type] ?? LAYER_ORDER.armor;
      return leftOrder - rightOrder || left.index - right.index;
    })
    .map(entry => entry.layer);
}

function getManualCoverLayer(cover, location) {
  if(!cover) {
    return null;
  }
  const protectedLocations = Array.isArray(cover.protectedLocations)
    ? cover.protectedLocations.map(location => String(location))
    : undefined;
  const baseStoppingPower = normalizeStoppingPower(cover.stoppingPower ?? cover.sp);
  const ablation = normalizeAblation(cover.ablation);
  const commonEvidence = compactCoverEvidence({
    provided: true,
    applies: cover.applies !== false,
    protectedLocations,
    baseStoppingPower,
    ablation,
    source: cover.source || "manual cover",
    transient: cover.transient === true
  });
  if(cover.applies === false) {
    return {
      applied: false,
      evidence: {
        ...commonEvidence,
        bypassed: true,
        bypassReason: "cover-does-not-apply"
      }
    };
  }
  if(Array.isArray(protectedLocations) && !protectedLocations.some(protectedLocation => locationsMatch(protectedLocation, location))) {
    return {
      applied: false,
      evidence: {
        ...commonEvidence,
        bypassed: true,
        bypassReason: "hit-location-unprotected"
      }
    };
  }

  const coverSP = Math.max(0, baseStoppingPower - ablation);
  if(coverSP <= 0) {
    return {
      applied: false,
      evidence: {
        ...commonEvidence,
        bypassed: true,
        bypassReason: "cover-sp-depleted"
      }
    };
  }
  return {
    applied: true,
    evidence: {
      ...commonEvidence,
      applied: true,
      bypassed: false
    },
    layer: {
      id: cover.id || "cover",
      name: cover.name || "Cover",
      type: "cover",
      stoppingPower: coverSP,
      baseStoppingPower,
      ablation,
      protectedLocations,
      layer: cover.layer || "hard",
      equipped: true,
      source: cover.source || "manual cover",
      transient: cover.transient === true,
      manual: true
    }
  };
}

function compactCoverEvidence(evidence) {
  return Object.fromEntries(
    Object.entries(evidence).filter(([, value]) => value !== undefined)
  );
}

function locationsMatch(left, right) {
  if(!right) {
    return false;
  }
  return normalizeLocationKey(left) === normalizeLocationKey(right);
}

function normalizeLocationKey(location) {
  const key = String(location || "").toLowerCase().replace(/[^a-z]/g, "");
  const aliases = {
    leftarm: "larm",
    rightarm: "rarm",
    leftleg: "lleg",
    rightleg: "rleg"
  };
  return aliases[key] || key;
}

function buildArmorWarnings(layers) {
  const warnings = [];
  if(layers.length > 3) {
    warnings.push(armorWarning(
      "armor-too-many-layers",
      "More than three armor or cover layers protect this hit location; verify the referee-approved layers.",
      "Cyberpunk 2020 core rules, Maximum Armor"
    ));
  }

  const hardLayers = layers.filter(layer => String(layer.layer || "").toLowerCase() === "hard");
  if(hardLayers.length > 1) {
    warnings.push(armorWarning(
      "armor-multiple-hard-layers",
      "More than one hard armor or cover layer protects this hit location; verify hard armor layering.",
      "Cyberpunk 2020 core rules, Maximum Armor"
    ));
  }
  return warnings;
}

function armorWarning(code, message, source) {
  return {
    code,
    severity: ARMOR_WARNING_SEVERITY,
    message,
    source
  };
}

function normalizeStoppingPower(value) {
  const numericValue = Number(value);
  return Number.isFinite(numericValue) && numericValue > 0 ? numericValue : 0;
}

function normalizeAblation(value) {
  const numericValue = Number(value);
  return Number.isFinite(numericValue) && numericValue > 0 ? numericValue : 0;
}

/**
 * Find the coverage entry in the armor's system block matching the target location case-insensitively.
 */
function getArmorCoverageForLocation(armorSystem, targetKey) {
  if (!armorSystem) return null;
  
  let coverageObj = armorSystem.coverage;
  let coveragePath = "coverage";

  if (!coverageObj && armorSystem.isFBC) {
    coverageObj = armorSystem.fbcHitLocations;
    coveragePath = "fbcHitLocations";
  }

  if (!coverageObj) {
    return null;
  }

  const entry = Object.entries(coverageObj).find(([key]) => key.toLowerCase() === targetKey);
  return entry ? { key: entry[0], value: entry[1], pathPrefix: coveragePath } : null;
}

export function getCyberwareStoppingPower(item, system) {
  const explicitSP = system.stoppingPower !== undefined ? system.stoppingPower : system.sp;
  const numericSP = Number(explicitSP);
  if (Number.isFinite(numericSP) && numericSP > 0) {
    return numericSP;
  }

  const match = getCyberwareSearchText(item, system).match(/\bsp\s*([0-9]+)/i);
  return match ? Number(match[1]) : 0;
}

function getCyberwareLayer(item, system) {
  if(system.layer) {
    return system.layer;
  }
  const searchText = getCyberwareSearchText(item, system);
  if (/\b(skin\s*weave|skinweave)\b/i.test(searchText)) {
    return "soft";
  }
  return "hard";
}

export function cyberwareCoversLocation(item, system, targetKey) {
  if (system.coverage || system.isFBC) {
    return !!getArmorCoverageForLocation(system, targetKey);
  }

  const searchText = getCyberwareSearchText(item, system);
  if (!isArmorCyberware(searchText)) {
    return false;
  }
  if (/\b(skin\s*weave|skinweave)\b/i.test(searchText)) {
    return true;
  }
  if (/\b(skull|head)\b/i.test(searchText)) {
    return targetKey === "head";
  }
  if (/\btorso\b/i.test(searchText)) {
    return targetKey === "torso";
  }
  return true;
}

export function isArmorCyberware(searchText) {
  return /\b(subdermal\s+armor|skin\s*weave|skinweave|body\s+plating)\b/i.test(searchText);
}

export function getCyberwareSearchText(item, system) {
  return [
    item.name,
    system.name,
    system.flavor,
    system.notes,
    system.cyberwareSubtype,
    system.cyberwareType
  ].filter(Boolean).join(" ");
}
