import { getDeathSaveState, requiresRecurringDeathSave } from "./save-resolver.js";
import { isPrimaryActiveGm } from "../foundry-compat.js";

const emittedTurnKeys = new Set();
const MAX_EMITTED_TURN_KEYS = 500;

export function registerCombatTurnDeathSaveHook() {
  if(typeof Hooks === "undefined" || !Hooks?.on) {
    return;
  }
  Hooks.on("combatTurnChange", (combat, prior, current) => {
    handleCombatTurnDeathSaveReminder(combat, current, { prior, current }).catch(error => {
      console.warn("CYBERPUNK | Failed to create turn-start Death Save reminder", error);
    });
  });
}

export async function handleCombatTurnDeathSaveReminder(combat, updateData = {}, updateOptions = {}, options = {}) {
  const adapter = options.adapter || createFoundryDeathSaveTurnAdapter();
  if(!adapter.isAuthoritativeClient()) {
    return { status: "skipped", reason: "not-authoritative-client" };
  }
  if(!isActiveStartedCombat(combat)) {
    return { status: "skipped", reason: "inactive-combat" };
  }

  const combatant = resolveActiveCombatant(combat);
  const actor = combatant?.actor;
  if(!actor) {
    return { status: "skipped", reason: "no-actor" };
  }

  const deathSaveState = getDeathSaveState(actor);
  if (deathSaveState.woundState?.level < 4) { // Not mortal
    return { status: "skipped", reason: "no-recurring-death-save" };
  }

  if (deathSaveState.dead) {
    return { status: "skipped", reason: "dead" };
  }
  if (deathSaveState.stabilized) {
    return { status: "skipped", reason: "stabilized" };
  }

  const turnKey = buildTurnKey(combat, combatant, updateData);
  if(emittedTurnKeys.has(turnKey)) {
    return { status: "duplicate", turnKey };
  }
  rememberTurnKey(turnKey);

  const reminder = buildTurnStartDeathSaveReminder(actor, { combat, combatant, deathSaveState });
  await adapter.createReminderMessage(reminder, { combat, combatant, updateOptions });
  return { status: "created", turnKey, reminder };
}

export function buildTurnStartDeathSaveReminder(actor, context = {}) {
  const deathSaveState = context.deathSaveState || getDeathSaveState(actor);
  const actorName = actor?.name || context?.combatant?.token?.name || localize("UnknownActor", "Unknown actor");
  const isDead = !!deathSaveState.dead;
  const isStabilized = !!deathSaveState.stabilized;
  return {
    type: "death",
    status: isDead || isStabilized ? "manual" : "pending",
    reason: "turn-start-recurring-death-save",
    actorName,
    mortalLevel: deathSaveState.mortalLevel,
    bodyType: deathSaveState.bodyType,
    threshold: deathSaveState.threshold,
    targetNumber: deathSaveState.threshold,
    penalty: deathSaveState.penalty,
    woundState: deathSaveState.woundState,
    stabilized: isStabilized,
    dead: isDead,
    manual: isDead || isStabilized
  };
}

function createFoundryDeathSaveTurnAdapter() {
  return {
    isAuthoritativeClient() {
      return isPrimaryActiveGm();
    },
    async createReminderMessage(reminder, { combatant } = {}) {
      const content = renderReminderContent(reminder);
      await ChatMessage.create({
        author: game.user.id,
        speaker: ChatMessage.getSpeaker({ actor: combatant?.actor }),
        content
      });
    }
  };
}

function isActiveStartedCombat(combat) {
  if(!combat) {
    return false;
  }
  if(combat.started === false) {
    return false;
  }
  if(combat.started === true) {
    return true;
  }
  return Number(combat.round || 0) > 0;
}

function resolveActiveCombatant(combat) {
  if (combat?.combatant) {
    return combat.combatant;
  }
  return undefined;
}

function buildTurnKey(combat, combatant, updateData = {}) {
  const combatId = combat?.uuid || combat?.id || "combat";
  const round = updateData.round ?? combat?.round ?? 0;
  const turn = updateData.turn ?? combat?.turn ?? 0;
  const combatantId = combatant?.id || combatant?._id || combatant?.actor?.uuid || combatant?.actor?.id || "combatant";
  return `${combatId}:${round}:${turn}:${combatantId}`;
}

function rememberTurnKey(turnKey) {
  emittedTurnKeys.add(turnKey);
  if(emittedTurnKeys.size <= MAX_EMITTED_TURN_KEYS) {
    return;
  }
  const oldestKey = emittedTurnKeys.values().next().value;
  emittedTurnKeys.delete(oldestKey);
}

function renderReminderContent(reminder) {
  const title = localize("DeathSaveReminderTitle", "Death Save Reminder");
  const stateLabel = reminder.dead
    ? localize("DeathSaveReminderDead", "Dead/manual")
    : reminder.stabilized
      ? localize("DeathSaveReminderStabilized", "Stabilized/manual")
      : localize("DeathSaveReminderPending", "Pending");
  
  const formattedBody = formatLocalize("DeathSaveReminderBody", {
    actor: reminder.actorName,
    woundState: reminder.woundState?.label || "",
    bodyType: reminder.bodyType ?? "?",
    penalty: reminder.penalty ?? "?",
    threshold: reminder.threshold ?? "?",
    state: stateLabel
  }, null);

  const fallbackBody = formattedBody ? formattedBody : `${reminder.actorName}: ${reminder.woundState?.label || ""}, Body Type ${reminder.bodyType ?? "?"}, Penalty ${reminder.penalty ?? "?"}, Threshold ${reminder.threshold ?? "?"}, ${stateLabel}`;

  return [
    `<h3>${escapeHtml(title)}</h3>`,
    `<p>${escapeHtml(fallbackBody)}</p>`
  ].join("");
}

function localize(key, fallback) {
  const fullKey = `CYBERPUNK.${key}`;
  if(typeof game !== "undefined" && game?.i18n?.has?.(fullKey)) {
    return game.i18n.localize(fullKey);
  }
  return fallback;
}

function formatLocalize(key, params, fallback) {
  const fullKey = `CYBERPUNK.${key}`;
  if(typeof game !== "undefined" && game?.i18n?.has?.(fullKey)) {
    return game.i18n.format(fullKey, params);
  }
  return fallback;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
