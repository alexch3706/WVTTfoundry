/** Import/registration smoke test with V14 namespace contracts. Real data models
 * are validated separately against the supplied V14 client; this is not a live world. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';

test('fresh main module imports and overlapping ready callbacks install native models and complete magic dispatch', async (t) => {
  const names = ['foundry', 'Actor', 'Item', 'Hooks', 'CONFIG', 'game', 'canvas', 'ui'];
  const previous = new Map(names.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  t.after(() => {
    for (const [key, descriptor] of previous)
      descriptor ? Object.defineProperty(globalThis, key, descriptor) : delete globalThis[key];
  });
  const hooks = new Map(),
    sheets = [],
    loaded = [],
    notices = [];
  const register = (name, callback) => {
    const list = hooks.get(name) ?? [];
    list.push(callback);
    hooks.set(name, list);
  };
  globalThis.Actor = class {};
  globalThis.Item = class {};
  globalThis.Hooks = { once: register, on: register };
  globalThis.foundry = {
    abstract: { TypeDataModel: class {} },
    data: { fields: {}, regionBehaviors: { RegionBehaviorType: class {} } },
    appv1: { sheets: { ActorSheet: class {}, ItemSheet: class {} } },
    applications: {
      handlebars: {
        loadTemplates: async (paths) => {
          loaded.push(...paths);
          return [];
        },
      },
    },
    documents: {
      collections: {
        Actors: { registerSheet: (...args) => sheets.push(args) },
        Items: { registerSheet: (...args) => sheets.push(args) },
      },
    },
    utils: { deepClone: structuredClone, fromUuid: async () => null, randomID: () => 'test-id' },
  };
  const gm = { id: 'gm', active: true, isGM: true, isActiveGM: true };
  const users = [gm];
  users.activeGM = gm;
  globalThis.game = {
    user: gm,
    users,
    actors: [],
    scenes: [],
    messages: [],
    combat: null,
    time: { worldTime: 0 },
    settings: { get: () => false },
  };
  globalThis.canvas = { ready: false, tokens: { placeables: [], controlled: [] } };
  globalThis.ui = {
    notifications: { warn: (message) => notices.push(message), error: (message) => notices.push(message) },
  };
  globalThis.CONFIG = { Actor: {}, Item: {}, Combat: {}, time: {}, RegionBehavior: { dataModels: {} } };
  await import('../../module/witcher/main.js');
  await Promise.all(hooks.get('init').map((callback) => callback()));
  assert.equal(CONFIG.time.roundTime, 3);
  assert.equal(typeof CONFIG.RegionBehavior.dataModels['witcher-rilerena.magicArea'], 'function');
  assert.equal(typeof CONFIG.RegionBehavior.dataModels['witcher-rilerena.ritualArea'], 'function');
  assert.equal(sheets.length, 2);
  assert.equal(loaded.length, 4);
  for (const path of loaded)
    assert(existsSync(new URL(`../../${path.replace('systems/witcher-rilerena/', '')}`, import.meta.url)));
  // Foundry's hook dispatcher does not wait between async ready callbacks.
  await Promise.all(hooks.get('ready').map((callback) => callback()));
  const { serial } = await import('../../module/witcher/runtime.js');
  await serial('witcher-authority', async () => {});
  assert.deepEqual(notices, []);
  const { BASIC_SPELL_KEYS, basicOperationSupported } =
    await import('../../module/witcher/magic-execution.js');
  const { spellEffectPlan } = await import('../../module/witcher/magic-effects.js');
  for (const [key, choices] of [
    ['talfryns-prison', {}],
    ['zephyr', { zephyrAffectsCaster: false }],
    ['dormyns-fog', { followCaster: false }],
  ]) {
    assert(BASIC_SPELL_KEYS.has(key));
    const plan = spellEffectPlan(key, { castTotal: 20, choices });
    assert(plan.ready);
    assert(plan.operations.every(basicOperationSupported), `${key}: execution adapters registered`);
  }
  const { supportsRitualRuntime } = await import('../../module/witcher/magic-ritual-effects.js');
  assert(
    supportsRitualRuntime('spell-jar'),
    'All five required Spell Jar spells have complete registered runtimes'
  );
});
