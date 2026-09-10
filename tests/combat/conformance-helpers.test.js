import assert from "node:assert/strict";
import { classifyConformance, knownExtendedPrefixes } from "../../module/combat/conformance-helpers.js";

/**
 * Fixture suite for conformance classification.
 * Covers every row in the I/O & Edge-Case Matrix from the story spec.
 */
export function runConformanceHelpersTests() {
  const results = [];

  function test(name, fn) {
    try {
      fn();
      results.push({ name: `conformance-helpers: ${name}`, passed: true });
    } catch (err) {
      console.error(`FAIL: conformance-helpers: ${name}`);
      console.error(err);
      results.push({ name: `conformance-helpers: ${name}`, passed: false, error: err });
    }
  }

  // ── Corebook exact ──
  test('classifies "Cyberpunk2020" as corebook', () => {
    assert.equal(classifyConformance("Cyberpunk2020"), "corebook");
  });

  test('classifies "Cyberpunk 2020" (with space) as corebook', () => {
    assert.equal(classifyConformance("Cyberpunk 2020"), "corebook");
  });

  test('classifies "Cyberpunk 2020 2nd ed. pg.83" (page ref) as corebook', () => {
    assert.equal(classifyConformance("Cyberpunk 2020 2nd ed. pg.83"), "corebook");
  });

  test('classifies "CP2020 Vehicles p.71" as corebook', () => {
    assert.equal(classifyConformance("CP2020 Vehicles p.71"), "corebook");
  });

  test('classifies lowercase "cyberpunk2020" as corebook', () => {
    assert.equal(classifyConformance("cyberpunk2020"), "corebook");
  });

  test('classifies "Cyberpunk 2nd edition" as corebook', () => {
    assert.equal(classifyConformance("Cyberpunk 2nd edition"), "corebook");
  });

  // ── Extended: supplements ──
  test('recognizes catalog book codes without confusing unfamiliar sources', () => {
    assert.equal(classifyConformance("CP20"), "corebook");
    assert.equal(classifyConformance("CP20, 66"), "corebook");
    for(const source of ["Chr1", "Chr 2, 30", "SOF2", "P&S", "MM"]) assert.equal(classifyConformance(source), "extended");
    assert.equal(classifyConformance("CP2099 homebrew"), "unknown");
  });

  test('classifies "Chromebook 1 pg.31" as extended', () => {
    assert.equal(classifyConformance("Chromebook 1 pg.31"), "extended");
  });

  test('classifies "Chrome 1" as extended (prefix match)', () => {
    assert.equal(classifyConformance("Chrome 1"), "extended");
  });

  test('classifies "Solo of Fortune 2 pg.25" as extended', () => {
    assert.equal(classifyConformance("Solo of Fortune 2 pg.25"), "extended");
  });

  // ── Extended: URL sources ──
  test('classifies https URL as extended', () => {
    assert.equal(classifyConformance("https://datafortress2020.com/"), "extended");
  });

  test('classifies http URL as extended', () => {
    assert.equal(classifyConformance("http://example.com/weapon"), "extended");
  });

  // ── Unknown ──
  test('classifies empty string as unknown', () => {
    assert.equal(classifyConformance(""), "unknown");
  });

  test('classifies literal string "undefined" as unknown', () => {
    assert.equal(classifyConformance("undefined"), "unknown");
  });

  test('classifies undefined as unknown', () => {
    assert.equal(classifyConformance(undefined), "unknown");
  });

  test('classifies null as unknown', () => {
    assert.equal(classifyConformance(null), "unknown");
  });

  test('classifies unknown source as unknown', () => {
    assert.equal(classifyConformance("Homebrew V3"), "unknown");
  });

  test('classifies numeric type as unknown', () => {
    assert.equal(classifyConformance(42), "unknown");
  });

  // ── Case insensitivity ──
  test('classifies mixed-case "cYbErPuNk2020" as corebook', () => {
    assert.equal(classifyConformance("cYbErPuNk2020"), "corebook");
  });

  test('classifies mixed-case "cHrOmEbOoK 2" as extended', () => {
    assert.equal(classifyConformance("cHrOmEbOoK 2"), "extended");
  });

  // ── knownExtendedPrefixes is exported ──
  test('knownExtendedPrefixes is an array with expected length', () => {
    assert.ok(Array.isArray(knownExtendedPrefixes));
    assert.ok(knownExtendedPrefixes.length > 10);
  });

  const passed = results.filter(r => r.passed).length;
  const failed = results.filter(r => !r.passed).length;
  console.log(`\nConformance helpers: ${passed} passed, ${failed} failed\n`);

  return results;
}
