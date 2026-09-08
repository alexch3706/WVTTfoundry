import "./mock-globals.mjs";
// Regenerate coverage map before running tests
await import("./combat/generate-coverage-map.mjs");

import { runCombatFixtures } from "./combat/combat-fixtures.test.js";
import { runCombatCommitTests } from "./combat/combat-commit.test.js";
import { runMartialArtsDataTests } from "./combat/martial-arts-data.test.js";
import { runConformanceHelpersTests } from "./combat/conformance-helpers.test.js";
import { runDeferredMechanicsTests } from "./combat/deferred-mechanics.test.js";
import { runDeathSaveTurnTests } from "./combat/death-save-turn.test.js";
import { runAttackTypeClassificationTests } from "./combat/attack-type-classification.test.js";

import { runHumanityPersistenceTests } from "./combat/humanity-persistence.test.js";
import { runRangeDcTests } from "./combat/range-dcs.test.js";
import { runRangeBracketTests } from "./combat/range-bracket.test.js";
import { runArmorMaintenanceTests } from "./combat/armor-maintenance.test.js";
import { runDerivedStatOverrideTests } from "./combat/derived-stat-overrides.test.js";
import { runWoundHintTests } from "./combat/wound-hints.test.js";
import { runSuppressiveFireTests } from "./combat/suppressive-fire.test.js";
import { runTemplatePlacementTests } from "./combat/template-placement.test.js";
import { runCyberlimbSchemaTests } from "./combat/cyberlimb-schema.test.js";
import { runCombatSnapshotTests } from "./combat/combat-snapshot.test.js";
import { runActorDataTests } from "./actor/actor-data.test.js";
import { runActorSheetLayoutTests } from "./actor/actor-sheet-layout.test.js";
import { runActorSheetAccessibilityTests } from "./actor/actor-sheet-accessibility.test.js";
import { runItemUiContractTests } from "./actor/item-ui-contracts.test.js";
import { runMigrationTests } from "./actor/migration.test.js";
import { runModifiersDialogTests } from "./combat/modifiers-dialog.test.js";
const results = [
  ...await runCombatFixtures(),
  await runCombatCommitTests(),
  await runMartialArtsDataTests(),
  ...await runConformanceHelpersTests(),
  ...await runDeferredMechanicsTests(),
  ...await runDeathSaveTurnTests(),
  ...await runAttackTypeClassificationTests(),
  ...await runHumanityPersistenceTests(),
  ...await runRangeDcTests(),
  ...runRangeBracketTests(),
  ...runArmorMaintenanceTests(),
  ...runDerivedStatOverrideTests(),
  ...runWoundHintTests(),
  ...await runSuppressiveFireTests(),
  ...await runTemplatePlacementTests(),
  ...runCyberlimbSchemaTests(),
  ...runCombatSnapshotTests(),
  ...runActorDataTests(),
  ...runActorSheetLayoutTests(),
  ...runActorSheetAccessibilityTests(),
  ...runItemUiContractTests(),
  ...await runMigrationTests(),
  await runModifiersDialogTests()
];

for(const result of results) {
  if (result.passed !== false) {
    console.log(`ok ${result.name}`);
  } else {
    console.log(`FAIL ${result.name}`);
  }
}

const failed = results.filter(r => r.passed === false).length;
const passed = results.length - failed;
console.log(`\n${results.length} fixture(s): ${passed} passed, ${failed} failed`);

if (failed > 0) process.exit(1);
