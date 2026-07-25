export function resolveActorSheetLayout({ width, activeTab }) {
  const mode = width >= 1100 ? "wide" : "compact";
  const combatFocus = activeTab === "combat";

  return {
    mode,
    combatFocus,
    showContentPane: !combatFocus,
    showCombatPane: mode === "wide" || combatFocus
  };
}
