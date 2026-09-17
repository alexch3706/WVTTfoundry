# Enhancement installation and native Shining

Sources: Core v1.35 pp.63,90,140,256 and 2022 Errata; A Tome of Chaos v1.01 pp.110–114,120.
The earlier [source audit](enhancements-audit.md) records the baseline gaps and exact source tables.
This document describes the new catalog, installation/storage and Shining implementation; combat/magic consumers are separate modules and must also pass their workflow tests.

## Catalog

`build-enhancements.mjs` reproducibly creates **35 Items** in `tome-enhancements`:
four new glyphs, fifteen installed-word reference Items, fifteen word diagrams and the Enhancement Slot Diagram.
Word diagrams link the actual component stones and their resulting reference Item. Tome's **Devana** spelling resolves to the existing Core **Devanna** rune.
Printed DCs, grades, times, investments and prices are retained, including Burning and Prolongation's printed price2150.
Glyph/word weights and finished-word prices are not printed; omissions remain visible and flagged.
The slot diagram modifies an existing item and intentionally has no separate product UUID.

## Equipment procedures

- **Physical armor sets:** Crafting Tools, a full-round action and Crafting DC14. Select several distinct covered sections or a subset. Success conserves the set's total weight and returns unused portions as real inventory Items. Failure retains the set. Removal is DC15 and returns only the actual installed portions.
- **Ordinary runes/glyphs:** Crafting Tools, one carried stone, eligible gear and a free slot. Permanently consumes the stone. The book provides no generic inscription check/time, so no armor-enhancement roll or action cost is borrowed.
- **Runewright inscription:** carried Runewright’s Tools and **30 minutes of actual world time**. Rechecks tool, target, capacity and stone at completion. Applies the printed enhanced result without inventing a Crafting check.
- **Words:** carried diagram, Runewright’s Tools, component stones and two/three slots. Takes **one hour of world time**, then Crafting DC15/DC21. Master-grade diagrams require Master Crafting. Installed required stones can contribute; loose stones are not consumed twice. A failed attempt immediately rolls the same check to recover exactly one preselected component. Other involved stones are lost.
- **Extra slots:** carried Master diagram, Crafting Tools, Meteorite4 and Infused Dust2; **four hours of world time**, Crafting DC25. Every covered location must have full SP, or a weapon full REL, when completing the work. Maximum three total slots; added slots only admit runes/glyphs. Ordinary recovery rules apply to failed material work.
- **Master Crafting:** requires ability ranks and uses a matching compendium/owned diagram as a read-only reference for the actual equipment crafting DC; the diagram need not be owned or carried. The GM can record a verified DC for custom equipment. Rolls that ability at the item's crafting DC. Adds a separate permanent resistance, Bleeding50% or Stun−2 source as appropriate for armor/damage type, with no rune slot or consumed stone.

Timed work is stored on the actor and can be completed from its chat receipt after the GM advances world time normally. Cancellation keeps ingredients but never restores elapsed time. A stale completion cannot repeat the effect.
All procedures use the elected GM's registered command queue. Final receipts are inside rollback; partial creation of returned parts is compensated on failure.

## Durable state and existing worlds

`flags.witcher-rilerena.enhancementState` retains original equipment stats and native versus added slot counts.
Attachments record their source, identity, inscription mode, slots, weight and physical portions. Rebuilds preserve current ablation separately at every covered location, preserve REL wear and retain stronger existing chance/Stun properties.
Master Crafting uses a distinct zero-slot source; replacing a rune cannot erase it.
Ordinary rune/glyph removal is rejected. A word blocks other magic stones even if one slot remains unused.

Legacy installations do not contain enough information to reconstruct values that an old merge overwrote.
Mutation requires a **GM reconciliation** of verified original base stats and actual contributed weights. The prompt labels current combined data as an editing starting point rather than an inferred original.
Read-only effect consumers can still recognize legacy canonical stones.

## Recorded table conventions

The source does not settle every combination. The implementation exposes or records these readings:

1. The physical set's total weight is distributed explicitly among selected pieces. The dialog starts with equal shares per body section; the user can change them, but total mass must be conserved.
2. Ordinary magical stones offer a visible choice whether etched stone weight remains on equipment or the crushed stone is consumed without adding mass.
3. Word crafting records that the word replaces component benefits and that a failed etching destroys existing involved stones except one recovered successfully. These readings are consistent with Tome111–113 but the exact failure timing is not independently spelled out.
4. Identical words never stack, as Tome111 explicitly states. Duplicate Binding/Mending glyphs use a visible **world setting**, strongest(default) or additive, because Tome110 does not settle duplicate stones. The selected rule applies within one item and across worn items.
5. Elemental glyph choice is made per casting and validates worn source, matching element and an actually damaging spell for bonus dice. Multiple glyph stacking is a recorded cast convention; mixed does not match every element.
6. Property magnitudes combine by their strongest value, preserving stronger native/Master Crafting bleeding or Stun instead of overwriting them with a weaker rune. Resistance is not applied repeatedly.
7. Composite words count as one actual attachment for repair difficulty; the later Tome words are not explicitly covered by Core140's repair sentence. Master Crafting is not counted as an attached enhancement.

## Shining

An action activates a **native Foundry V14 AmbientLight** with 6m bright daylight for 30 minutes.
The light follows the actor's worn torso armor, respects native light walls and uses its scene level. The source radius prints no height; the current-level interpretation is stated on its activation card.
The active GM must view the scene so the real V14 light geometry can determine affected tokens. Token footprint containment is tested against `lightSource.shape`; a geometric distance-only substitute is not used to bypass walls.

The source records affected actors with owned daylight effects. Overlapping sources are reconciled, and movement, walls, unequipping/transferring/deleting the armor or token, scene loading and expiry refresh the effect.
Only the dedicated light and its own daylight effects are removed; saved token light and manual actor environment settings are untouched.
Represented sunlight weaknesses use the daylight effect, including Core Katakan regeneration dropping from5 to3. This does not invent mechanics for unrepresented monster abilities.
Unviewed scenes retain previously determined exposure while the live source exists; reopening a scene recomputes native geometry. Expired/deleted sources are removed even when their scene is not displayed.

## Spell glyphs and focusing words

Core p.256 elemental glyphs on actual worn armor grant either **+3 spell DC** or **+1d6 damage** for a matching element; Tome p.120 Runewright inscription increases the DC option to +4. The casting dialog records each selected attachment, its mode and the table's multiple-glyph convention. An unmatched, unworn, duplicate or stale source is rejected before spending STA or Luck. Damage mode requires a spell that already deals damage. Mixed-element glyphs match mixed spells, not every element.

The cast saves these bonuses independently of the raw casting check. DC mode applies alongside an eligible Greater Focus to initial defenses, counters and subsequent resistance checks. Removing the armor later does not change the saved DC. Damage mode changes the actual damage formula and does not also raise DC.

Tome p.111 **Depletion** and **Prolongation** require the actual selected, eligible held focusing weapon carrying that word. Carrying another enchanted weapon grants no benefit. Their identity and bonuses are saved on the cast, including when the focus later changes.

- **Depletion:** a target that fails its actual spell/invocation defense loses a real 1d6 STA, once per original cast and target. Zero STA applies the normal unconscious/stunned state. Accepted magic, a successful defense, infinite STA and a periodic effect with no defense roll do not trigger it. The depletion receipt and target changes compensate together if the final write fails.
- **Prolongation:** for a printed random duration, the cast rolls the printed dice twice, saves the higher result, and applies the correct rounds/hours unit. Applying or retrying that cast never rerolls its duration. Fixed durations and critical-treatment uses of Magic Healing receive no duration roll; the latter restore no HP.

The one-Depletion-per-original-cast-and-target interpretation avoids silently repeating a single casting's added STA loss on every periodic tick. New continuing attacks still require actual failed defenses before the original cast can first apply it to that target.

## Verification

- `enhancements.test.mjs`: catalog reproducibility, actual links/prices, source-preserving SP/REL/property plans, physical portions, improved stones, per-cast glyph validation, word composition, slot restrictions, legacy rejection and duplicate passive glyph conventions.
- `enhancement-workflow.test.mjs`: actual registered commands with document writes, one-time consumption, elapsed-time checks, stale tools/damaged armor, one-stone recovery, rollback after failed receipts and partial embedded creation; native-light boundary/follow/expiry/unequip/exposure lifecycle with controlled documents.
- `magic-workflow.test.mjs` and `magic-ongoing-workflow.test.mjs`: actual inscription followed by spell casting, worn glyph DC/damage and explicit stacking, stale source rejection, strict Dispel ties, continued glyph DC with saved/fresh casting checks and Cursed Illness recovery, Depletion provenance and rollback, periodic no-defense exclusion, and Prolongation duration/units/retries/critical-treatment exclusion. The focused magic, enhancement and social handoff run passed 172 tests; these are document/authority fixtures, not a live Forge session.
- `node tools/witcher/validate-enhancement-models.mjs /path/to/foundry.mjs`: validates the generated native AmbientLight against genuine V14 field/document models. This checks its data schema; live canvas, Forge and multiplayer acceptance remain separate checks.

## Combat and recovery consumers

Chemobog checks actual REL loss from blocks, fumbles, damage and magical Rust. Shearing adds wear only after armor or pavise cover is penetrated, not after every ordinary shield block. Burning adds the fire damage option without an ignition chance; Rotation removes the rear attack bonus. Binding reduces random bleeding chances; Warding applies one elemental resistance. Protection changes maximum HP without repeatedly healing when armor is equipped. Mending adds healing once, including elapsed potion regeneration, and excludes temporary HP grants.

Deflection uses the actual weapon skill at −6, or Parry Arrows at its normal −3 plus the word's +2. Only a strictly higher result redirects a projectile. The new target must be within 10m and receives a real defense; failure causes Staggered without invented projectile damage.

Retribution uses 3 untyped magical torso damage ignoring armor. The source supplies neither an elemental damage type nor a block defense: this implementation does not invent fire/elemental susceptibility and follows the system's existing Quen rule for unblockable magic. It never recursively triggers itself. Rejuvenation requires an actual death and GM confirmation that the recorded attack with that weapon caused it; a zero-HP target or fully blocked later attack cannot manufacture or steal the kill credit.

Perun and Maribor Forest each add one die to the original adrenaline gain event (a nonrecursive additive reading); BODY still caps the pool. Placation costs 5 STA per die. Improved Perun retains actual rolled ones, without refunding spent STA. Core's emergency wording does not specify an exact positive HP amount; the emergency control explicitly records the table ruling of 1 HP.

`enhancement-combat-workflow.test.mjs` exercises accepted attacks/defenses, real SP/REL changes, protection rolls, redirected defense, kill and retaliation receipts, resource spending, temporary HP and failed persistence. These complement the installation and casting tests above.
