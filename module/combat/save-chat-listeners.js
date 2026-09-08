import { isPrimaryActiveGm, resolveFoundryUuid } from "../foundry-compat.js";

const ACTIVE_SAVE_ROLLS = new Set();
const COMPLETED_SAVE_ROLLS = new Set();
const SAVE_RESOLUTION_LOCKS = new WeakMap();
const SAVE_RESOLUTION_FLAG = "combatSaveResolutions";

export function registerSaveChatListeners() {
  // Foundry V14 exposes chat-card HTML through the HTML-suffixed hook.
  Hooks.on("renderChatMessageHTML", bindSaveChatActions);
  const refreshAuthoritativeChatActions = () => {
    // Refresh GM-authoritative chat actions when the active primary GM changes.
    globalThis.ui?.chat?.render?.();
  };
  Hooks.on("updateUser", refreshAuthoritativeChatActions);
  Hooks.on("userConnected", refreshAuthoritativeChatActions);
}

export function bindSaveChatActions(message, html) {
  const systemId = game.system.id;
  const flags = message.getFlag(systemId, "combatOutcome");
  if (!flags || !Array.isArray(flags.targets)) return;

  const root = html?.querySelectorAll ? html : html?.[0];
  if(!root?.querySelectorAll) return;
  const persistedResolutions = message.getFlag(systemId, SAVE_RESOLUTION_FLAG) || [];
  const mayAutoRoll = isPrimaryActiveGm();

  for(const button of root.querySelectorAll(".save-action-autoroll")) {
    const targetIndex = Number.parseInt(button.dataset.targetIndex, 10);
    const targetData = flags.targets[targetIndex];
    const resolutionKey = buildSaveResolutionKey(targetData, targetIndex);
    const actionKey = `${message.id || message._id || "chat"}|${resolutionKey}`;
    const unavailable = !mayAutoRoll
      || ACTIVE_SAVE_ROLLS.has(actionKey)
      || COMPLETED_SAVE_ROLLS.has(actionKey)
      || hasPersistedResolution(persistedResolutions, resolutionKey);
    setButtonsDisabled([button], unavailable);
    if(!mayAutoRoll) button.title = "Automatic NPC saves are resolved by the active GM.";
    else if(button.title === "Automatic NPC saves are resolved by the active GM.") button.removeAttribute?.("title");

    if(button.dataset.cyberpunkSaveBound === "true") continue;
    button.dataset.cyberpunkSaveBound = "true";

    button.addEventListener("click", async (event) => {
      event.preventDefault();
      const action = event.currentTarget;
      if (action.disabled || ACTIVE_SAVE_ROLLS.has(actionKey) || COMPLETED_SAVE_ROLLS.has(actionKey)) return;
      if(!isPrimaryActiveGm()) {
        ui.notifications.warn("Only the active GM can auto-roll NPC saves.");
        return;
      }
      // Lock only the automatic action. The manual-resolution button must
      // remain available if a prompt is incomplete or cannot be rolled.
      const autoRollActions = action.closest(".save-actions")?.querySelectorAll(".save-action-autoroll") || [action];
      setButtonsDisabled(autoRollActions, true);
      ACTIVE_SAVE_ROLLS.add(actionKey);

      if (!targetData) {
        ACTIVE_SAVE_ROLLS.delete(actionKey);
        setButtonsDisabled(autoRollActions, false);
        return;
      }

      let rollsStarted = false;
      try {
        const targetUuid = targetData.target?.actorUuid;
        const actor = targetUuid ? await resolveFoundryUuid(targetUuid) : undefined;
        if (!actor) {
          ui.notifications.warn(`Could not find actor ${targetUuid || "for this target"}`);
          setButtonsDisabled(autoRollActions, false);
          return;
        }
        if (actor.isOwner === false && !game.user?.isGM) {
          ui.notifications.warn(`You do not have permission to roll saves for ${actor.name}.`);
          setButtonsDisabled(autoRollActions, false);
          return;
        }

        const liveResolutions = message.getFlag(systemId, SAVE_RESOLUTION_FLAG) || [];
        if(hasPersistedResolution(liveResolutions, resolutionKey)) {
          COMPLETED_SAVE_ROLLS.add(actionKey);
          return;
        }
        const lockPersisted = await persistSaveResolution(message, systemId, resolutionKey, "pending");
        if(!lockPersisted) {
          ui.notifications.warn("Could not lock this automatic save action. Ask the active GM to resolve it manually.");
          setButtonsDisabled(autoRollActions, false);
          return;
        }
        rollsStarted = true;
        const saveResult = await autoRollSaves(actor, targetData.saves);
        COMPLETED_SAVE_ROLLS.add(actionKey);
        await persistSaveResolution(message, systemId, resolutionKey, saveResult.manualRequired ? "partial" : "auto");
        if(saveResult.manualRequired) {
          ui.notifications.warn("One or more saves lacked a valid threshold. Resolve them manually.");
        }
      } catch (error) {
        console.error("Failed to resolve combat saves:", error);
        ui.notifications.error("Could not finish the automatic saves. Resolve the remaining saves manually.");
        if(rollsStarted) {
          // A roll/chat message may already have been emitted. Keep the action
          // idempotently locked instead of risking a contradictory reroll.
          COMPLETED_SAVE_ROLLS.add(actionKey);
          await persistSaveResolution(message, systemId, resolutionKey, "partial");
        } else {
          setButtonsDisabled(autoRollActions, false);
        }
      } finally {
        ACTIVE_SAVE_ROLLS.delete(actionKey);
      }
    });
  }

  for(const button of root.querySelectorAll(".save-action-manual")) {
    if(button.dataset.cyberpunkSaveBound === "true") continue;
    button.dataset.cyberpunkSaveBound = "true";
    button.addEventListener("click", (event) => {
      event.preventDefault();
      ui.notifications.info("Manual resolution for saves clicked. Update the character sheet manually.");
    });
  }
}

async function autoRollSaves(actor, saves) {
  if (!saves || saves.length === 0) return { manualRequired: false };

  let hasFailedStun = false;
  let manualRequired = false;
  const actorName = escapeChatHtml(actor.name || "Target");

  for (const save of saves) {
    if (save.type === "stun" && hasFailedStun) {
      continue; // Skip further Stun Saves if target is already Stunned
    }
    const roll = await new Roll("1d10").evaluate();
    const threshold = resolveSaveThreshold(save);
    if (threshold === undefined) {
      ui.notifications.warn(`Save threshold is unavailable for ${actor.name}; resolve this save manually.`);
      manualRequired = true;
      continue;
    }
    const isSuccess = isSaveRollSuccessful(roll.total, save);

    let title = `${save.type === 'stun' ? 'Stun/Shock' : 'Death'} Save`;
    if (save.type === 'death') {
      title += ` (Mortal ${save.mortalLevel})`;
    } else {
      title += ` (${save.woundState.label})`;
    }
    const safeTitle = escapeChatHtml(title);
    const safeThreshold = escapeChatHtml(threshold);
    const safeBodyType = escapeChatHtml(save.bodyType);
    const safePenalty = escapeChatHtml(save.penalty);
    const safeRollTotal = escapeChatHtml(roll.total);

    const flavor = `<b>${actorName}</b> attempts a ${safeTitle}...<br/>
      Success on d10 ≤ ${safeThreshold} (BT ${safeBodyType} - ${safePenalty} penalty)<br/>
      Result: ${safeRollTotal} - <b>${isSuccess ? "SUCCESS" : "FAILURE"}</b>`;

    await roll.toMessage({
      speaker: ChatMessage.getSpeaker({ actor }),
      flavor: flavor
    });

    if (!isSuccess) {
      if (save.type === "stun") {
        hasFailedStun = true;
        await ChatMessage.create({
          speaker: ChatMessage.getSpeaker({ actor }),
          content: `<b>${actorName}</b> has failed a Stun/Shock Save and is now <b>Stunned</b>!`
        });
      } else if (save.type === "death") {
        await ChatMessage.create({
          speaker: ChatMessage.getSpeaker({ actor }),
          content: `<b>${actorName}</b> has failed a Death Save and is now <b>DEAD</b>!`
        });
        break; // Stop rolling if they died
      }

    }
  }
  return { manualRequired };
}

export function resolveSaveThreshold(save = {}) {
  const value = Number(save.threshold ?? save.targetNumber);
  return Number.isFinite(value) ? value : undefined;
}

export function isSaveRollSuccessful(rollTotal, save = {}) {
  const threshold = resolveSaveThreshold(save);
  const total = Number(rollTotal);
  return threshold !== undefined && Number.isFinite(total) && total <= threshold;
}

export function buildSaveResolutionKey(targetData = {}, targetIndex = 0) {
  return targetData?.target?.tokenUuid
    || `${targetData?.target?.actorUuid || "unknown-actor"}:${Number.isInteger(targetIndex) ? targetIndex : 0}`;
}

function hasPersistedResolution(resolutions, key) {
  return Array.isArray(resolutions) && resolutions.some(entry => entry?.key === key);
}

function setButtonsDisabled(buttons, disabled) {
  for(const button of Array.from(buttons || [])) {
    button.disabled = disabled;
    if(disabled) button.setAttribute?.("aria-disabled", "true");
    else button.removeAttribute?.("aria-disabled");
  }
}

export async function persistSaveResolution(message, systemId, key, status) {
  if(typeof message?.setFlag !== "function") return false;
  return await withSaveResolutionLock(message, async () => {
    try {
      const stored = message.getFlag(systemId, SAVE_RESOLUTION_FLAG);
      const current = Array.isArray(stored) ? stored : [];
      const next = [
        ...current.filter(entry => entry?.key !== key),
        {
          key,
          status,
          userId: game.user?.id,
          resolvedAt: new Date().toISOString()
        }
      ];
      await message.setFlag(systemId, SAVE_RESOLUTION_FLAG, next);
      return true;
    } catch(error) {
      // A persisted lock is required before any automatic roll starts; after a
      // partial roll it also records that manual resolution is safer than a retry.
      console.warn("Could not persist combat save resolution on ChatMessage:", error);
      return false;
    }
  });
}

async function withSaveResolutionLock(message, callback) {
  const previous = SAVE_RESOLUTION_LOCKS.get(message) || Promise.resolve();
  let release;
  const current = new Promise(resolve => { release = resolve; });
  SAVE_RESOLUTION_LOCKS.set(message, current);
  await previous.catch(() => {});
  try {
    return await callback();
  } finally {
    release();
    if(SAVE_RESOLUTION_LOCKS.get(message) === current) {
      SAVE_RESOLUTION_LOCKS.delete(message);
    }
  }
}

function escapeChatHtml(value) {
  if(typeof globalThis.foundry?.utils?.escapeHTML === "function") {
    return globalThis.foundry.utils.escapeHTML(String(value ?? ""));
  }
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
