import { SYSTEM_ID } from './config.js';
import { RuleError, beats } from './rules.js';
import { registerCommand, authorizedActor, runCommand } from './authority.js';
import {
  owner,
  prompt,
  input,
  check,
  checkHTML,
  chat,
  escapeHTML as e,
  commitActor,
  actionPlan,
} from './runtime.js';
import { allocateMaterials } from './crafting.js';
import { resolveFoundryUuid } from '../foundry-compat.js';
import { enhancementIdentity, wordDefinition } from './enhancement-catalog.js';
import {
  enhancementState,
  validateAttachmentTarget,
  installStonePlan,
  physicalSetPlan,
  removePhysicalPlan,
  makeAttachment,
  rebuildEnhancementUpdate,
  wordCraftPlan,
  validateExtraSlot,
  extraSlotUpdate,
  masterCraftUpdate,
  PHYSICAL_SECTIONS,
} from './enhancements.js';

const now = () => Number(game.time.worldTime);
const key = `flags.${SYSTEM_ID}.enhancementWork`;
const clone = (value) => foundry.utils.deepClone(value);
const normalize = (name) =>
  String(name ?? '')
    .toLowerCase()
    .replace(/[’']/g, '')
    .replace(/[^a-z0-9]/g, '');
export function registerEnhancementSettings() {
  game.settings.register(SYSTEM_ID, 'duplicatePassiveGlyphs', {
    name: 'Duplicate Binding and Mending glyphs',
    hint: 'Table convention: Tome110 does not specify whether identical Binding/Mending glyphs stack. Strongest applies the best single bonus; Additive sums distinct stones. Identical runewords/glyphwords never stack (Tome111).',
    scope: 'world',
    config: true,
    type: String,
    default: 'strongest',
    choices: { strongest: 'Strongest matching glyph', additive: 'Add every matching glyph' },
  });
}
const held = (item) => item?.system.carried !== false && Number(item?.system.quantity) > 0;
const tool = (actor, name) =>
  actor.items.some((item) => held(item) && normalize(item.name) === normalize(name));
const requireTool = (actor, name) => {
  if (!tool(actor, name)) throw new RuleError(`Carry ${name} before beginning or completing this procedure.`);
};
const itemFor = (actor, id) => {
  const item = actor.items.get(id);
  if (!item) throw new RuleError('The equipment or source item no longer belongs to this actor.');
  return item;
};
function modifier(value = 0) {
  const result = Number(value);
  if (!Number.isFinite(result) || Math.abs(result) > 100) throw new RuleError('Invalid crafting modifier.');
  return result;
}
function masterRank(actor) {
  return Number(
    actor.system.professionRanks?.masterCrafting ??
      actor.system.customSkills?.find((skill) => normalize(skill.name) === 'mastercrafting')?.rank ??
      0
  );
}
function craftBase(actor, extra = 0, ability = 'crafting') {
  return actor.skillBase(ability, { stat: 'cra', modifier: extra }).total;
}
function noCombat() {
  if (game.combat?.started)
    throw new RuleError('Finish combat before starting or completing this lengthy procedure.');
}
function stock(actor) {
  return [...actor.items].map((item) => ({
    id: item.id,
    name: item.name,
    ...(item.system.toObject?.() ?? item.system),
    sourceUuid: item._stats?.compendiumSource ?? item.flags?.core?.sourceId,
  }));
}
function raw(item) {
  return {
    name: item.name,
    type: item.type,
    img: item.img,
    system: clone(item.system.toObject?.() ?? item.system),
    flags: clone(item.flags ?? {}),
  };
}
function partialItem(source, portion) {
  const result = raw(source);
  result.system.quantity = 1;
  result.system.weight = portion.weight;
  result.system.cost = 0;
  result.system.notes = `${result.system.notes ?? ''} Partial enhancement: ${portion.sections.join(', ')}. The source gives no partial resale price.`;
  result.flags[SYSTEM_ID] ??= {};
  Object.assign(result.flags[SYSTEM_ID], { enhancementParts: portion, priceUnspecified: true });
  return result;
}
async function transaction(actor, changes, updates, created, receipt) {
  const prepared = created.map((item) => ({ ...item, _id: foundry.utils.randomID() }));
  try {
    return await commitActor(actor, changes, updates, async () => {
      if (prepared.length) await actor.createEmbeddedDocuments('Item', prepared, { keepId: true });
      return receipt();
    });
  } catch (error) {
    const createdIds = prepared.map((item) => item._id).filter((id) => actor.items.has(id));
    if (createdIds.length) await actor.deleteEmbeddedDocuments('Item', createdIds);
    throw error;
  }
}
function sourceRecipe(actor, payload, procedure) {
  const diagram = itemFor(actor, payload.sourceId);
  if (
    !held(diagram) ||
    diagram.type !== 'diagram' ||
    diagram.flags?.[SYSTEM_ID]?.enhancementProcedure !== procedure
  )
    throw new RuleError('Carry the actual enhancement diagram for this procedure.');
  if (procedure === 'word' && !wordDefinition(diagram.flags[SYSTEM_ID].enhancement?.key))
    throw new RuleError('Unknown word diagram.');
  return diagram;
}
function validateTimed(actor, payload) {
  const target = itemFor(actor, payload.targetId);
  if (!held(target)) throw new RuleError('Carry the target equipment throughout this procedure.');
  noCombat();
  if (payload.procedure === 'inscribe') {
    requireTool(actor, 'Runewright’s Tools');
    const source = itemFor(actor, payload.sourceId);
    installStonePlan(target, source, {
      id: 'preflight',
      mode: 'runewright',
      stoneWeight: payload.stoneWeight,
    });
    return { target, source, seconds: 1800 };
  }
  if (payload.procedure === 'word') {
    requireTool(actor, 'Runewright’s Tools');
    const diagram = sourceRecipe(actor, payload, 'word'),
      wordKey = diagram.flags[SYSTEM_ID].enhancement.key;
    const plan = wordCraftPlan(target, wordKey, [...actor.items]);
    if (plan.word.slots === 3 && masterRank(actor) < 1)
      throw new RuleError('Master-grade enchantments require the Master Crafting ability.');
    if (payload.componentBenefits !== 'replace' || payload.failurePriorStones !== 'destroy')
      throw new RuleError(
        'Record the table conventions: the word replaces component benefits; a failed etching destroys prior stones, except the one successfully recovered.'
      );
    if (!plan.word.components.includes(payload.recoverKey))
      throw new RuleError('Choose one required stone to recover if the attempt fails.');
    return { target, diagram, plan, seconds: 3600 };
  }
  if (payload.procedure === 'slot') {
    requireTool(actor, 'Crafting Tools');
    sourceRecipe(actor, payload, 'slot');
    validateExtraSlot(target);
    if (masterRank(actor) < 1)
      throw new RuleError('The Master-grade slot diagram requires the Master Crafting ability.');
    const used = allocateMaterials(
      [
        { name: 'Meteorite', quantity: 4 },
        { name: 'Infused Dust', quantity: 2 },
      ],
      stock(actor)
    );
    return { target, used, seconds: 14400 };
  }
  throw new RuleError('Unknown timed enhancement procedure.');
}

async function startWork(actor, payload) {
  if (actor.flags?.[SYSTEM_ID]?.enhancementWork)
    throw new RuleError('Complete or cancel the existing enhancement work first.');
  const valid = validateTimed(actor, payload);
  const work = {
    id: foundry.utils.randomID(),
    procedure: payload.procedure,
    sourceId: payload.sourceId,
    targetId: payload.targetId,
    modifier: modifier(payload.modifier),
    stoneWeight: payload.stoneWeight,
    recoverKey: payload.recoverKey,
    componentBenefits: payload.componentBenefits,
    failurePriorStones: payload.failurePriorStones,
    startedAt: now(),
    finishesAt: now() + valid.seconds,
  };
  return commitActor(actor, { [key]: work }, [], () =>
    chat(
      actor,
      'Enhancement work started',
      `<p>${e(valid.target.name)}: ${valid.seconds / 60} minutes. Complete after world time ${work.finishesAt}; tools, materials and equipment are checked again at completion.</p><button data-witcher-enhancement-finish data-actor="${e(actor.uuid)}">Complete enhancement work</button>`,
      { flags: { kind: 'enhancementWork', actorUuid: actor.uuid, workId: work.id } }
    )
  );
}

async function finishWork(actor, payload) {
  const work = actor.flags?.[SYSTEM_ID]?.enhancementWork;
  if (!work || work.id !== payload.workId)
    throw new RuleError('This enhancement work has already completed, was canceled, or was replaced.');
  if (now() < work.finishesAt)
    throw new RuleError(`The work needs ${Math.ceil(work.finishesAt - now())} more seconds of world time.`);
  const valid = validateTimed(actor, work),
    changes = { [key]: null },
    rolls = [];
  let updates = [],
    created = [],
    text;
  if (work.procedure === 'inscribe') {
    const plan = installStonePlan(valid.target, valid.source, {
      id: foundry.utils.randomID(),
      mode: 'runewright',
      stoneWeight: work.stoneWeight,
      now: now(),
    });
    updates = [plan.update, plan.sourceUpdate];
    text = `${valid.source.name} inscribed into ${valid.target.name} with Runewright’s Tools after 30 minutes. No extra Crafting check is printed.`;
  } else {
    const dc = work.procedure === 'slot' ? 25 : valid.plan.word.slots === 2 ? 15 : 21;
    const result = await check(craftBase(actor, work.modifier), { actor, manualDice: payload.manualDice });
    rolls.push(...result.rolls);
    const success = beats(result.total, dc);
    text = `${checkHTML(result)}<p>Crafting DC${dc}: ${success ? 'success' : 'failure'}.</p>`;
    if (work.procedure === 'slot') {
      updates = valid.used.map((entry) => ({ _id: entry.id, 'system.quantity': entry.after }));
      if (success) updates.push(extraSlotUpdate(valid.target));
      if (!success) {
        const recovery = await check(craftBase(actor, work.modifier), {
          actor,
          manualDice: payload.recoveryDice,
        });
        rolls.push(...recovery.rolls);
        text += `<p>Ordinary material recovery, DC25:</p>${checkHTML(recovery)}`;
        if (beats(recovery.total, 25))
          for (const entry of valid.used)
            updates.find((update) => update._id === entry.id)['system.quantity'] += Math.ceil(
              entry.quantity / 2
            );
      }
      text += success
        ? '<p>One rune/glyph-only slot added.</p>'
        : '<p>No slot added; successful recovery returns half of each material, rounded up.</p>';
    } else {
      const { plan, target } = valid;
      const kept = clone(plan.retained);
      let recovered = null;
      if (success) {
        const wordItem = {
          name: `${plan.word.category}: ${plan.word.key}`,
          type: 'enhancement',
          system: { category: plan.word.category },
          flags: { [SYSTEM_ID]: { enhancement: { key: plan.word.key, category: plan.word.category } } },
        };
        const attachment = makeAttachment(wordItem, { id: foundry.utils.randomID(), now: now() });
        attachment.componentBenefits = work.componentBenefits;
        attachment.failurePriorStones = work.failurePriorStones;
        kept.push(attachment);
      } else {
        const recovery = await check(craftBase(actor, work.modifier), {
          actor,
          manualDice: payload.recoveryDice,
        });
        rolls.push(...recovery.rolls);
        text += `<p>Immediate one-stone recovery, DC${dc}:</p>${checkHTML(recovery)}`;
        if (beats(recovery.total, dc)) {
          recovered = work.recoverKey;
          const installed = plan.installed.find((entry) => entry.key === recovered);
          if (installed) {
            const returned = {
              ...clone(installed.source),
              system: { ...clone(installed.system), quantity: 1, carried: true, equipped: false },
            };
            created.push(returned);
          }
          text += `<p>Recovered one ${e(recovered)}. Every other rune/glyph involved is lost.</p>`;
        } else text += '<p>Recovery failed; all involved runes/glyphs were lost.</p>';
      }
      updates = plan.loose
        .filter((item) => enhancementIdentity(item).key !== recovered)
        .map((item) => ({ _id: item.id, 'system.quantity': item.system.quantity - 1 }));
      updates.push(rebuildEnhancementUpdate(target, kept));
      text +=
        '<p>Table conventions: individual component benefits are replaced by the word; etching failure destroys prior stones except one successfully recovered.</p>';
    }
  }
  return transaction(actor, changes, updates, created, () =>
    chat(actor, 'Enhancement work completed', text.startsWith('<') ? text : `<p>${e(text)}</p>`, { rolls })
  );
}

async function installPhysical(actor, payload) {
  requireTool(actor, 'Crafting Tools');
  const source = itemFor(actor, payload.sourceId),
    ids = payload.targetIds;
  if (!Array.isArray(ids) || new Set(ids).size !== ids.length)
    throw new RuleError('Choose distinct armor pieces.');
  const plan = physicalSetPlan(
    source,
    ids.map((id) => itemFor(actor, id)),
    { id: foundry.utils.randomID(), weights: payload.weights, now: now() }
  );
  const action = actionPlan(actor, { full: true });
  const result = await check(craftBase(actor, modifier(payload.modifier) + action.modifier), {
    actor,
    manualDice: payload.manualDice,
  });
  const success = beats(result.total, 14);
  const updates = success ? [...plan.updates, plan.sourceUpdate] : [];
  const created = success && plan.remaining ? [partialItem(source, plan.remaining)] : [];
  return transaction(actor, action.changes, updates, created, () =>
    chat(
      actor,
      'Armor enhancement',
      `${checkHTML(result)}<p>Crafting DC14: ${success ? 'installed; unused body portions remain in inventory' : 'failed; enhancement retained'}.</p><p>Weight allocation follows the recorded per-piece table convention.</p>`,
      { rolls: result.rolls }
    )
  );
}

async function removePhysical(actor, payload) {
  requireTool(actor, 'Crafting Tools');
  const target = itemFor(actor, payload.targetId),
    plan = removePhysicalPlan(target, payload.attachmentId);
  const result = await check(craftBase(actor, modifier(payload.modifier)), {
    actor,
    manualDice: payload.manualDice,
  });
  const success = beats(result.total, 15);
  return transaction(actor, {}, success ? [plan.update] : [], success ? [plan.returned] : [], () =>
    chat(
      actor,
      'Remove armor enhancement',
      `${checkHTML(result)}<p>Crafting DC15: ${success ? 'parts returned to inventory' : 'attachment remains'}.</p>`,
      { rolls: result.rolls }
    )
  );
}

async function masterCraft(actor, payload, user) {
  if (masterRank(actor) < 1) throw new RuleError('Master Crafting requires ranks in that ability.');
  const target = itemFor(actor, payload.targetId);
  if (!held(target)) throw new RuleError('Carry the equipment before improving it.');
  const sourceUuid = target._stats?.compendiumSource ?? target.flags?.core?.sourceId;
  let dc;
  if (payload.customDC !== undefined) {
    if (!user.isGM) throw new RuleError('Only the GM can record a custom item’s verified crafting DC.');
    dc = Number(payload.customDC);
  } else {
    const diagram = payload.sourceId
      ? itemFor(actor, payload.sourceId)
      : await resolveFoundryUuid(payload.diagramUuid);
    if (diagram?.type !== 'diagram' || !sourceUuid || diagram.system.productUuid !== sourceUuid)
      throw new RuleError(
        'Use a reference diagram linked to the equipment’s original compendium source. Custom equipment needs a GM-verified DC.'
      );
    // Core63 does not require physically owning or carrying the diagram.
    dc = Number(diagram.system.craftDC);
  }
  if (!Number.isFinite(dc) || dc <= 0) throw new RuleError('The actual equipment crafting DC is required.');
  const update = masterCraftUpdate(target, payload.choice, { id: foundry.utils.randomID(), now: now() });
  const result = await check(craftBase(actor, modifier(payload.modifier), 'masterCrafting'), {
    actor,
    manualDice: payload.manualDice,
  });
  const success = beats(result.total, dc);
  return commitActor(actor, {}, success ? [update] : [], () =>
    chat(
      actor,
      'Master Crafting',
      `${checkHTML(result)}<p>DC${dc}: ${success ? e(payload.choice) + ' permanently applied' : 'no improvement'}.</p>`,
      { rolls: result.rolls }
    )
  );
}

/** Source owner is checked again by the elected GM at every mutation. */
export function registerEnhancements() {
  registerCommand('enhancement', async (payload, { user }) => {
    const actor = await authorizedActor(payload.actorUuid, user);
    if (payload.op === 'start') return startWork(actor, payload);
    if (payload.op === 'finish') return finishWork(actor, payload);
    if (payload.op === 'cancel') {
      const work = actor.flags?.[SYSTEM_ID]?.enhancementWork;
      if (!work || work.id !== payload.workId)
        throw new RuleError('The enhancement work is no longer pending.');
      return commitActor(actor, { [key]: null }, [], () =>
        chat(
          actor,
          'Enhancement work canceled',
          '<p>No components were consumed; elapsed time is not restored.</p>'
        )
      );
    }
    if (payload.op === 'physical') return installPhysical(actor, payload);
    if (payload.op === 'remove') return removePhysical(actor, payload);
    if (payload.op === 'mastercraft') return masterCraft(actor, payload, user);
    if (payload.op === 'reconcile') {
      if (!user.isGM) throw new RuleError('Only the GM may reconcile erased legacy enhancement provenance.');
      const target = itemFor(actor, payload.targetId),
        state = payload.state;
      if (target.flags?.[SYSTEM_ID]?.enhancementState?.version === 1)
        throw new RuleError('This equipment already has tracked enhancement provenance.');
      if (
        !state?.base ||
        state.version !== 1 ||
        !Number.isInteger(state.nativeSlots) ||
        !Number.isInteger(state.addedSlots) ||
        state.nativeSlots < 0 ||
        state.addedSlots < 0 ||
        state.nativeSlots + state.addedSlots !== target.system.enhancements
      )
        throw new RuleError('Supply a base snapshot and exact native/added slot counts.');
      for (const field of ['weight', 'stoppingPower', 'maxReliability', 'ev'])
        if (!Number.isFinite(state.base[field]) || state.base[field] < 0)
          throw new RuleError(`Invalid base ${field}.`);
      if (
        !Array.isArray(state.base.resistances) ||
        !Array.isArray(state.base.skillBonuses) ||
        typeof state.base.properties !== 'object'
      )
        throw new RuleError('Supply original base properties, resistances and skill bonuses.');
      const attachments = target.system.attachments.map((old, index) => {
        const category = old.category === 'armor' ? 'physical' : old.category;
        const original = {
          type: 'enhancement',
          name: old.name,
          img: 'icons/svg/upgrade.svg',
          system: { ...old.system, category: old.category },
          flags: {},
        };
        const identity = enhancementIdentity(original);
        if (!identity)
          throw new RuleError(
            `Cannot identify legacy attachment ${old.name}. Reconcile this custom source manually first.`
          );
        const weight = Number(payload.weights?.[index]);
        if (!Number.isFinite(weight) || weight < 0)
          throw new RuleError('Record each legacy attachment’s actual contributed weight.');
        return {
          ...makeAttachment(original, {
            id: foundry.utils.randomID(),
            weight,
            parts: category === 'physical' ? target.system.coverage : undefined,
          }),
          category,
        };
      });
      const update = rebuildEnhancementUpdate(target, attachments, state);
      return commitActor(actor, {}, [update], () =>
        chat(
          actor,
          'Legacy enhancements reconciled',
          '<p>The GM supplied original base stats and attachment weight. Future changes retain each source separately.</p>'
        )
      );
    }
    if (payload.op === 'inscribe') {
      requireTool(actor, 'Crafting Tools');
      const source = itemFor(actor, payload.sourceId),
        target = itemFor(actor, payload.targetId);
      if (!held(target)) throw new RuleError('Carry the target equipment.');
      const plan = installStonePlan(target, source, {
        id: foundry.utils.randomID(),
        mode: 'ordinary',
        stoneWeight: payload.stoneWeight,
        now: now(),
      });
      return commitActor(actor, {}, [plan.update, plan.sourceUpdate], () =>
        chat(
          actor,
          'Stone inscribed',
          `<p>${e(source.name)} → ${e(target.name)}. Permanent ordinary inscription; the Core provides no roll or duration. Stone weight convention: ${e(payload.stoneWeight)}.</p>`
        )
      );
    }
    throw new RuleError('Unknown enhancement procedure.');
  });
  Hooks.on('renderChatMessageHTML', (message, html) => {
    const button = html.querySelector('[data-witcher-enhancement-finish]');
    if (!button) return;
    const data = message.flags?.[SYSTEM_ID];
    button.addEventListener('click', () =>
      runCommand('enhancement', { actorUuid: data.actorUuid, op: 'finish', workId: data.workId }).catch(
        (error) => ui.notifications.error(error.message)
      )
    );
  });
}

export async function finishEnhancementWork(actor, { cancel = false } = {}) {
  owner(actor);
  const work = actor.flags?.[SYSTEM_ID]?.enhancementWork;
  if (!work) throw new RuleError('No enhancement work is pending.');
  return runCommand('enhancement', {
    actorUuid: actor.uuid,
    op: cancel ? 'cancel' : 'finish',
    workId: work.id,
  });
}

export async function enhancementAction(actor, source) {
  owner(actor);
  const identity = enhancementIdentity(source),
    procedure = source.flags?.[SYSTEM_ID]?.enhancementProcedure;
  if (!identity && !procedure) throw new RuleError('This item has no supported enhancement procedure.');
  const isWord = procedure === 'word',
    isSlot = procedure === 'slot';
  if (['runeword', 'glyphword'].includes(identity?.category))
    throw new RuleError(
      'Use the enchantment’s diagram and component stones to etch this word onto equipment.'
    );
  const word = isWord ? wordDefinition(source.flags[SYSTEM_ID].enhancement.key) : null;
  const eligible = [...actor.items].filter((item) => {
    try {
      if (!held(item)) return false;
      if (isSlot) validateExtraSlot(item);
      else validateAttachmentTarget(item, word ?? identity, { replacingStones: isWord });
      return true;
    } catch {
      return false;
    }
  });
  if (!eligible.length)
    throw new RuleError(
      'No carried equipment has the required type, slots and reconciled enhancement provenance.'
    );
  if (identity?.category === 'physical') {
    const available = source.flags?.[SYSTEM_ID]?.enhancementParts?.sections ?? PHYSICAL_SECTIONS;
    const totalWeight = source.flags?.[SYSTEM_ID]?.enhancementParts?.weight ?? source.system.weight;
    const values = await prompt(
      'Install armor enhancement set',
      '<p>Choose armor sections to enhance. Unused sections stay in inventory. The book gives a total set weight but no per-piece distribution; review and record the allocation below (default: equal weight per body section).</p>' +
        eligible
          .map(
            (item) =>
              input(`target_${item.id}`, item.name, { type: 'checkbox', checked: item.system.equipped }) +
              input(`weight_${item.id}`, 'Allocated set weight', {
                value: (totalWeight * item.system.coverage.length) / available.length,
                min: 0,
                step: 'any',
              })
          )
          .join('') +
        input('modifier', 'Crafting modifier', { value: 0 })
    );
    if (!values) return;
    const targets = eligible.filter((item) => values[`target_${item.id}`]);
    return runCommand('enhancement', {
      actorUuid: actor.uuid,
      op: 'physical',
      sourceId: source.id,
      targetIds: targets.map((item) => item.id),
      weights: Object.fromEntries(targets.map((item) => [item.id, Number(values[`weight_${item.id}`])])),
      modifier: values.modifier,
    });
  }
  let html = input('targetId', 'Equipment', {
    options: Object.fromEntries(eligible.map((item) => [item.id, item.name])),
  });
  if (!procedure)
    html +=
      input('method', 'Inscription method', {
        options: { ordinary: 'Ordinary Crafting Tools', runewright: 'Runewright’s Tools — 30 minutes' },
      }) +
      input('stoneWeight', 'Table convention: stone weight after etching', {
        options: {
          consumed: 'Stone consumed; do not add weight',
          retained: 'Retain stone weight on equipment',
        },
      });
  else
    html +=
      input('modifier', 'Crafting modifier', { value: 0 }) +
      `<p>Work takes ${isSlot ? '4 hours' : '1 hour'} of world time before completion.</p>`;
  if (isWord)
    html +=
      '<p>Recorded table conventions: the word replaces component benefits; failed etching destroys prior stones except one recovered by the immediate retry.</p>' +
      input('recoverKey', 'Stone to recover if etching fails', {
        options: Object.fromEntries(word.components.map((key) => [key, key])),
      });
  const values = await prompt('Enhance equipment', html, { button: 'Begin' });
  if (!values) return;
  return runCommand('enhancement', {
    actorUuid: actor.uuid,
    sourceId: source.id,
    targetId: values.targetId,
    op: procedure || values.method === 'runewright' ? 'start' : 'inscribe',
    procedure: procedure ?? 'inscribe',
    stoneWeight: values.stoneWeight,
    modifier: values.modifier ?? 0,
    recoverKey: values.recoverKey,
    componentBenefits: 'replace',
    failurePriorStones: 'destroy',
  });
}

export async function removeEnhancementAction(actor, item) {
  owner(actor);
  const eligible = item.system.attachments.filter(
    (entry) => entry.version === 1 && entry.category === 'physical'
  );
  if (!eligible.length) throw new RuleError('This item has no removable tracked physical enhancement.');
  const values = await prompt(
    'Remove armor enhancement',
    input('attachmentId', 'Attachment', {
      options: Object.fromEntries(eligible.map((entry) => [entry.id, entry.name])),
    }) + input('modifier', 'Crafting modifier', { value: 0 })
  );
  if (!values) return;
  return runCommand('enhancement', { actorUuid: actor.uuid, op: 'remove', targetId: item.id, ...values });
}

export async function masterCraftAction(actor, item) {
  owner(actor);
  const sourceUuid = item._stats?.compendiumSource ?? item.flags?.core?.sourceId;
  const diagrams = [...actor.items].filter(
    (entry) => entry.type === 'diagram' && sourceUuid && entry.system.productUuid === sourceUuid
  );
  const references = diagrams.map((entry) => ({ name: entry.name, uuid: entry.uuid }));
  if (sourceUuid)
    for (const pack of game.packs ?? []) {
      if (
        (pack.documentName ?? pack.metadata?.type) !== 'Item' ||
        !pack.collection?.startsWith(`${SYSTEM_ID}.`)
      )
        continue;
      if (pack.testUserPermission && !pack.testUserPermission(game.user, 'OBSERVER')) continue;
      const index = await pack.getIndex({ fields: ['type', 'system.productUuid'] });
      for (const entry of index)
        if (entry.type === 'diagram' && entry.system?.productUuid === sourceUuid)
          references.push({ name: entry.name, uuid: `Compendium.${pack.collection}.Item.${entry._id}` });
    }
  if (!references.length && !game.user.isGM)
    throw new RuleError(
      'No verified crafting DC reference was found. The GM can record the actual DC for custom equipment.'
    );
  const choices =
    item.type === 'armor'
      ? Object.fromEntries(
          ['slashing', 'piercing', 'bludgeoning', 'fire', 'elemental', 'bleeding'].map((value) => [
            value,
            value,
          ])
        )
      : Object.fromEntries([
          ...(item.system.damageTypes.some((type) => ['slashing', 'piercing'].includes(type))
            ? [['bleeding', 'Bleeding50%']]
            : []),
          ...(item.system.damageTypes.includes('bludgeoning') ? [['stun', 'Stun−2']] : []),
        ]);
  const values = await prompt(
    'Master Crafting',
    (references.length
      ? input('diagramUuid', 'Crafting DC reference (diagram ownership is not required)', {
          options: Object.fromEntries(references.map((entry) => [entry.uuid, entry.name])),
        })
      : input('customDC', 'GM: verified custom equipment Crafting DC', {
          min: 1,
          value: item.system.craftDC || '',
        })) +
      input('choice', 'Permanent improvement', { options: choices }) +
      input('modifier', 'Master Crafting modifier', { value: 0 })
  );
  if (!values) return;
  return runCommand('enhancement', {
    actorUuid: actor.uuid,
    op: 'mastercraft',
    targetId: item.id,
    ...values,
  });
}

export async function reconcileEnhancementsAction(actor, item) {
  owner(actor);
  if (!game.user.isGM) throw new RuleError('Only the GM may reconcile legacy provenance.');
  const s = item.system;
  const suggested = {
    version: 1,
    nativeSlots: s.enhancements,
    addedSlots: 0,
    base: {
      properties: clone(s.properties),
      resistances: [...s.resistances],
      skillBonuses: clone(s.skillBonuses),
      weight: s.weight,
      stoppingPower: s.stoppingPower,
      maxReliability: s.maxReliability,
      ev: s.ev,
    },
  };
  const values = await prompt(
    'Reconcile legacy enhancement base',
    '<p>Old installation overwrote base stats. The current combined stats below are only an editing starting point: replace them with verified original equipment stats, preserving custom/Master Crafting improvements as appropriate. Do not subtract guessed bonuses. Review each attachment’s contributed weight.</p>' +
      `<label>Verified base JSON<textarea name="state" rows="14">${e(JSON.stringify(suggested, null, 2))}</textarea></label>` +
      s.attachments
        .map((entry, index) =>
          input(`weight_${index}`, `${entry.name}: contributed weight`, {
            value: entry.system?.weight ?? 0,
            min: 0,
            step: 'any',
          })
        )
        .join('')
  );
  if (!values) return;
  let state;
  try {
    state = JSON.parse(values.state);
  } catch {
    throw new RuleError('The base snapshot must be valid JSON.');
  }
  return runCommand('enhancement', {
    actorUuid: actor.uuid,
    op: 'reconcile',
    targetId: item.id,
    state,
    weights: s.attachments.map((entry, index) => Number(values[`weight_${index}`])),
  });
}
