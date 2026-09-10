import { readFileSync } from "node:fs";
import { damageFormulaBounds, normalizeReliability } from "../../module/item/item-contract.js";

const OVERRIDES = JSON.parse(readFileSync(new URL("../../data/compendium-overrides/weapons.json", import.meta.url), "utf8"));
const NAMESPACE = "cyberpunk2020-rilerena";
const SKILLS = { Pistol: "Handgun", SMG: "Submachinegun", Rifle: "Rifle", Shotgun: "Rifle", Heavy: "HeavyWeapons", Melee: "Melee" };
const AVAILABILITY = { E: "Excellent", C: "Common", P: "Poor", R: "Rare", excellent: "Excellent", common: "Common", poor: "Poor", rare: "Rare" };
const CONCEALABILITY = { P: "ConcealPocket", J: "ConcealJacket", L: "ConcealLongcoat", N: "ConcealNoHide" };
const BALLISTIC_TYPES = new Set(["Pistol", "SMG", "Rifle", "Heavy", "Shotgun"]);
const BASIC_CALIBER = /^(?:\.?\d[\d.]*\s*(?:mm|ga|gauge|cal|sov|ACP|BMG|caseless|C|H|ET|ETE|M|Mag|magnum)?(?:[\s./-][\w.]+)*|\.\d+[\w\s.-]*)$/i;
const REASON_MESSAGES = {
  "accuracy-needs-variant-or-source": "Accuracy is missing or has multiple configurations; select and verify one.",
  "range-needs-variant-or-source": "Range is missing or has special distance bands; verify the source.",
  "attack-skill-needs-source": "The attack skill must be selected from the weapon rules.",
  "damage-needs-special-resolution": "Damage is not a supported dice formula; resolve the weapon effect manually.",
  "armor-interaction-needs-source": "Armor interaction is unverified; do not assume ordinary or AP damage.",
  "capacity-needs-variant-or-source": "Magazine capacity is missing or has alternatives; select the installed magazine.",
  "rate-of-fire-needs-special-resolution": "Rate of fire needs a mode choice or special timing rule.",
  "reliability-needs-source": "Reliability is missing or has a conditional rule; verify the source.",
  "special-weapon-rules-require-review": "Weapon-specific effects require referee resolution.",
  "source-damage-annotations-require-review": "The original damage notation contains additional or damaged rules; verify it before automation.",
  "imported-name-contains-table-fragments": "The imported name contains table fragments and needs source correction.",
  "heavy-weapon-personnel-rules-require-review": "Heavy-weapon ammunition and damage against personnel need source confirmation.",
  "shotgun-range-profile-needs-source": "Shotgun damage is missing a verified point-blank, close, medium or far profile."
};

function simpleFormula(value) {
  if (typeof value !== "string") return null;
  // Whitespace may surround an explicit operator, but cannot join separate
  // source-table cells: "2d6 1 1" must never become the valid roll "2d611".
  const match = value.trim().match(/^([1-9]\d*d[1-9]\d*)\s*(?:([+-])\s*(\d+))?$/i);
  return match ? `${match[1].toLowerCase()}${match[2] ?? ""}${match[3] ?? ""}` : null;
}

function numeric(value, { positive = false, integer = false } = {}) {
  if (typeof value !== "number" && !(typeof value === "string" && /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/.test(value.trim()))) return null;
  const result = Number(value);
  if (!Number.isFinite(result) || (positive && result <= 0) || (integer && !Number.isInteger(result))) return null;
  return result;
}

/** Unit conversion is limited to complete scalar measurements, never variants such as 12/25m. */
export function normalizeCatalogRange(value) {
  const scalar = numeric(value, { positive: true });
  if (scalar !== null) return scalar;
  if (typeof value !== "string") return null;
  const match = value.trim().match(/^(\d+(?:\.\d+)?)\s*(m|km|ft|mi)$/i);
  if (!match) return null;
  const metres = Number(match[1]) * { m: 1, km: 1000, ft: 0.3048, mi: 1609.344 }[match[2].toLowerCase()];
  return metres > 0 ? Math.round(metres * 1e6) / 1e6 : null;
}

function sourceDamageFacts(text) {
  if (typeof text !== "string") return { formula: null, caliber: null, bodyMinimum: null, plain: false };
  const groups = [...text.matchAll(/\(([^()]*)\)/g)].map(match => match[1].trim());
  const body = groups.find(group => /^B\d+$/i.test(group));
  const caliber = groups.find(group => !/^B\d+$/i.test(group) && BASIC_CALIBER.test(group) && !/^\d+(?:\.\d+)?\s*(?:m|km|ft)$/i.test(group));
  const formula = simpleFormula(text.replace(/\([^()]*\)/g, " "));
  return { formula, caliber: caliber ?? null, bodyMinimum: body ? Number(body.slice(1)) : null, plain: formula !== null };
}

function specialAttackType(name, damage) {
  const text = `${name} ${damage}`;
  if (/microwav/i.test(text)) return "Microwave";
  if (/laser|photon/i.test(text)) return "Laser";
  if (/taser|stun|volt pistol|shock touch/i.test(text)) return "Taser";
  if (/flame|flamer|thermite/i.test(text)) return "Flamethrow";
  if (/claymore/i.test(text)) return "Claymore";
  if (/\bmine\b/i.test(text)) return "Landmine";
  if (/\bRPG\b|bazooka|recoill?ess|\bLAW(?:-III)?\b|HLAW/i.test(text)) return "RPG";
  if (/missile|rocket|torpedo|subroc|LATGM|HATGM/i.test(text)) return "Missile";
  if (/grenade|\bgren\b|\bHE\b|\bHEAT\b|\bHEP\b/i.test(text)) return "Grenade";
  if (/\bgas\b|smoke|skunker/i.test(text)) return "Gas";
  if (/acid/i.test(text)) return "Acid";
  if (/squirt/i.test(text)) return "Squirt";
  if (/drug|wombat/i.test(text)) return "Drugs";
  if (/dart|needle/i.test(text)) return "Dart";
  if (/mono(?:blade|katana|knife|whip|sword)|mono pa/i.test(text)) return "Mono";
  return null;
}

/**
 * Table ROF alternatives are retained. Only common single/burst/automatic
 * patterns are converted; 1/2 can mean one shot every two turns, so is manual.
 */
function normalizeRateOfFire(value, weaponType) {
  const scalar = numeric(value, { positive: true, integer: true });
  if (scalar !== null) {
    if (scalar <= 3) return { rof: scalar, modes: ["SemiAuto"] };
    if (BALLISTIC_TYPES.has(weaponType)) return { rof: scalar, modes: ["SemiAuto", "FullAuto", "Suppressive"] };
    return { rof: scalar, modes: [] };
  }
  if (typeof value !== "string" || !/^\d+(?:\/\d+){1,2}$/.test(value.trim())) return { rof: null, modes: [] };
  const choices = value.split("/").map(Number);
  if (choices.some(n => n <= 0) || choices.some((n, i) => i && n <= choices[i - 1])) return { rof: null, modes: [] };
  if (value === "1/3") return { rof: 3, modes: ["SemiAuto", "ThreeRoundBurst"] };
  if (choices.at(-1) < 10) return { rof: null, modes: [] };
  const modes = ["SemiAuto"];
  if (choices.includes(3)) modes.push("ThreeRoundBurst");
  modes.push("FullAuto", "Suppressive");
  return { rof: choices.at(-1), modes };
}

function isSuspiciousName(name) {
  // A table fragment has at least type, accuracy and concealability columns.
  // A genuine model name such as "Sternmeyer SMG 21" is not a broken row.
  return /\b(?:HVY|RIF|SHT|SMG|MEL)\s+[+-]?\d+(?:\/[+-]?\d+)?\s+[PJLNECR-](?:[\s/]|$)/i.test(name) || name.length > 100;
}

/** Pure, deterministic catalog transform. Does not open Foundry or LevelDB. */
export function normalizeWeaponCatalog(source, { packName } = {}) {
  const document = structuredClone(source);
  if (document.type !== "weapon") return document;
  const entry = OVERRIDES.entries[`${packName}/${document._id}`];
  if (entry?.expectedName && document.name !== entry.expectedName && document.name !== entry.name) throw new Error(`Weapon override identity mismatch: ${packName}/${document._id}`);
  if (entry?.name) document.name = entry.name;
  const system = document.system ??= {};
  const previousCatalog = document.flags?.[NAMESPACE]?.catalog ?? {};
  const sourceValues = structuredClone(previousCatalog.sourceValues ?? system);
  // Keep the first import unchanged in provenance on subsequent builds.
  delete sourceValues.automation;
  const raw = structuredClone(sourceValues);
  const reasons = new Set(entry?.manualReasons ?? []);
  const evidence = structuredClone(entry?.evidence ?? []);
  const historicalDamage = entry?.historicalDamage ?? raw.damage;
  const facts = sourceDamageFacts(historicalDamage);
  const effective = { ...raw, ...structuredClone(entry?.system ?? {}) };
  Object.assign(system, effective);

  // The legacy importer assigned weight=1 to every weapon regardless of type.
  // Only an individually sourced override may replace this unknown quantity.
  system.weight = numeric(entry?.system?.weight, { positive: true });

  system.accuracy = numeric(effective.accuracy);
  system.range = normalizeCatalogRange(effective.range);
  system.shots = numeric(effective.shots, { positive: true, integer: true });
  system.shotsLeft = system.shots;
  system.reliability = normalizeReliability(effective.reliability) ?? null;
  system.availability = AVAILABILITY[effective.availability] ?? effective.availability ?? null;
  system.concealability = CONCEALABILITY[effective.concealability] ?? effective.concealability ?? null;
  system.attackSkill = effective.attackSkill && effective.attackSkill !== "ref" ? effective.attackSkill : SKILLS[effective.weaponType] ?? null;
  system.damage = facts.formula ?? simpleFormula(effective.damage);
  if (entry?.system && Object.hasOwn(entry.system, "damage")) system.damage = entry.system.damage;
  if (facts.caliber && !Object.hasOwn(entry?.system ?? {}, "ammoType")) system.ammoType = facts.caliber;
  else if (/^B\d+$/i.test(system.ammoType ?? "")) system.ammoType = null;
  if (facts.bodyMinimum !== null) system.bodyMinimum = facts.bodyMinimum;

  const rate = normalizeRateOfFire(effective.rof, effective.weaponType);
  system.rof = rate.rof;
  system.fireModes = structuredClone(entry?.system?.fireModes ?? rate.modes);
  const special = specialAttackType(document.name, historicalDamage);
  system.attackType = entry?.system?.attackType ?? special ?? (packName === "bows" ? "Archer" : effective.weaponType === "Melee" ? "Melee" : effective.weaponType === "Shotgun" ? (system.fireModes.includes("FullAuto") || system.fireModes.includes("ThreeRoundBurst") ? "Autoshotgun" : "Shotgun") : effective.attackType ?? null);
  if (packName === "bows") system.attackSkill = "Archery";
  if (["Melee", "Mono", "Archer"].includes(system.attackType)) system.fireModes = [];
  if (system.attackType === "Shotgun") system.fireModes = ["SemiAuto"];
  // Generic buckshot full-auto has a distinct pattern resolver; Suppressive and
  // bullet-style bursts are not interchangeable with that mechanism.
  if (["Shotgun", "Autoshotgun"].includes(system.attackType)) system.fireModes = system.fireModes.filter(mode => mode !== "Suppressive");
  system.rangeDamages = { pointBlank: "", close: "", medium: "", far: "", ...structuredClone(effective.rangeDamages ?? {}) };
  system.aoe = structuredClone(effective.aoe ?? { type: "", value: 0, width: 0 });

  const caliberNumber = facts.caliber ? Number(facts.caliber.match(/^\d+(?:\.\d+)?/)?.[0]) : null;
  const heavyCaliber = caliberNumber >= 20 && /^\d+(?:\.\d+)?\s*(?:mm\b|ET\b|DPU\b|HE\b|$)/i.test(facts.caliber);
  const conventional = BALLISTIC_TYPES.has(system.weaponType) && facts.plain && facts.caliber && !special && !heavyCaliber && !/cannon|mortar|rail|gauss|net\b|flec|sliver|ramjet|speargun/i.test(document.name);
  system.ap = typeof effective.ap === "boolean" ? effective.ap : conventional ? false : null;
  if (/\d(?:AP)(?:\s|\(|$)/i.test(historicalDamage) && !/EAP|API|HEAT|HEP/.test(historicalDamage)) system.ap = true;

  if (system.accuracy === null) reasons.add("accuracy-needs-variant-or-source");
  if (system.range === null && system.weaponType !== "Melee") reasons.add("range-needs-variant-or-source");
  if (!system.attackSkill) reasons.add("attack-skill-needs-source");
  if (!damageFormulaBounds(system.damage)) reasons.add("damage-needs-special-resolution");
  if (system.ap === null) reasons.add("armor-interaction-needs-source");
  if (system.weaponType !== "Melee") {
    if (system.shots === null) reasons.add("capacity-needs-variant-or-source");
    if (system.rof === null) reasons.add("rate-of-fire-needs-special-resolution");
    if (!system.reliability) reasons.add("reliability-needs-source");
  }
  if (special || ["Exotic", "Melee"].includes(system.weaponType) || packName === "bows") reasons.add("special-weapon-rules-require-review");
  if (!facts.plain && !entry?.reviewedDamage) reasons.add("source-damage-annotations-require-review");
  if (isSuspiciousName(document.name)) reasons.add("imported-name-contains-table-fragments");
  if (system.weaponType === "Heavy" && !conventional) reasons.add("heavy-weapon-personnel-rules-require-review");
  if (["Shotgun", "Autoshotgun"].includes(system.attackType) && Object.values(system.rangeDamages).some(formula => !damageFormulaBounds(formula))) reasons.add("shotgun-range-profile-needs-source");
  if (entry?.resolvedReasons) for (const reason of entry.resolvedReasons) reasons.delete(reason);
  system.automation = { status: reasons.size ? "manual" : "ready", reasons: [...reasons].sort().map(reason => REASON_MESSAGES[reason] ?? reason) };
  document.flags ??= {};
  document.flags[NAMESPACE] ??= {};
  document.flags[NAMESPACE].catalog = { ...previousCatalog, version: 1, sourceValues, evidence, ...(entry?.name ? { sourceName: entry.expectedName } : {}), ...(entry?.historicalDamage ? { historicalDamage: entry.historicalDamage, historicalCommit: "723cc084" } : {}) };
  return document;
}
