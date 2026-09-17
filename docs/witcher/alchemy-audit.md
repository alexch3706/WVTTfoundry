# Alchemy audit before implementation

Audit date: 2026-09-17. Baseline: `38a235d4`, alpha.6. This is a source/code audit, not an implementation or live Foundry certification. The authorized order is focus → alchemy → glyphs/enhancements → social combat. No implementation files were changed for this audit.

Primary sources read locally: **The Witcher Core Rulebook v1.35**, printed pp.32, 70, 87–88, 142, 146–147, 175, 246–251; **Core Errata 2022**; **A Tome of Chaos v1.01**, printed pp.27, 88, 97, 115–116, 210. Tome p.116 recipe symbols were checked visually in the PDF against the Core p.142 symbol legend. Page numbers below are printed book pages.

## Findings that should drive implementation

1. **Tome elixirs are missing.** None of its six elixirs or recipes are in the catalog. Penitent Mutagen is also missing. Bear Mutagen already exists through the Journal supplement.
2. **Many consumed items currently grant no printed effect.** Black Blood, Blizzard, Maribor Forest and several decoctions create named effects without the necessary combat consumers. Grave Hag's regeneration reads a `kills` field which no code increments. A catalog entry or saved flag is not runtime support.
3. **Toxicity recovery is incorrect.** Core p.247 says a successful DC18 Endurance check ends the latest potion's effects as well as toxicity poisoning. `endCondition` removes poison but leaves the latest potion and toxicity. White Honey and normal expiry change the toxicity number but leave the separate `Toxicity` effect/poison. Its trigger threshold uses Iron Stomach correctly, but ending below the limit and source attribution need a real state machine.
4. **25-dose bottles become unusable after the first dose.** `useItem` and `applyItem` require quantity ≥1, while Chloroform/Smelling Salts subtract 1/25. A fresh bottle becomes 0.96 and the next use is rejected. Use explicit dose counts or validate the actual fractional dose cost.
5. **Thunderbolt uses a generic damage field.** `POTION_MODIFIERS` adds `damage: 3`; `combat.prepareDamage` excludes environmental damage, and `magicDamageCard` sets `environmental: true`, so the current spell path does not receive this bonus. A dedicated physical-damage modifier makes the printed scope explicit and protects later entry points (Core p.247).
6. **Noon Wraith prevents no future conditions.** Its use clears Stun, Blindness and Prone once, but no immunity consumer is installed. Subsequent attacks can apply all three again.
7. **Alchemy operations are not consistently authoritative or compensated.** Ordinary use runs through a client-local serial queue; a GM approval card mutates the target/item before setting its applied flag. Cross-Actor use can change the target before an item write fails. Use, mutagen preparation, oil application and crafting post chat after committing consumption, so message failure can leave a consumed item with a retryable operation.
8. **Round/event triggers are missing.** There is no common authoritative receipt for a successful strike, being struck without damage, actual HP damage, credited kill, combat end, potion end or blood ingestion. These are distinct printed triggers. Derive them from accepted combat results, never from a player-entered accumulated bonus.
9. **Some medical/alchemical fields have no consumers.** `painRelief`, `healingDays`, `poisonDetectionDC` and nonmagical `flammable` are stored but not consumed by their actual rule paths. `magicIgnitionChance` reads magical rule operations, not Quick Fire's plain effect field.
10. **Expiry and recovery are inconsistent outside combat.** `updateWorldTime` expires nonmagical effects but does not process Swallow/Troll regeneration. Its Actor enumeration covers world Actors and tokens on the current canvas, missing synthetic actors on other scenes. Name-only effect lookups also ignore expiry/disabled state until cleanup runs.

## Existing implementation sites

| Code                                           | Relevant responsibility                                                                           |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `activities.js:useItem/applyItem`              | Named potion/alchemical use, quantity changes, non-witcher resistance, oil selection.             |
| `activities.js:performMutagen`                 | Actual Alchemy roll, permanent effect, two-slot limit and consumption.                            |
| `activities.js:tickActor/expireEffects`        | Combat round damage/regeneration, effect expiry and toxicity recomputation.                       |
| `activities.js:performTurnAction/endCondition` | Tawny Owl Recovery bonus; current generic poison cure.                                            |
| `activities.js:craftAttempt`, `crafting.js`    | Formula/tool/material checks, actual output creation, failed-attempt recovery.                    |
| `documents.js:actorSnapshot/skillBase/rest`    | Golden Oriole snapshot immunity; Cat/Killer Whale checks; natural healing and wound days.         |
| `rules.js:derivedStats/resolveDamage`          | Mutagen base-stat changes, maximum resources, ENC, damage/armor.                                  |
| `combat.js:prepareDamage/planDamageChanges`    | Blade-oil damage; generic potion damage; `hitThisRound` currently means damage, not every strike. |
| `magic-state.js:magicVigor`                    | Reads permanent mutagen Vigor modifiers.                                                          |
| `magic-effect-hooks.js:magicModifierSummary`   | Reads ordinary potion/mutagen modifier maps as well as magic.                                     |

Coverage labels: **Connected** means the named mechanical consumer exists; **Partial** identifies what works and what is missing/wrong; **Missing** means no effective consumer or catalog row. Connected entries still inherit the common transaction/expiry defects above and require real workflow verification.

## Core potions — p.247, non-witcher rule p.246

All 12 are in `witcher-gear.json`, with their printed durations/toxicity; durations are stored in rounds and converted to seconds by the use helper.

| Potion         | Actual current consumer                                                                                          | Outstanding behavior                                                                                                                                                                                                                                                                                                                      |
| -------------- | ---------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Black Blood    | **Missing** beyond duration/toxicity.                                                                            | Actual blood-ingestion trigger on another creature; 3 HP/round poison, Endurance DC20 termination, forced 2 m recoil with collision/placement handling. A normal bite is not automatically proof that blood was drunk.                                                                                                                    |
| Blizzard       | **Missing** beyond duration/toxicity.                                                                            | Credited enemy kill grants +4 REF once; subsequent kills do not stack or restart duration. Clear with the potion.                                                                                                                                                                                                                         |
| Cat            | **Partial:** removes dark combat penalty and light/underwater-context Awareness penalties through name checks.   | Hypnosis immunity and +2 when seeing through illusions missing; `skillBase` also wrongly exempts bright-light Awareness penalties, although Cat names darkness/dimness. No native token vision enhancement.                                                                                                                               |
| Full Moon      | **Connected:** current HP +30, maximum HP +30, subtraction at expiry/White Honey; duplicate active use rejected. | Verify temporary-HP behavior with injury thresholds, lethal expiry and death-save receipts, suppression, withdrawal and rollback. The book calls them temporary HP but does not specify a separate absorption pool; do not silently import another game's temporary-HP rules.                                                             |
| Golden Oriole  | **Partial:** clears poison at use, adds snapshot poison immunity, round poison damage is suppressed.             | Central condition immunity currently receives raw Actor state in some paths and can still admit poison; poison source cleanup/re-exposure and toxicity interactions need consistency.                                                                                                                                                     |
| Killer Whale   | **Partial:** removes underwater Awareness penalty.                                                               | Breath-holding duration ×1.5 has no clock/consumer; distinguish lack of air from wound-induced suffocation.                                                                                                                                                                                                                               |
| Maribor Forest | **Missing.** `adrenalineCost` exists only as a pure helper and is never called.                                  | Actual optional Adrenaline subsystem, critical-hit gain, BODY pool limit, two dice instead of one, predeclared STA expenditure and combat-end cleanup. Core p.175 labels Adrenaline optional: expose a setting and explain an inactive potion when that rule is off.                                                                      |
| Petri's Filter | **Connected:** +2 Spell Casting, Hex Weaving, Ritual Crafting through modifier summary and skillBase.            | Verify all three authoritative checks, manual dice, expiration and no duplicate addition.                                                                                                                                                                                                                                                 |
| Swallow        | **Partial:** +3 HP on a combat tick unless `hitThisRound`.                                                       | The flag is set only for damage >0, so an armor-stopped strike wrongly allows regeneration. Decide Quen's fully absorbed strike consistently with the physical-contact model. Add elapsed rounds outside combat and source-aware recovery restrictions.                                                                                   |
| Tawny Owl      | **Connected:** Recovery Action adds 2 STA before cap.                                                            | Verify near-cap Recovery, magical exhaustion counter, unconscious recovery, expiry and no bonus on unrelated rest recovery.                                                                                                                                                                                                               |
| Thunderbolt    | **Partial:** +3 damage is applied.                                                                               | Keep the scope explicitly physical; current magic damage is excluded by its environmental flag. Apply once per physical strike, not again per bonus term.                                                                                                                                                                                 |
| White Honey    | **Partial:** removes effects marked `potion`, subtracts Full Moon temporary HP and sets toxicity to zero.        | Remove toxicity-caused poison and its `Toxicity` source while retaining unrelated poisons. Its early branch skips p.246's non-witcher check: book gives no explicit exemption, so choose/document a rule instead of silently exempting it. Interaction with Tome elixirs needs a declared source interpretation, not a category accident. |

### Toxicity details requiring an explicit rule decision

- Core says ≤100% has no ill effect, but once poisoning has started its literal recovery sentence says lower toxicity **below** 100%. Handle the equality boundary explicitly and document it; Iron Stomach raises tolerance (Core p.70).
- A failed non-witcher DC18 check grants poison and no potion effect. Current code gives no specific failed-ingestion source, so its later cure silently becomes generic poison DC15. Do not invent a higher cure DC unless the source states it.
- The book ties toxicity to the duration of the potion/decoction. Several Tome elixirs have no explicit time duration; that requires an actual GM decision/record rather than a hardcoded invented timer.
- General same-potion stacking is not stated for every entry. Full Moon and Swallow explicitly prohibit stacking; the current code rejects duplicate active effects for every potion/decoction. Preserve explicit no-stacking rules and record a table ruling for any broader policy.

## Blade oils — Core p.248, formulae p.250

All 12 are cataloged. Each currently stores one `system.oil` on a selected equipped weapon for exactly 1,800 seconds; `prepareDamage` adds 5 before armor against a matching category.

| Oil                | Target category | Coverage  |
| ------------------ | --------------- | --------- |
| Beast Oil          | beast           | Connected |
| Cursed Oil         | cursed          | Connected |
| Draconid Oil       | draconid        | Connected |
| Elementa Oil       | elementa        | Connected |
| Hanged Man's Venom | humanoid        | Connected |
| Hybrid Oil         | hybrid          | Connected |
| Insectoid Oil      | insectoid       | Connected |
| Necrophage Oil     | necrophage      | Connected |
| Ogroid Oil         | ogroid          | Connected |
| Relict Oil         | relict          | Connected |
| Specter Oil        | specter         | Connected |
| Vampire Oil        | vampire         | Connected |

Shared gaps: dialog permits every equipped Weapon Item, including unsuitable natural attacks/bows; explicitly choose legal blades/weapon surfaces. Damage code forces every non-monster Actor to `humanoid` instead of respecting its actual category. No transaction includes the result card. Weapon oil can expire after an attack card is created while the saved attack still holds the previous oil data; validate or clearly define the strike-time snapshot. Reapplication overwrites the previous oil without explaining replacement. Base mechanics should expose active oil/time remaining on the owned weapon.

## Decoctions — Core p.248

All ten are cataloged at 75% toxicity for 30 minutes.

| Decoction   | Actual current consumer                                                          | Outstanding behavior                                                                                                                                                                                                                          |
| ----------- | -------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Arachas     | **Missing.**                                                                     | Dynamic +2 SP to every location per complete 10 free ENC; recompute with carried inventory, coins and Fiend's ENC change. Do not permanently increase base/max SP or confuse the bonus with armor repair.                                     |
| Fiend       | **Connected:** `encMultiplier:2` enters derived ENC.                             | Verify carried weight, encumbrance penalties, Arachas interaction and expiry.                                                                                                                                                                 |
| Grave Hag   | **Missing event consumer:** tick reads `kills ×2`, but `kills` is never written. | Credit each slain enemy once in the current combat; +2 HP/round per kill; reset at combat end, regardless of remaining potion duration.                                                                                                       |
| Griffin     | **Missing.**                                                                     | Each actual damage event >5 grants +2 SP to all locations, stacking. Errata 2022 confirms >5 and +2 SP; define whether a multi-location explosion is one damage event using recorded damage receipt, not one counter per arbitrary hook call. |
| Katakan     | **Missing.**                                                                     | +3 to critical-wound location determination. Integrate random and aimed tables without raising attack margin/severity; handle results above the table's normal maximum explicitly.                                                            |
| Nekker      | **Partial:** +3 Riding/Athletics enters checks.                                  | Actual ridden mount must not panic; no panic prevention consumer or linked mount lifecycle. Mounted combat was previously deprioritized, so describe this limitation until the required narrow hook is installed.                             |
| Noon Wraith | **Partial:** initial removal of stunned/blinded/prone.                           | Persistent immunity to Stun, Blindness and being knocked prone, across saves, conditions and magic. Clearing an existing condition and preventing a new one are separate behaviors.                                                           |
| Troll       | **Connected in combat:** regenerates 5 HP/round.                                 | Elapsed-round recovery outside combat; no double healing on repeated hooks, no revival of dead characters; expiry boundary.                                                                                                                   |
| Werewolf    | **Missing.**                                                                     | Exemption from STA expenditure for long-duration running. Current Run action has no long-duration fatigue procedure to exempt.                                                                                                                |
| Wyvern      | **Missing.**                                                                     | Each successful strike adds a cumulative +1 to the next strike; reset on taking damage or combat end. Hit event and damage event must not be conflated.                                                                                       |

Core p.70 Transmutation is a separate profession ability with a DC18 check, ten variant bonuses and halved decoction duration. None of those extra effects are connected to ingestion. Profession abilities were previously out of priority: expose/document that boundary rather than suggesting normal decoctions implement Transmutation.

## Mutagens — Core p.251, Tome p.210

Existing preparation rolls real Alchemy, consumes a dose and adds a permanent modifier effect. Core base-stat mutagens enter the base statistic before deriving HP/STA; numeric Vigor reaches the actual casting threshold. Two permanent slots are enforced in the command, and another party member can prepare the target's mutagen.

| Mutagen               | Bonus                                  | Current coverage                                                                                                                                             |
| --------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Griffin               | +2 melee damage                        | Connected through derived melee bonus.                                                                                                                       |
| Katakan               | +1 REF                                 | Connected permanent base REF.                                                                                                                                |
| Nekker                | +1 melee damage                        | Connected.                                                                                                                                                   |
| Werewolf              | +3 melee damage                        | Connected.                                                                                                                                                   |
| Wyvern                | +3 melee damage                        | Connected.                                                                                                                                                   |
| Arachas               | +5 HP                                  | Connected maximum HP modifier.                                                                                                                               |
| Fiend                 | +1 BODY                                | Connected base BODY and derived statistics.                                                                                                                  |
| Grave Hag             | +5 HP                                  | Connected maximum HP modifier.                                                                                                                               |
| Noonwraith            | +10 HP                                 | Connected maximum HP modifier.                                                                                                                               |
| Rock Troll            | +10 HP                                 | Connected maximum HP modifier.                                                                                                                               |
| Golem                 | +2 Vigor threshold                     | Connected through magicVigor.                                                                                                                                |
| Siren                 | +1 Vigor threshold                     | Connected through magicVigor.                                                                                                                                |
| Bear (Tome p.210)     | +10 HP, DC20, prolific hair growth     | Already cataloged from Journal p.144 with a connected numeric modifier. Preserve one identity or explicit alias instead of duplicating the same usable dose. |
| Penitent (Tome p.210) | +2 Vigor, DC18, glowing white markings | Missing catalog entry. Generic numeric mutagen preparation can consume the bonus once the complete source row exists.                                        |

Shared gaps:

- Core harvesting requires a killed monster and Witcher Training DC16. There is no harvest command selecting the actual corpse/mutagen and preventing duplicate extraction. Tome's Mutagen Extraction spell changes extraction to Alchemy or Witcher Training DC14; its saved metadata is not a harvesting workflow.
- One hour is acknowledged by a button; no saved preparation clock. The book allows declaration of elapsed crafting time, so retain an explicit attestation or implement a clock rather than implying one already runs.
- Non-witchers become poisoned with DC18 termination. Endurance is available, but the equally permitted **First Aid DC18 by another character** is not implemented.
- The slot limit counts effects marked `mutagen`; ensure normal effect controls cannot erase them, and migration does not orphan the permanent source. Generic UI already intends them to be non-removable; verify against all update routes.
- Failed processing currently consumes the dose. p.251 does not define salvage after this specific failure; do not silently import an unrelated recovery rule.
- Preparation chat is outside consumption/target mutation compensation. It needs one authoritative transaction and a retry-safe receipt.
- Tome's advanced mutation experiments and Core's Mutate spell are separate magical workflows, not ordinary mutagen ingestion. Their special death/social effects must not be applied to a normally prepared Witcher mutagen.

### Existing Journal mutagens (compatibility audit)

These existing Items have numeric `bonuses` consumed by the same preparation routine. This table checks the consumer, not a new re-audit of Journal text: Botchling +2 melee; Cockatrice +2 melee; Manticore +1 REF; Phoenix +3 melee; Vendigo +3 melee; Bear +10 HP; Bullvore +10 HP; Frightener +1 BODY; Garkain +10 HP; Shaelmaar +10 HP; Succubus +5 HP; Troll +5 HP; Bruxa +1 WILL; Elemental +3 Vigor; Foglet +2 Vigor; Leshen +1 WILL; Pesta +2 Vigor. All are connected to the shared stat/damage/Vigor consumers. Journal Troll +5 HP must remain distinct from Core Rock Troll +10 HP.

## General alchemical items — Core pp.87–88

All 22 have catalog entries and Core formulas, but the following describes actual use behavior.

| Item                        | Current coverage and exact gap                                                                                                                                                                                                                                                                                               |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Acid Solution (87)          | Partial: Athletics/BODY×2 throw, 2d6 and rolled half-d6 ablation on selected target. No native 2 m cone away from impact covering all creatures/objects; held weapon/equipment exposure needs actual targets.                                                                                                                |
| Adda's Tomb (87)            | Partial: consumes one dose and prints 1d10 days. No preserved object/expiry record, and human-sized corpse incorrectly costs only one instead of two doses.                                                                                                                                                                  |
| Alchemical Adhesive (87)    | Missing: throwing payload stores `adhesive:true`, with no combat consumer. Needs two-round hardening, actual bonded creatures/objects and permanent bond with Physique DC16 separation.                                                                                                                                      |
| Base Powder (87)            | Partial: turns off Torn Stomach `damagePerTurn` through an early embedded update. That write is outside the subsequent consumption transaction; specific acid dose neutralization has no selected source.                                                                                                                    |
| Black Venom (87)            | Partial: direct application adds poison with DC16 cure. Missing ingestion/bloodstream exposure distinction, full-round blade coating, 1d10-round poisoned weapon duration, penetrating-cut reinfection and Awareness DC16 poisoned drink detection.                                                                          |
| Bredan's Fury (87)          | Partial: 2d6 to every location of one target. It does not collect every creature within 2 m of the actual explosion.                                                                                                                                                                                                         |
| Chloroform (87)             | Partial: initial unmodified d10 compared to STUN−2, conditions and 1/25 consumption. Missing delivery Melee attack, continuing recovery at −2, source-specific unconsciousness and usable 25-dose inventory.                                                                                                                 |
| Clotting Powder (87)        | Partial: suppresses bleeding damage for 2d10 rounds, later may re-add a generic bleeding flag. Needs wound/bleeding-source attribution so expiry does not revive a cured unrelated source or lose wound bleeding.                                                                                                            |
| Fisstech (87, addiction 32) | Partial: DC18 addiction check; DC16 initial trance check; records addiction and unused painRelief. Missing permitted Endurance recheck each round, continuing below-10 unconsciousness, ongoing Stun expiry and actual addiction daily/offered-drug checks. Five-round unconsciousness currently leaves stale stunned state. |
| Hallucinogen (87)           | Partial: DC15 Endurance, 1d10 rounds and condition expiry. Missing thrown delivery within 3 m versus ingestion, and condition-source-safe termination.                                                                                                                                                                       |
| Invisible Ink (87)          | Text result only. Needs selected actual message/journal/object and heat-reveal control if advertised as an automated item; otherwise explicitly manual narrative use.                                                                                                                                                        |
| Numbing Herbs (88)          | Missing mechanical consumer: stores `painRelief:2` for 2d10 rounds. Must reduce critical-wound and near-death penalties by 2 without granting positive bonuses or restoring missing anatomy.                                                                                                                                 |
| Pantagran's Elixir (88)     | Connected: Resist Coercion −2 for rolled 1d6/2 hours. Its helper accepts rounds, so `roll ×600 ×3 seconds` is correct. Verify applicable social resistance and source-safe expiry. This Core item is distinct from Tome's Elixir category.                                                                                   |
| Perfume Potion (88)         | Partial: Endurance DC16, intoxication for 1d10 hours, 25 toxicity stored. Does not update/check toxicity when consumed. Keep its special cure restriction (magic/Wive's Tears); ordinary generic expiration/removal must not imply a new cure.                                                                               |
| Poisoner's Friend (88)      | Missing consumer: stores `poisonDetectionDC:20` on the Actor, not actual poisoned food/drink. Needs an object/source and a detection check; does not make every poison in the Actor universally DC20.                                                                                                                        |
| Quick Fire (88)             | Missing consumer: stores `flammable:50`. Needs 50% ignition on open flame/sparks and +50 percentage points when another effect has an ignition chance, with actual marked surfaces/objects/creatures.                                                                                                                        |
| Smelling Salts (88)         | Partial: immediate unstun/unconscious removal, but 25-dose bottle breaks after first use. Must respect magic that explicitly forbids ordinary waking (e.g. Healing Rest) and avoid clearing an unrelated persistent source.                                                                                                  |
| Sterilizing Fluid (88)      | Partial: `rec:+2` affects derived REC, including STA Recovery actions although the item grants natural healing only. `healingDays:-2` has no wound-clock consumer. Needs the treated wound's two-day reduction, non-stacking and correct natural-HP-only bonus.                                                              |
| Succubus' Breath (88)       | Partial: skin use grants +2 Seduction. Ingested −5 resistance-to-seduction mode and Awareness DC16 drink detection are missing. Restrict to seduction resistance, not all Resist Coercion checks.                                                                                                                            |
| Talgar's Tears (88)         | Partial: freeze chance reaches combat condition resolution. Missing actual 2 m impact cone and doubled ablation of exposed weapons/armor/objects.                                                                                                                                                                            |
| Wive's Tears Potion (88)    | Connected initial sobering. Must end the selected intoxication sources/timers so expiry cannot remove a later unrelated intoxication or leave an active Perfume source; retain toxicity unless a source says otherwise.                                                                                                      |
| Zerrikanian Fire (88)       | Partial: target fire condition on a successful throw. Missing actual 2 m impact cone and ignited objects/surfaces.                                                                                                                                                                                                           |

Core p.87 also states that these bottles break/spill when taking **more than 5 damage**, activating thrown chemicals. There is no inventory-bottle exposure/breakage workflow. Do not silently damage every carried bottle from a hit to its owner; the GM must identify exposed bottles/containers and actual damage.

## Tome elixirs — pp.115–116

All six rows below are **missing**, including formula Items. They are safe for non-Witchers to ingest without the Witcher-potion DC18 check; total toxicity above 100% still poisons. Halflings gain no benefits but still suffer toxicity (p.115).

| Elixir            | Printed behavior                                                                                                                             | Required consumer                                                                                                                                                                                               |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Anabolic Steroids | 50% toxicity; +10 maximum HP, +2 Endurance/Physique for 10 minutes; aggression for 1 hour.                                                   | Separate benefit/behavior clocks. Book says maximum HP, not Full Moon's +current temporary HP. Saved aggression marker with GM-facing behavior, no invented forced-attack rule.                                 |
| Last Hope         | 75%; treats one critical wound, but wound cannot heal until Doctor's Healing Hands DC24 reapplies it and then Healing Hands treats it again. | Actual chosen wound, locked recovery, reapplication and medical re-treatment states. No invented automatic natural recovery or magical bypass. Review explicit stronger magic such as Miracle separately.       |
| Lightning         | 75%; +3 damage on next physical attack.                                                                                                      | One-use predeclared attack receipt; consumes on the next attack, not every strike until arbitrary time or only a successful hit. No printed time limit in this entry.                                           |
| Mongoose          | 50%; immunity to poisoned condition for 30 minutes.                                                                                          | Central condition immunity throughout duration, including direct poison/critical sources. Unlike Golden Oriole, text does not expressly say it neutralizes existing poison: record the intended interpretation. |
| Strider           | 50%; no need for sleep for 24 hours.                                                                                                         | Sleep/fatigue/rest eligibility; does not automatically grant all rest or healing benefits.                                                                                                                      |
| Tempest           | 50%; +10 percentage points to existing Fire/Freeze/Prone attack or spell chances.                                                            | Shared physical and magical proc consumer, cap at 100, no new proc where none exists. No printed time limit in this entry.                                                                                      |

### Tome recipe transcription verified from PDF p.116

Every recipe additionally consumes **one bottle of Alcohest**. Existing equipment already has Alcohest. Symbols were read from the PDF; plain text extraction omits them. The printed second Last Hope table also says Journeyman Diagram; preserve the source instead of silently relabeling by DC.

| Formula           |  DC | Time   | Substances                                              | Formula cost |
| ----------------- | --: | ------ | ------------------------------------------------------- | -----------: |
| Anabolic Steroids |  16 | 30 min | Rebis 1, Caelum 1, Quebrith 1, Hydragenum 2             |          330 |
| Lightning         |  16 | 15 min | Vitriol 2, Vermilion 2, Hydragenum 2                    |          150 |
| Mongoose          |  15 | 15 min | Rebis 2, Aether 2, Fulgur 2                             |          100 |
| Strider           |  16 | 15 min | Rebis 2, Aether 1, Fulgur 1, Caelum 1                   |          128 |
| Tempest           |  15 | 15 min | Vitriol 1, Aether 1, Quebrith 1, Caelum 1, Hydragenum 1 |          104 |
| Last Hope         |  22 | 1 hour | Sol 2, Vitriol 1, Aether 2, Vermilion 3                 |          400 |

Tome p.210 additions: Bear Fat/Rebis and Bear Hide already exist through Journal; **Bes Horn/Fulgur** and **Mari Lwyd Skull/Hydragenum** are absent. Source quantities are 1d6/3 horns and one skull respectively. Keep any fractional-dice rounding decision explicit.

## Crafting coverage and requirements

There are **56 Core Alchemy formula Items**: 22 ordinary items, 12 potions, 12 oils and 10 decoctions. They point to actual compendium products; source alias spellings such as Wives' Tears/Relict Oils resolve by UUID. Oil recipes include one Dog Tallow; decoctions include the appropriate mutagen and one bottle of Spirits (Core p.250).

`craftAttempt` checks carried Alchemy Set, written or memorized recipe, ingredients and a declared elapsed time. Written formula adds +2; Alchemy is rolled against the actual formula DC; success creates one dose. Failed crafting consumes ingredients, then offers one immediate recovery check against the same DC and a choice of one used pure substance. `allocateMaterials` substitutes by alchemical substance and avoids spending a unit twice.

Needed work:

- Lock/revalidate actual inventory after the dialog; allocation is currently computed before it. Persist a project/attempt receipt so retries or stale clients cannot duplicate finished doses or repeat recovery.
- Include product creation, ingredient consumption, check result and the resulting chat/attempt marker in compensation. A failed result-card write currently leaves a completed craft.
- Formula availability checkbox is user input; validate actual written Item, or explicit GM attestation, consistently with the existing memorized-recipe hex rule.
- Generic `substanceUnits` exists in the schema but `allocateMaterials` never reads it; audit supported source rows before using multi-unit ingredients. Do not advertise this field as multiplying a material's contribution today.
- Provide integer bottles/doses and actual containers; p.92–93 Alchemy Set/bottle details matter if inventory includes empty containers. Do not invent a compulsory separate vial cost unless the formula/source requires it.
- Tome Herbalism (p.97) can substitute Spell Casting for Alchemy only when all elixir ingredients are plants, including recovery. Pure substitution rules exist, but `craftAttempt` supplies no `plantOnlyElixirCraftingOrRecovery` context. Do not enable that magic based on the rule descriptor alone.
- Essence of Potion (Tome p.88) copying already creates a real new dose, consumes Essence of Water and marks the source as copied. The source does not halve potency; preserve its dose identity through consumption/stacking. This is a separate spell, not a reason to invent a dilution rule.

## Recommended implementation sequence after focus audit

1. **Authoritative use and lifecycle foundation:** stable alchemy key, source Item UUID, target UUID, dose accounting, typed effect sources, check/manual-dice support, validated turn/action cost, idempotent receipts and compensation including chat. Migrate existing named effects without silently losing permanent mutations.
2. **Toxicity and expiry:** named-source poisoning, latest-dose removal on DC18, Iron Stomach threshold, White Honey, non-witcher ingestion and Halfling elixirs; combat/world-time and synthetic Actor coverage.
3. **Shared combat events and simple consumers:** physical-only damage, successful hit vs damage vs kill, proc chances, immunities, armor/SP bonus, regen, critical location, combat-end cleanup. Implement each potion/decoction using those authoritative events.
4. **Owned item operations:** legal blade oil/Black Venom coating and timers; native impact areas for thrown chemicals; selected object/surface effects and explicit bond/poison detection controls.
5. **Medical alchemy:** Numbing Herbs, Sterilizing Fluid, Clotting Powder, Last Hope's wound state machine; source-aware stun/sleep/intoxication/poison cleanup and fractional doses.
6. **Tome content and mutagen completion:** six products/formulas, missing mutagen/components, harvesting and First Aid poison cure; elixir craft/consume round trip using real components and catalog links.
7. **Focused verification before claiming completeness:** one meaningful use/expiry/workflow case per mechanical family, edge cases for every triggered item, and source-specific comparisons per catalog entry. General crafting/unit catalog tests alone do not exercise consumption.

Minimum failure tests: chat failure after target update; item write failure on another Actor; duplicate GM approval; stale target wound/weapon; expired potion on a synthetic token off-canvas; elapsed time jump/repeated hook; oil mismatch; non-physical attack with Thunderbolt/Lightning; armor-stopped strike with Swallow; actual kill attribution for Blizzard/Grave Hag; 26th use of a 25-dose bottle; Last Hope interrupted/retried surgery; multi-target chemical splash with separate defenses.

Book ambiguities (not authorizations to invent rules): general duplicate-potion policy, equal-threshold detoxification, temporary-HP expiration details, the lifetime of instantaneous/untimed Tome elixir toxicity, and interactions of explicit stronger healing with Last Hope. Use a visible persisted GM ruling where the provided books do not settle the result.
