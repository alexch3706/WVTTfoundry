import assert from "node:assert/strict";



import { CyberpunkActor } from "../../module/actor/actor.js";

export function runActorDataTests() {
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

  return results;
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
