import { validateWeaponContract, validateArmorContract, contributesBodyArmor } from "../item/item-contract.js";
import { COMBAT_CHAT_STATUS, MANUAL_RESOLUTION_REASON } from "./combat-outcome.js";

/** Validate the entire action before rolling or planning any state changes. */
export function validateCombatItemData(context = {}, options = {}) {
  const action = context.action || {};
  const issues = [];
  if (["ranged", "melee", "martial"].includes(action.type)) {
    const weapon = context.weapon || {};
    const result = validateWeaponContract(weapon.snapshot || {}, {
      actionType: action.type, fireMode: action.fireMode, range: action.range,
      damageRequired: action.type === "martial" && ["strike", "kick"].includes(String(action.meleeAction || "").toLowerCase()),
      ...options
    });
    issues.push(...result.issues.map(issue => ({ ...issue, itemName: weapon.name || "Weapon", itemUuid: weapon.itemUuid })));
    if (action.type === "ranged" && options.damageOnly !== true && Number(weapon.snapshot?.shotsLeft) === 0 && weapon.snapshot?.shotsLeft !== null) {
      issues.push({ code: "insufficient-ammo", field: "shotsLeft", message: "The weapon is empty; reload before attacking.", itemName: weapon.name || "Weapon" });
    }
  }
  // Auto-shotgun patterns can contain targets absent from the initial selection.
  const targets = [
    ...(context.targets || []),
    ...(context.target ? [context.target] : []),
    ...(action.autoshotgunPatterns || []).flatMap(pattern => pattern.affectedTargets || [])
  ];
  const seen = new Set();
  for (const target of targets) {
    const snapshot = target.snapshot || {};
    for (const [type, items] of [["armor", snapshot.equippedArmor], ["cyberware", snapshot.equippedCyberware]]) {
      for (const item of items || []) {
        const system = item.system || item;
        if (system.equipped === false || item.equipped === false) continue;
        const owner = target.actorUuid || target.tokenUuid;
        const key = owner && item.id ? `${owner}:${type}:${item.id}` : item;
        if (seen.has(key)) continue;
        seen.add(key);
        const result = validateArmorContract(system, { type });
        issues.push(...result.issues.map(issue => ({ ...issue, itemName: item.name || "Armor", itemId: item.id, actorUuid: target.actorUuid })));
        if (action.type === "melee" && system.edgedHalfSP === true && contributesBodyArmor(system) && !["edged", "blunt"].includes(context.weapon?.snapshot?.meleeDamageType)) {
          issues.push({ code: "missing-melee-damage-type", field: "meleeDamageType", itemName: context.weapon?.name || "Weapon", message: "The target's armor has special edged-weapon protection; specify whether this weapon is edged or blunt." });
        }
      }
    }
  }
  return { valid: issues.length === 0, issues };
}

export function preflightCombatItemData(context = {}, options = {}) {
  const result = validateCombatItemData(context, options);
  if (result.valid) return undefined;
  const message = result.issues.map(issue => `${issue.itemName}: ${issue.message}`).join(" ");
  const manualResolution = {
    required: true,
    reason: MANUAL_RESOLUTION_REASON.missingRuleData,
    message,
    blockedUpdateCategories: ["attacker-ammo", "target-damage", "target-armor", "target-saves"],
    issues: result.issues
  };
  const ammo = context.weapon?.snapshot?.shotsLeft;
  return {
    action: context.action || {},
    attacker: context.attacker || {},
    weapon: context.weapon || {},
    targets: (context.targets || (context.target ? [context.target] : [])).map(target => ({
      target,
      attack: { hit: false, warnings: [] },
      hits: [], saves: [], warnings: [],
      manualResolution,
      plannedUpdates: { actorUpdates: [], embeddedItemUpdates: [], chatStatus: COMBAT_CHAT_STATUS.manual }
    })),
    ammo: { ...(ammo !== undefined ? { before: ammo, after: ammo } : {}), delta: 0 },
    plannedUpdates: { itemUpdates: [], chatStatus: COMBAT_CHAT_STATUS.manual },
    manualResolution,
    chat: { status: COMBAT_CHAT_STATUS.manual },
    warnings: result.issues.map(issue => ({ ...issue, code: issue.code === "insufficient-ammo" ? issue.code : `item-data-${issue.code}`, severity: "warning", message: `${issue.itemName}: ${issue.message}` }))
  };
}
