/**
 * Suppressive Fire Tracker
 * Implements persistent hazard functionality for suppressive fire templates.
 */
import { resolveSuppressiveFireDamageOutcome } from "./attack-resolver.js";
import { buildActorCombatSnapshot, buildWeaponCombatSnapshot } from "./combat-snapshot.js";
import { previewAndApplyCombatOutcome, previewAndConfirmCombatOutcome } from "./combat-commit.js";
import {
    buildSuppressiveFireRegionData,
    getPrimaryRegionShape,
    getRegionDocument,
    regionContainsToken
} from "./region-zones.js";
import { isPrimaryActiveGm, resolveFoundryUuid } from "../foundry-compat.js";

const ACTIVE_SUPPRESSIVE_CHAT_ACTIONS = new Set();
const SUPPRESSIVE_INTERSECTION_QUEUES = new WeakMap();
const SUPPRESSIVE_HITS_RESOLUTION_FLAG = "suppressiveFireHitsResolution";
const SUPPRESSIVE_DAMAGE_RESOLUTION_FLAG = "suppressiveFireDamageResolution";
const LEGACY_SYSTEM_ID = "cyberpunk2020";
const CURRENT_SYSTEM_ID = "cyberpunk2020-rilerena";

/**
 * Calculates the Save DC for a Suppressive Fire zone.
 * @param {number} bulletsFired - Total number of bullets fired.
 * @param {number} zoneWidth - Width of the zone in meters (minimum 2).
 * @returns {number} The calculated Save DC.
 */
export function calculateSuppressiveFireSaveDC(bulletsFired, zoneWidth) {
    if (zoneWidth < 2) zoneWidth = 2; // minimum width check just in case
    return Math.floor(bulletsFired / zoneWidth);
}

/**
 * Legacy API alias which now builds data for a Foundry V14 RegionDocument.
 */
export function buildSuppressiveFireTemplateData(params) {
    return buildSuppressiveFireRegionData(params);
}

/**
 * Hook registration for Suppressive Fire
 */
export function registerSuppressiveFireHooks() {
    // V14 emits moveToken for token movement. Registering updateToken as well
    // would enqueue the same suppressive-fire check twice.
    Hooks.on("moveToken", (tokenDocument, movement, operation, user) => {
        if (!isPrimaryActiveGm()) return;
        void handleTokenMovement(tokenDocument).catch(reportSuppressiveHookError);
    });

    Hooks.on("combatTurnChange", (combat, prior, current) => {
        if (!isPrimaryActiveGm()) return;
        void handleSuppressiveFireCombatTurn(combat, current, { prior, current }).catch(reportSuppressiveHookError);
    });

    // Foundry V14 passes the rendered HTMLElement as the second argument.
    Hooks.on("renderChatMessageHTML", bindSuppressiveFireChatActions);
}

function reportSuppressiveHookError(error) {
    console.error("Suppressive-fire hook failed:", error);
    globalThis.ui?.notifications?.error("Suppressive-fire automation could not finish. Resolve the affected zone manually.");
}

export function bindSuppressiveFireChatActions(message, html) {
    if(!html?.querySelectorAll) return;
    const root = html;

    const mayResolve = isPrimaryActiveGm();
    const hitsLocked = isMessageResolutionLocked(readMessageResolution(message, SUPPRESSIVE_HITS_RESOLUTION_FLAG));
    const damageLocked = isMessageResolutionLocked(readMessageResolution(message, SUPPRESSIVE_DAMAGE_RESOLUTION_FLAG));

    for(const button of root.querySelectorAll(".roll-suppressive-hits")) {
        const actionKey = `suppressive-hits:${getActionRegionReference(button)}`;
        setActionDisabled(button, !mayResolve || hitsLocked || ACTIVE_SUPPRESSIVE_CHAT_ACTIONS.has(actionKey));
        if(button.dataset.cyberpunkSuppressiveBound === "true") continue;
        button.dataset.cyberpunkSuppressiveBound = "true";
        button.addEventListener("click", event => {
            return handleSuppressiveHitsAction(event, message);
        });
    }

    for(const button of root.querySelectorAll(".roll-damage")) {
        const actionKey = `suppressive-damage:${getActionRegionReference(button)}:${getActionActorReference(button)}`;
        setActionDisabled(button, !mayResolve || damageLocked || ACTIVE_SUPPRESSIVE_CHAT_ACTIONS.has(actionKey));
        if(button.dataset.cyberpunkSuppressiveBound === "true") continue;
        button.dataset.cyberpunkSuppressiveBound = "true";
        button.addEventListener("click", event => {
            return handleSuppressiveDamageAction(event, message);
        });
    }
}

function getSuppressiveFireState(regionLike) {
    const region = getRegionDocument(regionLike);
    if(!region) return { region: null, flags: null, scope: null };

    const scopes = [
        LEGACY_SYSTEM_ID,
        globalThis.game?.system?.id,
        CURRENT_SYSTEM_ID
    ].filter((scope, index, values) => scope && values.indexOf(scope) === index);

    for(const scope of scopes) {
        const flags = region.flags?.[scope]?.suppressiveFire;
        if(flags) return { region, flags, scope };
    }
    return { region, flags: null, scope: null };
}

function getSuppressiveFireUpdatePath(scope, property) {
    return `flags.${scope || LEGACY_SYSTEM_ID}.suppressiveFire.${property}`;
}

function getRegionById(regionId) {
    return getRegionDocument(globalThis.canvas?.scene?.regions?.get?.(regionId));
}

function getActionRegionReference(action) {
    return action?.dataset?.regionUuid || action?.dataset?.templateId || "unknown";
}

function getActionActorReference(action) {
    return action?.dataset?.tokenUuid || action?.dataset?.actorUuid || action?.dataset?.actorId || "unknown";
}

async function resolveDocumentUuid(uuid, resolver = resolveFoundryUuid) {
    if(!uuid || typeof resolver !== "function") return undefined;
    try {
        return await resolver(uuid);
    } catch {
        return undefined;
    }
}

async function resolveRegionReference({ regionUuid, templateId }, resolver) {
    const uuidRegion = getRegionDocument(await resolveDocumentUuid(regionUuid, resolver));
    if(uuidRegion) return uuidRegion;

    const viewedRegion = getRegionById(templateId);
    if(viewedRegion) return viewedRegion;

    const scenes = Array.from(globalThis.game?.scenes?.contents || globalThis.game?.scenes || []);
    const matches = scenes
        .map(scene => getRegionDocument(scene?.regions?.get?.(templateId)))
        .filter(Boolean);
    return matches.length === 1 ? matches[0] : undefined;
}

async function resolveActorReference({ actorUuid, tokenUuid, actorId }, resolver) {
    const token = await resolveDocumentUuid(tokenUuid, resolver);
    if(token?.actor) return token.actor;

    const actor = await resolveDocumentUuid(actorUuid, resolver);
    if(actor) return actor;
    return globalThis.game?.actors?.get?.(actorId);
}

async function handleSuppressiveHitsAction(event, message) {
    event.preventDefault();
    const action = event.currentTarget;
    const templateId = action?.dataset?.templateId;
    const regionUuid = action?.dataset?.regionUuid;
    const actorId = action?.dataset?.actorId;
    const actorUuid = action?.dataset?.actorUuid;
    const tokenUuid = action?.dataset?.tokenUuid;
    if(action?.disabled || (!templateId && !regionUuid) || (!actorId && !actorUuid && !tokenUuid)) return;
    if(!isPrimaryActiveGm()) {
        return globalThis.ui?.notifications?.warn("Only the active GM can resolve suppressive fire.");
    }

    // Serialize cap updates per template on the authoritative GM client. Two
    // target messages must not consume the same remaining-hit snapshot.
    const actionKey = `suppressive-hits:${regionUuid || templateId}`;
    if(ACTIVE_SUPPRESSIVE_CHAT_ACTIONS.has(actionKey)) {
        return globalThis.ui?.notifications?.warn("Another suppressive-fire roll is already being resolved.");
    }

    ACTIVE_SUPPRESSIVE_CHAT_ACTIONS.add(actionKey);
    setActionDisabled(action, true);
    let keepDisabled = false;
    try {
        if(isMessageResolutionLocked(readMessageResolution(message, SUPPRESSIVE_HITS_RESOLUTION_FLAG))) {
            keepDisabled = true;
            return;
        }
        const region = await resolveRegionReference({ regionUuid, templateId });
        if (!region) {
            globalThis.ui?.notifications?.warn("Suppressive fire zone no longer exists.");
            return;
        }

        const { flags, scope } = getSuppressiveFireState(region);
        if (!flags) return;
        const remainingHitCap = Math.max(0, Number(flags.remainingHitCap ?? flags.bulletsFired) || 0);
        if (remainingHitCap <= 0) {
            globalThis.ui?.notifications?.warn("This suppressive fire zone is depleted.");
            return;
        }

        const lockPersisted = await persistMessageResolution(message, SUPPRESSIVE_HITS_RESOLUTION_FLAG, {
            status: "pending",
            templateId,
            regionUuid,
            actorId,
            actorUuid,
            tokenUuid
        });
        if(!lockPersisted) {
            globalThis.ui?.notifications?.warn("Could not lock this suppressive-fire action. No hits were rolled.");
            return;
        }
        keepDisabled = true;

        const roll = await new Roll("1d6").evaluate();
        const hits = Math.max(0, Math.min(Number(roll.total) || 0, remainingHitCap));
        const newCap = remainingHitCap - hits;
        await region.update({ [getSuppressiveFireUpdatePath(scope, "remainingHitCap")]: newCap });

        const actor = await resolveActorReference({ actorUuid, tokenUuid, actorId });
        const actorName = escapeChatHtml(actor?.name || "Target");
        const safeTemplateId = escapeChatHtml(templateId || region.id);
        const safeRegionUuid = escapeChatHtml(regionUuid || region.uuid);
        const safeActorId = escapeChatHtml(actorId || actor?.id);
        const safeActorUuid = escapeChatHtml(actorUuid || actor?.uuid);
        const safeTokenUuid = escapeChatHtml(tokenUuid);
        await ChatMessage.create({
            author: game.user.id,
            speaker: ChatMessage.getSpeaker({ actor }),
            content: `
                <div class="cyberpunk2020-chat-card">
                    <header class="card-header flexrow">
                        <h3>Suppressive Fire Hits</h3>
                    </header>
                    <div class="card-content">
                        <p><strong>${actorName}</strong> takes <strong>${hits}</strong> hits from the suppressive fire zone!</p>
                        <p>Remaining hits in zone: ${newCap}</p>
                        <button type="button" class="roll-damage" data-hits="${hits}" data-template-id="${safeTemplateId}" data-region-uuid="${safeRegionUuid}" data-actor-id="${safeActorId}" data-actor-uuid="${safeActorUuid}" data-token-uuid="${safeTokenUuid}">Roll Damage</button>
                    </div>
                </div>
            `
        });
        const completedPersisted = await persistMessageResolution(message, SUPPRESSIVE_HITS_RESOLUTION_FLAG, {
            status: "completed",
            templateId,
            regionUuid,
            actorId,
            actorUuid,
            tokenUuid
        });
        if(!completedPersisted) {
            globalThis.ui?.notifications?.warn("Hits were resolved, but the chat lock could not be finalized. Resolve any follow-up manually.");
        }
    } catch(error) {
        console.error("Failed to resolve suppressive-fire hits:", error);
        if(keepDisabled) {
            await persistMessageResolution(message, SUPPRESSIVE_HITS_RESOLUTION_FLAG, {
                status: "partial",
                templateId,
                regionUuid,
                actorId,
                actorUuid,
                tokenUuid
            });
        }
        globalThis.ui?.notifications?.error(keepDisabled
            ? "Suppressive-fire resolution stopped after it was locked. Inspect the zone and resolve it manually."
            : "Could not resolve suppressive-fire hits. Please try again.");
    } finally {
        ACTIVE_SUPPRESSIVE_CHAT_ACTIONS.delete(actionKey);
        if(!keepDisabled) setActionDisabled(action, false);
    }
}

async function handleSuppressiveDamageAction(event, message) {
    event.preventDefault();
    const action = event.currentTarget;
    const hits = Number.parseInt(action?.dataset?.hits, 10);
    const templateId = action?.dataset?.templateId;
    const regionUuid = action?.dataset?.regionUuid;
    const actorId = action?.dataset?.actorId;
    const actorUuid = action?.dataset?.actorUuid;
    const tokenUuid = action?.dataset?.tokenUuid;
    if(
        action?.disabled
        || (!templateId && !regionUuid)
        || (!actorId && !actorUuid && !tokenUuid)
        || !Number.isInteger(hits)
        || hits <= 0
    ) return;
    if(!isPrimaryActiveGm()) {
        return globalThis.ui?.notifications?.warn("Only the active GM can resolve suppressive fire.");
    }

    const actionKey = `suppressive-damage:${regionUuid || templateId}:${tokenUuid || actorUuid || actorId}`;
    if(ACTIVE_SUPPRESSIVE_CHAT_ACTIONS.has(actionKey)) return;
    ACTIVE_SUPPRESSIVE_CHAT_ACTIONS.add(actionKey);
    setActionDisabled(action, true);
    let keepDisabled = false;
    try {
        if(isMessageResolutionLocked(readMessageResolution(message, SUPPRESSIVE_DAMAGE_RESOLUTION_FLAG))) {
            keepDisabled = true;
            return;
        }
        const lockPersisted = await persistMessageResolution(message, SUPPRESSIVE_DAMAGE_RESOLUTION_FLAG, {
            status: "pending",
            templateId,
            regionUuid,
            actorId,
            actorUuid,
            tokenUuid
        });
        if(!lockPersisted) {
            globalThis.ui?.notifications?.warn("Could not lock this suppressive-fire damage action. No damage was applied.");
            return;
        }
        keepDisabled = true;

        const result = await resolveSuppressiveFireDamageFromChat({
            templateId,
            regionUuid,
            actorId,
            actorUuid,
            tokenUuid,
            hits
        });
        if(result?.status === "committed") {
            const completedPersisted = await persistMessageResolution(message, SUPPRESSIVE_DAMAGE_RESOLUTION_FLAG, {
                status: "completed",
                templateId,
                regionUuid,
                actorId,
                actorUuid,
                tokenUuid
            });
            if(!completedPersisted) {
                globalThis.ui?.notifications?.warn("Damage was applied, but the chat lock could not be finalized. Do not repeat this action.");
            }
        } else if(canRetrySuppressiveDamageResolution(result)) {
            const retryPersisted = await persistMessageResolution(message, SUPPRESSIVE_DAMAGE_RESOLUTION_FLAG, {
                status: "retryable",
                templateId,
                regionUuid,
                actorId,
                actorUuid,
                tokenUuid
            });
            keepDisabled = !retryPersisted;
        } else {
            await persistMessageResolution(message, SUPPRESSIVE_DAMAGE_RESOLUTION_FLAG, {
                status: result?.status === "canceled" ? "canceled" : "partial",
                templateId,
                regionUuid,
                actorId,
                actorUuid,
                tokenUuid
            });
            globalThis.ui?.notifications?.warn(result?.status === "canceled"
                ? "Suppressive-fire damage was canceled. Resolve these existing hits manually if needed."
                : "This suppressive-fire damage result cannot be safely rerolled. Finish it manually instead.");
        }
    } catch(error) {
        console.error("Failed to resolve suppressive-fire damage:", error);
        if(keepDisabled) {
            await persistMessageResolution(message, SUPPRESSIVE_DAMAGE_RESOLUTION_FLAG, {
                status: "partial",
                templateId,
                regionUuid,
                actorId,
                actorUuid,
                tokenUuid
            });
        }
        globalThis.ui?.notifications?.error(keepDisabled
            ? "Suppressive-fire damage stopped after it was locked. Inspect the target and resolve it manually."
            : "Could not resolve suppressive-fire damage. Please try again.");
    } finally {
        ACTIVE_SUPPRESSIVE_CHAT_ACTIONS.delete(actionKey);
        if(!keepDisabled) setActionDisabled(action, false);
    }
}

function readMessageResolution(message, flag) {
    try {
        return message?.getFlag?.(globalThis.game?.system?.id || "cyberpunk2020-rilerena", flag);
    } catch {
        return undefined;
    }
}

function isMessageResolutionLocked(resolution) {
    return Boolean(resolution?.status && resolution.status !== "retryable");
}

export function canRetrySuppressiveDamageResolution(result) {
    const retrySafeStatuses = new Set([
        "missing-template",
        "missing-suppressive-fire-flags",
        "missing-combat-document"
    ]);
    if(!result || !retrySafeStatuses.has(result.status)) return false;
    const applied = result.applied || {};
    return [applied.itemUpdates, applied.embeddedItemUpdates, applied.actorUpdates]
        .every(value => (Number(value) || 0) === 0);
}

async function persistMessageResolution(message, flag, resolution) {
    if(typeof message?.setFlag !== "function") return false;
    try {
        await message.setFlag(globalThis.game?.system?.id || "cyberpunk2020-rilerena", flag, {
            ...resolution,
            userId: globalThis.game?.user?.id,
            resolvedAt: new Date().toISOString()
        });
        return true;
    } catch(error) {
        console.warn("Could not persist suppressive-fire chat resolution:", error);
        return false;
    }
}

function setActionDisabled(action, disabled) {
    if(!action) return;
    action.disabled = disabled;
    if(disabled) action.setAttribute?.("aria-disabled", "true");
    else action.removeAttribute?.("aria-disabled");
}

function escapeChatHtml(value) {
    if(typeof globalThis.foundry?.utils?.escapeHTML === "function") {
        return globalThis.foundry.utils.escapeHTML(String(value ?? ""));
    }
    return String(value ?? "")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#039;");
}

function finiteNumber(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
}

export async function resolveSuppressiveFireDamageFromChat({
    templateId,
    regionUuid,
    actorId,
    actorUuid,
    tokenUuid,
    hits
}, options = {}) {
    const uuidResolver = options.fromUuid || resolveFoundryUuid;
    const region = await resolveRegionReference({ regionUuid, templateId }, uuidResolver);
    if (!region) {
        globalThis.ui?.notifications?.warn("Suppressive fire zone no longer exists.");
        return { status: "missing-template" };
    }

    const { flags } = getSuppressiveFireState(region);
    if (!flags) {
        return { status: "missing-suppressive-fire-flags" };
    }

    const targetActor = await resolveActorReference({ actorUuid, tokenUuid, actorId }, uuidResolver);
    const shooterActor = await resolveActorReference({
        actorUuid: flags.shooterActorUuid,
        tokenUuid: flags.shooterTokenUuid,
        actorId: flags.shooterActorId
    }, uuidResolver);
    const weaponItem = await resolveDocumentUuid(flags.weaponItemUuid, uuidResolver)
        || shooterActor?.items?.get(flags.weaponItemId)
        || shooterActor?.itemTypes?.weapon?.find(item => item.id === flags.weaponItemId);

    if (!targetActor || !shooterActor || !weaponItem) {
        globalThis.ui?.notifications?.warn("Suppressive fire damage could not resolve actor or weapon data.");
        return { status: "missing-combat-document" };
    }

    const outcome = await resolveSuppressiveFireDamageOutcome({
        action: {
            type: "ranged",
            fireMode: "Suppressive",
            source: "Suppressive Fire Zone",
            hazardZone: buildSuppressiveFireHazardEvidence(region, flags)
        },
        attacker: {
            actorUuid: shooterActor.uuid,
            tokenUuid: flags.shooterTokenUuid,
            name: shooterActor.name,
            snapshot: buildActorCombatSnapshot(shooterActor, { includeEmptySkills: true })
        },
        weapon: {
            itemUuid: weaponItem.uuid,
            name: weaponItem.name,
            snapshot: buildWeaponCombatSnapshot(weaponItem)
        },
        target: {
            actorUuid: targetActor.uuid,
            tokenUuid,
            name: targetActor.name,
            snapshot: buildActorCombatSnapshot(targetActor, { includeEquipment: true })
        },
        hitCount: hits
    }, options.resolverOptions || {}, options.roller || activeSuppressiveFireRoller);

    const commitKey = options.commitKey || buildSuppressiveFireCommitKey({
        templateId: templateId || region.id,
        regionUuid: regionUuid || region.uuid,
        actorId,
        actorUuid: actorUuid || targetActor.uuid,
        tokenUuid
    });
    return await previewAndConfirmSuppressiveFireOutcome(outcome, { ...options, commitKey });
}

function buildSuppressiveFireHazardEvidence(region, flags) {
    const shape = getPrimaryRegionShape(region);
    const shapeType = String(shape?.type || "").toLowerCase();
    const distancePixels = Number(
        region?.parent?.dimensions?.distancePixels
        ?? globalThis.canvas?.dimensions?.distancePixels
    );
    const canConvertDistance = Number.isFinite(distancePixels) && distancePixels > 0;
    const lengthPixels = shapeType === "rectangle" ? Number(shape?.width) : Number(shape?.length);
    const widthPixels = shapeType === "rectangle" ? Number(shape?.height) : Number(shape?.width);
    const shapeDistance = canConvertDistance && Number.isFinite(lengthPixels)
        ? Math.abs(lengthPixels) / distancePixels
        : undefined;
    const shapeWidth = canConvertDistance && Number.isFinite(widthPixels)
        ? Math.abs(widthPixels) / distancePixels
        : undefined;

    return {
        kind: "suppressive-fire",
        // Preserve template aliases for stored combat evidence and chat APIs.
        templateUuid: region.uuid,
        templateId: region.id,
        regionUuid: region.uuid,
        regionId: region.id,
        type: "ray",
        origin: {
            x: finiteNumber(shape?.x, 0),
            y: finiteNumber(shape?.y, 0)
        },
        direction: finiteNumber(shape?.rotation, 0),
        width: shapeWidth ?? finiteNumber(flags.zoneWidth, 0),
        distance: shapeDistance ?? finiteNumber(flags.maxDistance, 0),
        lifecycle: "persistent"
    };
}

async function previewAndConfirmSuppressiveFireOutcome(outcome, options = {}) {
    const commitMode = resolveDamageCommitMode();
    if (commitMode === "direct" || options.decision === "confirm") {
        return await previewAndApplyCombatOutcome(outcome, { decision: "confirm", adapter: options.adapter, commitKey: options.commitKey });
    }

    return await previewAndConfirmCombatOutcome(outcome, {
        adapter: options.adapter,
        commitKey: options.commitKey
    });
}

function buildSuppressiveFireCommitKey({ templateId, regionUuid, actorId, actorUuid, tokenUuid }) {
    const combat = game?.combat;
    return [
        "suppressive-fire",
        regionUuid || templateId,
        tokenUuid || actorUuid || actorId,
        combat?.id || "no-combat",
        combat?.round ?? "no-round",
        combat?.turn ?? "no-turn"
    ].join(":");
}

function resolveDamageCommitMode() {
    try {
        if (typeof game?.settings?.get === "function") {
            return game.settings.get(game.system.id, "combatDamageCommitMode");
        }
    } catch {
        return "previewConfirm";
    }
    return "previewConfirm";
}

async function activeSuppressiveFireRoller(request = {}) {
    if (typeof Roll !== "function") {
        throw new Error("Suppressive fire damage resolution requires Foundry Roll.");
    }
    const formula = String(request.formula || "1d10").replace(/\s+hit\s+location$/i, "");
    const roll = await new Roll(formula).evaluate();
    const firstDie = roll.dice && roll.dice.length > 0 ? roll.dice[0] : null;
    return {
        id: request.id,
        formula: request.formula,
        total: roll.total,
        die: {
            faces: firstDie ? firstDie.faces : 10,
            natural: firstDie?.results?.[0]?.result ?? roll.total,
            results: firstDie?.results ? firstDie.results.map(result => result.result) : [roll.total],
            exploded: firstDie?.results ? firstDie.results.some(result => result.active === false) : false
        }
    };
}

function getActiveSuppressiveFireRegions(scene = globalThis.canvas?.scene) {
    const regions = scene?.regions;
    if(!regions) return [];
    const documents = Array.isArray(regions.contents)
        ? regions.contents
        : typeof regions.values === "function"
            ? Array.from(regions.values())
            : Array.isArray(regions)
                ? regions
                : [];

    return documents
        .map(getRegionDocument)
        .filter(region => {
            const { flags } = getSuppressiveFireState(region);
            return flags && Math.max(0, Number(flags.remainingHitCap ?? flags.bulletsFired) || 0) > 0;
        });
}

async function handleTokenMovement(tokenDocument) {
    const regions = getActiveSuppressiveFireRegions(tokenDocument?.parent);
    for (const region of regions) {
        await checkAndResolveIntersection(tokenDocument, region);
    }
}

export async function handleSuppressiveFireCombatTurn(combat, updateData = {}) {
    const currentCombatant = getUpdatedCombatant(combat, updateData);
    if (!currentCombatant || !currentCombatant.tokenId) return;

    const scene = getCombatScene(combat);
    const regions = getActiveSuppressiveFireRegions(scene);
    for (const region of regions) {
        const { flags } = getSuppressiveFireState(region);
        if(!flags) continue;

        // 1. If the current combatant is the shooter, expire their Regions.
        if (flags.shooterTokenId === currentCombatant.tokenId) {
            await expireSuppressiveFireTemplate(region);
            continue;
        }

        // 2. Check if the current combatant starts their turn inside the zone
        const tokenDocument = currentCombatant.token
            || scene?.tokens?.get?.(currentCombatant.tokenId)
            || globalThis.canvas?.tokens?.get?.(currentCombatant.tokenId)?.document;
        if (tokenDocument) {
            await checkAndResolveIntersection(tokenDocument, region, { combat });
        }
    }
}

export function getUpdatedCombatant(combat, updateData = {}) {
    const turns = Array.isArray(combat?.turns) ? combat.turns : [];
    if(
        (Object.prototype.hasOwnProperty.call(updateData, "combatantId") && updateData.combatantId === null)
        || (Object.prototype.hasOwnProperty.call(updateData, "turn") && updateData.turn === null)
    ) return null;

    const referencedCombatant = turns.find(combatant =>
        (updateData.combatantId && combatant?.id === updateData.combatantId)
        || (updateData.tokenId && combatant?.tokenId === updateData.tokenId)
    );
    if(referencedCombatant) return referencedCombatant;

    if(updateData.turn !== null && updateData.turn !== undefined) {
        const turn = Number(updateData.turn);
        if(Number.isInteger(turn)) return turns[turn] || combat?.combatant;
    }
    return combat?.combatant;
}

function getCombatScene(combat) {
    const sceneReference = combat?.scene;
    if(sceneReference && typeof sceneReference === "object") return sceneReference;
    if(sceneReference) {
        return globalThis.game?.scenes?.get?.(sceneReference)
            || (globalThis.canvas?.scene?.id === sceneReference ? globalThis.canvas.scene : undefined);
    }
    return globalThis.canvas?.scene;
}

async function expireSuppressiveFireTemplate(region) {
    // Depending on world setting, delete or deactivate
    // For now, we will delete it as requested initially, or mark it depleted
    await region.delete();
}

export async function checkAndResolveIntersection(tokenDocument, regionLike, context = {}) {
    const region = getRegionDocument(regionLike);
    if(!region || (typeof region !== "object" && typeof region !== "function")) return false;

    // Capture the triggering combat moment before waiting behind another token
    // which is resolving against this Region.
    const activeCombat = context.combat || globalThis.game?.combat;
    const combatId = activeCombat?.id || "none";
    const combatRound = activeCombat?.round ?? 0;
    const combatTurn = activeCombat?.turn ?? 0;
    const resolutionId = `${combatId}-${combatRound}-${combatTurn}`;

    return await withSuppressiveTemplateLock(region, async () => {
        // Re-read after acquiring the lock. Another token may have appended to
        // this shared array while this movement hook was queued.
        const { flags, scope } = getSuppressiveFireState(region);
        if(!flags || Math.max(0, Number(flags.remainingHitCap ?? flags.bulletsFired) || 0) <= 0) return false;
        const resolvedTokens = Array.isArray(flags.resolvedTokenIds) ? flags.resolvedTokenIds : [];
        const tokenResolutionRecord = resolvedTokens.some(record =>
            typeof record === "string"
                ? record === tokenDocument.id
                : record?.id === tokenDocument.id && record?.resolutionId === resolutionId
        );

        if (tokenResolutionRecord) {
            return false; // Already resolved for this event
        }

        // RegionDocument.testPoint evaluates the token center and elevation.
        const intersects = regionContainsToken(region, tokenDocument);

        if (intersects) {
            // Mark as resolved first to prevent loops
            const newResolved = [...resolvedTokens, { id: tokenDocument.id, resolutionId }];
            await region.update({ [getSuppressiveFireUpdatePath(scope, "resolvedTokenIds")]: newResolved });

            // Prompt the save dialog
            await promptSuppressiveFireSave(tokenDocument, region);
            return true;
        }
        return false;
    });
}

async function withSuppressiveTemplateLock(templateDocument, callback) {
    const previous = SUPPRESSIVE_INTERSECTION_QUEUES.get(templateDocument) || Promise.resolve();
    let release;
    const current = new Promise(resolve => { release = resolve; });
    SUPPRESSIVE_INTERSECTION_QUEUES.set(templateDocument, current);
    await previous.catch(() => {});
    try {
        return await callback();
    } finally {
        release();
        if(SUPPRESSIVE_INTERSECTION_QUEUES.get(templateDocument) === current) {
            SUPPRESSIVE_INTERSECTION_QUEUES.delete(templateDocument);
        }
    }
}

export async function promptSuppressiveFireSave(tokenDocument, regionLike) {
    const { region, flags } = getSuppressiveFireState(regionLike);
    if(!region || !flags) return;
    const actor = tokenDocument.actor;
    if (!actor) return;
    const actorName = escapeChatHtml(actor.name || "Target");
    const saveDC = escapeChatHtml(flags.saveDC);
    const remainingHitCap = escapeChatHtml(flags.remainingHitCap);
    const templateId = escapeChatHtml(region.id);
    const regionUuid = escapeChatHtml(region.uuid);
    const actorId = escapeChatHtml(actor.id);
    const actorUuid = escapeChatHtml(actor.uuid);
    const tokenUuid = escapeChatHtml(tokenDocument.uuid);

    // Dispatch a chat message asking for the save
    let chatData = {
        author: globalThis.game?.user?.id || "test",
        speaker: globalThis.ChatMessage?.getSpeaker({ actor: actor }) || { alias: actor.name },
        content: `
            <div class="cyberpunk2020-chat-card">
                <header class="card-header flexrow">
                    <h3>Suppressive Fire Zone!</h3>
                </header>
                <div class="card-content">
                    <p><strong>${actorName}</strong> has entered a suppressive fire zone.</p>
                    <p><strong>Save DC:</strong> ${saveDC}</p>
                    <p><strong>Remaining Hits in Zone:</strong> ${remainingHitCap}</p>
                    <p><i>Roll REF + Athletics + 1D10 vs ${saveDC}.</i></p>
                    <hr>
                    <button type="button" class="roll-suppressive-hits" data-template-id="${templateId}" data-region-uuid="${regionUuid}" data-actor-id="${actorId}" data-actor-uuid="${actorUuid}" data-token-uuid="${tokenUuid}">Failed Save! Roll 1D6 Hits</button>
                </div>
            </div>
        `
    };
    
    if (globalThis.ChatMessage) {
        await globalThis.ChatMessage.create(chatData);
    }
}
