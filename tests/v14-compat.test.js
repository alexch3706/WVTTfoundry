import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  foundryValuesEqual,
  getFoundryDieClass,
  getTokenCenterPoint,
  isPrimaryActiveGm,
  isFoundryDieTerm,
  measureTokenDistance,
  resolveFoundryUuid
} from "../module/foundry-compat.js";
import { Multiroll } from "../module/dice.js";
import { CyberpunkActor } from "../module/actor/actor.js";
import { getCollisionWallDocument } from "../module/combat/tactical-raycast.js";
import { LEGACY_SKILL_TRANSLATIONS } from "../module/legacy-skill-translations.js";

const readRepoFile = relativePath => readFileSync(new URL(`../${relativePath}`, import.meta.url), "utf8");

export async function runV14CompatibilityTests() {
  const results = [];

  async function test(name, assertion) {
    try {
      await assertion();
      results.push({ name: `v14 compatibility: ${name}`, passed: true });
    } catch(error) {
      console.error(error);
      results.push({ name: `v14 compatibility: ${name}`, passed: false, error });
    }
  }

  await test("uses the namespaced Die term and modern roll chat data", async () => {
    const previousFoundry = globalThis.foundry;
    const previousGame = globalThis.game;
    const previousChatMessage = globalThis.ChatMessage;
    const previousDie = globalThis.Die;
    let chatData;

    class V14Die {
      constructor() {
        this.number = 1;
        this.faces = 10;
        this.total = 7;
        this.expression = "1d10";
        this.flavor = "";
        this.results = [{ result: 7 }];
      }
      getResultLabel(result) { return String(result.result); }
    }

    try {
      delete globalThis.Die;
      globalThis.foundry = {
        dice: { terms: { Die: V14Die } },
        utils: {
          mergeObject(left, right) { return { ...(left || {}), ...(right || {}) }; }
        },
        applications: {
          handlebars: {
            async renderTemplate() { return "<div>roll</div>"; }
          }
        }
      };
      globalThis.game = { user: { id: "user-v14" } };
      globalThis.ChatMessage = { async create(data) { chatData = data; } };

      const die = new V14Die();
      const roll = { terms: [die], dice: [die], total: 7 };
      const multiroll = new Multiroll("V14 roll");
      multiroll.addRoll(roll);
      await multiroll.execute({}, "systems/test/roll.hbs");

      assert.equal(getFoundryDieClass(), V14Die);
      assert.equal(isFoundryDieTerm(die), true);
      assert.equal(chatData.type, undefined, "V14 roll messages derive their type from rolls");
      assert.equal(chatData.author, "user-v14", "V14 ChatMessage creation uses the canonical author field");
      assert.equal(chatData.user, undefined);
      assert.deepEqual(chatData.rolls, [roll]);
    } finally {
      globalThis.foundry = previousFoundry;
      globalThis.game = previousGame;
      globalThis.ChatMessage = previousChatMessage;
      if(previousDie === undefined) delete globalThis.Die;
      else globalThis.Die = previousDie;
    }
  });

  await test("measures elevated token centres through BaseGrid#measurePath", () => {
    const source = {
      _source: { x: 10, y: 20, elevation: 2 },
      elevation: 2,
      getCenterPoint() { return { x: 60, y: 70, elevation: 2 }; }
    };
    const target = {
      document: {
        _source: { x: 210, y: 20, elevation: 5 },
        elevation: 5,
        getCenterPoint() { return { x: 260, y: 70, elevation: 5 }; }
      }
    };
    let waypoints;
    const distance = measureTokenDistance(source, target, {
      measurePath(points) {
        waypoints = points;
        return { distance: 10 };
      }
    });

    assert.equal(distance, 10);
    assert.deepEqual(waypoints, [
      { x: 60, y: 70, elevation: 2 },
      { x: 260, y: 70, elevation: 5 }
    ]);
    assert.deepEqual(getTokenCenterPoint(source), waypoints[0]);
  });

  await test("uses foundry.utils.equals for freshness checks", () => {
    const previousFoundry = globalThis.foundry;
    let calls = 0;
    try {
      globalThis.foundry = {
        utils: {
          equals(left, right) {
            calls += 1;
            return left?.id === right?.id;
          }
        }
      };
      assert.equal(foundryValuesEqual({ id: 1 }, { id: 1 }), true);
      assert.equal(calls, 1);
    } finally {
      globalThis.foundry = previousFoundry;
    }
  });

  await test("resolves UUIDs through the V14 utility namespace", async () => {
    const previousFoundry = globalThis.foundry;
    const previousFromUuid = globalThis.fromUuid;
    const expected = { uuid: "Actor.v14" };
    try {
      globalThis.fromUuid = () => { throw new Error("legacy alias should not be used"); };
      globalThis.foundry = {
        utils: {
          async fromUuid(uuid) {
            assert.equal(uuid, expected.uuid);
            return expected;
          }
        }
      };
      assert.equal(await resolveFoundryUuid(expected.uuid), expected);
    } finally {
      globalThis.foundry = previousFoundry;
      if(previousFromUuid === undefined) delete globalThis.fromUuid;
      else globalThis.fromUuid = previousFromUuid;
    }
  });

  await test("uses V14 active-GM election for all-client hooks", () => {
    const assistant = { id: "a-assistant", isGM: true, active: true, isActiveGM: false };
    const gamemaster = { id: "z-gamemaster", isGM: true, active: true, isActiveGM: true };
    const users = { activeGM: gamemaster, contents: [assistant, gamemaster] };
    assert.equal(isPrimaryActiveGm(assistant, users), false);
    assert.equal(isPrimaryActiveGm(gamemaster, users), true);
  });

  await test("resolves walls through the V14 PolygonVertex EdgeSet", () => {
    const wall = { id: "wall-1", uuid: "Scene.test.Wall.wall-1" };
    const placeable = { document: wall };
    const collision = { x: 10, y: 20, edges: new Set([{ object: placeable }]) };
    assert.equal(getCollisionWallDocument(collision), wall);
  });

  await test("delegates initiative to the single V14 Actor workflow", async () => {
    const previousGame = globalThis.game;
    const previousUi = globalThis.ui;
    const actor = Object.create(CyberpunkActor.prototype);
    const expected = { id: "combat-1" };
    let receivedOptions;
    let calls = 0;
    actor.rollInitiative = async options => {
      calls += 1;
      receivedOptions = options;
      return expected;
    };
    try {
      globalThis.game = { combat: expected };
      globalThis.ui = { notifications: { error() {} } };
      const options = { createCombatants: true, rerollInitiative: false };
      assert.equal(await actor.addToCombatAndRollInitiative(options), expected);
      assert.equal(calls, 1);
      assert.equal(receivedOptions, options);
    } finally {
      globalThis.game = previousGame;
      globalThis.ui = previousUi;
    }
  });

  await test("contains no removed V14 runtime API calls", () => {
    const dice = readRepoFile("module/dice.js");
    const actorSheet = readRepoFile("module/actor/actor-sheet.js");
    const commit = readRepoFile("module/combat/combat-commit.js");
    const actor = readRepoFile("module/actor/actor.js");
    const migration = readRepoFile("module/migrate.js");
    const bootstrap = readRepoFile("module/cyberpunk2020-rilerena.js");
    const rollTemplates = [
      readRepoFile("templates/chat/default-roll.hbs"),
      readRepoFile("templates/chat/multi-hit.hbs")
    ].join("\n");
    const editorTemplates = [
      readRepoFile("templates/actor/actor-sheet.hbs"),
      readRepoFile("templates/item/item-sheet.hbs")
    ].join("\n");
    assert.doesNotMatch(dice, /instanceof\s+Die\b/);
    assert.doesNotMatch(dice, /CHAT_MESSAGE_(?:STYLES|TYPES)\?*\.ROLL/);
    assert.doesNotMatch(actorSheet, /\.measureDistance\s*\(/);
    assert.doesNotMatch(commit, /\.objectsEqual\s*\(/);
    assert.doesNotMatch(actor, /async\s+_onCreate\s*\(/);
    assert.doesNotMatch(actor, /getCombatantByActor\s*\(/);
    assert.match(actor, /await\s+super\._preCreate\s*\(/);
    assert.match(actor, /this\.updateSource\s*\(/);
    assert.doesNotMatch(migration, /compendium\.metadata\b/);
    assert.doesNotMatch(migration, /compendium\.index\b/);
    assert.match(migration, /compendium\.getDocuments\s*\(/);
    assert.match(migration, /compendium\.configure\s*\(\{ locked: false \}\)/);
    assert.doesNotMatch(migration, /["'`]system\.[^"'`]*\.-=/);
    assert.match(
      bootstrap,
      /Hooks\.once\(["']setup["'][\s\S]*?applyVisualEffectSettings\(\)/,
      "settings values must only be read once V14 reaches the setup phase"
    );
    assert.doesNotMatch(rollTemplates, /\._(?:formula|total)\b/);
    assert.doesNotMatch(editorTemplates, /\bowner=owner\b/);
  });

  await test("recognizes legacy skill names from every shipped locale", () => {
    for(const locale of ["en", "es", "it"]) {
      const translations = JSON.parse(readRepoFile(`lang/${locale}.json`));
      for(const [localizationKey, localizedName] of Object.entries(translations)) {
        if(!localizationKey.startsWith("CYBERPUNK.Skill")) continue;
        let legacyKey = localizationKey.slice("CYBERPUNK.Skill".length);
        if(legacyKey.startsWith("Martial Arts: ")) {
          legacyKey = legacyKey.slice("Martial Arts: ".length);
        }
        assert.ok(
          LEGACY_SKILL_TRANSLATIONS[legacyKey]?.includes(localizedName),
          `${locale} ${localizationKey} is absent from the locale-independent migration catalog`
        );
      }
    }
  });

  await test("documents the mandatory latest-V13 staging hop before V14", () => {
    const guide = readRepoFile("docs/v14-upgrade-guide.md");
    const latestV13 = guide.indexOf("latest stable V13");
    const secondBackup = guide.indexOf("second backup");
    const stageV14 = guide.indexOf("Stage Cyberpunk 2020 `2.0.0`");
    assert.ok(latestV13 >= 0, "the upgrade guide must require latest stable V13 staging");
    assert.ok(secondBackup > latestV13, "the staged V13 world must be backed up again");
    assert.ok(stageV14 > secondBackup, "V14 staging must happen only after the V13 backup");
    assert.match(guide, /no longer carries core migration support for data older than V13/);
  });

  return results;
}

if(process.argv[1]?.endsWith("v14-compat.test.js")) {
  const results = await runV14CompatibilityTests();
  for(const result of results) console.log(`${result.passed ? "ok" : "FAIL"} ${result.name}`);
  if(results.some(result => result.passed === false)) process.exit(1);
}
