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
import { WOUNDS } from '../../module/witcher/wounds.js';
import { woundItemData } from '../../module/witcher/wound-catalog.js';

import { workflow, row, clone } from './workflow-fixture.mjs';

test('injured-arm attack and weapon-defense penalties use the selected limb and end on healing', async (t) => {
  const w = await workflow(t),
    sword = await w.importItem(w.attacker, 'Arming Sword', { equipped: true }),
    guard = await w.importItem(w.target, 'Arming Sword', { equipped: true });
  const add = async (actor) =>
    (
      await actor.createEmbeddedDocuments('Item', [
        woundItemData({ ...WOUNDS.complex[1], severity: 'complex', location: 'rightArm' }),
      ])
    )[0];
  const injury = await add(w.attacker);
  await add(w.target);
  w.start();
  const first = await w.attack(sword, { woundArm: 'rightArm', manualDice: '2' });
  assert.equal(first.flags[SYSTEM_ID].check.base, 6); // REF5 + Sword5 - WA1 - arm3.
  const defense = await w.defend(first, {
    defense: 'blockWeapon',
    weapon: guard.id,
    woundArm: 'rightArm',
    manualDice: '8',
  });
  assert.equal(defense.flags[SYSTEM_ID].check.base, 7); // No weapon WA on defense.
  const second = await w.attack(sword, { woundArm: 'leftArm', manualDice: '2' });
  assert.equal(second.flags[SYSTEM_ID].check.base, 9);
  await injury.update({ 'system.wound.treatment': 'healed' });
  game.combat.round++;
  const third = await w.attack(sword, { woundArm: 'rightArm', manualDice: '2' });
  assert.equal(third.flags[SYSTEM_ID].check.base, 9);
  assert.equal(w.rolls.length, 0);
});

test('disabled-arm selection rejects before spending while the sound arm can still wield one weapon', async (t) => {
  const w = await workflow(t),
    sword = await w.importItem(w.attacker, 'Arming Sword', { equipped: true });
  await w.attacker.createEmbeddedDocuments('Item', [
    woundItemData({ ...WOUNDS.deadly[1], severity: 'deadly', location: 'rightArm', treatment: 'healed' }),
  ]);
  w.start();
  const before = clone(w.attacker._source);
  await assert.rejects(() => w.attack(sword, { woundArm: 'rightArm', manualDice: '2' }), /injured arm/);
  await assert.rejects(() => w.attack(sword, { woundArm: 'inventedArm', manualDice: '2' }), /Choose the arm/);
  assert.deepEqual(w.attacker._source, before);
  const result = await w.attack(sword, { woundArm: 'leftArm', manualDice: '2' });
  assert.equal(result.flags[SYSTEM_ID].check.base, 9);
});

test('real skill totals include eye injury only for sight and retain the healed permanent penalty', async (t) => {
  const w = await workflow(t);
  const [eye] = await w.attacker.createEmbeddedDocuments('Item', [
    woundItemData({ ...WOUNDS.deadly[4], severity: 'deadly', location: 'head' }),
  ]);
  assert.equal(w.attacker.skillBase('awareness', { sight: true }).total, 5);
  assert.equal(w.attacker.skillBase('awareness', { sight: false }).total, 10);
  await eye.update({ 'system.wound.treatment': 'healed' });
  assert.equal(w.attacker.skillBase('awareness', { sight: true }).total, 9);
  assert.equal(w.attacker.skillBase('awareness', { sight: false }).total, 10);
});

test('manual attacks preserve Luck, modifiers, paid fast strikes and persisted dice provenance', async (t) => {
  const w = await workflow(t),
    sword = await w.importItem(w.attacker, 'Arming Sword', { equipped: true });
  w.start();
  const first = await w.attack(sword, { manualDice: '7', extra: true, luck: 1, modifier: 2 });
  const a = first.flags[SYSTEM_ID];
  assert.equal(a.check.base, 9); // REF 5 + skill 5 - WA 1 - extra 3 + modifier 2 + Luck 1
  assert.equal(a.check.total, 16);
  assert.equal(a.check.source, 'manual');
  assert.deepEqual(a.check.dice, [7]);
  assert.deepEqual(first.rolls, []);
  assert.match(first.content, /manual entry/);
  assert.equal(w.attacker.system.sta.value, 22);
  assert.equal(w.attacker.system.luck.value, 4);
  const second = await w.attack(sword, { manualDice: '10,10,4' });
  assert.equal(second.flags[SYSTEM_ID].check.total, 30);
  assert.deepEqual(second.flags[SYSTEM_ID].check.dice, [10, 10, 4]);
  assert.equal(w.attacker.system.combat.remaining, 0);
  assert.equal(w.attacker.system.sta.value, 22);
});

for (const defense of ['dodge', 'reposition', 'blockWeapon', 'blockShield', 'parry']) {
  test(`manual ${defense} preserves normal defense resolution and STA expenditure`, async (t) => {
    const w = await workflow(t),
      sword = await w.importItem(w.attacker, 'Arming Sword', { equipped: true });
    const guard = ['blockWeapon', 'parry'].includes(defense)
      ? await w.importItem(w.target, 'Arming Sword', { equipped: true })
      : defense === 'blockShield'
        ? await w.importItem(w.target, 'Leather Shield', { equipped: true })
        : null;
    w.start();
    for (let i = 0; i < 2; i++) {
      const attack = await w.attack(sword, { manualDice: '2' });
      const response = await w.defend(attack, {
        defense,
        weapon: guard?.id ?? '',
        manualDice: '8',
        luck: 1,
      });
      assert.equal(response.flags[SYSTEM_ID].check.source, 'manual');
      assert.deepEqual(response.flags[SYSTEM_ID].check.dice, [8]);
      assert.match(response.content, /manual entry/);
      assert.equal(attack.flags[SYSTEM_ID].resolved, true);
      assert.equal(w.damageFor(attack), undefined);
      assert.equal(w.target.system.sta.value, 25 - i);
      assert.equal(w.target.system.luck.value, 4 - i);
    }
    assert.equal(w.notices.length, 0);
  });
}

test('manual attack/defense still roll damage automatically and apply HP and armor wear once', async (t) => {
  const w = await workflow(t),
    sword = await w.importItem(w.attacker, 'Arming Sword', { equipped: true });
  const armor = await w.importItem(w.target, 'Gambeson', { equipped: true });
  w.start();
  const attack = await w.attack(sword, { manualDice: '8' });
  w.enqueue(['2d6+4', 12]);
  await w.defend(attack, { manualDice: '4' });
  const damage = w.damageFor(attack);
  assert(damage, w.notices.join('; '));
  assert.equal(damage.flags[SYSTEM_ID].summary[0].damage, 9);
  assert.equal(damage.rolls[0].formula, '2d6+4');
  await w.apply(damage);
  await assert.rejects(() => w.apply(damage), /already been applied/);
  assert.equal(w.target.system.hp.value, 16);
  assert.equal(armor.system.sp.torso, 2);
  assert.equal(w.rolls.length, 0);
});

test('attack, quick defense and full defense dialogs submit their manual dice to real commands', async (t) => {
  const w = await workflow(t),
    sword = await w.importItem(w.attacker, 'Arming Sword', { equipped: true });
  const { attack, defend } = await import('../../module/witcher/combat.js');
  const names = ['Dialog', 'FormData'];
  const previous = new Map(names.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  t.after(() => {
    for (const [name, descriptor] of previous)
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
  });
  let dialog, values;
  const form = { reportValidity: () => true, querySelectorAll: () => [] };
  globalThis.FormData = class {
    constructor() {
      return Object.entries(values);
    }
  };
  globalThis.Dialog = class {
    constructor(data) {
      this.data = data;
      this.element = [{ querySelector: () => form }];
      dialog = this;
    }
    render() {
      return this;
    }
    submit(button) {
      button.callback(this.element);
      this.data.close();
    }
  };
  w.start();
  for (const quick of [{ defense: 'dodge' }, {}]) {
    values = {
      action: 'normal',
      style: 'fast',
      location: 'torso',
      type: 'slashing',
      modifier: '0',
      luck: '0',
      cover: '0',
      manualDice: '7',
    };
    const pendingAttack = attack(w.attacker, sword, { target: w.target });
    assert.match(dialog.data.content, /name="manualDice"/);
    await dialog.submit(dialog.data.buttons.submit);
    const message = await pendingAttack;
    assert.deepEqual(message.flags[SYSTEM_ID].check.dice, [7]);

    values = {
      defense: quick.defense ?? 'reposition',
      weapon: '',
      modifier: '0',
      gang: '1',
      luck: '0',
      dc: '10',
      manualDice: '10,6',
    };
    const pendingDefense = defend(message, quick);
    await new Promise(setImmediate); // defend first resolves the owning Actor UUID.
    assert.match(dialog.data.content, /name="manualDice"/);
    await dialog.submit(dialog.data.buttons.submit);
    const response = await pendingDefense;
    assert.deepEqual(response.flags[SYSTEM_ID].check.dice, [10, 6]);
    assert.equal(response.flags[SYSTEM_ID].check.source, 'manual');
    assert.equal(message.flags[SYSTEM_ID].resolved, true);
  }
  assert.equal(w.notices.length, 0);
});

test('manual fumbles retain pending consequences and duplicate-defense protection', async (t) => {
  const w = await workflow(t),
    sword = await w.importItem(w.attacker, 'Arming Sword', { equipped: true });
  w.start();
  const attack = await w.attack(sword, { manualDice: '1,10,4' });
  assert.equal(attack.flags[SYSTEM_ID].check.total, 0);
  assert.equal(attack.flags[SYSTEM_ID].check.fumble, 14);
  const defense = await w.defend(attack, { manualDice: '1,6' });
  assert.equal(defense.flags[SYSTEM_ID].check.total, 4);
  assert.equal(defense.flags[SYSTEM_ID].check.fumble, 6);
  assert.equal(attack.flags[SYSTEM_ID].resolved, false);
  await assert.rejects(() => runCommand('resolveDefense', { messageUuid: defense.uuid }), /pending fumble/);
  await assert.rejects(() => w.defend(attack, { manualDice: '9' }), /already has a defense/);
  assert.equal(w.target.system.combat.defenses, 1);
});

test('invalid manual attacks cannot spend ammunition, Luck, STA or attack slots', async (t) => {
  const w = await workflow(t),
    bow = await w.importItem(w.attacker, 'Short Bow', { equipped: true });
  const ammo = await w.importItem(w.attacker, 'Standard Ammunition');
  await bow.update({ 'system.ammoId': ammo.id });
  w.start();
  const before = clone(w.attacker._source);
  const items = w.attacker.items.map((item) => item.toObject());
  const messages = w.messages.size;
  for (const manualDice of ['10', '1,10', '8,2', '11', '10,,5']) {
    await assert.rejects(
      () => w.attack(bow, { manualDice, extra: true, luck: 2, distance: 8 }),
      /d10|follow-up/
    );
    assert.deepEqual(w.attacker._source, before);
    assert.deepEqual(
      w.attacker.items.map((item) => item.toObject()),
      items
    );
    assert.equal(w.messages.size, messages);
  }
  const quantity = ammo.system.quantity;
  const attack = await w.attack(bow, { manualDice: '7', extra: true, luck: 2, distance: 8 });
  assert.equal(attack.flags[SYSTEM_ID].check.source, 'manual');
  assert.equal(ammo.system.quantity, quantity - 1);
  assert.equal(w.attacker.system.sta.value, 22);
  assert.equal(w.attacker.system.luck.value, 3);
});

test('invalid manual defenses leave resources and attack availability intact; Passive DC rejects dice', async (t) => {
  const w = await workflow(t),
    sword = await w.importItem(w.attacker, 'Arming Sword', { equipped: true });
  w.start();
  const attack = await w.attack(sword, { manualDice: '2', modifier: -5 });
  const before = clone(w.target._source),
    messages = w.messages.size;
  for (const values of [
    { manualDice: '1' },
    { manualDice: '10,3,2' },
    { defense: 'passive', manualDice: '7' },
  ]) {
    await assert.rejects(() => w.defend(attack, values));
    assert.deepEqual(w.target._source, before);
    assert.equal(attack.flags[SYSTEM_ID].defenseRef, undefined);
    assert.equal(w.messages.size, messages);
  }
  const response = await w.defend(attack, { defense: 'passive', manualDice: '' });
  assert.equal(response.flags[SYSTEM_ID].check.source, 'passive');
  assert.equal(response.flags[SYSTEM_ID].check.total, 10);
  assert.doesNotMatch(response.content, /manual entry/);
  assert.equal(attack.flags[SYSTEM_ID].resolved, true);
});

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

test('real actor pre-update preserves positive-HP Heart saves and resets only the death state being left', async (t) => {
  const w = await workflow(t, { separatePrepared: true });
  await w.target.update({ 'system.deathSaves': 2, 'system.pendingDeathSaves': 1 });
  await w.target.update({ 'system.hp.value': 20 });
  assert.equal(w.target._source.system.pendingDeathSaves, 1);
  assert.equal(w.target._source.system.deathSaves, 2);
  await w.target.update({ 'system.hp.value': 15, 'system.pendingDeathSaves': 2 });
  assert.equal(w.target._source.system.pendingDeathSaves, 2);
  await w.target.update({ 'system.hp.value': -1 });
  await w.target.update({ 'system.hp.value': 1 });
  assert.equal(w.target._source.system.pendingDeathSaves, 0);
  assert.equal(w.target._source.system.deathSaves, 0);
  await w.target.update({ 'system.hp.value': -1, 'system.deathSaves': 4, 'system.pendingDeathSaves': 3 });
  await w.target.update({ 'system.hp.value': 1, 'system.pendingDeathSaves': 1 });
  assert.equal(w.target._source.system.pendingDeathSaves, 1);
  assert.equal(w.target._source.system.deathSaves, 0);
});

test('prepared STA is capped independently from stored STA and a treatment ceiling increase restores no points', async (t) => {
  const w = await workflow(t, { separatePrepared: true });
  const { woundItemData } = await import('../../module/witcher/wound-catalog.js');
  const { actorSnapshot, staminaCapChanges } = await import('../../module/witcher/documents.js');
  const { actionPlan } = await import('../../module/witcher/runtime.js');
  const [injury] = await w.target.createEmbeddedDocuments('Item', [
    woundItemData({ key: 'deadly-2', location: 'torso' }),
  ]);
  assert.equal(w.target.system.sta.max, 6);
  assert.equal(w.target.system.sta.value, 6);
  assert.equal(
    w.target._source.system.sta.value,
    25,
    'Preparation alone must not pretend the source was persisted'
  );
  const plan = actionPlan(w.target, { extra: true });
  assert.equal(plan.changes['system.sta.value'], 3, 'Spending starts from the prepared cap');
  const state = actorSnapshot(w.target);
  const projected = state.items.map((item) => ({ ...item, wound: { ...item.wound, treatment: 'treated' } }));
  await w.target.update(staminaCapChanges(w.target, projected));
  await injury.update({ 'system.wound.treatment': 'treated' });
  assert.equal(w.target.system.sta.max, 20);
  assert.equal(w.target.system.sta.value, 6);
  assert.equal(w.target._source.system.sta.value, 6);
  await w.target.deleteEmbeddedDocuments('Item', [injury.id]);
  assert.equal(w.target.system.sta.max, 25);
  assert.equal(w.target.system.sta.value, 6);
});

test('a registered Heart Damage hit persists the STA cap and pending Death save while HP is still positive', async (t) => {
  const w = await workflow(t, { separatePrepared: true }),
    sword = await w.importItem(w.attacker, 'Arming Sword', { equipped: true });
  await w.target.update({ 'system.overrides.hp': 100, 'system.hp.value': 100 });
  w.start();
  w.enqueue(['1d10', 6], ['1d10', 4], ['2d6', 9], ['1d6', 6], ['1d6', 3], ['2d6+4', 12], ['1d10', 2]);
  const attack = await w.attack(sword, { modifier: 20 });
  await w.defend(attack);
  const damage = w.damageFor(attack);
  assert.equal(damage.flags[SYSTEM_ID].wound.name, 'Heart Damage');
  await w.apply(damage);
  assert(w.target.system.hp.value > 0);
  assert.equal(w.target._source.system.pendingDeathSaves, 1);
  assert.equal(w.target.system.pendingDeathSaves, 1);
  assert.equal(w.target._source.system.sta.value, 6);
  assert.equal(w.target.system.sta.max, 6);
  assert.equal(w.target.system.sta.value, 6);
  assert(w.messages.some((message) => message.flags[SYSTEM_ID]?.deathFor === damage.uuid));
  assert.equal(w.rolls.length, 0);
});
