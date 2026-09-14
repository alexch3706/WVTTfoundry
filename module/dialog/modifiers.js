import { deepSet, localize } from "../utils.js"
import { isCorebookFidelityEnabled } from "../combat/settings-helpers.js"
import { parseManualAttackDie } from "../combat/attack-die-entry.js"

const primaryModifierPaths = new Set(["fireMode", "range", "aimRounds", "targetArea", "action", "martialArt"]);
// Deliberately client-session only: situational modifiers and physical dice must
// never leak into another attack, another weapon, or a persisted world setting.
const rememberedFireModes = new Map();

function choiceValues(choices = []) {
  return choices.flatMap(choice => choice?.choices
    ? choiceValues(choice.choices)
    : [typeof choice === "object" ? choice.value : choice]);
}

function submittedValue(values, path) {
  if (!values) return undefined;
  if (Object.hasOwn(values, path)) return values[path];
  return path.split(".").reduce((current, segment) => current?.[segment], values);
}

function notifyError(error) {
  globalThis.ui?.notifications?.error?.(error?.message || localize("AttackSubmitError"));
}

function setConfirming(dialog, confirming, locked = false) {
  const form = dialog.form || dialog.element?.[0]?.querySelector?.("form");
  form?.setAttribute?.("aria-busy", String(confirming));
  for (const button of form?.querySelectorAll?.('[type="submit"]') || []) {
    button.disabled = confirming || locked;
  }
}

function updateTargetingFields(form) {
  const targeting = form?.querySelector?.('[name="targetingMode"]');
  if (!targeting) return;
  const suppressive = form.querySelector('[name="fireMode"]')?.value === "Suppressive";
  targeting.disabled = suppressive;
  const useTemplate = !suppressive && targeting.value === "template";
  const range = form.querySelector('[name="range"]');
  if (range) range.disabled = useTemplate;
  const hint = form.querySelector(".attack-template-range-hint");
  if (hint) hint.hidden = !useTemplate;
}

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
        // The callback can include cancellable placement and physical-die
        // validation. Closing is owned by _updateObject after it succeeds.
        closeOnSubmit: false,
        weapon: null,
        // Use like [[mod1, mod2], [mod3, mod4, mod5]] etc to add groupings,
        modifierGroups: [],
        targetTokens: [], // id and name for each target token
        // Extra mod field for miscellaneous mod
        extraMod: true,
        templateTargetingAvailable: false,
        manualAttackDieEnabled: false,

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
        weapon: this.options.weapon,
        targetTokens: this.options.targetTokens || [],
        templateTargetingAvailable: !!this.options.templateTargetingAvailable,
        manualAttackDieEnabled: !!this.options.manualAttackDieEnabled,
        targetingModes: [
          { value: "selected", localKey: "AttackSelectedTargets" },
          { value: "template", localKey: "AttackAreaTemplate" }
        ],
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
          let value = submittedValue(this._submittedValues, modifier.dataPath)
            ?? modifier.defaultValue ?? "";
          if (modifier.dataPath === "fireMode") {
            const allowedModes = choiceValues(modifier.choices);
            const uuid = this.options.weapon?.uuid;
            const remembered = uuid ? rememberedFireModes.get(uuid) : undefined;
            if (remembered !== undefined && !allowedModes.includes(remembered)) {
              rememberedFireModes.delete(uuid);
            }
            if (submittedValue(this._submittedValues, modifier.dataPath) === undefined
                && allowedModes.includes(remembered)) {
              value = remembered;
            }
            if (!allowedModes.includes(value)) value = allowedModes[0] ?? "";
          }
          deepSet(data.defaultValues, modifier.dataPath, value);
        })
      })

      const splitGroups = primary => data.modifierGroups
        .map(group => group.filter(modifier => primaryModifierPaths.has(modifier.dataPath) === primary))
        .filter(group => group.length > 0);
      data.primaryModifierGroups = splitGroups(true);
      data.advancedModifierGroups = splitGroups(false);
      data.advancedExpanded = data.advancedModifierGroups.flat().some(modifier => {
        const submitted = submittedValue(this._submittedValues, modifier.dataPath);
        return submitted !== undefined && String(submitted) !== String(modifier.defaultValue ?? "");
      });
      data.defaultValues.targetingMode = data.templateTargetingAvailable
        && this._submittedValues?.targetingMode === "template" ? "template" : "selected";
      data.manualAttackDie = data.manualAttackDieEnabled ? this._submittedValues?.manualAttackDie ?? "" : "";

      return data;
    }

    /** @override */
    activateListeners(html) {
      super.activateListeners(html);
      const root = html?.[0] || html;
      const form = this.form || root?.querySelector?.("form") || root;
      for (const control of form?.querySelectorAll?.('[name="targetingMode"], [name="fireMode"]') || []) {
        control.addEventListener("change", () => updateTargetingFields(form));
      }
      updateTargetingFields(form);
      setConfirming(this, !!this._confirmInFlight, !!this._nonRetryableError);
    }
  
    /* -------------------------------------------- */
  
    /** @override */
    async _updateObject(event, formData) {
      // FormApplication.submit() has already called this method. Calling
      // submit() again from here re-enters _updateObject and can execute an
      // attack more than once. Treat this method as the single confirmation
      // boundary instead.
      if (this._confirmInFlight || this._confirmed) return false;
      this._submittedValues = { ...formData };
      // Disabled controls are omitted by native form serialization. Keep their
      // UI values for a retry/re-render without adding them to combat options.
      for (const name of ["range", "targetingMode"]) {
        const control = this.form?.querySelector?.(`[name="${name}"]`);
        if (control?.disabled && !Object.hasOwn(this._submittedValues, name)) {
          this._submittedValues[name] = control.value;
        }
      }
      this.object = formData;
      const fireMode = (this.options.modifierGroups || []).flat()
        .find(modifier => modifier.dataPath === "fireMode");
      try {
        if (fireMode && !choiceValues(fireMode.choices).includes(formData.fireMode)) {
          throw new Error(localize("AttackInvalidFireMode"));
        }
        if (this.options.templateTargetingAvailable
            && !["selected", "template"].includes(formData.targetingMode ?? "selected")) {
          throw new Error(localize("AttackInvalidTargetingMode"));
        }
        if (this.options.manualAttackDieEnabled) {
          formData.manualAttackDie = String(formData.manualAttackDie ?? "").trim();
          if (formData.manualAttackDie) parseManualAttackDie(formData.manualAttackDie);
        }
      } catch (error) {
        notifyError(error);
        return false;
      }

      this._confirmInFlight = true;
      setConfirming(this, true);
      try {
        const result = typeof this.options.onConfirm === "function"
          ? await this.options.onConfirm(formData) : undefined;
        if (result === false || result?.canceled) return false;
        const uuid = this.options.weapon?.uuid;
        if (uuid && fireMode) rememberedFireModes.set(uuid, formData.fireMode);
        this._confirmed = true;
        await this.close?.();
        return result;
      } catch (error) {
        if (error?.nonRetryable) {
          // A partial external commit cannot safely be repeated. Keep the
          // displayed form for inspection, but make it permanently read-only
          // at the confirmation boundary (including after a re-render).
          this._confirmed = true;
          this._nonRetryableError = true;
        }
        notifyError(error);
        return false;
      } finally {
        this._confirmInFlight = false;
        setConfirming(this, false, !!this._nonRetryableError);
      }
    }
 }
