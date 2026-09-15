/** Integration unit tests: real registered combat/inventory command handlers,
 * imported catalog records and controlled document/dice persistence fixtures.
 * No Foundry server, browser, sheet rendering or real network is simulated. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import Handlebars from 'handlebars';
import { armorLocationRows, actorArmorRows } from '../../module/witcher/armor-display.js';
import { STATS, SKILLS, HUMANOID_LOCATIONS, SYSTEM_ID } from '../../module/witcher/config.js';
import { derivedStats } from '../../module/witcher/rules.js';
import { runCommand } from '../../module/witcher/authority.js';

const catalog = ['weapons', 'armor', 'bestiary'].flatMap((name) =>
  JSON.parse(fs.readFileSync(new URL(`../../data/witcher/${name}.json`, import.meta.url)))
);
const row = (name) => {
  const record = catalog.find((entry) => entry.name === name);
  assert(record, name);
  return structuredClone(record);
};
const clone = (value) => structuredClone(value);
const getProperty = (object, key) => key.split('.').reduce((value, part) => value?.[part], object);
function patch(object, changes) {
  for (const [key, value] of Object.entries(changes)) {
    const parts = key.split('.'),
      last = parts.pop();
    let destination = object;
    for (const part of parts) destination = destination[part] ??= {};
    destination[last] = clone(value);
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
function serializableSystem(data) {
  Object.defineProperty(data, 'toObject', { enumerable: false, value: () => clone(data) });
  return data;
}

async function workflow(t, { creature = false, attackerName } = {}) {
  const names = ['foundry', 'game', 'ui', 'Hooks', 'ChatMessage', 'Roll', 'Actor', 'Item', 'canvas'];
  const previous = new Map(names.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  t.after(() => {
    for (const [name, descriptor] of previous)
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
  });
  let nextId = 0;
  const randomID = () => (++nextId).toString().padStart(16, '0');
  const docs = new Map(),
    messages = new Collection(),
    notices = [],
    rolls = [];
  const faults = { create: null, update: null };
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
    utils: {
      deepClone: clone,
      getProperty,
      randomID,
      fromUuid: async (uuid) => docs.get(uuid),
    },
  };
  globalThis.Actor = class {
    prepareDerivedData() {}
  };
  globalThis.Item = class {};
  globalThis.canvas = { tokens: { controlled: [] } };
  globalThis.ui = { notifications: { error: (message) => notices.push(message) } };
  globalThis.Hooks = { on() {} };
  globalThis.game = {
    user: gm,
    users,
    messages,
    time: { worldTime: 0 },
    settings: { get: () => 'publicroll' },
  };
  const { WitcherActor } = await import('../../module/witcher/documents.js');
  const { registerCombatChat } = await import('../../module/witcher/combat.js');
  const { registerInventory } = await import('../../module/witcher/inventory.js');
  registerCombatChat();
  registerInventory();
  globalThis.Roll = class UnitRoll {
    static validate(formula) {
      return typeof formula === 'string' && formula.length > 0;
    }
    constructor(formula) {
      this.formula = formula;
    }
    async evaluate() {
      assert(rolls.length, `Unexpected dice request: ${this.formula}`);
      const expected = rolls.shift();
      assert.equal(this.formula, expected.formula, 'Unexpected dice formula');
      this.total = expected.total;
      this.evaluated = true;
      return this;
    }
    toJSON() {
      return { formula: this.formula, total: this.total, evaluated: this.evaluated };
    }
  };
  globalThis.ChatMessage = {
    getSpeaker: ({ actor }) => ({ actor: actor.id, alias: actor.name }),
    applyRollMode() {},
    async create(data, options = {}) {
      if (faults.create?.(data)) throw new Error('Injected message creation failure');
      if (data._id) assert.equal(options.keepId, true, 'Stable chat IDs require keepId');
      const id = data._id ?? randomID();
      assert(!messages.has(id), 'Duplicate chat document ID');
      const stored = JSON.parse(JSON.stringify(data));
      const message = {
        ...stored,
        id,
        uuid: `ChatMessage.${id}`,
        author: gm,
        getFlag(scope, key) {
          return this.flags[scope]?.[key];
        },
        async update(changes) {
          if (faults.update?.(this, changes)) throw new Error('Injected message update failure');
          patch(this, changes);
          return this;
        },
      };
      messages.set(id, message);
      docs.set(message.uuid, message);
      return message;
    },
  };
  function makeActor(name, record = {}) {
    const id = randomID();
    const actor = {
      id,
      uuid: record.uuid ?? `Actor.${id}`,
      name,
      type: record.type ?? 'character',
      isOwner: true,
      items: new Collection(),
      skillCalls: [],
      testUserPermission: (user, level) => level === 'OWNER' && !!user && (user.isGM || user.id === 'player'),
      getActiveTokens: () => [],
      _source: {
        system: serializableSystem({
          stats: Object.fromEntries(STATS.map((key) => [key, 5])),
          statMods: {},
          skills: Object.fromEntries(Object.keys(SKILLS).map((key) => [key, 5])),
          hp: { value: 25, max: 25 },
          sta: { value: 25, max: 25 },
          luck: { value: 5, max: 5 },
          race: 'human',
          category: 'humanoid',
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
          environment: { light: 'daylight', underwater: false },
          organless: false,
          coins: 0,
          deathSaves: 0,
          pendingDeathSaves: 0,
          unconsciousRecovery: 0,
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
          ...clone(record.system ?? {}),
        }),
      },
      get system() {
        return this._source.system;
      },
      prepare() {
        this.system.derived = derivedStats(
          this.system,
          this.items.map((item) => ({ id: item.id, type: item.type, ...item.system.toObject() }))
        );
        this.system.hp.max = this.system.derived.hpMax;
        this.system.sta.max = this.system.derived.staMax;
        this.system.armorError = '';
      },
      skillBase(key, options) {
        this.skillCalls.push({ key, options: clone(options) });
        return WitcherActor.prototype.skillBase.call(this, key, options);
      },
      async update(changes) {
        patch(this._source, changes);
        this.prepare();
        return this;
      },
      async setCondition(condition, enabled = true) {
        return this.update({
          'system.conditions': enabled
            ? [...new Set([...this.system.conditions, condition])]
            : this.system.conditions.filter((value) => value !== condition),
        });
      },
      async createEmbeddedDocuments(type, records) {
        assert.equal(type, 'Item');
        return records.map((record) => {
          const id = randomID();
          const item = {
            id,
            name: record.name,
            type: record.type,
            actor: this,
            isOwner: true,
            _source: {
              system: serializableSystem({
                carried: true,
                equipped: false,
                quantity: 1,
                reliability: 10,
                maxReliability: 10,
                hands: 1,
                handsUsed: 0,
                accuracy: 0,
                weight: 0,
                rof: 1,
                loaded: true,
                jammed: false,
                damage: '1d6',
                properties: {},
                resistances: [],
                coverage: [],
                sp: {},
                ability: {},
                skillBonuses: [],
                ...clone(record.system),
              }),
            },
            get system() {
              return this._source.system;
            },
            async update(changes) {
              patch(this._source, changes);
              actor.prepare();
              return this;
            },
            toObject() {
              return { _id: this.id, name: this.name, type: this.type, system: this.system.toObject() };
            },
          };
          this.items.set(id, item);
          this.prepare();
          return item;
        });
      },
      async updateEmbeddedDocuments(type, changes) {
        assert.equal(type, 'Item');
        return Promise.all(changes.map(({ _id, ...fields }) => this.items.get(_id).update(fields)));
      },
      async deleteEmbeddedDocuments(type, ids) {
        assert.equal(type, 'Item');
        for (const id of ids) this.items.delete(id);
        this.prepare();
      },
    };
    actor.prepare();
    docs.set(actor.uuid, actor);
    return actor;
  }
  const attacker = makeActor('Hero', attackerName ? row(attackerName) : {});
  if (attackerName)
    await attacker.createEmbeddedDocuments(
      'Item',
      row(attackerName).items.filter((item) => item.type === 'weapon')
    );
  const target = makeActor(
    'Target',
    creature ? { ...row('Drowner'), uuid: 'Scene.unit.Token.one.Actor.drowner' } : {}
  );
  game.combat = { id: 'combat', started: false, round: 1, turn: 0, combatant: { actor: attacker } };
  async function importItem(actor, name, { equipped = false } = {}) {
    const [item] = await actor.createEmbeddedDocuments('Item', [row(name)]);
    if (equipped)
      await runCommand('inventory', { actorUuid: actor.uuid, itemId: item.id, patch: { equipped: true } });
    return item;
  }
  const start = () => {
    game.combat.started = true;
  };
  const turn = () => `${game.combat.id}:${game.combat.round}:${game.combat.turn}`;
  const attack = (item, values = {}) =>
    runCommand('attack', {
      actorUuid: attacker.uuid,
      targetUuid: target.uuid,
      itemId: item?.id,
      expectedTurn: turn(),
      values: {
        action: 'normal',
        style: 'fast',
        location: 'torso',
        type: item?.system.damageTypes?.[0] ?? 'bludgeoning',
        modifier: 0,
        luck: 0,
        cover: 0,
        extra: false,
        ...values,
      },
    });
  const defend = (message, values = {}) =>
    runCommand('defend', {
      messageUuid: message.uuid,
      expectedTurn: turn(),
      values: {
        defense: 'dodge',
        weapon: '',
        arm: 'leftArm',
        modifier: 0,
        gang: 1,
        dc: 10,
        luck: 0,
        ...values,
      },
    });
  const apply = (message) => runCommand('applyDamage', { messageUuid: message.uuid });
  const enqueue = (...items) => rolls.push(...items.map(([formula, total]) => ({ formula, total })));
  const damageFor = (message) =>
    messages.find(
      (item) => item.flags[SYSTEM_ID]?.kind === 'damage' && item.flags[SYSTEM_ID].attackRef === message.uuid
    );
  return {
    attacker,
    target,
    importItem,
    start,
    turn,
    attack,
    defend,
    apply,
    enqueue,
    damageFor,
    makeActor,
    messages,
    notices,
    faults,
    rolls,
  };
}

test('imported sword must be equipped; registered commands preserve two fast strikes and two paid extra strikes', async (t) => {
  const w = await workflow(t),
    sword = await w.importItem(w.attacker, 'Arming Sword');
  w.start();
  await assert.rejects(() => w.attack(sword), /Equip|equip/);
  game.combat.started = false;
  await runCommand('inventory', { actorUuid: w.attacker.uuid, itemId: sword.id, patch: { equipped: true } });
  w.start();
  w.enqueue(['1d10', 5], ['1d10', 5], ['1d10', 5], ['1d10', 5]);
  const first = await w.attack(sword);
  assert.equal(w.attacker.system.combat.remaining, 1);
  await w.attack(sword);
  assert.equal(w.attacker.system.combat.remaining, 0);
  const third = await w.attack(sword, { extra: true });
  assert.equal(w.attacker.system.sta.value, 22);
  const fourth = await w.attack(sword);
  assert.equal(w.attacker.system.sta.value, 22);
  assert.equal(third.flags[SYSTEM_ID].check.total, first.flags[SYSTEM_ID].check.total - 3);
  assert.equal(fourth.flags[SYSTEM_ID].check.total, third.flags[SYSTEM_ID].check.total);
  await assert.rejects(() => w.attack(sword, { extra: true }), /one extra action/);
  assert.equal(w.rolls.length, 0);
});

test('weapon defense uses its skill without WA, wears REL once and rejects a second defense submission', async (t) => {
  const w = await workflow(t),
    sword = await w.importItem(w.attacker, 'Arming Sword', { equipped: true });
  const guard = await w.importItem(w.target, 'Arming Sword', { equipped: true });
  await guard.update({ 'system.accuracy': 7 });
  w.start();
  w.enqueue(['1d10', 5], ['1d10', 6]);
  const attack = await w.attack(sword);
  const defense = await w.defend(attack, { defense: 'blockWeapon', weapon: guard.id });
  assert.equal(defense.flags[SYSTEM_ID].check.base, 10);
  assert.equal(guard.system.reliability, 14);
  assert.equal(w.target.skillCalls.at(-1).key, 'swordsmanship');
  const beforeSta = w.target.system.sta.value;
  await assert.rejects(
    () => w.defend(attack, { defense: 'blockWeapon', weapon: guard.id }),
    /already has a defense/
  );
  assert.equal(w.target.system.sta.value, beforeSta);
  assert.equal(guard.system.reliability, 14);
  assert.equal(w.rolls.length, 0);
});

test('registered unarmed parry rolls Brawling at -3 and staggers the attacker on success', async (t) => {
  const w = await workflow(t),
    sword = await w.importItem(w.attacker, 'Arming Sword', { equipped: true });
  await w.target.update({ 'system.skills.brawling': 7 });
  w.start();
  w.enqueue(['1d10', 5], ['1d10', 6]);
  const attack = await w.attack(sword),
    defense = await w.defend(attack, { defense: 'parry' });
  assert.equal(w.target.skillCalls.at(-1).key, 'brawling');
  assert.equal(defense.flags[SYSTEM_ID].check.base, 9);
  assert(w.attacker.system.conditions.includes('staggered'));
  assert.equal(w.rolls.length, 0);
});

for (const scenario of [
  { label: 'successful', attackRoll: 5, defenseRoll: 6, aim: 'torso', location: 'leftArm', damage: 6 },
  { label: 'failed aimed', attackRoll: 6, defenseRoll: 4, aim: 'torso', location: 'torso', damage: 12 },
  { label: 'failed random', attackRoll: 6, defenseRoll: 4, aim: '', location: 'torso', damage: 12 },
])
  test(`${scenario.label} arm block ${scenario.label === 'successful' ? 'redirects damage to the chosen arm' : 'preserves the attack hit location'}`, async (t) => {
    const w = await workflow(t),
      sword = await w.importItem(w.attacker, 'Arming Sword', { equipped: true });
    w.start();
    w.enqueue(
      ['1d10', scenario.attackRoll],
      ['1d10', scenario.defenseRoll],
      ...(!scenario.aim ? [['1d10', 2]] : []),
      ['2d6+4', 12]
    );
    const attack = await w.attack(sword, { location: scenario.aim });
    await w.defend(attack, { defense: 'blockArm', arm: 'leftArm' });
    const damage = w.damageFor(attack);
    assert(damage, w.notices.join('; '));
    assert.equal(w.target.skillCalls.at(-1).key, 'brawling');
    assert.equal(damage.flags[SYSTEM_ID].summary[0].location.id, scenario.location);
    assert.equal(damage.flags[SYSTEM_ID].summary[0].damage, scenario.damage);
    await w.apply(damage);
    assert.equal(w.target.system.hp.value, 25 - scenario.damage);
    assert.equal(w.rolls.length, 0);
  });

test('Core Griffin natural weapon with unprinted REL can parry while carried is false', async (t) => {
  const w = await workflow(t),
    sword = await w.importItem(w.attacker, 'Arming Sword', { equipped: true });
  const [claws] = await w.target.createEmbeddedDocuments('Item', [
    row('Griffin').items.find((item) => item.name === 'Claws'),
  ]);
  assert.equal(claws.system.carried, false);
  assert.equal(claws.system.reliability, 0);
  assert.equal(claws.system.maxReliability, 0);
  w.start();
  w.enqueue(['1d10', 5], ['1d10', 9]);
  const attack = await w.attack(sword);
  const defense = await w.defend(attack, { defense: 'parry', weapon: claws.id });
  assert.equal(w.target.skillCalls.at(-1).key, 'melee');
  assert.equal(defense.flags[SYSTEM_ID].check.base, 7);
  assert(w.attacker.system.conditions.includes('staggered'));
  assert.equal(claws.system.reliability, 0, 'Parry does not invent or consume an unprinted REL value');
  assert.equal(w.rolls.length, 0);
});

test('natural block requires GM-configured REL, consumes it once, and refuses the broken weapon', async (t) => {
  const w = await workflow(t),
    sword = await w.importItem(w.attacker, 'Arming Sword', { equipped: true });
  const [claws] = await w.target.createEmbeddedDocuments('Item', [
    row('Griffin').items.find((item) => item.name === 'Claws'),
  ]);
  w.start();
  w.enqueue(['1d10', 5]);
  const attack = await w.attack(sword);
  await assert.rejects(
    () => w.defend(attack, { defense: 'blockWeapon', weapon: claws.id }),
    /GM must set current and maximum REL/
  );
  assert.equal(w.target.system.combat.defenses, 0);
  assert.equal(w.rolls.length, 0);

  // Explicit GM configuration for this fixture, not a value asserted to be printed in Core.
  await claws.update({ 'system.reliability': 1, 'system.maxReliability': 1 });
  w.enqueue(['1d10', 6]);
  await w.defend(attack, { defense: 'blockWeapon', weapon: claws.id });
  assert.equal(claws.system.reliability, 0);
  assert.equal(claws.system.maxReliability, 1);
  await assert.rejects(
    () => w.defend(attack, { defense: 'blockWeapon', weapon: claws.id }),
    /already has a defense/
  );
  w.enqueue(['1d10', 5]);
  const second = await w.attack(sword);
  for (const defense of ['blockWeapon', 'parry'])
    await assert.rejects(() => w.defend(second, { defense, weapon: claws.id }), /equipped, usable weapon/);
  assert.equal(w.target.system.combat.defenses, 1);
  assert.equal(w.rolls.length, 0);
});

test('a natural weapon with configured maximum REL and current REL zero cannot attack', async (t) => {
  const w = await workflow(t, { attackerName: 'Griffin' }),
    claws = w.attacker.items.find((item) => item.name === 'Claws');
  // Explicit GM-configured durability, depleted by prior play; Core itself does not print it.
  await claws.update({ 'system.reliability': 0, 'system.maxReliability': 1 });
  w.start();
  await assert.rejects(() => w.attack(claws, { style: 'normal' }), /weapon is broken/);
  assert.equal(w.attacker.system.combat.npcStrikes, 0);
  assert.equal(w.rolls.length, 0);
});

test('player-authored attack and damage flags cannot impersonate GM-authorized combat results', async (t) => {
  const w = await workflow(t),
    sword = await w.importItem(w.attacker, 'Arming Sword', { equipped: true });
  w.start();
  w.enqueue(['1d10', 6]);
  const attack = await w.attack(sword);
  attack.author = game.users.get('player');
  await assert.rejects(() => w.defend(attack), /GM-authorized attack result/);
  assert.equal(w.target.system.combat.defenses, 0);
  assert.equal(w.rolls.length, 0);

  attack.author = game.users.get('gm');
  w.enqueue(['1d10', 4], ['2d6+4', 12]);
  await w.defend(attack);
  const damage = w.damageFor(attack);
  assert(damage, w.notices.join('; '));
  damage.author = game.users.get('player');
  await assert.rejects(() => w.apply(damage), /GM-authorized damage result/);
  assert.equal(w.target.system.hp.value, 25);
  damage.author = game.users.get('gm');
  await w.apply(damage);
  assert.equal(w.target.system.hp.value, 13);
  assert.equal(w.rolls.length, 0);
});

for (const silver of [false, true])
  test(`registered damage workflow applies ${silver ? 'silver bonus' : 'ordinary weapon resistance'} after armor once to one unlinked creature`, async (t) => {
    const w = await workflow(t, { creature: true });
    const sword = await w.importItem(w.attacker, silver ? 'Witcher’s Silver Sword' : 'Arming Sword', {
      equipped: true,
    });
    const armor = await w.importItem(w.target, 'Gambeson', { equipped: true });
    const other = w.makeActor('Other Drowner', {
      ...row('Drowner'),
      uuid: 'Scene.unit.Token.two.Actor.drowner',
    });
    await w.target.setCondition('prone');
    w.start();
    w.enqueue(
      ['1d10', 6],
      ['1d10', 4],
      silver ? ['1d6+2', 8] : ['2d6+4', 16],
      ...(silver ? [['3d6', 9]] : [])
    );
    const attack = await w.attack(sword);
    await w.defend(attack);
    const damage = w.damageFor(attack);
    assert(damage, w.notices.join('; '));
    assert.equal(damage.flags[SYSTEM_ID].summary[0].damage, silver ? 14 : 6);
    await w.apply(damage);
    assert.equal(w.target.system.hp.value, silver ? 11 : 19);
    assert.equal(armor.system.sp.torso, 2);
    // The displayed current values must come from persisted wear, not the catalog maximum.
    const armorRows = armorLocationRows(armor, w.target.system.locations);
    assert.deepEqual(
      armorRows.map((r) => [r.id, r.current, r.maximum]),
      [
        ['torso', 2, 3],
        ['rightArm', 3, 3],
        ['leftArm', 3, 3],
      ]
    );
    const locationRows = actorArmorRows(
      {
        ...w.target.system,
        items: w.target.items.map((i) => ({ type: i.type, id: i.id, name: i.name, ...i.system })),
      },
      w.target.system.locations
    );
    const torso = locationRows.find((l) => l.id === 'torso');
    assert.equal(torso.totalSP, 2);
    assert.equal(torso.maximumSP, 3);
    const hbs = Handlebars.create();
    hbs.registerHelper('checked', (v) => (v ? 'checked' : ''));
    const itemHTML = hbs.compile(
      fs.readFileSync(new URL('../../templates/witcher/item.hbs', import.meta.url), 'utf8')
    )({
      item: armor,
      system: armor.system,
      isArmor: true,
      owned: true,
      armorLocations: armorRows,
    });
    assert.match(itemHTML, /name='system\.sp\.torso'[^>]*value='2'/);
    assert(itemHTML.indexOf('Armor condition') < itemHTML.indexOf('Characteristics'));
    const actorHTML = hbs.compile(
      fs.readFileSync(new URL('../../templates/witcher/actor.hbs', import.meta.url), 'utf8')
    )({
      actor: w.target,
      system: w.target.system,
      locations: locationRows,
      inventory: [
        { id: armor.id, name: armor.name, system: armor.system, isArmor: true, armorLocations: armorRows },
      ],
    });
    assert.match(actorHTML, /SP current \/ max/);
    assert.match(actorHTML, /data-armor-location='torso'[^>]*>\s*<strong>2<\/strong>\s*\/\s*3/);
    assert.match(actorHTML, /Torso:\s*<b>2<\/b>\s*\/\s*3/);
    assert.equal(other.system.hp.value, 25);
    await assert.rejects(() => w.apply(damage), /already been applied/);
    assert.equal(w.target.system.hp.value, silver ? 11 : 19);
    assert.equal(w.rolls.length, 0);
  });

test('message creation failure after a paid bow attack restores STA, action budget, Luck and ammunition', async (t) => {
  const w = await workflow(t),
    bow = await w.importItem(w.attacker, 'Short Bow', { equipped: true }),
    ammo = await w.importItem(w.attacker, 'Standard Ammunition');
  await bow.update({ 'system.ammoId': ammo.id });
  w.start();
  w.enqueue(['1d10', 5]);
  w.faults.create = (data) => data.flags[SYSTEM_ID]?.kind === 'attack';
  const quantity = ammo.system.quantity;
  await assert.rejects(
    () => w.attack(bow, { extra: true, luck: 2, distance: 20 }),
    /Injected message creation failure/
  );
  assert.equal(w.attacker.system.sta.value, 25);
  assert.equal(w.attacker.system.luck.value, 5);
  assert.equal(w.attacker.system.combat.extra, 0);
  assert.equal(ammo.system.quantity, quantity);
});

test('failed defense chat creation clears the reservation and restores paid defense STA and Luck', async (t) => {
  const w = await workflow(t),
    sword = await w.importItem(w.attacker, 'Arming Sword', { equipped: true });
  w.start();
  await w.target.update({ 'system.combat.roundKey': 'combat:1', 'system.combat.defenses': 1 });
  w.enqueue(['1d10', 5], ['1d10', 6]);
  const attack = await w.attack(sword);
  w.faults.create = (data) => data.flags[SYSTEM_ID]?.kind === 'defense';
  await assert.rejects(() => w.defend(attack, { luck: 2 }), /Injected message creation failure/);
  assert.equal(attack.flags[SYSTEM_ID].defenseRef, '');
  assert.equal(w.target.system.sta.value, 25);
  assert.equal(w.target.system.luck.value, 5);
  assert.equal(w.target.system.combat.defenses, 1);
});

test('failed final damage receipt cannot apply HP and armor wear again on retry', async (t) => {
  const w = await workflow(t),
    sword = await w.importItem(w.attacker, 'Arming Sword', { equipped: true });
  const armor = await w.importItem(w.target, 'Gambeson', { equipped: true });
  w.start();
  w.enqueue(['1d10', 6], ['1d10', 4], ['2d6+4', 12]);
  const attack = await w.attack(sword);
  await w.defend(attack);
  const damage = w.damageFor(attack);
  assert(damage, w.notices.join('; '));
  w.faults.update = (message, changes) =>
    message === damage && changes[`flags.${SYSTEM_ID}.applied`] === true;
  await assert.rejects(() => w.apply(damage), /Injected message update failure/);
  assert.equal(w.target.system.hp.value, 16);
  assert.equal(armor.system.sp.torso, 2);
  w.faults.update = null;
  await w.apply(damage);
  assert.equal(damage.flags[SYSTEM_ID].applied, true);
  assert.equal(w.target.system.hp.value, 16);
  assert.equal(armor.system.sp.torso, 2);
});

test('registered strong strike applies -3 once, doubles damage before armor and leaves no second strike', async (t) => {
  const w = await workflow(t, { creature: true }),
    sword = await w.importItem(w.attacker, 'Arming Sword', { equipped: true });
  const armor = await w.importItem(w.target, 'Gambeson', { equipped: true });
  await w.target.setCondition('prone');
  w.start();
  w.enqueue(['1d10', 9], ['1d10', 4], ['2d6+4', 16]);
  const attack = await w.attack(sword, { style: 'strong' });
  await w.defend(attack);
  assert.equal(attack.flags[SYSTEM_ID].check.base, 6);
  assert.equal(w.attacker.system.combat.remaining, 0);
  assert.equal(w.attacker.system.sta.value, 25);
  const damage = w.damageFor(attack);
  assert(damage, w.notices.join('; '));
  assert.equal(damage.flags[SYSTEM_ID].summary[0].damage, 14);
  await w.apply(damage);
  assert.equal(w.target.system.hp.value, 11);
  assert.equal(armor.system.sp.torso, 2);
});

test('imported Griffin uses its printed Claws ROF and fixed damage through registered handlers', async (t) => {
  const w = await workflow(t, { attackerName: 'Griffin' }),
    claws = w.attacker.items.find((item) => item.name === 'Claws');
  assert(claws);
  assert.equal(claws.system.carried, false);
  assert.equal(claws.system.reliability, 0);
  assert.equal(claws.system.maxReliability, 0);
  w.start();
  const base = w.attacker.skillBase(claws.system.skill, { stat: claws.system.stat }).total;
  w.enqueue(['1d10', 6], ['1d10', 4], [claws.system.damage, 12], ['1d10', 5]);
  const attack = await w.attack(claws, { style: 'normal', modifier: 10 - base });
  await w.defend(attack);
  const damage = w.damageFor(attack);
  assert(damage, w.notices.join('; '));
  assert.equal(
    damage.flags[SYSTEM_ID].summary[0].raw,
    12,
    'Printed monster damage must not gain another BODY bonus'
  );
  await w.attack(claws, { style: 'normal' });
  assert.equal(w.attacker.system.combat.npcStrikes, 2);
  await assert.rejects(() => w.attack(claws, { style: 'normal', extra: true }), /cannot reset ROF/);
  assert.equal(w.rolls.length, 0);
});

test('a pending critical cannot wound or stun a target that becomes physically immune before application', async (t) => {
  const w = await workflow(t),
    sword = await w.importItem(w.attacker, 'Arming Sword', { equipped: true });
  w.start();
  w.enqueue(['1d10', 6], ['1d10', 4], ['2d6', 7], ['1d6', 3], ['1d6', 3], ['2d6+4', 12]);
  const attack = await w.attack(sword, { modifier: 7 });
  await w.defend(attack);
  const damage = w.damageFor(attack);
  assert(damage, w.notices.join('; '));
  assert(damage.flags[SYSTEM_ID].wound);
  await w.target.update({ 'system.traits.alwaysIncorporeal': true });
  await w.apply(damage);
  assert.equal(damage.flags[SYSTEM_ID].summary[0].damage, 0);
  assert.equal(damage.flags[SYSTEM_ID].wound, null);
  assert.equal(damage.flags[SYSTEM_ID].stun, null);
  await w.apply(damage);
  assert.equal(w.target.system.hp.value, 25);
  assert.equal(w.target.items.filter((item) => item.type === 'wound').length, 0);
  assert.equal(w.rolls.length, 0);
});

test('critical wound, damage and its Stun save are each persisted once when the final card update fails', async (t) => {
  const w = await workflow(t),
    sword = await w.importItem(w.attacker, 'Arming Sword', { equipped: true });
  w.start();
  w.enqueue(['1d10', 6], ['1d10', 4], ['2d6', 7], ['1d6', 3], ['1d6', 3], ['2d6+4', 12], ['1d10', 2]);
  const attack = await w.attack(sword, { modifier: 7 });
  await w.defend(attack);
  const damage = w.damageFor(attack);
  assert(damage, w.notices.join('; '));
  w.faults.update = (message, changes) =>
    message === damage && changes[`flags.${SYSTEM_ID}.applied`] === true;
  await assert.rejects(() => w.apply(damage), /Injected message update failure/);
  assert.equal(w.target.system.hp.value, 10);
  assert.equal(w.target.items.filter((item) => item.type === 'wound').length, 1);
  assert.equal(w.rolls.length, 0);
  w.faults.update = null;
  await w.apply(damage);
  assert.equal(w.target.system.hp.value, 10);
  assert.equal(w.target.items.filter((item) => item.type === 'wound').length, 1);
  assert.equal(damage.flags[SYSTEM_ID].applied, true);
  assert.equal(w.rolls.length, 0, 'Finishing the card must not roll its Stun save twice');
});
