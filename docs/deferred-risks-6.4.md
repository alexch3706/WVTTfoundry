# Deferred Risks — Story 6-4: Direct-Mutation & Awaited-Update Audit Findings

> Last reviewed: 2026-09-05
> Owner: @maintainer
> Status: Partially Resolved

---

## DEFERRED-6.4-1: Mixed Serial and Chunked Migration Performance

**Severity:** Low

**Description:** World actors, embedded items, standalone items, and compendium packs are traversed sequentially in the `ready` migration. Documents inside each compendium are processed concurrently in awaited chunks of 50. Large worlds may therefore still spend noticeable time in the outer serial loops, while the chunk size bounds compendium load.

**Acceptability:** Acceptable for MVP. Migration runs once per version upgrade. Even with 500+ documents, the total time should stay under a few seconds.

**Owner:** @maintainer

**Follow-up:** Profile a large backed-up world. If migration exceeds 5s, consider bounded batches for world documents as well as the existing compendium chunks.

---

## DEFERRED-6.4-2: Legacy Fallback Ammo Updates (Redundant After Story 6-8)

**Severity:** Low

**Description:** The `await`-patched ammo updates in `__semiAuto`, `__threeRoundBurst`, and `__fullAuto` (Finding A, item.js) will become dead code once the structured resolver is the default path (Story 6-8). The patches are correct but temporary.

**Acceptability:** Necessary guard-rail until the legacy path is removed. The patched code is already tested and prevents the stale-value bugs found in the audit.

**Owner:** @maintainer

**Follow-up:** Story 6-8 — remove or fence `__legacyWeaponRoll()` and all sub-methods.

---

## DEFERRED-6.4-3: Stale `previewData` Overwriting Concurrent Updates

**Severity:** Medium

**Description:** The combat preview/commit flow (`combat-commit.js` → `previewData`) can produce a stale snapshot that overwrites a later concurrent update. If two combat actions resolve near-simultaneously, the second commit may write the first action's ablated armor SP back onto the actor, undoing the second action's damage.

**Root Cause:** `previewData` is computed once at preview time and applied at commit time. There is no version guard or merge mechanism between preview capture and commit application.

**Acceptability:** Resolved for structured preview/confirm in Story 7.4 (2026-05-31): commit now validates preview baselines against live actor/item state and blocks stale confirms.

**Owner:** @maintainer

**Follow-up:** Monitor live-world reports; if additional stale paths appear outside structured commit flow, extend baseline coverage to those paths.

---

## DEFERRED-6.4-4: Concurrent Roll Locking (Double-Click)

**Severity:** Medium

**Description:** `resolveCombatAction` does not prevent concurrent invocations from the same attacker. A player clicking "Fire" twice in rapid succession launches two resolver pipelines, both of which can mutate the same actor's ammo, wounds, and SP. This can produce double-ammo-spend, double-damage, or inconsistent save prompts.

**Acceptability:** Resolved for structured preview/confirm in Story 7.4 (2026-05-31): duplicate confirm attempts for one preview are now blocked by commit guard in orchestration.

**Owner:** @maintainer

**Follow-up:** Keep under observation for non-preview paths; current guard targets the shared preview/confirm commit pipeline.

---

## DEFERRED-6.4-5: `_prepareArmorData` Morphing/Cleansing Should Move Out of `prepareData()`

**Severity:** Low

**Description:** `_prepareArmorData` in `item.js` directly mutates `system.coverage` inside `prepareData()` — a method that Foundry calls on every sheet render and data access. This is a direct mutation of persisted schema state from a prepare-only lifecycle method. The full fix would move coverage morphing/cleansing to an explicit event handler (e.g. `onTransferItem` or item-create hook) using `updateEmbeddedDocuments`.

**Acceptability:** The bug (`delete system.coverage.armorArea` → fixed with bracket notation) is gated by `COVERAGE_CLEANSE_THRESHOLD = 20` — extremely unlikely to trigger in normal play. The armour resolver (`getEquippedArmorForLocation`) reads from equipped item snapshots directly, not from actor-prepared coverage. The bracket-notation fix prevents the literal-property deletion bug.

**Owner:** @maintainer

**Follow-up:** Epic 6 post-MVP. Move coverage morphing/cleansing out of `prepareData()` into an explicit item-transfer or item-create handler.
