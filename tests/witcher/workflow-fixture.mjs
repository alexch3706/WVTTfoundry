/** Integration unit tests: real registered combat/inventory command handlers,
 * imported catalog records and controlled document/dice persistence fixtures.
 * No Foundry server, browser, sheet rendering or real network is simulated. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { STATS, SKILLS, HUMANOID_LOCATIONS, SYSTEM_ID } from '../../module/witcher/config.js';
import { derivedStats } from '../../module/witcher/rules.js';
import { runCommand } from '../../module/witcher/authority.js';

const catalog = ['weapons', 'armor', 'bestiary'].flatMap((name) =>
  JSON.parse(fs.readFileSync(new URL(`../../data/witcher/${name}.json`, import.meta.url)))
);
export const row = (name) => {
  const record = catalog.find((entry) => entry.name === name);
  assert(record, name);
  return structuredClone(record);
};
export const clone = (value) => structuredClone(value);
const getProperty = (object, key) => key.split('.').reduce((value, part) => value?.[part], object);
function patch(object, changes) {
  for (const [key, value] of Object.entries(changes)) {
    const parts = key.split('.'),
      last = parts.pop();
    let destination = object;
    for (const part of parts) destination = destination[part] ??= {};
    if (last.startsWith('-=')) delete destination[last.slice(2)];
    else destination[last] = clone(value);
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

export async function workflow(t, { creature = false, attackerName, separatePrepared = false } = {}) {
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
      expandObject: (changes) => {
        const expanded = {};
        patch(expanded, changes);
        return expanded;
      },
      randomID,
      fromUuid: async (uuid) => docs.get(uuid),
    },
  };
  globalThis.Actor = class {
    prepareDerivedData() {}
    async _preUpdate() {}
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
        async delete() {
          messages.delete(this.id);
          docs.delete(this.uuid);
        },
        async setFlag(scope, key, value) {
          return this.update({ [`flags.${scope}.${key}`]: value });
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
      get flags() {
        return this._source.flags ?? {};
      },
      toObject() {
        return {
          _id: this.id,
          name: this.name,
          type: this.type,
          system: this.system.toObject(),
          flags: clone(this.flags),
        };
      },
      get system() {
        return this._prepared ?? this._source.system;
      },
      prepare() {
        if (separatePrepared) {
          this._prepared = serializableSystem(clone(this._source.system));
          WitcherActor.prototype.prepareDerivedData.call(this);
          return;
        }
        this.system.derived = derivedStats(
          this.system,
          this.items.map((item) => ({
            id: item.id,
            type: item.type,
            flags: item.flags,
            ...item.system.toObject(),
          }))
        );
        this.system.hp.max = this.system.derived.hpMax;
        this.system.sta.max = this.system.derived.staMax;
        this.system.armorError = '';
      },
      skillBase(key, options) {
        this.skillCalls.push({ key, options: clone(options) });
        return WitcherActor.prototype.skillBase.call(this, key, options);
      },
      async rest(options) {
        return WitcherActor.prototype.rest.call(this, options);
      },
      async update(changes) {
        await WitcherActor.prototype._preUpdate.call(this, changes, {}, game.user);
        patch(this._source, changes);
        if (!this._source.system.toObject) serializableSystem(this._source.system);
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
            uuid: `${this.uuid}.Item.${id}`,
            documentName: 'Item',
            parent: this,
            name: record.name,
            type: record.type,
            actor: this,
            isOwner: true,
            _source: {
              flags: clone(record.flags ?? {}),
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
            get flags() {
              return this._source.flags ?? {};
            },
            get system() {
              return this._source.system;
            },
            async update(changes) {
              patch(this._source, changes);
              if (!this._source.system.toObject) serializableSystem(this._source.system);
              actor.prepare();
              return this;
            },
            toObject() {
              return {
                _id: this.id,
                name: this.name,
                type: this.type,
                system: this.system.toObject(),
                flags: clone(this.flags),
              };
            },
            async delete() {
              this.parent.items.delete(this.id);
              docs.delete(this.uuid);
              this.parent.prepare();
            },
          };
          this.items.set(id, item);
          docs.set(item.uuid, item);
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
    docs,
    Collection,
    rolls,
  };
}
