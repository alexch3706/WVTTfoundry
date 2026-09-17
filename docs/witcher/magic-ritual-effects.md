# Ritual outcomes and persistent controls

Sources: Core v1.35 pp.117–119, 168 and 230; *A Tome of Chaos* v1.01 pp.102–104, 130–133 and 140–145. This module implements the outcome side of the actual preparation/component engine in `magic-procedures.js`. Tests use controlled document fixtures; they are not a live Foundry V14 test.

## Registration and contracts

- `registerRitualRegions()` runs at init and registers `witcher-rilerena.ritualArea`.
- `await registerRitualRuntime()` runs at ready. It merges the real crafted-artifact adapters and amulet sequence from `magic-gear.js`, registers procedure callbacks and persistent chat controls.
- `supportsRitualRuntime(key)` reports actual dependencies. A pure source plan alone never enables a ritual. Spell Jar remains disabled until **all five** possible spell outcomes are operational.
- Prepared results return `{plans, rolls?, execute}`. Planning does not spend resources or write documents. The procedure engine first applies planned actor/inventory changes, then executes world changes. Every executor provides compensation; a later failed receipt restores created documents and modified state.
- `tickRitualRegions()` is intentionally unserialized for use inside the elected GM's `witcher-authority` queue. Hooks enqueue it; they do not wait inside another authority operation.

## Outcomes

| Rituals | Executed result |
| --- | --- |
| Cleansing Ritual | Removes chosen actual alcohol/drug, poison/oil or illness sources; preserves overlapping sources and rejects plague. |
| Hydromancy, Pyromancy | Maintained source effect and private, actionable GM information decision. Present-time detection uses the recorded casting total. |
| Magical Message | Owned artifact Item with actual message, up to three triggers, duration and optional lifelike gemstone recipe; GM-confirmed trigger playback. |
| Ritual of Life | Native circle, one actual recipient, 3 HP each of ten rounds, capped healing, source expiry and termination on exit. |
| Ritual of Magic | First capable occupant must actively focus; one-use circle grants half Ritual Crafting rank rounded down for five hours. Alternative creates the exact rolled `1d6/2` Fifth Essence quantity. |
| Spell Jar | Owned expiring Item; saved genuine random outcome, explicit odd-half mapping convention, native target/area preview, ordinary defense/apply cards through `releaseStoredMagic`, and actual quantity consumption. All five dependencies must be available first. |
| Spirit Seance | Actual supplied specter profile instantiated for the deceased and all recorded nearby bloodline spirits; original memories represented by identity links. Opposed possession, original-total repeat saves, +5/+10 circumstances, source-specific release. An Uninvited Guest uses no blood and requires that spirit to be killed or banished to lift its hex. |
| Telecommunication | One-hour source effects; transmission only between actual active reciprocal partners, private chat to their owners and GMs. |
| Consecrate | Native circle up to 10 m; actual Resist Magic on both entry and exit; monster-magic boundary restriction and optional traditional silver/meteorite variant. Ordinary projectiles pass. |
| Magic Barrier | Native boundary plus attackable 50 HP object; blocked solid crossings, incorporeal/teleport exceptions, real 5 HP/STA repair, upkeep, air supply controls and source-specific suffocation. |
| Oneiromancy | Actual selected participants limited by Ritual Crafting, rolled duration and private GM revelation. Bonds and truthful answers are recorded campaign facts. |
| Artifact Compression | Actual Endurance15, 6d6 torso damage card on failure, compression only after that damage is applied, one-tenth token size, one-fifth HP, no-aging/unconscious source, limb checks/damage receipts, immediate death at zero HP, and real dismemberment wound Items on reversal. Release restores geometry and leaves Stunned. |
| Golem Crafting | Actual bestiary Actor and Token with permanent source links and literal-order constraints. |
| Interactive Illusion | Native 20 m radius; actual Resist Magic/Endurance12 followed by Stun save for a believed hazard; no HP damage. |
| Imbue Trophy, Create Crystal Skull, Wagerer's Pendant, Enchant Amulet | Delegated to tested real gear controls, charges, sources, expiry and the consecutive amulet casting sequence. |
| Tyromancy | Secret actual cheese-quality die; successful omen or correctly signed false answer through a private GM decision. |
| Animate Armor | Actual source-verified Living Armor profile using snapshots of the three specifically consumed armor pieces, including current SP and resistances. |
| Beacon of the Unnatural | Attackable 20 HP totem, actual selected monster attraction records, explicit campaign-year range and nesting adjudication. No invented AI travel time. |
| Fog of the Past | Timed private GM selection of the actual emotionally strongest local event; looping narrative projection. |
| Magical Guestbook | Native doorway curtain records visible token faces and times for 24 hours, range-limited alerts, persistent owned clay-icon archive readable with at least 1 Vigor. Does not reveal hidden Actor names. |
| Create Place of Power | Revalidates two actual same-element Ley Line Regions and the actual standing-stone contact Region; writes the existing `magicSource` format used by attunement. Records the world's month length. |
| Cadfan's Synthesis | Actual Corpse Amalgam from the verified profile; ten distinct dead actors, actual recent death times, consumed-corpse records and hidden former corpse tokens. The same corpses cannot be reused. |
| Create Soul Beacon | Attackable 10 HP object lasting a day. Only one nearby source may benefit a cast; overlapping different kinds require a selected source. Human/elderfolk and beast/monster bonuses are exported to casting workflows. |
| Hanmarvyn's Blue Dream | Real Endurance24 and immediate Death State on failure; the unconscious vision still proceeds, with timed source and actual corpse-memory decision. |
| Reanimate Corpse | Actual deceased actor, required organs, source-linked −3 Resist Coercion, immobility and three-STA/minute maintenance; ordinary resurrection is not claimed. Torture/Torment restrictions are exported. |
| Uncontrolled/Controlled Summoning | Actual GM-selected demon profile appears uncontrolled. Actual offerings, true-name evidence, mantle protection and immediate printed arrival consequences remain in an actionable private GM decision. |
| Ritual of Naming | Actual named-demon information decision; failed ritual creates the permanent source-specific Lucifuge mark. |
| Ritual of Binding | Actual named demon, native drawn cage for 24 hours, blocked attacks/movement except a real True Staff of Binding, recorded completed verbal agreement, secret Resist Magic against original total every fortnight and actual calling without another summoning ritual. |
| Ritual of the Goat Skin | Actual equipped mantle artifact; all three printed species protections, requiring the recorded fortnight of preparation. |

## Integration points

`useRitualArtifact(actor,item)` serves Message, Guestbook and Jar item use. `useCompressionRelease(actor)` opens the reversal control. `compressedDeathChanges(actor,nextHP)` must be consumed by damage/stabilization handling: a compressed creature at zero HP dies without stabilization. `ritualActionRestriction(actor,action)` handles immobility, corpse torture/torment and trapped-demon attacks. `ritualTargetingBlock(source,target,{magic,solidEffect,teleport,weapon})` handles circle/barrier/cage attacks, including a line crossing a barrier with both endpoints outside.

`ritualNecromancyBonuses(actor,casterToken)` returns trusted current Gateway/Soul Beacon benefits. Procedure checks consume these directly; ordinary necromantic spell casting must use the same helper. Gateway's initial 1/2/3 triggers the separate Restless Spirits roll; 2/3 do not become an ordinary fumble. Creature creation snapshots a beast-beacon bonus onto the created creature.

## Special mishaps and GM decisions

Necromantic fumbles deal their actual severity in HP in addition to already-accounted overdraw, use the separate cumulative Restless Spirits table and never receive elemental backlash. Gateway is timed; Wraiths are real hostile creatures; Uninvited Guest applies an actual selected hex with its special removal rule. Haunting records its actual area and unresolved wrong, spawns actual creatures and exposes a GM campaign-night control. Penitent requires an actual printed creature profile. Create Place of Power creates actual 7d6 damage cards within six metres and destroys the recorded source stone.

The books leave some values or campaign facts unspecified. The UI records those decisions explicitly: unspecified circle radius, Spell Jar odd-half mapping and opposition total, HP conversion on reversing compression, specter/demon profile selection when not otherwise defined, world calendar dates and narrative knowledge/events. These are not fabricated automatic successes. Pending GM decisions remain visibly pending in source-linked cards.

## Verification

`node --test tests/witcher/magic-ritual-effects.test.mjs tests/witcher/magic-procedures.test.mjs` covers source coverage/readiness, actual recipe consumption and rollback, costs/fumbles/hex lifting, native movement pause fixtures, barrier crossings, special mishaps, source preservation, no-stacking Soul Beacons, compression fatality and Blue Dream's failure consequence. Additional creature/gear/zone/lifecycle test files verify their shared executors. Public V14 Region and Token movement APIs were checked against the actual V14 client source; a Forge/manual smoke test is still required.
