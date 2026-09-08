import { buildCombatChatData } from "./combat-chat.js";
import { COMBAT_CHAT_STATUS, COMBAT_WARNING_SEVERITY } from "./combat-outcome.js";
import { planCombatUpdates } from "./state-planner.js";
import { renderFoundryTemplate } from "../foundry-compat.js";

const UNSAFE_PLAN_WARNING_CODES = Object.freeze([
  "invalid-actor-update",
  "invalid-item-update",
  "invalid-embedded-item-update",
  "unserializable-update-payload",
  "unserializable-update-value",
  "unserializable-embedded-item-update",
  "conflicting-update-path",
  "conflicting-embedded-update-path",
  "insufficient-update-permission",
  "source-state-changed"
]);
const COMMIT_GUARD_REGISTRY = new Map();
const COMMIT_GUARD_TTL_MS = 5 * 60 * 1000;
const COMMIT_GUARD_MAX_ENTRIES = 2000;

export function buildCombatPreviewData(outcome = {}, plannedUpdates = undefined, options = {}) {
  const plan = plannedUpdates || planCombatUpdates(outcome);
  const warnings = collectBlockingWarnings(outcome, plan);
  const canCommit = warnings.length === 0;
  const status = canCommit ? COMBAT_CHAT_STATUS.preview : COMBAT_CHAT_STATUS.manual;
  const chatData = buildCombatChatData(outcome, plan, {
    status: options.status || status
  });

  return {
    status,
    canCommit,
    actions: {
      confirm: "confirm",
      cancel: "cancel"
    },
    action: clonePlainData(outcome.action || {}),
    attacker: extractActorRef(outcome.attacker),
    weapon: extractWeaponRef(outcome.weapon),
    ammo: clonePlainData(outcome.ammo || {}),
    plannedUpdates: summarizePlannedUpdates(plan),
    manualResolution: normalizeManualResolution(outcome.manualResolution),
    warnings,
    chatData,
    targets: (outcome.targets || []).map(buildTargetPreviewData)
  };
}

/**
 * Build a compact, user-facing list of the state changes represented by a
 * prepared combat plan. This deliberately stays plain-data-only so the same
 * summary can be rendered in a dialog or asserted in tests.
 */
export function buildCombatChangeSummary(outcome = {}, plan = {}) {
  const changes = [];
  const targetDataByActor = new Map();
  const armorNamesByActor = new Map();

  for(const targetOutcome of outcome.targets || []) {
    const actorUuid = targetOutcome?.target?.actorUuid;
    if(!actorUuid) continue;
    targetDataByActor.set(actorUuid, targetOutcome);
    armorNamesByActor.set(actorUuid, new Map(
      (targetOutcome?.target?.snapshot?.equippedArmor || [])
        .filter(armor => armor?.id)
        .map(armor => [armor.id, armor.name || armor.id])
    ));
  }

  const ammoUpdate = (plan.itemUpdates || []).find(entry =>
    entry.itemUuid === outcome?.weapon?.itemUuid
    && Object.prototype.hasOwnProperty.call(entry.update || {}, "system.shotsLeft")
  );
  if(ammoUpdate) {
    changes.push(changeRow({
      kind: "ammo",
      subject: outcome?.weapon?.name || "Weapon",
      before: findPreparedBaseline(plan, "itemUpdates", {
        itemUuid: ammoUpdate.itemUuid,
        path: "system.shotsLeft"
      }),
      after: ammoUpdate.update["system.shotsLeft"]
    }));
  }

  for(const entry of plan.actorUpdates || []) {
    for(const [path, after] of Object.entries(entry.update || {})) {
      const targetOutcome = targetDataByActor.get(entry.actorUuid);
      const sdpMatch = /^system\.hitLocations\.([^.]+)\.sdp\.value$/.exec(path);
      const isWoundDamage = path === "system.damage";
      changes.push(changeRow({
        kind: isWoundDamage ? "wounds" : (sdpMatch ? "sdp" : "state"),
        subject: targetOutcome?.target?.name || entry.actorUuid,
        before: findPreparedBaseline(plan, "actorUpdates", {
          actorUuid: entry.actorUuid,
          path
        }),
        after,
        detail: sdpMatch?.[1]
          || (isWoundDamage ? targetOutcome?.damage?.nextWoundState?.label : path)
      }));
    }
  }

  for(const batch of plan.embeddedItemUpdates || []) {
    const targetOutcome = targetDataByActor.get(batch.actorUuid);
    const armorNames = armorNamesByActor.get(batch.actorUuid) || new Map();
    for(const update of batch.updates || []) {
      for(const [path, after] of Object.entries(update || {})) {
        if(path === "_id") continue;
        const ablationMatch = /^system\.coverage\.([^.]+)\.ablation$/.exec(path);
        changes.push(changeRow({
          kind: ablationMatch ? "armor" : "state",
          subject: armorNames.get(update._id) || update._id || targetOutcome?.target?.name || batch.actorUuid,
          before: findPreparedBaseline(plan, "embeddedItemUpdates", {
            actorUuid: batch.actorUuid,
            type: batch.type,
            itemId: update._id,
            path
          }),
          after,
          detail: ablationMatch?.[1] || path
        }));
      }
    }
  }

  for(const entry of plan.itemUpdates || []) {
    for(const [path, after] of Object.entries(entry.update || {})) {
      if(path === "system.shotsLeft" && entry === ammoUpdate) continue;
      changes.push(changeRow({
        kind: "state",
        subject: entry.itemUuid === outcome?.weapon?.itemUuid
          ? outcome?.weapon?.name || entry.itemUuid
          : entry.itemUuid,
        before: findPreparedBaseline(plan, "itemUpdates", {
          itemUuid: entry.itemUuid,
          path
        }),
        after,
        detail: path
      }));
    }
  }

  return changes;
}

export function buildCombatTargetSummaries(targets = []) {
  return (targets || []).map(target => {
    const hits = Array.isArray(target?.hits) ? target.hits : [];
    const notFired = target?.attack?.notFired === true;
    const hit = !notFired && (target?.attack?.hit === true || hits.length > 0);
    const rollTotal = target?.attack?.roll?.total;
    const targetNumber = target?.attack?.targetNumber;
    return {
      name: target?.target?.name,
      notFired,
      hit,
      hitCount: hits.length,
      hasHits: hits.length > 0,
      hasRollDetails: rollTotal !== undefined || targetNumber !== undefined,
      rollTotal: rollTotal ?? "?",
      targetNumber: targetNumber ?? "?",
      saveCount: Array.isArray(target?.saves) ? target.saves.length : 0,
      manual: target?.manualResolution?.required === true
    };
  });
}

export function collectCombatOutcomeWarnings(outcome = {}, extraWarnings = []) {
  const warnings = [];
  const addWarnings = entries => {
    for(const entry of entries || []) {
      const normalized = typeof entry === "string" ? { message: entry } : entry;
      if(!normalized?.message) continue;
      if(warnings.some(existing =>
        existing.message === normalized.message
        && (existing.code || "") === (normalized.code || "")
      )) continue;
      warnings.push(clonePlainData(normalized));
    }
  };

  addWarnings(extraWarnings);
  addWarnings(outcome?.warnings);
  addWarnings(outcome?.action?.warnings);
  addWarnings((outcome?.pendingDecisions || []).map(decision => ({
    code: decision?.code || "pending-decision",
    message: decision?.message || decision?.label || decision?.reason
  })));

  for(const target of outcome?.targets || []) {
    addWarnings(target?.warnings);
    addWarnings(target?.attack?.warnings);
    addWarnings(target?.damage?.warnings);
    addWarnings((target?.pendingDecisions || []).map(decision => ({
      code: decision?.code || "pending-decision",
      message: decision?.message || decision?.label || decision?.reason
    })));
    for(const hit of target?.hits || []) {
      addWarnings(hit?.warnings);
      addWarnings(hit?.armor?.warnings);
    }
  }
  return warnings;
}

export async function previewAndConfirmCombatOutcome(outcome = {}, options = {}) {
  const {
    DialogClass = globalThis.Dialog,
    renderDialogTemplate = renderFoundryTemplate,
    titleKey = "CombatApplyTitle",
    ...commitOptions
  } = options;
  const previewResult = await previewAndApplyCombatOutcome(outcome, commitOptions);
  if(typeof DialogClass !== "function" || typeof renderDialogTemplate !== "function") {
    return previewResult;
  }

  const preview = previewResult.preview;
  const plan = preview?.plan || {};
  const headingId = `combat-confirm-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const dialogData = {
    headingId,
    canCommit: preview?.canCommit === true,
    changes: buildCombatChangeSummary(outcome, plan),
    targets: buildCombatTargetSummaries(preview?.targets || []).map(target => ({
      ...target,
      name: target.name || localizeCombatUi("UnknownTarget")
    })),
    warnings: collectCombatOutcomeWarnings(outcome, [
      ...(preview?.warnings || []),
      ...(plan?.warnings || [])
    ])
  };

  let content;
  try {
    content = await renderDialogTemplate(
      "systems/cyberpunk2020-rilerena/templates/dialog/combat-confirm.hbs",
      dialogData
    );
  } catch(error) {
    console.error("Failed to render combat confirmation:", error);
    return previewAndApplyCombatOutcome(outcome, {
      ...commitOptions,
      decision: "cancel",
      messageId: previewResult.messageId,
      plannedUpdates: plan
    });
  }

  return new Promise((resolve, reject) => {
    let resolved = false;
    const settleDecision = async (decision) => {
      if(resolved) return;
      resolved = true;
      try {
        resolve(await previewAndApplyCombatOutcome(outcome, {
          ...commitOptions,
          decision,
          messageId: previewResult.messageId,
          plannedUpdates: plan
        }));
      } catch(error) {
        reject(error);
      }
    };

    const buttons = {
      cancel: {
        label: localizeCombatUi("CombatCancelAction"),
        callback: () => settleDecision("cancel")
      }
    };
    if(dialogData.canCommit) {
      buttons.confirm = {
        label: localizeCombatUi("CombatApplyAction"),
        callback: () => settleDecision("confirm")
      };
    }

    try {
      new DialogClass({
        title: localizeCombatUi(titleKey),
        content,
        buttons,
        default: "cancel",
        close: () => {
          if(!resolved) settleDecision("cancel");
        }
      }, {
        classes: ["cyberpunk", "combat-confirm-dialog"],
        width: 520
      }).render(true);
    } catch(error) {
      console.error("Failed to open combat confirmation:", error);
      settleDecision("cancel");
    }
  });
}

export async function previewAndApplyCombatOutcome(outcome = {}, options = {}) {
  const adapter = options.adapter || createFoundryCombatAdapter();
  const rawPlan = options.plannedUpdates || planCombatUpdates(outcome);
  const plan = await ensureCommitPlanPrepared(rawPlan, adapter, outcome);
  const preview = buildCombatPreviewData(outcome, plan, options);
  const commitKey = resolveCommitKey(options, outcome, plan);

  let messageId = options.messageId;
  const warnings = [];

  if (options.decision === "cancel") {
    try {
      messageId = await createOrUpdateCombatChatMessage(outcome, COMBAT_CHAT_STATUS.canceled, {
        ...options,
        messageId,
        plannedUpdates: plan,
        adapter
      });
    } catch (error) {
      console.warn("Failed to create or update combat chat message:", error);
      warnings.push(commitWarning("chat-update-failed", `Failed to update combat chat message: ${error.message}`));
    }
    return {
      status: COMBAT_CHAT_STATUS.canceled,
      chatData: buildFinalChatData(outcome, plan, COMBAT_CHAT_STATUS.canceled),
      preview,
      messageId,
      applied: createEmptyCounts(),
      skipped: countPlanUpdates(plan),
      warnings: warnings.concat(preview.warnings)
    };
  }

  if (options.decision === "confirm") {
    if (!preview.canCommit) {
      try {
        messageId = await createOrUpdateCombatChatMessage(outcome, COMBAT_CHAT_STATUS.manual, {
          ...options,
          messageId,
          plannedUpdates: plan,
          adapter
        });
      } catch (error) {
        console.warn("Failed to create or update combat chat message:", error);
        warnings.push(commitWarning("chat-update-failed", `Failed to update combat chat message: ${error.message}`));
      }
      return {
        status: COMBAT_CHAT_STATUS.manual,
        chatData: buildFinalChatData(outcome, plan, COMBAT_CHAT_STATUS.manual),
        preview,
        messageId,
        applied: createEmptyCounts(),
        skipped: countPlanUpdates(plan),
        warnings: warnings.concat(preview.warnings)
      };
    }

    if(commitKey) {
      const duplicateWarning = acquireCommitGuard(commitKey);
      if(duplicateWarning) {
        warnings.push(duplicateWarning);
        try {
          messageId = await createOrUpdateCombatChatMessage(outcome, COMBAT_CHAT_STATUS.manual, {
            ...options,
            messageId,
            plannedUpdates: plan,
            adapter,
            warnings
          });
        } catch (error) {
          console.warn("Failed to update duplicate combat chat message:", error);
          warnings.push(commitWarning("chat-update-failed", `Failed to update combat chat message: ${error.message}`));
        }
        return {
          status: COMBAT_CHAT_STATUS.manual,
          chatData: buildFinalChatData(outcome, plan, COMBAT_CHAT_STATUS.manual),
          preview,
          messageId,
          applied: createEmptyCounts(),
          skipped: countPlanUpdates(plan),
          warnings: [...warnings, ...preview.warnings]
        };
      }
    }

    let result;
    try {
      result = await applyCombatUpdates(plan, adapter);
    } finally {
      if(commitKey) {
        if(result?.status !== COMBAT_CHAT_STATUS.committed) {
          releaseCommitGuard(commitKey);
        } else {
          markCommitGuardCommitted(commitKey);
        }
      }
    }

    try {
      messageId = await createOrUpdateCombatChatMessage(outcome, result.status, {
        ...options,
        messageId,
        plannedUpdates: plan,
        adapter,
        warnings: result.warnings
      });
    } catch (error) {
      console.warn("Failed to create or update combat chat message:", error);
      result.warnings.push(commitWarning("chat-update-failed", `Failed to update combat chat message: ${error.message}`));
    }

    return {
      ...result,
      chatData: buildFinalChatData(outcome, plan, result.status),
      preview,
      messageId
    };
  }

  // No decision provided: we are showing the preview
  const initialStatus = preview.status;
  try {
    messageId = await createOrUpdateCombatChatMessage(outcome, initialStatus, {
      ...options,
      messageId,
      plannedUpdates: plan,
      adapter
    });
  } catch (error) {
    console.warn("Failed to create or update combat chat message:", error);
    warnings.push(commitWarning("chat-update-failed", `Failed to update combat chat message: ${error.message}`));
  }

  return {
    status: preview.status,
    chatData: buildFinalChatData(outcome, plan, preview.status),
    preview: {
      ...preview,
      plan
    },
    messageId,
    applied: createEmptyCounts(),
    skipped: countPlanUpdates(plan),
    warnings: warnings.concat(preview.warnings)
  };
}

export async function applyCombatUpdates(plan = {}, adapter = createFoundryCombatAdapter()) {
  const planWarnings = collectUnsafePlanWarnings(plan);
  if(planWarnings.length > 0) {
    return blockedResult(plan, planWarnings);
  }

  const preflight = await preflightCombatUpdates(plan, adapter);
  if(preflight.warnings.length > 0) {
    return blockedResult(plan, preflight.warnings);
  }
  const freshnessWarnings = validatePlanFreshness(plan, preflight);
  if(freshnessWarnings.length > 0) {
    return blockedResult(plan, freshnessWarnings);
  }

  const applied = createEmptyCounts();

  const itemUpdates = plan.itemUpdates || [];
  for(let index = 0; index < itemUpdates.length; index += 1) {
    const entry = itemUpdates[index];
    try {
      await preflight.items.get(entry.itemUuid).update(clonePlainData(entry.update));
      applied.itemUpdates += 1;
    }
    catch(error) {
      return failedCommitResult(plan, applied, {
        itemUpdates: itemUpdates.length - index,
        embeddedItemUpdates: countEmbeddedUpdates(plan.embeddedItemUpdates),
        actorUpdates: (plan.actorUpdates || []).length
      }, error, "item-update-failed");
    }
  }

  const embeddedItemUpdates = plan.embeddedItemUpdates || [];
  for(let index = 0; index < embeddedItemUpdates.length; index += 1) {
    const batch = embeddedItemUpdates[index];
    try {
      await preflight.actors.get(batch.actorUuid).updateEmbeddedDocuments(batch.type, clonePlainData(batch.updates));
      applied.embeddedItemUpdates += (batch.updates || []).length;
    }
    catch(error) {
      return failedCommitResult(plan, applied, {
        itemUpdates: 0,
        embeddedItemUpdates: countEmbeddedUpdates(embeddedItemUpdates.slice(index)),
        actorUpdates: (plan.actorUpdates || []).length
      }, error, "embedded-item-update-failed");
    }
  }

  const actorUpdates = plan.actorUpdates || [];
  for(let index = 0; index < actorUpdates.length; index += 1) {
    const entry = actorUpdates[index];
    try {
      await preflight.actors.get(entry.actorUuid).update(clonePlainData(entry.update));
      applied.actorUpdates += 1;
    }
    catch(error) {
      return failedCommitResult(plan, applied, {
        itemUpdates: 0,
        embeddedItemUpdates: 0,
        actorUpdates: actorUpdates.length - index
      }, error, "actor-update-failed");
    }
  }

  return {
    status: COMBAT_CHAT_STATUS.committed,
    chatData: buildStatusData(COMBAT_CHAT_STATUS.committed),
    applied,
    skipped: createEmptyCounts(),
    warnings: []
  };
}

async function ensureCommitPlanPrepared(plan = {}, adapter = createFoundryCombatAdapter(), outcome = {}) {
  const clonedPlan = clonePlainData(plan || {});
  if(!clonedPlan.commitNonce) {
    clonedPlan.commitNonce = typeof globalThis.crypto?.randomUUID === "function" ? globalThis.crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  }
  const freshnessAlreadyPrepared = clonedPlan?.freshnessChecks?.prepared === true;
  // Permission is live state, unlike the baseline values captured for stale
  // preview detection. Re-evaluate it for every preview and confirm attempt.
  clonedPlan.warnings = (clonedPlan.warnings || [])
    .filter(warning => warning?.code !== "insufficient-update-permission");

  const checks = {
    itemUpdates: [],
    actorUpdates: [],
    embeddedItemUpdates: []
  };
  for(const entry of clonedPlan.itemUpdates || []) {
    const item = await adapter.resolveItem(entry.itemUuid).catch(() => undefined);
    if(!item) {
      continue;
    }
    if(!canCurrentUserUpdate(item)) {
      addPlanWarning(clonedPlan, "insufficient-update-permission", `You cannot update item ${entry.itemUuid}; combat changes require a GM.`);
    }
    for(const path of freshnessAlreadyPrepared ? [] : Object.keys(entry.update || {})) {
      const currentValue = clonePlainData(readDataPath(item, path));
      warnIfSourceStateChanged(clonedPlan, outcome, "itemUpdates", {
        itemUuid: entry.itemUuid,
        path
      }, currentValue);
      checks.itemUpdates.push({
        itemUuid: entry.itemUuid,
        path,
        baselineValue: currentValue
      });
    }
  }
  for(const entry of clonedPlan.actorUpdates || []) {
    const actor = await adapter.resolveActor(entry.actorUuid).catch(() => undefined);
    if(!actor) {
      continue;
    }
    if(!canCurrentUserUpdate(actor)) {
      addPlanWarning(clonedPlan, "insufficient-update-permission", `You cannot update actor ${entry.actorUuid}; combat changes require a GM.`);
    }
    for(const path of freshnessAlreadyPrepared ? [] : Object.keys(entry.update || {})) {
      const currentValue = clonePlainData(readDataPath(actor, path));
      warnIfSourceStateChanged(clonedPlan, outcome, "actorUpdates", {
        actorUuid: entry.actorUuid,
        path
      }, currentValue);
      checks.actorUpdates.push({
        actorUuid: entry.actorUuid,
        path,
        baselineValue: currentValue
      });
    }
  }
  for(const batch of clonedPlan.embeddedItemUpdates || []) {
    const actor = await adapter.resolveActor(batch.actorUuid).catch(() => undefined);
    if(!actor) {
      continue;
    }
    if(!canCurrentUserUpdate(actor)) {
      addPlanWarning(clonedPlan, "insufficient-update-permission", `You cannot update actor ${batch.actorUuid}; armor changes require a GM.`);
    }
    for(const update of freshnessAlreadyPrepared ? [] : (batch.updates || [])) {
      const itemId = update?._id;
      const embedded = resolveEmbeddedDocument(actor, batch.type, itemId);
      if(!embedded) {
        continue;
      }
      for(const path of Object.keys(update || {})) {
        if(path === "_id") {
          continue;
        }
        const currentValue = clonePlainData(readDataPath(embedded, path));
        warnIfSourceStateChanged(clonedPlan, outcome, "embeddedItemUpdates", {
          actorUuid: batch.actorUuid,
          type: batch.type,
          itemId,
          path
        }, currentValue);
        checks.embeddedItemUpdates.push({
          actorUuid: batch.actorUuid,
          type: batch.type,
          itemId,
          path,
          baselineValue: currentValue
        });
      }
    }
  }
  if(!freshnessAlreadyPrepared) {
    clonedPlan.freshnessChecks = {
      prepared: true,
      ...checks
    };
  }
  return clonedPlan;
}

function validatePlanFreshness(plan, preflight) {
  const warnings = [];
  const checks = plan?.freshnessChecks;
  if(!checks?.prepared) {
    return warnings;
  }

  for(const check of checks.itemUpdates || []) {
    const item = preflight.items.get(check.itemUuid);
    if(!item) {
      warnings.push(commitWarning("stale-preview-blocked", `Item missing before confirm (${check.itemUuid}). Commit was blocked.`));
      return warnings;
    }
    const currentValue = clonePlainData(readDataPath(item, check.path));
    if(!isFreshnessValueEqual(currentValue, check.baselineValue)) {
      warnings.push(commitWarning("stale-preview-blocked", `Item state changed before confirm (${check.itemUuid} ${check.path}). Commit was blocked.`));
      return warnings;
    }
  }
  for(const check of checks.actorUpdates || []) {
    const actor = preflight.actors.get(check.actorUuid);
    if(!actor) {
      warnings.push(commitWarning("stale-preview-blocked", `Actor missing before confirm (${check.actorUuid}). Commit was blocked.`));
      return warnings;
    }
    const currentValue = clonePlainData(readDataPath(actor, check.path));
    if(!isFreshnessValueEqual(currentValue, check.baselineValue)) {
      warnings.push(commitWarning("stale-preview-blocked", `Actor state changed before confirm (${check.actorUuid} ${check.path}). Commit was blocked.`));
      return warnings;
    }
  }
  for(const check of checks.embeddedItemUpdates || []) {
    const actor = preflight.actors.get(check.actorUuid);
    if(!actor) {
      warnings.push(commitWarning("stale-preview-blocked", `Actor missing before confirm (${check.actorUuid}). Commit was blocked.`));
      return warnings;
    }
    const embedded = resolveEmbeddedDocument(actor, check.type, check.itemId);
    if(!embedded) {
      warnings.push(commitWarning("stale-preview-blocked", `Embedded item is missing before confirm (${check.actorUuid} ${check.itemId}). Commit was blocked.`));
      return warnings;
    }
    const currentValue = clonePlainData(readDataPath(embedded, check.path));
    if(!isFreshnessValueEqual(currentValue, check.baselineValue)) {
      warnings.push(commitWarning("stale-preview-blocked", `Embedded item state changed before confirm (${check.actorUuid} ${check.itemId} ${check.path}). Commit was blocked.`));
      return warnings;
    }
  }
  return warnings;
}

export function createFoundryCombatAdapter() {
  return {
    async resolveItem(itemUuid) {
      return resolveFoundryDocument(itemUuid);
    },
    async resolveActor(actorUuid) {
      return resolveFoundryDocument(actorUuid);
    },
    async renderTemplate(templatePath, data) {
      return renderFoundryTemplate(templatePath, data);
    },
    async createChatMessage(chatData) {
      if (typeof globalThis.ChatMessage?.create !== "function") {
        throw new Error("Foundry ChatMessage.create is unavailable; inject a combat commit adapter for tests or non-Foundry runtimes.");
      }
      const message = await globalThis.ChatMessage.create(chatData);
      return message?.id;
    },
    async updateChatMessage(messageId, updateData) {
      if (typeof globalThis.game?.messages?.get !== "function") {
        throw new Error("Foundry game.messages.get is unavailable; inject a combat commit adapter for tests or non-Foundry runtimes.");
      }
      const message = globalThis.game.messages.get(messageId);
      if (!message) {
        console.warn(`ChatMessage ${messageId} could not be resolved for update (it may have been deleted).`);
        return;
      }
      await message.update(updateData);
    }
  };
}

async function preflightCombatUpdates(plan, adapter) {
  const items = new Map();
  const actors = new Map();
  const warnings = [];

  for(const entry of plan.itemUpdates || []) {
    let item;
    try {
      item = await adapter.resolveItem(entry.itemUuid);
    }
    catch(error) {
      warnings.push(commitWarning("resolve-item-document-failed", `Item document ${entry.itemUuid} could not be resolved for commit.`, errorToPlainData(error)));
      continue;
    }
    if(!item || typeof item.update !== "function") {
      warnings.push(commitWarning("missing-item-document", `Item document ${entry.itemUuid} could not be resolved for commit.`));
      continue;
    }
    if(!canCurrentUserUpdate(item)) {
      addUniqueCommitWarning(warnings, "insufficient-update-permission", `You cannot update item ${entry.itemUuid}; combat changes require a GM.`);
    }
    items.set(entry.itemUuid, item);
  }

  for(const batch of plan.embeddedItemUpdates || []) {
    const actor = await resolveActorForPreflight(actors, adapter, batch.actorUuid, warnings);
    if(!actor || typeof actor.updateEmbeddedDocuments !== "function") {
      warnings.push(commitWarning("missing-actor-document", `Actor document ${batch.actorUuid} could not be resolved for embedded item commit.`));
    }
    else if(!canCurrentUserUpdate(actor)) {
      addUniqueCommitWarning(warnings, "insufficient-update-permission", `You cannot update actor ${batch.actorUuid}; armor changes require a GM.`);
    }
    for(const update of batch.updates || []) {
      if(!update?._id) {
        warnings.push(commitWarning("invalid-embedded-item-update", `Embedded ${batch.type} update on actor ${batch.actorUuid} requires an _id before commit.`));
      }
    }
  }

  for(const entry of plan.actorUpdates || []) {
    const actor = await resolveActorForPreflight(actors, adapter, entry.actorUuid, warnings);
    if(!actor || typeof actor.update !== "function") {
      warnings.push(commitWarning("missing-actor-document", `Actor document ${entry.actorUuid} could not be resolved for commit.`));
    }
    else if(!canCurrentUserUpdate(actor)) {
      addUniqueCommitWarning(warnings, "insufficient-update-permission", `You cannot update actor ${entry.actorUuid}; combat changes require a GM.`);
    }
  }

  return {
    items,
    actors,
    warnings
  };
}

async function resolveActorForPreflight(actors, adapter, actorUuid, warnings) {
  if(actors.has(actorUuid)) {
    return actors.get(actorUuid);
  }

  let actor;
  try {
    actor = await adapter.resolveActor(actorUuid);
  }
  catch(error) {
    warnings.push(commitWarning("resolve-actor-document-failed", `Actor document ${actorUuid} could not be resolved for commit.`, errorToPlainData(error)));
    return undefined;
  }
  if(actor) {
    actors.set(actorUuid, actor);
  }
  return actor;
}

function collectBlockingWarnings(outcome, plan) {
  const warnings = [];
  if(outcome?.manualResolution?.required) {
    warnings.push(commitWarning("manual-resolution-required", outcome.manualResolution.message || "Manual resolution is required before combat updates can be committed."));
  }

  for(const target of outcome?.targets || []) {
    if(target?.manualResolution?.required) {
      warnings.push(commitWarning("manual-resolution-required", target.manualResolution.message || "A target requires manual resolution before combat updates can be committed."));
    }
  }

  warnings.push(...collectUnsafePlanWarnings(plan));
  return warnings;
}

function collectUnsafePlanWarnings(plan) {
  return (plan?.warnings || [])
    .filter(warning => UNSAFE_PLAN_WARNING_CODES.includes(warning?.code))
    .map(warning => commitWarning("unsafe-plan-warning", warning.message || `Unsafe planned update warning: ${warning.code}.`, warning));
}

function blockedResult(plan, warnings) {
  return {
    status: COMBAT_CHAT_STATUS.manual,
    chatData: buildStatusData(COMBAT_CHAT_STATUS.manual),
    applied: createEmptyCounts(),
    skipped: countPlanUpdates(plan),
    warnings
  };
}

function failedCommitResult(plan, applied, skipped, error, phase) {
  return {
    status: COMBAT_CHAT_STATUS.manual,
    chatData: buildStatusData(COMBAT_CHAT_STATUS.manual),
    applied,
    skipped,
    warnings: [
      commitWarning("combat-update-failed", `Combat update failed during ${phase}; later updates were not applied.`, errorToPlainData(error))
    ]
  };
}

function countPlanUpdates(plan = {}) {
  return {
    itemUpdates: (plan.itemUpdates || []).length,
    embeddedItemUpdates: countEmbeddedUpdates(plan.embeddedItemUpdates),
    actorUpdates: (plan.actorUpdates || []).length
  };
}

function createEmptyCounts() {
  return {
    itemUpdates: 0,
    embeddedItemUpdates: 0,
    actorUpdates: 0
  };
}

function buildTargetPreviewData(targetOutcome = {}) {
  return {
    target: extractActorRef(targetOutcome.target),
    attack: clonePlainData(targetOutcome.attack || {}),
    hits: cloneArray(targetOutcome.hits),
    damage: clonePlainData(targetOutcome.damage || {}),
    saves: cloneArray(targetOutcome.saves),
    plannedUpdates: summarizePlannedUpdates(targetOutcome.plannedUpdates),
    manualResolution: normalizeManualResolution(targetOutcome.manualResolution),
    warnings: cloneArray(targetOutcome.warnings)
  };
}

function changeRow({ kind, subject, before, after, detail = undefined }) {
  return {
    kind,
    subject,
    before: before === undefined ? "?" : clonePlainData(before),
    after: after === undefined ? "?" : clonePlainData(after),
    ...(detail ? { detail } : {})
  };
}

function findPreparedBaseline(plan, category, expected = {}) {
  const checks = plan?.freshnessChecks?.[category] || [];
  const match = checks.find(check => Object.entries(expected)
    .every(([key, value]) => check?.[key] === value));
  return match?.baselineValue;
}

function canCurrentUserUpdate(document) {
  const user = globalThis.game?.user;
  if(user && typeof document?.canUserModify === "function") {
    try {
      return document.canUserModify(user, "update") !== false;
    } catch {
      // Fall back to the ownership flag exposed by Foundry Documents.
    }
  }
  return document?.isOwner !== false;
}

function addPlanWarning(plan, code, message) {
  plan.warnings = Array.isArray(plan.warnings) ? plan.warnings : [];
  if(plan.warnings.some(warning => warning?.code === code && warning?.message === message)) {
    return;
  }
  plan.warnings.push({
    code,
    severity: COMBAT_WARNING_SEVERITY.warning,
    message
  });
}

function addUniqueCommitWarning(warnings, code, message) {
  if(warnings.some(warning => warning?.code === code && warning?.message === message)) {
    return;
  }
  warnings.push(commitWarning(code, message));
}

function warnIfSourceStateChanged(plan, outcome, category, expected, currentValue) {
  const sourceValue = findOutcomeSourceBaseline(outcome, category, expected);
  if(sourceValue === undefined || isFreshnessValueEqual(currentValue, sourceValue)) {
    return;
  }
  const subject = expected.itemUuid || expected.actorUuid || "document";
  addPlanWarning(
    plan,
    "source-state-changed",
    `State changed while the attack was being prepared (${subject} ${expected.path}). Recalculate the attack before applying changes.`
  );
}

function findOutcomeSourceBaseline(outcome, category, expected) {
  if(category === "itemUpdates" && expected.itemUuid === outcome?.weapon?.itemUuid) {
    if(expected.path === "system.shotsLeft" && outcome?.ammo?.before !== undefined) {
      return clonePlainData(outcome.ammo.before);
    }
    return clonePlainData(readSnapshotPath(outcome?.weapon?.snapshot, expected.path));
  }

  const targetOutcome = (outcome?.targets || [])
    .find(target => target?.target?.actorUuid === expected.actorUuid);
  if(!targetOutcome) {
    return undefined;
  }
  if(category === "actorUpdates") {
    return clonePlainData(readSnapshotPath(targetOutcome?.target?.snapshot, expected.path));
  }
  if(category === "embeddedItemUpdates") {
    const item = (targetOutcome?.target?.snapshot?.equippedArmor || [])
      .find(armor => armor?.id === expected.itemId);
    return clonePlainData(readDataPath(item, expected.path));
  }
  return undefined;
}

function readSnapshotPath(snapshot, documentPath) {
  const snapshotPath = String(documentPath || "").replace(/^system\./, "");
  return readDataPath(snapshot, snapshotPath);
}

function localizeCombatUi(key) {
  const fullKey = `CYBERPUNK.${key}`;
  try {
    const localized = globalThis.game?.i18n?.localize?.(fullKey);
    return localized && localized !== fullKey ? localized : key;
  } catch {
    return key;
  }
}

function summarizePlannedUpdates(plannedUpdates = {}) {
  return {
    chatStatus: plannedUpdates.chatStatus || COMBAT_CHAT_STATUS.preview,
    actorUpdateCount: (plannedUpdates.actorUpdates || []).length,
    itemUpdateCount: (plannedUpdates.itemUpdates || []).length,
    embeddedItemUpdateCount: countEmbeddedUpdates(plannedUpdates.embeddedItemUpdates),
    warnings: cloneArray(plannedUpdates.warnings)
  };
}

function countEmbeddedUpdates(embeddedItemUpdates = []) {
  return embeddedItemUpdates.reduce((count, batch) => count + (batch?.updates || []).length, 0);
}

function normalizeManualResolution(manualResolution = {}) {
  return {
    required: !!manualResolution.required,
    ...(manualResolution.reason ? { reason: manualResolution.reason } : {}),
    ...(manualResolution.message ? { message: manualResolution.message } : {}),
    ...(manualResolution.blockedUpdateCategories ? { blockedUpdateCategories: cloneArray(manualResolution.blockedUpdateCategories) } : {})
  };
}

function extractActorRef(ref = {}) {
  return {
    ...(ref.actorUuid ? { actorUuid: ref.actorUuid } : {}),
    ...(ref.tokenUuid ? { tokenUuid: ref.tokenUuid } : {}),
    ...(ref.name ? { name: ref.name } : {})
  };
}

function extractWeaponRef(weapon = {}) {
  return {
    ...(weapon.itemUuid ? { itemUuid: weapon.itemUuid } : {}),
    ...(weapon.name ? { name: weapon.name } : {})
  };
}

function commitWarning(code, message, source = undefined) {
  return {
    code,
    severity: COMBAT_WARNING_SEVERITY.warning,
    message,
    ...(source ? { source } : {})
  };
}

function buildFinalChatData(outcome, plan, status) {
  return buildCombatChatData(outcome, {
    ...plan,
    chatStatus: status
  }, {
    status
  });
}

function buildStatusData(status) {
  return {
    status,
    ...{
      isPreview: status === COMBAT_CHAT_STATUS.preview,
      isManual: status === COMBAT_CHAT_STATUS.manual,
      isCommitted: status === COMBAT_CHAT_STATUS.committed,
      isCanceled: status === COMBAT_CHAT_STATUS.canceled
    }
  };
}

function errorToPlainData(error) {
  return {
    name: error?.name || "Error",
    message: error?.message || String(error)
  };
}

function cloneArray(value = []) {
  return Array.isArray(value) ? value.map(entry => clonePlainData(entry)) : [];
}

function clonePlainData(data) {
  if(data === undefined) {
    return undefined;
  }
  return JSON.parse(JSON.stringify(data));
}

function isFreshnessValueEqual(a, b) {
  if (typeof globalThis.foundry?.utils?.objectsEqual === "function") {
    return globalThis.foundry.utils.objectsEqual(a, b);
  }
  return JSON.stringify(a) === JSON.stringify(b);
}

function readDataPath(document, path) {
  if(!path || typeof path !== "string") {
    return undefined;
  }
  if (typeof globalThis.foundry?.utils?.getProperty === "function") {
    return globalThis.foundry.utils.getProperty(document, path);
  }
  const parts = path.split(".");
  let current = document;
  for(const part of parts) {
    if(current == null || typeof current !== "object") {
      return undefined;
    }
    current = current[part];
  }
  return current;
}

function resolveEmbeddedDocument(actor, type, itemId) {
  if(!actor || !type || !itemId) {
    return undefined;
  }
  const collection = actor.items;
  if(collection && typeof collection.get === "function") {
    const found = collection.get(itemId);
    if(found) {
      return found;
    }
  }
  const fallback = actor[type];
  if(fallback && typeof fallback.get === "function") {
    return fallback.get(itemId);
  }
  if(Array.isArray(fallback)) {
    return fallback.find(entry => entry?._id === itemId || entry?.id === itemId);
  }
  return undefined;
}

function resolveCommitKey(options, outcome, plan) {
  if(typeof options.commitKey === "string" && options.commitKey.length > 0) {
    return options.commitKey;
  }
  const commitNonce = typeof plan?.commitNonce === "string" && plan.commitNonce.length > 0 ? plan.commitNonce : "";
  if(typeof options.messageId === "string" && options.messageId.length > 0 && commitNonce) {
    return `message:${options.messageId}:${commitNonce}`;
  }
  if(commitNonce) {
    return `preview:${commitNonce}`;
  }
  const fallbackNonce = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  return `ephemeral:${fallbackNonce}`;
}

function acquireCommitGuard(commitKey) {
  pruneCommitGuardRegistry();
  const existing = COMMIT_GUARD_REGISTRY.get(commitKey);
  if(existing?.committed || existing?.pending) {
    return commitWarning("duplicate-confirm-blocked", "Duplicate confirm attempt was blocked. This preview can only be committed once.");
  }
  COMMIT_GUARD_REGISTRY.set(commitKey, { pending: true, committed: false, touchedAt: Date.now() });
  return null;
}

function markCommitGuardCommitted(commitKey) {
  COMMIT_GUARD_REGISTRY.set(commitKey, { pending: false, committed: true, touchedAt: Date.now() });
}

function releaseCommitGuard(commitKey) {
  COMMIT_GUARD_REGISTRY.delete(commitKey);
}

function pruneCommitGuardRegistry() {
  const now = Date.now();
  for(const [key, entry] of COMMIT_GUARD_REGISTRY.entries()) {
    if(!entry?.pending && (now - (entry?.touchedAt || 0)) > COMMIT_GUARD_TTL_MS) {
      COMMIT_GUARD_REGISTRY.delete(key);
    }
  }

  if(COMMIT_GUARD_REGISTRY.size <= COMMIT_GUARD_MAX_ENTRIES) {
    return;
  }
  const sortedByTouchedAt = [...COMMIT_GUARD_REGISTRY.entries()]
    .filter(([, entry]) => !entry?.pending)
    .sort((a, b) => (a[1]?.touchedAt || 0) - (b[1]?.touchedAt || 0));
  const overflow = COMMIT_GUARD_REGISTRY.size - COMMIT_GUARD_MAX_ENTRIES;
  for(let index = 0; index < overflow && index < sortedByTouchedAt.length; index += 1) {
    COMMIT_GUARD_REGISTRY.delete(sortedByTouchedAt[index][0]);
  }
}

async function resolveFoundryDocument(uuid) {
  if(typeof globalThis.fromUuid !== "function") {
    throw new Error("Foundry fromUuid is unavailable; inject a combat commit adapter for tests or non-Foundry runtimes.");
  }
  return globalThis.fromUuid(uuid);
}

export async function createOrUpdateCombatChatMessage(outcome = {}, resultStatus, options = {}) {
  const adapter = options.adapter || createFoundryCombatAdapter();
  const plan = {
    ...(options.plannedUpdates || planCombatUpdates(outcome)),
    chatStatus: resultStatus
  };
  const chatData = buildCombatChatData(outcome, plan, { status: resultStatus });
  if (options.warnings && options.warnings.length > 0) {
    chatData.warnings = [
      ...chatData.warnings,
      ...options.warnings
    ];
  }

  const templatePath = "systems/cyberpunk2020-rilerena/templates/chat/combat-outcome.hbs";
  const htmlContent = await adapter.renderTemplate(templatePath, chatData);

  const messageId = options.messageId;
  const messageFlags = {
    [globalThis.game?.system?.id || "cyberpunk2020"]: {
      combatOutcome: chatData
    }
  };

  if (messageId) {
    await adapter.updateChatMessage(messageId, { 
      content: htmlContent,
      flags: messageFlags
    });
    return messageId;
  } else {
    let speaker = options.speaker;
    if(!speaker && typeof globalThis.ChatMessage?.getSpeaker === "function") {
      let actor;
      if (outcome.attacker?.actorUuid) {
        actor = await adapter.resolveActor(outcome.attacker.actorUuid).catch(() => undefined);
      }
      if (actor) {
        speaker = globalThis.ChatMessage.getSpeaker({ actor });
      } else {
        speaker = {};
      }
    }
    const chatMessageData = {
      content: htmlContent,
      flags: messageFlags
    };
    const userId = options.userId || (typeof globalThis.game?.user?.id === "string" ? globalThis.game.user.id : undefined);
    if (userId) chatMessageData.user = userId;
    if (speaker && Object.keys(speaker).length > 0) chatMessageData.speaker = speaker;
    const msgStyle = globalThis.CONST?.CHAT_MESSAGE_STYLES?.OTHER;
    const msgType = globalThis.CONST?.CHAT_MESSAGE_TYPES?.OTHER;
    if (msgStyle !== undefined) chatMessageData.style = msgStyle;
    else if (msgType !== undefined) chatMessageData.type = msgType;

    const createdId = await adapter.createChatMessage(chatMessageData);
    if (!createdId) {
      throw new Error("ChatMessage creation resolved to empty or undefined message ID.");
    }
    return createdId;
  }
}
