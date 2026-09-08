import { makeD10Roll, Multiroll } from "../dice.js";
import { SortOrders, sortSkills } from "./skill-sort.js";
import { btmFromBT } from "../lookups.js";
import { properCase, localize, getDefaultSkills } from "../utils.js"
import { resolveArmor } from "../combat/armor-resolver.js";
import { applyDerivedStatOverrides } from "./derived-stats.js";

const COMBAT_SENSE_LOCALIZATION_KEY = "SkillCombatSense";
const AWARENESS_NOTICE_LOCALIZATION_KEY = "SkillAwarenessNotice";

function normalizeSkillIdentifier(value) {
  return String(value || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

function localizedSkillAliases(localizationKey, fallbackNames = []) {
  const fullKey = `CYBERPUNK.${localizationKey}`;
  const aliases = [...fallbackNames, localizationKey];
  const i18n = globalThis.game?.i18n;

  try {
    const localized = i18n?.localize?.(fullKey);
    if(localized && localized !== fullKey) aliases.push(localized);
  } catch {
    // The actor data API is also exercised outside a running Foundry client.
  }

  return aliases;
}

/**
 * Extend the base Actor document by defining a custom roll data structure which is ideal for the Simple system.
 * @extends {Actor}
 */
export class CyberpunkActor extends Actor {


  /** @override */
  async _onCreate(data, options={}) {
    const updates = {_id: data._id};
    if (data.type === "character" ) {
      updates["prototypeToken.actorLink"] = true;
      updates["prototypeToken.sight.enabled"] = true;
    }
    
    // Check if we have skills already, don't wipe skill items if we do
    let firstSkill = data.items.find(item => item.type === 'skill');
    if (!firstSkill) {
      // Using toObject is important - foundry REALLY doesn't like creating new documents from documents themselves
      const skillsData = 
        sortSkills(await getDefaultSkills(), SortOrders.Name)
        .map(item => item.toObject());
      updates.items = [];
      updates.items = data.items.concat(skillsData);
      updates["system.skillsSortedBy"] = "Name";
      this.update(updates);
    }
  }

  /**
   * Augment the basic actor data with additional dynamic data - the stuff that's calculated from other data
   */
  prepareData() {
    super.prepareData();
    // Make separate methods for each Actor type (character, npc, etc.) to keep
    // things organized.
    switch ( this.type ) {
      // NPCs are exactly the same as characters at the moment, but don't get vision or default actorlink
      case "npc":
      case "character":
        this._prepareCharacterData(this.system);
        break;
    }
  }

  /**
   * Prepare Character type specific data
   */
  _prepareCharacterData(system) {
    const stats = system.stats;
    // Calculate stat totals using base+temp
    for(const stat of Object.values(stats)) {
      stat.total = stat.base + stat.tempMod;
    }
    // A lookup for translating hit rolls to names of hit locations
    // I know that for ranges there are better data structures to lookup, but we're using d10s for hit locations, so it's no issue
    system.hitLocLookup = {};
    for(const hitLoc in system.hitLocations) {
      let area = system.hitLocations[hitLoc]
      area.stoppingPower = 0;
      let [start, end] = area.location;
      // Just one die number that'll hit the location
      if(!end) {
        system.hitLocLookup[start] = hitLoc;
      }
      // A range of die numbers that'll hit the location
      else {
        for(let i = start; i <= end; i++) {
          system.hitLocLookup[i] = hitLoc;
        }
      }
    }
    
    // Sort through this now so we don't have to later
    let equippedItems = this.items.contents.filter(item => {
      return item.system.equipped;
    });

    // Reflex is affected by encumbrance values too
    stats.ref.armorMod = 0;
    equippedItems.filter(i => i.type === "armor").forEach(armor => {
      let armorData = armor.system;
      if(armorData.encumbrance != null) {
        stats.ref.armorMod -= armorData.encumbrance;
      }
    });

    const targetSnapshot = {
      equippedArmor: equippedItems.filter(i => i.type === "armor"),
      equippedCyberware: equippedItems.filter(i => i.type === "cyberware")
    };

    // FBC check
    const fbcItem = targetSnapshot.equippedCyberware.find(c => c.system.isFBC);
    system.isFBC = !!fbcItem;

    // Calculate specific SDP overlays from equipped cyberware
    const specificSdpOverlays = {};
    for (const cw of targetSnapshot.equippedCyberware) {
      const loc = cw.system?.location;
      const sdp = Number(cw.system?.sdp);
      if (loc && system.hitLocations[loc] && sdp > 0) {
        specificSdpOverlays[loc] = Math.max(specificSdpOverlays[loc] || 0, sdp);
      }
    }

    for(const locName in system.hitLocations) {
      let location = system.hitLocations[locName];
      location.type = "flesh";
      const resolution = resolveArmor(false, targetSnapshot, locName);
      location.stoppingPower = resolution.effectiveStoppingPower;

      // Determine the Max SDP for this location (Specific Cyberware takes precedence over FBC)
      let maxSdp = 0;
      let isCybernetic = false;

      if (specificSdpOverlays[locName]) {
        maxSdp = specificSdpOverlays[locName];
        isCybernetic = true;
      } else if (system.isFBC && fbcItem && fbcItem.system.fbcHitLocations && fbcItem.system.fbcHitLocations[locName]?.sdp) {
        maxSdp = fbcItem.system.fbcHitLocations[locName].sdp;
        isCybernetic = true;
      }

      if (isCybernetic) {
        location.type = "cybernetic";
        if (!location.sdp) {
          location.sdp = { value: maxSdp, max: 0 };
        }
        location.sdp.max = maxSdp;
        
        // Handle Foundry array edge cases
        if (Array.isArray(location.sdp.value)) {
          location.sdp.value = location.sdp.value.find(v => v !== "" && v != null) || maxSdp;
        }
        // Auto-heal on first initialization
        if (location.sdp.value == null || location.sdp.value === "") {
          location.sdp.value = maxSdp;
        }
      } else {
        // If it's flesh, we ensure sdp isn't populated to prevent UI rendering
        delete location.sdp;
      }
    }
    stats.ref.total = stats.ref.base + stats.ref.tempMod + stats.ref.armorMod;

    const move = stats.ma;
    move.run = move.total * 3;
    move.leap = Math.floor(move.run / 4); 

    const body = stats.bt;
    body.carry = body.total * 10;
    body.lift = body.total * 40;
    body.modifier = system.isFBC ? 0 : btmFromBT(body.total);
    system.carryWeight = 0;
    equippedItems.forEach(item => {
      let weight = item.system.weight || 0;
      system.carryWeight += parseFloat(weight);
    });

    // Apply wound effects
    // Change stat total, but leave a record of the difference in stats.[statName].woundMod
    // Modifies the very-end-total, idk if this'll need to change in the future
    let woundState = this.woundState();
    let woundStat = function(stat, totalChange) {
        let newTotal = totalChange(stat.total)
        stat.woundMod = -(stat.total - newTotal);
        stat.total = newTotal;
    }
    if(woundState >= 4) {
      [stats.ref, stats.int, stats.cool].forEach(stat => woundStat(stat, total => Math.ceil(total/3)));
    } 
    else if(woundState == 3) {
      [stats.ref, stats.int, stats.cool].forEach(stat => woundStat(stat, total => Math.ceil(total/2)));
    }
    else if(woundState == 2) {
      woundStat(stats.ref, total => total - 2);
    }
    // calculate and configure the humanity
    const emp = stats.emp;
    emp.humanity = {base: emp.base * 10};
    // calculate total HL from cyberware
    let hl = 0;
    equippedItems.filter(i => i.type === "cyberware").forEach(cyberware => {
      const cyber = cyberware.system;
      hl += (cyber.humanityLoss) ? cyber.humanityLoss : 0;
    });

    emp.humanity.loss = hl;
    // calculate current Humanity and current EMP
    emp.humanity.total = emp.humanity.base - emp.humanity.loss;
    emp.total = emp.base + emp.tempMod - Math.floor(emp.humanity.loss/10);
    applyDerivedStatOverrides(system);
  }

  /**
   * 
   * @param {string} sortOrder The order to sort skills by. Options are in skill-sort.js's SortOrders. "Name" or "Stat". Default "Name".
   */
  sortSkills(sortOrder = "Name") {
    let allSkills = this.itemTypes.skill;
    sortOrder = sortOrder || Object.keys(SortOrders)[0];
    console.log(`Sorting skills by ${sortOrder}`);
    let sortedView = sortSkills(allSkills, SortOrders[sortOrder]).map(skill => skill.id);

    // Technically UI info, but we don't wanna calc every time we open a sheet so store it in the actor.
    this.update({
      // Why is it that when storing Item: {data: {data: {innerdata}}}, it comes out as {data: {innerdata}}
      "system.sortedSkillIDs": sortedView,
      "system.skillsSortedBy": sortOrder
    });
  }

  /**
   * Get a body type modifier from the body type stat (body)
   * I couldn't figure out a single formula that'd work for it (cos of the weird widths of BT values)
   */
  static btm(body, isFBC = false) {
    if (isFBC) return 0;
    if(body < 2)
      return 0;
    return btmFromBT(body);
  }

  // Current wound state. 0 for uninjured, going up by 1 for each new one. 1 for Light, 2 Serious, 3 Critical etc.
  woundState() {
    const damage = this.system.damage;
    if(damage == 0) return 0;
    // Wound slots are 4 wide, so divide by 4, ceil the result
    return Math.ceil(damage/4);
  }


  stunThreshold() {
    const body = this.system.stats.bt.total;
    // +1 as Light has no penalty, but is 1 from woundState()
    return body - this.woundState() + 1; 
  }

  deathThreshold() {
    // The first wound state to penalise is Mortal 1 instead of Serious.
    return this.stunThreshold() + 3;
  }

  // TODO: Again, will not work if skill names localized
  trainedMartials() {
    return this.itemTypes.skill
      .filter(skill => skill.name.startsWith("Martial"))
      .filter(martial => martial.system.level > 0)
      .map(martial => martial.name);
  }

  // TODO: Make this doable with just skill name
  static realSkillValue(skill) {
    // Sometimes we use this to sort raw item data before it becomes a full-fledged item. So we use either system or data, as needed
    let data = skill?.system || skill;
    if(!data) return 0;
    let value = data.level;
    if(data.isChipped) {
      value = data.chipLevel || 0;
    }
    const numericValue = Number(value);
    return Number.isFinite(numericValue) ? numericValue : 0;
  }

  findItemSkill(...names) {
    const wantedNames = new Set(names.flat().map(normalizeSkillIdentifier).filter(Boolean));
    const itemSkills = this.itemTypes?.skill
      || this.items?.filter?.(item => item.type === "skill")
      || [];

    return Array.from(itemSkills).find(skill => {
      const identifiers = [
        skill?.name,
        skill?.system?.key,
        skill?.system?.skillKey,
        skill?.system?.slug
      ];
      return identifiers.some(identifier => wantedNames.has(normalizeSkillIdentifier(identifier)));
    });
  }

  getSkillVal(skillName, aliases = []) {
    return CyberpunkActor.realSkillValue(this.findItemSkill(skillName, aliases));
  }

  getCombatSenseValue() {
    const aliases = localizedSkillAliases(COMBAT_SENSE_LOCALIZATION_KEY, ["Combat Sense", "CombatSense"]);
    return CyberpunkActor.realSkillValue(this.findItemSkill(aliases));
  }

  isAwarenessNoticeSkill(skill) {
    const aliases = localizedSkillAliases(AWARENESS_NOTICE_LOCALIZATION_KEY, ["Awareness/Notice", "AwarenessNotice"]);
    const wantedNames = new Set(aliases.map(normalizeSkillIdentifier));
    return [skill?.name, skill?.system?.key, skill?.system?.skillKey, skill?.system?.slug]
      .some(identifier => wantedNames.has(normalizeSkillIdentifier(identifier)));
  }

  /**
   * Add stable roll-data projections for values which live in embedded skill Items.
   * Foundry uses this object when evaluating the system initiative formula.
   */
  getRollData() {
    const rollData = super.getRollData();
    return {
      ...rollData,
      itemSkills: {
        ...(rollData?.itemSkills || {}),
        combatSense: {
          value: this.getCombatSenseValue()
        }
      }
    };
  }

  rollSkill(skillId) {
    let skill = this.items.get(skillId);
    let skillData = skill.system;
    let value = CyberpunkActor.realSkillValue(skill);

    let rollParts = [];
    rollParts.push(value);

    if(skillData.stat) {
      rollParts.push(`@stats.${skillData.stat}.total`);
    }
    if(this.isAwarenessNoticeSkill(skill)) {
      rollParts.push(this.getCombatSenseValue());
    }

    let roll = new Multiroll(skill.name)
      .addRoll(makeD10Roll(rollParts, this.system));

    roll.defaultExecute();
  }

  rollStat(statName) {
    let fullStatName = localize(properCase(statName) + "Full");
    let roll = new Multiroll(fullStatName);
    roll.addRoll(makeD10Roll(
      [`@stats.${statName}.total`],
      this.system
    ));
    roll.defaultExecute();
  }

  /*
   * Adds this actor to the current encounter - if there isn't one, this just shows an error - and rolls their initiative
   */
  async addToCombatAndRollInitiative(options = {createCombatants: true}) {
    if(!game.combat) {
      ui.notifications.error(localize("NoCombatError"));
      return;
    }

    // This... doesn't seem to actually roll the iniative, and the docs aren't telling in how to make this function do so
    // So for now, we're going to have to add them to the combat, then ask the combat very nicely to roll this actor please
    return this.rollInitiative(options = options).then( (combat) => {
      combat.rollInitiative([combat.getCombatantByActor(this).id]);
    });
  }

  rollStunDeath() {
    if (this.system.isFBC) {
      ui.notifications.info(game.i18n.localize("Full Body Conversions do not make Stun or Death saves."));
      return;
    }
    let rolls = new Multiroll(localize("StunDeathSave"), localize("UnderThresholdMessage"));
    rolls.addRoll(new Roll("1d10"), {
      name: localize("Save")
    });
    rolls.addRoll(new Roll(`${this.stunThreshold()}`), {
      name: "Stun Threshold"
    });
    rolls.addRoll(new Roll(`${this.deathThreshold()}`), {
      name: "Death Threshold"
    });
    rolls.defaultExecute();
  }
}
