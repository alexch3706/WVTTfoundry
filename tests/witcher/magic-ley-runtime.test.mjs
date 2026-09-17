import test from 'node:test';
import assert from 'node:assert/strict';
import { workflow, clone } from './workflow-fixture.mjs';
import { SYSTEM_ID } from '../../module/witcher/config.js';
import { MAGIC, magicInfo, magicItemData } from '../../module/witcher/magic-catalog.js';
import { artifactItemData, amuletGrantedItems } from '../../module/witcher/magic-gear-rules.js';
import { runCommand } from '../../module/witcher/authority.js';
import { turnIdentity } from '../../module/witcher/runtime.js';
import { synchronizeLeyBorrowed } from '../../module/witcher/magic-learning.js';
let learnedMagic, registerMagicCommands, magicFingerprint, planAdditionalLey, effectFor, resolvedMagic;

async function fixture(t, element = 'fire', tradition = 'mage') {
  const w = await workflow(t),
    previous = Object.getOwnPropertyDescriptor(globalThis, 'CONFIG');
  ({ learnedMagic, registerMagicCommands, magicFingerprint, planAdditionalLey, effectFor, resolvedMagic } =
    await import('../../module/witcher/magic-runtime.js'));
  t.after(() =>
    previous ? Object.defineProperty(globalThis, 'CONFIG', previous) : delete globalThis.CONFIG
  );
  globalThis.CONFIG = { Canvas: { polygonBackends: { sight: { testCollision: () => false } } } };
  const actor = w.attacker,
    scene = {
      id: 'ley',
      uuid: 'Scene.ley',
      grid: { size: 100, distance: 2, units: 'm' },
      tokens: new w.Collection(),
      regions: new w.Collection(),
    };
  const place = (actor, x) => {
    const token = {
      id: actor.id,
      uuid: `Scene.ley.Token.${actor.id}`,
      documentName: 'Token',
      actor,
      parent: scene,
      name: actor.name,
      x,
      y: 0,
      width: 1,
      height: 1,
      elevation: 0,
      getMovementOrigin() {
        return { x: this.x + 50, y: this.y + 50, elevation: 0 };
      },
      testInsideRegion: () => true,
    };
    scene.tokens.set(token.id, token);
    w.docs.set(token.uuid, token);
    return token;
  };
  const source = place(actor, 0),
    target = place(w.target, 200);
  const region = {
    id: 'line',
    uuid: 'Scene.ley.Region.line',
    documentName: 'Region',
    parent: scene,
    flags: { [SYSTEM_ID]: { magicSource: { kind: 'ley', element } } },
  };
  scene.regions.set(region.id, region);
  w.docs.set(region.uuid, region);
  game.scenes = new w.Collection([[scene.id, scene]]);
  game.actors = new w.Collection([
    [actor.id, actor],
    [w.target.id, w.target],
  ]);
  await actor.update({
    'system.vigor': 20,
    'system.sta.value': 100,
    'system.magic': {
      tradition,
      speech: true,
      gestures: true,
      minorGestures: true,
      coneAngle: 90,
      spent: 0,
      roundKey: '',
      leyConnection: {
        active: true,
        sourceUuid: region.uuid,
        tokenUuid: source.uuid,
        element,
        dc: 16,
        history: {},
      },
    },
  });
  registerMagicCommands();
  const learn = async (key) => (await actor.createEmbeddedDocuments('Item', [magicItemData(key)]))[0];
  const cast = (item, values = {}, extra = {}) =>
    runCommand('magicCast', {
      actorUuid: actor.uuid,
      itemId: item.id,
      expected: magicFingerprint(item),
      turn: turnIdentity(),
      tokenUuid: source.uuid,
      targetUuids: [target.uuid],
      values: { power: magicInfo(item.system.magic.key).cost.min, manualDice: '6', ...values },
      ...extra,
    });
  const job = () => actor.system.magic.leyConnection.pending?.[0];
  return { ...w, actor, scene, region, source, target, learn, cast, job };
}
test('real Earth casting fumble also disconnects and increases only this line’s future connection DC', async (t) => {
  const w = await fixture(t, 'earth'),
    item = await w.learn('cenlly-graig');
  const card = await w.cast(item, { manualDice: '1,3' });
  assert.equal(w.actor.system.hp.value, 22);
  assert.equal(w.actor.system.magic.leyConnection.active, false);
  assert.equal(w.actor.system.magic.leyConnection.dc, 18);
  assert.equal(w.actor.system.magic.leyConnection.history[w.region.uuid].dc, 18);
  assert.equal(card.flags[SYSTEM_ID].failed, false);
});
test('Ley effects merge with ordinary conditions/effect removals and priest penalties stack independently', async (t) => {
  const w = await fixture(t, 'water', 'priest');
  const data = {
    castId: 'one',
    magic: magicInfo('quen'),
    check: { total: 10 },
    actorUuid: w.actor.uuid,
    tokenUuid: w.source.uuid,
  };
  const changes = { 'system.effects': [{ id: 'kept', modifiers: {} }], 'system.conditions': ['fire'] };
  planAdditionalLey(w.actor, data, changes, { elementalBacklash: true, staCost: 2 });
  assert.equal(changes['system.effects'].length, 2);
  assert.equal(changes['system.effects'][1].modifiers.vigor, -2);
  assert.deepEqual(changes['system.conditions'], ['fire']);
  await w.actor.update(changes);
  game.time.worldTime = 100;
  const next = {};
  planAdditionalLey(
    w.actor,
    { ...data, castId: 'two' },
    next,
    { elementalBacklash: false, staCost: 2 },
    { fumble: 1 }
  );
  assert.equal(next['system.effects'].filter((effect) => effect.magic?.key === 'ley-line-penalty').length, 2);
  assert.equal(next['system.effects'].at(-1).expires, 21700);
});
test('real upkeep overdraw adds Water hallucinations without losing the paid effect or ordinary Frozen backlash', async (t) => {
  const w = await fixture(t, 'water'),
    item = await w.learn('control-water');
  const magic = magicInfo('control-water');
  const effect = effectFor(
    {
      castId: 'initial',
      actorUuid: w.actor.uuid,
      tokenUuid: w.source.uuid,
      itemUuid: item.uuid,
      itemId: item.id,
      magicKey: magic.key,
      magic,
      power: 5,
      staCost: 5,
      resolved: resolvedMagic(magic, 5),
      check: { total: 19 },
    },
    { magic: { casterEffect: true } }
  );
  await w.actor.update({ 'system.effects': [effect], 'system.vigor': 1 });
  game.time.worldTime = 3;
  await runCommand('magicMaintain', {
    actorUuid: w.actor.uuid,
    effectId: effect.id,
    turn: turnIdentity(),
    values: { overdraw: true },
  });
  assert(w.actor.system.conditions.includes('hallucinating'));
  assert(w.actor.system.conditions.includes('frozen'));
  assert(w.actor.system.effects.some((entry) => entry.id === effect.id));
  assert(w.actor.system.effects.some((entry) => entry.magic?.leyHallucinationSource === w.region.uuid));
});
test('Air grants are real source-tagged items; amulet/borrowed knowledge cannot bootstrap a new tier', async (t) => {
  const w = await fixture(t, 'air');
  await w.learn('light-feet');
  await synchronizeLeyBorrowed(w.actor);
  const grants = w.actor.items.filter((item) => item.flags[SYSTEM_ID]?.leyBorrowed);
  const expected = MAGIC.filter(
    (magic) =>
      magic.kind === 'spell' &&
      magic.element === 'air' &&
      magic.tier === 'novice' &&
      magic.key !== 'light-feet'
  );
  assert.equal(grants.length, expected.length);
  assert(grants.every((item) => item.flags[SYSTEM_ID].leyBorrowed.sourceUuid === w.region.uuid));
  await synchronizeLeyBorrowed(w.actor);
  assert.equal(w.actor.items.filter((item) => item.flags[SYSTEM_ID]?.leyBorrowed).length, expected.length);
  await w.actor.update({ 'system.magic.leyConnection.active': false });
  await synchronizeLeyBorrowed(w.actor);
  assert.equal(w.actor.items.filter((item) => item.flags[SYSTEM_ID]?.leyBorrowed).length, 0);
  assert(w.actor.items.some((item) => item.system.magic.key === 'light-feet'));
});
test('stale Air grant cannot cast after disconnect even before the cleanup hook executes', async (t) => {
  const w = await fixture(t, 'air');
  await w.learn('bronwyns-gust');
  await synchronizeLeyBorrowed(w.actor);
  const borrowed = w.actor.items.find((item) => item.system.magic.key === 'light-feet');
  assert(learnedMagic(w.actor, borrowed.id));
  await w.actor.update({ 'system.magic.leyConnection.active': false });
  assert.throws(() => learnedMagic(w.actor, borrowed.id), /no longer grants/);
});
test('Air replacement is real casting with original STA paid once and normal effect application', async (t) => {
  const w = await fixture(t, 'air');
  const changes = {},
    data = {
      castId: 'air-original',
      magic: magicInfo('bronwyns-gust'),
      actorUuid: w.actor.uuid,
      tokenUuid: w.source.uuid,
      power: 2,
      check: { total: 14, base: 10, dice: [1, 7], fumble: 7 },
    };
  planAdditionalLey(w.actor, data, changes, { elementalBacklash: false, staCost: 2 }, { fumble: 7 });
  await w.actor.update(changes);
  const job = await runCommand('magicLeyChoose', {
    actorUuid: w.actor.uuid,
    jobId: w.job().id,
    magicKey: 'light-feet',
  });
  const sta = w.actor.system.sta.value;
  const card = await runCommand('magicLeyResolve', {
    actorUuid: w.actor.uuid,
    jobId: job.id,
    version: job.version,
    targetUuids: [],
    values: { power: 2 },
  });
  assert.equal(w.actor.system.sta.value, sta);
  assert.equal(card.flags[SYSTEM_ID].failed, false);
  assert.equal(card.flags[SYSTEM_ID].staCost, 2);
  assert.equal(card.flags[SYSTEM_ID].check.fumble, 7);
  await runCommand('magicApply', { messageUuid: card.uuid });
  assert(w.actor.system.effects.some((effect) => effect.magic?.key === 'light-feet'));
  await assert.rejects(
    runCommand('magicLeyResolve', {
      actorUuid: w.actor.uuid,
      jobId: job.id,
      version: job.version,
      targetUuids: [],
      values: { power: 2 },
    }),
    /already been resolved/
  );
});
test('Fire fumble creates one mandatory random recast; actual cost/extra action is paid and its fumble cannot recurse', async (t) => {
  const w = await fixture(t, 'fire'),
    item = await w.learn('aenye');
  const first = await w.cast(item, { manualDice: '1,3' });
  assert(w.job());
  assert.match(first.content, /mandatory additional action/);
  const sta = w.actor.system.sta.value;
  w.enqueue(['1d2', 2]);
  const job = await runCommand('magicLeyChoose', { actorUuid: w.actor.uuid, jobId: w.job().id });
  assert.equal(job.targetUuid, w.target.uuid);
  const repeat = await runCommand('magicLeyResolve', {
    actorUuid: w.actor.uuid,
    jobId: job.id,
    version: job.version,
    targetUuids: [job.targetUuid],
    values: { manualDice: '1,7' },
  });
  assert.equal(w.actor.system.sta.value, sta - 8);
  assert.equal(w.actor.system.combat.extra, 1);
  assert.equal(repeat.flags[SYSTEM_ID].failed, true);
  assert.equal(w.actor.system.magic.leyConnection.pending.length, 0);
  assert.equal(w.actor.system.conditions.includes('fire'), true);
});
test('Fire choice is saved without rerolling and failed card persistence compensates the forced payment and pending job', async (t) => {
  const w = await fixture(t, 'fire'),
    item = await w.learn('aenye');
  await w.cast(item, { manualDice: '1,3' });
  w.enqueue(['1d2', 1]);
  const job = await runCommand('magicLeyChoose', { actorUuid: w.actor.uuid, jobId: w.job().id });
  const again = await runCommand('magicLeyChoose', { actorUuid: w.actor.uuid, jobId: job.id });
  assert.deepEqual(again, job);
  const before = w.actor.toObject();
  w.faults.create = () => true;
  await assert.rejects(
    runCommand('magicLeyResolve', {
      actorUuid: w.actor.uuid,
      jobId: job.id,
      version: job.version,
      targetUuids: [job.targetUuid],
      values: { manualDice: '6' },
    }),
    /Injected/
  );
  assert.deepEqual(w.actor.toObject(), before);
});
test('a worn actual amulet lets a priest cast a mage spell with only Focus2 and rechecks its source on every use', async (t) => {
  const w = await fixture(t, 'fire', 'priest');
  await w.actor.update({ 'system.magic.leyConnection.active': false });
  const [amulet] = await w.actor.createEmbeddedDocuments('Item', [
    artifactItemData('amulet', { storedMagic: [{ key: 'aenye' }], complete: true }),
  ]);
  await amulet.update({ 'system.equipped': true });
  const [spell] = await w.actor.createEmbeddedDocuments('Item', amuletGrantedItems(amulet));
  const sta = w.actor.system.sta.value;
  await w.cast(spell);
  assert.equal(w.actor.system.sta.value, sta - 3);
  await amulet.update({ 'system.equipped': false });
  assert.throws(() => learnedMagic(w.actor, spell.id), /equipped/);
  await amulet.update({ 'system.equipped': true });
  await w.actor.update({ 'system.vigor': 2 });
  await assert.rejects(w.cast(spell, { overdraw: true }), /sufficient Vigor/);
});
test('an actual priest counter fumble applies cumulative Ley Vigor penalty and uses only the Dispel amulet focus', async (t) => {
  const w = await fixture(t, 'air', 'priest');
  const [amulet] = await w.actor.createEmbeddedDocuments('Item', [
    artifactItemData('amulet', { storedMagic: [{ key: 'dispel' }], complete: true }),
  ]);
  await amulet.update({ 'system.equipped': true });
  const [dispel] = await w.actor.createEmbeddedDocuments('Item', amuletGrantedItems(amulet));
  const incoming = await ChatMessage.create({
    flags: {
      [SYSTEM_ID]: {
        kind: 'magic',
        castId: 'incoming',
        name: 'Incoming spell',
        magicKey: 'quen',
        magic: magicInfo('quen'),
        power: 4,
        actorUuid: w.target.actor.uuid,
        tokenUuid: w.target.uuid,
        check: { total: 18, base: 10, dice: [8], fumble: 0 },
        staCost: 4,
        failed: false,
        cancelled: false,
        applied: false,
        targets: [{ actorUuid: w.actor.uuid, tokenUuid: w.source.uuid, status: 'pending' }],
        fumble: {},
      },
    },
  });
  const sta = w.actor.system.sta.value;
  const card = await runCommand('magicCounter', {
    messageUuid: incoming.uuid,
    reactorUuid: w.actor.uuid,
    tokenUuid: w.source.uuid,
    turn: turnIdentity(),
    values: { defense: 'dispel', dispelItemId: dispel.id, manualDice: '1,2' },
  });
  assert.equal(w.actor.system.sta.value, sta - 1);
  assert.equal(w.actor.system.hp.value, 23);
  assert.equal(
    w.actor.system.effects.find((effect) => effect.magic?.key === 'ley-line-penalty').modifiers.vigor,
    -2
  );
  assert(card.content.includes('six hours'));
});
test('maintained amulet spell revalidates its worn source and never discounts upkeep a second time', async (t) => {
  const w = await fixture(t, 'air', 'priest');
  await w.actor.update({ 'system.magic.leyConnection.active': false });
  const [amulet] = await w.actor.createEmbeddedDocuments('Item', [
    artifactItemData('amulet', { storedMagic: [{ key: 'afans-mirror' }], complete: true }),
  ]);
  await amulet.update({ 'system.equipped': true });
  const [spell] = await w.actor.createEmbeddedDocuments('Item', amuletGrantedItems(amulet)),
    magic = magicInfo('afans-mirror');
  const effect = effectFor(
    {
      castId: 'amulet-maintained',
      actorUuid: w.actor.uuid,
      tokenUuid: w.source.uuid,
      itemUuid: spell.uuid,
      itemId: spell.id,
      amuletId: amulet.id,
      magicKey: magic.key,
      magic,
      power: 3,
      staCost: 1,
      resolved: resolvedMagic(magic, 3),
      check: { total: 19 },
    },
    { magic: { casterEffect: true } }
  );
  await w.actor.update({ 'system.effects': [effect] });
  game.time.worldTime = 3;
  const sta = w.actor.system.sta.value;
  await runCommand('magicMaintain', {
    actorUuid: w.actor.uuid,
    effectId: effect.id,
    turn: turnIdentity(),
    values: {},
  });
  assert.equal(w.actor.system.sta.value, sta - magic.duration.maintenanceCost);
  await amulet.update({ 'system.equipped': false });
  game.time.worldTime = 6;
  await assert.rejects(
    runCommand('magicMaintain', {
      actorUuid: w.actor.uuid,
      effectId: effect.id,
      turn: turnIdentity(),
      values: {},
    }),
    /equipped/
  );
});
