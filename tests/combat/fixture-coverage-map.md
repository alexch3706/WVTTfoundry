# Fixture Coverage Map

**Generated:** automatically from every JSON file in `tests/combat/fixtures/`
**Total fixture cases:** 98

This map indexes rule references from the JSON fixture suite. A zero in the first
table means there is no JSON case for that area; it does not mean that focused
assertion modules have no coverage. Those modules are listed separately below.

---

## JSON Fixture Coverage by Area

| Rule / Audit Area | JSON Cases | Fixture Cases |
|---|---|---|
| Range DC Table | ✅ 6 | `ranged-full-auto.json` → full auto success at medium range with 10 bullets (-1 mod) and 1 hit<br>`ranged-full-auto.json` → full-auto-long-range<br>`ranged-single-shot.json` → structured hit with ranged modifier evidence<br>`ranged-single-shot.json` → structured PointBlank range hit<br>`ranged-single-shot.json` → structured Extreme range miss (6 total, showing 5) |
| Attack Roll Formula | ✅ 2 | `ranged-full-auto.json` → full auto multi-target success with 25 shots on 2 targets<br>`ranged-single-shot.json` → structured miss skips location |
| Aiming Rounds | ✅ 1 | `ranged-single-shot.json` → structured hit with ranged modifier evidence |
| Blinded Modifier | ✅ 1 | `ranged-single-shot.json` → structured hit with ranged modifier evidence |
| Misc Modifiers | ✅ 1 | `ranged-single-shot.json` → structured hit with ranged modifier evidence |
| Weapon Accuracy | ✅ 1 | `ranged-single-shot.json` → structured hit with ranged modifier evidence |
| Hit Location | ✅ 1 | `ranged-single-shot.json` → structured hit uses options-only aimed location |
| Cover Stopping Power | ✅ 5 | `ranged-single-shot.json` → structured hit applies manual cover before personal armor<br>`ranged-single-shot.json` → structured manual cover penetration emits cover ablation evidence<br>`ranged-single-shot.json` → structured cover penetration can continue into personal armor<br>`ranged-single-shot.json` → structured cover stop does not stage-ablate personal armor<br>`ranged-single-shot.json` → structured cover and layered armor penetration ablates personal layers only |
| Armor & AP | ✅ 13 | `ranged-full-auto.json` → full auto success with 3 hits and progressive ablation at close range (+3 mod)<br>`ranged-single-shot.json` → structured cyberware staged penetration uses system-ablation update path<br>`ranged-single-shot.json` → structured outer armor stop does not prematurely ablate cyberware<br>`ranged-single-shot.json` → structured hit applies manual cover before personal armor<br>`ranged-single-shot.json` → structured AP penetration plans staged armor ablation (13 total, showing 5) |
| Staged Penetration | ✅ 9 | `ranged-single-shot.json` → structured outer armor stop does not prematurely ablate cyberware<br>`ranged-single-shot.json` → structured AP penetration plans staged armor ablation<br>`ranged-single-shot.json` → structured AP penetration respects staged penetration disabled<br>`ranged-single-shot.json` → structured layered armor ablates all participating layers<br>`ranged-single-shot.json` → structured stopped hit does not plan staged armor ablation (9 total, showing 5) |
| Progressive Ablation | ✅ 14 | `ranged-full-auto.json` → full auto success with 3 hits and progressive ablation at close range (+3 mod)<br>`ranged-full-auto.json` → full auto layered armor second hit recalculates degraded effective SP<br>`ranged-single-shot.json` → structured cyberware staged penetration uses system-ablation update path<br>`ranged-single-shot.json` → structured outer armor stop does not prematurely ablate cyberware<br>`ranged-single-shot.json` → structured AP penetration plans staged armor ablation (14 total, showing 5) |
| Body Type Modifier | ✅ 6 | `melee-baseline.json` → melee-bt13-vs-bt14<br>`melee-baseline.json` → melee-bt15-vs-bt15<br>`melee-baseline.json` → melee-bt10-vs-bt10<br>`melee-baseline.json` → melee-bt11-vs-bt11<br>`ranged-single-shot.json` → structured penetrating hit applies minimum damage after BTM (6 total, showing 5) |
| Minimum Damage (1 after BTM) | ✅ 1 | `ranged-single-shot.json` → structured penetrating hit applies minimum damage after BTM |
| Wound State | ✅ 2 | `ranged-single-shot.json` → structured unarmored hit resolves damage and stun save<br>`ranged-single-shot.json` → structured hit causing Mortal wound state generates stun and death saves |
| Head Hit Specials | ✅ 1 | `ranged-single-shot.json` → structured head hit doubles wound damage |
| Limb Loss Threshold | ✅ 1 | `ranged-single-shot.json` → structured limb hit over threshold surfaces severing warning |
| Save Prompts (Stun/Death) | ✅ 6 | `fbc-baseline.json` → biological saves bypassed<br>`ranged-single-shot.json` → structured head hit doubles wound damage<br>`ranged-single-shot.json` → structured unarmored hit resolves damage and stun save<br>`ranged-single-shot.json` → structured hit causing Mortal wound state generates stun and death saves<br>`ranged-single-shot.json` → structured stopped hit on already Mortal target does not resolve attack-time recurring death save reminder (6 total, showing 5) |
| Mortal Wound & Death Saves | ✅ 2 | `ranged-single-shot.json` → structured hit causing Mortal wound state generates stun and death saves<br>`ranged-single-shot.json` → structured mortal 7+ suppresses death save as dead/manual state |
| Recurring Death Save | ✅ 1 | `ranged-single-shot.json` → structured stopped hit on already Mortal target does not resolve attack-time recurring death save reminder |
| Three-Round Burst | ✅ 9 | `reliability-jam.json` → burst-fumble-standard<br>`three-round-burst.json` → three-round burst success with 2 hits and progressive ablation<br>`three-round-burst.json` → three-round burst success with 1 bullet remaining in weapon<br>`three-round-burst.json` → three-round burst miss skips location/damage rolls and subtracts 3 ammo<br>`three-round-burst.json` → three-round-burst-close-range-advantage (9 total, showing 5) |
| Full Auto | ✅ 11 | `ranged-full-auto.json` → full auto success with 3 hits and progressive ablation at close range (+3 mod)<br>`ranged-full-auto.json` → full auto layered armor second hit recalculates degraded effective SP<br>`ranged-full-auto.json` → full auto success at medium range with 10 bullets (-1 mod) and 1 hit<br>`ranged-full-auto.json` → full auto success with 5 bullets left at close range (0 mod) and 5 hits<br>`ranged-full-auto.json` → full auto multi-target later target hit preserves evidence and hit cap (11 total, showing 5) |
| ROF & Ammo | ✅ 5 | `ranged-full-auto.json` → full auto success at medium range with 10 bullets (-1 mod) and 1 hit<br>`ranged-full-auto.json` → full auto success with 5 bullets left at close range (0 mod) and 5 hits<br>`ranged-full-auto.json` → full auto multi-target success with 25 shots on 2 targets<br>`ranged-full-auto.json` → full auto multi-target later target hit preserves evidence and hit cap<br>`ranged-full-auto.json` → full-auto-single-target-miss |
| Suppressive Fire | 0 | — |
| Reliability & Jams | ✅ 14 | `melee-baseline.json` → melee-fumble<br>`ranged-full-auto.json` → full-auto-fumble-standard-jam<br>`ranged-full-auto.json` → full-auto-fumble-very-reliable<br>`ranged-full-auto.json` → full-auto-multi-target-jam-abort<br>`reliability-jam.json` → full-auto-fumble-standard (14 total, showing 5) |
| Melee Opposed Roll | ✅ 5 | `melee-baseline.json` → melee-attacker-wins<br>`melee-baseline.json` → melee-defender-wins<br>`melee-baseline.json` → melee-tie<br>`melee-baseline.json` → melee-fumble<br>`melee-baseline.json` → melee-actorless-target |
| Strength Damage Bonus | ✅ 5 | `melee-baseline.json` → melee-attacker-wins<br>`melee-baseline.json` → melee-bt13-vs-bt14<br>`melee-baseline.json` → melee-bt15-vs-bt15<br>`melee-baseline.json` → melee-bt10-vs-bt10<br>`melee-baseline.json` → melee-bt11-vs-bt11 |
| Martial Arts | ✅ 2 | `melee-baseline.json` → martial-action-shell<br>`melee-baseline.json` → martial-unknown-action-fallback |
| Grapple Family | ✅ 9 | `melee-baseline.json` → martial-grapple-karate<br>`melee-baseline.json` → martial-choke-requires-hold<br>`melee-baseline.json` → martial-escape-requires-grapple-hold<br>`melee-baseline.json` → martial-throw-requires-grapple-without-state<br>`melee-baseline.json` → martial-choke-without-hold-state (9 total, showing 5) |
| Grapple Prerequisites | ✅ 3 | `melee-baseline.json` → martial-disarm-aikido<br>`melee-baseline.json` → martial-choke-requires-hold<br>`melee-baseline.json` → martial-throw-requires-grapple-without-state |
| Attack Type Classification | ✅ 1 | `ranged-single-shot.json` → structured PointBlank unsupported damage formula rolls normally |
| Humanity & EMP | 0 | — |
| Edge Case / Manual Resolution | ✅ 10 | `melee-baseline.json` → melee-actorless-target<br>`melee-baseline.json` → martial-choke-without-hold-state<br>`melee-baseline.json` → martial-escape-without-any-state<br>`ranged-single-shot.json` → structured manual cover penetration emits cover ablation evidence<br>`ranged-single-shot.json` → structured hit without location model is manual (10 total, showing 5) |
| Ammo State & Updates | ✅ 10 | `ranged-full-auto.json` → full-auto-single-target-miss<br>`ranged-full-auto.json` → full-auto-zero-ammo<br>`ranged-single-shot.json` → structured outcome warns when ammo is insufficient<br>`ranged-single-shot.json` → structured outcome warns when ammo state is missing<br>`ranged-single-shot.json` → structured outcome warns when ammo state is fractional (10 total, showing 5) |
| Audit Compliance | ✅ 14 | `melee-baseline.json` → melee-actorless-target<br>`ranged-full-auto.json` → full-auto-zero-ammo<br>`ranged-single-shot.json` → structured AP penetration plans staged armor ablation<br>`ranged-single-shot.json` → structured AP penetration respects staged penetration disabled<br>`ranged-single-shot.json` → structured hit without location model is manual (14 total, showing 5) |
| Corebook Fidelity Mode | ✅ 3 | `ranged-single-shot.json` → structured weapon conformance label in snapshot<br>`unsupported-modes.json` → full-auto-fidelity-supported<br>`unsupported-modes.json` → three-round-burst-fidelity-supported |

---

## Detailed Case Index

| Fixture | Case | Rule Reference |
|---|---|---|
| `fbc-baseline.json` | headshot ignores multiplier | Story 10.6: Hitting an FBC in the head does not apply the headshot multiplier. |
| `fbc-baseline.json` | biological saves bypassed | Story 10.6: Hitting an FBC does not trigger biological Stun/Shock or Death sa... |
| `melee-baseline.json` | melee-attacker-wins | CP2020 p.100: Melee opposed roll — attacker wins = hit; CP2020 p.100: strengt... |
| `melee-baseline.json` | melee-defender-wins | CP2020 p.100: Melee opposed roll — defender wins = miss |
| `melee-baseline.json` | melee-tie | CP2020 p.100: Melee tie = defender wins (attacker does not beat defender) |
| `melee-baseline.json` | melee-fumble | CP2020 p.99: Melee Natural 1 = fumble (miss) |
| `melee-baseline.json` | melee-actorless-target | Audit 6.4: Missing target actor blocks melee resolution |
| `melee-baseline.json` | martial-action-shell | CP2020 p.101: Martial Arts — Strike (baseline damageOnly category) |
| `melee-baseline.json` | martial-strike-karate-bonus | CP2020 p.101: Karate Strike +2 key technique bonus |
| `melee-baseline.json` | martial-kick-savate-bonus | CP2020 p.101: Savate Kick +2 key technique bonus |
| `melee-baseline.json` | martial-block-parry | CP2020 p.101: Boxing Block/Parry +1 key technique bonus (non-damage category) |
| `melee-baseline.json` | martial-dodge-capoeira | CP2020 p.101: Capoeira Dodge +1 key technique bonus (non-damage category) |
| `melee-baseline.json` | martial-disarm-aikido | CP2020 p.101: Aikido Disarm +1; CP2020 p.101: prerequisite check (requires Bl... |
| `melee-baseline.json` | martial-grapple-karate | CP2020 p.101: Karate Grapple (grappleFamily, no key technique bonus for grapple) |
| `melee-baseline.json` | martial-choke-requires-hold | CP2020 p.101: Choke requires prerequisite Hold state (confirmed) |
| `melee-baseline.json` | martial-escape-requires-grapple-hold | CP2020 p.101: Escape requires Grapple or Hold state (confirmed); CP2020 p.101... |
| `melee-baseline.json` | martial-unknown-action-fallback | CP2020 p.101: Unknown martial action falls back to damageOnly category |
| `melee-baseline.json` | melee-bt13-vs-bt14 | CP2020 p.106: BTM table — BT 13 = -6, BT 14 = -6; CP2020 p.100: strengthDamag... |
| `melee-baseline.json` | melee-bt15-vs-bt15 | CP2020 p.106: BTM table — BT 15 = -8; CP2020 p.100: strengthDamageBonus BT 15... |
| `melee-baseline.json` | melee-bt10-vs-bt10 | CP2020 p.106: BTM table — BT 10 = -4; CP2020 p.100: strengthDamageBonus BT 10... |
| `melee-baseline.json` | melee-bt11-vs-bt11 | CP2020 p.106: BTM table — BT 11 = -5; CP2020 p.100: strengthDamageBonus BT 11... |
| `melee-baseline.json` | martial-throw-requires-grapple-without-state | CP2020 p.101: Throw requires Grapple + BlockParry + Dodge prerequisites (unco... |
| `melee-baseline.json` | martial-choke-without-hold-state | CP2020 p.101: Choke requires Hold (unconfirmed) — manual resolution required |
| `melee-baseline.json` | martial-escape-without-any-state | CP2020 p.101: Escape requires Grapple or Hold (unconfirmed) — manual resoluti... |
| `melee-baseline.json` | martial-hold-requires-grapple-with-state | CP2020 p.101: Hold requires Grapple (confirmed); CP2020 p.101: Aikido +1 |
| `melee-baseline.json` | martial-sweep-trip-basic | CP2020 p.101: Sweep/Trip (grappleFamily); CP2020 p.101: Capoeira +1 |
| `ranged-full-auto.json` | full auto success with 3 hits and progressive ablation at close range (+3 mod) | CP2020 p.100: Full Auto; CP2020 p.100: Close range +3; CP2020 p.106: Staged a... |
| `ranged-full-auto.json` | full auto layered armor second hit recalculates degraded effective SP | CP2020 p.100, p.105-106: Later full-auto hits use degraded layered SP and per... |
| `ranged-full-auto.json` | full auto success at medium range with 10 bullets (-1 mod) and 1 hit | CP2020 p.100: Full Auto at Medium (-1 mod per 10 ROF); CP2020 p.99: Range DC ... |
| `ranged-full-auto.json` | full auto success with 5 bullets left at close range (0 mod) and 5 hits | CP2020 p.100: Full Auto 0 mod (5 ROF); CP2020 p.100: hit cap = margin of success |
| `ranged-full-auto.json` | full auto multi-target success with 25 shots on 2 targets | CP2020 p.100: ROF halved per target; CP2020 p.100: separate attack rolls |
| `ranged-full-auto.json` | full auto multi-target later target hit preserves evidence and hit cap | CP2020 p.100: ROF halved per target; CP2020 p.100: full-auto hits capped by s... |
| `ranged-full-auto.json` | full-auto-single-target-miss | CP2020 p.100: Full Auto miss consumes ROF ammo |
| `ranged-full-auto.json` | full-auto-fumble-standard-jam | CP2020 p.99: Natural 1 Fumble; CP2020 p.99: Standard reliability jam |
| `ranged-full-auto.json` | full-auto-fumble-very-reliable | CP2020 p.99: VeryReliable does not jam on fumble |
| `ranged-full-auto.json` | full-auto-long-range | CP2020 p.99: Range DC (Long=25); CP2020 p.100: Full Auto at Long range |
| `ranged-full-auto.json` | full-auto-zero-ammo | CP2020 p.100: Full Auto requires ammo; Audit 6.4: Insufficient ammo warning |
| `ranged-full-auto.json` | full-auto-multi-target-jam-abort | CP2020 p.100: Full Auto multi-target jam aborts remaining targets |
| `ranged-full-auto.json` | ranged-full-auto-aimed-location | CP2020 p.100: Full Auto; CP2020 p.99: Aimed shot (-4) |
| `ranged-single-shot.json` | structured cyberware staged penetration uses system-ablation update path | CP2020 p.105-106: Penetrated cyberware armor must stage-ablate through persis... |
| `ranged-single-shot.json` | structured outer armor stop does not prematurely ablate cyberware | CP2020 p.105-106: Cyberware ablation only occurs after penetration reaches pe... |
| `ranged-single-shot.json` | structured hit with ranged modifier evidence | CP2020 p.99: Range DC table (Medium=20); CP2020 p.99: Aiming rounds; CP2020 p... |
| `ranged-single-shot.json` | structured miss skips location | CP2020 p.99: Attack roll vs DC; CP2020 p.99: miss skips location/damage rolls |
| `ranged-single-shot.json` | structured hit applies manual cover before personal armor | CP2020 p.105: Cover stopping power resolves first; personal armor applies onl... |
| `ranged-single-shot.json` | structured AP penetration plans staged armor ablation | CP2020 p.106: Armor Piercing halving; CP2020 p.106: Staged Penetration; Audit... |
| `ranged-single-shot.json` | structured AP penetration respects staged penetration disabled | Audit 6.4: stagedPenetration setting disabled; CP2020 p.106: AP halving witho... |
| `ranged-single-shot.json` | structured layered armor ablates all participating layers | CP2020 p.105: Proportional Armor Layering; CP2020 p.106: Staged Penetration o... |
| `ranged-single-shot.json` | structured stopped hit with damage exceeding outer layer plans outer layer ablation | Epic 9: Outer layer armor stress |
| `ranged-single-shot.json` | structured stopped hit does not plan staged armor ablation | CP2020 p.106: No penetration = no staged ablation |
| `ranged-single-shot.json` | structured penetrating hit applies minimum damage after BTM | CP2020 p.106: Minimum 1 damage after BTM |
| `ranged-single-shot.json` | structured head hit doubles wound damage | CP2020 p.102: Head hit doubles damage; CP2020 p.108: Head hit > 8 damage = sp... |
| `ranged-single-shot.json` | structured limb hit over threshold surfaces severing warning | CP2020 p.108: Limb > 8 damage = severed/crushed |
| `ranged-single-shot.json` | structured manual cover penetration emits cover ablation evidence | CP2020 p.106: Manual cover ablation evidence is tracked without item updates |
| `ranged-single-shot.json` | structured cover penetration can continue into personal armor | CP2020 p.105-106: Cover can be penetrated first, then personal armor can stil... |
| `ranged-single-shot.json` | structured cover stop does not stage-ablate personal armor | CP2020 p.105-106: When cover fully stops damage, personal armor is not penetr... |
| `ranged-single-shot.json` | structured hit uses options-only aimed location | CP2020 p.99: Aimed shot (-4 to hit); CP2020 p.102: Hit Location table |
| `ranged-single-shot.json` | structured hit without location model is manual | Audit 6.4: missing hit-location model blocks automated resolution |
| `ranged-single-shot.json` | structured outcome warns when ammo is insufficient | Audit 6.4: Awaited update discipline — insufficient ammo blocks automated update |
| `ranged-single-shot.json` | structured outcome warns when ammo state is missing | Audit 6.4: Missing ammo state blocks ammo updates |
| `ranged-single-shot.json` | structured outcome warns when ammo state is fractional | Audit 6.4: Fractional ammo state is invalid |
| `ranged-single-shot.json` | structured outcome warns when ammo update target is missing | Audit 6.4: Missing item UUID blocks ammo update planning |
| `ranged-single-shot.json` | structured path falls back when range data is missing | Audit 6.4: Missing range data triggers legacy fallback |
| `ranged-single-shot.json` | structured unarmored hit resolves damage and stun save | CP2020 p.107: Wound State table; CP2020 p.108: Stun/Shock save |
| `ranged-single-shot.json` | structured hit causing Mortal wound state generates stun and death saves | CP2020 p.107: Mortal wound state (13+); CP2020 p.108: Death Saves |
| `ranged-single-shot.json` | structured stopped hit on already Mortal target does not resolve attack-time recurring death save reminder | CP2020 p.108: Recurring Death Saves are turn-start reminders, not attack-time... |
| `ranged-single-shot.json` | structured PointBlank range hit | CP2020 p.99: Range DC table (PointBlank=10); CP2020 p.99: point-blank always ... |
| `ranged-single-shot.json` | structured PointBlank unsupported damage formula rolls normally | CP2020 p.99: PointBlank maximum damage; unsupported damage formulas must fall... |
| `ranged-single-shot.json` | structured Extreme range miss | CP2020 p.99: Range DC table (Extreme=30); CP2020 p.99: miss at DC 30 with 1d1... |
| `ranged-single-shot.json` | structured weapon conformance label in snapshot | Audit 6.1: source-based conformance — CP2020 Corebook source classifies as co... |
| `ranged-single-shot.json` | structured mortal 7+ suppresses death save as dead/manual state | CP2020 p.108: Mortal 7+ is treated as dead/manual state; no new Death Save pr... |
| `ranged-single-shot.json` | structured layered armor penetration ablates all participating layers | CP2020: Layered personal armor penetration ablates all participating layers |
| `ranged-single-shot.json` | structured AP layered armor penetration ablates all participating layers | CP2020 p.105-106: AP layered armor penetration keeps AP math and ablates all ... |
| `ranged-single-shot.json` | structured cover and layered armor penetration ablates personal layers only | CP2020 p.105-106: Cover ablation remains evidence-only while penetrated layer... |
| `ranged-single-shot.json` | AP minimum 1 damage rule when penetration leaves 0 damage | CP2020 p.105: AP Penetration min 1 damage rule |
| `ranged-single-shot.json` | Head multiplier applies before BTM for AP headshots | CP2020 p.105: Head x2 multiplier applies before BTM |
| `reliability-jam.json` | full-auto-fumble-standard | CP2020 p.99: Standard reliability jams on Natural 1; CP2020 p.99: clear stopp... |
| `reliability-jam.json` | full-auto-fumble-unreliable | CP2020 p.99: Unreliable jams and damages on Natural 1; CP2020 p.99: repair re... |
| `reliability-jam.json` | full-auto-fumble-very-reliable | CP2020 p.99: VeryReliable does not jam on Natural 1 |
| `reliability-jam.json` | burst-fumble-standard | CP2020 p.99: ThreeRoundBurst fumble with Standard reliability = jam |
| `reliability-jam.json` | semi-auto-fumble-standard | CP2020 p.99: Semi-auto fumble = miss but no jam (ammo still consumed) |
| `reliability-jam.json` | full-auto-hit-no-fumble | CP2020 p.99: Non-fumble attack resolves normally |
| `reliability-jam.json` | full-auto-fumble-missing-reliability | CP2020 p.99: Missing reliability defaults to standard jam behavior |
| `shotgun-template.json` | Shotgun damages vary by distance | FNFF Shotgun Pattern (pg.113) |
| `shotgun-template.json` | Shotgun missing template data returns manual resolution | FNFF Shotgun Pattern (pg.113) - requires template distances |
| `shotgun-template.json` | Shotgun without template calculates range using target distance | Skip template UX fallback |
| `shotgun-template.json` | Shotgun missing bracket damage returns manual resolution | FNFF Shotgun Pattern (pg.113) - requires trusted drop-off data |
| `three-round-burst.json` | three-round burst success with 2 hits and progressive ablation | CP2020 p.99: Three-Round Burst; CP2020 p.106: Progressive armor ablation (sta... |
| `three-round-burst.json` | three-round burst success with 1 bullet remaining in weapon | CP2020 p.99: Burst with limited ammo; CP2020 p.99: ammo delta = min(shotsLeft... |
| `three-round-burst.json` | three-round burst miss skips location/damage rolls and subtracts 3 ammo | CP2020 p.99: Burst miss consumes 3 ammo; CP2020 p.99: skip damage rolls |
| `three-round-burst.json` | three-round-burst-close-range-advantage | CP2020 p.99: Burst +3 at Close range; CP2020 p.99: Range DC table (Close=15) |
| `three-round-burst.json` | three-round-burst-aimed-location | CP2020 p.99: Burst +3 at any range; CP2020 p.99: Aimed shot (-4) |
| `three-round-burst.json` | three-round-burst-fumble-standard-jam | CP2020 p.99: Natural 1 is Fumble; CP2020 p.99: Standard reliability jams on f... |
| `three-round-burst.json` | three-round-burst-fumble-very-reliable | CP2020 p.99: VeryReliable does not jam on fumble |
| `three-round-burst.json` | three-round-burst-fumble-unreliable | CP2020 p.99: Unreliable jams and damages on fumble |
| `three-round-burst.json` | three-round-burst-point-blank-max-damage-per-hit | CP2020 p.99: PointBlank ranged attacks use maximum weapon damage; CP2020 p.99... |
| `three-round-burst.json` | three-round-burst-zero-ammo | CP2020 p.99: Burst requires ammo; Audit 6.4: Insufficient ammo warning |
| `unsupported-modes.json` | full-auto-fidelity-supported | Audit 6.2: FullAuto is a supported attack type in Corebook Fidelity mode |
| `unsupported-modes.json` | three-round-burst-fidelity-supported | Audit 6.2: ThreeRoundBurst is supported in Corebook Fidelity mode |

---

## Focused Assertion Coverage

The following inline functions and focused test modules also verify rule areas and
are not counted as JSON fixture cases:

| Function | Rules Verified |
|---|---|
| `assertBodyTypeDamageResolver` | BTM table (BT 2, 6, 10–15), minimum damage, fractional/string BT |
| `assertWoundPlanning` | Wound state transitions, head damage doubling, limb loss, special cases |
| `assertSavePromptResolution` | Stun/Shock save generation, Death saves, recurring mortal save |
| `assertArmorResolver` | Proportional armor layering, SP/ablation, cover, AP halving, layer limits |
| `assertTargetNormalization` | Target snapshot building, equipped armor/cyberware filtering |
| `assertCombatResolverRouting` | Fire mode routing, multi-target ROF, insufficient ammo |
| `assertSettingsHelpers` | Corebook Fidelity Mode toggling, supported fire modes |
| `conformance-helpers.test.js` | Source-based conformance classification |
| `deferred-mechanics.test.js` | Deferred mechanics registry |
| `attack-type-classification.test.js` | Attack type support classification |
| `humanity-persistence.test.js` | Humanity cost resolution, EMP derivation |
| `range-dcs.test.js` | Range DC table values (PB=10, C=15, M=20, L=25, E=30) |
| `suppressive-fire.test.js` | Save DC, template lifecycle, movement deduplication, durable chat locks, per-hit damage and commit flow |

---

*Generated by `tests/combat/generate-coverage-map.mjs`.*
