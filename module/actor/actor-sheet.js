import { fireModes, martialOptions, meleeAttackTypes, meleeBonkOptions, rangedModifiers, weaponTypes } from "../lookups.js"
import { localize, localizeParam } from "../utils.js"
import { ModifiersDialog } from "../dialog/modifiers.js"
import { SortOrders } from "./skill-sort.js";
import { buildInitialAttackTargets, executeAttackFromForm, supportsAreaTargeting } from "../combat/attack-workflow.js";
import { getAttackDieEntryMode, isCorebookFidelityEnabled } from "../combat/settings-helpers.js";
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
    sheetData.skillDisplayList = sheetData.filteredSkillIDs
      .map(id => this.actor.items.get(id))
      .filter(Boolean);
  }

  // Handle searching skills
  _filterSkills(sheetData) {
    if(sheetData.system.transient.skillFilter == null) {
      sheetData.system.transient.skillFilter = "";
    }
    const upperSearch = sheetData.system.transient.skillFilter.toUpperCase();
    const skillItems = Array.from(this.actor.itemTypes?.skill || []);
    const currentIDs = skillItems.map(skill => skill.id);
    const currentIDSet = new Set(currentIDs);
    const cachedIDs = sheetData.system.sortedSkillIDs;
    const cacheMatchesCurrentItems = Array.isArray(cachedIDs)
      && cachedIDs.length === currentIDs.length
      && new Set(cachedIDs).size === cachedIDs.length
      && cachedIDs.every(id => currentIDSet.has(id));
    const listToFilter = cacheMatchesCurrentItems
      ? cachedIDs
      : sortSkills(skillItems, SortOrders[sheetData.skillsSort] || SortOrders.Name).map(skill => skill.id);

    // Only filter if we need to
    if(upperSearch === "") {
      return listToFilter;
    }
    return listToFilter.filter(id =>
      this.actor.items.get(id)?.name?.toUpperCase().includes(upperSearch)
    );
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
      const item = getEventItem(this, ev);
      if(!item || item.type !== "weapon" || item.warnInvalidCombatData?.()) return;
      const selectedTargets = Array.from(game.users.current.targets.values());
      const attackerToken = this.actor.token || findControlledTokenForActor(this.actor);
      const resolverOptions = structuredResolverOptions(item);
      const targetTokens = buildInitialAttackTargets(attackerToken, selectedTargets);
      const modifierGroups = item.isRanged()
        ? rangedModifiers(item, targetTokens, { suppressiveTemplateAvailable: resolverOptions !== null })
        : item.system.attackType === meleeAttackTypes.martial
          ? martialOptions(this.actor)
          : meleeBonkOptions();

      new ModifiersDialog(this.actor, {
        weapon: item,
        targetTokens,
        modifierGroups,
        templateTargetingAvailable: supportsAreaTargeting(item, resolverOptions !== null),
        manualAttackDieEnabled: resolverOptions !== null && getAttackDieEntryMode({ options: resolverOptions }) === "prompt",
        onConfirm: fireOptions => executeAttackFromForm({
          weapon: item, attackerToken, selectedTargets, resolverOptions, fireOptions
        })
      }).render(true);
    });

    function findControlledTokenForActor(actor) {
      return globalThis.canvas?.tokens?.controlled?.find(token => token?.actor?.uuid === actor?.uuid);
    }

  }
}
