/**
 * @module settings-helpers — Centralized settings access for combat resolver
 */

/**
 * Check if Corebook Fidelity Mode is enabled.
 * Gracefully falls back to `true` when game.settings is unavailable (e.g. test context).
 * @param {Object} [context] Optional combat context to check for overrides in tests.
 * @returns {boolean}
 */
export function isCorebookFidelityEnabled(context = {}) {
  // Check if context has options.corebookFidelityMode or action.options.corebookFidelityMode (used in tests)
  if (context?.options?.corebookFidelityMode !== undefined) {
    return !!context.options.corebookFidelityMode;
  }
  if (context?.action?.options?.corebookFidelityMode !== undefined) {
    return !!context.action.options.corebookFidelityMode;
  }
  try {
    if (typeof game?.settings?.get === "function") {
      return !!game.settings.get(game.system.id, "corebookFidelityMode");
    }
  } catch {
    // fall through to default
  }
  return true; // default for test/standalone contexts without game
}

/**
 * Filter fire mode choices based on current settings.
 * @param {string[]} rawFireModes - Raw fire mode values from __getFireModes()
 * @param {Object} [context] Optional combat context for overrides in tests
 * @returns {string[]} Filtered fire mode values
 */
export function filterSupportedFireModes(rawFireModes = [], context = {}) {
  if (!isCorebookFidelityEnabled(context)) {
    return [...rawFireModes]; // relaxed mode — show all
  }

  return rawFireModes.filter(mode => {
    const lower = String(mode).toLowerCase();
    // Only expose this mode when its caller can collect/place the corridor.
    if (lower === "suppressive") return context.suppressiveTemplateAvailable === true;
    return true;
  });
}

export function getAttackDieEntryMode(context = {}) {
  const override = context?.options?.attackDieEntryMode ?? context?.action?.options?.attackDieEntryMode;
  if (override === "prompt" || override === "auto") {
    return override;
  }
  try {
    if (typeof game?.settings?.get === "function") {
      const value = game.settings.get(game.system.id, "attackDieEntryMode");
      return value === "prompt" ? "prompt" : "auto";
    }
  } catch {
    // fall through to default
  }
  return "auto";
}
