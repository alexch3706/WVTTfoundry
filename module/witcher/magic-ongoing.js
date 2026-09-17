import { magicDefenseTotal } from './magic-focus-rules.js';
/** Authoritative continuing spell procedures. Native events are inputs, never player declarations. */
import { SYSTEM_ID } from './config.js';
import { RuleError } from './rules.js';
import { removeMagicEffects } from './magic-state.js';
import { magicInfo } from './magic-catalog.js';

const copy = (value) => structuredClone(value);
const values = (collection) => collection?.contents ?? Array.from(collection?.values?.() ?? collection ?? []);
const escape = (value) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  );
const finite = (value, name) => {
  if (!Number.isFinite(value)) throw new RuleError(`${name} must be a finite number.`);
  return value;
};
let adapters = {};
let hooksRegistered = false;
const timedKinds = new Set(['damage', 'heal', 'condition', 'resource', 'restoreWound', 'item', 'move']);
const timings = new Set([
  'startTurn',
  'enter',
  'exit',
  'enterOrStartTurn',
  'castAndEnterOnOwnTurnOrStartTurn',
  'eachMaintainedRound',
  'expiry',
  'crossTarget',
  'impact',
]);
const recoveryRules = new Set([
  'mentalRecovery',
  'illnessRecovery',
  'truthCompulsion',
  'repeatMagicDefense',
  'silenced',
  'spectralTether',
  'pacified',
  'compelledOrder',
]);
const expiryRules = new Set(['invisibility', 'pacified']);
const externalTriggers = new Set(['eatFeast']);

export const ONGOING_MAGIC_CAPABILITIES = Object.freeze({
  timings: [...timings],
  rules: [...recoveryRules, 'activeActions'],
  endRules: [...expiryRules],
  events: [
    'startTurn',
    'endTurn',
    'endRound',
    'enter',
    'exit',
    'cast',
    'crossTarget',
    'impact',
    'maintainedRound',
    'expiry',
    'targetTurn',
    'casterTurn',
    'escapeAttempt',
    'enduranceSave',
    'repeatDefense',
    'attacked',
    'casterHit',
    'casterWeaponHit',
    'eatFeast',
  ],
  actions: ['repeatSave', 'activeActions', 'escape'],
  predicates: ['hasMetalWeaponOrArmor'],
  delayed: ['arrivalRounds'],
  notes: [
    'Nested operation executors, action payment, range/target validation, and rule hooks remain independently required.',
  ],
});

function currentTime(context) {
  return finite(context.time ?? globalThis.game?.time?.worldTime ?? 0, 'World time');
}
function contextWith(context = {}) {
  return { ...adapters, ...context };
}
function requireGM(context) {
  const user = context.authorityUser ?? globalThis.game?.user ?? context.user;
  if (!user?.isGM) throw new RuleError('Only the authoritative GM can execute continuing magic.');
  if (context.isAuthority && !context.isAuthority())
    throw new RuleError('Only the elected GM can execute continuing magic.');
}
function callback(context, key) {
  if (typeof context[key] !== 'function')
    throw new RuleError(`Continuing magic requires the ${key} adapter.`);
  return context[key];
}
function operationsOf(effect) {
  return effect.magic?.operations ?? (effect.magic?.operation ? [effect.magic.operation] : []);
}
function ongoingState(effect) {
  return {
    managed: true,
    seenEvents: [],
    cursors: {},
    pending: {},
    completed: [],
    counters: {},
    ...copy(effect.magic?.ongoing ?? {}),
  };
}
function sameCast(effect, candidate) {
  return (
    candidate.id === effect.id ||
    (effect.magic.castId &&
      candidate.magic?.castId === effect.magic.castId &&
      !candidate.magic?.casterEffect &&
      !candidate.magic?.persistsAfterSource)
  );
}
function immediate(operation) {
  const result = copy(operation);
  result.timing = 'immediate';
  delete result.trigger;
  delete result.save;
  delete result.selectionChance;
  delete result.predicate;
  delete result.endsOnCasterWeaponHit;
  delete result.requiresCompletedRest;
  return result;
}
function nestedSupported(operations, supportsImmediate) {
  return !supportsImmediate || operations.every((operation) => supportsImmediate(immediate(operation)));
}

/** Reports only the continuing part; callers must also check modifier rules and nested executors. */
export function ongoingOperationSupport(operation, { supportsImmediate } = {}) {
  if (!operation || typeof operation !== 'object') return false;
  if (operation.type === 'zone')
    return (
      operation.operations?.every((child) => ongoingOperationSupport(child, { supportsImmediate })) ?? false
    );
  if (
    operation.type === 'summon' &&
    Number.isInteger(operation.arrivalRounds) &&
    operation.arrivalRounds > 0
  ) {
    const ready = { ...operation };
    delete ready.arrivalRounds;
    return !supportsImmediate || supportsImmediate(ready);
  }
  if (operation.type === 'shield' && (operation.escape || operation.breakFree))
    return saveSupported(operation.escape ?? operation.breakFree);
  const rule = operation.rule;
  if (rule?.key === 'activeActions')
    return !!rule.operations?.length && nestedSupported(rule.operations, supportsImmediate);
  if (recoveryRules.has(rule?.key)) return !!repeatDescriptor(operation);
  if (expiryRules.has(rule?.key) && (rule.endsOnHit || rule.endsIfAttacked)) return true;
  if (
    timedKinds.has(operation.type) &&
    (timings.has(operation.timing) ||
      externalTriggers.has(operation.trigger) ||
      (operation.save && (!operation.timing || operation.timing === 'immediate')))
  ) {
    if (operation.predicate && operation.predicate !== 'hasMetalWeaponOrArmor') return false;
    if (operation.save && !saveSupported(operation.save)) return false;
    return !supportsImmediate || supportsImmediate(immediate(operation));
  }
  return false;
}

function saveSupported(save) {
  return (
    !!save &&
    (save.roll === '1d10' ||
      typeof save.skill === 'string' ||
      (Array.isArray(save.skill) && save.skill.length > 0)) &&
    (save.roll === '1d10' || Number.isFinite(save.dc) || save.versus === 'newSpellCasting')
  );
}
function repeatDescriptor(operation) {
  const rule = operation.rule;
  if (!rule) return null;
  if (rule.key === 'mentalRecovery')
    return {
      ...rule,
      kind: 'save',
      when: ['startTurn', 'targetTurn'],
      success: 'endCast',
      oncePerRound: true,
    };
  if (rule.key === 'illnessRecovery')
    return {
      ...rule,
      kind: 'save',
      when: ['enduranceSave'],
      success: 'endCast',
      comparison: 'strictlyGreater',
      action: 'escape',
    };
  if (rule.key === 'truthCompulsion')
    return {
      skill: rule.repeatSkill,
      versus: rule.repeatAgainst,
      kind: 'save',
      when: ['startTurn', 'targetTurn'],
      success: 'truthNotCompelled',
      failure: 'truthCompelled',
      oncePerRound: true,
    };
  if (rule.key === 'repeatMagicDefense')
    return {
      ...rule,
      kind: 'save',
      when: ['startTurn', 'targetTurn', 'repeatDefense'],
      success: 'endCast',
      oncePerRound: true,
    };
  if (rule.repeatSave)
    return {
      ...rule.repeatSave,
      kind: 'save',
      when:
        rule.repeatSave.timing === 'endRound' ? ['endRound'] : ['startTurn', 'targetTurn', 'repeatDefense'],
      success: 'endCast',
      oncePerRound: true,
    };
  return null;
}
function eventMatches(operation, event) {
  if (operation.trigger) return operation.trigger === event.kind;
  if (operation.save && (!operation.timing || operation.timing === 'immediate')) return event.kind === 'cast';
  if (operation.timing === 'enterOrStartTurn') return ['enter', 'startTurn'].includes(event.kind);
  if (operation.timing === 'castAndEnterOnOwnTurnOrStartTurn')
    return (
      ['cast', 'startTurn'].includes(event.kind) || (event.kind === 'enter' && event.data?.ownTurn === true)
    );
  if (operation.timing === 'eachMaintainedRound')
    return event.kind === 'maintainedRound' && event.data?.maintenancePaid === true;
  return operation.timing === event.kind;
}
function eventCursor(event, actorUuid) {
  if (!Number.isFinite(event.sequence)) return null;
  return `${event.clock ?? 'event'}:${event.kind}:${actorUuid}`;
}
function validateEvent(event) {
  if (
    !event ||
    typeof event.id !== 'string' ||
    !event.id ||
    event.id.length > 1000 ||
    typeof event.kind !== 'string'
  )
    throw new RuleError('A trusted, uniquely identified magic event is required.');
  if (event.sequence !== undefined) finite(event.sequence, 'Event sequence');
}

/** Pure selection: a save is a pending procedure, never an assumed failure or success. */
export function planMagicOngoing(effect, event, { actorUuid = event.actorUuid, time = 0 } = {}) {
  validateEvent(event);
  const ongoing = ongoingState(effect);
  const marker = `${event.id}:${actorUuid ?? ''}`;
  const cursor = eventCursor(event, actorUuid);
  if (ongoing.seenEvents.includes(marker) || (cursor && ongoing.cursors[cursor] >= event.sequence))
    return { duplicate: true, procedures: [], ongoing };
  // Existing sign/healing lifecycles have their own exact counters.
  if (effect.magic?.healing || effect.magic?.repeatDefense)
    return { duplicate: true, procedures: [], ongoing };
  const procedures = [];
  const walk = (operation, path) => {
    if (operation.type === 'zone')
      return operation.operations?.forEach((child, i) => walk(child, `${path}.${i}`));
    if (
      operation.endsOnCasterWeaponHit &&
      event.kind === 'casterWeaponHit' &&
      event.data?.targetUuid === effect.magic?.casterUuid &&
      event.data?.hit === true
    )
      procedures.push({ kind: 'endCast', path });
    if (
      (operation.rule?.endsOnHit && event.kind === 'casterHit' && event.data?.hit === true) ||
      (operation.rule?.endsIfAttacked && event.kind === 'attacked')
    )
      procedures.push({ kind: 'endCast', path });
    const repeat = repeatDescriptor(operation);
    if (repeat?.when.includes(event.kind)) {
      const cycle = event.cycle ?? event.id;
      const dedupe = `${path}:save:${actorUuid}:${cycle}`;
      let due = true;
      if (repeat.intervalFormula) {
        const counter = ongoing.counters[`${path}:resistanceInterval`] ?? {
          remaining: repeat.initialDelayRounds,
          lastCycle: '',
        };
        if (!Number.isInteger(counter.remaining) || counter.remaining < 0)
          throw new RuleError('A repeated resistance interval must have its actual printed dice result.');
        if (counter.lastCycle !== cycle && counter.remaining > 0) counter.remaining--;
        counter.lastCycle = cycle;
        ongoing.counters[`${path}:resistanceInterval`] = counter;
        due =
          counter.remaining === 0 &&
          !Object.values(ongoing.pending).some((entry) => entry.path === path && entry.kind === 'save');
      }
      if (
        due &&
        !ongoing.completed.includes(dedupe) &&
        !Object.values(ongoing.pending).some((entry) => entry.dedupe === dedupe)
      )
        procedures.push({ ...repeat, path, operation, dedupe });
    }
    if (
      operation.rule?.key === 'activeActions' &&
      ['casterTurn', 'startTurn', 'turnAction'].includes(event.kind)
    ) {
      const dedupe = `${path}:action:${actorUuid}:${event.cycle ?? event.id}`;
      if (
        !ongoing.completed.includes(dedupe) &&
        !Object.values(ongoing.pending).some((entry) => entry.dedupe === dedupe)
      )
        procedures.push({
          kind: 'action',
          operation,
          path,
          dedupe,
          action: operation.rule.action ?? 'normal',
          maintenanceCost: operation.rule.maintenanceCost,
        });
    }
    if (
      operation.type === 'shield' &&
      (operation.escape || operation.breakFree) &&
      event.kind === 'escapeAttempt'
    )
      procedures.push({
        ...(operation.escape ?? operation.breakFree),
        kind: 'save',
        path,
        operation,
        action: 'escape',
        success: 'endCast',
      });
    if (operation.type === 'summon' && operation.arrivalRounds && event.kind === 'worldTime') {
      if (
        time >= (effect.magic.createdAt ?? 0) + operation.arrivalRounds * 3 &&
        !ongoing.completed.includes(`${path}:arrival`)
      ) {
        const ready = copy(operation);
        delete ready.arrivalRounds;
        procedures.push({ kind: 'execute', operation: ready, path, once: `${path}:arrival` });
      }
    }
    if (!eventMatches(operation, event)) return;
    if (
      externalTriggers.has(operation.trigger) &&
      ongoing.completed.includes(`${path}:${operation.trigger}:${actorUuid}`)
    )
      return;
    procedures.push({
      kind: operation.save ? 'save' : 'execute',
      operation,
      path,
      ...(operation.save ?? {}),
      once: externalTriggers.has(operation.trigger) ? `${path}:${operation.trigger}:${actorUuid}` : undefined,
    });
  };
  operationsOf(effect).forEach((operation, i) => walk(operation, String(i)));
  return { duplicate: false, procedures, ongoing, marker, cursor };
}

class Transaction {
  undo = [];
  receipts = [];
  async receive(result) {
    if (!result || typeof result.rollback !== 'function')
      throw new RuleError('A continuing operation must return a rollback receipt.');
    this.undo.push(result.rollback);
    this.receipts.push(result.receipt ?? result);
    return result;
  }
  async update(document, changes) {
    const source = document.toObject?.() ?? document;
    const before = {};
    for (const key of Object.keys(changes)) {
      const value = key.split('.').reduce((entry, part) => entry?.[part], source);
      if (value !== undefined) before[key] = copy(value);
      else {
        const parts = key.split('.');
        parts[parts.length - 1] = `-=${parts.at(-1)}`;
        before[parts.join('.')] = null;
      }
    }
    this.undo.push(() => document.update(before));
    await document.update(changes);
  }
  async rollback() {
    const failures = [];
    while (this.undo.length) {
      try {
        await this.undo.pop()();
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length) throw new AggregateError(failures, 'Continuing magic compensation failed.');
  }
}
async function transactional(work) {
  const tx = new Transaction();
  try {
    const result = await work(tx);
    return {
      ...result,
      rollback: () => tx.rollback(),
      receipt: { ...result?.receipt, operations: tx.receipts },
    };
  } catch (error) {
    try {
      await tx.rollback();
    } catch (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        'Continuing magic failed and could not be fully restored.'
      );
    }
    throw error;
  }
}

function actorEffectStore(actor, effectId) {
  return {
    actor,
    source: actor,
    effectId,
    read: () => actor.system.effects.find((effect) => effect.id === effectId),
    async write(ongoing, tx) {
      const effects = copy(actor.system.effects);
      const effect = effects.find((entry) => entry.id === effectId);
      if (!effect) return; // A nested operation legitimately ended this source.
      effect.magic.ongoing = ongoing;
      await tx.update(actor, { 'system.effects': effects });
    },
    async end(tx, { allCast = false } = {}) {
      const effect = this.read();
      if (!effect) return;
      const removed = removeMagicEffects(actor.system, (candidate) =>
        allCast ? sameCast(effect, candidate) : candidate.id === effect.id
      );
      await tx.update(actor, { 'system.effects': removed.effects, 'system.conditions': removed.conditions });
    },
  };
}
function regionEffectStore(region, actor) {
  return {
    actor,
    source: region,
    effectId: region.uuid,
    read: () => {
      const area = region.flags?.[SYSTEM_ID]?.magicArea;
      if (!area?.operations) return null;
      return {
        id: region.uuid,
        name: region.name,
        expires: area.expires ?? 0,
        magic: {
          ...area,
          casterUuid: area.casterUuid,
          castingTotal: area.castingTotal ?? area.castTotal,
          operations: area.operations,
          regionUuid: region.uuid,
          ongoing: region.flags?.[SYSTEM_ID]?.magicOngoing,
        },
      };
    },
    async write(ongoing, tx) {
      await tx.update(region, { [`flags.${SYSTEM_ID}.magicOngoing`]: ongoing });
    },
    async end(tx) {
      await tx.update(region, { [`flags.${SYSTEM_ID}.magicArea.active`]: false });
    },
  };
}
async function sourceContext(store, effect, event, context) {
  const resolver = context.resolveUuid ?? globalThis.fromUuid;
  const caster = context.caster ?? (await resolver?.(effect.magic.casterUuid));
  if (!caster?.system) throw new RuleError('The continuing spell’s original caster is unavailable.');
  const scene =
    context.scene ??
    (effect.magic.sceneUuid
      ? await resolver?.(effect.magic.sceneUuid)
      : store.source.documentName === 'Region'
        ? store.source.parent
        : undefined);
  return {
    ...context,
    caster,
    target: store.actor,
    targets: [store.actor],
    sourceUuid: store.source.uuid,
    effectId: effect.id,
    castId: effect.magic.castId,
    castTotal: effect.magic.castingTotal ?? effect.magic.castTotal,
    focus: copy(effect.magic.focus ?? effect.magic.initialCast?.focus ?? null),
    sourceMagic: magicInfo(effect.magic.key) ?? context.sourceMagic,
    sourceMetadata: copy(effect.magic),
    sourceEffect: copy(effect),
    tokenUuid: effect.magic.tokenUuid,
    messageUuid: effect.magic.messageUuid,
    initialCast: copy(effect.magic.initialCast),
    duration: effect.magic.duration,
    point: effect.magic.point ?? context.point,
    scene,
    event,
  };
}
async function resolvePredicate(operation, context) {
  if (operation.requiresCompletedRest) return context.event?.data?.completedRest;
  if (!operation.predicate) return true;
  if (context.predicate) {
    const result = await context.predicate(operation.predicate, operation, context);
    if (typeof result === 'boolean') return result;
  }
  // Material is not inferred from names or weapon categories. An explicit material field is required.
  if (operation.predicate === 'hasMetalWeaponOrArmor') {
    const equipment = values(context.target.items).filter(
      (item) =>
        (item.type === 'weapon' || (item.type === 'armor' && item.system.equipped)) &&
        item.system.carried !== false &&
        item.system.quantity > 0
    );
    if (equipment.some((item) => item.system.material === 'metal' || item.system.properties?.metal === true))
      return true;
    if (
      !equipment.length ||
      equipment.every((item) => item.system.material && item.system.material !== 'metal')
    )
      return false;
  }
  return undefined;
}
async function rollFormula(formula, context, purpose) {
  const result = await callback(context, 'rollFormula')(formula, { actor: context.target, purpose });
  return finite(typeof result === 'number' ? result : result?.total, 'Dice total');
}
function ownerIds(actor, context, gmOnly = false) {
  return values(context.users ?? globalThis.game?.users)
    .filter((user) => user.isGM || (!gmOnly && actor.testUserPermission?.(user, 'OWNER')))
    .map((user) => user.id);
}
async function postPending(store, effect, procedure, event, ongoing, context, tx) {
  const id = `${event.id}:${procedure.path}:${procedure.kind}:${store.actor.uuid}`;
  if (ongoing.pending[id]) return;
  const pending = {
    ...copy(procedure),
    id,
    actorUuid: store.actor.uuid,
    sourceUuid: store.source.uuid,
    effectId: effect.id,
    event: copy(event),
    createdAt: currentTime(context),
    status: 'pending',
  };
  const skill = Array.isArray(pending.skill) ? pending.skill.join(' / ') : pending.skill;
  const detail =
    pending.kind === 'save'
      ? `${skill ?? '1d10 vs INT'}${pending.versus === 'newSpellCasting' ? ' against a new Spell Casting check' : Number.isFinite(pending.dc) ? ` against ${pending.dc}` : ''}`
      : pending.kind === 'action'
        ? `${pending.action} action${pending.maintenanceCost ? `; printed upkeep ${pending.maintenanceCost} STA (verify payment once)` : ''}`
        : pending.reason;
  const gmOnly = pending.kind === 'decision';
  const message = await callback(
    context,
    'postMessage'
  )({
    content: `<h3>${escape(effect.name ?? effect.magic.key ?? 'Continuing magic')}</h3><p>${escape(store.actor.name)}: ${escape(detail)}</p><p>${gmOnly ? 'Waiting for the GM to resolve the stated rule condition.' : 'Waiting for the affected player or GM to resolve this procedure.'}</p><button type="button" data-magic-ongoing="${escape(id)}">${gmOnly ? 'Resolve condition' : pending.kind === 'save' ? 'Roll resistance' : 'Use action'}</button>`,
    whisper: ownerIds(store.actor, context, gmOnly),
    flags: {
      [SYSTEM_ID]: {
        magicOngoing: {
          actorUuid: store.actor.uuid,
          sourceUuid: store.source.uuid,
          effectId: effect.id,
          pendingId: id,
          kind: pending.kind,
        },
      },
    },
  });
  if (!message?.delete) throw new RuleError('A continuing magic prompt must be a real ChatMessage document.');
  tx.undo.push(() => message.delete());
  pending.messageUuid = message.uuid;
  ongoing.pending[id] = pending;
}
async function executeProcedure(procedure, context, tx) {
  const operations = procedure.operations ?? [immediate(procedure.operation)];
  return tx.receive(await callback(context, 'executeOperations')(operations, context));
}
export function ongoingProcedureSurvivesExpiry(pending) {
  return (
    pending.status === 'pending' &&
    (pending.event.kind === 'expiry' || pending.kind === 'decision' || !!pending.operation?.save)
  );
}
async function processStore(store, event, context, tx) {
  const effect = store.read();
  if (!effect) return { status: 'absent' };
  const plan = planMagicOngoing(effect, event, { actorUuid: store.actor.uuid, time: currentTime(context) });
  if (plan.duplicate) return { status: 'duplicate' };
  const source = await sourceContext(store, effect, event, context);
  const ongoing = plan.ongoing;
  let executed = 0;
  if (
    event.kind === 'expiry' &&
    plan.procedures.some((procedure) => procedure.operation?.requiresCompletedRest)
  ) {
    const operations = plan.procedures.map((procedure) => immediate(procedure.operation));
    if (event.data?.completedRest === true) {
      await executeProcedure({ operations }, source, tx);
      executed += operations.length;
    } else if (event.data?.completedRest !== false)
      await postPending(
        store,
        effect,
        {
          kind: 'decision',
          path: 'completedRest',
          reason:
            'Confirm that the entire required rest was completed without interruption before applying healing and wound recovery.',
          resume: { kind: 'execute', operations },
        },
        event,
        ongoing,
        source,
        tx
      );
    plan.procedures = [];
  }
  for (const procedure of plan.procedures) {
    if (procedure.kind === 'endCast') {
      await store.end(tx, { allCast: true });
      return { status: 'ended' };
    }
    if (procedure.operation) {
      const predicate = await resolvePredicate(procedure.operation, source);
      if (predicate === false) continue;
      if (predicate === undefined) {
        await postPending(
          store,
          effect,
          {
            ...procedure,
            kind: 'decision',
            resume: copy(procedure),
            reason: procedure.operation.requiresCompletedRest
              ? 'Confirm that the entire required rest was completed without interruption.'
              : `Confirm the printed condition: ${procedure.operation.predicate}.`,
          },
          event,
          ongoing,
          source,
          tx
        );
        continue;
      }
      if (procedure.operation.selectionChance !== undefined) {
        const chance = finite(procedure.operation.selectionChance, 'Selection chance');
        const roll = await rollFormula('1d100', source, 'storm selection');
        if (roll < 1 || roll > 100 || !Number.isInteger(roll))
          throw new RuleError('Storm selection requires an actual d100 result.');
        if (roll > chance) continue;
      }
    }
    if (procedure.kind === 'save' || procedure.kind === 'action')
      await postPending(store, effect, procedure, event, ongoing, source, tx);
    else {
      await executeProcedure(procedure, source, tx);
      executed++;
      if (procedure.once) ongoing.completed.push(procedure.once);
    }
  }
  ongoing.seenEvents = [...ongoing.seenEvents, plan.marker].slice(-512);
  if (plan.cursor) ongoing.cursors[plan.cursor] = event.sequence;
  if (event.kind === 'expiry') ongoing.phase = 'expired';
  await store.write(ongoing, tx);
  if (
    (ongoing.phase === 'expired' && !Object.values(ongoing.pending).some(ongoingProcedureSurvivesExpiry)) ||
    (effect.magic.oneShot && !Object.keys(ongoing.pending).length)
  )
    await store.end(tx);
  return {
    status: Object.values(ongoing.pending).some((entry) => entry.status === 'pending')
      ? 'pending'
      : 'applied',
    executed,
    pendingIds: Object.keys(ongoing.pending),
  };
}

/** UNSERIALIZED: call inside the system authority queue, including from combat damage application. */
export async function triggerMagicOngoing(actor, event, supplied = {}) {
  const context = contextWith(supplied);
  requireGM(context);
  validateEvent(event);
  if (!actor?.system?.effects) throw new RuleError('A continuing magic target must be an Actor.');
  return transactional(async (tx) => {
    const results = [];
    for (const effect of [...actor.system.effects]) {
      if (!effect.magic || !operationsOf(effect).length) continue;
      if (event.effectId && effect.id !== event.effectId) continue;
      results.push(await processStore(actorEffectStore(actor, effect.id), event, context, tx));
    }
    return { status: 'processed', results, receipt: { actorUuid: actor.uuid, eventId: event.id } };
  });
}

/** Native Region behavior integration. This deliberately does not replace the existing behavior class. */
export async function triggerMagicOngoingRegion(region, nativeEvent, supplied = {}) {
  const context = contextWith(supplied);
  requireGM(context);
  const area = region.flags?.[SYSTEM_ID]?.magicArea;
  if (!area?.operations || area.active === false) return { status: 'inactive', rollback: async () => {} };
  const token = nativeEvent.data?.token?.document ?? nativeEvent.data?.token;
  const actor = token?.actor;
  if (!actor) throw new RuleError('A Region event requires its actual token and Actor.');
  if (area.excludesCaster && actor.uuid === area.casterUuid)
    return { status: 'excluded', rollback: async () => {} };
  const kind = {
    initialCast: 'cast',
    tokenTimeRound: 'startTurn',
    tokenEnter: 'enter',
    tokenExit: 'exit',
    tokenTurnStart: 'startTurn',
    tokenTurnEnd: 'endTurn',
    tokenRoundEnd: 'endRound',
  }[nativeEvent.name];
  if (!kind) return { status: 'ignored', rollback: async () => {} };
  const combat = nativeEvent.data?.combat;
  const round = nativeEvent.data?.round ?? combat?.round;
  const turn = nativeEvent.data?.turn ?? combat?.turn;
  const moving = ['enter', 'exit'].includes(kind);
  const position = [token.x, token.y, token.elevation].join(',');
  // Region membership transitions provide a persistent ordinal; moving out then back in is a new event.
  const state = region.flags?.[SYSTEM_ID]?.magicOngoing ?? {};
  const membership = copy(state.membership ?? {});
  if (moving) {
    if (membership[token.id]?.inside === (kind === 'enter'))
      return { status: 'duplicate', rollback: async () => {} };
    membership[token.id] = {
      inside: kind === 'enter',
      ordinal: (membership[token.id]?.ordinal ?? 0) + 1,
      position,
    };
  }
  const id =
    nativeEvent.name === 'initialCast'
      ? `${region.uuid}:${token.id}:cast`
      : moving
        ? `${region.uuid}:${token.id}:${kind}:${membership[token.id].ordinal}`
        : `${region.uuid}:${token.id}:${kind}:${combat?.id}:${round}:${turn}`;
  const event = {
    id,
    kind,
    actorUuid: actor.uuid,
    tokenUuid: token.uuid,
    regionUuid: region.uuid,
    cycle: combat?.started ? `${combat.id}:${round}` : `time:${Math.floor(currentTime(context) / 3)}`,
    ...(moving || kind === 'cast' ? {} : { clock: combat?.id, sequence: round * 10000 + turn }),
    data: { ownTurn: !nativeEvent.data?.initialPlacement && combat?.combatant?.actor?.uuid === actor.uuid },
  };
  return transactional(async (tx) => {
    const result = await processStore(regionEffectStore(region, actor), event, context, tx);
    if (moving) await tx.update(region, { [`flags.${SYSTEM_ID}.magicOngoing.membership`]: membership });
    return { ...result, receipt: { regionUuid: region.uuid, eventId: id } };
  });
}

export function ongoingEffectData(operations, context = {}) {
  if (!Array.isArray(operations) || !operations.length || !context.castId || !context.caster?.uuid)
    throw new RuleError('Continuing magic needs its actual operations, caster, and cast identifier.');
  const now = currentTime(context);
  const seconds = context.duration?.seconds ?? (context.duration?.rounds ? context.duration.rounds * 3 : 0);
  return {
    id: context.effectId ?? `ongoing:${context.castId}:${context.target?.id ?? 'source'}`,
    name: context.name ?? context.sourceMagic?.name ?? 'Continuing magic',
    modifiers: {},
    conditions: [],
    expires: seconds > 0 ? now + seconds : 0,
    magic: {
      key: context.sourceMagic?.key,
      castId: context.castId,
      casterUuid: context.caster.uuid,
      castingTotal: context.castTotal,
      focus: copy(context.focus ?? context.initialCast?.focus ?? null),
      createdAt: now,
      duration: copy(context.duration ?? {}),
      point: copy(context.point),
      sceneUuid: context.scene?.uuid,
      tokenUuid: context.tokenUuid ?? context.casterToken?.uuid,
      messageUuid: context.messageUuid,
      initialCast: copy(context.initialCast),
      operations: copy(operations),
      oneShot: !!context.oneShot,
      ongoing: {
        managed: true,
        nextAt: now + 3,
        seenEvents: [],
        cursors: {},
        pending: {},
        completed: [],
        counters: {},
      },
    },
  };
}
export async function installMagicOngoing(actor, operations, supplied = {}) {
  const context = contextWith(supplied);
  requireGM(context);
  const effect = ongoingEffectData(operations, { ...context, target: actor });
  if (actor.system.effects.some((entry) => entry.id === effect.id))
    throw new RuleError('This continuing procedure is already installed.');
  return transactional(async (tx) => {
    await tx.update(actor, { 'system.effects': [...copy(actor.system.effects), effect] });
    return { status: 'installed', effect, receipt: { actorUuid: actor.uuid, effectId: effect.id } };
  });
}

async function getPending(payload, context) {
  const resolve = context.resolveUuid ?? globalThis.fromUuid;
  if (!resolve) throw new RuleError('Document resolution is unavailable.');
  const actor = await resolve(payload.actorUuid);
  const source = payload.sourceUuid === payload.actorUuid ? actor : await resolve(payload.sourceUuid);
  if (!actor?.system || !source) throw new RuleError('The continuing spell or its target no longer exists.');
  if (!context.user?.isGM && !actor.testUserPermission?.(context.user, 'OWNER'))
    throw new RuleError('You must own the affected Actor to resolve this procedure.');
  const store =
    source.documentName === 'Region'
      ? regionEffectStore(source, actor)
      : actorEffectStore(actor, payload.effectId);
  if (source.documentName !== 'Region' && source.uuid !== actor.uuid)
    throw new RuleError('Invalid continuing magic source.');
  const effect = store.read();
  const ongoing = ongoingState(effect ?? {});
  const pending = ongoing.pending[payload.pendingId];
  if (!effect || !pending || pending.actorUuid !== actor.uuid || pending.status !== 'pending')
    throw new RuleError('This procedure is no longer pending.');
  if (ongoing.phase === 'expired' && !ongoingProcedureSurvivesExpiry(pending))
    throw new RuleError('This magical effect has expired.');
  return { actor, source, store, effect, ongoing, pending };
}
function validateManualDie(value) {
  if (
    value !== undefined &&
    value !== '' &&
    (!Number.isInteger(Number(value)) || Number(value) < 1 || Number(value) > 10)
  )
    throw new RuleError('An entered d10 must be an integer from 1 to 10.');
  return value === undefined || value === '' ? undefined : Number(value);
}
async function payAction(pending, actor, context, tx) {
  if (!pending.action) return;
  await tx.receive(
    await callback(context, 'reserveAction')(actor, {
      action: pending.action,
      eventId: pending.id,
      maintenanceCost: pending.maintenanceCost ?? 0,
      effectId: context.effectId,
      castId: context.castId,
      source: 'ongoingMagic',
      event: pending.event,
    })
  );
}
async function closePrompt(pending, summary, context, tx) {
  if (!pending.messageUuid) return;
  const resolve = context.resolveUuid ?? globalThis.fromUuid;
  const message = await resolve?.(pending.messageUuid);
  if (!message) return;
  const content = String(message.content ?? '').replace(
    /<button\b[^>]*data-magic-ongoing=[\s\S]*?<\/button>/g,
    ''
  );
  await tx.update(message, {
    content: `${content}<p><strong>${escape(summary)}</strong></p>`,
    [`flags.${SYSTEM_ID}.magicOngoing.status`]: 'resolved',
  });
}
async function saveProcedure(pending, effect, actor, values, context, tx) {
  const sourceMessage = context.messageUuid
    ? await (context.resolveUuid ?? globalThis.fromUuid)?.(context.messageUuid)
    : null;
  const sourceCast = sourceMessage?.flags?.[SYSTEM_ID];
  if (sourceCast?.ongoingAttack) {
    if (sourceCast.cancelled || sourceCast.failed) throw new RuleError('This continuing attack was negated.');
    if (sourceCast.targets?.some((row) => row.actorUuid === actor.uuid && row.status === 'defended'))
      return { success: true, summary: 'Heliotrope countered this incoming magical attack.' };
  }
  let total, dc, success, castingCheck, defense;
  if (pending.resolvedCheck) {
    ({ total, dc, success, defense } = pending.resolvedCheck);
    const message = await (context.resolveUuid ?? globalThis.fromUuid)?.(
      pending.resolvedCheck.fumbleMessageUuid
    );
    if (!message?.flags?.[SYSTEM_ID]?.fumbleResolved)
      throw new RuleError('Resolve the defensive fumble before applying the continuing magical hit.');
  } else if (pending.operation?.save && values.skill === 'accept') {
    total = 0;
    dc = finite(pending.dc, 'Defense DC');
    success = false;
    defense = { kind: 'accept', check: { total: 0, base: 0, dice: [], fumble: 0 } };
  } else if (pending.roll === '1d10' && pending.comparison === 'strictlyLess') {
    await payAction(pending, actor, context, tx);
    const manualDie = validateManualDie(values.manualDice ?? values.manualDie);
    total = manualDie ?? (await rollFormula('1d10', context, 'mental recovery'));
    if (!Number.isInteger(total) || total < 1 || total > 10)
      throw new RuleError('Mental recovery requires one unmodified d10.');
    dc = finite(
      Number(actor.system.derived?.stats?.[pending.attribute] ?? actor.system.stats?.[pending.attribute]),
      'Recovery attribute'
    );
    success = total < dc;
  } else {
    await payAction(pending, actor, context, tx);
    const skills = Array.isArray(pending.skill) ? pending.skill : [pending.skill];
    const skill = values.skill ?? skills[0];
    if (!skills.includes(skill) || !skill)
      throw new RuleError('Choose one of this spell’s printed resistance skills.');
    if (skills.length > 1 && !values.skill) throw new RuleError('Choose which permitted defense to use.');
    if (pending.versus === 'newSpellCasting') {
      castingCheck = await callback(context, 'rollCheck')(context.caster, {
        skill: 'spellCasting',
        purpose: 'continuing magic opposition',
        pendingRole: 'opposition',
        values: {},
        sourceMagic: context.sourceMagic,
        tokenUuid: context.tokenUuid,
        castId: `${context.castId}:${pending.id}:opposition`,
      });
      if (castingCheck?.rollback) await tx.receive(castingCheck);
      dc = magicDefenseTotal(context, finite(castingCheck?.total, 'Opposed Spell Casting total'));
    } else dc = finite(pending.dc, 'Resistance DC');
    const check = await callback(context, 'rollCheck')(actor, {
      skill,
      purpose: 'continuing magic resistance',
      pendingRole: pending.operation?.save ? 'ongoingDefense' : 'repeatResistance',
      values: copy(values),
      manualDice: values.manualDice,
      dc,
      effectId: effect.id,
    });
    if (check?.rollback) await tx.receive(check);
    total = finite(check?.total, 'Resistance total');
    const opposed = pending.versus === 'newSpellCasting' || pending.comparison === 'atLeast';
    success = castingCheck?.spellSucceeds === false || (opposed ? total >= dc : total > dc);
    defense = {
      kind: skill,
      weaponId: values.weaponId ?? '',
      check: { total, base: check.base ?? 0, fumble: check.fumble ?? 0, dice: copy(check.dice ?? []) },
    };
    if (check.fumbleMessageUuid)
      return {
        deferred: true,
        resolvedCheck: {
          total,
          dc,
          success,
          defense,
          castingTotal: castingCheck?.total ?? context.castTotal,
          fumbleMessageUuid: check.fumbleMessageUuid,
        },
        summary: 'Resolve the defensive fumble, then use this card again to finish the saved defense.',
      };
  }
  if (!success && pending.operation && !pending.operation.rule && pending.operation.type !== 'shield') {
    const failures = pending.onFailure?.length ? pending.onFailure : [immediate(pending.operation)];
    await executeProcedure(
      { operations: failures },
      {
        ...context,
        defense,
        pendingId: pending.id,
        castTotal:
          pending.versus === 'newSpellCasting'
            ? (castingCheck?.total ?? pending.resolvedCheck?.castingTotal ?? context.castTotal)
            : context.castTotal,
      },
      tx
    );
  }
  if (
    success &&
    pending.onSuccess &&
    !['none', 'avoidAttack', 'endEffect', 'endAllEffects', 'endEmbeddedEffects'].includes(pending.onSuccess)
  ) {
    await executeProcedure(
      {
        operations: [
          {
            type: 'narrative',
            timing: 'immediate',
            target: 'target',
            procedure: 'successfulMagicalSave',
            adjudicator: 'gm',
            outcome: pending.onSuccess,
            skill: pending.skill,
            total,
            dc,
          },
        ],
      },
      context,
      tx
    );
  }
  return {
    success,
    total,
    dc,
    castingCheck,
    end: success && pending.success === 'endCast',
    summary: `${success ? 'Successful' : 'Failed'} resistance: ${total}${pending.comparison === 'strictlyLess' ? ' < ' : ' against '}${dc}.`,
  };
}

/** Registered command handler. A player selects only an existing saved prompt, never its operation. */
export async function resolveMagicOngoing(payload, authority = {}, supplied = {}) {
  const context = contextWith({ ...supplied, ...authority });
  requireGM(context);
  return transactional(async (tx) => {
    const { actor, store, effect, ongoing, pending } = await getPending(payload, context);
    const source = await sourceContext(store, effect, pending.event, context);
    const input = payload.values ?? {};
    let result;
    if (pending.kind === 'save') result = await saveProcedure(pending, effect, actor, input, source, tx);
    else if (pending.kind === 'action') {
      const rule = pending.operation.rule;
      const ids = input.targetUuids ?? [actor.uuid];
      if (!Array.isArray(ids) || ids.length > 100 || ids.some((id) => typeof id !== 'string'))
        throw new RuleError('Select valid action targets.');
      const resolver = context.resolveUuid ?? globalThis.fromUuid;
      const targets = await Promise.all(ids.map((id) => resolver(id)));
      if (targets.some((target) => !target?.system)) throw new RuleError('Every action target must exist.');
      await callback(context, 'validateActionTargets')(rule.operations, {
        ...source,
        targets,
        choices: input.choices ?? {},
        requester: context.user,
      });
      await payAction(pending, actor, source, tx);
      await executeProcedure(
        { operations: rule.operations.map((operation) => ({ ...copy(operation), timing: 'immediate' })) },
        {
          ...source,
          target: targets[0],
          targets,
          choices: input.choices ?? {},
          executionRole: 'activeAction',
          actionRule: copy(rule),
          pending: copy(pending),
          values: copy(input),
        },
        tx
      );
      result = { success: true, summary: 'The continuing action was executed.' };
    } else if (pending.kind === 'decision') {
      if (!context.user?.isGM || typeof input.applies !== 'boolean')
        throw new RuleError('Only the GM can decide this printed rule condition.');
      if (input.applies) {
        const resume = pending.resume;
        if (resume.kind === 'save' || resume.kind === 'action') {
          await postPending(
            store,
            effect,
            resume,
            { ...pending.event, id: `${pending.event.id}:approved` },
            ongoing,
            source,
            tx
          );
        } else await executeProcedure(resume, source, tx);
      }
      result = {
        success: input.applies,
        summary: input.applies
          ? 'The GM confirmed the rule condition; its procedure was applied or offered.'
          : 'The GM determined that the rule condition does not apply.',
      };
    } else throw new RuleError('Unsupported continuing magic procedure.');
    if (result.deferred) {
      ongoing.pending[pending.id].resolvedCheck = result.resolvedCheck;
      await store.write(ongoing, tx);
      const prompt = await (context.resolveUuid ?? globalThis.fromUuid)?.(pending.messageUuid);
      if (prompt) await tx.update(prompt, { content: `${prompt.content}<p>${escape(result.summary)}</p>` });
      return { status: 'awaitingFumble', result, receipt: { actorUuid: actor.uuid, pendingId: pending.id } };
    }
    delete ongoing.pending[pending.id];
    if (pending.dedupe) ongoing.completed.push(pending.dedupe);
    if (pending.once) ongoing.completed.push(pending.once);
    if (pending.success === 'truthNotCompelled')
      ongoing.counters.truth = {
        cycle: pending.event.cycle,
        compelled: !result.success,
        total: result.total,
        dc: result.dc,
      };
    if (pending.intervalFormula && !result.success) {
      const delay = await rollFormula(pending.intervalFormula, source, 'next permitted resistance');
      if (!Number.isInteger(delay) || delay < 1 || delay > 6)
        throw new RuleError('Mental Command resistance interval requires an actual 1d6 result.');
      ongoing.counters[`${pending.path}:resistanceInterval`] = {
        remaining: delay,
        lastCycle: pending.event.cycle ?? pending.event.id,
      };
    }
    await closePrompt(pending, result.summary, source, tx);
    if (!Object.values(ongoing.pending).some((entry) => entry.actorUuid === actor.uuid)) {
      const castingCard = source.messageUuid
        ? await (context.resolveUuid ?? globalThis.fromUuid)?.(source.messageUuid)
        : null;
      const castingFlags = castingCard?.flags?.[SYSTEM_ID];
      if (castingFlags?.ongoingAttack) {
        const rows = copy(castingFlags.targets);
        for (const row of rows)
          if (row.actorUuid === actor.uuid && row.status === 'ongoingPending') row.status = 'resolvedOngoing';
        await tx.update(castingCard, { [`flags.${SYSTEM_ID}.targets`]: rows });
      }
    }
    if (result.end) await store.end(tx, { allCast: true });
    else {
      await store.write(ongoing, tx);
      if (
        (ongoing.phase === 'expired' &&
          !Object.values(ongoing.pending).some(ongoingProcedureSurvivesExpiry)) ||
        (effect.magic.oneShot && !Object.keys(ongoing.pending).length)
      )
        await store.end(tx);
    }
    return {
      status: 'resolved',
      result,
      receipt: { actorUuid: actor.uuid, effectId: effect.id, pendingId: pending.id },
    };
  });
}

function actorList(context) {
  if (context.actors) return values(context.actors);
  const actors = new Map(values(globalThis.game?.actors).map((actor) => [actor.uuid, actor]));
  for (const scene of values(globalThis.game?.scenes))
    for (const token of values(scene.tokens)) if (token.actor) actors.set(token.actor.uuid, token.actor);
  return [...actors.values()];
}
function inCombat(actor, combat) {
  return (
    combat?.started && values(combat.combatants).some((combatant) => combatant.actor?.uuid === actor.uuid)
  );
}
function hasRoundOperation(effect) {
  const find = (operation) =>
    operation.timing === 'startTurn' ||
    operation.timing === 'enterOrStartTurn' ||
    operation.timing === 'castAndEnterOnOwnTurnOrStartTurn' ||
    repeatDescriptor(operation)?.when.some((when) => ['startTurn', 'endRound'].includes(when)) ||
    operation.operations?.some(find);
  return operationsOf(effect).some(find);
}

/** Advances exact 3-second rounds out of combat, including the last tick before expiry. */
export async function tickMagicOngoing(supplied = {}) {
  const context = contextWith(supplied);
  requireGM(context);
  const time = currentTime(context),
    combat = context.combat ?? globalThis.game?.combat;
  const results = [];
  for (const actor of actorList(context)) {
    for (const original of [...actor.system.effects]) {
      if (!original.magic?.ongoing?.managed || original.magic.healing || original.magic.repeatDefense)
        continue;
      let effect = actor.system.effects.find((entry) => entry.id === original.id);
      if (!effect) continue;
      const through = effect.expires > 0 ? Math.min(time, effect.expires) : time;
      if (!inCombat(actor, combat) && hasRoundOperation(effect)) {
        const next = effect.magic.ongoing.nextAt ?? effect.magic.createdAt + 3;
        // Bound work per callback without skipping elapsed rounds. A subsequent tick resumes here.
        let count = 0;
        for (let at = next; at <= through && count < 100; at += 3, count++) {
          const cycle = `time:${at}`;
          results.push(
            await triggerMagicOngoing(
              actor,
              {
                id: `${effect.id}:${cycle}:start`,
                kind: 'startTurn',
                effectId: effect.id,
                actorUuid: actor.uuid,
                cycle,
                clock: 'world',
                sequence: at,
              },
              { ...context, time: at }
            )
          );
          if (!actor.system.effects.some((entry) => entry.id === effect.id)) break;
          results.push(
            await triggerMagicOngoing(
              actor,
              {
                id: `${effect.id}:${cycle}:end`,
                kind: 'endRound',
                effectId: effect.id,
                actorUuid: actor.uuid,
                cycle,
                clock: 'world',
                sequence: at,
              },
              { ...context, time: at }
            )
          );
          const effects = copy(actor.system.effects);
          const latest = effects.find((entry) => entry.id === effect.id);
          if (!latest) break;
          latest.magic.ongoing.nextAt = at + 3;
          await actor.update({ 'system.effects': effects });
        }
      }
      effect = actor.system.effects.find((entry) => entry.id === original.id);
      if (!effect) continue;
      results.push(
        await triggerMagicOngoing(
          actor,
          {
            id: `${effect.id}:time:${time}`,
            kind: 'worldTime',
            effectId: effect.id,
            actorUuid: actor.uuid,
            clock: 'world',
            sequence: time,
          },
          context
        )
      );
      effect = actor.system.effects.find((entry) => entry.id === original.id);
      if (!effect || effect.magic.ongoing.phase === 'expired') continue;
      const waitingCatchup =
        !inCombat(actor, combat) && hasRoundOperation(effect) && effect.magic.ongoing.nextAt <= through;
      if (effect.expires > 0 && effect.expires <= time && !waitingCatchup)
        results.push(
          await triggerMagicOngoing(
            actor,
            {
              id: `${effect.id}:expiry:${effect.expires}`,
              kind: 'expiry',
              effectId: effect.id,
              actorUuid: actor.uuid,
              data: {},
            },
            context
          )
        );
    }
  }
  return { results };
}

async function renderPrompt(message, html) {
  const state = message.flags?.[SYSTEM_ID]?.magicOngoing;
  if (!state || state.status === 'resolved') return;
  const element = html?.querySelector ? html : html?.[0];
  const button = element?.querySelector?.('[data-magic-ongoing]');
  if (!button) return;
  button.addEventListener('click', async () => {
    button.disabled = true;
    try {
      const resolve = adapters.resolveUuid ?? globalThis.fromUuid;
      const actor = await resolve(state.actorUuid);
      const source = state.sourceUuid === state.actorUuid ? actor : await resolve(state.sourceUuid);
      const store =
        source?.documentName === 'Region'
          ? regionEffectStore(source, actor)
          : actorEffectStore(actor, state.effectId);
      const pending = store.read()?.magic?.ongoing?.pending?.[state.pendingId];
      if (!pending) throw new RuleError('This procedure is no longer pending.');
      let input = {};
      if (adapters.promptInput) input = await adapters.promptInput(pending, { actor, source });
      else {
        const Dialog = globalThis.foundry?.applications?.api?.DialogV2;
        if (!Dialog) throw new RuleError('The Foundry dialog API is unavailable.');
        if (pending.kind === 'decision') {
          input = await Dialog.input({
            window: { title: 'Printed rule condition' },
            content: `<p>${escape(pending.reason)}</p><label>Does this condition apply? <select name="applies"><option value="true">Yes</option><option value="false">No</option></select></label>`,
            ok: { label: 'Resolve' },
          });
          if (input) input.applies = input.applies === 'true';
        } else if (pending.kind === 'save') {
          const skills = Array.isArray(pending.skill) ? pending.skill : [pending.skill].filter(Boolean);
          input = await Dialog.input({
            window: { title: 'Magical resistance' },
            content: `${skills.length > 1 ? `<label>Defense <select name="skill">${skills.map((skill) => `<option value="${escape(skill)}">${escape(skill)}</option>`).join('')}</select></label>` : ''}<label>Entered dice (leave blank to roll) <input name="manualDice" type="text" placeholder="${pending.roll === '1d10' ? 'One unmodified d10' : 'e.g. 10, 7'}"></label>`,
            ok: { label: 'Roll resistance' },
          });
        } else {
          const targetUuids = values(globalThis.game?.user?.targets)
            .map((token) => token.actor?.uuid)
            .filter(Boolean);
          const confirmed = await Dialog.confirm({
            window: { title: 'Continuing magical action' },
            content: `<p>Use the printed ${escape(pending.action)} action against ${targetUuids.length} selected target(s)? The action and any unpaid maintenance must be available.</p>`,
          });
          input = confirmed ? { targetUuids } : null;
        }
      }
      if (!input) return;
      await callback(adapters, 'runCommand')(
        pending.kind === 'save' ? 'magicOngoingSave' : 'magicOngoingAction',
        { ...state, values: input },
        { label: 'Resolve continuing magic' }
      );
    } catch (error) {
      (adapters.onError ?? ((failure) => globalThis.ui?.notifications?.error(failure.message)))(error);
    } finally {
      button.disabled = false;
    }
  });
}

/** Inject existing authority/action/damage implementations; never create another command queue. */
export function registerMagicOngoing(options = {}) {
  adapters = { ...adapters, ...options };
  if (options.registerCommand) {
    options.registerCommand('magicOngoingAction', (payload, authority) =>
      resolveMagicOngoing(payload, authority)
    );
    options.registerCommand('magicOngoingSave', (payload, authority) =>
      resolveMagicOngoing(payload, authority)
    );
  }
  if (!options.registerHooks || hooksRegistered) return;
  const Hooks = options.Hooks ?? globalThis.Hooks;
  if (!Hooks) throw new RuleError('Foundry hooks are unavailable.');
  hooksRegistered = true;
  const schedule = (task) => {
    if (!(adapters.isAuthority?.() ?? globalThis.game?.user?.isGM)) return;
    const queue = callback(adapters, 'schedule');
    queue(task).catch((error) =>
      (adapters.onError ?? ((failure) => globalThis.ui?.notifications?.error(failure.message)))(error)
    );
  };
  const previous = new Map();
  Hooks.on('preUpdateCombat', (combat, changes) => {
    if ('round' in changes || 'turn' in changes)
      previous.set(combat.id, { actor: combat.combatant?.actor, round: combat.round, turn: combat.turn });
  });
  Hooks.on('updateCombat', (combat, changes) => {
    if (!('round' in changes || 'turn' in changes) || !combat.started) return;
    const old = previous.get(combat.id);
    previous.delete(combat.id);
    schedule(async () => {
      if (old?.actor)
        await triggerMagicOngoing(old.actor, {
          id: `${combat.id}:${old.round}:${old.turn}:end`,
          kind: 'endTurn',
          actorUuid: old.actor.uuid,
          cycle: `${combat.id}:${old.round}`,
          clock: combat.id,
          sequence: old.round * 10000 + old.turn,
        });
      if (old && combat.round > old.round)
        for (const actor of new Map(
          values(combat.combatants)
            .filter((c) => c.actor)
            .map((c) => [c.actor.uuid, c.actor])
        ).values())
          await triggerMagicOngoing(actor, {
            id: `${combat.id}:${old.round}:endRound`,
            kind: 'endRound',
            actorUuid: actor.uuid,
            cycle: `${combat.id}:${old.round}`,
            clock: combat.id,
            sequence: old.round,
          });
      const actor = combat.combatant?.actor;
      if (actor)
        await triggerMagicOngoing(actor, {
          id: `${combat.id}:${combat.round}:${combat.turn}:start`,
          kind: 'startTurn',
          actorUuid: actor.uuid,
          cycle: `${combat.id}:${combat.round}`,
          clock: combat.id,
          sequence: combat.round * 10000 + combat.turn,
        });
      await tickMagicOngoing({ combat });
    });
  });
  Hooks.on('updateWorldTime', () => schedule(() => tickMagicOngoing()));
  Hooks.on('canvasReady', () => schedule(() => tickMagicOngoing()));
  Hooks.on('renderChatMessageHTML', renderPrompt);
}
