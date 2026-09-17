import { SYSTEM_ID } from './config.js';
import { RuleError, beats } from './rules.js';
import { activeHexes } from './magic-hex-rules.js';
import { immuneTo } from './monster-rules.js';
import { magicInfo } from './magic-catalog.js';
import { registerCommand, runCommand, authorizedActor } from './authority.js';
import {
  prompt,
  input,
  manualCheckInput,
  check,
  checkHTML,
  dice,
  chat,
  commitActor,
  escapeHTML as e,
  serial,
  errorNotice,
} from './runtime.js';
import { isPrimaryActiveGm } from '../foundry-compat.js';
const copy = (value) => structuredClone(value);
const list = (collection) => Array.from(collection?.values?.() ?? collection ?? []);
const resolve = (uuid) => foundry.utils.fromUuid(uuid);
const day = () => Math.floor(game.time.worldTime / 86400);
function hexFor(actor, id) {
  const effect = actor.system.effects.find((effect) => effect.id === id);
  if (!effect || !activeHexes({ effects: [effect] }).size)
    throw new RuleError('This hex is missing or suppressed.');
  return effect;
}
function conditionChanges(actor, conditions) {
  return {
    'system.conditions': [
      ...new Set([...actor.system.conditions, ...conditions.filter((key) => !immuneTo(actor.system, key))]),
    ],
  };
}

export async function resolveHexEvent({ actorUuid, effectId, event, values = {} }, { user, id }) {
  if (!user.isGM) throw new RuleError('The GM declares the actual exposure or memory event.');
  const actor = await authorizedActor(actorUuid, user),
    effect = hexFor(actor, effectId),
    key = effect.magic.key;
  let changes = {},
    content = '',
    rolls = [],
    flags = { kind: 'hex-event', actorUuid, effectId, event, eventId: id };
  if (key === 'the-hex-of-shadows' && event === 'visions') {
    const result = await check(actor.skillBase('awareness').total, { actor, manualDice: values.manualDice });
    rolls = result.rolls;
    content =
      checkHTML(result) +
      '<p>The glimpses and whispers are visions caused by the hex. The book assigns no universal DC or actual threat.</p>';
  } else if (key === 'the-pestas-kiss' && event === 'disease') {
    if (immuneTo(actor.system, 'disease'))
      return chat(actor, 'Pesta’s Kiss: exposure', '<p>Disease immunity prevents infection.</p>', { flags });
    if (!String(values.illness ?? '').trim())
      throw new RuleError('Identify the actual illness of the person contacted.');
    const roll = await dice('1d100');
    rolls = [roll];
    const infected = roll.total <= 75;
    content = `<p>d100 ${roll.total}: ${infected ? 'Illness contracted' : 'No infection'} — ${e(values.illness)}.</p>`;
    if (infected)
      changes['system.effects'] = [
        ...actor.system.effects,
        {
          id: foundry.utils.randomID(),
          key: values.illness,
          expires: 0,
          modifiers: {},
          notes: `Contracted through Pesta’s Kiss; apply this specific illness’s symptoms and treatment.`,
          hexConsequence: { castId: effect.magic.castId, illness: values.illness },
        },
      ];
  } else if (key === 'the-pestas-kiss' && event === 'nauseatingSmell') {
    const result = await check(actor.skillBase('endurance').total, {
      actor,
      manualDice: values.manualDice,
      context: { skill: 'endurance', dc: 16 },
    });
    rolls = result.rolls;
    const passed = beats(result.total, 16);
    if (!passed) changes = conditionChanges(actor, ['nausea']);
    content = checkHTML(result) + `<p>Endurance DC16: ${passed ? 'Resisted nausea.' : 'Nausea applied.'}</p>`;
  } else if (key === 'curse-of-temperance' && event === 'intoxicant') {
    if (!values.consumed) throw new RuleError('Confirm actual consumption of an intoxicating substance.');
    changes = conditionChanges(actor, ['intoxicated', 'nausea']);
    content =
      '<p>The consumed intoxicant immediately causes Intoxication and Nausea. Both conditions were applied.</p>';
  } else if (key === 'the-hex-of-the-beast' && event === 'animal') {
    const token = await resolve(values.tokenUuid),
      animalToken = await resolve(values.animalTokenUuid);
    if (
      token?.actor?.uuid !== actor.uuid ||
      !animalToken?.actor ||
      animalToken.actor.system.category !== 'beast'
    )
      throw new RuleError('Choose this hexed creature and an actual animal token.');
    const { magicTokenDistance } = await import('./magic-runtime.js');
    if (magicTokenDistance(token, animalToken) > 10) throw new RuleError('The animal is beyond 10m.');
    const roll = await dice('1d100');
    rolls = [roll];
    const attacks = roll.total <= 50;
    flags = { ...flags, attacks, sourceTokenUuid: animalToken.uuid, targetTokenUuid: token.uuid };
    content = `<p>d100 ${roll.total}: ${e(animalToken.name)} reacts poorly${attacks ? ' and attacks the hexed creature' : '; no compulsory attack'}.</p>${attacks ? '<button type="button" data-hex-event="animalAttack">Resolve animal attack</button>' : ''}`;
  } else if (key === 'hex-of-forgetfulness' && event === 'forget') {
    if (effect.magic.lastForgottenDay === day())
      throw new RuleError('The GM already invoked this hex today.');
    if (!String(values.memory ?? '').trim())
      throw new RuleError('Name the fact, memory, recipe or magic at stake.');
    const item = values.itemId ? actor.items.get(values.itemId) : null;
    if (values.itemId && (!item || !['magic', 'diagram'].includes(item.type)))
      throw new RuleError('Choose an actual learned magic or recipe item.');
    const result = await check(actor.skillBase('resistMagic').total, {
      actor,
      manualDice: values.manualDice,
      context: { skill: 'resistMagic', dc: 20 },
    });
    rolls = result.rolls;
    const passed = beats(result.total, 20),
      effects = copy(actor.system.effects),
      updated = effects.find((row) => row.id === effect.id);
    updated.magic.lastForgottenDay = day();
    if (!passed)
      updated.magic.forgotten = [
        ...(updated.magic.forgotten ?? []),
        {
          description: values.memory,
          itemId: item?.id ?? '',
          magicKey: item?.system.magic?.key ?? '',
          forgottenAt: game.time.worldTime,
        },
      ];
    changes['system.effects'] = effects;
    content =
      checkHTML(result) +
      `<p>Resist Magic DC20: ${passed ? 'Memory retained' : 'Forgotten until the hex is removed'} — ${e(values.memory)}.</p>`;
  } else throw new RuleError('This event does not match the selected hex.');
  return commitActor(actor, changes, [], () =>
    chat(actor, `${effect.key}: ${event}`, content, { rolls, flags })
  );
}

export function forgottenMagic(state, key) {
  return (state.effects ?? []).some(
    (effect) =>
      activeHexes({ effects: [effect] }).has('hex-of-forgetfulness') &&
      effect.magic.forgotten?.some((entry) => entry.magicKey === key)
  );
}
export function forgottenRecipe(state, itemId) {
  return (state.effects ?? []).some(
    (effect) =>
      activeHexes({ effects: [effect] }).has('hex-of-forgetfulness') &&
      effect.magic.forgotten?.some((entry) => entry.itemId === itemId)
  );
}
export async function hexEventAction(actor, effect) {
  const key = effect.magic.key;
  const options = {
    'the-hex-of-shadows': { visions: 'Whispers and silhouettes' },
    'the-pestas-kiss': { disease: 'Contact with an ill person', nauseatingSmell: 'Nauseating smell' },
    'curse-of-temperance': { intoxicant: 'Consumed an intoxicant' },
    'the-hex-of-the-beast': { animal: 'Animal within 10m' },
    'hex-of-forgetfulness': { forget: 'Daily memory resistance' },
  }[key];
  if (!options)
    throw new RuleError(
      'This hex has no separate exposure action; its effects apply through rest, checks or wounds.'
    );
  let fields = input('event', 'Actual event', { options });
  if (key === 'the-pestas-kiss') fields += input('illness', 'Specific illness contacted', { type: 'text' });
  if (key === 'curse-of-temperance')
    fields += input('consumed', 'An intoxicating substance was consumed', { type: 'checkbox' });
  if (key === 'hex-of-forgetfulness')
    fields +=
      input('memory', 'Memory selected by the GM', { type: 'text' }) +
      input('itemId', 'Related learned magic or recipe', {
        options: {
          '': 'Fact / memory without an item',
          ...Object.fromEntries(
            [...actor.items]
              .filter((item) => ['magic', 'diagram'].includes(item.type))
              .map((item) => [item.id, item.name])
          ),
        },
      });
  if (key === 'the-hex-of-the-beast') {
    const tokens = list(canvas.scene?.tokens);
    fields +=
      input('tokenUuid', 'Hexed creature', {
        options: Object.fromEntries(
          tokens.filter((token) => token.actor?.uuid === actor.uuid).map((token) => [token.uuid, token.name])
        ),
      }) +
      input('animalTokenUuid', 'Animal within 10m', {
        options: Object.fromEntries(
          tokens
            .filter((token) => token.actor?.system.category === 'beast')
            .map((token) => [token.uuid, token.name])
        ),
      });
  }
  fields += manualCheckInput();
  const values = await prompt('Hex: resolve actual event', fields, { button: 'Resolve event' });
  if (values)
    return runCommand('magicHexEvent', {
      actorUuid: actor.uuid,
      effectId: effect.id,
      event: values.event,
      values,
    });
}
export function registerHexRuntime() {
  registerCommand('magicHexEvent', resolveHexEvent);
  Hooks.on('renderChatMessageHTML', (message, html) => {
    const root = html?.querySelectorAll ? html : html?.[0];
    for (const button of root?.querySelectorAll('[data-hex-event="animalAttack"]') ?? [])
      button.addEventListener('click', async () => {
        try {
          if (!game.user.isGM) throw new RuleError('The GM controls this compelled animal attack.');
          const data = message.flags[SYSTEM_ID];
          if (!message.author?.isGM || data.kind !== 'hex-event' || !data.attacks)
            throw new RuleError('Use the actual encounter card.');
          const source = await resolve(data.sourceTokenUuid),
            target = await resolve(data.targetTokenUuid);
          const weapons = [...source.actor.items].filter((item) => item.type === 'weapon');
          if (!weapons.length) throw new RuleError('This animal needs its real attack item first.');
          const choice =
            weapons.length === 1
              ? { weaponId: weapons[0].id }
              : await prompt(
                  'Animal attack',
                  input('weaponId', 'Attack', {
                    options: Object.fromEntries(weapons.map((item) => [item.id, item.name])),
                  })
                );
          if (choice)
            await game.witcher.attack(source.actor, source.actor.items.get(choice.weaponId), {
              sourceTokenUuid: source.uuid,
              targetTokenUuid: target.uuid,
              target: target.actor,
            });
        } catch (error) {
          errorNotice(error);
        }
      });
  });
}
