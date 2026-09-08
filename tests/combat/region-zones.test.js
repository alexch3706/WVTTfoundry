import assert from "node:assert/strict";

import {
  buildAoERegionData,
  buildSuppressiveFireRegionData,
  getPrimaryRegionShape,
  getRegionDocument,
  getTokenCenter,
  pixelsToSceneUnits,
  placeCombatRegion,
  regionContainsToken,
  sceneUnitsToPixels
} from "../../module/combat/region-zones.js";

export async function runRegionZoneTests() {
  const results = [];
  const originalCanvas = globalThis.canvas;
  const originalGame = globalThis.game;
  const originalConst = globalThis.CONST;

  async function run(name, test) {
    let passed = true;
    try {
      await test();
    } catch(error) {
      console.error(error);
      passed = false;
    }
    results.push({ name: `region-zones: ${name}`, passed });
  }

  try {
    globalThis.game = { user: { id: "user-1", color: "#12ab34" } };
    globalThis.CONST = {
      DOCUMENT_OWNERSHIP_LEVELS: { OWNER: 3 },
      REGION_VISIBILITY: { ALWAYS: 2 }
    };
    globalThis.canvas = {
      ready: true,
      dimensions: { distancePixels: 20, distance: 5, size: 100 },
      level: { id: "level-1" },
      scene: { grid: { distance: 5 } }
    };

    await run("maps AoE geometry to V14 Region shapes", async () => {
      assert.equal(sceneUnitsToPixels(3.5), 70);
      assert.equal(pixelsToSceneUnits(70), 3.5);

      const cone = buildAoERegionData({
        type: "cone",
        distance: 10,
        angle: 60,
        origin: { x: 100, y: 200 }
      });
      assert.deepEqual(cone.shapes[0], {
        type: "cone",
        x: 100,
        y: 200,
        radius: 200,
        angle: 60,
        rotation: 0,
        curvature: "flat",
        gridBased: false
      });

      const circle = buildAoERegionData({ type: "circle", distance: 8, origin: { x: 5, y: 6 } });
      assert.deepEqual(circle.shapes[0], {
        type: "circle",
        x: 5,
        y: 6,
        radius: 160,
        gridBased: false
      });

      const rectangle = buildAoERegionData({
        type: "rect",
        distance: 10,
        width: 6,
        height: 4,
        origin: { x: 10, y: 20 }
      });
      assert.deepEqual(rectangle.shapes[0], {
        type: "rectangle",
        x: 10,
        y: 20,
        width: 120,
        height: 80,
        rotation: 0,
        anchorX: 0.5,
        anchorY: 0.5,
        gridBased: false
      });

      const line = buildAoERegionData({ type: "ray", distance: 12, width: 2, origin: { x: 7, y: 9 } });
      assert.deepEqual(line.shapes[0], {
        type: "line",
        x: 7,
        y: 9,
        length: 240,
        width: 40,
        rotation: 0,
        gridBased: false
      });
      assert.equal(line.flags.cyberpunk2020.combatRegion.templateType, "ray");
      assert.deepEqual(line.levels, ["level-1"]);
      assert.deepEqual(line.ownership, { "user-1": 3 });
      assert.equal(line.visibility, 2);
      assert.throws(
        () => buildAoERegionData({ type: "burst", distance: 10, origin: { x: 0, y: 0 } }),
        /Unsupported Area-of-Effect type/
      );

      globalThis.canvas.level = null;
      const baseLevelCircle = buildAoERegionData({ type: "circle", distance: 5, origin: { x: 0, y: 0 } });
      assert.deepEqual(baseLevelCircle.levels, [], "the base Scene level must not be represented by an invalid null ID");
      globalThis.canvas.level = { id: "level-1" };
    });

    await run("builds a persistent suppressive-fire line", async () => {
      const data = buildSuppressiveFireRegionData({
        attackerTokenId: "token-1",
        attackerActorId: "actor-1",
        weaponItemId: "weapon-1",
        damageFormula: "4d6",
        bulletsFired: 18,
        zoneWidth: 3,
        maxDistance: 30,
        origin: { x: 300, y: 400 },
        combatRound: 5,
        combatTurn: 2,
        combatId: "combat-1"
      });

      assert.deepEqual(data.shapes[0], {
        type: "line",
        x: 300,
        y: 400,
        length: 600,
        width: 60,
        rotation: 0,
        gridBased: false
      });
      assert.deepEqual(data.flags.cyberpunk2020.suppressiveFire, {
        shooterActorId: "actor-1",
        shooterTokenId: "token-1",
        weaponItemId: "weapon-1",
        damageFormula: "4d6",
        bulletsFired: 18,
        remainingHitCap: 18,
        saveDC: 6,
        zoneWidth: 3,
        maxDistance: 30,
        createdCombatId: "combat-1",
        createdRound: 5,
        createdTurn: 2,
        expiresAtRound: 6,
        expiresAtTurn: 2,
        resolvedTokenIds: []
      });
    });

    await run("tests token centers and elevations with RegionDocument.testPoint", async () => {
      const testedPoints = [];
      const regionDocument = {
        shapes: [{ type: "circle", radius: 100 }],
        testPoint: point => {
          testedPoints.push(point);
          return point.elevation === 7;
        }
      };
      const regionPlaceable = { document: regionDocument };
      const tokenPlaceable = {
        center: { x: 125, y: 175 },
        document: { elevation: 7 }
      };

      assert.equal(getRegionDocument(regionPlaceable), regionDocument);
      assert.equal(getPrimaryRegionShape(regionPlaceable), regionDocument.shapes[0]);
      assert.equal(regionContainsToken(regionPlaceable, tokenPlaceable), true);
      assert.deepEqual(testedPoints[0], { x: 125, y: 175, elevation: 7 });

      const unrenderedToken = { x: 100, y: 200, width: 2, height: 1, elevation: 7 };
      assert.deepEqual(getTokenCenter(unrenderedToken), { x: 200, y: 250 });
      assert.equal(regionContainsToken(regionDocument, unrenderedToken), true);
      assert.deepEqual(testedPoints[1], { x: 200, y: 250, elevation: 7 });

      assert.equal(regionContainsToken({ testPoint: () => { throw new Error("bad geometry"); } }, tokenPlaceable), false);
      assert.equal(regionContainsToken(null, tokenPlaceable), false);
    });

    await run("places anchored Regions through the public RegionLayer API", async () => {
      const calls = [];
      const returnedDocument = { id: "region-1" };
      globalThis.canvas.regions = {
        placeRegion: async (data, options) => {
          calls.push({ data, options });
          return returnedDocument;
        }
      };
      const data = buildAoERegionData({ type: "cone", distance: 10, origin: { x: 10, y: 20 } });
      const placed = await placeCombatRegion(data, {
        create: false,
        anchorOrigin: { x: 10, y: 20 }
      });

      assert.equal(placed, returnedDocument);
      assert.equal(calls[0].options.create, false);
      assert.equal(calls[0].options.allowRotation, false);
      const shape = {
        updateSource(update) {
          Object.assign(this, update);
        }
      };
      let renderFlags;
      const moveResult = calls[0].options.onMove({
        shape,
        position: { x: 20, y: 30 },
        preview: { renderFlags: { set: flags => { renderFlags = flags; } } }
      });
      assert.equal(moveResult, false, "custom movement replaces Foundry's translating movement");
      assert.deepEqual({ x: shape.x, y: shape.y, rotation: shape.rotation }, { x: 10, y: 20, rotation: 45 });
      assert.deepEqual(renderFlags, { refreshGeometry: true });

      globalThis.canvas.regions.placeRegion = async (_data, options) => {
        assert.equal(options.create, true);
        return null;
      };
      assert.equal(await placeCombatRegion(data, { create: true }), null, "Foundry cancellation remains null");
    });

    await run("reports placement precondition and API errors", async () => {
      const data = buildAoERegionData({ type: "circle", distance: 5, origin: { x: 0, y: 0 } });
      globalThis.canvas.regions = { placeRegion: async () => { throw new Error("permission denied"); } };
      await assert.rejects(() => placeCombatRegion(data), /permission denied/);

      globalThis.canvas.ready = false;
      await assert.rejects(() => placeCombatRegion(data), /Canvas is not ready/);
      globalThis.canvas.ready = true;
      globalThis.canvas.regions = undefined;
      await assert.rejects(() => placeCombatRegion(data), /Region placement API is unavailable/);
    });
  } finally {
    globalThis.canvas = originalCanvas;
    globalThis.game = originalGame;
    globalThis.CONST = originalConst;
  }

  return results;
}
