import { HUMANOID_LOCATIONS, MONSTER_LOCATIONS } from './config.js';
import { armorAt, stackArmor, derivedStats } from './rules.js';
import { alchemyArmorBonus } from './alchemy-combat-rules.js';

/** Read the same per-location values as armorAt; a stored zero is broken armor. */
export function armorLocationRows(item, locations = []) {
  const system = item.system ?? item;
  if (item.type !== 'armor') return [];
  const labels = new Map(
    [...HUMANOID_LOCATIONS, ...MONSTER_LOCATIONS, ...locations].map((l) => [l.id, l.label])
  );
  return [...new Set(system.coverage ?? [])].map((id) => {
    const current = system.sp?.[id] ?? system.stoppingPower;
    return {
      id,
      label: labels.get(id) ?? id,
      current,
      maximum: system.stoppingPower,
      damaged: current < system.stoppingPower,
      broken: current === 0 && system.stoppingPower > 0,
    };
  });
}

/** Current protection and the same equipped layers after full repair. */
export function actorArmorRows(state, locations) {
  const repaired = state.items.map((item) => ({ ...item, sp: {} }));
  const inherent = state.race === 'dwarf' ? 2 : 0;
  const alchemySP = alchemyArmorBonus(state, derivedStats(state, state.items)).total;
  return locations.map((location, index) => {
    try {
      const worn = stackArmor(armorAt(state.items, location));
      const maximumWorn = stackArmor(armorAt(repaired, location));
      const totalSP = worn + (location.sp ?? 0) + inherent + alchemySP;
      const maximumSP = maximumWorn + (location.maxSp ?? 0) + inherent + alchemySP;
      return {
        ...location,
        index,
        totalSP,
        maximumSP,
        alchemySP,
        damaged: totalSP < maximumSP,
        totalWeakSP: worn + (location.weakSp ?? 0) + inherent + alchemySP,
        maximumWeakSP: maximumWorn + (location.weakMaxSp ?? 0) + inherent + alchemySP,
      };
    } catch {
      return { ...location, index, totalSP: '!', maximumSP: '!', totalWeakSP: '!', maximumWeakSP: '!' };
    }
  });
}
