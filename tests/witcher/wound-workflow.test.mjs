/** Real registered wound commands with controlled document, dice, and chat
 * persistence. These integration tests do not simulate a Foundry server. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { STATS, SKILLS, HUMANOID_LOCATIONS, SYSTEM_ID } from '../../module/witcher/config.js';
import { derivedStats } from '../../module/witcher/rules.js';
import { woundItemData } from '../../module/witcher/wound-catalog.js';
import { woundModifiers, woundConditions } from '../../module/witcher/wounds.js';
import { runCommand, registerAuthority } from '../../module/witcher/authority.js';

const clone = (value) => structuredClone(value);
const getProperty = (value, key) => key.split('.').reduce((result, part) => result?.[part], value);
function patch(target, changes) {
  for (const [key, value] of Object.entries(changes)) {
    const parts = key.split('.'),
      last = parts.pop();
    let current = target;
    for (const part of parts) current = current[part] ??= {};
    if (last.startsWith('-=')) delete current[last.slice(2)];
    else current[last] = clone(value);
  }
}
class Collection extends Map {
  [Symbol.iterator]() {
    return this.values();
  }
  map(fn) {
    return [...this.values()].map(fn);
  }
  filter(fn) {
    return [...this.values()].filter(fn);
  }
  find(fn) {
    return [...this.values()].find(fn);
  }
  some(fn) {
    return [...this.values()].some(fn);
  }
}
function system(data) {
  Object.defineProperty(data, 'toObject', { enumerable: false, value: () => clone(data) });
  return data;
}

async function workflow(t) {
  const globals = ['foundry', 'game', 'ui', 'Hooks', 'ChatMessage', 'Roll', 'Actor', 'Item', 'canvas'];
  const previous = new Map(globals.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  t.after(() => {
    for (const [key, descriptor] of previous)
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
  });
  let sequence = 0;
  const randomID = () => String(++sequence).padStart(16, '0');
  const docs = new Map(),
    actors = new Collection(),
    messages = new Collection(),
    hooks = new Map();
  const rolls = [],
    notices = [],
    faults = { message: null, item: null, actor: null };
  const gm = { id: 'gm', isGM: true, isActiveGM: true, active: true };
  const player = { id: 'player', isGM: false, isActiveGM: false, active: true };
  const users = new Collection([
    ['gm', gm],
    ['player', player],
  ]);
  users.activeGM = gm;
  globalThis.foundry = {
    abstract: { TypeDataModel: class {} },
    data: { fields: {} },
    utils: { deepClone: clone, getProperty, randomID, fromUuid: async (uuid) => docs.get(uuid) },
  };
  globalThis.Actor = class {
    prepareDerivedData() {}
  };
  globalThis.Item = class {};
  globalThis.canvas = { tokens: { controlled: [] } };
  globalThis.ui = { notifications: { error: (message) => notices.push(message) } };
  globalThis.Hooks = {
    on(name, callback) {
      hooks.set(name, [...(hooks.get(name) ?? []), callback]);
    },
  };
  globalThis.game = {
    user: gm,
    users,
    actors,
    messages,
    time: { worldTime: 0 },
    settings: { get: () => 'publicroll' },
  };
  const { WitcherActor } = await import('../../module/witcher/documents.js');
  const { registerWoundActions, woundFingerprint } = await import('../../module/witcher/wound-actions.js');
  const { registerActivities } = await import('../../module/witcher/activities.js');
  registerWoundActions();
  registerActivities();
  registerAuthority();
  globalThis.Roll = class {
    static validate(formula) {
      return typeof formula === 'string' && !!formula;
    }
    constructor(formula) {
      this.formula = formula;
    }
    async evaluate() {
      assert(rolls.length, `Unexpected roll ${this.formula}`);
      const expected = rolls.shift();
      assert.equal(this.formula, expected.formula);
      this.total = expected.total;
      return this;
    }
    toJSON() {
      return { formula: this.formula, total: this.total };
    }
  };
  globalThis.ChatMessage = {
    getSpeaker: ({ actor }) => ({ actor: actor.id, alias: actor.name }),
    applyRollMode() {},
    async create(data) {
      if (faults.message?.(data)) throw new Error('Injected chat failure');
      const id = data._id ?? randomID();
      const message = {
        ...JSON.parse(JSON.stringify(data)),
        id,
        uuid: `ChatMessage.${id}`,
        author: users.get(data.author ?? game.user.id),
        async update(changes) {
          patch(this, changes);
          for (const callback of hooks.get('updateChatMessage') ?? []) callback(this);
          return this;
        },
      };
      messages.set(id, message);
      docs.set(message.uuid, message);
      // Process the authenticated player's message as the elected GM. The
      // command author remains the player, exercising actual permission checks.
      if (message.flags?.[SYSTEM_ID]?.kind === 'command') game.user = gm;
      for (const callback of hooks.get('createChatMessage') ?? []) callback(message);
      return message;
    },
  };
  function makeActor(name, overrides = {}, owned = true) {
    const id = randomID();
    const actor = {
      id,
      uuid: `Actor.${id}`,
      name,
      type: 'character',
      isOwner: true,
      items: new Collection(),
      testUserPermission: (user, level) => level === 'OWNER' && !!user && (user.isGM || owned),
      getActiveTokens: () => [],
      _source: {
        system: system({
          stats: Object.fromEntries(STATS.map((key) => [key, key === 'body' ? 7 : 5])),
          skills: Object.fromEntries(Object.keys(SKILLS).map((key) => [key, 5])),
          hp: { value: 25, max: 30 },
          sta: { value: 25, max: 30 },
          luck: { value: 5, max: 5 },
          race: 'human',
          anatomy: 'humanoid',
          locations: clone(HUMANOID_LOCATIONS),
          conditions: [],
          effects: [],
          traits: {},
          transport: {},
          customSkills: [],
          professionRanks: {},
          resistances: [],
          naturalResistances: [],
          immunities: [],
          vulnerabilities: [],
          overrides: {},
          environment: {},
          organless: false,
          deathSaves: 0,
          pendingDeathSaves: 0,
          unconsciousRecovery: 0,
          healingEnabled: false,
          healingBonus: 0,
          combat: {
            key: '',
            roundKey: '',
            actions: 0,
            extra: 0,
            defenses: 0,
            remaining: 0,
            full: false,
            strikeIndex: 0,
            attackAction: '',
            npcWeaponId: '',
            npcStrikes: 0,
            weaponId: '',
            style: '',
            extraPenalty: 0,
            aim: 0,
            applied: [],
            reactions: [],
          },
          ...clone(overrides),
        }),
      },
      get system() {
        return this._source.system;
      },
      prepare() {
        this.system.derived = derivedStats(
          this.system,
          this.items.map((i) => ({ id: i.id, type: i.type, ...i.system.toObject() }))
        );
        this.system.hp.max = this.system.derived.hpMax;
        this.system.sta.max = this.system.derived.staMax;
      },
      skillBase(key, options) {
        return WitcherActor.prototype.skillBase.call(this, key, options);
      },
      rest(options) {
        return WitcherActor.prototype.rest.call(this, options);
      },
      async update(changes) {
        if (faults.actor?.(this, changes)) throw new Error('Injected actor failure');
        patch(this._source, changes);
        this.prepare();
        return this;
      },
      async createEmbeddedDocuments(type, records) {
        assert.equal(type, 'Item');
        return records.map((record) => {
          const itemId = randomID();
          const data = clone(record.system);
          if (record.type === 'wound')
            data.wound = {
              daysRemaining: 0,
              daysTotal: 0,
              turnsTreated: 0,
              magicUses: 0,
              recoveryBody: 0,
              recoveryPending: false,
              recoveryContext: '',
              extraResult: 0,
              notes: '',
              endedConditions: [],
              ageRounds: 0,
              damagePerTurn: 0,
              stabilizedDamagePerTurn: 0,
              stunEvery: 0,
              stabilizedStunEvery: 0,
              healedModifiers: {},
              permanent: false,
              fatal: false,
              ...data.wound,
            };
          const item = {
            id: itemId,
            uuid: `${actor.uuid}.Item.${itemId}`,
            actor,
            name: record.name,
            type: record.type,
            isOwner: true,
            _source: { system: system(data) },
            get system() {
              return this._source.system;
            },
            async update(changes) {
              patch(this._source, changes);
              actor.prepare();
              if (faults.item?.(this, changes)) throw new Error('Injected embedded failure');
              return this;
            },
            toObject() {
              return { _id: this.id, name: this.name, type: this.type, system: this.system.toObject() };
            },
          };
          actor.items.set(itemId, item);
          docs.set(item.uuid, item);
          actor.prepare();
          return item;
        });
      },
      async updateEmbeddedDocuments(type, records) {
        assert.equal(type, 'Item');
        const results = [];
        for (const { _id, ...fields } of records) results.push(await this.items.get(_id).update(fields));
        return results;
      },
      async deleteEmbeddedDocuments(type, ids) {
        assert.equal(type, 'Item');
        const removed = ids.map((id) => this.items.get(id)).filter(Boolean);
        for (const id of ids) {
          docs.delete(this.items.get(id)?.uuid);
          this.items.delete(id);
        }
        this.prepare();
        return removed;
      },
    };
    actor.prepare();
    docs.set(actor.uuid, actor);
    actors.set(id, actor);
    return actor;
  }
  const patient = makeActor('Patient');
  const healer = makeActor('Doctor', {
    customSkills: [{ id: 'healingHands', name: 'Healing Hands', stat: 'cra', rank: 5 }],
  });
  game.combat = { id: 'combat', started: false, round: 1, turn: 0, combatant: { actor: healer } };
  const turn = () =>
    game.combat.started ? `${game.combat.id}:${game.combat.round}:${game.combat.turn}` : '';
  const add = (key, location, actor = patient) =>
    runCommand('addWound', { actorUuid: actor.uuid, key, location });
  const act = (item, action, options = {}, expected = woundFingerprint(item)) =>
    runCommand('woundAction', {
      actorUuid: item.actor.uuid,
      itemId: item.id,
      action,
      options,
      expected,
    });
  const medical = (item, options = {}, expected) =>
    act(
      item,
      'medical',
      {
        healerUuid: healer.uuid,
        kind: 'treat',
        modifier: 0,
        rounds: 1,
        manualDice: '6',
        turn: turn(),
        ...options,
      },
      expected
    );
  const enqueue = (...values) => rolls.push(...values.map(([formula, total]) => ({ formula, total })));
  const asPlayer = async (callback) => {
    game.user = player;
    try {
      return await callback();
    } finally {
      game.user = gm;
    }
  };
  return {
    patient,
    healer,
    makeActor,
    add,
    act,
    medical,
    enqueue,
    asPlayer,
    turn,
    rolls,
    notices,
    faults,
    messages,
    woundFingerprint,
  };
}

test('adding a wound rolls its one-time detail, preserves hit HP, and uses the catalog factory', async (t) => {
  const w = await workflow(t);
  const hp = w.patient.system.hp.value;
  w.enqueue(['1d10', 7], ['1d6', 4]);
  const teeth = await w.add('complex-4', 'head');
  const concussion = await w.add('difficult-4', 'head');
  assert.equal(teeth.system.wound.extraResult, 7);
  assert.equal(teeth.system.wound.notes, 'Teeth lost: 7');
  assert.equal(concussion.system.wound.stunEvery, 4);
  assert.equal(teeth.system.wound.treatment, 'untreated');
  assert.equal(w.patient.system.hp.value, hp);
  assert.equal(teeth.system.description, woundItemData({ key: 'complex-4' }).system.description);
  await w.act(teeth, 'markStabilized');
  await w.act(concussion, 'markStabilized');
  assert.equal(teeth.system.wound.extraResult, 7);
  assert.equal(concussion.system.wound.stunEvery, 4);
  assert.equal(w.rolls.length, 0);
  assert.equal(w.patient.items.size, 2);
});

test('add rejects organless organs, incompatible anatomy, unknown keys, and unauthorized actors before writes', async (t) => {
  const w = await workflow(t);
  await w.patient.update({ 'system.organless': true });
  await assert.rejects(() => w.add('simple-2', 'torso'), /Organless/);
  await assert.rejects(() => w.add('simple-0', 'head'), /location/);
  await assert.rejects(() => w.add('unknown-1', 'head'), /Unknown/);
  const other = w.makeActor('Someone else', {}, false);
  await assert.rejects(() => w.asPlayer(() => w.add('simple-0', 'leftLeg', other)), /do not own/);
  assert.equal(w.patient.items.size, 0);
  assert.equal(other.items.size, 0);
  assert.equal(w.rolls.length, 0);
});

test('fatal wounds mark dead and reject care; Heart Damage resolves exactly one pending Death save with a receipt', async (t) => {
  const w = await workflow(t);
  const fatal = await w.add('deadly-5', 'head');
  assert(w.patient.system.conditions.includes('dead'));
  await assert.rejects(() => w.act(fatal, 'markStabilized'), /fatal/);
  await assert.rejects(() => w.act(fatal, 'heal'), /fatal/);
  const second = w.makeActor('Heart patient');
  w.enqueue(['1d10', 2]);
  const heart = await w.add('deadly-3', 'torso', second);
  assert.equal(second.system.pendingDeathSaves, 0);
  assert.equal(second.system.deathSaves, 1);
  assert(second.system.combat.applied.includes(`wound:${heart.id}:death`));
  assert(!second.system.conditions.includes('dead'));
  await w.act(heart, 'markStabilized');
  assert.equal(second.system.deathSaves, 1);
  assert.equal(w.rolls.length, 0);
});

test('medical treatment accumulates complete rounds, fails on a DC tie, and starts recovery only after success', async (t) => {
  const w = await workflow(t),
    injury = await w.add('complex-0', 'leftLeg');
  await w.medical(injury, { rounds: 2 });
  assert.equal(injury.system.wound.turnsTreated, 2);
  assert.equal(injury.system.wound.treatment, 'untreated');
  await w.medical(injury, { rounds: 2, manualDice: '4' }); // CRA5+Healing Hands5+4 ties DC14.
  assert.equal(injury.system.wound.turnsTreated, 0);
  assert.equal(injury.system.wound.treatment, 'untreated');
  await w.medical(injury, { rounds: 4, manualDice: '5' });
  assert.equal(injury.system.wound.treatment, 'treated');
  assert.equal(injury.system.wound.daysRemaining, 5);
  assert.equal(injury.system.wound.recoveryPending, false);
  assert.equal(w.patient.system.hp.value, 25);
  assert.equal(w.rolls.length, 0);
});

test('First Aid stabilizes without a clock, Healing Hands requires the profession skill, and combat pays one action per round', async (t) => {
  const w = await workflow(t),
    injury = await w.add('simple-0', 'leftLeg');
  await w.medical(injury, { kind: 'stabilize', manualDice: '3' });
  assert.equal(injury.system.wound.treatment, 'stabilized');
  assert.equal(injury.system.wound.daysRemaining, 0);
  await assert.rejects(
    () => w.medical(injury, { healerUuid: w.patient.uuid, rounds: 2 }),
    /Healing Hands skill/
  );
  game.combat.started = true;
  await assert.rejects(() => w.medical(injury, { rounds: 2 }), /one treatment round/);
  await w.medical(injury);
  assert.equal(w.healer.system.combat.actions, 1);
  assert.equal(injury.system.wound.turnsTreated, 1);
  await assert.rejects(() => w.medical(injury), /action|extra/i);
  game.combat.round += 1;
  await w.medical(injury);
  assert.equal(injury.system.wound.treatment, 'treated');
});

test('partial magic does not stabilize or heal HP/STA; required successful uses begin treatment and stale replay is rejected', async (t) => {
  const w = await workflow(t),
    injury = await w.add('simple-0', 'leftLeg');
  const expected = w.woundFingerprint(injury),
    hp = w.patient.system.hp.value,
    sta = w.patient.system.sta.value;
  await w.act(injury, 'magic', { uses: 3 }, expected);
  assert.equal(injury.system.wound.magicUses, 3);
  assert.equal(injury.system.wound.treatment, 'untreated');
  await assert.rejects(() => w.act(injury, 'magic', { uses: 3 }, expected), /changed while/);
  await assert.rejects(() => w.act(injury, 'magic', { uses: 2 }), /exceed/);
  await w.act(injury, 'magic', { uses: 1 });
  assert.equal(injury.system.wound.treatment, 'treated');
  assert.equal(injury.system.wound.magicUses, 4);
  assert.equal(injury.system.wound.daysRemaining, 1);
  assert.equal(w.patient.system.hp.value, hp);
  assert.equal(w.patient.system.sta.value, sta);
});

test('manual healed state clears ordinary modifiers and retains permanent modifiers without deleting either card', async (t) => {
  const w = await workflow(t),
    ordinary = await w.add('simple-0', 'leftLeg');
  await w.act(ordinary, 'markTreated');
  await w.act(ordinary, 'heal');
  assert.deepEqual(woundModifiers(ordinary.system.wound), {});
  const permanent = await w.add('deadly-1', 'leftArm');
  await w.act(permanent, 'markTreated');
  await w.act(permanent, 'heal');
  assert.equal(woundModifiers(permanent.system.wound).armDisabled, 1);
  assert.equal(w.patient.items.size, 2);
  await assert.rejects(() => w.act(permanent, 'days', { mode: 'set', days: 1 }), /temporary injury/);
});

test('pending recovery requires an explicit GM clock and advancing it preserves a healed history card', async (t) => {
  const w = await workflow(t),
    injury = await w.add('simple-2', 'torso');
  await w.act(injury, 'markTreated');
  assert.equal(injury.system.wound.recoveryPending, true);
  assert.equal(injury.system.wound.daysRemaining, 0);
  await assert.rejects(
    () => w.act(injury, 'days', { mode: 'advance', days: 1 }),
    /set the recovery duration/
  );
  await w.act(injury, 'days', { mode: 'set', days: 3 });
  assert.equal(injury.system.wound.recoveryPending, false);
  await w.asPlayer(() => w.act(injury, 'days', { mode: 'advance', days: 2 }));
  assert.equal(injury.system.wound.daysRemaining, 1);
  await w.act(injury, 'days', { mode: 'advance', days: 1 });
  assert.equal(injury.system.wound.treatment, 'healed');
  assert.equal(w.patient.items.size, 1);
});

test('authenticated player requests cannot mark care, add magic, mark healed, or override a recovery duration', async (t) => {
  const w = await workflow(t),
    injury = await w.add('simple-0', 'leftLeg');
  for (const [action, options] of [
    ['markStabilized', {}],
    ['markTreated', {}],
    ['magic', { uses: 1 }],
    ['heal', {}],
  ])
    await assert.rejects(() => w.asPlayer(() => w.act(injury, action, options)), /GM records treatment/);
  await w.asPlayer(() => w.medical(injury, { kind: 'stabilize', manualDice: '3' }));
  assert.equal(injury.system.wound.treatment, 'stabilized');
  await w.act(injury, 'markTreated');
  await assert.rejects(
    () => w.asPlayer(() => w.act(injury, 'days', { mode: 'set', days: 5 })),
    /GM records treatment/
  );
});

test('failed treatment persistence restores both healer action budget and the patient wound, including a partial embedded write', async (t) => {
  const w = await workflow(t),
    injury = await w.add('simple-0', 'leftLeg');
  game.combat.started = true;
  const patient = clone(w.patient._source),
    healer = clone(w.healer._source),
    before = clone(injury._source);
  let failed = false;
  w.faults.item = (item) => item === injury && !failed && (failed = true);
  await assert.rejects(() => w.medical(injury), /Injected embedded/);
  assert.deepEqual(w.patient._source, patient);
  assert.deepEqual(w.healer._source, healer);
  assert.deepEqual(injury._source, before);
  w.faults.item = null;
  w.faults.message = () => true;
  await assert.rejects(() => w.medical(injury), /Injected chat/);
  assert.deepEqual(w.patient._source, patient);
  assert.deepEqual(w.healer._source, healer);
  assert.deepEqual(injury._source, before);
});

test('a failed add receipt removes the created injury and rolls back fatal conditions', async (t) => {
  const w = await workflow(t),
    before = clone(w.patient._source);
  w.faults.message = () => true;
  await assert.rejects(() => w.add('deadly-5', 'head'), /Injected chat/);
  assert.equal(w.patient.items.size, 0);
  assert.deepEqual(w.patient._source, before);
});

test('real rest advances only running clocks, retains healed Items, and pauses a changed Critical Healing context', async (t) => {
  const w = await workflow(t),
    ordinary = await w.add('simple-0', 'leftLeg');
  await w.act(ordinary, 'markTreated', { duration: 2 });
  await runCommand('woundRest', { actorUuid: w.patient.uuid, days: 1 });
  assert.equal(ordinary.system.wound.daysRemaining, 1);
  const foreign = await w.add('simple-2', 'torso');
  await runCommand('woundRest', { actorUuid: w.patient.uuid, days: 1 });
  assert.equal(ordinary.system.wound.recoveryPending, true);
  assert.equal(ordinary.system.wound.daysRemaining, 1);
  assert.equal(foreign.system.wound.treatment, 'untreated');
  await w.act(ordinary, 'days', { mode: 'set', days: 1 });
  await runCommand('woundRest', { actorUuid: w.patient.uuid, days: 1 });
  assert.equal(ordinary.system.wound.treatment, 'healed');
  assert.equal(w.patient.items.size, 2);
  game.combat.started = true;
  await assert.rejects(() => runCommand('woundRest', { actorUuid: w.patient.uuid, days: 1 }), /End combat/);
});

test('a failed immediate Death-save receipt retains Heart Damage and its pending save for retry', async (t) => {
  const w = await workflow(t);
  const logged = [],
    previousError = console.error;
  console.error = (...args) => logged.push(args);
  t.after(() => {
    console.error = previousError;
  });
  w.enqueue(['1d10', 2]);
  w.faults.message = (data) => data.content.includes('death save');
  const injury = await w.add('deadly-3', 'torso');
  assert.equal(w.patient.items.get(injury.id), injury);
  assert.equal(w.patient.system.pendingDeathSaves, 1);
  assert.equal(w.patient.system.deathSaves, 0);
  assert.deepEqual(w.patient.system.combat.applied, []);
  assert(w.notices.some((message) => message.includes('Injected chat')));
  assert.equal(logged.length, 1);
  w.faults.message = null;
  w.enqueue(['1d10', 2]);
  const { save } = await import('../../module/witcher/runtime.js');
  await save(w.patient, 'death', { receipt: `wound:${injury.id}:death` });
  assert.equal(w.patient.system.pendingDeathSaves, 0);
  assert.equal(w.patient.system.deathSaves, 1);
  await save(w.patient, 'death', { receipt: `wound:${injury.id}:death` });
  assert.equal(w.patient.system.deathSaves, 1);
  assert.equal(w.rolls.length, 0);
});

test('failed rest rolls back HP, STA and every wound when one clock update partially fails', async (t) => {
  const w = await workflow(t),
    first = await w.add('simple-0', 'leftLeg'),
    second = await w.add('simple-1', 'leftArm');
  await w.act(first, 'markTreated', { duration: 2 });
  await w.act(second, 'markTreated', { duration: 3 });
  await w.patient.update({ 'system.healingEnabled': true, 'system.hp.value': 15, 'system.sta.value': 5 });
  const before = clone(w.patient._source),
    firstBefore = clone(first._source),
    secondBefore = clone(second._source);
  let failed = false;
  w.faults.item = (item) => item === second && !failed && (failed = true);
  await assert.rejects(
    () => runCommand('woundRest', { actorUuid: w.patient.uuid, days: 1 }),
    /Injected embedded/
  );
  assert.deepEqual(w.patient._source, before);
  assert.deepEqual(first._source, firstBefore);
  assert.deepEqual(second._source, secondBefore);
});

test('legacy care never silently clears actor conditions and an explicit clear preserves another active wound', async (t) => {
  const w = await workflow(t),
    first = await w.add('complex-3', 'torso'),
    second = await w.add('difficult-0', 'leftLeg');
  await first.update({ 'system.wound.separateConditions': false });
  await second.update({ 'system.wound.separateConditions': false });
  await w.patient.update({ 'system.conditions': ['bleeding', 'poison'] });
  await w.act(first, 'markStabilized', { clearLegacy: ['bleeding'] });
  assert.deepEqual(w.patient.system.conditions, ['bleeding', 'poison']);
  await w.act(second, 'markStabilized');
  assert.deepEqual(w.patient.system.conditions, ['bleeding', 'poison']);
  const third = await w.add('difficult-5', 'head');
  await third.update({ 'system.wound.separateConditions': false });
  await w.act(third, 'markStabilized', { clearLegacy: ['bleeding'] });
  assert.deepEqual(w.patient.system.conditions, ['poison']);
  assert.equal(w.patient.items.size, 3);
});

test('real round ticks merge wound bleeding once and preserve unrelated poison through each stabilization', async (t) => {
  const w = await workflow(t);
  const { tickActor } = await import('../../module/witcher/activities.js');
  const first = await w.add('complex-3', 'torso'),
    second = await w.add('difficult-0', 'leftLeg');
  await w.patient.update({ 'system.conditions': ['poison'] });
  await tickActor(w.patient, 'round:1');
  assert.equal(w.patient.system.hp.value, 20); // Poison 3 + one Bleeding 2, not 4 from two wounds.
  assert.deepEqual(w.patient.system.conditions, ['poison']);
  await w.act(first, 'markStabilized');
  await tickActor(w.patient, 'round:2');
  assert.equal(w.patient.system.hp.value, 15); // The other untreated injury still bleeds.
  assert.deepEqual(w.patient.system.conditions, ['poison']);
  await w.act(second, 'markStabilized');
  await tickActor(w.patient, 'round:3');
  assert.equal(w.patient.system.hp.value, 12); // Only independent poison remains.
  assert.deepEqual(w.patient.system.conditions, ['poison']);
  await tickActor(w.patient, 'round:3');
  assert.equal(w.patient.system.hp.value, 12); // Duplicate turn processing is idempotent.
  assert.equal(w.rolls.length, 0);
});

test('First Aid ends wound-only bleeding without stabilizing the critical or removing its periodic saves', async (t) => {
  const w = await workflow(t);
  const { tickActor } = await import('../../module/witcher/activities.js');
  const injury = await w.add('complex-3', 'torso');
  assert.deepEqual(w.patient.system.conditions, []);
  await tickActor(w.patient, 'bleed:1');
  assert.equal(w.patient.system.hp.value, 23);
  w.enqueue(['1d10', 6]); // CRA5 + First Aid5 + 6 beats DC15.
  await runCommand('turnAction', {
    actorUuid: w.patient.uuid,
    key: 'endCondition',
    options: { condition: 'bleeding' },
  });
  assert.deepEqual(injury.system.wound.endedConditions, ['bleeding']);
  assert.equal(injury.system.wound.treatment, 'untreated');
  assert.equal(injury.system.wound.stunEvery, 5);
  assert.equal(injury.system.wound.daysRemaining, 0);
  assert.deepEqual(woundConditions([...w.patient.items]), []);
  await tickActor(w.patient, 'bleed:2');
  assert.equal(w.patient.system.hp.value, 23);
  assert.equal(w.rolls.length, 0);
});

test('Endurance ends Septic Shock poison while leaving the untreated Stamina and stat penalties active', async (t) => {
  const w = await workflow(t);
  const { tickActor } = await import('../../module/witcher/activities.js');
  const injury = await w.add('deadly-2', 'torso');
  const before = clone(woundModifiers(injury.system.wound));
  await tickActor(w.patient, 'poison:1');
  assert.equal(w.patient.system.hp.value, 22);
  w.enqueue(['1d10', 6]); // BODY7 + Endurance5 + 6 beats DC15.
  await runCommand('turnAction', {
    actorUuid: w.patient.uuid,
    key: 'endCondition',
    options: { condition: 'poison' },
  });
  assert.deepEqual(injury.system.wound.endedConditions, ['poison']);
  assert.equal(injury.system.wound.treatment, 'untreated');
  assert.deepEqual(woundModifiers(injury.system.wound), before);
  assert.equal(w.patient.system.derived.mods.staMultiplier, 0.25);
  assert.equal(w.patient.system.derived.mods.int, -3);
  await tickActor(w.patient, 'poison:2');
  assert.equal(w.patient.system.hp.value, 22);
  assert.equal(w.rolls.length, 0);
});

test('ending Bleeding clears all existing wound and actor sources, preserves Poison, and permits a new injury to bleed', async (t) => {
  const w = await workflow(t);
  const first = await w.add('complex-3', 'torso'),
    second = await w.add('difficult-0', 'leftLeg'),
    stable = await w.add('difficult-5', 'head');
  await w.act(stable, 'markStabilized');
  await w.patient.update({ 'system.conditions': ['bleeding', 'poison'] });
  w.enqueue(['1d10', 6]);
  await runCommand('turnAction', {
    actorUuid: w.patient.uuid,
    key: 'endCondition',
    options: { condition: 'bleeding' },
  });
  assert.deepEqual(w.patient.system.conditions, ['poison']);
  assert.deepEqual(first.system.wound.endedConditions, ['bleeding']);
  assert.deepEqual(second.system.wound.endedConditions, ['bleeding']);
  assert.deepEqual(stable.system.wound.endedConditions, []);
  assert.equal(second.system.wound.treatment, 'untreated');
  assert.equal(woundModifiers(second.system.wound).spdMultiplier, 0.25);
  assert.deepEqual(woundConditions([...w.patient.items]), []);
  await w.act(first, 'markStabilized');
  assert.deepEqual(first.system.wound.endedConditions, ['bleeding']);
  const newInjury = await w.add('difficult-0', 'rightLeg');
  assert.deepEqual(newInjury.system.wound.endedConditions, []);
  assert.deepEqual(woundConditions([...w.patient.items]), ['bleeding']);
});

test('a DC tie does not end a wound condition, and failed embedded persistence restores every condition source', async (t) => {
  const w = await workflow(t);
  const first = await w.add('complex-3', 'torso'),
    second = await w.add('difficult-0', 'leftLeg');
  w.enqueue(['1d10', 5]); // CRA5 + First Aid5 + 5 ties DC15.
  const end = () =>
    runCommand('turnAction', {
      actorUuid: w.patient.uuid,
      key: 'endCondition',
      options: { condition: 'bleeding' },
    });
  await end();
  assert.deepEqual(first.system.wound.endedConditions, []);
  assert.deepEqual(second.system.wound.endedConditions, []);
  assert.deepEqual(woundConditions([...w.patient.items]), ['bleeding']);
  await w.patient.update({ 'system.conditions': ['bleeding', 'poison'] });
  const beforeActor = clone(w.patient._source),
    beforeFirst = clone(first._source),
    beforeSecond = clone(second._source);
  let failed = false;
  w.faults.item = (item) => item === second && !failed && (failed = true);
  w.enqueue(['1d10', 6]);
  await assert.rejects(end, /Injected embedded/);
  assert.deepEqual(w.patient._source, beforeActor);
  assert.deepEqual(first._source, beforeFirst);
  assert.deepEqual(second._source, beforeSecond);
  assert.deepEqual(woundConditions([...w.patient.items]), ['bleeding']);
});

test('medical treatment applies the selected injured arm penalty and permits the healthy arm', async (t) => {
  const w = await workflow(t),
    injury = await w.add('simple-0', 'leftLeg');
  await w.add('complex-1', 'leftArm', w.healer);
  await w.medical(injury, { rounds: 2, manualDice: '4', woundArm: 'leftArm' });
  assert.equal(injury.system.wound.treatment, 'untreated'); // CRA5 + rank5 −3 arm +4 =11.
  assert.match([...w.messages.values()].at(-1).content, /Base 7/);
  await w.medical(injury, { rounds: 2, manualDice: '4', woundArm: 'rightArm' });
  assert.equal(injury.system.wound.treatment, 'treated'); // Healthy arm gives14 > DC12.
  assert.match([...w.messages.values()].at(-1).content, /Base 10/);
});

test('a healer with both arms disabled cannot perform medicine or spend a treatment action', async (t) => {
  const w = await workflow(t),
    injury = await w.add('simple-0', 'leftLeg');
  await w.add('deadly-1', 'leftArm', w.healer);
  await w.add('deadly-1', 'rightArm', w.healer);
  const beforePatient = clone(w.patient._source),
    beforeHealer = clone(w.healer._source),
    beforeWound = clone(injury._source),
    messages = w.messages.size;
  for (const woundArm of ['leftArm', 'rightArm', 'both'])
    await assert.rejects(() => w.medical(injury, { rounds: 2, woundArm }), /injured arm cannot/);
  assert.deepEqual(w.patient._source, beforePatient);
  assert.deepEqual(w.healer._source, beforeHealer);
  assert.deepEqual(injury._source, beforeWound);
  assert.equal(w.messages.size, messages);
  assert.equal(w.rolls.length, 0);
});

test('the End Condition dialog includes card-induced states even without actor condition flags', async (t) => {
  const w = await workflow(t);
  const { turnAction } = await import('../../module/witcher/activities.js');
  await w.add('complex-3', 'torso');
  await w.add('deadly-2', 'torso');
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'Dialog');
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, 'Dialog', previous);
    else delete globalThis.Dialog;
  });
  let content;
  globalThis.Dialog = class {
    constructor(data) {
      this.data = data;
      content = data.content;
    }
    render() {
      this.data.buttons.cancel.callback();
      return this;
    }
  };
  const before = clone(w.patient._source);
  await turnAction(w.patient, 'endCondition');
  assert.match(content, /value="bleeding"/);
  assert.match(content, /value="poison"/);
  assert.deepEqual(w.patient._source, before);
});

test('dropping, treating and removing a Stamina injury never refills its capped current STA', async (t) => {
  const w = await workflow(t);
  const injury = await w.add('deadly-2', 'torso'); // Septic Shock
  const capped = w.patient.system.sta.max;
  assert(capped < 25);
  assert.equal(w.patient._source.system.sta.value, capped);
  await w.patient.update({ 'system.sta.value': Math.max(0, capped - 1) });
  await w.act(injury, 'markTreated');
  assert.equal(w.patient.system.sta.value, Math.max(0, capped - 1));
  await runCommand('removeWound', {
    actorUuid: w.patient.uuid,
    itemId: injury.id,
    expected: w.woundFingerprint(injury),
  });
  assert.equal(w.patient.items.has(injury.id), false);
  assert.equal(w.patient.system.sta.value, Math.max(0, capped - 1));
});

test('removing a legacy Stamina wound caps old current STA and compensates a cancelled deletion', async (t) => {
  const w = await workflow(t);
  const injury = await w.add('deadly-2', 'torso');
  await w.patient.update({ 'system.sta.value': 25 }); // Legacy over-limit stored resource.
  const originalDelete = w.patient.deleteEmbeddedDocuments;
  w.patient.deleteEmbeddedDocuments = async () => [];
  const remove = () =>
    runCommand('removeWound', {
      actorUuid: w.patient.uuid,
      itemId: injury.id,
      expected: w.woundFingerprint(injury),
    });
  await assert.rejects(remove, /cancelled/);
  assert.equal(w.patient.system.sta.value, 25);
  assert(w.patient.items.has(injury.id));
  w.patient.deleteEmbeddedDocuments = originalDelete;
  const capped = w.patient.system.sta.max;
  await remove();
  assert.equal(w.patient.system.sta.value, capped);
  assert.equal(w.patient.items.has(injury.id), false);
});
