/** Pure, shared semantic checks for source catalogs and live combat snapshots. */
import { LEGACY_SKILL_TRANSLATIONS } from "../legacy-skill-translations.js";

export const ITEM_CONTRACT_VERSION = 1;
export const WEAPON_FIRE_MODES = Object.freeze(["SemiAuto", "ThreeRoundBurst", "FullAuto", "Suppressive"]);
const COMBAT_SKILLS = ["Handgun", "Submachinegun", "Rifle", "HeavyWeapons", "Melee", "Fencing", "Brawling", "Archery", "Athletics"];
const NO_BODY_PROTECTION = new Set(["protectedObject", "shield", "clothing"]);

export function canonicalSkillId(name) {
  const normalized = String(name ?? "").trim().toLowerCase();
  return Object.entries(LEGACY_SKILL_TRANSLATIONS).find(([key, aliases]) =>
    [key, ...aliases].some(alias => alias.toLowerCase() === normalized)
  )?.[0];
}

export function findCombatSkill(skills = {}, name) {
  if (Object.hasOwn(skills, name)) return skills[name];
  const canonical = canonicalSkillId(name);
  const normalized = String(name ?? "").trim().toLowerCase();
  return Object.entries(skills).find(([key]) => key.trim().toLowerCase() === normalized || canonical && canonicalSkillId(key) === canonical)?.[1];
}

export function normalizeReliability(value) {
  return ({ st: "Standard", standard: "Standard", vr: "VeryReliable", veryreliable: "VeryReliable", ur: "Unreliable", unreliable: "Unreliable" })[String(value ?? "").replace(/\s/g, "").toLowerCase()];
}

export function normalizeFireMode(value) {
  return WEAPON_FIRE_MODES.find(mode => mode.toLowerCase() === String(value ?? "").toLowerCase());
}

export function contributesBodyArmor(system = {}) {
  return !NO_BODY_PROTECTION.has(system.armorRole);
}

/** Empty, null, booleans and unit-bearing strings are never numeric stats. */
export function isFiniteStat(value, { strict = false, minimum = -Infinity, integer = false } = {}) {
  if (typeof value !== "number" && (strict || typeof value !== "string" || !value.trim())) return false;
  const number = Number(value);
  return Number.isFinite(number) && number >= minimum && (!integer || Number.isInteger(number));
}

function automationIssues(system, issues) {
  const automation = system.automation;
  if (automation === undefined) return;
  if (!automation || !["ready", "manual", "custom"].includes(automation.status)) {
    issues.push({ code: "invalid-automation-status", field: "automation.status", message: "Choose a valid automation status." });
  } else if (automation.status === "manual") {
    const reasons = Array.isArray(automation.reasons) ? automation.reasons.filter(reason => typeof reason === "string" && reason.trim()) : [];
    issues.push({ code: "manual-item-data", field: "automation", message: reasons.length ? `Manual resolution required: ${reasons.join("; ")}` : "This item's rules have not been verified; resolve it manually." });
  }
}

/**
 * Catalog-ready items have a strict schema. Existing custom items may retain
 * numeric strings, but unusable stats and explicit manual status still block.
 */
export function validateWeaponContract(system = {}, options = {}) {
  const issues = [];
  const strict = options.strict === true || system.automation?.status === "ready";
  const actionType = options.actionType || (/^(melee|mono|martial|beast)$/i.test(system.attackType || "") ? "melee" : "ranged");
  const ranged = actionType === "ranged" && options.damageOnly !== true;
  const add = (code, field, message) => issues.push({ code, field, message });
  automationIssues(system, issues);

  const skill = String(system.attackSkill ?? "").trim();
  if (options.damageOnly !== true && actionType !== "martial" && (!skill || /^(ref|undefined|null)$/i.test(skill))) {
    add("missing-attack-skill", "attackSkill", "Select an actual weapon skill; REF is a stat, not an attack skill.");
  } else if (options.damageOnly !== true && strict && actionType !== "martial" && !COMBAT_SKILLS.includes(skill)) {
    add("unknown-attack-skill", "attackSkill", "The catalog attack skill must use a supported canonical skill name.");
  }
  if ((actionType !== "martial" || options.damageRequired === true) && !damageFormulaBounds(system.damage)) {
    add("invalid-weapon-damage", "damage", "Enter a supported damage formula; annotated or missing damage requires manual resolution.");
  }
  if ((system.ap !== undefined || strict) && typeof system.ap !== "boolean") {
    add("unknown-armor-penetration", "ap", "Armor penetration must be explicitly true or false; special penetration requires manual resolution.");
  }
  if (system.meleeDamageType && !["edged", "blunt"].includes(system.meleeDamageType)) add("invalid-melee-damage-type", "meleeDamageType", "Melee damage type must be edged or blunt.");
  if (options.damageOnly !== true && (ranged || system.accuracy !== undefined || strict)) {
    if (!isFiniteStat(system.accuracy, { strict })) add("invalid-weapon-accuracy", "accuracy", "Weapon accuracy must be a finite number.");
  }
  if (ranged) {
    const shotgun = /^(shotgun|autoshotgun)$/i.test(system.attackType || "");
    const needsRange = strict || shotgun || /^(auto|rangeauto)$/i.test(options.range || "") || system.range !== undefined;
    if (needsRange && (!isFiniteStat(system.range, { strict, minimum: 0 }) || Number(system.range) === 0)) add("invalid-weapon-range", "range", "Weapon range must be a positive number of meters.");
    if (!isFiniteStat(system.shotsLeft, { strict, minimum: 0, integer: true })) add("invalid-weapon-ammo", "shotsLeft", "Current ammunition must be a non-negative integer.");
    if (strict || system.shots !== undefined) {
      if (!isFiniteStat(system.shots, { strict, minimum: 1, integer: true })) add("invalid-weapon-capacity", "shots", "Ammunition capacity must be a positive integer.");
      else if (Number(system.shotsLeft) > Number(system.shots)) add("ammo-over-capacity", "shotsLeft", "Current ammunition exceeds the weapon's capacity.");
    }
    if (!isFiniteStat(system.rof, { strict, minimum: 1, integer: true })) add("invalid-weapon-rof", "rof", "Attacks require a positive weapon ROF expressed as an integer.");
    if ((strict || system.reliability !== undefined) && !normalizeReliability(system.reliability)) add("unknown-weapon-reliability", "reliability", "Weapon reliability must be Standard, VeryReliable or Unreliable (ST/VR/UR). ");
    if (strict && !/^(Auto|Shotgun|Autoshotgun)$/.test(system.attackType || "")) add("unsupported-attack-type", "attackType", "This weapon's attack mechanics require manual resolution.");
    if (strict || system.fireModes !== undefined) {
      if (!Array.isArray(system.fireModes) || !system.fireModes.length || system.fireModes.some(mode => !WEAPON_FIRE_MODES.includes(mode))) {
        add("invalid-fire-modes", "fireModes", "Specify the weapon's supported fire modes explicitly.");
      } else if (options.fireMode && !system.fireModes.includes(normalizeFireMode(options.fireMode))) {
        add("unsupported-fire-mode", "fireModes", "This weapon does not support the selected fire mode.");
      }
    }
    if (shotgun) {
      const bands = system.rangeDamages || {};
      for (const [name, formula] of [["pointBlank", strict ? bands.pointBlank : bands.pointBlank || bands.close], ["close", strict ? bands.close : bands.close || bands.pointBlank], ["medium", bands.medium], ["far", strict ? bands.far : bands.far || bands.long]]) {
        if (!damageFormulaBounds(formula)) add("invalid-shotgun-damage", `rangeDamages.${name}`, `Shotgun damage for ${name} range is missing or unsupported.`);
      }
    }
  }
  return { valid: issues.length === 0, issues };
}

export function validateArmorContract(system = {}, options = {}) {
  const issues = [];
  if (!contributesBodyArmor(system)) return { valid: true, issues };
  const strict = options.strict === true || system.automation?.status === "ready";
  const cyberware = options.type === "cyberware";
  automationIssues(system, issues);
  if (system.edgedHalfSP !== undefined && typeof system.edgedHalfSP !== "boolean") issues.push({ code: "invalid-edged-protection", field: "edgedHalfSP", message: "Edged-weapon armor behavior must be explicitly true or false." });
  if (system.apDefeating === true) issues.push({ code: "unsupported-ap-defeating-armor", field: "apDefeating", message: "AP-defeating armor needs special rules; resolve protection manually." });
  const coverage = system.coverage || (system.isFBC ? system.fbcHitLocations : undefined);
  if (coverage !== undefined && (!coverage || typeof coverage !== "object" || Array.isArray(coverage))) {
    issues.push({ code: "invalid-armor-coverage", field: "coverage", message: "Armor coverage must identify the protected body locations." });
  } else if (!coverage && !cyberware) {
    issues.push({ code: "missing-armor-coverage", field: "coverage", message: "Equipped armor has no body coverage; resolve protection manually." });
  } else if (coverage) {
    const seenLocations = new Set();
    for (const [location, entry] of Object.entries(coverage)) {
      const locationKey = location.toLowerCase();
      if (seenLocations.has(locationKey)) issues.push({ code: "duplicate-armor-location", field: `coverage.${location}`, message: `Armor contains duplicate ${location} locations; resolve their SP and ablation before automating protection.` });
      seenLocations.add(locationKey);
      const sp = entry?.stoppingPower ?? entry?.sp;
      if (!entry || !isFiniteStat(sp, { strict, minimum: 0 })) issues.push({ code: "invalid-armor-sp", field: `coverage.${location}.stoppingPower`, message: `Armor SP at ${location} must be a non-negative number.` });
      if ((strict || entry?.ablation !== undefined) && !isFiniteStat(entry?.ablation, { strict, minimum: 0 })) issues.push({ code: "invalid-armor-ablation", field: `coverage.${location}.ablation`, message: `Armor ablation at ${location} must be a non-negative number.` });
      if (Number(sp) > 0 && (strict || entry.layer !== undefined) && !["soft", "hard"].includes(entry.layer)) issues.push({ code: "missing-armor-layer", field: `coverage.${location}.layer`, message: `Select soft or hard armor for ${location}.` });
    }
  }
  if (!cyberware && (strict || system.encumbrance !== undefined) && !isFiniteStat(system.encumbrance, { strict, minimum: 0 })) issues.push({ code: "invalid-armor-encumbrance", field: "encumbrance", message: "Armor encumbrance must be an explicit non-negative number." });
  for (const field of cyberware ? ["stoppingPower", "sp", "ablation"] : []) {
    if (system[field] !== undefined && !isFiniteStat(system[field], { strict, minimum: 0 })) issues.push({ code: "invalid-cyberware-armor", field, message: `Cyberware ${field} must be a non-negative number.` });
  }
  return { valid: issues.length === 0, issues };
}

/**
 * Supported damage arithmetic and its possible minimum/maximum values.
 * Parsing (not eval) preserves operators: "4d6 AP" and table fragments fail.
 */
export function damageFormulaBounds(formula) {
  if (typeof formula !== "string" && typeof formula !== "number") return undefined;
  const source = String(formula).trim();
  if (source.length > 512) return undefined;
  const tokens = source.match(/\d*d\d+|\d+(?:\.\d+)?|[()+*/-]/gi) || [];
  if (!source || tokens.join("").toLowerCase() !== source.replace(/\s+/g, "").toLowerCase()) return undefined;
  let index = 0;
  const finite = pair => pair.every(Number.isFinite) ? pair : undefined;
  function atom() {
    const token = tokens[index++];
    if (token === "+") return atom();
    if (token === "-") { const value = atom(); return value && [-value[1], -value[0]]; }
    if (token === "(") { const value = expression(); return tokens[index++] === ")" ? value : undefined; }
    const dice = token?.match(/^(\d*)d(\d+)$/i);
    if (dice) {
      const count = Number(dice[1] || 1), faces = Number(dice[2]);
      return count > 0 && count <= 1000 && faces > 0 && Number.isSafeInteger(count * faces) ? [count, count * faces] : undefined;
    }
    return token && /^\d/.test(token) && Number.isFinite(Number(token)) ? [Number(token), Number(token)] : undefined;
  }
  function product() {
    let value = atom();
    while (value && ["*", "/"].includes(tokens[index])) {
      const operator = tokens[index++], rhs = atom();
      if (!rhs || operator === "/" && rhs[0] <= 0 && rhs[1] >= 0) return undefined;
      const candidates = value.flatMap(left => rhs.map(right => operator === "*" ? left * right : left / right));
      value = finite([Math.min(...candidates), Math.max(...candidates)]);
    }
    return value;
  }
  function expression() {
    let value = product();
    while (value && ["+", "-"].includes(tokens[index])) {
      const operator = tokens[index++], rhs = product();
      if (!rhs) return undefined;
      value = finite(operator === "+" ? [value[0] + rhs[0], value[1] + rhs[1]] : [value[0] - rhs[1], value[1] - rhs[0]]);
    }
    return value;
  }
  const result = expression();
  return result && index === tokens.length && result[1] > 0 ? { minimum: result[0], maximum: result[1] } : undefined;
}
