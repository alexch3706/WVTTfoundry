import assert from "node:assert/strict";

import {
  assertNoInvalidMigrationDocuments,
  convertOldSkill,
  isMigratableCompendium,
  isPrimaryActiveGM,
  migrateCompendium,
  migrateItem,
  migrateSyntheticTokenActors,
  migrateWorld
} from "../../module/migrate.js";

export async function runMigrationTests() {
  const previousGame = globalThis.game;
  const settingValues = new Map([["migrationPendingPackRelocks", "[]"]]);
  globalThis.game = {
    i18n: {
      has: () => false,
      localize: key => key
    },
    model: {
      Item: {
        weapon: {
          templates: ["common"],
          rangeDamages: {
            pointBlank: "",
            close: "",
            medium: "",
            far: ""
          }
        },
        skill: {
          templates: ["common"]
        }
      }
    },
    settings: {
      get: (_systemId, key) => settingValues.get(key) ?? false,
      async set(_systemId, key, value) {
        settingValues.set(key, value);
        return value;
      }
    },
    system: { id: "cyberpunk2020-rilerena" }
  };

  try {
    assertLegacySkillChipMigration();
    assertEnabledLegacySkillChipIsPreserved();
    assertLegacyShotgunRangeMigration();
    assertCurrentCloseDamageWinsOverLegacyShort();
    assertLegacyRangeDamageArrayIsConverted();
    assertMissingRangeDamageDefaultsUseCurrentSchema();
    await assertNumericActorDamageIsPreserved();
    await assertInvalidLegacyDamageFailsClosed();
    await assertIntentionalTokenSettingsArePreserved();
    await assertMissingTokenDefaultsAreMigrated();
    await assertLegacyTokenVisionUsesV14Paths();
    await assertLegacyActorSkillsAreConvertedWithoutUndefinedDeletes();
    await assertSourceOnlyLegacySkillsAreLocaleIndependent();
    await assertConcreteItemProgressWinsStaleLegacySkills();
    assertSingleActiveGmOwnsAutomaticMigration();
    await assertSyntheticTokenActorDeltasAreMigrated();
    await assertDetachedActorDeltaFallbackIsLossless();
    await assertSyntheticLegacySkillsOverlayInheritedItems();
    assertCompendiumMigrationScope();
    assertConvertedSkillsUseModernSystemData();
    await assertUnsupportedCompendiumDocumentsAreSkipped();
    await assertEmptyCompendiumMigrationsDoNotWrite();
    await assertNonEmptyCompendiumMigrationsUpdateDocuments();
    await assertLockedWorldCompendiumIsRestored();
    await assertLockedWorldCompendiumIsRestoredAfterFailure();
    await assertCompendiumActorItemsAreMigrated();
    await assertCompendiumSceneActorDeltasAreMigrated();
    await assertAdventureCompendiumContentIsMigrated();
    await assertRejectedMigrationCrudResultsFailClosed();
    await assertSkillCacheInvalidationIsRetrySafe();
    await assertDuplicateDeletionRetryIsRecoverable();
    await assertInterruptedPackRelockIsRecovered();
    await assertRejectedCompletionMarkerFailsClosed();
    await assertFailedWorldPackPreventsVersionStamp();
    await assertConcurrentWorldMigrationsAreSingleFlight();
    await assertInvalidDocumentsPreventVersionStamp();
    await assertResolvedValidationFailuresPreventMigration();
  } finally {
    globalThis.game = previousGame;
  }

  return [{ name: "migration: legacy item UI fields are preserved", passed: true }];
}

async function assertSyntheticTokenActorDeltasAreMigrated() {
  const previousFoundry = globalThis.foundry;
  const actorUpdates = [];
  const itemUpdates = [];
  const skill = {
    name: "Synthetic Skill",
    documentName: "Item",
    type: "skill",
    system: { source: "", chipped: true, isChipped: false },
    async update(update) { itemUpdates.push(update); return this; }
  };
  const actor = {
    name: "Unlinked Token Actor",
    documentName: "Actor",
    type: "npc",
    isToken: true,
    token: {
      delta: {
        toObject() { return { system: {} }; }
      }
    },
    system: { damage: "7", sortedSkillIDs: ["skill-1"] },
    items: [skill],
    async update(update) { actorUpdates.push(update); return this; }
  };

  try {
    globalThis.foundry = { utils: { isEmpty: value => Object.keys(value || {}).length === 0 } };
    const count = await migrateSyntheticTokenActors([
      { tokens: [{ actorLink: false, actor }, { actorLink: true, actor }] }
    ]);
    assert.equal(count, 1, "only unlinked token actors should be migrated");
    assert.equal(actorUpdates.length, 1);
    assert.equal(actorUpdates[0]["system.damage"], 7);
    assert.equal(
      actorUpdates[0]["system.sortedSkillIDs"],
      null,
      "a migrated synthetic Skill must shadow the inherited sort cache"
    );
    assert.equal(itemUpdates.length, 1);
    assert.equal(itemUpdates[0]["system.isChipped"], true);
    assertForcedDeletion(itemUpdates[0], "system.chipped");
  } finally {
    globalThis.foundry = previousFoundry;
  }
}

async function assertDetachedActorDeltaFallbackIsLossless() {
  const previousReplace = globalThis._replace;
  const tokenUpdates = [];
  let deltaUpdateCalls = 0;
  const delta = {
    name: "Detached Delta",
    documentName: "ActorDelta",
    type: "npc",
    system: { damage: "4" },
    items: [{
      _id: "skill-1",
      name: "Delta Skill",
      type: "skill",
      system: { source: "", chipped: true, isChipped: false }
    }, { _id: "deleted-skill", _tombstone: true }],
    toObject() { return { system: this.system, items: this.items }; },
    async update() { deltaUpdateCalls += 1; }
  };
  const token = {
    name: "Detached Token",
    actorLink: false,
    actor: null,
    delta,
    async update(update) {
      tokenUpdates.push(update);
      const replacement = update["delta.items"];
      if(replacement?.operator === "ForcedReplacement") delta.items = structuredClone(replacement.value);
      return this;
    }
  };
  try {
    globalThis._replace = value => ({ operator: "ForcedReplacement", value });
    assert.equal(await migrateSyntheticTokenActors([
      { name: "Detached Scene", tokens: [token] }
    ], { throwOnError: true }), 1);
    assert.equal(deltaUpdateCalls, 0, "orphan ActorDelta.update() is a V14 no-op and must never be trusted");
    assert.equal(tokenUpdates[0]["delta.system.damage"], 4);
    assert.equal(tokenUpdates[0]["delta.system.sortedSkillIDs"], null);
    assert.equal(tokenUpdates[0]["delta.items"].operator, "ForcedReplacement");
    assert.equal(delta.items[0].system.isChipped, true);
    assert.equal(delta.items[0].system.chipped, undefined, "forced replacement must remove the obsolete field");
    assert.deepEqual(delta.items[1], { _id: "deleted-skill", _tombstone: true }, "delta tombstones must survive replacement");

    await assert.rejects(
      () => migrateSyntheticTokenActors([{
        name: "Broken Scene",
        tokens: [{
          name: "Broken Token",
          actorLink: false,
          actor: null,
          delta: { system: { skills: { Athletics: { value: 2 } } }, items: [], async update() {} },
          async update() {}
        }]
      }], { throwOnError: true }),
      /legacy Actor skills but no synthetic Actor/
    );
  } finally {
    if(previousReplace === undefined) delete globalThis._replace;
    else globalThis._replace = previousReplace;
  }
}

async function assertSyntheticLegacySkillsOverlayInheritedItems() {
  const actorUpdates = [];
  const inheritedAthletics = {
    _id: "athletics-1",
    name: "Athletics",
    documentName: "Item",
    type: "skill",
    system: { source: "", level: 0, chipLevel: 0, isChipped: false, notes: "keep me", diffMod: 2 },
    toObject() { return { _id: this._id, name: this.name, type: this.type, system: { ...this.system } }; },
    async update() { return this; }
  };
  const inheritedSword = {
    _id: "sword-1",
    name: "Sword",
    documentName: "Item",
    type: "weapon",
    system: { source: "", rangeDamages: { pointBlank: "", close: "", medium: "", far: "" } },
    toObject() { return { _id: this._id, name: this.name, type: this.type, system: structuredClone(this.system) }; },
    async update() { return this; }
  };
  const syntheticActor = {
    name: "Delta-skilled Token Actor",
    documentName: "Actor",
    type: "npc",
    isToken: true,
    token: {
      delta: {
        system: {
          skills: {
            Athletics: { value: 4, chipValue: 0, chipped: false, ip: 12, stat: "ref" }
          }
        },
        toObject() { return { system: structuredClone(this.system), items: [] }; },
        items: {
          baseCollection: [inheritedAthletics, inheritedSword],
          manages: () => false,
          isTombstone: () => false
        }
      }
    },
    system: {
      skills: {
        Athletics: { value: 4, chipValue: 0, chipped: false, ip: 12, stat: "ref" }
      }
    },
    items: [inheritedAthletics, inheritedSword],
    async update(update) { actorUpdates.push(update); return this; }
  };

  await migrateSyntheticTokenActors([{
    name: "Delta Skill Scene",
    tokens: [{ actorLink: false, actor: syntheticActor }]
  }], { throwOnError: true });

  assert.equal(actorUpdates.length, 1);
  assertForcedDeletion(actorUpdates[0], "system.skills");
  const migratedAthletics = actorUpdates[0].items.find(item => item.name === "Athletics");
  assert.equal(actorUpdates[0].items.length, 1, "unchanged inherited Items must not be adopted into ActorDelta");
  assert.equal(actorUpdates[0].items.some(item => item.name === "Sword"), false);
  assert.equal(migratedAthletics._id, "athletics-1", "the inherited Item identity must be preserved");
  assert.equal(migratedAthletics.system.level, 4, "ActorDelta-specific training must override the inherited level");
  assert.equal(migratedAthletics.system.ip, 12);
  assert.equal(migratedAthletics.system.notes, "keep me", "modern Item-only fields must be preserved");
  assert.equal(migratedAthletics.system.diffMod, 2, "an existing difficulty modifier must not be reset");
  assert.equal(actorUpdates[0]["system.sortedSkillIDs"], null, "a token-specific Item override must shadow the base sort cache");
}

function assertCompendiumMigrationScope() {
  const systemId = "cyberpunk2020-rilerena";
  assert.equal(isMigratableCompendium({ collection: "world.custom-items" }, systemId), true);
  assert.equal(isMigratableCompendium({ collection: `${systemId}.default-skills` }, systemId), false);
  assert.equal(
    isMigratableCompendium({ collection: "unrelated.items", metadata: { system: systemId } }, systemId),
    false,
    "a module's required system is not proof that the system owns its pack"
  );
  assert.equal(isMigratableCompendium({ metadata: { packageType: "world" } }, systemId), false);
}

function assertConvertedSkillsUseModernSystemData() {
  const converted = convertOldSkill("Athletics", {
    value: 4,
    chipValue: 2,
    chipped: true,
    ip: 10,
    stat: "ref"
  });
  assert.equal(converted.data, undefined, "V14 documents must not be created with the removed data field");
  assert.equal(converted.system.level, 4);
  assert.equal(converted.system.isChipped, true);
}

async function assertEmptyCompendiumMigrationsDoNotWrite() {
  const previousFoundry = globalThis.foundry;
  let updateCalls = 0;
  globalThis.foundry = {
    utils: {
      isEmpty: value => Object.keys(value || {}).length === 0
    }
  };
  try {
    await migrateCompendium({
      collection: "world.current-items",
      title: "Current Items",
      locked: false,
      async getDocuments() {
        return [{
          id: "skill-1",
          name: "Current Skill",
          documentName: "Item",
          type: "skill",
          system: { source: "", isChipped: false },
          async update() { updateCalls += 1; }
        }];
      }
    });
  } finally {
    globalThis.foundry = previousFoundry;
  }
  assert.equal(updateCalls, 0, "empty migrations must not rewrite compendium documents");
}

async function assertNonEmptyCompendiumMigrationsUpdateDocuments() {
  const previousFoundry = globalThis.foundry;
  const updates = [];
  globalThis.foundry = {
    utils: {
      isEmpty: value => Object.keys(value || {}).length === 0
    }
  };
  try {
    await migrateCompendium({
      collection: "world.legacy-items",
      title: "Legacy Items",
      locked: false,
      async getDocuments() {
        return [{
          id: "skill-1",
          name: "Legacy Skill",
          documentName: "Item",
          type: "skill",
          system: { isChipped: false },
          async update(updateData) { updates.push(updateData); return this; }
        }];
      }
    });
  } finally {
    globalThis.foundry = previousFoundry;
  }
  assert.deepEqual(updates, [{ "system.source": "" }], "compendium migrations must update the loaded Document API");
}

async function assertUnsupportedCompendiumDocumentsAreSkipped() {
  let updateCalls = 0;
  await migrateCompendium({
    collection: "world.roll-tables",
    title: "Roll Tables",
    locked: false,
    async getDocuments() {
      return [{
        id: "table-1",
        name: "Hit Location",
        documentName: "RollTable",
        flags: {},
        async update() { updateCalls += 1; }
      }];
    }
  });
  assert.equal(updateCalls, 0, "unsupported compendium document types must not fail or write during migration");
}

async function assertLockedWorldCompendiumIsRestored() {
  const lockTransitions = [];
  const pack = {
    collection: "world.locked-items",
    title: "Locked Items",
    locked: true,
    async configure({ locked }) {
      lockTransitions.push(locked);
      this.locked = locked;
    },
    async getDocuments() { return []; }
  };
  const report = await migrateCompendium(pack);
  assert.deepEqual(lockTransitions, [false, true]);
  assert.equal(pack.locked, true);
  assert.equal(report.restoredLock, true);
}

async function assertLockedWorldCompendiumIsRestoredAfterFailure() {
  const lockTransitions = [];
  const pack = {
    collection: "world.broken-items",
    title: "Broken Items",
    locked: true,
    async configure({ locked }) {
      lockTransitions.push(locked);
      this.locked = locked;
    },
    async getDocuments() { throw new Error("database unavailable"); }
  };
  await assert.rejects(() => migrateCompendium(pack), /database unavailable/);
  assert.deepEqual(lockTransitions, [false, true]);
  assert.equal(pack.locked, true, "a failed migration must not leave a World pack unlocked");
}

async function assertCompendiumActorItemsAreMigrated() {
  const actorUpdates = [];
  const itemUpdates = [];
  const actor = {
    id: "actor-1",
    name: "Packed Actor",
    documentName: "Actor",
    type: "npc",
    system: { sortedSkillIDs: ["skill-1"] },
    items: [{
      id: "skill-1",
      name: "Legacy Skill",
      documentName: "Item",
      type: "skill",
      system: { source: "", chipped: true, isChipped: false },
      toObject() { return { _id: this.id, name: this.name, type: this.type, system: this.system }; },
      async update(update) { itemUpdates.push(update); return this; }
    }],
    async update(update) { actorUpdates.push(update); return this; }
  };
  await migrateCompendium({
    collection: "world.actors",
    title: "Actors",
    locked: false,
    async getDocuments() { return [actor]; }
  });
  assert.equal(itemUpdates.length, 1);
  assert.equal(itemUpdates[0]["system.isChipped"], true);
  assertForcedDeletion(itemUpdates[0], "system.chipped");
  assert.equal(actorUpdates.length, 1);
  assertForcedDeletion(actorUpdates[0], "system.sortedSkillIDs");
}

async function assertCompendiumSceneActorDeltasAreMigrated() {
  const actorUpdates = [];
  const itemUpdates = [];
  const actor = {
    id: "synthetic-1",
    name: "Packed Token Actor",
    documentName: "Actor",
    type: "npc",
    isToken: true,
    token: {
      delta: {
        toObject() { return { system: {} }; }
      }
    },
    system: { damage: "3", sortedSkillIDs: ["skill-1"] },
    items: [{
      id: "skill-1",
      name: "Packed Skill",
      documentName: "Item",
      type: "skill",
      system: { source: "", chipped: true, isChipped: false },
      async update(update) { itemUpdates.push(update); return this; }
    }],
    async update(update) { actorUpdates.push(update); return this; }
  };
  const scene = {
    id: "scene-1",
    name: "Packed Scene",
    documentName: "Scene",
    flags: {},
    tokens: [{ id: "token-1", name: "Packed Token", actorLink: false, actor }],
    async update() { return this; }
  };
  await migrateCompendium({
    collection: "world.scenes",
    title: "Scenes",
    locked: false,
    async getDocuments() { return [scene]; }
  });
  assert.equal(actorUpdates.length, 1);
  assert.equal(actorUpdates[0]["system.damage"], 3);
  assert.equal(actorUpdates[0]["system.sortedSkillIDs"], null);
  assert.equal(itemUpdates.length, 1);
  assert.equal(itemUpdates[0]["system.isChipped"], true);
  assertForcedDeletion(itemUpdates[0], "system.chipped");
}

async function assertAdventureCompendiumContentIsMigrated() {
  const previousPacks = globalThis.game.packs;
  globalThis.game.packs = {
    get: () => ({
      async getDocuments() {
        return [{
          name: "Athletics",
          type: "skill",
          toObject() { return { name: this.name, type: this.type, system: { level: 0 } }; }
        }];
      }
    })
  };
  try {
  const source = {
    _id: "adventure-1",
    name: "Legacy Adventure",
    actors: [{
      _id: "actor-1",
      name: "Adventure Solo",
      type: "npc",
      system: {
        damage: "2",
        sortedSkillIDs: ["handgun-1", "handgun-duplicate"],
        skills: {
          Handgun: { value: 7, chipValue: 0, chipped: false, ip: 20, stat: "ref" },
          Athletics: { value: 0, chipValue: 0, chipped: false, ip: 0, stat: "ref" },
          Expert: {
            group: true,
            Cryptography: { value: 0, chipValue: 0, chipped: false, ip: 6, stat: "int" }
          }
        }
      },
      items: [{
        _id: "handgun-1",
        name: "Handgun",
        type: "skill",
        system: { source: "", level: 0, notes: "preserve me", chipped: true, isChipped: false }
      }, {
        _id: "handgun-duplicate",
        name: "Handgun",
        type: "skill",
        system: { source: "", level: 7, ip: 20, notes: "", isChipped: false, diffMod: 1 }
      }]
    }, {
      _id: "actor-sort-cache",
      name: "Adventure cached skill actor",
      type: "npc",
      system: { sortedSkillIDs: ["cached-skill"] },
      items: [{
        _id: "cached-skill",
        name: "Cached Skill",
        type: "skill",
        system: { source: "", chipped: true, isChipped: false }
      }]
    }, {
      _id: "actor-delta-base",
      name: "Adventure delta base",
      type: "npc",
      system: {},
      items: [{
        _id: "delta-base-handgun",
        name: "Handgun",
        type: "skill",
        system: {
          source: "",
          level: 0,
          chipLevel: 0,
          isChipped: false,
          ip: 0,
          diffMod: 1,
          isRoleSkill: false,
          stat: "ref",
          notes: "base notes",
          flavor: ""
        }
      }]
    }],
    items: [{
      _id: "weapon-1",
      name: "Adventure Shotgun",
      type: "weapon",
      system: {
        rangeDamages: { pointBlank: "6d6", short: "5d6", medium: "4d6", far: "3d6" }
      }
    }],
    scenes: [{
      _id: "scene-1",
      name: "Adventure Scene",
      tokens: [{
        _id: "token-1",
        actorId: "actor-1",
        actorLink: false,
        delta: {
          system: {
            damage: "4",
            skills: {
              Handgun: { value: 9, chipValue: 0, chipped: false, ip: 25, stat: "ref" },
              Athletics: { value: 0, chipValue: 0, chipped: false, ip: 0, stat: "ref" },
              Expert: {
                group: true,
                Cryptography: { value: 0, chipValue: 0, chipped: false, ip: 8, stat: "int" }
              }
            }
          },
          items: []
        }
      }, {
        _id: "token-2",
        actorId: "actor-1",
        actorLink: false,
        delta: {
          system: {
            skills: {
              Handgun: { value: 9, chipValue: 0, chipped: false, ip: 25, stat: "ref" }
            }
          },
          items: [{
            _id: "handgun-1",
            name: "Handgun",
            type: "skill",
            system: { source: "", level: 11, ip: 31, isChipped: false, stat: "ref" }
          }]
        }
      }, {
        _id: "token-3",
        actorId: "actor-1",
        actorLink: false,
        delta: {
          system: {
            skills: {
              Handgun: { value: 9, chipValue: 0, chipped: false, ip: 25, stat: "ref" }
            }
          },
          items: [{ _id: "handgun-1", _tombstone: true }]
        }
      }, {
        _id: "token-4",
        actorId: "actor-delta-base",
        actorLink: false,
        delta: {
          system: {
            skills: {
              Handgun: { value: 6, chipValue: 0, chipped: false, ip: 12, stat: "ref" }
            }
          },
          items: [{
            _id: "spanish-token-handgun",
            name: "Armas Cortas",
            type: "skill",
            system: {
              source: "",
              level: 6,
              chipLevel: 0,
              isChipped: false,
              ip: 12,
              diffMod: 1,
              isRoleSkill: false,
              stat: "ref",
              notes: "",
              flavor: ""
            }
          }]
        }
      }, {
        _id: "token-5",
        actorId: "actor-delta-base",
        actorLink: false,
        delta: {
          system: { sortedSkillIDs: ["delta-base-handgun"] },
          items: [{
            _id: "delta-base-handgun",
            name: "Handgun",
            type: "skill",
            system: { source: "", chipped: true, isChipped: false }
          }]
        }
      }, {
        _id: "token-6",
        actorId: "actor-delta-base",
        actorLink: false,
        delta: {
          system: {
            skills: {
              Expert: {
                group: true,
                TokenForensics: { value: 3, chipValue: 0, chipped: false, ip: 4, stat: "int" }
              }
            }
          },
          items: []
        }
      }]
    }]
  };
  const updates = [];
  const adventure = {
    id: source._id,
    name: source.name,
    documentName: "Adventure",
    toObject() { return structuredClone(source); },
    async update(update) { updates.push(update); return this; }
  };

  const adventurePack = {
    collection: "world.adventures",
    title: "Adventures",
    locked: false,
    async getDocuments() { return [adventure]; }
  };
  await migrateCompendium(adventurePack);

  assert.equal(updates.length, 1, "Adventure contents must be persisted through their owning Document");
  const actor = updates[0].actors[0];
  assert.equal(actor.system.damage, 2);
  assert.equal(actor.system.skills, undefined);
  assert.equal(actor.system.sortedSkillIDs, undefined, "changed Actor Items must invalidate persisted sort IDs");
  const handgun = actor.items.find(item => item.name === "Handgun");
  assert.equal(actor.items.filter(item => item.name === "Handgun").length, 1);
  assert.equal(handgun._id, "handgun-1");
  assert.equal(handgun.system.level, 7);
  assert.equal(handgun.system.notes, "preserve me");
  assert.equal(handgun.system.isChipped, true);
  assert.equal(handgun.system.chipped, undefined);
  const expert = actor.items.find(item => item.name === "Expert: Cryptography");
  assert.equal(expert.system.ip, 6);
  assert.match(expert._id, /^[A-Za-z0-9]{16}$/, "new Adventure embedded Items need stable Document IDs");
  assert.equal(actor.items.some(item => item.name === "Athletics"), false, "a deleted zero-state default skill must stay deleted");
  const cachedActor = updates[0].actors.find(entry => entry._id === "actor-sort-cache");
  assert.equal(cachedActor.system.sortedSkillIDs, undefined, "migrated Skill state must invalidate Adventure sort IDs");
  assert.equal(cachedActor.items[0].system.isChipped, true);

  const weapon = updates[0].items[0];
  assert.equal(weapon.system.source, "");
  assert.equal(weapon.system.rangeDamages.close, "5d6");
  assert.equal(weapon.system.rangeDamages.short, undefined);

  const delta = updates[0].scenes[0].tokens[0].delta;
  assert.equal(delta.system.damage, 4);
  assert.equal(delta.system.skills, undefined);
  assert.equal(delta.system.sortedSkillIDs, null, "token-only skill overrides must shadow inherited sort IDs");
  assert.equal(delta.items.length, 2);
  assert.equal(delta.items[0]._id, "handgun-1", "the inherited Item identity must be used for the delta override");
  assert.equal(delta.items[0].system.level, 9);
  assert.equal(delta.items[0].system.ip, 25);
  const deltaExpert = delta.items.find(item => item.name === "Expert: Cryptography");
  assert.equal(deltaExpert.system.ip, 8);
  assert.equal(deltaExpert._id, expert._id, "the ActorDelta override must reference the newly assigned base Item ID");
  assert.equal(delta.items.some(item => item.name === "Athletics"), false, "an ActorDelta must not resurrect a zero-state default skill");

  const managedDelta = updates[0].scenes[0].tokens[1].delta;
  assert.equal(managedDelta.system.skills, undefined);
  assert.equal(managedDelta.items.length, 1);
  assert.equal(managedDelta.items[0].system.level, 11, "a managed ActorDelta Item must beat stale legacy state");
  assert.equal(managedDelta.items[0].system.ip, 31);

  const tombstonedDelta = updates[0].scenes[0].tokens[2].delta;
  assert.equal(tombstonedDelta.system.skills, undefined);
  assert.deepEqual(
    tombstonedDelta.items,
    [{ _id: "handgun-1", _tombstone: true }],
    "an ActorDelta tombstone must not be replaced by a legacy skill override"
  );

  const localizedDelta = updates[0].scenes[0].tokens[3].delta;
  assert.equal(localizedDelta.items.length, 1, "the localized token-only duplicate must be folded");
  assert.equal(localizedDelta.items[0]._id, "delta-base-handgun", "the inherited canonical ID must survive the fold");
  assert.equal(localizedDelta.items[0].name, "Handgun");
  assert.equal(localizedDelta.items[0].system.level, 6);
  assert.equal(localizedDelta.items[0].system.notes, "base notes");
  assert.equal(localizedDelta.system.sortedSkillIDs, null);

  const chippedDelta = updates[0].scenes[0].tokens[4].delta;
  assert.equal(chippedDelta.items[0].system.chipped, undefined);
  assert.equal(chippedDelta.items[0].system.isChipped, true);
  assert.equal(chippedDelta.system.sortedSkillIDs, null, "a migrated delta Skill must invalidate inherited ordering");

  const tokenOnlyDelta = updates[0].scenes[0].tokens[5].delta;
  const tokenOnlySkill = tokenOnlyDelta.items.find(item => item.name === "Expert: Token Forensics");
  assert.match(tokenOnlySkill._id, /^[A-Za-z0-9]{16}$/, "token-only Adventure ActorDelta Items need stable IDs");
  const deltaBase = updates[0].actors.find(entry => entry._id === "actor-delta-base");
  assert.ok(
    !deltaBase.items.some(item => item._id === tokenOnlySkill._id),
    "a generated ActorDelta Item ID must not accidentally override a base Actor Item"
  );

  await migrateCompendium(adventurePack);
  const repeatedTokenOnlySkill = updates[1].scenes[0].tokens[5].delta.items
    .find(item => item.name === "Expert: Token Forensics");
  assert.equal(
    repeatedTokenOnlySkill._id,
    tokenOnlySkill._id,
    "retrying the same Adventure ActorDelta migration must reproduce its generated Item ID"
  );

  const collisionSource = structuredClone(source);
  collisionSource.actors.find(actor => actor._id === "actor-delta-base").items.push({
    _id: tokenOnlySkill._id,
    name: "Reserved base identity",
    type: "misc",
    system: {}
  });
  const collisionUpdates = [];
  const collisionAdventure = {
    id: collisionSource._id,
    name: collisionSource.name,
    documentName: "Adventure",
    toObject() { return structuredClone(collisionSource); },
    async update(update) { collisionUpdates.push(update); return this; }
  };
  const collisionPack = {
    collection: "world.adventure-id-collision",
    title: "Adventure ID Collision",
    locked: false,
    async getDocuments() { return [collisionAdventure]; }
  };
  await migrateCompendium(collisionPack);
  await migrateCompendium(collisionPack);
  const collisionIds = collisionUpdates.map(update => update.scenes[0].tokens[5].delta.items
    .find(item => item.name === "Expert: Token Forensics")._id);
  assert.notEqual(collisionIds[0], tokenOnlySkill._id, "base Actor Item IDs must be reserved from ActorDelta generation");
  assert.equal(collisionIds[1], collisionIds[0], "collision salting must also be deterministic across retries");

  let unsafeAdventureWrites = 0;
  await assert.rejects(
    () => migrateCompendium({
      collection: "world.ambiguous-adventure",
      title: "Ambiguous Adventure",
      locked: false,
      async getDocuments() {
        return [{
          id: "ambiguous-adventure",
          name: "Ambiguous Adventure",
          documentName: "Adventure",
          toObject() {
            return {
              actors: [{
                _id: "ambiguous-actor",
                name: "Ambiguous Actor",
                type: "npc",
                system: { skills: { Handgun: { value: 0, chipValue: 0, chipped: false, ip: 0, stat: "ref" } } },
                items: [
                  { _id: "canonical", name: "Handgun", type: "skill", system: { level: 0, stat: "ref" } },
                  { _id: "duplicate", name: "Handgun", type: "skill", system: { level: 0, stat: "int" } }
                ]
              }],
              items: [],
              scenes: []
            };
          },
          async update() { unsafeAdventureWrites += 1; return this; }
        }];
      }
    }),
    /divergent stat/,
    "Adventure duplicate skills with conflicting state must fail closed"
  );
  assert.equal(unsafeAdventureWrites, 0);

  await assert.rejects(
    () => migrateCompendium({
      collection: "world.ambiguous-delta-adventure",
      title: "Ambiguous ActorDelta Adventure",
      locked: false,
      async getDocuments() {
        return [{
          id: "ambiguous-delta-adventure",
          name: "Ambiguous ActorDelta Adventure",
          documentName: "Adventure",
          toObject() {
            return {
              actors: [{
                _id: "base-actor",
                name: "Base Actor",
                type: "npc",
                system: {},
                items: [{
                  _id: "base-handgun",
                  name: "Handgun",
                  type: "skill",
                  system: { source: "", level: 6, ip: 10, stat: "ref" }
                }]
              }],
              items: [],
              scenes: [{
                _id: "scene",
                tokens: [{
                  _id: "token",
                  actorId: "base-actor",
                  actorLink: false,
                  delta: {
                    system: {
                      skills: {
                        Handgun: { value: 0, chipValue: 0, chipped: false, ip: 0, stat: "ref" }
                      }
                    },
                    items: [{
                      _id: "localized-handgun",
                      name: "Armas Cortas",
                      type: "skill",
                      system: { source: "", level: 8, ip: 30, stat: "ref" }
                    }]
                  }
                }]
              }]
            };
          },
          async update() { unsafeAdventureWrites += 1; return this; }
        }];
      }
    }),
    /divergent progress/,
    "base and localized ActorDelta Items with divergent state must fail closed"
  );
  assert.equal(unsafeAdventureWrites, 0, "an ambiguous ActorDelta must abort before Adventure.update");
  } finally {
    globalThis.game.packs = previousPacks;
  }
}

async function assertRejectedMigrationCrudResultsFailClosed() {
  await assert.rejects(
    () => migrateSyntheticTokenActors([{
      name: "Rejected Token Scene",
      tokens: [{
        name: "Rejected Token",
        actorLink: false,
        actor: null,
        delta: {
          system: { damage: "3" },
          items: [],
          toObject() { return { system: structuredClone(this.system), items: [] }; }
        },
        async update() { return undefined; }
      }]
    }], { throwOnError: true }),
    /rejected its detached ActorDelta update/,
    "a falsy TokenDocument update result must abort migration"
  );

  await assert.rejects(
    () => migrateCompendium({
      collection: "world.rejected-adventure",
      title: "Rejected Adventure",
      locked: false,
      async getDocuments() {
        return [{
          id: "rejected-adventure",
          name: "Rejected Adventure",
          documentName: "Adventure",
          toObject() {
            return {
              actors: [],
              scenes: [],
              items: [{
                _id: "weapon-1",
                name: "Legacy Weapon",
                type: "weapon",
                system: { rangeDamages: { pointBlank: "", close: "", medium: "", far: "" } }
              }]
            };
          },
          async update() { return undefined; }
        }];
      }
    }),
    /Adventure Rejected Adventure rejected its migration update/,
    "a falsy Adventure update result must abort migration"
  );

  const previousGame = globalThis.game;
  const previousUi = globalThis.ui;
  const settingValues = new Map([
    ["migrationPendingPackRelocks", "[]"],
    ["systemMigrationVersion", ""]
  ]);
  const settingWrites = [];
  const errors = [];
  const actor = {
    id: "rejected-actor",
    name: "Rejected Actor",
    documentName: "Actor",
    type: "npc",
    system: { damage: "2" },
    items: [{
      id: "current-skill",
      name: "Current Skill",
      documentName: "Item",
      type: "skill",
      system: { source: "", isChipped: false },
      async update() { return this; }
    }],
    async update() { return undefined; }
  };
  try {
    const user = { id: "gm", isGM: true, active: true };
    globalThis.game = {
      user,
      users: { contents: [user] },
      i18n: { has: () => false, localize: key => key },
      actors: { contents: [actor] },
      items: { contents: [] },
      scenes: { contents: [] },
      packs: { contents: [] },
      collections: new Map([["Actor", { contents: [actor], invalidDocumentIds: new Set() }]]),
      settings: {
        get: (_systemId, key) => settingValues.get(key),
        async set(_systemId, key, value) {
          settingWrites.push([key, value]);
          settingValues.set(key, value);
          return value;
        }
      },
      system: { id: "cyberpunk2020-rilerena", version: "2.0.0" }
    };
    globalThis.ui = { notifications: { info() {}, error(message) { errors.push(message); } } };

    assert.equal(await migrateWorld(), false);
    assert.equal(settingValues.get("systemMigrationVersion"), "", "a rejected Document update must prevent the version stamp");
    assert.equal(settingWrites.some(([key]) => key === "systemMigrationVersion"), false);
    assert.equal(errors.length, 1);
  } finally {
    globalThis.game = previousGame;
    globalThis.ui = previousUi;
  }
}

async function assertSkillCacheInvalidationIsRetrySafe() {
  const previousGame = globalThis.game;
  const previousUi = globalThis.ui;
  const settingValues = new Map([
    ["migrationPendingPackRelocks", "[]"],
    ["systemMigrationVersion", ""]
  ]);
  let rejectCacheUpdate = true;
  let itemUpdateCalls = 0;
  const skill = {
    id: "retry-skill",
    name: "Retry Skill",
    documentName: "Item",
    type: "skill",
    system: { source: "", chipped: true, isChipped: false },
    async update(update) {
      itemUpdateCalls += 1;
      if(Object.hasOwn(update, "system.isChipped")) this.system.isChipped = update["system.isChipped"];
      if(Object.hasOwn(update, "system.chipped")) delete this.system.chipped;
      return this;
    }
  };
  const actor = {
    id: "retry-cache-actor",
    name: "Retry cache Actor",
    documentName: "Actor",
    type: "npc",
    system: { sortedSkillIDs: [skill.id] },
    items: [skill],
    async update(update) {
      if(Object.hasOwn(update, "system.sortedSkillIDs")) {
        if(rejectCacheUpdate) {
          rejectCacheUpdate = false;
          return undefined;
        }
        delete this.system.sortedSkillIDs;
      }
      return this;
    }
  };

  try {
    const user = { id: "gm", isGM: true, active: true };
    globalThis.game = {
      user,
      users: { contents: [user] },
      i18n: { has: () => false, localize: key => key },
      model: { Item: { skill: { templates: ["common"] } } },
      actors: { contents: [actor] },
      items: { contents: [] },
      scenes: { contents: [] },
      packs: { contents: [] },
      collections: new Map([
        ["Actor", { contents: [actor], invalidDocumentIds: new Set() }],
        ["Item", { contents: [], invalidDocumentIds: new Set() }]
      ]),
      settings: {
        get: (_systemId, key) => settingValues.get(key),
        async set(_systemId, key, value) {
          settingValues.set(key, value);
          return value;
        }
      },
      system: { id: "cyberpunk2020-rilerena", version: "2.0.0" }
    };
    globalThis.ui = { notifications: { info() {}, error() {} } };

    assert.equal(await migrateWorld(), false, "a rejected cache invalidation must abort migration");
    assert.equal(itemUpdateCalls, 0, "Skill data must not change before its owning Actor accepts cache invalidation");
    assert.equal(settingValues.get("systemMigrationVersion"), "");

    assert.equal(await migrateWorld(), true, "the retry must clear the cache and finish the Skill migration");
    assert.equal(itemUpdateCalls, 1);
    assert.equal(actor.system.sortedSkillIDs, undefined);
    assert.equal(skill.system.chipped, undefined);
    assert.equal(skill.system.isChipped, true);
    assert.equal(settingValues.get("systemMigrationVersion"), "2.0.0");
  } finally {
    globalThis.game = previousGame;
    globalThis.ui = previousUi;
  }
}

async function assertDuplicateDeletionRetryIsRecoverable() {
  const previousGame = globalThis.game;
  const previousUi = globalThis.ui;
  const actorUpdates = [];
  const deleteCalls = [];
  let deleteAttempts = 0;
  const settingValues = new Map([
    ["migrationPendingPackRelocks", "[]"],
    ["systemMigrationVersion", ""]
  ]);
  const settingWrites = [];

  const makeSkill = ({ id, level, ip }) => ({
    _id: id,
    id,
    name: "Handgun",
    documentName: "Item",
    type: "skill",
    system: {
      source: "",
      level,
      chipLevel: 0,
      isChipped: false,
      ip,
      diffMod: 1,
      isRoleSkill: false,
      stat: "ref",
      notes: "",
      flavor: ""
    },
    toObject() {
      return { _id: this._id, name: this.name, type: this.type, system: structuredClone(this.system) };
    },
    async update() { return this; }
  });
  const actor = {
    id: "retry-actor",
    name: "Retry Actor",
    documentName: "Actor",
    type: "npc",
    system: {
      sortedSkillIDs: ["handgun-current", "handgun-duplicate"],
      skills: { Handgun: { value: 4, chipValue: 0, chipped: false, ip: 8, stat: "ref" } }
    },
    items: [
      makeSkill({ id: "handgun-current", level: 7, ip: 20 }),
      makeSkill({ id: "handgun-duplicate", level: 0, ip: 0 })
    ],
    toObject() { return { system: structuredClone(this.system) }; },
    async update(update) {
      actorUpdates.push(update);
      if(Array.isArray(update.items)) {
        for(const itemSource of update.items) {
          const existing = this.items.find(item => item.id === (itemSource._id || itemSource.id));
          if(existing) existing.system = structuredClone(itemSource.system);
        }
      }
      if(Object.hasOwn(update, "system.sortedSkillIDs")) delete this.system.sortedSkillIDs;
      if(Object.hasOwn(update, "system.skills")) delete this.system.skills;
      return this;
    },
    async deleteEmbeddedDocuments(documentName, ids) {
      deleteAttempts += 1;
      deleteCalls.push([documentName, [...ids]]);
      if(deleteAttempts === 1) return [];
      const deleted = this.items.filter(item => ids.includes(item.id));
      this.items = this.items.filter(item => !ids.includes(item.id));
      return deleted;
    }
  };

  try {
    const user = { id: "gm", isGM: true, active: true };
    globalThis.game = {
      user,
      users: { contents: [user] },
      i18n: { has: () => false, localize: key => key },
      actors: { contents: [actor] },
      items: { contents: [] },
      scenes: { contents: [] },
      packs: { contents: [] },
      collections: new Map([["Actor", { contents: [actor], invalidDocumentIds: new Set() }]]),
      settings: {
        get: (_systemId, key) => settingValues.get(key),
        async set(_systemId, key, value) {
          settingWrites.push([key, value]);
          settingValues.set(key, value);
          return value;
        }
      },
      system: { id: "cyberpunk2020-rilerena", version: "2.0.0" }
    };
    globalThis.ui = { notifications: { info() {}, error() {} } };

    assert.equal(await migrateWorld(), false, "the first rejected duplicate deletion must abort");
    assert.ok(actor.system.skills, "legacy skills must remain as a retry marker until duplicate deletion succeeds");
    assert.equal(actor.items.length, 2, "the rejected deletion must leave both embedded Items available for retry");
    assert.equal(settingValues.get("systemMigrationVersion"), "");

    assert.equal(await migrateWorld(), true, "a second run must finish the interrupted deletion safely");
    assert.equal(actor.system.skills, undefined);
    assert.equal(actor.items.length, 1);
    assert.equal(actor.items[0].id, "handgun-current");
    assert.equal(settingValues.get("systemMigrationVersion"), "2.0.0");
    assert.deepEqual(deleteCalls, [
      ["Item", ["handgun-duplicate"]],
      ["Item", ["handgun-duplicate"]]
    ]);
    assert.equal(
      actorUpdates.slice(0, 2).some(update => Object.hasOwn(update, "system.skills")),
      false,
      "cleanup must not erase the retry marker before embedded deletion is confirmed"
    );
    assert.equal(
      settingWrites.filter(([key]) => key === "systemMigrationVersion").length,
      1,
      "only the successful retry may stamp the World"
    );
  } finally {
    globalThis.game = previousGame;
    globalThis.ui = previousUi;
  }
}

async function assertInterruptedPackRelockIsRecovered() {
  const previousGame = globalThis.game;
  const previousUi = globalThis.ui;
  const lockTransitions = [];
  let relockAttempts = 0;
  const settingValues = new Map([
    ["migrationPendingPackRelocks", "[]"],
    ["systemMigrationVersion", ""]
  ]);
  const pack = {
    collection: "world.interrupted-lock",
    title: "Interrupted Lock",
    locked: true,
    contents: [],
    invalidDocumentIds: new Set(),
    async configure({ locked }) {
      lockTransitions.push(locked);
      if(!locked) {
        this.locked = false;
        return this;
      }
      relockAttempts += 1;
      if(relockAttempts > 1) this.locked = true;
      return this;
    },
    async getDocuments() { return []; }
  };
  try {
    const user = { id: "gm", isGM: true, active: true };
    globalThis.game = {
      user,
      users: { contents: [user] },
      actors: { contents: [] },
      items: { contents: [] },
      scenes: { contents: [] },
      packs: { contents: [pack] },
      collections: new Map(),
      settings: {
        get: (_systemId, key) => settingValues.get(key),
        async set(_systemId, key, value) {
          settingValues.set(key, value);
          return value;
        }
      },
      system: { id: "cyberpunk2020-rilerena", version: "2.0.0" }
    };
    globalThis.ui = { notifications: { info() {}, error() {} } };

    assert.equal(await migrateWorld(), false, "an unconfirmed relock must abort migration");
    assert.equal(pack.locked, false);
    assert.deepEqual(JSON.parse(settingValues.get("migrationPendingPackRelocks")), [pack.collection]);
    assert.equal(settingValues.get("systemMigrationVersion"), "");

    assert.equal(await migrateWorld(), true, "the durable journal must repair an interrupted relock on retry");
    assert.equal(pack.locked, true);
    assert.equal(settingValues.get("migrationPendingPackRelocks"), "[]");
    assert.equal(settingValues.get("systemMigrationVersion"), "2.0.0");
    assert.deepEqual(lockTransitions, [false, true, true]);
  } finally {
    globalThis.game = previousGame;
    globalThis.ui = previousUi;
  }
}

async function assertRejectedCompletionMarkerFailsClosed() {
  const previousGame = globalThis.game;
  const previousUi = globalThis.ui;
  const markerAttempts = [];
  const errors = [];
  let successNotifications = 0;
  try {
    const user = { id: "gm", isGM: true, active: true };
    globalThis.game = {
      user,
      users: { contents: [user] },
      actors: { contents: [] },
      items: { contents: [] },
      scenes: { contents: [] },
      packs: { contents: [] },
      collections: new Map(),
      settings: {
        get: (_systemId, key) => key === "migrationPendingPackRelocks" ? "[]" : "",
        async set(_systemId, key, value) {
          markerAttempts.push([key, value]);
          return value;
        }
      },
      system: { id: "cyberpunk2020-rilerena", version: "2.0.0" }
    };
    globalThis.ui = {
      notifications: {
        info() { successNotifications += 1; },
        error(message) { errors.push(message); }
      }
    };

    assert.equal(await migrateWorld(), false, "a rejected completion marker must not report success");
    assert.deepEqual(markerAttempts, [["systemMigrationVersion", "2.0.0"]]);
    assert.equal(successNotifications, 0);
    assert.equal(errors.length, 1);
  } finally {
    globalThis.game = previousGame;
    globalThis.ui = previousUi;
  }
}

async function assertFailedWorldPackPreventsVersionStamp() {
  const previousGame = globalThis.game;
  const previousUi = globalThis.ui;
  const settingWrites = [];
  const settingValues = new Map([
    ["migrationPendingPackRelocks", "[]"],
    ["systemMigrationVersion", ""]
  ]);
  const pack = {
    collection: "world.unavailable",
    title: "Unavailable",
    locked: true,
    async configure({ locked }) { this.locked = locked; },
    async getDocuments() { throw new Error("pack read failed"); }
  };
  try {
    globalThis.game = {
      user: { isGM: true },
      actors: { contents: [] },
      items: { contents: [] },
      scenes: { contents: [] },
      packs: { contents: [pack] },
      collections: new Map(),
      settings: {
        storage: new Map([["world", { contents: [] }]]),
        get: (_systemId, key) => settingValues.get(key),
        async set(_systemId, key, value) {
          settingWrites.push([key, value]);
          settingValues.set(key, value);
          return value;
        }
      },
      system: { id: "cyberpunk2020-rilerena", version: "2.0.0" }
    };
    globalThis.ui = { notifications: { info() {}, error() {} } };
    await migrateWorld();
    assert.equal(
      settingWrites.some(([key]) => key === "systemMigrationVersion"),
      false,
      "a failed World pack migration must not stamp the World as migrated"
    );
    assert.equal(pack.locked, true);
  } finally {
    globalThis.game = previousGame;
    globalThis.ui = previousUi;
  }
}

async function assertConcurrentWorldMigrationsAreSingleFlight() {
  const previousGame = globalThis.game;
  const previousUi = globalThis.ui;
  const settingWrites = [];
  let releaseUpdate;
  let actorUpdateCalls = 0;
  const updateGate = new Promise(resolve => { releaseUpdate = resolve; });
  const actor = {
    id: "actor-race",
    name: "Failing concurrent actor",
    documentName: "Actor",
    type: "npc",
    system: { damage: "1" },
    items: [{
      id: "skill-current",
      name: "Current Skill",
      documentName: "Item",
      type: "skill",
      system: { source: "", isChipped: false },
      async update() {}
    }],
    async update() {
      actorUpdateCalls += 1;
      await updateGate;
      throw new Error("concurrent write failed");
    }
  };
  try {
    const user = { id: "gm", isGM: true, active: true };
    globalThis.game = {
      user,
      users: { contents: [user] },
      actors: { contents: [actor] },
      items: { contents: [] },
      scenes: { contents: [] },
      packs: { contents: [] },
      collections: new Map(),
      settings: {
        async set(...args) { settingWrites.push(args); }
      },
      system: { id: "cyberpunk2020-rilerena", version: "2.0.0" }
    };
    globalThis.ui = { notifications: { info() {}, error() {} } };

    const first = migrateWorld();
    const second = migrateWorld();
    assert.equal(first, second, "concurrent callers must share one migration operation");
    releaseUpdate();
    assert.deepEqual(await Promise.all([first, second]), [false, false]);
    assert.equal(actorUpdateCalls, 1, "the same Actor must not be migrated twice concurrently");
    assert.deepEqual(settingWrites, [], "a shared failed migration must never write the version stamp");
  } finally {
    globalThis.game = previousGame;
    globalThis.ui = previousUi;
  }
}

async function assertInvalidDocumentsPreventVersionStamp() {
  assert.throws(
    () => assertNoInvalidMigrationDocuments({
      collections: new Map([["Actor", { invalidDocumentIds: new Set(["broken-actor"]) }]]),
      packs: { contents: [
        { collection: "world.items", invalidDocumentIds: new Set(["broken-item"]) },
        { collection: "unrelated-module.items", invalidDocumentIds: new Set(["not-our-document"]) }
      ] }
    }),
    /World collection Actor: broken-actor.*Compendium world\.items: broken-item/
  );
  assert.doesNotThrow(() => assertNoInvalidMigrationDocuments({
    collections: new Map(),
    packs: { contents: [
      { collection: "unrelated-module.items", invalidDocumentIds: new Set(["not-our-document"]) }
    ] }
  }), "another package's invalid pack must not block this system's World migration");

  const nestedInvalidWorld = {
    collections: new Map([
      ["Actor", {
        invalidDocumentIds: new Set(),
        contents: [{
          id: "actor-with-broken-item",
          items: { invalidDocumentIds: new Set(["broken-embedded-item"]), contents: [] }
        }]
      }],
      ["Scene", {
        invalidDocumentIds: new Set(),
        contents: [{
          id: "scene-with-broken-delta",
          tokens: {
            invalidDocumentIds: new Set(),
            contents: [{
              id: "token-with-broken-delta",
              delta: {
                id: "delta-with-broken-item",
                items: { invalidDocumentIds: new Set(["broken-delta-item"]), contents: [] }
              }
            }]
          }
        }]
      }]
    ]),
    packs: { contents: [] }
  };
  assert.throws(
    () => assertNoInvalidMigrationDocuments(nestedInvalidWorld),
    /broken-embedded-item.*broken-delta-item/,
    "invalid embedded Actor and ActorDelta Items must be detected recursively"
  );

  const previousGame = globalThis.game;
  const previousUi = globalThis.ui;
  const settingWrites = [];
  try {
    globalThis.game = {
      user: { isGM: true },
      actors: nestedInvalidWorld.collections.get("Actor"),
      items: { contents: [] },
      scenes: nestedInvalidWorld.collections.get("Scene"),
      packs: { contents: [] },
      collections: nestedInvalidWorld.collections,
      settings: {
        storage: new Map([["world", { contents: [] }]]),
        async set(...args) { settingWrites.push(args); }
      },
      system: { id: "cyberpunk2020-rilerena", version: "2.0.0" }
    };
    globalThis.ui = { notifications: { info() {}, error() {} } };
    await migrateWorld();
    assert.deepEqual(settingWrites, [], "uninitialized Documents must prevent the migration version stamp");
  } finally {
    globalThis.game = previousGame;
    globalThis.ui = previousUi;
  }
}

async function assertResolvedValidationFailuresPreventMigration() {
  const previousGame = globalThis.game;
  const previousUi = globalThis.ui;
  const settingWrites = [];
  let adventureUpdateCalls = 0;
  const droppedFailure = {
    empty: false,
    unresolved: false,
    getAllFailures() {
      return {
        "actors.0": { dropped: true, unresolved: false, message: "invalid Actor was dropped" }
      };
    }
  };
  const adventure = {
    id: "adventure-with-dropped-actor",
    name: "Dropped Actor Adventure",
    documentName: "Adventure",
    validationFailures: { fields: droppedFailure, joint: null },
    toObject() { return { _id: this.id, name: this.name, actors: [], items: [], scenes: [] }; },
    async update() { adventureUpdateCalls += 1; }
  };
  const pack = {
    collection: "world.dropped-adventure",
    title: "Dropped Adventure",
    locked: false,
    invalidDocumentIds: new Set(),
    contents: [adventure],
    async getDocuments() { return [adventure]; }
  };

  await assert.rejects(
    () => migrateCompendium(pack),
    /fields validation failure.*actors\.0/,
    "a resolved-but-dropped Adventure element is still unsafe to persist"
  );
  assert.equal(adventureUpdateCalls, 0, "a truncated Adventure must not be rewritten");

  try {
    const user = { id: "gm", isGM: true, active: true };
    globalThis.game = {
      user,
      users: { contents: [user] },
      actors: { contents: [] },
      items: { contents: [] },
      scenes: { contents: [] },
      packs: { contents: [pack] },
      collections: new Map(),
      settings: { async set(...args) { settingWrites.push(args); } },
      system: { id: "cyberpunk2020-rilerena", version: "2.0.0" }
    };
    globalThis.ui = { notifications: { info() {}, error() {} } };
    assert.equal(await migrateWorld(), false);
    assert.deepEqual(settingWrites, [], "resolved validation fallbacks must prevent the version stamp");
    assert.equal(adventureUpdateCalls, 0);
  } finally {
    globalThis.game = previousGame;
    globalThis.ui = previousUi;
  }
}

function assertLegacySkillChipMigration() {
  const updates = migrateItem({
    name: "Legacy chip skill",
    type: "skill",
    system: { source: "", chipped: true }
  });
  assert.equal(updates["system.isChipped"], true);
  assertForcedDeletion(updates, "system.chipped");
}

function assertEnabledLegacySkillChipIsPreserved() {
  const updates = migrateItem({
    name: "Current chip skill",
    type: "skill",
    system: { source: "", isChipped: false, chipped: true }
  });
  assert.equal(updates["system.isChipped"], true);
  assertForcedDeletion(updates, "system.chipped");
}

function assertLegacyRangeDamageArrayIsConverted() {
  const updates = migrateItem({
    name: "Array-based shotgun",
    type: "weapon",
    system: {
      source: "",
      rangeDamages: ["6d6", "5d6", "4d6", "3d6", ""]
    }
  });
  assert.deepEqual(updates["system.rangeDamages"], {
    pointBlank: "6d6",
    close: "5d6",
    medium: "4d6",
    far: "3d6"
  });
  assert.throws(
    () => migrateItem({
      name: "Five-band legacy shotgun",
      type: "weapon",
      system: { source: "", rangeDamages: ["6d6", "5d6", "4d6", "3d6", "2d6"] }
    }),
    /unsupported legacy range damage data/,
    "a meaningful unsupported range band must not be silently discarded"
  );
}

function assertLegacyShotgunRangeMigration() {
  const updates = migrateItem({
    name: "Legacy shotgun",
    type: "weapon",
    system: {
      source: "",
      rangeDamages: { pointBlank: "6d6", short: "5d6", medium: "4d6", far: "3d6" }
    }
  });
  assert.equal(updates["system.rangeDamages.close"], "5d6");
  assertForcedDeletion(updates, "system.rangeDamages.short");
}

function assertCurrentCloseDamageWinsOverLegacyShort() {
  const updates = migrateItem({
    name: "Mixed shotgun",
    type: "weapon",
    system: {
      source: "",
      rangeDamages: { pointBlank: "6d6", close: "5d6+1", short: "5d6", medium: "4d6", far: "3d6" }
    }
  });
  assert.equal(updates["system.rangeDamages.close"], undefined);
  assertForcedDeletion(updates, "system.rangeDamages.short");
}

function assertMissingRangeDamageDefaultsUseCurrentSchema() {
  const updates = migrateItem({
    name: "Unconfigured weapon",
    type: "weapon",
    system: { source: "" }
  });
  assert.deepEqual(updates["system.rangeDamages"], {
    pointBlank: "",
    close: "",
    medium: "",
    far: ""
  });
}

async function assertNumericActorDamageIsPreserved() {
  const { migrateActor } = await import("../../module/migrate.js");
  const updates = await migrateActor({
    name: "Legacy wounded actor",
    type: "character",
    system: { damage: "5" },
    prototypeToken: { actorLink: true, sight: { enabled: true } },
    items: [{ type: "skill" }]
  });
  assert.equal(updates["system.damage"], 5, "a version-gated rerun must not heal legacy actors");
}

async function assertInvalidLegacyDamageFailsClosed() {
  const { migrateActor } = await import("../../module/migrate.js");
  await assert.rejects(
    () => migrateActor({
      name: "Malformed Actor",
      type: "npc",
      system: { damage: "not-a-number" },
      items: [{ type: "skill" }]
    }),
    /invalid legacy damage value/,
    "invalid Actor damage must not be silently reset"
  );

  await assert.rejects(
    () => migrateSyntheticTokenActors([{
      name: "Malformed Delta Scene",
      tokens: [{
        name: "Malformed Delta Token",
        actorLink: false,
        actor: null,
        delta: {
          system: { damage: "Infinity" },
          items: [],
          toObject() { return { system: structuredClone(this.system), items: [] }; }
        },
        async update() { throw new Error("invalid damage must fail before writing"); }
      }]
    }], { throwOnError: true }),
    /invalid legacy damage value/,
    "invalid detached ActorDelta damage must abort before persistence"
  );

  let adventureWrites = 0;
  await assert.rejects(
    () => migrateCompendium({
      collection: "world.invalid-damage-adventure",
      title: "Invalid Damage Adventure",
      locked: false,
      async getDocuments() {
        return [{
          id: "invalid-damage-adventure",
          name: "Invalid Damage Adventure",
          documentName: "Adventure",
          toObject() {
            return {
              actors: [{
                _id: "actor-1",
                name: "Base Actor",
                type: "npc",
                system: {},
                items: [{ _id: "skill-1", name: "Handgun", type: "skill", system: { source: "" } }]
              }],
              items: [],
              scenes: [{
                _id: "scene-1",
                tokens: [{
                  _id: "token-1",
                  actorId: "actor-1",
                  actorLink: false,
                  delta: { system: { damage: "oops" }, items: [] }
                }]
              }]
            };
          },
          async update() { adventureWrites += 1; return this; }
        }];
      }
    }),
    /invalid legacy damage value/,
    "invalid Adventure ActorDelta damage must abort"
  );
  assert.equal(adventureWrites, 0);
}

async function assertIntentionalTokenSettingsArePreserved() {
  const { migrateActor } = await import("../../module/migrate.js");
  const updates = await migrateActor({
    name: "Unlinked actor without vision",
    type: "character",
    system: {},
    prototypeToken: {
      actorLink: false,
      disposition: -1,
      sight: { enabled: false, range: 0 }
    },
    items: [{ type: "skill" }]
  });
  assert.equal(updates["prototypeToken.actorLink"], undefined);
  assert.equal(updates["prototypeToken.disposition"], undefined);
  assert.equal(updates["prototypeToken.sight.enabled"], undefined);
  assert.equal(updates["prototypeToken.sight.range"], undefined);
}

async function assertMissingTokenDefaultsAreMigrated() {
  const { migrateActor } = await import("../../module/migrate.js");
  const updates = await migrateActor({
    name: "Legacy token defaults",
    type: "character",
    system: {},
    prototypeToken: { sight: {} },
    items: [{ type: "skill" }]
  });
  assert.equal(updates["prototypeToken.actorLink"], true);
  assert.equal(updates["prototypeToken.disposition"], 1);
  assert.equal(updates["prototypeToken.sight.enabled"], true);
  assert.equal(updates["prototypeToken.sight.range"], 30);
}

async function assertLegacyTokenVisionUsesV14Paths() {
  const { migrateActor } = await import("../../module/migrate.js");
  const updates = await migrateActor({
    name: "Very old token defaults",
    type: "character",
    system: {},
    token: { vision: false, dimSight: 12 },
    items: [{ type: "skill" }]
  });
  assert.equal(updates["prototypeToken.sight.enabled"], false, "an explicit legacy vision choice must survive");
  assert.equal(updates["prototypeToken.sight.range"], 12, "legacy dimSight must move to the V14 sight range");
  assert.equal(updates["token.vision"], undefined, "migration must not write removed Actor token paths");
  assert.equal(updates["token.dimSight"], undefined, "migration must not write removed Actor token paths");
}

async function assertLegacyActorSkillsAreConvertedWithoutUndefinedDeletes() {
  const previousPacks = globalThis.game.packs;
  try {
    globalThis.game.packs = {
      get: () => ({
        async getDocuments() {
          return [{
            name: "Athletics",
            toObject: () => ({ name: "Athletics", type: "skill", system: { level: 0 } })
          }];
        }
      })
    };
    const updates = await (await import("../../module/migrate.js")).migrateActor({
      name: "Legacy skills actor",
      type: "npc",
      system: {
        skills: {
          Athletics: { value: 0, chipValue: 0, chipped: false, ip: 9, stat: "ref" },
          Authority: { value: 0, chipValue: 0, chipped: false, ip: 0, isSpecial: true, stat: "cool" },
          CombatSense: { value: 0, chipValue: 0, chipped: false, ip: 3, isSpecial: true, stat: "" },
          Expert: {
            group: true,
            Cryptography: { value: 0, chipValue: 0, chipped: false, ip: 4, stat: "int" }
          },
          Language: {
            group: true,
            Esperanto: { value: 0, chipValue: 0, chipped: true, ip: 0, stat: "int" }
          }
        }
      },
      items: []
    });
    assertForcedDeletion(updates, "system.skills");
    assertForcedDeletion(updates, "system.sortedSkillIDs");
    const athletics = updates.items.find(item => item.name === "Athletics");
    assert.equal(athletics.system.level, 0);
    assert.equal(athletics.system.ip, 9, "IP-only legacy skill progress must survive");
    assert.equal(updates.items.some(item => item.name === "Authority"), false, "pristine role defaults must not become Items");
    assert.equal(updates.items.find(item => item.name === "Combat Sense").system.ip, 3, "IP-only role progress must survive");
    assert.equal(updates.items.find(item => item.name === "Expert: Cryptography").system.ip, 4);
    assert.equal(updates.items.find(item => item.name === "Language: Esperanto").system.isChipped, true);
    assert.throws(
      () => convertOldSkill("Malformed", { value: "not-a-number" }),
      /not a finite number/,
      "malformed numeric legacy state must fail closed"
    );
  } finally {
    globalThis.game.packs = previousPacks;
  }
}

async function assertSourceOnlyLegacySkillsAreLocaleIndependent() {
  const previousI18n = globalThis.game.i18n;
  try {
    // The Items below were persisted while Spanish was active, but this V14
    // migration deliberately runs in English. Matching must not depend on the
    // locale selected during either operation.
    globalThis.game.i18n = {
      has: key => ["CYBERPUNK.SkillHandgun", "CYBERPUNK.SkillKarate"].includes(key),
      localize: key => ({
        "CYBERPUNK.SkillHandgun": "Handgun",
        "CYBERPUNK.SkillKarate": "Karate"
      })[key] || key
    };
    const sourceSkills = {
      Handgun: { value: 7, chipValue: 0, chipped: false, ip: 20, stat: "ref" },
      MartialArts: {
        group: true,
        Karate: { value: 5, chipValue: 0, chipped: false, ip: 11, stat: "ref" }
      }
    };
    const updates = await (await import("../../module/migrate.js")).migrateActor({
      name: "Spanish-created actor migrated in English",
      type: "npc",
      system: {},
      toObject: () => ({ system: { skills: sourceSkills } }),
      items: [
        {
          _id: "handgun-1",
          name: "Handgun",
          type: "skill",
          system: { level: 0, notes: "keep handgun notes" }
        },
        {
          _id: "localized-handgun-1",
          name: "Armas Cortas",
          type: "skill",
          system: {
            level: 8,
            chipLevel: 0,
            isChipped: false,
            ip: 30,
            diffMod: 1,
            isRoleSkill: false,
            stat: "ref",
            notes: "",
            flavor: ""
          },
          flags: {},
          effects: []
        },
        {
          _id: "karate-1",
          name: "Martial Arts: Karate",
          type: "skill",
          system: { level: 6, notes: "keep karate notes", diffMod: 2 }
        }
      ]
    });

    assertForcedDeletion(updates, "system.skills");
    const migratedItems = updates.items;
    assert.equal(migratedItems.length, 2, "locale aliases must not leave duplicate skills");
    const handgun = migratedItems.find(item => item.name === "Handgun");
    assert.equal(handgun._id, "handgun-1");
    assert.equal(handgun.system.level, 8, "newer Item progress must win over stale legacy Actor progress");
    assert.equal(handgun.system.ip, 30);
    assert.equal(handgun.system.notes, "keep handgun notes");
    assert.equal(migratedItems.some(item => item.name === "Armas Cortas"), false);
    const karate = migratedItems.find(item => item.name === "Martial Arts: Karate");
    assert.equal(karate._id, "karate-1");
    assert.equal(karate.system.level, 6, "an existing canonical Item must beat stale legacy Actor progress");
    assert.equal(karate.system.notes, "keep karate notes");
    assert.equal(karate.system.diffMod, 2);

    const literalKeyUpdates = await (await import("../../module/migrate.js")).migrateActor({
      name: "Actor with persisted missing localization keys",
      type: "npc",
      system: {
        skills: {
          MartialArts: {
            group: true,
            Aikido: { value: 2, chipValue: 0, chipped: false, ip: 3, stat: "ref" }
          },
          Expert: {
            group: true,
            Cryptography: { value: 1, chipValue: 0, chipped: false, ip: 2, stat: "int" }
          }
        }
      },
      items: [
        { _id: "aikido", name: "Martial Arts: Aikido", type: "skill", system: { level: 4, ip: 8, stat: "ref" } },
        {
          _id: "aikido-literal",
          name: "Martial Arts: CYBERPUNK.SkillAikido",
          type: "skill",
          system: { level: 0, ip: 0, stat: "ref" }
        },
        { _id: "expert", name: "Expert: Cryptography", type: "skill", system: { level: 0, ip: 0, stat: "int" } },
        {
          _id: "expert-literal",
          name: "Expert: CYBERPUNK.SkillCryptography",
          type: "skill",
          system: { level: 3, ip: 6, stat: "int" }
        }
      ]
    });
    assert.equal(literalKeyUpdates.items.length, 2, "literal missing-key aliases must be folded");
    assert.equal(literalKeyUpdates.items.find(item => item._id === "aikido").system.level, 4);
    assert.equal(literalKeyUpdates.items.find(item => item._id === "expert").system.level, 3);

    await assert.rejects(
      () => (import("../../module/migrate.js")).then(({ migrateActor }) => migrateActor({
        name: "Divergent missing-key aliases",
        type: "npc",
        system: {
          skills: {
            Expert: {
              group: true,
              Cryptography: { value: 1, chipValue: 0, chipped: false, ip: 2, stat: "int" }
            }
          }
        },
        items: [
          { _id: "expert", name: "Expert: Cryptography", type: "skill", system: { level: 2, ip: 4, stat: "int" } },
          {
            _id: "expert-literal",
            name: "Expert: CYBERPUNK.SkillCryptography",
            type: "skill",
            system: { level: 3, ip: 6, stat: "int" }
          }
        ]
      })),
      /divergent progress/,
      "divergent literal missing-key aliases must fail closed"
    );

    await assert.rejects(
      () => (import("../../module/migrate.js")).then(({ migrateActor }) => migrateActor({
        name: "Ambiguous localized actor",
        type: "npc",
        system: { skills: sourceSkills },
        items: [
          { _id: "canonical", name: "Handgun", type: "skill", system: { level: 6, ip: 10 } },
          { _id: "localized", name: "Armas Cortas", type: "skill", system: { level: 8, ip: 30 } }
        ]
      })),
      /divergent progress/,
      "two independently edited aliases must fail closed instead of silently discarding one"
    );

    await assert.rejects(
      () => (import("../../module/migrate.js")).then(({ migrateActor }) => migrateActor({
        name: "Ambiguous zero-progress actor",
        type: "npc",
        system: { skills: { Handgun: { value: 0, chipValue: 0, chipped: false, ip: 0, stat: "ref" } } },
        items: [
          { _id: "canonical", name: "Handgun", type: "skill", system: { level: 0, isRoleSkill: false, stat: "" } },
          { _id: "localized", name: "Armas Cortas", type: "skill", system: { level: 0, isRoleSkill: false, stat: "tech" } }
        ]
      })),
      /divergent stat/,
      "blank and populated stats are both meaningful and must not be folded silently"
    );

    const actorUpdates = [];
    const embeddedDeletes = [];
    const liveItems = [
      {
        _id: "handgun-1",
        name: "Handgun",
        documentName: "Item",
        type: "skill",
        system: { source: "", level: 0, notes: "keep handgun notes" },
        toObject() {
          return { _id: this._id, name: this.name, type: this.type, system: structuredClone(this.system) };
        },
        async update() { return this; }
      },
      {
        _id: "localized-handgun-1",
        name: "Armas Cortas",
        documentName: "Item",
        type: "skill",
        system: { source: "", level: 8, ip: 30, isChipped: false },
        toObject() {
          return { _id: this._id, name: this.name, type: this.type, system: structuredClone(this.system) };
        },
        async update() { return this; }
      }
    ];
    const liveActor = {
      name: "Live localized actor",
      documentName: "Actor",
      type: "npc",
      system: {},
      items: liveItems,
      toObject: () => ({ system: { skills: sourceSkills } }),
      async update(update) { actorUpdates.push(update); return this; },
      async deleteEmbeddedDocuments(documentName, ids) {
        embeddedDeletes.push([documentName, ids]);
        return ids.map(_id => ({ _id }));
      }
    };
    await migrateCompendium({
      collection: "world.localized-actors",
      title: "Localized Actors",
      locked: false,
      async getDocuments() { return [liveActor]; }
    });
    assert.equal(actorUpdates[0].items.length, 2, "unmatched legacy skills are preserved alongside the deduplicated Item");
    assertForcedDeletion(actorUpdates[0], "system.sortedSkillIDs");
    assert.deepEqual(
      embeddedDeletes,
      [["Item", ["localized-handgun-1"]]],
      "live duplicate removal must use embedded deletion semantics"
    );
  } finally {
    globalThis.game.i18n = previousI18n;
  }
}

async function assertConcreteItemProgressWinsStaleLegacySkills() {
  const { migrateActor } = await import("../../module/migrate.js");
  const previousPacks = globalThis.game.packs;
  try {
    globalThis.game.packs = {
      get: () => ({
        async getDocuments() {
          return [{ name: "Athletics", type: "skill", toObject() { return { name: this.name, type: this.type, system: {} }; } }];
        }
      })
    };
    const updates = await migrateActor({
      name: "Previously migrated actor",
      type: "npc",
      system: {
        skills: {
          Handgun: { value: 4, chipValue: 0, chipped: false, ip: 8, stat: "ref" },
          Athletics: { value: 0, chipValue: 0, chipped: false, ip: 0, stat: "ref" }
        }
      },
      items: [{
        _id: "handgun-current",
        name: "Handgun",
        type: "skill",
        system: { level: 7, chipLevel: 0, isChipped: false, ip: 24, stat: "ref" }
      }]
    });
    assertForcedDeletion(updates, "system.skills");
    assert.equal(updates.items, undefined, "stale legacy state must neither rewrite an Item nor resurrect a deleted default skill");
  } finally {
    globalThis.game.packs = previousPacks;
  }
}

function assertSingleActiveGmOwnsAutomaticMigration() {
  const users = [
    { id: "gm-b", isGM: true, active: true },
    { id: "gm-a", isGM: true, active: true },
    { id: "player", isGM: false, active: true }
  ];
  assert.equal(isPrimaryActiveGM(users[0], users), false);
  assert.equal(isPrimaryActiveGM(users[1], users), true);
  assert.equal(isPrimaryActiveGM(users[2], users), false);
}

function assertForcedDeletion(update, path) {
  assert.equal(Object.hasOwn(update, path), true, `${path} must use an explicit deletion operator`);
  assert.equal(typeof update[path], "object");
  assert.notEqual(update[path], null);
  assert.equal(Object.keys(update).some(key => key.includes(".-=")), false, "V14 deprecated -= deletion keys");
}
