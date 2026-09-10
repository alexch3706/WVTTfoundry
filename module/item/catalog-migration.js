import { isPrimaryActiveGm, resolveFoundryUuid } from "../foundry-compat.js";

import { COMPENDIUM_CONTENT_VERSION } from "../data-versions.js";
export { COMPENDIUM_CONTENT_VERSION } from "../data-versions.js";
export const CATALOG_FLAG_SCOPE = "cyberpunk2020-rilerena";
const STATE_FIELDS = new Set(["shotsLeft", "equipped", "ablation", "humanityLoss", "sdp", "lastOwnerId", "location"]);
const NON_MECHANICAL_FIELDS = new Set(["cost", "weight", "source", "notes", "flavor", "concealability", "availability"]);
const clone = value => value === undefined ? undefined : structuredClone(value);
const own = (value, key) => Object.prototype.hasOwnProperty.call(value || {}, key);

function equal(left, right) {
  if(left === right) return true;
  if(!left || !right || typeof left !== "object" || typeof right !== "object") return false;
  if(Array.isArray(left) !== Array.isArray(right)) return false;
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every(key => own(right, key) && equal(left[key], right[key]));
}

function definitions(system, prefix = "", output = {}) {
  for(const [key, value] of Object.entries(system || {})) {
    if(STATE_FIELDS.has(key) || key === "automation") continue;
    const field = prefix ? `${prefix}.${key}` : key;
    if(value && typeof value === "object" && !Array.isArray(value)) definitions(value, field, output);
    else output[field] = clone(value);
  }
  return output;
}

function atPath(object, field) {
  let value = object;
  for(const part of field.split(".")) {
    if(!own(value, part)) return { exists: false };
    value = value[part];
  }
  return { exists: true, value };
}

function locationKey(value) {
  const key = value.toLowerCase().replace(/[^a-z]/g, "");
  return ({ leftarm: "larm", rightarm: "rarm", leftleg: "lleg", rightleg: "rleg" })[key] || key;
}

export function getCatalogReference(source) {
  const reference = source?._stats?.compendiumSource || source?.flags?.core?.sourceId;
  return typeof reference === "string" && /^Compendium\.cyberpunk2020-rilerena\.[^.]+\.(?:Item\.)?[a-zA-Z0-9]{16}$/.test(reference)
    ? reference : undefined;
}

/**
 * Three-way, field-level merge. A raw Item source (not a template-merged view)
 * is required so absent fields can be distinguished from live state/defaults.
 */
export function planCatalogItemUpdate(source, catalog, { reference = getCatalogReference(source) } = {}) {
  const metadata = catalog?.flags?.[CATALOG_FLAG_SCOPE]?.catalog;
  const originalMetadata = source?.flags?.[CATALOG_FLAG_SCOPE]?.catalog;
  if(!reference || !metadata || source.type !== catalog.type || reference.split(".").at(-1) !== catalog._id) {
    return { status: "unlinked", changes: [], conflicts: [], update: {} };
  }
  const target = definitions(catalog.system);
  const baseline = originalMetadata?.definitionValues || definitions(metadata.sourceValues || {});
  const nextBaseline = { ...clone(baseline) };
  const update = {};
  const changes = [], conflicts = [];
  for(const [field, value] of Object.entries(target)) {
    const [group, location] = field.split(".");
    if(["coverage", "fbcHitLocations"].includes(group)) {
      const alias = Object.keys(source.system?.[group] || {}).find(key => key !== location && locationKey(key) === locationKey(location));
      const legacyDamage = group === "coverage" && !Object.keys(source.system?.coverage || {}).length && Number(source.system?.ablation) > 0;
      if(alias || legacyDamage) {
        conflicts.push({ field, current: clone(alias ? source.system[group][alias] : source.system.ablation), catalog: clone(value),
          reason: alias ? `Existing location '${alias}' must retain its damage; reconcile the location names manually.` : "Transfer existing cyberware armor damage before converting to per-location protection." });
        continue;
      }
    }
    const current = atPath(source.system, field);
    if(current.exists && equal(current.value, value)) {
      nextBaseline[field] = clone(value);
      continue;
    }
    if(!current.exists || own(baseline, field) && equal(current.value, baseline[field])) {
      update[`system.${field}`] = clone(value);
      changes.push({ field, before: clone(current.value), after: clone(value) });
      nextBaseline[field] = clone(value);
    } else {
      conflicts.push({ field, current: clone(current.value), catalog: clone(value) });
    }
  }
  if(metadata.sourceName === source.name && catalog.name !== source.name) {
    update.name = catalog.name;
    changes.push({ field: "name", before: source.name, after: catalog.name });
  }
  // Never initialize/reset shotsLeft here: repairing definitions must not reload
  // a weapon. Newly imported compendium documents already have initial ammo.
  const mechanicalConflicts = conflicts.filter(entry => !NON_MECHANICAL_FIELDS.has(entry.field.split(".")[0]));
  const currentAutomation = source.system?.automation;
  const manualOverride = currentAutomation?.status === "manual" && (
    originalMetadata?.manualOverride === true
    || (!originalMetadata?.automationValues && !originalMetadata?.conflicts?.length)
    || (originalMetadata?.automationValues && !equal(currentAutomation, originalMetadata.automationValues))
  );
  let automation = clone(catalog.system?.automation);
  if(mechanicalConflicts.length) {
    automation = { status: "manual", reasons: [...new Set([
      ...(automation?.reasons || []), ...(manualOverride ? currentAutomation.reasons || [] : []),
      `Catalog update preserved customized fields: ${mechanicalConflicts.map(entry => entry.field).join(", ")}. Review these fields before using automatic combat.`
    ])] };
  } else if(manualOverride || originalMetadata?.version && currentAutomation?.status === "custom") {
    automation = clone(currentAutomation);
  }
  if(automation && !equal(source.system?.automation, automation)) {
    update["system.automation"] = automation;
    changes.push({ field: "automation", before: clone(source.system?.automation), after: automation });
  }
  const applied = {
    ...clone(metadata),
    definitionValues: nextBaseline,
    automationValues: clone(automation),
    manualOverride,
    version: COMPENDIUM_CONTENT_VERSION,
    conflicts: conflicts.map(entry => entry.field)
  };
  if(!equal(originalMetadata, applied)) update[`flags.${CATALOG_FLAG_SCOPE}.catalog`] = applied;
  return { status: conflicts.length ? "conflicts" : changes.length ? "update" : "current", changes, conflicts, update };
}

function itemSource(item) {
  return clone(typeof item.toObject === "function" ? item.toObject() : item._source || item);
}

function collectionValues(collection) {
  return Array.from(collection?.contents || collection || []);
}

function worldItems(game) {
  const items = new Map();
  const add = item => {
    if(["weapon", "armor", "cyberware"].includes(item?.type)) items.set(item.uuid || item, item);
  };
  collectionValues(game.items).forEach(add);
  for(const actor of collectionValues(game.actors)) collectionValues(actor.items).forEach(add);
  for(const scene of collectionValues(game.scenes)) {
    for(const token of collectionValues(scene.tokens)) {
      if(token.actorLink !== true && token.actor) collectionValues(token.actor.items).forEach(add);
    }
  }
  return [...items.values()];
}

/** Preview is read-only; no system or world compendium is unlocked. */
export async function previewCatalogMigration({ game = globalThis.game, resolve = resolveFoundryUuid } = {}) {
  if(!game?.user?.isGM) throw new Error("Only a GM can review catalog updates.");
  const cache = new Map();
  const entries = [];
  for(const item of worldItems(game)) {
    const before = itemSource(item);
    const reference = getCatalogReference(before);
    if(!reference) {
      entries.push({ item, name: item.name, uuid: item.uuid, status: "unlinked", changes: [], conflicts: [], update: {} });
      continue;
    }
    if(!cache.has(reference)) cache.set(reference, await resolve(reference));
    const document = cache.get(reference);
    if(!document) {
      entries.push({ item, name: item.name, uuid: item.uuid, status: "source-missing", changes: [], conflicts: [], update: {} });
      continue;
    }
    const catalog = itemSource(document);
    entries.push({ item, before, catalog, reference, name: item.name, uuid: item.uuid,
      ...planCatalogItemUpdate(before, catalog, { reference }) });
  }
  return { version: COMPENDIUM_CONTENT_VERSION, entries,
    updates: entries.filter(entry => Object.keys(entry.update).length).length,
    conflicts: entries.filter(entry => entry.conflicts.length).length,
    unlinked: entries.filter(entry => ["unlinked", "source-missing"].includes(entry.status)).length };
}

let applying = false;

/** Apply exactly the preview, rejecting changed Items or catalog sources. */
export async function applyCatalogMigration(preview, { game = globalThis.game, resolve = resolveFoundryUuid } = {}) {
  if(!isPrimaryActiveGm(game?.user, game?.users)) throw new Error("Only the primary active GM can apply catalog updates.");
  if(applying) throw new Error("A catalog update is already running.");
  if(preview?.version !== COMPENDIUM_CONTENT_VERSION || !Array.isArray(preview.entries)) throw new Error("Create a fresh catalog preview first.");
  applying = true;
  let updated = 0;
  try {
    const entries = preview.entries.filter(entry => Object.keys(entry.update).length);
    // Check every item before the first write, then check each item again just
    // before updating it. A change made after preview cannot be overwritten.
    for(const entry of entries) {
      if(!equal(itemSource(entry.item), entry.before)) throw new Error(`${entry.name} changed after preview. Refresh the preview.`);
      const latest = await resolve(entry.reference);
      if(!latest || !equal(itemSource(latest), entry.catalog)) throw new Error(`${entry.name}'s catalog source changed. Refresh the preview.`);
      const expected = planCatalogItemUpdate(entry.before, entry.catalog, { reference: entry.reference });
      if(!equal(expected.update, entry.update)) throw new Error("Catalog preview was modified; refresh it before applying.");
    }
    for(const entry of entries) {
      if(!equal(itemSource(entry.item), entry.before)) throw new Error(`${entry.name} changed during migration. ${updated} item(s) already updated; refresh the preview.`);
      await entry.item.update(entry.update);
      // Re-plan from persisted data: a rejected update must not count as applied.
      const remaining = planCatalogItemUpdate(itemSource(entry.item), entry.catalog, { reference: entry.reference });
      if(Object.keys(remaining.update).length) throw new Error(`${entry.name}: catalog update was not fully persisted.`);
      updated++;
    }
    return { updated, conflicts: preview.conflicts, unlinked: preview.unlinked };
  } finally { applying = false; }
}

export function registerCatalogMigrationMenu() {
  const Base = globalThis.FormApplication;
  class CatalogMigrationMenu extends Base {
    static get defaultOptions() {
      return foundry.utils.mergeObject(super.defaultOptions, {
        id: "cyberpunk-catalog-migration", title: "CYBERPUNK.CatalogMigrationName",
        template: "systems/cyberpunk2020-rilerena/templates/dialog/catalog-migration.hbs",
        width: 760, height: 600, closeOnSubmit: false
      });
    }
    getData() {
      return { preview: this.preview, busy: this.busy, canApply: !!this.preview?.updates && !this.busy,
        rows: this.preview?.entries.map(({ name, status, changes, conflicts, uuid }) => ({ name, status, changes, conflicts, uuid })) || [] };
    }
    activateListeners(html) {
      super.activateListeners(html);
      html.find('[data-action="preview"]').on("click", () => this.run(async () => { this.preview = await previewCatalogMigration(); }));
      html.find('[data-action="apply"]').on("click", () => this.run(async () => {
        const result = await applyCatalogMigration(this.preview);
        ui.notifications.info(`${game.i18n.localize("CYBERPUNK.CatalogMigrationResult")} (${result.updated})`);
        this.preview = await previewCatalogMigration();
      }));
    }
    async run(operation) {
      if(this.busy) return;
      this.busy = true;
      this.render();
      try { await operation(); }
      catch(error) { ui.notifications.error(error.message); }
      finally { this.busy = false; this.render(); }
    }
    async _updateObject() {}
  }
  game.settings.registerMenu(game.system.id, "catalogMigration", {
    name: "CYBERPUNK.CatalogMigrationName", label: "CYBERPUNK.CatalogMigrationPreview",
    hint: "CYBERPUNK.CatalogMigrationHint", icon: "fas fa-list-check", type: CatalogMigrationMenu, restricted: true
  });
}
