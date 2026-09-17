import { actorEnhancementBenefits, elementalGlyphBonus, enhancementBenefits } from './enhancements.js';
import { SYSTEM_ID } from './config.js';

export function glyphFields(actor, magic, { input, escapeHTML }) {
  const glyphs = actorEnhancementBenefits(actor.items).glyphs.filter(
    (glyph) => glyph.element === magic.element
  );
  if (!glyphs.length) return '';
  return (
    '<fieldset><legend>Elemental glyphs</legend><p>Choose a bonus for this casting. The table convention for multiple glyphs is saved with the cast.</p>' +
    input('glyphStacking', 'Glyph stacking convention', {
      options: { one: 'One matching glyph', all: 'Stack matching glyphs' },
      value: 'one',
    }) +
    glyphs
      .map((glyph) =>
        input(
          `glyph_${glyph.itemId}_${glyph.attachmentId}`,
          `${glyph.name} (${actor.items.get(glyph.itemId)?.name ?? 'armor'})`,
          {
            options: {
              '': 'Do not use',
              dc: `+${glyph.dc} spell DC`,
              ...(magic.effect?.damageFormula ? { damage: `+${glyph.damageDice}d6 damage` } : {}),
            },
          }
        )
      )
      .join('') +
    '</fieldset>'
  );
}
export function readGlyphChoices(actor, values) {
  return actorEnhancementBenefits(actor.items).glyphs.flatMap((glyph) => {
    const mode = values[`glyph_${glyph.itemId}_${glyph.attachmentId}`];
    return mode ? [{ itemId: glyph.itemId, attachmentId: glyph.attachmentId, mode }] : [];
  });
}
export function castEnhancementSnapshot(actor, magic, focusItem, values) {
  const glyphs = elementalGlyphBonus(actor.items, magic.element, values.glyphs ?? [], {
    damaging: !!magic.effect?.damageFormula,
    stacking: values.glyphStacking || 'one',
  });
  const words =
    focusItem && ['spell', 'invocation'].includes(magic.kind) ? enhancementBenefits(focusItem).words : [];
  return {
    glyphs,
    glyphDC: glyphs.dc,
    glyphDamageDice: glyphs.damageDice,
    depletion: words.includes('depletion'),
    prolongation: words.includes('prolongation'),
    sourceFocusId: focusItem?.id ?? '',
  };
}

export async function depletionChanges(actor, data, row, changes) {
  const receipt = `depletion:${data.castId}:${actor.uuid}`;
  if (
    !data.focus?.depletion ||
    !row?.defense?.kind ||
    !Number.isFinite(row.defense.check?.total) ||
    row.defense.kind === 'accept' ||
    actor.system.traits?.infiniteStamina ||
    actor.system.combat.applied.includes(receipt)
  )
    return [];
  const { dice } = await import('./runtime.js');
  const roll = await dice('1d6');
  changes['system.sta.value'] = (changes['system.sta.value'] ?? actor.system.sta.value) - roll.total;
  changes['system.combat.applied'] = [
    ...(changes['system.combat.applied'] ?? actor.system.combat.applied),
    receipt,
  ];
  if (changes['system.sta.value'] <= 0)
    changes['system.conditions'] = [
      ...new Set([...(changes['system.conditions'] ?? actor.system.conditions), 'stunned', 'unconscious']),
    ];
  return [roll];
}
