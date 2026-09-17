import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { workflow } from './workflow-fixture.mjs';
import { SYSTEM_ID as S } from '../../module/witcher/config.js';
import {
  installStonePlan,
  makeAttachment,
  rebuildEnhancementUpdate,
} from '../../module/witcher/enhancements.js';
import { commitActor } from '../../module/witcher/runtime.js';
import {
  applyRetribution,
  redirectProjectile,
  awardRejuvenation,
} from '../../module/witcher/enhancement-combat.js';
import { gainAdrenaline, adrenalineState, executeAdrenalineHP } from '../../module/witcher/adrenaline.js';
import { ALCHEMY_PROFILES, alchemyEffect } from '../../module/witcher/alchemy-rules.js';
import { alchemyElapsedRecovery } from '../../module/witcher/alchemy-time.js';
const sources = ['witcher-gear', 'tome-enhancements', 'equipment'].flatMap((name) =>
  JSON.parse(fs.readFileSync(new URL(`../../data/witcher/${name}.json`, import.meta.url)))
);
const source = (name) => {
  const entry = sources.find((i) => i.name === name);
  assert(entry, name);
  return structuredClone(entry);
};
async function attach(item, name, { improved = false } = {}) {
  if (!item.system.attachments?.length)
    await item.update({ 'system.enhancements': 3, 'system.attachments': [] });
  const record = source(name);
  const update = name.includes('word:')
    ? rebuildEnhancementUpdate(item, [makeAttachment(record, { id: name })])
    : installStonePlan(item, record, {
        id: name,
        mode: improved ? 'runewright' : 'ordinary',
        stoneWeight: 'consumed',
      }).update;
  await item.update(update);
}
async function hit(w, sword, { raw = 12, ...values } = {}) {
  const attack = await w.attack(sword, { manualDice: '8', ...values });
  w.enqueue(['2d6+4', raw]);
  await w.defend(attack, { manualDice: '4' });
  const damage = w.damageFor(attack);
  assert(damage, w.notices.join('\n'));
  await w.apply(damage);
  return { attack, damage };
}

test('Chemobog protects real block wear, compensates failed chat and still allows failed protection', async (t) => {
  const w = await workflow(t),
    sword = await w.importItem(w.attacker, 'Arming Sword', { equipped: true }),
    shield = await w.importItem(w.target, 'Arming Sword', { equipped: true });
  await attach(shield, 'Chemobog');
  w.start();
  const rel = shield.system.reliability;
  const a = await w.attack(sword, { manualDice: '4' });
  w.enqueue(['1d6', 4]);
  await w.defend(a, { defense: 'blockWeapon', weapon: shield.id, manualDice: '8' });
  assert.equal(shield.system.reliability, rel);
  assert.equal(a.flags[S].resolved, true);
  w.enqueue(['1d6', 4]);
  await assert.rejects(
    () =>
      commitActor(w.target, {}, [{ _id: shield.id, 'system.reliability': rel - 1 }], () => {
        throw Error('after failed');
      }),
    /after failed/
  );
  assert.equal(shield.system.reliability, rel);
  w.enqueue(['1d6', 3]);
  await commitActor(w.target, {}, [{ _id: shield.id, 'system.reliability': rel - 1 }]);
  assert.equal(shield.system.reliability, rel - 1);
});

test('Burning selects real fire damage without ignition; Rotation removes rear bonus; Warding resists it', async (t) => {
  const w = await workflow(t),
    sword = await w.importItem(w.attacker, 'Arming Sword', { equipped: true }),
    armor = await w.importItem(w.target, 'Gambeson', { equipped: true });
  await attach(sword, 'Runeword: Burning');
  await attach(armor, 'Glyphword: Rotation');
  w.start();
  const first = await hit(w, sword, { type: 'fire', rear: true });
  assert.equal(first.attack.flags[S].check.total, 17); // 10 base +8 die -1 torso aim, no rear +3
  assert.equal(first.damage.flags[S].request[0].type, 'fire');
  assert(!w.target.system.conditions.includes('fire'));
  await armor.update(rebuildEnhancementUpdate(armor, []));
  await attach(armor, 'Glyph of Warding');
  const second = await hit(w, sword, { type: 'fire' });
  assert.equal(second.damage.flags[S].summary[0].damage, 5); // armor ablated to SP2: (12-2)/2
});

test('Shearing doubles penetrated armor ablation and only adds pavise wear on penetration', async (t) => {
  const w = await workflow(t),
    sword = await w.importItem(w.attacker, 'Arming Sword', { equipped: true }),
    armor = await w.importItem(w.target, 'Gambeson', { equipped: true });
  const pavise = await w.importItem(w.target, 'Pavise', { equipped: true });
  await attach(sword, 'Runeword: Shearing');
  w.start();
  await hit(w, sword);
  assert.equal(armor.system.sp.torso, 1);
  await pavise.update({ 'system.reliability': 10 });
  await hit(w, sword, { raw: 8, coverItemId: pavise.id });
  assert.equal(pavise.system.reliability, 9);
  game.combat.round++;
  game.combat.turn++;
  await hit(w, sword, { raw: 12, coverItemId: pavise.id });
  assert.equal(pavise.system.reliability, 7);
});

test('Protection grants maximum HP only; Mending improves actual healing but never temporary HP grants', async (t) => {
  const w = await workflow(t),
    armor = await w.importItem(w.target, 'Gambeson', { equipped: true });
  await attach(armor, 'Glyphword: Protection');
  assert.equal(w.target.system.hp.max, 30);
  assert.equal(w.target.system.hp.value, 25);
  await armor.update(rebuildEnhancementUpdate(armor, []));
  await attach(armor, 'Glyph of Mending');
  await w.target.update({ 'system.hp.value': 5 });
  await commitActor(w.target, { 'system.hp.value': 8 });
  assert.equal(w.target.system.hp.value, 9);
  await commitActor(w.target, {
    'system.effects': [{ id: 'temp', temporaryHp: 5, modifiers: { hp: 5 } }],
    'system.hp.value': 14,
  });
  assert.equal(w.target.system.hp.value, 14);
  const dose = alchemyEffect(ALCHEMY_PROFILES.swallow, { id: 'swallow', now: 0 });
  assert.equal(
    alchemyElapsedRecovery({ ...w.target.system, effects: [dose] }, 6, { healingBonus: 1 }).healing,
    8
  );
});

test('Retribution is armor-ignoring untyped magic without an invented block defense; duplicate and failed receipts never double damage', async (t) => {
  const w = await workflow(t),
    sword = await w.importItem(w.attacker, 'Arming Sword', { equipped: true }),
    armor = await w.importItem(w.target, 'Gambeson', { equipped: true });
  await attach(armor, 'Glyphword: Retribution');
  w.start();
  await w.attacker.update({ 'system.effects': [{ id: 'quen', shieldHP: 10, magic: { key: 'quen' } }] });
  const { damage } = await hit(w, sword);
  assert.equal(w.attacker.system.hp.value, 22);
  assert.equal(w.attacker.system.effects[0].shieldHP, 10);
  await applyRetribution(damage, w.target, damage.flags[S]);
  assert.equal(w.attacker.system.hp.value, 22);
  await w.attacker.update({ 'system.effects': [], 'system.resistances': ['elemental'] });
  const next = await hit(w, sword);
  assert.equal(w.attacker.system.hp.value, 19); // source gives no elemental damage type
  const altered = { ...next.damage.flags[S], attackRef: 'rollback' };
  w.faults.create = (data) => data.flags?.[S]?.kind === 'retribution';
  await assert.rejects(() => applyRetribution(next.damage, w.target, altered), /Injected/);
  assert.equal(w.attacker.system.hp.value, 19);
  assert(!w.attacker.system.combat.applied.includes('retribution:rollback'));
});

test('Rejuvenation requires actual death, preserves ownership after an armor-stopped hit and pays once', async (t) => {
  const w = await workflow(t),
    sword = await w.importItem(w.attacker, 'Arming Sword', { equipped: true });
  await attach(sword, 'Runeword: Rejuvenation');
  w.start();
  const { damage } = await hit(w, sword);
  const event = w.target.flags[S].alchemyLastHit;
  await w.attacker.update({ 'system.sta.value': 5 });
  await awardRejuvenation(w.target, event);
  assert.equal(w.attacker.system.sta.value, 5);
  await w.target.update({ 'system.effects': [{ id: 'quen', shieldHP: 99, magic: { key: 'quen' } }] });
  await hit(w, sword);
  assert.equal(w.target.flags[S].alchemyLastHit.messageUuid, damage.uuid);
  await w.target.setCondition('dead');
  await awardRejuvenation(w.target, event);
  const recovered = w.attacker.system.sta.value;
  assert.equal(recovered, 5 + w.attacker.system.derived.rec);
  await awardRejuvenation(w.target, event);
  assert.equal(w.attacker.system.sta.value, recovered);
});

function token(w, actor, x = 0) {
  const doc = { uuid: 'Token.' + actor.id, actor, parent: { id: 'scene' }, x, y: 0 };
  doc.object = { document: doc, center: { x, y: 0 } };
  w.docs.set(doc.uuid, doc);
  return doc;
}
async function projectile(w, total) {
  const src = token(w, w.attacker),
    dst = token(w, w.target, 1);
  return ChatMessage.create({
    flags: {
      [S]: {
        kind: 'attack',
        actorUuid: w.attacker.uuid,
        targetUuid: w.target.uuid,
        authorId: game.user.id,
        sourceTokenUuid: src.uuid,
        targetTokenUuid: dst.uuid,
        weapon: { id: 'arrow', name: 'Arrow', category: 'bow', properties: {}, reliability: 10 },
        check: { total, fumble: 0 },
        action: 'normal',
        style: 'normal',
        resolved: false,
      },
    },
  });
}

test('Deflection uses weapon -6, strict victory and a real second defense with only Staggered', async (t) => {
  const w = await workflow(t),
    sword = await w.importItem(w.target, 'Arming Sword', { equipped: true });
  await attach(sword, 'Runeword: Deflection');
  w.start();
  canvas.grid = { measurePath: ([a, b]) => ({ distance: Math.abs(a.x - b.x) }) };
  const a = await projectile(w, 10);
  await w.defend(a, { defense: 'parry', weapon: sword.id, manualDice: '8' });
  assert.equal(w.target.skillCalls.at(-1).options.modifier, -6);
  const offer = w.messages.find((m) => m.flags?.[S]?.kind === 'deflection');
  assert(offer, w.notices.join('\n'));
  const far = token(w, w.makeActor('Far'), 50);
  await assert.rejects(
    () =>
      redirectProjectile(
        { messageUuid: offer.uuid, targetTokenUuid: far.uuid },
        { user: game.user, id: 'far' }
      ),
    /within 10/
  );
  const target = token(w, w.makeActor('Third'), 5);
  const redirected = await redirectProjectile(
    { messageUuid: offer.uuid, targetTokenUuid: target.uuid },
    { user: game.user, id: 'redirect' }
  );
  await target.actor.update({ 'system.skills.dodge': 0 });
  await w.defend(redirected, { manualDice: '2' });
  assert(target.actor.system.conditions.includes('staggered'));
  assert.equal(target.actor.system.hp.value, 25);
  assert(!w.damageFor(redirected));
  await assert.rejects(
    () =>
      redirectProjectile(
        { messageUuid: offer.uuid, targetTokenUuid: target.uuid },
        { user: game.user, id: 'again' }
      ),
    /already/
  );
  const tie = await projectile(w, 12);
  await w.defend(tie, { defense: 'parry', weapon: sword.id, manualDice: '8' });
  assert.equal(w.messages.filter((m) => m.flags?.[S]?.kind === 'deflection').length, 1);
});

test('Deflection Parry Arrows uses DEX and rank with -1; Perun and Placation change actual adrenaline costs', async (t) => {
  const w = await workflow(t),
    sword = await w.importItem(w.target, 'Arming Sword', { equipped: true });
  await attach(sword, 'Runeword: Deflection');
  await w.target.update({ 'system.professionRanks.parryArrows': 5 });
  w.start();
  const a = await projectile(w, 10);
  await w.defend(a, { defense: 'parry', weapon: sword.id, manualDice: '8' });
  const call = w.target.skillCalls.at(-1);
  assert.equal(call.key, 'parryArrows');
  assert.equal(call.options.stat, 'dex');
  assert.equal(call.options.modifier, -1);
  const own = await w.importItem(w.attacker, 'Arming Sword', { equipped: true }),
    carried = await w.importItem(w.attacker, 'Arming Sword');
  await attach(own, 'Perun', { improved: true });
  await attach(carried, 'Runeword: Placation');
  game.settings.get = (scope, key) => (key === 'adrenaline' ? true : 'publicroll');
  await w.attacker.update({
    'system.effects': [alchemyEffect(ALCHEMY_PROFILES['maribor-forest'], { id: 'maribor', now: 0 })],
  });
  await gainAdrenaline(w.attacker, 'critical', { critical: true, weapon: own });
  assert.equal(adrenalineState(w.attacker).dice, 3);
  const Base = Roll;
  globalThis.Roll = class extends Base {
    async evaluate() {
      await super.evaluate();
      this.dice = [
        {
          results: [
            { result: 1, active: true },
            { result: 4, active: true },
          ],
        },
      ];
      return this;
    }
  };
  w.enqueue(['2d6', 5]);
  await executeAdrenalineHP({ actorUuid: w.attacker.uuid, count: 2 }, { user: game.user });
  assert.equal(w.attacker.system.sta.value, 15);
  assert.equal(adrenalineState(w.attacker).dice, 2);
});

test('kill confirmation commits Rejuvenation and eligible potion bonuses together, preserves rollback and rejects another player', async (t) => {
  const w = await workflow(t),
    sword = await w.importItem(w.attacker, 'Arming Sword', { equipped: true });
  const { offerAlchemyKill, resolveAlchemyKill } = await import('../../module/witcher/alchemy-combat.js');
  const { activeAlchemy } = await import('../../module/witcher/alchemy-rules.js');
  await attach(sword, 'Runeword: Rejuvenation');
  await w.attacker.update({
    'system.effects': ['blizzard', 'grave-hag-decoction'].map((key) =>
      alchemyEffect(ALCHEMY_PROFILES[key], { id: key, now: 0 })
    ),
  });
  w.start();
  await hit(w, sword);
  await w.attacker.update({ 'system.sta.value': 5 });
  await w.target.setCondition('dead');
  await offerAlchemyKill(w.target);
  const card = w.messages.find((m) => m.flags?.[S]?.kind === 'alchemyKill');
  assert(card);
  assert.equal(w.attacker.system.sta.value, 5);
  await assert.rejects(() => resolveAlchemyKill(card, game.users.get('player')), /GM/);
  w.faults.update = (doc) => doc.uuid === card.uuid;
  await assert.rejects(() => resolveAlchemyKill(card, game.user), /Injected/);
  assert.equal(w.attacker.system.sta.value, 5);
  assert.equal(activeAlchemy(w.attacker.system, 'grave-hag-decoction').alchemy.kills, 0);
  w.faults.update = null;
  await resolveAlchemyKill(card, game.user);
  assert.equal(w.attacker.system.sta.value, 10);
  assert.equal(activeAlchemy(w.attacker.system, 'grave-hag-decoction').alchemy.kills, 1);
  assert.equal(activeAlchemy(w.attacker.system, 'blizzard').modifiers.ref, 4);
  await resolveAlchemyKill(card, game.user);
  assert.equal(w.attacker.system.sta.value, 10);
});
