import { SYSTEM_ID } from './config.js';
import { RuleError, beats } from './rules.js';
import { magicInfo } from './magic-catalog.js';
import { magicVigor, validateCasting } from './magic-state.js';
import { magicCostPlan, magicalFumble, elementalBacklash } from './magic-rules.js';
import {
  artifactItemData,
  amuletImbuementCost,
  amuletGrantedItems,
  AMULET_DRAWBACKS,
} from './magic-gear-rules.js';
import { registerCommand, runCommand, authorizedActor } from './authority.js';
import { resolveFoundryUuid } from '../foundry-compat.js';
import { ritualComponentPlan } from './magic-procedures.js';
import { resolveWoundArm } from './wound-rules.js';
import {
  actionPlan,
  turnIdentity,
  commitActor,
  check,
  checkHTML,
  dice,
  chat,
  prompt,
  input,
  manualCheckInput,
  validateManualCheck,
  woundArmInput,
  escapeHTML as e,
  errorNotice,
} from './runtime.js';

const copy = (value) => structuredClone(value);
const rows = (value) => value?.contents ?? Array.from(value ?? []);
const now = () => game.time.worldTime;
const path = `flags.${SYSTEM_ID}.amuletImbuement`;
const current = (actor) => actor.flags?.[SYSTEM_ID]?.amuletImbuement;
const roundKey = () => (game.combat?.started ? `${game.combat.id}:${game.combat.round}` : '');
const number = (value, label = 'Modifier') => {
  const result = Number(value ?? 0);
  if (!Number.isFinite(result)) throw new RuleError(`${label} must be a finite number.`);
  return result;
};
const snapshot = (actor) => ({
  ...copy(actor.system.toObject()),
  items: rows(actor.items).map((item) => item.toObject()),
});
export function amuletComponents(count) {
  if (!Number.isInteger(count) || count < 1 || count > 4)
    throw new RuleError('Choose one to four stored spells.');
  return [
    { id: 'amulet', name: 'Simple Amulet', quantity: 1, kind: 'consume' },
    { id: 'gems', name: 'Perfect Gemstone', quantity: count, kind: 'consume' },
    { id: 'essence', name: 'Fifth Essence', quantity: 2, kind: 'consume' },
    { id: 'tools', name: 'Runewright’s Tools', quantity: 1, kind: 'retain' },
  ];
}
export function amuletSequencePlan(
  entries,
  { id, itemId, expected, time, drawback = '', upkeepMode = '', upkeepRuling = '' } = {}
) {
  if (
    !Array.isArray(entries) ||
    !entries.length ||
    entries.length > 4 ||
    new Set(entries.map((entry) => entry.key)).size !== entries.length
  )
    throw new RuleError('Choose one to four different learned spells or invocations.');
  const spells = entries.map((entry) => ({
    ...copy(entry),
    ...amuletImbuementCost(magicInfo(entry.key), Number(entry.power)),
  }));
  if (spells.length > 1 && !AMULET_DRAWBACKS[drawback])
    throw new RuleError('Choose one drawback for a multi-spell amulet.');
  if (
    spells.some((entry) => entry.maintenanceSTA > 0) &&
    (!['same-round', 'four-rounds'].includes(upkeepMode) || !String(upkeepRuling).trim())
  )
    throw new RuleError(
      'The GM must record how the four maintenance payments are timed; the book does not specify their Vigor timing.'
    );
  return {
    id,
    ritualItemId: itemId,
    expected,
    createdAt: time,
    readyAt: time + 45,
    stage: 'preparing',
    storedMagic: spells,
    drawback: spells.length > 1 ? drawback : null,
    upkeepMode,
    upkeepRuling,
    index: 0,
    upkeepPaid: 0,
    paidSTA: 0,
    receipts: [],
    version: 0,
  };
}
function learned(actor, itemId, key) {
  const item = actor.items.get(itemId),
    magic = magicInfo(item?.system?.magic?.key);
  if (
    !item ||
    item.type !== 'magic' ||
    !magic ||
    (key && magic.key !== key) ||
    item.flags?.[SYSTEM_ID]?.magicAmulet
  )
    throw new RuleError(
      'Use actual learned magic; an amulet cannot supply knowledge for crafting another amulet.'
    );
  return { item, magic };
}
function sequence(actor, id, version) {
  const state = copy(current(actor));
  if (!state || state.id !== id || !['preparing', 'imbuing', 'upkeep', 'checking'].includes(state.stage))
    throw new RuleError('This amulet sequence is no longer active.');
  const { item } = learned(actor, state.ritualItemId, 'enchant-amulet');
  if (JSON.stringify(item.system.magic) !== state.expected)
    throw new RuleError('The ritual entry changed after preparation began.');
  if (version !== undefined && state.version !== version)
    throw new RuleError('This amulet step was already resolved or changed. Reopen its current card.');
  return state;
}
function card(actor, state, result = null) {
  const action =
    state.stage === 'preparing' || state.stage === 'imbuing'
      ? 'cast'
      : state.stage === 'upkeep'
        ? 'upkeep'
        : state.stage === 'checking'
          ? 'finish'
          : '';
  const label = {
    cast: 'Cast next stored spell',
    upkeep: 'Pay next upkeep round',
    finish: 'Complete Ritual Crafting check',
  }[action];
  return (
    `<p>${e(state.stage)}. Stored casts: ${state.index}/${state.storedMagic.length}. Actual STA spent: ${state.paidSTA}.</p>` +
    (state.stage === 'preparing'
      ? `<p>15 rounds of preparation; ready at world time ${state.readyAt}.</p>`
      : '') +
    (state.upkeepRuling
      ? `<p>GM maintenance timing: ${e(state.upkeepRuling)} (${e(state.upkeepMode)}).</p>`
      : '') +
    (result ? checkHTML(result) : '') +
    (action
      ? `<button type="button" data-magic-amulet="${action}" data-actor="${e(actor.uuid)}" data-sequence="${e(state.id)}">${label}</button>`
      : '') +
    (action
      ? `<button type="button" data-magic-amulet="cancel" data-actor="${e(actor.uuid)}" data-sequence="${e(state.id)}">Abandon sequence</button>`
      : '') +
    (state.reason ? `<p>${e(state.reason)}</p>` : '')
  );
}
function post(actor, state, result = null, rolls = []) {
  return chat(actor, 'Enchant Amulet', card(actor, state, result), {
    rolls,
    flags: { kind: 'amulet-imbuement', actorUuid: actor.uuid, sequenceId: state.id },
  });
}
async function begin(
  { actorUuid, itemId, entries, allocations = {}, drawback, upkeepMode, upkeepRuling, turn },
  { user, id }
) {
  const actor = await authorizedActor(actorUuid, user),
    { item, magic } = learned(actor, itemId, 'enchant-amulet');
  if (current(actor) && ['preparing', 'imbuing', 'upkeep', 'checking'].includes(current(actor).stage))
    throw new RuleError('Finish or cancel the active amulet sequence first.');
  validateCasting(snapshot(actor), rows(actor.items), magic);
  const selected = entries.map((entry) => {
    const learnedEntry = learned(actor, entry.itemId, entry.key);
    if (learnedEntry.magic.cost.formula && (!user.isGM || !String(entry.costRuling || '').trim()))
      throw new RuleError('The GM must record the actual formula cost and its inputs for imbuement.');
    validateCasting(snapshot(actor), rows(actor.items), learnedEntry.magic);
    return { ...entry, expected: JSON.stringify(learnedEntry.item.system.magic) };
  });
  const state = amuletSequencePlan(selected, {
    id,
    itemId,
    expected: JSON.stringify(item.system.magic),
    time: now(),
    drawback,
    upkeepMode,
    upkeepRuling,
  });
  if (state.storedMagic.some((entry) => entry.maintenanceSTA > 0) && !user.isGM)
    throw new RuleError('The GM must start this maintained-spell amulet after recording its payment timing.');
  ritualComponentPlan(rows(actor.items), amuletComponents(entries.length), allocations, { isGM: user.isGM });
  state.allocations = copy(allocations);
  state.gmSubstitutions = user.isGM;
  const action = actionPlan(actor, { full: true, expectedTurn: turn });
  return commitActor(actor, { ...action.changes, [path]: state }, [], () => post(actor, state));
}
async function backlashPlan(actor, magic, cost, result, values, changes, rolls) {
  let element = magic.element;
  if (!['earth', 'air', 'fire', 'water', 'mixed'].includes(element)) element = values.element || 'mixed';
  let mixedElement;
  const fumble = result?.fumble ?? 0;
  if ((cost.elementalBacklash || fumble >= 7) && element === 'mixed') {
    const roll = await dice('1d4');
    rolls.push(roll);
    mixedElement = ['earth', 'air', 'fire', 'water'][roll.total - 1];
  }
  const mishap = magicalFumble({ fumble, element, mixedElement, kind: 'spell' });
  const effects = cost.elementalBacklash ? elementalBacklash(element, { mixedElement }) : mishap;
  const damage = cost.hpCost + mishap.damage;
  if (damage) changes['system.hp.value'] = actor.system.hp.value - damage;
  const conditions = new Set(changes['system.conditions'] ?? actor.system.conditions);
  if (effects.condition) conditions.add(effects.condition);
  if (cost.exhausted) conditions.add('stunned');
  changes['system.conditions'] = [...conditions];
  if ((changes['system.hp.value'] ?? actor.system.hp.value) <= 0 && damage)
    changes['system.pendingDeathSaves'] = actor.system.pendingDeathSaves + 1;
  return { mishap, airPush: effects.pushMeters || 0, element: effects.element ?? element };
}
function pay(actor, magic, power, values, action = { changes: {}, modifier: 0 }) {
  const key = roundKey();
  const cost = magicCostPlan({
    power,
    focus: 0,
    spent: key && actor.system.magic.roundKey === key ? actor.system.magic.spent : 0,
    vigor: magicVigor(snapshot(actor), magic),
    stamina: action.changes['system.sta.value'] ?? actor.system.sta.value,
    dimeritium: actor.system.magic.dimeritiumContact,
  });
  if (cost.hpCost && !values.overdraw)
    throw new RuleError(`This payment costs ${cost.hpCost} HP beyond Vigor. Explicitly allow overexertion.`);
  return {
    cost,
    changes: {
      ...action.changes,
      'system.sta.value': cost.staAfter,
      'system.magic.roundKey': key,
      'system.magic.spent': cost.roundAfter,
      ...(cost.exhausted ? { 'system.magic.exhaustedRecovery': 20 } : {}),
    },
  };
}
async function postBacklash(actor, state, result, tokenUuid, rolls) {
  if (!result.airPush && !result.mishap.focusExplosion) return;
  await chat(
    actor,
    'Amulet imbuement: backlash',
    `<p>${result.airPush ? 'Air pushes the caster 2m in a random direction. ' : ''}${result.mishap.focusExplosion ? 'Carried magical focuses explode, even though they were not used for the ritual. ' : ''}Resolve the actual scene consequences.</p><button type="button" data-magic-action="backlash">Resolve backlash</button>`,
    {
      rolls,
      flags: {
        kind: 'magic-backlash',
        actorUuid: actor.uuid,
        tokenUuid,
        castId: state.id,
        backlash: { element: result.element, pushMeters: result.airPush },
        fumble: result.mishap,
        backlashResolved: false,
      },
    }
  );
}
async function cast({ actorUuid, sequenceId, version, turn, values = {}, tokenUuid = '' }, { user }) {
  const actor = await authorizedActor(actorUuid, user),
    state = sequence(actor, sequenceId, version);
  if (!Number.isInteger(version)) throw new RuleError('Reopen the current amulet crafting step.');
  const token = await resolveFoundryUuid(tokenUuid);
  if (token?.documentName !== 'Token' || token.actor?.uuid !== actor.uuid)
    throw new RuleError(
      'Choose the actual caster token before imbuement so any backlash has a real position.'
    );
  if (!['preparing', 'imbuing'].includes(state.stage))
    throw new RuleError('Finish the current upkeep before casting the next stored spell.');
  if (now() < state.readyAt) throw new RuleError('The ritual requires its full 15 rounds of preparation.');
  const entry = state.storedMagic[state.index],
    { item, magic } = learned(actor, entry.itemId, entry.key);
  if (JSON.stringify(item.system.magic) !== entry.expected)
    throw new RuleError('A stored spell entry changed during preparation.');
  const arm = resolveWoundArm(
    actor.system,
    rows(actor.items),
    values.woundArm,
    actor.system.skills.spellCasting < 9 ? 'one' : 'optional'
  );
  validateCasting(snapshot(actor), rows(actor.items), magic, { arm });
  validateManualCheck(values, actor, { skill: 'spellCasting' });
  const action = actionPlan(actor, { expectedTurn: turn, extra: !!values.extra, forfeit: !!values.forfeit });
  const total = state.upkeepMode === 'same-round' ? entry.totalSTA : entry.initialSTA;
  const { cost, changes } = pay(actor, magic, total, values, action);
  const luck = number(values.luck, 'Luck');
  if (!Number.isInteger(luck) || luck < 0 || luck > actor.system.luck.value)
    throw new RuleError('Invalid Luck expenditure.');
  const result = await check(
    actor.skillBase('spellCasting', { arm, modifier: number(values.modifier) + luck + action.modifier })
      .total,
    { manualDice: values.manualDice, actor, context: { skill: 'spellCasting' } }
  );
  const rolls = [...result.rolls],
    backlash = await backlashPlan(actor, magic, cost, result, values, changes, rolls);
  changes['system.luck.value'] = actor.system.luck.value - luck;
  const components = state.receipts.length
    ? { updates: [] }
    : ritualComponentPlan(rows(actor.items), amuletComponents(state.storedMagic.length), state.allocations, {
        isGM: state.gmSubstitutions,
      });
  state.paidSTA += cost.staCost;
  state.version++;
  state.receipts.push({
    key: entry.key,
    time: now(),
    turn,
    check: { total: result.total, fumble: result.fumble, dice: result.dice },
    cost: copy(cost),
    upkeep: state.upkeepMode === 'same-round' ? Array(4).fill(entry.maintenanceSTA) : [],
  });
  if (!backlash.mishap.spellSucceeds) {
    state.stage = 'failed';
    state.reason = 'A stored spell failed during imbuement.';
  } else if (entry.maintenanceSTA && state.upkeepMode === 'four-rounds') {
    state.stage = 'upkeep';
    state.upkeepPaid = 0;
    state.upkeepTime = now();
    state.upkeepRound = roundKey();
  } else {
    state.index++;
    state.stage = state.index === state.storedMagic.length ? 'checking' : 'imbuing';
  }
  changes[path] = state;
  let cardMessage;
  try {
    return await commitActor(actor, changes, components.updates, async () => {
      cardMessage = await post(actor, state, result, rolls);
      await postBacklash(actor, state, backlash, tokenUuid, []);
      return cardMessage;
    });
  } catch (error) {
    if (cardMessage) await cardMessage.delete();
    throw error;
  }
}
async function upkeep({ actorUuid, sequenceId, version, turn, values = {}, tokenUuid = '' }, { user }) {
  const actor = await authorizedActor(actorUuid, user),
    state = sequence(actor, sequenceId, version);
  if (!Number.isInteger(version)) throw new RuleError('Reopen the current amulet crafting step.');
  if (state.stage !== 'upkeep' || state.upkeepMode !== 'four-rounds')
    throw new RuleError('This sequence has no upkeep payment due.');
  if (turn !== turnIdentity()) throw new RuleError('The turn changed before payment.');
  const key = roundKey();
  if (key ? key === state.upkeepRound : now() < state.upkeepTime + 3)
    throw new RuleError('The recorded GM timing requires the next upkeep round.');
  const entry = state.storedMagic[state.index],
    { magic } = learned(actor, entry.itemId, entry.key);
  validateCasting(snapshot(actor), rows(actor.items), magic, { continuing: true });
  const { cost, changes } = pay(actor, magic, entry.maintenanceSTA, values),
    rolls = [];
  const backlash = await backlashPlan(actor, magic, cost, null, values, changes, rolls);
  state.paidSTA += cost.staCost;
  state.version++;
  state.upkeepPaid++;
  state.upkeepTime = now();
  state.upkeepRound = key;
  state.receipts.at(-1).upkeep.push({ time: now(), round: key, cost: copy(cost) });
  if (state.upkeepPaid === 4) {
    state.index++;
    state.stage = state.index === state.storedMagic.length ? 'checking' : 'imbuing';
  }
  changes[path] = state;
  let message;
  try {
    return await commitActor(actor, changes, [], async () => {
      message = await post(actor, state, null, rolls);
      await postBacklash(actor, state, backlash, tokenUuid, []);
      return message;
    });
  } catch (error) {
    if (message) await message.delete();
    throw error;
  }
}
async function finish({ actorUuid, sequenceId, version, turn, values = {} }, { user }) {
  const actor = await authorizedActor(actorUuid, user),
    state = sequence(actor, sequenceId, version);
  if (!Number.isInteger(version)) throw new RuleError('Reopen the current amulet crafting step.');
  if (turn !== turnIdentity()) throw new RuleError('The combat turn changed. Reopen the crafting check.');
  if (state.stage !== 'checking' || state.index !== state.storedMagic.length)
    throw new RuleError('Actually cast all stored spells and pay their upkeep first.');
  if (actor.system.conditions.some((condition) => ['dead', 'stunned', 'unconscious'].includes(condition)))
    throw new RuleError('The caster cannot finish the ritual in this condition.');
  validateManualCheck(values, actor, { skill: 'ritualCrafting', dc: 18 });
  const luck = number(values.luck, 'Luck');
  if (!Number.isInteger(luck) || luck < 0 || luck > actor.system.luck.value)
    throw new RuleError('Invalid Luck expenditure.');
  const result = await check(
    actor.skillBase('ritualCrafting', { modifier: number(values.modifier) + luck }).total,
    { manualDice: values.manualDice, actor, context: { skill: 'ritualCrafting', dc: 18 } }
  );
  state.stage = !result.fumble && beats(result.total, 18) ? 'complete' : 'failed';
  state.version++;
  state.ritualCheck = { total: result.total, fumble: result.fumble, dice: result.dice };
  const changes = { [path]: state, 'system.luck.value': actor.system.luck.value - luck };
  if (result.fumble) {
    changes['system.hp.value'] = actor.system.hp.value - state.paidSTA;
    if (changes['system.hp.value'] <= 0)
      changes['system.pendingDeathSaves'] = actor.system.pendingDeathSaves + 1;
  }
  let created = [];
  try {
    return await commitActor(actor, changes, [], async () => {
      if (state.stage === 'complete') {
        created = await actor.createEmbeddedDocuments(
          'Item',
          [
            artifactItemData('amulet', {
              castId: state.id,
              casterUuid: actor.uuid,
              createdAt: now(),
              complete: true,
              drawback: state.drawback,
              storedMagic: state.storedMagic.map(({ key, power, initialSTA, maintenanceSTA }) => ({
                key,
                power,
                initialSTA,
                maintenanceSTA,
              })),
            }),
          ],
          { witcherMagicGear: true }
        );
        created.push(
          ...(await actor.createEmbeddedDocuments('Item', amuletGrantedItems(created[0]), {
            witcherMagicGear: true,
          }))
        );
      }
      return post(actor, state, result, result.rolls);
    });
  } catch (error) {
    if (created.length)
      await actor.deleteEmbeddedDocuments(
        'Item',
        created.map((item) => item.id),
        { witcherMagicGear: true }
      );
    throw error;
  }
}
async function cancel({ actorUuid, sequenceId }, { user }) {
  const actor = await authorizedActor(actorUuid, user),
    state = sequence(actor, sequenceId);
  state.stage = 'failed';
  state.reason = 'Crafting was abandoned; spent resources remain spent.';
  return commitActor(actor, { [path]: state }, [], () => post(actor, state));
}
/** Return a patch for the same transaction as the unrelated action. Preparation
 * uses the separate ritual-interruption rules; only an active cast sequence fails. */
export function amuletImbuementInterruption(actor, reason) {
  const state = current(actor);
  if (!state || !['imbuing', 'upkeep', 'checking'].includes(state.stage)) return {};
  return {
    [path]: { ...copy(state), stage: 'failed', reason: `Another action interrupted imbuement: ${reason}.` },
  };
}
function allocationFields(actor, requirements) {
  const items = rows(actor.items).filter(
    (item) => item.type !== 'magic' && item.system.quantity > 0 && item.system.carried !== false
  );
  return requirements
    .map(
      (requirement) =>
        input(
          `material_${requirement.id}`,
          `${requirement.name} ×${requirement.quantity}${requirement.kind === 'retain' ? ' (retain)' : ''}`,
          {
            options: {
              '': 'Choose actual item',
              ...Object.fromEntries(items.map((item) => [item.id, `${item.name} (${item.system.quantity})`])),
            },
          }
        ) +
        (game.user.isGM
          ? input(`ruling_${requirement.id}`, 'GM material substitution (only if needed)', { type: 'text' })
          : '')
    )
    .join('');
}
export async function beginAmuletImbuement({ actor, item }) {
  const turn = turnIdentity(),
    learnedSpells = rows(actor.items).filter(
      (row) =>
        row.type === 'magic' &&
        ['spell', 'invocation'].includes(magicInfo(row.system.magic.key)?.kind) &&
        !row.flags?.[SYSTEM_ID]?.magicAmulet
    );
  if (!learnedSpells.length)
    throw new RuleError('Learn the actual spells or invocations before imbuing an amulet.');
  const choice = await prompt(
    'Enchant Amulet: stored magic',
    '<p>Select 1–4 different learned spells. Every actual cast costs full STA, without Focus.</p>' +
      learnedSpells
        .map(
          (spell) =>
            input(`spell_${spell.id}`, spell.name, { type: 'checkbox' }) +
            input(`power_${spell.id}`, 'Full spell STA', {
              value: magicInfo(spell.system.magic.key).cost.min || 0.5,
              min: magicInfo(spell.system.magic.key).cost.min,
              max: magicInfo(spell.system.magic.key).cost.formula
                ? undefined
                : magicInfo(spell.system.magic.key).cost.max,
              step: magicInfo(spell.system.magic.key).cost.step,
            }) +
            (magicInfo(spell.system.magic.key).cost.formula
              ? input(`costRuling_${spell.id}`, 'GM: actual formula inputs and cost', { type: 'text' })
              : '')
        )
        .join('') +
      input('drawback', 'Multi-spell drawback', {
        options: { hp: 'Maximum HP −5', headache: 'INT / WILL / REF −1', sta: 'Maximum STA −10' },
      }),
    { button: 'Choose components' }
  );
  if (!choice) return;
  const entries = learnedSpells
    .filter((spell) => choice[`spell_${spell.id}`])
    .map((spell) => ({
      itemId: spell.id,
      key: spell.system.magic.key,
      power: Number(choice[`power_${spell.id}`]),
      costRuling: choice[`costRuling_${spell.id}`] || '',
    }));
  const requirements = amuletComponents(entries.length),
    maintained = entries.some(
      (entry) => amuletImbuementCost(magicInfo(entry.key), entry.power).maintenanceSTA > 0
    );
  if (maintained && !game.user.isGM)
    throw new RuleError(
      'Ask the GM to start this amulet and record the book’s unspecified upkeep/Vigor timing.'
    );
  const material = await prompt(
    'Enchant Amulet: materials and timing',
    allocationFields(actor, requirements) +
      (maintained
        ? '<p>The book requires four upkeep payments but does not specify their Vigor timing. Record the GM’s ruling.</p>' +
          input('upkeepMode', 'Maintenance payment timing', {
            options: {
              'same-round': 'Pay together; aggregate Vigor this round',
              'four-rounds': 'Four actual upkeep rounds; Vigor each round',
            },
          }) +
          input('upkeepRuling', 'GM timing ruling', { type: 'text' })
        : ''),
    { button: 'Begin 15-round preparation' }
  );
  if (!material) return;
  const allocations = Object.fromEntries(
    requirements.map((requirement) => [
      requirement.id,
      { itemId: material[`material_${requirement.id}`], ruling: material[`ruling_${requirement.id}`] || '' },
    ])
  );
  return runCommand('magicAmuletBegin', {
    actorUuid: actor.uuid,
    itemId: item.id,
    entries,
    allocations,
    drawback: choice.drawback,
    upkeepMode: material.upkeepMode || '',
    upkeepRuling: material.upkeepRuling || '',
    turn,
  });
}
export async function amuletCraftingAction(actor, action, sequenceId) {
  if (action === 'cancel') return runCommand('magicAmuletCancel', { actorUuid: actor.uuid, sequenceId });
  const state = sequence(actor, sequenceId),
    turn = turnIdentity(),
    entry = state.storedMagic[state.index];
  const cost =
    action === 'upkeep'
      ? entry.maintenanceSTA
      : action === 'cast'
        ? state.upkeepMode === 'same-round'
          ? entry.totalSTA
          : entry.initialSTA
        : 0;
  const values = await prompt(
    'Enchant Amulet',
    `<p>This step spends ${cost} STA; Vigor ${magicVigor(snapshot(actor), entry && magicInfo(entry.key))}. Focus is unavailable.</p>` +
      (action === 'upkeep'
        ? ''
        : input('modifier', 'Modifier', { value: 0 }) +
          input('luck', 'Luck', { value: 0, min: 0, max: actor.system.luck.value }) +
          manualCheckInput() +
          woundArmInput(actor)) +
      (cost
        ? input('overdraw', 'Allow HP loss and elemental backlash beyond Vigor', { type: 'checkbox' })
        : '') +
      (action === 'cast'
        ? input('extra', 'Use extra action (3 STA, −3)', { type: 'checkbox' }) +
          input('forfeit', 'Forfeit remaining strikes', { type: 'checkbox' })
        : ''),
    { button: action === 'finish' ? 'Complete ritual check' : 'Pay and resolve' }
  );
  if (!values) return;
  const candidates = rows(globalThis.canvas?.tokens?.controlled)
    .map((token) => token.document)
    .filter((token) => token.actor?.uuid === actor.uuid);
  const tokens = candidates.length ? candidates : (actor.getActiveTokens?.(true, true) ?? []);
  let token = tokens.length === 1 ? (tokens[0].document ?? tokens[0]) : null;
  if (!token && action !== 'finish') {
    const available = rows(globalThis.game?.scenes)
      .flatMap((scene) => rows(scene.tokens))
      .filter((row) => row.actor?.uuid === actor.uuid);
    if (!available.length)
      throw new RuleError('Place the caster token in the ritual scene before imbuement.');
    const selected = await prompt(
      'Actual caster token',
      input('tokenUuid', 'Token', {
        options: Object.fromEntries(available.map((row) => [row.uuid, row.name])),
      }),
      { button: 'Choose' }
    );
    if (!selected) return;
    token = available.find((row) => row.uuid === selected.tokenUuid);
  }
  return runCommand(
    { cast: 'magicAmuletCast', upkeep: 'magicAmuletUpkeep', finish: 'magicAmuletFinish' }[action],
    {
      actorUuid: actor.uuid,
      sequenceId,
      version: state.version,
      values,
      turn,
      tokenUuid: token?.uuid || '',
    }
  );
}
export function registerAmuletCrafting() {
  registerCommand('magicAmuletBegin', begin);
  registerCommand('magicAmuletCast', cast);
  registerCommand('magicAmuletUpkeep', upkeep);
  registerCommand('magicAmuletFinish', finish);
  registerCommand('magicAmuletCancel', cancel);
  Hooks.on('renderChatMessageHTML', (_message, html) =>
    html.querySelectorAll('[data-magic-amulet]').forEach((button) =>
      button.addEventListener('click', async () => {
        button.disabled = true;
        try {
          const actor = await resolveFoundryUuid(button.dataset.actor);
          await amuletCraftingAction(actor, button.dataset.magicAmulet, button.dataset.sequence);
        } catch (error) {
          errorNotice(error);
        } finally {
          button.disabled = false;
        }
      })
    )
  );
}
