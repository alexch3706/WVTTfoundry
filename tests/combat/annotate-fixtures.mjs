#!/usr/bin/env node
/**
 * Annotate every singleShotCase in every fixture JSON file with a ruleReference string.
 * Reads each file, adds ruleReference to every case, writes back.
 */

import { readFile, readdir, writeFile } from "node:fs/promises";

const FIXTURE_DIR = new URL("./fixtures/", import.meta.url);

const ANNOTATIONS = {
  "ranged-single-shot.json": {
    outcomeEvidence: "CP2020 p.99: Attack roll formula; CP2020 p.102: Hit location; CP2020 p.105: Armor/AP/BTM pipeline",
    cases: {
      "structured hit with ranged modifier evidence":
        "CP2020 p.99: Range DC table (Medium=20); CP2020 p.99: Aiming rounds; CP2020 p.100: Blinded modifier; CP2020 p.100: Misc modifiers; CP2020 p.99: Weapon Accuracy",
      "structured miss skips location":
        "CP2020 p.99: Attack roll vs DC; miss skips location/damage rolls",
      "structured hit applies manual cover as armor layer":
        "CP2020 p.105: Cover stopping power; CP2020 p.105: Proportional armor layering",
      "structured AP penetration plans staged armor ablation":
        "CP2020 p.106: Armor Piercing halving; CP2020 p.106: Staged Penetration; Audit 3.3: Staged armor ablation on penetration",
      "structured AP penetration respects staged penetration disabled":
        "Audit: stagedPenetration setting disabled; CP2020 p.106: AP halving without ablation",
      "structured layered armor ablates outer item-backed layer":
        "CP2020 p.105: Proportional Armor Layering; CP2020 p.106: Staged Penetration on outer layer",
      "structured stopped hit with damage exceeding outer layer plans outer layer ablation":
        "Epic 9: Outer layer armor stress",
      "structured stopped hit does not plan staged armor ablation":
        "CP2020 p.106: No penetration = no staged ablation",
      "structured penetrating hit applies minimum damage after BTM":
        "CP2020 p.106: Minimum 1 damage after BTM",
      "structured head hit doubles wound damage":
        "CP2020 p.102: Head hit doubles damage; CP2020 p.108: Head hit > 8 damage = special (auto-death threshold)",
      "structured limb hit over threshold surfaces severing warning":
        "CP2020 p.108: Limb > 8 damage = severed/crushed",
      "structured manual cover penetration has no staged armor target":
        "CP2020 p.106: Staged Penetration only applies to item-backed armor",
      "structured hit uses options-only aimed location":
        "CP2020 p.99: Aimed shot (-4 to hit); CP2020 p.102: Hit Location table",
      "structured hit without location model is manual":
        "Audit: missing hit-location model blocks automated resolution",
      "structured outcome warns when ammo is insufficient":
        "Audit 6.4: Awaited update discipline — insufficient ammo blocks automated update",
      "structured outcome warns when ammo state is missing":
        "Audit 6.4: Missing ammo state blocks ammo updates",
      "structured outcome warns when ammo state is fractional":
        "Audit 6.4: Fractional ammo state is invalid",
      "structured outcome warns when ammo update target is missing":
        "Audit 6.4: Missing item UUID blocks ammo update planning",
      "structured path falls back when range data is missing":
        "Audit 6.4: Missing range data triggers legacy fallback",
      "structured unarmored hit resolves damage and stun save":
        "CP2020 p.107: Wound State table; CP2020 p.108: Stun/Shock save",
      "structured hit causing Mortal wound state generates stun and death saves":
        "CP2020 p.107: Mortal wound state (13+); CP2020 p.108: Death Saves",
      "structured stopped hit on already Mortal target does not resolve attack-time recurring death save reminder":
        "CP2020 p.108: Recurring Death Saves are turn-start reminders, not attack-time zero-damage prompts"
    }
  },
  "three-round-burst.json": {
    outcomeEvidence: "CP2020 p.99: Three-Round Burst rules; CP2020 p.102: Hit locations",
    cases: {
      "three-round burst success with 2 hits and progressive ablation":
        "CP2020 p.99: Three-Round Burst; CP2020 p.106: Progressive armor ablation (staged penetration)",
      "three-round burst success with 1 bullet remaining in weapon":
        "CP2020 p.99: Burst with limited ammo; ammo delta = min(shotsLeft, 3)",
      "three-round burst miss skips location/damage rolls and subtracts 3 ammo":
        "CP2020 p.99: Burst miss consumes 3 ammo; skip damage rolls",
      "three-round-burst-close-range-advantage":
        "CP2020 p.99: Burst +3 at Close range; CP2020 p.99: Range DC table (Close=15)",
      "three-round-burst-aimed-location":
        "CP2020 p.99: Burst +3 at any range; CP2020 p.99: Aimed shot (-4)",
      "three-round-burst-fumble-standard-jam":
        "CP2020 p.99: Natural 1 is Fumble; CP2020 p.99: Standard reliability jams on fumble",
      "three-round-burst-fumble-very-reliable":
        "CP2020 p.99: VeryReliable does not jam on fumble",
      "three-round-burst-fumble-unreliable":
        "CP2020 p.99: Unreliable jams and damages on fumble",
      "three-round-burst-zero-ammo":
        "CP2020 p.99: Burst requires ammo; Audit 6.4: Insufficient ammo warning"
    }
  },
  "ranged-full-auto.json": {
    outcomeEvidence: "CP2020 p.100: Full Auto rules; CP2020 p.100: ROF divided per target",
    cases: {
      "full auto success with 3 hits and progressive ablation at close range (+3 mod)":
        "CP2020 p.100: Full Auto; CP2020 p.100: Close range +3; CP2020 p.106: Staged armor ablation",
      "full auto success at medium range with 10 bullets (-1 mod) and 1 hit":
        "CP2020 p.100: Full Auto at Medium (-1 mod per 10 ROF); CP2020 p.99: Range DC (Medium=20)",
      "full auto success with 5 bullets left at close range (0 mod) and 5 hits":
        "CP2020 p.100: Full Auto 0 mod (5 ROF); hit cap = margin of success",
      "full auto multi-target success with 25 shots on 2 targets":
        "CP2020 p.100: ROF halved per target; separate attack rolls",
      "full-auto-single-target-miss":
        "CP2020 p.100: Full Auto miss consumes ROF ammo",
      "full-auto-fumble-standard-jam":
        "CP2020 p.99: Natural 1 Fumble; Standard reliability jam",
      "full-auto-fumble-very-reliable":
        "CP2020 p.99: VeryReliable does not jam on fumble",
      "full-auto-long-range":
        "CP2020 p.99: Range DC (Long=25); CP2020 p.100: Full Auto at Long range",
      "full-auto-zero-ammo":
        "CP2020 p.100: Full Auto requires ammo; Audit 6.4: Insufficient ammo warning",
      "full-auto-multi-target-jam-abort":
        "CP2020 p.100: Full Auto multi-target jam aborts remaining targets"
    }
  },
  "reliability-jam.json": {
    outcomeEvidence: "CP2020 p.99: Weapon Reliability and Jams; fumble behavior varies by reliability tier",
    cases: {
      "full-auto-fumble-standard":
        "CP2020 p.99: Standard reliability jams on Natural 1; clear stoppage before next shot",
      "full-auto-fumble-unreliable":
        "CP2020 p.99: Unreliable jams and damages on Natural 1; repair required",
      "full-auto-fumble-very-reliable":
        "CP2020 p.99: VeryReliable does not jam on Natural 1",
      "burst-fumble-standard":
        "CP2020 p.99: ThreeRoundBurst fumble with Standard reliability = jam",
      "semi-auto-fumble-standard":
        "CP2020 p.99: Semi-auto fumble = miss but no jam (ammo still consumed)",
      "full-auto-hit-no-fumble":
        "CP2020 p.99: Non-fumble attack resolves normally",
      "full-auto-fumble-missing-reliability":
        "CP2020 p.99: Missing reliability defaults to standard jam behavior"
    }
  },
  "unsupported-modes.json": {
    outcomeEvidence: "Audit 6.2: Exotic weapon type and missing-input guards",
    cases: {
      "suppressive-no-inputs-fidelity - reject to legacy warning":
        "Audit 6.2: Corebook Fidelity mode rejects missing inputs",
      "suppressive-no-inputs-relaxed - routes to resolver, returns resolver manual outcome":
        "Audit 6.2: Relaxed mode routes to resolver which returns manual outcome",
      "full-auto-fidelity-supported":
        "Audit 6.2: FullAuto is a supported attack type in Corebook Fidelity mode",
      "three-round-burst-fidelity-supported":
        "Audit 6.2: ThreeRoundBurst is supported in Corebook Fidelity mode"
    }
  },
  "melee-baseline.json": {
    outcomeEvidence: "CP2020 p.100: Melee Attacker vs Defender opposed roll; CP2020 p.100: Melee damage = weapon + strength bonus",
    cases: {
      "melee-attacker-wins":
        "CP2020 p.100: Melee opposed roll — attacker wins = hit; strength damage bonus applied",
      "melee-defender-wins":
        "CP2020 p.100: Melee opposed roll — defender wins = miss",
      "melee-tie":
        "CP2020 p.100: Melee tie = defender wins (attacker does not beat defender)",
      "melee-fumble":
        "CP2020 p.99: Melee Natural 1 = fumble (miss)",
      "melee-actorless-target":
        "Audit: Missing target actor blocks melee resolution",
      "martial-action-shell":
        "CP2020 p.101: Martial Arts — Strike (baseline damageOnly category)",
      "martial-strike-karate-bonus":
        "CP2020 p.101: Karate Strike +2 key technique bonus",
      "martial-kick-savate-bonus":
        "CP2020 p.101: Savate Kick +2 key technique bonus",
      "martial-block-parry":
        "CP2020 p.101: Boxing Block/Parry +1 key technique bonus (non-damage category)",
      "martial-dodge-capoeira":
        "CP2020 p.101: Capoeira Dodge +1 key technique bonus (non-damage category)",
      "martial-disarm-aikido":
        "CP2020 p.101: Aikido Disarm +1; prerequisite check (requires BlockParry, Dodge)",
      "martial-grapple-karate":
        "CP2020 p.101: Karate Grapple (grappleFamily, no key technique bonus for grapple)",
      "martial-choke-requires-hold":
        "CP2020 p.101: Choke requires prerequisite Hold state (confirmed)",
      "martial-escape-requires-grapple-hold":
        "CP2020 p.101: Escape requires Grapple or Hold state (confirmed); Judo +1",
      "martial-unknown-action-fallback":
        "CP2020 p.101: Unknown martial action falls back to damageOnly category",
      "melee-bt13-vs-bt14":
        "CP2020 p.106: BTM table — BT 13 = -6, BT 14 = -6; strengthDamageBonus BT 13 = +5",
      "melee-bt15-vs-bt15":
        "CP2020 p.106: BTM table — BT 15 = -8; strengthDamageBonus BT 15 = +8",
      "melee-bt10-vs-bt10":
        "CP2020 p.106: BTM table — BT 10 = -4; strengthDamageBonus BT 10 = +2",
      "melee-bt11-vs-bt11":
        "CP2020 p.106: BTM table — BT 11 = -5; strengthDamageBonus BT 11 = +4",
      "martial-throw-requires-grapple-without-state":
        "CP2020 p.101: Throw requires Grapple + BlockParry + Dodge prerequisites (unconfirmed)",
      "martial-choke-without-hold-state":
        "CP2020 p.101: Choke requires Hold (unconfirmed) — manual resolution required",
      "martial-escape-without-any-state":
        "CP2020 p.101: Escape requires Grapple or Hold (unconfirmed) — manual resolution required",
      "martial-hold-requires-grapple-with-state":
        "CP2020 p.101: Hold requires Grapple (confirmed); Aikido +1",
      "martial-sweep-trip-basic":
        "CP2020 p.101: Sweep/Trip (grappleFamily); Capoeira +1"
    }
  }
};

async function main() {
  let missingCount = 0;
  const fixtureFiles = (await readdir(FIXTURE_DIR))
    .filter(filename => filename.endsWith(".json"))
    .sort();

  for (const filename of fixtureFiles) {
    const annotations = ANNOTATIONS[filename] || { cases: {} };
    const url = new URL(filename, FIXTURE_DIR);
    const data = JSON.parse(await readFile(url, "utf8"));
    let modified = false;

    // Annotate outcomeEvidence at top level
    if (annotations.outcomeEvidence && data.outcomeEvidence) {
      if (!data.outcomeEvidence.ruleReference) {
        data.outcomeEvidence.ruleReference = annotations.outcomeEvidence;
        modified = true;
      }
    }

    // Annotate each singleShotCase
    for (const singleCase of (data.singleShotCases || [])) {
      if (singleCase.ruleReference) continue;
      const ref = annotations.cases[singleCase.name];
      if (ref) {
        singleCase.ruleReference = ref;
        modified = true;
      } else {
        console.error(`WARNING: No annotation found for case "${singleCase.name}" in ${filename}`);
        missingCount++;
      }
    }

    if (modified) {
      await writeFile(url, JSON.stringify(data, null, 2) + "\n", "utf8");
      console.log(`✅ ${filename} — annotated`);
    } else {
      console.log(`⏭️ ${filename} — already annotated or no changes`);
    }
  }

  if (missingCount > 0) {
    console.error(`\n❌ Failed: ${missingCount} fixture cases are missing annotations.`);
    process.exit(1);
  }
}

await main().catch(e => {
  console.error(e);
  process.exit(1);
});
