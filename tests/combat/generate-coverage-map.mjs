#!/usr/bin/env node
/**
 * Fixture Coverage Map Generator
 *
 * Parses all fixture JSON files, extracts ruleReference metadata, and generates
 * tests/combat/fixture-coverage-map.md documenting every rule/audit area and
 * which fixtures cover it.
 */

import { readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const FIXTURE_DIR = resolve(__dirname, "fixtures");
const OUTPUT = resolve(__dirname, "fixture-coverage-map.md");

async function generateCoverageMap() {
  const fixtureFiles = (await readdir(FIXTURE_DIR))
    .filter(filename => filename.endsWith(".json"))
    .sort();

  // Collect all rule references from all fixture cases
  const fixtureCases = [];
  let totalCases = 0;

  for (const filename of fixtureFiles) {
    const filepath = resolve(FIXTURE_DIR, filename);
    const data = JSON.parse(await readFile(filepath, "utf8"));

    const cases = data.singleShotCases || [];
    for (const c of cases) {
      totalCases++;
      fixtureCases.push({
        fixture: filename,
        name: c.name,
        ruleReference: c.ruleReference || "(no ruleReference)"
      });
    }

    // Also collect inline test functions from combat-fixtures.test.js
    // (assertBodyTypeDamageResolver, assertWoundPlanning, etc.) — these are
    // documented separately in the story spec reference table.
  }

  // Build a lookup: rule area → list of fixture cases
  // We parse the rule references into coarse-grained areas
  const areaPatterns = [
    { pattern: /Range DC/i, label: "Range DC Table" },
    { pattern: /Attack roll/i, label: "Attack Roll Formula" },
    { pattern: /Aiming/i, label: "Aiming Rounds" },
    { pattern: /Blinded/i, label: "Blinded Modifier" },
    { pattern: /Misc modifiers?/i, label: "Misc Modifiers" },
    { pattern: /Accuracy/i, label: "Weapon Accuracy" },
    { pattern: /Hit location/i, label: "Hit Location" },
    { pattern: /Cover/i, label: "Cover Stopping Power" },
    { pattern: /Armor/i, label: "Armor & AP" },
    { pattern: /Penetration/i, label: "Staged Penetration" },
    { pattern: /Ablat/i, label: "Progressive Ablation" },
    { pattern: /BTM/i, label: "Body Type Modifier" },
    { pattern: /minimum damage|minimum 1/i, label: "Minimum Damage (1 after BTM)" },
    { pattern: /Wound/i, label: "Wound State" },
    { pattern: /head.?hit|head.?doubl|head.?critical/i, label: "Head Hit Specials" },
    { pattern: /limb/i, label: "Limb Loss Threshold" },
    { pattern: /Saves?|Stun|Death|Shock/i, label: "Save Prompts (Stun/Death)" },
    { pattern: /Mortal/i, label: "Mortal Wound & Death Saves" },
    { pattern: /Recurring/i, label: "Recurring Death Save" },
    { pattern: /Burst/i, label: "Three-Round Burst" },
    { pattern: /Full.?Auto/i, label: "Full Auto" },
    { pattern: /ROF/i, label: "ROF & Ammo" },
    { pattern: /Suppressive/i, label: "Suppressive Fire" },
    { pattern: /Reliability|jam|fumble/i, label: "Reliability & Jams" },
    { pattern: /Melee/i, label: "Melee Opposed Roll" },
    { pattern: /strength damage bonus|strength.*bonus/i, label: "Strength Damage Bonus" },
    { pattern: /Martial/i, label: "Martial Arts" },
    { pattern: /Grapple|hold|choke|throw|escape/i, label: "Grapple Family" },
    { pattern: /Prerequisite/i, label: "Grapple Prerequisites" },
    { pattern: /AttachType|Exotic|unsupported/i, label: "Attack Type Classification" },
    { pattern: /Humanity|\bEMP\b/i, label: "Humanity & EMP" },
    { pattern: /Missing|Actorless|manual/i, label: "Edge Case / Manual Resolution" },
    { pattern: /Ammo/i, label: "Ammo State & Updates" },
    { pattern: /Audit/i, label: "Audit Compliance" },
    { pattern: /fidelity|Corebook/i, label: "Corebook Fidelity Mode" }
  ];

  const areaMap = {};
  for (const { pattern, label } of areaPatterns) {
    areaMap[label] = [];
  }

  for (const entry of fixtureCases) {
    const ref = entry.ruleReference;
    for (const { pattern, label } of areaPatterns) {
      if (pattern.test(ref)) {
        areaMap[label].push(entry);
      }
    }
  }

  // Generate markdown
  let md = `# Fixture Coverage Map

**Generated:** automatically from every JSON file in \`tests/combat/fixtures/\`
**Total fixture cases:** ${totalCases}

This map indexes rule references from the JSON fixture suite. A zero in the first
table means there is no JSON case for that area; it does not mean that focused
assertion modules have no coverage. Those modules are listed separately below.

---

## JSON Fixture Coverage by Area

| Rule / Audit Area | JSON Cases | Fixture Cases |
|---|---|---|
`;

  for (const { label } of areaPatterns) {
    const entries = areaMap[label];
    if (entries.length > 0) {
      const caseList = entries
        .slice(0, 5)
        .map(e => `\`${e.fixture}\` → ${e.name}`)
        .join("<br>");
      const count = entries.length > 5 ? ` (${entries.length} total, showing 5)` : "";
      md += `| ${label} | ✅ ${entries.length} | ${caseList}${count} |\n`;
    } else {
      md += `| ${label} | 0 | — |\n`;
    }
  }

  md += `
---

## Detailed Case Index

| Fixture | Case | Rule Reference |
|---|---|---|
`;

  for (const entry of fixtureCases) {
    const shortRef = entry.ruleReference.length > 80
      ? entry.ruleReference.slice(0, 77) + "..."
      : entry.ruleReference;
    md += `| \`${entry.fixture}\` | ${entry.name} | ${shortRef} |\n`;
  }

  md += `
---

## Focused Assertion Coverage

The following inline functions and focused test modules also verify rule areas and
are not counted as JSON fixture cases:

| Function | Rules Verified |
|---|---|
| \`assertBodyTypeDamageResolver\` | BTM table (BT 2, 6, 10–15), minimum damage, fractional/string BT |
| \`assertWoundPlanning\` | Wound state transitions, head damage doubling, limb loss, special cases |
| \`assertSavePromptResolution\` | Stun/Shock save generation, Death saves, recurring mortal save |
| \`assertArmorResolver\` | Proportional armor layering, SP/ablation, cover, AP halving, layer limits |
| \`assertTargetNormalization\` | Target snapshot building, equipped armor/cyberware filtering |
| \`assertCombatResolverRouting\` | Fire mode routing, multi-target ROF, insufficient ammo |
| \`assertSettingsHelpers\` | Corebook Fidelity Mode toggling, supported fire modes |
| \`conformance-helpers.test.js\` | Source-based conformance classification |
| \`deferred-mechanics.test.js\` | Deferred mechanics registry |
| \`attack-type-classification.test.js\` | Attack type support classification |
| \`humanity-persistence.test.js\` | Humanity cost resolution, EMP derivation |
| \`range-dcs.test.js\` | Range DC table values (PB=10, C=15, M=20, L=25, E=30) |
| \`suppressive-fire.test.js\` | Save DC, template lifecycle, movement deduplication, durable chat locks, per-hit damage and commit flow |

---

*Generated by \`tests/combat/generate-coverage-map.mjs\`.*
`;

  await writeFile(OUTPUT, md, "utf8");
  console.log(`✅ Coverage map written to ${OUTPUT}`);
  console.log(`   ${totalCases} fixture cases indexed across ${fixtureFiles.length} files`);
}

await generateCoverageMap().catch(e => {
  console.error(e);
  process.exit(1);
});
