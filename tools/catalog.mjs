#!/usr/bin/env node
import { promises as fs } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import {
  REPOSITORY_ROOT, inspectDeclaredPacks, migrateDeclaredPacks, readPackDefinitions
} from "./migrate-packs-v14.mjs";

import { COMPENDIUM_CONTENT_VERSION } from "../module/data-versions.js";
export const CATALOG_VERSION = COMPENDIUM_CONTENT_VERSION;
export const CATALOG_NAMESPACE = "cyberpunk2020-rilerena";
export const SOURCE_ROOT = path.join(REPOSITORY_ROOT, "src", "compendia");
const MANIFEST_PATH = path.join(SOURCE_ROOT, "manifest.json");
const REPORT_PATH = path.join(REPOSITORY_ROOT, "docs", "catalog-audit.json");

function stable(value) {
  if(Array.isArray(value)) return value.map(stable);
  if(value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
  }
  return value;
}

async function writeJson(filename, value) {
  await fs.mkdir(path.dirname(filename), { recursive: true });
  await fs.writeFile(filename, `${JSON.stringify(stable(value), null, 2)}\n`);
}

function identities(documents) {
  return documents.map(document => ({ id: document._id, type: document.type ?? null }))
    .sort((left, right) => left.id.localeCompare(right.id));
}

/** One-time extraction. The official CLI opens temporary copies only. */
export async function bootstrapCatalog() {
  try {
    await fs.access(SOURCE_ROOT);
    throw new Error("Canonical source directory already exists; bootstrap never overwrites it");
  } catch(error) {
    if(error.code !== "ENOENT") throw error;
  }
  const extracted = await inspectDeclaredPacks();
  if(extracted.issues.length) throw new Error(extracted.issues.join("\n"));
  const manifest = { version: CATALOG_VERSION, packs: {} };
  for(const { definition, documents } of extracted.results) {
    manifest.packs[definition.name] = identities(documents);
    for(const document of documents) {
      await writeJson(path.join(SOURCE_ROOT, definition.name, `${document._id}.json`), document);
    }
  }
  await writeJson(MANIFEST_PATH, manifest);
  return { packs: extracted.results.length, documents: extracted.totals.documents };
}

export async function readCatalogSources() {
  const manifest = JSON.parse(await fs.readFile(MANIFEST_PATH, "utf8"));
  const definitions = await readPackDefinitions();
  const expectedPacks = definitions.map(definition => definition.name).sort();
  if(!isDeepStrictEqual(Object.keys(manifest.packs).sort(), expectedPacks)) {
    throw new Error("Canonical identity manifest does not match declared packs");
  }
  const sources = new Map();
  for(const definition of definitions) {
    const directory = path.join(SOURCE_ROOT, definition.name);
    const filenames = (await fs.readdir(directory)).sort();
    const documents = [];
    for(const filename of filenames) {
      if(!/^[a-zA-Z0-9]{16}\.json$/.test(filename)) {
        throw new Error(`Unexpected canonical source file: ${definition.name}/${filename}`);
      }
      const document = JSON.parse(await fs.readFile(path.join(directory, filename), "utf8"));
      if(filename !== `${document._id}.json`) throw new Error(`Source filename/ID mismatch: ${filename}`);
      documents.push(document);
    }
    if(!isDeepStrictEqual(identities(documents), manifest.packs[definition.name])) {
      throw new Error(`${definition.name}: canonical identities changed; preserve existing IDs and types`);
    }
    sources.set(definition.name, documents);
  }
  return sources;
}

export async function normalizeCatalogSources({ write = false } = {}) {
  const [{ normalizeWeaponCatalog }, { normalizeArmorCatalog }] = await Promise.all([
    import("./lib/normalize-weapon-catalog.mjs"), import("./lib/normalize-armor-catalog.mjs")
  ]);
  const sources = await readCatalogSources();
  let changed = 0;
  for(const [packName, documents] of sources) {
    for(let index = 0; index < documents.length; index++) {
      const original = documents[index];
      let document = structuredClone(original);
      if(document.type === "weapon") document = normalizeWeaponCatalog(document, { packName });
      if(document.type === "armor" || document.type === "cyberware") {
        document = normalizeArmorCatalog(document, { packName });
      }
      if(document._id !== original._id || document.type !== original.type) {
        throw new Error(`${packName}:${original._id}: normalization changed identity`);
      }
      if(document.system?.automation && document.system.automation.status !== "custom") {
        document.flags ??= {};
        document.flags[CATALOG_NAMESPACE] ??= {};
        const metadata = document.flags[CATALOG_NAMESPACE].catalog ??= {};
        metadata.version = CATALOG_VERSION;
        metadata.sourceValues ??= structuredClone(original.system);
        metadata.sourceName ??= original.name;
        metadata.automationValues = structuredClone(document.system.automation);
      }
      if(!isDeepStrictEqual(document, original)) {
        changed++;
        if(write) await writeJson(path.join(SOURCE_ROOT, packName, `${document._id}.json`), document);
      }
      documents[index] = document;
    }
  }
  const report = await auditCatalogSources(sources);
  if(write) await writeJson(REPORT_PATH, report);
  return { changed, report };
}

/** Invalid data may ship only as explicitly manual content with actionable reasons. */
export async function auditCatalogSources(sources = undefined) {
  sources ??= await readCatalogSources();
  const { validateWeaponContract, validateArmorContract } = await import("../module/item/item-contract.js");
  const report = { version: CATALOG_VERSION, documents: 0, ready: 0, manual: 0, unscoped: 0,
    byType: {}, fatal: [], review: [] };
  for(const [packName, documents] of sources) {
    for(const document of documents) {
      report.documents++;
      const system = document.system || {};
      const status = system.automation?.status;
      const scoped = document.type === "weapon" || document.type === "armor"
        || (document.type === "cyberware" && status && status !== "custom");
      if(!scoped) { report.unscoped++; continue; }
      const counts = report.byType[document.type] ??= { ready: 0, manual: 0 };
      const ref = `${packName}/${document._id}`;
      if(!["ready", "manual"].includes(status)) {
        report.fatal.push({ ref, name: document.name, issues: ["Missing explicit automation status"] });
        continue;
      }
      if(status === "manual") {
        const reasons = system.automation.reasons;
        if(!Array.isArray(reasons) || !reasons.length || reasons.some(reason => typeof reason !== "string" || !reason.trim())) {
          report.fatal.push({ ref, name: document.name, issues: ["Manual content needs actionable reasons"] });
        }
        report.manual++; counts.manual++;
        report.review.push({ ref, name: document.name, type: document.type, reasons });
        continue;
      }
      const contract = document.type === "weapon"
        ? validateWeaponContract(system, { strict: true })
        : validateArmorContract(system, { type: document.type, strict: true });
      if(!contract.valid) report.fatal.push({ ref, name: document.name, issues: contract.issues });
      report.ready++; counts.ready++;
    }
  }
  return report;
}

export async function checkCatalogPacks() {
  const sources = await readCatalogSources();
  const report = await auditCatalogSources(sources);
  if(report.fatal.length) throw new Error(`Catalog has ${report.fatal.length} fatal issues:\n${JSON.stringify(report.fatal.slice(0, 10), null, 2)}`);
  const extracted = await inspectDeclaredPacks();
  if(extracted.issues.length) throw new Error(extracted.issues.join("\n"));
  for(const { definition, documents } of extracted.results) {
    const expected = sources.get(definition.name);
    const byId = new Map(documents.map(document => [document._id, document]));
    if(documents.length !== expected.length) throw new Error(`${definition.name}: source/pack count mismatch`);
    for(const document of expected) {
      if(!isDeepStrictEqual(document, byId.get(document._id))) {
        throw new Error(`${definition.name}/${document._id}: pack differs from canonical source; rebuild it`);
      }
    }
  }
  return report;
}

async function main() {
  const [command = "audit", ...args] = process.argv.slice(2);
  if(args.some(arg => arg !== "--write")) throw new Error(`Unknown options: ${args.join(" ")}`);
  const write = args.includes("--write");
  let result;
  if(command === "bootstrap") result = await bootstrapCatalog();
  else if(command === "normalize") result = await normalizeCatalogSources({ write });
  else if(command === "audit") {
    result = await auditCatalogSources();
    if(write) await writeJson(REPORT_PATH, result);
    if(result.fatal.length) process.exitCode = 1;
  } else if(command === "check") result = await checkCatalogPacks();
  else if(command === "build") {
    const report = await auditCatalogSources();
    if(report.fatal.length) throw new Error(`Cannot build catalog with ${report.fatal.length} fatal issues`);
    result = await migrateDeclaredPacks({ write, documentsByPack: await readCatalogSources() });
  } else throw new Error("Usage: node tools/catalog.mjs bootstrap|normalize|audit|check|build [--write]");
  // The full review queue lives in docs/catalog-audit.json, not a wall of console output.
  if(result.review) result = { ...result, review: `${result.review.length} entries; run audit --write for the JSON report` };
  if(result.report) result = { ...result, report: { ...result.report, review: `${result.report.review.length} review entries` } };
  console.log(JSON.stringify(result, null, 2));
}

if(import.meta.url === pathToFileURL(path.resolve(process.argv[1] || "")).href) {
  main().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
}
