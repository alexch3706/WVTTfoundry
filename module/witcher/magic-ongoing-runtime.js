import { magicDefenseTotal } from './magic-focus-rules.js';
import { SYSTEM_ID } from './config.js';
import { RuleError } from './rules.js';
import { registerCommand, runCommand } from './authority.js';
import { registerMagicOngoing, installMagicOngoing, triggerMagicOngoing } from './magic-ongoing.js';
import { executeBasicSpell, registerSpellExecutionAdapters } from './magic-execution.js';
import { resolvedMagic, effectFor, magicDamageCard, magicTokenDistance } from './magic-runtime.js';
import { actorSnapshot, itemSnapshot } from './documents.js';
import { validateWeaponGrip } from './inventory.js';
import { resolveWoundArm } from './wound-rules.js';
import { isPrimaryActiveGm } from '../foundry-compat.js';
import { magicDefenses, magicalFumble, elementalBacklash } from './magic-rules.js';
import { magicConditionRules } from './magic-effect-hooks.js';
import { createMagicRegion, magicTokenOrigin, magicRegionTargets } from './magic-regions.js';
import { triggerMagicOngoingRegion } from './magic-ongoing.js';
import { combatModifier } from './combat.js';
import {
  dice,
  check,
  chat,
  checkHTML,
  commitActor,
  actionPlan,
  turnIdentity,
  serial,
  errorNotice,
  prompt,
  input,
  manualCheckInput,
  woundArmInput,
  escapeHTML,
} from './runtime.js';

const copy = (value) => foundry.utils.deepClone(value);
const resolve = (uuid) => foundry.utils.fromUuid(uuid);
const all = (collection) => Array.from(collection?.values?.() ?? collection ?? []);
const tokensFor = (actor, scene) => all(scene?.tokens).filter((token) => token.actor?.uuid === actor.uuid);

export async function createContinuingZone(
  operation,
  { data, caster, sourceToken, operationIndex, message }
) {
  const duration = operation.duration ?? data.magic.duration;
  const seconds = duration.seconds || (duration.rounds || 0) * 3;
  const origin = magicTokenOrigin(sourceToken);
  const spec = {
    ...copy(operation.shape),
    origin: operation.centeredOnCaster ? 'caster' : 'ranged',
    range: operation.placementRange ?? data.magic.range.distance,
    volume: 'level',
    wallRestriction: 'sight',
    angleSource: operation.shape.shape === 'cone' ? 'table' : 'rule',
  };
  const placement = operation.centeredOnCaster
    ? origin
    : (data.area?.placement ?? data.points?.[operation.point]);
  if (!placement) throw new RuleError('Place the actual persistent magical area before applying it.');
  const region = await createMagicRegion({
    scene: sourceToken.parent,
    casterToken: sourceToken,
    spec,
    placement,
    expectedOrigin: origin,
    requester: game.user,
    name: data.name,
    links: {
      castId: data.castId,
      casterUuid: caster.uuid,
      spellUuid: data.itemUuid || `${caster.uuid}.Item.${data.itemId}`,
    },
    rounds: Math.max(1, duration.rounds || Math.ceil(seconds / 3)),
    state: {
      key: data.magicKey,
      operationIndex,
      operations: copy(operation.operations),
      castingTotal: data.check.total,
      focus: copy(data.focus ?? null),
      duration: copy(duration),
      createdAt: game.time.worldTime,
      expires: seconds > 0 ? game.time.worldTime + seconds : 0,
      active: true,
      excludesCaster: !!operation.excludesCaster,
      tokenUuid: sourceToken.uuid,
      messageUuid: message.uuid,
      initialCast: copy(data),
      sceneUuid: sourceToken.parent.uuid,
    },
    validatedCast:
      data.area?.data &&
      ['shape', 'radius', 'distance', 'width', 'height', 'verticalHeight'].every(
        (key) =>
          operation.shape[key] === undefined ||
          operation.shape[key] === (data.area.spec ?? data.area.area)?.[key]
      )
        ? { ...data.area, area: data.area.spec ?? data.area.area }
        : undefined,
  });
  const results = [];
  try {
    const state = region.flags[SYSTEM_ID].magicArea;
    const candidates = magicRegionTargets({
      region,
      casterToken: sourceToken,
      spec: state.spec,
      origin: state.origin,
      placement: state.placement,
      requester: game.user,
    });
    for (const candidate of candidates.filter((entry) => entry.included)) {
      const token = sourceToken.parent.tokens.get(candidate.tokenId);
      if (!token?.actor) continue;
      results.push(
        await triggerMagicOngoingRegion(region, {
          name: 'tokenEnter',
          data: { token, combat: game.combat, initialPlacement: true },
        })
      );
      results.push(
        await triggerMagicOngoingRegion(region, { name: 'initialCast', data: { token, combat: game.combat } })
      );
    }
    return {
      status: 'applied',
      receipt: { regionUuid: region.uuid },
      rollback: async () => {
        for (const result of [...results].reverse()) await result.rollback();
        await region.delete();
      },
    };
  } catch (error) {
    for (const result of results.reverse()) await result.rollback();
    await region.delete();
    throw error;
  }
}

export async function executeContinuingOperations(operations, context) {
  if (context.executionRole === 'activeAction') return executeContinuingAttack(operations, context);
  const targets = [
    ...new Map(
      (context.targets?.length ? context.targets : [context.target]).map((actor) => [actor.uuid, actor])
    ).values(),
  ];
  const receipts = [];
  try {
    for (const target of targets)
      receipts.push(await executeContinuingTarget(operations, { ...context, target, targets: [target] }));
    return {
      status: receipts.some((result) => result.status === 'pendingGM') ? 'pendingGM' : 'applied',
      receipt: {
        targets: targets.map((actor) => actor.uuid),
        results: receipts.map((result) => result.receipt),
      },
      rollback: async () => {
        for (const result of [...receipts].reverse()) await result.rollback();
      },
    };
  } catch (error) {
    for (const result of receipts.reverse()) await result.rollback();
    throw error;
  }
}

async function executeContinuingTarget(operations, context) {
  const { caster, target, sourceMagic: magic, castId, castTotal } = context;
  if (!magic || !caster || !target) throw new RuleError('The continuing spell source is missing.');
  const source = context.tokenUuid ? await resolve(context.tokenUuid) : tokensFor(caster, context.scene)[0];
  if (!source) throw new RuleError('The original caster token is missing.');
  const targetToken = context.event?.tokenUuid
    ? await resolve(context.event.tokenUuid)
    : tokensFor(target, source.parent)[0];
  if (!targetToken) throw new RuleError('Place the affected creature on the source scene.');
  const sourceMessage = context.messageUuid ? await resolve(context.messageUuid) : null;
  const original = sourceMessage?.flags?.[SYSTEM_ID] ?? context.initialCast ?? {};
  const executionId = `${castId}:${context.effectId}:${context.pendingId ?? context.event?.id ?? 'event'}:${target.uuid}`;
  const data = {
    ...copy(original),
    kind: 'magic',
    magic,
    magicKey: magic.key,
    name: magic.name,
    castId,
    executionId,
    actorUuid: caster.uuid,
    tokenUuid: source.uuid,
    itemUuid: original.itemUuid ?? '',
    itemId: original.itemId ?? '',
    power: original.power ?? magic.cost.min,
    resolved: resolvedMagic(magic, original.power ?? magic.cost.min),
    check: { total: castTotal, base: castTotal, dice: [], fumble: 0 },
    focus: copy(context.focus ?? original.focus ?? null),
    staCost: original.staCost ?? magic.cost.min,
    choices: { ...(original.choices ?? {}), ...(context.choices ?? {}) },
    messageUuid: sourceMessage?.uuid,
  };
  const row = { tokenUuid: targetToken.uuid, actorUuid: target.uuid, defense: context.defense ?? {} };
  return executeBasicSpell({
    data,
    row,
    caster,
    target,
    message: sourceMessage ?? { uuid: context.sourceUuid },
    receipt: `ongoing:${executionId}:${target.uuid}`,
    operationsOverride: operations,
    returnTransaction: true,
    effectFor,
    damageCard: magicDamageCard,
  });
}

const savedCheck = (result) => ({
  total: result.total,
  base: result.base ?? result.total,
  dice: copy(result.dice ?? []),
  fumble: result.fumble ?? 0,
});

/** Each attack creates actual defense prompts; damage only follows a failed saved defense. */
export async function executeContinuingAttack(operations, context) {
  const { caster, sourceMagic: magic, actionRule = {} } = context;
  const source = context.tokenUuid ? await resolve(context.tokenUuid) : tokensFor(caster, context.scene)[0];
  if (!source?.actor || !operations.length)
    throw new RuleError('The continuing attack needs its actual caster token and operations.');
  const targets = [...new Map((context.targets ?? []).map((actor) => [actor.uuid, actor])).values()];
  if (!targets.length) throw new RuleError('Select the actual targets of the continuing attack.');
  const undo = [],
    receipts = [],
    rollback = async () => {
      for (const reverse of [...undo].reverse()) await reverse();
    };
  const executionId = `${context.castId}:${context.pending?.id ?? foundry.utils.randomID()}`;
  try {
    let attackCheck = {
      total: actionRule.useCastingTotal ?? context.castTotal,
      base: actionRule.useCastingTotal ?? context.castTotal,
      dice: [],
      fumble: 0,
    };
    const attackSkill =
      actionRule.attackSkill ?? operations.find((operation) => operation.attackSkill)?.attackSkill;
    if (actionRule.newCastingCheckEachAttack || actionRule.newCastingCheck || attackSkill) {
      attackCheck = await continuingCheck(caster, {
        skill: attackSkill ?? 'spellCasting',
        purpose: `Continuing attack: ${magic.name}`,
        pendingRole: 'activeAttack',
        values: context.values ?? {},
        sourceMagic: magic,
        tokenUuid: source.uuid,
        castId: executionId,
      });
      if (attackCheck.rollback) undo.push(attackCheck.rollback);
    }
    const attack = {
      ...(context.initialCast ?? {}),
      kind: 'magic',
      ongoingAttack: true,
      actorUuid: caster.uuid,
      tokenUuid: source.uuid,
      magicKey: magic.key,
      magic,
      name: magic.name,
      castId: context.castId,
      executionId,
      parentCastId: context.castId,
      check: savedCheck(attackCheck),
      focus: copy(context.focus ?? context.initialCast?.focus ?? null),
      staCost: context.initialCast?.staCost ?? magic.cost.min,
      power: context.initialCast?.power ?? magic.cost.min,
      failed: attackCheck.spellSucceeds === false,
      cancelled: false,
      applied: true,
      targets: targets.map((actor) => {
        const token = tokensFor(actor, source.parent)[0];
        if (!token) throw new RuleError('A continuing attack target has left the caster’s scene.');
        return { actorUuid: actor.uuid, tokenUuid: token.uuid, name: actor.name, status: 'ongoingPending' };
      }),
      resolved: resolvedMagic(magic, context.initialCast?.power ?? magic.cost.min),
      backlash: attackCheck.backlash ?? null,
      fumble: attackCheck.magicFumble ?? {},
      backlashResolved: !(attackCheck.backlash?.pushMeters || attackCheck.magicFumble?.focusExplosion),
    };
    const card = await chat(
      caster,
      `${magic.name}: continuing attack`,
      checkHTML(attack.check) +
        `<p>${attack.failed ? 'The magical attack failed.' : `The ${attackSkill || actionRule.newCastingCheckEachAttack || actionRule.newCastingCheck ? 'new' : 'original'} attack check is ${attack.check.total}; defense DC ${magicDefenseTotal(attack)}${attack.focus?.defenseBonus ? ' (+2 Greater Focus)' : ''}${attack.focus?.glyphDC ? ` (+${attack.focus.glyphDC} elemental glyph)` : ''}. Each selected target must resolve its printed defense.`}</p>` +
        (!attack.failed
          ? '<button type="button" data-magic-action="counter">Dispel / Heliotrope</button>'
          : ''),
      { flags: attack }
    );
    undo.push(() => card.delete());
    if (!attack.failed)
      for (const actor of targets) {
        const targetToken = tokensFor(actor, source.parent)[0];
        if (!targetToken) throw new RuleError('A continuing attack target has left the caster’s scene.');
        const pending = operations.map((operation) => {
          const explicit = operation.save?.skill ?? operation.defenses;
          const defenses = (
            Array.isArray(explicit)
              ? explicit
              : explicit
                ? [explicit]
                : magicDefenses(magic, { includeCounters: false })
          ).map((skill) => (skill === 'reposition' ? 'athletics' : skill));
          if (!defenses.length)
            throw new RuleError('This continuing attack needs its printed defense procedure.');
          const result = copy(operation);
          result.target = 'target';
          result.timing = 'immediate';
          result.save = {
            ...(operation.save ?? {}),
            skill: [...new Set(defenses)],
            dc:
              actionRule.useCastingTotal !== undefined
                ? magicDefenseTotal(attack, actionRule.useCastingTotal)
                : actionRule.newCastingCheckEachAttack || actionRule.newCastingCheck || attackSkill
                  ? magicDefenseTotal(attack)
                  : (operation.save?.dc ?? magicDefenseTotal(attack)),
            onSuccess: operation.save?.onSuccess ?? 'avoidAttack',
            comparison:
              actionRule.useCastingTotal !== undefined ||
              actionRule.newCastingCheckEachAttack ||
              actionRule.newCastingCheck ||
              attackSkill
                ? 'atLeast'
                : (operation.save?.comparison ??
                  (operation.save?.dc === undefined ? 'atLeast' : 'strictlyGreater')),
          };
          // Separate damage/status operations that share one defense are bundled below.
          return result;
        });
        const grouped = [];
        for (const operation of pending) {
          const previous = grouped.at(-1);
          if (
            previous &&
            JSON.stringify(previous.save.skill) === JSON.stringify(operation.save.skill) &&
            previous.save.dc === operation.save.dc &&
            operation.type === 'condition'
          ) {
            previous.save.onFailure = [
              ...(previous.save.onFailure?.length
                ? previous.save.onFailure
                : [{ ...copy(previous), save: undefined }]),
              { ...copy(operation), save: undefined },
            ];
          } else grouped.push(operation);
        }
        const installed = await installMagicOngoing(actor, grouped, {
          caster,
          castId: context.castId,
          castTotal: attack.check.total,
          focus: copy(attack.focus),
          sourceMagic: magic,
          effectId: `attack:${executionId}:${actor.id}`,
          time: game.time.worldTime,
          duration: {},
          scene: source.parent,
          tokenUuid: source.uuid,
          messageUuid: card.uuid,
          initialCast: attack,
          oneShot: true,
        });
        undo.push(installed.rollback);
        receipts.push(installed.receipt);
        const result = await triggerMagicOngoing(actor, {
          id: `attack:${executionId}:${actor.uuid}`,
          kind: 'cast',
          effectId: installed.effect.id,
          actorUuid: actor.uuid,
          tokenUuid: targetToken.uuid,
          cycle: context.event?.cycle ?? '',
        });
        undo.push(result.rollback);
        receipts.push(result.receipt);
      }
    return {
      status: attack.failed ? 'failed' : 'awaitingDefenses',
      receipt: {
        attackMessageUuid: card.uuid,
        targets: targets.map((actor) => actor.uuid),
        procedures: receipts,
      },
      rollback,
    };
  } catch (error) {
    await rollback();
    throw error;
  }
}

async function continuingCheck(actor, options) {
  const values = options.values ?? {};
  let skill = options.skill,
    arm = '',
    modifier = Number(values.modifier ?? 0);
  if (!Number.isFinite(modifier)) throw new RuleError('The modifier must be finite.');
  const luck = Number(values.luck ?? 0);
  if (!Number.isInteger(luck) || luck < 0 || luck > actor.system.luck.value)
    throw new RuleError('Invalid Luck expenditure.');
  const defense = options.pendingRole === 'ongoingDefense' && ['dodge', 'athletics', 'block'].includes(skill);
  if (
    defense &&
    actor.system.conditions.some((condition) => ['stunned', 'unconscious', 'dead'].includes(condition))
  )
    throw new RuleError(
      'This condition prevents an active defense. Ask the GM to use the printed passive defense.'
    );
  if (defense || options.pendingRole === 'activeAttack')
    modifier += combatModifier(actor, { defense }).modifier;
  const plan = defense ? actionPlan(actor, { defense: true }) : { changes: {}, modifier: 0 };
  const weapon = actor.items.get(values.weaponId);
  if (skill === 'block') {
    if (!weapon || !['weapon', 'shield'].includes(weapon.type) || weapon.system.reliability <= 0)
      throw new RuleError('Choose a usable, equipped blocking weapon.');
    const state = actorSnapshot(actor),
      grip = validateWeaponGrip(state, itemSnapshot(weapon), state.items);
    arm = resolveWoundArm(state, [...actor.items], values.woundArm, grip.hands === 2 ? 'both' : 'one');
    modifier += grip.modifier;
    skill = weapon.type === 'shield' ? 'melee' : weapon.system.skill;
  }
  const before = { system: copy(actor._source?.system ?? actor.system.toObject()) };
  const result = await check(
    actor.skillBase(skill, { modifier: modifier + luck + plan.modifier, arm }).total,
    {
      ...{ manualDice: options.manualDice ?? values.manualDice ?? options.manualDie?.toString() },
      actor: actor,
    }
  );
  const itemChanges =
    options.skill === 'block' && result.total >= options.dc
      ? [{ _id: weapon.id, 'system.reliability': Math.max(0, weapon.system.reliability - 1) }]
      : [];
  const beforeREL = weapon?.system.reliability;
  const flags =
    defense && result.fumble > 5
      ? {
          kind: 'defense',
          magicDefense: true,
          actorUuid: actor.uuid,
          authorId: game.user.id,
          defense: options.skill === 'block' ? 'blockWeapon' : options.skill,
          weaponId: weapon?.id ?? '',
          check: { base: result.base, total: result.total, dice: result.dice, fumble: result.fumble },
          fumbleResolved: false,
        }
      : {};
  const changes = { ...plan.changes, 'system.luck.value': actor.system.luck.value - luck };
  let fumble = null,
    backlash = null;
  const displayedRolls = [...result.rolls];
  if (
    skill === 'spellCasting' &&
    result.fumble &&
    ['activeAttack', 'opposition'].includes(options.pendingRole)
  ) {
    const element = options.sourceMagic?.element ?? 'mixed';
    let mixedElement = null;
    if (element === 'mixed' && result.fumble >= 7) {
      const rolled = await dice('1d4');
      displayedRolls.push(rolled);
      mixedElement = ['earth', 'air', 'fire', 'water'][rolled.total - 1];
    }
    fumble = magicalFumble({ fumble: result.fumble, element, mixedElement });
    changes['system.hp.value'] = actor.system.hp.value - fumble.damage;
    if (changes['system.hp.value'] <= 0)
      changes['system.pendingDeathSaves'] = actor.system.pendingDeathSaves + 1;
    if (fumble.condition && !magicConditionRules(actor.system, fumble.condition).immune)
      changes['system.conditions'] = [...new Set([...actor.system.conditions, fumble.condition])];
    backlash = result.fumble >= 7 ? elementalBacklash(element, { mixedElement }) : null;
  }
  const message = await commitActor(actor, changes, itemChanges, () =>
    chat(
      actor,
      options.purpose,
      checkHTML(result) +
        (flags.kind ? '<button type="button" data-witcher-action="fumble">Resolve fumble (GM)</button>' : ''),
      { rolls: displayedRolls, flags }
    )
  );
  let backlashCard;
  try {
    if (backlash?.pushMeters || fumble?.focusExplosion)
      backlashCard = await chat(
        actor,
        'Continuing magic backlash',
        '<p>Resolve the printed magical fumble before continuing.</p><button type="button" data-magic-action="backlash">Resolve backlash (GM)</button>',
        {
          flags: {
            kind: 'magic-backlash',
            actorUuid: actor.uuid,
            tokenUuid: options.tokenUuid,
            castId: options.castId ?? foundry.utils.randomID(),
            name: options.purpose,
            element: options.sourceMagic?.element ?? 'mixed',
            failed: true,
            targets: [],
            check: savedCheck(result),
            fumble,
            backlash,
            backlashResolved: false,
          },
        }
      );
  } catch (error) {
    await actor.update({ system: before.system });
    await message.delete();
    throw error;
  }
  return {
    ...result,
    spellSucceeds: fumble?.spellSucceeds,
    magicFumble: fumble,
    backlash,
    fumbleMessageUuid: flags.kind ? message.uuid : undefined,
    rollback: async () => {
      await actor.update({ system: before.system });
      if (itemChanges.length)
        await actor.updateEmbeddedDocuments('Item', [{ _id: weapon.id, 'system.reliability': beforeREL }]);
      await message.delete();
      await backlashCard?.delete();
    },
  };
}

async function reserveContinuingAction(actor, options) {
  const combat = game.combat;
  if (
    combat?.started &&
    options.action !== 'escape' &&
    options.event?.cycle &&
    options.event.cycle !== `${combat.id}:${combat.round}`
  )
    throw new RuleError('Use the current round’s magical action card.');
  const marker = actor.system.effects.find(
    (effect) => effect.magic?.castId === options.castId && effect.magic.casterEffect
  );
  if (options.maintenanceCost > 0 && (!marker || marker.magic.upkeepDue))
    throw new RuleError('Pay the spell’s upkeep from the Magic tab before using this action.');
  const before = copy(actor._source?.system ?? actor.system.toObject());
  const plan = actionPlan(actor, {
    full: options.action === 'fullRound',
    recovery: options.action === 'escape',
    actionKey: 'magicAction',
  });
  await commitActor(actor, plan.changes);
  return {
    rollback: () => actor.update({ system: before }),
    receipt: { action: options.action, eventId: options.eventId },
  };
}

async function promptContinuing(pending, { actor }) {
  if (pending.kind === 'decision')
    return prompt(
      'Magical rule condition',
      `<p>${escapeHTML(pending.reason)}</p>` +
        input('applies', 'The printed condition is fulfilled', { type: 'checkbox' }),
      { button: 'Record ruling' }
    );
  if (pending.kind === 'save') {
    if (pending.resolvedCheck)
      return prompt(
        'Finish saved magical defense',
        '<p>Resolve the saved defensive fumble first. This continues the recorded roll without rolling or charging again.</p>',
        { button: 'Finish saved defense' }
      );
    if (pending.roll === '1d10')
      return prompt(
        'Mental recovery',
        '<p>Roll one unmodified d10 strictly below current INT. This is not an exploding skill check.</p>' +
          input('manualDice', 'Entered d10 (optional)', { type: 'text' }),
        { button: 'Roll recovery' }
      );
    const skills = Array.isArray(pending.skill) ? pending.skill : [pending.skill].filter(Boolean);
    return prompt(
      'Continuing magic: resistance',
      (skills.length
        ? input('skill', 'Permitted resistance', {
            options: {
              ...Object.fromEntries(skills.map((key) => [key, key])),
              ...(pending.operation?.save ? { accept: 'Accept the hit (no defense)' } : {}),
            },
          })
        : '') +
        (skills.includes('block')
          ? input('weaponId', 'Blocking equipment', {
              options: {
                '': 'Choose equipment',
                ...Object.fromEntries(
                  [...actor.items]
                    .filter((item) => ['weapon', 'shield'].includes(item.type) && item.system.equipped)
                    .map((item) => [item.id, item.name])
                ),
              },
            })
          : '') +
        manualCheckInput() +
        input('modifier', 'Modifier', { value: 0 }) +
        input('luck', 'Luck spent', { min: 0, max: actor.system.luck.value, value: 0 }) +
        woundArmInput(actor)
    );
  }
  const answer = await prompt(
    'Continuing magical action',
    `<p>Use the printed ${pending.action} action against the selected targets. Pay any due upkeep from the Magic tab first.</p>` +
      manualCheckInput() +
      input('modifier', 'Modifier', { value: 0 }) +
      input('luck', 'Luck spent', { min: 0, max: actor.system.luck.value, value: 0 }),
    { button: 'Use action' }
  );
  return answer
    ? {
        ...answer,
        targetUuids: [...game.user.targets].map((token) => token.actor.uuid),
        turn: turnIdentity(),
      }
    : null;
}

export function registerContinuingMagicRuntime() {
  registerSpellExecutionAdapters({ createZone: createContinuingZone });
  registerMagicOngoing({
    registerCommand,
    runCommand,
    registerHooks: true,
    resolveUuid: resolve,
    rollCheck: continuingCheck,
    rollFormula: dice,
    executeOperations: executeContinuingOperations,
    reserveAction: reserveContinuingAction,
    postMessage: (data) => ChatMessage.create(data),
    schedule: (operation) => serial('witcher-authority', operation),
    isAuthority: isPrimaryActiveGm,
    onError: errorNotice,
    promptInput: promptContinuing,
    validateActionTargets: async (operations, context) => {
      const casterToken = context.tokenUuid
        ? await resolve(context.tokenUuid)
        : tokensFor(context.caster, context.scene)[0];
      if (!casterToken) throw new RuleError('The caster token is missing.');
      const targets = context.targets ?? [];
      const limit = Math.min(...operations.map((operation) => operation.maxTargets ?? Infinity));
      if (new Set(targets.map((actor) => actor.uuid)).size !== targets.length)
        throw new RuleError('Select each continuing-action target only once.');
      if (!targets.length || targets.length > limit)
        throw new RuleError(`Select between one and ${limit} targets for this magical action.`);
      for (const actor of targets) {
        const token = tokensFor(actor, casterToken.parent)[0];
        const reach = Math.min(
          ...operations.map((operation) => operation.range ?? context.sourceMagic.range.distance)
        );
        if (!token || magicTokenDistance(casterToken, token) > reach)
          throw new RuleError('A chosen target is beyond the continuing spell’s range.');
        const backend = globalThis.CONFIG?.Canvas?.polygonBackends?.sight;
        if (!backend?.testCollision) throw new RuleError('Native wall collision testing is unavailable.');
        const origin = magicTokenOrigin(casterToken),
          destination = magicTokenOrigin(token);
        if (
          origin.level !== destination.level ||
          backend.testCollision(origin, destination, {
            type: 'sight',
            mode: 'any',
            level: casterToken.parent.levels?.get(origin.level),
          })
        )
          throw new RuleError('The chosen target is outside the caster’s clear line of sight.');
      }
      return targets;
    },
  });
}
