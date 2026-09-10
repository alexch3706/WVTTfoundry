import { weaponTypes, sortedAttackTypes, concealability, availability, reliability, attackSkills, meleeAttackTypes, getStatNames } from "../lookups.js";
import { formulaHasDice } from "../dice.js";
import { localize } from "../utils.js";
import { classifyConformance } from "../combat/conformance-helpers.js";
import { validateWeaponContract, validateArmorContract, WEAPON_FIRE_MODES } from "./item-contract.js";

/**
 * Extend the basic ItemSheet with some very simple modifications
 * @extends {ItemSheet}
 */
export class CyberpunkItemSheet extends ItemSheet {

  /** @override */
  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      classes: ["cyberpunk", "sheet", "item"],
      width: 520,
      height: 480,
      tabs: [{ navSelector: ".sheet-tabs", contentSelector: ".sheet-body", initial: "settings" }]
    });
  }

  /** @override */
  get template() {
    const path = "systems/cyberpunk2020-rilerena/templates/item";
    // Return a single sheet for all item types.
    // return `${path}/item-sheet.hbs`;

    // Alternatively, you could use the following return statement to do a
    // unique item sheet by type, like `weapon-sheet.hbs`.
    return `${path}/item-sheet.hbs`;
  }

  /* -------------------------------------------- */

  /** @override */
  async getData(options) {
    // This means the handlebars data and the form edit data actually mirror each other
    const data = await super.getData(options);
    data.system = this.item.system;
    const validator = this.item.type === "weapon" ? validateWeaponContract
      : ["armor", "cyberware"].includes(this.item.type) ? validateArmorContract : undefined;
    if(validator) {
      data.catalogIssues = validator(this.item.system, { type: this.item.type }).issues;
      data.hasAutomation = true;
    }
    data.hasStructuredCoverage = Object.keys(this.item.system.coverage || {}).length > 0;

    switch (this.item.type) {
      case "weapon":
        this._prepareWeapon(data);
        break;
    
      case "armor":
        this._prepareArmor(data);
        break;

      case "skill":
        this._prepareSkill(data);
        break;

      default:
        break;
    }

    // Derive conformance for non-skill items
    if (this.item.type !== "skill") {
      const scope = classifyConformance(this.item.system.source);
      const labelKey = `CYBERPUNK.Conformance${scope.charAt(0).toUpperCase() + scope.slice(1)}`;
      data.conformance = { scope, labelKey };
    }

    return data;
  }

  _prepareSkill(sheet) {
    sheet.stats = getStatNames();
  }

  _prepareWeapon(sheet) {
    sheet.weaponTypes = Object.values(weaponTypes).sort();
    if(this.item.system.weaponType === weaponTypes.melee) {
      sheet.attackTypes = Object.values(meleeAttackTypes).sort();
    }
    else {
      sheet.attackTypes = sortedAttackTypes;
    }
    sheet.concealabilities = Object.values(concealability);
    sheet.availabilities = Object.values(availability);
    sheet.reliabilities = Object.values(reliability);
    const keys = attackSkills[this.item.system.weaponType] || [];
    sheet.attackSkillChoices = keys.map(key => ({ key, label: localize("Skill" + key) }));
    sheet.attackSkills = [...keys.map(x => localize("Skill"+x)), ...(this.actor?.trainedMartials() || [])];
    for(const key of this.actor?.trainedMartials() || []) {
      sheet.attackSkillChoices.push({ key, label: key });
    }
    const current = this.item.system.attackSkill;
    sheet.selectedAttackSkill = sheet.attackSkillChoices.find(choice => choice.key === current || choice.label === current)?.key || current;
    if(current && !sheet.attackSkillChoices.some(choice => choice.key === sheet.selectedAttackSkill)) {
      sheet.attackSkillChoices.push({ key: current, label: current });
    }
    const configuredModes = Array.isArray(this.item.system.fireModes) ? this.item.system.fireModes : this.item.__getFireModes?.() || [];
    sheet.fireModeChoices = WEAPON_FIRE_MODES.map(key => ({ key, label: localize(key), selected: configuredModes.includes(key) }));

    // TODO: Be not so inefficient for this
    if(!sheet.attackSkills.length && this.actor) {
      if(this.actor) {
        sheet.attackSkills = this.actor.itemTypes.skill.map(skill => skill.name).sort();
      }
    }
  }

  _prepareArmor(sheet) {
    
  }

  async _updateObject(event, formData) {
    if(this.item.type === "weapon") {
      if(Object.prototype.hasOwnProperty.call(formData, "system.ap")) {
        const value = formData["system.ap"];
        formData["system.ap"] = value === true || value === "true" ? true : value === false || value === "false" ? false : null;
      }
      const selector = this.form?.querySelector?.('select[name="system.fireModes"]');
      if(selector) formData["system.fireModes"] = Array.from(selector.selectedOptions, option => option.value);
    }
    return super._updateObject(event, formData);
  }

  /* -------------------------------------------- */

  /** @override */
  setPosition(options = {}) {
    const position = super.setPosition(options);
    const sheetBody = this.element.find(".sheet-body");
    const bodyHeight = position.height - 192;
    sheetBody.css("height", bodyHeight);
    return position;
  }

  /* -------------------------------------------- */

  /** @override */
  activateListeners(html) {
    html = $(html);
    super.activateListeners(html);

    // Everything below here is only needed if the sheet is editable
    if (!this.options.editable) return;

    html.find(".enable-cyberware-coverage").on("click", ev => {
      ev.preventDefault();
      html.find(".cyberware-coverage-fields").prop("disabled", false);
      html.find(".enable-cyberware-coverage").hide();
    });

    // Roll handlers, click handlers, etc. would go here, same as actor sheet.
    html.find(".item-roll").click(this.item.roll.bind(this));

    html.find(".accel").click(() => this.item.accel());
    html.find(".decel").click(() => this.item.accel(true));
    
    // roll for humanity loss on cyberware 
    html.find('.humanity-cost-roll').click(async ev => {
      ev.stopPropagation();
      const cyber = this.object;
      const hc = cyber.system.humanityCost;
      let loss = 0;
      // determine if humanity cost is a number or dice
      if (formulaHasDice(hc)) {
        // roll the humanity cost
        let r = await new Roll(hc).evaluate();
        loss = r.total ? r.total : 0;
      } else {
        const num = Number(hc);
        loss = (isNaN(num)) ? 0 : num;
      }
      await cyber.update({ "system.humanityLoss": loss });
    });
  }
  
}
