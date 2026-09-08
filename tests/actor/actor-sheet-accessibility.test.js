import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const projectFile = relativePath => readFileSync(new URL(`../../${relativePath}`, import.meta.url), "utf8");

export function runActorSheetAccessibilityTests() {
  const results = [];

  function test(name, fn) {
    try {
      fn();
      results.push({ name: `actor sheet accessibility: ${name}`, passed: true });
    } catch (error) {
      console.error(`FAIL: actor sheet accessibility: ${name}`);
      console.error(error);
      results.push({ name: `actor sheet accessibility: ${name}`, passed: false, error });
    }
  }

  test("does not force the application window to maximize", () => {
    const source = projectFile("module/actor/actor-sheet.js");
    assert.doesNotMatch(source, /\bthis\.maximize\s*\(/);
  });

  test("shared field labels reference their controls", () => {
    for (const file of ["boolean", "number", "select", "string"]) {
      const template = projectFile(`templates/fields/${file}.hbs`);
      const labelTarget = template.match(/<label for="([^"]+)">/)?.[1];
      const controlId = template.match(/<(?:input|select)[^>]*\bid="([^"]+)"/)?.[1];

      assert.ok(labelTarget, `${file} field should give its label a for target`);
      assert.equal(controlId, labelTarget, `${file} field label and control ID should match`);
    }
  });

  test("navigation and wound controls use keyboard-operable buttons", () => {
    const actorSheet = projectFile("templates/actor/actor-sheet.hbs");
    const woundTracker = projectFile("templates/actor/parts/woundtracker.hbs");

    assert.equal((actorSheet.match(/<button type="button" class="nav-cmd item"/g) || []).length, 5);
    assert.doesNotMatch(actorSheet, /<a class="nav-cmd item"/);
    assert.match(woundTracker, /<button type="button" data-damage=/);
    assert.match(woundTracker, /aria-label="[^"]*\{\{displayedWound\}\}/);
    assert.match(woundTracker, /aria-pressed=/);
    assert.match(woundTracker, /unless @root\.editable[^}]*\}\} disabled aria-disabled="true"/);
  });

  test("primary sheet actions expose keyboard activation", () => {
    const sheetSource = projectFile("module/actor/actor-sheet.js");
    for(const file of ["templates/actor/parts/combat.hbs", "templates/actor/parts/skill.hbs"]) {
      assert.match(projectFile(file), /data-keyboard-action="true"/, `${file} should expose keyboard actions`);
    }
    const gearTemplate = projectFile("templates/actor/parts/gear.hbs");
    assert.match(gearTemplate, /<button type="button" class="field-image roll fire-weapon action"/);
    assert.match(gearTemplate, /<button type="button" class="gear-edit item-edit action"/);
    assert.doesNotMatch(gearTemplate, /role="button"[^>]*>[\s\S]*role="button"/);
    assert.match(sheetSource, /event\.key !== "Enter" && event\.key !== " "/);
    assert.match(sheetSource, /if\(event\.repeat\) return/);
    assert.match(sheetSource, /event\.stopPropagation\(\)/);
  });

  test("system styles provide scoped focus and motion behavior", () => {
    const mainStyles = projectFile("scss/cyberpunk2020-rilerena.scss");
    const interactionStyles = projectFile("scss/_interactivityHints.scss");
    const woundStyles = projectFile("scss/_woundtracker.scss");

    assert.doesNotMatch(mainStyles, /^\s*\*\s*\{\s*scrollbar-width:/m);
    assert.match(mainStyles, /prefers-reduced-motion:\s*reduce/);
    assert.match(interactionStyles, /\.cyberpunk button:focus-visible/);
    assert.match(woundStyles, /min-width:\s*24px/);
    assert.match(woundStyles, /min-height:\s*24px/);
  });

  return results;
}

if (process.argv[1]?.endsWith("actor-sheet-accessibility.test.js")) {
  const results = runActorSheetAccessibilityTests();
  if (results.some(result => result.passed === false)) process.exit(1);
}
