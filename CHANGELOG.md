# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.0.0] - 2026-09-08

### Save feedback and attack UX (2026-09-14)
- Replaced manual Stun/Death's reversed critical/fumble colors with separate explicit roll-under results, sharing thresholds and comparison logic with automated saves. Equality succeeds; the informational roll does not change actor conditions.
- Reduced the attack form to primary controls and collapsed situational modifiers, with weapon/target summary, optional physical d10 entry and session-only memory of the last valid fire mode.
- Moved area targeting into the form and limited follow-up placement/configuration to the selected attack mode. Normal shots no longer prompt for suppressive fire; cancellation and invalid input preserve the form without rolling again.
- Preserved combat preview/confirmation and added regression coverage for manual save feedback, form retry/duplicate submission, target/range handling and cancellable placement.
- Made suppressive corridor creation and ammunition spending a guarded operation: pending zones remain inactive until charged, recoverable failures roll back, and uncertain outcomes block automatic retry.

### Catalog quality (2026-09-10)
- Added canonical JSON sources, reviewed weapon/armor corrections, retained import provenance and a deterministic semantic-audit/build workflow for all declared packs.
- Restored typed range, skills, magazines, fire modes, reliability, shotgun damage profiles, armor coverage/material/EV and supported protective cyberware. Unsupported or ambiguous records carry explicit manual reasons.
- Blocked invalid combat data before any roll or state change; corrected automatic range lookup, localized skill lookup, catalog autoshotgun single shots and edged-weapon armor interactions.
- Added per-location armor status/editors, explicit unknown AP/weight values and review status controls.
- Added a GM catalog migration preview that preserves customized definitions, ammunition, ablation, equipped state and cyberware state, including stale-preview and persistence checks.
- Added tests that send actual catalog items through the resolver, enforce source/pack equality and preserve every existing document ID and type.

### Breaking
- Raised the supported Foundry core generation to V14 only and verified the package metadata against V14 Stable 7 (`14.365`).
- Replaced the removed `MeasuredTemplate` combat workflow with V14 Regions for shotgun areas and persistent suppressive-fire zones.
- Preserved every existing compendium collection ID and path, including the historically mixed-case and underscored IDs accepted by V14, so existing UUIDs, macros, and third-party lookups do not require redirects.

### Changed
- Rebuilt all 28 declared compendia with the official Foundry pack tooling: 2,123 Item documents use `system`, 521 documents use `ownership`, all 2,124 legacy export records use `_stats.exportSource`, and the RollTable/result schemas and LevelDB keys use their canonical V14 forms.
- Moved dice-term lookup, token centers, grid path measurement, value comparison, chat hooks, and chat style data to their public V14 APIs.
- Restricted runtime compendium migration to mutable world-owned packs; shipped system packs are converted and audited offline, and unrelated module data is never rewritten.
- Made World migration fail closed, durably recover interrupted pack relocks, verify persistence results and completion stamping, reject skipped/invalid Documents, preserve unlinked-token `ActorDelta` inheritance and tombstones, and overlay legacy skill progress without replacing existing Item IDs or Item-only fields.
- Prevented stale legacy skill maps from resurrecting deleted default skills or generating blank role abilities, recognized names persisted under every shipped locale (including literal missing-translation keys), made ambiguous duplicate-skill state abort safely, and invalidated stale skill-sort caches before embedded Item changes.

### Added
- Added V14 Region placement/containment contracts, cross-scene synthetic-token coverage, cancellation and persistence coverage, manifest validation, and a non-mutating 2,124-document compendium audit.
- Added a pinned, reproducible compendium migration tool and a tag-gated GitHub release workflow that produces an installable root-level archive and checksum.
- Added a dedicated [V14 upgrade guide](docs/v14-upgrade-guide.md) with backup, module re-enable, validation, and rollback instructions.

## [1.1.0] - 2026-09-05

### Fixed
- Corrected Skill chip and shotgun range-damage field bindings, including migration of previously saved legacy fields.
- Restored Item Sheet defaults, Vehicle Sheet markup, Item-based Combat Sense initiative and Awareness bonuses, and weapon-only Gear fire actions.
- Prevented recursive attack-modifier submission and made template placement cancellation explicit.
- Corrected Stun/Death Save roll-under guidance and validation.
- Added a safe combat review dialog that shows planned ammo, wound, armor, and SDP changes before applying them.
- Blocked automatic combat commits when the current user cannot update every affected document.
- Prevented duplicate automatic save and suppressive-fire resolution across connected clients.
- Preserved legacy chipped skills, numeric damage values, range brackets, explicit token link/vision choices, and already-damaged cyberlimb SDP during migration and combat previews.
- Added compatible chat hooks and Handlebars template helpers for Foundry V12 and V13.
- Fixed actor-sheet portrait sizing, focus behavior, control labels, wound controls, and globally leaking visual effects.

### Changed
- Actor Sheets no longer maximize automatically.
- Combat confirmation now defaults to Cancel and hides Apply when manual resolution is required.
- Added focused regression checks for item UI contracts, modifier submission, accessibility, migration, and combat change summaries.

## [1.0.0] - 2026-06-13

This milestone release marks the culmination of 8 major development epics. The system has been fundamentally rebuilt from the ground up to have a strict, rule-accurate, stateless combat resolver that completely overhauls how combat is played, validated, and recorded in Foundry VTT.

### Changed
- **Total Combat Architecture Rewrite:** Weapon attacks now delegate to a new pure JS `CombatOutcome` resolver rather than mutating actor data immediately. All state changes are now previewed in a confirm dialog before commit.
- **Foundry V12/V13 Compatibility:** Refactored core system components and asynchronous `Roll.evaluate` flows to ensure verified support for Foundry V12 and forward compatibility up to V13.
- **Compendium Architecture:** Migrated all compendiums to LevelDB format for improved performance and stability.

### Added
- **Ranged Combat Overhaul:**
  - Automated three-round bursts, suppressive fire zones, and full-auto mechanics against single and multiple targets.
  - Implemented automatic fire fumbles, reliability drops, and jams.
  - Aimed multi-hit locations are now fully persisted in the combat pipeline.
  - Implemented point-blank maximum ranged damage drop-off rules.
- **Melee & Martial Arts Overhaul:**
  - Full support for Opposed Melee and Martial Arts rolls (Attacker vs Defender).
  - Melee/Unarmed now correctly applies Body Type damage modifiers.
  - 12 Martial Arts styles added as inspectable data, with support for all core actions (Strike, Kick, Block, Dodge, Disarm, Throw, Hold, Escape, Choke, Sweep, Grapple).
- **Damage & Armor Pipeline:**
  - Full support for Armor Piercing (AP) and Staged Penetration.
  - Automated calculation of Effective SP using layered armor rules.
  - Body Type Modifier (BTM) minimum damage limits enforced correctly.
  - Wound state transitions, Head-hit double damage, and Limb-loss mechanics fully integrated.
  - Automated Stun/Shock and Death save prompts.
- **UI Enhancements:**
  - **V2 Three-Pane UI Overhaul:** Introduced a modernized, persistent three-pane layout for actor sheets and the combat tab.
  - Added equipped armor repair controls and sheet overrides directly to the UI.
  - Manual attack die entry prompts added for groups playing around a shared physical table.

### Fixed
- Fixed weapon firing events within the new Combat Tab UI.
- Fixed sequential cover ablation logic and skinweave/subdermal ablation behavior.
- Fixed death save reminders triggering on dead or stabilized targets.
- Preserved full-auto damage evidence and hit modifiers in chat cards across multiple targets.
- Resolved multiple actor and item sheet registration issues across Foundry V11 and V12.

---
*For older changes prior to the `1.0.0` milestone, see the git commit history.*
