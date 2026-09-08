import assert from "assert";
import { bindSuppressiveFireChatActions, calculateSuppressiveFireSaveDC, buildSuppressiveFireTemplateData, canRetrySuppressiveDamageResolution, handleSuppressiveFireCombatTurn, resolveSuppressiveFireDamageFromChat } from "../../module/combat/suppressive-fire-tracker.js";
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
    } catch (e) {
      console.error(e);
      passed = false;
    }
    addResult("suppressive-fire: Save DC calculation", passed);
  }

  function testTemplateDataBuilder() {
    let passed = true;
    try {
      const data = buildSuppressiveFireTemplateData({
        attackerTokenId: "t1",
        attackerActorId: "a1",
        weaponItemId: "w1",
        damageFormula: "2d6",
        bulletsFired: 20,
        zoneWidth: 2,
        maxDistance: 10,
        origin: {x: 100, y: 100},
        combatRound: 1,
        combatTurn: 2,
        combatId: "c1"
      });

      assert.strictEqual(data.t, "ray");
      assert.strictEqual(data.distance, 10);
      assert.strictEqual(data.width, 2);
      
      const flags = data.flags?.cyberpunk2020?.suppressiveFire;
      assert.ok(flags, "Flags must be defined");
      assert.strictEqual(flags.shooterActorId, "a1");
      assert.strictEqual(flags.shooterTokenId, "t1");
      assert.strictEqual(flags.weaponItemId, "w1");
      assert.strictEqual(flags.damageFormula, "2d6");
      assert.strictEqual(flags.bulletsFired, 20);
      assert.strictEqual(flags.remainingHitCap, 20);
      assert.strictEqual(flags.saveDC, 10); // 20 / 2
      assert.strictEqual(flags.zoneWidth, 2);
      assert.strictEqual(flags.createdCombatId, "c1");
      assert.strictEqual(flags.createdRound, 1);
      assert.strictEqual(flags.createdTurn, 2);
      assert.deepStrictEqual(flags.resolvedTokenIds, []);
    } catch(e) {
      console.error(e);
      passed = false;
    }
    addResult("suppressive-fire: Template data builder", passed);
  }

  function testCrossVersionChatBindingIsGmAuthoritative() {
    let passed = true;
    const previousGame = globalThis.game;
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
      assert.strictEqual(playerHits.disabled, true, "non-GM V13 chat actions should be disabled");
      assert.strictEqual(playerDamage.disabled, true, "non-GM damage actions should be disabled");

      globalThis.game.user = { id: "gm", isGM: true };
      bindSuppressiveFireChatActions({ getFlag: () => undefined }, makeRoot(playerHits, playerDamage));
      assert.strictEqual(playerHits.disabled, false, "an existing hit action should refresh for the new primary GM");
      assert.strictEqual(playerDamage.disabled, false, "an existing damage action should refresh for the new primary GM");

      const gmHits = makeButton({ templateId: "template", actorId: "actor" });
      const gmDamage = makeButton({ templateId: "template", actorId: "actor", hits: "2" });
      bindSuppressiveFireChatActions({ getFlag: () => undefined }, [makeRoot(gmHits, gmDamage)]);
      assert.strictEqual(gmHits.disabled, false, "primary GM V12 chat actions should remain enabled");
      assert.strictEqual(typeof gmHits.listeners.click, "function");
      assert.strictEqual(typeof gmDamage.listeners.click, "function");
    } catch(error) {
      console.error(error);
      passed = false;
    } finally {
      globalThis.game = previousGame;
    }
    addResult("suppressive-fire: V12/V13 chat actions are GM-authoritative", passed);
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
        scene: {
          templates: {
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
    try {
        const { checkAndResolveIntersection } = await import("../../module/combat/suppressive-fire-tracker.js");
        globalThis.game = { combat: { id: "c1", round: 1, turn: 1 } };
        
        let updateCalled = false;
        const template = {
            document: {
                x: 0,
                y: 0,
                flags: {
                    cyberpunk2020: {
                        suppressiveFire: {
                            remainingHitCap: 10,
                            saveDC: 15,
                            resolvedTokenIds: []
                        }
                    }
                },
                update: async (data) => { updateCalled = true; }
            },
            shape: {
                contains: (x, y) => { return x === 50 && y === 50; } // mocks intersection
            }
        };

        const tokenDocumentIntersecting = {
            id: "tok1",
            x: 0, y: 0, width: 1, height: 1,
            object: { center: { x: 50, y: 50 } },
            actor: { name: "Test Actor" }
        };

        const resultIntersect = await checkAndResolveIntersection(tokenDocumentIntersecting, template);
        assert.ok(resultIntersect, "Should return true for intersecting token");
        assert.ok(updateCalled, "Template should be updated with new resolved token ID");

        // Now test non-intersecting
        const tokenDocumentNotIntersecting = {
            id: "tok2",
            x: 0, y: 0, width: 1, height: 1,
            object: { center: { x: 999, y: 999 } },
            actor: { name: "Test Actor" }
        };
        const resultNotIntersect = await checkAndResolveIntersection(tokenDocumentNotIntersecting, template);
        assert.strictEqual(resultNotIntersect, false, "Should return false for non-intersecting token");

        const previousChatMessage = globalThis.ChatMessage;
        let promptCount = 0;
        try {
          const concurrentFlags = {
            remainingHitCap: 10,
            saveDC: 5,
            resolvedTokenIds: []
          };
          const concurrentTemplate = {
            document: {
              id: "template-concurrent",
              x: 0,
              y: 0,
              flags: { cyberpunk2020: { suppressiveFire: concurrentFlags } },
              async update(data) {
                // Yield before exposing the persisted record to reproduce
                // overlapping updateToken/moveToken hooks on Foundry V13.
                await Promise.resolve();
                concurrentFlags.resolvedTokenIds = data["flags.cyberpunk2020.suppressiveFire.resolvedTokenIds"];
              }
            },
            shape: { contains: () => true }
          };
          const concurrentToken = {
            id: "token-concurrent",
            x: 0,
            y: 0,
            width: 1,
            height: 1,
            object: { center: { x: 50, y: 50 } },
            actor: { id: "actor-concurrent", name: "Concurrent Target" }
          };
          globalThis.ChatMessage = {
            getSpeaker: () => ({}),
            async create() { promptCount += 1; }
          };

          const [firstResolution, overlappingResolution] = await Promise.all([
            checkAndResolveIntersection(concurrentToken, concurrentTemplate),
            checkAndResolveIntersection(concurrentToken, concurrentTemplate)
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
            checkAndResolveIntersection(concurrentToken, concurrentTemplate),
            checkAndResolveIntersection(secondToken, concurrentTemplate)
          ]);
          assert.strictEqual(firstTokenResolution, true);
          assert.strictEqual(secondTokenResolution, true);
          assert.deepStrictEqual(
            concurrentFlags.resolvedTokenIds.map(record => record.id).sort(),
            ["token-concurrent", "token-concurrent-two"]
          );
          assert.strictEqual(promptCount, 2, "different tokens should queue without losing either resolution record");
          assert.strictEqual(await checkAndResolveIntersection(secondToken, concurrentTemplate), false);
          assert.strictEqual(promptCount, 2, "a persisted token resolution must not be prompted again in the same turn");
        } finally {
          globalThis.ChatMessage = previousChatMessage;
        }

    } catch (e) {
        console.error(e);
        passed = false;
    }
    addResult("suppressive-fire: Intersection logic and deduplication", passed);
  }

  async function testTemplateSurvivesAdvanceAwayFromShooter() {
    let passed = true;
    try {
      let deleted = false;
      const template = {
        document: {
          flags: {
            cyberpunk2020: {
              suppressiveFire: {
                shooterTokenId: "shooter-token",
                remainingHitCap: 10,
                resolvedTokenIds: []
              }
            }
          },
          delete: async () => { deleted = true; }
        }
      };

      globalThis.canvas = {
        templates: { placeables: [template] },
        tokens: {
          get: () => undefined
        }
      };

      const combat = {
        combatant: { tokenId: "shooter-token" },
        turns: [
          { tokenId: "shooter-token" },
          { tokenId: "next-token" }
        ]
      };

      await handleSuppressiveFireCombatTurn(combat, { turn: 1 });

      assert.strictEqual(deleted, false, "template should survive when turn advances from shooter to next combatant");
    } catch (e) {
      console.error(e);
      passed = false;
    }
    addResult("suppressive-fire: template survives turn advance away from shooter", passed);
  }

  async function testTemplateExpiresWhenShooterTurnStartsAgain() {
    let passed = true;
    try {
      let deleted = false;
      const template = {
        document: {
          flags: {
            cyberpunk2020: {
              suppressiveFire: {
                shooterTokenId: "shooter-token",
                remainingHitCap: 10,
                resolvedTokenIds: []
              }
            }
          },
          delete: async () => { deleted = true; }
        }
      };

      globalThis.canvas = {
        templates: { placeables: [template] },
        tokens: {
          get: () => undefined
        }
      };

      const combat = {
        combatant: { tokenId: "previous-token" },
        turns: [
          { tokenId: "shooter-token" },
          { tokenId: "previous-token" }
        ]
      };

      await handleSuppressiveFireCombatTurn(combat, { turn: 0 });

      assert.strictEqual(deleted, true, "template should expire when turn advances back to shooter");
    } catch (e) {
      console.error(e);
      passed = false;
    }
    addResult("suppressive-fire: template expires when shooter turn starts again", passed);
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
        scene: {
          templates: {
            get: (id) => id === "template-1" ? {
              id: "template-1",
              uuid: "Scene.test.MeasuredTemplate.template-1",
              t: "ray",
              x: 100,
              y: 100,
              direction: 0,
              distance: 10,
              flags: {
                cyberpunk2020: {
                  suppressiveFire: {
                    shooterActorId: "shooter-actor",
                    weaponItemId: "weapon-1",
                    zoneWidth: 2
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
    } catch (e) {
      console.error(e);
      passed = false;
    }
    addResult("suppressive-fire: chat damage resolution commits actor damage", passed);
  }

  testSaveDC();
  testTemplateDataBuilder();
  testCrossVersionChatBindingIsGmAuthoritative();
  await testFailedChatLockPreventsSuppressiveHitEffects();
  await testIntersectionLogic();
  await testTemplateSurvivesAdvanceAwayFromShooter();
  await testTemplateExpiresWhenShooterTurnStartsAgain();
  await testFailedSaveDamageUsesPerBulletPipeline();
  await testChatDamageResolutionCommitsActorDamage();
  
  return results;
}
