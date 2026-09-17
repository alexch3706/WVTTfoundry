import test from 'node:test';
import assert from 'node:assert/strict';
import {
  executeWorldMagic,
  worldOperationSupport,
  expireWorldItemMagic,
  restoreWorldTransformation,
  resolveWorldMagicDecision,
} from '../../module/witcher/magic-world-effects.js';

const SYSTEM = 'witcher-rilerena';
let nextId = 1;
function patch(object, changes) {
  for (const [path, value] of Object.entries(changes)) {
    const parts = path.split('.');
    let current = object;
    for (const part of parts.slice(0, -1)) current = current[part] ??= {};
    const key = parts.at(-1);
    if (key.startsWith('-=')) delete current[key.slice(2)];
    else current[key] = structuredClone(value);
  }
}
class Document {
  constructor(data, { parent, kind = 'Actor' } = {}) {
    this._source = structuredClone(data);
    this.parent = parent;
    this.documentName = kind;
    this.id = data._id ?? `id${nextId++}`;
    this.uuid = parent ? `${parent.uuid}.${kind}.${this.id}` : `${kind}.${this.id}`;
    this.items = new Map();
    this.deleted = false;
  }
  get system() {
    return this._source.system;
  }
  get flags() {
    return this._source.flags ?? {};
  }
  get name() {
    return this._source.name;
  }
  get type() {
    return this._source.type;
  }
  get ownership() {
    return this._source.ownership;
  }
  get content() {
    return this._source.content ?? '';
  }
  get img() {
    return this._source.img;
  }
  get texture() {
    return this._source.texture;
  }
  toObject() {
    return structuredClone(this._source);
  }
  async update(changes) {
    patch(this._source, changes);
    if (this.system?.overrides?.hp) this.system.hp.max = this.system.overrides.hp;
    return this;
  }
  async delete() {
    this.deleted = true;
    this.parent?.items?.delete(this.id);
  }
  async createEmbeddedDocuments(kind, sources) {
    return sources.map((data) => {
      const item = new Document(data, { parent: this, kind });
      this.items.set(item.id, item);
      return item;
    });
  }
  async getTokenDocument(overrides) {
    return { toObject: () => ({ ...this._source.prototypeToken, actorId: this.id, ...overrides }) };
  }
  testUserPermission() {
    return false;
  }
}
function actor() {
  return new Document({
    name: 'Caster',
    type: 'character',
    img: 'caster.webp',
    ownership: { player: 3 },
    system: {
      stats: { int: 8, ref: 6, dex: 5, body: 5, spd: 5, emp: 7, cra: 4, will: 8, luck: 4 },
      overrides: { hp: 30 },
      hp: { value: 23, max: 30 },
      sta: { value: 20, max: 30 },
      magic: {},
      anatomy: 'humanoid',
      locations: [],
      traits: {},
      conditions: [],
      effects: [],
    },
  });
}
async function addItem(owner, data) {
  return (
    await owner.createEmbeddedDocuments('Item', [
      {
        name: 'Item',
        type: 'gear',
        system: { quantity: 1, properties: {}, equipped: false, carried: true },
        ...data,
      },
    ])
  )[0];
}
function context(caster, extra = {}) {
  return {
    user: { id: 'gm', isGM: true },
    caster,
    castId: 'cast-1',
    sourceMagic: { key: 'test', name: 'Test magic', text: 'Book effect', source: 'Core', page: 102 },
    ...extra,
  };
}

function animal() {
  return {
    name: 'Cat',
    type: 'monster',
    img: 'cat.webp',
    system: {
      stats: { int: 1, ref: 7, dex: 8, body: 2, spd: 6, emp: 1, cra: 1, will: 3, luck: 0 },
      skills: { melee: 2 },
      overrides: { hp: 20, sta: 15 },
      hp: { value: 20, max: 20 },
      sta: { value: 15, max: 15 },
      anatomy: 'quadruped',
      locations: [{ id: 'torso', sp: 0 }],
      traits: { nightVision: true },
      transport: {},
    },
    prototypeToken: { texture: { src: 'cat-token.webp' } },
    items: [
      {
        name: 'Claw',
        type: 'weapon',
        system: { quantity: 1, equipped: true, carried: false, properties: { natural: true }, damage: '1d6' },
      },
    ],
  };
}

test('unknown operations and unimplemented delayed summons are rejected before writes', async () => {
  const caster = actor();
  assert.equal(worldOperationSupport({ type: 'item', action: 'inventTreasure' }), false);
  assert.equal(
    worldOperationSupport({ type: 'summon', profile: 'horse', appearsWithinSeconds: 3600 }),
    false
  );
  assert.equal(worldOperationSupport({ type: 'transform', form: 'greatBear' }), false);
  assert.equal(worldOperationSupport({ type: 'item', action: 'forageYield' }), false);
  await assert.rejects(
    executeWorldMagic({ type: 'item', action: 'inventTreasure' }, context(caster)),
    /No complete world executor/
  );
  assert.equal(caster.items.size, 0);
});

test('temporary Balanced changes the actual item and compensates completely', async () => {
  const caster = actor(),
    weapon = await addItem(caster, {
      type: 'weapon',
      system: { quantity: 1, category: 'sword', properties: { balanced: false } },
    });
  const before = weapon.toObject();
  const result = await executeWorldMagic(
    {
      type: 'item',
      action: 'property',
      itemId: weapon.id,
      property: 'balanced',
      value: true,
      duration: { seconds: 1800 },
    },
    context(caster)
  );
  assert.equal(result.status, 'applied');
  assert.equal(weapon.system.properties.balanced, true);
  await result.rollback();
  assert.deepEqual(weapon.toObject(), { ...before, flags: { [SYSTEM]: {} } });
});

test('overlapping equipment effects expire in either order without making the bonus permanent', async () => {
  const caster = actor(),
    weapon = await addItem(caster, {
      type: 'weapon',
      system: { quantity: 1, category: 'sword', properties: { balanced: false } },
    });
  const operation = {
    type: 'item',
    action: 'property',
    itemId: weapon.id,
    property: 'balanced',
    value: true,
  };
  await executeWorldMagic(operation, context(caster));
  await executeWorldMagic(operation, context(caster, { castId: 'cast-2' }));
  await expireWorldItemMagic(weapon, 'cast-1', { user: { isGM: true } });
  assert.equal(weapon.system.properties.balanced, true);
  await expireWorldItemMagic(weapon, 'cast-2', { user: { isGM: true } });
  assert.equal(weapon.system.properties.balanced, false);
});

test('copying one potion dose splits the affected original and consumes exactly one component', async () => {
  const caster = actor();
  const potion = await addItem(caster, {
    name: 'Swallow',
    type: 'alchemical',
    system: { category: 'potion', quantity: 3 },
  });
  const water = await addItem(caster, {
    name: 'Essence of Water',
    type: 'component',
    system: { quantity: 4 },
  });
  const result = await executeWorldMagic(
    { type: 'item', action: 'copyConsumable', sourceItem: potion.id },
    context(caster)
  );
  assert.equal(potion.system.quantity, 2);
  assert.equal(water.system.quantity, 3);
  const affected = [...caster.items.values()].filter((item) => item.flags[SYSTEM]?.essenceCopied);
  assert.equal(affected.length, 2);
  assert.equal(
    affected.reduce((sum, item) => sum + item.system.quantity, 0),
    2
  );
  await result.rollback();
  assert.equal(caster.items.size, 2);
  assert.equal(potion.system.quantity, 3);
  assert.equal(water.system.quantity, 4);
});

test('a failed copy rolls inventory changes back after an actual partial document write', async () => {
  const caster = actor(),
    potion = await addItem(caster, {
      name: 'Swallow',
      type: 'alchemical',
      system: { category: 'potion', quantity: 1 },
    });
  const water = await addItem(caster, { name: 'Essence of Water', system: { quantity: 2 } });
  caster.createEmbeddedDocuments = async () => {
    throw new Error('database unavailable');
  };
  await assert.rejects(
    executeWorldMagic({ type: 'item', action: 'copyConsumable', sourceItem: potion.id }, context(caster)),
    /database unavailable/
  );
  assert.equal(water.system.quantity, 2);
  assert.equal(potion.flags[SYSTEM]?.essenceCopied, undefined);
});

test('rust uses current armor SP per location without reducing maximum SP', async () => {
  const caster = actor();
  const armor = await addItem(caster, {
    type: 'armor',
    system: {
      quantity: 1,
      equipped: true,
      coverage: ['torso', 'rightArm'],
      stoppingPower: 10,
      sp: { torso: 7, rightArm: 9 },
    },
  });
  const result = await executeWorldMagic(
    {
      type: 'item',
      action: 'rust',
      affectsAllWornArmor: true,
      formula: '2d6',
      penalties: { ref: -2, dex: -2, spd: -2 },
    },
    context(caster, { rollFormula: async () => 4 })
  );
  assert.deepEqual(armor.system.sp, { torso: 3, rightArm: 5 });
  assert.equal(armor.system.stoppingPower, 10);
  await result.rollback();
  assert.deepEqual(armor.system.sp, { torso: 7, rightArm: 9 });
});

test('summoning creates real actor and scene-token documents and rolls both back', async () => {
  const caster = actor(),
    created = [];
  const scene = {
    grid: { size: 100 },
    async createEmbeddedDocuments(kind, records) {
      return records.map((record) => {
        const token = new Document(record, { kind });
        created.push(token);
        return token;
      });
    },
  };
  const result = await executeWorldMagic(
    { type: 'summon', profile: 'cat', count: 2, controllable: false },
    context(caster, {
      scene,
      point: { x: 0, y: 0 },
      resolveActorProfile: async () => animal(),
      createActor: async (data) => {
        const doc = new Document(data);
        created.push(doc);
        return doc;
      },
    })
  );
  assert.equal(result.receipt.summons.length, 2);
  assert.equal(created.length, 4);
  assert.deepEqual(created[0].ownership, { default: 0 });
  assert.equal(created[1]._source.actorId, created[0].id);
  await result.rollback();
  assert.ok(created.every((doc) => doc.deleted));
});

test('polymorphism retains mental stats, merges equipment, preserves damage, and restores original form', async () => {
  const caster = actor(),
    weapon = await addItem(caster, {
      type: 'weapon',
      system: { quantity: 1, equipped: true, carried: true, properties: {} },
    });
  const token = new Document({ texture: { src: 'caster-token.webp' } }, { kind: 'Token' });
  const ctx = context(caster, { casterToken: token, resolveActorProfile: async () => animal() });
  await executeWorldMagic(
    { type: 'transform', form: 'cat', mergeEquipment: true, preserveMentalStatistics: true },
    ctx
  );
  assert.equal(caster.system.stats.int, 8);
  assert.equal(caster.system.stats.body, 2);
  assert.equal(caster.system.hp.value, 13);
  assert.equal(weapon.system.equipped, false);
  assert.equal(token.texture.src, 'cat-token.webp');
  await caster.update({ 'system.hp.value': 10 });
  await restoreWorldTransformation(caster, ctx);
  assert.equal(caster.system.stats.body, 5);
  assert.equal(caster.system.hp.value, 20);
  assert.equal(weapon.system.equipped, true);
  assert.equal(caster.items.size, 1);
  assert.equal(token.texture.src, 'caster-token.webp');
});

test('narrative magic records a pending private GM decision instead of claiming the effect happened', async () => {
  const caster = actor();
  let message;
  const replies = [];
  const result = await executeWorldMagic(
    { type: 'narrative', procedure: 'answerDivineAugury', question: 'Where is the lost key?' },
    context(caster, { postMessage: async (data) => (message = new Document(data, { kind: 'ChatMessage' })) })
  );
  assert.equal(result.status, 'pendingGM');
  assert.equal(message.flags[SYSTEM].magicDecision.status, 'pendingGM');
  await assert.rejects(
    resolveWorldMagicDecision(message, { outcome: 'resolved', answer: '' }, { user: { isGM: true } }),
    /actual GM ruling/
  );
  await resolveWorldMagicDecision(
    message,
    { outcome: 'resolved', answer: 'Under the old bridge.' },
    {
      user: { id: 'gm', isGM: true },
      caster,
      postMessage: async (data) => {
        const reply = new Document(data, { kind: 'ChatMessage' });
        replies.push(reply);
        return reply;
      },
    }
  );
  assert.equal(message.flags[SYSTEM].magicDecision.status, 'resolved');
  assert.match(message.content, /Under the old bridge/);
  assert.equal(replies.length, 1);
  assert.deepEqual(replies[0]._source.whisper.sort(), ['gm', 'player']);
  assert.equal(message.flags[SYSTEM].magicDecision.replyMessageUuid, replies[0].uuid);
  const duplicate = await resolveWorldMagicDecision(
    message,
    { outcome: 'resolved', answer: 'Under the old bridge.' },
    { user: { id: 'gm', isGM: true } }
  );
  assert.equal(duplicate.duplicate, true);
  assert.equal(replies.length, 1);
});

test('a real health diagnosis reads only requested target fields and rolls its message back', async () => {
  const caster = actor(),
    patient = actor();
  let message;
  await addItem(patient, {
    name: 'Broken Ribs',
    type: 'wound',
    system: { wound: { treatment: 'treated', location: 'torso' } },
  });
  const result = await executeWorldMagic(
    { type: 'reveal', target: 'target', fields: ['hp', 'wounds'] },
    context(caster, {
      target: patient,
      postMessage: async (data) => (message = new Document(data, { kind: 'ChatMessage' })),
    })
  );
  assert.equal(result.status, 'applied');
  assert.equal(result.receipt.information[0].hp.value, 23);
  assert.equal(result.receipt.information[0].wounds[0].name, 'Broken Ribs');
  assert.equal(result.receipt.information[0].poisoned, undefined);
  await result.rollback();
  assert.equal(message.deleted, true);
});

test('Conspiracy of the Mother bonds existing crows and changes actual claws without inventing new animals', async () => {
  const caster = actor(),
    crow = actor();
  crow._source.name = 'Crow';
  crow.system.bestiary = { species: 'crow' };
  crow.system.skills = {};
  const claw = await addItem(crow, {
    name: 'Claw',
    type: 'weapon',
    system: { properties: { natural: true }, damage: '1d6/2' },
  });
  const result = await executeWorldMagic(
    { type: 'summon', profile: 'crow', count: 1, maxBonded: 10 },
    context(caster, { targets: [crow], worldActors: [crow] })
  );
  assert.equal(result.receipt.createdActors, 0);
  assert.equal(crow.system.stats.int, 7);
  assert.equal(crow.system.skills.sleightOfHand, 7);
  assert.equal(claw.system.damage, '2d6');
  assert.equal(crow.flags[SYSTEM].magicWorld.existingCreature, true);
  await result.rollback();
  assert.equal(crow.system.stats.int, 8);
  assert.equal(claw.system.damage, '1d6/2');
  assert.equal(crow.flags[SYSTEM]?.magicWorld, undefined);
});

test('ritual creature profiles create actual printed Actors and preserve paid armor snapshots', async () => {
  const caster = actor(),
    created = [];
  const armorItems = [
    {
      name: 'Head',
      type: 'armor',
      system: {
        quantity: 0,
        coverage: ['head'],
        stoppingPower: 10,
        sp: { head: 6 },
        properties: {},
        resistances: [],
      },
    },
    {
      name: 'Torso',
      type: 'armor',
      system: {
        quantity: 0,
        coverage: ['torso', 'rightArm', 'leftArm'],
        stoppingPower: 12,
        properties: {},
        resistances: ['slashing'],
      },
    },
    {
      name: 'Legs',
      type: 'armor',
      system: {
        quantity: 0,
        coverage: ['rightLeg', 'leftLeg'],
        stoppingPower: 8,
        properties: {},
        resistances: [],
      },
    },
  ];
  const scene = {
    grid: { size: 100 },
    async createEmbeddedDocuments(kind, records) {
      return records.map((record) => {
        const doc = new Document(record, { kind });
        created.push(doc);
        return doc;
      });
    },
  };
  const ctx = context(caster, {
    scene,
    point: { x: 0, y: 0 },
    armorItems,
    createActor: async (data) => {
      const doc = new Document(data);
      created.push(doc);
      return doc;
    },
  });
  const armor = await executeWorldMagic({ type: 'summon', profile: 'living-armor', count: 1 }, ctx);
  assert.equal(created[0].system.hp.value, 60);
  assert.equal(created[0].toObject().items.find((item) => item.name === 'Head').system.sp.head, 6);
  assert.equal(created[0].toObject().items.find((item) => item.name === 'Head').system.quantity, 1);
  assert.equal(armorItems[0].system.quantity, 0, 'The ritual owns component payment');
  assert.equal(created[0].flags[SYSTEM].magicCreature.profile, 'living-armor');
  assert.equal(created[0].flags[SYSTEM].magicWorld.castId, 'cast-1');
  assert.deepEqual(created[0].ownership, caster.ownership);
  const corpse = await executeWorldMagic({ type: 'summon', profile: 'corpse-amalgam', count: 1 }, ctx);
  assert.equal(created[2].system.hp.value, 100);
  assert.equal(created[2].system.sta.value, 50);
  assert.equal(created[2].system.bestiary.printedDefenses.reposition, 13);
  await corpse.rollback();
  await armor.rollback();
  assert(created.every((doc) => doc.deleted));
});

test('Chemobog checks real magical Rust REL loss without discarding the separate rust record', async () => {
  const caster = actor();
  const weapon = await addItem(caster, {
    name: 'Runed sword',
    type: 'weapon',
    system: {
      quantity: 1,
      reliability: 12,
      attachments: [{ key: 'chemobog', category: 'rune', mode: 'runewright' }],
    },
  });
  const formulas = [];
  const result = await executeWorldMagic(
    { type: 'item', action: 'rust', sourceItem: weapon.id, formula: '2d6', penalties: { ref: -2 } },
    context(caster, {
      rollFormula: async (formula) => {
        formulas.push(formula);
        return formula === '2d6' ? 5 : 3;
      },
    })
  );
  assert.deepEqual(formulas, ['2d6', '1d6']);
  assert.equal(weapon.system.reliability, 12);
  assert(weapon.flags[SYSTEM].rust);
  await result.rollback();
  assert.equal(weapon.flags[SYSTEM]?.rust, undefined);
});
