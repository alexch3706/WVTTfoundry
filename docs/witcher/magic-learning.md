# Learning, Places of Power, and Ley Lines

Pure source-benefit/mishap calculations live in `magic-power-rules.js`, which imports without Foundry globals. `magic-learning.js` reexports them for compatibility and owns UI, commands, source contact and persistence.

## Entry points and actual persistence

Call `registerMagicLearning({planBacklash?})` once at ready. It registers authoritative commands, chat-button handlers, native Region contact auditing, and disconnects when a token leaves a Ley Line or its Region is deleted. Actor-sheet controls call `magicLearningAction(actor, action, projectId)`; valid actions are `learn`, `study`, `finish`, `improve`, `configure`, `power`, `connect`, `disconnect`. `magicLearningDisplay(actor, worldTime)` supplies safe project eligibility and source status.

State fields under `system.magic`: `birthEligible` (nullable boolean), `magicIP` (restricted IP), `learning[]`, `powerUses[]`, `powerFocus`, and `leyConnection`. Ordinary advancement still uses existing `system.ip`. Every resource/project change commits through the existing compensating transaction. Completing study creates the canonical magic Item; extracting Essence updates an existing component or imports the real component from the Components pack. Failed chat persistence restores resources/progress and removes newly created Items.

Native Scene Regions are configured by the GM through `configure`. Their flags contain `flags['witcher-rilerena'].magicSource = {kind:'place'|'ley', element, monthSeconds?}`. The GM draws the actual source; the rule does not manufacture a source at the caster. Membership uses V14 `TokenDocument.testInsideRegion`, including the document's native geometry and level/elevation rules. The table decides the source's actual existence and extent. Tome p.8 describes Ley Lines as roughly6m wide.

## Learning — Core p.123, Tome p.118

| Tier                |  IP | Minimum duration |  DC | Successful checks |
| ------------------- | --: | ---------------- | --: | ----------------: |
| Novice / Low        |  10 | 4days            |  14 |                 2 |
| Journeyman / Medium |  20 | 1week            |  18 |                 4 |
| Master / High       |  30 | 3weeks           |  22 |                 6 |
| Arch Priest         |  40 | 5weeks           |  24 |                 8 |

The GM records an available teacher/tome and confirms that the character started with Vigor above0. Current Vigor cannot establish birth eligibility, and temporarily losing Vigor does not erase that eligibility. Mages learn spells/rituals/hexes/signs; priests and druids learn invocations/rituals/hexes/signs; witchers learn signs. Gifted laypeople cannot learn ordinary magic (Tome p.74).

The GM starts a project because the existence/availability of an in-world teacher or tome and legacy birth eligibility cannot be verified from a dragged compendium Item. Starting spends IP, restricted magic IP first. The caster can then make the actual casting-skill checks. Hexes use Hex Weaving; rituals use Ritual Crafting; other magic uses Spell Casting. A specific spell formula grants+2 to these learning checks (Tome p.118).

A check must **beat** the DC. Every failure adds a day to the minimum total duration and postpones retry until the next study day. Successes do not impose an invented one-check-per-day restriction. Completion requires both the check count and the minimum duration, including all failure extensions. The default day boundary follows Foundry world-time24-hour days; the pure helper accepts `nextDayAt` for a calendar adapter. There is no automatic cancellation refund because the book specifies none.

The table does not explicitly map basic/alternate/advanced signs or Tome's Hierophant tier to its rows. Such entries require a recorded GM tier ruling instead of an unlabelled invented cost. All ordinary printed novice/journeyman/master/archpriest and low/medium/high entries use their exact row automatically.

`magicImproveSkill` spends the restricted pool first to raise Spell Casting, Ritual Crafting, or Hex Weaving, using the existing doubled skill-IP formula and rank cap. Core p.122 does not enumerate every “magical skill”; use a separate recorded GM ruling for other candidates rather than allowing unrestricted ordinary skill spending.

## Places of Power — Core p.122

The character spends three consecutive full turns concentrating. Combat records each full-round action and prevents another contribution in the same round. Outside combat, nine seconds of world time must pass. Leaving the source clears concentration. The GM must advance actual world time; clicking repeatedly cannot finish early.

Attunement grants10 restricted magic IP and one hour of+5 Vigor/+2 Spell Casting **for that source's element only**. These bonuses are separate from generic actor statistics. Alternatively, extraction grants5 Fifth Essence in inventory. The alternative is treated as exchanging the attunement package, including its IP; the text says to forego the bonus and extract Essence. Repeated identical temporary attunements use one matching elemental bonus rather than stacking each draw.

Starting with the second draw before recovery, an Endurance check against DC20 is required. Every successful repeated-draw check raises subsequent DC by4; failures do not. A failed check inflicts the actual5d6 roll as direct HP damage plus the source's elemental consequence. Failure does not remove the draw's benefit because the printed rule does not say so. The character's history is per Place of Power.

The GM supplies the world's calendar-month duration when configuring the source. No unconditional30-day month is assumed. Each draw restarts that interval from the latest use; a calendar with varying month lengths must update the configured duration for the applicable month. When the interval has elapsed the next draw is safe and the escalating history resets.

`placeOfPowerBenefits(state, magic, worldTime)` returns conditional Vigor/casting bonuses. **The casting engine must call it**; saving the effect alone is not automation. The expiry mechanism must remove its record at the one-hour deadline.

Earth, Fire and Water consequences directly persist Stunned, Fire or Frozen. Air creates a genuine pending `magic-backlash` card routed through the existing GM push2m handler. Damage below0 schedules a Death save. `planBacklash(actor,{element,damage,reason,sourceUuid})` can override this with the shared runtime planner; it returns `{changes,backlash,pending}`. It must not mutate the actor before the owning transaction commits.

## Ley Lines — Tome pp.8–9

Only mages, priests and druids can connect. The character must be touching the actual native Region. Connection costs an action and requires Spell Casting to beat DC16 (plus any Earth reconnection penalty). Failure causes the ordinary elemental result with **no additional HP damage**. Priests/druids use a randomly chosen mixed result, consistent with Core p.166. Failed initial connection does not also cause the connected-Line table's additional mishap.

Moving away disconnects; returning requires another check. Runtime must call `validateLeyContact(actor)` before using a stored connection so a missed hook or unloaded client cannot retain its benefit. Earth reconnection difficulty persists per source in `leyConnection.history`.

`leyLineBenefits(state, magic, {knownMagic})` returns:

| User/source  | Conditional benefit                                                                                 |
| ------------ | --------------------------------------------------------------------------------------------------- |
| Mage / Earth | Every defense against matching magic has−4.                                                         |
| Mage / Air   | Borrow any air spell of a tier of air spell already known; no permanent Item or teaching knowledge. |
| Mage / Fire  | Add2 damage dice to an already damaging spell; promote its existing ignition chance to100%.         |
| Mage / Water | Spell Casting+2 for matching water magic.                                                           |
| Priest/Druid | Vigor+4 without requiring an elemental invocation.                                                  |

Connected mages cannot cast a spell of another element. `leyDamageFormula` preserves the original die size (4d8→6d8), rather than blindly adding2d6; a flat or compound formula requires the GM to resolve the omitted die size. Add temporary priest/druid Vigor **before the final zero clamp**, or a penalty reduced to0 then increased by4 could incorrectly restore casting.

`leyLineMishapPlan(state,{time,cast,id})` is the additional consequence planner for a fumble/overdraw **while connected**:

- Earth: disconnect and raise that line's next connection DC by2.
- Priest/Druid: another−2 Vigor effect lasting6hours; each application has its own expiry and stacks.
- Air: a `replaceSpell` job for the GM to choose a different same-tier air spell, preserving original STA and ensuring the spell goes off despite the fumble.
- Fire: a `repeatSpell` job that spends another action and the same STA, uses a random target, and applies ordinary fumble consequences only to the repeat.
- Water: source-owned hallucination condition/effect while connected. Disconnect sets its maximum expiry to60seconds later; the GM controls the hallucinations and can end them earlier.

**Air/Fire jobs require an actual runtime resolver before those branches can be advertised as complete.** Returning a job or a descriptive chat card is not its execution. Root casting integration also owns snapshotting the defense penalty, modified damage/ignition, borrowed-air casting entry, and composing these changes into the original casting transaction. A spell's ordinary fumble and overdraw consequences remain in addition to the Ley Line result.

## Verification limits

Tests exercise pure book rules and the actual registered commands with controlled document persistence: stale/source contact, no early completion, three separate full turns, real catalog-item creation, restricted-IP use, failure timing, condition backlash, and transaction compensation. These are not acceptance tests in a running Foundry/Forge world.
