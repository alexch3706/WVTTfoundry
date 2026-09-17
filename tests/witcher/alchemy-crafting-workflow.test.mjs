import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { workflow, clone } from './workflow-fixture.mjs';
import { SYSTEM_ID } from '../../module/witcher/config.js';
import { runCommand } from '../../module/witcher/authority.js';

const rows = ['diagrams', 'tome-alchemy', 'alchemy', 'witcher-gear', 'components', 'equipment'].flatMap(
  (name) => JSON.parse(fs.readFileSync(new URL(`../../data/witcher/${name}.json`, import.meta.url)))
);
async function setup(t, name = 'Swallow Formula') {
  const w = await workflow(t),
    runtime = await import('../../module/witcher/alchemy-crafting-runtime.js');
  runtime.registerCraftingRuntime();
  const row = rows.find((item) => item.name === name);
  assert(row, name);
  const [formula] = await w.attacker.createEmbeddedDocuments('Item', [row]);
  const tool = rows.find((item) => item.name === 'Alchemy Set');
  assert(tool);
  await w.attacker.createEmbeddedDocuments('Item', [tool]);
  const [product] = await w.target.createEmbeddedDocuments('Item', [
    rows.find((item) => item.name === row.system.productName),
  ]);
  w.docs.set(row.system.productUuid, product);
  const ingredients = [];
  for (const material of row.system.materials) {
    const source = rows.find((item) =>
      material.substance ? item.system.substance === material.substance : item.name === material.name
    );
    assert(source, material.name);
    const data = clone(source);
    data.system.quantity = material.quantity;
    ingredients.push((await w.attacker.createEmbeddedDocuments('Item', [data]))[0]);
  }
  const options = { written: true, time: true, modifier: 0, manualDice: '9' };
  return {
    ...w,
    formula,
    ingredients,
    runtime,
    craft: (extra = {}) =>
      runCommand('craftingAttempt', {
        actorUuid: w.attacker.uuid,
        diagramUuid: formula.uuid,
        options: { ...options, ...extra },
      }),
  };
}

test('actual formula and fresh allocated ingredients produce one real dose; depleted stock cannot be reused', async (t) => {
  const w = await setup(t);
  await w.craft();
  assert(w.ingredients.every((item) => item.system.quantity === 0));
  const product = w.attacker.items.find((item) => item.name === 'Swallow' && item.type === 'alchemical');
  assert(product);
  assert.equal(product.system.quantity, 1);
  assert.equal(product.system.sourceUuid, w.target.items.find((item) => item.name === 'Swallow').uuid);
  await assert.rejects(w.craft(), /Missing/);
  assert.equal(w.attacker.items.filter((item) => item.name === 'Swallow').length, 1);
});

test('Herbalism substitution receives the actual plant-only ingredient context for crafting and recovery', async (t) => {
  const w = await setup(t, 'Numbing Herbs Formula');
  // These two actual plants provide this formula’s substances. The invocation
  // effect uses the same structured operation as a resolved Herbalism cast.
  for (const item of w.ingredients) {
    const actualPlant = rows.find(
      (row) =>
        [
          'Celandine',
          'Balisse Fruit',
          'Hellebore Petals',
          'Arenaria',
          'Honeysuckle',
          'Mandrake Root',
          'Wolfsbane',
          'Crow’s Eye',
        ].includes(row.name) && row.system.substance === item.system.substance
    );
    assert(actualPlant, item.system.substance);
    item.name = actualPlant.name;
  }
  await w.attacker.update({
    'system.skills.alchemy': 0,
    'system.skills.spellCasting': 15,
    'system.effects': [
      {
        id: 'herbal',
        key: 'Herbalism',
        expires: 0,
        magic: {
          key: 'herbalism',
          operation: {
            type: 'modifier',
            modifiers: {},
            rule: {
              key: 'skillSubstitution',
              skill: 'alchemy',
              substitute: 'spellCasting',
              predicate: 'plantOnlyElixirCraftingOrRecovery',
            },
          },
        },
      },
    ],
  });
  await w.craft({ manualDice: '2' });
  assert(
    w.attacker.items.some((item) => item.name === 'Numbing Herbs'),
    'Spell Casting substitution actually passed DC12'
  );
  assert(
    w.attacker.skillCalls.some(
      (call) =>
        call.key === 'spellCasting' && call.options.context.predicates.plantOnlyElixirCraftingOrRecovery
    )
  );
});

test('chat or product failure compensates all ingredient stacks and deletes any created output', async (t) => {
  const w = await setup(t);
  const before = w.ingredients.map((item) => item.system.quantity);
  w.faults.create = () => true;
  await assert.rejects(w.craft(), /Injected message/);
  assert.deepEqual(
    w.ingredients.map((item) => item.system.quantity),
    before
  );
  assert(!w.attacker.items.some((item) => item.name === 'Swallow'));
  assert.equal(w.attacker.flags?.[SYSTEM_ID]?.craftRecovery, undefined);
  w.faults.create = null;
  await w.craft();
  assert(w.attacker.items.some((item) => item.name === 'Swallow'));
});

test('written bonus requires a carried owned formula or explicit GM access evidence', async (t) => {
  const w = await setup(t);
  await w.formula.update({ 'system.carried': false });
  await assert.rejects(w.craft(), /carried recipe/);
  assert(w.ingredients.every((item) => item.system.quantity > 0));
  await w.craft({ writtenEvidence: 'GM: open formula book on the alchemist’s workbench' });
  assert(w.attacker.items.some((item) => item.name === 'Swallow'));
});

test('failed alchemy allows exactly one immediate roll recovering one actual pure substance', async (t) => {
  const w = await setup(t);
  const message = await w.craft({ manualDice: '2' }),
    data = message.flags[SYSTEM_ID];
  assert(w.ingredients.every((item) => item.system.quantity === 0));
  const substance = w.ingredients[0].system.substance;
  await runCommand('craftingRecovery', {
    actorUuid: w.attacker.uuid,
    receipt: data.craftReceipt,
    options: { substance, manualDice: '9' },
  });
  const recovered = w.attacker.items.filter((item) => item.system.category === 'pureSubstance');
  assert.equal(recovered.length, 1);
  assert.equal(recovered[0].name, substance);
  assert.equal(recovered[0].system.quantity, 1);
  await assert.rejects(
    runCommand('craftingRecovery', {
      actorUuid: w.attacker.uuid,
      receipt: data.craftReceipt,
      options: { substance, manualDice: '9' },
    }),
    /no unused recovery/
  );
});

test('recovery result chat failure restores its single opportunity and removes recovered product', async (t) => {
  const w = await setup(t);
  const message = await w.craft({ manualDice: '2' }),
    receipt = message.flags[SYSTEM_ID].craftReceipt,
    substance = w.ingredients[0].system.substance;
  w.faults.create = () => true;
  await assert.rejects(
    runCommand('craftingRecovery', {
      actorUuid: w.attacker.uuid,
      receipt,
      options: { substance, manualDice: '9' },
    }),
    /Injected message/
  );
  assert.equal(w.attacker.flags[SYSTEM_ID].craftRecovery.status, 'pending');
  assert(!w.attacker.items.some((item) => item.system.category === 'pureSubstance'));
  w.faults.create = null;
  await runCommand('craftingRecovery', {
    actorUuid: w.attacker.uuid,
    receipt,
    options: { substance, manualDice: '9' },
  });
  assert.equal(w.attacker.flags[SYSTEM_ID].craftRecovery.status, 'used');
});

test('later time invalidates recovery and a stale missing ingredient cannot pass authority validation', async (t) => {
  const w = await setup(t);
  const message = await w.craft({ manualDice: '2' }),
    receipt = message.flags[SYSTEM_ID].craftReceipt,
    substance = w.ingredients[0].system.substance;
  game.time.worldTime = 3;
  await assert.rejects(
    runCommand('craftingRecovery', {
      actorUuid: w.attacker.uuid,
      receipt,
      options: { substance, manualDice: '9' },
    }),
    /immediately/
  );
  assert(!w.attacker.items.some((item) => item.system.category === 'pureSubstance'));
});

test('Cerebral Elixir recipe resolves its actual silver as alchemy without requiring a forge', async (t) => {
  const w = await setup(t, 'Cerebral Elixir Formula');
  await w.attacker.update({ 'system.skills.alchemy': 15 });
  await w.craft();
  assert(w.attacker.items.some((item) => item.name === 'Cerebral Elixir'));
  assert(w.ingredients.every((item) => item.system.quantity === 0));
});

test('five-round Numbing Herbs formula requires five consecutive real combat work actions', async (t) => {
  const w = await setup(t, 'Numbing Herbs Formula');
  w.start();
  const step = () =>
    runCommand('craftingRound', {
      actorUuid: w.attacker.uuid,
      diagramUuid: w.formula.uuid,
      options: { written: true, manualDice: '9', modifier: 0 },
    });
  for (let round = 1; round <= 5; round++) {
    game.combat.round = round;
    game.time.worldTime = (round - 1) * 3;
    await step();
    if (round < 5) assert(!w.attacker.items.some((item) => item.name === 'Numbing Herbs'));
    if (round === 1) await assert.rejects(step(), /separate combat turn/);
  }
  assert(w.attacker.items.some((item) => item.name === 'Numbing Herbs'));
  assert(w.ingredients.every((item) => item.system.quantity === 0));
});
