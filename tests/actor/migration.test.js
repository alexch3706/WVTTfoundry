import assert from "node:assert/strict";

import { isPrimaryActiveGM, migrateCompendium, migrateItem } from "../../module/migrate.js";

export async function runMigrationTests() {
  const previousGame = globalThis.game;
  globalThis.game = {
    model: {
      Item: {
        weapon: {
          templates: ["common"],
          rangeDamages: {
            pointBlank: "",
            close: "",
            medium: "",
            far: ""
          }
        },
        skill: {
          templates: ["common"]
        }
      }
    },
    system: { template: { Item: {} } }
  };

  try {
    assertLegacySkillChipMigration();
    assertEnabledLegacySkillChipIsPreserved();
    assertLegacyShotgunRangeMigration();
    assertCurrentCloseDamageWinsOverLegacyShort();
    assertLegacyRangeDamageArrayIsConverted();
    assertMissingRangeDamageDefaultsUseCurrentSchema();
    await assertNumericActorDamageIsPreserved();
    await assertIntentionalTokenSettingsArePreserved();
    await assertMissingTokenDefaultsAreMigrated();
    assertSingleActiveGmOwnsAutomaticMigration();
    await assertUnsupportedCompendiumDocumentsAreSkipped();
    await assertEmptyCompendiumMigrationsDoNotWrite();
    await assertNonEmptyCompendiumMigrationsUpdateDocuments();
  } finally {
    globalThis.game = previousGame;
  }

  return [{ name: "migration: legacy item UI fields are preserved", passed: true }];
}

async function assertEmptyCompendiumMigrationsDoNotWrite() {
  const previousFoundry = globalThis.foundry;
  let updateCalls = 0;
  globalThis.foundry = {
    utils: {
      isEmpty: value => Object.keys(value || {}).length === 0
    }
  };
  try {
    await migrateCompendium({
      locked: false,
      metadata: { label: "Current Items" },
      index: [{ id: "skill-1" }],
      async getDocument(id) {
        return {
          id,
          name: "Current Skill",
          documentName: "Item",
          type: "skill",
          system: { source: "", isChipped: false },
          async update() { updateCalls += 1; }
        };
      }
    });
  } finally {
    globalThis.foundry = previousFoundry;
  }
  assert.equal(updateCalls, 0, "empty migrations must not rewrite compendium documents");
}

async function assertNonEmptyCompendiumMigrationsUpdateDocuments() {
  const previousFoundry = globalThis.foundry;
  const updates = [];
  globalThis.foundry = {
    utils: {
      isEmpty: value => Object.keys(value || {}).length === 0
    }
  };
  try {
    await migrateCompendium({
      locked: false,
      metadata: { label: "Legacy Items" },
      index: [{ id: "skill-1" }],
      async getDocument(id) {
        return {
          id,
          name: "Legacy Skill",
          documentName: "Item",
          type: "skill",
          system: { isChipped: false },
          async update(updateData) { updates.push(updateData); }
        };
      }
    });
  } finally {
    globalThis.foundry = previousFoundry;
  }
  assert.deepEqual(updates, [{ "system.source": "" }], "compendium migrations must update the loaded Document API");
}

async function assertUnsupportedCompendiumDocumentsAreSkipped() {
  let updateCalls = 0;
  await migrateCompendium({
    locked: false,
    metadata: { label: "Roll Tables" },
    index: [{ id: "table-1" }],
    async getDocument(id) {
      return { id, name: "Hit Location", documentName: "RollTable" };
    },
    async updateDocument() {
      updateCalls += 1;
    }
  });
  assert.equal(updateCalls, 0, "unsupported compendium document types must not fail or write during migration");
}

function assertLegacySkillChipMigration() {
  const updates = migrateItem({
    name: "Legacy chip skill",
    type: "skill",
    system: { source: "", chipped: true }
  });
  assert.equal(updates["system.isChipped"], true);
  assert.equal(updates["system.-=chipped"], null);
}

function assertEnabledLegacySkillChipIsPreserved() {
  const updates = migrateItem({
    name: "Current chip skill",
    type: "skill",
    system: { source: "", isChipped: false, chipped: true }
  });
  assert.equal(updates["system.isChipped"], true);
  assert.equal(updates["system.-=chipped"], null);
}

function assertLegacyRangeDamageArrayIsConverted() {
  const updates = migrateItem({
    name: "Array-based shotgun",
    type: "weapon",
    system: {
      source: "",
      rangeDamages: ["6d6", "5d6", "4d6", "3d6", "2d6"]
    }
  });
  assert.deepEqual(updates["system.rangeDamages"], {
    pointBlank: "6d6",
    close: "5d6",
    medium: "4d6",
    far: "3d6"
  });
}

function assertLegacyShotgunRangeMigration() {
  const updates = migrateItem({
    name: "Legacy shotgun",
    type: "weapon",
    system: {
      source: "",
      rangeDamages: { pointBlank: "6d6", short: "5d6", medium: "4d6", far: "3d6" }
    }
  });
  assert.equal(updates["system.rangeDamages.close"], "5d6");
  assert.equal(updates["system.rangeDamages.-=short"], null);
}

function assertCurrentCloseDamageWinsOverLegacyShort() {
  const updates = migrateItem({
    name: "Mixed shotgun",
    type: "weapon",
    system: {
      source: "",
      rangeDamages: { pointBlank: "6d6", close: "5d6+1", short: "5d6", medium: "4d6", far: "3d6" }
    }
  });
  assert.equal(updates["system.rangeDamages.close"], undefined);
  assert.equal(updates["system.rangeDamages.-=short"], null);
}

function assertMissingRangeDamageDefaultsUseCurrentSchema() {
  const updates = migrateItem({
    name: "Unconfigured weapon",
    type: "weapon",
    system: { source: "" }
  });
  assert.deepEqual(updates["system.rangeDamages"], {
    pointBlank: "",
    close: "",
    medium: "",
    far: ""
  });
}

async function assertNumericActorDamageIsPreserved() {
  const { migrateActor } = await import("../../module/migrate.js");
  const updates = await migrateActor({
    name: "Legacy wounded actor",
    type: "character",
    system: { damage: "5" },
    prototypeToken: { actorLink: true, sight: { enabled: true } },
    items: [{ type: "skill" }]
  });
  assert.equal(updates["system.damage"], 5, "a version-gated rerun must not heal legacy actors");
}

async function assertIntentionalTokenSettingsArePreserved() {
  const { migrateActor } = await import("../../module/migrate.js");
  const updates = await migrateActor({
    name: "Unlinked actor without vision",
    type: "character",
    system: {},
    prototypeToken: {
      actorLink: false,
      disposition: -1,
      sight: { enabled: false, range: 0 }
    },
    items: [{ type: "skill" }]
  });
  assert.equal(updates["prototypeToken.actorLink"], undefined);
  assert.equal(updates["prototypeToken.disposition"], undefined);
  assert.equal(updates["prototypeToken.sight.enabled"], undefined);
  assert.equal(updates["prototypeToken.sight.range"], undefined);
}

async function assertMissingTokenDefaultsAreMigrated() {
  const { migrateActor } = await import("../../module/migrate.js");
  const updates = await migrateActor({
    name: "Legacy token defaults",
    type: "character",
    system: {},
    prototypeToken: { sight: {} },
    items: [{ type: "skill" }]
  });
  assert.equal(updates["prototypeToken.actorLink"], true);
  assert.equal(updates["prototypeToken.disposition"], 1);
  assert.equal(updates["prototypeToken.sight.enabled"], true);
  assert.equal(updates["prototypeToken.sight.range"], 30);
}

function assertSingleActiveGmOwnsAutomaticMigration() {
  const users = [
    { id: "gm-b", isGM: true, active: true },
    { id: "gm-a", isGM: true, active: true },
    { id: "player", isGM: false, active: true }
  ];
  assert.equal(isPrimaryActiveGM(users[0], users), false);
  assert.equal(isPrimaryActiveGM(users[1], users), true);
  assert.equal(isPrimaryActiveGM(users[2], users), false);
}
