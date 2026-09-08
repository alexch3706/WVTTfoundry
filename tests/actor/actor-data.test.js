import assert from "node:assert/strict";



import { buildActorCreationUpdates, CyberpunkActor } from "../../module/actor/actor.js";

export async function runActorDataTests() {
  const results = [];
  try {
    assertPartialCyberlimbSDP();
    results.push({ name: "assertPartialCyberlimbSDP", passed: true });
  } catch(e) {
    console.error(e);
    results.push({ name: "assertPartialCyberlimbSDP", passed: false });
  }

  try {
    assertMaxSDPSelection();
    results.push({ name: "assertMaxSDPSelection", passed: true });
  } catch(e) {
    console.error(e);
    results.push({ name: "assertMaxSDPSelection", passed: false });
  }

  try {
    assertFBCOverride();
    results.push({ name: "assertFBCOverride", passed: true });
  } catch(e) {
    console.error(e);
    results.push({ name: "assertFBCOverride", passed: false });
  }

  try {
    assertItemBasedCombatSense();
    results.push({ name: "assertItemBasedCombatSense", passed: true });
  } catch(e) {
    console.error(e);
    results.push({ name: "assertItemBasedCombatSense", passed: false });
  }

  try {
    assertMissingItemSkillsAreSafe();
    results.push({ name: "assertMissingItemSkillsAreSafe", passed: true });
  } catch(e) {
    console.error(e);
    results.push({ name: "assertMissingItemSkillsAreSafe", passed: false });
  }

  try {
    await assertV14ActorCreationLifecycle();
    results.push({ name: "assertV14ActorCreationLifecycle", passed: true });
  } catch(e) {
    console.error(e);
    results.push({ name: "assertV14ActorCreationLifecycle", passed: false });
  }

  return results;
}

async function assertV14ActorCreationLifecycle() {
  const previousGame = globalThis.game;
  const actor = new CyberpunkActor();
  let sourceUpdate;
  actor.updateSource = update => { sourceUpdate = update; };

  try {
    globalThis.game = {
      system: { id: "cyberpunk2020-rilerena" },
      settings: { get: () => false },
      packs: {
        get: id => id === "cyberpunk2020-rilerena.default-skills" ? {
          async getDocuments() {
            return [
              { name: "Stealth", type: "skill", toObject: () => ({ name: "Stealth", type: "skill", system: {} }) },
              { name: "Athletics", type: "skill", toObject: () => ({ name: "Athletics", type: "skill", system: {} }) }
            ];
          }
        } : undefined
      }
    };

    const allowed = await actor._preCreate({
      type: "character",
      items: [{ name: "Starting Gear", type: "misc", system: {} }]
    }, {}, { id: "creator" });

    assert.equal(allowed, true, "the base lifecycle result must be preserved");
    assert.equal(actor._mockBasePreCreateCalls, 1, "the V14 base pre-create lifecycle must run exactly once");
    assert.equal(sourceUpdate["prototypeToken.actorLink"], true);
    assert.equal(sourceUpdate["prototypeToken.sight.enabled"], true);
    assert.equal(sourceUpdate["system.skillsSortedBy"], "Name");
    assert.deepEqual(sourceUpdate.items.map(item => item.name), ["Starting Gear", "Athletics", "Stealth"]);
    assert.equal(sourceUpdate._id, undefined, "pre-create source updates must not patch document IDs");

    assert.deepEqual(
      buildActorCreationUpdates({ type: "npc", items: [{ type: "skill" }] }, [{ type: "skill", name: "Default" }]),
      {},
      "actors which already contain skills must retain their creation source unchanged"
    );

    let packReads = 0;
    globalThis.game.packs.get = () => {
      packReads += 1;
      throw new Error("the default pack must not be read");
    };
    const actorWithSkill = new CyberpunkActor();
    let existingSkillUpdate;
    actorWithSkill.updateSource = update => { existingSkillUpdate = update; };
    await actorWithSkill._preCreate({ type: "character", items: [{ type: "skill", name: "Custom" }] });
    assert.equal(packReads, 0, "actors created with skills must not read the defaults pack");
    assert.deepEqual(existingSkillUpdate, {
      "prototypeToken.actorLink": true,
      "prototypeToken.sight.enabled": true
    }, "character token defaults are independent from skill seeding");

    const deniedActor = new CyberpunkActor();
    deniedActor._mockPreCreateResult = false;
    let deniedUpdateCalls = 0;
    deniedActor.updateSource = () => { deniedUpdateCalls += 1; };
    assert.equal(await deniedActor._preCreate({ type: "character" }), false);
    assert.equal(deniedUpdateCalls, 0, "a canceled base lifecycle must not mutate creation data");
  } finally {
    globalThis.game = previousGame;
  }
}

function assertPartialCyberlimbSDP() {
  const mockActor = {
    type: "character",
    items: {
      contents: [
        {
          type: "cyberware",
          system: {
            equipped: true,
            location: "lArm",
            sdp: 30
          }
        }
      ]
    },
    woundState: () => "Light",
    system: {
      stats: {
        int: { base: 5, tempMod: 0 },
        ref: { base: 5, tempMod: 0 },
        tech: { base: 5, tempMod: 0 },
        cool: { base: 5, tempMod: 0 },
        attr: { base: 5, tempMod: 0 },
        luck: { base: 5, tempMod: 0 },
        ma: { base: 5, tempMod: 0 },
        bt: { base: 5, tempMod: 0 },
        emp: { base: 5, tempMod: 0 }
      },
      hitLocations: {
        lArm: { label: "Left Arm", location: [6], type: "flesh" },
        rArm: { label: "Right Arm", location: [5], type: "flesh" }
      }
    }
  };

  // Call the method
  CyberpunkActor.prototype._prepareCharacterData.call(mockActor, mockActor.system);

  // Assertions
  assert.equal(mockActor.system.hitLocations.lArm.type, "cybernetic", "lArm should be upgraded to cybernetic type");
  assert.equal(mockActor.system.hitLocations.lArm.sdp?.max, 30, "lArm max SDP should be set to 30");
  assert.equal(mockActor.system.hitLocations.lArm.sdp?.value, 30, "lArm current SDP should initialize to 30");
  
  assert.equal(mockActor.system.hitLocations.rArm.type, "flesh", "rArm should remain flesh");
  assert.equal(mockActor.system.hitLocations.rArm.sdp, undefined, "rArm should not have SDP initialized");
}

function assertMaxSDPSelection() {
  const mockActor = {
    type: "character",
    items: {
      contents: [
        { type: "cyberware", system: { equipped: true, location: "lArm", sdp: 15 } },
        { type: "cyberware", system: { equipped: true, location: "lArm", sdp: 30 } },
        { type: "cyberware", system: { equipped: true, location: "lArm", sdp: 10 } }
      ]
    },
    woundState: () => "Light",
    system: {
      stats: { int: {base:5, tempMod:0}, ref: {base:5, tempMod:0}, tech: {base:5, tempMod:0}, cool: {base:5, tempMod:0}, attr: {base:5, tempMod:0}, luck: {base:5, tempMod:0}, ma: {base:5, tempMod:0}, bt: {base:5, tempMod:0}, emp: {base:5, tempMod:0} },
      hitLocations: {
        lArm: { label: "Left Arm", location: [6], type: "flesh" }
      }
    }
  };

  CyberpunkActor.prototype._prepareCharacterData.call(mockActor, mockActor.system);

  assert.equal(mockActor.system.hitLocations.lArm.sdp?.max, 30, "Should select max SDP among multiple items on the same location");
}

function assertFBCOverride() {
  const mockActor = {
    type: "character",
    items: {
      contents: [
        {
          type: "cyberware",
          system: {
            equipped: true,
            isFBC: true,
            fbcHitLocations: {
              lArm: { sdp: 20 },
              rArm: { sdp: 20 }
            }
          }
        },
        {
          type: "cyberware",
          system: {
            equipped: true,
            location: "lArm",
            sdp: 40
          }
        }
      ]
    },
    woundState: () => "Light",
    system: {
      stats: { int: {base:5, tempMod:0}, ref: {base:5, tempMod:0}, tech: {base:5, tempMod:0}, cool: {base:5, tempMod:0}, attr: {base:5, tempMod:0}, luck: {base:5, tempMod:0}, ma: {base:5, tempMod:0}, bt: {base:5, tempMod:0}, emp: {base:5, tempMod:0} },
      hitLocations: {
        lArm: { label: "Left Arm", location: [6], type: "flesh" },
        rArm: { label: "Right Arm", location: [5], type: "flesh" }
      }
    }
  };

  CyberpunkActor.prototype._prepareCharacterData.call(mockActor, mockActor.system);

  assert.equal(mockActor.system.hitLocations.rArm.sdp?.max, 20, "rArm should fallback to FBC max SDP");
  assert.equal(mockActor.system.hitLocations.lArm.sdp?.max, 40, "lArm should override FBC with specific cyberware max SDP");
}

function assertItemBasedCombatSense() {
  const originalGame = globalThis.game;
  const actor = Object.create(CyberpunkActor.prototype);
  actor.system = { stats: { ref: { total: 8 } } };
  actor.itemTypes = {
    skill: [
      { name: "Awareness/Notice", type: "skill", system: { level: 4, isChipped: false } },
      { name: "Combat Sense", type: "skill", system: { level: 6, chipLevel: 3, isChipped: true } }
    ]
  };

  assert.equal(actor.getCombatSenseValue(), 3, "Combat Sense should use the embedded Item's active chip value");
  assert.equal(actor.isAwarenessNoticeSkill(actor.itemTypes.skill[0]), true, "Awareness/Notice should be recognized as the linked Item skill");
  assert.equal(actor.getRollData().itemSkills.combatSense.value, 3, "initiative roll data should expose Item-based Combat Sense");

  try {
    globalThis.game = {
      i18n: {
        localize: key => ({
          "CYBERPUNK.SkillCombatSense": "Sentido de Combate",
          "CYBERPUNK.SkillAwarenessNotice": "Advertir/Notar"
        })[key] || key
      }
    };
    actor.itemTypes.skill = [
      { name: "Advertir/Notar", type: "skill", system: { level: 4 } },
      { name: "Sentido de Combate", type: "skill", system: { level: 7 } }
    ];
    assert.equal(actor.getCombatSenseValue(), 7, "localized Combat Sense Items should be resolved through i18n aliases");
    assert.equal(actor.isAwarenessNoticeSkill(actor.itemTypes.skill[0]), true, "localized Awareness/Notice Items should be recognized");
  } finally {
    globalThis.game = originalGame;
  }
}

function assertMissingItemSkillsAreSafe() {
  const actor = Object.create(CyberpunkActor.prototype);
  actor.system = { stats: { ref: { total: 8 } } };
  actor.itemTypes = { skill: [] };

  assert.equal(actor.getCombatSenseValue(), 0, "actors without Combat Sense should receive a zero initiative bonus");
  assert.equal(actor.getSkillVal("Missing Skill"), 0, "missing embedded skills should resolve to zero instead of throwing");
  assert.equal(CyberpunkActor.realSkillValue(undefined), 0, "undefined skill values should be safe");
}
