/** Core p.72: Greater Focus raises the spell's defensive DC, never its casting check. */
export function greaterFocusSnapshot(item, magic = {}) {
  const state = item?.system ?? item;
  if (!state?.properties?.greaterFocus) return null;
  // Imported relics preserve these qualifiers verbatim in their source effect text
  // (Core pp.257–263). Unknown qualifiers must not become unrestricted bonuses.
  const qualifier = /Greater\s+Focus\s*\(([^)]+)\)/i.exec(state.effectText ?? '')?.[1];
  const elements = qualifier
    ? qualifier
        .toLowerCase()
        .replace(/\bmagic\b/g, '')
        .split(/\s*(?:&|,|and)\s*/)
        .map((part) => part.trim())
    : [];
  const matches = !elements.length || elements.includes(magic.element);
  return {
    itemId: item.id ?? item._id ?? '',
    itemUuid: item.uuid ?? '',
    name: item.name ?? state.name ?? 'Greater Focus',
    elements,
    element: magic.element ?? 'unspecified',
    defenseBonus: matches ? 2 : 0,
  };
}

/** Read only the authoritative cast snapshot; inventory changes cannot rewrite past DCs. */
export const magicDefenseBonus = (data) =>
  (data?.focus?.defenseBonus === 2 ? 2 : 0) + Math.max(0, Number(data?.focus?.glyphDC) || 0);
export function magicDefenseTotal(data, castingTotal = data?.check?.total ?? data?.castingTotal ?? 0) {
  return Number(castingTotal) + magicDefenseBonus(data);
}
