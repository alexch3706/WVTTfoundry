import assert from "node:assert/strict";

import { resolveActorSheetLayout } from "../../module/actor/actor-sheet-layout.js";

export function runActorSheetLayoutTests() {
  const results = [];

  function test(name, fn) {
    try {
      fn();
      results.push({ name: `actor sheet layout: ${name}`, passed: true });
    } catch (error) {
      console.error(`FAIL: actor sheet layout: ${name}`);
      console.error(error);
      results.push({ name: `actor sheet layout: ${name}`, passed: false, error });
    }
  }

  test("skills view below 1100px prioritizes content over the combat HUD", () => {
    for (const width of [700, 900, 1099]) {
      const layout = resolveActorSheetLayout({ width, activeTab: "skills" });

      assert.equal(layout.mode, "compact", `${width}px should use compact mode`);
      assert.equal(layout.showContentPane, true, `${width}px should show ordinary tab content`);
      assert.equal(layout.showCombatPane, false, `${width}px should hide the combat HUD`);
    }
  });

  test("skills view from 1100px keeps content and the combat HUD visible", () => {
    for (const width of [1100, 1200]) {
      const layout = resolveActorSheetLayout({ width, activeTab: "skills" });

      assert.equal(layout.mode, "wide", `${width}px should use wide mode`);
      assert.equal(layout.showContentPane, true, `${width}px should show ordinary tab content`);
      assert.equal(layout.showCombatPane, true, `${width}px should show the combat HUD`);
    }
  });

  test("combat tab focuses the combat surface at every supported width", () => {
    for (const width of [700, 900, 1200]) {
      const layout = resolveActorSheetLayout({ width, activeTab: "combat" });

      assert.equal(layout.showContentPane, false, `${width}px should hide ordinary tab content`);
      assert.equal(layout.showCombatPane, true, `${width}px should show the combat surface`);
      assert.equal(layout.combatFocus, true, `${width}px should use combat focus mode`);
    }
  });

  return results;
}

if (process.argv[1]?.endsWith("actor-sheet-layout.test.js")) {
  const results = runActorSheetLayoutTests();
  if (results.some(result => result.passed === false)) process.exit(1);
}
