import assert from "node:assert/strict";

import { buildWoundStateHints } from "../../module/actor/wound-hints.js";

export function runWoundHintTests() {
  const results = [];

  function test(name, fn) {
    try {
      fn();
      results.push({ name: `wound hints: ${name}`, passed: true });
    } catch (err) {
      console.error(`FAIL: wound hints: ${name}`);
      console.error(err);
      results.push({ name: `wound hints: ${name}`, passed: false, error: err });
    }
  }

  test("wound labels include stun save thresholds", () => {
    const hints = buildWoundStateHints(["Light", "Serious", "Critical", "Mortal 0"], 10);

    assert.deepEqual(hints, [
      { label: "Light", stunPenalty: 0, stunThreshold: 10, hint: "Stun Save: d10 ≤ BODY 10" },
      { label: "Serious", stunPenalty: 1, stunThreshold: 9, hint: "Stun Save: d10 ≤ 9 (BODY 10 - 1)" },
      { label: "Critical", stunPenalty: 2, stunThreshold: 8, hint: "Stun Save: d10 ≤ 8 (BODY 10 - 2)" },
      { label: "Mortal 0", stunPenalty: 3, stunThreshold: 7, hint: "Stun Save: d10 ≤ 7 (BODY 10 - 3)" }
    ]);
  });

  return results;
}

if (process.argv[1] === import.meta.url || process.argv[1]?.endsWith("wound-hints.test.js")) {
  const results = runWoundHintTests();
  const failed = results.filter(r => !r.passed).length;
  if (failed > 0) process.exit(1);
}
