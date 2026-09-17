# Enhancements, runes, glyphs and enchantments: source audit

Read-only implementation audit against **alpha.6, commit `38a235d4`**. Sources are the supplied Core Rulebook v1.35, Core Errata 2022 and A Tome of Chaos v1.01, using printed page numbers. This document proposes the next implementation stage; it does not mark missing mechanics as implemented.

## 1. Source map and baseline inventory

| Subject                                                    | Source                                       | Existing catalog/runtime                                                                                                                                          |
| ---------------------------------------------------------- | -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Weapon rune slots; Armor Piercing, Focus and Greater Focus | Core 72; Errata's p.72 correction            | Weapon properties/slot fields exist. Ordinary Armor Piercing bypasses armor resistance; Improved AP also changes SP. Focus audit is a separate active task.       |
| Armor slots, EV and resistance                             | Core 78                                      | Armor records and native damage/EV calculation exist.                                                                                                             |
| Ordinary armor enhancements                                | Core 90; Errata p.90 corrections             | All seven enhancement Items exist in `equipment.json`; installation is incomplete and removal absent.                                                             |
| Enhancement diagrams                                       | Core 139; Errata's Dwarven recipe correction | Seven recipe rows exist in `diagrams.json`; two have the wrong product UUID.                                                                                      |
| Repair with enhancements                                   | Core 140                                     | `repairDifficulty = craftDC − 5 + 2 × attachments.length` exists.                                                                                                 |
| Core runes/glyphs                                          | Core 256                                     | Ten runes and five glyphs exist in `witcher-gear.json`; rune support is partial, all five glyph effects lack consumers.                                           |
| Additional glyphs                                          | Tome 110                                     | Four Items and their effects are absent.                                                                                                                          |
| Runewords/glyphwords                                       | Tome 111–112                                 | Eight runewords and seven glyphwords are absent as specific procedures/catalog entries.                                                                           |
| Enchantment diagrams                                       | Tome 113–114                                 | Fifteen word recipes and the extra-slot recipe are absent.                                                                                                        |
| Runewright’s Tools and improved inscription                | Tome 120; price Tome 123                     | Tool Item exists in `magic-gear.json` (550 crowns, weight explicitly unspecified). Rituals retain it correctly. Half-hour inscription and its bonuses are absent. |
| Master Crafting                                            | Core 63; exact replacement in Errata         | Generic profession ranks exist, but there is no actual Master Crafting improvement workflow.                                                                      |
| Adrenaline, needed by Perun/Placation                      | Core 175, optional rule                      | Only unused pure `adrenalineCost` helper/tests; no actor pool, earned-die/usage controls or combat lifecycle consumer.                                            |

### Existing entry points

- `activities.js:420` — `enhance(actor, enhancement)`: local owner/actor queue, one target, generic full-round action, optional Crafting DC14, attachment snapshot and permanent base-field mutation.
- `sheets.js` — enhancement **Apply** buttons call that function; there are no attachment removal, slot creation, improved inscription or word crafting controls.
- `documents.js` — generic `enhancements`, `attachments`, `properties`, armor SP and skill bonus fields; no typed slot restrictions or enhancement origin/mode/durability data.
- `combat.js` — ordinary property chances, Stun, AP, armor ablation and block wear; no word hooks.
- `consequences.js:252` — Chemobog checks only the weapon-damage branch of physical fumbles.
- `crafting.js` and `activities.js:craftAttempt` — general material allocation/repair. Ordinary recovery returns half of each material; that is **not** Tome enchantment recovery.

## 2. Ordinary armor enhancements

Core p.90 says these are sold as **sets** and normally apply to every armor piece worn at installation. The sidebar permits using only a body section and keeping the other portions for later. Installation takes one full round, Crafting Tools and Crafting DC14; a failed attempt retains the enhancement. Success adds its bonuses and weight. Removal requires Crafting DC15; success returns reusable enhancement parts, failure leaves the attachment. Damage/breakage does not detach it; destroying the armor destroys its enhancement.

| Enhancement      |  SP | Resistance/effect                    | Set weight | Price |
| ---------------- | --: | ------------------------------------ | ---------: | ----: |
| Chain Mail       |  +3 | Bludgeoning, Slashing                |          3 |   125 |
| Dwarven          |  +5 | Slashing, Piercing                   |        3.5 |   195 |
| Elven            |  +3 | Bludgeoning, Piercing; Stealth +1    |        0.5 |   200 |
| Fiber            |  +1 | Bleeding damage halved, rounded down |        0.5 |    40 |
| Hardened Leather |  +2 | Bludgeoning, Slashing, Fire          |        1.5 |   130 |
| Steel            |  +4 | Slashing, Piercing                   |        3.5 |   145 |
| Studded Leather  |  +2 | Slashing                             |          1 |    80 |

The seven catalog Items match this table. Current installation selects **one** armor Item and consumes the entire set; it neither applies the whole set nor preserves unused body sections. It also permits unworn targets without presenting that as the partial-use choice. The set's listed total weight must not be added once per armor piece. Distribution between pieces/partial portions is unprinted and needs an explicit, recorded convention if per-item ENC must be precise.

Armor bonuses affect both maximum SP and current SP at covered locations. Rebuild from durable base armor plus retained sources; installation/removal must not reset earlier ablation or heal already damaged unrelated locations. Preserve permanent bonuses, native resistances and other attachments when removing a source. Core p.90 does not remove enhancement properties merely because current SP reaches zero.

### Two incorrect recipe products

Core p.139 recipe rows have correct component lists but resolve ambiguous names to the wrong category:

- **Hardened Leather Diagram, DC16, 4 hours** currently creates `components.Item.dab08d4e2480e46e`. It must create `equipment.Item.0d6d168dff97b266` (Hardened Leather Enhancement).
- **Steel Diagram, DC18, 5 hours** currently creates `components.Item.beba339c616a1c68`. It must create `equipment.Item.8ad9daaec609acb7` (Steel Enhancement).

The p.130 component diagrams share those display names and must remain separate. Use canonical product IDs/category/source page, not first name match. The remaining five p.139 enhancement product links are correct. Dwarven's ingredients already match Errata: Mahakaman Steel, Wolf Hide, Thread ×5 and Coal.

## 3. Core runes and glyphs

Core p.256: one open slot per stone, weapons for runes, armor for glyphs, the stone is consumed, inscription is permanent and cannot normally be removed. Tome p.111 provides a special later replacement path when forming a word. The Core does not provide a generic Crafting DC or a full-round duration for ordinary inscription; do not silently borrow armor-enhancement DC/time. Core p.127 and Tome p.120 identify ordinary Crafting Tools as the basic tools.

| Rune     | Core effect                                      | Current behavior/gap                                                                                                    |
| -------- | ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| Chemobog | When weapon would take damage, d6 4–6 negates it | Only physical-fumble damage checks it. Successful block wear and all other weapon-damage routes still bypass it.        |
| Dazhbog  | Fire 30%                                         | Stored property and normal damage-condition path exist.                                                                 |
| Devanna  | Bleeding 30%                                     | Stored property and normal damage-condition path exist. Tome calls it **Devana**; recipe matching needs a stable alias. |
| Morana   | Poison 30%                                       | Stored property and normal damage-condition path exist.                                                                 |
| Perun    | One extra adrenaline die whenever one is gained  | Description only; adrenaline subsystem is absent.                                                                       |
| Stribog  | Stagger 30%                                      | Stored property and normal damage-condition path exist.                                                                 |
| Svarog   | Armor Piercing                                   | Existing AP consumer works once property is installed.                                                                  |
| Triglav  | Stun −1                                          | Stored `stun:-1, stunWeapon:true`; head/torso Stun consumer exists.                                                     |
| Veles    | Greater Focus                                    | Property exists; no ordinary STA discount implied by this rune. Coordinate the active Focus audit.                      |
| Zoria    | Freeze 30%                                       | Stored property and normal damage-condition path exist.                                                                 |

The five Core glyphs — Magic/mixed, Air, Earth, Fire, Water — allow a **per-casting choice** of **+3 spell DC or +1d6 spell damage**, only for the matching element. The sidebar says to choose when casting, not permanently when inscribing. Current glyph records have empty properties and installation only consumes the Item/slot and adds weight; the benefit is wholly missing.

The authoritative cast must record the selected glyph(s), source armor and chosen bonus. It must revalidate worn/carried source and element, apply DC benefits to the actual opposing defense/DC path, and add damage dice only where the spell actually has damage. Adding damage to a non-damaging spell is not printed. Mixed does not match every element. The text's sidebar says “magic” while its table says “spells”; signs/invocations coverage and multiple identical glyph stacking need a documented reading rather than invented restrictions or bonuses.

Rune/glyph installation currently also adds the stone's 0.5 weight to the target. Unlike p.90 physical enhancements, p.256 describes etching/crushing the stone and does not explicitly prescribe this resulting weapon/armor weight increase. Keep this distinction visible; do not extrapolate the armor-set weight rule as a universal magic-stone rule.

## 4. Tome glyphs and Runewright inscription

| Glyph, Tome p.110 | Normal                                                       | With Runewright’s Tools, p.120 | Price |
| ----------------- | ------------------------------------------------------------ | ------------------------------ | ----: |
| Binding           | Bleeding chance reduced by 30 percentage points while worn   | Reduction becomes 40 points    |   200 |
| Mending           | Whenever HP is regained while worn, regain one additional HP | Additional HP becomes two      |   450 |
| Reinforcement     | Armor SP +3                                                  | SP bonus +4                    |   100 |
| Warding           | Resistance to elemental-source damage, e.g. fire/lightning   | Also Resist Magic +1           |   300 |

These glyph Items do not yet exist. Weight is not printed on p.110. Binding must reduce the actual chance before rolling and must not be confused with Fiber's reduction of ongoing bleeding **damage**. Mending belongs in actual HP recovery paths (rest, medical/alchemical/magical healing and regeneration as applicable), respecting maximum HP and healing prohibitions. It is not a general REC or maximum-HP increase. Warding is a damage resistance, not complete immunity; preserve the usual no-duplicate-resistance rule and elemental-source distinction.

Tome p.120: using actual Runewright’s Tools and taking **half an hour** grants these inscription benefits:

| Stone                                   | Improved result                                                   |
| --------------------------------------- | ----------------------------------------------------------------- |
| Chemobog                                | Damage only on d6 1–2 (3–6 negate it).                            |
| Dazhbog, Devana, Morana, Stribog, Zoria | Printed chance becomes 40%.                                       |
| Perun                                   | Additional benefit: a spent adrenaline die rolling 1 is retained. |
| Svarog                                  | Improved Armor Piercing instead of ordinary AP.                   |
| Triglav                                 | Stun penalty increases by one, to −2.                             |
| Veles                                   | Also gains Focus (1); Greater Focus remains.                      |
| All five Core glyphs                    | DC choice rises to +4; the +1d6 damage option is unchanged.       |
| Four new glyphs                         | As in the preceding table.                                        |

There is no extra Crafting roll/DC in this half-hour paragraph. Record the actual inscription mode and time; merely owning tools or equipping the finished item does not automatically upgrade old stones. The book does not clearly specify retroactive re-etching of an already spent stone; require a visible table ruling if offered. This procedure is separate from the required tools and checks for word crafting.

## 5. Enchantment composition and crafting

Tome p.111: one runeword/glyphword per item; it blocks other runes/glyphs **even if unused capacity remains**. Lesser words occupy two slots, greater words three. Identical word benefits cannot apply repeatedly even across different items. Installed component stones can contribute; unrelated prior runes/glyphs are destroyed when the word is etched. Treating the word as replacing its components' individual benefits is consistent with the no-other-runes restriction, but the paragraph does not separately spell out this replacement. Record that interpretation rather than silently granting both sets of benefits.

Tome p.113: require the recipe, components and Runewright’s Tools. The Crafting attempt takes the printed hour. A failed attempt permits **one immediate recovery check at the same Crafting check**; success recovers **one** used rune/glyph, the others are lost. This differs from Core ordinary half-of-each-material recovery. Existing installed ingredients must not be consumed a second time or produce an extra loose stone on success.

| Word         | Slots / DC | Components; each ×1        | Investment / diagram price |
| ------------ | ---------- | -------------------------- | -------------------------: |
| Burning      | 2 / 15     | Chemobog, Dazhbog          |                1175 / 2150 |
| Placation    | 2 / 15     | Morana, Stribog            |                1075 / 2150 |
| Preservation | 2 / 15     | Devana, Morana             |                1150 / 2300 |
| Prolongation | 2 / 15     | Perun, Svarog              |                1175 / 2150 |
| Shearing     | 2 / 15     | Veles, Zoria               |                1150 / 2300 |
| Balance      | 2 / 15     | Mending, Reinforcement     |                 550 / 1100 |
| Beguilement  | 2 / 15     | Fire, Water                |                1150 / 2300 |
| Heft         | 2 / 15     | Mending, Reinforcement     |                 550 / 1100 |
| Rotation     | 2 / 15     | Binding, Reinforcement     |                  300 / 600 |
| Shining      | 2 / 15     | Air, Warding               |                 875 / 1750 |
| Deflection   | 3 / 21     | Chemobog, Perun, Stribog   |                1650 / 3300 |
| Depletion    | 3 / 21     | Stribog, Triglav, Veles    |                1675 / 3350 |
| Rejuvenation | 3 / 21     | Perun, Svarog, Triglav     |                1750 / 3500 |
| Protection   | 3 / 21     | Earth, Magic, Warding      |                1450 / 2900 |
| Retribution  | 3 / 21     | Earth, Fire, Reinforcement |                1250 / 2500 |

Glyph component names in this table abbreviate “Glyph of …”. All fifteen recipes take **one hour**. Preserve the printed prices, including Burning/Prolongation values that do not simply double their investment. Do not create new prices by arithmetic.

### Runeword effects, Tome p.111

| Word / allowed item             | Exact mechanic requiring a consumer                                                                                                                                                                                                                                                                                                                                |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Burning / weapon                | Optional fire damage type for this weapon; bypasses physical B/S/P resistance, still affected by fire immunity/resistance, does **not** ignite. Do not mark every such attack as a spell.                                                                                                                                                                          |
| Deflection / weapon             | Against ranged attack, weapon skill base −6; must beat original attack. Choose target within 10 m, who takes a defense action against that original parry total or becomes Staggered. If user has Parry Arrows ranks, instead grants that ability +2. Requires actual reaction budget, eligible ranged attack, secondary target/defense and idempotent resolution. |
| Depletion / weapon              | Spell/invocation cast **using this actual weapon as focus**: target who fails defense loses 1d6 STA in addition to spell effect. No signs/free generic worn bonus is stated. Need per-target fail receipt, exhaustion and no duplicate counter/upkeep triggering.                                                                                                  |
| Placation / weapon              | While carried, adrenaline costs 5 STA per die instead of 10. Requires complete optional adrenaline system.                                                                                                                                                                                                                                                         |
| Preservation / weapon or shield | Reliability +5, retaining existing wear rather than repairing it every equip/reload.                                                                                                                                                                                                                                                                               |
| Prolongation / weapon           | Spell/invocation cast through this focus with rolled duration: roll the **duration twice**, keep higher. Does not change a fixed/Active duration. Save original duration rolls; do not reroll on upkeep.                                                                                                                                                           |
| Rejuvenation / weapon           | When this weapon kills a creature, restore STA equal to wielder REC. HP≤0 is only Death State, not automatically a kill. Needs actual death attribution, max STA and a one-use kill receipt.                                                                                                                                                                       |
| Shearing / weapon               | On penetration, one additional SP damage to armor or REL damage to shields. Apply in proper armor/shield wear stage, not as HP damage or a generic weapon REL penalty.                                                                                                                                                                                             |

### Glyphword effects, Tome p.112

| Word / allowed item      | Exact mechanic requiring a consumer                                                                                                                                                                                                                               |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Balance / any armor      | EV reduced by one; define handling at EV0 without allowing a negative EV to become a stat bonus.                                                                                                                                                                  |
| Beguilement / head armor | Worn Charisma, Grooming and Style, Leadership +1.                                                                                                                                                                                                                 |
| Heft / any armor         | SP +2; EV doubled, and EV0 remains 0. Preserve location wear.                                                                                                                                                                                                     |
| Protection / torso armor | Worn HP +5. Needs consistent maximum/current HP policy that does not repeatedly heal through equip toggles.                                                                                                                                                       |
| Retribution / any armor  | When wearer takes attack damage, attacker takes 3 torso damage ignoring armor. No hit on fully absorbed attacks; needs source/receipt linkage, correct shield/HP handling and no endless reflection loop.                                                         |
| Rotation / leg armor     | Removes attacker bonus for being outside wearer's vision cone; does not remove defender's separate own-vision targeting penalties or every ambush bonus.                                                                                                          |
| Shining / torso armor    | An action activates 6 m daylight for 30 minutes, affecting weaknesses/susceptibilities to light **and sunlight**. Actual token light and source-aware restoration; sunlight-sensitive creature effects need real consumers rather than a decorative circle alone. |

## 6. Extra slots and Master Crafting

**Extra slot, Tome p.114:** target weapon or armor must have full current REL/SP, Crafting Tools, Meteorite ×4, Infused Dust ×2 and Enhancement Slot Diagram. Four hours, Crafting DC25; investment684, diagram1368. Maximum **three** slots. Added slots are restricted to runes/glyphs, not physical armor enhancements. Track native versus added slot capacities separately. Check **every covered location's** SP at completion; average/max SP is insufficient. Shield eligibility is not explicitly included here; Preservation's separate shield permission does not create a blanket slot-creation permission.

**Master Crafting, Core p.63/Errata:** unlocks master-grade crafting and permits an actual Master Crafting roll against target item's crafting DC to grant armor a chosen resistance or weapon Bleeding50% / Stun−2 according to damage type. It is a profession ability, not Crafting DC14 and not a consumed rune/slot. No extra cost or duration is specified for this improvement. Damage-type selection, existing equal/stronger properties and the actual item's diagram DC must be respected. The generic crafting path currently has no master-grade gate; diagrams also need reliable grade metadata.

Master Crafting and Runewright inscription are independent sources. A 30% Devanna must not reduce existing Master Crafting Bleeding50%, and Triglav−1 must not weaken existing Stun−2. Removing/replacing a rune cannot delete the ability bonus. Neither text grants infinite repeated stacking of the same permanent improvement. Multi-type weapon choice and repeated armor-resistance application need explicit source review/table decisions rather than a convenient repeated +bonus button.

## 7. Cross-system defects/invariants to resolve

1. **Authoritative transaction:** current `enhance` runs on the owner's local queue, calculates eligible targets before the dialog and does not revalidate target capacity after it. Its chat occurs after `commitActor`, outside rollback. Move resource-changing operations to registered GM commands; revalidate ownership, targets, tools, source quantities, actual time and current slots at commit; compensate final receipt failure.
2. **Do not overwrite unrelated base data:** current spread merge lets newly installed 30% poison/fire or Stun−1 overwrite stronger existing values. Keep immutable/source-aware base properties and separate attachment deltas. Typed provenance is also necessary when word etching destroys only selected prior sources.
3. **Current versus maximum durability:** all SP bonuses must preserve damage by location; REL bonuses preserve wear. Removal must clamp legal values without accidentally restoring lost armor. Required full-SP/REL checks use the effective current maximum.
4. **Capacity versus item count:** `attachments.length` only models one slot each. Words use2/3; added slots accept only magical stones; words forbid new stones even with spare capacity. Repair's +2 per attached rune/glyph/enhancement needs an explicit rule for composite words (one word versus its constituent stones is not clarified by Core140).
5. **Recovery semantics:** ordinary enhancement removal returns actual reusable parts; ordinary rune removal is forbidden; failed word crafting can recover only one chosen stone. Generic disassembly or quantity editing must not duplicate these sources.
6. **Coverage and gear state:** physical SP applies where the item covers. Worn glyph effects end when removed; carried Placation differs from wielded Deflection and selected-focus Depletion/Prolongation. Transfer to a new actor cannot leave stale bonuses on the old actor.
7. **Every relevant damage/recovery consumer:** Chemobog needs block/parry/damage/fumble/attack-on-weapon routes; Binding chance and Fiber damage are different; Mending must not reenter itself; Retribution cannot recursively reflect. Apply each rolled result once under retry/reconnect.
8. **No invented resource subsystem:** Perun/Placation cannot be called complete with only description text. Implement the optional Core175 pool (critical-hit gain, BODY cap, predeclared usage, damage/tempHP, emergency use, cost, combat-end cleanup) or explicitly keep those two benefits unavailable.
9. **Book ambiguities remain visible:** glyph stacking/applicability, set weight distribution, rune weight after etching, old inscription upgrades, words' repair count and enhancement failure's prior-source destruction timing are not all resolved by the supplied paragraphs. Record narrowly scoped decisions; do not silently invent a universal rule.
10. **Existing worlds need migration:** legacy attachment snapshots do not retain every overwritten base value. A verified original compendium source can help reconstruct the original item, but custom/mastercrafted values cannot safely be guessed. Preserve current state and flag a GM reconciliation when lost provenance prevents a reliable reconstruction.

## 8. Recommended implementation/check order after alchemy

1. Correct recipe links; introduce stable enhancement identities, source records, slot accounting and reversible effective stats.
2. Finish Core physical sets/partial use/removal and Core rune consumers; integrate the root Focus audit and per-cast elemental glyph choice.
3. Add four Tome glyphs and actual half-hour Runewright inscription, including source-aware durability/healing hooks.
4. Add all fifteen words/recipes and the extra-slot procedure with proper inventory/time/recovery semantics; implement their specialized combat/magic consumers.
5. Connect Master Crafting without erasing rune/native effects; finish optional adrenaline where needed, or clearly expose its unresolved dependency.
6. Verify through real registered-command tests: double-click/race, stale slots, source transfer, damaged multi-location armor, worn toggles, stronger native properties, ingredient alias resolution, nested failures/recovery, spell choice/counters, kill attribution, reflect-loop prevention and native Shining cleanup. Then build/read back compendia and perform Forge acceptance.

No implementation files were changed for this audit. No tests were added because this stage only records verified source requirements and current code/catalog gaps.
