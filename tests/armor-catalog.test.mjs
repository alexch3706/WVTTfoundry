import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import test from "node:test";
import { normalizeArmorCatalog, getArmorCatalogOverrides, ARMOR_LOCATIONS } from "../tools/lib/normalize-armor-catalog.mjs";
import { getEquippedArmorForLocation } from "../module/combat/armor-resolver.js";

function legacy(name, { id = "test-item", type = "armor", coverage = { Torso: { stoppingPower: 18, ablation: 0 } } } = {}) {
  return { _id: id, name, type, system: { source: "CP20", notes: "Original source text", weight: 1, coverage } };
}

test("real armor profiles repair different protection at torso and arms", () => {
  const armor = normalizeArmorCatalog(legacy("Armored Motorcycle Jacket"), { packName: "armor" });
  assert.equal(armor.system.coverage.Torso.stoppingPower, 12);
  assert.equal(armor.system.coverage.lArm.stoppingPower, 4);
  assert.equal(armor.system.coverage.rArm.stoppingPower, 4);
  assert.equal(armor.system.coverage.Head.stoppingPower, 0);
  assert.equal(armor.system.encumbrance, 0);
  assert.equal(armor.system.automation.status, "ready");
  const layers = getEquippedArmorForLocation({ equippedArmor: [armor] }, "lArm");
  assert.equal(layers[0].stoppingPower, 4);
});

test("core armor exports explicit EV, material and the edged-weapons footnote", () => {
  const vest = normalizeArmorCatalog(legacy("Flak Vest*"));
  assert.equal(vest.system.encumbrance, 1);
  assert.equal(vest.system.coverage.Torso.layer, "hard");
  assert.equal(vest.system.coverage.Torso.stoppingPower, 20);
  assert.equal(vest.system.edgedHalfSP, true);
  assert.equal(vest.system.equipped, true);
  assert.equal(vest.system.automation.status, "ready");
});

test("helmets and stockings never provide torso or full-body protection", () => {
  const helmet = normalizeArmorCatalog(legacy("Sneaksuit Helmet"));
  assert.equal(helmet.system.coverage.Head.stoppingPower, 18);
  assert.equal(helmet.system.coverage.Torso.stoppingPower, 0);
  const stockings = normalizeArmorCatalog(legacy("Armored Stockings (SP 6)"));
  assert.equal(stockings.system.coverage.lLeg.stoppingPower, 6);
  assert.equal(stockings.system.coverage.Torso.stoppingPower, 0);
});

test("mixed military armor material and SP are retained per location", () => {
  const armor = normalizeArmorCatalog(legacy("Militech Combat Armor"));
  assert.equal(armor.system.coverage.Head.stoppingPower, 20);
  assert.equal(armor.system.coverage.Torso.stoppingPower, 18);
  assert.equal(armor.system.coverage.rLeg.stoppingPower, 14);
  assert.equal(armor.system.coverage.Head.layer, "hard");
  assert.equal(armor.system.coverage.rLeg.layer, "soft");
});

test("protected containers and held shields are not automatically worn body armor", () => {
  const box = normalizeArmorCatalog(legacy("Codelock Safebox (SP40, Self-destruct)", { id: "tf7b0t8o43QzM5aF", coverage: { Torso: { stoppingPower: 40 } } }));
  assert.equal(box.system.armorRole, "protectedObject");
  assert.equal(box.system.objectStoppingPower, 40);
  assert.equal(box.system.equipped, false);
  assert.deepEqual(getEquippedArmorForLocation({ equippedArmor: [box] }, "Torso"), []);
  const shield = normalizeArmorCatalog(legacy("Police Issue Riot Shield Held"));
  assert.equal(shield.system.armorRole, "shield");
  assert.equal(shield.system.objectStoppingPower, 15);
  assert.equal(shield.system.equipped, false);
});

test("partial protection and fire-only SP remain manual without invented body coverage", () => {
  for(const name of ["Hiking Boots", "Biotechnica Enviro Gloves Hands", "Fireproof Clothing"]) {
    const armor = normalizeArmorCatalog(legacy(name));
    assert.equal(armor.system.specialStoppingPower, 20);
    assert.equal(armor.system.automation.status, "manual");
    assert.ok(Object.values(armor.system.coverage).every(segment => segment.stoppingPower === 0));
  }
  const scuba = normalizeArmorCatalog(legacy('"Big Blue" Nuscuba Pack'));
  assert.equal(scuba.system.armorRole, "wornArmor");
  assert.equal(scuba.system.coverage.Head.stoppingPower, 15);
  assert.match(scuba.system.automation.reasons.join(" "), /back/);
});

test("protective cyberware has explicit coverage but ordinary implants remain untouched", () => {
  const skin = normalizeArmorCatalog(legacy("Skinweave", { type: "cyberware" }));
  assert.deepEqual(Object.keys(skin.system.coverage), ARMOR_LOCATIONS);
  assert.ok(Object.values(skin.system.coverage).every(segment => segment.stoppingPower === 12 && segment.layer === "soft"));
  const torso = normalizeArmorCatalog(legacy("Torso Plate", { type: "cyberware" }));
  assert.equal(torso.system.encumbrance, 3);
  assert.equal(torso.system.coverage.Torso.stoppingPower, 25);
  const ordinary = legacy("Audio Recorder", { type: "cyberware", coverage: undefined });
  assert.deepEqual(normalizeArmorCatalog(ordinary), ordinary);
});

test("percent coverage and unselected limbs require review", () => {
  const skull = normalizeArmorCatalog(legacy("Subdermal Skull Armor", { type: "cyberware" }));
  assert.equal(skull.system.automation.status, "manual");
  assert.match(skull.system.automation.reasons[0], /60%/);
  const limb = normalizeArmorCatalog(legacy("Limb Armor", { type: "cyberware" }));
  assert.equal(limb.system.specialStoppingPower, 20);
  assert.ok(Object.values(limb.system.coverage).every(segment => segment.stoppingPower === 0));
});

test("FBC shorthand does not manufacture limb SDP or activate FBC rules", () => {
  const fbc = normalizeArmorCatalog(legacy("Alpha Class", { type: "cyberware", id: "d33co2hrNofIEG6a", coverage: undefined }));
  assert.equal(fbc.system.isFBC, false);
  assert.equal(fbc.system.automation.status, "manual");
  assert.equal(fbc.system.fbcHitLocations, undefined);
});

test("normalization is immutable and idempotent and preserves original values for review", () => {
  const original = legacy("Heavy Armor Jacket");
  const before = structuredClone(original);
  const normalized = normalizeArmorCatalog(original, { packName: "armor" });
  assert.deepEqual(original, before);
  assert.equal(normalized._id, original._id);
  assert.equal(normalized.type, original.type);
  assert.deepEqual(normalized.flags["cyberpunk2020-rilerena"].catalog.sourceValues, before.system);
  assert.equal(normalized.system.weight, null);
  assert.deepEqual(normalizeArmorCatalog(normalized, { packName: "armor" }), normalized);
});

test("unknown items retain their identity and report unresolved mechanical fields", () => {
  const unknown = normalizeArmorCatalog(legacy("Unknown prototype armor"));
  assert.equal(unknown.system.encumbrance, null);
  assert.equal(unknown.system.coverage.Torso.layer, "");
  assert.equal(unknown.system.automation.status, "manual");
  assert.equal(unknown.system.coverage.Torso.stoppingPower, 18);
});

test("positive SP without a space and SP-changing upgrades cannot be silently ignored", () => {
  const skin = normalizeArmorCatalog(legacy("Toughened Skin", { type: "cyberware", id: "SapjWdzsdf2ph4RU" }));
  assert.equal(skin.system.specialStoppingPower, 6);
  assert.equal(skin.system.automation.status, "manual");
  for(const [id, name, expected] of [
    ["Gq8g57Gp29t0qrFS", "Increased SP", /increment and recipient/],
    ["HhHskpuJf5utuda8", "Squat", /selected cyberlimb/],
    ["iUkxqyLE91IIB9H3", "Tougher", /purchased level/],
    ["6gNWZb4Va5E9m96W", "Rippers", /activation state/],
    ["JHBz0VftWxZu5V7f", "Sharkman", /duplicating protection/]
  ]) {
    const item = legacy(name, { type: "cyberware", id });
    delete item.system.coverage;
    const normalized = normalizeArmorCatalog(item);
    assert.equal(normalized.system.automation.status, "manual");
    assert.match(normalized.system.automation.reasons[0], expected);
    assert.ok(Object.values(normalized.system.coverage).every(segment => segment.stoppingPower === 0));
  }
});

test("armor-penetrating weapons and healing Skinweave are not classified as protective implants", () => {
  for(const [id, name] of [
    ["JeGdfinEBw0eexDS", "Cutting Torch"],
    ["hYz4MrfT2fUVjIE0", "BigRipp"],
    ["XY3YGCng7lbMw4Tm", "Drill Hand"],
    ["QsyarHXPA7Lr3boj", "Tri-Dart Launcher"],
    ["Sj2KRsS0YCGwCRG6", "Lifesaver Skinweave"],
    ["y2DZQ5xNl2xlsQRy", "Nanowear Ozoneshield"]
  ]) {
    const original = legacy(name, { type: "cyberware", id });
    delete original.system.coverage;
    assert.deepEqual(normalizeArmorCatalog(original), original);
  }
});

test("every shipped cyberware armor claim is processed or has an explicit false-positive review", () => {
  const directory = new URL("../src/compendia/cyberware/", import.meta.url);
  const excluded = getArmorCatalogOverrides().cyberwareProtectionFalsePositives;
  const unreviewed = [];
  for(const filename of readdirSync(directory).filter(name => name.endsWith(".json"))) {
    const original = JSON.parse(readFileSync(new URL(filename, directory), "utf8"));
    const normalized = normalizeArmorCatalog(original, { packName: "cyberware" });
    if(normalized.system.automation) continue;
    const text = [original.name, original.system.notes, original.system.flavor].join(" ");
    const hasProtectionClaim = /\bSP\b|\bSP\s*\d+|\b\d+\s*SP\b|skin\s*weave|plating|exoskeleton/i.test(text)
      || Object.values(original.system.coverage || {}).some(segment => segment.stoppingPower > 0);
    if(hasProtectionClaim && !excluded[original._id]) unreviewed.push(`${original._id}: ${original.name}`);
  }
  assert.deepEqual(unreviewed, [], "New armor claims need a verified profile, a manual review reason or a documented false-positive decision.");
});
