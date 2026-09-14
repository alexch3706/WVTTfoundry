import { loadFoundryTemplates } from "./foundry-compat.js";

/**
 * Define a set of template paths to pre-load
 * Pre-loaded templates are compiled and cached for fast access when rendering
 * @return {Promise}
 */
export const preloadHandlebarsTemplates = async function() {
    // Path to partial from foundry path. For cyberpunk, is "systems/cyberpunk2020-rilerena/templates/actor/parts/___.hbs". Is .hbs as they're handlebars files
    return loadFoundryTemplates([
        "systems/cyberpunk2020-rilerena/templates/actor/parts/statsrow.hbs",
        "systems/cyberpunk2020-rilerena/templates/actor/parts/woundtracker.hbs",
        "systems/cyberpunk2020-rilerena/templates/actor/parts/skills.hbs",
        "systems/cyberpunk2020-rilerena/templates/actor/parts/gear.hbs",
        "systems/cyberpunk2020-rilerena/templates/actor/parts/cyberware.hbs",
        "systems/cyberpunk2020-rilerena/templates/actor/parts/combat.hbs",
        "systems/cyberpunk2020-rilerena/templates/actor/parts/armor-display.hbs",
        "systems/cyberpunk2020-rilerena/templates/actor/parts/skill.hbs",

        // Shared templates
        "systems/cyberpunk2020-rilerena/templates/fields/string.hbs",
        "systems/cyberpunk2020-rilerena/templates/fields/number.hbs",
        "systems/cyberpunk2020-rilerena/templates/fields/boolean.hbs",
        "systems/cyberpunk2020-rilerena/templates/fields/select.hbs",

        // Roll templates
        "systems/cyberpunk2020-rilerena/templates/chat/default-roll.hbs",
        "systems/cyberpunk2020-rilerena/templates/chat/save-roll.hbs",
        "systems/cyberpunk2020-rilerena/templates/chat/weapon-roll.hbs",
        "systems/cyberpunk2020-rilerena/templates/chat/multi-hit.hbs",
        "systems/cyberpunk2020-rilerena/templates/chat/combat-outcome.hbs",

        // Item sheet
        "systems/cyberpunk2020-rilerena/templates/item/item-sheet.hbs",

        // Weapon parts
        "systems/cyberpunk2020-rilerena/templates/item/parts/weapon/summary.hbs",
        "systems/cyberpunk2020-rilerena/templates/item/parts/weapon/settings.hbs",
        // Armor parts
        "systems/cyberpunk2020-rilerena/templates/item/parts/armor/summary.hbs",
        "systems/cyberpunk2020-rilerena/templates/item/parts/armor/settings.hbs",
        // Cyberware
        "systems/cyberpunk2020-rilerena/templates/item/parts/cyberware/summary.hbs",
        "systems/cyberpunk2020-rilerena/templates/item/parts/cyberware/settings.hbs",
        // Vehicle
        "systems/cyberpunk2020-rilerena/templates/item/parts/vehicle/summary.hbs",
        "systems/cyberpunk2020-rilerena/templates/item/parts/vehicle/settings.hbs",
        // Skill
        "systems/cyberpunk2020-rilerena/templates/item/parts/skill/summary.hbs",
        "systems/cyberpunk2020-rilerena/templates/item/parts/skill/settings.hbs",

        // Shared item partials
        "systems/cyberpunk2020-rilerena/templates/item/parts/shared/conformance-badge.hbs",

        // Misc
        "systems/cyberpunk2020-rilerena/templates/item/parts/misc/summary.hbs",
        "systems/cyberpunk2020-rilerena/templates/item/parts/misc/settings.hbs",

        // Weapon settings dialog
        "systems/cyberpunk2020-rilerena/templates/dialog/modifiers.hbs",
        "systems/cyberpunk2020-rilerena/templates/dialog/combat-confirm.hbs",

    ]);
  };
