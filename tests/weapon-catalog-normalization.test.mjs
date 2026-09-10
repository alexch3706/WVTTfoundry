import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { test } from "node:test";
import { normalizeCatalogRange, normalizeWeaponCatalog } from "../tools/lib/normalize-weapon-catalog.mjs";
import { damageFormulaBounds, validateWeaponContract } from "../module/item/item-contract.js";

const root = new URL("../src/compendia/", import.meta.url);
const source = (pack, id) => JSON.parse(readFileSync(new URL(`${pack}/${id}.json`, root), "utf8"));
const normalized = (pack, id) => normalizeWeaponCatalog(source(pack, id), { packName: pack });

test("ranges convert complete unit-bearing measurements, never missing values or variant bands", () => {
  for (const [input, expected] of [["400m", 400], ["1.5 km", 1500], ["20ft", 6.096], ["3.2 mi", 5149.9008], [50, 50]]) assert.equal(normalizeCatalogRange(input), expected);
  for (const value of [null, undefined, "", " ", false, "12/25m", "Touch", "LOS", "-", "0m"]) assert.equal(normalizeCatalogRange(value), null);
});

test("numeric table fragments never become larger dice, and reliability aliases remain safe", () => {
  const fixture = {
    _id: "test000000000001", name: "Test pistol", type: "weapon", system: {
      weaponType: "Pistol", attackType: "Auto", damage: "2d6 1 1", ammoType: "9mm",
      accuracy: "+0", range: "50m", shots: "8", rof: "2", reliability: " vr ", weight: 1
    }
  };
  const result = normalizeWeaponCatalog(fixture, { packName: "pistols" });
  assert.equal(result.system.damage, null);
  assert.equal(result.system.reliability, "VeryReliable");
  assert.equal(result.system.weight, null);
  assert.equal(result.flags["cyberpunk2020-rilerena"].catalog.sourceValues.weight, 1);
  assert.equal(result.system.automation.status, "manual");
  fixture.system.damage = "2d6 + 1";
  fixture.system.reliability = "VR*";
  const conditional = normalizeWeaponCatalog(fixture, { packName: "pistols" });
  assert.equal(conditional.system.damage, "2d6+1");
  assert.equal(conditional.system.reliability, null);
  assert.equal(conditional.system.automation.status, "manual");
});

test("a core pistol uses its real capacity and has no invented automatic fire", () => {
  const document = normalized("pistols", "0fzrC84PzMzrfJPx");
  assert.equal(document.name, "Armalite 44");
  assert.equal(document.system.shots, 8);
  assert.equal(document.system.shotsLeft, 8);
  assert.equal(document.system.range, 50);
  assert.equal(document.system.attackSkill, "Handgun");
  assert.deepEqual(document.system.fireModes, ["SemiAuto"]);
  assert.equal(document.system.automation.status, "ready");
});

test("a real rifle recovers caliber independently of BODY minimum and composite ROF", () => {
  const document = normalized("rifles", "srNOjbOVl5OuVY0L");
  assert.equal(document.system.ammoType, "5.56");
  assert.equal(document.system.bodyMinimum, 5);
  assert.equal(document.system.range, 400);
  assert.equal(document.system.rof, 30);
  assert.equal(document.system.shotsLeft, 35);
  assert.equal(document.system.attackSkill, "Rifle");
  assert.deepEqual(document.system.fireModes, ["SemiAuto", "ThreeRoundBurst", "FullAuto", "Suppressive"]);
  assert.equal(document.flags["cyberpunk2020-rilerena"].catalog.sourceValues.rof, "3/30");
});

test("normal and automatic shotguns have verified buckshot profiles and distinct modes", () => {
  const manualAction = normalized("shotguns", "yGI0MaMJgWsevJx1").system;
  const automatic = normalized("shotguns", "WMF5ySEGoMqFG4UB").system;
  assert.equal(manualAction.attackType, "Shotgun");
  assert.deepEqual(manualAction.fireModes, ["SemiAuto"]);
  assert.equal(automatic.attackType, "Autoshotgun");
  assert.deepEqual(automatic.fireModes, ["SemiAuto", "FullAuto"]);
  assert.equal(automatic.rof, 10);
  assert.deepEqual(manualAction.rangeDamages, { pointBlank: "4d6", close: "4d6", medium: "3d6", far: "2d6" });
  assert.equal(damageFormulaBounds(manualAction.rangeDamages.pointBlank).maximum, 24);
  assert.equal(manualAction.ap, false);
  assert.equal(manualAction.automation.status, "ready");
});

test("shotgun ammunition still uses a pattern when the weapon is cataloged as a pistol", () => {
  const pistol = normalized("pistols", "Z597tbqU9ucHAysd").system;
  assert.equal(pistol.weaponType, "Pistol");
  assert.equal(pistol.attackType, "Shotgun");
  assert.equal(pistol.attackSkill, "Handgun");
  assert.equal(pistol.rangeDamages.medium, "3d6");
  assert.equal(pistol.automation.status, "ready");
  assert.equal(normalized("shotguns", "ICtqxNGB14L17Kxh").system.weight, 15);
  assert.equal(normalized("pistols", "k3Z10lvnTR0jTFLO").system.automation.status, "manual");
});

test("source-backed base configurations resolve optional stocks and magazine extensions", () => {
  const raider = normalized("shotguns", "1HEsqKiBjyOgGlLf");
  const police = normalized("shotguns", "tXSEAge5nHqDEpVE");
  assert.equal(raider.system.shots, 5);
  assert.equal(raider.flags["cyberpunk2020-rilerena"].catalog.sourceValues.shots, "5/9");
  assert.match(raider.system.configuration, /five-round/);
  assert.equal(police.system.accuracy, 0);
  assert.match(police.system.configuration, /extended/);
  assert.equal(police.flags["cyberpunk2020-rilerena"].catalog.sourceValues.accuracy, "0/-1");
});

test("variant shotguns retain explicit manual reasons rather than fabricated range profiles", () => {
  const crusher = normalized("shotguns", "Hy5dkrTnPl07ZzvM").system;
  assert.equal(crusher.shots, 6);
  assert.equal(crusher.rof, 2);
  assert.equal(crusher.range, 25);
  assert.equal(crusher.accuracy, null);
  assert.equal(crusher.automation.status, "manual");
  assert.ok(crusher.automation.reasons.some(reason => reason.includes("12m")));
  for (const id of ["AppQOtF2RVd93zXj", "H4oybrOacL6ETLDC", "zUP8MG5s6lTMSkSR"]) {
    const weapon = normalized("shotguns", id).system;
    assert.equal(weapon.automation.status, "manual");
    assert.equal(weapon.rangeDamages.medium, "");
  }
});

test("core weapon variants preserve their source while selecting only verified base configurations", () => {
  const rifle = normalized("rifles", "Y4nClMmLPSE6BOTf");
  assert.equal(rifle.system.accuracy, -1);
  assert.equal(rifle.system.concealability, "ConcealNoHide");
  assert.equal(rifle.system.automation.status, "ready");
  assert.equal(rifle.flags["cyberpunk2020-rilerena"].catalog.sourceValues.accuracy, "-1/-2");
  const thompson = normalized("smgs", "TrOk4hfpGmiE0ZM0");
  assert.equal(thompson.system.shots, 30);
  assert.equal(thompson.system.shotsLeft, 30);
  assert.equal(thompson.system.reliability, null);
  assert.equal(thompson.system.automation.status, "manual");
  assert.ok(thompson.system.automation.reasons.some(reason => /ST.*VR/.test(reason)));
  assert.equal(thompson.flags["cyberpunk2020-rilerena"].catalog.sourceValues.shots, "30/50");
  assert.equal(thompson.flags["cyberpunk2020-rilerena"].catalog.sourceValues.reliability, "ST");
});

test("explosive malfunctions and mode-dependent accuracy keep precise manual guards", () => {
  const budget = normalized("pistols", "fJbZnxMM32e0gnNJ");
  assert.equal(budget.system.reliability, "Unreliable");
  assert.equal(budget.system.automation.status, "manual");
  assert.ok(budget.system.automation.reasons.some(reason => /10%.*explosion/.test(reason)));
  assert.equal(budget.flags["cyberpunk2020-rilerena"].catalog.sourceValues.reliability, "UR*");
  const sternmeyer = normalized("smgs", "Xq351oM6S4kA1Mpj");
  assert.equal(sternmeyer.system.accuracy, null);
  assert.equal(sternmeyer.system.automation.status, "manual");
  assert.ok(sternmeyer.system.automation.reasons.some(reason => /WA 0.*WA -1/.test(reason)));
  assert.ok(sternmeyer.system.automation.reasons.every(reason => !/table fragments/.test(reason)));
});

test("lost AP annotations and non-ballistic weapons cannot silently become normal bullets", () => {
  const evaw = normalized("rifles", "tG7nq5q46MAzpQ3p");
  assert.equal(evaw.system.ap, true);
  assert.equal(evaw.system.automation.status, "manual");
  assert.match(evaw.flags["cyberpunk2020-rilerena"].catalog.historicalDamage, /AP/);
  const taser = normalized("pistols", "2cVessrlAWppzNbI").system;
  assert.equal(taser.attackType, "Taser");
  assert.equal(taser.damage, null);
  assert.equal(taser.ap, null);
  assert.equal(taser.automation.status, "manual");
  const railgun = normalized("rifles", "q95uG8vegEoSBqIV").system;
  assert.equal(railgun.ap, null);
  assert.equal(railgun.automation.status, "manual");
});

test("verified melee damage retains the edged/blunt distinction without ballistic AP", () => {
  const knife = normalized("melee", "YB5pTQkSSdbh8jac").system;
  const club = normalized("melee", "ciPRLbBpUsxDIIWX").system;
  const switchblade = normalized("melee", "GuX6xQrgIml20izi").system;
  assert.equal(knife.damage, "1d6");
  assert.equal(knife.ap, false);
  assert.equal(knife.meleeDamageType, "edged");
  assert.equal(club.meleeDamageType, "blunt");
  assert.equal(knife.automation.status, "ready");
  assert.equal(switchblade.damage, "1d6/2");
  assert.equal(switchblade.automation.status, "ready");
  assert.equal(normalized("melee", "IOWhzJj5GdFxoItr").system.automation.status, "manual");
});

test("verified table-fragment repairs preserve ID and original name", () => {
  const document = normalized("rifles", "p5FokfzzLO2FWhmx");
  assert.equal(document._id, "p5FokfzzLO2FWhmx");
  assert.equal(document.name, "AKR-20 Medium Assault");
  assert.match(document.flags["cyberpunk2020-rilerena"].catalog.sourceName, /^HVY/);
  assert.equal(normalized("rifles", "p5UgONCNp4VO4gkT").system.ap, false, ".30-06 is not a 30mm cannon");
  const wrongIdentity = source("rifles", "p5FokfzzLO2FWhmx");
  wrongIdentity.name = "An unrelated item reusing the ID";
  assert.throws(() => normalizeWeaponCatalog(wrongIdentity, { packName: "rifles" }), /identity mismatch/);
});

test("every shipped weapon normalizes without mutation, remains idempotent and is valid or explicitly manual", () => {
  let count = 0, ready = 0;
  for (const pack of ["pistols", "rifles", "smgs", "shotguns", "heavyWeapons", "bows", "exotics", "melee", "weapons_other"]) {
    for (const filename of readdirSync(new URL(`${pack}/`, root))) {
      const document = JSON.parse(readFileSync(new URL(`${pack}/${filename}`, root), "utf8"));
      const original = structuredClone(document);
      const result = normalizeWeaponCatalog(document, { packName: pack });
      assert.deepEqual(document, original);
      assert.equal(result._id, document._id);
      assert.equal(result.type, document.type);
      assert.deepEqual(normalizeWeaponCatalog(result, { packName: pack }), result, `${pack}/${document._id} is not idempotent`);
      const metadata = result.flags["cyberpunk2020-rilerena"].catalog;
      assert.ok(metadata.sourceValues);
      assert.ok(metadata.evidence.length);
      if (result.system.automation.status === "ready") {
        ready++;
        const contract = validateWeaponContract(result.system, { strict: true });
        assert.equal(contract.valid, true, `${pack}/${document._id}: ${JSON.stringify(contract.issues)}`);
      } else {
        assert.equal(result.system.automation.status, "manual");
        assert.ok(result.system.automation.reasons.length);
      }
      count++;
    }
  }
  assert.equal(count, 607);
  assert.ok(ready >= 220, `Only ${ready} weapon records are usable after normalization`);
});
