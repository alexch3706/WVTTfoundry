import assert from "node:assert/strict";

import {
  AOE_TEMPLATE_CHOICE,
  SUPPRESSIVE_TEMPLATE_CHOICE,
  drawAoETemplateAndGetTargets,
  drawAutoshotgunPatternsAndGetTargets,
  placePersistentSuppressiveFireTemplate,
  promptUseAoETemplate,
  promptUseSuppressiveFireTemplate
} from "../../module/combat/template-placement.js";

export async function runTemplatePlacementTests() {
  const results = [];
  const originalCanvas = globalThis.canvas;
  const originalGame = globalThis.game;
  const originalUi = globalThis.ui;

  async function testShotgunConeTemplateIsTransient() {
    let passed = true;
    try {
      const placementCalls = [];
      const testedPoints = [];
      let warningCount = 0;
      globalThis.game = {
        user: { id: "user-1", color: "#ff0000" }
      };
      globalThis.ui = { notifications: { warn: () => { warningCount += 1; } } };
      globalThis.canvas = {
        ready: true,
        dimensions: { distancePixels: 10, distance: 1, size: 100 },
        level: { id: "level-1" },
        scene: { grid: { distance: 1 } },
        tokens: {
          placeables: [
            { id: "attacker-token", center: { x: 100, y: 100 }, document: { id: "attacker-token", elevation: 0 } },
            { id: "inside-token", center: { x: 200, y: 100 }, document: { id: "inside-token", elevation: 5 } },
            { id: "outside-token", center: { x: 500, y: 100 }, document: { id: "outside-token", elevation: 2 } }
          ]
        },
        regions: {
          placeRegion: async (data, options) => {
            placementCalls.push({ data, options });
            const shape = {
              ...data.shapes[0],
              updateSource(update) {
                Object.assign(this, update);
              }
            };
            const moveResult = options.onMove({
              shape,
              position: { x: 200, y: 200 },
              preview: { renderFlags: { set: () => {} } }
            });
            assert.equal(moveResult, false);
            return {
              id: "shotgun-region",
              uuid: "Scene.test.Region.shotgun-region",
              shapes: [shape],
              testPoint(point) {
                testedPoints.push(point);
                return point.x < 300;
              }
            };
          }
        }
      };

      const result = await drawAoETemplateAndGetTargets(
        { name: "Shotgun", system: { aoe: { type: "cone", value: 10 } } },
        { id: "attacker-token", center: { x: 100, y: 100 } }
      );
      assert.equal(placementCalls.length, 1);
      assert.equal(placementCalls[0].options.create, false, "shotgun AoE uses an ephemeral RegionDocument");
      assert.equal(placementCalls[0].data.shapes[0].type, "cone");
      assert.equal(placementCalls[0].data.shapes[0].radius, 100, "Scene units are converted to pixels");
      assert.deepEqual(testedPoints, [
        { x: 200, y: 100, elevation: 5 },
        { x: 500, y: 100, elevation: 2 }
      ], "RegionDocument.testPoint receives token center and elevation; the directional attacker is excluded");
      assert.deepEqual(result.affectedTargets.map(token => token.id), ["inside-token"]);
      assert.equal(result.hazardZone.lifecycle, "transient");
      assert.equal(result.hazardZone.templateId, "shotgun-region", "legacy evidence aliases remain available");
      assert.equal(result.hazardZone.regionId, "shotgun-region", "Region identity is exposed explicitly");
      assert.equal(result.hazardZone.templateUuid, "Scene.test.Region.shotgun-region");
      assert.equal(result.affectedTargets[0].tactical.template.targetDistance, 10);
      assert.equal(result.affectedTargets[0].tactical.template.direction, 45);

      globalThis.canvas.regions.placeRegion = async () => null;
      const canceledResult = await drawAoETemplateAndGetTargets(
        { system: { aoe: { type: "cone", value: 10 } } },
        { id: "attacker-token", center: { x: 100, y: 100 } }
      );
      assert.equal(canceledResult.canceled, true, "Foundry Region cancellation cancels the attack");

      globalThis.canvas.regions.placeRegion = async () => {
        throw new Error("permission denied");
      };
      const failedResult = await drawAoETemplateAndGetTargets(
        { system: { aoe: { type: "cone", value: 10 } } },
        { id: "attacker-token", center: { x: 100, y: 100 } }
      );
      assert.equal(failedResult.canceled, true, "Foundry API rejection cancels instead of hanging the attack");
      assert.equal(warningCount, 1, "API failures notify the user but ordinary cancellation does not");
    } catch (e) {
      console.error(e);
      passed = false;
    }
    results.push({ name: "template-placement: shotgun cone template is transient", passed });
  }

  async function testAutoshotgunPatternsAreCollectedSequentially() {
    let passed = true;
    try {
      const calls = [];
      const placements = [
        {
          affectedTargets: [
            {
              id: "target-shell-1",
              tactical: {
                template: {
                  templateUuid: "Scene.test.Region.autoshotgun-shell-1",
                  templateId: "autoshotgun-shell-1",
                  type: "cone",
                  origin: { x: 0, y: 0 },
                  direction: 0,
                  angle: 45,
                  distance: 20,
                  targetDistance: 12,
                  inclusion: "intersected"
                }
              }
            }
          ],
          hazardZone: {
            templateUuid: "Scene.test.Region.autoshotgun-shell-1",
            templateId: "autoshotgun-shell-1",
            type: "cone",
            origin: { x: 0, y: 0 },
            direction: 0,
            angle: 45,
            distance: 20,
            inclusion: "intersected"
          }
        },
        {
          affectedTargets: [
            {
              id: "target-shell-2",
              tactical: {
                template: {
                  templateUuid: "Scene.test.Region.autoshotgun-shell-2",
                  templateId: "autoshotgun-shell-2",
                  type: "cone",
                  origin: { x: 0.5, y: 0 },
                  direction: 0,
                  angle: 45,
                  distance: 20,
                  targetDistance: 12,
                  inclusion: "intersected"
                }
              }
            }
          ],
          hazardZone: {
            templateUuid: "Scene.test.Region.autoshotgun-shell-2",
            templateId: "autoshotgun-shell-2",
            type: "cone",
            origin: { x: 0.5, y: 0 },
            direction: 0,
            angle: 45,
            distance: 20,
            inclusion: "intersected"
          }
        }
      ];

      const result = await drawAutoshotgunPatternsAndGetTargets(
        { name: "CAWS", system: { aoe: { type: "cone", value: 20 } } },
        { id: "attacker-token" },
        2,
        {
          drawPattern: async (item, attackerToken, shellIndex) => {
            calls.push({ item, attackerToken, shellIndex });
            return placements[shellIndex - 1];
          }
        }
      );

      assert.equal(calls.length, 2, "autoshotgun placement calls drawPattern once per shell");
      assert.deepEqual(calls.map(call => call.shellIndex), [1, 2], "autoshotgun placement passes shell indexes in order");
      assert.equal(result.patterns.length, 2, "autoshotgun placement returns one pattern per shell");
      assert.equal(result.patterns[0].shellIndex, 1);
      assert.equal(result.patterns[0].template.templateId, "autoshotgun-shell-1");
      assert.equal(result.patterns[0].affectedTargets[0].id, "target-shell-1");
      assert.equal(result.patterns[1].shellIndex, 2);
      assert.equal(result.patterns[1].template.templateId, "autoshotgun-shell-2");
      assert.equal(result.patterns[1].affectedTargets[0].id, "target-shell-2");
    } catch (e) {
      console.error(e);
      passed = false;
    }
    results.push({ name: "template-placement: autoshotgun patterns are collected sequentially", passed });
  }

  async function testAutoshotgunPatternsSanitizeLiveTargets() {
    let passed = true;
    try {
      const liveTarget = {
        id: "live-target",
        uuid: "Scene.test.Token.live-target",
        name: "Live Target",
        actor: { uuid: "Actor.live-target" },
        document: { uuid: "Scene.test.Token.live-target" },
        center: { x: 100, y: 120 },
        distance: { value: 8, units: "m", source: "template" },
        tactical: {
          template: {
            templateUuid: "Scene.test.Region.autoshotgun-live",
            templateId: "autoshotgun-live",
            type: "cone",
            origin: { x: 0, y: 0 },
            direction: 0,
            angle: 45,
            distance: 20,
            targetDistance: 8,
            inclusion: "intersected"
          }
        }
      };
      liveTarget.parent = liveTarget;

      const result = await drawAutoshotgunPatternsAndGetTargets(
        { name: "CAWS", system: { aoe: { type: "cone", value: 20 } } },
        { id: "attacker-token" },
        1,
        {
          drawPattern: async () => ({
            affectedTargets: [liveTarget],
            hazardZone: {
              templateUuid: "Scene.test.Region.autoshotgun-live",
              templateId: "autoshotgun-live",
              type: "cone",
              origin: { x: 0, y: 0 },
              direction: 0,
              angle: 45,
              distance: 20,
              inclusion: "intersected"
            }
          })
        }
      );

      assert.doesNotThrow(() => JSON.stringify(result.patterns), "autoshotgun patterns should be JSON-safe after placement");
      assert.equal(result.patterns[0].affectedTargets[0].id, "live-target");
      assert.equal(result.patterns[0].affectedTargets[0].actorUuid, "Actor.live-target");
      assert.equal(result.patterns[0].affectedTargets[0].tokenUuid, "Scene.test.Token.live-target");
      assert.deepEqual(result.patterns[0].affectedTargets[0].distance, { value: 8, units: "m", source: "template" });
      assert.equal(result.patterns[0].affectedTargets[0].tactical.template.templateId, "autoshotgun-live");
      assert.equal(result.patterns[0].affectedTargets[0].parent, undefined, "live token object graph should not leak into pattern evidence");
    } catch (e) {
      console.error(e);
      passed = false;
    }
    results.push({ name: "template-placement: autoshotgun patterns sanitize live targets", passed });
  }

  async function testAutoshotgunCanceledPlacementReturnsWarningPattern() {
    let passed = true;
    try {
      const result = await drawAutoshotgunPatternsAndGetTargets(
        { name: "CAWS", system: { aoe: { type: "cone", value: 20 } } },
        { id: "attacker-token" },
        2,
        {
          drawPattern: async (_item, _attackerToken, shellIndex) => shellIndex === 1
            ? {
                affectedTargets: [],
                hazardZone: {
                  templateUuid: "Scene.test.Region.autoshotgun-empty",
                  templateId: "autoshotgun-empty",
                  type: "cone",
                  origin: { x: 0, y: 0 },
                  direction: 0,
                  angle: 45,
                  distance: 20,
                  inclusion: "intersected"
                }
              }
            : []
        }
      );

      assert.equal(result.patterns.length, 2, "autoshotgun placement preserves declared shell count");
      assert.equal(result.patterns[0].shellIndex, 1);
      assert.equal(result.patterns[0].template.templateId, "autoshotgun-empty", "empty zone keeps hazard-zone evidence");
      assert.equal(result.patterns[0].warnings, undefined, "empty but placed zone does not warn");
      assert.equal(result.patterns[1].shellIndex, 2);
      assert.equal(result.patterns[1].template, undefined, "canceled shell has no template evidence");
      assert.ok(result.patterns[1].warnings.some(warning => warning.code === "autoshotgun-pattern-canceled"), "canceled shell returns warning evidence");
    } catch (e) {
      console.error(e);
      passed = false;
    }
    results.push({ name: "template-placement: autoshotgun canceled placement returns warning pattern", passed });
  }

  async function testAutoshotgunExplicitCancelAbortsRemainingPatterns() {
    let passed = true;
    try {
      const calls = [];
      const result = await drawAutoshotgunPatternsAndGetTargets(
        { name: "CAWS", system: { aoe: { type: "cone", value: 20 } } },
        { id: "attacker-token" },
        3,
        {
          drawPattern: async (item, attackerToken, shellIndex) => {
            calls.push(shellIndex);
            return { affectedTargets: [], canceled: true };
          }
        }
      );

      assert.equal(result.canceled, true, "an explicit placement cancellation cancels the attack");
      assert.equal(result.canceledShellIndex, 1);
      assert.deepEqual(result.patterns, [], "a canceled pattern is not treated as attack evidence");
      assert.deepEqual(calls, [1], "remaining shell templates are not requested after cancellation");
    } catch (e) {
      console.error(e);
      passed = false;
    }
    results.push({ name: "template-placement: explicit autoshotgun cancel aborts remaining patterns", passed });
  }

  async function testSuppressiveFireCreatesPersistentAnchoredRegion() {
    let passed = true;
    try {
      const placementCalls = [];
      let warningCount = 0;
      globalThis.game = {
        user: { id: "user-1", color: "#ff0000" },
        combat: { id: "combat-1", round: 3, turn: 2 }
      };
      globalThis.ui = { notifications: { warn: () => { warningCount += 1; } } };
      globalThis.canvas = {
        ready: true,
        dimensions: { distancePixels: 20, distance: 1, size: 100 },
        level: { id: "level-1" },
        scene: { grid: { distance: 1 } },
        regions: {
          placeRegion: async (data, options) => {
            placementCalls.push({ data, options });
            const shape = {
              ...data.shapes[0],
              updateSource(update) {
                Object.assign(this, update);
              }
            };
            options.onMove({
              shape,
              position: { x: 100, y: 200 },
              preview: { renderFlags: { set: () => {} } }
            });
            assert.deepEqual(
              { x: shape.x, y: shape.y, rotation: shape.rotation },
              { x: 100, y: 100, rotation: 90 },
              "pointer movement rotates the line while keeping it anchored to the attacker"
            );
            return { id: "suppressive-region", uuid: "Scene.test.Region.suppressive-region" };
          }
        }
      };

      const placed = await placePersistentSuppressiveFireTemplate(
        { id: "attacker-token", center: { x: 100, y: 100 }, actor: { id: "actor-1" } },
        { id: "weapon-1", system: { damage: "3d6" } },
        12,
        2,
        20
      );
      assert.equal(placed, true);
      assert.equal(placementCalls[0].options.create, true, "suppressive-fire Regions persist in the Scene");
      assert.deepEqual(placementCalls[0].data.shapes[0], {
        type: "line",
        x: 100,
        y: 100,
        length: 400,
        width: 40,
        rotation: 0,
        gridBased: false
      });
      assert.equal(placementCalls[0].data.flags.cyberpunk2020.suppressiveFire.saveDC, 6);
      assert.equal(placementCalls[0].data.flags.cyberpunk2020.suppressiveFire.createdRound, 3);

      globalThis.canvas.regions.placeRegion = async () => null;
      assert.equal(await placePersistentSuppressiveFireTemplate(
        { id: "attacker-token", center: { x: 100, y: 100 }, actor: { id: "actor-1" } },
        { id: "weapon-1", system: { damage: "3d6" } },
        12,
        2,
        20
      ), false, "canceling Region placement does not create a suppressive-fire zone");

      globalThis.canvas.regions.placeRegion = async () => { throw new Error("permission denied"); };
      assert.equal(await placePersistentSuppressiveFireTemplate(
        { id: "attacker-token", center: { x: 100, y: 100 }, actor: { id: "actor-1" } },
        { id: "weapon-1", system: { damage: "3d6" } },
        12,
        2,
        20
      ), false, "Region API errors settle the placement as failed");
      assert.equal(warningCount, 1);
    } catch(e) {
      console.error(e);
      passed = false;
    }
    results.push({ name: "template-placement: suppressive fire creates a persistent anchored Region", passed });
  }

  async function testTemplatePromptsDistinguishNormalAndCancel() {
    let passed = true;
    const OriginalDialog = globalThis.Dialog;
    try {
      let dialogConfig;
      globalThis.Dialog = class {
        constructor(config) {
          dialogConfig = config;
        }
        render() {
          return this;
        }
      };

      const normalPromise = promptUseAoETemplate({ system: { aoe: { type: "cone" } } });
      dialogConfig.buttons.normal.callback();
      assert.equal(await normalPromise, AOE_TEMPLATE_CHOICE.normal);

      const cancelPromise = promptUseAoETemplate({ system: { aoe: { type: "cone" } } });
      dialogConfig.close();
      assert.equal(await cancelPromise, AOE_TEMPLATE_CHOICE.canceled);

      const suppressiveNormalPromise = promptUseSuppressiveFireTemplate({}, 10);
      dialogConfig.buttons.normal.callback();
      assert.deepEqual(await suppressiveNormalPromise, { choice: SUPPRESSIVE_TEMPLATE_CHOICE.normal });

      const suppressiveCancelPromise = promptUseSuppressiveFireTemplate({}, 10);
      dialogConfig.buttons.cancel.callback();
      assert.deepEqual(await suppressiveCancelPromise, { choice: SUPPRESSIVE_TEMPLATE_CHOICE.canceled });

      const suppressiveClampPromise = promptUseSuppressiveFireTemplate({}, 10);
      dialogConfig.buttons.template.callback({
        find: selector => ({ val: () => selector === "#suppressiveRounds" ? "999" : "0" })
      });
      assert.deepEqual(await suppressiveClampPromise, {
        choice: SUPPRESSIVE_TEMPLATE_CHOICE.template,
        roundsFired: 10,
        zoneWidth: 1
      }, "suppressive values are bounded independently of HTML validation");
    } catch (e) {
      console.error(e);
      passed = false;
    } finally {
      globalThis.Dialog = OriginalDialog;
    }
    results.push({ name: "template-placement: prompts distinguish normal roll from cancel attack", passed });
  }

  try {
    await testShotgunConeTemplateIsTransient();
    await testAutoshotgunPatternsAreCollectedSequentially();
    await testAutoshotgunPatternsSanitizeLiveTargets();
    await testAutoshotgunCanceledPlacementReturnsWarningPattern();
    await testAutoshotgunExplicitCancelAbortsRemainingPatterns();
    await testSuppressiveFireCreatesPersistentAnchoredRegion();
    await testTemplatePromptsDistinguishNormalAndCancel();
  } finally {
    globalThis.canvas = originalCanvas;
    globalThis.game = originalGame;
    globalThis.ui = originalUi;
  }

  return results;
}
