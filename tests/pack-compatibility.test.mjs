import assert from "node:assert/strict";

import {
  EXPECTED_PACK_COUNT,
  fingerprintDeclaredPacks,
  inspectDeclaredPacks,
  modernizeDocument
} from "../tools/migrate-packs-v14.mjs";

const EXPECTED_DOCUMENT_COUNTS = Object.freeze({
  "roll-tables": 1,
  "default-skills": 90,
  "role-skills": 10,
  pistols: 141,
  rifles: 83,
  cyberware: 658,
  chipware: 203,
  communication: 10,
  electronics: 17,
  entertainment: 12,
  fashion: 32,
  furnishing: 10,
  medical: 10,
  netrunningEquipment: 15,
  security: 26,
  surveillance: 5,
  tools: 13,
  rentalandservices: 40,
  sellthedead: 27,
  armor: 199,
  vehicles: 139,
  melee: 64,
  smgs: 48,
  shotguns: 27,
  heavyWeapons: 214,
  bows: 7,
  exotics: 19,
  weapons_other: 4
});

function testTransformationContract() {
  const legacy = {
    _id: "table00000000001",
    _key: "!items!table00000000001",
    name: "Compatibility Fixture",
    permission: { default: 0, user: 3 },
    flags: {
      fixture: { preserved: true },
      exportSource: {
        world: "fixture-world",
        system: "cyberpunk2020-rilerena",
        coreVersion: "12.331",
        systemVersion: "1.0.0"
      },
      core: { sourceId: "RollTable.source00000001" }
    },
    effects: [],
    results: [
      {
        _id: "result0000000001",
        _key: "!tables.results!table00000000001.result0000000001",
        type: 0,
        resultId: "",
        text: "Text"
      },
      {
        _id: "result0000000002",
        _key: "!tables.results!table00000000001.result0000000002",
        type: 2,
        resultId: "item000000000001",
        resultCollection: "cyberpunk2020-rilerena.pistols",
        text: "Document"
      }
    ]
  };
  const { document, counters } = modernizeDocument(legacy, {
    type: "RollTable",
    packDocumentTypes: new Map([["cyberpunk2020-rilerena.pistols", "Item"]])
  });

  assert.equal(document._id, legacy._id);
  assert.equal(document.name, legacy.name);
  assert.deepEqual(document.flags, {
    fixture: { preserved: true }
  });
  assert.equal(document._stats.compendiumSource, "RollTable.source00000001");
  assert.deepEqual(document._stats.exportSource, {
    worldId: "fixture-world",
    uuid: null,
    coreVersion: "12.331",
    systemId: "cyberpunk2020-rilerena",
    systemVersion: "1.0.0"
  });
  assert.deepEqual(document.ownership, legacy.permission);
  assert.equal("permission" in document, false);
  assert.equal("effects" in document, false);
  assert.equal(document._key, "!tables!table00000000001");
  assert.equal(document.results[0].type, "text");
  assert.equal(document.results[0].name, "");
  assert.equal(document.results[0].description, "Text");
  assert.equal("text" in document.results[0], false);
  assert.equal("documentId" in document.results[0], false);
  assert.equal(document.results[1].type, "document");
  assert.equal(document.results[1].name, "Document");
  assert.equal(document.results[1].description, "");
  assert.equal(
    document.results[1].documentUuid,
    "Compendium.cyberpunk2020-rilerena.pistols.Item.item000000000001"
  );
  assert.equal("text" in document.results[1], false);
  assert.equal("documentId" in document.results[1], false);
  assert.equal("documentCollection" in document.results[1], false);
  assert.equal("resultId" in document.results[1], false);
  assert.equal("resultCollection" in document.results[1], false);
  assert.equal(counters.tableResultTypes, 2);
  assert.equal(counters.coreSourceIdsMigrated, 1);
  assert.equal(counters.legacyExportSourcesMigrated, 1);

  const skill = modernizeDocument({
    _id: "skill00000000001",
    _key: "!items!skill00000000001",
    name: "Legacy Chip Skill",
    type: "skill",
    flags: {},
    system: { chipped: true, isChipped: false },
    ownership: { default: 0 }
  }, { type: "Item" });
  assert.equal(skill.document.system.chipped, undefined);
  assert.equal(skill.document.system.isChipped, true);
  assert.equal(skill.counters.legacySkillChippedRemoved, 1);
}

async function testRawPacks() {
  const before = await fingerprintDeclaredPacks();
  const report = await inspectDeclaredPacks();
  const after = await fingerprintDeclaredPacks();

  assert.deepEqual(after, before, "pack compatibility check must not mutate repository LevelDB files");
  assert.equal(report.totals.packs, EXPECTED_PACK_COUNT);
  assert.deepEqual(report.packDocumentCounts, EXPECTED_DOCUMENT_COUNTS);
  assert.equal(report.totals.documents, 2124);
  assert.equal(report.totals.documentsWithId, 2124);
  assert.equal(report.totals.documentsWithName, 2124);
  assert.equal(report.totals.documentsWithFlags, 2124);
  assert.equal(report.totals.systems, 2123);
  assert.equal(report.totals.legacyData, 0);
  assert.equal(report.totals.legacyPermissions, 0);
  assert.equal(report.totals.legacySkillChipped, 0);
  assert.equal(report.totals.legacyCoreSourceIds, 0);
  assert.equal(report.totals.legacyExportSources, 0);
  assert.equal(report.totals.exportSources, 2124);
  assert.equal(report.totals.invalidExportSources, 0);
  assert.equal(report.totals.compendiumSources, 1);
  assert.equal(report.totals.tableResults, 6);
  assert.equal(report.totals.legacyNumericResultTypes, 0);
  assert.equal(report.totals.invalidResultTypes, 0);
  assert.equal(report.totals.legacyResultIds, 0);
  assert.equal(report.totals.legacyResultCollections, 0);
  assert.equal(report.totals.legacyResultTexts, 0);
  assert.equal(report.totals.missingResultNames, 0);
  assert.equal(report.totals.missingResultDescriptions, 0);
  assert.equal(report.totals.missingDocumentUuids, 0);
  assert.equal(report.totals.invalidPrimaryKeys, 0);
  assert.equal(report.totals.invalidEmbeddedKeys, 0);
  assert.deepEqual(report.issues, []);
}

testTransformationContract();
await testRawPacks();
console.log("pack compatibility: 28 packs and 2124 documents are V14-clean");
