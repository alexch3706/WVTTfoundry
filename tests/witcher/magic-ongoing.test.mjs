import test from 'node:test';
import assert from 'node:assert/strict';
import {
  planMagicOngoing,
  ongoingEffectData,
  installMagicOngoing,
  triggerMagicOngoing,
  resolveMagicOngoing,
  tickMagicOngoing,
  triggerMagicOngoingRegion,
  ongoingOperationSupport,
  registerMagicOngoing,
} from '../../module/witcher/magic-ongoing.js';

const SYSTEM = 'witcher-rilerena';
let next = 0;
class Document {
  constructor(source, kind = 'Actor') {
    this.documentName = kind;
    this.id = `test${++next}`;
    this.uuid = `${kind}.${this.id}`;
    this.data = structuredClone(source);
  }
  get system() {
    return this.data.system;
  }
  get flags() {
    return this.data.flags;
  }
  get name() {
    return this.data.name;
  }
  get content() {
    return this.data.content;
  }
  get items() {
    return this.data.items ?? [];
  }
  toObject() {
    return structuredClone(this.data);
  }
  testUserPermission(user) {
    return user?.id === 'owner';
  }
  async update(changes) {
    for (const [key, value] of Object.entries(changes)) {
      const parts = key.split('.');
      let ref = this.data;
      for (const part of parts.slice(0, -1)) ref = ref[part] ??= {};
      if (parts.at(-1).startsWith('-=')) delete ref[parts.at(-1).slice(2)];
      else ref[parts.at(-1)] = structuredClone(value);
    }
    if (this.failNextUpdate) {
      this.failNextUpdate = false;
      throw new Error('write failed after mutation');
    }
    return this;
  }
  async delete() {
    this.deleted = true;
  }
}
function setup() {
  const gm = { id: 'gm', isGM: true },
    owner = { id: 'owner', isGM: false };
  const actor = new Document({
    name: 'Target',
    system: { hp: { value: 10, max: 30 }, stats: { int: 7 }, effects: [], conditions: [] },
    flags: {},
  });
  const caster = new Document({
    name: 'Caster',
    system: { hp: { value: 30, max: 30 }, effects: [], conditions: [] },
    flags: {},
  });
  const docs = new Map([
    [actor.uuid, actor],
    [caster.uuid, caster],
  ]);
  const executions = [],
    messages = [],
    checks = [];
  let actionCount = 0;
  const context = {
    isAuthority: () => true,
    authorityUser: gm,
    user: gm,
    users: [gm, owner],
    caster,
    castId: 'cast-one',
    castTotal: 19,
    sourceMagic: { key: 'sample', name: 'Sample' },
    time: 0,
    actors: [actor],
    combat: null,
    resolveUuid: async (uuid) => docs.get(uuid),
    postMessage: async (data) => {
      const message = new Document(data, 'ChatMessage');
      docs.set(message.uuid, message);
      messages.push(message);
      return message;
    },
    rollFormula: async () => 1,
    rollCheck: async (target, input) => {
      checks.push({ actorUuid: target.uuid, ...input });
      return { total: 20 };
    },
    reserveAction: async () => {
      actionCount++;
      return {
        receipt: { action: true },
        rollback: async () => {
          actionCount--;
        },
      };
    },
    validateActionTargets: async () => {},
    executeOperations: async (operations, ctx) => {
      const before = ctx.target.system.hp.value;
      for (const operation of operations)
        if (operation.type === 'heal')
          ctx.target.system.hp.value = Math.min(ctx.target.system.hp.max, before + operation.amount);
      const entry = { operations: structuredClone(operations), actorUuid: ctx.target.uuid };
      executions.push(entry);
      return {
        receipt: { count: operations.length },
        rollback: async () => {
          ctx.target.system.hp.value = before;
          executions.splice(executions.indexOf(entry), 1);
        },
      };
    },
  };
  return {
    actor,
    caster,
    gm,
    owner,
    docs,
    context,
    executions,
    messages,
    checks,
    get actionCount() {
      return actionCount;
    },
  };
}
const event = (kind = 'startTurn', sequence = 1) => ({
  id: `combat:${sequence}:${kind}`,
  kind,
  cycle: `combat:${sequence}`,
  sequence,
  clock: 'combat',
});
async function install(f, operations, extra = {}) {
  return (await installMagicOngoing(f.actor, operations, { ...f.context, ...extra })).effect;
}
function request(f, effect, id) {
  return {
    actorUuid: f.actor.uuid,
    sourceUuid: f.actor.uuid,
    effectId: effect.id,
    pendingId:
      id ??
      Object.keys(f.actor.system.effects.find((entry) => entry.id === effect.id).magic.ongoing.pending)[0],
  };
}

test('operation support is exact: timing, predicates, nested executor, and delayed profile checked', () => {
  assert.equal(ongoingOperationSupport({ type: 'heal', amount: 3, timing: 'startTurn' }), true);
  assert.equal(
    ongoingOperationSupport({ type: 'damage', timing: 'startTurn', predicate: 'guessedWeather' }),
    false
  );
  assert.equal(ongoingOperationSupport({ type: 'modifier', rule: { key: 'unknown' } }), false);
  assert.equal(
    ongoingOperationSupport(
      { type: 'summon', arrivalRounds: 2, profile: 'unknown' },
      { supportsImmediate: () => false }
    ),
    false
  );
  assert.equal(
    ongoingOperationSupport(
      { type: 'modifier', rule: { key: 'activeActions', operations: [{ type: 'damage' }] } },
      { supportsImmediate: () => false }
    ),
    false
  );
});

test('pure planning ignores legacy ticks and rejects repeated and rewound event sequences', () => {
  const f = setup();
  const effect = ongoingEffectData([{ type: 'heal', amount: 3, timing: 'startTurn' }], f.context);
  const plan = planMagicOngoing(effect, event(), { actorUuid: f.actor.uuid });
  assert.equal(plan.procedures.length, 1);
  effect.magic.ongoing = { ...plan.ongoing, seenEvents: [plan.marker], cursors: { [plan.cursor]: 3 } };
  assert.equal(planMagicOngoing(effect, event(), { actorUuid: f.actor.uuid }).duplicate, true);
  assert.equal(planMagicOngoing(effect, event('startTurn', 2), { actorUuid: f.actor.uuid }).duplicate, true);
  effect.magic.healing = 3;
  assert.equal(planMagicOngoing(effect, event('startTurn', 4)).duplicate, true);
});

test('actual healing ticks once per elapsed round and final tick precedes expiration', async () => {
  const f = setup();
  await install(f, [{ type: 'heal', amount: 3, timing: 'startTurn' }], { duration: { rounds: 3 } });
  await tickMagicOngoing({ ...f.context, time: 9 });
  assert.equal(f.actor.system.hp.value, 19);
  assert.equal(f.executions.length, 3);
  assert.equal(f.actor.system.effects.length, 0);
  await tickMagicOngoing({ ...f.context, time: 9 });
  assert.equal(f.actor.system.hp.value, 19);
});

test('nested effect damage is not executed before the printed save; ties defend successfully', async () => {
  const f = setup();
  const effect = await install(f, [
    {
      type: 'damage',
      formula: '8d6',
      timing: 'startTurn',
      selectionChance: 35,
      save: { skill: 'dodge', dc: 20, onFailure: [], onSuccess: 'avoidAttack', comparison: 'atLeast' },
    },
  ]);
  await triggerMagicOngoing(f.actor, event(), f.context);
  assert.equal(f.executions.length, 0);
  assert.equal(f.messages.length, 1);
  const payload = request(f, effect);
  const result = await resolveMagicOngoing(payload, { user: f.owner }, f.context);
  assert.equal(result.result.success, true);
  assert.equal(f.executions.length, 0);
  await assert.rejects(() => resolveMagicOngoing(payload, { user: f.owner }, f.context), /no longer pending/);
});

test('failed zone save executes damage with nested hit effects intact exactly once', async () => {
  const f = setup();
  f.context.rollCheck = async () => ({ total: 18 });
  const effect = await install(f, [
    {
      type: 'damage',
      formula: '8d6',
      timing: 'startTurn',
      onHit: { type: 'condition', condition: 'fire', chance: 75 },
      save: { skill: ['dodge', 'block'], dc: 20, onFailure: [], onSuccess: 'avoidAttack' },
    },
  ]);
  await triggerMagicOngoing(f.actor, event(), f.context);
  await assert.rejects(
    () => resolveMagicOngoing(request(f, effect), { user: f.owner }, f.context),
    /Choose which/
  );
  await resolveMagicOngoing(
    { ...request(f, effect), values: { skill: 'dodge', manualDie: 4 } },
    { user: f.owner },
    f.context
  );
  assert.equal(f.executions.length, 1);
  assert.equal(f.executions[0].operations[0].timing, 'immediate');
  assert.equal(f.executions[0].operations[0].onHit.chance, 75);
});

test('mental recovery uses strictly less than INT and permits a fresh attempt next round', async () => {
  const f = setup();
  const effect = await install(f, [
    {
      type: 'modifier',
      rule: {
        key: 'mentalRecovery',
        roll: '1d10',
        comparison: 'strictlyLess',
        attribute: 'int',
        timing: 'targetTurn',
        frequency: 'oncePerRound',
      },
    },
  ]);
  await triggerMagicOngoing(f.actor, event(), f.context);
  const failure = await resolveMagicOngoing(
    { ...request(f, effect), values: { manualDie: 7 } },
    { user: f.owner },
    f.context
  );
  assert.equal(failure.result.success, false);
  await triggerMagicOngoing(f.actor, { ...event(), id: 'same-round-alias', kind: 'targetTurn' }, f.context);
  assert.equal(f.messages.length, 1);
  await triggerMagicOngoing(f.actor, event('startTurn', 2), f.context);
  const success = await resolveMagicOngoing(
    { ...request(f, effect), values: { manualDie: 6 } },
    { user: f.owner },
    f.context
  );
  assert.equal(success.result.success, true);
  assert.equal(f.actor.system.effects.length, 0);
});

test('new Spell Casting opposition is rolled afresh and ending the spell preserves another condition source', async () => {
  const f = setup();
  const effect = await install(f, [
    {
      type: 'modifier',
      rule: { key: 'repeatMagicDefense', skill: 'dodge', versus: 'newSpellCasting', action: 'normal' },
    },
  ]);
  f.actor.system.conditions = ['blinded'];
  f.actor.system.effects.push(
    {
      id: 'spell-blind',
      conditions: ['blinded'],
      magic: { castId: effect.magic.castId, addedConditions: ['blinded'] },
    },
    { id: 'other-blind', conditions: ['blinded'], magic: { castId: 'other', addedConditions: [] } }
  );
  await triggerMagicOngoing(f.actor, event(), f.context);
  await resolveMagicOngoing(request(f, effect), { user: f.owner }, f.context);
  assert.deepEqual(
    f.checks.map((entry) => entry.skill),
    ['spellCasting', 'dodge']
  );
  assert.equal(f.actionCount, 1);
  assert.deepEqual(f.actor.system.conditions, ['blinded']);
  assert.deepEqual(
    f.actor.system.effects.map((entry) => entry.id),
    ['other-blind']
  );
  assert.deepEqual(f.actor.system.effects[0].magic.addedConditions, ['blinded']);
});

test('unknown environmental eligibility produces a GM decision; player cannot assert it', async () => {
  const f = setup();
  f.actor.data.items = [{ type: 'weapon', system: { equipped: true, quantity: 1 } }];
  const effect = await install(f, [
    { type: 'damage', formula: '2', timing: 'startTurn', predicate: 'hasMetalWeaponOrArmor' },
  ]);
  await triggerMagicOngoing(f.actor, event(), f.context);
  assert.equal(f.executions.length, 0);
  assert.deepEqual(f.messages[0].data.whisper, ['gm']);
  const payload = { ...request(f, effect), values: { applies: true } };
  await assert.rejects(() => resolveMagicOngoing(payload, { user: f.owner }, f.context), /Only the GM/);
  await resolveMagicOngoing(payload, { user: f.gm }, f.context);
  assert.equal(f.executions.length, 1);
});

test('an active action uses actual saved operations, permission and action budget, with compensated failure', async () => {
  const f = setup();
  const effect = await install(f, [
    {
      type: 'modifier',
      rule: {
        key: 'activeActions',
        action: 'fullRound',
        maintenanceCost: 6,
        operations: [{ type: 'heal', amount: 3 }],
      },
    },
  ]);
  await triggerMagicOngoing(f.actor, event(), f.context);
  const payload = {
    ...request(f, effect),
    values: { targetUuids: [f.actor.uuid] },
    operations: [{ type: 'heal', amount: 1000 }],
  };
  await assert.rejects(
    () => resolveMagicOngoing(payload, { user: { id: 'stranger' } }, f.context),
    /must own/
  );
  f.actor.failNextUpdate = true;
  await assert.rejects(() => resolveMagicOngoing(payload, { user: f.owner }, f.context), /write failed/);
  assert.equal(f.actionCount, 0);
  assert.equal(f.actor.system.hp.value, 10);
  assert.equal(f.executions.length, 0);
  assert.equal(Object.keys(f.actor.system.effects[0].magic.ongoing.pending).length, 1);
  await resolveMagicOngoing(payload, { user: f.owner }, f.context);
  assert.equal(f.actor.system.hp.value, 13);
  assert.equal(f.actionCount, 1);
});

test('post-execution write failure rolls back resource changes and permits safe retry', async () => {
  const f = setup();
  await install(f, [{ type: 'heal', amount: 3, timing: 'startTurn' }]);
  f.actor.failNextUpdate = true;
  await assert.rejects(() => triggerMagicOngoing(f.actor, event(), f.context), /write failed/);
  assert.equal(f.actor.system.hp.value, 10);
  await triggerMagicOngoing(f.actor, event(), f.context);
  assert.equal(f.actor.system.hp.value, 13);
  await triggerMagicOngoing(f.actor, event(), f.context);
  assert.equal(f.actor.system.hp.value, 13);
});

test('native Region transitions deduplicate and leaving then entering is a new contact', async () => {
  const f = setup();
  const region = new Document(
    {
      name: 'Ice slick',
      flags: {
        [SYSTEM]: {
          magicArea: {
            casterUuid: f.caster.uuid,
            castId: 'cast-area',
            active: true,
            operations: [{ type: 'damage', formula: '1d6', timing: 'enter' }],
          },
        },
      },
    },
    'Region'
  );
  const token = { id: 'token', uuid: 'Scene.one.Token.token', actor: f.actor, x: 0, y: 0, elevation: 0 };
  const native = (name) => ({ name, data: { token } });
  await triggerMagicOngoingRegion(region, native('tokenEnter'), f.context);
  await triggerMagicOngoingRegion(region, native('tokenEnter'), f.context);
  assert.equal(f.executions.length, 1);
  await triggerMagicOngoingRegion(region, native('tokenExit'), f.context);
  await triggerMagicOngoingRegion(region, native('tokenEnter'), f.context);
  assert.equal(f.executions.length, 2);
});

test('delayed arrival occurs at the printed time, one time, with the delay removed for execution', async () => {
  const f = setup();
  await install(f, [{ type: 'summon', profile: 'dog', arrivalRounds: 2 }]);
  await tickMagicOngoing({ ...f.context, time: 5 });
  assert.equal(f.executions.length, 0);
  await tickMagicOngoing({ ...f.context, time: 6 });
  await tickMagicOngoing({ ...f.context, time: 9 });
  assert.equal(f.executions.length, 1);
  assert.equal(f.executions[0].operations[0].arrivalRounds, undefined);
});

test('completed rest is a real GM decision before healing and permanent wound handling is delegated intact', async () => {
  const f = setup();
  const effect = await install(
    f,
    [
      { type: 'heal', amount: 3, timing: 'expiry', requiresCompletedRest: true },
      {
        type: 'restoreWound',
        action: 'healTreatedWounds',
        timing: 'expiry',
        preservePermanentPenalties: true,
      },
    ],
    { duration: { seconds: 86400 } }
  );
  await tickMagicOngoing({ ...f.context, time: 86400 });
  assert.equal(f.actor.system.hp.value, 10);
  assert.equal(f.executions.length, 0);
  assert.equal(f.actor.system.effects[0].magic.ongoing.phase, 'expired');
  await resolveMagicOngoing({ ...request(f, effect), values: { applies: false } }, { user: f.gm }, f.context);
  assert.equal(f.actor.system.hp.value, 10);
  assert.equal(f.actor.system.effects.length, 0);
});

test('final round attack still resolves after duration ends and instant saves trigger at cast', async () => {
  const f = setup();
  const effect = await install(
    f,
    [
      {
        type: 'damage',
        formula: '2d6',
        timing: 'startTurn',
        save: { skill: 'dodge', dc: 22, onFailure: [] },
      },
    ],
    { duration: { rounds: 1 } }
  );
  await tickMagicOngoing({ ...f.context, time: 3 });
  assert.equal(f.actor.system.effects[0].magic.ongoing.phase, 'expired');
  await resolveMagicOngoing(request(f, effect), { user: f.owner }, f.context);
  assert.equal(f.executions.length, 1);
  assert.equal(f.actor.system.effects.length, 0);
  const immediate = {
    type: 'condition',
    condition: 'prone',
    timing: 'immediate',
    save: { skill: 'physique', dc: 24, onFailure: [{ type: 'condition', condition: 'prone' }] },
  };
  assert.equal(ongoingOperationSupport(immediate), true);
  await install(f, [immediate]);
  await triggerMagicOngoing(f.actor, event('cast'), f.context);
  assert.equal(f.messages.length, 2);
});

test('current derived INT and full entered check dice reach the authoritative check adapter', async () => {
  const f = setup();
  f.actor.system.derived = { stats: { int: 9 } };
  const effect = await install(f, [
    {
      type: 'modifier',
      rule: { key: 'mentalRecovery', roll: '1d10', comparison: 'strictlyLess', attribute: 'int' },
    },
  ]);
  await triggerMagicOngoing(f.actor, event(), f.context);
  const result = await resolveMagicOngoing(
    { ...request(f, effect), values: { manualDice: '8' } },
    { user: f.owner },
    f.context
  );
  assert.equal(result.result.success, true);
  const second = await install(f, [
    { type: 'condition', timing: 'immediate', condition: 'prone', save: { skill: 'dodge', dc: 18 } },
  ]);
  await triggerMagicOngoing(f.actor, event('cast'), f.context);
  await resolveMagicOngoing(
    {
      ...request(f, second),
      values: { manualDice: '10, 10, 7', luck: 2, modifier: -1, weaponId: 'shield', woundArm: 'left' },
    },
    { user: f.owner },
    f.context
  );
  assert.equal(f.checks.at(-1).values.manualDice, '10, 10, 7');
  assert.equal(f.checks.at(-1).pendingRole, 'ongoingDefense');
});

test('registration reuses authority commands and requires an explicit scheduler for native hooks', () => {
  const commands = new Map(),
    hooks = new Map();
  registerMagicOngoing({
    registerCommand: (name, handler) => commands.set(name, handler),
    registerHooks: true,
    Hooks: { on: (name, fn) => hooks.set(name, fn) },
    schedule: async (fn) => fn(),
    isAuthority: () => false,
  });
  assert.ok(commands.has('magicOngoingAction'));
  assert.ok(commands.has('magicOngoingSave'));
  assert.ok(hooks.has('updateWorldTime'));
  assert.ok(hooks.has('renderChatMessageHTML'));
});

test('Mental Command waits the actual 1d6 interval and rerolls it after failed resistance', async () => {
  const f = setup();
  f.context.rollFormula = async () => 2;
  f.context.rollCheck = async () => ({ total: 10 });
  const effect = await install(f, [
    {
      type: 'modifier',
      rule: {
        key: 'compelledOrder',
        repeatSave: { skill: 'resistMagic', dc: 20, initialDelayRounds: 2, intervalFormula: '1d6' },
      },
    },
  ]);
  await triggerMagicOngoing(f.actor, event(), f.context);
  assert.equal(f.messages.length, 0);
  await triggerMagicOngoing(f.actor, event('startTurn', 2), f.context);
  assert.equal(f.messages.length, 1);
  await resolveMagicOngoing(request(f, effect), { user: f.owner }, f.context);
  await triggerMagicOngoing(f.actor, event('startTurn', 3), f.context);
  assert.equal(f.messages.length, 1);
  await triggerMagicOngoing(f.actor, event('startTurn', 4), f.context);
  assert.equal(f.messages.length, 2);
});

test('a fixed printed DC must be exceeded even for a Dodge defense', async () => {
  const f = setup();
  const effect = await install(f, [
    {
      type: 'damage',
      formula: '2d6',
      timing: 'startTurn',
      save: { skill: 'dodge', dc: 20, onSuccess: 'avoidAttack' },
    },
  ]);
  await triggerMagicOngoing(f.actor, event(), f.context);
  const result = await resolveMagicOngoing(request(f, effect), { user: f.owner }, f.context);
  assert.equal(result.result.success, false);
  assert.equal(f.executions.length, 1);
});
