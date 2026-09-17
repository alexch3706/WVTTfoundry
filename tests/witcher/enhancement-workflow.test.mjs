/** Exercise real registered GM commands against controlled document persistence. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { runCommand } from '../../module/witcher/authority.js';
const S = 'witcher-rilerena';
const clone = (value) => structuredClone(value);
const core = JSON.parse(
  await fs.readFile(new URL('../../data/witcher/witcher-gear.json', import.meta.url), 'utf8')
);
const equipment = JSON.parse(
  await fs.readFile(new URL('../../data/witcher/equipment.json', import.meta.url), 'utf8')
);
const tome = JSON.parse(
  await fs.readFile(new URL('../../data/witcher/tome-enhancements.json', import.meta.url), 'utf8')
);
class Collection extends Map {
  [Symbol.iterator]() {
    return this.values();
  }
  some(fn) {
    return [...this.values()].some(fn);
  }
  find(fn) {
    return [...this.values()].find(fn);
  }
  filter(fn) {
    return [...this.values()].filter(fn);
  }
  map(fn) {
    return [...this.values()].map(fn);
  }
}
function patch(target, updates) {
  for (const [key, value] of Object.entries(updates)) {
    const parts = key.split('.'),
      end = parts.pop();
    let at = target;
    for (const part of parts) at = at[part] ??= {};
    if (end.startsWith('-=')) delete at[end.slice(2)];
    else at[end] = clone(value);
  }
}
async function fixture(t) {
  const names = ['foundry', 'game', 'ui', 'Hooks', 'ChatMessage', 'Actor', 'Item', 'canvas'];
  const previous = new Map(names.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  t.after(() => {
    for (const [key, value] of previous)
      if (value) Object.defineProperty(globalThis, key, value);
      else delete globalThis[key];
  });
  let serial = 0;
  const randomID = () => `fixture${++serial}`;
  const docs = new Map(),
    messages = [],
    faults = { chat: false, partialCreate: false };
  globalThis.foundry = {
    abstract: { TypeDataModel: class {} },
    data: { fields: {} },
    utils: {
      randomID,
      deepClone: clone,
      getProperty: (target, key) => key.split('.').reduce((at, part) => at?.[part], target),
      fromUuid: async (uuid) => docs.get(uuid),
    },
  };
  globalThis.Actor = class {};
  globalThis.Item = class {};
  globalThis.canvas = {};
  globalThis.Hooks = { on() {} };
  globalThis.ui = { notifications: { error() {} } };
  globalThis.game = {
    user: { id: 'gm', isGM: true, isActiveGM: true, active: true },
    time: { worldTime: 100 },
    settings: { get: () => 'publicroll' },
  };
  globalThis.ChatMessage = {
    getSpeaker: ({ actor }) => ({ actor: actor.id }),
    applyRollMode() {},
    async create(data) {
      if (faults.chat) {
        faults.chat = false;
        throw new Error('Receipt failed');
      }
      const message = { ...data, uuid: `ChatMessage.${randomID()}` };
      messages.push(message);
      return message;
    },
  };
  const actor = {
    id: 'actor',
    uuid: 'Actor.actor',
    name: 'Craftsman',
    isOwner: true,
    items: new Collection(),
    _source: {
      flags: {},
      system: {
        professionRanks: { masterCrafting: 1 },
        customSkills: [],
        effects: [],
        conditions: [],
        traits: {},
        magic: {},
        combat: { reactions: [], actions: 0, remaining: 0, full: false, defenses: 0, extra: 0 },
        sta: { value: 30, max: 30 },
      },
    },
    get system() {
      return this._source.system;
    },
    get flags() {
      return this._source.flags;
    },
    testUserPermission(user) {
      return user.isGM;
    },
    skillBase(key, { modifier = 0 } = {}) {
      return { total: 20 + Number(modifier) };
    },
    async update(updates) {
      patch(this._source, updates);
      return this;
    },
    async updateEmbeddedDocuments(type, updates) {
      return updates.map((update) => {
        const item = this.items.get(update._id);
        assert.ok(item);
        patch(item._source, Object.fromEntries(Object.entries(update).filter(([key]) => key !== '_id')));
        return item;
      });
    },
    async createEmbeddedDocuments(type, records) {
      const made = [];
      for (const record of records) {
        made.push(add(record));
        if (faults.partialCreate) {
          faults.partialCreate = false;
          throw new Error('Partial create failed');
        }
      }
      return made;
    },
    async deleteEmbeddedDocuments(type, ids) {
      for (const id of ids) this.items.delete(id);
    },
  };
  function add(record) {
    const id = record._id ?? randomID(),
      _source = { ...clone(record), flags: clone(record.flags ?? {}) };
    const item = {
      id,
      uuid: `${actor.uuid}.Item.${id}`,
      _source,
      get name() {
        return _source.name;
      },
      get img() {
        return _source.img;
      },
      get type() {
        return _source.type;
      },
      get system() {
        return _source.system;
      },
      get flags() {
        return _source.flags;
      },
    };
    actor.items.set(id, item);
    docs.set(item.uuid, item);
    return item;
  }
  docs.set(actor.uuid, actor);
  const { registerEnhancements } = await import('../../module/witcher/enhancement-runtime.js');
  registerEnhancements();
  const source = (name) => add([...core, ...equipment, ...tome].find((entry) => entry.name === name));
  const gear = (type = 'weapon', overrides = {}) =>
    add({
      name: 'Test equipment',
      type,
      system: {
        quantity: 1,
        carried: true,
        equipped: true,
        enhancements: 3,
        attachments: [],
        properties: { bleeding: 50 },
        resistances: [],
        skillBonuses: [],
        weight: 2,
        stoppingPower: 10,
        sp: { torso: 7 },
        coverage: ['torso'],
        ev: 1,
        maxReliability: 10,
        reliability: 7,
        ...overrides,
      },
    });
  const command = (payload) => runCommand('enhancement', { actorUuid: actor.uuid, ...payload });
  const tools = () => {
    for (const name of ['Crafting Tools', 'Runewright’s Tools'])
      add({ name, type: 'gear', system: { quantity: 1, carried: true } });
  };
  return { actor, add, source, gear, command, tools, messages, faults };
}

test('registered inscription consumes a real stone once, preserves stronger native properties and rolls back failed receipt', async (t) => {
  const f = await fixture(t);
  f.tools();
  const target = f.gear(),
    source = f.source('Devanna');
  f.faults.chat = true;
  await assert.rejects(
    f.command({ op: 'inscribe', sourceId: source.id, targetId: target.id, stoneWeight: 'consumed' }),
    /Receipt failed/
  );
  assert.equal(source.system.quantity, 1);
  assert.equal(target.system.attachments.length, 0);
  await f.command({ op: 'inscribe', sourceId: source.id, targetId: target.id, stoneWeight: 'consumed' });
  assert.equal(source.system.quantity, 0);
  assert.equal(target.system.properties.bleeding, 50);
  await assert.rejects(
    f.command({ op: 'inscribe', sourceId: source.id, targetId: target.id, stoneWeight: 'consumed' }),
    /carried stone/
  );
  assert.equal(target.system.attachments.length, 1);
});

test('Runewright completion requires actual elapsed time and revalidates carried tools', async (t) => {
  const f = await fixture(t);
  f.tools();
  const target = f.gear(),
    source = f.source('Triglav');
  await f.command({
    op: 'start',
    procedure: 'inscribe',
    sourceId: source.id,
    targetId: target.id,
    stoneWeight: 'consumed',
  });
  const work = clone(f.actor.flags[S].enhancementWork);
  await assert.rejects(f.command({ op: 'finish', workId: work.id }), /more seconds/);
  game.time.worldTime = work.finishesAt;
  const tool = f.actor.items.find((item) => item.name === 'Runewright’s Tools');
  tool.system.carried = false;
  await assert.rejects(f.command({ op: 'finish', workId: work.id }), /Carry Runewright/);
  tool.system.carried = true;
  await f.command({ op: 'finish', workId: work.id });
  assert.equal(target.system.properties.stun, -2);
  assert.equal(source.system.quantity, 0);
  assert.equal(f.actor.flags[S].enhancementWork, null);
  await assert.rejects(f.command({ op: 'finish', workId: work.id }), /already completed/);
});

test('registered physical install/remove conserves unused parts and reverses partial embedded creation failure', async (t) => {
  const f = await fixture(t);
  f.tools();
  const target = f.gear('armor'),
    source = f.source('Chain Mail Enhancement');
  const request = {
    op: 'physical',
    sourceId: source.id,
    targetIds: [target.id],
    weights: { [target.id]: 0.5 },
    manualDice: '5',
  };
  const beforeCount = f.actor.items.size;
  f.faults.partialCreate = true;
  await assert.rejects(f.command(request), /Partial create failed/);
  assert.equal(f.actor.items.size, beforeCount);
  assert.equal(source.system.quantity, 1);
  assert.equal(target.system.stoppingPower, 10);
  await f.command(request);
  assert.equal(target.system.stoppingPower, 13);
  assert.equal(target.system.sp.torso, 10);
  const remaining = f.actor.items.find((item) => item.flags[S]?.enhancementParts);
  assert.equal(remaining.system.weight, 2.5);
  assert.equal(remaining.flags[S].enhancementParts.sections.includes('torso'), false);
  target.system.sp.torso = 8;
  await f.command({
    op: 'remove',
    targetId: target.id,
    attachmentId: target.system.attachments[0].id,
    manualDice: '5',
  });
  assert.equal(target.system.sp.torso, 5);
  assert.equal(target.system.stoppingPower, 10);
  assert.equal(f.actor.items.filter((item) => item.flags[S]?.enhancementParts).length, 2);
});

test('failed word crafting recovers exactly one chosen stone including an already installed ingredient', async (t) => {
  const f = await fixture(t);
  f.tools();
  const target = f.gear(),
    chemobog = f.source('Chemobog'),
    dazhbog = f.source('Dazhbog');
  await f.command({ op: 'inscribe', sourceId: chemobog.id, targetId: target.id, stoneWeight: 'consumed' });
  const recipe = f.source('Runeword: Burning Diagram');
  await f.command({
    op: 'start',
    procedure: 'word',
    sourceId: recipe.id,
    targetId: target.id,
    recoverKey: 'chemobog',
    componentBenefits: 'replace',
    failurePriorStones: 'destroy',
  });
  const work = f.actor.flags[S].enhancementWork;
  game.time.worldTime = work.finishesAt;
  await f.command({ op: 'finish', workId: work.id, manualDice: '1,9', recoveryDice: '5' });
  assert.equal(target.system.attachments.length, 0);
  assert.equal(dazhbog.system.quantity, 0);
  assert.equal(
    f.actor.items
      .filter((item) => item.name === 'Chemobog')
      .reduce((sum, item) => sum + item.system.quantity, 0),
    1
  );
});

test('successful word craft clears individual rune effects and uses two slots without free additional stones', async (t) => {
  const f = await fixture(t);
  f.tools();
  const target = f.gear(),
    veles = f.source('Veles');
  await f.command({ op: 'inscribe', sourceId: veles.id, targetId: target.id, stoneWeight: 'consumed' });
  f.source('Chemobog');
  f.source('Dazhbog');
  const recipe = f.source('Runeword: Burning Diagram');
  await f.command({
    op: 'start',
    procedure: 'word',
    sourceId: recipe.id,
    targetId: target.id,
    recoverKey: 'chemobog',
    componentBenefits: 'replace',
    failurePriorStones: 'destroy',
  });
  const work = f.actor.flags[S].enhancementWork;
  game.time.worldTime = work.finishesAt;
  await f.command({ op: 'finish', workId: work.id, manualDice: '5' });
  assert.equal(target.system.attachments.length, 1);
  assert.equal(target.system.attachments[0].slots, 2);
  assert.equal(target.system.properties.greaterFocus, undefined);
  assert.equal(target.system.properties.bleeding, 50);
  const perun = f.source('Perun');
  await assert.rejects(
    f.command({ op: 'inscribe', sourceId: perun.id, targetId: target.id, stoneWeight: 'consumed' }),
    /cannot receive/
  );
});

test('slot completion rejects armor damaged after work began without spending materials', async (t) => {
  const f = await fixture(t);
  f.tools();
  const target = f.gear('armor', { enhancements: 0, sp: { torso: 10 } });
  const diagram = f.source('Enhancement Slot Diagram');
  const meteorite = f.add({ name: 'Meteorite', type: 'component', system: { quantity: 4, carried: true } });
  const dust = f.add({ name: 'Infused Dust', type: 'component', system: { quantity: 2, carried: true } });
  await f.command({ op: 'start', procedure: 'slot', sourceId: diagram.id, targetId: target.id });
  const work = f.actor.flags[S].enhancementWork;
  game.time.worldTime = work.finishesAt;
  target.system.sp.torso = 9;
  await assert.rejects(f.command({ op: 'finish', workId: work.id, manualDice: '6' }), /full SP/);
  assert.equal(meteorite.system.quantity, 4);
  assert.equal(dust.system.quantity, 2);
  target.system.sp.torso = 10;
  await f.command({ op: 'finish', workId: work.id, manualDice: '6' });
  assert.equal(target.system.enhancements, 1);
  assert.equal(meteorite.system.quantity, 0);
  assert.equal(dust.system.quantity, 0);
});

test('Master Crafting uses its ability and verified DC without inventing a carried-diagram requirement', async (t) => {
  const f = await fixture(t);
  const target = f.gear('weapon', { properties: {}, damageTypes: ['slashing'] });
  target._stats = { compendiumSource: 'Compendium.witcher-rilerena.weapons.Item.testweapon' };
  const reference = f.add({
    name: 'Actual weapon diagram',
    type: 'diagram',
    system: { productUuid: target._stats.compendiumSource, craftDC: 16, quantity: 0, carried: false },
  });
  await f.command({
    op: 'mastercraft',
    targetId: target.id,
    sourceId: reference.id,
    choice: 'bleeding',
    manualDice: '5',
  });
  assert.equal(target.system.properties.bleeding, 50);
  assert.equal(target.system.attachments[0].category, 'mastercraft');
  assert.equal(target.system.attachments[0].slots, 0);
  assert.equal(reference.system.quantity, 0);
});

async function shiningFixture(t) {
  const f = await fixture(t);
  const { registerShining, reconcileShining, shiningDaylight } =
    await import('../../module/witcher/enhancements-light.js');
  const { makeAttachment } = await import('../../module/witcher/enhancements.js');
  registerShining();
  const armor = f.gear('armor', {
    coverage: ['torso'],
    attachments: [
      makeAttachment(
        tome.find((item) => item.name === 'Glyphword: Shining'),
        { id: 'shining-word' }
      ),
    ],
  });
  const scene = {
    id: 'scene',
    grid: { size: 100, distance: 2, units: 'm' },
    lights: new Collection(),
    tokens: new Collection(),
    async createEmbeddedDocuments(type, rows) {
      assert.equal(type, 'AmbientLight');
      return rows.map((row) => {
        const _source = clone(row);
        const light = {
          id: row._id,
          uuid: `Scene.scene.AmbientLight.${row._id}`,
          parent: scene,
          _source,
          toObject: () => clone(_source),
          async update(updates) {
            patch(_source, updates);
            return this;
          },
        };
        for (const key of ['x', 'y', 'elevation', 'levels', 'hidden', 'flags', 'config'])
          Object.defineProperty(light, key, { get: () => _source[key] });
        light.object = {
          initializeLightSource() {},
          lightSource: {
            shape: {
              contains(x, y) {
                // Controlled native-light boundary: radius and a wall at x=200.
                return x < 200 && Math.hypot(x - light.x, y - light.y) <= light.config.bright * 50;
              },
            },
          },
        };
        scene.lights.set(light.id, light);
        return light;
      });
    },
    async deleteEmbeddedDocuments(type, ids) {
      for (const id of ids) this.lights.delete(id);
    },
  };
  const token = {
    id: 'token',
    name: 'Carrier',
    parent: scene,
    actor: f.actor,
    x: 0,
    y: 0,
    elevation: 0,
    level: 'ground',
    getCenterPoint() {
      return { x: this.x, y: this.y, elevation: this.elevation };
    },
    getContainmentTestPoints() {
      return [this.getCenterPoint()];
    },
    toObject() {
      return { x: this.x, y: this.y, elevation: this.elevation, level: this.level };
    },
  };
  scene.tokens.set(token.id, token);
  const otherActor = {
    id: 'katakan',
    uuid: 'Actor.katakan',
    system: {
      effects: [{ id: 'unrelated', key: 'Existing effect' }],
      conditions: [],
      traits: { regeneration: 5, sunlightRegeneration: 3 },
      environment: { light: 'darkness' },
    },
    async update(updates) {
      patch(this, updates);
    },
  };
  const otherToken = { ...token, id: 'katakan-token', actor: otherActor, x: 100 };
  scene.tokens.set(otherToken.id, otherToken);
  game.scenes = new Collection([[scene.id, scene]]);
  game.actors = new Collection([
    [f.actor.id, f.actor],
    [otherActor.id, otherActor],
  ]);
  canvas.ready = true;
  canvas.scene = scene;
  const activate = () =>
    runCommand('shining', {
      actorUuid: f.actor.uuid,
      itemId: armor.id,
      sceneId: scene.id,
      tokenId: token.id,
    });
  return { ...f, armor, token, scene, otherActor, otherToken, activate, reconcileShining, shiningDaylight };
}

test('registered Shining creates native 6m daylight, respects native walls and follows its source token', async (t) => {
  const f = await shiningFixture(t);
  await f.activate();
  assert.equal(f.scene.lights.size, 1);
  const light = [...f.scene.lights][0];
  assert.equal(light.config.bright, 6);
  assert.equal(light.config.dim, 0);
  assert.equal(f.shiningDaylight(f.otherActor.system), true);
  assert.equal(f.otherActor.system.environment.light, 'darkness', 'manual environment remains unchanged');
  f.otherToken.x = 250;
  await f.reconcileShining();
  assert.equal(f.shiningDaylight(f.otherActor.system), false, 'native wall boundary excludes the target');
  f.token.x = 50;
  await f.reconcileShining();
  assert.equal(light.x, 50);
  await assert.rejects(f.activate(), /already has active/);
  f.armor.system.equipped = false;
  await f.reconcileShining();
  assert.equal(f.scene.lights.size, 0);
  assert.equal(f.otherActor.system.effects.length, 1);
});

test('Shining source expiry and failed receipt restore only owned light/exposure/action data', async (t) => {
  const f = await shiningFixture(t);
  const baseline = clone(f.actor.system.combat);
  f.faults.chat = true;
  await assert.rejects(f.activate(), /Receipt failed/);
  assert.equal(f.scene.lights.size, 0);
  assert.equal(f.shiningDaylight(f.otherActor.system), false);
  assert.deepEqual(f.actor.system.combat, baseline);
  await f.activate();
  const end = [...f.scene.lights][0].flags[S].shining.expires;
  game.time.worldTime = end;
  await f.reconcileShining();
  assert.equal(f.scene.lights.size, 0);
  assert.equal(f.shiningDaylight(f.otherActor.system), false);
  assert.deepEqual(f.otherActor.system.effects, [{ id: 'unrelated', key: 'Existing effect' }]);
});
