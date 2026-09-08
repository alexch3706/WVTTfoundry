import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { getFoundryHandlebarsFunction } from "../../module/foundry-compat.js";

const readRepoFile = relativePath => readFileSync(new URL(`../../${relativePath}`, import.meta.url), "utf8");

export function runItemUiContractTests() {
  const results = [];

  function test(name, assertion) {
    try {
      assertion();
      results.push({ name: `item UI contract: ${name}`, passed: true });
    } catch(error) {
      console.error(error);
      results.push({ name: `item UI contract: ${name}`, passed: false, error });
    }
  }

  test("item sheet opens an existing tab", () => {
    const sheet = readRepoFile("module/item/item-sheet.js");
    const template = readRepoFile("templates/item/item-sheet.hbs");
    const initialTab = sheet.match(/initial:\s*"([^"]+)"/)?.[1];
    const renderedTabs = [...template.matchAll(/data-tab="([^"]+)"/g)].map(match => match[1]);

    assert.ok(initialTab, "item sheet should declare an initial tab");
    assert.ok(renderedTabs.includes(initialTab), `initial tab '${initialTab}' must exist in the item template`);
  });

  test("skill chip control uses the Item schema field", () => {
    const template = readRepoFile("templates/item/parts/skill/settings.hbs");
    assert.match(template, /edit="system\.isChipped"/);
    assert.doesNotMatch(template, /edit="system\.chipped"/);
  });

  test("shotgun damage fields match resolver bands", () => {
    const template = readRepoFile("templates/item/parts/weapon/settings.hbs");
    const damageBands = [...template.matchAll(/edit="system\.rangeDamages\.([^"]+)"/g)]
      .map(match => match[1]);

    assert.deepEqual(damageBands, ["pointBlank", "close", "medium", "far"]);
  });

  test("vehicle template has balanced structural tags", () => {
    const template = readRepoFile("templates/item/parts/vehicle/settings.hbs");
    const count = pattern => [...template.matchAll(pattern)].length;

    assert.equal(count(/<div(?=[\s>])/g), count(/<\/div>/g), "vehicle div tags should balance");
    assert.equal(count(/<span(?=[\s>])/g), count(/<\/span>/g), "vehicle span tags should balance");
  });

  test("manual form labels reference existing control IDs", () => {
    for(const file of [
      "templates/item/parts/vehicle/settings.hbs",
      "templates/actor/parts/combat.hbs",
      "templates/actor/parts/gear.hbs"
    ]) {
      const template = readRepoFile(file);
      const ids = new Set([...template.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]));
      const labelTargets = [...template.matchAll(/<label[^>]*\bfor="([^"]+)"/g)].map(match => match[1]);
      for(const target of labelTargets) {
        assert.ok(ids.has(target), `${file}: label target '${target}' should match a control ID`);
      }
    }
  });

  test("gear attack affordance and listener are weapon-only", () => {
    const template = readRepoFile("templates/actor/parts/gear.hbs");
    const sheet = readRepoFile("module/actor/actor-sheet.js");

    assert.match(template, /\{\{#if \(equals type "weapon"\)\}\}[^\n]*fire-weapon/);
    assert.match(sheet, /item\.type !== "weapon"/);
  });

  test("initiative no longer reads the legacy actor skills object", () => {
    const manifest = JSON.parse(readRepoFile("system.json"));
    assert.equal(manifest.initiative, "1d10x10 + @stats.ref.total + @itemSkills.combatSense.value");
  });

  test("Handlebars helpers support the Foundry V13 namespace", () => {
    const previousFoundry = globalThis.foundry;
    const previousRenderer = globalThis.renderTemplate;
    try {
      delete globalThis.renderTemplate;
      globalThis.foundry = {
        applications: {
          handlebars: {
            renderTemplate(path) { return `rendered:${path}`; }
          }
        }
      };
      const renderer = getFoundryHandlebarsFunction("renderTemplate");
      assert.equal(typeof renderer, "function");
      assert.equal(renderer("template.hbs"), "rendered:template.hbs");
    } finally {
      globalThis.foundry = previousFoundry;
      if(previousRenderer === undefined) delete globalThis.renderTemplate;
      else globalThis.renderTemplate = previousRenderer;
    }
  });

  return results;
}

if(process.argv[1]?.endsWith("item-ui-contracts.test.js")) {
  const results = runItemUiContractTests();
  for(const result of results) console.log(`${result.passed ? "ok" : "FAIL"} ${result.name}`);
  if(results.some(result => result.passed === false)) process.exit(1);
}
