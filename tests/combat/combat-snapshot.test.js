import assert from "node:assert/strict";
import { buildActorCombatSnapshot } from "../../module/combat/combat-snapshot.js";

export function runCombatSnapshotTests() {
  const results = [];
  try {
    assertCyberwareSDPOverlay();
    results.push({ name: "assertCyberwareSDPOverlay", passed: true });
  } catch(e) {
    console.error(e);
    results.push({ name: "assertCyberwareSDPOverlay", passed: false });
  }
  
  try {
    assertMaxSDPTakenForMultipleCyberware();
    results.push({ name: "assertMaxSDPTakenForMultipleCyberware", passed: true });
  } catch(e) {
    console.error(e);
    results.push({ name: "assertMaxSDPTakenForMultipleCyberware", passed: false });
  }

  try {
    assertFBCSpecificCyberwareOverride();
    results.push({ name: "assertFBCSpecificCyberwareOverride", passed: true });
  } catch(e) {
    console.error(e);
    results.push({ name: "assertFBCSpecificCyberwareOverride", passed: false });
  }

  try {
    assertZeroSDPIsIgnored();
    results.push({ name: "assertZeroSDPIsIgnored", passed: true });
  } catch(e) {
    console.error(e);
    results.push({ name: "assertZeroSDPIsIgnored", passed: false });
  }

  try {
    assertDamagedCyberlimbSDPIsPreserved();
    results.push({ name: "assertDamagedCyberlimbSDPIsPreserved", passed: true });
  } catch(e) {
    console.error(e);
    results.push({ name: "assertDamagedCyberlimbSDPIsPreserved", passed: false });
  }

  return results;
}

function assertDamagedCyberlimbSDPIsPreserved() {
  const mockActor = {
    system: {
      stats: {}, damage: 0, isFBC: false,
      hitLocations: {
        rarm: { label: "Right Arm", type: "cybernetic", sdp: { value: 20, max: 30 } }
      }
    },
    itemTypes: {
      cyberware: [
        { id: "1", system: { equipped: true, location: "rarm", sdp: 30 } }
      ]
    }
  };
  const snapshot = buildActorCombatSnapshot(mockActor, { includeEquipment: true });
  assert.equal(snapshot.hitLocations.rarm.sdp?.value, 20, "combat snapshots must not heal damaged cyberlimbs");
  assert.equal(snapshot.hitLocations.rarm.sdp?.max, 30);
}

function assertCyberwareSDPOverlay() {
  const mockActor = {
    system: {
      stats: {}, damage: 0, isFBC: false,
      hitLocations: { rarm: { label: "Right Arm", type: "flesh" } }
    },
    itemTypes: {
      cyberware: [
        { id: "1", system: { equipped: true, location: "rarm", sdp: 20 } }
      ]
    }
  };
  const snapshot = buildActorCombatSnapshot(mockActor, { includeEquipment: true });
  assert.equal(snapshot.hitLocations.rarm.type, "cybernetic");
  assert.equal(snapshot.hitLocations.rarm.sdp?.value, 20);
}

function assertMaxSDPTakenForMultipleCyberware() {
  const mockActor = {
    system: {
      stats: {}, damage: 0, isFBC: false,
      hitLocations: { rarm: { label: "Right Arm", type: "flesh" } }
    },
    itemTypes: {
      cyberware: [
        { id: "1", system: { equipped: true, location: "rarm", sdp: 15 } },
        { id: "2", system: { equipped: true, location: "rarm", sdp: 30 } },
        { id: "3", system: { equipped: true, location: "rarm", sdp: 10 } }
      ]
    }
  };
  const snapshot = buildActorCombatSnapshot(mockActor, { includeEquipment: true });
  assert.equal(snapshot.hitLocations.rarm.type, "cybernetic");
  assert.equal(snapshot.hitLocations.rarm.sdp?.value, 30, "Should take maximum SDP of 30");
}

function assertFBCSpecificCyberwareOverride() {
  const mockActor = {
    system: {
      stats: {}, damage: 0, isFBC: true,
      hitLocations: {
        rarm: { label: "Right Arm", type: "cybernetic", sdp: { value: 20, max: 20 } },
        larm: { label: "Left Arm", type: "cybernetic", sdp: { value: 20, max: 20 } }
      }
    },
    itemTypes: {
      cyberware: [
        { id: "1", system: { equipped: true, location: "rarm", sdp: 15 } }
      ]
    }
  };
  const snapshot = buildActorCombatSnapshot(mockActor, { includeEquipment: true });
  assert.equal(snapshot.hitLocations.rarm.sdp?.value, 15, "Specific 15 SDP should override FBC 20");
  assert.equal(snapshot.hitLocations.larm.sdp?.value, 20, "Larm should remain FBC 20");
}

function assertZeroSDPIsIgnored() {
  const mockActor = {
    system: {
      stats: {}, damage: 0, isFBC: false,
      hitLocations: { head: { label: "Head", type: "flesh" } }
    },
    itemTypes: {
      cyberware: [
        { id: "1", system: { equipped: true, location: "head", sdp: 0 } }
      ]
    }
  };
  const snapshot = buildActorCombatSnapshot(mockActor, { includeEquipment: true });
  assert.equal(snapshot.hitLocations.head.type, "flesh", "Should remain flesh if SDP is 0");
  assert.equal(snapshot.hitLocations.head.sdp, undefined, "Should not add SDP object if 0");
}
