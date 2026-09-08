/**
 * Suppressive Fire Tracker
 * Implements persistent hazard functionality for suppressive fire templates.
 */
import { resolveSuppressiveFireDamageOutcome } from "./attack-resolver.js";
import { buildActorCombatSnapshot, buildWeaponCombatSnapshot } from "./combat-snapshot.js";
import { previewAndApplyCombatOutcome, previewAndConfirmCombatOutcome } from "./combat-commit.js";

const ACTIVE_SUPPRESSIVE_CHAT_ACTIONS = new Set();
const SUPPRESSIVE_INTERSECTION_QUEUES = new WeakMap();
const SUPPRESSIVE_HITS_RESOLUTION_FLAG = "suppressiveFireHitsResolution";
const SUPPRESSIVE_DAMAGE_RESOLUTION_FLAG = "suppressiveFireDamageResolution";

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
 * Builds the data object for a new Suppressive Fire MeasuredTemplate.
 */
export function buildSuppressiveFireTemplateData(params) {
    const {
        attackerTokenId,
        attackerActorId,
        weaponItemId,
        damageFormula,
        bulletsFired,
        zoneWidth,
        maxDistance,
        origin,
        combatRound,
        combatTurn,
        combatId
    } = params;

    const saveDC = calculateSuppressiveFireSaveDC(bulletsFired, zoneWidth);

    return {
        t: "ray",
        distance: maxDistance || 10,
        width: zoneWidth,
        x: origin.x,
        y: origin.y,
        flags: {
            cyberpunk2020: {
                suppressiveFire: {
                    shooterActorId: attackerActorId,
                    shooterTokenId: attackerTokenId,
                    weaponItemId,
                    damageFormula,
                    bulletsFired,
                    remainingHitCap: bulletsFired,
                    saveDC,
                    zoneWidth,
                    createdCombatId: combatId,
                    createdRound: combatRound,
                    createdTurn: combatTurn,
                    expiresAtRound: combatRound + 1, // Will be refined later
                    expiresAtTurn: combatTurn,
                    resolvedTokenIds: []
                }
            }
        }
    };
}

/**
 * Hook registration for Suppressive Fire
 */
export function registerSuppressiveFireHooks() {
    // Only GM handles the resolution to avoid duplicate resolution from multiple clients
    Hooks.on("updateToken", (tokenDocument, change, options, userId) => {
        if (!isPrimaryActiveGmClient()) return;
        if (change.x === undefined && change.y === undefined) return;
        void handleTokenMovement(tokenDocument).catch(reportSuppressiveHookError);
    });

    // In V13+ we can use moveToken
    Hooks.on("moveToken", (tokenDocument, change, options, userId) => {
        if (!isPrimaryActiveGmClient()) return;
        void handleTokenMovement(tokenDocument).catch(reportSuppressiveHookError);
    });

    Hooks.on("combatTurn", (combat, updateData, updateOptions) => {
        if (!isPrimaryActiveGmClient()) return;
        void handleSuppressiveFireCombatTurn(combat, updateData).catch(reportSuppressiveHookError);
    });

    // V12 passes a jQuery wrapper to renderChatMessage; V13 passes an
    // HTMLElement to renderChatMessageHTML. Bind both without duplicating
    // listeners when a compatibility shim emits both hooks.
    Hooks.on("renderChatMessage", bindSuppressiveFireChatActions);
    Hooks.on("renderChatMessageHTML", bindSuppressiveFireChatActions);
}

function reportSuppressiveHookError(error) {
    console.error("Suppressive-fire hook failed:", error);
    globalThis.ui?.notifications?.error("Suppressive-fire automation could not finish. Resolve the affected zone manually.");
}

export function bindSuppressiveFireChatActions(message, html) {
    const root = html?.querySelectorAll ? html : html?.[0];
    if(!root?.querySelectorAll) return;

    const mayResolve = isPrimaryActiveGmClient();
    const hitsLocked = isMessageResolutionLocked(readMessageResolution(message, SUPPRESSIVE_HITS_RESOLUTION_FLAG));
    const damageLocked = isMessageResolutionLocked(readMessageResolution(message, SUPPRESSIVE_DAMAGE_RESOLUTION_FLAG));

    for(const button of root.querySelectorAll(".roll-suppressive-hits")) {
        const actionKey = `suppressive-hits:${button?.dataset?.templateId || "unknown"}`;
        setActionDisabled(button, !mayResolve || hitsLocked || ACTIVE_SUPPRESSIVE_CHAT_ACTIONS.has(actionKey));
        if(button.dataset.cyberpunkSuppressiveBound === "true") continue;
        button.dataset.cyberpunkSuppressiveBound = "true";
        button.addEventListener("click", event => {
            return handleSuppressiveHitsAction(event, message);
        });
    }

    for(const button of root.querySelectorAll(".roll-damage")) {
        const actionKey = `suppressive-damage:${button?.dataset?.templateId || "unknown"}:${button?.dataset?.actorId || "unknown"}`;
        setActionDisabled(button, !mayResolve || damageLocked || ACTIVE_SUPPRESSIVE_CHAT_ACTIONS.has(actionKey));
        if(button.dataset.cyberpunkSuppressiveBound === "true") continue;
        button.dataset.cyberpunkSuppressiveBound = "true";
        button.addEventListener("click", event => {
            return handleSuppressiveDamageAction(event, message);
        });
    }
}

async function handleSuppressiveHitsAction(event, message) {
    event.preventDefault();
    const action = event.currentTarget;
    const templateId = action?.dataset?.templateId;
    const actorId = action?.dataset?.actorId;
    if(action?.disabled || !templateId || !actorId) return;
    if(!isPrimaryActiveGmClient()) {
        return globalThis.ui?.notifications?.warn("Only the active GM can resolve suppressive fire.");
    }

    // Serialize cap updates per template on the authoritative GM client. Two
    // target messages must not consume the same remaining-hit snapshot.
    const actionKey = `suppressive-hits:${templateId}`;
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
        const templateDoc = globalThis.canvas?.scene?.templates?.get?.(templateId);
        if (!templateDoc) {
            globalThis.ui?.notifications?.warn("Suppressive fire template no longer exists.");
            return;
        }

        const flags = templateDoc.flags?.cyberpunk2020?.suppressiveFire;
        if (!flags) return;
        const remainingHitCap = Math.max(0, Number(flags.remainingHitCap) || 0);
        if (remainingHitCap <= 0) {
            globalThis.ui?.notifications?.warn("This suppressive fire zone is depleted.");
            return;
        }

        const lockPersisted = await persistMessageResolution(message, SUPPRESSIVE_HITS_RESOLUTION_FLAG, {
            status: "pending",
            templateId,
            actorId
        });
        if(!lockPersisted) {
            globalThis.ui?.notifications?.warn("Could not lock this suppressive-fire action. No hits were rolled.");
            return;
        }
        keepDisabled = true;

        const roll = await new Roll("1d6").evaluate();
        const hits = Math.max(0, Math.min(Number(roll.total) || 0, remainingHitCap));
        const newCap = remainingHitCap - hits;
        await templateDoc.update({ "flags.cyberpunk2020.suppressiveFire.remainingHitCap": newCap });

        const actor = globalThis.game?.actors?.get?.(actorId);
        const actorName = escapeChatHtml(actor?.name || "Target");
        const safeTemplateId = escapeChatHtml(templateId);
        const safeActorId = escapeChatHtml(actorId);
        await ChatMessage.create({
            user: game.user.id,
            speaker: ChatMessage.getSpeaker({ actor }),
            content: `
                <div class="cyberpunk2020-chat-card">
                    <header class="card-header flexrow">
                        <h3>Suppressive Fire Hits</h3>
                    </header>
                    <div class="card-content">
                        <p><strong>${actorName}</strong> takes <strong>${hits}</strong> hits from the suppressive fire zone!</p>
                        <p>Remaining hits in zone: ${newCap}</p>
                        <button type="button" class="roll-damage" data-hits="${hits}" data-template-id="${safeTemplateId}" data-actor-id="${safeActorId}">Roll Damage</button>
                    </div>
                </div>
            `
        });
        const completedPersisted = await persistMessageResolution(message, SUPPRESSIVE_HITS_RESOLUTION_FLAG, {
            status: "completed",
            templateId,
            actorId
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
                actorId
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
    const actorId = action?.dataset?.actorId;
    if(action?.disabled || !templateId || !actorId || !Number.isInteger(hits) || hits <= 0) return;
    if(!isPrimaryActiveGmClient()) {
        return globalThis.ui?.notifications?.warn("Only the active GM can resolve suppressive fire.");
    }

    const actionKey = `suppressive-damage:${templateId}:${actorId}`;
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
            actorId
        });
        if(!lockPersisted) {
            globalThis.ui?.notifications?.warn("Could not lock this suppressive-fire damage action. No damage was applied.");
            return;
        }
        keepDisabled = true;

        const result = await resolveSuppressiveFireDamageFromChat({ templateId, actorId, hits });
        if(result?.status === "committed") {
            const completedPersisted = await persistMessageResolution(message, SUPPRESSIVE_DAMAGE_RESOLUTION_FLAG, {
                status: "completed",
                templateId,
                actorId
            });
            if(!completedPersisted) {
                globalThis.ui?.notifications?.warn("Damage was applied, but the chat lock could not be finalized. Do not repeat this action.");
            }
        } else if(canRetrySuppressiveDamageResolution(result)) {
            const retryPersisted = await persistMessageResolution(message, SUPPRESSIVE_DAMAGE_RESOLUTION_FLAG, {
                status: "retryable",
                templateId,
                actorId
            });
            keepDisabled = !retryPersisted;
        } else {
            await persistMessageResolution(message, SUPPRESSIVE_DAMAGE_RESOLUTION_FLAG, {
                status: result?.status === "canceled" ? "canceled" : "partial",
                templateId,
                actorId
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
                actorId
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

function isPrimaryActiveGmClient() {
    const currentUser = globalThis.game?.user;
    if(!currentUser?.isGM) return false;
    const users = Array.from(globalThis.game?.users?.contents || globalThis.game?.users || []);
    const activeGms = users
        .filter(user => user?.isGM && user?.active)
        .sort((left, right) => String(left.id).localeCompare(String(right.id)));
    return activeGms.length === 0 || activeGms[0]?.id === currentUser.id;
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

export async function resolveSuppressiveFireDamageFromChat({ templateId, actorId, hits }, options = {}) {
    const templateDoc = canvas.scene.templates.get(templateId);
    if (!templateDoc) {
        ui.notifications?.warn("Suppressive fire template no longer exists.");
        return { status: "missing-template" };
    }

    const flags = templateDoc.flags.cyberpunk2020?.suppressiveFire;
    if (!flags) {
        return { status: "missing-suppressive-fire-flags" };
    }

    const targetActor = game.actors.get(actorId);
    const shooterActor = game.actors.get(flags.shooterActorId);
    const weaponItem = shooterActor?.items?.get(flags.weaponItemId)
        || shooterActor?.itemTypes?.weapon?.find(item => item.id === flags.weaponItemId);

    if (!targetActor || !shooterActor || !weaponItem) {
        ui.notifications?.warn("Suppressive fire damage could not resolve actor or weapon data.");
        return { status: "missing-combat-document" };
    }

    const outcome = await resolveSuppressiveFireDamageOutcome({
        action: {
            type: "ranged",
            fireMode: "Suppressive",
            source: "Suppressive Fire Zone",
            hazardZone: {
                kind: "suppressive-fire",
                templateUuid: templateDoc.uuid,
                templateId: templateDoc.id,
                type: templateDoc.t,
                origin: { x: templateDoc.x, y: templateDoc.y },
                direction: templateDoc.direction,
                width: flags.zoneWidth,
                distance: templateDoc.distance,
                lifecycle: "persistent"
            }
        },
        attacker: {
            actorUuid: shooterActor.uuid,
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
            name: targetActor.name,
            snapshot: buildActorCombatSnapshot(targetActor, { includeEquipment: true })
        },
        hitCount: hits
    }, options.resolverOptions || {}, options.roller || activeSuppressiveFireRoller);

    const commitKey = options.commitKey || buildSuppressiveFireCommitKey({ templateId, actorId });
    return await previewAndConfirmSuppressiveFireOutcome(outcome, { ...options, commitKey });
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

function buildSuppressiveFireCommitKey({ templateId, actorId }) {
    const combat = game?.combat;
    return [
        "suppressive-fire",
        templateId,
        actorId,
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

function getActiveSuppressiveFireTemplates() {
    if (!canvas || !canvas.templates) return [];
    return canvas.templates.placeables.filter(t => 
        t.document.flags?.cyberpunk2020?.suppressiveFire &&
        t.document.flags.cyberpunk2020.suppressiveFire.remainingHitCap > 0
    );
}

async function handleTokenMovement(tokenDocument) {
    if (!tokenDocument.object) return;
    const templates = getActiveSuppressiveFireTemplates();
    for (const template of templates) {
        await checkAndResolveIntersection(tokenDocument, template);
    }
}

export async function handleSuppressiveFireCombatTurn(combat, updateData = {}) {
    const currentCombatant = getUpdatedCombatant(combat, updateData);
    if (!currentCombatant || !currentCombatant.tokenId) return;

    const templates = getActiveSuppressiveFireTemplates();
    for (const template of templates) {
        const flags = template.document.flags.cyberpunk2020.suppressiveFire;

        // 1. If the current combatant is the shooter, expire their templates
        if (flags.shooterTokenId === currentCombatant.tokenId) {
            await expireSuppressiveFireTemplate(template);
            continue;
        }

        // 2. Check if the current combatant starts their turn inside the zone
        const tokenDocument = canvas.tokens.get(currentCombatant.tokenId)?.document;
        if (tokenDocument) {
            await checkAndResolveIntersection(tokenDocument, template);
        }
    }
}

function getUpdatedCombatant(combat, updateData = {}) {
    const turn = Number(updateData.turn);
    if (Number.isInteger(turn) && Array.isArray(combat?.turns)) {
        return combat.turns[turn] || combat.combatant;
    }
    return combat?.combatant;
}

async function expireSuppressiveFireTemplate(template) {
    // Depending on world setting, delete or deactivate
    // For now, we will delete it as requested initially, or mark it depleted
    await template.document.delete();
}

export async function checkAndResolveIntersection(tokenDocument, template) {
    const templateDocument = template?.document;
    if(!templateDocument || (typeof templateDocument !== "object" && typeof templateDocument !== "function")) return false;

    // Capture the triggering combat moment before waiting behind another token
    // which is resolving against this template.
    const combatId = globalThis.game?.combat?.id || "none";
    const combatRound = globalThis.game?.combat?.round || 0;
    const combatTurn = globalThis.game?.combat?.turn || 0;
    const resolutionId = `${combatId}-${combatRound}-${combatTurn}`;

    return await withSuppressiveTemplateLock(templateDocument, async () => {
        // Re-read after acquiring the lock. Another token may have appended to
        // this shared array while this movement hook was queued.
        const flags = templateDocument.flags?.cyberpunk2020?.suppressiveFire;
        if(!flags || flags.remainingHitCap <= 0) return false;
        const resolvedTokens = flags.resolvedTokenIds || [];
        const tokenResolutionRecord = resolvedTokens.find(r => r.id === tokenDocument.id && r.resolutionId === resolutionId);

        if (tokenResolutionRecord) {
            return false; // Already resolved for this event
        }

        // Check geometric intersection
        const tCenter = tokenDocument.object?.center || {
            x: tokenDocument.x + (tokenDocument.width * (globalThis.canvas?.grid?.size || 100) / 2),
            y: tokenDocument.y + (tokenDocument.height * (globalThis.canvas?.grid?.size || 100) / 2)
        };
        const intersects = template.shape?.contains(tCenter.x - template.document.x, tCenter.y - template.document.y);

        if (intersects) {
            // Mark as resolved first to prevent loops
            const newResolved = [...resolvedTokens, { id: tokenDocument.id, resolutionId }];
            await template.document.update({ "flags.cyberpunk2020.suppressiveFire.resolvedTokenIds": newResolved });

            // Prompt the save dialog
            await promptSuppressiveFireSave(tokenDocument, template);
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

export async function promptSuppressiveFireSave(tokenDocument, template) {
    const flags = template.document.flags.cyberpunk2020.suppressiveFire;
    const actor = tokenDocument.actor;
    if (!actor) return;
    const actorName = escapeChatHtml(actor.name || "Target");
    const saveDC = escapeChatHtml(flags.saveDC);
    const remainingHitCap = escapeChatHtml(flags.remainingHitCap);
    const templateId = escapeChatHtml(template.document.id);
    const actorId = escapeChatHtml(actor.id);

    // Dispatch a chat message asking for the save
    let chatData = {
        user: globalThis.game?.user?.id || "test",
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
                    <button type="button" class="roll-suppressive-hits" data-template-id="${templateId}" data-actor-id="${actorId}">Failed Save! Roll 1D6 Hits</button>
                </div>
            </div>
        `
    };
    
    if (globalThis.ChatMessage) {
        await globalThis.ChatMessage.create(chatData);
    }
}
