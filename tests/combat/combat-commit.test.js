import assert from "node:assert/strict";

import { COMBAT_CHAT_STATUS } from "../../module/combat/combat-outcome.js";
import {
  applyCombatUpdates,
  buildCombatChangeSummary,
  buildCombatTargetSummaries,
  buildCombatPreviewData,
  collectCombatOutcomeWarnings,
  previewAndConfirmCombatOutcome,
  previewAndApplyCombatOutcome
} from "../../module/combat/combat-commit.js";
import { planCombatUpdates } from "../../module/combat/state-planner.js";

export async function runCombatCommitTests() {
  assertPreviewData();
  assertCombatConfirmationProjection();
  await assertCombatChangeSummary();
  await assertDialogDefaultsToCancelAndSettles();
  await assertConfirmAppliesUpdatesInOrder();
  await assertConfirmPersistsMultipleLayerAblation();
  await assertCancelDoesNotApplyUpdates();
  await assertCancelDoesNotApplyMultipleLayerAblation();
  await assertManualResolutionBlocksCommit();
  await assertInvalidPlanBlocksCommit();
  await assertUnresolvedDocumentBlocksCommit();
  await assertResolverRejectionBlocksCommit();
  await assertPermissionBlockedPreview();
  await assertPermissionRevokedAfterPreviewBlocksCommit();
  await assertSourceStateChangedBeforePreviewBlocksCommit();
  await assertEmbeddedUpdateWithoutIdBlocksCommit();
  await assertWriteRejectionReturnsPartialFailure();
  await assertDuplicateConfirmIsBlocked();
  await assertStalePreviewIsBlocked();
  await assertStaleLayeredArmorPreviewIsBlocked();
  await assertChatOutcomeLifecycle();

  return {
    name: "combat-commit"
  };
}

async function assertDialogDefaultsToCancelAndSettles() {
  const outcome = buildOutcome();
  const adapter = createFakeAdapter({
    initialItems: {
      "Actor.attacker.Item.heavy-pistol": { system: { shotsLeft: 10 } }
    },
    initialActors: {
      "Actor.target": {
        system: { damage: 0 },
        items: {
          "armor-jacket": { _id: "armor-jacket", system: { coverage: { torso: { ablation: 0 } } } }
        }
      }
    }
  });
  let dialogData;
  let dialogOptions;
  class FakeDialog {
    constructor(data, options) {
      dialogData = data;
      dialogOptions = options;
    }
    render() { return this; }
  }

  const resultPromise = previewAndConfirmCombatOutcome(outcome, {
    adapter,
    DialogClass: FakeDialog,
    renderDialogTemplate: async (_path, data) => `<section>${data.headingId}</section>`
  });
  await new Promise(resolve => setTimeout(resolve, 0));

  assert.equal(dialogData.default, "cancel", "combat confirmation is fail-safe by default");
  assert.ok(dialogData.buttons.confirm, "valid plans expose an Apply action");
  assert.ok(dialogOptions.classes.includes("cyberpunk"), "dialog shell receives system styling");
  await dialogData.buttons.cancel.callback();
  const result = await resultPromise;
  assert.equal(result.status, COMBAT_CHAT_STATUS.canceled, "cancel action settles the combat flow");
}

function assertCombatConfirmationProjection() {
  const targets = buildCombatTargetSummaries([
    {
      target: { name: "Not fired" },
      attack: { notFired: true, hit: false },
      hits: []
    },
    {
      target: { name: "Grappled" },
      attack: { hit: true, roll: { total: 19 }, targetNumber: 15 },
      hits: []
    }
  ]);
  assert.equal(targets[0].notFired, true, "jammed targets are not mislabeled as misses");
  assert.equal(targets[0].hit, false);
  assert.equal(targets[1].hit, true, "non-damage successes remain successful");
  assert.equal(targets[1].hasHits, false, "non-damage successes do not claim zero damage hits");
  assert.equal(targets[1].rollTotal, 19);

  const warnings = collectCombatOutcomeWarnings({
    warnings: [{ code: "root", message: "Root warning" }],
    targets: [{
      attack: { warnings: [{ code: "jam", message: "Weapon jammed" }] },
      hits: [{ warnings: [{ code: "critical", message: "Critical injury" }] }]
    }]
  }, [{ code: "root", message: "Root warning" }]);
  assert.deepEqual(warnings.map(warning => warning.code), ["root", "jam", "critical"], "dialog keeps non-blocking combat warnings without duplicates");
}

async function assertPermissionBlockedPreview() {
  const outcome = buildOutcome();
  const adapter = createFakeAdapter({
    unownedActors: ["Actor.target"]
  });
  const previewResult = await previewAndApplyCombatOutcome(outcome, { adapter });

  assert.equal(previewResult.status, COMBAT_CHAT_STATUS.manual, "unowned targets require GM resolution");
  assert.equal(previewResult.preview.canCommit, false, "permission failure disables confirmation");
  assert.ok(
    previewResult.preview.warnings.some(warning => warning.source?.code === "insufficient-update-permission"),
    "preview explains the missing update permission"
  );

  const confirmResult = await previewAndApplyCombatOutcome(outcome, {
    adapter,
    decision: "confirm",
    messageId: previewResult.messageId,
    plannedUpdates: previewResult.preview.plan
  });
  assert.equal(confirmResult.status, COMBAT_CHAT_STATUS.manual);
  const mutations = adapter.calls.filter(call =>
    call.type === "item.update"
    || call.type === "actor.update"
    || call.type === "actor.updateEmbeddedDocuments"
  );
  assert.deepEqual(mutations, [], "permission-blocked combat cannot spend ammo or mutate a target");
}

async function assertPermissionRevokedAfterPreviewBlocksCommit() {
  const outcome = buildOutcome();
  const unownedActors = [];
  const adapter = createFakeAdapter({ unownedActors });
  const previewResult = await previewAndApplyCombatOutcome(outcome, { adapter });
  assert.equal(previewResult.preview.canCommit, true, "owned targets can initially be confirmed");

  unownedActors.push("Actor.target");
  const confirmResult = await previewAndApplyCombatOutcome(outcome, {
    adapter,
    decision: "confirm",
    messageId: previewResult.messageId,
    plannedUpdates: previewResult.preview.plan
  });

  assert.equal(confirmResult.status, COMBAT_CHAT_STATUS.manual, "revoked permission blocks confirmation");
  assert.ok(
    confirmResult.preview.warnings.some(warning => warning.source?.code === "insufficient-update-permission"),
    "confirmation reports the live permission failure"
  );
  const mutations = adapter.calls.filter(call =>
    call.type === "item.update"
    || call.type === "actor.update"
    || call.type === "actor.updateEmbeddedDocuments"
  );
  assert.deepEqual(mutations, [], "permission changes after preview cannot produce a partial commit");
}

async function assertSourceStateChangedBeforePreviewBlocksCommit() {
  const outcome = buildOutcome();
  const adapter = createFakeAdapter({
    initialItems: {
      "Actor.attacker.Item.heavy-pistol": { system: { shotsLeft: 10 } }
    },
    initialActors: {
      "Actor.target": {
        system: { damage: 3 },
        items: {
          "armor-jacket": { _id: "armor-jacket", system: { coverage: { torso: { ablation: 0 } } } }
        }
      }
    }
  });
  const previewResult = await previewAndApplyCombatOutcome(outcome, { adapter });

  assert.equal(previewResult.status, COMBAT_CHAT_STATUS.manual, "state changes before preview require recalculation");
  assert.ok(
    previewResult.preview.warnings.some(warning => warning.source?.code === "source-state-changed"),
    "preview explains that the source snapshot is stale"
  );
  const woundChange = buildCombatChangeSummary(outcome, previewResult.preview.plan)
    .find(change => change.kind === "wounds");
  assert.equal(woundChange.before, 3, "summary reports current document state, not the stale outcome value");

  const confirmResult = await previewAndApplyCombatOutcome(outcome, {
    adapter,
    decision: "confirm",
    messageId: previewResult.messageId,
    plannedUpdates: previewResult.preview.plan
  });
  assert.equal(confirmResult.status, COMBAT_CHAT_STATUS.manual);
  assert.equal(adapter.state.actors["Actor.target"].system.damage, 3, "stale attack cannot overwrite newer damage");
}

async function assertCombatChangeSummary() {
  const outcome = buildOutcome();
  const adapter = createFakeAdapter({
    initialItems: {
      "Actor.attacker.Item.heavy-pistol": { system: { shotsLeft: 10 } }
    },
    initialActors: {
      "Actor.target": {
        system: { damage: 0 },
        items: {
          "armor-jacket": { _id: "armor-jacket", system: { coverage: { torso: { ablation: 0 } } } }
        }
      }
    }
  });
  const previewResult = await previewAndApplyCombatOutcome(outcome, { adapter });
  const changes = buildCombatChangeSummary(outcome, previewResult.preview.plan);

  assert.deepEqual(changes, [
    {
      kind: "ammo",
      subject: "Heavy Pistol",
      before: 10,
      after: 9
    },
    {
      kind: "wounds",
      subject: "Guard",
      before: 0,
      after: 5
    },
    {
      kind: "armor",
      subject: "armor-jacket",
      before: 0,
      after: 1,
      detail: "torso"
    }
  ], "confirmation summary exposes every automatic state change");
}

function assertPreviewData() {
  const outcome = buildOutcome();
  const plan = planCombatUpdates(outcome);
  const preview = buildCombatPreviewData(outcome, plan);

  assert.equal(preview.status, COMBAT_CHAT_STATUS.preview, "preview status");
  assert.equal(preview.canCommit, true, "preview can commit valid plan");
  assert.deepEqual(preview.actions, {
    confirm: "confirm",
    cancel: "cancel"
  }, "preview actions");
  assert.deepEqual(preview.ammo, {
    before: 10,
    delta: -1,
    after: 9,
    source: "weapon.snapshot.shotsLeft"
  }, "preview ammo evidence");
  assert.deepEqual(preview.plannedUpdates, {
    chatStatus: COMBAT_CHAT_STATUS.preview,
    actorUpdateCount: 1,
    itemUpdateCount: 1,
    embeddedItemUpdateCount: 1,
    warnings: []
  }, "preview planned update summary");
  assert.equal(preview.targets[0].target.actorUuid, "Actor.target", "preview target actor");
  assert.equal(preview.targets[0].attack.hit, true, "preview hit flag");
  assert.equal(preview.targets[0].hits[0].location, "torso", "preview hit location");
  assert.equal(preview.chatData.status, COMBAT_CHAT_STATUS.preview, "preview chat evidence");
}

async function assertConfirmAppliesUpdatesInOrder() {
  const outcome = buildOutcome();
  const plan = planCombatUpdates(outcome);
  const adapter = createFakeAdapter();
  const result = await applyCombatUpdates(plan, adapter);

  assert.deepEqual(adapter.calls, [
    {
      type: "item.update",
      uuid: "Actor.attacker.Item.heavy-pistol",
      update: {
        "system.shotsLeft": 9
      }
    },
    {
      type: "actor.updateEmbeddedDocuments",
      uuid: "Actor.target",
      documentType: "Item",
      updates: [
        {
          _id: "armor-jacket",
          "system.coverage.torso.ablation": 1
        }
      ]
    },
    {
      type: "actor.update",
      uuid: "Actor.target",
      update: {
        "system.damage": 5
      }
    }
  ], "commit order");
  assert.deepEqual(result, {
    status: COMBAT_CHAT_STATUS.committed,
    chatData: buildExpectedChatStatus(COMBAT_CHAT_STATUS.committed),
    applied: {
      itemUpdates: 1,
      embeddedItemUpdates: 1,
      actorUpdates: 1
    },
    skipped: {
      itemUpdates: 0,
      embeddedItemUpdates: 0,
      actorUpdates: 0
    },
    warnings: []
  }, "commit result");
}

async function assertConfirmPersistsMultipleLayerAblation() {
  const outcome = buildLayeredArmorOutcome();
  const plan = planCombatUpdates(outcome);
  const adapter = createFakeAdapter({
    initialActors: {
      "Actor.target": {
        system: { damage: 0 },
        items: buildLayeredArmorItemState()
      }
    }
  });
  const result = await applyCombatUpdates(plan, adapter);

  assert.equal(result.status, COMBAT_CHAT_STATUS.committed, "layered armor confirm commits");
  assert.equal(result.applied.embeddedItemUpdates, 2, "both layered armor updates are applied");
  assert.equal(adapter.state.actors["Actor.target"].items["armor-inner"].system.coverage.torso.ablation, 1, "inner layer ablation persists");
  assert.equal(adapter.state.actors["Actor.target"].items["armor-outer"].system.coverage.torso.ablation, 1, "outer layer ablation persists");
}

async function assertCancelDoesNotApplyUpdates() {
  const outcome = buildOutcome();
  const adapter = createFakeAdapter();
  const result = await previewAndApplyCombatOutcome(outcome, {
    adapter,
    decision: "cancel"
  });

  const mutations = adapter.calls.filter(c => c.type !== "renderTemplate" && !c.type.startsWith("chatMessage"));
  assert.deepEqual(mutations, [], "cancel should not mutate documents");
  assert.equal(result.status, COMBAT_CHAT_STATUS.canceled, "cancel status");
  assert.equal(result.chatData.status, COMBAT_CHAT_STATUS.canceled, "cancel chat status");
  assert.equal(result.preview.canCommit, true, "cancel still exposes valid preview");
}

async function assertCancelDoesNotApplyMultipleLayerAblation() {
  const outcome = buildLayeredArmorOutcome();
  const adapter = createFakeAdapter({
    initialActors: {
      "Actor.target": {
        system: { damage: 0 },
        items: buildLayeredArmorItemState()
      }
    }
  });
  const result = await previewAndApplyCombatOutcome(outcome, {
    adapter,
    decision: "cancel"
  });

  assert.equal(result.status, COMBAT_CHAT_STATUS.canceled, "layered armor cancel status");
  assert.equal(adapter.state.actors["Actor.target"].items["armor-inner"].system.coverage.torso.ablation, 0, "cancel leaves inner layer unchanged");
  assert.equal(adapter.state.actors["Actor.target"].items["armor-outer"].system.coverage.torso.ablation, 0, "cancel leaves outer layer unchanged");
}

async function assertManualResolutionBlocksCommit() {
  const outcome = buildOutcome({
    manualResolution: {
      required: true,
      reason: "missing-rule-data",
      blockedUpdateCategories: ["target-damage"]
    }
  });
  const adapter = createFakeAdapter();
  const result = await previewAndApplyCombatOutcome(outcome, {
    adapter,
    decision: "confirm"
  });

  const mutations = adapter.calls.filter(c => c.type !== "renderTemplate" && !c.type.startsWith("chatMessage"));
  assert.deepEqual(mutations, [], "manual resolution should not mutate documents");
  assert.equal(result.status, COMBAT_CHAT_STATUS.manual, "manual block status");
  assert.equal(result.chatData.status, COMBAT_CHAT_STATUS.manual, "manual chat status");
  assert.equal(result.preview.canCommit, false, "manual preview cannot commit");
  assert.equal(result.warnings[0].code, "manual-resolution-required", "manual warning");
}

async function assertInvalidPlanBlocksCommit() {
  const outcome = buildOutcome({
    plannedUpdates: {
      itemUpdates: [
        {
          itemUuid: "",
          update: {
            "system.shotsLeft": 9
          }
        }
      ]
    }
  });
  const plan = planCombatUpdates(outcome);
  const adapter = createFakeAdapter();
  const result = await applyCombatUpdates(plan, adapter);

  assert.deepEqual(adapter.calls, [], "invalid plan should not mutate documents");
  assert.equal(result.status, COMBAT_CHAT_STATUS.manual, "invalid plan status");
  assert.equal(result.warnings[0].code, "unsafe-plan-warning", "invalid plan warning");
}

async function assertUnresolvedDocumentBlocksCommit() {
  const outcome = buildOutcome();
  const plan = planCombatUpdates(outcome);
  const adapter = createFakeAdapter({
    missingItems: ["Actor.attacker.Item.heavy-pistol"]
  });
  const result = await applyCombatUpdates(plan, adapter);

  assert.deepEqual(adapter.calls, [], "missing document should not mutate documents");
  assert.equal(result.status, COMBAT_CHAT_STATUS.manual, "missing document status");
  assert.equal(result.warnings[0].code, "missing-item-document", "missing document warning");
}

async function assertResolverRejectionBlocksCommit() {
  const outcome = buildOutcome();
  const plan = planCombatUpdates(outcome);
  const adapter = createFakeAdapter({
    rejectItems: ["Actor.attacker.Item.heavy-pistol"]
  });
  const result = await applyCombatUpdates(plan, adapter);

  assert.deepEqual(adapter.calls, [], "resolver rejection should not mutate documents");
  assert.equal(result.status, COMBAT_CHAT_STATUS.manual, "resolver rejection status");
  assert.equal(result.warnings[0].code, "resolve-item-document-failed", "resolver rejection warning");
}

async function assertEmbeddedUpdateWithoutIdBlocksCommit() {
  const outcome = buildOutcome({
    targets: [
      {
        plannedUpdates: {
          embeddedItemUpdates: [
            {
              actorUuid: "Actor.target",
              type: "Item",
              updates: [
                {
                  "system.coverage.torso.ablation": 1
                }
              ]
            }
          ]
        }
      }
    ]
  });
  const plan = planCombatUpdates(outcome);
  const adapter = createFakeAdapter();
  const result = await applyCombatUpdates(plan, adapter);

  assert.deepEqual(adapter.calls, [], "embedded update without id should not mutate documents");
  assert.equal(result.status, COMBAT_CHAT_STATUS.manual, "embedded update without id status");
  assert.equal(result.warnings[0].code, "invalid-embedded-item-update", "embedded update without id warning");
}

async function assertWriteRejectionReturnsPartialFailure() {
  const outcome = buildOutcome();
  const plan = planCombatUpdates(outcome);
  const adapter = createFakeAdapter({
    rejectEmbeddedActors: ["Actor.target"]
  });
  const result = await applyCombatUpdates(plan, adapter);

  assert.deepEqual(adapter.calls, [
    {
      type: "item.update",
      uuid: "Actor.attacker.Item.heavy-pistol",
      update: {
        "system.shotsLeft": 9
      }
    }
  ], "write rejection should stop after first failed phase");
  assert.equal(result.status, COMBAT_CHAT_STATUS.manual, "write rejection status");
  assert.deepEqual(result.applied, {
    itemUpdates: 1,
    embeddedItemUpdates: 0,
    actorUpdates: 0
  }, "write rejection applied counts");
  assert.deepEqual(result.skipped, {
    itemUpdates: 0,
    embeddedItemUpdates: 1,
    actorUpdates: 1
  }, "write rejection skipped counts");
  assert.equal(result.warnings[0].code, "combat-update-failed", "write rejection warning");
}

function buildOutcome(overrides = {}) {
  return mergePlainData({
    action: {
      type: "ranged",
      fireMode: "SemiAuto",
      range: "RangeClose"
    },
    attacker: {
      actorUuid: "Actor.attacker",
      name: "Solo"
    },
    weapon: {
      itemUuid: "Actor.attacker.Item.heavy-pistol",
      name: "Heavy Pistol"
    },
    ammo: {
      before: 10,
      delta: -1,
      after: 9,
      source: "weapon.snapshot.shotsLeft"
    },
    targets: [
      {
        target: {
          actorUuid: "Actor.target",
          tokenUuid: "Scene.test.Token.target",
          name: "Guard",
          snapshot: {
            stats: {
              bt: {
                total: 6
              }
            },
            damage: 0
          }
        },
        attack: {
          roll: {
            total: 18
          },
          targetNumber: 15,
          hit: true,
          margin: 3,
          warnings: []
        },
        hits: [
          {
            location: "torso",
            warnings: []
          }
        ],
        plannedUpdates: {
          actorUpdates: [
            {
              actorUuid: "Actor.target",
              update: {
                "system.damage": 5
              }
            }
          ],
          embeddedItemUpdates: [
            {
              actorUuid: "Actor.target",
              type: "Item",
              updates: [
                {
                  _id: "armor-jacket",
                  "system.coverage.torso.ablation": 1
                }
              ]
            }
          ]
        },
        warnings: []
      }
    ],
    plannedUpdates: {
      itemUpdates: [
        {
          itemUuid: "Actor.attacker.Item.heavy-pistol",
          update: {
            "system.shotsLeft": 9
          }
        }
      ],
      chatStatus: COMBAT_CHAT_STATUS.preview
    },
    manualResolution: {
      required: false
    },
    chat: {
      status: COMBAT_CHAT_STATUS.preview
    },
    warnings: []
  }, overrides);
}

function buildLayeredArmorOutcome() {
  return buildOutcome({
    plannedUpdates: {
      itemUpdates: [],
      chatStatus: COMBAT_CHAT_STATUS.preview
    },
    targets: [
      {
        target: {
          actorUuid: "Actor.target",
          tokenUuid: "Scene.test.Token.target",
          name: "Guard",
          snapshot: {
            stats: {
              bt: {
                total: 6
              }
            },
            damage: 0
          }
        },
        attack: {
          roll: {
            total: 18
          },
          targetNumber: 15,
          hit: true,
          margin: 3,
          warnings: []
        },
        hits: [
          {
            location: "torso",
            warnings: []
          }
        ],
        plannedUpdates: {
          embeddedItemUpdates: [
            {
              actorUuid: "Actor.target",
              type: "Item",
              updates: [
                {
                  _id: "armor-inner",
                  "system.coverage.torso.ablation": 1
                },
                {
                  _id: "armor-outer",
                  "system.coverage.torso.ablation": 1
                }
              ]
            }
          ]
        },
        warnings: []
      }
    ]
  });
}

function buildLayeredArmorItemState() {
  return {
    "armor-inner": { _id: "armor-inner", system: { coverage: { torso: { ablation: 0 } } } },
    "armor-outer": { _id: "armor-outer", system: { coverage: { torso: { ablation: 0 } } } }
  };
}

function createFakeAdapter(options = {}) {
  const calls = [];
  let nextMessageId = 1;
  const state = {
    items: clonePlainData(options.initialItems || {}),
    actors: clonePlainData(options.initialActors || {})
  };

  const ensureItemState = (itemUuid) => {
    if(!state.items[itemUuid]) {
      state.items[itemUuid] = { system: { shotsLeft: 10 } };
    }
    return state.items[itemUuid];
  };
  const ensureActorState = (actorUuid) => {
    if(!state.actors[actorUuid]) {
      state.actors[actorUuid] = {
        system: { damage: 0 },
        items: {
          "armor-jacket": {
            _id: "armor-jacket",
            system: { coverage: { torso: { ablation: 0 } } }
          }
        }
      };
    }
    if(!state.actors[actorUuid].items) {
      state.actors[actorUuid].items = {};
    }
    return state.actors[actorUuid];
  };

  return {
    calls,
    state,
    async resolveItem(itemUuid) {
      if((options.rejectItems || []).includes(itemUuid)) {
        throw new Error(`Cannot resolve ${itemUuid}`);
      }
      if((options.missingItems || []).includes(itemUuid)) {
        return undefined;
      }
      const itemState = ensureItemState(itemUuid);
      return {
        isOwner: !(options.unownedItems || []).includes(itemUuid),
        system: itemState.system || (itemState.system = {}),
        async update(update) {
          applyUpdateData(itemState, update);
          calls.push({
            type: "item.update",
            uuid: itemUuid,
            update
          });
        }
      };
    },
    async resolveActor(actorUuid) {
      if((options.rejectActors || []).includes(actorUuid)) {
        throw new Error(`Cannot resolve ${actorUuid}`);
      }
      if((options.missingActors || []).includes(actorUuid)) {
        return undefined;
      }
      const actorState = ensureActorState(actorUuid);
      return {
        isOwner: !(options.unownedActors || []).includes(actorUuid),
        system: actorState.system || (actorState.system = {}),
        items: {
          get(itemId) {
            return actorState.items[itemId] ? { ...actorState.items[itemId], system: actorState.items[itemId].system || {} } : undefined;
          }
        },
        async updateEmbeddedDocuments(documentType, updates) {
          if((options.rejectEmbeddedActors || []).includes(actorUuid)) {
            throw new Error(`Cannot update embedded documents for ${actorUuid}`);
          }
          for(const update of updates || []) {
            const itemId = update?._id;
            if(!itemId) {
              continue;
            }
            if(!actorState.items[itemId]) {
              actorState.items[itemId] = { _id: itemId, system: {} };
            }
            applyUpdateData(actorState.items[itemId], update);
          }
          calls.push({
            type: "actor.updateEmbeddedDocuments",
            uuid: actorUuid,
            documentType,
            updates
          });
        },
        async update(update) {
          if((options.rejectActorUpdates || []).includes(actorUuid)) {
            throw new Error(`Cannot update actor ${actorUuid}`);
          }
          applyUpdateData(actorState, update);
          calls.push({
            type: "actor.update",
            uuid: actorUuid,
            update
          });
        }
      };
    },
    async renderTemplate(templatePath, data) {
      calls.push({
        type: "renderTemplate",
        templatePath,
        data
      });
      return `<mock-rendered-template-for-${data.status}>`;
    },
    async createChatMessage(chatData) {
      const messageId = `msg-${nextMessageId++}`;
      calls.push({
        type: "chatMessage.create",
        messageId,
        chatData
      });
      return messageId;
    },
    async updateChatMessage(messageId, updateData) {
      calls.push({
        type: "chatMessage.update",
        messageId,
        updateData
      });
    }
  };
}

async function assertDuplicateConfirmIsBlocked() {
  const outcome = buildOutcome();
  const adapter = createFakeAdapter({
    initialItems: {
      "Actor.attacker.Item.heavy-pistol": { system: { shotsLeft: 10 } }
    },
    initialActors: {
      "Actor.target": {
        system: { damage: 0 },
        items: {
          "armor-jacket": { _id: "armor-jacket", system: { coverage: { torso: { ablation: 0 } } } }
        }
      }
    }
  });
  const previewResult = await previewAndApplyCombatOutcome(outcome, { adapter });
  const firstConfirm = await previewAndApplyCombatOutcome(outcome, {
    adapter,
    decision: "confirm",
    messageId: previewResult.messageId,
    plannedUpdates: previewResult.preview.plan
  });
  const secondConfirm = await previewAndApplyCombatOutcome(outcome, {
    adapter,
    decision: "confirm",
    messageId: previewResult.messageId,
    plannedUpdates: previewResult.preview.plan
  });

  assert.equal(firstConfirm.status, COMBAT_CHAT_STATUS.committed, "first confirm should commit");
  assert.equal(secondConfirm.status, COMBAT_CHAT_STATUS.manual, "duplicate confirm should be blocked");
  assert.equal(secondConfirm.warnings[0].code, "duplicate-confirm-blocked", "duplicate confirm warning code");
  const mutations = adapter.calls.filter(call => call.type === "item.update" || call.type === "actor.update" || call.type === "actor.updateEmbeddedDocuments");
  assert.equal(mutations.length, 3, "duplicate confirm must not add extra mutations");
  const chatUpdates = adapter.calls.filter(call => call.type === "chatMessage.update");
  assert.equal(chatUpdates.length, 2, "duplicate confirm should still update chat message to manual status");
}

async function assertStalePreviewIsBlocked() {
  const outcome = buildOutcome();
  const adapter = createFakeAdapter({
    initialItems: {
      "Actor.attacker.Item.heavy-pistol": { system: { shotsLeft: 10 } }
    },
    initialActors: {
      "Actor.target": {
        system: { damage: 0 },
        items: {
          "armor-jacket": { _id: "armor-jacket", system: { coverage: { torso: { ablation: 0 } } } }
        }
      }
    }
  });
  const previewResult = await previewAndApplyCombatOutcome(outcome, { adapter });
  adapter.state.items["Actor.attacker.Item.heavy-pistol"].system.shotsLeft = 8;

  const result = await previewAndApplyCombatOutcome(outcome, {
    adapter,
    decision: "confirm",
    messageId: previewResult.messageId,
    plannedUpdates: previewResult.preview.plan
  });

  assert.equal(result.status, COMBAT_CHAT_STATUS.manual, "stale preview should be blocked");
  assert.equal(result.warnings[0].code, "stale-preview-blocked", "stale preview warning code");
  const mutations = adapter.calls.filter(call => call.type === "item.update" || call.type === "actor.update" || call.type === "actor.updateEmbeddedDocuments");
  assert.deepEqual(mutations, [], "stale confirm must not mutate documents");
}

async function assertStaleLayeredArmorPreviewIsBlocked() {
  const outcome = buildLayeredArmorOutcome();
  const adapter = createFakeAdapter({
    initialActors: {
      "Actor.target": {
        system: { damage: 0 },
        items: buildLayeredArmorItemState()
      }
    }
  });
  const previewResult = await previewAndApplyCombatOutcome(outcome, { adapter });
  adapter.state.actors["Actor.target"].items["armor-inner"].system.coverage.torso.ablation = 1;

  const result = await previewAndApplyCombatOutcome(outcome, {
    adapter,
    decision: "confirm",
    messageId: previewResult.messageId,
    plannedUpdates: previewResult.preview.plan
  });

  assert.equal(result.status, COMBAT_CHAT_STATUS.manual, "stale layered armor preview should be blocked");
  assert.equal(result.warnings[0].code, "stale-preview-blocked", "stale layered armor warning code");
  assert.equal(adapter.state.actors["Actor.target"].items["armor-outer"].system.coverage.torso.ablation, 0, "stale preview blocks remaining layer mutation");
}

async function assertChatOutcomeLifecycle() {
  const outcome = buildOutcome();
  const adapter = createFakeAdapter();

  // 1. Initial preview
  const previewResult = await previewAndApplyCombatOutcome(outcome, {
    adapter
  });

  assert.equal(previewResult.status, COMBAT_CHAT_STATUS.preview, "status should be preview");
  assert.ok(previewResult.messageId, "should return a messageId");

  const previewCalls = adapter.calls.filter(c => c.type.startsWith("chatMessage") || c.type === "renderTemplate");
  assert.deepEqual(previewCalls, [
    {
      type: "renderTemplate",
      templatePath: "systems/cyberpunk2020-rilerena/templates/chat/combat-outcome.hbs",
      data: previewResult.chatData
    },
    {
      type: "chatMessage.create",
      messageId: "msg-1",
      chatData: {
        content: "<mock-rendered-template-for-preview>",
        flags: expectedOutcomeFlags(previewResult.chatData)
      }
    }
  ], "preview chat calls");

  // 2. Confirm the preview
  adapter.calls.length = 0;
  const confirmResult = await previewAndApplyCombatOutcome(outcome, {
    adapter,
    decision: "confirm",
    messageId: previewResult.messageId
  });

  assert.equal(confirmResult.status, COMBAT_CHAT_STATUS.committed, "status should be committed");
  assert.equal(confirmResult.messageId, previewResult.messageId, "should reuse messageId");

  const confirmCalls = adapter.calls.filter(c => c.type.startsWith("chatMessage") || c.type === "renderTemplate");
  assert.deepEqual(confirmCalls, [
    {
      type: "renderTemplate",
      templatePath: "systems/cyberpunk2020-rilerena/templates/chat/combat-outcome.hbs",
      data: confirmResult.chatData
    },
    {
      type: "chatMessage.update",
      messageId: "msg-1",
      updateData: {
        content: "<mock-rendered-template-for-committed>",
        flags: expectedOutcomeFlags(confirmResult.chatData)
      }
    }
  ], "confirm chat calls");

  // 3. Cancel a preview
  adapter.calls.length = 0;
  const cancelResult = await previewAndApplyCombatOutcome(outcome, {
    adapter,
    decision: "cancel",
    messageId: previewResult.messageId
  });

  assert.equal(cancelResult.status, COMBAT_CHAT_STATUS.canceled, "status should be canceled");

  const cancelCalls = adapter.calls.filter(c => c.type.startsWith("chatMessage") || c.type === "renderTemplate");
  assert.deepEqual(cancelCalls, [
    {
      type: "renderTemplate",
      templatePath: "systems/cyberpunk2020-rilerena/templates/chat/combat-outcome.hbs",
      data: cancelResult.chatData
    },
    {
      type: "chatMessage.update",
      messageId: "msg-1",
      updateData: {
        content: "<mock-rendered-template-for-canceled>",
        flags: expectedOutcomeFlags(cancelResult.chatData)
      }
    }
  ], "cancel chat calls");
}

function expectedOutcomeFlags(chatData) {
  return {
    cyberpunk2020: {
      combatOutcome: chatData
    }
  };
}

function buildExpectedChatStatus(status) {
  return {
    status,
    isPreview: status === COMBAT_CHAT_STATUS.preview,
    isManual: status === COMBAT_CHAT_STATUS.manual,
    isCommitted: status === COMBAT_CHAT_STATUS.committed,
    isCanceled: status === COMBAT_CHAT_STATUS.canceled
  };
}

function mergePlainData(base, patch) {
  if(Array.isArray(base) || Array.isArray(patch) || !isPlainObject(base) || !isPlainObject(patch)) {
    return patch === undefined ? clonePlainData(base) : clonePlainData(patch);
  }

  const merged = clonePlainData(base);
  for(const [key, value] of Object.entries(patch)) {
    merged[key] = key in merged ? mergePlainData(merged[key], value) : clonePlainData(value);
  }
  return merged;
}

function clonePlainData(data) {
  return JSON.parse(JSON.stringify(data));
}

function isPlainObject(value) {
  return !!value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype;
}

function applyUpdateData(target, update) {
  for(const [path, value] of Object.entries(update || {})) {
    if(path === "_id") {
      continue;
    }
    setByPath(target, path, value);
  }
}

function setByPath(target, path, value) {
  const parts = String(path).split(".");
  let current = target;
  for(let index = 0; index < parts.length - 1; index += 1) {
    const part = parts[index];
    if(!current[part] || typeof current[part] !== "object") {
      current[part] = {};
    }
    current = current[part];
  }
  current[parts[parts.length - 1]] = clonePlainData(value);
}
