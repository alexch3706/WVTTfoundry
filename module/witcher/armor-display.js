import { HUMANOID_LOCATIONS, MONSTER_LOCATIONS } from './config.js';
import { armorAt, stackArmor } from './rules.js';

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
  return locations.map((location, index) => {
    try {
      const worn = stackArmor(armorAt(state.items, location));
      const maximumWorn = stackArmor(armorAt(repaired, location));
      const totalSP = worn + (location.sp ?? 0) + inherent;
      const maximumSP = maximumWorn + (location.maxSp ?? 0) + inherent;
      return {
        ...location,
        index,
        totalSP,
        maximumSP,
        damaged: totalSP < maximumSP,
        totalWeakSP: worn + (location.weakSp ?? 0) + inherent,
        maximumWeakSP: maximumWorn + (location.weakMaxSp ?? 0) + inherent,
      };
    } catch {
      return { ...location, index, totalSP: '!', maximumSP: '!', totalWeakSP: '!', maximumWeakSP: '!' };
    }
  });
}
