import assert from "node:assert/strict";

import {
  buildArmorRepairUpdate,
  getArmorItemStatus,
  getCyberwareArmorStatus
} from "../../module/combat/armor-maintenance.js";

export function runArmorMaintenanceTests() {
  const results = [];

  function test(name, fn) {
    try {
      fn();
      results.push({ name: `armor maintenance: ${name}`, passed: true });
    } catch (err) {
      console.error(`FAIL: armor maintenance: ${name}`);
      console.error(err);
      results.push({ name: `armor maintenance: ${name}`, passed: false, error: err });
    }
  }

  test("Skinweave repair restores ablated armor cyberware", () => {
    const skinweave = {
      id: "skinweave",
      name: "Skinweave",
      type: "cyberware",
      system: {
        notes: "Armors whole body to SP 12. Diff 20 to spot",
        ablation: 4
      }
    };

    assert.deepEqual(getCyberwareArmorStatus(skinweave), {
      isArmor: true,
      baseStoppingPower: 12,
      ablation: 4,
      currentStoppingPower: 8,
      repairable: true
    });
    assert.deepEqual(buildArmorRepairUpdate(skinweave), {
      "system.ablation": 0
    });
  });

  test("zoned Skinweave repair restores only ablated coverage zones", () => {
    const skinweave = {
      id: "zoned-skinweave",
      name: "Skinweave",
      type: "cyberware",
      system: {
        coverage: {
          Torso: { stoppingPower: 12, ablation: 2 },
          lArm: { stoppingPower: 12, ablation: 1 },
          rArm: { stoppingPower: 12, ablation: 0 }
        }
      }
    };

    assert.deepEqual(getCyberwareArmorStatus(skinweave), {
      isArmor: true,
      baseStoppingPower: 12,
      ablation: 2,
      currentStoppingPower: 12,
      repairable: true,
      locations: [
        { location: "Torso", baseStoppingPower: 12, ablation: 2, currentStoppingPower: 10 },
        { location: "lArm", baseStoppingPower: 12, ablation: 1, currentStoppingPower: 11 },
        { location: "rArm", baseStoppingPower: 12, ablation: 0, currentStoppingPower: 12 }
      ]
    });
    assert.deepEqual(buildArmorRepairUpdate(skinweave), {
      "system.coverage.Torso.ablation": 0,
      "system.coverage.lArm.ablation": 0
    });
  });

  test("armor item repair restores ablated coverage zones", () => {
    const jacket = {
      id: "armor-jacket",
      name: "Kevlar Jacket",
      type: "armor",
      system: {
        coverage: {
          Head: { stoppingPower: 0, ablation: 0 },
          Torso: { stoppingPower: 14, ablation: 2 },
          lArm: { stoppingPower: 10, ablation: 1 },
          rArm: { stoppingPower: 10, ablation: 0 }
        }
      }
    };

    assert.deepEqual(getArmorItemStatus(jacket), {
      isArmor: true,
      baseStoppingPower: 14,
      ablation: 2,
      currentStoppingPower: 12,
      repairable: true,
      locations: [
        { location: "Torso", baseStoppingPower: 14, ablation: 2, currentStoppingPower: 12 },
        { location: "lArm", baseStoppingPower: 10, ablation: 1, currentStoppingPower: 9 },
        { location: "rArm", baseStoppingPower: 10, ablation: 0, currentStoppingPower: 10 }
      ]
    });
    assert.deepEqual(buildArmorRepairUpdate(jacket), {
      "system.coverage.Torso.ablation": 0,
      "system.coverage.lArm.ablation": 0
    });
  });

  test("depleted zones stay visible and over-ablation never reduces another zone", () => {
    const armor = { type: "armor", system: { coverage: {
      Torso: { stoppingPower: 10, ablation: 20 },
      lArm: { stoppingPower: 10, ablation: 0 }
    } } };
    const status = getArmorItemStatus(armor);
    assert.equal(status.currentStoppingPower, 10);
    assert.equal(status.locations[0].currentStoppingPower, 0);
    assert.equal(status.repairable, true);
  });

  test("protected objects are not displayed as body armor", () => {
    const item = { type: "armor", system: { armorRole: "protectedObject", coverage: { Torso: { stoppingPower: 40, ablation: 2 } } } };
    const status = getArmorItemStatus(item);
    assert.equal(status.isArmor, false);
    assert.equal(status.repairable, false);
  });

  return results;
}

if (process.argv[1] === import.meta.url || process.argv[1]?.endsWith("armor-maintenance.test.js")) {
  const results = runArmorMaintenanceTests();
  const failed = results.filter(r => !r.passed).length;
  if (failed > 0) process.exit(1);
}
