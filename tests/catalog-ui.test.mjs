import "./mock-globals.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

globalThis.ItemSheet = class {
  async _updateObject(_event, formData) { return formData; }
  async getData() { return {}; }
};
const { CyberpunkItem } = await import("../module/item/item.js");
const { CyberpunkItemSheet } = await import("../module/item/item-sheet.js");

test("clearing explicit modes never restores automatic or suppressive fire", () => {
  const item = Object.create(CyberpunkItem.prototype);
  item.type = "weapon";
  item.system = { attackType: "Auto", fireModes: [] };
  assert.deepEqual(item.__getFireModes(), []);
  item.system.fireModes = ["SemiAuto"];
  assert.deepEqual(item.__getFireModes(), ["SemiAuto"]);
  delete item.system.fireModes;
  assert.ok(item.__getFireModes().includes("FullAuto"), "only genuinely unspecified legacy modes use the fallback");
});

test("weapon form keeps unknown penetration distinct from normal ammunition", async () => {
  const sheet = Object.create(CyberpunkItemSheet.prototype);
  sheet.item = { type: "weapon" };
  for(const [input, expected] of [["unknown", null], ["true", true], ["false", false], [null, null]]) {
    const result = await sheet._updateObject({}, { "system.ap": input, "system.range": null });
    assert.equal(result["system.ap"], expected);
    assert.equal(result["system.range"], null);
  }
});

test("weapon form persists an intentionally empty mode selection", async () => {
  const sheet = Object.create(CyberpunkItemSheet.prototype);
  sheet.item = { type: "weapon" };
  sheet.form = { querySelector() { return { selectedOptions: [] }; } };
  const result = await sheet._updateObject({}, {});
  assert.deepEqual(result["system.fireModes"], []);
});

test("unrelated legacy cyberware edits do not create zero per-location armor", async () => {
  const sheet = Object.create(CyberpunkItemSheet.prototype);
  sheet.item = { type: "cyberware", system: { stoppingPower: 12, ablation: 2, source: "CP20" } };
  const before = structuredClone(sheet.item.system);
  const data = await sheet.getData({});
  assert.equal(data.hasStructuredCoverage, false);
  assert.equal(data.system.coverage, undefined);
  assert.deepEqual(sheet.item.system, before);
  const template = readFileSync(new URL("../templates/item/parts/cyberware/settings.hbs", import.meta.url), "utf8");
  assert.match(template, /<fieldset[^>]+cyberware-coverage-fields[^>]+unless hasStructuredCoverage[^>]+disabled/);
});
