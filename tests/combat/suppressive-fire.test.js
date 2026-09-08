import assert from "assert";
import {
  bindSuppressiveFireChatActions,
  buildSuppressiveFireTemplateData,
  calculateSuppressiveFireSaveDC,
  canRetrySuppressiveDamageResolution,
  getUpdatedCombatant,
  handleSuppressiveFireCombatTurn,
  promptSuppressiveFireSave,
  registerSuppressiveFireHooks,
  resolveSuppressiveFireDamageFromChat
} from "../../module/combat/suppressive-fire-tracker.js";
import { resolveSuppressiveFireDamageOutcome } from "../../module/combat/attack-resolver.js";
import { planCombatUpdates } from "../../module/combat/state-planner.js";

export async function runSuppressiveFireTests() {
  const results = [];
  
  function addResult(name, pass) {
    results.push({ name, passed: pass });
  }

  function testSaveDC() {
    let passed = true;
    try {
      assert.strictEqual(calculateSuppressiveFireSaveDC(30, 2), 15);
      assert.strictEqual(calculateSuppressiveFireSaveDC(30, 3), 10);
      assert.strictEqual(calculateSuppressiveFireSaveDC(25, 2), 12);
      assert.strictEqual(calculateSuppressiveFireSaveDC(0, 2), 0);
      assert.strictEqual(canRetrySuppressiveDamageResolution({ status: "canceled", applied: {} }), false);
      assert.strictEqual(canRetrySuppressiveDamageResolution({ status: "missing-combat-document", applied: {} }), true);
      assert.strictEqual(canRetrySuppressiveDamageResolution({ status: "manual", applied: { actorUpdates: 1 } }), false);
      assert.strictEqual(canRetrySuppressiveDamageResolution({ status: "committed", applied: {} }), false);
      const firstCombatant = { id: "first", tokenId: "first-token" };
      assert.strictEqual(
        getUpdatedCombatant({ combatant: firstCombatant, turns: [firstCombatant] }, { combatantId: null, tokenId: null, turn: null }),
        null,
        "a cleared V14 combat turn must not wrap around to combatant zero"
      );
    } catch (e) {
      console.error(e);
      passed = false;
    }
    addResult("suppressive-fire: Save DC calculation", passed);
  }

  function testTemplateDataBuilder() {
    let passed = true;
    const previousCanvas = globalThis.canvas;
    try {
      globalThis.canvas = {
        dimensions: { distancePixels: 100 },
        level: { id: "level-1" }
      };
      const data = buildSuppressiveFireTemplateData({
        attackerTokenId: "t1",
        attackerTokenUuid: "Scene.s1.Token.t1",
        attackerActorId: "a1",
        attackerActorUuid: "Actor.a1",
        weaponItemId: "w1",
        weaponItemUuid: "Actor.a1.Item.w1",
        damageFormula: "2d6",
        bulletsFired: 20,
        zoneWidth: 2,
        maxDistance: 10,
        origin: {x: 100, y: 100},
        combatRound: 1,
        combatTurn: 2,
        combatId: "c1"
      });

      const shape = data.shapes?.[0];
      assert.ok(shape, "Region data must contain a primary shape");
      assert.strictEqual(shape.type, "line");
      assert.strictEqual(shape.x, 100);
      assert.strictEqual(shape.y, 100);
      assert.strictEqual(shape.length, 1000);
      assert.strictEqual(shape.width, 200);
      assert.strictEqual(shape.rotation, 0);
      assert.strictEqual(shape.gridBased, false);
      
      const flags = data.flags?.cyberpunk2020?.suppressiveFire;
      assert.ok(flags, "Flags must be defined");
      assert.strictEqual(flags.shooterActorId, "a1");
      assert.strictEqual(flags.shooterActorUuid, "Actor.a1");
      assert.strictEqual(flags.shooterTokenId, "t1");
      assert.strictEqual(flags.shooterTokenUuid, "Scene.s1.Token.t1");
      assert.strictEqual(flags.weaponItemId, "w1");
      assert.strictEqual(flags.weaponItemUuid, "Actor.a1.Item.w1");
      assert.strictEqual(flags.damageFormula, "2d6");
      assert.strictEqual(flags.bulletsFired, 20);
      assert.strictEqual(flags.remainingHitCap, 20);
      assert.strictEqual(flags.saveDC, 10); // 20 / 2
      assert.strictEqual(flags.zoneWidth, 2);
      assert.strictEqual(flags.maxDistance, 10);
      assert.strictEqual(flags.createdCombatId, "c1");
      assert.strictEqual(flags.createdRound, 1);
      assert.strictEqual(flags.createdTurn, 2);
      assert.deepStrictEqual(flags.resolvedTokenIds, []);
    } catch(e) {
      console.error(e);
      passed = false;
    } finally {
      globalThis.canvas = previousCanvas;
    }
    addResult("suppressive-fire: V14 Region data builder", passed);
  }

  function testV14ChatBindingIsGmAuthoritative() {
    let passed = true;
    const previousGame = globalThis.game;
    const previousHooks = globalThis.Hooks;
    try {
      const makeButton = dataset => ({
        dataset: { ...dataset },
        disabled: false,
        attributes: {},
        listeners: {},
        setAttribute(name, value) { this.attributes[name] = value; },
        removeAttribute(name) { delete this.attributes[name]; },
        addEventListener(type, listener) { this.listeners[type] = listener; }
      });
      const makeRoot = (hitsButton, damageButton) => ({
        querySelectorAll(selector) {
          if(selector === ".roll-suppressive-hits") return [hitsButton];
          if(selector === ".roll-damage") return [damageButton];
          return [];
        }
      });

      globalThis.game = {
        system: { id: "cyberpunk2020-rilerena" },
        user: { id: "player", isGM: false },
        users: [{ id: "gm", isGM: true, active: true }]
      };
      const playerHits = makeButton({ templateId: "template", actorId: "actor" });
      const playerDamage = makeButton({ templateId: "template", actorId: "actor", hits: "2" });
      bindSuppressiveFireChatActions({ getFlag: () => undefined }, makeRoot(playerHits, playerDamage));
      assert.strictEqual(playerHits.disabled, true, "non-GM V14 chat actions should be disabled");
      assert.strictEqual(playerDamage.disabled, true, "non-GM damage actions should be disabled");

      globalThis.game.user = { id: "gm", isGM: true };
      bindSuppressiveFireChatActions({ getFlag: () => undefined }, makeRoot(playerHits, playerDamage));
      assert.strictEqual(playerHits.disabled, false, "an existing hit action should refresh for the new primary GM");
      assert.strictEqual(playerDamage.disabled, false, "an existing damage action should refresh for the new primary GM");

      const gmHits = makeButton({ templateId: "template", actorId: "actor" });
      const gmDamage = makeButton({ templateId: "template", actorId: "actor", hits: "2" });
      bindSuppressiveFireChatActions({ getFlag: () => undefined }, makeRoot(gmHits, gmDamage));
      assert.strictEqual(gmHits.disabled, false, "primary GM V14 chat actions should remain enabled");
      assert.strictEqual(typeof gmHits.listeners.click, "function");
      assert.strictEqual(typeof gmDamage.listeners.click, "function");

      const legacyWrapperHits = makeButton({ templateId: "legacy", actorId: "actor" });
      bindSuppressiveFireChatActions(
        { getFlag: () => undefined },
        [makeRoot(legacyWrapperHits, makeButton({ templateId: "legacy", actorId: "actor", hits: "2" }))]
      );
      assert.strictEqual(legacyWrapperHits.listeners.click, undefined, "V14-only binding must ignore jQuery wrappers");

      const registeredHooks = [];
      globalThis.Hooks = { on: name => registeredHooks.push(name) };
      registerSuppressiveFireHooks();
      assert.ok(registeredHooks.includes("moveToken"), "V14 movement hook should be registered");
      assert.ok(!registeredHooks.includes("updateToken"), "movement must not be processed twice through updateToken");
      assert.ok(registeredHooks.includes("renderChatMessageHTML"), "V14 HTMLElement hook should be registered");
      assert.ok(registeredHooks.includes("combatTurnChange"), "post-update V14 combat hook should be registered");
      assert.ok(!registeredHooks.includes("combatTurn"), "initiating-client pre-update combat hook should not be registered");
      assert.ok(!registeredHooks.includes("renderChatMessage"), "legacy jQuery chat hook should not be registered");
    } catch(error) {
      console.error(error);
      passed = false;
    } finally {
      globalThis.game = previousGame;
      globalThis.Hooks = previousHooks;
    }
    addResult("suppressive-fire: V14 HTMLElement chat actions are GM-authoritative", passed);
  }

  async function testFailedChatLockPreventsSuppressiveHitEffects() {
    let passed = true;
    const previousGame = globalThis.game;
    const previousCanvas = globalThis.canvas;
    const previousUi = globalThis.ui;
    const previousRoll = globalThis.Roll;
    const previousChatMessage = globalThis.ChatMessage;
    try {
      let rollCount = 0;
      let templateUpdateCount = 0;
      let chatCount = 0;
      const hitsButton = {
        dataset: { templateId: "template-1", actorId: "actor-1" },
        disabled: false,
        attributes: {},
        listeners: {},
        setAttribute(name, value) { this.attributes[name] = value; },
        removeAttribute(name) { delete this.attributes[name]; },
        addEventListener(type, listener) { this.listeners[type] = listener; }
      };
      const root = {
        querySelectorAll(selector) {
          return selector === ".roll-suppressive-hits" ? [hitsButton] : [];
        }
      };
      const message = {
        getFlag() { return undefined; },
        async setFlag() { throw new Error("permission denied"); }
      };
      globalThis.game = {
        system: { id: "cyberpunk2020-rilerena" },
        user: { id: "gm", isGM: true },
        users: [{ id: "gm", isGM: true, active: true }]
      };
      globalThis.canvas = {
        dimensions: { size: 100 },
        scene: {
          regions: {
            get: () => ({
              flags: { cyberpunk2020: { suppressiveFire: { remainingHitCap: 10 } } },
              async update() { templateUpdateCount += 1; }
            })
          }
        }
      };
      globalThis.ui = { notifications: { warn() {}, error() {} } };
      globalThis.Roll = class {
        async evaluate() {
          rollCount += 1;
          return { total: 3 };
        }
      };
      globalThis.ChatMessage = {
        getSpeaker: () => ({}),
        async create() { chatCount += 1; }
      };

      bindSuppressiveFireChatActions(message, root);
      await hitsButton.listeners.click({ preventDefault() {}, currentTarget: hitsButton });

      assert.strictEqual(rollCount, 0, "the hit roll must not start without a durable chat lock");
      assert.strictEqual(templateUpdateCount, 0, "the template cap must not change without a durable chat lock");
      assert.strictEqual(chatCount, 0, "no follow-up card should be created without a durable chat lock");
      assert.strictEqual(hitsButton.disabled, false, "a failed pre-lock remains retryable");
    } catch(error) {
      console.error(error);
      passed = false;
    } finally {
      globalThis.game = previousGame;
      globalThis.canvas = previousCanvas;
      globalThis.ui = previousUi;
      globalThis.Roll = previousRoll;
      globalThis.ChatMessage = previousChatMessage;
    }
    addResult("suppressive-fire: failed chat lock prevents hit side effects", passed);
  }

  async function testIntersectionLogic() {
    let passed = true;
    const previousGame = globalThis.game;
    const previousCanvas = globalThis.canvas;
    const previousChatMessage = globalThis.ChatMessage;
    try {
      const { checkAndResolveIntersection } = await import("../../module/combat/suppressive-fire-tracker.js");
      globalThis.game = { combat: { id: "c1", round: 1, turn: 1 } };
      globalThis.canvas = { dimensions: { size: 100 } };
      globalThis.ChatMessage = { getSpeaker: () => ({}), async create() {} };

      let updateCalled = false;
      const testedPoints = [];
      const flags = {
        remainingHitCap: 10,
        saveDC: 15,
        resolvedTokenIds: []
      };
      const region = {
        id: "region-center-elevation",
        flags: { cyberpunk2020: { suppressiveFire: flags } },
        testPoint(point) {
          testedPoints.push(point);
          return point.x === 50 && point.y === 50 && point.elevation === 7;
        },
        async update(data) {
          updateCalled = true;
          flags.resolvedTokenIds = data["flags.cyberpunk2020.suppressiveFire.resolvedTokenIds"];
        }
      };

      const tokenDocumentIntersecting = {
        id: "tok1",
        x: 0,
        y: 0,
        width: 1,
        height: 1,
        elevation: 7,
        object: { center: { x: 50, y: 50 } },
        actor: { id: "actor-1", name: "Test Actor" }
      };

      const resultIntersect = await checkAndResolveIntersection(tokenDocumentIntersecting, region);
      assert.strictEqual(resultIntersect, true, "RegionDocument.testPoint should resolve an intersecting token");
      assert.strictEqual(updateCalled, true, "RegionDocument should persist the resolved token ID");
      assert.deepStrictEqual(testedPoints[0], { x: 50, y: 50, elevation: 7 }, "containment must use token center and elevation");

      const tokenDocumentNotIntersecting = {
        id: "tok2",
        x: 0,
        y: 0,
        width: 1,
        height: 1,
        elevation: 2,
        object: { center: { x: 999, y: 999 } },
        actor: { id: "actor-2", name: "Test Actor" }
      };
      assert.strictEqual(
        await checkAndResolveIntersection(tokenDocumentNotIntersecting, region),
        false,
        "a token outside the Region should not resolve"
      );

      let promptCount = 0;
      const concurrentFlags = {
        remainingHitCap: 10,
        saveDC: 5,
        resolvedTokenIds: []
      };
      const concurrentRegion = {
        id: "region-concurrent",
        flags: { cyberpunk2020: { suppressiveFire: concurrentFlags } },
        testPoint: () => true,
        async update(data) {
          // Yield before exposing the persisted record to reproduce overlapping
          // updateToken/moveToken hooks on Foundry V14.
          await Promise.resolve();
          concurrentFlags.resolvedTokenIds = data["flags.cyberpunk2020.suppressiveFire.resolvedTokenIds"];
        }
      };
      const concurrentToken = {
        id: "token-concurrent",
        x: 0,
        y: 0,
        width: 1,
        height: 1,
        elevation: 3,
        object: { center: { x: 50, y: 50 } },
        actor: { id: "actor-concurrent", name: "Concurrent Target" }
      };
      globalThis.ChatMessage = {
        getSpeaker: () => ({}),
        async create() { promptCount += 1; }
      };

      const [firstResolution, overlappingResolution] = await Promise.all([
        checkAndResolveIntersection(concurrentToken, concurrentRegion),
        checkAndResolveIntersection(concurrentToken, concurrentRegion)
      ]);
      assert.strictEqual(firstResolution, true);
      assert.strictEqual(overlappingResolution, false);
      assert.strictEqual(promptCount, 1, "overlapping movement hooks must create one save prompt");

      concurrentFlags.resolvedTokenIds = [];
      promptCount = 0;
      const secondToken = {
        ...concurrentToken,
        id: "token-concurrent-two",
        actor: { id: "actor-concurrent-two", name: "Second Concurrent Target" }
      };
      const [firstTokenResolution, secondTokenResolution] = await Promise.all([
        checkAndResolveIntersection(concurrentToken, concurrentRegion),
        checkAndResolveIntersection(secondToken, concurrentRegion)
      ]);
      assert.strictEqual(firstTokenResolution, true);
      assert.strictEqual(secondTokenResolution, true);
      assert.deepStrictEqual(
        concurrentFlags.resolvedTokenIds.map(record => record.id).sort(),
        ["token-concurrent", "token-concurrent-two"]
      );
      assert.strictEqual(promptCount, 2, "different tokens should queue without losing either resolution record");
      assert.strictEqual(await checkAndResolveIntersection(secondToken, concurrentRegion), false);
      assert.strictEqual(promptCount, 2, "a persisted token resolution must not be prompted again in the same turn");
    } catch (e) {
      console.error(e);
      passed = false;
    } finally {
      globalThis.game = previousGame;
      globalThis.canvas = previousCanvas;
      globalThis.ChatMessage = previousChatMessage;
    }
    addResult("suppressive-fire: V14 Region containment and deduplication", passed);
  }

  async function testTemplateSurvivesAdvanceAwayFromShooter() {
    let passed = true;
    const previousCanvas = globalThis.canvas;
    try {
      let deleted = false;
      let containmentChecks = 0;
      const region = {
        flags: {
          cyberpunk2020: {
            suppressiveFire: {
              shooterTokenId: "shooter-token",
              remainingHitCap: 10,
              resolvedTokenIds: []
            }
          }
        },
        testPoint: () => {
          containmentChecks += 1;
          return false;
        },
        delete: async () => { deleted = true; }
      };

      globalThis.canvas = {
        dimensions: { size: 100 },
        scene: {
          regions: { contents: [region] },
          tokens: { get: () => undefined }
        }
      };

      const combat = {
        combatant: {
          id: "next",
          tokenId: "next-token",
          token: {
            id: "next-token",
            x: 0,
            y: 0,
            width: 1,
            height: 1,
            elevation: 0
          }
        },
        turns: [
          { id: "shooter", tokenId: "shooter-token" },
          {
            id: "next",
            tokenId: "next-token",
            token: {
              id: "next-token",
              x: 0,
              y: 0,
              width: 1,
              height: 1,
              elevation: 0
            }
          }
        ]
      };

      await handleSuppressiveFireCombatTurn(combat, { combatantId: "next", tokenId: "next-token", turn: 1 });

      assert.strictEqual(deleted, false, "Region should survive when turn advances from shooter to next combatant");
      assert.strictEqual(containmentChecks, 1, "active zones must be looked up through Scene.regions");
    } catch (e) {
      console.error(e);
      passed = false;
    } finally {
      globalThis.canvas = previousCanvas;
    }
    addResult("suppressive-fire: Scene Region lookup survives turn advance away from shooter", passed);
  }

  async function testTemplateExpiresWhenShooterTurnStartsAgain() {
    let passed = true;
    const previousCanvas = globalThis.canvas;
    const previousGame = globalThis.game;
    try {
      let deleted = false;
      globalThis.game = { system: { id: "cyberpunk2020-rilerena" } };
      const region = {
        flags: {
          "cyberpunk2020-rilerena": {
            suppressiveFire: {
              shooterTokenId: "shooter-token",
              remainingHitCap: 10,
              resolvedTokenIds: []
            }
          }
        },
        delete: async () => { deleted = true; }
      };

      globalThis.canvas = {
        scene: {
          regions: { contents: [region] },
          tokens: { get: () => undefined }
        }
      };

      const combat = {
        combatant: { id: "shooter", tokenId: "shooter-token" },
        turns: [
          { id: "shooter", tokenId: "shooter-token" },
          { id: "previous", tokenId: "previous-token" }
        ]
      };

      await handleSuppressiveFireCombatTurn(combat, { combatantId: "shooter", tokenId: "shooter-token", turn: 0 });

      assert.strictEqual(deleted, true, "Region should expire when turn advances back to shooter");
    } catch (e) {
      console.error(e);
      passed = false;
    } finally {
      globalThis.canvas = previousCanvas;
      globalThis.game = previousGame;
    }
    addResult("suppressive-fire: Region expires when shooter turn starts again", passed);
  }

  async function testCombatTurnUsesCombatSceneWhenGmViewsAnotherScene() {
    let passed = true;
    const previousCanvas = globalThis.canvas;
    const previousGame = globalThis.game;
    try {
      let combatRegionDeleted = false;
      let viewedRegionDeleted = false;
      const combatRegion = {
        flags: {
          "cyberpunk2020-rilerena": {
            suppressiveFire: { shooterTokenId: "shooter-token", remainingHitCap: 10 }
          }
        },
        delete: async () => { combatRegionDeleted = true; }
      };
      const viewedRegion = {
        flags: {
          "cyberpunk2020-rilerena": {
            suppressiveFire: { shooterTokenId: "shooter-token", remainingHitCap: 10 }
          }
        },
        delete: async () => { viewedRegionDeleted = true; }
      };
      const combatScene = {
        id: "combat-scene",
        regions: { contents: [combatRegion] },
        tokens: { get: () => undefined }
      };
      globalThis.game = {
        system: { id: "cyberpunk2020-rilerena" },
        scenes: { get: id => id === combatScene.id ? combatScene : undefined }
      };
      globalThis.canvas = {
        scene: { id: "viewed-scene", regions: { contents: [viewedRegion] } }
      };

      await handleSuppressiveFireCombatTurn({
        scene: combatScene.id,
        combatant: { id: "shooter", tokenId: "shooter-token" },
        turns: [{ id: "shooter", tokenId: "shooter-token" }]
      }, { combatantId: "shooter", tokenId: "shooter-token", turn: 0 });

      assert.strictEqual(combatRegionDeleted, true, "the Region in the combat Scene should expire");
      assert.strictEqual(viewedRegionDeleted, false, "the GM's viewed Scene must remain untouched");
    } catch(error) {
      console.error(error);
      passed = false;
    } finally {
      globalThis.canvas = previousCanvas;
      globalThis.game = previousGame;
    }
    addResult("suppressive-fire: turn automation resolves the combat Scene", passed);
  }

  async function testFailedSaveDamageUsesPerBulletPipeline() {
    let passed = true;
    try {
      const rolls = [
        { id: "location", formula: "1d10 hit location", total: 4, die: { faces: 10, natural: 4 }, location: "torso" },
        { id: "damage", formula: "4d6", total: 15, die: { faces: 6, natural: 15 } },
        { id: "location", formula: "1d10 hit location", total: 4, die: { faces: 10, natural: 4 }, location: "torso" },
        { id: "damage", formula: "4d6", total: 15, die: { faces: 6, natural: 15 } }
      ];
      let rollIndex = 0;
      const roller = async (request = {}) => {
        const roll = rolls[rollIndex++];
        assert.strictEqual(request.id, roll.id);
        return roll;
      };
      const outcome = await resolveSuppressiveFireDamageOutcome({
        action: {
          type: "ranged",
          fireMode: "Suppressive",
          source: "suppressive-fire-test"
        },
        attacker: {
          actorUuid: "Actor.attacker",
          name: "Solo"
        },
        weapon: {
          itemUuid: "Actor.attacker.Item.rifle",
          name: "Assault Rifle",
          snapshot: {
            damage: "4d6",
            ap: false,
            attackType: "Auto"
          }
        },
        target: {
          actorUuid: "Actor.target",
          tokenUuid: "Scene.test.Token.target",
          name: "Target",
          snapshot: {
            stats: {
              bt: { total: 6 }
            },
            damage: 0,
            hitLocations: {
              torso: { label: "Torso" }
            },
            equippedArmor: [
              {
                id: "armor-vest",
                name: "Kevlar Vest",
                equipped: true,
                system: {
                  coverage: {
                    torso: {
                      sp: 12,
                      ablation: 0,
                      layer: "soft"
                    }
                  }
                }
              }
            ]
          }
        },
        hitCount: 2
      }, {}, roller);

      const plan = planCombatUpdates(outcome);

      assert.strictEqual(rollIndex, rolls.length, "each suppressive hit should roll location and damage separately");
      assert.strictEqual(outcome.targets[0].hits.length, 2, "failed save should produce one hit record per bullet");
      assert.deepStrictEqual(plan.actorUpdates, [
        {
          actorUuid: "Actor.target",
          update: {
            "system.damage": 3
          }
        }
      ]);
      assert.deepStrictEqual(plan.embeddedItemUpdates, [
        {
          actorUuid: "Actor.target",
          type: "Item",
          updates: [
            {
              _id: "armor-vest",
              "system.coverage.torso.ablation": 2
            }
          ]
        }
      ]);
    } catch (e) {
      console.error(e);
      passed = false;
    }
    addResult("suppressive-fire: failed save damage uses per-bullet pipeline", passed);
  }

  async function testChatDamageResolutionCommitsActorDamage() {
    let passed = true;
    const previousGame = globalThis.game;
    const previousUi = globalThis.ui;
    const previousCanvas = globalThis.canvas;
    try {
      const targetState = { system: { damage: 0 } };
      const targetActor = {
        id: "target-actor",
        uuid: "Actor.target",
        name: "Target",
        system: {
          stats: { bt: { total: 6 } },
          damage: 0,
          hitLocations: { torso: { label: "Torso" } }
        },
        itemTypes: {}
      };
      const weaponItem = {
        id: "weapon-1",
        uuid: "Actor.shooter.Item.weapon-1",
        name: "Assault Rifle",
        system: {
          damage: "4d6",
          ap: false,
          attackType: "Auto"
        }
      };
      const shooterActor = {
        id: "shooter-actor",
        uuid: "Actor.shooter",
        name: "Shooter",
        system: {
          stats: {},
          skills: {},
          damage: 0,
          hitLocations: {}
        },
        itemTypes: { weapon: [weaponItem] },
        items: {
          get: (id) => id === "weapon-1" ? weaponItem : undefined
        }
      };
      const actors = new Map([
        ["target-actor", targetActor],
        ["shooter-actor", shooterActor]
      ]);
      globalThis.game = {
        system: { id: "cyberpunk2020-rilerena" },
        user: { id: "gm", isGM: true },
        settings: { get: () => "direct" },
        actors: {
          get: (id) => actors.get(id)
        }
      };
      globalThis.ui = { notifications: { warn: () => {} } };
      globalThis.canvas = {
        dimensions: { distancePixels: 100 },
        scene: {
          regions: {
            get: (id) => id === "template-1" ? {
              id: "template-1",
              uuid: "Scene.test.Region.template-1",
              shapes: [{
                type: "rectangle",
                x: 100,
                y: 100,
                width: 1000,
                height: 200,
                rotation: 30,
                anchorX: 0,
                anchorY: 0.5
              }],
              flags: {
                cyberpunk2020: {
                  suppressiveFire: {
                    shooterActorId: "shooter-actor",
                    weaponItemId: "weapon-1",
                    zoneWidth: 99,
                    maxDistance: 99
                  }
                }
              }
            } : undefined
          }
        }
      };

      const rolls = [
        { id: "location", formula: "1d10 hit location", total: 4, die: { faces: 10, natural: 4 }, location: "torso" },
        { id: "damage", formula: "4d6", total: 8, die: { faces: 6, natural: 8 } }
      ];
      let rollIndex = 0;
      const adapter = {
        async resolveItem() {
          return { update: async () => {} };
        },
        async resolveActor(actorUuid) {
          if (actorUuid !== "Actor.target") return undefined;
          return {
            system: targetState.system,
            async update(update) {
              Object.assign(targetState.system, { damage: update["system.damage"] });
            },
            async updateEmbeddedDocuments() {}
          };
        },
        async renderTemplate(templatePath, data) {
          return `<${data.status}>`;
        },
        async createChatMessage() {
          return "message-1";
        },
        async updateChatMessage() {}
      };

      const result = await resolveSuppressiveFireDamageFromChat({
        templateId: "template-1",
        actorId: "target-actor",
        hits: 1
      }, {
        decision: "confirm",
        adapter,
        roller: async (request = {}) => {
          const roll = rolls[rollIndex++];
          assert.strictEqual(request.id, roll.id);
          return roll;
        }
      });

      assert.strictEqual(result.status, "committed");
      assert.strictEqual(targetState.system.damage, 6);
      assert.strictEqual(rollIndex, rolls.length);
      assert.deepStrictEqual(result.preview.action.hazardZone, {
        kind: "suppressive-fire",
        templateUuid: "Scene.test.Region.template-1",
        templateId: "template-1",
        regionUuid: "Scene.test.Region.template-1",
        regionId: "template-1",
        type: "ray",
        origin: { x: 100, y: 100 },
        direction: 30,
        width: 2,
        distance: 10,
        lifecycle: "persistent"
      }, "damage evidence should derive geometry from a core-converted rectangle Region");
    } catch (e) {
      console.error(e);
      passed = false;
    } finally {
      globalThis.game = previousGame;
      globalThis.ui = previousUi;
      globalThis.canvas = previousCanvas;
    }
    addResult("suppressive-fire: Region evidence and chat damage commit", passed);
  }

  async function testUnlinkedTokenDamageUsesUuidReferences() {
    let passed = true;
    const previousGame = globalThis.game;
    const previousUi = globalThis.ui;
    const previousCanvas = globalThis.canvas;
    const previousChatMessage = globalThis.ChatMessage;
    try {
      const targetActorUuid = "Scene.combat.Token.target.Actor.base-target";
      const targetTokenUuid = "Scene.combat.Token.target";
      const shooterActorUuid = "Scene.combat.Token.shooter.Actor.base-shooter";
      const shooterTokenUuid = "Scene.combat.Token.shooter";
      const weaponUuid = `${shooterActorUuid}.Item.weapon-1`;
      const regionUuid = "Scene.combat.Region.template-1";
      const targetState = { system: { damage: 0 } };
      const targetActor = {
        id: "base-target",
        uuid: targetActorUuid,
        name: "Unlinked Target",
        system: {
          stats: { bt: { total: 6 } },
          damage: 0,
          hitLocations: { torso: { label: "Torso" } }
        },
        itemTypes: {}
      };
      const weaponItem = {
        id: "weapon-1",
        uuid: weaponUuid,
        name: "Synthetic Rifle",
        system: { damage: "4d6", ap: false, attackType: "Auto" }
      };
      const shooterActor = {
        id: "base-shooter",
        uuid: shooterActorUuid,
        name: "Unlinked Shooter",
        system: { stats: {}, damage: 0, hitLocations: {} },
        itemTypes: { weapon: [weaponItem] },
        items: { get: id => id === weaponItem.id ? weaponItem : undefined }
      };
      const targetToken = { id: "target", uuid: targetTokenUuid, actor: targetActor };
      const shooterToken = { id: "shooter", uuid: shooterTokenUuid, actor: shooterActor };
      const region = {
        id: "template-1",
        uuid: regionUuid,
        parent: { dimensions: { distancePixels: 100 } },
        shapes: [{ type: "rectangle", x: 0, y: 0, width: 1000, height: 200, rotation: 0 }],
        flags: {
          "cyberpunk2020-rilerena": {
            suppressiveFire: {
              shooterActorId: shooterActor.id,
              shooterActorUuid,
              shooterTokenId: shooterToken.id,
              shooterTokenUuid,
              weaponItemId: weaponItem.id,
              weaponItemUuid: weaponUuid,
              saveDC: 10,
              remainingHitCap: 10,
              zoneWidth: 2,
              maxDistance: 10
            }
          }
        }
      };
      const documents = new Map([
        [regionUuid, region],
        [targetTokenUuid, targetToken],
        [targetActorUuid, targetActor],
        [shooterTokenUuid, shooterToken],
        [shooterActorUuid, shooterActor],
        [weaponUuid, weaponItem]
      ]);
      let legacyActorLookups = 0;
      globalThis.game = {
        system: { id: "cyberpunk2020-rilerena" },
        user: { id: "gm", isGM: true },
        settings: { get: () => "direct" },
        actors: { get() { legacyActorLookups += 1; return undefined; } },
        scenes: { contents: [] }
      };
      globalThis.ui = { notifications: { warn() {} } };
      globalThis.canvas = {
        dimensions: { distancePixels: 25 },
        scene: { id: "viewed-elsewhere", regions: { get: () => undefined } }
      };
      let promptData;
      globalThis.ChatMessage = {
        getSpeaker: () => ({ alias: targetActor.name }),
        async create(data) { promptData = data; }
      };

      await promptSuppressiveFireSave(targetToken, region);
      assert.match(promptData.content, new RegExp(`data-region-uuid="${regionUuid}"`));
      assert.match(promptData.content, new RegExp(`data-actor-uuid="${targetActorUuid}"`));
      assert.match(promptData.content, new RegExp(`data-token-uuid="${targetTokenUuid}"`));

      const rolls = [
        { id: "location", formula: "1d10 hit location", total: 4, die: { faces: 10, natural: 4 }, location: "torso" },
        { id: "damage", formula: "4d6", total: 8, die: { faces: 6, natural: 8 } }
      ];
      let rollIndex = 0;
      const adapter = {
        async resolveItem() { return { update: async () => {} }; },
        async resolveActor(uuid) {
          assert.strictEqual(uuid, targetActorUuid, "commit must address the synthetic Actor UUID");
          return {
            system: targetState.system,
            async update(update) { targetState.system.damage = update["system.damage"]; },
            async updateEmbeddedDocuments() {}
          };
        },
        async renderTemplate(templatePath, data) { return `<${data.status}>`; },
        async createChatMessage() { return "message-unlinked"; },
        async updateChatMessage() {}
      };

      const result = await resolveSuppressiveFireDamageFromChat({
        templateId: region.id,
        regionUuid,
        actorId: targetActor.id,
        actorUuid: targetActorUuid,
        tokenUuid: targetTokenUuid,
        hits: 1
      }, {
        decision: "confirm",
        adapter,
        fromUuid: async uuid => documents.get(uuid),
        roller: async request => {
          const roll = rolls[rollIndex++];
          assert.strictEqual(request.id, roll.id);
          return roll;
        }
      });

      assert.strictEqual(result.status, "committed");
      assert.strictEqual(targetState.system.damage, 6);
      assert.strictEqual(legacyActorLookups, 0, "UUID resolution must not fall back to the shared base Actor");
      assert.strictEqual(result.preview.targets[0].target.actorUuid, targetActorUuid);
      assert.strictEqual(result.preview.targets[0].target.tokenUuid, targetTokenUuid);
      assert.strictEqual(result.preview.action.hazardZone.width, 2, "Region Scene dimensions must win over the viewed canvas");
    } catch(error) {
      console.error(error);
      passed = false;
    } finally {
      globalThis.game = previousGame;
      globalThis.ui = previousUi;
      globalThis.canvas = previousCanvas;
      globalThis.ChatMessage = previousChatMessage;
    }
    addResult("suppressive-fire: unlinked token UUIDs survive cross-scene chat resolution", passed);
  }

  testSaveDC();
  testTemplateDataBuilder();
  testV14ChatBindingIsGmAuthoritative();
  await testFailedChatLockPreventsSuppressiveHitEffects();
  await testIntersectionLogic();
  await testTemplateSurvivesAdvanceAwayFromShooter();
  await testTemplateExpiresWhenShooterTurnStartsAgain();
  await testCombatTurnUsesCombatSceneWhenGmViewsAnotherScene();
  await testFailedSaveDamageUsesPerBulletPipeline();
  await testChatDamageResolutionCommitsActorDamage();
  await testUnlinkedTokenDamageUsesUuidReferences();
  
  return results;
}
