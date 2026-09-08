import assert from "node:assert/strict";

import {
  buildTurnStartDeathSaveReminder,
  handleCombatTurnDeathSaveReminder,
  registerCombatTurnDeathSaveHook
} from "../../module/combat/death-save-turn.js";
import {
  bindSaveChatActions,
  buildSaveResolutionKey,
  isSaveRollSuccessful,
  persistSaveResolution,
  resolveSaveThreshold
} from "../../module/combat/save-chat-listeners.js";

export async function runDeathSaveTurnTests() {
  const results = [];

  async function test(name, fn) {
    try {
      await fn();
      results.push({ name: `death-save-turn: ${name}`, passed: true });
    } catch (err) {
      console.error(`FAIL: death-save-turn: ${name}`);
      console.error(err);
      results.push({ name: `death-save-turn: ${name}`, passed: false, error: err });
    }
  }

  await test("does not emit without active started combat", async () => {
    const adapter = createFakeTurnAdapter({ combat: undefined });
    const result = await handleCombatTurnDeathSaveReminder(undefined, {}, {}, { adapter });
    assert.equal(result.status, "skipped");
    assert.equal(adapter.messages.length, 0);
  });

  await test("registers the all-client post-update V14 turn hook", () => {
    const previousHooks = globalThis.Hooks;
    const registrations = [];
    try {
      globalThis.Hooks = { on: (name, callback) => registrations.push({ name, callback }) };
      registerCombatTurnDeathSaveHook();
      assert.deepEqual(registrations.map(entry => entry.name), ["combatTurnChange"]);
      assert.equal(typeof registrations[0].callback, "function");
    } finally {
      globalThis.Hooks = previousHooks;
    }
  });

  await test("does not emit before initiative starts", async () => {
    const adapter = createFakeTurnAdapter({ combat: { started: false, combatant: activeCombatant() } });
    const result = await handleCombatTurnDeathSaveReminder(adapter.combat, {}, {}, { adapter });
    assert.equal(result.status, "skipped");
    assert.equal(adapter.messages.length, 0);
  });

  await test("does not emit on non-GM clients", async () => {
    const adapter = createFakeTurnAdapter({ isGM: false });
    const result = await handleCombatTurnDeathSaveReminder(adapter.combat, {}, {}, { adapter });
    assert.equal(result.status, "skipped");
    assert.equal(adapter.messages.length, 0);
  });

  await test("emits exactly one reminder for a Mortal active combatant", async () => {
    const adapter = createFakeTurnAdapter();
    const first = await handleCombatTurnDeathSaveReminder(adapter.combat, { turn: 0, round: 1 }, {}, { adapter });
    const duplicate = await handleCombatTurnDeathSaveReminder(adapter.combat, { turn: 0, round: 1 }, {}, { adapter });
    assert.equal(first.status, "created");
    assert.equal(duplicate.status, "duplicate");
    assert.equal(adapter.messages.length, 1);
    assert.match(adapter.messages[0].content, /Mortal 0/);
    assert.match(adapter.messages[0].content, /Body Type 6/);
    assert.match(adapter.messages[0].content, /Penalty 0/);
  });

  await test("does not emit for dead or stabilized actors", async () => {
    const deadAdapter = createFakeTurnAdapter({
      combat: { started: true, round: 1, turn: 0, combatant: activeCombatant({ system: { damage: 41, stats: { bt: { total: 6 } } } }) }
    });
    const stabilizedAdapter = createFakeTurnAdapter({
      combat: { started: true, round: 1, turn: 0, combatant: activeCombatant({ system: { damage: 13, deathSave: { stabilized: true }, stats: { bt: { total: 6 } } } }) }
    });

    assert.equal((await handleCombatTurnDeathSaveReminder(deadAdapter.combat, {}, {}, { adapter: deadAdapter })).status, "skipped");
    assert.equal((await handleCombatTurnDeathSaveReminder(stabilizedAdapter.combat, {}, {}, { adapter: stabilizedAdapter })).status, "skipped");
    assert.equal(deadAdapter.messages.length, 0);
    assert.equal(stabilizedAdapter.messages.length, 0);
  });

  await test("builds reminder data with actor, Mortal level, Body Type, and penalty", () => {
    const reminder = buildTurnStartDeathSaveReminder(activeCombatant().actor);
    assert.equal(reminder.actorName, "Target");
    assert.equal(reminder.mortalLevel, 0);
    assert.equal(reminder.bodyType, 6);
    assert.equal(reminder.penalty, 0);
    assert.equal(reminder.threshold, 6);
    assert.equal(reminder.woundState.label, "Mortal 0");
  });

  await test("save rolls succeed at or below the canonical threshold", () => {
    const save = { threshold: 6, targetNumber: 2 };
    assert.equal(resolveSaveThreshold(save), 6, "canonical threshold takes precedence over the deprecated alias");
    assert.equal(isSaveRollSuccessful(6, save), true, "a roll equal to the threshold succeeds");
    assert.equal(isSaveRollSuccessful(5, save), true, "a roll below the threshold succeeds");
    assert.equal(isSaveRollSuccessful(7, save), false, "a roll above the threshold fails");
  });

  await test("legacy save prompts still resolve through targetNumber", () => {
    assert.equal(resolveSaveThreshold({ targetNumber: 4 }), 4);
    assert.equal(isSaveRollSuccessful(4, { targetNumber: 4 }), true);
    assert.equal(isSaveRollSuccessful(5, { targetNumber: 4 }), false);
    assert.equal(isSaveRollSuccessful(1, {}), false, "a missing threshold cannot silently pass");
  });

  await test("save actions distinguish linked tokens of the same actor", () => {
    const actorUuid = "Actor.shared";
    assert.equal(buildSaveResolutionKey({ target: { actorUuid, tokenUuid: "Scene.test.Token.one" } }, 0), "Scene.test.Token.one");
    assert.equal(buildSaveResolutionKey({ target: { actorUuid, tokenUuid: "Scene.test.Token.two" } }, 1), "Scene.test.Token.two");
    assert.notEqual(
      buildSaveResolutionKey({ target: { actorUuid } }, 0),
      buildSaveResolutionKey({ target: { actorUuid } }, 1),
      "actor-only fallbacks include the stable target index"
    );
  });

  await test("automatic NPC saves are restricted to the active GM", () => {
    const previousGame = globalThis.game;
    try {
      const makeButton = () => ({
        dataset: { targetIndex: "0" },
        disabled: false,
        attributes: {},
        listeners: {},
        setAttribute(name, value) { this.attributes[name] = value; },
        removeAttribute(name) { delete this.attributes[name]; },
        addEventListener(type, listener) { this.listeners[type] = listener; }
      });
      const autoButton = makeButton();
      const manualButton = makeButton();
      const root = {
        querySelectorAll(selector) {
          if(selector === ".save-action-autoroll") return [autoButton];
          if(selector === ".save-action-manual") return [manualButton];
          return [];
        }
      };
      const message = {
        id: "message-1",
        getFlag(_systemId, key) {
          if(key === "combatOutcome") {
            return { targets: [{ target: { actorUuid: "Actor.target" }, saves: [] }] };
          }
          return [];
        }
      };
      globalThis.game = {
        system: { id: "cyberpunk2020-rilerena" },
        user: { id: "player", isGM: false },
        users: [{ id: "gm", isGM: true, active: true }]
      };

      bindSaveChatActions(message, root);
      assert.equal(autoButton.disabled, true);
      assert.equal(manualButton.disabled, false, "manual resolution stays available to players");
      assert.equal(typeof manualButton.listeners.click, "function");

      globalThis.game.user = { id: "gm", isGM: true };
      bindSaveChatActions(message, root);
      assert.equal(autoButton.disabled, false, "an existing chat action is refreshed when this client becomes primary GM");
    } finally {
      globalThis.game = previousGame;
    }
  });

  await test("concurrent target save locks preserve every message flag", async () => {
    const previousGame = globalThis.game;
    const storedFlags = {};
    const message = {
      getFlag(_systemId, key) {
        return storedFlags[key];
      },
      async setFlag(_systemId, key, value) {
        // Yield so this test would expose an unguarded read-modify-write race.
        await new Promise(resolve => setTimeout(resolve, 0));
        storedFlags[key] = structuredClone(value);
      }
    };
    globalThis.game = { user: { id: "gm" } };
    try {
      await Promise.all([
        persistSaveResolution(message, "cyberpunk2020-rilerena", "Actor.a:0", "pending"),
        persistSaveResolution(message, "cyberpunk2020-rilerena", "Actor.b:1", "pending")
      ]);
      assert.deepEqual(
        storedFlags.combatSaveResolutions.map(entry => entry.key).sort(),
        ["Actor.a:0", "Actor.b:1"]
      );
    } finally {
      globalThis.game = previousGame;
    }
  });

  return results;
}

function createFakeTurnAdapter(options = {}) {
  const messages = [];
  const adapter = {
    messages,
    combat: options.combat || { started: true, round: 1, turn: 0, combatant: activeCombatant() },
    isAuthoritativeClient() {
      return options.isGM !== false;
    },
    async createReminderMessage(reminder) {
      messages.push({
        content: `${reminder.actorName}: ${reminder.woundState.label}, Body Type ${reminder.bodyType}, Penalty ${reminder.penalty}, Threshold ${reminder.threshold}`
      });
    }
  };
  return adapter;
}

function activeCombatant(actor = { name: "Target", system: { damage: 13, stats: { bt: { total: 6 } } } }) {
  return {
    id: "combatant-1",
    actor,
    token: {
      name: actor.name
    }
  };
}
