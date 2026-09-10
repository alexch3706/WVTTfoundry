import {
  getCyberwareSearchText,
  getCyberwareStoppingPower,
  isArmorCyberware
} from "./armor-resolver.js";

export function getCyberwareArmorStatus(item) {
  const system = item?.system || item || {};
  if(system.coverage || system.fbcHitLocations) {
    return getCoverageArmorStatus(system.coverage || system.fbcHitLocations, true, { requireStoppingPower: true });
  }

  const baseStoppingPower = getCyberwareStoppingPower(item || {}, system);
  const hasExplicitArmorValue = system.stoppingPower !== undefined || system.sp !== undefined || system.coverage !== undefined;
  const isArmor = baseStoppingPower > 0 && (hasExplicitArmorValue || isArmorCyberware(getCyberwareSearchText(item || {}, system)));
  const ablation = normalizeAblation(system.ablation);
  const currentStoppingPower = Math.max(0, baseStoppingPower - ablation);

  return {
    isArmor,
    baseStoppingPower,
    ablation,
    currentStoppingPower,
    repairable: isArmor && ablation > 0
  };
}

export function getArmorItemStatus(item) {
  const system = item?.system || item || {};
  const worn = !system.armorRole || system.armorRole === "wornArmor";
  return getCoverageArmorStatus(system.coverage || {}, worn && (item?.type === "armor" || !!system.coverage));
}

function getCoverageArmorStatus(coverage = {}, isArmorCandidate = false, options = {}) {
  // Body locations are alternative hit targets, not additive armor layers.
  const locations = Object.entries(coverage).map(([location, segment]) => {
    const baseStoppingPower = normalizeStoppingPower(segment?.stoppingPower ?? segment?.sp);
    const ablation = normalizeAblation(segment?.ablation);
    return { location, baseStoppingPower, ablation, currentStoppingPower: Math.max(0, baseStoppingPower - ablation) };
  }).filter(segment => segment.baseStoppingPower > 0);
  const baseStoppingPower = Math.max(0, ...locations.map(segment => segment.baseStoppingPower));
  const currentStoppingPower = Math.max(0, ...locations.map(segment => segment.currentStoppingPower));
  const ablation = Math.max(0, ...locations.map(segment => segment.ablation));

  return {
    isArmor: isArmorCandidate && (!options.requireStoppingPower || baseStoppingPower > 0),
    baseStoppingPower,
    ablation,
    currentStoppingPower,
    repairable: isArmorCandidate && locations.some(segment => segment.ablation > 0),
    locations
  };
}

export function buildArmorRepairUpdate(item) {
  if(item?.type === "armor" || item?.system?.coverage || item?.system?.fbcHitLocations) {
    return buildArmorItemRepairUpdate(item);
  }

  const status = getCyberwareArmorStatus(item);
  if(!status.isArmor) {
    return undefined;
  }
  return {
    "system.ablation": 0
  };
}

function buildArmorItemRepairUpdate(item) {
  const update = {};

  const coverage = item?.system?.coverage || {};
  for(const [coverageKey, segment] of Object.entries(coverage)) {
    if(normalizeAblation(segment?.ablation) > 0) {
      update[`system.coverage.${coverageKey}.ablation`] = 0;
    }
  }

  const fbcLocations = item?.system?.fbcHitLocations || {};
  for(const [coverageKey, segment] of Object.entries(fbcLocations)) {
    if(normalizeAblation(segment?.ablation) > 0) {
      update[`system.fbcHitLocations.${coverageKey}.ablation`] = 0;
    }
  }

  return Object.keys(update).length > 0 ? update : undefined;
}

function normalizeStoppingPower(value) {
  const numericValue = Number(value);
  return Number.isFinite(numericValue) && numericValue > 0 ? numericValue : 0;
}

function normalizeAblation(value) {
  const numericValue = Number(value);
  return Number.isFinite(numericValue) && numericValue > 0 ? numericValue : 0;
}
