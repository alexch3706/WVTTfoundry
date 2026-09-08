import { sortSkills, SortOrders } from "./actor/skill-sort.js";
import { getDefaultSkills, tryLocalize } from "./utils.js";
import { isPrimaryActiveGm } from "./foundry-compat.js";
import { getLegacySkillTranslations } from "./legacy-skill-translations.js";

const updateFuncs = {
    "Actor": migrateActor,
    "Item": migrateItem
}

const FALLBACK_EMBEDDED_FIELDS = Object.freeze([
    // Core hierarchical fields.
    "items", "effects", "pages", "results", "tokens", "notes", "drawings",
    "tiles", "walls", "lights", "sounds", "regions", "behaviors", "templates",
    "combatants", "cards", "levels", "delta",
    // Adventure content uses SetField<EmbeddedDataField> rather than the
    // regular Document hierarchy, but may still contain system Documents.
    "actors", "combats", "journal", "scenes", "tables", "macros", "playlists", "folders"
]);
const PENDING_PACK_RELOCKS_SETTING = "migrationPendingPackRelocks";
// These ten role abilities existed in the pre-Item Actor template but were
// intentionally not part of the general default-skills pack. A pristine
// legacy Actor therefore contains zero-valued records for all ten. Do not
// turn those template defaults into ten new role Items for every Actor; any
// actual progress still makes the record user-owned and therefore migratable.
const LEGACY_TEMPLATE_ROLE_SKILLS = new Set([
    "authority",
    "charismaticleadership",
    "combatsense",
    "credibility",
    "family",
    "interface",
    "juryrig",
    "medicaltech",
    "resources",
    "streetdeal"
]);
// Migration writes stay deliberately sequential. Foundry Documents and packs
// share persistence backends, so bounded, ordered writes are safer than a
// large Promise.all() burst during a one-time World upgrade.
let migrationInFlight;
const FALLBACK_FORCED_DELETION = Object.freeze({ cyberpunkMigrationOperator: "ForcedDeletion" });
const MIGRATION_EMBEDDED_DELETIONS = Symbol("cyberpunkMigrationEmbeddedDeletions");

export function isPrimaryActiveGM(currentUser, users = []) {
    return isPrimaryActiveGm(currentUser, users);
}

// Handle migration of things. The shape of it nabbed from 5e.
// Return one in-flight operation to every caller so the ready hook and a
// manual console invocation cannot race each other into a false stamp.
export function migrateWorld() {
    if (!game.user?.isGM) {
        ui.notifications.error("Only the GM can migrate the world");
        return Promise.resolve(false);
    }
    if(!isPrimaryActiveGm(game.user, game.users)) {
        ui.notifications.error("Only the primary active GM can migrate the world");
        return Promise.resolve(false);
    }
    if(migrationInFlight) return migrationInFlight;

    const migration = runWorldMigration();
    const trackedMigration = migration.finally(() => {
        if(migrationInFlight === trackedMigration) migrationInFlight = undefined;
    });
    migrationInFlight = trackedMigration;
    return trackedMigration;
}

async function runWorldMigration() {
    try {
        const migratedDocuments = new Set();
        assertNoInvalidMigrationDocuments();
        for(const actor of game.actors.contents) {
            await migrateActorAndItems(actor, { throwOnError: true, migratedDocuments });
        }
        for(const item of game.items.contents) {
            await migrateDocumentOnce(item, { throwOnError: true, migratedDocuments });
        }
        await migrateSyntheticTokenActors(game.scenes?.contents || [], {
            throwOnError: true,
            migratedDocuments
        });
        const worldPacks = Array.from(game.packs?.contents || game.packs || [])
            .filter(pack => isMigratableCompendium(pack));
        for(const compendium of worldPacks) {
            await migrateCompendium(compendium);
        }
        assertNoPendingPackRelocks();
        assertNoInvalidMigrationDocuments();
        await game.settings.set(game.system.id, "systemMigrationVersion", game.system.version);
        const persistedVersion = game.settings.get(game.system.id, "systemMigrationVersion");
        if(persistedVersion !== game.system.version) {
            throw new Error("the migration completion marker was rejected");
        }
        ui.notifications.info(`Cyberpunk2020 System Migration to version ${game.system.version} completed!`, {permanent: true});
        return true;
    } catch(err) {
        console.error(`Cyberpunk2020 migration aborted: ${err.message}`);
        ui.notifications.error(`Cyberpunk2020 System Migration failed :( Please see console log for details`);
        return false;
    }
}

/** Migrate system data stored in ActorDelta for unlinked Scene tokens. */
export async function migrateSyntheticTokenActors(
    scenes = globalThis.game?.scenes?.contents || [],
    { throwOnError = false, migratedDocuments = new Set() } = {}
) {
    let actorsMigrated = 0;
    for(const scene of Array.from(scenes || [])) {
        const tokens = Array.from(scene?.tokens?.contents || scene?.tokens || []);
        for(const token of tokens) {
            if(token?.actorLink === true) continue;
            try {
                if(token?.actor) {
                    const migrated = await migrateActorAndItems(token.actor, { throwOnError, migratedDocuments });
                    if(migrated) actorsMigrated += 1;
                    continue;
                }
                if(token?.delta) {
                    await migrateDetachedActorDelta(token, { throwOnError });
                    actorsMigrated += 1;
                }
            } catch(error) {
                const sceneLabel = scene?.name || scene?.id || "unknown Scene";
                const tokenLabel = token?.name || token?.id || "unknown Token";
                const wrapped = new Error(
                    `Failed synthetic Actor migration for ${tokenLabel} in ${sceneLabel}: ${migrationErrorMessage(error)}`,
                    { cause: error }
                );
                console.error(wrapped);
                if(throwOnError) throw wrapped;
            }
        }
    }
    console.info(`CYBERPUNK | Migrated ${actorsMigrated} synthetic token actor(s)`);
    return actorsMigrated;
}

async function migrateActorAndItems(actor, { throwOnError = false, migratedDocuments = new Set() } = {}) {
    const actorResult = await migrateDocumentOnce(actor, { throwOnError, migratedDocuments });
    if(!actorResult.success) return false;
    for(const item of Array.from(actor?.items?.contents || actor?.items || [])) {
        const itemResult = await migrateDocumentOnce(item, { throwOnError, migratedDocuments });
        if(!itemResult.success) return false;
    }
    return true;
}

async function migrateDocumentOnce(
    document,
    { throwOnError = false, migratedDocuments = new Set(), applyUpdate = defaultDataUse } = {}
) {
    if(migratedDocuments.has(document)) return { success: true, changed: false };
    migratedDocuments.add(document);
    return migrateDocument(document, applyUpdate, { throwOnError });
}

/**
 * A Token's synthetic Actor is normally available after Game initialization.
 * If its base Actor is missing, migrate only lossless ActorDelta fields and
 * fail closed when legacy actor skills require the complete synthetic Actor.
 */
async function migrateDetachedActorDelta(token, { throwOnError = false } = {}) {
    const delta = token?.delta;
    const tokenSource = typeof token?.toObject === "function" ? token.toObject() : null;
    const deltaSource = typeof delta?.toObject === "function"
        ? delta.toObject()
        : tokenSource?.delta || {
            system: delta?.system,
            items: Array.from(delta?.items?.contents || delta?.items || [])
                .map(item => typeof item?.toObject === "function" ? item.toObject() : item)
        };

    if(deltaSource?.system?.skills) {
        throw new Error("the Token has legacy Actor skills but no synthetic Actor is available");
    }

    const update = {};
    if(typeof deltaSource?.system?.damage === "string") {
        update["system.damage"] = readLegacyDamage(
            deltaSource.system.damage,
            token?.name || token?.id || "detached ActorDelta"
        );
    }

    const sourceItems = deltaSource?.items;
    if(Array.isArray(sourceItems)) {
        let changed = false;
        let skillItemsChanged = false;
        const migratedItems = sourceItems.map(item => {
            const itemUpdate = migrateItem(item);
            if(isEmptyUpdate(itemUpdate)) return item;
            changed = true;
            skillItemsChanged ||= item?.type === "skill";
            return applyUpdateToPlainObject(item, itemUpdate);
        });
        // ActorDelta.items is a differential collection. A normal recursive
        // array update would merge obsolete fields back in and could not
        // express tombstones faithfully. This is the complete raw delta
        // source, so replacement is both necessary and safe here.
        if(changed) update.items = getForcedReplacementOperator(migratedItems);
        if(skillItemsChanged) update["system.sortedSkillIDs"] = null;
    }

    if(!isEmptyUpdate(update)) {
        if(typeof token?.update !== "function") {
            throw new Error("the owning Token cannot persist its detached ActorDelta");
        }
        const tokenUpdate = Object.fromEntries(
            Object.entries(update).map(([path, value]) => [`delta.${path}`, value])
        );
        const updatedToken = await token.update(tokenUpdate);
        if(!updatedToken) {
            throw new Error("the owning Token rejected its detached ActorDelta update");
        }
    }
}

const defaultDataUse = async (document, updateData) => {
    const deletionPlan = getEmbeddedDeletionPlan(updateData);
    const persistableUpdate = Object.fromEntries(Object.entries(updateData || {}));
    const deferredCleanup = {};
    // Keep the legacy marker until every duplicate is deleted. If deletion is
    // rejected halfway through, the next run can reconstruct and retry the
    // exact cleanup instead of stamping a world with orphaned aliases.
    if(deletionPlan.length > 0 && Object.hasOwn(persistableUpdate, "system.skills")) {
        deferredCleanup["system.skills"] = persistableUpdate["system.skills"];
        delete persistableUpdate["system.skills"];
    }
    if (!isEmptyUpdate(persistableUpdate)) {
        console.log(`Total update data for document ${document.name}:`);
        console.log(persistableUpdate);
        await persistMigrationDocumentUpdate(document, persistableUpdate);
    }
    for(const [documentName, ids] of deletionPlan) {
        if(typeof document?.deleteEmbeddedDocuments !== "function") {
            throw new Error(`${document?.name || document?.id || "Document"} cannot delete duplicate ${documentName} documents`);
        }
        const deleted = await document.deleteEmbeddedDocuments(documentName, ids);
        const deletedIds = new Set(Array.from(deleted || []).map(entry => entry?.id || entry?._id).filter(Boolean));
        if(ids.some(id => !deletedIds.has(id))) {
            throw new Error(`${document?.name || document?.id || "Document"} rejected deletion of duplicate ${documentName} documents`);
        }
    }
    if(!isEmptyUpdate(deferredCleanup)) {
        await persistMigrationDocumentUpdate(document, deferredCleanup);
    }
};

async function persistMigrationDocumentUpdate(document, update) {
    const updatedDocument = await document.update(update);
    if(!updatedDocument) {
        throw new Error(`${document?.name || document?.id || "Document"} rejected its migration update`);
    }
    return updatedDocument;
}

async function migrateDocument(document, applyUpdate = defaultDataUse, { throwOnError = false } = {}) {
    try {
        let migrateDataFunc = updateFuncs[document.documentName];
        if(migrateDataFunc === undefined) {
            console.log(`No migrate function for document with documentName field "${document.documentName}"`);
            return { success: true, changed: false };
        }
        const updateData = await migrateDataFunc(document);
        await applyUpdate(document, updateData);
        return { success: true, changed: !isEmptyUpdate(updateData) };
    } catch(err) {
        const wrapped = new Error(
            `Failed cyberpunk system migration for ${document?.type} ${document?.name}: ${migrationErrorMessage(err)}`,
            { cause: err }
        );
        console.error(wrapped);
        if(throwOnError) throw wrapped;
        return { success: false, changed: false };
    }
}

function migrationErrorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}

// For now, actors. We can do migrate world as a total of them all. Nabbed framework of code from 5e
/**
 * Migrate a single Actor document to incorporate latest cyberpunk2020-rilerena data model changes
 * Return an Object of updateData to be applied
 * @param {object} actor    The actor Document to update
 * @return {Object}         The updateData to apply (via `document.update`)
 */
export async function migrateActor(actor) {
    console.log(`Migrating data of ${actor.name}`);

    // No need to migrate items currently
    let actorUpdates = {}

    // This is derived display state. Clear it before any embedded Item write,
    // so a failed Actor update cannot leave a successfully migrated Skill
    // paired with stale ordering which a retry would no longer detect.
    if(actor.system?.sortedSkillIDs !== undefined && actor.system.sortedSkillIDs !== null) {
        invalidateSkillSortCache(actorUpdates, { syntheticActor: actor?.isToken === true });
    }

    if(typeof(actor.system?.damage) === "string") {
        console.log("Making damage a number");
        actorUpdates[`system.damage`] = readLegacyDamage(actor.system.damage, actor.name || actor.id || "Actor");
    }
    if(actor.type == "character") {
        const prototypeToken = actor.prototypeToken || actor.token || {};
        const actorLink = prototypeToken.actorLink;
        if(actorLink === undefined || actorLink === null) {
            console.log(`Giving ${actor.name}'s default token an explicit actor link setting`);
            actorUpdates[`prototypeToken.actorLink`] = true;
        }
        if(prototypeToken.disposition === undefined || prototypeToken.disposition === null) {
            actorUpdates[`prototypeToken.disposition`] = 1;
        }
        if(prototypeToken.sight?.enabled === undefined || prototypeToken.sight?.enabled === null) {
            console.log(`Giving ${actor.name}'s default token an explicit V14 vision setting`);
            // Very old Actor sources (including raw Adventure content) may
            // still expose vision/dimSight. Read those values as hints, but
            // always persist the canonical V14 prototypeToken.sight fields.
            const legacyVision = prototypeToken.vision;
            actorUpdates[`prototypeToken.sight.enabled`] = legacyVision === undefined || legacyVision === null
                ? true
                : normalizeLegacyBoolean(legacyVision);
            if(prototypeToken.sight?.range === undefined || prototypeToken.sight?.range === null) {
                const legacyRange = Number(prototypeToken.dimSight);
                actorUpdates[`prototypeToken.sight.range`] = Number.isFinite(legacyRange) ? legacyRange : 30;
            }
        }
    }
    
    // Trained legacy skills that we keep. These must be overlaid even when
    // Item skills already exist: a synthetic Actor may inherit those Items
    // from its base Actor while its ActorDelta still stores different values.
    const legacySkills = getLegacyActorSkills(actor);
    let trainedSkills = [];
    if(legacySkills) {
        console.log(`${actor.name} still uses non-item skills. Removing.`);
        actorUpdates["system.skills"] = getForcedDeletionOperator();

        trainedSkills = collectTrainedLegacySkills(legacySkills);
    }
    console.log(`Legacy skills to preserve: ${trainedSkills.map(skill => skill.item.name).join(", ") || "None"}`);
    const currentItems = Array.from(actor.items || []).map(item =>
        typeof item?.toObject === "function" ? item.toObject() : item
    );
    const skills = currentItems.filter(item => item.type === "skill");
    const syntheticActor = actor?.isToken === true;

    // Migrate from pre-item times
    if(skills.length === 0 && !syntheticActor) {
        console.log(`${actor.name} does not have item skills. Adding aaaall 78 core ones`);
        console.log(`Keeping any skills you had points in: ${trainedSkills.map(skill => skill.item.name).join(", ") || "None"}`);

        // Resolve raw legacy keys against the canonical English names shipped
        // by the default pack. Active UI locale is used only as a matching
        // alias, never as persisted Item identity.
        const skillsToAdd = (await getDefaultSkills()).map(item => item.toObject());
        for(const trainedSkill of trainedSkills) {
            const index = skillsToAdd.findIndex(item => legacySkillMatchesItem(trainedSkill, item));
            if(index === -1) {
                if(!trainedSkill.hasUserState
                    && LEGACY_TEMPLATE_ROLE_SKILLS.has(normalizeSkillName(trainedSkill.item.name))) continue;
                skillsToAdd.push(trainedSkill.item);
                continue;
            }
            const current = skillsToAdd[index];
            skillsToAdd[index] = {
                ...current,
                system: overlayLegacySkillValues(current.system, trainedSkill.item.system)
            };
        }
        const sortedSkills = sortSkills(skillsToAdd, SortOrders.Name);
        actorUpdates["system.skillsSortedBy"] = "Name";

        // TODO: This is repeated in a few places - centralise/refactor
        actorUpdates.items = currentItems.concat(sortedSkills);
        invalidateSkillSortCache(actorUpdates, { syntheticActor });
    } else if(trainedSkills.length > 0) {
        const matchedSkills = new Set();
        const duplicateIndices = new Set();
        const migrationByIndex = new Map();
        const additionalItems = [];
        for(const legacySkill of trainedSkills) {
            const matches = currentItems
                .map((item, index) => ({ item, index }))
                .filter(({ item }) => item?.type === "skill" && legacySkillMatchesItem(legacySkill, item));
            if(matches.length === 0) {
                if(syntheticActor) {
                    const inherited = resolveSyntheticLegacySkill(actor, legacySkill);
                    if(inherited.status === "tombstone") {
                        matchedSkills.add(legacySkill);
                        continue;
                    }
                    if(inherited.status === "inherited") {
                        if(legacySkill.hasUserState) {
                            additionalItems.push({
                                ...inherited.item,
                                system: overlayLegacySkillValues(inherited.item.system, legacySkill.item.system)
                            });
                        }
                        matchedSkills.add(legacySkill);
                    }
                }
                continue;
            }

            const canonicalName = normalizeSkillName(legacySkill.item.name);
            const canonical = matches.find(({ item }) => normalizeSkillName(item.name) === canonicalName) || matches[0];
            if(migrationByIndex.has(canonical.index)) {
                throw new Error(`multiple legacy skills resolve to the same Item ${canonical.item.name}`);
            }
            migrationByIndex.set(canonical.index, {
                legacySkill,
                duplicates: matches.filter(match => match.index !== canonical.index).map(match => match.item),
                overlayLegacy: syntheticActor
                    && legacySkill.hasUserState
                    && syntheticSkillMatchesAreInherited(actor, matches)
            });
            for(const match of matches) {
                if(match.index !== canonical.index) duplicateIndices.add(match.index);
            }
            matchedSkills.add(legacySkill);
        }

        const syntheticItemUpserts = [];
        const mergedItems = currentItems.flatMap((item, index) => {
            if(duplicateIndices.has(index)) return [];
            const migration = migrationByIndex.get(index);
            if(!migration) return [item];
            let merged = item;
            if(migration.duplicates.length === 0) {
                if(migration.overlayLegacy) {
                    merged = {
                        ...item,
                        system: overlayLegacySkillValues(item.system, migration.legacySkill.item.system)
                    };
                }
            } else {
                for(const duplicate of migration.duplicates) {
                    merged = mergeLocalizedLegacySkillDuplicate(merged, duplicate, migration.legacySkill, {
                        overlayLegacy: migration.overlayLegacy
                    });
                }
            }
            if(syntheticActor && (migration.overlayLegacy || migration.duplicates.length > 0)) {
                syntheticItemUpserts.push(merged);
            }
            return [merged];
        });
        mergedItems.push(...additionalItems);
        const unmatchedSkills = trainedSkills.filter(skill => !matchedSkills.has(skill));
        const materializedSkills = await filterLegacySkillsToMaterialize(unmatchedSkills);
        mergedItems.push(...materializedSkills.map(skill => skill.item));
        const itemsChanged = duplicateIndices.size > 0
            || additionalItems.length > 0
            || Array.from(migrationByIndex.values()).some(migration => migration.overlayLegacy)
            || materializedSkills.length > 0;
        if(itemsChanged) {
            // ActorDelta Item updates are differential. Sending the complete
            // effective synthetic collection would adopt every inherited Item
            // as a managed override and break future base-Actor inheritance.
            actorUpdates.items = syntheticActor
                ? syntheticItemUpserts.concat(additionalItems, materializedSkills.map(skill => skill.item))
                : mergedItems;
            invalidateSkillSortCache(actorUpdates, { syntheticActor });
        }
        if(duplicateIndices.size > 0) {
            const duplicateIds = [...duplicateIndices]
                .map(index => currentItems[index]?._id || currentItems[index]?.id)
                .filter(Boolean);
            if(duplicateIds.length !== duplicateIndices.size) {
                throw new Error("cannot safely delete a duplicate legacy skill Item without an ID");
            }
            setEmbeddedDeletionPlan(actorUpdates, "Item", duplicateIds);
        }
    }

    return actorUpdates;
}

function getLegacyActorSkills(actor) {
    // DataModel cleaning normally preserves unknown template keys because a
    // System's strictDataCleaning defaults to false in V14. Read the public
    // source representation as well so an explicitly strict installation
    // cannot hide legacy skills before this migration gets a chance to move
    // them into embedded Items.
    if(actor?.isToken === true) {
        const delta = actor?.token?.delta;
        if(typeof delta?.toObject !== "function") {
            throw new Error("synthetic Actor cannot expose its raw V14 ActorDelta source");
        }
        let deltaSource;
        try {
            deltaSource = delta.toObject();
        } catch(error) {
            throw new Error("synthetic Actor cannot read its raw V14 ActorDelta source", { cause: error });
        }
        if(!deltaSource || typeof deltaSource !== "object") {
            throw new Error("synthetic Actor returned an invalid raw V14 ActorDelta source");
        }
        // An absent delta field is authoritative. Falling through to the
        // effective synthetic Actor would mistake inherited base-Actor legacy
        // state for a token-specific override.
        return deltaSource.system?.skills;
    }

    let source;
    try {
        source = typeof actor?.toObject === "function" ? actor.toObject() : null;
    } catch {
        source = null;
    }
    return source?.system?.skills ?? actor?.system?.skills;
}

function collectTrainedLegacySkills(skills) {
    const result = [];

    for(const [name, skill] of Object.entries(skills || {})) {
        if(!skill || typeof skill !== "object" || Array.isArray(skill)) {
            throw new Error(`legacy skill ${name} has malformed data`);
        }
        if(skill.group) {
            for(const [subskillName, subskill] of Object.entries(skill)) {
                if(subskillName === "group") continue;
                if(!subskill || typeof subskill !== "object" || Array.isArray(subskill)) {
                    throw new Error(`legacy skill ${name}:${subskillName} has malformed data`);
                }
                const identifier = `${name}:${subskillName}`;
                const descriptor = createLegacySkillDescriptor(identifier, subskill, {
                    parentName: name,
                    subskillName
                });
                if(shouldPreserveLegacySkill(identifier, descriptor)) result.push(descriptor);
            }
            continue;
        }
        // Preserve even zero-valued custom skills. Existing Item skills remain
        // authoritative, while an unmatched descriptor may be the only record
        // that a user-created Expert or Language skill existed.
        const descriptor = createLegacySkillDescriptor(name, skill);
        if(shouldPreserveLegacySkill(name, descriptor)) result.push(descriptor);
    }
    return result;
}

function shouldPreserveLegacySkill(identifier, descriptor) {
    if(!LEGACY_TEMPLATE_ROLE_SKILLS.has(normalizeSkillName(identifier))) return true;
    return descriptor.hasUserState;
}

async function filterLegacySkillsToMaterialize(skills) {
    if(skills.length === 0) return [];
    const materialized = skills.filter(skill => skill.hasUserState);
    const zeroState = skills.filter(skill => !skill.hasUserState);
    if(zeroState.length === 0) return materialized;

    const defaults = (await getDefaultSkills()).map(item =>
        typeof item?.toObject === "function" ? item.toObject() : item
    );
    for(const skill of zeroState) {
        const isBuiltIn = LEGACY_TEMPLATE_ROLE_SKILLS.has(normalizeSkillName(skill.item.name))
            || defaults.some(item => item?.type === "skill" && legacySkillMatchesItem(skill, item));
        if(!isBuiltIn) materialized.push(skill);
    }
    return materialized;
}

function createLegacySkillDescriptor(identifier, skillData, { parentName, subskillName } = {}) {
    const item = convertOldSkill(identifier, skillData);
    const aliases = new Set([
        normalizeSkillName(identifier),
        normalizeSkillName(item.name)
    ]);

    if(parentName && subskillName) {
        const prefix = humanizeLegacySkillKey(parentName);
        const localizedSubskills = new Set([
            subskillName,
            tryLocalize(`Skill${subskillName}`, subskillName),
            ...getLegacySkillTranslations(subskillName)
        ]);
        for(const localizedSubskill of localizedSubskills) {
            // The old migration kept the group prefix in Spanish and Italian.
            aliases.add(normalizeSkillName(`${prefix}: ${localizedSubskill}`));
            // The old English Martial Arts keys performed a second lookup
            // which stripped that prefix, leaving an Item named just Karate,
            // Boxing, and so on.
            if(parentName === "MartialArts") aliases.add(normalizeSkillName(localizedSubskill));
        }
        // Foundry returns the localization key itself when a translation is
        // missing. The 1.x migration used an unconditional localize() call,
        // so custom group entries (and several English martial arts) could
        // persist this literal key inside the Item name.
        aliases.add(normalizeSkillName(`${prefix}: CYBERPUNK.Skill${subskillName}`));
        aliases.add(normalizeSkillName(tryLocalize(`Skill${item.name}`, item.name)));
    } else {
        aliases.add(normalizeSkillName(tryLocalize(`Skill${identifier}`, identifier)));
        for(const localizedName of getLegacySkillTranslations(identifier)) {
            aliases.add(normalizeSkillName(localizedName));
        }
    }
    return { item, aliases, hasUserState: hasSkillProgress(item.system) };
}

function legacySkillMatchesItem(legacySkill, item) {
    return legacySkill.aliases.has(normalizeSkillName(item?.name));
}

function getSyntheticDeltaItems(actor) {
    const items = actor?.token?.delta?.items;
    if(typeof items?.manages !== "function" || typeof items?.isTombstone !== "function") {
        throw new Error("synthetic Actor does not expose its V14 ActorDelta Item collection");
    }
    return items;
}

function syntheticSkillMatchesAreInherited(actor, matches) {
    const deltaItems = getSyntheticDeltaItems(actor);
    return matches.every(({ item }) => {
        const id = item?._id || item?.id;
        if(!id) throw new Error(`synthetic skill ${item?.name || "unknown"} has no ID`);
        return !deltaItems.manages(id);
    });
}

function resolveSyntheticLegacySkill(actor, legacySkill) {
    const deltaItems = getSyntheticDeltaItems(actor);
    const baseItems = deltaItems.baseCollection;
    if(!baseItems || typeof baseItems[Symbol.iterator] !== "function") {
        throw new Error("synthetic Actor does not expose its V14 base Item collection");
    }
    const baseItem = Array.from(baseItems).find(item =>
        item?.type === "skill" && legacySkillMatchesItem(legacySkill, item)
    );
    if(!baseItem) return { status: "missing" };

    const id = baseItem.id || baseItem._id;
    if(!id) throw new Error(`base skill ${baseItem?.name || "unknown"} has no ID`);
    if(deltaItems.isTombstone(id)) return { status: "tombstone" };
    if(deltaItems.manages(id)) {
        throw new Error(`managed synthetic skill ${baseItem.name} is absent from the synthetic Actor`);
    }
    return {
        status: "inherited",
        item: typeof baseItem.toObject === "function" ? baseItem.toObject() : cloneMigrationSource(baseItem)
    };
}

function normalizeSkillName(value) {
    return String(value || "")
        .normalize("NFKC")
        .toLocaleLowerCase("en-US")
        .replace(/[^\p{L}\p{N}]+/gu, "");
}

function humanizeLegacySkillKey(value) {
    return String(value || "")
        .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
        .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
        .trim();
}

function formatLegacySkillName(identifier) {
    return String(identifier || "")
        .split(":")
        .map(humanizeLegacySkillKey)
        .join(": ");
}

export function migrateItem(item) {
    console.log(`Migrating data of ${item.name}`);

    // No need to migrate items currently
    let itemUpdates = {}
    let system = item.system;
    if(!system || typeof system !== "object") return itemUpdates;
    const itemModel = game.model?.Item?.[item.type];
    let itemTemplates = itemModel?.templates;

    if(itemTemplates?.includes("common") && system.source === undefined) {
        console.log(`${item.name} has no source field. Giving it one.`)
        itemUpdates["system.source"] = "";
    }
    if(item.type === "skill") {
        // A previous Skill sheet wrote the chip toggle to `system.chipped`,
        // while runtime calculations read `system.isChipped`. Preserve that
        // user choice before removing the obsolete field.
        if(system.chipped !== undefined) {
            const legacyChipped = normalizeLegacyBoolean(system.chipped);
            // The template may already have supplied the default false even
            // when the persisted legacy choice was true. Prefer an enabled
            // value from either field so migration cannot silently unchip a
            // skill that was configured through the old Item sheet.
            if(system.isChipped === undefined || (legacyChipped && !normalizeLegacyBoolean(system.isChipped))) {
                itemUpdates["system.isChipped"] = legacyChipped;
            }
            itemUpdates["system.chipped"] = getForcedDeletionOperator();
        }
    }
    if(item.type === "weapon") {
        if(Array.isArray(system.rangeDamages)) {
            // Older migrations initialized this field as a five-element
            // array. Convert its four supported bands, but fail closed if an
            // installation used the spare slot for real data.
            const unsupportedTail = system.rangeDamages.slice(4);
            if(unsupportedTail.some(value => !isBlankMigrationValue(value) && value !== 0)) {
                throw new Error(
                    `${item.name || "weapon"} has unsupported legacy range damage data beyond the four V14 bands`
                );
            }
            const [pointBlank = "", close = "", medium = "", far = ""] = system.rangeDamages;
            itemUpdates["system.rangeDamages"] = { pointBlank, close, medium, far };
        }
        else if(!system.rangeDamages) {
            console.log(`${item.name} has no place to put damages per range. Instantiating those.`);
            const weaponModel = game.model?.Item?.weapon;
            itemUpdates["system.rangeDamages"] = weaponModel?.rangeDamages || {
                pointBlank: "",
                close: "",
                medium: "",
                far: ""
            };
        }
        else if(system.rangeDamages.short !== undefined) {
            // The old sheet saved the close-range formula under `short`; the
            // schema and resolver use `close`.
            if(!system.rangeDamages.close && system.rangeDamages.short) {
                itemUpdates["system.rangeDamages.close"] = system.rangeDamages.short;
            }
            itemUpdates["system.rangeDamages.short"] = getForcedDeletionOperator();
        }
    }
    return itemUpdates;
}

function normalizeLegacyBoolean(value) {
    if(typeof value === "string") {
        return ["true", "1", "on", "yes"].includes(value.trim().toLowerCase());
    }
    return value === true || value === 1;
}

function readLegacyDamage(value, identity) {
    if(value.trim() === "") return 0;
    const damage = Number(value);
    if(!Number.isFinite(damage)) {
        throw new Error(`${identity} has invalid legacy damage value ${JSON.stringify(value)}`);
    }
    return damage;
}

export async function migrateCompendium(compendium) {
    if(!isMigratableCompendium(compendium)) {
        throw new Error(`Refusing to migrate non-world compendium ${compendium?.collection || "unknown"}`);
    }

    const title = compendium.title || compendium.collection;
    const collection = compendium.collection;
    const pendingRelocks = readPendingPackRelocks();
    const wasLocked = compendium.locked === true;
    const mustRelock = wasLocked || pendingRelocks.has(collection);
    let migrationError;
    let documentsMigrated = 0;
    const migratedDocuments = new Set();

    try {
        if(mustRelock && !pendingRelocks.has(collection)) {
            pendingRelocks.add(collection);
            await persistPendingPackRelocks(pendingRelocks);
        }
        if(compendium.locked === true) {
            if(typeof compendium.configure !== "function") {
                throw new Error(`World compendium ${title} is locked and cannot be configured`);
            }
            await compendium.configure({ locked: false });
            if(compendium.locked) throw new Error(`World compendium ${title} remained locked after configure()`);
        }

        if(typeof compendium.getDocuments !== "function") {
            throw new Error(`World compendium ${title} does not expose getDocuments()`);
        }
        console.log(`Updating Documents in world compendium ${title}`);
        const documents = await compendium.getDocuments();
        assertNoInvalidDocumentTrees(documents, `Compendium ${compendium.collection || title}`, { collection: compendium });
        for(const document of documents) {
            await migrateCompendiumDocument(document, { migratedDocuments });
            documentsMigrated += 1;
        }
        assertNoInvalidDocumentTrees(documents, `Compendium ${compendium.collection || title}`, { collection: compendium });
    } catch(error) {
        migrationError = error;
    } finally {
        if(mustRelock) {
            try {
                if(typeof compendium.configure !== "function") {
                    throw new Error(`World compendium ${title} cannot restore its locked state`);
                }
                await compendium.configure({ locked: true });
                if(!compendium.locked) throw new Error(`World compendium ${title} remained unlocked after configure()`);
                const remainingRelocks = readPendingPackRelocks();
                remainingRelocks.delete(collection);
                await persistPendingPackRelocks(remainingRelocks);
            } catch(error) {
                if(migrationError) {
                    migrationError = new AggregateError(
                        [migrationError, error],
                        `Migration and lock restoration both failed for world compendium ${title}`
                    );
                } else migrationError = error;
            }
        }
    }

    if(migrationError) throw migrationError;
    return { collection: compendium.collection, documentsMigrated, restoredLock: mustRelock };
}

function readPendingPackRelocks() {
    if(typeof globalThis.game?.settings?.get !== "function") {
        throw new Error("World settings are unavailable for migration lock recovery");
    }
    const raw = game.settings.get(game.system.id, PENDING_PACK_RELOCKS_SETTING);
    let entries;
    try {
        entries = Array.isArray(raw) ? raw : JSON.parse(raw || "[]");
    } catch(error) {
        throw new Error("the migration pack-relock journal is malformed", { cause: error });
    }
    if(!Array.isArray(entries) || entries.some(entry => typeof entry !== "string" || !entry.startsWith("world."))) {
        throw new Error("the migration pack-relock journal contains invalid entries");
    }
    return new Set(entries);
}

async function persistPendingPackRelocks(collections) {
    if(typeof globalThis.game?.settings?.set !== "function") {
        throw new Error("World settings cannot persist migration lock recovery");
    }
    const expected = [...collections].sort();
    await game.settings.set(game.system.id, PENDING_PACK_RELOCKS_SETTING, JSON.stringify(expected));
    const actual = [...readPendingPackRelocks()].sort();
    if(!migrationValuesEqual(actual, expected)) {
        throw new Error("the migration pack-relock journal update was rejected");
    }
}

function assertNoPendingPackRelocks() {
    const pending = [...readPendingPackRelocks()];
    if(pending.length > 0) {
        throw new Error(`World compendia still require lock restoration: ${pending.join(", ")}`);
    }
}

/**
 * Only mutable World-owned packs are migrated at runtime. Packs shipped by
 * this system are already converted and audited before release; module and
 * system package files must never be rewritten from inside a user's World.
 */
export function isMigratableCompendium(compendium) {
    return String(compendium?.collection || "").startsWith("world.");
}

/**
 * Abort rather than stamp a migration that silently skipped Documents which
 * Foundry V14 could not initialize and therefore omitted from `contents`.
 */
export function assertNoInvalidMigrationDocuments(gameRef = globalThis.game) {
    const collections = [];
    if(gameRef?.collections?.entries) {
        for(const [key, collection] of gameRef.collections.entries()) {
            collections.push([`World collection ${key}`, collection]);
        }
    } else {
        for(const key of ["actors", "items", "macros", "journal", "tables", "scenes", "cards", "playlists", "combats", "messages"]) {
            if(gameRef?.[key]) collections.push([`World collection ${key}`, gameRef[key]]);
        }
    }
    for(const pack of Array.from(gameRef?.packs?.contents || gameRef?.packs || [])
        .filter(isMigratableCompendium)) {
        collections.push([`Compendium ${pack.collection || pack.title || "unknown"}`, pack]);
    }

    const invalid = [];
    const seenCollections = new Set();
    const seenDocuments = new Set();
    for(const [label, collection] of collections) {
        collectInvalidCollectionEntries(collection, label, invalid, seenCollections, seenDocuments);
    }
    if(invalid.length > 0) {
        throw new Error(
            `Foundry could not initialize ${invalid.length} Document(s); migration cannot safely continue: ${invalid.join(", ")}`
        );
    }
    return true;
}

function assertNoInvalidDocumentTrees(documents, label, { collection } = {}) {
    const invalid = [];
    const seenCollections = new Set();
    const seenDocuments = new Set();
    if(collection) {
        collectInvalidCollectionEntries(collection, label, invalid, seenCollections, seenDocuments);
    }
    for(const document of Array.from(documents || [])) {
        collectInvalidDocumentEntries(document, label, invalid, seenCollections, seenDocuments);
    }
    if(invalid.length > 0) {
        throw new Error(
            `Foundry could not initialize ${invalid.length} embedded Document(s); migration cannot safely continue: ${invalid.join(", ")}`
        );
    }
}

function collectInvalidCollectionEntries(collection, label, invalid, seenCollections, seenDocuments) {
    if(!collection || typeof collection !== "object" || seenCollections.has(collection)) return;
    seenCollections.add(collection);
    for(const id of Array.from(collection.invalidDocumentIds || [])) invalid.push(`${label}: ${id}`);
    for(const document of migrationCollectionContents(collection)) {
        collectInvalidDocumentEntries(document, label, invalid, seenCollections, seenDocuments);
    }
}

function collectInvalidDocumentEntries(document, parentLabel, invalid, seenCollections, seenDocuments) {
    if(!document || typeof document !== "object" || seenDocuments.has(document)) return;
    seenDocuments.add(document);
    const identity = document.uuid || document.name || document.id || document._id || document.documentName || "Document";
    const label = `${parentLabel} > ${identity}`;
    collectDocumentValidationFailures(document, label, invalid);
    const fields = new Set(Object.keys(document.constructor?.hierarchy || {}));
    for(const field of FALLBACK_EMBEDDED_FIELDS) {
        if(field in document) fields.add(field);
    }

    for(const field of fields) {
        let value;
        try {
            value = document[field];
        } catch(error) {
            invalid.push(`${label}.${field}: inaccessible (${error.message})`);
            continue;
        }
        if(!value || typeof value !== "object") continue;
        if(isMigrationCollection(value)) {
            collectInvalidCollectionEntries(value, `${label}.${field}`, invalid, seenCollections, seenDocuments);
        } else {
            collectInvalidDocumentEntries(value, `${label}.${field}`, invalid, seenCollections, seenDocuments);
        }
    }
}

function collectDocumentValidationFailures(document, label, invalid) {
    let failures;
    try {
        failures = document.validationFailures;
    } catch(error) {
        invalid.push(`${label}: validation state inaccessible (${error.message})`);
        return;
    }
    if(!failures || typeof failures !== "object") return;
    for(const [category, failure] of Object.entries(failures)) {
        if(!hasRecordedValidationFailure(failure)) continue;
        let paths = [];
        try {
            if(typeof failure.getAllFailures === "function") {
                paths = Object.keys(failure.getAllFailures() || {});
            }
        } catch {
            // The public `empty` flag below is sufficient to fail closed.
        }
        const pathSummary = paths.length > 0 ? ` (${paths.slice(0, 5).join(", ")})` : "";
        invalid.push(`${label}: ${category} validation failure${pathSummary}`);
    }
}

function hasRecordedValidationFailure(failure) {
    if(!failure || typeof failure !== "object") return false;
    if(typeof failure.empty === "boolean") return !failure.empty;
    if(failure.unresolved || failure.dropped || failure.joint) return true;
    if(Object.keys(failure.fields || {}).length > 0) return true;
    if(Array.isArray(failure.elements) && failure.elements.length > 0) return true;
    try {
        return typeof failure.getAllFailures === "function"
            && Object.keys(failure.getAllFailures() || {}).length > 0;
    } catch {
        return true;
    }
}

function isMigrationCollection(value) {
    return Array.isArray(value)
        || value?.invalidDocumentIds instanceof Set
        || Array.isArray(value?.contents)
        || (!value?.documentName && typeof value?.values === "function");
}

function migrationCollectionContents(collection) {
    if(!collection) return [];
    if(Array.isArray(collection)) return collection;
    if(Array.isArray(collection.contents)) return collection.contents;
    if(typeof collection.values === "function") return Array.from(collection.values());
    if(typeof collection[Symbol.iterator] === "function") return Array.from(collection);
    return [];
}

function overlayLegacySkillValues(current = {}, legacy = {}) {
    const merged = { ...current };
    for(const field of ["level", "chipLevel", "isChipped", "ip", "isRoleSkill", "stat"]) {
        if(legacy[field] !== undefined) merged[field] = legacy[field];
    }
    if(merged.diffMod === undefined && legacy.diffMod !== undefined) merged.diffMod = legacy.diffMod;
    return merged;
}

const SKILL_PROGRESS_FIELDS = Object.freeze(["level", "chipLevel", "isChipped", "ip"]);
const SKILL_STATE_FIELDS = Object.freeze([...SKILL_PROGRESS_FIELDS, "isRoleSkill", "stat"]);

/**
 * Version 1.x could create both a canonical skill and a localized trained
 * alias (for example Handgun and Armas Cortas). Fold the alias into the
 * canonical, stable-ID Item. Current Item progress wins over the stale legacy
 * Actor object; ambiguous edits fail closed instead of discarding user data.
 */
function mergeLocalizedLegacySkillDuplicate(canonical, duplicate, legacySkill, { overlayLegacy = false } = {}) {
    const canonicalSystem = canonical.system || {};
    const duplicateSystem = duplicate.system || {};
    const canonicalHasProgress = hasSkillProgress(canonicalSystem);
    const duplicateHasProgress = hasSkillProgress(duplicateSystem);
    if(canonicalHasProgress && duplicateHasProgress
        && !migrationValuesEqual(skillProgress(canonicalSystem), skillProgress(duplicateSystem))) {
        throw new Error(
            `duplicate localized skill Items ${canonical.name} and ${duplicate.name} both contain divergent progress; `
            + "resolve them manually before migrating"
        );
    }

    for(const field of ["isRoleSkill", "stat"]) {
        const canonicalValue = canonicalSystem[field];
        const duplicateValue = duplicateSystem[field];
        if(canonicalValue === undefined || duplicateValue === undefined) continue;
        const normalizedCanonical = field === "isRoleSkill"
            ? normalizeLegacyBoolean(canonicalValue)
            : canonicalValue;
        const normalizedDuplicate = field === "isRoleSkill"
            ? normalizeLegacyBoolean(duplicateValue)
            : duplicateValue;
        if(!migrationValuesEqual(normalizedCanonical, normalizedDuplicate)) {
            throw new Error(
                `duplicate localized skill Items ${canonical.name} and ${duplicate.name} contain divergent ${field}; `
                + "resolve them manually before migrating"
            );
        }
    }

    const progressSource = overlayLegacy
        ? legacySkill.item.system
        : duplicateHasProgress ? duplicateSystem : canonicalSystem;
    const system = overlayLegacy
        ? overlayLegacySkillValues(canonicalSystem, legacySkill.item.system)
        : { ...canonicalSystem };
    for(const field of SKILL_STATE_FIELDS) {
        if(progressSource?.[field] !== undefined) system[field] = progressSource[field];
    }
    for(const field of ["isRoleSkill", "stat"]) {
        if(system[field] === undefined && duplicateSystem[field] !== undefined) {
            system[field] = duplicateSystem[field];
        }
    }

    for(const [field, value] of Object.entries(duplicateSystem)) {
        if(SKILL_STATE_FIELDS.includes(field) || value === undefined) continue;
        if(field === "diffMod" && Number(value) === 1) continue;
        const current = system[field];
        if(isBlankMigrationValue(value)) continue;
        if(isBlankMigrationValue(current)) {
            system[field] = cloneMigrationSource(value);
            continue;
        }
        if(!migrationValuesEqual(current, value)) {
            throw new Error(
                `duplicate localized skill Items ${canonical.name} and ${duplicate.name} contain divergent ${field}; `
                + "resolve them manually before migrating"
            );
        }
    }

    const merged = { ...canonical, system };
    for(const field of ["flags", "effects"]) {
        const value = duplicate[field];
        if(isBlankMigrationValue(value)) continue;
        if(isBlankMigrationValue(merged[field])) merged[field] = cloneMigrationSource(value);
        else if(!migrationValuesEqual(merged[field], value)) {
            throw new Error(
                `duplicate localized skill Items ${canonical.name} and ${duplicate.name} contain divergent ${field}; `
                + "resolve them manually before migrating"
            );
        }
    }
    if(isCustomItemImage(duplicate.img)) {
        if(!isCustomItemImage(merged.img)) merged.img = duplicate.img;
        else if(merged.img !== duplicate.img) {
            throw new Error(
                `duplicate localized skill Items ${canonical.name} and ${duplicate.name} contain divergent images; `
                + "resolve them manually before migrating"
            );
        }
    }
    console.info(`CYBERPUNK | Folded localized legacy skill ${duplicate.name} into ${canonical.name}`);
    return merged;
}

function hasSkillProgress(system = {}) {
    return Number(system.level || 0) !== 0
        || Number(system.chipLevel || 0) !== 0
        || Number(system.ip || 0) !== 0
        || normalizeLegacyBoolean(system.isChipped);
}

function skillProgress(system = {}) {
    return {
        level: Number(system.level || 0),
        chipLevel: Number(system.chipLevel || 0),
        isChipped: normalizeLegacyBoolean(system.isChipped),
        ip: Number(system.ip || 0)
    };
}

function isBlankMigrationValue(value) {
    if(value === undefined || value === null || value === "") return true;
    if(Array.isArray(value)) return value.length === 0;
    return typeof value === "object" && Object.keys(value).length === 0;
}

function migrationValuesEqual(left, right) {
    if(globalThis.foundry?.utils?.equals) return foundry.utils.equals(left, right);
    return JSON.stringify(left) === JSON.stringify(right);
}

function isCustomItemImage(image) {
    return typeof image === "string"
        && image.length > 0
        && image !== "icons/svg/item-bag.svg"
        && image !== "icons/svg/mystery-man.svg";
}

async function migrateCompendiumDocument(document, { migratedDocuments = new Set() } = {}) {
    if(document?.documentName === "Adventure") {
        await migrateAdventureDocument(document);
        return;
    }

    const hierarchy = [{ path: "", document }];
    if(typeof document?.traverseEmbeddedDocuments === "function") {
        for(const [path, descendant] of document.traverseEmbeddedDocuments()) {
            hierarchy.push({ path: String(path || ""), document: descendant });
        }
    }

    for(const entry of hierarchy) {
        // ActorDelta state must be persisted through its owning TokenDocument;
        // Scene migration below handles its synthetic Actor or lossless raw
        // fallback as one unit.
        if(entry.path.split(".").includes("delta")) continue;
        const current = entry.document;
        if(current?.documentName === "Actor") {
            await migrateActorAndItems(current, { throwOnError: true, migratedDocuments });
        } else if(current?.documentName === "Item") {
            await migrateDocumentOnce(current, { throwOnError: true, migratedDocuments });
        } else if(current?.documentName === "Scene") {
            await migrateSyntheticTokenActors([current], { throwOnError: true, migratedDocuments });
        }
    }
}

/**
 * Adventure content is stored as SetField<EmbeddedDataField>, not normal
 * independently updatable embedded Documents. Modernize its source and write
 * each changed top-level content field back through the Adventure Document.
 */
async function migrateAdventureDocument(adventure) {
    if(typeof adventure?.toObject !== "function" || typeof adventure?.update !== "function") {
        throw new Error(`Adventure ${adventure?.name || adventure?.id || "unknown"} cannot expose and persist its content`);
    }
    const source = adventure.toObject();
    const update = {};

    const actors = [];
    let actorsChanged = false;
    for(const actor of Array.from(source.actors || [])) {
        const result = await migratePlainActorSource(actor);
        actors.push(result.value);
        actorsChanged ||= result.changed;
    }
    if(actorsChanged) update.actors = actors;
    const actorsById = new Map(actors.map(actor => [actor._id || actor.id, actor]));

    const items = [];
    let itemsChanged = false;
    for(const item of Array.from(source.items || [])) {
        const result = migratePlainItemSource(item);
        items.push(result.value);
        itemsChanged ||= result.changed;
    }
    if(itemsChanged) update.items = items;

    const scenes = [];
    let scenesChanged = false;
    for(const scene of Array.from(source.scenes || [])) {
        const result = await migratePlainSceneSource(scene, actorsById);
        scenes.push(result.value);
        scenesChanged ||= result.changed;
    }
    if(scenesChanged) update.scenes = scenes;

    if(!isEmptyUpdate(update)) {
        const updatedAdventure = await adventure.update(update);
        if(!updatedAdventure) {
            throw new Error(`Adventure ${adventure?.name || adventure?.id || "unknown"} rejected its migration update`);
        }
    }
}

async function migratePlainActorSource(source) {
    let actor = cloneMigrationSource(source);
    let changed = false;
    const actorUpdate = await migrateActor(actor);
    if(!isEmptyUpdate(actorUpdate)) {
        actor = applyUpdateToPlainObject(actor, actorUpdate);
        changed = true;
    }
    if(assignMissingPlainItemIds(actor)) changed = true;

    const items = [];
    let itemsChanged = false;
    let skillItemsChanged = false;
    for(const item of Array.from(actor.items || [])) {
        const result = migratePlainItemSource(item);
        items.push(result.value);
        itemsChanged ||= result.changed;
        skillItemsChanged ||= result.changed && item?.type === "skill";
    }
    if(itemsChanged) {
        actor.items = items;
        changed = true;
    }
    if(skillItemsChanged) {
        delete actor.system?.sortedSkillIDs;
        changed = true;
    }
    return { value: actor, changed };
}

function migratePlainItemSource(source) {
    const item = cloneMigrationSource(source);
    const update = migrateItem(item);
    return {
        value: isEmptyUpdate(update) ? item : applyUpdateToPlainObject(item, update),
        changed: !isEmptyUpdate(update)
    };
}

function assignMissingPlainItemIds(actor) {
    const items = Array.from(actor?.items || []);
    if(items.every(item => item?._id || item?.id)) return false;
    const actorId = actor?._id || actor?.id;
    if(!actorId) {
        throw new Error(`cannot assign migrated embedded Item IDs for Actor ${actor?.name || "unknown"} without an ID`);
    }
    const usedIds = new Set(items.map(item => item?._id || item?.id).filter(Boolean));
    for(let index = 0; index < items.length; index += 1) {
        const item = items[index];
        if(item?._id || item?.id) continue;
        let salt = 0;
        let id;
        do {
            id = deterministicMigrationDocumentId(
                `${actorId}:${index}:${item?.type || "Item"}:${item?.name || "Unnamed"}`,
                salt
            );
            salt += 1;
        } while(usedIds.has(id));
        item._id = id;
        usedIds.add(id);
    }
    return true;
}

function deterministicMigrationDocumentId(seed, salt = 0) {
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    const input = `${seed}:${salt}`;
    let first = 0x811c9dc5;
    let second = 0x9e3779b9;
    for(let index = 0; index < input.length; index += 1) {
        const code = input.charCodeAt(index);
        first = Math.imul(first ^ code, 0x01000193) >>> 0;
        second = Math.imul(second ^ code, 0x85ebca6b) >>> 0;
    }
    let id = "";
    for(let index = 0; index < 16; index += 1) {
        first = Math.imul(first ^ (first >>> 15), 0x2c1b3c6d) >>> 0;
        second = Math.imul(second ^ (second >>> 13), 0x297a2d39) >>> 0;
        id += alphabet[((first ^ second) >>> 0) % alphabet.length];
    }
    return id;
}

async function migratePlainSceneSource(source, actorsById) {
    const scene = cloneMigrationSource(source);
    if(!Array.isArray(scene.tokens)) return { value: scene, changed: false };
    let changed = false;
    const tokens = [];
    for(const token of scene.tokens) {
        if(token?.actorLink === true || !token?.delta) {
            tokens.push(token);
            continue;
        }
        let baseActor = actorsById.get(token.actorId);
        if(!baseActor) {
            const worldActor = globalThis.game?.actors?.get?.(token.actorId);
            baseActor = typeof worldActor?.toObject === "function" ? worldActor.toObject() : worldActor;
        }
        const result = await migratePlainActorDeltaSource(token.delta, baseActor, {
            sceneId: scene?._id || scene?.id,
            tokenId: token?._id || token?.id
        });
        if(result.changed) changed = true;
        tokens.push(result.changed ? { ...token, delta: result.value } : token);
    }
    scene.tokens = tokens;
    return { value: scene, changed };
}

async function migratePlainActorDeltaSource(source, baseActor, { sceneId, tokenId } = {}) {
    const delta = cloneMigrationSource(source);
    let changed = false;
    delta.system ||= {};

    if(typeof delta.system.damage === "string") {
        delta.system.damage = readLegacyDamage(delta.system.damage, "Adventure ActorDelta");
        changed = true;
    }

    const deltaItems = Array.from(delta.items || []).map(cloneMigrationSource);
    let skillItemsChanged = false;
    const legacySkills = delta.system.skills;
    if(legacySkills) {
        if(!baseActor) {
            throw new Error("an Adventure Scene token has legacy ActorDelta skills but its base Actor is unavailable");
        }
        const baseItems = Array.from(baseActor.items || []);
        const legacySkillDescriptors = collectTrainedLegacySkills(legacySkills);
        const handledSkills = new Set();
        for(const trainedSkill of legacySkillDescriptors) {
            const baseMatches = baseItems.filter(item =>
                item?.type === "skill" && legacySkillMatchesItem(trainedSkill, item)
            );
            const effectiveMatches = [];
            const matchedDeltaIndices = new Set();
            let explicitlyDeleted = false;

            // Resolve the effective ActorDelta collection, not just the raw
            // delta. A raw record with a base Item ID shadows that base Item;
            // a tombstone is an authoritative per-token deletion.
            for(const baseItem of baseMatches) {
                const baseId = baseItem?._id || baseItem?.id;
                if(!baseId) throw new Error(`base skill ${baseItem?.name || "unknown"} has no ID`);
                const deltaIndex = deltaItems.findIndex(item =>
                    item !== null && (item?._id || item?.id) === baseId
                );
                if(deltaIndex >= 0) {
                    matchedDeltaIndices.add(deltaIndex);
                    if(deltaItems[deltaIndex]?._tombstone) {
                        explicitlyDeleted = true;
                    } else {
                        effectiveMatches.push({
                            origin: "delta",
                            item: deltaItems[deltaIndex],
                            index: deltaIndex,
                            baseItem
                        });
                    }
                } else {
                    effectiveMatches.push({ origin: "base", item: baseItem });
                }
            }

            // Include token-only Items whose IDs do not correspond to a base
            // Item. This is how the 1.x locale-dependent migration could
            // leave Armas Cortas beside an inherited canonical Handgun.
            for(let index = 0; index < deltaItems.length; index += 1) {
                const item = deltaItems[index];
                if(item === null || matchedDeltaIndices.has(index) || item?._tombstone) continue;
                if(item?.type === "skill" && legacySkillMatchesItem(trainedSkill, item)) {
                    const itemId = item?._id || item?.id;
                    const baseItem = itemId
                        ? baseItems.find(candidate => (candidate?._id || candidate?.id) === itemId)
                        : undefined;
                    effectiveMatches.push({ origin: "delta", item, index, baseItem });
                }
            }

            if(effectiveMatches.length === 0) {
                if(explicitlyDeleted) handledSkills.add(trainedSkill);
                continue;
            }

            if(effectiveMatches.length === 1) {
                const [match] = effectiveMatches;
                if(match.origin === "base" && trainedSkill.hasUserState) {
                    const inheritedSource = cloneMigrationSource(match.item);
                    deltaItems.push({
                        ...inheritedSource,
                        system: overlayLegacySkillValues(inheritedSource.system, trainedSkill.item.system)
                    });
                    skillItemsChanged = true;
                }
                // A managed Item is newer than the stale legacy object, even
                // when it shadows a matching base Item under a renamed label.
                handledSkills.add(trainedSkill);
                continue;
            }

            const canonicalName = normalizeSkillName(trainedSkill.item.name);
            const canonical = effectiveMatches.find(match =>
                normalizeSkillName(match.item?.name) === canonicalName
            ) || effectiveMatches[0];
            const duplicates = effectiveMatches.filter(match => match !== canonical);
            const overlayLegacy = trainedSkill.hasUserState
                && effectiveMatches.every(match => match.origin === "base");
            let merged = cloneMigrationSource(canonical.item);
            for(const duplicate of duplicates) {
                merged = mergeLocalizedLegacySkillDuplicate(merged, duplicate.item, trainedSkill, {
                    overlayLegacy
                });
            }

            if(!migrationValuesEqual(merged, canonical.item)) {
                if(canonical.origin === "delta") deltaItems[canonical.index] = merged;
                else deltaItems.push(merged);
            }
            for(const duplicate of duplicates) {
                const duplicateId = duplicate.item?._id || duplicate.item?.id;
                if(!duplicateId) {
                    throw new Error(`cannot safely remove duplicate skill ${duplicate.item?.name || "unknown"} without an ID`);
                }
                if(duplicate.origin === "delta") {
                    // Removing an override would reveal its base Item again;
                    // replace it with a tombstone when that ID is inherited.
                    deltaItems[duplicate.index] = duplicate.baseItem
                        ? { _id: duplicateId, _tombstone: true }
                        : null;
                } else {
                    deltaItems.push({ _id: duplicateId, _tombstone: true });
                }
            }
            skillItemsChanged = true;
            handledSkills.add(trainedSkill);
        }
        const unmatchedSkills = legacySkillDescriptors.filter(skill => !handledSkills.has(skill));
        for(const trainedSkill of await filterLegacySkillsToMaterialize(unmatchedSkills)) {
            deltaItems.push(trainedSkill.item);
            skillItemsChanged = true;
        }
        delete delta.system.skills;
        changed = true;
    }

    let itemsChanged = false;
    delta.items = deltaItems.filter(item => item !== null).map(item => {
        const result = migratePlainItemSource(item);
        itemsChanged ||= result.changed;
        skillItemsChanged ||= result.changed && item?.type === "skill";
        return result.value;
    });
    if(assignMissingPlainActorDeltaItemIds(delta, baseActor, { sceneId, tokenId })) {
        itemsChanged = true;
    }
    if(skillItemsChanged) {
        // A synthetic Actor may otherwise inherit a truthy base-Actor cache
        // which cannot describe token-only Item overrides. Null deliberately
        // shadows that cache and makes the sheet derive IDs from the synthetic
        // collection.
        delta.system.sortedSkillIDs = null;
        changed = true;
    }
    changed ||= itemsChanged;
    return { value: delta, changed };
}

function assignMissingPlainActorDeltaItemIds(delta, baseActor, { sceneId, tokenId } = {}) {
    const items = Array.from(delta?.items || []);
    const missingIds = items.some(item => item && !item._tombstone && !(item._id || item.id));
    if(!missingIds) return false;
    if(!sceneId || !tokenId) {
        throw new Error("cannot assign migrated ActorDelta Item IDs without Scene and Token IDs");
    }

    // A delta Item which collides with an inherited Item ID becomes an override,
    // so reserve identities from both sides of the differential collection.
    const usedIds = new Set([
        ...Array.from(baseActor?.items || []).map(item => item?._id || item?.id),
        ...items.map(item => item?._id || item?.id)
    ].filter(Boolean));
    for(let index = 0; index < items.length; index += 1) {
        const item = items[index];
        if(!item || item._tombstone || item._id || item.id) continue;
        let salt = 0;
        let id;
        do {
            id = deterministicMigrationDocumentId(
                `${sceneId}:${tokenId}:${index}:${item?.type || "Item"}:${item?.name || "Unnamed"}`,
                salt
            );
            salt += 1;
        } while(usedIds.has(id));
        item._id = id;
        usedIds.add(id);
    }
    return true;
}

function cloneMigrationSource(source) {
    return globalThis.structuredClone
        ? structuredClone(source)
        : JSON.parse(JSON.stringify(source));
}

function getForcedDeletionOperator() {
    if(globalThis._del) return globalThis._del;
    const ForcedDeletion = globalThis.foundry?.data?.operators?.ForcedDeletion;
    return typeof ForcedDeletion === "function"
        ? new ForcedDeletion()
        : FALLBACK_FORCED_DELETION;
}

function getForcedReplacementOperator(value) {
    if(typeof globalThis._replace === "function") return globalThis._replace(value);
    const ForcedReplacement = globalThis.foundry?.data?.operators?.ForcedReplacement;
    if(typeof ForcedReplacement?.create === "function") return ForcedReplacement.create(value);
    throw new Error("the Foundry V14 forced-replacement operator is unavailable");
}

function invalidateSkillSortCache(update, { syntheticActor = false } = {}) {
    update["system.sortedSkillIDs"] = syntheticActor ? null : getForcedDeletionOperator();
}

function setEmbeddedDeletionPlan(update, documentName, ids) {
    if(!update[MIGRATION_EMBEDDED_DELETIONS]) {
        Object.defineProperty(update, MIGRATION_EMBEDDED_DELETIONS, {
            value: [],
            configurable: false,
            enumerable: false,
            writable: false
        });
    }
    update[MIGRATION_EMBEDDED_DELETIONS].push([documentName, [...ids]]);
}

function getEmbeddedDeletionPlan(update) {
    return Array.from(update?.[MIGRATION_EMBEDDED_DELETIONS] || []);
}

function isForcedDeletionOperator(value) {
    if(value === FALLBACK_FORCED_DELETION || value === globalThis._del) return true;
    const ForcedDeletion = globalThis.foundry?.data?.operators?.ForcedDeletion;
    return typeof ForcedDeletion === "function" && value instanceof ForcedDeletion;
}

function isEmptyUpdate(update) {
    if(globalThis.foundry?.utils?.isEmpty) return foundry.utils.isEmpty(update);
    return Object.keys(update || {}).length === 0;
}

function applyUpdateToPlainObject(source, update) {
    const clone = globalThis.structuredClone
        ? structuredClone(source)
        : JSON.parse(JSON.stringify(source));
    for(const [path, value] of Object.entries(update)) {
        const parts = path.split(".");
        let target = clone;
        for(let index = 0; index < parts.length - 1; index += 1) {
            const part = parts[index];
            if(!target[part] || typeof target[part] !== "object") target[part] = {};
            target = target[part];
        }
        const finalPart = parts.at(-1);
        if(isForcedDeletionOperator(value)) delete target[finalPart];
        else target[finalPart] = value;
    }
    return clone;
}

// Take an old hardcoded skill and translate it into data for a skill item
export function convertOldSkill(name, skillData) {
    return {name: formatLegacySkillName(name), type: "skill", system: {
        flavor: "",
        notes: "",
        level: readLegacySkillNumber(skillData.value, `${name}.value`),
        chipLevel: readLegacySkillNumber(skillData.chipValue, `${name}.chipValue`),
        isChipped: normalizeLegacyBoolean(skillData.chipped),
        ip: readLegacySkillNumber(skillData.ip, `${name}.ip`),
        diffMod: 1, // No skills have those currently.
        isRoleSkill: normalizeLegacyBoolean(skillData.isSpecial),
        stat: skillData.stat
    }};
}

function readLegacySkillNumber(value, path) {
    if(value === undefined || value === null || value === "") return 0;
    const number = Number(value);
    if(!Number.isFinite(number)) {
        throw new Error(`legacy skill field ${path} is not a finite number`);
    }
    return number;
}
