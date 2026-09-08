import { fireModes, martialOptions, meleeAttackTypes, meleeBonkOptions, rangedModifiers, weaponTypes } from "../lookups.js"
import { localize, localizeParam } from "../utils.js"
import { ModifiersDialog } from "../dialog/modifiers.js"
import { SortOrders } from "./skill-sort.js";
import { normalizeSelectedTargets } from "../combat/target-normalizer.js";
import { getAttackDieEntryMode, isCorebookFidelityEnabled } from "../combat/settings-helpers.js";
import { promptAttackDieEntry } from "../combat/attack-die-entry.js";
import { buildWoundStateHints } from "./wound-hints.js";
import { buildArmorRepairUpdate, getArmorItemStatus, getCyberwareArmorStatus } from "../combat/armor-maintenance.js";
import { resolveActorSheetLayout } from "./actor-sheet-layout.js";

/**
 * Extend the basic ActorSheet with some very simple modifications
 * @extends {ActorSheet}
 */
export class CyberpunkActorSheet extends ActorSheet {

  /** @override */
  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      // Css classes
      classes: ["cyberpunk", "sheet", "actor"],
      template: "systems/cyberpunk2020-rilerena/templates/actor/actor-sheet.hbs",
      // Default window dimensions
      width: 1200,
      height: 900,
      tabs: [{ navSelector: ".sheet-tabs", contentSelector: ".sheet-body", initial: "skills" }]
    });
  }

  /* -------------------------------------------- */

  /** @override */
  async _render(force=false, options={}) {
    await super._render(force, options);
    this._applyActorSheetLayout();
  }

  /* -------------------------------------------- */

  /** @override */
  setPosition(options = {}) {
    const position = super.setPosition(options);
    this._applyActorSheetLayout({ width: position.width });
    return position;
  }

  _applyActorSheetLayout({ width, activeTab } = {}) {
    const root = this.element?.find?.(".sheet-terminal")?.[0];
    if(!root) return;

    const selectedTab = activeTab
      || root.querySelector(".sheet-tabs [data-tab].active")?.dataset.tab
      || this._activeActorSheetTab
      || this.options.tabs?.[0]?.initial
      || "skills";
    const sheetWidth = Number(width ?? this.position?.width ?? this.options.width);
    const layout = resolveActorSheetLayout({ width: sheetWidth, activeTab: selectedTab });

    root.classList.toggle("layout-wide", layout.mode === "wide");
    root.classList.toggle("layout-compact", layout.mode === "compact");
    root.classList.toggle("combat-focus", layout.combatFocus);
    this._activeActorSheetTab = selectedTab;
  }

  /* -------------------------------------------- */

  /** @override */
  async getData(options) {
    // the data THIS returns is only available in this class and the template
    const sheetData = await super.getData(options);
    // Make actor info available relatively easily
    sheetData.system = sheetData.actor.system;

    // Prepare items.
    if (this.actor.type == 'character' || this.actor.type == "npc") {
      this._prepareCharacterItems(sheetData);
      this._addWoundTrack(sheetData);
      // Reset search text if it's null or we just rendered for the first time
      if(sheetData.system.transient == null) {
        sheetData.system.transient = { skillFilter: "" };
      }
      this._prepareSkills(sheetData);
      // All this extra lookup is cos we can't store a list of entities in data :(
      sheetData.weaponTypes = weaponTypes;
    }
    return sheetData;
  }

  _prepareSkills(sheetData) {
    sheetData.skillsSort = this.actor.system.skillsSortedBy || "Name";
    sheetData.skillsSortChoices = Object.keys(SortOrders);
    sheetData.filteredSkillIDs = this._filterSkills(sheetData);
    sheetData.skillDisplayList = sheetData.filteredSkillIDs.map(id => this.actor.items.get(id));
  }

  // Handle searching skills
  _filterSkills(sheetData) {
    let id = sheetData.actor._id;

    if(sheetData.system.transient.skillFilter == null) {
      sheetData.system.transient.skillFilter = "";
    }
    let upperSearch = sheetData.system.transient.skillFilter.toUpperCase();
    let listToFilter = sheetData.system.sortedSkillIDs || game.actors.get(id).itemTypes.skill.map(skill => skill.id);

    // Only filter if we need to
    if(upperSearch === "") {
      return listToFilter;
    }
    else {
      // If we searched previously and the old search had results, we can filter those instead of the whole lot
      if(sheetData.system.transient.oldSearch != null 
        && sheetData.filteredSkillIDs != null
        && upperSearch.startsWith(oldSearch)) {
        listToFilter = sheetData.filteredSkillIDs; 
      }
      return listToFilter.filter(id => {
        let skillName = this.actor.items.get(id).name;
        return skillName.toUpperCase().includes(upperSearch);
      });
    }
  }

  _addWoundTrack(sheetData) {
    // Add localized wound states, excluding uninjured. All non-mortal, plus mortal
    const nonMortals = ["Light", "Serious", "Critical"].map(e => game.i18n.localize("CYBERPUNK."+e));
    const mortals = Array(7).fill().map((_,index) => game.i18n.format("CYBERPUNK.Mortal", {mortality: index}));
    sheetData.woundStates = buildWoundStateHints(nonMortals.concat(mortals), sheetData.system.stats.bt.total);
  }
  
  /**
   * Items that aren't actually cyberware or skills - everything that should be shown in the gear tab. 
   */
  _gearTabItems(allItems) {
    let hideThese = new Set(["cyberware", "skill"])
    // As per https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Intl/Collator
    // Compares locale-compatibly, and pretty fast too apparently.
    let nameSorter = new Intl.Collator();
    let showItems = allItems.filter((item) => !hideThese.has(item.type))
      .sort((a, b) => {
        return nameSorter.compare(a.name, b.name)
      });
    return showItems;
  }

  /**
   * Organize and classify Items for Character sheets.
   *
   * @param {Object} actorData The actor to prepare.
   *
   * @return {undefined}
   */
  _prepareCharacterItems(sheetData) {
    let sortedItems = sheetData.actor.itemTypes;
    
    sheetData.gearTabItems = this._gearTabItems(sheetData.actor.items);

    // Convenience copy of itemTypes tab, makes things a little less long-winded in the templates
    // TODO: Does this copy need to be done with itemTypes being a thing?
    sheetData.gear = {
      weapons: sortedItems.weapon,
      armor: sortedItems.armor.map(armor => ({
        id: armor.id,
        name: armor.name,
        img: armor.img,
        system: armor.system,
        armorStatus: getArmorItemStatus(armor)
      })),
      cyberware: sortedItems.cyberware.map(cyber => ({
        id: cyber.id,
        name: cyber.name,
        img: cyber.img,
        system: cyber.system,
        armorStatus: getCyberwareArmorStatus(cyber)
      })),
      misc: sortedItems.misc,
      cyberCost: sortedItems.cyberware.reduce((a,b) => a + b.system.cost, 0)
    };

  }

  /** @override */
  activateListeners(html) {
    html = $(html);
    super.activateListeners(html);

    html.find(".sheet-tabs [data-tab]").click(ev => {
      const activeTab = ev.currentTarget.dataset.tab;
      this._applyActorSheetLayout({ activeTab });
    });

    /**
   * Get an owned item from a click event, for any event trigger with a data-item-id property
   * @param {*} ev 
   */
    function getEventItem(sheet, ev) {
      let itemId = ev.currentTarget.dataset.itemId;
      return sheet.actor.items.get(itemId);
    }
    // TODO: Check if shift is held to skip dialog?
    function deleteItemDialog(ev) {
      ev.stopPropagation();
      let item = getEventItem(this, ev);
      let confirmDialog = new Dialog({
        title: localize("ItemDeleteConfirmTitle"),
        content: `<p>${localizeParam("ItemDeleteConfirmText", {itemName: item.name})}</p>`,
        buttons: {
          yes: {
            label: localize("Yes"),
            callback: () => item.delete()
          },
          no: { label: localize("No") },
        },
        default:"no"
      });
      confirmDialog.render(true);
    }

    // Everything below here is only needed if the sheet is editable
    if (!this.options.editable) return;

    html.find('[data-keyboard-action="true"]').on("keydown", event => {
      if(event.key !== "Enter" && event.key !== " ") return;
      if(event.repeat) return;
      event.preventDefault();
      // Some compact sheet rows contain a focused attack action inside an
      // editable item row. Do not let the same keypress bubble up and trigger
      // both actions.
      event.stopPropagation();
      event.currentTarget.click();
    });
    
    // Find elements with stuff like html.find('.cssClass').click(this.function.bind(this));
    // Bind makes the "this" object in the function this.
    // html.find('.skill-search').click(this._onItemCreate.bind(this));

    html.find('.stat-roll').click(ev => {
      let statName = ev.currentTarget.dataset.statName;
      this.actor.rollStat(statName);
    });
    // TODO: Refactor these skill interactivity stuff into their own methods
    html.find(".skill-level").click((event) => event.target.select()).change(async (event) => {
      let skill = this.actor.items.get(event.currentTarget.dataset.skillId);
      let target = skill.system.isChipped ? "system.chipLevel" : "system.level";
      let updateData = {_id: skill.id};
      updateData[target] = parseInt(event.target.value, 10);
      await this.actor.updateEmbeddedDocuments("Item", [updateData]);
      // Mild hack to make sheet refresh and re-sort: the ability to do that should just be put in 
    });
    html.find(".chip-toggle").click(async ev => {
      let skill = this.actor.items.get(ev.currentTarget.dataset.skillId);
      await this.actor.updateEmbeddedDocuments("Item", [{
        _id: skill.id,
        "system.isChipped": !skill.system.isChipped
      }]);
    });

    html.find(".skill-sort > select").change(ev => {
      let sort = ev.currentTarget.value;
      this.actor.sortSkills(sort);
    });
    html.find(".skill-roll").click(ev => {
      let id = ev.currentTarget.dataset.skillId;
      this.actor.rollSkill(id);
    });
    html.find(".roll-initiative").click(ev => {
      this.actor.addToCombatAndRollInitiative();
    });
    html.find(".damage").click(async ev => {
      let damage = Number(ev.currentTarget.dataset.damage);
      await this.actor.update({
        "system.damage": damage
      });
    });
    html.find(".stun-death-save").click(ev => {
      this.actor.rollStunDeath();
    });
    html.find(".repair-cyberware-armor").click(async ev => {
      ev.stopPropagation();
      const item = getEventItem(this, ev);
      const update = buildArmorRepairUpdate(item);
      if(update) {
        await item.update(update);
      }
    });
    html.find(".repair-armor").click(async ev => {
      ev.stopPropagation();
      const item = getEventItem(this, ev);
      const update = buildArmorRepairUpdate(item);
      if(update) {
        await item.update(update);
      }
    });

    html.find('.item-roll').click(ev => {
      // Roll is often within child events, don't bubble please
      ev.stopPropagation();
      let item = getEventItem(this, ev);
      item.roll();
    });
    html.find('.item-edit').click(ev => {
      ev.stopPropagation();
      let item = getEventItem(this, ev);
      item.sheet.render(true);
    });
    html.find('.item-delete').click(deleteItemDialog.bind(this));
    html.find('.rc-item-delete').bind("contextmenu", deleteItemDialog.bind(this)); 

    function structuredResolverOptions(item) {
      if (isCorebookFidelityEnabled({ weapon: item, actor: item?.actor || this?.actor })) {
        return {};
      }
      return null;
    }

    html.find('.fire-weapon').click(async ev => {
      ev.stopPropagation();
      let item = getEventItem(this, ev);
      if(!item || item.type !== "weapon") return;
      let isRanged = item.isRanged();

      let onConfirm = undefined;
      const selectedTargets = Array.from(game.users.current.targets.values());
      let targetTokens = normalizeSelectedTargets(selectedTargets);
      
      let resolverOptions = structuredResolverOptions(item);
      let suppressiveFireOptions = null;
      let shotgunTemplateTargeting = null;
      let targetsToRaycast = selectedTargets;
      let normalizeTacticalTargetsFn = null;

      const attackerToken = this.actor.token || findControlledTokenForActor(this.actor);

      // If structured combat is active and weapon is ranged, prompt for raycast GM covers first
      if (resolverOptions && isRanged) {
        try {
          const { detectAndPromptTacticalRaycasts } = await import("../combat/tactical-raycast.js");
          const { normalizeTacticalTargets } = await import("../combat/target-normalizer.js");
          normalizeTacticalTargetsFn = normalizeTacticalTargets;

          const isLegacyShotgun = item.system?.weaponType === "Shotgun" || item.system?.weaponType === "Shotgun ";
          const isAutoshotgun = String(item.system?.attackType || "").toLowerCase().trim() === "autoshotgun";
          const hasAoE = !!item.system?.aoe?.type;

          if ((hasAoE || isLegacyShotgun) && !isAutoshotgun) {
            const { AOE_TEMPLATE_CHOICE, promptUseAoETemplate, drawAoETemplateAndGetTargets, buildAoETemplateTargetingOptions } = await import("../combat/template-placement.js");
            const templateChoice = await promptUseAoETemplate(item);
            if(templateChoice === AOE_TEMPLATE_CHOICE.canceled) {
              return;
            }
            if (templateChoice === AOE_TEMPLATE_CHOICE.template) {
              const shotgunTemplateResult = await drawAoETemplateAndGetTargets(item, attackerToken);
              if(shotgunTemplateResult?.canceled) {
                return;
              }
              const affectedTargets = Array.isArray(shotgunTemplateResult)
                ? shotgunTemplateResult
                : shotgunTemplateResult?.affectedTargets || [];
              shotgunTemplateTargeting = buildAoETemplateTargetingOptions({
                selectedTargets,
                affectedTargets,
                hazardZone: shotgunTemplateResult?.hazardZone
              });
              targetsToRaycast = shotgunTemplateTargeting.raycastTargets;
            }
          } else if (!isAutoshotgun) {
            const fireModes = typeof item.__getFireModes === "function" ? item.__getFireModes() : [];
            const isAutoWeapon = fireModes.includes("Suppressive") || fireModes.includes("FullAuto") || String(item.system?.attackType).toLowerCase() === "auto" || String(item.system?.weaponType).toLowerCase().includes("auto");

            if (isAutoWeapon) {
              const shotsLeft = Number(item.system?.shotsLeft) || 0;
              if (shotsLeft > 0) {
                const { SUPPRESSIVE_TEMPLATE_CHOICE, promptUseSuppressiveFireTemplate, placePersistentSuppressiveFireTemplate } = await import("../combat/template-placement.js");
                const suppressiveChoice = await promptUseSuppressiveFireTemplate(item, Math.min(shotsLeft, item.system?.rof || 999));
                if(suppressiveChoice?.choice === SUPPRESSIVE_TEMPLATE_CHOICE.canceled) {
                  return;
                }
                if (suppressiveChoice?.choice === SUPPRESSIVE_TEMPLATE_CHOICE.template) {
                  suppressiveFireOptions = suppressiveChoice;
                  const { getMaxRangeBracketDistance } = await import("../lookups.js");
                  const maxDistance = getMaxRangeBracketDistance(item.system?.range || 50, 'RangeClose');
                  const isPlaced = await placePersistentSuppressiveFireTemplate(attackerToken, item, suppressiveFireOptions.roundsFired, suppressiveFireOptions.zoneWidth, maxDistance);
                  if (isPlaced) {
                    await item.update({ "system.shotsLeft": shotsLeft - suppressiveFireOptions.roundsFired });
                    return; // Exit, because it's a persistent hazard now, no immediate attack roll needed
                  }
                  return;
                }
              }
            }
          }

          targetTokens = await detectAndPromptTacticalRaycasts(attackerToken, targetsToRaycast);
          targetTokens = normalizeTacticalTargetsFn({
            targets: targetTokens,
            ...(shotgunTemplateTargeting?.template ? { template: shotgunTemplateTargeting.template } : {})
          });
        } catch (e) {
          console.warn("Tactical raycast failure:", e);
          targetTokens = normalizeTacticalTargetsFn
            ? normalizeTacticalTargetsFn({
                targets: targetsToRaycast.map(target => markRaycastFailureManual(target)),
                ...(shotgunTemplateTargeting?.template ? { template: shotgunTemplateTargeting.template } : {})
              })
            : targetTokens.map(target => markRaycastFailureManual(target));
        }
      }
      
      if (attackerToken) {
        // Distance calculation for all targets
        targetTokens.forEach((tt, idx) => {
          if (tt.distance?.source === "template") {
            return;
          }
          const rawTarget = selectedTargets.find(t => t.id === tt.id || t.document?.uuid === tt.tokenUuid) || selectedTargets[idx];
          if (rawTarget && globalThis.canvas?.grid?.measureDistance) {
            const dist = globalThis.canvas.grid.measureDistance(attackerToken, rawTarget);
            tt.distance = { value: dist, units: globalThis.canvas.grid.units || "m", source: "standard-grid" };
          }
        });
      }

      let modifierGroups = undefined;
      if(isRanged) {
        modifierGroups = rangedModifiers(item, targetTokens);
        if (suppressiveFireOptions) {
          const fireModeMod = modifierGroups?.[0]?.find(m => m.localKey === "FireMode");
          if (fireModeMod && fireModeMod.choices?.includes("Suppressive")) {
             fireModeMod.defaultValue = "Suppressive";
          }
        }
      }
      else if (item.system.attackType === meleeAttackTypes.martial){
        modifierGroups = martialOptions(this.actor);
      }
      else {
        modifierGroups = meleeBonkOptions();
      }

      let dialog = new ModifiersDialog(this.actor, {
        weapon: item,
        targetTokens: targetTokens,
        modifierGroups: modifierGroups,
        onConfirm: async (fireOptions) => {
          if (suppressiveFireOptions && fireOptions.fireMode === "Suppressive") {
            fireOptions.roundsFired = suppressiveFireOptions.roundsFired;
            fireOptions.fireZoneWidth = suppressiveFireOptions.zoneWidth;
          }
          const isAutoshotgunFullAuto = String(item.system?.attackType || "").toLowerCase().trim() === "autoshotgun"
            && String(fireOptions.fireMode || "").toLowerCase() === "fullauto";
          if (isAutoshotgunFullAuto) {
            if (!attackerToken) {
              ui.notifications?.warn("Attacker token is required to place autoshotgun patterns.");
              return;
            }
            const shotsLeft = Number(item.system?.shotsLeft) || 0;
            const rof = Number(item.system?.rof) || 0;
            const maxShells = Math.min(shotsLeft, rof);
            const { promptAutoshotgunShellCount, drawAutoshotgunPatternsAndGetTargets } = await import("../combat/template-placement.js");
            const shellCount = await promptAutoshotgunShellCount(item, maxShells);
            if (!shellCount) {
              return;
            }
            const autoshotgunPlacement = await drawAutoshotgunPatternsAndGetTargets(item, attackerToken, shellCount);
            if(autoshotgunPlacement.canceled) {
              return;
            }
            fireOptions.autoshotgunPatterns = autoshotgunPlacement.patterns;
          }
          if (shotgunTemplateTargeting?.hazardZone) {
            fireOptions.hazardZone = shotgunTemplateTargeting.hazardZone;
          }
          let attackDieOptions = {};
          if (resolverOptions && getAttackDieEntryMode({ options: resolverOptions }) === "prompt") {
            attackDieOptions = await promptAttackDieEntry();
            if (attackDieOptions.canceled) return;
          }
          return item.__weaponRoll(fireOptions, targetTokens, { structured: !!resolverOptions, ...resolverOptions, ...attackDieOptions });
        }
      });
      dialog.render(true);
    });

    function findControlledTokenForActor(actor) {
      return globalThis.canvas?.tokens?.controlled?.find(token => token?.actor?.uuid === actor?.uuid);
    }

    function markRaycastFailureManual(target) {
      return {
        document: target?.document,
        actor: target?.actor,
        actorUuid: target?.actorUuid || target?.actor?.uuid,
        tokenUuid: target?.tokenUuid || target?.document?.uuid,
        id: target?.id,
        uuid: target?.uuid,
        name: target?.name,
        center: target?.center,
        bounds: target?.bounds,
        snapshot: target?.snapshot,
        ...target,
        manualResolution: {
          ...(target.manualResolution || {}),
          required: true,
          reason: target.manualResolution?.reason || "pending-user-decision",
          message: target.manualResolution?.message || "Tactical raycast failed; resolve cover/barrier interaction manually.",
          blockedUpdateCategories: [...new Set([...(target.manualResolution?.blockedUpdateCategories || []), "target-damage", "target-armor", "target-saves"])]
        },
        warnings: [
          ...(target.warnings || []),
          {
            code: "manual-tactical-raycast",
            severity: "warning",
            message: "Tactical raycast failed; resolve cover/barrier interaction manually."
          }
        ]
      };
    }
  }
}
