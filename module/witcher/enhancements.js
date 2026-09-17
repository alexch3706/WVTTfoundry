/** Source-aware enhancement plans; no document writes. Passive duplicate-glyph
 * policy can be passed explicitly; runtime defaults read the recorded world rule. */
import {
  ENHANCEMENT_SCOPE as S,
  enhancementIdentity,
  enhancementRule,
  wordDefinition,
} from './enhancement-catalog.js';

const clone = (value) => structuredClone(value);
const num = (value) => Number(value ?? 0);
const systemOf = (item) => item?.system ?? item ?? {};
const attachmentsOf = (item) => systemOf(item).attachments ?? [];
const fail = (message) => {
  throw new Error(message);
};
const idOf = (item) => item.id ?? item._id;
export const PHYSICAL_SECTIONS = ['head', 'torso', 'leftArm', 'rightArm', 'leftLeg', 'rightLeg'];
export function passiveGlyphStacking() {
  try {
    return globalThis.game?.settings?.get(S, 'duplicatePassiveGlyphs') === 'additive'
      ? 'additive'
      : 'strongest';
  } catch {
    return 'strongest';
  }
}
function passiveTotal(values, stacking) {
  if (!['strongest', 'additive'].includes(stacking))
    fail('Choose strongest or additive duplicate passive glyphs.');
  return stacking === 'additive' ? values.reduce((sum, value) => sum + value, 0) : Math.max(0, ...values);
}

export function enhancementState(item) {
  const state = item.flags?.[S]?.enhancementState;
  if (state?.version === 1) return clone(state);
  if (attachmentsOf(item).length)
    fail(
      'Legacy enhancement provenance is incomplete. A GM must reconcile the original base properties before changing these attachments.'
    );
  const s = systemOf(item);
  return {
    version: 1,
    nativeSlots: num(s.enhancements),
    addedSlots: 0,
    base: {
      properties: clone(s.properties ?? {}),
      resistances: [...(s.resistances ?? [])],
      skillBonuses: clone(s.skillBonuses ?? []),
      weight: num(s.weight),
      stoppingPower: num(s.stoppingPower),
      maxReliability: num(s.maxReliability ?? s.reliability),
      ev: num(s.ev),
    },
  };
}

export function attachmentRule(attachment) {
  if (attachment.version === 1 && attachment.category === 'mastercraft') return clone(attachment.rule);
  const identity =
    attachment.key && attachment.category
      ? { key: attachment.key, category: attachment.category }
      : enhancementIdentity({
          type: 'enhancement',
          name: attachment.name,
          system: { ...attachment.system, category: attachment.category },
        });
  if (!identity) return null;
  return enhancementRule(identity, {
    improved: attachment.mode === 'runewright',
    source: attachment.system ?? {},
  });
}

/** Legacy stones still inform consumers; mutations require reconciled base data. */
export function enhancementBenefits(item, { stacking = passiveGlyphStacking() } = {}) {
  const rules = attachmentsOf(item)
    .map((attachment) => ({ attachment, rule: attachmentRule(attachment) }))
    .filter((entry) => entry.rule);
  const words = [...new Set(rules.map(({ rule }) => rule.word).filter(Boolean))];
  return {
    words,
    chemobogThreshold: Math.min(7, ...rules.map(({ rule }) => rule.chemobogThreshold ?? 7)),
    adrenalineExtra: Math.max(0, ...rules.map(({ rule }) => rule.adrenalineExtra ?? 0)),
    adrenalineRetainOne: rules.some(({ rule }) => rule.adrenalineRetainOne),
    bleedingReduction: passiveTotal(
      rules.map(({ rule }) => rule.bleedingReduction ?? 0),
      stacking
    ),
    healingBonus: passiveTotal(
      rules.map(({ rule }) => rule.healingBonus ?? 0),
      stacking
    ),
    elementalResistance: rules.some(({ rule }) => rule.resistances.includes('elemental')),
    hp: Math.max(0, ...rules.map(({ rule }) => rule.hp ?? 0)),
    glyphs: rules
      .filter(({ rule }) => rule.elementalGlyph)
      .map(({ attachment, rule }) => ({
        ...rule.elementalGlyph,
        attachmentId: attachment.id,
        itemId: idOf(item),
        name: attachment.name,
      })),
  };
}

export function actorEnhancementBenefits(items, { stacking = passiveGlyphStacking() } = {}) {
  const carried = [...items].filter(
    (item) => systemOf(item).carried !== false && num(systemOf(item).quantity ?? 1) > 0
  );
  const worn = carried.filter((item) => item.type === 'armor' && systemOf(item).equipped);
  const benefits = worn.map((item) => enhancementBenefits(item, { stacking }));
  const words = [...new Set(benefits.flatMap((row) => row.words))];
  return {
    words,
    glyphs: benefits.flatMap((row) => row.glyphs),
    // Tome110 does not settle duplicate Binding/Mending stones; use the world's
    // explicit convention. Words still never stack (Tome111).
    passiveGlyphStacking: stacking,
    bleedingReduction: passiveTotal(
      benefits.map((row) => row.bleedingReduction),
      stacking
    ),
    healingBonus: passiveTotal(
      benefits.map((row) => row.healingBonus),
      stacking
    ),
    hp: words.includes('protection') ? 5 : 0,
    elementalResistance: benefits.some((row) => row.elementalResistance),
    rotation: words.includes('rotation'),
    retribution: words.includes('retribution'),
    placation: carried.some((item) => enhancementBenefits(item).words.includes('placation')),
  };
}

export function elementalGlyphBonus(
  items,
  element,
  choices = [],
  { damaging = false, stacking = 'one' } = {}
) {
  if (!['one', 'distinct', 'all'].includes(stacking))
    fail('Choose a recorded glyph-stacking table convention.');
  const available = actorEnhancementBenefits(items).glyphs.filter((glyph) => glyph.element === element);
  const used = new Set(),
    keys = new Set();
  let dc = 0,
    damageDice = 0;
  const sources = choices.map((choice) => {
    const key = `${choice.itemId}:${choice.attachmentId}`;
    if (used.has(key)) fail('The same glyph cannot be selected twice.');
    const glyph = available.find(
      (row) => row.itemId === choice.itemId && row.attachmentId === choice.attachmentId
    );
    if (!glyph) fail('The selected glyph is no longer worn or does not match the spell element.');
    if (!['dc', 'damage'].includes(choice.mode)) fail('Choose spell DC or spell damage for each glyph.');
    if (choice.mode === 'damage' && !damaging) fail('A glyph cannot add damage to a non-damaging spell.');
    if (stacking === 'one' && used.size) fail('The recorded table convention permits one glyph per casting.');
    if (stacking === 'distinct' && keys.has(glyph.element))
      fail('The recorded convention does not stack identical elemental glyphs.');
    used.add(key);
    keys.add(glyph.element);
    if (choice.mode === 'dc') dc += glyph.dc;
    else damageDice += glyph.damageDice;
    return { ...glyph, mode: choice.mode };
  });
  return { dc, damageDice, sources, stacking };
}

export function slotUsage(item, attachments = attachmentsOf(item), state = enhancementState(item)) {
  const physical = attachments.filter(
    (entry) => entry.category === 'physical' || entry.category === 'armor'
  ).length;
  const total = attachments.reduce(
    (sum, entry) => sum + (entry.category === 'mastercraft' ? 0 : num(entry.slots ?? 1)),
    0
  );
  return {
    total,
    physical,
    capacity: state.nativeSlots + state.addedSlots,
    nativeCapacity: state.nativeSlots,
    addedCapacity: state.addedSlots,
  };
}

export function validateAttachmentTarget(
  item,
  identity,
  { replacingStones = false, state = enhancementState(item) } = {}
) {
  const s = systemOf(item),
    word = wordDefinition(identity.key);
  const wordCategory = ['runeword', 'glyphword'].includes(identity.category);
  if (identity.category === 'rune' && item.type !== 'weapon') fail('Runes require a weapon.');
  if (['glyph', 'physical'].includes(identity.category) && item.type !== 'armor')
    fail('This enhancement requires armor.');
  if (wordCategory) {
    if (!word || word.category !== identity.category) fail('Unknown enchantment.');
    if (word.target === 'weapon' && item.type !== 'weapon') fail('This runeword requires a weapon.');
    if (word.target === 'weapon-or-shield' && !['weapon', 'shield'].includes(item.type))
      fail('Preservation requires a weapon or shield.');
    if (['armor', 'head', 'torso', 'legs'].includes(word.target) && item.type !== 'armor')
      fail('This glyphword requires armor.');
    if (word.target === 'head' && !s.coverage?.includes('head')) fail('Beguilement requires head armor.');
    if (word.target === 'torso' && !s.coverage?.includes('torso'))
      fail('This glyphword requires torso armor.');
    if (word.target === 'legs' && !s.coverage?.some((key) => ['leftLeg', 'rightLeg'].includes(key)))
      fail('Rotation requires leg armor.');
  }
  if (
    attachmentsOf(item).some((entry) => ['runeword', 'glyphword'].includes(entry.category)) &&
    identity.category !== 'physical'
  )
    fail('An enchanted item cannot receive another word, rune or glyph.');
  const retained = replacingStones
    ? attachmentsOf(item).filter((entry) => !['rune', 'glyph'].includes(entry.category))
    : attachmentsOf(item);
  const usage = slotUsage(item, retained, state),
    needed = wordCategory ? word.slots : 1;
  if (usage.total + needed > usage.capacity) fail('The equipment no longer has enough enhancement slots.');
  if (identity.category === 'physical' && usage.physical + 1 > usage.nativeCapacity)
    fail('Added slots can only hold runes or glyphs, not physical armor enhancements.');
  return { usage, needed };
}

function mergeProperties(base, addition) {
  const result = { ...base };
  for (const [key, value] of Object.entries(addition)) {
    if (typeof value === 'boolean') result[key] = !!result[key] || value;
    else if (typeof value === 'number')
      result[key] = key === 'stun' ? Math.min(num(result[key]), value) : Math.max(num(result[key]), value);
    else if (value && !result[key]) result[key] = value;
  }
  return result;
}

/** Recalculate real equipment fields but retain damage, never heal by toggling. */
export function rebuildEnhancementUpdate(item, attachments, state = enhancementState(item)) {
  const s = systemOf(item),
    base = state.base,
    rules = attachments.map(attachmentRule).filter(Boolean);
  let properties = clone(base.properties),
    resistances = new Set(base.resistances),
    skillBonuses = clone(base.skillBonuses);
  let sp = num(base.stoppingPower),
    rel = num(base.maxReliability),
    weight = num(base.weight),
    ev = num(base.ev);
  for (const rule of rules) {
    properties = mergeProperties(properties, rule.properties ?? {});
    for (const resistance of rule.resistances ?? []) resistances.add(resistance);
    skillBonuses.push(...(rule.skillBonuses ?? []));
    sp += num(rule.sp);
    rel += num(rule.reliability);
    ev = ev * num(rule.evMultiplier ?? 1) + num(rule.evAdd);
  }
  for (const attachment of attachments) weight += num(attachment.weight);
  const result = {
    _id: idOf(item),
    [`flags.${S}.enhancementState`]: clone(state),
    'system.attachments': clone(attachments),
    'system.properties': properties,
    'system.resistances': [...resistances],
    'system.skillBonuses': skillBonuses,
    'system.weight': weight,
    'system.ev': Math.max(0, ev),
    'system.enhancements': state.nativeSlots + state.addedSlots,
  };
  if (item.type === 'armor') {
    result['system.stoppingPower'] = sp;
    result['system.sp'] = { ...(s.sp ?? {}) };
    for (const location of s.coverage ?? []) {
      const damage = Math.max(0, num(s.stoppingPower) - num(s.sp?.[location] ?? s.stoppingPower));
      result['system.sp'][location] = Math.max(0, sp - damage);
    }
  }
  if (['weapon', 'shield'].includes(item.type)) {
    const wear = Math.max(0, num(s.maxReliability ?? s.reliability) - num(s.reliability));
    result['system.maxReliability'] = rel;
    result['system.reliability'] = Math.max(0, rel - wear);
  }
  return result;
}

export function makeAttachment(source, { id, mode = 'ordinary', weight = 0, parts, now = 0 } = {}) {
  const identity = enhancementIdentity(source);
  if (!identity) fail('This item has no recognized enhancement identity.');
  if (!['ordinary', 'runewright'].includes(mode)) fail('Unknown inscription method.');
  const s = systemOf(source);
  return {
    version: 1,
    id,
    key: identity.key,
    category: identity.category,
    name: source.name,
    mode,
    slots: wordDefinition(identity.key)?.slots ?? 1,
    weight,
    parts: parts ? [...parts] : undefined,
    installedAt: now,
    sourceItemId: idOf(source),
    sourceUuid: source.uuid ?? '',
    // Enough original data to return physical parts without inventing an item.
    system: clone(typeof s.toObject === 'function' ? s.toObject() : s),
    source: { name: source.name, type: source.type, img: source.img, flags: clone(source.flags ?? {}) },
  };
}

export function installStonePlan(target, source, options = {}) {
  const identity = enhancementIdentity(source);
  if (!identity || !['rune', 'glyph'].includes(identity.category)) fail('Choose a rune or glyph.');
  const s = systemOf(source);
  if (num(s.quantity) < 1 || s.carried === false) fail('A carried stone is required.');
  validateAttachmentTarget(target, identity);
  // Rune mass after etching is unprinted: explicit recorded convention required.
  if (!['consumed', 'retained'].includes(options.stoneWeight))
    fail('Choose whether etched stone weight remains; the source does not specify.');
  const attachment = makeAttachment(source, {
    ...options,
    weight: options.stoneWeight === 'retained' ? num(s.weight) : 0,
  });
  attachment.stoneWeightConvention = options.stoneWeight;
  return {
    update: rebuildEnhancementUpdate(target, [...attachmentsOf(target), attachment]),
    attachment,
    sourceUpdate: { _id: idOf(source), 'system.quantity': num(s.quantity) - 1 },
  };
}

export function validateExtraSlot(item) {
  const s = systemOf(item),
    state = enhancementState(item);
  if (!['weapon', 'armor'].includes(item.type)) fail('Extra slots require a weapon or armor.');
  if (state.nativeSlots + state.addedSlots >= 3) fail('Equipment cannot have more than three slots.');
  if (item.type === 'weapon' && num(s.reliability) !== num(s.maxReliability))
    fail('The weapon must be at full Reliability.');
  if (
    item.type === 'armor' &&
    (!s.coverage?.length ||
      s.coverage.some((location) => num(s.sp?.[location] ?? s.stoppingPower) !== num(s.stoppingPower)))
  )
    fail('Every covered location must be at full SP.');
  return state;
}

export function extraSlotUpdate(item) {
  const state = validateExtraSlot(item);
  state.addedSlots += 1;
  return rebuildEnhancementUpdate(item, attachmentsOf(item), state);
}

export function physicalSetPlan(source, targets, { id, weights, now = 0 } = {}) {
  const identity = enhancementIdentity(source),
    s = systemOf(source);
  if (identity?.category !== 'physical') fail('Choose an ordinary armor enhancement.');
  if (num(s.quantity) < 1 || s.carried === false) fail('A carried enhancement set is required.');
  if (!targets.length) fail('Choose at least one armor piece.');
  const portion = source.flags?.[S]?.enhancementParts;
  const available = portion?.sections ?? PHYSICAL_SECTIONS;
  const totalWeight = num(portion?.weight ?? s.weight);
  const used = new Set();
  let weight = 0;
  const updates = targets.map((target, index) => {
    validateAttachmentTarget(target, identity);
    if (systemOf(target).carried === false) fail('Carry armor before improving it.');
    const parts = systemOf(target).coverage ?? [];
    if (!parts.length || parts.some((part) => !available.includes(part) || used.has(part)))
      fail(
        'The set does not contain the required unused body sections; overlapping pieces need separate enhancement portions.'
      );
    const share = Number(weights?.[idOf(target)]);
    if (!Number.isFinite(share) || share < 0) fail('Record the set-weight allocation for every armor piece.');
    weight += share;
    parts.forEach((part) => used.add(part));
    const attachment = makeAttachment(source, { id: `${id}-${index}`, weight: share, parts, now });
    attachment.weightConvention = 'explicit-set-allocation';
    return rebuildEnhancementUpdate(target, [...attachmentsOf(target), attachment]);
  });
  const remaining = available.filter((part) => !used.has(part));
  if (weight > totalWeight + 1e-8 || (!remaining.length && Math.abs(weight - totalWeight) > 1e-8))
    fail('Allocated weights must conserve the enhancement set’s total weight.');
  return {
    updates,
    remaining: remaining.length ? { sections: remaining, weight: Math.max(0, totalWeight - weight) } : null,
    sourceUpdate: { _id: idOf(source), 'system.quantity': num(s.quantity) - 1 },
    weight,
  };
}

export function removePhysicalPlan(target, attachmentId) {
  const attachment = attachmentsOf(target).find((entry) => entry.id === attachmentId);
  if (!attachment || attachment.category !== 'physical' || attachment.version !== 1)
    fail('Only tracked physical enhancement parts can be removed; runes and glyphs are permanent.');
  const update = rebuildEnhancementUpdate(
    target,
    attachmentsOf(target).filter((entry) => entry.id !== attachmentId)
  );
  const returned = {
    ...clone(attachment.source),
    system: {
      ...clone(attachment.system),
      quantity: 1,
      weight: attachment.weight,
      carried: true,
      equipped: false,
    },
  };
  returned.flags ??= {};
  returned.flags[S] ??= {};
  returned.flags[S].enhancementParts = { sections: [...attachment.parts], weight: attachment.weight };
  return { update, returned, attachment };
}

export function wordCraftPlan(target, wordKey, looseItems) {
  const word = wordDefinition(wordKey);
  if (!word) fail('Unknown enchantment diagram.');
  validateAttachmentTarget(target, word, { replacingStones: true });
  const category = word.category === 'runeword' ? 'rune' : 'glyph';
  const installed = [],
    loose = [],
    used = new Set();
  for (const key of word.components) {
    const attachment = attachmentsOf(target).find(
      (entry) =>
        !used.has(entry.id) &&
        entry.category === category &&
        (entry.key ?? enhancementIdentity({ name: entry.name, system: entry.system })?.key) === key
    );
    if (attachment) {
      installed.push(attachment);
      used.add(attachment.id);
      continue;
    }
    const item = looseItems.find(
      (entry) =>
        enhancementIdentity(entry)?.key === key &&
        enhancementIdentity(entry)?.category === category &&
        num(systemOf(entry).quantity) > 0 &&
        systemOf(entry).carried !== false
    );
    if (!item) fail(`Missing required ${category}: ${key}.`);
    loose.push(item);
  }
  return {
    word,
    installed,
    loose,
    destroyed: attachmentsOf(target).filter(
      (entry) => ['rune', 'glyph'].includes(entry.category) && !used.has(entry.id)
    ),
    retained: attachmentsOf(target).filter((entry) => !['rune', 'glyph'].includes(entry.category)),
  };
}

export function masterCraftUpdate(item, choice, { id, now = 0 } = {}) {
  if (!['weapon', 'armor'].includes(item.type)) fail('Master Crafting improves a weapon or armor.');
  const rule = { properties: {}, resistances: [], skillBonuses: [] };
  if (item.type === 'armor') {
    if (!['slashing', 'piercing', 'bludgeoning', 'fire', 'elemental', 'bleeding'].includes(choice))
      fail('Choose the armor resistance.');
    if (systemOf(item).resistances?.includes(choice)) fail('The armor already has that resistance.');
    rule.resistances.push(choice);
  } else {
    const types = systemOf(item).damageTypes ?? [];
    if (choice === 'bleeding' && types.some((type) => ['slashing', 'piercing'].includes(type)))
      rule.properties.bleeding = 50;
    else if (choice === 'stun' && types.includes('bludgeoning'))
      Object.assign(rule.properties, { stunWeapon: true, stun: -2 });
    else fail('The chosen weapon improvement does not match its damage type.');
    if (
      (choice === 'bleeding' && num(systemOf(item).properties?.bleeding) >= 50) ||
      (choice === 'stun' && num(systemOf(item).properties?.stun) <= -2)
    )
      fail('The weapon already has this or a stronger improvement.');
  }
  const attachment = {
    version: 1,
    id,
    category: 'mastercraft',
    key: `mastercraft-${choice}`,
    name: `Master Crafting: ${choice}`,
    slots: 0,
    weight: 0,
    installedAt: now,
    rule,
  };
  return rebuildEnhancementUpdate(item, [...attachmentsOf(item), attachment]);
}
