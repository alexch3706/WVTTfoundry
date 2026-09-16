/** Unit tests of the real runtime/authority functions with controlled document,
 * hook and dice fixtures. These do not simulate or certify a running Foundry. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  actionPlan,
  actorFromUuid,
  check,
  commitActor,
  serial,
  turnIdentity,
} from '../../module/witcher/runtime.js';
import {
  authorizedActor,
  registerAuthority,
  registerCommand,
  runCommand,
} from '../../module/witcher/authority.js';
import { SYSTEM_ID } from '../../module/witcher/config.js';

const clone = (value) => structuredClone(value);
const getProperty = (object, key) => key.split('.').reduce((value, part) => value?.[part], object);
function applyFields(object, changes) {
  for (const [key, value] of Object.entries(changes)) {
    const parts = key.split('.'),
      last = parts.pop();
    let target = object;
    for (const part of parts) target = target[part] ??= {};
    target[last] = clone(value);
  }
}

function actorFixture({ uuid = 'Actor.hero', owners = ['player'], conditions = [], stamina = 25 } = {}) {
  const actor = {
    uuid,
    documentName: 'Actor',
    isOwner: true,
    _source: {
      system: {
        hp: { value: 25 },
        sta: { value: stamina },
        luck: { value: 5 },
        conditions: [...conditions],
        traits: { infiniteStamina: false },
        combat: {
          key: '',
          roundKey: '',
          actions: 0,
          extra: 0,
          defenses: 0,
          remaining: 0,
          full: false,
          weaponId: '',
          npcWeaponId: '',
          npcStrikes: 0,
          style: '',
          attackAction: '',
          extraPenalty: 0,
          strikeIndex: 0,
          reactions: [],
          applied: [],
        },
      },
    },
    items: new Map(),
    writes: [],
    get system() {
      return this._source.system;
    },
    testUserPermission(user, level) {
      return level === 'OWNER' && !!user && (user.isGM || owners.includes(user.id));
    },
    async update(changes) {
      this.writes.push({ kind: 'actor', changes: clone(changes) });
      applyFields(this._source, changes);
      return this;
    },
    async updateEmbeddedDocuments(type, changes) {
      assert.equal(type, 'Item');
      this.writes.push({ kind: 'items', changes: clone(changes) });
      for (const { _id, ...fields } of changes) applyFields(this.items.get(_id)._source, fields);
      return changes.map(({ _id }) => this.items.get(_id));
    },
  };
  for (const [id, quantity] of [
    ['arrows', 5],
    ['bolts', 7],
  ])
    actor.items.set(id, {
      id,
      _source: { system: { quantity } },
      get system() {
        return this._source.system;
      },
    });
  return actor;
}

function environment(t, actor = actorFixture()) {
  const names = ['foundry', 'game', 'ui', 'Hooks', 'ChatMessage', 'Roll'];
  const previous = new Map(names.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  t.after(() => {
    for (const [name, descriptor] of previous)
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
  });
  const gm = { id: 'gm', active: true, isGM: true, isActiveGM: true };
  const player = { id: 'player', active: true, isGM: false, isActiveGM: false };
  const outsider = { id: 'outsider', active: true, isGM: false, isActiveGM: false };
  const users = [gm, player, outsider];
  users.activeGM = gm;
  const docs = new Map([[actor.uuid, actor]]),
    notices = [],
    hooks = new Map();
  let nextId = 0;
  globalThis.foundry = {
    utils: {
      deepClone: clone,
      getProperty,
      fromUuid: async (uuid) => docs.get(uuid),
      randomID: () => (++nextId).toString().padStart(16, '0'),
    },
  };
  globalThis.game = {
    user: gm,
    users,
    messages: [],
    combat: { id: 'combat', started: true, round: 1, turn: 0, combatant: { actor } },
  };
  globalThis.ui = { notifications: { error: (message) => notices.push(message) } };
  globalThis.Hooks = {
    on: (name, handler) => {
      if (!hooks.has(name)) hooks.set(name, []);
      hooks.get(name).push(handler);
    },
  };
  async function dispatch(name, ...args) {
    return Promise.all((hooks.get(name) ?? []).map((handler) => handler(...args)));
  }
  function messageFixture({
    name = 'fixture',
    author = player,
    command = 'unit-command',
    payload = {},
    id = name,
  } = {}) {
    const message = {
      id: name,
      uuid: `ChatMessage.${name}`,
      author,
      flags: { [SYSTEM_ID]: { kind: 'command', id, command, payload, status: 'pending' } },
      writes: [],
      async update(changes) {
        this.writes.push(clone(changes));
        applyFields(this, changes);
        await dispatch('updateChatMessage', this);
        return this;
      },
    };
    return message;
  }
  return { actor, gm, player, outsider, users, docs, notices, dispatch, messageFixture };
}

test('commitActor awaits actor and embedded writes before its callback and returns the callback result', async (t) => {
  const { actor } = environment(t);
  const result = await commitActor(
    actor,
    { 'system.sta.value': 22 },
    [{ _id: 'arrows', 'system.quantity': 4 }],
    async () => {
      assert.equal(actor.system.sta.value, 22);
      assert.equal(actor.items.get('arrows').system.quantity, 4);
      assert.deepEqual(
        actor.writes.map((write) => write.kind),
        ['actor', 'items']
      );
      return { uuid: 'ChatMessage.attack' };
    }
  );
  assert.equal(result.uuid, 'ChatMessage.attack');
});

test('failed chat callback rolls back spent STA, Luck, conditions and ammunition without touching unrelated HP', async (t) => {
  const { actor } = environment(t);
  const failure = new Error('Chat persistence failed');
  await assert.rejects(
    () =>
      commitActor(
        actor,
        { 'system.sta.value': 22, 'system.luck.value': 3, 'system.conditions': ['staggered'] },
        [{ _id: 'arrows', 'system.quantity': 4 }],
        async () => {
          throw failure;
        }
      ),
    (error) => error === failure
  );
  assert.equal(actor.system.sta.value, 25);
  assert.equal(actor.system.luck.value, 5);
  assert.equal(actor.system.hp.value, 25);
  assert.deepEqual(actor.system.conditions, []);
  assert.equal(actor.items.get('arrows').system.quantity, 5);
});

test('partially failed embedded write restores all affected items and does not call the receipt callback', async (t) => {
  const { actor } = environment(t);
  const writeItems = actor.updateEmbeddedDocuments.bind(actor);
  let first = true,
    callbacks = 0;
  actor.updateEmbeddedDocuments = async (type, changes) => {
    if (first) {
      first = false;
      await writeItems(type, changes.slice(0, 1));
      throw new Error('Partial embedded failure');
    }
    return writeItems(type, changes);
  };
  await assert.rejects(
    () =>
      commitActor(
        actor,
        { 'system.sta.value': 22 },
        [
          { _id: 'arrows', 'system.quantity': 4 },
          { _id: 'bolts', 'system.quantity': 6 },
        ],
        () => callbacks++
      ),
    /Partial embedded failure/
  );
  assert.equal(callbacks, 0);
  assert.equal(actor.system.sta.value, 25);
  assert.equal(actor.items.get('arrows').system.quantity, 5);
  assert.equal(actor.items.get('bolts').system.quantity, 7);
});

test('missing embedded equipment aborts before spending any actor resources', async (t) => {
  const { actor } = environment(t);
  await assert.rejects(
    () => commitActor(actor, { 'system.sta.value': 22 }, [{ _id: 'gone', 'system.quantity': 0 }]),
    /Equipment changed/
  );
  assert.equal(actor.writes.length, 0);
});

test('incomplete rollback reports recovery failure while preserving the original error', async (t) => {
  const { actor, notices } = environment(t);
  const writeActor = actor.update.bind(actor);
  let writes = 0;
  actor.update = async (changes) => {
    if (++writes > 1) throw new Error('Rollback transport failure');
    return writeActor(changes);
  };
  const failure = new Error('Receipt write failure');
  await assert.rejects(
    () =>
      commitActor(actor, { 'system.sta.value': 22 }, [], () => {
        throw failure;
      }),
    (error) => error === failure
  );
  assert.equal(notices.length, 1);
  assert.match(notices[0], /rollback was incomplete/);
});

test('a rejected serialized operation does not block the next operation on the same actor', async () => {
  const events = [];
  const first = serial('unit-actor', async () => {
    events.push('first');
    throw new Error('Expected failure');
  });
  const second = serial('unit-actor', async () => {
    events.push('second');
    return 2;
  });
  await assert.rejects(first, /Expected failure/);
  assert.equal(await second, 2);
  assert.deepEqual(events, ['first', 'second']);
});

const sword = { id: 'sword', type: 'weapon', category: 'sword', properties: {}, rof: 1 };
test('runtime continuation checks the current turn and conditions before allowing a second fast strike', async (t) => {
  const { actor } = environment(t);
  const expectedTurn = turnIdentity();
  await actor.update(actionPlan(actor, { weapon: sword, style: 'fast', expectedTurn }).changes);
  assert.equal(actor.system.combat.remaining, 1);
  game.combat.turn = 1;
  assert.throws(() => actionPlan(actor, { weapon: sword, style: 'fast', expectedTurn }), /turn changed/);
  game.combat.turn = 0;
  for (const status of ['stunned', 'unconscious', 'pinned', 'dead']) {
    actor.system.conditions = [status];
    assert.throws(
      () => actionPlan(actor, { weapon: sword, style: 'fast', expectedTurn }),
      /cannot act|recovery or escape/
    );
  }
  actor.system.conditions = [];
  const second = actionPlan(actor, { weapon: sword, style: 'fast', expectedTurn });
  assert.equal(second.continuing, true);
  assert.equal(second.cost, 0);
  assert.equal(second.budget.remaining, 0);
  game.combat.combatant.actor = { uuid: 'Actor.other' };
  assert.throws(() => actionPlan(actor, { weapon: sword, style: 'fast', expectedTurn }), /tracker/);
});

test('ending combat invalidates an open attack dialog instead of silently spending outside combat', (t) => {
  const { actor } = environment(t),
    expectedTurn = turnIdentity();
  game.combat.started = false;
  assert.throws(() => actionPlan(actor, { weapon: sword, expectedTurn }), /turn changed/);
  assert.equal(actor.writes.length, 0);
});

test('defense spending resets by round and does not consume the attacker turn or allow negative STA', async (t) => {
  const { actor } = environment(t);
  game.combat.combatant.actor = { uuid: 'Actor.enemy' };
  await actor.update(actionPlan(actor, { defense: true }).changes);
  assert.equal(actor.system.combat.defenses, 1);
  assert.equal(actor.system.sta.value, 25);
  await actor.update(actionPlan(actor, { defense: true }).changes);
  assert.equal(actor.system.sta.value, 24);
  actor.system.sta.value = 0;
  assert.throws(() => actionPlan(actor, { defense: true }), /Not enough Stamina/);
  actor.system.conditions = ['activelyDodging'];
  assert.equal(actionPlan(actor, { defense: true }).cost, 0);
  actor.system.conditions = [];
  game.combat.round++;
  assert.equal(actionPlan(actor, { defense: true }).cost, 0);
});

test('a creature completes printed ROF once, and defense in the next round permits a fresh attack sequence', async (t) => {
  const { actor } = environment(t);
  const claws = { ...sword, id: 'claws', category: 'natural', rof: 2, properties: { natural: true } };
  const options = { weapon: claws, npc: true, style: 'normal' };
  await actor.update(actionPlan(actor, options).changes);
  await actor.update(actionPlan(actor, options).changes);
  assert.equal(actor.system.combat.npcStrikes, 2);
  assert.throws(() => actionPlan(actor, { ...options, extra: true }), /cannot reset ROF/);
  game.combat.round++;
  await actor.update(actionPlan(actor, { defense: true }).changes);
  const next = actionPlan(actor, options);
  assert.equal(next.budget.npcStrikes, 1);
  assert.equal(next.budget.remaining, 1);
});

test('runtime pays an extra action once and preserves its penalty for the second strike', async (t) => {
  const { actor } = environment(t);
  const first = actionPlan(actor, { weapon: sword, style: 'fast', extra: true });
  await actor.update(first.changes);
  assert.equal(actor.system.sta.value, 22);
  const second = actionPlan(actor, { weapon: sword, style: 'fast' });
  await actor.update(second.changes);
  assert.equal(second.modifier, -3);
  assert.equal(actor.system.sta.value, 22);
  actor.system.traits.infiniteStamina = true;
  actor.system.sta.value = 0;
  game.combat.round++;
  assert.equal(actionPlan(actor, { weapon: sword, extra: true }).cost, 0);
});

test('actual check() evaluates exploding/fumbling d10 chains and returns evaluated roll objects', async (t) => {
  environment(t);
  let totals = [10, 10, 4];
  globalThis.Roll = class UnitRoll {
    static validate(formula) {
      return formula === '1d10';
    }
    constructor(formula) {
      this.formula = formula;
      this.evaluated = false;
    }
    async evaluate() {
      this.total = totals.shift();
      this.evaluated = true;
      return this;
    }
  };
  let result = await check(12);
  assert.equal(result.total, 36);
  assert.equal(result.source, 'automatic');
  assert(result.rolls.every((roll) => roll.evaluated));
  totals = [1, 10, 4];
  result = await check(12);
  assert.equal(result.total, 0);
  assert.equal(result.fumble, 14);
  totals = [7];
  result = await check(12, { manualDice: '  ' });
  assert.equal(result.total, 19);
  assert.equal(result.source, 'automatic');
  assert.equal(result.rolls.length, 1);
});

test('UUID resolution and authority distinguish two unlinked tokens sharing a world actor', async (t) => {
  const { docs, player, outsider } = environment(t);
  const one = actorFixture({ uuid: 'Scene.scene.Token.one.Actor.hero' });
  const two = actorFixture({ uuid: 'Scene.scene.Token.two.Actor.hero' });
  docs.set('Scene.scene.Token.one', { documentName: 'Token', actor: one });
  docs.set(two.uuid, two);
  assert.equal(await actorFromUuid('Scene.scene.Token.one'), one);
  assert.equal(await authorizedActor(two.uuid, player), two);
  await assert.rejects(() => authorizedActor(two.uuid, outsider), /do not own/);
  await assert.rejects(() => authorizedActor('Actor.missing', player), /do not own/);
});

test('GM request execution uses authenticated message author, not user IDs supplied in payload', async (t) => {
  const { actor, player, outsider, dispatch, messageFixture } = environment(t);
  const seen = [];
  registerCommand('unit-auth', async (payload, context) => {
    const target = await authorizedActor(payload.actorUuid, context.user);
    seen.push(context.user.id);
    await target.update({ 'system.sta.value': target.system.sta.value - 1 });
  });
  registerAuthority();
  const unauthorized = messageFixture({
    name: 'bad',
    author: outsider,
    command: 'unit-auth',
    payload: { actorUuid: actor.uuid, userId: player.id },
  });
  await dispatch('createChatMessage', unauthorized);
  assert.equal(unauthorized.flags[SYSTEM_ID].status, 'error');
  assert.equal(actor.system.sta.value, 25);
  const authorized = messageFixture({
    name: 'good',
    author: player,
    command: 'unit-auth',
    payload: { actorUuid: actor.uuid, userId: outsider.id },
  });
  await dispatch('createChatMessage', authorized);
  assert.equal(authorized.flags[SYSTEM_ID].status, 'done');
  assert.deepEqual(seen, ['player']);
  assert.equal(actor.system.sta.value, 24);
});

test('duplicate delivery of one pending command executes only once, including after completion', async (t) => {
  const { dispatch, messageFixture } = environment(t);
  let calls = 0;
  registerCommand('unit-once', async () => {
    calls++;
    return { uuid: 'ChatMessage.result' };
  });
  registerAuthority();
  const message = messageFixture({ command: 'unit-once' });
  await Promise.all([dispatch('createChatMessage', message), dispatch('createChatMessage', message)]);
  await dispatch('createChatMessage', message);
  assert.equal(calls, 1);
  assert.equal(message.flags[SYSTEM_ID].status, 'done');
  assert.equal(message.flags[SYSTEM_ID].resultUuid, 'ChatMessage.result');
});

test('failed receipt after command success never repeats the resource-changing handler', async (t) => {
  const { actor, dispatch, messageFixture, notices } = environment(t);
  let calls = 0;
  registerCommand('unit-receipt', async () => {
    calls++;
    await actor.update({ 'system.sta.value': actor.system.sta.value - 3 });
  });
  registerAuthority();
  const message = messageFixture({ command: 'unit-receipt' });
  const update = message.update.bind(message);
  message.update = async (changes) => {
    if (changes[`flags.${SYSTEM_ID}.status`] === 'done') throw new Error('Receipt unavailable');
    return update(changes);
  };
  const originalError = console.error;
  console.error = () => {};
  try {
    await dispatch('createChatMessage', message);
  } finally {
    console.error = originalError;
  }
  await dispatch('createChatMessage', message);
  assert.equal(calls, 1);
  assert.equal(actor.system.sta.value, 22);
  assert.equal(message.flags[SYSTEM_ID].status, 'running');
  assert.match(notices[0], /Receipt unavailable/);
});

test('player runCommand reaches elected GM and resolves only after its persistent completion receipt', async (t) => {
  const { actor, gm, player, dispatch, messageFixture } = environment(t);
  let received;
  registerCommand('unit-player', async (payload, context) => {
    received = context.user;
    await authorizedActor(payload.actorUuid, context.user);
    return { uuid: 'ChatMessage.player-result' };
  });
  registerAuthority();
  globalThis.ChatMessage = {
    create: async (data) => {
      const request = data.flags[SYSTEM_ID];
      const message = messageFixture({
        name: request.id,
        id: request.id,
        author: player,
        command: request.command,
        payload: request.payload,
      });
      assert(data.whisper.includes(gm.id) && data.whisper.includes(player.id));
      game.user = gm;
      await dispatch('createChatMessage', message);
      game.user = player;
      return message;
    },
  };
  game.user = player;
  const result = await runCommand('unit-player', { actorUuid: actor.uuid });
  assert.equal(received, player);
  assert.equal(result, 'ChatMessage.player-result');
});
