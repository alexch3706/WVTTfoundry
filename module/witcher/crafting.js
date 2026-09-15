import { RuleError } from './rules.js';

export const materialKey = (name) =>
  String(name)
    .toLowerCase()
    .replace(/[’']/g, '')
    .replace(/[^a-z0-9]/g, '');
/** Allocate stock across recipe rows without reusing the same units twice. */
export function allocateMaterials(materials, items) {
  const remaining = new Map(items.map((i) => [i.id, i.quantity]));
  const used = new Map();
  for (const required of materials) {
    let needed = Number(required.quantity);
    if (!Number.isInteger(needed) || needed <= 0)
      throw new RuleError('Recipe component quantities must be positive integers.');
    const candidates = items.filter(
      (i) =>
        i.carried !== false &&
        (required.substance
          ? i.substance === required.substance
          : materialKey(i.name) === materialKey(required.name) ||
            (required.uuid && i.sourceUuid === required.uuid))
    );
    for (const item of candidates) {
      const amount = Math.min(needed, remaining.get(item.id));
      if (amount <= 0) continue;
      remaining.set(item.id, remaining.get(item.id) - amount);
      needed -= amount;
      const entry = used.get(item.id) ?? {
        id: item.id,
        name: item.name,
        substance: item.substance,
        quantity: 0,
        before: item.quantity,
      };
      entry.quantity += amount;
      used.set(item.id, entry);
      if (needed === 0) break;
    }
    if (needed) throw new RuleError(`Missing ${needed} unit(s) of ${required.name}.`);
  }
  return [...used.values()].map((i) => ({ ...i, after: i.before - i.quantity }));
}
export function craftingRecovery(used, { alchemy = false, success = false } = {}) {
  if (!success) return [];
  if (alchemy)
    return [...new Set(used.map((i) => i.substance).filter(Boolean))].map((name) => ({ name, quantity: 1 }));
  return used.map((i) => ({ id: i.id, quantity: Math.ceil(i.quantity / 2) }));
}
export function repairDifficulty(diagram, enhancements = 0) {
  return diagram.craftDC - 5 + enhancements * 2;
}
