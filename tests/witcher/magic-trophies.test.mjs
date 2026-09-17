import test from 'node:test';
import assert from 'node:assert/strict';
import { SYSTEM_ID } from '../../module/witcher/config.js';
import {
  magicCastingRules,
  magicAttackRules,
  magicDamageRules,
  magicIgnitionChance,
  magicConditionRules,
} from '../../module/witcher/magic-effect-hooks.js';
import { trophyRulesFor } from '../../module/witcher/magic-trophies.js';
import { resolveDamage } from '../../module/witcher/rules.js';
import { workflow } from './workflow-fixture.mjs';
const bearer = (species) => ({
  uuid: 'Actor.hunter',
  effects: [],
  items: [
    {
      id: 'trophy',
      type: 'gear',
      quantity: 1,
      carried: true,
      equipped: true,
      flags: {
        [SYSTEM_ID]: {
          ritualArtifact: {
            key: 'imbue-trophy',
            species,
            activeActorUuid: 'Actor.hunter',
            helpedKillActorUuids: ['Actor.hunter'],
            resistance: 'piercing',
          },
        },
      },
    },
  ],
});
test('actual worn trophy and kill participation gate immunity; stale effect labels grant nothing', () => {
  const state = bearer('golem');
  assert.equal(magicConditionRules(state, 'bleeding').immune, true);
  state.items[0].equipped = false;
  assert.equal(magicConditionRules(state, 'bleeding').immune, false);
  state.items[0].equipped = true;
  state.items[0].flags[SYSTEM_ID].ritualArtifact.helpedKillActorUuids = [];
  assert.equal(magicConditionRules(state, 'bleeding').immune, false);
});
test('elemental casting bonus only applies to matching spells or Signs; non-matching cast remains ordinary', () => {
  const state = bearer('slyzard');
  assert.equal(magicCastingRules(state, { kind: 'spell', element: 'fire' }).bonus, 2);
  for (const context of [
    { kind: 'invocation', element: 'fire' },
    { kind: 'spell', element: 'water' },
    { kind: 'spell' },
  ])
    assert.equal(magicCastingRules(state, context).bonus, 0);
});
test('trophy ignition reduction, chosen resistance and armor wear are consumed by shared combat rules', () => {
  assert.equal(magicIgnitionChance(bearer('phoenix'), 75).chance, 25);
  assert.equal(magicIgnitionChance(bearer('phoenix'), 25).chance, 0);
  assert.equal(magicDamageRules(bearer('frightener'), { damageType: 'piercing' }).resistant, true);
  assert.equal(magicDamageRules(bearer('frightener'), { damageType: 'slashing' }).resistant, false);
  assert.equal(magicAttackRules(bearer('earth-elemental')).ablationMultiplier, 2);
  assert.equal(trophyRulesFor(bearer('katakan'), { hit: true, hpDamage: 0 }).attackEffects.length, 0);
  assert.equal(trophyRulesFor(bearer('katakan'), { hit: true, hpDamage: 1 }).attackEffects[0].chance, 25);
});
test('Hym deals exactly four through blocking armor, without wearing it or bypassing Quen or immunity', () => {
  const target = { race: 'human', effects: [], traits: {}, immunities: [] };
  const location = { id: 'head', group: 'head', multiplier: 3, sp: 20 };
  const attack = { raw: 5, type: 'slashing', properties: { armorNegatedDamage: 4 } };
  const result = resolveDamage(attack, target, location, []);
  assert.equal(result.damage, 4);
  assert.equal(result.penetrated, false);
  assert.equal(result.naturalChange.after, 20);
  assert.equal(resolveDamage(attack, { ...target, immunities: ['slashing'] }, location, []).damage, 0);
  assert.equal(
    resolveDamage(
      attack,
      { ...target, effects: [{ id: 'quen', shieldHP: 10, magic: { key: 'quen' } }] },
      location,
      []
    ).damage,
    0
  );
});

test('a real worn Griffin trophy offers both rolled injuries and applies the chosen wound through ordinary combat', async (t) => {
  const w = await workflow(t),
    sword = await w.importItem(w.attacker, 'Arming Sword', { equipped: true });
  await w.attacker.createEmbeddedDocuments('Item', [
    {
      name: 'Imbued Griffin trophy',
      type: 'gear',
      flags: {
        [SYSTEM_ID]: {
          ritualArtifact: {
            key: 'imbue-trophy',
            species: 'griffin',
            activeActorUuid: w.attacker.uuid,
            helpedKillActorUuids: [w.attacker.uuid],
          },
        },
      },
      system: { equipped: true, carried: true, quantity: 1 },
    },
  ]);
  // A genuine Foundry TypeDataModel exposes its owning document through parent.
  Object.defineProperty(w.attacker.system, 'parent', { value: w.attacker });
  const previousDialog = globalThis.Dialog,
    previousFormData = globalThis.FormData;
  t.after(() => {
    if (previousDialog) globalThis.Dialog = previousDialog;
    else delete globalThis.Dialog;
    globalThis.FormData = previousFormData;
  });
  const dialogs = [];
  globalThis.FormData = class {
    *[Symbol.iterator]() {
      yield ['critical', '1'];
    }
  };
  globalThis.Dialog = class {
    constructor(data) {
      this.data = data;
    }
    render() {
      dialogs.push(this.data);
      this.data.buttons.submit.callback({
        querySelector: () => ({ reportValidity: () => true, querySelectorAll: () => [] }),
      });
    }
  };
  w.start();
  const attack = await w.attack(sword, { manualDice: '9', modifier: 1 });
  w.enqueue(['2d6', 7], ['1d6', 2], ['1d6', 1], ['1d6', 6], [sword.system.damage, 4]);
  await w.defend(attack, { manualDice: '2' });
  assert.equal(dialogs.length, 1);
  assert.match(dialogs[0].content, /Foreign Object/);
  assert.match(dialogs[0].content, /Cracked Ribs/);
  const damage = w.damageFor(attack);
  assert.equal(damage.flags[SYSTEM_ID].wound.name, 'Cracked Ribs');
  w.enqueue(['1d10', 2]);
  await w.apply(damage);
  assert.equal(w.target.items.find((item) => item.type === 'wound').system.wound.name, 'Cracked Ribs');
  assert.equal(w.rolls.length, 0);
});
