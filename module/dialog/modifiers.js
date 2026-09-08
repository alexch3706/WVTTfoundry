import { deepSet, localize } from "../utils.js"
import { defaultTargetLocations } from "../lookups.js"
import { isCorebookFidelityEnabled } from "../combat/settings-helpers.js"

/**
 * A specialized form used to select the modifiers for shooting with a weapon
 * This could, I guess, also be done with dialog and FormDataExtended
 * @implements {FormApplication}
 */
 export class ModifiersDialog extends FormApplication {

    /** @override */
      static get defaultOptions() {
        return foundry.utils.mergeObject(super.defaultOptions, {
        id: "weapon-modifier",
        classes: [game.system.id],
        title: localize("AttackModifiers"),
        template: "systems/cyberpunk2020-rilerena/templates/dialog/modifiers.hbs",
        width: 400,
        height: "auto",
        weapon: null,
        // Use like [[mod1, mod2], [mod3, mod4, mod5]] etc to add groupings,
        modifierGroups: [],
        targetTokens: [], // id and name for each target token
        // Extra mod field for miscellaneous mod
        extraMod: true,

        onConfirm: (results) => console.log(results)
      });
    }
  
    /* -------------------------------------------- */
  
    /**
     * Return a reference to the target attribute
     * @type {String}
     */
    get attribute() {
        return this.options.name;
    }
  
    /* -------------------------------------------- */
  
    /** @override */
    getData() {
      // Woo! This should be much more flexible than the previous implementation
      // My gods did it require thinking about the shape of things, because loosely-typed can be a headache

      // The dialog enriches modifiers with template metadata below. Work on a
      // copy so a re-render cannot mutate the options supplied by the caller or
      // append another "extra modifier" group each time.
      const modifierGroups = (this.options.modifierGroups || []).map(group =>
        (group || []).map(modifier => ({ ...modifier }))
      );

      let data = {
        modifierGroups,
        targetTokens: this.options.targetTokens,
        // You can't refer to indices in FormApplication form entries as far as I know, so let's give them a place to live
        defaultValues: {},
        isCorebookFidelityEnabled: isCorebookFidelityEnabled({ weapon: this.options.weapon })
      };
      if(this.options.extraMod) {
        data.modifierGroups.push([{
          localKey: "ExtraModifiers",
          dataPath: "extraMod",
          defaultValue: 0
        }]);
      }

      data.modifierGroups.forEach(group => {
        group.forEach(modifier => {
          // path towards modifier's field template
          let fieldPath = `fields/${modifier.choices 
            ? "select" : typeof(modifier.defaultValue)}`;
 
          modifier.fieldPath = fieldPath;
          deepSet(data.defaultValues, modifier.dataPath, (modifier.defaultValue !== undefined ? modifier.defaultValue : ""));
        })
      })

      return data;
    }
  
    /* -------------------------------------------- */
  
    /** @override */
    async _updateObject(event, formData) {
      // FormApplication.submit() has already called this method. Calling
      // submit() again from here re-enters _updateObject and can execute an
      // attack more than once. Treat this method as the single confirmation
      // boundary instead.
      this.object = formData;
      if(typeof this.options.onConfirm === "function") {
        await this.options.onConfirm(formData);
      }
    }
 }
