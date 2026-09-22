import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import Handlebars from 'handlebars';
import { workflow } from './workflow-fixture.mjs';
import { SYSTEM_ID as S } from '../../module/witcher/config.js';
import { runCommand } from '../../module/witcher/authority.js';

async function setup(t, { creature = false, aim = '', style = 'fast' } = {}) {
  const w = await workflow(t, { creature });
  const manual = await import('../../module/witcher/manual-combat.js');
  const sword = await w.importItem(w.attacker, 'Arming Sword', { equipped: true });
  await w.attacker.update({ 'system.manualCombat': true });
  w.start();
  const defaultAttack = () => w.attack(sword, { manualDice: '8', location: aim, style });
  const submit = (card, values, extra = {}) =>
    runCommand('manualDamage', {
      messageUuid: card.uuid,
      revision: card.flags[S].manualDamage.revision,
      values,
      ...extra,
    });
  const hit = async () => {
    const a = await defaultAttack();
    w.enqueue(['1d10', 4]);
    await w.defend(a);
    assert(a.flags[S].manualDamage, w.notices.join('\n'));
    return a;
  };
  return { ...w, manual, sword, defaultAttack, submit, hit };
}

test('manual damage arithmetic validates individual dice, fixed terms and ranges without rolling', async (t) => {
  const {
    manual: { manualFormulaResult: f },
  } = await setup(t);
  assert.equal(f('2d6+4', '3,5').total, 12);
  assert.equal(f('(2d6 + 1d4 - 2) * 2', '1,6,4').total, 18);
  assert.equal(f('1d6/2', '5').total, 2.5);
  assert.equal(f('0d6').total, 0);
  assert.equal(f('4').total, 4);
  for (const [formula, value] of [
    ['2d6+4', '8'],
    ['2d6', '7,1'],
    ['1d10', '0'],
    ['1d10', '11'],
    ['1d6', '3,'],
    ['1d6', '3.5'],
    ['1d6', '-2'],
    ['1d6', ''],
    ['1d6', '1e0'],
    ['2d6', '3,,5'],
    ['4', '4'],
    ['1d6/0', '1'],
    ['1d6kh1', '2'],
    ['2**4', ''],
    ['101d6', '1'],
  ])
    assert.throws(() => f(formula, value), undefined, formula + ' ' + value);
});

test('per-actor mode requires physical attack dice before spending and keeps complete exploding chains', async (t) => {
  const w = await setup(t),
    before = structuredClone(w.attacker._source);
  await assert.rejects(
    () => w.attack(w.sword, { manualDice: '', extra: true, luck: 1 }),
    /physical combat dice/
  );
  assert.deepEqual(w.attacker._source, before);
  await assert.rejects(
    () => w.attack(w.sword, { manualDice: '10' }),
    /follow|chain|additional|complete|end/i
  );
  const a = await w.attack(w.sword, { manualDice: '10,10,4' });
  assert.equal(a.flags[S].manualCombat, true);
  assert.equal(a.flags[S].check.source, 'manual');
  assert.deepEqual(a.flags[S].check.dice, [10, 10, 4]);
});

test('manual PC versus automatic NPC records actual location and damage, armor and HP once', async (t) => {
  const w = await setup(t),
    armor = await w.importItem(w.target, 'Gambeson');
  await armor.update({ 'system.equipped': true });
  const a = await w.hit();
  assert.equal(a.flags[S].manualDamage.request.kind, 'location');
  assert(!w.damageFor(a));
  const paid = structuredClone(w.attacker._source);
  await w.submit(a, { dice: '3' });
  assert.equal(a.flags[S].manualDamage.request.formula, '2d6+4');
  await w.submit(a, { dice: '3,5' });
  const d = w.damageFor(a);
  assert.equal(d.flags[S].request[0].location, 'torso');
  assert.equal(d.flags[S].request[0].raw, 12);
  assert.equal(d.rolls.length, 0);
  assert.match(d.content, /Physical combat dice/);
  assert.match(d.content, /3,5/);
  await w.apply(d);
  assert.equal(w.target.system.hp.value, 16);
  assert.equal(armor.system.sp.torso, 2);
  assert.deepEqual(w.attacker._source, paid);
  await assert.rejects(() => w.submit(a, { dice: '6,6' }), /already/);
  await assert.rejects(() => w.apply(d), /already/);
  assert.equal(w.target.system.hp.value, 16);
});

test('recorded head result has no aiming penalty and damage uses head multiplier', async (t) => {
  const w = await setup(t),
    a = await w.hit();
  assert.equal(a.flags[S].check.base, 10);
  await w.submit(a, { location: 'head' });
  await w.submit(a, { dice: '1,1' });
  const d = w.damageFor(a);
  assert.equal(d.flags[S].request[0].raw, 6);
  assert.equal(d.flags[S].summary[0].damage, 18);
  assert.equal(a.flags[S].aimed, '');
  await w.apply(d);
  assert.equal(w.target.system.hp.value, 7);
});

test('aimed attacks preserve the declared penalty and skip manual random location', async (t) => {
  const w = await setup(t, { aim: 'head' });
  const a = await w.attack(w.sword, { manualDice: '9', location: 'head', modifier: 5 });
  w.enqueue(['1d10', 2]);
  await w.defend(a);
  assert.equal(a.flags[S].check.base, 9);
  assert.equal(a.flags[S].manualDamage.request.key, 'damage-head');
  await w.submit(a, { dice: '1,1' });
  assert.equal(w.damageFor(a).flags[S].request[0].location, 'head');
});

test('strong attacks retain doubled raw damage and monster locations come from the actual anatomy', async (t) => {
  const w = await setup(t, { creature: true, style: 'strong' });
  const a = await w.attack(w.sword, { manualDice: '9', location: '', style: 'strong', modifier: 3 });
  w.enqueue(['1d10', 2]);
  await w.defend(a);
  assert(a.flags[S].manualDamage, w.notices.join('\n'));
  const locations = a.flags[S].manualDamage.request.locations;
  assert.deepEqual(
    locations.map((l) => l.id),
    w.target.system.locations.map((l) => l.id)
  );
  await assert.rejects(() => w.submit(a, { location: 'inventedWing' }), /anatomy/);
  const id = locations.find((l) => l.id !== 'head').id;
  await w.submit(a, { location: id });
  await w.submit(a, { dice: '2,2' });
  const d = w.damageFor(a);
  assert.equal(d.flags[S].request[0].multiplier, 2);
  assert.equal(d.flags[S].summary[0].rolled, 16);
});

for (const defense of ['dodge', 'reposition', 'parry', 'blockWeapon', 'blockShield'])
  test(`automatic attack versus manual ${defense} uses the defender’s selected skill`, async (t) => {
    const w = await setup(t);
    await w.attacker.update({ 'system.manualCombat': false });
    await w.target.update({ 'system.manualCombat': true });
    const guard = ['parry', 'blockWeapon'].includes(defense)
      ? await w.importItem(w.target, 'Arming Sword')
      : defense === 'blockShield'
        ? await w.importItem(w.target, 'Leather Shield')
        : null;
    if (guard) await guard.update({ 'system.equipped': true });
    w.enqueue(['1d10', 3]);
    const a = await w.attack(w.sword, { location: 'torso' });
    assert.equal(a.flags[S].check.source, 'automatic');
    const before = structuredClone(w.target._source);
    await assert.rejects(() => w.defend(a, { defense, weapon: guard?.id }), /physical combat dice/);
    assert.deepEqual(w.target._source, before);
    assert(!a.flags[S].defenseRef);
    const d = await w.defend(a, { defense, weapon: guard?.id, manualDice: '8' });
    assert.equal(d.flags[S].check.source, 'manual');
    const call = w.target.skillCalls.at(-1);
    assert.equal(
      call.key,
      defense === 'reposition'
        ? 'athletics'
        : defense === 'dodge'
          ? 'dodge'
          : defense === 'blockShield'
            ? 'melee'
            : 'swordsmanship'
    );
    assert(a.flags[S].resolved);
    assert(!a.flags[S].manualDamage);
  });

test('a successful defense creates no manual damage prompt; passive DC needs no physical d10', async (t) => {
  const w = await setup(t);
  await w.target.update({ 'system.manualCombat': true });
  const missed = await w.attack(w.sword, { manualDice: '2' });
  await w.defend(missed, { manualDice: '8' });
  assert(missed.flags[S].resolved);
  assert(!missed.flags[S].manualDamage);
  const a = await w.attack(w.sword, { manualDice: '4', location: 'torso' });
  await w.defend(a, { defense: 'passive', dc: 10 });
  assert(a.flags[S].manualDamage);
  assert.equal(a.flags[S].manualDamage.request.key, 'damage-torso');
});

test('invalid values and stale or unauthorized submissions preserve prior input and paid resources', async (t) => {
  const w = await setup(t),
    a = await w.hit();
  const revision = a.flags[S].manualDamage.revision;
  await assert.rejects(
    () =>
      w.manual.submitManualDamage(
        { messageUuid: a.uuid, revision, values: { dice: '3' } },
        { user: { id: 'stranger', isGM: false }, id: 'bad' }
      ),
    /own/
  );
  await w.submit(a, { location: 'torso' });
  const before = structuredClone(a.flags[S].manualDamage);
  await assert.rejects(() => w.submit(a, { dice: '3,5' }, { revision }), /changed/);
  for (const dice of ['7,1', '3', '3,5,2', '', undefined])
    await assert.rejects(() => w.submit(a, { dice }), /dice|between|exactly/);
  assert.deepEqual(a.flags[S].manualDamage, before);
  await w.manual.submitManualDamage(
    { messageUuid: a.uuid, revision: before.revision, values: { dice: '3,5' } },
    { user: game.users.get('player'), id: 'owned' }
  );
  assert(w.damageFor(a));
  assert.equal(a.flags[S].manualDamage.answers['damage-torso'].authorId, 'player');
});

test('mode and source bonuses are snapshotted; current armor is reviewed again without rerolling', async (t) => {
  const w = await setup(t),
    a = await w.hit();
  await w.attacker.update({
    'system.manualCombat': false,
    'system.effects': [{ id: 'bonus', key: 'Changed after hit', modifiers: { damage: 30 } }],
  });
  await w.submit(a, { location: 'torso' });
  await w.submit(a, { dice: '3,5' });
  const d = w.damageFor(a);
  assert.equal(d.flags[S].request[0].raw, 12);
  const armor = await w.importItem(w.target, 'Gambeson');
  await armor.update({ 'system.equipped': true });
  await w.apply(d);
  assert.equal(w.target.system.hp.value, 25);
  assert.equal(d.flags[S].summary[0].damage, 9);
  assert.match(d.content, /3,5/);
  await w.apply(d);
  assert.equal(w.target.system.hp.value, 16);
});

test('failed damage publication and final receipt resume saved dice without rerolling or double spending', async (t) => {
  const w = await setup(t),
    a = await w.hit();
  await w.submit(a, { location: 'torso' });
  const paid = structuredClone(w.attacker._source);
  w.faults.create = (data) => data.flags?.[S]?.kind === 'damage';
  await assert.rejects(() => w.submit(a, { dice: '3,5' }), /Injected/);
  assert.equal(a.flags[S].manualDamage.status, 'ready');
  assert.equal(a.flags[S].manualDamage.result.request[0].raw, 12);
  w.faults.create = null;
  w.faults.update = (doc, changes) => doc.uuid === a.uuid && changes[`flags.${S}.resolved`] === true;
  await assert.rejects(() => w.submit(a, undefined), /Injected/);
  assert(w.damageFor(a));
  w.faults.update = null;
  await w.submit(a, undefined);
  assert(a.flags[S].resolved);
  assert.equal(a.flags[S].manualDamage.status, 'complete');
  assert.doesNotMatch(a.content, /data-witcher-action="manualDamage"/);
  assert.equal(
    w.messages.filter((m) => m.flags?.[S]?.attackRef === a.uuid && m.flags[S].kind === 'damage').length,
    1
  );
  assert.deepEqual(w.attacker._source, paid);
});

test('critical hits use manual critical dice instead of a freely selected ordinary location', async (t) => {
  const w = await setup(t);
  const a = await w.attack(w.sword, { manualDice: '9', location: '', modifier: 5 });
  w.enqueue(['1d10', 3]);
  await w.defend(a);
  assert.equal(a.flags[S].manualDamage.request.key, 'critical-location');
  await assert.rejects(() => w.submit(a, { location: 'head' }), /dice/);
  await w.submit(a, { dice: '3,4' });
  if (a.flags[S].manualDamage.request.key === 'critical-side') await w.submit(a, { dice: '1' });
  assert.equal(a.flags[S].manualDamage.request.key, 'damage-torso');
  await w.submit(a, { dice: '1,1' });
  const d = w.damageFor(a);
  assert.equal(d.flags[S].wound.location, 'torso');
  assert(d.flags[S].criticalLevel);
  assert.equal(d.flags[S].request[0].criticalBonus, 5);
});

test('manual silver and adrenaline dice remain separate and are preserved in the result', async (t) => {
  const w = await setup(t);
  game.settings.get = (scope, key) => (key === 'adrenaline' ? true : 'publicroll');
  await w.sword.update({ 'system.properties.silverDamage': '1d6' });
  await w.target.update({ 'system.silverVulnerable': true });
  await w.attacker.update({ [`flags.${S}.adrenaline`]: { combatId: 'combat', dice: 1, receipts: [] } });
  const a = await w.attack(w.sword, { manualDice: '8', location: 'torso', adrenalineDice: 1 });
  w.enqueue(['1d10', 4]);
  await w.defend(a);
  assert.equal(a.flags[S].manualDamage.request.key, 'adrenaline');
  await w.submit(a, { dice: '3' });
  await w.submit(a, { dice: '2,2' });
  assert.equal(a.flags[S].manualDamage.request.key, 'silver-torso');
  await w.submit(a, { dice: '4' });
  const d = w.damageFor(a);
  assert.equal(d.flags[S].request[0].raw, 11);
  assert.equal(d.flags[S].request[0].silver, 4);
  assert.equal(w.attacker.system.sta.value, 15);
});

test('cancel and reopen keep saved location and dice; client continues through authoritative requests', async (t) => {
  const w = await setup(t),
    a = await w.hit();
  const paid = structuredClone(w.attacker._source);
  const seen = [];
  await w.manual.enterManualDamage(a, {
    ask: async (title, fields, options) => {
      seen.push(title);
      if (seen.length === 1) {
        assert.match(fields, /Location d10/);
        assert.throws(() => options.validate({ dice: '11' }));
        options.validate({ location: 'torso' });
        return { location: 'torso' };
      }
      assert.match(fields, /2d6\+4/);
      return null;
    },
  });
  assert.equal(seen.length, 2);
  assert.equal(a.flags[S].manualDamage.request.key, 'damage-torso');
  assert.equal(a.flags[S].manualDamage.answers.location.location, 'torso');
  assert(!w.damageFor(a));
  await w.manual.enterManualDamage(a, {
    ask: async (title, fields, options) => {
      assert.match(title, /Weapon damage: Torso/);
      options.validate({ dice: '3,5' });
      return { dice: '3,5' };
    },
  });
  assert(w.damageFor(a));
  assert.equal(a.flags[S].manualDamage.status, 'complete');
  assert.doesNotMatch(a.content, /data-witcher-action="manualDamage"/);
  assert.deepEqual(w.attacker._source, paid);
});

test('failure before persisting an answer leaves the same input available', async (t) => {
  const w = await setup(t),
    a = await w.hit();
  const before = structuredClone(a.flags[S].manualDamage);
  w.faults.update = (doc, patch) => doc === a && !!patch[`flags.${S}.manualDamage`];
  await assert.rejects(() => w.submit(a, { location: 'torso' }), /Injected/);
  assert.deepEqual(a.flags[S].manualDamage, before);
  w.faults.update = null;
  await w.submit(a, { location: 'torso' });
  assert.equal(a.flags[S].manualDamage.request.key, 'damage-torso');
});

test('custom anatomy rerolls missing critical groups while retaining the recorded dice', async (t) => {
  const w = await setup(t);
  await w.target.update({
    'system.anatomy': 'custom',
    'system.locations': [
      { id: 'body', label: 'Body', group: 'torso', min: 1, max: 10, aim: -1, multiplier: 1 },
    ],
  });
  const a = await w.attack(w.sword, { manualDice: '9', location: '', modifier: 5 });
  w.enqueue(['1d10', 3]);
  await w.defend(a);
  await w.submit(a, { dice: '1,1' });
  assert.equal(a.flags[S].manualDamage.request.key, 'critical-reroll-1');
  assert.equal(a.flags[S].manualDamage.history[0].dice, '1,1');
  await w.submit(a, { dice: '3,4' });
  assert.equal(a.flags[S].manualDamage.request.key, 'damage-body');
  await w.submit(a, { dice: '2,2' });
  assert.equal(w.damageFor(a).flags[S].wound.location, 'body');
  assert.match(w.damageFor(a).content, /1,1/);
  assert.match(w.damageFor(a).content, /3,4/);
});

test('Griffin critical choice is made by the owner after recording both results', async (t) => {
  const w = await setup(t);
  await w.attacker.createEmbeddedDocuments('Item', [
    {
      name: 'Griffin trophy',
      type: 'gear',
      system: { equipped: true, carried: true, quantity: 1 },
      flags: {
        [S]: {
          ritualArtifact: {
            key: 'imbue-trophy',
            species: 'griffin',
            activeActorUuid: w.attacker.uuid,
            helpedKillActorUuids: [w.attacker.uuid],
          },
        },
      },
    },
  ]);
  const a = await w.attack(w.sword, { manualDice: '9', location: '', modifier: 5 });
  w.enqueue(['1d10', 3]);
  await w.defend(a);
  await w.submit(a, { dice: '3,4' });
  assert.equal(a.flags[S].manualDamage.request.key, 'critical-alternative-location');
  await w.submit(a, { dice: '5,5' });
  assert.equal(a.flags[S].manualDamage.request.kind, 'choice');
  await assert.rejects(() => w.submit(a, { choice: '2' }), /Invalid/);
  await w.submit(a, { choice: '1' });
  await w.submit(a, { dice: '1,1' });
  assert.equal(w.damageFor(a).flags[S].wound.name, 'Ruptured Spleen');
});

test('manual weapon effects ask for a validated percentile die after damage', async (t) => {
  const w = await setup(t);
  await w.sword.update({ 'system.properties.bleeding': 30 });
  const a = await w.hit();
  await w.submit(a, { location: 'torso' });
  await w.submit(a, { dice: '2,2' });
  assert.equal(a.flags[S].manualDamage.request.key, 'effect-bleeding');
  await assert.rejects(() => w.submit(a, { dice: '101' }), /between/);
  await w.submit(a, { dice: '25' });
  const d = w.damageFor(a);
  assert(d.flags[S].conditions.includes('bleeding'));
  assert.equal(d.rolls.length, 0);
});

test('natural attacks from the bestiary honor the Actor toggle and retain printed damage', async (t) => {
  const w = await workflow(t, { attackerName: 'Griffin' });
  const manual = await import('../../module/witcher/manual-combat.js');
  await w.attacker.update({ 'system.manualCombat': true });
  const claws = w.attacker.items.find((i) => i.name === 'Claws');
  const base = w.attacker.skillBase(claws.system.skill, { stat: claws.system.stat }).total;
  w.start();
  const a = await w.attack(claws, { style: 'normal', manualDice: '6', modifier: 10 - base });
  w.enqueue(['1d10', 4]);
  await w.defend(a);
  assert.equal(a.flags[S].manualDamage.request.formula, claws.system.damage);
  const count = manual.manualFormula(claws.system.damage).count;
  await runCommand('manualDamage', {
    messageUuid: a.uuid,
    revision: 0,
    values: { dice: Array(count).fill(2).join(',') },
  });
  const d = w.damageFor(a);
  assert.equal(
    d.flags[S].request[0].raw,
    manual.manualFormulaResult(claws.system.damage, Array(count).fill(2).join(',')).total
  );
  assert.equal(w.attacker.system.combat.remaining, 1);
});

test('the real sheet saves its checkbox and renders the persisted mode', async (t) => {
  const w = await setup(t);
  foundry.appv1 = { sheets: { ActorSheet: class {}, ItemSheet: class {} } };
  const { WitcherActorSheet } = await import('../../module/witcher/sheets.js');
  const sheet = new WitcherActorSheet();
  sheet.actor = w.attacker;
  const update = w.attacker.update.bind(w.attacker);
  w.attacker.update = (changes) => update({ 'system.manualCombat': changes.system.manualCombat });
  Handlebars.registerHelper('checked', (value) => (value ? 'checked' : ''));
  Handlebars.registerHelper('selectOptions', () => '');
  const render = Handlebars.compile(
    fs.readFileSync(new URL('../../templates/witcher/actor.hbs', import.meta.url), 'utf8')
  );
  for (const enabled of [false, true, false]) {
    await sheet._updateObject(null, { 'system.manualCombat': enabled });
    assert.equal(w.attacker.system.manualCombat, enabled);
    const html = render({ actor: w.attacker, system: w.attacker.system });
    const checkbox = html.match(/<input[^>]*name=['"]system.manualCombat['"][^>]*>/)?.[0];
    assert(checkbox);
    assert.equal(checkbox.includes('checked'), enabled);
  }
});
