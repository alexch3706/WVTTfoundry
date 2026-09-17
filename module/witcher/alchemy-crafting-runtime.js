/** Core pp.127,142. A recipe and actual current inventory are resolved on the GM.
 * Failed attempts have one recorded recovery opportunity, never a repeatable roll.
 */
import { SYSTEM_ID } from './config.js';
import { RuleError, beats } from './rules.js';
import { allocateMaterials, craftingRecovery, repairDifficulty, materialKey } from './crafting.js';
import { forgottenRecipe } from './magic-hex-runtime.js';
import { registerCommand, authorizedActor, runCommand } from './authority.js';
import { resolveFoundryUuid } from '../foundry-compat.js';
import {
  owner,
  prompt,
  input,
  manualCheckInput,
  validateManualCheck,
  check,
  checkHTML,
  chat,
  commitActor,
  actionPlan,
  turnIdentity,
  escapeHTML as e,
  errorNotice,
} from './runtime.js';

const clone = (value) => foundry.utils.deepClone(value);
const fingerprint = (diagram) => JSON.stringify(diagram.system.toObject?.() ?? diagram.system);
const carried = (item) => item.system.carried !== false && item.system.quantity >= 1;
const tool = (actor, name) => actor.items.some((item) => carried(item) && item.name === name);
const stock = (actor) =>
  actor.items.map((item) => ({
    id: item.id,
    name: item.name,
    type: item.type,
    flags: clone(item.flags ?? {}),
    ...item.system.toObject(),
    sourceUuid: item.system.sourceUuid || item._stats?.compendiumSource || item.flags?.core?.sourceId,
  }));
const PLANTS = new Set(
  [
    'Balisse Fruit',
    'Barley',
    'Crow’s Eye',
    'White Myrtle Petals',
    'Celandine',
    'Han Fiber',
    'Allspice Root',
    'Berbercane Fruit',
    'Ginatia Petals',
    'Hellebore Petals',
    'Arenaria',
    'Bryonia',
    'Ergot Seeds',
    'Fool’s Parsley Leaves',
    'Longrube',
    'Wolfsbane',
    'Blowball',
    'Buckthorn',
    'Honeysuckle',
    'Mandrake Root',
    'Verbena',
    'Beggartick Blossoms',
    'Pringrape',
  ].map(materialKey)
);
const botanical = (item) =>
  PLANTS.has(materialKey(item.name)) || item.flags?.[SYSTEM_ID]?.plantOrigin?.verified === true;
const combatStamp = (actor) => JSON.stringify(actor.system.combat);

function recipeAccess(actor, diagram, options, user) {
  if (diagram?.type !== 'diagram')
    throw new RuleError('Choose an actual crafting diagram or alchemy formula.');
  const owned = diagram.parent?.uuid === actor.uuid && actor.items.get(diagram.id) === diagram;
  if (options.written) {
    if (!(owned && carried(diagram)) && !(user.isGM && String(options.writtenEvidence ?? '').trim()))
      throw new RuleError(
        'The +2 written bonus requires a carried recipe item, or the GM’s recorded access to a physical recipe.'
      );
  } else if (!owned || !diagram.system.memorized || forgottenRecipe(actor.system, diagram.id))
    throw new RuleError('Without a written recipe, this actor must own and remember its memorized formula.');
}

async function resolveRecipe(actor, diagramUuid) {
  return actor.items.find((item) => item.uuid === diagramUuid) ?? (await resolveFoundryUuid(diagramUuid));
}

export async function executeCraft(
  { actorUuid, diagramUuid, repairItemId, expected, options = {} },
  { user, id, completedWork = false }
) {
  const actor = await authorizedActor(actorUuid, user),
    receipt = `craft:${id}`;
  if (actor.system.combat.applied.includes(receipt))
    return (
      game.messages.find((message) => message.flags?.[SYSTEM_ID]?.craftReceipt === receipt) ?? {
        receipt,
        alreadyApplied: true,
      }
    );
  const diagram = await resolveRecipe(actor, diagramUuid),
    d = diagram?.system;
  recipeAccess(actor, diagram, options, user);
  if (expected && fingerprint(diagram) !== expected)
    throw new RuleError('The recipe changed while its dialog was open. Reopen it.');
  if (game.combat?.started && !completedWork)
    throw new RuleError('Complete the recipe’s crafting time outside the active combat.');
  if (!options.time) throw new RuleError('Complete and record the printed crafting time first.');
  if (!Number.isFinite(options.modifier ?? 0)) throw new RuleError('Enter a finite crafting modifier.');
  const alchemy = d.skill === 'alchemy',
    requiredTool = alchemy ? 'Alchemy Set' : 'Crafting Tools';
  if (!tool(actor, requiredTool)) throw new RuleError(`A carried ${requiredTool} is required.`);
  const repairItem = repairItemId ? actor.items.get(repairItemId) : null;
  if (
    repairItemId &&
    (!repairItem ||
      !['weapon', 'armor', 'shield'].includes(repairItem.type) ||
      materialKey(d.productName) !== materialKey(repairItem.name))
  )
    throw new RuleError('The repair target must match this diagram and remain in the actor’s inventory.');
  const materials = repairItem ? d.materials.map((entry) => ({ ...entry, quantity: 1 })) : d.materials;
  if (!materials?.length) throw new RuleError('This recipe has no actual component requirements.');
  const inventory = stock(actor),
    used = allocateMaterials(materials, inventory);
  const metal =
    !alchemy && materials.some((entry) => /iron|steel|silver|gold|meteorite|dimeritium/i.test(entry.name));
  if (
    metal &&
    !tool(actor, 'Tinker’s Forge') &&
    !(user.isGM && options.forge && String(options.forgeEvidence ?? '').trim())
  )
    throw new RuleError('Metal crafting requires an actual forge or the GM’s recorded access to one.');
  const product = repairItem ? null : await resolveFoundryUuid(d.productUuid);
  if (!repairItem && (!product || !Number.isInteger(d.productQuantity) || d.productQuantity < 1))
    throw new RuleError('Resolve the actual product and a positive whole output quantity before crafting.');
  const plantOnly =
    alchemy && used.every((entry) => botanical(inventory.find((item) => item.id === entry.id)));
  const plantRuling = user.isGM && String(options.plantEvidence ?? '').trim();
  const context = {
    skill: d.skill,
    dc: repairItem
      ? repairDifficulty(
          d,
          (repairItem.system.attachments ?? []).filter((entry) => entry.category !== 'mastercraft').length
        )
      : d.craftDC,
    predicates: { plantOnlyElixirCraftingOrRecovery: alchemy && !!(plantOnly || plantRuling) },
  };
  const plan = completedWork ? { changes: {} } : actionPlan(actor, { actionKey: 'crafting' });
  validateManualCheck({ manualDice: options.manualDice }, actor, context);
  const result = await check(
    actor.skillBase(d.skill, { modifier: (options.written ? 2 : 0) + (options.modifier ?? 0), context })
      .total,
    { manualDice: options.manualDice, actor, context }
  );
  const success = beats(result.total, context.dc),
    updates = used.map((entry) => ({ _id: entry.id, 'system.quantity': entry.after }));
  if (success && repairItem) {
    updates.push(
      repairItem.type === 'armor'
        ? {
            _id: repairItem.id,
            'system.sp': Object.fromEntries(
              repairItem.system.coverage.map((location) => [location, repairItem.system.stoppingPower])
            ),
          }
        : { _id: repairItem.id, 'system.reliability': repairItem.system.maxReliability }
    );
  }
  const changes = { ...plan.changes, 'system.combat.applied': [...actor.system.combat.applied, receipt] };
  const projectedCombat = { ...clone(actor.system.combat) };
  for (const [key, value] of Object.entries(changes))
    if (key.startsWith('system.combat.')) projectedCombat[key.slice(14)] = clone(value);
  const recovery = {
    receipt,
    diagramUuid,
    skill: d.skill,
    dc: context.dc,
    alchemy,
    used,
    context,
    worldTime: game.time.worldTime,
    combatStamp: JSON.stringify(projectedCombat),
    status: success ? 'unavailable' : 'pending',
  };
  changes[`flags.${SYSTEM_ID}.craftRecovery`] = recovery;
  const created = [];
  return commitActor(actor, changes, updates, async () => {
    try {
      if (success && !repairItem) {
        const data = product.toObject();
        delete data._id;
        data.system.quantity = d.productQuantity;
        data.system.equipped = false;
        data.system.sourceUuid = product.uuid;
        created.push(...(await actor.createEmbeddedDocuments('Item', [data])));
        if (created.length !== 1) throw new RuleError('Creating the crafted product was cancelled.');
      }
      return await chat(
        actor,
        repairItem ? 'Repair' : 'Crafting',
        checkHTML(result) +
          `<p>${e(diagram.name)} · DC ${context.dc}: ${success ? 'completed.' : 'failed; allocated components consumed.'}</p>` +
          `${success ? '' : '<button data-crafting-recover>One immediate recovery attempt</button>'}` +
          `<p>${e(options.writtenEvidence ?? '')} ${e(options.forgeEvidence ?? '')} ${e(options.plantEvidence ?? '')}</p>`,
        {
          rolls: result.rolls,
          flags: { kind: 'craftingResult', craftReceipt: receipt, actorUuid: actor.uuid, recovery },
        }
      );
    } catch (error) {
      if (created.length)
        await actor.deleteEmbeddedDocuments(
          'Item',
          created.map((item) => item.id)
        );
      throw error;
    }
  });
}

/** Short formulas print a number of rounds. Each actual full-turn work action
 * advances one round; an elapsed-time checkbox cannot complete combat work. */
export async function executeCraftRound(payload, { user, id }) {
  const actor = await authorizedActor(payload.actorUuid, user),
    diagram = await resolveRecipe(actor, payload.diagramUuid),
    options = payload.options ?? {};
  recipeAccess(actor, diagram, options, user);
  if (!game.combat?.started) throw new RuleError('Use ordinary crafting outside combat.');
  const match = String(diagram.system.craftTime)
      .trim()
      .match(/^(\d+)\s*rounds?$/i),
    required = match ? Number(match[1]) : 0;
  if (!required)
    throw new RuleError(
      'This formula does not print a short duration in rounds. Complete its longer crafting time outside combat.'
    );
  if (payload.expected && fingerprint(diagram) !== payload.expected)
    throw new RuleError('The formula changed. Reopen the crafting action.');
  if (!tool(actor, diagram.system.skill === 'alchemy' ? 'Alchemy Set' : 'Crafting Tools'))
    throw new RuleError('Carry the actual crafting tool before spending a work round.');
  allocateMaterials(diagram.system.materials, stock(actor));
  const prior = actor.flags?.[SYSTEM_ID]?.craftWork,
    turn = turnIdentity();
  if (prior?.lastTurn === turn)
    throw new RuleError('One round of this formula requires a separate combat turn.');
  const continuing =
    prior?.diagramUuid === diagram.uuid &&
    prior?.expected === fingerprint(diagram) &&
    prior?.combatId === game.combat.id &&
    prior?.round === game.combat.round - 1;
  const rounds = (continuing ? prior.rounds : 0) + 1;
  const plan = actionPlan(actor, { actionKey: 'crafting', full: true });
  const work = {
    diagramUuid: diagram.uuid,
    expected: fingerprint(diagram),
    repairItemId: payload.repairItemId ?? '',
    rounds,
    required,
    lastTurn: turn,
    combatId: game.combat.id,
    round: game.combat.round,
  };
  const changes = { ...plan.changes, [`flags.${SYSTEM_ID}.craftWork`]: work };
  if (rounds < required)
    return commitActor(actor, changes, [], () =>
      chat(
        actor,
        'Crafting work',
        `<p>${e(diagram.name)}: ${rounds}/${required} consecutive work rounds. Components are rechecked each round and consumed when the attempt resolves.</p>`
      )
    );
  work.rounds = 0;
  work.completed = true;
  return commitActor(actor, changes, [], () =>
    executeCraft({ ...payload, options: { ...options, time: true } }, { user, id, completedWork: true })
  );
}

export async function executeCraftRecovery({ actorUuid, receipt, options = {} }, { user, id }) {
  const actor = await authorizedActor(actorUuid, user),
    recovery = actor.flags?.[SYSTEM_ID]?.craftRecovery;
  if (!recovery || recovery.receipt !== receipt || recovery.status !== 'pending')
    throw new RuleError('This crafting attempt has no unused recovery opportunity.');
  if (recovery.worldTime !== game.time.worldTime || recovery.combatStamp !== combatStamp(actor))
    throw new RuleError('Recovery must be attempted immediately, before time or another action advances.');
  const candidates = craftingRecovery(recovery.used, { alchemy: recovery.alchemy, success: true });
  if (
    recovery.alchemy &&
    (!candidates.length || !candidates.some((candidate) => candidate.name === options.substance))
  )
    throw new RuleError('Choose one of the actual substances used in this failed attempt.');
  if (!recovery.alchemy && candidates.some((entry) => !actor.items.get(entry.id)))
    throw new RuleError(
      'A consumed component stack was removed. Restore it before resolving this recorded recovery.'
    );
  validateManualCheck({ manualDice: options.manualDice }, actor, recovery.context);
  const result = await check(actor.skillBase(recovery.skill, { context: recovery.context }).total, {
    manualDice: options.manualDice,
    actor,
    context: recovery.context,
  });
  const success = beats(result.total, recovery.dc),
    updates =
      success && !recovery.alchemy
        ? candidates.map((entry) => ({
            _id: entry.id,
            'system.quantity': actor.items.get(entry.id).system.quantity + entry.quantity,
          }))
        : [];
  const created = [];
  return commitActor(
    actor,
    {
      [`flags.${SYSTEM_ID}.craftRecovery`]: {
        ...clone(recovery),
        status: 'used',
        recoveryReceipt: `craft-recovery:${id}`,
      },
    },
    updates,
    async () => {
      try {
        if (success && recovery.alchemy) {
          created.push(
            ...(await actor.createEmbeddedDocuments('Item', [
              {
                name: options.substance,
                type: 'component',
                system: {
                  substance: options.substance,
                  category: 'pureSubstance',
                  quantity: 1,
                  weight: 0.1,
                  carried: true,
                },
              },
            ]))
          );
          if (created.length !== 1)
            throw new RuleError('Creating the recovered pure substance was cancelled.');
        }
        return await chat(
          actor,
          'Crafting recovery',
          checkHTML(result) +
            `<p>DC ${recovery.dc}: ${success ? (recovery.alchemy ? `one pure ${e(options.substance)} recovered.` : 'half of each allocated material recovered (rounded up).') : 'no materials recovered.'} This recovery opportunity is now spent.</p>`,
          { rolls: result.rolls, flags: { craftReceipt: receipt, recoveryUsed: true } }
        );
      } catch (error) {
        if (created.length)
          await actor.deleteEmbeddedDocuments(
            'Item',
            created.map((item) => item.id)
          );
        throw error;
      }
    }
  );
}

export async function startCrafting(actor, diagram, { repairItem = null } = {}) {
  owner(actor);
  if (diagram?.type !== 'diagram') throw new RuleError('Choose a crafting diagram or alchemy formula.');
  const d = diagram.system,
    owned = diagram.parent?.uuid === actor.uuid;
  const materials = repairItem ? d.materials.map((entry) => ({ ...entry, quantity: 1 })) : d.materials;
  const used = allocateMaterials(materials, stock(actor));
  const options = await prompt(
    repairItem ? 'Repair equipment' : 'Craft',
    `<p>${e(diagram.name)} · ${e(d.craftTime)}</p><ul>${used.map((entry) => `<li>${e(entry.name)} × ${entry.quantity}</li>`).join('')}</ul>` +
      input('written', 'Use written recipe (+2)', { type: 'checkbox', checked: owned && carried(diagram) }) +
      (game.user.isGM
        ? input('writtenEvidence', 'GM: physical external recipe access (if not carried)', { type: 'text' }) +
          input('forge', 'GM: external forge available', { type: 'checkbox' }) +
          input('forgeEvidence', 'GM: external forge location', { type: 'text' }) +
          input('plantEvidence', 'GM: verified all ingredients are plants (Herbalism only)', { type: 'text' })
        : '') +
      input('time', 'Required crafting time has elapsed', { type: 'checkbox' }) +
      input('modifier', 'Other modifiers', { value: 0 }) +
      manualCheckInput(),
    { button: game.combat?.started ? 'Spend one crafting round' : 'Complete crafting' }
  );
  if (!options) return;
  return runCommand(
    game.combat?.started ? 'craftingRound' : 'craftingAttempt',
    {
      actorUuid: actor.uuid,
      diagramUuid: diagram.uuid,
      repairItemId: repairItem?.id,
      expected: fingerprint(diagram),
      options,
    },
    { label: `${actor.name}: ${diagram.name}` }
  );
}

export function registerCraftingRuntime() {
  registerCommand('craftingAttempt', executeCraft);
  registerCommand('craftingRound', executeCraftRound);
  registerCommand('craftingRecovery', executeCraftRecovery);
  Hooks.on('renderChatMessageHTML', (message, html) => {
    const button = html.querySelector('[data-crafting-recover]');
    if (!button) return;
    button.addEventListener('click', () =>
      (async () => {
        const data = message.flags?.[SYSTEM_ID],
          actor = await resolveFoundryUuid(data.actorUuid);
        owner(actor);
        const choices = craftingRecovery(data.recovery.used, {
          alchemy: data.recovery.alchemy,
          success: true,
        });
        const options = await prompt(
          'Recover crafting components',
          `<p>One immediate attempt against DC ${data.recovery.dc}. This does not receive the written formula’s +2 crafting bonus.</p>` +
            (data.recovery.alchemy
              ? input('substance', 'Recover one pure substance', {
                  options: Object.fromEntries(choices.map((entry) => [entry.name, entry.name])),
                })
              : '') +
            manualCheckInput(),
          { button: 'Recover' }
        );
        if (options)
          await runCommand('craftingRecovery', {
            actorUuid: actor.uuid,
            receipt: data.craftReceipt,
            options,
          });
      })().catch(errorNotice)
    );
  });
}
