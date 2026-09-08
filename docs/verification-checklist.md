# MVP Combat Foundry Verification Checklist

> Last updated: 2026-09-05
> Target: Corebook Fidelity MVP release readiness

## Pre-Check: Automated Fixture Suite

Before running any manual Foundry checks, verify the fixture suite passes:

- [ ] `node tests/run-combat-fixtures.mjs` — all fixtures pass (0 failures)
- [ ] Coverage map (`tests/combat/fixture-coverage-map.md`) is up to date
- [ ] No unexpected test-count regression (current runner baseline: 155 checks; coverage map: 98 JSON fixture cases)

If any fixture fails, stop. Resolver mechanics are not reliable until the fixture suite is green.

---

## Check Sections

### Section A: Environment Setup (§1)

- [ ] A0: Configure system settings: verify "Corebook Fidelity" behavior is understood (note if ON or OFF for this test run)
- [ ] A1: Clean test world loaded. Document exact Foundry version (e.g., v11.315) and system version in your test report.
- [ ] A2: Attacker actor created with weapon and stats (§1.1)
- [ ] A3: Target actor created with armor and stats (§1.2)
- [ ] A4: Both tokens placed on active scene at a specific measurable distance (e.g., 10m) to verify range DCs

### Section B: Target Selection & Single-Shot Flow (§2)

Detailed steps in `docs/testing/foundry-manual-checks.md §2.1–§2.4`.

- [ ] B1: Targeting reticle visible on enemy token (§2.1)
- [ ] B2: Modifiers dialog appears with Semi-Auto, range, and modifier options (§2.2)
- [ ] B3: Preview dialog shows correct attacker, target, attack total, hit/miss, and mathematically correct damage summary and ammo change (§2.3)
- [ ] B4: Confirm → sheet mutations (ammo -1, damage applied, armor SP ablated if penetrated) (§2.4)
- [ ] B5: Chat card shows `[COMMITTED]` banner (green) with full evidence (§2.4)
- [ ] B6: Cancel → no sheet mutations, chat card shows `[CANCELED]` (§3)
- [ ] B7: Only one chat card created per attack (no duplicates) (§2.4)
- [ ] B8: Actorless token → manual resolution flow (§4.1)
- [ ] B9: Zero ammo → insufficient ammo warning, commit blocked (§4.2)

### Section C: Preview/Confirm Edge Cases (§3)

- [ ] C1: Confirm path updates ammo, damage, and armor in the correct order
- [ ] C2: Cancel path leaves all three unchanged
- [ ] C3: Chat card status updates in-place (same card, new banner) (§3.2)
- [ ] C4: Manual resolution card shows `[MANUAL]` banner (yellow) (§4.1)
- [ ] C5: Close preview dialog via X or Esc key → treated as cancel, no sheet mutations

### Section D: Armor, AP, BTM, Wounds, Saves (§6)

Detailed steps in `docs/testing/foundry-manual-checks.md §6.1–§6.5`.

- [ ] D1: AP hit → effective SP halved, damage penetrates, armor ablated (§6.1)
- [ ] D2: Staged penetration disabled → armor NOT ablated on confirm (§6.1)
- [ ] D3: Multiple armor layers + cover → effective SP calculated with layering, only outermost penetrated layer ablated (§6.2)
- [ ] D4: BTM applied correctly and boundary tested (e.g., damage reduced to exactly 0 is clamped to minimum 1) (§6.3)
- [ ] D5: Head hit → damage doubled, +8 warning surfaces (§6.4)
- [ ] D6: Limb hit over 8 → severing/crushing warning surfaces (§6.4)
- [ ] D7: Stun save prompt when entering Serious/Critical (§6.5)
- [ ] D8: Death save prompt when entering Mortal (§6.5)
- [ ] D9: Recurring death save reminder appears once at start of already-Mortal actor's active Combat turn (§6.5)
- [ ] D10: Reload world after confirm → armor SP persisted (§6.1)
- [ ] D11: Mortal 7+ → no new death save prompt; dead/manual state is surfaced (§6.5)

### Section E: Automatic Fire (§7)

Detailed steps in `docs/testing/foundry-manual-checks.md §7.1–§7.8`.

- [ ] E1: Three-round burst → ammo -3 or ammo remaining, hit count ≤ 3, damage per hit (§7.2)
- [ ] E2: Three-round burst with 1 round → ammo -1, hit capped at 1
- [ ] E2.1: Three-round burst with exactly 2 rounds left → ammo -2, hit count capped at 2
- [ ] E3: Three-round burst with 0 ammo → insufficient ammo warning
- [ ] E4: Full auto single target → ammo delta = min(shotsLeft, ROF), hit count capped by margin (§7.3)
- [ ] E5: Full auto multi-target → ROF divided by target count, per-target outcomes (§7.4)
- [ ] E6: Full auto multi-target odd ROF → floor division, leftover unspent rounds
- [ ] E7: Suppressive fire hidden when Corebook Fidelity ON (§7.5)
- [ ] E8: Suppressive fire marked manual/warning when Corebook Fidelity OFF (§7.6)
- [ ] E9: Natural 1 with standard auto → jam warning, ammo deducted, hit forced false (§7.7)
- [ ] E10: Natural 1 with very reliable → no jam, just miss
- [ ] E11: Natural 1 with semi-auto → no jam, standard fumble
- [ ] E12: Ammo bounded by shotsLeft, never negative (§7.8)
- [ ] E13: Natural 10 → exploding die logic applied, additional roll added to total

### Section F: Melee & Martial Actions (§8)

Detailed steps in `docs/testing/foundry-manual-checks.md §8.1–§8.12`.

- [ ] F1: Opposed melee with attacker > defender → hit, damage resolved (§8.2)
- [ ] F2: Opposed melee with defender > attacker → miss, no damage (§8.3)
- [ ] F2.1: Opposed melee with attacker == defender → resolve tie (defender wins/attacker misses)
- [ ] F3: Martial Strike with Karate → +2 key technique bonus applied (§8.4)
- [ ] F4: Martial Block/Parry → non-damage outcome, hits empty (§8.5)
- [ ] F5: Martial Kick with Savate → +2 key technique bonus applied (§8.6)
- [ ] F6: Martial Grapple → grappleFamily category, hits empty (§8.7)
- [ ] F7: Martial Choke with prerequisite → clean outcome (§8.8)
- [ ] F8: Martial Hold with missing prerequisite → manual resolution (§8.9)
- [ ] F9: Martial Disarm → prerequisite warning, confirm available (§8.10)
- [ ] F10: Melee with martial skill but melee weapon → uses martial skill (§8.11)
- [ ] F11: Actorless target → manual resolution in melee (§8.12)

### Section G: Epic 6 Cross-Cutting (NEW)

#### G1: Corebook Conformance Labels (§6.1)

- [ ] G1a: Item sheet for a weapon with `system.source: "CP2020 Corebook"` displays a conformance badge/label
- [ ] G1b: Item sheet for a weapon with `system.source: "Blackhand's Street Weapons"` displays an "Extended" label
- [ ] G1c: Item sheet for a weapon with empty/unknown `system.source` displays "Unknown" label (no missing UI)
- [ ] G1d: Chat card for a resolved attack includes conformance scope in the weapon section (corebook/extended/unknown)

#### G2: Deferred/Manual Mechanics Visibility (§6.2)

- [ ] G2a: With Corebook Fidelity ON — fire mode dropdown shows only Semi-Auto, Three-Round Burst, Full Auto. Suppressive Fire is NOT visible.
- [ ] G2b: With Corebook Fidelity ON — exotic weapon types produce a warning or manual-resolution chat card
- [ ] G2c: With Corebook Fidelity OFF — all fire modes visible; selecting an unsupported mode produces a warning/notification
- [ ] G2d: Deferred mechanics documented in `docs/deferred-risks-6.4.md` are visible to maintainers (remaining deferred items and resolved concurrency hardening notes are accurate)

#### G3: Humanity Persistence (§6.5)

- [ ] G3a: Open a character sheet with cyberware → find an item with a humanity cost expression (e.g., "1d6")
- [ ] G3b: Click the humanity cost roll button → verify the preview roll displays a result (e.g., "4")
- [ ] G3c: Confirm/apply → humanity loss is written to the item's `system.humanityLoss` field
- [ ] G3d: Close and reopen the actor sheet → humanity loss value persists
- [ ] G3e: Actor EMP/humanity derived values accurately reflect the accumulated loss across boundary conditions (e.g., dropping below 0 EMP triggers Cyberpsychosis warning, fractional HL truncates correctly)
- [ ] G3f: Set humanity cost to "N/A" or empty → no value written, no error
- [ ] G3g: Set humanity loss on the item directly via sheet edit → value persists on reload
- [ ] G3h: Enter invalid humanity formula (e.g., 'abc') → displays warning, does not crash or write NaN

#### G4: Documentation & Audit Closure (§6.3, §6.4)

- [ ] G4a: `docs/resolver-contracts.md` exists and covers all public contract shapes
- [ ] G4b: `docs/rule-reference-policy.md` exists and establishes citation format
- [ ] G4c: `docs/deferred-risks-6.4.md` exists and documents all deferred audit findings
- [ ] G4d: Code review confirms no direct `system` mutations in combat-resolver, attack-resolver, armor-resolver, damage-resolver, save-resolver, or state-planner modules
- [ ] G4e: Code review confirms all Foundry document updates in combat paths use `await`-ed `update()`, `updateEmbeddedDocuments()`, or equivalent APIs

#### G5: Legacy Path Fencing (§6.8)

- [ ] G5a: Code review confirms `__semiAuto`, `__threeRoundBurst`, `__fullAuto` in `module/item/item.js` are removed, fenced, or redirected to resolver
- [ ] G5b: Code review confirms `__meleeBonk` and `__martialBonk` are removed, fenced, or redirected
- [ ] G5c: Code review confirms `__legacyWeaponRoll()` or equivalent fallback path is explicitly fenced behind a compatibility flag or removed
- [ ] G5d: Code review confirms no supported MVP combat action bypasses `CombatOutcome` and state planner

---

## Readiness Review Summary

| Area | Epic | Status | Notes |
|------|------|--------|-------|
| Resolver Contracts | 1 | 🟢 | Documented in `docs/resolver-contracts.md` |
| Fixture Suite | 1–5 | 🟢 | 155 checks passing; 98 JSON fixture cases indexed |
| Target Normalization | 2 | 🟢 | UUID-rich target refs, manual-resolution fallback |
| Single-Shot Firearm | 2 | 🟢 | Preview/confirm, ammo, chat evidence |
| Armor/AP/BTM/Wounds/Saves | 3 | 🟢 | Full pipeline; staged penetration toggle |
| Automatic Fire | 4 | 🟢 | Burst, full auto (single + multi), suppressive fire, jams |
| Melee & Martial Arts | 5 | 🟢 | Opposed rolls, martial data, grapple prerequisites |
| Conformance Labels | 6.1 | Needs check | Verify conformance badge renders on item sheets |
| Deferred Mechanics | 6.2 | Needs check | Verify unsupported modes hidden/warned |
| Humanity Persistence | 6.5 | Needs check | Verify cyberware roll persists on reload |
| Legacy Path Fencing | 6.8 | Needs check | Verify all item methods defer to resolver |
| Audit Closure | 6.4 | Needs check | Verify no direct mutations, all awaits present |
| Unresolved Gaps | All | See below | |

**Overall Readiness:** ⬜ (complete checks and fill)

---

## Unresolved Verification Gaps

The following areas cannot be fully verified by pure fixtures or existing manual checks. Each gap is documented with owner and follow-up story. **Note:** These known gaps are accepted risks for the MVP release and do not block the "Go" decision for Corebook Fidelity MVP.

| Gap ID | Area | Description | Owner | Follow-up |
|--------|------|-------------|-------|-----------|
| GAP-6.7-3 | Mortal 7+ Persistent Dead State | Current implementation suppresses new save prompts as dead/manual state but does not persist an explicit dead status. | @alexch3706 | Post-MVP: Implement persisted dead-state automation |
| GAP-6.7-4 | Migration Performance | World documents and packs are traversed serially; documents inside each compendium run in awaited chunks of 50. | @alexch3706 | Profile a large backup; batch outer loops if >5s |
| GAP-6.7-5 | Armor Coverage Morphing in `prepareData()` | `_prepareArmorData` mutates coverage inside `prepareData()` — gated by threshold, unlikely to trigger. | @alexch3706 | Epic 6 post-MVP: Move to explicit event handler |
| GAP-6.7-6 | Foundry v13 Maximum Compatibility | Manifest declares `maximum: 13` but `verified: 12`. v13 behavior is not fully tested. | @alexch3706 | Verify on Foundry v13 before marking it verified |
| GAP-6.7-7 | Exotic Weapon Guard | Exotic weapon types that do not match the resolver classification are flagged manual, but specific exotic types (bows, thrown) lack dedicated manual check steps. | @alexch3706 | Add exotic-type manual checks in follow-up |
| GAP-6.7-8 | Legacy Fallback Ammo Updates | DEFERRED-6.4-2: Ammo mutations in legacy fallback path lack await/state planner | @alexch3706 | Post-MVP: Remove legacy path |

---

## How to Use This Checklist

1. **Prerequisites:** Load a clean Foundry test world with the current system version.
2. **Pre-check:** Run `node tests/run-combat-fixtures.mjs` and confirm 0 failures.
3. **Per-section setup:** Follow the referenced `docs/testing/foundry-manual-checks.md` sections for actor/item/token setup.
4. **Execute:** Step through each check in order. Mark `🟢 Pass`, `🔴 Fail`, or `🟡 Partial`.
5. **Record:** Attach the completed checklist to the release PR or QA issue. Do not commit point-in-time checklists to the `docs/` folder.
6. **Gate:** If any 🔴 failure exists, do not proceed to readiness review without a documented mitigation plan.
