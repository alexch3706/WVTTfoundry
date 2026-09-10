import { readFileSync } from "node:fs";

const overrides = JSON.parse(readFileSync(new URL("../../data/compendium-overrides/armor.json", import.meta.url), "utf8"));
const NAMESPACE = "cyberpunk2020-rilerena";
export const ARMOR_LOCATIONS = Object.freeze(["Head", "Torso", "lArm", "rArm", "lLeg", "rLeg"]);

function normalizeName(name = "") {
  return name.toLowerCase().replace(/\([^)]*\)\s*$/, "").replace(/[+*]/g, "")
    .replace(/\bw\s*hole body\b/g, "").replace(/\s+/g, " ").trim();
}

function profileFor(document) {
  const name = normalizeName(document.name);
  return overrides.profiles.find(profile => (!profile.types || profile.types.includes(document.type))
    && profile.names.some(candidate => normalizeName(candidate) === name));
}

function blankCoverage() {
  return Object.fromEntries(ARMOR_LOCATIONS.map(location => [location, { stoppingPower: 0, ablation: 0, layer: "" }]));
}

function profileCoverage(profile) {
  const coverage = blankCoverage();
  const groups = { all: ARMOR_LOCATIONS, body: ARMOR_LOCATIONS.slice(1), jacket: ["Torso", "lArm", "rArm"], legs: ["lLeg", "rLeg"], none: [] };
  const values = profile.coverage || Object.fromEntries((groups[profile.covers] || profile.covers?.split(",") || []).map(location => [location, profile.sp]));
  for(const [location, sp] of Object.entries(values)) {
    if(!ARMOR_LOCATIONS.includes(location)) throw new Error(`Unknown armor location ${location}`);
    coverage[location] = { stoppingPower: sp, ablation: 0, layer: profile.layers?.[location] || profile.layer || "" };
  }
  return coverage;
}

function retainSource(document, packName) {
  document.flags ||= {};
  document.flags[NAMESPACE] ||= {};
  const catalog = document.flags[NAMESPACE].catalog ||= {};
  catalog.sourceValues ||= structuredClone(document.system || {});
  catalog.packName ||= packName;
  catalog.version = 1;
  return catalog;
}

/** Offline only: transform a catalog source, never a user's owned Item or live DB. */
export function normalizeArmorCatalog(original, { packName = "" } = {}) {
  const document = structuredClone(original);
  if(!["armor", "cyberware"].includes(document.type)) return document;
  const profile = profileFor(document);
  const fbc = document.type === "cyberware" && overrides.fbcReview.ids.includes(document._id);
  const protectiveReview = document.type === "cyberware" && overrides.protectiveCyberwareReview.includes(document._id);
  if(document.type === "cyberware" && !profile && !fbc && !protectiveReview) return document;

  const catalog = retainSource(document, packName);
  // Always start from retained raw values, making repeated source builds idempotent.
  const sourceValues = catalog.sourceValues;
  const system = document.system ||= {};
  const reasons = [];
  system.armorRole = "wornArmor";
  system.equipped = false;
  system.encumbrance = null;
  system.edgedHalfSP = false;
  system.apDefeating = false;
  if(profile?.covers !== "none" || !Number.isFinite(profile?.sp)) delete system.specialStoppingPower;
  if(profile?.role !== "shield" && !overrides.protectedObjects.includes(document._id)) delete system.objectStoppingPower;
  system.weight = null; // Legacy imports used 1kg for every armor; it was not source data.
  system.coverage = blankCoverage();
  catalog.reviewNotes = ["Weight is unknown unless explicitly verified in the reference."];

  if(profile) {
    system.coverage = profileCoverage(profile);
    system.armorRole = profile.role || "wornArmor";
    system.encumbrance = profile.ev ?? null;
    system.weight = profile.weight ?? null;
    system.source = profile.source;
    system.edgedHalfSP = profile.edgedHalfSP === true;
    system.apDefeating = profile.apDefeating === true;
    if(profile.covers === "none" && Number.isFinite(profile.sp)) system.specialStoppingPower = profile.sp;
    if(profile.role === "shield") system.objectStoppingPower = profile.sp;
    reasons.push(...(profile.manual || []));
    catalog.provenance = { reference: overrides.reference.title, pdfPage: profile.page ?? null, source: profile.source, ...(profile.url ? { url: profile.url } : {}) };
  } else if(document.type === "armor" && overrides.protectedObjects.includes(document._id)) {
    system.armorRole = "protectedObject";
    system.objectStoppingPower = Math.max(0, ...Object.values(sourceValues.coverage || {}).map(segment => Number(segment.stoppingPower) || 0));
    system.encumbrance = 0;
    const explicitWeight = document.name.match(/\b(\d+(?:\.\d+)?)\s*kg\b/i);
    if(explicitWeight) system.weight = Number(explicitWeight[1]);
    catalog.provenance = { source: "Original item identity and explicitly stated object SP" };
  } else if(document.type === "armor" && overrides.clothing.includes(document._id)) {
    system.armorRole = "clothing";
    system.encumbrance = 0;
    catalog.provenance = { source: "Original unarmored fashion item" };
  } else if(document.type === "armor" && overrides.damagedRecords.includes(document._id)) {
    system.armorRole = "protectedObject";
    reasons.push("Imported entry is a table fragment, service or ambiguous item identity; verify before using as equipment.");
  } else if(fbc) {
    // A partial FBC must not silently change BTM, saves or limb SDP on equip.
    system.isFBC = false;
    reasons.push(overrides.fbcReview.reason);
    catalog.provenance = { reference: overrides.reference.title, pdfPage: 109, urls: overrides.fbcReview.sources };
  } else {
    // Keep any valid explicit SP visible for review, but do not invent missing EV/material.
    for(const location of ARMOR_LOCATIONS) {
      const segment = sourceValues.coverage?.[location];
      if(typeof segment?.stoppingPower === "number" && Number.isFinite(segment.stoppingPower) && segment.stoppingPower >= 0) {
        system.coverage[location].stoppingPower = segment.stoppingPower;
      }
    }
    reasons.push(document.type === "cyberware"
      ? overrides.protectiveCyberwareReviewReasons?.[document._id] || "Protective cyberware needs a verified location, SP profile, material and applicable REF penalty or special-effect rule."
      : "Verify armor coverage, SP variant, material and encumbrance against the source before automatic resolution.");
  }

  if(system.armorRole === "wornArmor" && system.encumbrance === null && reasons.length === 0) reasons.push("Armor encumbrance is not verified.");
  system.equipped = system.armorRole === "wornArmor" || system.armorRole === "clothing";
  system.automation = { status: reasons.length ? "manual" : "ready", reasons };
  return document;
}

export function getArmorCatalogOverrides() {
  return structuredClone(overrides);
}
