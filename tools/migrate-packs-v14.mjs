#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { promisify, isDeepStrictEqual } from "node:util";

const execFileAsync = promisify(execFile);

export const FOUNDRY_CLI_VERSION = "3.0.4";
export const EXPECTED_PACK_COUNT = 28;

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
export const REPOSITORY_ROOT = path.resolve(SCRIPT_DIR, "..");
const PACKS_ROOT = path.join(REPOSITORY_ROOT, "packs");
const SYSTEM_MANIFEST = path.join(REPOSITORY_ROOT, "system.json");

const DOCUMENT_COLLECTIONS = Object.freeze({
  Item: "items",
  RollTable: "tables"
});

const TABLE_RESULT_TYPES = Object.freeze({
  0: "text",
  1: "document",
  2: "document"
});

const WORLD_DOCUMENT_TYPES = new Set([
  "Actor", "Cards", "ChatMessage", "Combat", "FogExploration", "Folder",
  "Item", "JournalEntry", "Macro", "Playlist", "RollTable", "Scene", "User"
]);

function own(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function createCounters() {
  return {
    dataToSystem: 0,
    permissionToOwnership: 0,
    tableResultTypes: 0,
    resultIdToDocumentId: 0,
    resultCollectionToDocumentCollection: 0,
    collectionToDocumentCollection: 0,
    tableResultDescriptions: 0,
    tableResultNames: 0,
    tableResultDocumentUuids: 0,
    legacyResultFieldsRemoved: 0,
    primaryCollectionKeys: 0,
    embeddedCollectionKeys: 0,
    syntheticEmptyEffectsRemoved: 0,
    legacySkillChippedRemoved: 0,
    coreSourceIdsMigrated: 0,
    legacyExportSourcesMigrated: 0
  };
}

function addCounters(target, source) {
  for (const key of Object.keys(target)) target[key] += source[key] ?? 0;
  return target;
}

function renameField(object, legacyKey, modernKey, counters, counterKey) {
  if (!own(object, legacyKey)) return;
  if (own(object, modernKey) && !isDeepStrictEqual(object[modernKey], object[legacyKey])) {
    throw new Error(`Cannot migrate ${legacyKey}: conflicting ${modernKey} value`);
  }
  if (!own(object, modernKey)) object[modernKey] = object[legacyKey];
  delete object[legacyKey];
  counters[counterKey] += 1;
}

function normalizeLegacyBoolean(value) {
  if (typeof value === "string") {
    return ["true", "1", "on", "yes"].includes(value.trim().toLowerCase());
  }
  return value === true || value === 1;
}

function modernizeSkillSystem(document, counters) {
  if(document.type !== "skill" || !document.system || !own(document.system, "chipped")) return;
  document.system.isChipped = normalizeLegacyBoolean(document.system.isChipped)
    || normalizeLegacyBoolean(document.system.chipped);
  delete document.system.chipped;
  counters.legacySkillChippedRemoved += 1;
}

function modernizeCoreSourceId(document, counters) {
  const sourceId = document.flags?.core?.sourceId;
  if(sourceId === undefined) return;

  const currentSource = document._stats?.compendiumSource;
  if(currentSource !== undefined && currentSource !== sourceId) {
    throw new Error(`Cannot migrate flags.core.sourceId: conflicting _stats.compendiumSource value`);
  }
  document._stats = { ...(document._stats || {}), compendiumSource: sourceId };
  delete document.flags.core.sourceId;
  if(Object.keys(document.flags.core).length === 0) delete document.flags.core;
  counters.coreSourceIdsMigrated += 1;
}

function modernizeLegacyExportSource(document, counters) {
  const exportSource = document.flags?.exportSource;
  if(exportSource === undefined) return;

  const migrated = exportSource === null ? null : {
    worldId: exportSource.world ?? null,
    uuid: null,
    coreVersion: exportSource.coreVersion ?? null,
    systemId: exportSource.system ?? null,
    systemVersion: exportSource.systemVersion ?? null
  };
  const current = document._stats?.exportSource;
  if(current !== undefined && !isDeepStrictEqual(current, migrated)) {
    throw new Error("Cannot migrate flags.exportSource: conflicting _stats.exportSource value");
  }
  document._stats = { ...(document._stats || {}), exportSource: migrated };
  delete document.flags.exportSource;
  counters.legacyExportSourcesMigrated += 1;
}

function expectedPrimaryKey(document, definition) {
  const collection = DOCUMENT_COLLECTIONS[definition.type];
  if (!collection) throw new Error(`Unsupported pack document type: ${definition.type}`);
  return `!${collection}!${document._id}`;
}

function expectedResultKey(table, result) {
  return `!tables.results!${table._id}.${result._id}`;
}

function buildLegacyDocumentUuid(documentCollection, documentId, definition) {
  if(typeof documentCollection !== "string" || !documentCollection || typeof documentId !== "string" || !documentId) {
    throw new Error("Cannot migrate a document TableResult without documentCollection and documentId");
  }
  if(WORLD_DOCUMENT_TYPES.has(documentCollection)) return `${documentCollection}.${documentId}`;

  const documentName = definition.packDocumentTypes?.get(documentCollection);
  if(!documentName) throw new Error(`Cannot determine Document type for compendium ${documentCollection}`);
  return `Compendium.${documentCollection}.${documentName}.${documentId}`;
}

function modernizeTableResult(result, definition, counters) {
  if(typeof result.type === "number") {
    const modernType = TABLE_RESULT_TYPES[result.type];
    if(!modernType) throw new Error(`Unknown numeric TableResult type: ${result.type}`);
    result.type = modernType;
    counters.tableResultTypes += 1;
  } else if(result.type === "pack") {
    result.type = "document";
    counters.tableResultTypes += 1;
  }

  // Normalize the older aliases only as an intermediate step, then remove
  // every V13 shim field in favour of V14's canonical schema.
  renameField(result, "resultId", "documentId", counters, "resultIdToDocumentId");
  renameField(
    result,
    "resultCollection",
    "documentCollection",
    counters,
    "resultCollectionToDocumentCollection"
  );
  renameField(result, "collection", "documentCollection", counters, "collectionToDocumentCollection");

  const hasText = own(result, "text");
  const legacyText = result.text;
  const hasLegacyId = own(result, "documentId");
  const hasLegacyCollection = own(result, "documentCollection");

  if(result.type === "document") {
    if(hasText) {
      if(own(result, "name") && result.name !== legacyText) {
        throw new Error("Cannot migrate TableResult text: conflicting name value");
      }
      if(!own(result, "name")) {
        result.name = legacyText;
        counters.tableResultNames += 1;
      }
      if(!own(result, "description")) {
        result.description = "";
        counters.tableResultDescriptions += 1;
      }
    }

    if(hasLegacyId !== hasLegacyCollection) {
      throw new Error("Cannot migrate a document TableResult with a partial legacy reference");
    }
    if(hasLegacyId) {
      const documentUuid = buildLegacyDocumentUuid(result.documentCollection, result.documentId, definition);
      if(own(result, "documentUuid") && result.documentUuid !== documentUuid) {
        throw new Error("Cannot migrate TableResult reference: conflicting documentUuid value");
      }
      result.documentUuid = documentUuid;
      counters.tableResultDocumentUuids += 1;
    }
    if(!own(result, "name")) result.name = "";
    if(!own(result, "description")) result.description = "";
  } else if(result.type === "text") {
    if((hasLegacyId && result.documentId) || (hasLegacyCollection && result.documentCollection)) {
      throw new Error("Cannot discard a document reference from a text TableResult");
    }
    if(hasText) {
      if(own(result, "description") && result.description !== legacyText) {
        throw new Error("Cannot migrate TableResult text: conflicting description value");
      }
      if(!own(result, "description")) {
        result.description = legacyText;
        counters.tableResultDescriptions += 1;
      }
    }
    if(!own(result, "name")) result.name = "";
  }

  for(const legacyKey of ["text", "documentId", "documentCollection", "resultId", "resultCollection", "collection"]) {
    if(!own(result, legacyKey)) continue;
    delete result[legacyKey];
    counters.legacyResultFieldsRemoved += 1;
  }
}

/**
 * Return a modernized clone of one extracted primary document.
 *
 * Only schema migrations required by V14 are applied. Identity, names, flags,
 * system payloads, and all unrelated fields remain untouched.
 */
export function modernizeDocument(source, definition) {
  let document = structuredClone(source);
  const counters = createCounters();
  const preserved = {
    id: structuredClone(source._id),
    name: structuredClone(source.name),
    system: structuredClone(source.system ?? source.data),
    flags: structuredClone(source.flags),
    stats: structuredClone(source._stats)
  };

  renameField(document, "data", "system", counters, "dataToSystem");
  renameField(document, "permission", "ownership", counters, "permissionToOwnership");
  modernizeSkillSystem(document, counters);
  modernizeCoreSourceId(document, counters);
  modernizeLegacyExportSource(document, counters);

  const primaryKey = expectedPrimaryKey(document, definition);
  if (document._key !== primaryKey) {
    document._key = primaryKey;
    counters.primaryCollectionKeys += 1;
  }

  if (definition.type === "RollTable") {
    // The legacy pack was accidentally keyed as an Item. The official CLI
    // consequently materializes an empty Item.effects array while extracting
    // it. It is not RollTable content and is invalid in the V14 schema.
    if (own(document, "effects")) {
      if (!Array.isArray(document.effects) || document.effects.length !== 0) {
        throw new Error(`RollTable ${document._id} has non-empty legacy effects`);
      }
      delete document.effects;
      counters.syntheticEmptyEffectsRemoved += 1;
    }

    if (!Array.isArray(document.results)) {
      throw new Error(`RollTable ${document._id} has no results array`);
    }

    for (const result of document.results) {
      modernizeTableResult(result, definition, counters);

      const resultKey = expectedResultKey(document, result);
      if (result._key !== resultKey) {
        result._key = resultKey;
        counters.embeddedCollectionKeys += 1;
      }
    }
  }

  if (document._id !== preserved.id || document.name !== preserved.name) {
    throw new Error(`Identity changed while modernizing ${source._id}`);
  }

  const expected = {
    type: document.type,
    system: preserved.system,
    flags: preserved.flags,
    _stats: preserved.stats
  };
  modernizeSkillSystem(expected, createCounters());
  modernizeCoreSourceId(expected, createCounters());
  modernizeLegacyExportSource(expected, createCounters());
  if(!isDeepStrictEqual(document.system, expected.system)) {
    throw new Error(`System payload changed unexpectedly while modernizing ${source._id}`);
  }
  if(!isDeepStrictEqual(document.flags, expected.flags) || !isDeepStrictEqual(document._stats, expected._stats)) {
    throw new Error(`Flags or document stats changed unexpectedly while modernizing ${source._id}`);
  }
  if (own(source, "permission") && !isDeepStrictEqual(document.ownership, source.permission)) {
    throw new Error(`Ownership payload changed while modernizing ${source._id}`);
  }

  return { document, counters };
}

export async function readPackDefinitions() {
  const manifest = JSON.parse(await fs.readFile(SYSTEM_MANIFEST, "utf8"));
  if (!Array.isArray(manifest.packs) || manifest.packs.length !== EXPECTED_PACK_COUNT) {
    throw new Error(`Expected ${EXPECTED_PACK_COUNT} declared packs, found ${manifest.packs?.length ?? 0}`);
  }

  const seenPaths = new Set();
  const packDocumentTypes = new Map(
    manifest.packs.map(definition => [`${manifest.id}.${definition.name}`, definition.type])
  );
  return Promise.all(manifest.packs.map(async definition => {
    if (!DOCUMENT_COLLECTIONS[definition.type]) {
      throw new Error(`Unsupported declared pack type ${definition.type} for ${definition.name}`);
    }
    const absolutePath = path.resolve(REPOSITORY_ROOT, definition.path);
    const relativePath = path.relative(PACKS_ROOT, absolutePath);
    if (!relativePath || relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
      throw new Error(`Pack path escapes packs/: ${definition.path}`);
    }
    if (seenPaths.has(absolutePath)) throw new Error(`Duplicate pack path: ${definition.path}`);
    seenPaths.add(absolutePath);
    const stat = await fs.stat(absolutePath);
    if (!stat.isDirectory()) throw new Error(`Pack path is not a directory: ${definition.path}`);
    return { ...definition, absolutePath, relativePath, packDocumentTypes };
  }));
}

async function listFiles(root) {
  const files = [];
  async function visit(directory) {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const filename = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(filename);
      else if (entry.isFile()) files.push(filename);
    }
  }
  await visit(root);
  return files;
}

async function fingerprintDirectory(root) {
  const hash = createHash("sha256");
  for (const filename of await listFiles(root)) {
    hash.update(path.relative(root, filename).split(path.sep).join("/"));
    hash.update("\0");
    hash.update(await fs.readFile(filename));
    hash.update("\0");
  }
  return hash.digest("hex");
}

export async function fingerprintDeclaredPacks() {
  const definitions = await readPackDefinitions();
  const fingerprints = {};
  for (const definition of definitions) {
    fingerprints[definition.path] = await fingerprintDirectory(definition.absolutePath);
  }
  return fingerprints;
}

async function loadFoundryCli(workspace) {
  const providedModule = process.env.FVTT_CLI_MODULE;
  if (providedModule) {
    return import(pathToFileURL(path.resolve(providedModule)).href);
  }

  const installRoot = path.join(workspace, "foundry-cli");
  await fs.mkdir(installRoot, { recursive: true });
  try {
    await execFileAsync("npm", [
      "install",
      "--silent",
      "--no-audit",
      "--no-fund",
      "--prefix",
      installRoot,
      `@foundryvtt/foundryvtt-cli@${FOUNDRY_CLI_VERSION}`
    ], {
      env: { ...process.env, npm_config_update_notifier: "false" },
      maxBuffer: 10 * 1024 * 1024
    });
  } catch (error) {
    const detail = error.stderr?.trim() || error.message;
    throw new Error(`Unable to install official Foundry CLI ${FOUNDRY_CLI_VERSION}: ${detail}`);
  }

  const packageJson = JSON.parse(await fs.readFile(
    path.join(installRoot, "node_modules", "@foundryvtt", "foundryvtt-cli", "package.json"),
    "utf8"
  ));
  if (packageJson.version !== FOUNDRY_CLI_VERSION) {
    throw new Error(`Expected Foundry CLI ${FOUNDRY_CLI_VERSION}, installed ${packageJson.version}`);
  }
  return import(pathToFileURL(path.join(
    installRoot,
    "node_modules",
    "@foundryvtt",
    "foundryvtt-cli",
    "index.mjs"
  )).href);
}

async function readExtractedDocuments(directory) {
  const documents = [];
  for (const filename of await listFiles(directory)) {
    if (path.extname(filename) !== ".json") continue;
    documents.push(JSON.parse(await fs.readFile(filename, "utf8")));
  }
  documents.sort((left, right) => String(left._id).localeCompare(String(right._id)));
  return documents;
}

async function extractPackFromCopy(cli, definition, workspace, suffix) {
  const copiedPack = path.join(workspace, `pack-copies-${suffix}`, definition.relativePath);
  const extracted = path.join(workspace, `extracted-${suffix}`, definition.relativePath);
  await fs.mkdir(path.dirname(copiedPack), { recursive: true });
  await fs.cp(definition.absolutePath, copiedPack, { recursive: true, force: false });
  await cli.extractPack(copiedPack, extracted, {
    clean: true,
    jsonOptions: { space: 2 },
    transformName: document => `${document._id}.json`
  });
  return readExtractedDocuments(extracted);
}

function auditDocuments(definition, documents) {
  const issues = [];
  const counts = {
    documents: documents.length,
    documentsWithId: 0,
    documentsWithName: 0,
    documentsWithFlags: 0,
    systems: 0,
    legacyData: 0,
    ownerships: 0,
    legacyPermissions: 0,
    legacySkillChipped: 0,
    legacyCoreSourceIds: 0,
    legacyExportSources: 0,
    exportSources: 0,
    invalidExportSources: 0,
    compendiumSources: 0,
    tableResults: 0,
    legacyNumericResultTypes: 0,
    invalidResultTypes: 0,
    legacyResultIds: 0,
    legacyResultCollections: 0,
    legacyResultTexts: 0,
    missingResultNames: 0,
    missingResultDescriptions: 0,
    missingDocumentUuids: 0,
    invalidPrimaryKeys: 0,
    invalidEmbeddedKeys: 0
  };
  const ids = new Set();

  for (const document of documents) {
    if (document._id) counts.documentsWithId += 1;
    else issues.push(`${definition.name}: document without _id`);
    if (typeof document.name === "string") counts.documentsWithName += 1;
    else issues.push(`${definition.name}:${document._id}: document without name`);
    if (own(document, "flags")) counts.documentsWithFlags += 1;
    if (own(document, "system")) counts.systems += 1;
    if (own(document, "data")) {
      counts.legacyData += 1;
      issues.push(`${definition.name}:${document._id}: legacy data field`);
    }
    if (own(document, "ownership")) counts.ownerships += 1;
    if (own(document, "permission")) {
      counts.legacyPermissions += 1;
      issues.push(`${definition.name}:${document._id}: legacy permission field`);
    }
    if(document.type === "skill" && own(document.system || {}, "chipped")) {
      counts.legacySkillChipped += 1;
      issues.push(`${definition.name}:${document._id}: legacy system.chipped field`);
    }
    if(document.flags?.core?.sourceId !== undefined) {
      counts.legacyCoreSourceIds += 1;
      issues.push(`${definition.name}:${document._id}: removed flags.core.sourceId field`);
    }
    if(document.flags?.exportSource !== undefined) {
      counts.legacyExportSources += 1;
      issues.push(`${definition.name}:${document._id}: deprecated flags.exportSource field`);
    }
    if(document._stats?.exportSource !== undefined) {
      counts.exportSources += 1;
      const exportSource = document._stats.exportSource;
      const requiredFields = ["worldId", "uuid", "coreVersion", "systemId", "systemVersion"];
      const valid = exportSource === null || (
        exportSource && typeof exportSource === "object"
        && requiredFields.every(field => own(exportSource, field))
        && requiredFields.every(field => exportSource[field] === null || typeof exportSource[field] === "string")
      );
      if(!valid) {
        counts.invalidExportSources += 1;
        issues.push(`${definition.name}:${document._id}: malformed _stats.exportSource field`);
      }
    }
    if(document._stats?.compendiumSource) counts.compendiumSources += 1;
    if (ids.has(document._id)) issues.push(`${definition.name}:${document._id}: duplicate _id`);
    ids.add(document._id);

    if (document._key !== expectedPrimaryKey(document, definition)) {
      counts.invalidPrimaryKeys += 1;
      issues.push(`${definition.name}:${document._id}: invalid primary LevelDB key ${document._key}`);
    }

    if (definition.type === "Item" && !own(document, "system")) {
      issues.push(`${definition.name}:${document._id}: Item has no system field`);
    }

    if (definition.type !== "RollTable") continue;
    if (!Array.isArray(document.results)) {
      issues.push(`${definition.name}:${document._id}: RollTable has no results array`);
      continue;
    }
    for (const result of document.results) {
      counts.tableResults += 1;
      if (typeof result.type === "number") {
        counts.legacyNumericResultTypes += 1;
        issues.push(`${definition.name}:${document._id}:${result._id}: numeric result type`);
      } else if (!Object.values(TABLE_RESULT_TYPES).includes(result.type)) {
        counts.invalidResultTypes += 1;
        issues.push(`${definition.name}:${document._id}:${result._id}: invalid result type ${result.type}`);
      }
      if (own(result, "resultId")) {
        counts.legacyResultIds += 1;
        issues.push(`${definition.name}:${document._id}:${result._id}: legacy resultId field`);
      }
      if (own(result, "documentId")) {
        counts.legacyResultIds += 1;
        issues.push(`${definition.name}:${document._id}:${result._id}: deprecated documentId field`);
      }
      if (own(result, "resultCollection") || own(result, "collection") || own(result, "documentCollection")) {
        counts.legacyResultCollections += 1;
        issues.push(`${definition.name}:${document._id}:${result._id}: legacy result collection field`);
      }
      if(own(result, "text")) {
        counts.legacyResultTexts += 1;
        issues.push(`${definition.name}:${document._id}:${result._id}: deprecated text field`);
      }
      if(typeof result.name !== "string") {
        counts.missingResultNames += 1;
        issues.push(`${definition.name}:${document._id}:${result._id}: missing canonical name field`);
      }
      if(typeof result.description !== "string") {
        counts.missingResultDescriptions += 1;
        issues.push(`${definition.name}:${document._id}:${result._id}: missing canonical description field`);
      }
      if(result.type === "document" && (typeof result.documentUuid !== "string" || !result.documentUuid)) {
        counts.missingDocumentUuids += 1;
        issues.push(`${definition.name}:${document._id}:${result._id}: missing canonical documentUuid field`);
      }
      if (result._key !== expectedResultKey(document, result)) {
        counts.invalidEmbeddedKeys += 1;
        issues.push(`${definition.name}:${document._id}:${result._id}: invalid embedded LevelDB key`);
      }
    }
  }
  return { counts, issues };
}

function aggregateAudit(packResults) {
  const totals = {
    packs: packResults.length,
    documents: 0,
    documentsWithId: 0,
    documentsWithName: 0,
    documentsWithFlags: 0,
    systems: 0,
    legacyData: 0,
    ownerships: 0,
    legacyPermissions: 0,
    legacySkillChipped: 0,
    legacyCoreSourceIds: 0,
    legacyExportSources: 0,
    exportSources: 0,
    invalidExportSources: 0,
    compendiumSources: 0,
    tableResults: 0,
    legacyNumericResultTypes: 0,
    invalidResultTypes: 0,
    legacyResultIds: 0,
    legacyResultCollections: 0,
    legacyResultTexts: 0,
    missingResultNames: 0,
    missingResultDescriptions: 0,
    missingDocumentUuids: 0,
    invalidPrimaryKeys: 0,
    invalidEmbeddedKeys: 0
  };
  const issues = [];
  const packDocumentCounts = {};
  for (const result of packResults) {
    // Report by the public manifest ID. A pack path may intentionally differ
    // in case (sellthedead -> packs/sellTheDead) and both identities must stay
    // stable for existing compendium UUIDs and filesystems.
    packDocumentCounts[result.definition.name] = result.documents.length;
    for (const key of Object.keys(totals)) {
      if (key !== "packs") totals[key] += result.audit.counts[key] ?? 0;
    }
    issues.push(...result.audit.issues);
  }
  return { totals, packDocumentCounts, issues };
}

async function inspectInWorkspace(cli, definitions, workspace, suffix = "check") {
  const results = [];
  for (const definition of definitions) {
    const documents = await extractPackFromCopy(cli, definition, workspace, suffix);
    results.push({ definition, documents, audit: auditDocuments(definition, documents) });
  }
  return { results, ...aggregateAudit(results) };
}

async function withTemporaryWorkspace(callback) {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "cyberpunk2020-v14-packs-"));
  try {
    return await callback(workspace);
  } finally {
    await fs.rm(workspace, { recursive: true, force: true, maxRetries: 10 });
  }
}

/** Inspect every manifest-declared pack without opening a repository DB. */
export async function inspectDeclaredPacks() {
  return withTemporaryWorkspace(async workspace => {
    const definitions = await readPackDefinitions();
    const cli = await loadFoundryCli(workspace);
    return inspectInWorkspace(cli, definitions, workspace);
  });
}

async function writeSources(directory, documents) {
  await fs.mkdir(directory, { recursive: true });
  for (const document of [...documents].sort((left, right) => String(left._id).localeCompare(String(right._id)))) {
    await fs.writeFile(path.join(directory, `${document._id}.json`), `${JSON.stringify(document, null, 2)}\n`);
  }
}

async function normalizeVolatileLevelFiles(packDirectory) {
  for (const filename of await listFiles(packDirectory)) {
    const basename = path.basename(filename);
    if (basename === "LOCK" || basename === "LOG" || basename === "LOG.old" || basename.endsWith(".log")) {
      await fs.writeFile(filename, "");
    }
  }
}

function assertRoundTrip(expected, actual, packName) {
  if (expected.length !== actual.length) {
    throw new Error(`${packName}: round-trip changed document count (${expected.length} -> ${actual.length})`);
  }
  for (let index = 0; index < expected.length; index += 1) {
    if (!isDeepStrictEqual(expected[index], actual[index])) {
      throw new Error(`${packName}:${expected[index]?._id}: official CLI round-trip changed document content`);
    }
  }
}

async function replacePackDirectories(definitions, builtPacks, initialFingerprints) {
  const suffix = `${process.pid}-${Date.now()}`;
  const stageRoot = path.join(PACKS_ROOT, `.v14-stage-${suffix}`);
  const backupRoot = path.join(PACKS_ROOT, `.v14-backup-${suffix}`);
  const replaced = [];
  await fs.mkdir(stageRoot, { recursive: true });
  await fs.mkdir(backupRoot, { recursive: true });

  try {
    for (let index = 0; index < definitions.length; index += 1) {
      await fs.cp(builtPacks.get(definitions[index].path), path.join(stageRoot, String(index)), {
        recursive: true,
        force: false
      });
    }

    for (let index = 0; index < definitions.length; index += 1) {
      const definition = definitions[index];
      const currentFingerprint = await fingerprintDirectory(definition.absolutePath);
      if (currentFingerprint !== initialFingerprints.get(definition.path)) {
        throw new Error(`${definition.path} changed while migration was being prepared`);
      }
      const backup = path.join(backupRoot, String(index));
      await fs.rename(definition.absolutePath, backup);
      try {
        await fs.rename(path.join(stageRoot, String(index)), definition.absolutePath);
      } catch (error) {
        await fs.rename(backup, definition.absolutePath);
        throw error;
      }
      replaced.push({ definition, backup, index });
    }
  } catch (error) {
    for (const entry of replaced.reverse()) {
      const failed = path.join(stageRoot, `failed-${entry.index}`);
      await fs.rename(entry.definition.absolutePath, failed);
      await fs.rename(entry.backup, entry.definition.absolutePath);
    }
    throw error;
  } finally {
    await fs.rm(stageRoot, { recursive: true, force: true, maxRetries: 10 });
    await fs.rm(backupRoot, { recursive: true, force: true, maxRetries: 10 });
  }
}

/**
 * Transform and round-trip every declared pack. With write=false, this is a
 * complete dry run and the repository remains byte-for-byte unchanged.
 */
export async function migrateDeclaredPacks({ write = false, documentsByPack } = {}) {
  return withTemporaryWorkspace(async workspace => {
    const definitions = await readPackDefinitions();
    const initialFingerprints = new Map();
    for (const definition of definitions) {
      initialFingerprints.set(definition.path, await fingerprintDirectory(definition.absolutePath));
    }

    const cli = await loadFoundryCli(workspace);
    const extracted = await inspectInWorkspace(cli, definitions, workspace, "before");
    const transformationTotals = createCounters();
    const builtPacks = new Map();

    for (const result of extracted.results) {
      const replacements = documentsByPack?.get(result.definition.name);
      if(documentsByPack && !replacements) {
        throw new Error(`Missing canonical sources for ${result.definition.name}`);
      }
      if(replacements) {
        const identity = documents => documents.map(document => [document._id, document.type ?? null])
          .sort((left, right) => left[0].localeCompare(right[0]));
        if(!isDeepStrictEqual(identity(replacements), identity(result.documents))) {
          throw new Error(`${result.definition.name}: canonical sources changed stable document IDs or types`);
        }
      }
      const modernDocuments = [];
      for (const source of replacements || result.documents) {
        const { document, counters } = modernizeDocument(source, result.definition);
        modernDocuments.push(document);
        addCounters(transformationTotals, counters);
      }
      modernDocuments.sort((left, right) => left._id.localeCompare(right._id));

      const sources = path.join(workspace, "modern-sources", result.definition.relativePath);
      const built = path.join(workspace, "built-packs", result.definition.relativePath);
      await writeSources(sources, modernDocuments);
      await cli.compilePack(sources, built);

      const verifyDefinition = { ...result.definition, absolutePath: built };
      const verifiedDocuments = await extractPackFromCopy(
        cli,
        verifyDefinition,
        workspace,
        `verify-${result.definition.name}`
      );
      assertRoundTrip(modernDocuments, verifiedDocuments, result.definition.name);
      const audit = auditDocuments(result.definition, verifiedDocuments);
      if (audit.issues.length) {
        throw new Error(`${result.definition.name}: rebuilt pack is not V14-clean: ${audit.issues[0]}`);
      }
      // LevelDB diagnostic logs contain wall-clock timestamps and thread IDs.
      // They are not data, so blank them after the DB is closed. The SSTable,
      // CURRENT, and MANIFEST files emitted by the pinned CLI are deterministic.
      await normalizeVolatileLevelFiles(built);
      builtPacks.set(result.definition.path, built);
    }

    const changedDefinitions = [];
    for (const definition of definitions) {
      const builtFingerprint = await fingerprintDirectory(builtPacks.get(definition.path));
      if (builtFingerprint !== initialFingerprints.get(definition.path)) changedDefinitions.push(definition);
    }
    if (write && changedDefinitions.length) {
      await replacePackDirectories(changedDefinitions, builtPacks, initialFingerprints);
    }
    return {
      mode: write ? "write" : "dry-run",
      before: { totals: extracted.totals, packDocumentCounts: extracted.packDocumentCounts },
      transformations: transformationTotals,
      packsWritten: write ? changedDefinitions.length : 0,
      packsWouldWrite: changedDefinitions.length
    };
  });
}

function parseArguments(argv) {
  const options = { mode: "check", json: false };
  for (const argument of argv) {
    if (argument === "--check") options.mode = "check";
    else if (argument === "--dry-run") options.mode = "dry-run";
    else if (argument === "--write") options.mode = "write";
    else if (argument === "--json") options.json = true;
    else if (argument === "--help" || argument === "-h") options.help = true;
    else throw new Error(`Unknown argument: ${argument}`);
  }
  return options;
}

function printHelp() {
  console.log(`Usage: node tools/migrate-packs-v14.mjs [mode] [--json]

Modes:
  --check     Extract copies and fail if any declared pack uses legacy fields (default)
  --dry-run   Transform, rebuild, and verify entirely in a temporary directory
  --write     Transform and replace all 28 declared pack directories after verification

Set FVTT_CLI_MODULE to an official foundryvtt-cli index.mjs to avoid the
temporary npm install. Otherwise version ${FOUNDRY_CLI_VERSION} is installed under the OS temp directory.`);
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  if (options.mode === "check") {
    const report = await inspectDeclaredPacks();
    const output = {
      mode: "check",
      totals: report.totals,
      packDocumentCounts: report.packDocumentCounts,
      issueCount: report.issues.length,
      issueSamples: report.issues.slice(0, 20)
    };
    console.log(options.json ? JSON.stringify(output, null, 2) : output);
    if (report.issues.length) process.exitCode = 1;
    return;
  }

  const report = await migrateDeclaredPacks({ write: options.mode === "write" });
  console.log(options.json ? JSON.stringify(report, null, 2) : report);
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) {
  main().catch(error => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}
