/** GM-authoritative, persisted Verbal Combat. No HP damage or physical attack machinery. */
import { SYSTEM_ID, SKILLS } from './config.js';
import { RuleError } from './rules.js';
import { registerCommand, authorizedActor } from './authority.js';
import { actorFromUuid, actionPlan, check, dice, chat, commitActor, escapeHTML as e } from './runtime.js';
import { activeHexes } from './magic-hex-rules.js';
import { trophyRulesFor } from './magic-trophies.js';
import { ritualActionRestriction } from './magic-ritual-effects.js';
import {
  SOCIAL_ATTACKS,
  SOCIAL_TOOLS,
  validateSocialConventions,
  validateToolOpposition,
  initialResolve,
  socialMove,
  socialStat,
  socialDamage,
  verbalDefenseResult,
  cumulativeDamage,
  socialModifiers,
  socialReputation,
  relationshipUpdate,
  studyExpiry,
} from './social-rules.js';

const copy = (value) => foundry.utils.deepClone(value);
const now = () => game.time.worldTime;
const randomID = () => foundry.utils.randomID();
const trophyFor = (actor) => trophyRulesFor({ ...actor.system, uuid: actor.uuid, items: [...actor.items] });
const gmOnly = (user) => {
  if (!user.isGM) throw new RuleError('The GM records this verbal-combat ruling.');
};
const number = (value = 0) => {
  const n = Number(value);
  if (!Number.isFinite(n)) throw new RuleError('A modifier must be finite.');
  return n;
};
const savedCheck = ({ rolls, ...result }) => copy(result);
const member = (state, uuid) => {
  const row = state.participants.find((row) => row.actorUuid === uuid);
  if (!row) throw new RuleError('This actor is not in the argument.');
  return row;
};
const active = (state, uuid) => {
  const row = member(state, uuid);
  if (row.status !== 'active') throw new RuleError('This participant has left or lost the argument.');
  return row;
};
async function encounterFor(uuid, revision) {
  const message = await foundry.utils.fromUuid(uuid),
    data = message?.flags?.[SYSTEM_ID];
  if (!message?.author?.isGM || data?.kind !== 'socialCombat')
    throw new RuleError('Choose an authoritative Verbal Combat card.');
  const state = copy(data);
  if (revision !== undefined && revision !== state.revision)
    throw new RuleError('The argument changed. Reopen its card.');
  synchronizeClock(state);
  return { message, state };
}
function synchronizeClock(state) {
  if (
    state.conventions?.timing !== 'foundryCombat' ||
    game.combat?.id !== state.combatId ||
    !game.combat.started
  )
    return;
  state.clockTurns = game.combat.turns?.length || game.combat.combatants?.size || state.order.length;
  state.clockTurn = game.combat.turn ?? 0;
  state.round = game.combat.round;
  state.turnSerial = (state.round - 1) * state.clockTurns + state.clockTurn;
  const index = state.order.indexOf(game.combat.combatant?.actor?.uuid);
  if (index >= 0) state.turnIndex = index;
}
export function socialActorDisplay(actor) {
  const encounters = [...(game.messages ?? [])]
    .filter((message) => message.flags?.[SYSTEM_ID]?.kind === 'socialCombat')
    .map((message) => ({ message, state: message.flags[SYSTEM_ID] }))
    .filter(({ state }) => state.participants.some((row) => row.actorUuid === actor.uuid))
    .map(({ message, state }) => ({
      messageUuid: message.uuid,
      name: state.name,
      status: state.status,
      resolve: member(state, actor.uuid).resolve,
      maxResolve: member(state, actor.uuid).maxResolve,
      goal: member(state, actor.uuid).goal,
      isTurn: state.order[state.turnIndex] === actor.uuid,
      pending: !!state.pending,
    }));
  const allActors = [
    ...(game.actors ?? []),
    ...[...(game.scenes ?? [])].flatMap((scene) =>
      [...(scene.tokens ?? [])].map((token) => token.actor).filter(Boolean)
    ),
  ];
  return {
    encounters,
    relationships: copy(actor.system.social?.relationships ?? []).map((row) => ({
      ...row,
      otherName: allActors.find((entry) => entry.uuid === row.otherUuid)?.name ?? row.otherUuid,
      friendshipLabel:
        ['No friendship', 'Acquaintance', 'Dedicated friend', 'Blood-brother'][row.friendship ?? 0] ??
        'Friend',
      romanceLabel: {
        active: 'In love with this person (−3)',
        bitter: 'Romance ended badly (+3 against their empathetic attacks)',
        none: 'No Romance',
      }[row.romance ?? 'none'],
    })),
    reputationEffects: copy(
      (actor.system.social?.reputationEffects ?? []).filter((row) => row.expires > now())
    ).map((row) => ({
      ...row,
      audienceLabel: row.audienceId,
      value: row.amount,
      remainingHours: Math.max(0, (row.expires - now()) / 3600),
    })),
  };
}
export function socialCard(state) {
  const pending = state.pending;
  const rows = state.participants
    .map(
      (row) =>
        `<li><strong>${e(row.name)}</strong>: ${row.resolve}/${row.maxResolve} Resolve · ${e(row.status)}<br>Goal: ${e(row.goal)}</li>`
    )
    .join('');
  const awaiting =
    pending?.targets
      .filter((row) => !row.defense)
      .map(
        (row) =>
          `<button data-social-action="defend" data-social-actor="${e(row.actorUuid)}">${e(member(state, row.actorUuid).name)}: defend</button>`
      )
      .join('') ?? '';
  const last = state.history.at(-1);
  return `<article class="witcher-chat"><h3>${e(state.name)} · Verbal Combat</h3><p>${e(state.status)} · round ${state.round}. ${state.status === 'active' ? `Turn: ${e(member(state, state.order[state.turnIndex]).name)}` : ''}</p><ul>${rows}</ul>${pending ? `<p>${e(member(state, pending.actorUuid).name)}: ${e(pending.move.name)}. ${pending.targets.map((row) => `${e(member(state, row.actorUuid).name)}: check ${row.check.total}`).join('; ')}</p>${awaiting}` : ''}${last ? `<p>${e(last.summary ?? '')}</p>` : ''}<button data-social-action="open">Argument / history</button>${state.status === 'active' && !pending ? '<button data-social-action="declare">Attack / tool</button>' : ''}</article>`;
}
async function saveEncounter(message, state) {
  const before = { content: message.content, [`flags.${SYSTEM_ID}`]: copy(message.flags[SYSTEM_ID]) };
  state.revision++;
  try {
    await message.update({ content: socialCard(state), [`flags.${SYSTEM_ID}`]: state });
  } catch (error) {
    try {
      await message.update(before);
    } catch (restore) {
      throw new AggregateError(
        [error, restore],
        'Verbal Combat receipt restoration failed; GM review is required.'
      );
    }
    throw error;
  }
  return message;
}
async function commitMany(plans, after) {
  const [plan, ...rest] = [...plans.values()];
  if (!plan) return after();
  return commitActor(plan.actor, plan.changes, [], () =>
    commitMany(new Map(rest.map((row) => [row.actor.uuid, row])), after)
  );
}
function changesFor(plans, actor) {
  if (!plans.has(actor.uuid)) plans.set(actor.uuid, { actor, changes: {} });
  return plans.get(actor.uuid).changes;
}
function socialState(actor, changes) {
  return {
    ...actor.system,
    social: {
      ...(actor.system.social ?? {}),
      relationships: changes['system.social.relationships'] ?? actor.system.social?.relationships ?? [],
      reputationEffects:
        changes['system.social.reputationEffects'] ?? actor.system.social?.reputationEffects ?? [],
    },
  };
}
function checkTurn(state, actor) {
  if (state.status !== 'active' || state.pending)
    throw new RuleError('Finish the current exchange before acting.');
  active(state, actor.uuid);
  if (state.conventions.timing === 'foundryCombat') {
    if (
      !game.combat?.started ||
      game.combat.id !== state.combatId ||
      game.combat.combatant?.actor?.uuid !== actor.uuid
    )
      throw new RuleError('Use the linked Foundry Combat on this actor’s turn.');
  } else if (state.order[state.turnIndex] !== actor.uuid)
    throw new RuleError('Wait for this participant’s verbal turn.');
}
function actionCost(state, actor, { defense = false, tool = false, values = {} } = {}) {
  // Reanimation explicitly permits a dead soul to speak without resurrecting it.
  const reanimated = actor.system.effects?.some((effect) => effect.magic?.rule?.key === 'reanimated-corpse');
  const acting = reanimated
    ? {
        ...actor,
        system: { ...actor.system, conditions: actor.system.conditions.filter((key) => key !== 'dead') },
      }
    : actor;
  const free =
    state.conventions.timing === 'verbalTurns' || (defense && state.conventions.repeatedDefenses === 'free');
  if (free && values.extra)
    throw new RuleError('Extra actions need the recorded Foundry Combat timing convention.');
  return actionPlan(acting, {
    reaction: free,
    defense,
    full: tool,
    extra: !!values.extra,
    forfeit: !!values.forfeit,
    actionKey: defense ? 'verbalDefense' : 'verbalAttack',
  });
}
function advance(state) {
  if (state.status !== 'active') return;
  if (new Set(state.participants.filter((row) => row.status === 'active').map((row) => row.side)).size < 2) {
    state.status = 'complete';
    state.endedAt = now();
    return;
  }
  if (state.conventions.timing === 'foundryCombat') {
    synchronizeClock(state);
    return;
  }
  do {
    state.turnIndex = (state.turnIndex + 1) % state.order.length;
    state.turnSerial++;
    if (state.turnIndex === 0) state.round++;
  } while (member(state, state.order[state.turnIndex]).status !== 'active');
  state.effects = state.effects.filter(
    (row) => row.expiresTurn === undefined || row.expiresTurn > state.turnSerial
  );
}
function validateTarget(state, source, target) {
  if (!target?.system) throw new RuleError('The opposing actor no longer exists.');
  const sourceRow = active(state, source.uuid),
    targetRow = active(state, target.uuid);
  if (sourceRow.side === targetRow.side || source.uuid === target.uuid)
    throw new RuleError('Choose an active opposing participant.');
  const profile = state.context[source.uuid]?.[target.uuid] ?? {};
  if (
    target.flags?.[SYSTEM_ID]?.ritualCreature?.unbound &&
    !target.system.effects.some((effect) => effect.magic?.boundCannotAttack) &&
    !profile.demonDealBeneficial
  )
    throw new RuleError(
      'An unbound demon needs a recorded bargain beneficial to it; social victory cannot waive that restriction.'
    );
  if (target.system.category === 'beast') {
    if (!trophyFor(source).verbalCombatAnimals && !profile.communicationEvidence)
      throw new RuleError(
        'Verbal Combat with this beast requires the actual Leshen trophy or a GM-recorded communication source.'
      );
    if (!profile.animalGoalAllowed)
      throw new RuleError(
        'Record that the animal would do this for itself; Leshen cannot compel an otherwise refused act.'
      );
  }
  if (target.system.traits?.mindless && !profile.communicationEvidence)
    throw new RuleError('A mindless target needs a real, recorded means of communication and a valid goal.');
}
function rollBase(state, source, target, move, values, { defense = false, actionModifier = 0 } = {}) {
  const context = state.context[source.uuid]?.[target.uuid] ?? {};
  const result = socialModifiers(state, source, target, move, {
    defense,
    time: now(),
    standing: context.standing ?? 'equal',
    feared: !!context.feared,
    standingHandled: activeHexes(source.system).has('the-odious-hex'),
    trophy: trophyFor(source),
  });
  const modifier = number(values.modifier) + actionModifier + result.total + number(values.luck);
  return {
    base: source.skillBase(move.skill, {
      modifier,
      context: { socialStanding: result.standing, intimacy: !!context.intimacy, stressed: true },
    }).total,
    modifiers: [
      ...result.modifiers,
      ...(number(values.modifier) ? [{ label: 'Situational', value: number(values.modifier) }] : []),
      ...(actionModifier ? [{ label: 'Action', value: actionModifier }] : []),
      ...(number(values.luck) ? [{ label: 'Luck', value: number(values.luck) }] : []),
    ],
  };
}
function luckChanges(actor, values, changes) {
  const luck = number(values.luck);
  if (!Number.isInteger(luck) || luck < 0 || luck > actor.system.luck.value)
    throw new RuleError('Invalid Luck expenditure.');
  if (luck) changes['system.luck.value'] = actor.system.luck.value - luck;
}
function adjustCheck(result, base) {
  return {
    ...savedCheck(result),
    base,
    total: result.fumble ? Math.max(0, base - result.fumble) : result.total + base - result.base,
  };
}
async function startEncounter(payload, { user, id }) {
  gmOnly(user);
  const conventions = validateSocialConventions(payload.conventions);
  if (!payload.conventionsConfirmed)
    throw new RuleError('Confirm the displayed interpretations of the book’s ambiguous cases.');
  if (!Array.isArray(payload.participants) || payload.participants.length < 2)
    throw new RuleError('Choose at least two participants.');
  if (new Set(payload.participants.map((row) => row.actorUuid)).size !== payload.participants.length)
    throw new RuleError('An actor can participate only once in an argument.');
  const participants = [];
  for (const row of payload.participants) {
    const actor = await actorFromUuid(row.actorUuid);
    if (!actor?.system || !row.goal?.trim() || !row.side?.trim())
      throw new RuleError('Each actual participant needs a side and a stated goal.');
    const resolve = initialResolve(actor, conventions.resolveRounding);
    if (resolve <= 0) throw new RuleError('Participants need positive starting Resolve.');
    participants.push({
      actorUuid: actor.uuid,
      name: actor.name,
      side: row.side.trim(),
      goal: row.goal.trim(),
      maxResolve: resolve,
      resolve,
      status: 'active',
      reputationSkills: (row.reputationSkills ?? []).filter((key) => SKILLS[key]),
      reputationType: String(row.reputationType ?? ''),
      speechEvidence: String(row.speechEvidence ?? ''),
    });
  }
  if (new Set(participants.map((row) => row.side)).size < 2)
    throw new RuleError('An argument needs opposing sides.');
  const state = {
    kind: 'socialCombat',
    id,
    version: 1,
    revision: 0,
    name: payload.name?.trim() || 'Argument',
    status: 'active',
    participants,
    conventions,
    conventionReason: String(payload.conventionReason ?? ''),
    order: participants.map((row) => row.actorUuid),
    turnIndex: 0,
    turnSerial: 0,
    round: 1,
    combatId: conventions.timing === 'foundryCombat' ? game.combat?.id : '',
    audienceId: String(payload.audienceId ?? '').trim(),
    public: !!payload.public,
    context: copy(payload.context ?? {}),
    toolOpposition: {},
    effects: [],
    counters: {},
    torture: [],
    implyUsed: [],
    knownReputations: [],
    pending: null,
    history: [],
    outcomes: [],
    startedAt: now(),
  };
  if (conventions.timing === 'foundryCombat' && !game.combat?.started)
    throw new RuleError('Start the actual Foundry Combat before linking verbal turns.');
  for (const [key, value] of Object.entries(payload.toolOpposition ?? {})) {
    if (!['romance', 'imply', 'bribe'].includes(key)) throw new RuleError('Unknown tool opposition.');
    state.toolOpposition[key] = validateToolOpposition(value);
  }
  if (state.public && !state.audienceId)
    throw new RuleError('Name the public audience whose Reputation may change.');
  return chat(await actorFromUuid(participants[0].actorUuid), state.name, socialCard(state), {
    flags: state,
  });
}
async function declare(
  { messageUuid, revision, actorUuid, move: key, targetUuids, values = {} },
  { user, id }
) {
  const { message, state } = await encounterFor(messageUuid, revision),
    actor = await authorizedActor(actorUuid, user);
  checkTurn(state, actor);
  const move = socialMove(key, { skill: values.skill });
  if (move.damageStat) move.damageValue = socialStat(actor, move.damageStat);
  if (!Array.isArray(targetUuids) || !targetUuids.length || new Set(targetUuids).size !== targetUuids.length)
    throw new RuleError('Choose each opponent once.');
  if (move.tool && targetUuids.length !== 1) throw new RuleError('Tools require one named opponent.');
  const targets = [];
  for (const uuid of targetUuids) {
    const target = await actorFromUuid(uuid);
    validateTarget(state, actor, target);
    targets.push(target);
  }
  if (key === 'imply' && state.implyUsed.includes(actorUuid))
    throw new RuleError('Imply has already been used in this argument.');
  if (key === 'bribe' && !(number(values.offer) > 0))
    throw new RuleError(
      'Offer a positive amount of Crowns. Funds are checked when the offer is transferred.'
    );
  const opposition = !move.tool
    ? null
    : key === 'study'
      ? { kind: 'dc', dc: socialStat(targets[0], 'int') * 3, reason: 'Core p.177: INT × 3' }
      : validateToolOpposition(state.toolOpposition[key]);
  const action = actionCost(state, actor, { tool: move.tool, values }),
    plans = new Map();
  Object.assign(changesFor(plans, actor), action.changes);
  luckChanges(actor, values, changesFor(plans, actor));
  const bases = targets.map((target) =>
    rollBase(state, actor, target, move, values, { actionModifier: action.modifier })
  );
  const roll = await check(bases[0].base, {
    actor,
    manualDice: values.manualDice,
    context: { skill: move.skill, stressed: true },
  });
  const exchange = {
    id,
    actorUuid,
    move,
    offer: key === 'bribe' ? number(values.offer) : 0,
    opposition,
    declaredAt: now(),
    turnSerial: state.turnSerial,
    status: 'pending',
    targets: targets.map((target, index) => ({
      actorUuid: target.uuid,
      check: adjustCheck(roll, bases[index].base),
      modifiers: bases[index].modifiers,
      defense: null,
    })),
  };
  if (key === 'imply' && state.conventions.implyUse === 'attempt') state.implyUsed.push(actorUuid);
  state.pending = exchange;
  if (opposition?.kind === 'dc') {
    exchange.targets[0].defense = {
      move: { key: 'dc', name: `DC ${opposition.dc}` },
      check: { total: opposition.dc },
      fixed: true,
    };
    await resolveExchange(state, plans);
  }
  return commitMany(plans, () => saveEncounter(message, state));
}
async function defend({ messageUuid, revision, actorUuid, defense, counterAttack, values = {} }, { user }) {
  const { message, state } = await encounterFor(messageUuid, revision),
    actor = await authorizedActor(actorUuid, user);
  const exchange = state.pending,
    row = exchange?.targets.find((row) => row.actorUuid === actorUuid);
  if (!row || row.defense) throw new RuleError('This participant has no pending verbal defense.');
  if (exchange.kind === 'faceDown') return defendFaceDown({ message, state, actor, values });
  active(state, actorUuid);
  const attacker = await actorFromUuid(exchange.actorUuid),
    plans = new Map();
  if (defense === 'accept')
    row.defense = { move: { key: 'accept', name: 'Accept' }, accepted: true, check: { total: 0 } };
  else {
    const move = exchange.move.tool
      ? { key: 'toolDefense', name: 'Tool opposition', skill: exchange.opposition.skill }
      : socialMove(defense, { defense: true, counterAttack });
    move.incomingFamily = exchange.move.family;
    if (move.damageStat) move.damageValue = socialStat(actor, move.damageStat);
    const action = actionCost(state, actor, { defense: true, values });
    Object.assign(changesFor(plans, actor), action.changes);
    luckChanges(actor, values, changesFor(plans, actor));
    const base = rollBase(state, actor, attacker, move, values, {
      defense: true,
      actionModifier: action.modifier,
    });
    let result = await check(base.base, {
      actor,
      manualDice: values.manualDice,
      context: { skill: move.skill, stressed: true, dc: row.check.total },
    });
    let reroll = null;
    if (values.stubborn && result.total < row.check.total) {
      if (actor.system.race !== 'human' || move.skill !== 'resistCoercion')
        throw new RuleError('Blindly Stubborn requires a human’s failed Resist Coercion check.');
      const used = Number(actor.flags?.[SYSTEM_ID]?.socialStubbornUses ?? 0);
      if (used >= 3) throw new RuleError('All three Blindly Stubborn uses have been spent this session.');
      reroll = await check(base.base, {
        actor,
        manualDice: values.rerollDice,
        context: { skill: move.skill, stressed: true, dc: row.check.total },
      });
      changesFor(plans, actor)[`flags.${SYSTEM_ID}.socialStubbornUses`] = used + 1;
      if (reroll.total > result.total) [result, reroll] = [reroll, result];
    }
    row.defense = {
      move,
      check: savedCheck(result),
      modifiers: base.modifiers,
      reroll: reroll ? savedCheck(reroll) : null,
    };
  }
  if (exchange.targets.every((row) => row.defense)) await resolveExchange(state, plans);
  return commitMany(plans, () => saveEncounter(message, state));
}
async function resolveExchange(state, plans) {
  const exchange = state.pending,
    source = await actorFromUuid(exchange.actorUuid),
    results = [];
  const rollCache = new Map();
  for (const row of exchange.targets) {
    if (state.conventions.groupResolution === 'ordered' && member(state, source.uuid).resolve <= 0) {
      results.push({
        targetUuid: row.actorUuid,
        skipped: true,
        reason: 'Attacker lost before this ordered response.',
      });
      continue;
    }
    const target = await actorFromUuid(row.actorUuid),
      defense = row.defense;
    const outcome = defense.accepted
      ? { defended: false, returnEffect: false }
      : defense.fixed
        ? { defended: row.check.total <= defense.check.total, returnEffect: false }
        : verbalDefenseResult(row.check.total, defense.check.total, state.conventions.tiedDefense);
    if (exchange.move.tool) {
      if (!outcome.defended) await applyTool(state, exchange, source, target, plans);
      results.push({ targetUuid: target.uuid, ...outcome, damage: 0 });
      continue;
    }
    const winner = outcome.defended ? target : source,
      loser = outcome.defended ? source : target;
    const move = outcome.defended ? defense.move : exchange.move;
    if (outcome.defended && !outcome.returnEffect) {
      results.push({ targetUuid: target.uuid, ...outcome, damage: 0 });
      continue;
    }
    if (move.key === 'disengage') {
      if (state.conventions.disengage === 'encounter') {
        state.status = 'disengaged';
        state.endedAt = now();
      } else member(state, winner.uuid).status = 'disengaged';
      results.push({ targetUuid: target.uuid, ...outcome, damage: 0, disengaged: true });
      continue;
    }
    const cacheKey =
      winner.uuid === source.uuid && state.conventions.multiDamage === 'shared'
        ? 'attack'
        : `${winner.uuid}>${loser.uuid}`;
    if (!rollCache.has(cacheKey)) rollCache.set(cacheKey, (await dice(`1d${move.die}`)).total);
    const die = rollCache.get(cacheKey);
    const trigger = state.conventions.cumulativeTiming === 'triggeringHit';
    const extra = cumulativeDamage(state, winner.uuid, loser.uuid, move, { increment: trigger });
    const damage = socialDamage(move, winner, die, state.conventions.halfDamage) + extra;
    if (!trigger) cumulativeDamage(state, winner.uuid, loser.uuid, move, { increment: true });
    const loserRow = member(state, loser.uuid),
      before = loserRow.resolve;
    loserRow.resolve = Math.max(0, before - damage);
    if (move.key === 'ridicule' && state.public) {
      const changes = changesFor(plans, loser),
        current = socialState(loser, changes);
      changes['system.social.reputationEffects'] = [
        ...current.social.reputationEffects,
        {
          id: `${exchange.id}:${winner.uuid}:${loser.uuid}`,
          audienceId: state.audienceId,
          amount: -2,
          expires: now() + 86400,
          source: 'Ridicule',
          encounterId: state.id,
        },
      ];
    }
    if (loserRow.resolve === 0) {
      loserRow.status = 'lost';
      const goal = member(state, winner.uuid).goal;
      state.outcomes.push({
        exchangeId: exchange.id,
        winnerUuid: winner.uuid,
        loserUuid: loser.uuid,
        goal,
        move: move.key,
        time: now(),
        simultaneous: state.conventions.groupResolution === 'simultaneous',
      });
      if (move.key === 'befriend' && before > 0) {
        const changes = changesFor(plans, loser);
        changes['system.social.relationships'] = relationshipUpdate(
          socialState(loser, changes),
          winner.uuid,
          'befriend',
          state.id
        );
      }
    }
    results.push({
      targetUuid: row.actorUuid,
      winnerUuid: winner.uuid,
      loserUuid: loser.uuid,
      ...outcome,
      move: move.key,
      die,
      damage,
      cumulative: extra,
      before,
      after: loserRow.resolve,
    });
  }
  exchange.status = 'resolved';
  exchange.results = results;
  exchange.summary = `${exchange.move.name}: ${results.map((row) => (row.skipped ? row.reason : `${member(state, row.targetUuid).name}: ${row.defended ? 'defended' : 'successful'}${row.damage ? `, ${row.damage} Resolve` : ''}`)).join('; ')}`;
  state.history.push(exchange);
  state.pending = null;
  advance(state);
}
async function applyTool(state, exchange, source, target, plans) {
  const { key } = exchange.move;
  if (key === 'romance') {
    const changes = changesFor(plans, target);
    changes['system.social.relationships'] = relationshipUpdate(
      socialState(target, changes),
      source.uuid,
      'romance',
      state.id
    );
  } else if (key === 'study')
    state.effects.push({
      kind: 'study',
      actorUuid: source.uuid,
      targetUuid: state.conventions.studyScope === 'target' ? target.uuid : '',
      expiresTurn: studyExpiry(state),
      exchangeId: exchange.id,
    });
  else if (key === 'imply') {
    if (!state.implyUsed.includes(source.uuid)) state.implyUsed.push(source.uuid);
    state.effects.push({ kind: 'imply', actorUuid: target.uuid, exchangeId: exchange.id });
  } else if (key === 'bribe') {
    const bonus =
      state.conventions.bribeIncrements === 'whole' ? Math.floor(exchange.offer / 50) : exchange.offer / 50;
    const targetUuid = state.conventions.bribeScope === 'target' ? target.uuid : '';
    if (state.conventions.repeatedBribes === 'replace')
      state.effects = state.effects.filter(
        (row) => !(row.kind === 'bribe' && row.actorUuid === source.uuid && row.targetUuid === targetUuid)
      );
    state.effects.push({
      kind: 'bribe',
      actorUuid: source.uuid,
      targetUuid,
      recipientUuid: target.uuid,
      bonus,
      offer: exchange.offer,
      transferred: false,
      exchangeId: exchange.id,
    });
  }
}

async function recordRuling({ messageUuid, revision, kind, actorUuid, targetUuid, values = {} }, { user }) {
  gmOnly(user);
  const { message, state } = await encounterFor(messageUuid, revision),
    plans = new Map();
  if (state.pending && kind !== 'end')
    throw new RuleError('Finish the pending exchange before changing its rulings.');
  if (kind === 'tool') {
    if (!['romance', 'imply', 'bribe'].includes(values.move))
      throw new RuleError('Choose a tool with unprinted opposition.');
    state.toolOpposition[values.move] = validateToolOpposition(values);
  } else if (kind === 'context') {
    member(state, actorUuid);
    member(state, targetUuid);
    if (!['equal', 'tolerated', 'hated'].includes(values.standing))
      throw new RuleError('Choose a valid standing.');
    state.context[actorUuid] ??= {};
    state.context[actorUuid][targetUuid] = {
      standing: values.standing,
      feared: !!values.feared,
      intimacy: !!values.intimacy,
      demonDealBeneficial: values.demonDealBeneficial === true,
      animalGoalAllowed: values.animalGoalAllowed === true,
      communicationEvidence: String(values.communicationEvidence ?? ''),
    };
  } else if (kind === 'torture') {
    const victim = await actorFromUuid(targetUuid);
    member(state, actorUuid);
    member(state, targetUuid);
    const restriction = ritualActionRestriction(victim, 'torture');
    if (restriction) throw new RuleError(restriction);
    if (!values.atMercy || !String(values.evidence ?? '').trim())
      throw new RuleError('Record the actual damage and why the target is at this interrogator’s mercy.');
    const receipt = values.damageMessageUuid ? await foundry.utils.fromUuid(values.damageMessageUuid) : null;
    const damage = receipt?.flags?.[SYSTEM_ID];
    if (
      values.damageMessageUuid &&
      !(
        receipt?.author?.isGM &&
        damage?.kind === 'damage' &&
        damage.applied &&
        damage.targetUuid === targetUuid &&
        damage.summary?.some((row) => row.damage > 0)
      )
    )
      throw new RuleError('Choose an applied actual damage receipt for this victim.');
    const threshold = victim.system.derived?.woundThreshold ?? Math.floor(victim.system.hp.max / 5);
    const severe =
      state.conventions.tortureThreshold === 'atOrBelow'
        ? victim.system.hp.value <= threshold
        : victim.system.hp.value < threshold;
    state.torture = state.torture.filter(
      (row) => !(row.actorUuid === actorUuid && row.targetUuid === targetUuid)
    );
    state.torture.push({
      actorUuid,
      targetUuid,
      severe,
      evidence: values.evidence,
      damageMessageUuid: receipt?.uuid ?? '',
      recordedAt: now(),
    });
  } else if (kind === 'endRomance') {
    const actor = await actorFromUuid(actorUuid);
    member(state, actorUuid);
    member(state, targetUuid);
    changesFor(plans, actor)['system.social.relationships'] = relationshipUpdate(
      actor,
      targetUuid,
      values.badly ? 'bitter' : 'endRomance',
      state.id
    );
  } else if (kind === 'knownReputation') {
    member(state, actorUuid);
    member(state, targetUuid);
    if (!String(values.reason ?? '').trim())
      throw new RuleError('Record how this observer already knows the Reputation.');
    const key = `${actorUuid}>${targetUuid}`;
    if (!state.knownReputations.includes(key)) state.knownReputations.push(key);
  } else if (kind === 'resetStubborn') {
    const actor = await actorFromUuid(actorUuid);
    member(state, actorUuid);
    changesFor(plans, actor)[`flags.${SYSTEM_ID}.socialStubbornUses`] = 0;
  } else if (kind === 'end') {
    if (!String(values.reason ?? '').trim()) throw new RuleError('Record why this argument ended.');
    if (state.pending) {
      state.history.push({
        ...state.pending,
        status: 'cancelled',
        summary: `Pending exchange cancelled: ${values.reason}`,
      });
      state.pending = null;
    }
    state.status = 'ended';
    state.endedAt = now();
    state.endReason = values.reason;
  } else throw new RuleError('Unknown verbal-combat ruling.');
  state.history.push({
    id: randomID(),
    kind: 'ruling',
    summary: `${kind}: ${values.reason ?? values.evidence ?? values.move ?? ''}`,
    values: copy(values),
    actorUuid,
    targetUuid,
  });
  return commitMany(plans, () => saveEncounter(message, state));
}
async function transferBribe({ messageUuid, revision, exchangeId }, { user }) {
  gmOnly(user);
  const { message, state } = await encounterFor(messageUuid, revision);
  const offer = state.effects.find((row) => row.kind === 'bribe' && row.exchangeId === exchangeId);
  if (!offer || offer.transferred) throw new RuleError('Choose one successful, unpaid bribe offer.');
  const source = await actorFromUuid(offer.actorUuid),
    target = await actorFromUuid(offer.recipientUuid),
    plans = new Map();
  if (source.system.coins < offer.offer) throw new RuleError('The offered Crowns are no longer available.');
  changesFor(plans, source)['system.coins'] = source.system.coins - offer.offer;
  changesFor(plans, target)['system.coins'] = target.system.coins + offer.offer;
  offer.transferred = true;
  offer.transferredAt = now();
  return commitMany(plans, () => saveEncounter(message, state));
}
export function registerSocialCommands() {
  registerCommand('socialStart', startEncounter);
  registerCommand('socialDeclare', declare);
  registerCommand('socialDefense', defend);
  registerCommand('socialRuling', recordRuling);
  registerCommand('socialTransferBribe', transferBribe);
  registerCommand('socialRecognition', recognition);
  registerCommand('socialFaceDown', faceDown);
  registerCommand('socialClock', async (_, { user }) => {
    gmOnly(user);
    for (const message of game.messages ?? []) {
      const old = message.flags?.[SYSTEM_ID];
      if (
        old?.kind !== 'socialCombat' ||
        old.status !== 'active' ||
        old.conventions.timing !== 'foundryCombat'
      )
        continue;
      const next = copy(old);
      synchronizeClock(next);
      if (next.turnSerial !== old.turnSerial || next.turnIndex !== old.turnIndex)
        await saveEncounter(message, next);
    }
  });
}

function effectiveReputation(state, actor) {
  const row = member(state, actor.uuid);
  return socialReputation(actor, {
    audienceId: state.audienceId,
    monsterSlayer: row.reputationType === 'monster-slayer',
    trophyBonus: trophyFor(actor).reputation,
    time: now(),
  });
}
async function simpleD10(manualDice) {
  if (manualDice !== undefined && manualDice !== '') {
    const value = Number(manualDice);
    if (!Number.isInteger(value) || value < 1 || value > 10)
      throw new RuleError('Enter one ordinary d10 face, 1–10.');
    return value;
  }
  return (await dice('1d10')).total;
}
async function recognition({ messageUuid, revision, actorUuid, targetUuid, manualDice }, { user }) {
  const { message, state } = await encounterFor(messageUuid, revision),
    observer = await authorizedActor(actorUuid, user),
    subject = await actorFromUuid(targetUuid);
  if (state.pending || state.status !== 'active')
    throw new RuleError('Finish the current exchange before checking Reputation.');
  member(state, observer.uuid);
  member(state, subject.uuid);
  const key = `${observer.uuid}>${subject.uuid}`;
  if (
    state.history.some(
      (entry) =>
        entry.kind === 'recognition' && entry.actorUuid === observer.uuid && entry.targetUuid === subject.uuid
    )
  )
    throw new RuleError('This observer already checked this Reputation in the current encounter.');
  const rep = effectiveReputation(state, subject),
    die = await simpleD10(manualDice);
  const recognized = die <= (state.conventions.negativeRecognition === 'absolute' ? Math.abs(rep) : rep);
  if (recognized && !state.knownReputations.includes(key)) state.knownReputations.push(key);
  state.history.push({
    id: randomID(),
    kind: 'recognition',
    actorUuid,
    targetUuid,
    die,
    reputation: rep,
    recognized,
    summary: `${observer.name} ${recognized ? 'recognizes' : 'does not recognize'} ${subject.name}: d10 ${die}, Reputation ${rep}.`,
  });
  return saveEncounter(message, state);
}
async function faceDown({ messageUuid, revision, actorUuid, targetUuid, values = {} }, { user, id }) {
  const { message, state } = await encounterFor(messageUuid, revision),
    actor = await authorizedActor(actorUuid, user),
    target = await actorFromUuid(targetUuid);
  if (state.pending || state.status !== 'active')
    throw new RuleError('Finish the current exchange before a Face-Down.');
  validateTarget(state, actor, target);
  if (!state.knownReputations.includes(`${targetUuid}>${actorUuid}`))
    throw new RuleError('The opponent must already know this actor’s Reputation.');
  if (
    state.conventions.faceDownFrequency === 'oncePerOpponent' &&
    state.history.some(
      (row) =>
        row.kind === 'faceDown' &&
        row.actorUuid === actorUuid &&
        row.targets.some((entry) => entry.actorUuid === targetUuid)
    )
  )
    throw new RuleError('This encounter permits one Face-Down per opponent.');
  const die = await simpleD10(values.manualDice),
    reputation = effectiveReputation(state, actor),
    base = socialStat(actor, 'will') + reputation;
  state.pending = {
    id,
    kind: 'faceDown',
    actorUuid,
    move: { key: 'faceDown', name: 'Reputation Face-Down' },
    reputation,
    declaredAt: now(),
    targets: [
      { actorUuid: targetUuid, check: { total: base + die, base, dice: [die], fumble: 0 }, defense: null },
    ],
  };
  return saveEncounter(message, state);
}
async function defendFaceDown({ message, state, actor, values }) {
  const exchange = state.pending,
    row = exchange.targets[0],
    source = await actorFromUuid(exchange.actorUuid);
  const die = await simpleD10(values.manualDice),
    reputation = effectiveReputation(state, actor),
    base = socialStat(actor, 'will') + reputation;
  row.defense = {
    move: { key: 'faceDown', name: 'Reputation Face-Down' },
    check: { total: base + die, base, dice: [die], fumble: 0 },
    reputation,
  };
  const defended = row.defense.check.total >= row.check.total,
    winner = defended ? actor : source,
    loser = defended ? source : actor;
  const winnerRep = defended ? reputation : exchange.reputation;
  if (winnerRep > 0) {
    const skills = member(state, winner.uuid).reputationSkills;
    state.effects = state.effects.filter(
      (effect) =>
        !(
          effect.kind === 'reputation' &&
          effect.actorUuid === winner.uuid &&
          effect.targetUuid === loser.uuid
        )
    );
    state.effects.push({
      kind: 'reputation',
      actorUuid: winner.uuid,
      targetUuid: loser.uuid,
      skills: [...skills],
      exchangeId: exchange.id,
    });
  }
  exchange.status = 'resolved';
  exchange.winnerUuid = winner.uuid;
  exchange.summary = `${winner.name} wins the Reputation Face-Down${winnerRep > 0 ? ': +3 only to the recorded relevant skills against this opponent' : '; negative Reputation grants no +3'}.`;
  state.history.push(exchange);
  state.pending = null;
  return saveEncounter(message, state);
}

/** Linking this receipt to a demon's binding never substitutes a prose claim for an actual victory. */
export async function validatedSocialVictory(messageUuid, { winnerUuid, loserUuid, goal } = {}) {
  const { state } = await encounterFor(messageUuid);
  if (state.pending) throw new RuleError('Finish the pending verbal exchange before recording its outcome.');
  const victories = state.outcomes.filter(
    (row) => row.winnerUuid === winnerUuid && row.loserUuid === loserUuid
  );
  const outcome = goal === undefined ? victories.at(-1) : victories.find((row) => row.goal === goal);
  if (!outcome)
    throw new RuleError('This Verbal Combat contains no matching victory and exact agreement goal.');
  return {
    messageUuid,
    encounterId: state.id,
    exchangeId: outcome.exchangeId,
    winnerUuid,
    loserUuid,
    goal: outcome.goal,
    time: outcome.time,
  };
}
