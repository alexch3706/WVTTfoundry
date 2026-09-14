import { renderFoundryTemplate } from "../foundry-compat.js";
import { localize, localizeParam } from "../utils.js";
import { getDeathSaveState, getStunSaveState, isSaveRollSuccessful, requiresRecurringDeathSave } from "./save-resolver.js";

export const MANUAL_SAVE_TEMPLATE = "systems/cyberpunk2020-rilerena/templates/chat/save-roll.hbs";

/**
 * The sheet's combined button uses one ordinary d10, evaluated separately for
 * each applicable save. This is informational: it never changes actor state or
 * claims to resolve the persistent automatic-save prompts in combat chat.
 */
export async function rollManualStunDeath(actor) {
  if(actor.system?.isFBC) {
    ui.notifications.info(localize("SaveFbcNotRequired"));
    return;
  }

  const stun = getStunSaveState(actor);
  const death = getDeathSaveState(actor);
  const damage = actor.system?.damage;
  if(damage === undefined || damage === null || damage === ""
    || !Number.isInteger(stun.damage) || !Number.isInteger(stun.bodyType)
    || stun.threshold === undefined || death.threshold === undefined) {
    ui.notifications.warn(localize("SaveInvalidState"));
    return;
  }
  if(death.dead) {
    ui.notifications.info(localize("SaveAlreadyDead"));
    return;
  }

  // Deliberately not makeD10Roll/Multiroll: saves neither explode on 10 nor
  // inherit high-is-good critical/fumble or min/max presentation.
  const roll = await new Roll("1d10").evaluate();
  const saves = [
    buildSaveFeedback("stun", stun, roll.total, true),
    buildSaveFeedback("death", death, roll.total, requiresRecurringDeathSave(actor))
  ];
  const content = await renderFoundryTemplate(MANUAL_SAVE_TEMPLATE, {
    title: localize("StunDeathSave"),
    instruction: localize("UnderThresholdMessage"),
    rollOnly: localize("SaveRollOnly"),
    roll,
    saves
  });

  return ChatMessage.create({
    author: game.user.id,
    speaker: ChatMessage.getSpeaker({ actor }),
    rolls: [roll],
    sound: "sounds/dice.wav",
    content
  });
}

function buildSaveFeedback(type, state, rollTotal, required) {
  const passed = required ? isSaveRollSuccessful(rollTotal, state) : undefined;
  return {
    type,
    name: localize(type === "stun" ? "SaveStunLabel" : "SaveDeathLabel"),
    required,
    passed,
    threshold: state.threshold,
    formula: localizeParam("SaveFormula", {
      body: state.bodyType,
      penalty: state.penalty,
      threshold: state.threshold
    }),
    label: localize(required ? (passed ? "SaveSuccess" : "SaveFailure") : "SaveNotRequired"),
    resultClass: required ? (passed ? "outcome-hit" : "outcome-miss") : "outcome-not-fired",
    notRequiredReason: required ? "" : localize("SaveDeathNotRequired")
  };
}
