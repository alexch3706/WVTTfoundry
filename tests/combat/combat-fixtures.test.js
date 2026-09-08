import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";

import { resolveCombatAction } from "../../module/combat/combat-resolver.js";
import { resolveBodyTypeDamage } from "../../module/combat/attack-resolver.js";
import { buildCombatChatData } from "../../module/combat/combat-chat.js";
import { buildWeaponCombatSnapshot } from "../../module/combat/combat-snapshot.js";
import { isActorDeadForDeathSaves, isActorStabilizedForDeathSaves, requiresRecurringDeathSave, resolveSavePromptsForTarget } from "../../module/combat/save-resolver.js";
import { planCombatUpdates } from "../../module/combat/state-planner.js";
import { normalizeSelectedTargets, normalizeTacticalTargets } from "../../module/combat/target-normalizer.js";
import { getEquippedArmorForLocation, resolveArmor } from "../../module/combat/armor-resolver.js";
import { detectAndPromptTacticalRaycasts } from "../../module/combat/tactical-raycast.js";
import { getAttackDieEntryMode, isCorebookFidelityEnabled, filterSupportedFireModes } from "../../module/combat/settings-helpers.js";
import { buildShotgunTemplateTargetingOptions, buildAoETemplateTargetingOptions } from "../../module/combat/template-placement.js";
import { CyberpunkItem } from "../../module/item/item.js";

export async function runCombatFixtures() {
  const results = [];

  assertTargetNormalization();
  assertShotgunTargetSelectionPreservesGetters();
  await assertTacticalTargetNormalization();
  assertWeaponCombatSnapshot();
  assertBodyTypeDamageResolver();
  assertWoundPlanning();
  assertSavePromptResolution();
  assertDeathSaveStateHelpers();
  assertArmorResolver();
  await assertZonedCyberwareArmorHitPlanning();
  await assertCombatResolverRouting();
  await assertAutoshotgunFullAutoOverlapResolution();
  await assertAutoshotgunMissedShellPreservesEvidence();
  await assertAutoshotgunCloseRangeDamageIsRolled();
  await assertAutoshotgunPointBlankDamageBand();
  await assertAutoshotgunPointBlankFallsBackToCloseDamage();
  await assertAutoshotgunPatternAdjacencyWarning();
  await assertAutoshotgunExtremeRangeRequiresManualResolution();
  await assertAutoshotgunShellCountBoundedByRofAndAmmo();
  await assertAutoshotgunMissingPatternRequiresManualResolution();
  assertCyberpunkItemAdapterPreservesAutoshotgunPatterns();
  assertSettingsHelpers();

  const fixtureDirectory = new URL("./fixtures/", import.meta.url);
  const fixtureUrls = (await readdir(fixtureDirectory))
    .filter(filename => filename.endsWith(".json"))
    .sort()
    .map(filename => new URL(filename, fixtureDirectory));

  for(const fixtureUrl of fixtureUrls) {
    const fixture = JSON.parse(await readFile(fixtureUrl, "utf8"));
    results.push(await runFixture(fixture));
  }

  return results;
}

async function runFixture(fixture) {
  if(fixture.casesOnly === true) {
    await assertSingleShotCases(fixture);
    return { name: fixture.name };
  }
  const roller = createScriptedRoller(fixture.rolls);
  const context = clonePlainData(fixture.context);
  const isSuppressiveFire = (String(context?.action?.fireMode || "").toLowerCase() === "suppressivefire");
  const useStructured = isSuppressiveFire || fixture.useStructured;

  context.legacy = {
    mode: "fixture",
    fallback: ({ context: resolverContext, roller }) => {
      if(useStructured) {
        // These fixture types are resolved through the structured resolver, not legacy.
        // This fallback is bypassed when options.structured=true is passed.
        return { manualResolution: { required: true }, targets: [] };
      }
      return buildSingleShotOutcome(resolverContext, roller, fixture);
    }
  };

  console.log("Running fixture:", fixture.name);
  const options = useStructured ? { structured: true } : {};
  const outcome = await resolveCombatAction(context, options, roller);
  roller.assertComplete();

  if(useStructured) {
    // Structured-resolved fixtures may use different outcome structures (e.g., saves or jam).
    // Skip standard assertOutcomeShape which expects attack roll fields.
    assert.equal(outcome.action.type, fixture.context.action.type, `${fixture.name} action type`);
    assert.equal(outcome.action.fireMode, fixture.context.action.fireMode, `${fixture.name} fire mode`);
    assert.ok(outcome.attacker.actorUuid, `${fixture.name} attacker actor UUID`);
    assert.ok(outcome.weapon.itemUuid, `${fixture.name} weapon item UUID`);
    assert.equal(outcome.targets.length, fixture.context.targets.length, `${fixture.name} target count`);
    if(fixture.expected?.outcome?.chatStatus) {
      assert.equal(outcome.chat.status, fixture.expected.outcome.chatStatus, `${fixture.name} chat status`);
    }
  } else {
    assertOutcomeShape(outcome, fixture.expected.outcome);
  }

  const plannedUpdates = planCombatUpdates(outcome);

  if(useStructured) {
    // Structured-resolved fixtures produce complex nested outcomes.
    // Use partial matching (assertObjectIncludes) instead of exact deep equality.
    assertObjectIncludes(plannedUpdates, fixture.expected?.plannedUpdates || {}, `${fixture.name} planned updates`);

    const previewChatData = buildCombatChatData(outcome, plannedUpdates);
    assertObjectIncludes(previewChatData, fixture.expected?.chatData?.preview || {}, `${fixture.name} preview chat data`);
  } else {
    assert.deepEqual(plannedUpdates, fixture.expected?.plannedUpdates || {}, `${fixture.name} planned updates`);

    const previewChatData = buildCombatChatData(outcome, plannedUpdates);
    assert.deepEqual(previewChatData, fixture.expected?.chatData?.preview || {}, `${fixture.name} preview chat data`);
  }

  await assertSingleShotCases(fixture);

  for(const statusCase of fixture.chatStatusCases || []) {
    const caseOutcome = reviveFixtureSentinels(mergePlainData(outcome, statusCase.outcome || {}));
    const casePlan = reviveFixtureSentinels(mergePlainData(plannedUpdates, statusCase.plannedUpdates || {}));
    const caseOptions = reviveFixtureSentinels(clonePlainData(statusCase.options || {}));
    const chatData = buildCombatChatData(caseOutcome, casePlan, caseOptions);
    assertObjectIncludes(chatData, statusCase.expected, `${fixture.name} ${statusCase.name} chat data`);
  }

  for(const invalidCase of fixture.invalidPlanCases || []) {
    const invalidOutcome = reviveFixtureSentinels(clonePlainData(invalidCase.outcome));
    const warningPlan = planCombatUpdates(invalidOutcome);
    assert.deepEqual(warningPlan, invalidCase.expectedPlan, `${fixture.name} ${invalidCase.name}`);
  }

  return {
    name: fixture.name,
    outcome,
    plannedUpdates
  };
}

function createScriptedRoller(rolls = []) {
  let nextRollIndex = 0;

  function roller(request = {}) {
    const scriptedRoll = rolls[nextRollIndex];
    if(!scriptedRoll) {
      throw new Error(`No scripted roll available for ${request.id || "unidentified roll"}.`);
    }
    console.log(`Roller requested: ${request.id}. Next scripted roll is: ${scriptedRoll.id}`);
    if(request.id && scriptedRoll.id !== request.id) {
      throw new Error(`Expected scripted roll ${scriptedRoll.id}, received ${request.id}.`);
    }
    if(scriptedRoll.expectedRequest) {
      assertObjectIncludes(request, scriptedRoll.expectedRequest, `${request.id || "roll"} request`);
    }

    nextRollIndex += 1;
    const rollMetadata = {
      id: scriptedRoll.id,
      formula: scriptedRoll.formula || request.formula,
      total: scriptedRoll.total,
      die: clonePlainData(scriptedRoll.die),
      seed: request.seed
    };
    if(scriptedRoll.location) {
      rollMetadata.location = scriptedRoll.location;
    }
    return rollMetadata;
  }

  roller.assertComplete = () => {
    assert.equal(nextRollIndex, rolls.length, "all scripted rolls should be consumed");
  };

  return roller;
}

function buildSingleShotOutcome(context, roller, fixture) {
  const attackRoll = roller({ id: "attack", seed: fixture.name });
  const locationRoll = roller({ id: "location", seed: fixture.name });
  const damageRoll = roller({ id: "damage", seed: fixture.name });
  const target = context.targets[0];
  const hitEvidence = fixture.outcomeEvidence?.hit;
  const hit = attackRoll.total >= context.action.targetNumber;

  return {
    action: context.action,
    attacker: context.attacker,
    weapon: context.weapon,
    targets: [
      {
        target,
        attack: {
          roll: attackRoll,
          targetNumber: context.action.targetNumber,
          hit,
          margin: attackRoll.total - context.action.targetNumber,
          warnings: []
        },
        hits: hit ? [
          {
            location: hitEvidence.location,
            locationRoll,
            damageRoll,
            rawDamage: hitEvidence.rawDamage,
            effectiveStoppingPower: hitEvidence.effectiveStoppingPower,
            armorPiercing: hitEvidence.armorPiercing,
            armorMitigation: hitEvidence.armorMitigation,
            penetratingDamage: hitEvidence.penetratingDamage,
            bodyTypeModifier: hitEvidence.bodyTypeModifier,
            bodyTypeMitigation: hitEvidence.bodyTypeMitigation,
            minimumDamageApplied: hitEvidence.minimumDamageApplied,
            finalDamage: hitEvidence.finalDamage,
            warnings: []
          }
        ] : [],
        plannedUpdates: clonePlainData(fixture.outcomeEvidence.plannedUpdates),
        warnings: []
      }
    ],
    ammo: clonePlainData(fixture.outcomeEvidence.ammo),
    plannedUpdates: {
      itemUpdates: clonePlainData(fixture.outcomeEvidence.itemUpdates),
      chatStatus: "preview"
    },
    manualResolution: {
      required: false
    },
    chat: {
      status: "preview"
    },
    warnings: []
  };
}

async function assertSingleShotCases(fixture) {
  for(const singleShotCase of fixture.singleShotCases || []) {
    // Strict ruleReference validation — every fixture case must document which rule it verifies
    if (!singleShotCase.ruleReference || typeof singleShotCase.ruleReference !== "string") {
      throw new Error(`${fixture.name}: case "${singleShotCase.name}" is missing required "ruleReference" string`);
    }
    const roller = createScriptedRoller(singleShotCase.rolls);
    const context = reviveFixtureSentinels(mergePlainData(fixture.context, singleShotCase.context || {}));
    if(singleShotCase.legacyExpected) {
      context.legacy = {
        mode: "fixture",
        fallback: () => clonePlainData(singleShotCase.legacyExpected)
      };
    }
    const outcome = await resolveCombatAction(context, { structured: true }, roller);
    roller.assertComplete();
    const plan = planCombatUpdates(outcome);
    assertObjectIncludes(outcome, singleShotCase.expected, `${fixture.name} ${singleShotCase.name} outcome`);
    if(singleShotCase.expectedPlan) {
      assertObjectIncludes(plan, singleShotCase.expectedPlan, `${fixture.name} ${singleShotCase.name} planned updates`);
    }
    if(singleShotCase.expectedChat) {
      const chatData = buildCombatChatData(outcome, plan);
      assertObjectIncludes(chatData, singleShotCase.expectedChat, `${fixture.name} ${singleShotCase.name} chat data`);
    }
  }
}

function assertTargetNormalization() {
  const normalized = normalizeSelectedTargets([
    {
      id: "token-actor",
      document: {
        uuid: "Scene.test.Token.actor",
        name: "Armored Target"
      },
      actor: {
        uuid: "Actor.target",
        name: "Target Actor",
        system: {
          stats: {
            body: {
              total: 6
            }
          },
          damage: 2,
      isFBC: false,
          hitLocations: {
            torso: {
              label: "Torso"
            }
          }
        },
        itemTypes: {
          armor: [
            {
              id: "armor-vest",
              name: "Kevlar Vest",
              type: "armor",
              system: {
                equipped: true,
                coverage: {
                  torso: {
                    stoppingPower: 12,
                    ablation: 0
                  }
                }
              }
            },
            {
              id: "stored-vest",
              name: "Stored Vest",
              type: "armor",
              system: {
                equipped: false,
                coverage: {
                  torso: {
                    stoppingPower: 20,
                    ablation: 0
                  }
                }
              }
            }
          ],
          cyberware: [
            {
              id: "subdermal-armor",
              name: "Subdermal Armor",
              type: "cyberware",
              system: {
                equipped: true,
                stoppingPower: 2
              }
            },
            {
              id: "stored-subdermal-armor",
              name: "Stored Subdermal Armor",
              type: "cyberware",
              system: {
                equipped: false,
                stoppingPower: 4
              }
            }
          ]
        }
      }
    },
    {
      id: "token-actorless",
      document: {
        uuid: "Scene.test.Token.actorless",
        name: "Actorless Target"
      }
    },
    {
      id: "plain-target",
      tokenUuid: "Scene.test.Token.plain",
      actorUuid: "Actor.plain",
      name: "Plain Target",
      snapshot: {
        stats: {
          body: {
            total: 5
          }
        },
        damage: 0,
        hitLocations: {
          head: {
            label: "Head"
          }
        }
      }
    }
  ]);

  assert.deepEqual(normalized[0], {
    id: "token-actor",
    tokenUuid: "Scene.test.Token.actor",
    actorUuid: "Actor.target",
    name: "Armored Target",
    snapshot: {
      stats: {
        body: {
          total: 6
        }
      },
      damage: 2,
      isFBC: false,
      hitLocations: {
        torso: {
          label: "Torso"
        }
      },
      equippedArmor: [
        {
          id: "armor-vest",
          name: "Kevlar Vest",
          type: "armor",
          system: {
            equipped: true,
            coverage: {
              torso: {
                stoppingPower: 12,
                ablation: 0
              }
            }
          }
        }
      ],
      equippedCyberware: [
        {
          id: "subdermal-armor",
          name: "Subdermal Armor",
          type: "cyberware",
          system: {
            equipped: true,
            stoppingPower: 2
          }
        }
      ]
    }
  }, "actor-backed target normalization");

  assert.deepEqual(normalized[1], {
    id: "token-actorless",
    tokenUuid: "Scene.test.Token.actorless",
    name: "Actorless Target",
    manualResolution: {
      required: true,
      reason: "missing-target-actor",
      message: "Target Actor is unavailable; resolve target damage, armor, and saves manually.",
      blockedUpdateCategories: ["target-damage", "target-armor", "target-saves"]
    },
    warnings: [
      {
        code: "missing-target-actor",
        severity: "warning",
        message: "Target Actor is unavailable; resolve target damage, armor, and saves manually."
      }
    ]
  }, "actorless target normalization");

  assert.deepEqual(normalized[2], {
    id: "plain-target",
    tokenUuid: "Scene.test.Token.plain",
    actorUuid: "Actor.plain",
    name: "Plain Target",
    snapshot: {
      stats: {
        body: {
          total: 5
        }
      },
      damage: 0,
      hitLocations: {
        head: {
          label: "Head"
        }
      }
    }
  }, "plain target normalization");

  assert.deepEqual(JSON.parse(JSON.stringify(normalized)), normalized, "normalized targets are JSON-safe");
}

function assertWeaponCombatSnapshot() {
  const item = {
    system: {
      damage: "3d6",
      ap: true,
      shotsLeft: 8,
      rof: 2,
      reliability: "Standard",
      range: 50,
      accuracy: 1,
      attackType: "shotgun",
      attackSkill: "Rifle",
      rangeDamages: {
        pointBlank: "4d6",
        close: "4d6",
        medium: "3d6",
        far: "2d6"
      }
    }
  };
  const snapshot = buildWeaponCombatSnapshot(item);
  assert.equal(snapshot.attackType, "shotgun");
  assert.deepEqual(snapshot.rangeDamages, {
    pointBlank: "4d6",
    close: "4d6",
    medium: "3d6",
    far: "2d6"
  });
}

function assertShotgunTargetSelectionPreservesGetters() {
  class DummyDocument { constructor(uuid) { this.uuid = uuid; } }
  class DummyActor { constructor(uuid) { this.uuid = uuid; } }
  class DummyToken {
    constructor(docUuid, actorUuid) {
      this.docUuid = docUuid;
      this.actUuid = actorUuid;
    }
    get document() { return new DummyDocument(this.docUuid); }
    get actor() { return new DummyActor(this.actUuid); }
  }

  const selectedToken = new DummyToken("Scene.test.Token.1", "Actor.1");
  const affectedToken = new DummyToken("Scene.test.Token.2", "Actor.2");

  const targeting = buildShotgunTemplateTargetingOptions({
    selectedTargets: [selectedToken],
    affectedTargets: [affectedToken]
  });

  assert.equal(targeting.targets[0].document?.uuid, "Scene.test.Token.1");
  assert.equal(targeting.targets[0].actor?.uuid, "Actor.1");
  assert.equal(targeting.raycastTargets[1].document?.uuid, "Scene.test.Token.2");
  assert.equal(targeting.raycastTargets[1].actor?.uuid, "Actor.2");
}

async function assertTacticalTargetNormalization() {
  const shotgunTemplateTargeting = buildShotgunTemplateTargetingOptions({
    selectedTargets: [
      {
        id: "token-selected-shotgun",
        selected: true,
        actorUuid: "Actor.selectedShotgun",
        name: "Selected Shotgun Target",
        snapshot: {}
      }
    ],
    affectedTargets: [
      {
        id: "token-shotgun-affected",
        actorUuid: "Actor.shotgunAffected",
        name: "Shotgun Affected Token",
        snapshot: {},
        tactical: {
          template: {
            templateUuid: "Scene.test.MeasuredTemplate.shotgun-adapter",
            templateId: "shotgun-adapter",
            type: "cone",
            origin: { x: 10, y: 20 },
            direction: 0,
            angle: 45,
            distance: 12,
            targetDistance: 3,
            inclusion: "intersected"
          }
        }
      }
    ]
  });

  assert.equal(shotgunTemplateTargeting.raycastTargets.length, 2);
  const shotgunTargets = normalizeTacticalTargets({
    targets: shotgunTemplateTargeting.raycastTargets,
    template: shotgunTemplateTargeting.template
  });

  assert.equal(shotgunTargets.length, 2);
  assert.equal(shotgunTargets[0].id, "token-selected-shotgun");
  assert.equal(shotgunTargets[0].tactical.selected, true);
  assert.equal(shotgunTargets[0].tactical.template, undefined);
  assert.equal(shotgunTargets[1].id, "token-shotgun-affected");
  assert.equal(shotgunTargets[1].tactical.selected, false);
  assert.equal(shotgunTargets[1].tactical.template.templateId, "shotgun-adapter");
  assert.deepEqual(shotgunTargets[1].distance, { value: 3, units: "m", source: "template" });
  assert.equal(shotgunTargets[1].tactical.template.targetDistance, 3);

  const emptyShotgunTemplateTargeting = buildShotgunTemplateTargetingOptions({
    selectedTargets: [],
    affectedTargets: [],
    hazardZone: {
      templateUuid: "Scene.test.MeasuredTemplate.empty-shotgun",
      templateId: "empty-shotgun",
      type: "cone",
      origin: { x: 10, y: 20 },
      direction: 90,
      angle: 45,
      distance: 12,
      inclusion: "intersected",
      lifecycle: "transient"
    }
  });

  assert.deepEqual(emptyShotgunTemplateTargeting.targets, [], "empty shotgun Zone-Only adapter keeps selected targets empty");
  assert.deepEqual(emptyShotgunTemplateTargeting.raycastTargets, [], "empty shotgun Zone-Only adapter keeps raycast targets empty");
  assert.equal(emptyShotgunTemplateTargeting.template, undefined, "empty shotgun Zone-Only adapter does not invent per-target template evidence");
  assert.equal(emptyShotgunTemplateTargeting.hazardZone.kind, "shotgun-cone");
  assert.equal(emptyShotgunTemplateTargeting.hazardZone.templateId, "empty-shotgun");
  assert.equal(emptyShotgunTemplateTargeting.hazardZone.affectedTokenCount, 0);

  const circleTemplateTargeting = buildAoETemplateTargetingOptions({
    selectedTargets: [],
    affectedTargets: [],
    hazardZone: {
      templateUuid: "Scene.test.MeasuredTemplate.circle",
      templateId: "circle-template",
      type: "circle",
      origin: { x: 10, y: 20 },
      distance: 5,
      inclusion: "intersected",
      lifecycle: "transient"
    }
  });

  assert.equal(circleTemplateTargeting.hazardZone.kind, "circle", "circle template adapter sets hazard zone kind to circle");

  const overlappingShotgunTemplateTargeting = buildShotgunTemplateTargetingOptions({
    selectedTargets: [
      {
        id: "token-overlap-shotgun",
        selected: true,
        actorUuid: "Actor.overlapShotgun",
        name: "Overlapping Shotgun Target",
        snapshot: {}
      }
    ],
    affectedTargets: [
      {
        id: "token-overlap-shotgun",
        actorUuid: "Actor.overlapShotgun",
        name: "Overlapping Shotgun Target",
        snapshot: {},
        tactical: {
          template: {
            templateUuid: "Scene.test.MeasuredTemplate.shotgun-overlap",
            templateId: "shotgun-overlap",
            type: "cone",
            origin: { x: 10, y: 20 },
            direction: 0,
            angle: 45,
            distance: 12,
            targetDistance: 4,
            inclusion: "intersected"
          }
        }
      }
    ]
  });

  assert.equal(overlappingShotgunTemplateTargeting.raycastTargets.length, 1);
  const overlappingShotgunTargets = normalizeTacticalTargets({
    targets: overlappingShotgunTemplateTargeting.raycastTargets,
    template: overlappingShotgunTemplateTargeting.template
  });

  assert.equal(overlappingShotgunTargets.length, 1);
  assert.equal(overlappingShotgunTargets[0].id, "token-overlap-shotgun");
  assert.equal(overlappingShotgunTargets[0].tactical.selected, true);
  assert.equal(overlappingShotgunTargets[0].tactical.template.templateId, "shotgun-overlap");
  assert.equal(overlappingShotgunTargets[0].distance, undefined);
  assert.equal(overlappingShotgunTargets[0].tactical.template.targetDistance, 4);

  const targets = normalizeTacticalTargets({
    targets: [
      {
        id: "token-actor",
        selected: true,
        document: { uuid: "Scene.test.Token.actor", name: "Armored Target" },
        actor: { uuid: "Actor.target", name: "Target Actor", system: { stats: { body: { total: 6 } } } }
      }
    ],
    template: {
      templateUuid: "Scene.test.MeasuredTemplate.1",
      templateId: "template-1",
      type: "cone",
      origin: { x: 100, y: 100 },
      direction: 45,
      angle: 30,
      distance: 10,
      inclusion: "intersected",
      affectedTargets: [
        {
          id: "token-actor",
          selected: true,
          document: { uuid: "Scene.test.Token.actor", name: "Armored Target" },
          actor: { uuid: "Actor.target", name: "Target Actor", system: { stats: { body: { total: 6 } } } }
        }
      ]
    },
    raycast: {
      origin: { x: 50, y: 50 },
      destination: { x: 150, y: 150 },
      obstruction: { id: "wall-1", uuid: "Scene.test.Wall.1", type: "wall", name: "Concrete Wall" },
      obstructionDistance: 4,
      firstTarget: true,
      requiresGmDecision: false
    },
    distance: {
      value: 8,
      units: "m",
      source: "measured"
    }
  });

  assert.equal(targets.length, 1);
  assert.equal(targets[0].tokenUuid, "Scene.test.Token.actor");
  assert.deepEqual(targets[0].distance, { value: 8, units: "m", source: "measured" });
  assert.deepEqual(JSON.parse(JSON.stringify(targets)), targets, "tactical targets are JSON-safe");
  assert.deepEqual(targets[0].tactical, {
    selected: true,
    template: {
      templateUuid: "Scene.test.MeasuredTemplate.1",
      templateId: "template-1",
      type: "cone",
      origin: { x: 100, y: 100 },
      direction: 45,
      angle: 30,
      distance: 10,
      targetDistance: 8,
      inclusion: "intersected"
    },
    raycast: {
      origin: { x: 50, y: 50 },
      destination: { x: 150, y: 150 },
      obstruction: { id: "wall-1", uuid: "Scene.test.Wall.1", type: "wall", name: "Concrete Wall" },
      obstructionDistance: 4,
      firstTarget: true,
      requiresGmDecision: false
    }
  });

  const multiTargets = normalizeTacticalTargets({
    targets: [
      { id: "token-near", selected: false, actorUuid: "Actor.near", name: "Near Target", snapshot: {} },
      { id: "token-far", selected: false, actorUuid: "Actor.far", name: "Far Target", snapshot: {} }
    ],
    template: {
      templateId: "template-2",
      type: "cone",
      origin: { x: 10, y: 20 },
      direction: 0,
      angle: 45,
      distance: 12,
      inclusion: "intersected",
      affectedTargets: [
        { id: "token-near", selected: false, actorUuid: "Actor.near", name: "Near Target", snapshot: {} },
        { id: "token-far", selected: false, actorUuid: "Actor.far", name: "Far Target", snapshot: {} }
      ]
    },
    distance: {
      byTarget: {
        "token-near": { value: 3, units: "m", source: "template" },
        "token-far": { value: 9, units: "m", source: "template" }
      }
    }
  });

  assert.equal(multiTargets[0].tactical.selected, false);
  assert.equal(multiTargets[1].tactical.selected, false);
  assert.deepEqual(multiTargets[0].distance, { value: 3, units: "m", source: "template" });
  assert.deepEqual(multiTargets[1].distance, { value: 9, units: "m", source: "template" });
  assert.equal(multiTargets[0].tactical.template.targetDistance, 3);
  assert.equal(multiTargets[1].tactical.template.targetDistance, 9);

  const multiTargetsByAlternateIdentifiers = normalizeTacticalTargets({
    targets: [
      { id: "token-third", tokenUuid: "Scene.test.Token.third", actorUuid: "Actor.third", selected: false, name: "Third Target", snapshot: {} },
      { id: "token-fourth", tokenUuid: "Scene.test.Token.fourth", actorUuid: "Actor.fourth", selected: false, name: "Fourth Target", snapshot: {} }
    ],
    template: {
      templateId: "template-alternate-distance-keys",
      type: "cone",
      origin: { x: 10, y: 20 },
      direction: 0,
      angle: 45,
      distance: 12,
      inclusion: "intersected",
      affectedTargets: [
        { tokenUuid: "Scene.test.Token.fourth", actorUuid: "Actor.fourth", name: "Fourth Target", snapshot: {} },
        { tokenUuid: "Scene.test.Token.third", actorUuid: "Actor.third", name: "Third Target", snapshot: {} }
      ]
    },
    distance: {
      byTarget: {
        "Actor.fourth": { value: 10, units: "m", source: "template" },
        "Scene.test.Token.third": { value: 4, units: "m", source: "template" }
      }
    }
  });

  assert.equal(multiTargetsByAlternateIdentifiers.length, 2);
  assert.equal(multiTargetsByAlternateIdentifiers[0].id, "token-third");
  assert.equal(multiTargetsByAlternateIdentifiers[1].id, "token-fourth");
  assert.deepEqual(multiTargetsByAlternateIdentifiers[0].distance, { value: 4, units: "m", source: "template" });
  assert.deepEqual(multiTargetsByAlternateIdentifiers[1].distance, { value: 10, units: "m", source: "template" });
  assert.equal(multiTargetsByAlternateIdentifiers[0].tactical.template.targetDistance, 4);
  assert.equal(multiTargetsByAlternateIdentifiers[1].tactical.template.targetDistance, 10);

  const selectedTargetOutsideBareTemplate = normalizeTacticalTargets({
    targets: [
      { id: "token-outside-zone", selected: true, actorUuid: "Actor.outsideZone", name: "Outside Zone Target", snapshot: {} }
    ],
    template: {
      templateId: "template-bare",
      type: "cone",
      origin: { x: 10, y: 20 },
      direction: 0,
      angle: 45,
      distance: 12,
      inclusion: "intersected"
    }
  });

  assert.equal(selectedTargetOutsideBareTemplate.length, 1);
  assert.equal(selectedTargetOutsideBareTemplate[0].tactical.selected, true);
  assert.equal(selectedTargetOutsideBareTemplate[0].tactical.template, undefined);

  const selectedTargetMissingRequiredTemplateEvidence = normalizeTacticalTargets({
    targets: [
      { id: "token-required-template-missing", selected: true, actorUuid: "Actor.requiredTemplateMissing", name: "Required Template Missing", snapshot: {} }
    ],
    template: {
      templateId: "template-required-missing-evidence",
      type: "cone",
      origin: { x: 10, y: 20 },
      direction: 0,
      angle: 45,
      distance: 12,
      inclusion: "intersected"
    },
    templateRequired: true
  });

  assert.equal(selectedTargetMissingRequiredTemplateEvidence[0].manualResolution.required, true);
  assert.equal(selectedTargetMissingRequiredTemplateEvidence[0].manualResolution.message, "Template mode requested but tactical data is incomplete.");
  assert.deepEqual(selectedTargetMissingRequiredTemplateEvidence[0].manualResolution.blockedUpdateCategories, ["target-damage", "target-armor", "target-saves"]);
  assert.equal(selectedTargetMissingRequiredTemplateEvidence[0].tactical.template, undefined);
  assert.ok(selectedTargetMissingRequiredTemplateEvidence[0].warnings.some(w => w.code === "missing-tactical-template"));

  const legacyBareTemplateTargets = normalizeTacticalTargets({
    targets: [
      { id: "token-legacy-bare", selected: false, actorUuid: "Actor.legacyBare", name: "Legacy Bare Template Target", snapshot: {} }
    ],
    template: {
      templateId: "template-legacy-bare",
      type: "cone",
      origin: { x: 10, y: 20 },
      direction: 0,
      angle: 45,
      distance: 12,
      inclusion: "intersected"
    },
    legacyBareTemplateAttachToAll: true
  });

  assert.equal(legacyBareTemplateTargets[0].tactical.template.templateId, "template-legacy-bare", "legacy bare-template attach-to-all remains opt-in compatibility");

  const selectedTargetWithSeparateAffectedToken = normalizeTacticalTargets({
    targets: [
      { id: "token-selected", selected: true, actorUuid: "Actor.selected", name: "Selected Target", snapshot: {} }
    ],
    template: {
      templateId: "template-affected",
      type: "cone",
      origin: { x: 10, y: 20 },
      direction: 0,
      angle: 45,
      distance: 12,
      inclusion: "intersected",
      affectedTargets: [
        { id: "token-affected", actorUuid: "Actor.affected", name: "Affected Token", snapshot: {} }
      ]
    }
  });

  assert.equal(selectedTargetWithSeparateAffectedToken.length, 2);
  assert.equal(selectedTargetWithSeparateAffectedToken[0].id, "token-selected");
  assert.equal(selectedTargetWithSeparateAffectedToken[0].tactical.selected, true);
  assert.equal(selectedTargetWithSeparateAffectedToken[0].tactical.template, undefined);
  assert.equal(selectedTargetWithSeparateAffectedToken[1].id, "token-affected");
  assert.equal(selectedTargetWithSeparateAffectedToken[1].tactical.selected, false);
  assert.equal(selectedTargetWithSeparateAffectedToken[1].tactical.template.templateId, "template-affected");

  const templateWithSelectedAndAffectedLists = normalizeTacticalTargets({
    template: {
      templateId: "template-selected-and-affected",
      type: "cone",
      origin: { x: 10, y: 20 },
      direction: 0,
      angle: 45,
      distance: 12,
      inclusion: "intersected",
      targets: [
        { id: "token-template-selected", selected: true, actorUuid: "Actor.templateSelected", name: "Template Selected", snapshot: {} }
      ],
      affectedTargets: [
        { id: "token-template-affected", actorUuid: "Actor.templateAffected", name: "Template Affected", snapshot: {} }
      ]
    }
  });

  assert.equal(templateWithSelectedAndAffectedLists.length, 2);
  assert.equal(templateWithSelectedAndAffectedLists[0].id, "token-template-selected");
  assert.equal(templateWithSelectedAndAffectedLists[0].tactical.selected, true);
  assert.equal(templateWithSelectedAndAffectedLists[1].id, "token-template-affected");
  assert.equal(templateWithSelectedAndAffectedLists[1].tactical.selected, false);
  assert.equal(templateWithSelectedAndAffectedLists[1].tactical.template.templateId, "template-selected-and-affected");

  const affectedTokenWithGmJudgementEvidence = normalizeTacticalTargets({
    template: {
      templateId: "template-gm-judgement",
      type: "cone",
      origin: { x: 10, y: 20 },
      direction: 0,
      angle: 45,
      distance: 12,
      inclusion: "intersected",
      affectedTargets: [
        {
          id: "token-gm-judgement-affected",
          actorUuid: "Actor.gmJudgementAffected",
          name: "GM Judgement Affected",
          snapshot: {},
          tactical: {
            raycast: {
              origin: { x: 0, y: 0 },
              destination: { x: 5, y: 5 },
              obstruction: { id: "wall-gm", uuid: "Scene.test.Wall.gm", type: "wall", name: "GM Wall" },
              obstructionDistance: 2,
              firstTarget: false,
              requiresGmDecision: true
            },
            cover: {
              applies: true,
              stoppingPower: 10,
              source: "raycast-gm"
            }
          }
        }
      ]
    }
  });

  assert.equal(affectedTokenWithGmJudgementEvidence.length, 1);
  assert.equal(affectedTokenWithGmJudgementEvidence[0].id, "token-gm-judgement-affected");
  assert.equal(affectedTokenWithGmJudgementEvidence[0].tactical.selected, false);
  assert.equal(affectedTokenWithGmJudgementEvidence[0].tactical.template.templateId, "template-gm-judgement");
  assert.equal(affectedTokenWithGmJudgementEvidence[0].tactical.raycast.requiresGmDecision, true);
  assert.equal(affectedTokenWithGmJudgementEvidence[0].tactical.cover.stoppingPower, 10);
  assert.equal(affectedTokenWithGmJudgementEvidence[0].manualResolution.required, true);
  assert.deepEqual(affectedTokenWithGmJudgementEvidence[0].manualResolution.blockedUpdateCategories, ["target-damage", "target-armor", "target-saves"]);
  assert.ok(affectedTokenWithGmJudgementEvidence[0].warnings.some(w => w.code === "manual-tactical-raycast"));

  const selectedTargetAlsoCaughtInHazardZone = normalizeTacticalTargets({
    targets: [
      { id: "token-overlap", selected: true, actorUuid: "Actor.overlap", name: "Overlapping Target", snapshot: {} }
    ],
    template: {
      templateId: "template-overlap",
      type: "cone",
      origin: { x: 10, y: 20 },
      direction: 0,
      angle: 45,
      distance: 12,
      inclusion: "intersected",
      affectedTargets: [
        { id: "token-overlap", actorUuid: "Actor.overlap", name: "Overlapping Target", snapshot: {} }
      ]
    }
  });

  assert.equal(selectedTargetAlsoCaughtInHazardZone.length, 1);
  assert.equal(selectedTargetAlsoCaughtInHazardZone[0].id, "token-overlap");
  assert.equal(selectedTargetAlsoCaughtInHazardZone[0].tactical.selected, true);
  assert.equal(selectedTargetAlsoCaughtInHazardZone[0].tactical.template.templateId, "template-overlap");

  const selectedTargetAlsoCaughtWithPerTargetHazardZoneEvidence = normalizeTacticalTargets({
    targets: [
      { id: "token-overlap-evidence", selected: true, actorUuid: "Actor.overlapEvidence", name: "Overlapping Evidence Target", snapshot: {} }
    ],
    template: {
      templateId: "template-overlap-evidence",
      type: "cone",
      origin: { x: 10, y: 20 },
      direction: 0,
      angle: 45,
      distance: 12,
      inclusion: "intersected",
      affectedTargets: [
        {
          id: "token-overlap-evidence",
          actorUuid: "Actor.overlapEvidence",
          name: "Overlapping Evidence Target",
          snapshot: {},
          distance: { value: 4, units: "m", source: "template" }
        }
      ]
    }
  });

  assert.equal(selectedTargetAlsoCaughtWithPerTargetHazardZoneEvidence.length, 1);
  assert.equal(selectedTargetAlsoCaughtWithPerTargetHazardZoneEvidence[0].id, "token-overlap-evidence");
  assert.equal(selectedTargetAlsoCaughtWithPerTargetHazardZoneEvidence[0].tactical.selected, true);
  assert.equal(selectedTargetAlsoCaughtWithPerTargetHazardZoneEvidence[0].tactical.template.templateId, "template-overlap-evidence");
  assert.deepEqual(selectedTargetAlsoCaughtWithPerTargetHazardZoneEvidence[0].distance, { value: 4, units: "m", source: "template" });
  assert.equal(selectedTargetAlsoCaughtWithPerTargetHazardZoneEvidence[0].tactical.template.targetDistance, 4);

  const selectedTargetAlsoCaughtWithSelectedAndHazardZoneDistances = normalizeTacticalTargets({
    targets: [
      {
        id: "token-overlap-distance",
        selected: true,
        actorUuid: "Actor.overlapDistance",
        name: "Overlapping Distance Target",
        snapshot: {},
        distance: { value: 8, units: "m", source: "grid" }
      }
    ],
    template: {
      templateId: "template-overlap-distance",
      type: "cone",
      origin: { x: 10, y: 20 },
      direction: 0,
      angle: 45,
      distance: 12,
      inclusion: "intersected",
      affectedTargets: [
        {
          id: "token-overlap-distance",
          actorUuid: "Actor.overlapDistance",
          name: "Overlapping Distance Target",
          snapshot: {},
          distance: { value: 3, units: "m", source: "template" }
        }
      ]
    }
  });

  assert.equal(selectedTargetAlsoCaughtWithSelectedAndHazardZoneDistances.length, 1);
  assert.equal(selectedTargetAlsoCaughtWithSelectedAndHazardZoneDistances[0].id, "token-overlap-distance");
  assert.equal(selectedTargetAlsoCaughtWithSelectedAndHazardZoneDistances[0].tactical.selected, true);
  assert.deepEqual(selectedTargetAlsoCaughtWithSelectedAndHazardZoneDistances[0].distance, { value: 8, units: "m", source: "grid" });
  assert.equal(selectedTargetAlsoCaughtWithSelectedAndHazardZoneDistances[0].tactical.template.templateId, "template-overlap-distance");
  assert.equal(selectedTargetAlsoCaughtWithSelectedAndHazardZoneDistances[0].tactical.template.targetDistance, 3);

  const selectedTargetMatchedToHazardZoneByAlternateIdentifier = normalizeTacticalTargets({
    targets: [
      {
        id: "token-selected-alternate-id",
        tokenUuid: "Scene.test.Token.alternate",
        actorUuid: "Actor.alternate",
        selected: true,
        name: "Alternate Identifier Target",
        snapshot: {},
        distance: { value: 8, units: "m", source: "grid" }
      }
    ],
    template: {
      templateId: "template-alternate-identifier",
      type: "cone",
      origin: { x: 10, y: 20 },
      direction: 0,
      angle: 45,
      distance: 12,
      inclusion: "intersected",
      affectedTargets: [
        {
          tokenUuid: "Scene.test.Token.alternate",
          actorUuid: "Actor.alternate",
          name: "Alternate Identifier Target",
          snapshot: {},
          distance: { value: 3, units: "m", source: "template" }
        }
      ]
    }
  });

  assert.equal(selectedTargetMatchedToHazardZoneByAlternateIdentifier.length, 1);
  assert.equal(selectedTargetMatchedToHazardZoneByAlternateIdentifier[0].id, "token-selected-alternate-id");
  assert.equal(selectedTargetMatchedToHazardZoneByAlternateIdentifier[0].tactical.selected, true);
  assert.deepEqual(selectedTargetMatchedToHazardZoneByAlternateIdentifier[0].distance, { value: 8, units: "m", source: "grid" });
  assert.equal(selectedTargetMatchedToHazardZoneByAlternateIdentifier[0].tactical.template.templateId, "template-alternate-identifier");
  assert.equal(selectedTargetMatchedToHazardZoneByAlternateIdentifier[0].tactical.template.targetDistance, 3);

  const zoneOnlyAffectedTokens = normalizeTacticalTargets({
    template: {
      templateId: "template-zone-only",
      type: "cone",
      origin: { x: 10, y: 20 },
      direction: 0,
      angle: 45,
      distance: 12,
      inclusion: "intersected",
      affectedTargets: [
        { id: "token-zone-left", actorUuid: "Actor.zoneLeft", name: "Zone Left", snapshot: {} },
        { id: "token-zone-right", actorUuid: "Actor.zoneRight", name: "Zone Right", snapshot: {} }
      ]
    }
  });

  assert.equal(zoneOnlyAffectedTokens.length, 2);
  assert.equal(zoneOnlyAffectedTokens[0].id, "token-zone-left");
  assert.equal(zoneOnlyAffectedTokens[1].id, "token-zone-right");
  assert.equal(zoneOnlyAffectedTokens[0].tactical.selected, false);
  assert.equal(zoneOnlyAffectedTokens[1].tactical.selected, false);
  assert.equal(zoneOnlyAffectedTokens[0].tactical.template.templateId, "template-zone-only");
  assert.equal(zoneOnlyAffectedTokens[1].tactical.template.templateId, "template-zone-only");

  const templateWithEmptyTargetsAndAffectedTokens = normalizeTacticalTargets({
    template: {
      templateId: "template-empty-targets",
      type: "cone",
      origin: { x: 10, y: 20 },
      direction: 0,
      angle: 45,
      distance: 12,
      inclusion: "intersected",
      targets: [],
      affectedTargets: [
        { id: "token-empty-fallback", actorUuid: "Actor.emptyFallback", name: "Empty Fallback", snapshot: {} }
      ]
    }
  });

  assert.equal(templateWithEmptyTargetsAndAffectedTokens.length, 1);
  assert.equal(templateWithEmptyTargetsAndAffectedTokens[0].id, "token-empty-fallback");
  assert.equal(templateWithEmptyTargetsAndAffectedTokens[0].tactical.selected, false);
  assert.equal(templateWithEmptyTargetsAndAffectedTokens[0].tactical.template.templateId, "template-empty-targets");

  const templateCollectedTargets = normalizeTacticalTargets({
    template: {
      templateId: "template-collected",
      type: "cone",
      origin: { x: 10, y: 20 },
      direction: 0,
      angle: 45,
      distance: 12,
      inclusion: "intersected",
      targets: [
        { id: "token-template-near", selected: false, actorUuid: "Actor.templateNear", name: "Template Near", snapshot: {} },
        { id: "token-template-far", selected: false, actorUuid: "Actor.templateFar", name: "Template Far", snapshot: {} }
      ]
    },
    distance: {
      byTarget: {
        "token-template-near": { value: 1, units: "m", source: "template" },
        "token-template-far": { value: 3, units: "m", source: "template" }
      }
    }
  });

  assert.equal(templateCollectedTargets.length, 2);
  assert.equal(templateCollectedTargets[0].tactical.template.targetDistance, 1);
  assert.equal(templateCollectedTargets[1].tactical.template.targetDistance, 3);
  assert.deepEqual(JSON.parse(JSON.stringify(templateCollectedTargets)), templateCollectedTargets, "template-collected targets are JSON-safe");
  
  // Test manual fallback for missing target context
  const manualTargets = normalizeTacticalTargets({
    targets: [{ id: "token-actorless" }],
    template: { type: "cone" }, // Missing origin, inclusion, etc.
    raycast: { origin: { x: 0, y: 0 } } // Missing destination
  });
  
  assert.equal(manualTargets[0].manualResolution.required, true);
  assert.equal(manualTargets[0].manualResolution.reason, "missing-target-actor");
  assert.deepEqual(manualTargets[0].manualResolution.blockedUpdateCategories, ["target-damage", "target-armor", "target-saves"]);
  assert.ok(manualTargets[0].warnings.some(w => w.code === "missing-target-actor"));
  assert.ok(manualTargets[0].warnings.some(w => w.code === "missing-tactical-template"));
  assert.ok(manualTargets[0].warnings.some(w => w.code === "missing-tactical-raycast"));

  const missingRequiredRaycastEvidence = normalizeTacticalTargets({
    targets: [{ id: "token-required-raycast-missing", actorUuid: "Actor.requiredRaycastMissing", name: "Required Raycast Missing", snapshot: {} }],
    raycast: {
      origin: { x: 0, y: 0 }
    },
    raycastRequired: true
  });

  assert.equal(missingRequiredRaycastEvidence[0].manualResolution.required, true);
  assert.equal(missingRequiredRaycastEvidence[0].manualResolution.message, "Raycast mode requested but tactical data is incomplete.");
  assert.deepEqual(missingRequiredRaycastEvidence[0].manualResolution.blockedUpdateCategories, ["target-damage", "target-armor", "target-saves"]);
  assert.ok(missingRequiredRaycastEvidence[0].warnings.some(w => w.code === "missing-tactical-raycast"));

  const missingRequestedContext = normalizeTacticalTargets({
    targets: [{ id: "token-requested", actorUuid: "Actor.requested", name: "Requested Target", snapshot: {} }],
    templateRequired: true,
    raycastRequired: true
  });

  assert.equal(missingRequestedContext[0].manualResolution.required, true);
  assert.deepEqual(missingRequestedContext[0].manualResolution.blockedUpdateCategories, ["target-damage", "target-armor", "target-saves"]);
  assert.ok(missingRequestedContext[0].warnings.some(w => w.code === "missing-tactical-template"));
  assert.ok(missingRequestedContext[0].warnings.some(w => w.code === "missing-tactical-raycast"));

  const gmDecisionTargets = normalizeTacticalTargets({
    targets: [{ id: "token-gm", actorUuid: "Actor.gm", name: "GM Target", snapshot: {} }],
    template: {
      templateId: "template-manual",
      type: "cone",
      origin: { x: 0, y: 0 },
      inclusion: "manual_decision"
    },
    raycast: {
      origin: { x: 0, y: 0 },
      destination: { x: 5, y: 5 },
      requiresGmDecision: true
    }
  });

  assert.equal(gmDecisionTargets[0].manualResolution.required, true);
  assert.ok(gmDecisionTargets[0].warnings.some(w => w.code === "manual-tactical-template"));
  assert.ok(gmDecisionTargets[0].warnings.some(w => w.code === "manual-tactical-raycast"));

  const ambiguousRaycastTargets = normalizeTacticalTargets({
    targets: [{ id: "token-ambiguous", actorUuid: "Actor.ambiguous", name: "Ambiguous Target", snapshot: {} }],
    raycast: {
      origin: { x: 0, y: 0 },
      destination: { x: 5, y: 5 },
      obstruction: { id: "wall-1" }, // missing type or name making it ambiguous
      requiresGmDecision: false
    }
  });

  assert.equal(ambiguousRaycastTargets[0].manualResolution.required, true);
  assert.ok(ambiguousRaycastTargets[0].warnings.some(w => w.code === "ambiguous-tactical-raycast"));

  const nonTacticalTargets = normalizeTacticalTargets({
    targets: [{ id: "token-non-tactical", actorUuid: "Actor.nonTactical", name: "Non Tactical Target", snapshot: {} }]
  });

  assert.equal(nonTacticalTargets[0].tactical.selected, true);
  assert.equal(nonTacticalTargets[0].manualResolution, undefined);
  assert.equal(nonTacticalTargets[0].warnings, undefined);

  assert.deepEqual(normalizeTacticalTargets(null), []);
  
  // Prove resolveCombatAction() remains the public seam for tactical flows
  // and accepts tactical context without breaking
  const tacticalContext = {
    action: {
      type: "ranged",
      fireMode: "semiauto",
      targetNumber: 15,
      options: {}
    },
    attacker: {
      actorUuid: "Actor.attacker",
      snapshot: { stats: { ref: { total: 10 } } }
    },
    weapon: {
      itemUuid: "Item.weapon",
      snapshot: { damage: "2d6", type: "P", accuracy: 0, attackSkill: "Handgun", attackType: "auto", rof: 2 }
    },
    targets: targets,
    legacy: {
      mode: "fallback",
      fallback: () => ({ targets: [{ target: targets[0] }] })
    }
  };
  
  // Stub a roller that guarantees a miss to just check routing
  const staticRoller = () => ({ id: "attack", total: 10, die: { result: 1 } });
  
  const outcome = await resolveCombatAction(tacticalContext, { structured: true }, staticRoller);
  assert.equal(outcome.targets.length, 1);
  assert.equal(outcome.targets[0].target.tactical.template.inclusion, "intersected");

  const emptyZoneOnlyContext = {
    action: {
      type: "ranged",
      fireMode: "semiAuto",
      range: "close",
      hazardZone: {
        kind: "shotgun-cone",
        templateId: "template-empty-zone",
        templateUuid: "Scene.test.MeasuredTemplate.emptyZone",
        type: "cone",
        origin: { x: 10, y: 20 },
        direction: 90,
        angle: 45,
        distance: 12,
        inclusion: "intersected",
        affectedTokenCount: 0,
        lifecycle: "transient"
      }
    },
    attacker: {
      actorUuid: "Actor.emptyZoneAttacker",
      snapshot: { stats: { ref: { total: 10 } } }
    },
    weapon: {
      itemUuid: "Actor.emptyZoneAttacker.Item.shotgun",
      snapshot: {
        damage: "4d6",
        accuracy: 0,
        attackSkill: "Shotgun",
        attackType: "shotgun",
        shotsLeft: 2
      }
    },
    targets: [],
    legacy: {
      mode: "fallback",
      fallback: () => "fallback-called"
    }
  };
  const emptyZoneOutcome = await resolveCombatAction(emptyZoneOnlyContext, { structured: true }, staticRoller);
  assert.equal(emptyZoneOutcome.manualResolution.required, false, "empty Zone-Only Attack is valid");
  assert.equal(emptyZoneOutcome.targets.length, 0, "empty Hazard Zone does not create a target");
  assert.equal(emptyZoneOutcome.action.hazardZone.templateId, "template-empty-zone", "empty Hazard Zone evidence is preserved");
  assert.deepEqual(emptyZoneOutcome.ammo, {
    before: 2,
    delta: -1,
    after: 1,
    source: "weapon.snapshot.shotsLeft"
  });

  const emptyZonePlan = planCombatUpdates(emptyZoneOutcome);
  assert.deepEqual(emptyZonePlan.actorUpdates, [], "empty Zone-Only Attack plans no target actor updates");
  assert.deepEqual(emptyZonePlan.embeddedItemUpdates, [], "empty Zone-Only Attack plans no target embedded item updates");
  assert.deepEqual(emptyZonePlan.itemUpdates, [{
    itemUuid: "Actor.emptyZoneAttacker.Item.shotgun",
    update: { "system.shotsLeft": 1 }
  }], "empty Zone-Only Attack still plans attacker ammo");

  const emptyZoneChat = buildCombatChatData(emptyZoneOutcome, emptyZonePlan);
  assert.equal(emptyZoneChat.action.hazardZone.templateId, "template-empty-zone", "chat preserves empty Hazard Zone evidence");
  assert.equal(emptyZoneChat.targets.length, 0, "chat does not invent a target for an empty Hazard Zone");

  const previousCanvas = globalThis.canvas;
  const previousConfig = globalThis.CONFIG;
  try {
    delete globalThis.canvas;
    const manualRaycastTargets = await detectAndPromptTacticalRaycasts({ center: { x: 0, y: 0 } }, [{
      id: "token-manual",
      actorUuid: "Actor.manual",
      name: "Manual Target",
      snapshot: {}
    }]);
    assert.equal(manualRaycastTargets[0].manualResolution.required, true, "missing canvas marks raycast target manual");
    assert.ok(manualRaycastTargets[0].warnings.some(warning => warning.code === "manual-tactical-raycast"), "missing canvas adds raycast manual warning");

    globalThis.canvas = {
      ready: true,
      walls: {},
      grid: { size: 100 },
      scene: { grid: { distance: 2 } }
    };
    let lastRaycastOrigin = null;
    let lastRaycastOptions = null;
    globalThis.CONFIG = {
      Canvas: {
        polygonBackends: {
          sight: {
            testCollision: (origin, dest, options) => {
              lastRaycastOrigin = origin;
              lastRaycastOptions = options;
              return null;
            }
          }
        }
      }
    };
    const staleTarget = {
      id: "token-stale",
      actorUuid: "Actor.stale",
      name: "Stale Target",
      snapshot: {},
      center: { x: 10, y: 0 },
      tactical: {
        raycast: { requiresGmDecision: true },
        cover: { applies: true, stoppingPower: 10 },
        selected: true
      }
    };
    const clearTargets = await detectAndPromptTacticalRaycasts({ center: { x: 0, y: 0 } }, [staleTarget]);
    assert.equal(clearTargets[0].tactical.raycast, undefined, "no-collision raycast clears stale raycast context");
    assert.equal(clearTargets[0].tactical.cover, undefined, "no-collision raycast clears stale cover context");
    assert.equal(staleTarget.tactical.cover.stoppingPower, 10, "raycast adapter does not mutate source target tactical data");

    await detectAndPromptTacticalRaycasts({ center: { x: 0, y: 0 } }, [{
      id: "token-circle-target",
      actorUuid: "Actor.circle",
      name: "Circle Target",
      snapshot: {},
      center: { x: 100, y: 100 },
      tactical: {
        template: {
          type: "circle",
          origin: { x: 50, y: 50 }
        }
      }
    }]);
    assert.deepEqual(lastRaycastOrigin, { x: 50, y: 50 }, "circle template uses template origin for raycasts instead of attacker origin");
    assert.equal(lastRaycastOptions?.type, "move", "tactical raycast uses movement collision so Invisible Walls are detected");
  } finally {
    globalThis.canvas = previousCanvas;
    globalThis.CONFIG = previousConfig;
  }
}

function assertBodyTypeDamageResolver() {
  assert.deepEqual(resolveBodyTypeDamage(0, 6), {
    penetratingDamage: 0,
    bodyTypeModifier: 2,
    bodyTypeMitigation: 0,
    finalDamage: 0,
    minimumDamageApplied: false
  }, "full armor stop skips BTM and minimum damage");

  assert.deepEqual(resolveBodyTypeDamage(5, 6), {
    penetratingDamage: 5,
    bodyTypeModifier: 2,
    bodyTypeMitigation: 2,
    finalDamage: 3,
    minimumDamageApplied: false
  }, "BTM partially reduces penetrating damage");

  assert.deepEqual(resolveBodyTypeDamage(1, 6), {
    penetratingDamage: 1,
    bodyTypeModifier: 2,
    bodyTypeMitigation: 0,
    finalDamage: 1,
    minimumDamageApplied: true
  }, "BTM cannot reduce penetrating damage below minimum 1");

  assert.deepEqual(resolveBodyTypeDamage(5, "not-a-number"), {
    penetratingDamage: 5,
    bodyTypeModifier: 0,
    bodyTypeMitigation: 0,
    finalDamage: 5,
    minimumDamageApplied: false
  }, "invalid Body Type does not become maximum BTM");

  // BT 13 — modifier 6 (was 5 before fix), 7 - 6 = 1, not minimum-forced
  assert.deepEqual(resolveBodyTypeDamage(7, 13), {
    penetratingDamage: 7,
    bodyTypeModifier: 6,
    bodyTypeMitigation: 6,
    finalDamage: 1,
    minimumDamageApplied: false
  }, "BT 13 BTM reduces penetrating damage to exactly 1 (not minimum-forced)");

  // BT 14 — modifier 6 (was 5 before fix), 5 - 6 = -1, forced to minimum 1
  assert.deepEqual(resolveBodyTypeDamage(5, 14), {
    penetratingDamage: 5,
    bodyTypeModifier: 6,
    bodyTypeMitigation: 4,
    finalDamage: 1,
    minimumDamageApplied: true
  }, "BT 14 BTM forces minimum damage when BTM exceeds penetrating damage");

  // BT 15 — modifier 8 (was 5 before fix), 10 - 8 = 2
  assert.deepEqual(resolveBodyTypeDamage(10, 15), {
    penetratingDamage: 10,
    bodyTypeModifier: 8,
    bodyTypeMitigation: 8,
    finalDamage: 2,
    minimumDamageApplied: false
  }, "BT 15 BTM correctly resolves to modifier 8");

  // BT 2 — modifier 0 (guard limit)
  assert.deepEqual(resolveBodyTypeDamage(5, 2), {
    penetratingDamage: 5,
    bodyTypeModifier: 0,
    bodyTypeMitigation: 0,
    finalDamage: 5,
    minimumDamageApplied: false
  }, "BT 2 BTM resolves to modifier 0");

  // BT 3 — modifier 1 (CP2020 p.106: BT 3-4 = -1)
  assert.deepEqual(resolveBodyTypeDamage(6, 3), {
    penetratingDamage: 6,
    bodyTypeModifier: 1,
    bodyTypeMitigation: 1,
    finalDamage: 5,
    minimumDamageApplied: false
  }, "BT 3 BTM resolves to modifier 1");

  // BT 4 — modifier 1
  assert.deepEqual(resolveBodyTypeDamage(5, 4), {
    penetratingDamage: 5,
    bodyTypeModifier: 1,
    bodyTypeMitigation: 1,
    finalDamage: 4,
    minimumDamageApplied: false
  }, "BT 4 BTM resolves to modifier 1");

  // BT 5 — modifier 2 (CP2020 p.106: BT 5-7 = -2)
  assert.deepEqual(resolveBodyTypeDamage(5, 5), {
    penetratingDamage: 5,
    bodyTypeModifier: 2,
    bodyTypeMitigation: 2,
    finalDamage: 3,
    minimumDamageApplied: false
  }, "BT 5 BTM resolves to modifier 2");

  // BT 7 — modifier 2 (CP2020 p.106: BT 5-7 = -2)
  assert.deepEqual(resolveBodyTypeDamage(5, 7), {
    penetratingDamage: 5,
    bodyTypeModifier: 2,
    bodyTypeMitigation: 2,
    finalDamage: 3,
    minimumDamageApplied: false
  }, "BT 7 BTM resolves to modifier 2");

  // BT 8 — modifier 3 (CP2020 p.106: BT 8-9 = -3)
  assert.deepEqual(resolveBodyTypeDamage(6, 8), {
    penetratingDamage: 6,
    bodyTypeModifier: 3,
    bodyTypeMitigation: 3,
    finalDamage: 3,
    minimumDamageApplied: false
  }, "BT 8 BTM resolves to modifier 3");

  // BT 9 — modifier 3 (CP2020 p.106: BT 8-9 = -3)
  assert.deepEqual(resolveBodyTypeDamage(4, 9), {
    penetratingDamage: 4,
    bodyTypeModifier: 3,
    bodyTypeMitigation: 3,
    finalDamage: 1,
    minimumDamageApplied: false
  }, "BT 9 BTM resolves to modifier 3; 4-3=1 exactly, no minimum forcing");

  // BT 11 — modifier 5 (explicit case)
  assert.deepEqual(resolveBodyTypeDamage(7, 11), {
    penetratingDamage: 7,
    bodyTypeModifier: 5,
    bodyTypeMitigation: 5,
    finalDamage: 2,
    minimumDamageApplied: false
  }, "BT 11 BTM resolves to modifier 5");

  // BT 12 — modifier 5 (explicit case)
  assert.deepEqual(resolveBodyTypeDamage(5, 12), {
    penetratingDamage: 5,
    bodyTypeModifier: 5,
    bodyTypeMitigation: 4,
    finalDamage: 1,
    minimumDamageApplied: true
  }, "BT 12 BTM forces minimum damage when BTM matches penetrating damage");

  // BT 10.5 — fractional input resolves to BT 10 (modifier 4)
  assert.deepEqual(resolveBodyTypeDamage(10, 10.5), {
    penetratingDamage: 10,
    bodyTypeModifier: 4,
    bodyTypeMitigation: 4,
    finalDamage: 6,
    minimumDamageApplied: false
  }, "fractional BT 10.5 resolves to BT 10 modifier 4");

  // BT "13" — string input resolves to modifier 6
  assert.deepEqual(resolveBodyTypeDamage(7, "13"), {
    penetratingDamage: 7,
    bodyTypeModifier: 6,
    bodyTypeMitigation: 6,
    finalDamage: 1,
    minimumDamageApplied: false
  }, "string BT '13' resolves to BT 13 modifier 6");
}

function assertWoundPlanning() {
  const torsoOutcome = buildWoundOutcome({
    currentDamage: 3,
    location: "torso",
    finalDamage: 2
  });
  const torsoPlan = planCombatUpdates(torsoOutcome);
  assert.deepEqual(torsoPlan.actorUpdates, [
    {
      actorUuid: "Actor.target",
      update: {
        "system.damage": 5
      }
    }
  ], "wound planning advances target damage");
  assert.deepEqual(torsoOutcome.targets[0].hits[0].woundTransition, {
    previousDamage: 3,
    damageDelta: 2,
    nextDamage: 5,
    previousWoundState: {
      level: 1,
      label: "Light"
    },
    nextWoundState: {
      level: 2,
      label: "Serious"
    },
    crossedThreshold: true
  }, "wound planning records wound transition evidence");

  const criticalOutcome = buildWoundOutcome({
    currentDamage: 7,
    location: "torso",
    finalDamage: 2
  });
  planCombatUpdates(criticalOutcome);
  assert.deepEqual(criticalOutcome.targets[0].damage.nextWoundState, {
    level: 3,
    label: "Critical"
  }, "wound planning records Critical transition");

  const mortalOutcome = buildWoundOutcome({
    currentDamage: 11,
    location: "torso",
    finalDamage: 2
  });
  planCombatUpdates(mortalOutcome);
  assert.deepEqual(mortalOutcome.targets[0].damage.nextWoundState, {
    level: 4,
    label: "Mortal 0"
  }, "wound planning records Mortal transition");

  const headOutcome = buildWoundOutcome({
    currentDamage: 0,
    location: "Head",
    finalDamage: 10,
    specialCases: [
      {
        code: "head-hit-double-damage",
        damageMultiplier: 2,
        damageBeforeMultiplier: 5,
        damageAfterMultiplier: 10
      }
    ]
  });
  const headPlan = planCombatUpdates(headOutcome);
  assert.deepEqual(headPlan.actorUpdates[0].update, {
    "system.damage": 10
  }, "head hit applies wound damage directly");
  assert.equal(headOutcome.targets[0].hits[0].woundDamage, 10, "head hit exposes wound damage");
  assert.deepEqual(headOutcome.targets[0].hits[0].specialCases, [
    {
      code: "head-hit-double-damage",
      damageMultiplier: 2,
      damageBeforeMultiplier: 5,
      damageAfterMultiplier: 10
    },
    {
      code: "head-critical-injury",
      threshold: 8,
      woundDamage: 10
    }
  ], "head hit exposes special cases without save prompts");
  assert.deepEqual(headOutcome.targets[0].hits[0].warnings, [
    {
      code: "head-critical-injury",
      severity: "warning",
      message: "Head hit exceeded 8 damage in one attack; target is killed automatically unless the referee overrides the special case."
    }
  ], "head threshold surfaces automatic-death warning");

  const labeledHeadOutcome = buildWoundOutcome({
    currentDamage: 0,
    location: "skull",
    locationLabel: "Head",
    finalDamage: 4,
    specialCases: [
      {
        code: "head-hit-double-damage",
        damageMultiplier: 2,
        damageBeforeMultiplier: 2,
        damageAfterMultiplier: 4
      }
    ]
  });
  planCombatUpdates(labeledHeadOutcome);
  assert.equal(labeledHeadOutcome.targets[0].hits[0].woundDamage, 4, "head label applies wound damage directly");

  const limbOutcome = buildWoundOutcome({
    currentDamage: 0,
    location: "rArm",
    finalDamage: 9
  });
  planCombatUpdates(limbOutcome);
  assert.deepEqual(limbOutcome.targets[0].hits[0].warnings, [
    {
      code: "limb-loss-threshold",
      severity: "warning",
      message: "Limb hit exceeded 8 damage in one attack; limb is severed or crushed and requires follow-up resolution."
    }
  ], "limb threshold surfaces warning");

  const stoppedOutcome = buildWoundOutcome({
    currentDamage: 4,
    location: "torso",
    finalDamage: 0
  });
  const stoppedPlan = planCombatUpdates(stoppedOutcome);
  assert.deepEqual(stoppedPlan.actorUpdates, [], "full stop does not plan target damage");
  assert.equal(stoppedOutcome.targets[0].hits[0].woundTransition, undefined, "full stop does not add wound transition");

  stoppedOutcome.targets[0].hits[0].woundDamage = 9;
  stoppedOutcome.targets[0].hits[0].woundTransition = { stale: true };
  stoppedOutcome.targets[0].hits[0].specialCases = [{ code: "head-critical-injury" }];
  planCombatUpdates(stoppedOutcome);
  assert.equal(stoppedOutcome.targets[0].hits[0].woundDamage, undefined, "replanning clears stale wound damage");
  assert.equal(stoppedOutcome.targets[0].hits[0].woundTransition, undefined, "replanning clears stale wound transition");
  assert.equal(stoppedOutcome.targets[0].hits[0].specialCases, undefined, "replanning clears stale special cases");

  const missingDamageOutcome = buildWoundOutcome({
    currentDamage: undefined,
    location: "torso",
    finalDamage: 2
  });
  const missingDamagePlan = planCombatUpdates(missingDamageOutcome);
  assert.deepEqual(missingDamagePlan.actorUpdates, [], "missing damage snapshot does not plan target damage");
  assert.deepEqual(missingDamagePlan.warnings, [
    {
      code: "missing-target-damage-state",
      severity: "warning",
      message: "Target damage state is unavailable; resolve target damage manually before committing wound updates."
    }
  ], "missing damage snapshot produces unsafe plan warning");

  const fractionalDamageOutcome = buildWoundOutcome({
    currentDamage: 0,
    location: "torso",
    finalDamage: 1.5
  });
  const fractionalDamagePlan = planCombatUpdates(fractionalDamageOutcome);
  assert.deepEqual(fractionalDamagePlan.actorUpdates, [], "fractional final damage does not plan target damage");
  assert.deepEqual(fractionalDamagePlan.warnings, [
    {
      code: "invalid-wound-damage",
      severity: "warning",
      message: "Wound damage must be a non-negative integer before it can be planned."
    }
  ], "fractional final damage produces unsafe plan warning");

  const existingSpecialCaseOutcome = buildWoundOutcome({
    currentDamage: 0,
    location: "rArm",
    finalDamage: 9,
    specialCases: [{ code: "existing-special-case" }]
  });
  planCombatUpdates(existingSpecialCaseOutcome);
  assert.deepEqual(existingSpecialCaseOutcome.targets[0].hits[0].specialCases, [
    {
      code: "existing-special-case"
    },
    {
      code: "limb-loss-threshold",
      threshold: 8,
      woundDamage: 9
    }
  ], "wound planning preserves existing special cases");
}

function assertSavePromptResolution() {
  assert.deepEqual(resolveSavePromptsForTarget(buildWoundOutcome({
    currentDamage: 3,
    location: "torso",
    finalDamage: 2
  }).targets[0]), {
    saves: [
      {
        type: "stun",
        status: "pending",
        reason: "damage-taken",
        bodyType: 6,
        threshold: 5,
        targetNumber: 5,
        penalty: 1,
        woundState: {
          level: 2,
          label: "Serious"
        },
        evidence: {
          previousDamage: 3,
          nextDamage: 5,
          damageDelta: 2
        }
      }
    ],
    warnings: []
  }, "Serious wound damage creates pending Stun/Shock prompt");

  assert.deepEqual(resolveSavePromptsForTarget(buildWoundOutcome({
    currentDamage: 11,
    location: "torso",
    finalDamage: 2
  }).targets[0]), {
    saves: [
      {
        type: "stun",
        status: "pending",
        reason: "damage-taken",
        bodyType: 6,
        threshold: 3,
        targetNumber: 3,
        penalty: 3,
        woundState: {
          level: 4,
          label: "Mortal 0"
        },
        evidence: {
          previousDamage: 11,
          nextDamage: 13,
          damageDelta: 2
        }
      },
      {
        type: "death",
        status: "pending",
        reason: "mortal-wound",
        bodyType: 6,
        threshold: 6,
        targetNumber: 6,
        penalty: 0,
        mortalLevel: 0,
        woundState: {
          level: 4,
          label: "Mortal 0"
        },
        evidence: {
          previousDamage: 11,
          nextDamage: 13,
          damageDelta: 2
        }
      }
    ],
    warnings: []
  }, "Mortal wound damage creates pending Stun/Shock and Death prompts");

  assert.deepEqual(resolveSavePromptsForTarget(buildWoundOutcome({
    currentDamage: 13,
    location: "torso",
    finalDamage: 0
  }).targets[0]), {
    saves: [],
    warnings: []
  }, "Existing Mortal target does not receive attack-time recurring Death Save reminder");

  assert.deepEqual(resolveSavePromptsForTarget(buildWoundOutcome({
    currentDamage: 41,
    location: "torso",
    finalDamage: 2
  }).targets[0]), {
    saves: [],
    warnings: [
      {
        code: "target-already-dead",
        severity: "warning",
        message: "Target is dead or Mortal 7+; do not generate a new Death Save prompt."
      }
    ]
  }, "Mortal 7+ target receives no new Stun/Shock or Death prompt");

  assert.deepEqual(resolveSavePromptsForTarget(buildWoundOutcome({
    currentDamage: 13,
    location: "torso",
    finalDamage: 2,
    deathSaveState: {
      stabilized: true
    }
  }).targets[0]), {
    saves: [
      {
        type: "stun",
        status: "pending",
        reason: "damage-taken",
        bodyType: 6,
        threshold: 3,
        targetNumber: 3,
        penalty: 3,
        woundState: {
          level: 4,
          label: "Mortal 0"
        },
        evidence: {
          previousDamage: 13,
          nextDamage: 15,
          damageDelta: 2
        }
      }
    ],
    warnings: []
  }, "Stabilized Mortal target suppresses attack-time Death prompts while preserving Stun/Shock");

  const noDamageOutcome = buildWoundOutcome({
    currentDamage: 4,
    location: "torso",
    finalDamage: 0
  });
  const noDamagePlan = planCombatUpdates(noDamageOutcome);
  assert.deepEqual(noDamageOutcome.targets[0].saves, [], "no-damage non-Mortal target receives no save prompts");
  assert.deepEqual(noDamagePlan.warnings, [], "no-damage non-Mortal target does not warn");

  const missingBodyTypeOutcome = buildWoundOutcome({
    currentDamage: 3,
    location: "torso",
    finalDamage: 2,
    bodyType: null
  });
  const missingBodyTypePlan = planCombatUpdates(missingBodyTypeOutcome);
  assert.deepEqual(missingBodyTypeOutcome.targets[0].saves, [], "missing Body Type blocks save prompts");
  assert.deepEqual(missingBodyTypePlan.warnings, [
    {
      code: "missing-target-body-type",
      severity: "warning",
      message: "Target Body Type is unavailable; resolve Stun/Shock and Death Saves manually."
    }
  ], "missing Body Type produces manual save warning");

  const criticalOutcome = buildWoundOutcome({
    currentDamage: 7,
    location: "torso",
    finalDamage: 2
  });
  const criticalPlan = planCombatUpdates(criticalOutcome);
  assert.deepEqual(criticalOutcome.targets[0].saves, [
    {
      type: "stun",
      status: "pending",
      reason: "damage-taken",
      bodyType: 6,
      threshold: 4,
      targetNumber: 4,
      penalty: 2,
      woundState: {
        level: 3,
        label: "Critical"
      },
      evidence: {
        previousDamage: 7,
        nextDamage: 9,
        damageDelta: 2
      }
    }
  ], "planning attaches Critical Stun/Shock prompt to outcome");
  assert.deepEqual(buildCombatChatData(criticalOutcome, criticalPlan).targets[0].saves, criticalOutcome.targets[0].saves, "chat data exposes save prompts");

  // --- Progressive Saves Test ---
  const multiHitOutcome = buildMultiHitWoundOutcome({
    currentDamage: 0,
    hits: [
      { location: "torso", finalDamage: 5 }, // 5 dmg -> Serious
      { location: "torso", finalDamage: 5 }, // 10 dmg -> Critical
      { location: "torso", finalDamage: 5 }  // 15 dmg -> Mortal 0
    ],
    bodyType: 6
  });
  assert.deepEqual(resolveSavePromptsForTarget(multiHitOutcome.targets[0]), {
    saves: [
      {
        type: "stun",
        status: "pending",
        reason: "damage-taken",
        bodyType: 6,
        threshold: 5,
        targetNumber: 5,
        penalty: 1,
        woundState: { level: 2, label: "Serious" },
        evidence: { previousDamage: 0, nextDamage: 5, damageDelta: 5 }
      },
      {
        type: "stun",
        status: "pending",
        reason: "damage-taken",
        bodyType: 6,
        threshold: 4,
        targetNumber: 4,
        penalty: 2,
        woundState: { level: 3, label: "Critical" },
        evidence: { previousDamage: 5, nextDamage: 10, damageDelta: 5 }
      },
      {
        type: "stun",
        status: "pending",
        reason: "damage-taken",
        bodyType: 6,
        threshold: 3,
        targetNumber: 3,
        penalty: 3,
        woundState: { level: 4, label: "Mortal 0" },
        evidence: { previousDamage: 10, nextDamage: 15, damageDelta: 5 }
      },
      {
        type: "death",
        status: "pending",
        reason: "mortal-wound",
        bodyType: 6,
        threshold: 6,
        targetNumber: 6,
        penalty: 0,
        mortalLevel: 0,
        woundState: { level: 4, label: "Mortal 0" },
        evidence: { previousDamage: 0, nextDamage: 15, damageDelta: 15 }
      }
    ],
    warnings: []
  }, "multi-hit attack generates progressive stun saves and one final death save");
}

function assertDeathSaveStateHelpers() {
  assert.equal(requiresRecurringDeathSave({ system: { damage: 13, stats: { bt: { total: 6 } } } }), true, "Mortal actor requires recurring Death Save");
  assert.equal(requiresRecurringDeathSave({ system: { damage: 12, stats: { bt: { total: 6 } } } }), false, "Critical actor does not require recurring Death Save");
  assert.equal(requiresRecurringDeathSave({ system: { damage: 13, deathSave: { stabilized: true }, stats: { bt: { total: 6 } } } }), false, "stabilized Mortal actor suppresses recurring Death Save");
  assert.equal(requiresRecurringDeathSave({ system: { damage: 41, stats: { bt: { total: 6 } } } }), false, "Mortal 7+ actor is treated as dead");
  assert.equal(isActorDeadForDeathSaves({ system: { deathSave: { failed: true } } }), true, "failed death save state is dead");
  assert.equal(isActorStabilizedForDeathSaves({ system: { deathSave: { stabilized: true } } }), true, "deathSave.stabilized is recognized");
}

function buildWoundOutcome({ currentDamage, location, locationLabel = undefined, finalDamage, specialCases = undefined, bodyType = 6, deathSaveState = undefined }) {
  const stats = bodyType === undefined
    ? {}
    : {
        bt: {
          total: bodyType
        }
      };
  return {
    targets: [
      {
        target: {
          actorUuid: "Actor.target",
          snapshot: {
            stats,
            damage: currentDamage,
            ...(deathSaveState ? { deathSave: deathSaveState } : {})
          }
        },
        manualResolution: {
          required: false
        },
        hits: [
          {
            location,
            locationLabel,
            finalDamage,
            specialCases,
            warnings: []
          }
        ]
      }
    ],
    plannedUpdates: {
      chatStatus: "preview"
    }
  };
}

function buildMultiHitWoundOutcome({ currentDamage, hits, bodyType = 6, deathSaveState = undefined }) {
  const stats = bodyType === undefined
    ? {}
    : {
        bt: {
          total: bodyType
        }
      };
  return {
    targets: [
      {
        target: {
          actorUuid: "Actor.target",
          snapshot: {
            stats,
            damage: currentDamage,
            ...(deathSaveState ? { deathSave: deathSaveState } : {})
          }
        },
        manualResolution: {
          required: false
        },
        hits: hits.map(hit => ({
          location: hit.location || "torso",
          locationLabel: hit.locationLabel,
          finalDamage: hit.finalDamage,
          woundDamage: hit.woundDamage || hit.finalDamage, // Mocking attack resolver behavior where woundDamage is populated
          specialCases: hit.specialCases,
          warnings: []
        }))
      }
    ],
    plannedUpdates: {
      chatStatus: "preview"
    }
  };
}


function assertOutcomeShape(outcome, expected) {
  assert.equal(outcome.action.type, expected.actionType, "outcome action type");
  assert.equal(outcome.action.fireMode, expected.fireMode, "outcome fire mode");
  assert.ok(outcome.attacker.actorUuid, "outcome attacker actor UUID");
  assert.ok(outcome.weapon.itemUuid, "outcome weapon item UUID");
  assert.equal(outcome.targets.length, 1, "outcome target count");
  assert.equal(outcome.targets[0].attack.roll.total, expected.attackTotal, "outcome attack total");
  assert.equal(outcome.targets[0].attack.targetNumber, expected.targetNumber, "outcome target number");
  assert.equal(outcome.targets[0].attack.hit, expected.hit, "outcome hit flag");
  assert.equal(outcome.targets[0].hits[0].location, expected.location, "outcome hit location");
  assert.equal(outcome.targets[0].hits[0].rawDamage, expected.rawDamage, "outcome raw damage");
  assert.equal(outcome.targets[0].hits[0].effectiveStoppingPower, expected.effectiveStoppingPower, "outcome armor evidence");
  assert.equal(outcome.targets[0].hits[0].armorMitigation, expected.armorMitigation, "outcome armor mitigation");
  if("penetratingDamage" in expected) {
    assert.equal(outcome.targets[0].hits[0].penetratingDamage, expected.penetratingDamage, "outcome penetrating damage");
  }
  if("bodyTypeModifier" in expected) {
    assert.equal(outcome.targets[0].hits[0].bodyTypeModifier, expected.bodyTypeModifier, "outcome body type modifier");
  }
  assert.equal(outcome.targets[0].hits[0].bodyTypeMitigation, expected.bodyTypeMitigation, "outcome body type mitigation");
  if("minimumDamageApplied" in expected) {
    assert.equal(outcome.targets[0].hits[0].minimumDamageApplied, expected.minimumDamageApplied, "outcome minimum damage evidence");
  }
  assert.equal(outcome.targets[0].hits[0].finalDamage, expected.finalDamage, "outcome final damage");
  assert.deepEqual(outcome.targets[0].attack.roll, expected.rolls.attack, "outcome attack roll metadata");
  assert.deepEqual(outcome.targets[0].hits[0].locationRoll, expected.rolls.location, "outcome location roll metadata");
  assert.deepEqual(outcome.targets[0].hits[0].damageRoll, expected.rolls.damage, "outcome damage roll metadata");
  assert.equal(outcome.chat.status, expected.chatStatus, "outcome chat status");
}

function clonePlainData(data) {
  return JSON.parse(JSON.stringify(data));
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

function isPlainObject(value) {
  return !!value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype;
}

function assertObjectIncludes(actual, expected, message) {
  if(Array.isArray(expected)) {
    assert.ok(Array.isArray(actual), `${message} should be an array`);
    assert.equal(actual.length, expected.length, `${message} length`);
    expected.forEach((expectedValue, index) => {
      if(isPlainObject(expectedValue) || Array.isArray(expectedValue)) {
        assertObjectIncludes(actual[index], expectedValue, `${message}[${index}]`);
      }
      else {
        assert.deepEqual(actual[index], expectedValue, `${message}[${index}]`);
      }
    });
    return;
  }

  for(const [key, expectedValue] of Object.entries(expected)) {
    if(isPlainObject(expectedValue) || Array.isArray(expectedValue)) {
      assertObjectIncludes(actual?.[key], expectedValue, `${message}.${key}`);
    }
    else {
      assert.deepEqual(actual?.[key], expectedValue, `${message}.${key}`);
    }
  }
}

function reviveFixtureSentinels(data) {
  if(Array.isArray(data)) {
    return data.map(value => reviveFixtureSentinels(value));
  }
  if(data && typeof data === "object") {
    for(const [key, value] of Object.entries(data)) {
      data[key] = reviveFixtureSentinels(value);
    }
    return data;
  }
  if(data === "__UNDEFINED__") {
    return undefined;
  }
  return data;
}

function assertArmorResolver() {
  // Test target snapshot structure with a mix of equipped/unequipped armor and cyberware
  const targetSnapshot = {
    stats: {
      body: { total: 6 }
    },
    hitLocations: {
      torso: { stoppingPower: 99, label: "Torso" } // Pre-summed SP that must be ignored!
    },
    equippedArmor: [
      {
        id: "armor-torso-1",
        name: "Light Kevlar Vest",
        type: "armor",
        system: {
          equipped: true,
          coverage: {
            torso: { stoppingPower: 10, ablation: 0, layer: "soft" },
            rarm: { stoppingPower: 6, ablation: 1, layer: "soft" }
          }
        }
      },
      {
        id: "armor-torso-2",
        name: "MetalGear",
        type: "armor",
        system: {
          equipped: true,
          coverage: {
            torso: { sp: 25, ablation: 2, layer: "hard" }
          }
        }
      },
      {
        id: "armor-unequipped",
        name: "Unequipped Vest",
        type: "armor",
        system: {
          equipped: false,
          coverage: {
            torso: { stoppingPower: 12, ablation: 0 }
          }
        }
      }
    ],
    equippedCyberware: [
      {
        id: "cyberware-subdermal",
        name: "Subdermal Armor",
        type: "cyberware",
        system: {
          equipped: true,
          stoppingPower: 2,
          ablation: 0,
          layer: "hard"
        }
      },
      {
        id: "cyberware-skinweave",
        name: "Skinweave SP12",
        type: "cyberware",
        system: {
          equipped: true,
          cyberwareType: "BIOWARE",
          cyberwareSubtype: "SKINWEAVE",
          flavor: "12 SP;50% chance-1 ATTR loss",
          source: "Cyberpunk 2020 2nd ed. pg.85"
        }
      },
      {
        id: "cyberware-skull",
        name: "Subdermal Skull Armor SP6",
        type: "cyberware",
        system: {
          equipped: true,
          cyberwareType: "IMPLANT",
          cyberwareSubtype: "SUBDERMAL ARMOR",
          flavor: "6SP; DIFF 30 to spot"
        }
      },
      {
        id: "cyberware-unequipped",
        name: "Unequipped Skin Weave",
        type: "cyberware",
        system: {
          equipped: false,
          stoppingPower: 4,
          ablation: 0
        }
      }
    ]
  };

  // 1. Test getEquippedArmorForLocation with Torso (case-insensitive)
  const torsoLayers = getEquippedArmorForLocation(targetSnapshot, "Torso");
  assert.equal(torsoLayers.length, 4, "should extract 4 layers for Torso (2 armor, 2 cyberware)");

  // Verify details of armor-torso-1
  const layer1 = torsoLayers.find(l => l.id === "armor-torso-1");
  assert.ok(layer1, "layer 1 exists");
  assert.equal(layer1.stoppingPower, 10, "layer 1 SP");
  assert.equal(layer1.type, "armor", "layer 1 type");
  assert.equal(layer1.layer, "soft", "layer 1 material");

  // Verify details of MetalGear (uses alternative 'sp' property)
  const layer2 = torsoLayers.find(l => l.id === "armor-torso-2");
  assert.ok(layer2, "layer 2 exists");
  assert.equal(layer2.stoppingPower, 23, "layer 2 usable SP accounts for ablation");
  assert.equal(layer2.type, "armor", "layer 2 type");
  assert.equal(layer2.layer, "hard", "layer 2 material");

  // Verify details of subdermal armor
  const cyberLayer = torsoLayers.find(l => l.id === "cyberware-subdermal");
  assert.ok(cyberLayer, "cyberware layer exists");
  assert.equal(cyberLayer.stoppingPower, 2, "cyberware SP");
  assert.equal(cyberLayer.type, "cyberware", "cyberware type");
  assert.equal(cyberLayer.layer, "hard", "cyberware material");
  assert.equal(cyberLayer.ablation, 0, "cyberware layer preserves current ablation");
  assert.equal(cyberLayer.updatePath, "system.ablation", "cyberware layer exposes ablation update path");

  const skinweaveLayer = torsoLayers.find(l => l.id === "cyberware-skinweave");
  assert.ok(skinweaveLayer, "skinweave layer exists");
  assert.equal(skinweaveLayer.stoppingPower, 12, "skinweave SP is parsed from existing pack-style text");
  assert.equal(skinweaveLayer.layer, "soft", "pack-style skinweave defaults to soft layer");
  assert.equal(skinweaveLayer.source, "Cyberpunk 2020 2nd ed. pg.85", "skinweave source is preserved");
  assert.equal(skinweaveLayer.updatePath, "system.ablation", "skinweave layer exposes cyberware ablation update path");
  assert.ok(!torsoLayers.some(l => l.id === "cyberware-skull"), "skull-only subdermal armor does not cover torso");

  const zonedSkinweaveSnapshot = {
    equippedCyberware: [
      {
        id: "zoned-skinweave",
        name: "Skinweave SP12",
        type: "cyberware",
        system: {
          equipped: true,
          cyberwareSubtype: "SKINWEAVE",
          coverage: {
            Torso: { stoppingPower: 12, ablation: 2, layer: "soft" },
            rArm: { stoppingPower: 12, ablation: 0, layer: "soft" }
          }
        }
      }
    ]
  };
  const zonedSkinweaveTorso = getEquippedArmorForLocation(zonedSkinweaveSnapshot, "torso")[0];
  assert.equal(zonedSkinweaveTorso.stoppingPower, 10, "zoned skinweave torso SP accounts for torso ablation only");
  assert.equal(zonedSkinweaveTorso.coverageKey, "Torso", "zoned skinweave preserves matched coverage key");
  assert.equal(zonedSkinweaveTorso.updatePath, "system.coverage.Torso.ablation", "zoned skinweave ablates the hit location");
  const zonedSkinweaveRarm = getEquippedArmorForLocation(zonedSkinweaveSnapshot, "rarm")[0];
  assert.equal(zonedSkinweaveRarm.stoppingPower, 12, "zoned skinweave arm SP ignores torso ablation");
  assert.equal(zonedSkinweaveRarm.updatePath, "system.coverage.rArm.ablation", "zoned skinweave keeps per-location ablation path");

  const headLayers = getEquippedArmorForLocation(targetSnapshot, "Head");
  const skullLayer = headLayers.find(l => l.id === "cyberware-skull");
  assert.ok(skullLayer, "skull subdermal armor covers head");
  assert.equal(skullLayer.stoppingPower, 6, "skull subdermal SP is parsed from name/flavor");

  // Verify that unequipped layers are ignored
  assert.ok(!torsoLayers.some(l => l.id === "armor-unequipped"), "unequipped armor is ignored");
  assert.ok(!torsoLayers.some(l => l.id === "cyberware-unequipped"), "unequipped cyberware is ignored");

  // 2. Test resolveArmor
  // Inside-out proportional resolution combines cyberware, armor, then outer layers.
  const resolvedNonAP = resolveArmor(false, targetSnapshot, "torso");
  assert.equal(resolvedNonAP.effectiveStoppingPower, 28, "non-AP effective stopping power uses proportional layering with ablation");
  assert.equal(resolvedNonAP.armorPiercing, false, "armorPiercing flag is false");
  assert.equal(resolvedNonAP.rawStoppingPower, 28, "raw stopping power reflects ablated layers before AP");

  // AP behavior is preserved from 3.1 until full AP semantics are handled in 3.3.
  const resolvedAP = resolveArmor(true, targetSnapshot, "torso");
  assert.equal(resolvedAP.effectiveStoppingPower, 14, "AP effective stopping power is halved after proportional layering");
  assert.equal(resolvedAP.armorPiercing, true, "armorPiercing flag is true");
  assert.deepEqual(resolvedAP.armorPiercingEvidence, {
    applied: true,
    rawStoppingPower: 28,
    effectiveStoppingPower: 14,
    coverRawStoppingPower: 0,
    coverEffectiveStoppingPower: 0,
    personalRawStoppingPower: 28,
    personalEffectiveStoppingPower: 14,
    armorDivisor: 2,
    penetratingDamageDivisor: 2
  }, "AP evidence describes both armor and penetrating-damage divisors");
  assert.equal(resolvedAP.warnings.length, 2, "four active torso layers with multiple hard layers produce warnings");
  assert.deepEqual(resolvedAP.warnings.map(warning => warning.code), ["armor-too-many-layers", "armor-multiple-hard-layers"]);

  assert.equal(layer1.baseStoppingPower, 10, "armor layer preserves base SP");
  assert.equal(layer1.coverageKey, "torso", "armor layer preserves original coverage key");
  assert.equal(layer1.ablation, 0, "armor layer preserves current ablation");
  assert.equal(layer1.updatePath, "system.coverage.torso.ablation", "armor layer exposes ablation update path");
  assert.equal(layer2.baseStoppingPower, 25, "ablated armor layer preserves base SP");
  assert.equal(layer2.stoppingPower, 23, "ablated armor layer reduces usable SP");
  assert.equal(layer2.coverageKey, "torso", "alternative sp coverage preserves original key");

  // Skinweave and generic subdermal armor cover all locations, so rarm has three proportional layers.
  const resolvedRarmAP = resolveArmor(true, targetSnapshot, "rarm");
  assert.equal(resolvedRarmAP.effectiveStoppingPower, 9, "AP halves proportional 18 SP to 9");

  const layeredSnapshot = {
    equippedArmor: [
      {
        id: "soft-jacket",
        name: "Armor Jacket",
        system: {
          equipped: true,
          coverage: {
            torso: { stoppingPower: 10, layer: "soft" }
          }
        }
      },
      {
        id: "hard-plate",
        name: "Hard Plate",
        system: {
          equipped: true,
          coverage: {
            torso: { stoppingPower: 12, layer: "hard" }
          }
        }
      }
    ]
  };

  const layeredArmor = resolveArmor(false, layeredSnapshot, "torso");
  assert.equal(layeredArmor.effectiveStoppingPower, 17, "0-4 SP difference adds +5 to larger SP");
  assert.deepEqual(layeredArmor.layers.map(layer => layer.id), ["soft-jacket", "hard-plate"], "armor layers remain inspectable");

  const coveredArmor = resolveArmor(false, layeredSnapshot, "torso", {
    cover: {
      name: "Concrete Barrier",
      stoppingPower: 8,
      layer: "hard",
      source: "manual cover"
    }
  });
  assert.equal(coveredArmor.effectiveStoppingPower, 25, "cover is resolved first, then personal armor mitigation is added sequentially");
  assert.equal(coveredArmor.layers.at(-1).type, "cover", "manual cover is appended as a cover layer");
  assert.equal(coveredArmor.layers.at(-1).source, "manual cover", "manual cover source is preserved");

  const emptyLocationCover = resolveArmor(false, layeredSnapshot, "torso", {
    cover: {
      name: "Narrow Barrier",
      stoppingPower: 8,
      protectedLocations: [],
      source: "raycast-gm"
    }
  });
  assert.equal(emptyLocationCover.cover.present, false, "empty protected location list bypasses cover for every hit");
  assert.equal(emptyLocationCover.cover.bypassed, true, "bypassed cover remains visible as cover evidence");
  assert.equal(emptyLocationCover.cover.bypassReason, "hit-location-unprotected", "empty protected location list records the bypass reason");

  const aliasedLocationCover = resolveArmor(false, layeredSnapshot, "lArm", {
    cover: {
      name: "Door Frame",
      stoppingPower: 8,
      protectedLocations: ["leftArm"],
      source: "raycast-gm"
    }
  });
  assert.equal(aliasedLocationCover.cover.present, true, "leftArm protected location aliases match lArm hits");
  assert.equal(aliasedLocationCover.cover.effectiveStoppingPower, 8, "aliased protected cover applies full SP before ablation");

  const ablatedCover = resolveArmor(false, layeredSnapshot, "torso", {
    cover: {
      name: "Concrete Barrier",
      stoppingPower: 8,
      ablation: 3,
      protectedLocations: ["Torso"],
      source: "raycast-gm",
      transient: true
    }
  });
  assert.equal(ablatedCover.cover.baseStoppingPower, 8, "cover evidence keeps base SP");
  assert.equal(ablatedCover.cover.ablation, 3, "cover evidence keeps transient ablation");
  assert.equal(ablatedCover.cover.effectiveStoppingPower, 5, "transient cover ablation degrades effective Cover SP");

  const skinweaveAndHardArmor = resolveArmor(false, {
    equippedArmor: [
      {
        id: "hard-plate",
        name: "Hard Plate",
        system: {
          equipped: true,
          coverage: {
            torso: { stoppingPower: 12, layer: "hard" }
          }
        }
      }
    ],
    equippedCyberware: [
      {
        id: "cyberware-skinweave",
        name: "Skinweave SP12",
        system: {
          equipped: true,
          cyberwareSubtype: "SKINWEAVE",
          flavor: "12 SP"
        }
      }
    ]
  }, "torso");
  assert.equal(skinweaveAndHardArmor.warnings.length, 0, "skinweave plus one hard layer is not a multi-hard violation");

  const explicitSkinweaveLayer = getEquippedArmorForLocation({
    equippedCyberware: [
      {
        id: "explicit-skinweave",
        name: "Skinweave SP12",
        system: {
          equipped: true,
          layer: "hard",
          flavor: "12 SP"
        }
      }
    ]
  }, "torso")[0];
  assert.equal(explicitSkinweaveLayer.layer, "hard", "explicit cyberware layer overrides Skinweave default");

  const warningSnapshot = {
    equippedArmor: [
      ...layeredSnapshot.equippedArmor,
      {
        id: "second-hard-plate",
        name: "Second Hard Plate",
        system: {
          equipped: true,
          coverage: {
            torso: { stoppingPower: 8, layer: "hard" }
          }
        }
      }
    ]
  };
  const warningArmor = resolveArmor(false, warningSnapshot, "torso", {
    cover: {
      name: "Concrete Barrier",
      stoppingPower: 8,
      layer: "hard",
      source: "manual cover"
    }
  });
  assert.equal(warningArmor.warnings.length, 1, "cover-specific hard layers do not create false multi-hard warnings against personal armor");
  assert.deepEqual(warningArmor.warnings.map(warning => warning.code), ["armor-multiple-hard-layers"]);

  const casePreservingArmor = resolveArmor(false, {
    equippedArmor: [
      {
        id: "case-vest",
        name: "Case Vest",
        system: {
          equipped: true,
          coverage: {
            Torso: { stoppingPower: 10, ablation: 3, layer: "soft" }
          }
        }
      }
    ]
  }, "torso");
  assert.equal(casePreservingArmor.layers[0].coverageKey, "Torso", "original coverage key case is preserved");
  assert.equal(casePreservingArmor.layers[0].stoppingPower, 7, "existing ablation reduces usable stopping power");
  assert.equal(casePreservingArmor.layers[0].updatePath, "system.coverage.Torso.ablation", "update path preserves original coverage key");
}

async function assertZonedCyberwareArmorHitPlanning() {
  const context = {
    action: {
      type: "ranged",
      fireMode: "semiAuto",
      range: "medium",
      targetNumber: 15,
      options: {
        targetArea: "torso",
        stagedPenetration: true
      }
    },
    attacker: {
      actorUuid: "Actor.attacker",
      name: "Solo",
      snapshot: {
        stats: {
          ref: { total: 8 }
        },
        skills: {
          handgun: { level: 6 }
        }
      }
    },
    weapon: {
      itemUuid: "Actor.attacker.Item.heavy-pistol",
      name: "Heavy Pistol",
      snapshot: {
        damage: "4d6",
        ap: false,
        shotsLeft: 10,
        rof: 2,
        reliability: "standard",
        attackType: "Auto",
        attackSkill: "handgun"
      }
    },
    targets: [
      {
        actorUuid: "Actor.target",
        tokenUuid: "Scene.test.Token.target",
        name: "Target",
        snapshot: {
          stats: {
            bt: { total: 6 }
          },
          damage: 0,
          hitLocations: {
            torso: { label: "Torso" }
          },
          equippedCyberware: [
            {
              id: "zoned-skinweave",
              name: "Skinweave",
              type: "cyberware",
              system: {
                equipped: true,
                cyberwareSubtype: "SKINWEAVE",
                coverage: {
                  Torso: { stoppingPower: 12, ablation: 1, layer: "soft" },
                  rArm: { stoppingPower: 12, ablation: 0, layer: "soft" }
                }
              }
            }
          ]
        }
      }
    ],
    legacy: {
      fallback: () => ({ manualResolution: { required: true }, targets: [] })
    }
  };
  const roller = createScriptedRoller([
    {
      id: "attack",
      total: 21,
      die: { faces: 10, natural: 9, results: [9], exploded: false }
    },
    {
      id: "damage",
      formula: "4d6",
      total: 14,
      die: { faces: 6, natural: 14, results: [4, 4, 3, 3] }
    }
  ]);

  const outcome = await resolveCombatAction(context, { structured: true }, roller);
  roller.assertComplete();
  const hit = outcome.targets[0].hits[0];
  assert.equal(hit.effectiveStoppingPower, 11, "zoned skinweave hit uses ablated SP for the hit location");
  assert.equal(hit.stagedPenetration.updatePath, "system.coverage.Torso.ablation", "zoned skinweave hit records a location-specific update path");

  const plannedUpdates = planCombatUpdates(outcome);
  assert.deepEqual(plannedUpdates.embeddedItemUpdates, [
    {
      actorUuid: "Actor.target",
      type: "Item",
      updates: [
        {
          _id: "zoned-skinweave",
          "system.coverage.Torso.ablation": 2
        }
      ]
    }
  ], "zoned skinweave hit plans ablation only for the struck location");

  const coverContext = {
    action: {
      type: "ranged",
      fireMode: "threeroundburst",
      range: "medium",
      targetNumber: 15,
      targetArea: "torso",
      options: {
        targetArea: "torso",
        stagedPenetration: true
      }
    },
    attacker: {
      actorUuid: "Actor.attacker",
      name: "Solo",
      snapshot: {
        stats: {
          ref: { total: 8 }
        },
        skills: {
          handgun: { level: 6 }
        }
      }
    },
    weapon: {
      itemUuid: "Actor.attacker.Item.heavy-pistol",
      name: "Heavy Pistol",
      snapshot: {
        damage: "4d6",
        ap: false,
        shotsLeft: 3,
        rof: 2,
        reliability: "standard",
        attackType: "Auto",
        attackSkill: "handgun"
      }
    },
    targets: [
      {
        actorUuid: "Actor.target",
        tokenUuid: "Scene.test.Token.target",
        name: "Target",
        tactical: {
          raycast: {
            origin: { x: 0, y: 0 },
            destination: { x: 10, y: 0 },
            obstruction: { id: "wall-1", uuid: "Scene.test.Wall.1", type: "wall", name: "Concrete Wall" },
            obstructionDistance: 4,
            firstTarget: true,
            requiresGmDecision: false
          },
          cover: {
            applies: true,
            stoppingPower: 8,
            protectedLocations: ["Torso"],
            source: "raycast-gm",
            transient: true
          }
        },
        snapshot: {
          stats: {
            bt: { total: 6 }
          },
          damage: 0,
          hitLocations: {
            torso: { label: "Torso" }
          }
        }
      }
    ],
    legacy: {
      fallback: () => ({ manualResolution: { required: true }, targets: [] })
    }
  };
  const coverRoller = createScriptedRoller([
    { id: "attack", total: 24, die: { faces: 10, natural: 10, results: [10], exploded: false } },
    { id: "burst_hits", total: 2, die: { faces: 3, natural: 2, results: [2], exploded: false } },
    { id: "damage", formula: "4d6", total: 10, die: { faces: 6, natural: 10, results: [3, 3, 2, 2] } },
    { id: "damage", formula: "4d6", total: 10, die: { faces: 6, natural: 10, results: [3, 3, 2, 2] } }
  ]);

  const coverOutcome = await resolveCombatAction(coverContext, { structured: true }, coverRoller);
  coverRoller.assertComplete();
  const coverHits = coverOutcome.targets[0].hits;
  assert.equal(coverHits.length, 2, "three-round burst cover fixture produces two hits");
  assert.equal(coverHits[0].cover.effectiveStoppingPower, 8, "first cover hit uses original Cover SP");
  assert.deepEqual(coverHits[0].cover.ablation, { before: 0, after: 1, applied: true }, "first cover hit records transient cover ablation");
  assert.equal(coverHits[1].cover.effectiveStoppingPower, 7, "second cover hit uses transiently ablated Cover SP");
  assert.deepEqual(coverHits[1].cover.protectedLocations, ["Torso"], "cover hit evidence preserves protected locations");
  assert.equal(coverHits[1].cover.mitigation, 7, "cover hit evidence exposes cover mitigation separately");

  const coverChat = buildCombatChatData(coverOutcome);
  assert.equal(coverChat.targets[0].hits[0].cover.ablation.after, 1, "chat data exposes cover ablation evidence");
  assert.deepEqual(coverChat.targets[0].hits[0].cover.protectedLocations, ["Torso"], "chat data exposes protected cover locations");
}

async function assertCombatResolverRouting() {
  const roller = (request) => {
    if (request.id === "attack") {
      return { id: "attack", total: 20, die: { natural: 8 } };
    }
    if (request.id === "location") {
      return { id: "location", total: 4, die: { natural: 4 }, location: "torso" };
    }
    if (request.id === "damage") {
      return { id: "damage", total: 10, die: { natural: 10 } };
    }
    return { total: 10 };
  };
  const context = {
    action: {
      type: "ranged",
      fireMode: "FullAuto",
      range: "close",
      targetNumber: 15
    },
    attacker: {
      snapshot: {
        stats: { ref: { total: 8 } }
      }
    },
    weapon: {
      snapshot: {
        attackSkill: "rifle",
        shotsLeft: 10,
        rof: 10,
        attackType: "Auto"
      }
    },
    targets: [
      {
        snapshot: {
          stats: { bt: { total: 6 } },
          hitLocations: { torso: { label: "Torso" } }
        }
      }
    ],
    legacy: {
      fallback: () => "fallback-called"
    }
  };

  const result = await resolveCombatAction(context, { structured: true }, roller);
  assert.notEqual(result, "fallback-called", "FullAuto should be routed to structured resolver");

  // Multi-target full-auto with sufficient ammo/ROF (ROF 10, targets 2 => roundsFiredPerTarget = Math.floor(10 / 2) = 5)
  const multiTargetContext = {
    ...context,
    weapon: {
      snapshot: {
        attackSkill: "rifle",
        shotsLeft: 10,
        rof: 10,
        attackType: "Auto"
      }
    },
    targets: [
      {
        snapshot: {
          stats: { bt: { total: 6 } },
          hitLocations: { torso: { label: "Torso" } }
        }
      },
      {
        snapshot: {
          stats: { bt: { total: 6 } },
          hitLocations: { torso: { label: "Torso" } }
        }
      }
    ]
  };
  const multiResult = await resolveCombatAction(multiTargetContext, { structured: true }, roller);
  assert.notEqual(multiResult, "fallback-called", "Multi-target FullAuto with sufficient ROF/ammo should be routed to structured resolver");

  // Multi-target full-auto with insufficient ammo (shotsLeft 1, targets 2 => roundsFiredPerTarget = Math.floor(1 / 2) = 0)
  const insufficientAmmoContext = {
    ...multiTargetContext,
    weapon: {
      snapshot: {
        attackSkill: "rifle",
        shotsLeft: 1,
        rof: 10,
        attackType: "Auto"
      }
    }
  };
  const insufficientResult = await resolveCombatAction(insufficientAmmoContext, { structured: true }, roller);
  assert.notEqual(insufficientResult, "fallback-called", "Multi-target FullAuto with roundsFiredPerTarget < 1 should stay structured");
  assert.equal(insufficientResult.manualResolution.required, true, "insufficient multi-target full-auto should be manual");
  assert.equal(insufficientResult.chat.status, "manual", "insufficient multi-target full-auto should produce a manual chat outcome");
  assert.equal(insufficientResult.ammo.delta, 0, "insufficient multi-target full-auto should not spend ammo");

  const semiAutoMultiTargetContext = {
    ...multiTargetContext,
    action: {
      type: "ranged",
      fireMode: "SemiAuto",
      range: "close",
      targetNumber: 15
    }
  };
  const semiAutoMultiResult = await resolveCombatAction(semiAutoMultiTargetContext, { structured: true }, roller);
  assert.notEqual(semiAutoMultiResult, "fallback-called", "SemiAuto multi-target should stay structured");
  assert.equal(semiAutoMultiResult.manualResolution.required, true, "SemiAuto multi-target should be manual");
  assert.match(semiAutoMultiResult.manualResolution.message, /exactly one target/i, "SemiAuto multi-target should explain target count");

  const noTargetContext = {
    ...context,
    action: {
      type: "ranged",
      fireMode: "SemiAuto",
      range: "close",
      targetNumber: 15
    },
    targets: []
  };
  const noTargetResult = await resolveCombatAction(noTargetContext, { structured: true }, roller);
  assert.equal(noTargetResult.manualResolution.required, true, "missing ranged target should be manual");
  assert.match(noTargetResult.manualResolution.message, /select a target/i, "missing target should explain required target selection");

  const manualAttackDieContext = {
    ...context,
    action: {
      type: "ranged",
      fireMode: "SemiAuto",
      range: "close",
      targetNumber: 15
    },
    weapon: {
      snapshot: {
        attackSkill: "rifle",
        shotsLeft: 10,
        rof: 10,
        attackType: "Auto"
      }
    },
    targets: [
      {
        snapshot: {
          stats: { bt: { total: 6 } },
          hitLocations: { torso: { label: "Torso" } }
        }
      }
    ]
  };
  const manualAttackDieResult = await resolveCombatAction(manualAttackDieContext, { structured: true, manualAttackDie: "10,7" }, roller);
  assert.equal(manualAttackDieResult.targets[0].attack.roll.total, 25, "manual ranged attack die applies before stat and skill math");
  assert.deepEqual(manualAttackDieResult.targets[0].attack.roll.die.results, [10, 7], "manual ranged attack die records the physical dice");

  const manualMeleeResult = await resolveCombatAction({
    action: { type: "melee" },
    attacker: {
      snapshot: {
        stats: { ref: { total: 9 }, bt: { total: 6 } },
        skills: { melee: { level: 5 } }
      }
    },
    weapon: {
      snapshot: {
        attackSkill: "melee",
        damage: "1d6",
        attackType: "Melee"
      }
    },
    targets: [
      {
        snapshot: {
          stats: { ref: { total: 6 }, bt: { total: 8 } },
          skills: { brawling: { level: 3 }, melee: { level: 4 } },
          hitLocations: { torso: { label: "Torso" } }
        }
      }
    ],
    legacy: { fallback: () => "fallback-called" }
  }, { structured: true, manualAttackDie: "9" }, createScriptedRoller([
    { id: "defend", total: 30, die: { faces: 10, natural: 10, results: [10], exploded: false } }
  ]));
  assert.equal(manualMeleeResult.targets[0].attack.roll.total, 23, "manual melee attack die applies before stat and skill math");
  assert.deepEqual(manualMeleeResult.targets[0].attack.roll.die.results, [9], "manual melee attack die records the physical die");

  const manualMartialResult = await resolveCombatAction({
    action: {
      type: "martial",
      meleeAction: "Strike",
      options: { martialArt: "karate" }
    },
    attacker: {
      snapshot: {
        stats: { ref: { total: 9 }, bt: { total: 6 } },
        skills: { karate: { level: 5 } }
      }
    },
    weapon: {
      snapshot: {
        attackSkill: null,
        damage: "1d3",
        attackType: "Martial"
      }
    },
    targets: [
      {
        snapshot: {
          stats: { ref: { total: 6 }, bt: { total: 8 } },
          skills: { brawling: { level: 3 } },
          hitLocations: { torso: { label: "Torso" } }
        }
      }
    ],
    legacy: { fallback: () => "fallback-called" }
  }, { structured: true, manualAttackDie: "10,10" }, createScriptedRoller([
    { id: "defend", total: 40, die: { faces: 10, natural: 10, results: [10], exploded: false } }
  ]));
  assert.equal(manualMartialResult.targets[0].attack.roll.total, 36, "manual martial attack die applies before stat, skill, and key technique math");
  assert.deepEqual(manualMartialResult.targets[0].attack.roll.die.results, [10, 10], "manual martial attack die records one explosion pair");

  await assert.rejects(
    () => resolveCombatAction(manualAttackDieContext, { structured: true, manualAttackDie: "10" }, roller),
    /explosion/i,
    "manual attack die 10 requires one explosion follow-up"
  );
  await assert.rejects(
    () => resolveCombatAction(manualAttackDieContext, { structured: true, manualAttackDie: "10,10,4" }, roller),
    /explosion/i,
    "manual attack die rejects chained explosions"
  );

  const zeroRofContext = {
    ...context,
    weapon: {
      snapshot: {
        attackSkill: "rifle",
        shotsLeft: 10,
        rof: 0,
        attackType: "Auto"
      }
    }
  };
  const zeroRofResult = await resolveCombatAction(zeroRofContext, { structured: true }, roller);
  assert.equal(zeroRofResult.manualResolution.required, true, "FullAuto with zero ROF should be manual");
  assert.match(zeroRofResult.manualResolution.message, /positive weapon ROF/i, "zero ROF should explain invalid ROF");

  const zeroAmmoFullAutoContext = {
    ...context,
    weapon: {
      snapshot: {
        attackSkill: "rifle",
        shotsLeft: 0,
        rof: 10,
        attackType: "Auto"
      }
    }
  };
  const zeroAmmoFullAutoResult = await resolveCombatAction(zeroAmmoFullAutoContext, { structured: true }, roller);
  assert.notEqual(zeroAmmoFullAutoResult, "fallback-called", "FullAuto with zero ammo should stay structured");
  assert.equal(zeroAmmoFullAutoResult.manualResolution.required, true, "FullAuto with zero ammo should be manual");
  assert.equal(zeroAmmoFullAutoResult.warnings[0].code, "insufficient-ammo", "FullAuto with zero ammo should warn about ammo");

  const zeroAmmoBurstContext = {
    ...context,
    action: {
      type: "ranged",
      fireMode: "ThreeRoundBurst",
      range: "close",
      targetNumber: 15
    },
    weapon: {
      snapshot: {
        attackSkill: "rifle",
        shotsLeft: 0,
        rof: 10,
        attackType: "Auto"
      }
    }
  };
  const zeroAmmoBurstResult = await resolveCombatAction(zeroAmmoBurstContext, { structured: true }, roller);
  assert.notEqual(zeroAmmoBurstResult, "fallback-called", "ThreeRoundBurst with zero ammo should stay structured");
  assert.equal(zeroAmmoBurstResult.manualResolution.required, true, "ThreeRoundBurst with zero ammo should be manual");
  assert.equal(zeroAmmoBurstResult.warnings[0].code, "insufficient-ammo", "ThreeRoundBurst with zero ammo should warn about ammo");
}

async function assertAutoshotgunFullAutoOverlapResolution() {
  const overlappingTarget = {
    id: "target-autoshotgun-overlap",
    tokenUuid: "Scene.test.Token.autoshotgunTarget",
    actorUuid: "Actor.autoshotgunTarget",
    name: "Autoshotgun Overlap Target",
    snapshot: {
      stats: { bt: { total: 6 } },
      damage: 0,
      hitLocations: {
        torso: { label: "Torso" }
      }
    }
  };
  const context = {
    action: {
      type: "ranged",
      fireMode: "FullAuto",
      range: "medium",
      targetNumber: 20,
      autoshotgunPatterns: [
        {
          shellIndex: 1,
          template: {
            templateUuid: "Scene.test.MeasuredTemplate.autoshotgun-1",
            templateId: "autoshotgun-1",
            type: "cone",
            origin: { x: 0, y: 0 },
            direction: 0,
            angle: 45,
            distance: 20,
            targetDistance: 20,
            inclusion: "intersected"
          },
          affectedTargets: [overlappingTarget]
        },
        {
          shellIndex: 2,
          template: {
            templateUuid: "Scene.test.MeasuredTemplate.autoshotgun-2",
            templateId: "autoshotgun-2",
            type: "cone",
            origin: { x: 0.5, y: 0 },
            direction: 0,
            angle: 45,
            distance: 20,
            targetDistance: 20,
            inclusion: "intersected"
          },
          affectedTargets: [overlappingTarget]
        }
      ]
    },
    attacker: {
      actorUuid: "Actor.autoshotgunAttacker",
      snapshot: {
        stats: { ref: { total: 8 } },
        skills: { shotgun: { level: 6 } }
      }
    },
    weapon: {
      itemUuid: "Actor.autoshotgunAttacker.Item.autoshotgun",
      name: "CAWS",
      snapshot: {
        attackSkill: "shotgun",
        attackType: "Autoshotgun",
        shotsLeft: 6,
        rof: 2,
        range: 50,
        accuracy: 0,
        damage: "4d6",
        rangeDamages: {
          pointBlank: "4d6",
          close: "4d6",
          medium: "3d6",
          far: "2d6"
        }
      }
    },
    targets: [overlappingTarget],
    legacy: {
      fallback: () => "fallback-called"
    }
  };
  const roller = createScriptedRoller([
    { id: "attack", total: 24, die: { faces: 10, natural: 10, results: [10], exploded: false } },
    { id: "location", total: 2, die: { faces: 10, natural: 2, results: [2], exploded: false } },
    { id: "damage", formula: "3d6", total: 11, die: { faces: 6, natural: 5, results: [5, 4, 2] } },
    {
      id: "attack",
      total: 22,
      die: { faces: 10, natural: 8, results: [8], exploded: false },
      expectedRequest: {
        rollData: {
          modifier: {
            extraMod: -2
          }
        }
      }
    },
    { id: "location", total: 3, die: { faces: 10, natural: 3, results: [3], exploded: false } },
    { id: "damage", formula: "3d6", total: 9, die: { faces: 6, natural: 4, results: [4, 3, 2] } }
  ]);

  const outcome = await resolveCombatAction(context, { structured: true }, roller);
  roller.assertComplete();

  assert.notEqual(outcome, "fallback-called", "Autoshotgun FullAuto should use structured resolver");
  assert.equal(outcome.manualResolution.required, false, "overlapping autoshotgun patterns should resolve without manual fallback");
  assert.equal(outcome.ammo.delta, -2, "autoshotgun spends the declared shell count");
  assert.equal(outcome.targets.length, 1, "overlapping patterns keep one target outcome per affected token");
  assert.equal(outcome.targets[0].hits.length, 2, "target caught by two successful patterns receives two hit records");
  assert.equal(outcome.targets[0].hits[0].autoshotgun.shellIndex, 1, "first hit preserves shell evidence");
  assert.equal(outcome.targets[0].hits[0].shotgun.templateId, "autoshotgun-1", "first hit preserves pattern evidence");
  assert.equal(outcome.targets[0].hits[1].autoshotgun.shellIndex, 2, "second hit preserves shell evidence");
  assert.equal(outcome.targets[0].hits[1].shotgun.templateId, "autoshotgun-2", "second hit preserves pattern evidence");

  const chatData = buildCombatChatData(outcome);
  assert.equal(chatData.targets[0].hits[0].autoshotgun.shellIndex, 1, "chat data preserves autoshotgun shell evidence");
}

async function assertAutoshotgunMissedShellPreservesEvidence() {
  const target = {
    id: "target-autoshotgun-miss",
    tokenUuid: "Scene.test.Token.autoshotgunMissTarget",
    actorUuid: "Actor.autoshotgunMissTarget",
    name: "Autoshotgun Miss Target",
    snapshot: {
      stats: { bt: { total: 6 } },
      damage: 0,
      hitLocations: {
        torso: { label: "Torso" }
      }
    }
  };
  const context = {
    action: {
      type: "ranged",
      fireMode: "FullAuto",
      range: "medium",
      targetNumber: 20,
      autoshotgunPatterns: [
        {
          shellIndex: 1,
          template: {
            templateUuid: "Scene.test.MeasuredTemplate.autoshotgun-hit",
            templateId: "autoshotgun-hit",
            type: "cone",
            origin: { x: 0, y: 0 },
            direction: 0,
            angle: 45,
            distance: 20,
            targetDistance: 20,
            inclusion: "intersected"
          },
          affectedTargets: [target]
        },
        {
          shellIndex: 2,
          template: {
            templateUuid: "Scene.test.MeasuredTemplate.autoshotgun-miss",
            templateId: "autoshotgun-miss",
            type: "cone",
            origin: { x: 0.5, y: 0 },
            direction: 0,
            angle: 45,
            distance: 20,
            targetDistance: 20,
            inclusion: "intersected"
          },
          affectedTargets: [target]
        }
      ]
    },
    attacker: {
      actorUuid: "Actor.autoshotgunAttacker",
      snapshot: {
        stats: { ref: { total: 8 } },
        skills: { shotgun: { level: 6 } }
      }
    },
    weapon: {
      itemUuid: "Actor.autoshotgunAttacker.Item.autoshotgun",
      name: "CAWS",
      snapshot: {
        attackSkill: "shotgun",
        attackType: "Autoshotgun",
        shotsLeft: 6,
        rof: 2,
        range: 50,
        accuracy: 0,
        damage: "4d6",
        rangeDamages: {
          pointBlank: "4d6",
          close: "4d6",
          medium: "3d6",
          far: "2d6"
        }
      }
    },
    targets: [target],
    legacy: {
      fallback: () => "fallback-called"
    }
  };
  const roller = createScriptedRoller([
    { id: "attack", total: 24, die: { faces: 10, natural: 10, results: [10], exploded: false } },
    { id: "location", total: 2, die: { faces: 10, natural: 2, results: [2], exploded: false } },
    { id: "damage", formula: "3d6", total: 11, die: { faces: 6, natural: 5, results: [5, 4, 2] } },
    { id: "attack", total: 19, die: { faces: 10, natural: 5, results: [5], exploded: false } }
  ]);

  const outcome = await resolveCombatAction(context, { structured: true }, roller);
  roller.assertComplete();

  assert.equal(outcome.ammo.delta, -2, "missed autoshotgun shell still spends declared ammo");
  assert.equal(outcome.action.autoshotgun.shells.length, 2, "outcome preserves one evidence record per shell");
  assert.equal(outcome.action.autoshotgun.shells[0].attack.hit, true, "first shell evidence records hit");
  assert.equal(outcome.action.autoshotgun.shells[1].attack.hit, false, "missed shell evidence records miss");
  assert.equal(outcome.action.autoshotgun.shells[1].pattern.templateId, "autoshotgun-miss", "missed shell preserves pattern evidence");
  assert.equal(outcome.targets.length, 1, "missed shell does not create an extra target outcome");
  assert.equal(outcome.targets[0].hits.length, 1, "missed shell creates no damage hit");
}

async function assertAutoshotgunCloseRangeDamageIsRolled() {
  const target = {
    id: "target-autoshotgun-close",
    tokenUuid: "Scene.test.Token.autoshotgunCloseTarget",
    actorUuid: "Actor.autoshotgunCloseTarget",
    name: "Autoshotgun Close Target",
    snapshot: {
      stats: { bt: { total: 6 } },
      damage: 0,
      hitLocations: {
        torso: { label: "Torso" }
      }
    }
  };
  const context = {
    action: {
      type: "ranged",
      fireMode: "FullAuto",
      range: "close",
      targetNumber: 15,
      autoshotgunPatterns: [
        {
          shellIndex: 1,
          template: {
            templateUuid: "Scene.test.MeasuredTemplate.autoshotgun-close",
            templateId: "autoshotgun-close",
            type: "cone",
            origin: { x: 0, y: 0 },
            direction: 0,
            angle: 45,
            distance: 20,
            targetDistance: 5,
            inclusion: "intersected"
          },
          affectedTargets: [target]
        }
      ]
    },
    attacker: {
      actorUuid: "Actor.autoshotgunAttacker",
      snapshot: {
        stats: { ref: { total: 8 } },
        skills: { shotgun: { level: 6 } }
      }
    },
    weapon: {
      itemUuid: "Actor.autoshotgunAttacker.Item.autoshotgun",
      name: "CAWS",
      snapshot: {
        attackSkill: "shotgun",
        attackType: "Autoshotgun",
        shotsLeft: 6,
        rof: 2,
        range: 50,
        accuracy: 0,
        damage: "5d6",
        rangeDamages: {
          pointBlank: "5d6",
          close: "5d6",
          medium: "4d6",
          far: "3d6"
        }
      }
    },
    targets: [target],
    legacy: {
      fallback: () => "fallback-called"
    }
  };
  const roller = createScriptedRoller([
    { id: "attack", total: 19, die: { faces: 10, natural: 9, results: [9], exploded: false } },
    { id: "location", total: 3, die: { faces: 10, natural: 3, results: [3], exploded: false } },
    {
      id: "damage",
      formula: "5d6",
      total: 17,
      die: { faces: 6, natural: 6, results: [6, 4, 3, 2, 2] },
      expectedRequest: {
        formula: "5d6"
      }
    }
  ]);

  const outcome = await resolveCombatAction(context, { structured: true }, roller);
  roller.assertComplete();

  assert.equal(outcome.manualResolution.required, false, "close autoshotgun pattern should resolve without manual fallback");
  assert.equal(outcome.targets[0].hits[0].shotgun.bracket, "close", "5m target uses close shotgun damage band for range 50 weapon");
  assert.equal(outcome.targets[0].hits[0].shotgun.measuredDistance.value, 5, "shotgun evidence preserves measured template distance");
  assert.equal(outcome.targets[0].hits[0].damageRoll.total, 17, "close shotgun damage should use rolled damage, not maximum damage");
  assert.equal(outcome.targets[0].hits[0].rawDamage, 17, "raw damage should come from the close damage roll");
}

async function assertAutoshotgunPointBlankDamageBand() {
  const target = {
    id: "target-autoshotgun-pointblank",
    tokenUuid: "Scene.test.Token.autoshotgunPointBlankTarget",
    actorUuid: "Actor.autoshotgunPointBlankTarget",
    name: "Autoshotgun Point Blank Target",
    snapshot: {
      stats: { bt: { total: 6 } },
      damage: 0,
      hitLocations: {
        torso: { label: "Torso" }
      }
    }
  };
  const context = {
    action: {
      type: "ranged",
      fireMode: "FullAuto",
      range: "close",
      targetNumber: 15,
      autoshotgunPatterns: [
        {
          shellIndex: 1,
          template: {
            templateUuid: "Scene.test.MeasuredTemplate.autoshotgun-pointblank",
            templateId: "autoshotgun-pointblank",
            type: "cone",
            origin: { x: 0, y: 0 },
            direction: 0,
            angle: 45,
            distance: 20,
            targetDistance: 1,
            inclusion: "intersected"
          },
          affectedTargets: [target]
        }
      ]
    },
    attacker: {
      actorUuid: "Actor.autoshotgunAttacker",
      snapshot: {
        stats: { ref: { total: 8 } },
        skills: { shotgun: { level: 6 } }
      }
    },
    weapon: {
      itemUuid: "Actor.autoshotgunAttacker.Item.autoshotgun",
      name: "CAWS",
      snapshot: {
        attackSkill: "shotgun",
        attackType: "Autoshotgun",
        shotsLeft: 6,
        rof: 2,
        range: 50,
        accuracy: 0,
        damage: "5d6",
        rangeDamages: {
          pointBlank: "6d6",
          close: "5d6",
          medium: "4d6",
          far: "3d6"
        }
      }
    },
    targets: [target],
    legacy: {
      fallback: () => "fallback-called"
    }
  };
  const roller = createScriptedRoller([
    { id: "attack", total: 19, die: { faces: 10, natural: 9, results: [9], exploded: false } },
    { id: "location", total: 3, die: { faces: 10, natural: 3, results: [3], exploded: false } }
  ]);

  const outcome = await resolveCombatAction(context, { structured: true }, roller);
  roller.assertComplete();

  assert.equal(outcome.manualResolution.required, false, "point blank autoshotgun pattern should resolve without manual fallback");
  assert.equal(outcome.targets[0].hits[0].shotgun.bracket, "pointBlank", "1m target uses pointBlank shotgun damage band");
  assert.equal(outcome.targets[0].hits[0].shotgun.damageFormula, "6d6", "pointBlank band uses explicit pointBlank shotgun damage formula");
  assert.equal(outcome.targets[0].hits[0].damageRoll.total, 36, "pointBlank shotgun damage should use maximum damage");
  assert.equal(outcome.targets[0].hits[0].damageRoll.maximized, true, "pointBlank shotgun maximum damage is recorded in roll evidence");
}

async function assertAutoshotgunPointBlankFallsBackToCloseDamage() {
  const target = {
    id: "target-autoshotgun-pointblank-fallback",
    tokenUuid: "Scene.test.Token.autoshotgunPointBlankFallbackTarget",
    actorUuid: "Actor.autoshotgunPointBlankFallbackTarget",
    name: "Autoshotgun Point Blank Fallback Target",
    snapshot: {
      stats: { bt: { total: 6 } },
      damage: 0,
      hitLocations: {
        torso: { label: "Torso" }
      }
    }
  };
  const context = {
    action: {
      type: "ranged",
      fireMode: "FullAuto",
      range: "close",
      targetNumber: 15,
      autoshotgunPatterns: [
        {
          shellIndex: 1,
          template: {
            templateUuid: "Scene.test.MeasuredTemplate.autoshotgun-pointblank-fallback",
            templateId: "autoshotgun-pointblank-fallback",
            type: "cone",
            origin: { x: 0, y: 0 },
            direction: 0,
            angle: 45,
            distance: 20,
            targetDistance: 1,
            inclusion: "intersected"
          },
          affectedTargets: [target]
        }
      ]
    },
    attacker: {
      actorUuid: "Actor.autoshotgunAttacker",
      snapshot: {
        stats: { ref: { total: 8 } },
        skills: { shotgun: { level: 6 } }
      }
    },
    weapon: {
      itemUuid: "Actor.autoshotgunAttacker.Item.autoshotgun",
      name: "CAWS",
      snapshot: {
        attackSkill: "shotgun",
        attackType: "Autoshotgun",
        shotsLeft: 6,
        rof: 2,
        range: 50,
        accuracy: 0,
        damage: "5d6",
        rangeDamages: {
          close: "5d6",
          medium: "4d6",
          far: "3d6"
        }
      }
    },
    targets: [target],
    legacy: {
      fallback: () => "fallback-called"
    }
  };
  const roller = createScriptedRoller([
    { id: "attack", total: 19, die: { faces: 10, natural: 9, results: [9], exploded: false } },
    { id: "location", total: 3, die: { faces: 10, natural: 3, results: [3], exploded: false } }
  ]);

  const outcome = await resolveCombatAction(context, { structured: true }, roller);
  roller.assertComplete();

  assert.equal(outcome.manualResolution.required, false, "point blank autoshotgun can fall back to close damage formula");
  assert.equal(outcome.targets[0].hits[0].shotgun.bracket, "pointBlank", "fallback keeps pointBlank distance evidence");
  assert.equal(outcome.targets[0].hits[0].shotgun.damageFormula, "5d6", "pointBlank fallback uses close shotgun damage formula");
  assert.equal(outcome.targets[0].hits[0].damageRoll.total, 30, "pointBlank fallback close damage should use maximum damage");
  assert.equal(outcome.targets[0].hits[0].damageRoll.maximized, true, "pointBlank fallback maximum damage is recorded in roll evidence");
}

async function assertAutoshotgunPatternAdjacencyWarning() {
  const target = {
    id: "target-autoshotgun-adjacency",
    tokenUuid: "Scene.test.Token.autoshotgunAdjacencyTarget",
    actorUuid: "Actor.autoshotgunAdjacencyTarget",
    name: "Autoshotgun Adjacency Target",
    snapshot: {
      stats: { bt: { total: 6 } },
      damage: 0,
      hitLocations: {
        torso: { label: "Torso" }
      }
    }
  };
  const context = {
    action: {
      type: "ranged",
      fireMode: "FullAuto",
      range: "medium",
      targetNumber: 20,
      autoshotgunPatterns: [
        {
          shellIndex: 1,
          template: {
            templateUuid: "Scene.test.MeasuredTemplate.autoshotgun-adjacent-1",
            templateId: "autoshotgun-adjacent-1",
            type: "cone",
            origin: { x: 0, y: 0 },
            direction: 0,
            angle: 45,
            distance: 20,
            targetDistance: 20,
            inclusion: "intersected"
          },
          affectedTargets: [target]
        },
        {
          shellIndex: 2,
          template: {
            templateUuid: "Scene.test.MeasuredTemplate.autoshotgun-adjacent-2",
            templateId: "autoshotgun-adjacent-2",
            type: "cone",
            origin: { x: 3, y: 0 },
            direction: 0,
            angle: 45,
            distance: 20,
            targetDistance: 20,
            inclusion: "intersected"
          },
          affectedTargets: [target]
        }
      ]
    },
    attacker: {
      actorUuid: "Actor.autoshotgunAttacker",
      snapshot: {
        stats: { ref: { total: 8 } },
        skills: { shotgun: { level: 6 } }
      }
    },
    weapon: {
      itemUuid: "Actor.autoshotgunAttacker.Item.autoshotgun",
      name: "CAWS",
      snapshot: {
        attackSkill: "shotgun",
        attackType: "Autoshotgun",
        shotsLeft: 6,
        rof: 2,
        range: 50,
        accuracy: 0,
        damage: "4d6",
        rangeDamages: {
          pointBlank: "4d6",
          close: "4d6",
          medium: "3d6",
          far: "2d6"
        }
      }
    },
    targets: [target],
    legacy: {
      fallback: () => "fallback-called"
    }
  };
  const roller = createScriptedRoller([
    { id: "attack", total: 24, die: { faces: 10, natural: 10, results: [10], exploded: false } },
    { id: "location", total: 2, die: { faces: 10, natural: 2, results: [2], exploded: false } },
    { id: "damage", formula: "3d6", total: 11, die: { faces: 6, natural: 5, results: [5, 4, 2] } },
    { id: "attack", total: 22, die: { faces: 10, natural: 8, results: [8], exploded: false } },
    { id: "location", total: 3, die: { faces: 10, natural: 3, results: [3], exploded: false } },
    { id: "damage", formula: "3d6", total: 9, die: { faces: 6, natural: 4, results: [4, 3, 2] } }
  ]);

  const outcome = await resolveCombatAction(context, { structured: true }, roller);
  roller.assertComplete();

  assert.equal(outcome.targets[0].hits.length, 2, "adjacency warning should not hard-block autoshotgun resolution");
  assert.ok(outcome.warnings.some(warning => warning.code === "autoshotgun-pattern-adjacency"), "autoshotgun warns when consecutive patterns are more than 1m apart");
}

async function assertAutoshotgunExtremeRangeRequiresManualResolution() {
  const target = {
    id: "target-autoshotgun-extreme",
    tokenUuid: "Scene.test.Token.autoshotgunExtremeTarget",
    actorUuid: "Actor.autoshotgunExtremeTarget",
    name: "Autoshotgun Extreme Target",
    snapshot: {
      stats: { bt: { total: 6 } },
      damage: 0,
      hitLocations: {
        torso: { label: "Torso" }
      }
    }
  };
  const context = {
    action: {
      type: "ranged",
      fireMode: "FullAuto",
      range: "extreme",
      targetNumber: 30,
      autoshotgunPatterns: [
        {
          shellIndex: 1,
          template: {
            templateUuid: "Scene.test.MeasuredTemplate.autoshotgun-extreme",
            templateId: "autoshotgun-extreme",
            type: "cone",
            origin: { x: 0, y: 0 },
            direction: 0,
            angle: 45,
            distance: 100,
            targetDistance: 75,
            inclusion: "intersected"
          },
          affectedTargets: [target]
        }
      ]
    },
    attacker: {
      actorUuid: "Actor.autoshotgunAttacker",
      snapshot: {
        stats: { ref: { total: 8 } },
        skills: { shotgun: { level: 6 } }
      }
    },
    weapon: {
      itemUuid: "Actor.autoshotgunAttacker.Item.autoshotgun",
      name: "CAWS",
      snapshot: {
        attackSkill: "shotgun",
        attackType: "Autoshotgun",
        shotsLeft: 6,
        rof: 2,
        range: 50,
        accuracy: 0,
        damage: "4d6",
        rangeDamages: {
          pointBlank: "4d6",
          close: "4d6",
          medium: "3d6",
          far: "2d6"
        }
      }
    },
    targets: [target],
    legacy: {
      fallback: () => "fallback-called"
    }
  };
  const roller = createScriptedRoller([
    { id: "attack", total: 32, die: { faces: 10, natural: 10, results: [10], exploded: false } },
    { id: "location", total: 2, die: { faces: 10, natural: 2, results: [2], exploded: false } }
  ]);

  const outcome = await resolveCombatAction(context, { structured: true }, roller);
  roller.assertComplete();

  assert.equal(outcome.manualResolution.required, true, "extreme-range autoshotgun pattern should require manual resolution");
  assert.match(outcome.manualResolution.message, /extreme/i, "manual resolution explains undefined extreme-range shotgun damage");
  assert.equal(outcome.ammo.delta, -1, "manual extreme-range autoshotgun still plans declared ammo spending");
  assert.equal(outcome.targets[0].hits.length, 1, "extreme-range manual outcome preserves hit location evidence");
  assert.equal(outcome.targets[0].hits[0].damageRoll, undefined, "extreme-range manual outcome does not roll far damage silently");
}

async function assertAutoshotgunShellCountBoundedByRofAndAmmo() {
  const target = {
    id: "target-autoshotgun-shell-bound",
    tokenUuid: "Scene.test.Token.autoshotgunShellBoundTarget",
    actorUuid: "Actor.autoshotgunShellBoundTarget",
    name: "Autoshotgun Shell Bound Target",
    snapshot: {
      stats: { bt: { total: 6 } },
      damage: 0,
      hitLocations: {
        torso: { label: "Torso" }
      }
    }
  };
  const context = {
    action: {
      type: "ranged",
      fireMode: "FullAuto",
      range: "medium",
      targetNumber: 20,
      autoshotgunPatterns: [
        { shellIndex: 1, template: { templateId: "shell-1", type: "cone", origin: { x: 0, y: 0 }, targetDistance: 20, inclusion: "intersected" }, affectedTargets: [target] },
        { shellIndex: 2, template: { templateId: "shell-2", type: "cone", origin: { x: 0.5, y: 0 }, targetDistance: 20, inclusion: "intersected" }, affectedTargets: [target] },
        { shellIndex: 3, template: { templateId: "shell-3", type: "cone", origin: { x: 1, y: 0 }, targetDistance: 20, inclusion: "intersected" }, affectedTargets: [target] }
      ]
    },
    attacker: {
      actorUuid: "Actor.autoshotgunAttacker",
      snapshot: {
        stats: { ref: { total: 8 } },
        skills: { shotgun: { level: 6 } }
      }
    },
    weapon: {
      itemUuid: "Actor.autoshotgunAttacker.Item.autoshotgun",
      name: "CAWS",
      snapshot: {
        attackSkill: "shotgun",
        attackType: "Autoshotgun",
        shotsLeft: 6,
        rof: 2,
        range: 50,
        accuracy: 0,
        damage: "4d6",
        rangeDamages: {
          pointBlank: "4d6",
          close: "4d6",
          medium: "3d6",
          far: "2d6"
        }
      }
    },
    targets: [target],
    legacy: {
      fallback: () => "fallback-called"
    }
  };
  const roller = createScriptedRoller([]);

  const outcome = await resolveCombatAction(context, { structured: true }, roller);
  roller.assertComplete();

  assert.equal(outcome.manualResolution.required, true, "autoshotgun shell count beyond ROF should require manual correction");
  assert.match(outcome.manualResolution.message, /rof/i, "shell count manual resolution explains ROF bound");
  assert.equal(outcome.ammo.delta, 0, "invalid autoshotgun shell count should not spend ammo");
  assert.equal(outcome.targets.length, 0, "invalid autoshotgun shell count should not resolve target damage");
}

async function assertAutoshotgunMissingPatternRequiresManualResolution() {
  const context = {
    action: {
      type: "ranged",
      fireMode: "FullAuto",
      range: "medium",
      targetNumber: 20,
      autoshotgunPatterns: [
        {
          shellIndex: 1,
          affectedTargets: [],
          warnings: [{
            code: "autoshotgun-pattern-canceled",
            severity: "warning",
            message: "Autoshotgun shell 1 has no template evidence; resolve this shell manually."
          }]
        }
      ]
    },
    attacker: {
      actorUuid: "Actor.autoshotgunAttacker",
      snapshot: {
        stats: { ref: { total: 8 } },
        skills: { shotgun: { level: 6 } }
      }
    },
    weapon: {
      itemUuid: "Actor.autoshotgunAttacker.Item.autoshotgun",
      name: "CAWS",
      snapshot: {
        attackSkill: "shotgun",
        attackType: "Autoshotgun",
        shotsLeft: 6,
        rof: 2,
        range: 50,
        accuracy: 0,
        damage: "4d6",
        rangeDamages: {
          pointBlank: "4d6",
          close: "4d6",
          medium: "3d6",
          far: "2d6"
        }
      }
    },
    targets: [],
    legacy: {
      fallback: () => "fallback-called"
    }
  };
  const roller = createScriptedRoller([]);

  const outcome = await resolveCombatAction(context, { structured: true }, roller);
  roller.assertComplete();

  assert.equal(outcome.manualResolution.required, true, "missing autoshotgun pattern evidence should require manual resolution");
  assert.match(outcome.manualResolution.message, /template/i, "missing pattern manual resolution explains template evidence");
  assert.equal(outcome.ammo.delta, 0, "missing autoshotgun pattern evidence should not spend ammo automatically");
  assert.ok(outcome.warnings.some(warning => warning.code === "autoshotgun-pattern-canceled"), "missing autoshotgun pattern preserves adapter warning");
}

function assertCyberpunkItemAdapterPreservesAutoshotgunPatterns() {
  const item = Object.create(CyberpunkItem.prototype);
  item.uuid = "Actor.autoshotgunAttacker.Item.autoshotgun";
  item.name = "CAWS";
  item.actor = {
    uuid: "Actor.autoshotgunAttacker",
    name: "Solo",
    system: {
      stats: { ref: { total: 8 } },
      skills: { shotgun: { level: 6 } },
      hitLocations: {}
    },
    itemTypes: {}
  };
  item.system = {
    weaponType: "Shotgun",
    attackType: "Autoshotgun",
    attackSkill: "shotgun",
    shotsLeft: 6,
    rof: 2,
    range: 50,
    rangeDamages: {
      medium: "3d6"
    }
  };

  const autoshotgunPatterns = [
    {
      shellIndex: 1,
      template: { templateId: "autoshotgun-adapter-1", type: "cone", origin: { x: 0, y: 0 }, targetDistance: 20, inclusion: "intersected" },
      affectedTargets: [{ id: "target-1", actorUuid: "Actor.target" }]
    }
  ];
  const context = item.__buildCombatResolverContext({
    fireMode: "FullAuto",
    range: "medium",
    autoshotgunPatterns
  }, []);

  assert.deepEqual(context.action.autoshotgunPatterns, autoshotgunPatterns, "CyberpunkItem adapter preserves autoshotgun pattern intent for resolver");
}

function assertSettingsHelpers() {
  const originalGame = global.game;

  try {
    // 1. Default (no game object): should return true
    delete global.game;
    assert.equal(isCorebookFidelityEnabled(), true);
    assert.deepEqual(filterSupportedFireModes(["FullAuto", "Suppressive"]), ["FullAuto"]);
    assert.equal(getAttackDieEntryMode(), "auto");
    assert.equal(getAttackDieEntryMode({ options: { attackDieEntryMode: "prompt" } }), "prompt");

    // 2. Corebook Fidelity ON
    global.game = { system: { id: "cyberpunk2020" }, settings: { get: () => true } };
    assert.equal(isCorebookFidelityEnabled(), true);
    assert.deepEqual(filterSupportedFireModes(["FullAuto", "Suppressive"]), ["FullAuto"]);

    // 3. Corebook Fidelity OFF (relaxed mode)
    global.game = { system: { id: "cyberpunk2020" }, settings: { get: () => false } };
    assert.equal(isCorebookFidelityEnabled(), false);
    assert.deepEqual(filterSupportedFireModes(["FullAuto", "Suppressive"]), ["FullAuto", "Suppressive"]);
  } finally {
    // Restore
    global.game = originalGame;
  }
}
