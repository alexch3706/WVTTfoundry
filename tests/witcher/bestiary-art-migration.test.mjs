import { test } from 'node:test';
import assert from 'node:assert/strict';
import { updateBestiaryArt } from '../../module/witcher/bestiary-art-migration.js';

const ID = '457d92acb05226b4';
const UUID = `Compendium.witcher-rilerena.bestiary.Actor.${ID}`;
const DEFAULT = 'icons/svg/mystery-man.svg';
const ART = {
  [ID]: {
    name: 'Bandit',
    portrait: 'systems/witcher-rilerena/assets/bestiary/bandit-portrait.webp',
    token: 'systems/witcher-rilerena/assets/bestiary/bandit-token.webp',
  },
};
const GM = { id: 'gm', isGM: true, active: true, isActiveGM: true };
const collection = (documents) => ({ contents: documents, get: (id) => documents.find((d) => d.id === id) });

function assignPaths(object, changes) {
  for (const [path, value] of Object.entries(changes)) {
    const keys = path.split('.'),
      final = keys.pop();
    let target = object;
    for (const key of keys) target = target[key] ??= {};
    target[final] = structuredClone(value);
  }
}

class DocumentFixture {
  constructor(data, uuid) {
    this._source = structuredClone(data);
    this.uuid = uuid;
    this.updates = [];
    this.failures = 0;
    this.cancel = false;
  }
  get id() {
    return this._source._id;
  }
  get name() {
    return this._source.name;
  }
  async update(changes) {
    this.updates.push(structuredClone(changes));
    if (this.failures-- > 0) throw new Error('Simulated database failure');
    if (this.cancel) return undefined;
    assignPaths(this._source, changes);
    return this;
  }
}

function actor(id, changes = {}) {
  const document = new DocumentFixture(
    {
      _id: id,
      name: 'Bandit',
      type: 'npc',
      img: DEFAULT,
      _stats: { compendiumSource: UUID },
      prototypeToken: { texture: { src: DEFAULT, scaleX: 1.2 }, ring: { enabled: true } },
      system: { hp: { value: 7 }, source: 'The Witcher Core Rulebook v1.35', page: 270 },
      ownership: { player: 3 },
      flags: {},
    },
    `Actor.${id}`
  );
  assignPaths(document._source, changes);
  return document;
}

class TokenFixture extends DocumentFixture {
  constructor(id, actorId, changes = {}) {
    super(
      {
        _id: id,
        name: id,
        actorId,
        actorLink: false,
        texture: { src: DEFAULT, scaleX: 1.4, scaleY: 0.8 },
        x: 100,
        y: 200,
        rotation: 30,
        width: 2,
        height: 2,
        ring: { enabled: true, subject: { texture: 'worlds/test/custom-ring.webp' } },
        delta: { system: { hp: { value: 2 } } },
      },
      `Scene.inactive.Token.${id}`
    );
    assignPaths(this._source, changes);
  }
  get actorId() {
    return this._source.actorId;
  }
  get actorLink() {
    return this._source.actorLink;
  }
  get baseActor() {
    return game.actors.get(this.actorId);
  }
  get actor() {
    if (!this.baseActor || this.actorLink) return this.baseActor;
    // V14 BaseActorDelta.toObject drops optional null fields before merging.
    const data = structuredClone(this.baseActor._source);
    for (const [key, value] of Object.entries(this._source.delta ?? {})) {
      if (value != null) data[key] = structuredClone(value);
    }
    return { _source: data };
  }
}

function world(actors, tokens = [], user = GM) {
  globalThis.game = {
    user: { ...user },
    users: { activeGM: GM, contents: [GM, user] },
    actors: collection(actors),
    scenes: collection([
      { id: 'active', active: true, tokens: collection([]) },
      { id: 'inactive', active: false, tokens: collection(tokens) },
    ]),
  };
}

test('art migration matches current and legacy provenance, including renamed imports', async () => {
  const renamed = actor('renamed', { name: 'The bridge sentry' });
  const legacy = actor('legacy', { '_stats.compendiumSource': null, 'flags.core.sourceId': UUID });
  const oldUuid = actor('old-uuid', {
    '_stats.compendiumSource': null,
    'flags.core.sourceId': UUID.replace('.Actor.', '.'),
  });
  const marked = actor('marked', {
    '_stats.compendiumSource': null,
    'flags.witcher-rilerena.sourcePages': [271, 272],
  });
  const unrelated = actor('unrelated', { '_stats.compendiumSource': null });
  const pc = actor('pc', { type: 'character' });
  const otherPack = actor('other-pack', {
    '_stats.compendiumSource': UUID.replace('.bestiary.', '.my-bestiary.'),
    'flags.witcher-rilerena.sourcePages': [271, 272],
  });
  const inconsistentMarker = actor('bad-marker', {
    '_stats.compendiumSource': null,
    'flags.witcher-rilerena.sourcePages': [17],
  });
  world([renamed, legacy, oldUuid, marked, unrelated, pc, otherPack, inconsistentMarker]);
  const result = await updateBestiaryArt(ART);
  assert.equal(result.actorsUpdated, 4);
  assert.equal(result.actorPortraitsUpdated, 4);
  assert.equal(result.prototypeTokensUpdated, 4);
  for (const matched of [renamed, legacy, oldUuid, marked]) {
    assert.equal(matched._source.img, ART[ID].portrait);
    assert.equal(matched._source.prototypeToken.texture.src, ART[ID].token);
  }
  for (const skipped of [unrelated, pc, otherPack, inconsistentMarker])
    assert.equal(skipped.updates.length, 0);
});

test('custom portraits and token art are independently preserved without changing game data', async () => {
  const portrait = actor('portrait', { img: 'worlds/test/my-portrait.webp' });
  const prototype = actor('prototype', { 'prototypeToken.texture.src': 'worlds/test/my-token.webp' });
  const custom = actor('custom', {
    img: 'https://example.test/portrait.webp',
    'prototypeToken.texture.src': 'worlds/test/my-token.webp',
  });
  const snapshots = [portrait, prototype, custom].map((a) => structuredClone(a._source));
  world([portrait, prototype, custom]);
  await updateBestiaryArt(ART);
  assert.deepEqual(portrait.updates, [{ 'prototypeToken.texture.src': ART[ID].token }]);
  assert.deepEqual(prototype.updates, [{ img: ART[ID].portrait }]);
  assert.equal(custom.updates.length, 0);
  for (const [i, document] of [portrait, prototype, custom].entries()) {
    const before = snapshots[i];
    before.img = document._source.img;
    before.prototypeToken.texture.src = document._source.prototypeToken.texture.src;
    assert.deepEqual(document._source, before);
  }
});

test('all inactive scene tokens update safely; old default ActorDelta portraits resume inheritance', async () => {
  const imported = actor('imported');
  const linked = new TokenFixture('linked', imported.id, { actorLink: true });
  const unlinked = new TokenFixture('unlinked', imported.id, { 'delta.img': DEFAULT });
  const inherited = new TokenFixture('inherited', imported.id);
  const custom = new TokenFixture('custom', imported.id, {
    'texture.src': 'worlds/test/token.webp',
    'delta.img': 'worlds/test/portrait.webp',
  });
  const snapshots = [linked, unlinked, inherited, custom].map((t) => structuredClone(t._source));
  world([imported], [linked, unlinked, inherited, custom]);
  const result = await updateBestiaryArt(ART);
  assert.equal(result.scenesScanned, 2);
  assert.equal(result.tokensScanned, 4);
  assert.equal(result.tokensUpdated, 3);
  assert.equal(result.tokenTexturesUpdated, 3);
  assert.equal(result.syntheticPortraitsUpdated, 1);
  assert.equal(unlinked._source.delta.img, null);
  assert.equal(unlinked.actor._source.img, ART[ID].portrait);
  assert.equal(inherited.actor._source.img, ART[ID].portrait);
  assert.equal(custom.actor._source.img, 'worlds/test/portrait.webp');
  assert.equal(custom.updates.length, 0);
  assert.ok(!Object.hasOwn(linked.updates[0], 'delta.img'));
  assert.ok(!Object.hasOwn(inherited.updates[0], 'delta.img'));
  for (const [i, token] of [linked, unlinked, inherited, custom].entries()) {
    const before = snapshots[i];
    before.texture.src = token._source.texture.src;
    if (Object.hasOwn(token._source.delta, 'img')) before.delta.img = token._source.delta.img;
    assert.deepEqual(token._source, before);
  }
  const rerun = await updateBestiaryArt(ART);
  assert.equal(rerun.actorsUpdated + rerun.tokensUpdated, 0);
  assert.deepEqual(rerun.errors, []);
});

test('clearing a placeholder delta preserves and inherits a custom world portrait', async () => {
  const imported = actor('custom-base', { img: 'worlds/test/my-bandit.webp' });
  const token = new TokenFixture('old-delta', imported.id, { 'delta.img': 'icons/svg/pawprint.svg' });
  world([imported], [token]);
  await updateBestiaryArt(ART);
  assert.equal(token._source.delta.img, null);
  assert.equal(token.actor._source.img, 'worlds/test/my-bandit.webp');
  await imported.update({ img: 'worlds/test/revised-bandit.webp' });
  assert.equal(token.actor._source.img, 'worlds/test/revised-bandit.webp');
});

test('null, empty and pawprint placeholders update; unidentifiable or orphaned tokens do not', async () => {
  const missing = actor('missing', { img: null, 'prototypeToken.texture.src': '' });
  const pawprint = actor('pawprint', { img: 'icons/svg/pawprint.svg' });
  const unknown = actor('unknown', { '_stats.compendiumSource': null });
  const token = new TokenFixture('empty', missing.id, { 'texture.src': null });
  const unrelated = new TokenFixture('unrelated', unknown.id);
  const orphan = new TokenFixture('orphan', 'deleted-actor');
  world([missing, pawprint, unknown], [token, unrelated, orphan]);
  const result = await updateBestiaryArt(ART);
  assert.equal(result.actorsUpdated, 2);
  assert.equal(result.tokensUpdated, 1);
  assert.equal(unrelated.updates.length + orphan.updates.length, 0);
});

test('only the elected active GM can write, and losing election stops later writes', async () => {
  for (const user of [
    { id: 'player', isGM: false, active: true },
    { id: 'gm2', isGM: true, active: true, isActiveGM: false },
    { id: 'gm', isGM: true, active: false },
  ]) {
    const imported = actor('not-written');
    world([imported], [], user);
    const result = await updateBestiaryArt(ART);
    assert.equal(result.skipped, 'not-primary-gm');
    assert.equal(imported.updates.length, 0);
  }
  const first = actor('first'),
    second = actor('second');
  world([first, second]);
  const update = first.update.bind(first);
  first.update = async (changes) => {
    const result = await update(changes);
    game.user.isActiveGM = false;
    return result;
  };
  const result = await updateBestiaryArt(ART);
  assert.equal(result.skipped, 'lost-primary-gm');
  assert.equal(first.updates.length, 1);
  assert.equal(second.updates.length, 0);
});

test('partial actor and token failures remain retryable while successful documents stay unchanged', async () => {
  const failed = actor('failed'),
    good = actor('good');
  failed.failures = 1;
  const token = new TokenFixture('failed-token', good.id, { 'delta.img': DEFAULT });
  token.failures = 1;
  const surviving = new TokenFixture('surviving-token', failed.id);
  world([failed, good], [token, surviving]);
  const first = await updateBestiaryArt(ART);
  assert.equal(first.errors.length, 2);
  assert.equal(first.actorsUpdated, 1);
  assert.equal(first.tokensUpdated, 1);
  assert.equal(surviving.actor._source.img, ART[ID].portrait);
  const next = await updateBestiaryArt(ART);
  assert.equal(next.errors.length, 0);
  assert.equal(next.actorsUpdated, 1);
  assert.equal(next.tokensUpdated, 1);
  assert.equal(good.updates.length, 1);
  assert.equal(surviving.updates.length, 1);
  assert.equal(token.actor._source.img, ART[ID].portrait);
});

test('cancelled writes report errors and overlapping callers share a scan', async () => {
  const imported = actor('cancelled');
  imported.cancel = true;
  world([imported]);
  const [first, concurrent] = await Promise.all([updateBestiaryArt(ART), updateBestiaryArt(ART)]);
  assert.equal(imported.updates.length, 1);
  assert.deepEqual(first, concurrent);
  assert.equal(first.actorsUpdated, 0);
  assert.match(first.errors[0].message, /cancelled/);
  imported.cancel = false;
  const retry = await updateBestiaryArt(ART);
  assert.equal(retry.actorsUpdated, 1);
  assert.deepEqual(retry.errors, []);
});
