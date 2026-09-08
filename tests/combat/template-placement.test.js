import assert from "node:assert/strict";

import {
  AOE_TEMPLATE_CHOICE,
  SUPPRESSIVE_TEMPLATE_CHOICE,
  drawAoETemplateAndGetTargets,
  drawAutoshotgunPatternsAndGetTargets,
  promptUseAoETemplate,
  promptUseSuppressiveFireTemplate
} from "../../module/combat/template-placement.js";

export async function runTemplatePlacementTests() {
  const results = [];

  async function testShotgunConeTemplateIsTransient() {
    let passed = true;
    try {
      let createdTemplateDeleted = false;
      const handlers = {};
      const createdDoc = {
        id: "shotgun-template",
        uuid: "Scene.test.MeasuredTemplate.shotgun-template",
        x: 100,
        y: 100,
        direction: 45,
        angle: 45,
        distance: 10,
        delete: async () => { createdTemplateDeleted = true; }
      };
      createdDoc.object = {
        document: createdDoc,
        shape: {
          contains: () => false
        }
      };

      globalThis.game = {
        user: { id: "user-1", color: "#ff0000" }
      };
      globalThis.ui = { notifications: { warn: () => {} } };
      globalThis.Ray = class {
        constructor(origin, destination) {
          this.angle = Math.atan2(destination.y - origin.y, destination.x - origin.x);
          this.distance = Math.hypot(destination.x - origin.x, destination.y - origin.y);
        }
      };
      Math.normalizeDegrees = Math.normalizeDegrees || ((degrees) => ((degrees % 360) + 360) % 360);
      Math.toDegrees = Math.toDegrees || ((radians) => radians * 180 / Math.PI);

      globalThis.CONFIG = {
        MeasuredTemplate: {
          documentClass: class {
            constructor(data) {
              this.data = data;
              this.x = data.x;
              this.y = data.y;
              this.direction = data.direction;
              this.angle = data.angle;
              this.distance = data.distance;
            }
            updateSource(update) {
              Object.assign(this, update);
            }
            toObject() {
              return { ...this.data, direction: this.direction };
            }
          },
          objectClass: class {
            constructor(doc) {
              this.document = doc;
              this.layer = { preview: { addChild: () => {} } };
            }
            async draw() {}
            refresh() {}
            destroy() {}
          }
        }
      };
      globalThis.canvas = {
        ready: true,
        scene: {
          grid: { distance: 1 },
          createEmbeddedDocuments: async () => [createdDoc]
        },
        grid: { size: 100 },
        templates: { preview: { addChild: () => {} } },
        tokens: {
          placeables: []
        },
        stage: {
          on: (event, handler) => { handlers[event] = handler; },
          off: (event) => { delete handlers[event]; }
        },
        app: {
          view: {
            addEventListener: () => {},
            removeEventListener: () => {}
          }
        }
      };

      const promise = drawAoETemplateAndGetTargets(
        { system: { aoe: { type: "cone", value: 10 } } },
        { id: "attacker-token", center: { x: 100, y: 100 } }
      );
      await new Promise(resolve => setTimeout(resolve, 0));
      handlers.pointerdown({
        stopPropagation: () => {}
      });

      const result = await promise;
      assert.equal(result.hazardZone.lifecycle, "transient");
      assert.equal(createdTemplateDeleted, true, "shotgun cone MeasuredTemplate should be deleted after evidence is collected");

      globalThis.canvas.scene.createEmbeddedDocuments = async () => {
        throw new Error("permission denied");
      };
      const failedPlacement = drawAoETemplateAndGetTargets(
        { system: { aoe: { type: "cone", value: 10 } } },
        { id: "attacker-token", center: { x: 100, y: 100 } }
      );
      await new Promise(resolve => setTimeout(resolve, 0));
      handlers.pointerdown({ stopPropagation: () => {} });
      const failedResult = await Promise.race([
        failedPlacement,
        new Promise((_, reject) => setTimeout(() => reject(new Error("failed placement did not settle")), 250))
      ]);
      assert.equal(failedResult.canceled, true, "Foundry API rejection cancels instead of hanging the attack");
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
                  templateUuid: "Scene.test.MeasuredTemplate.autoshotgun-shell-1",
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
            templateUuid: "Scene.test.MeasuredTemplate.autoshotgun-shell-1",
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
                  templateUuid: "Scene.test.MeasuredTemplate.autoshotgun-shell-2",
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
            templateUuid: "Scene.test.MeasuredTemplate.autoshotgun-shell-2",
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
            templateUuid: "Scene.test.MeasuredTemplate.autoshotgun-live",
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
              templateUuid: "Scene.test.MeasuredTemplate.autoshotgun-live",
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
                  templateUuid: "Scene.test.MeasuredTemplate.autoshotgun-empty",
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

  await testShotgunConeTemplateIsTransient();
  await testAutoshotgunPatternsAreCollectedSequentially();
  await testAutoshotgunPatternsSanitizeLiveTargets();
  await testAutoshotgunCanceledPlacementReturnsWarningPattern();
  await testAutoshotgunExplicitCancelAbortsRemainingPatterns();
  await testTemplatePromptsDistinguishNormalAndCancel();

  return results;
}
