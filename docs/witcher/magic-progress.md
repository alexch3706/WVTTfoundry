# Magic implementation status

Alpha.7 adds held/worn Focus and Greater Focus, per-cast glyph bonuses, Depletion/Prolongation and social trophy consumers. See [the new feature guide](alpha7-play-guide.md). The casting coverage counts below are unchanged.

Release candidate **0.1.0-alpha.6**, audited **2026-09-17**. Scope: Core v1.35, supplied Errata, and _A Tome of Chaos_ v1.01; Foundry V14/The Forge. This records implementation coverage, not a claim that every magic entry is automated.

## Catalog, plans and casting are separate

| Layer                                      | Current inventory | What it establishes                                                                                                                                     |
| ------------------------------------------ | ----------------: | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Magic reference Items                      |               238 | 12 signs, 119 spells, 61 invocations, 34 rituals and 12 hexes, with source metadata.                                                                    |
| Spell/invocation plans and targeting       |               180 | Every spell/invocation has an individual plan and targeting profile. A plan can still require an unimplemented executor.                                |
| Enabled sign/spell/invocation entry points |                66 | 12 signs, 34 spells and 20 invocations are listed by `IMPLEMENTED_MAGIC`. Each actual choice still passes authoritative preflight.                      |
| Remaining spell/invocation references      |               126 | Their text/plans exist; ordinary automated casting remains disabled.                                                                                    |
| Ritual recipes                             |                34 | Separate preparation, components and outcomes; availability depends on registered adapters, special mishaps and stored-spell dependencies.              |
| Hex procedures                             |                12 | Casting, identification and source-specific lifting exist; contextual events and campaign facts can require explicit GM resolution.                     |
| Ritual-artifact reference Items            |                45 | Four skulls, 33 trophies, one pendant, four amulet configurations and three material/tool entries. This is not all magical equipment in the supplement. |

`magic-support.js` supplies 52 ordinary spell/invocation keys; `magic-state.js` adds Dispel, Magic Healing and 12 signs. The authoritative lists can change after this checkpoint. A supported entry can still be waiting for a defense, damage application, world-time deadline or recorded GM decision.

The builders produce five magic packs plus a separate artifact pack. Counts alone do not establish current release packaging, LevelDB readback or live-world behavior.

## Enabled inventory

### Signs — 12

Yrden, Quen, Aard, Igni, Axii, Magic Trap, Active Shield, Aard Sweep, Fire Stream, Puppet, Somne and Supirre.

These use actual checks, costs, fumbles, defenses and source effects. Quen applies before armor; Active Shield has shared protection, upkeep and collapse controls. Yrden follows occupants; Magic Trap has preparation and attack controls. Puppet, Somne, Axii and healing have repeated checks or source-aware end conditions. See [rules](magic-rules-audit.md), [Regions](magic-regions.md) and [continuing effects](magic-ongoing.md).

### Spells — 34

| Group                                      | Enabled entries                                                                                                                                                           |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Checks, information, modifiers and objects | Blinding Dust; Dispel; Glamour; Magic Compass; Codi Bywyd; Diagnostic Spell; Luthien’s Quill; Blemish; Detect Ley Line; Light Feet; Disrupt Focus; Empower.               |
| Immediate attacks                          | Cenlly Graig; Earthen Spike; Korath’s Breath; Aenye; Brand of Fire; Magic Flare; Tanio Ilchar; Wave of Fire; Carys’ Hail; Anialwch; Waves of the Naglfar; Breath of Fire. |
| Healing, restraint and movement            | Magic Healing; Talfryn’s Prison; Adenydd; Zephyr.                                                                                                                         |
| Persistent areas and attacks               | Static Storm; Dormyn’s Fog; Suffocate; Merigold’s Hailstorm; Lightning Storm; Melgar’s Fire.                                                                              |

Talfryn creates an actual attackable 15 HP roots object and escape check. Adenydd has a real glide/landing procedure. Zephyr uses native collision checks, token displacement and a separate ramming ruling/damage card. Dormyn limits native vision and restores each source when it ends. A general move/zone helper does not enable every movement/area spell. See [restraints](magic-restraints.md) and [wind/fog](magic-wind-fog.md).

### Invocations — 20

Cursed Illness; Nature’s Gift; Nature’s Sight; Blessing of Healing; Primal Reservoir; Threads of Life; Blessing of Fortune; Blessing of Love; Holy Light; Vaults of Knowledge; Web of Lies; Cleansing Fire; Divine Wisdom; Healing Rest; Blessed Weapon; Light of Penance; Presence of the Divine; Brand of Withering; Miracle of Lebioda; Voice of the Counselor.

Healing Rest depends on completed, uninterrupted rest and preserves permanent injury penalties. Miracle of Lebioda uses wound/anatomy restoration. Blessing of Healing has separate ordinary-HP and critical-treatment modes.

## Connected systems and boundaries

| System           | Connected behavior                                                                                                                                                                    | Limits                                                                                                                                                                                                                                        |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Casting          | Manual/exploding d10, opposed defenses, action/STA/Vigor, Focus, overdraw, fumbles, counters, upkeep, duration and compensation.                                                      | A generic cast cannot replace an unsupported entry-specific effect.                                                                                                                                                                           |
| Native areas     | V14 previews, placement, containment/walls, ongoing attacks, entry/turn events and source cleanup.                                                                                    | Unspecified geometry requires a table convention; native checks require the actual viewed scene/level.                                                                                                                                        |
| Rituals          | Preparation, helpers, interruptions, actual inventory, outcome adapters, private GM decisions and persistent controls.                                                                | Availability must be checked after registration. Profiles, source objects and narrative facts can remain required. See [outcomes](magic-ritual-effects.md).                                                                                   |
| Hexes            | Source-linked casting/identification/lifting; fumble changes, penalties, Nightmare/Unending Need rest, Bones of Glass and Forgetfulness.                                              | Contextual disease/animal/intoxicant/hallucination events and story conditions use explicit GM controls when the world cannot provide the fact. They are not all inferred automatically from movement. See [procedures](magic-procedures.md). |
| Learning         | Actual IP, checks, elapsed study, failure extensions, known-magic Items and restricted advancement.                                                                                   | Teacher/tome availability, birth eligibility and unmapped tiers require GM facts/rulings. See [learning](magic-learning.md).                                                                                                                  |
| Power sources    | Actual drawn sources/contact, attunement/extraction, history, elemental benefits, additional Ley consequences, Air grants/replacement and Fire recast jobs.                           | Replacement requires implemented eligible spells. Missing targets, insufficient STA or undefined level mapping remain pending. See [Ley runtime](magic-ley-runtime.md).                                                                       |
| Artifacts        | Actual skull creatures/recharge; pendant suppression/burst; amulet grants, drawbacks, costs and sequential crafting.                                                                  | Actual acquired artifacts require GM setup; amulet creation uses its dedicated sequence. See [artifact audit](magic-gear-audit.md).                                                                                                           |
| Trophies         | Kill eligibility, worn/contact/one-active rules, skill effects and installed combat hooks for immunity/resistance, ignition, ablation, critical choice, damage, grapple and throwing. | Some special social/world/optional-action rules still lack consumers. `TROPHY_INSTALLED_HOOKS`/`trophySupport`, not profile presence, determine support.                                                                                      |
| Dark-art rituals | Special mishaps, actual hostile creatures, Soul Beacons, compression, source-verified Living Armor/Corpse Amalgam and demon/specter controls.                                         | Campaign facts, bargains, unspecified profiles and some outcomes remain GM decisions. This does not enable every dark-art spell or all creature abilities.                                                                                    |

All five Spell Jar dependencies are now enabled. Actual release still uses the selected spell’s target/defense/apply workflow and the recorded odd-half convention. Enchant Amulet is available through its dedicated sequential crafting handler; its availability gate recognizes that handler. Ordinary weapon attacks interrupt an active imbuement sequence in the same transaction as the attack, with compensation if persistence fails.

## Remaining work

1. **126 spells/invocations:** portals/teleportation, polymorphism, most advanced terrain manipulation, many special equipment spells and both necromantic spells remain disabled. Existing plans/helpers are not completed casting workflows.
2. **14 magical Gifts:** a separate Tome feature, absent from the 238-entry catalog. Gifted laypeople are barred from ordinary magic, but their own Gifts still need implementation.
3. **Remaining trophies and broader magical equipment:** 45 artifact records do not complete the equipment chapter.
4. **End-to-end verification of each promoted entry:** choices, saves, expiry, counters, source loss, removal and failed persistence must work together. Capability flags alone do not establish full ritual/summon behavior.
5. **Live V14/The Forge acceptance:** check real vision, movement, shared shields, regions and reconnect. No running Forge world is accessible here. Automated packaging/model/rendering checks are recorded below.

## Visible source decisions

- Aard: literal base 10% plus 10% per STA; Aard Sweep: 10% per STA.
- Unprinted cone angles remain table conventions. Somne/Supirre element requires an explicit ruling when needed for backlash.
- Fire Stream upkeep retains half-STA fractions; Core p.48 rounding addresses derived statistics.
- Fully absorbed Quen damage causing no critical wound is a documented shield-first interpretation.
- Zephyr caster inclusion, stationary/following fog, ramming base/weight/location, Spell Jar odd-half mapping, amulet maintenance timing and compression reversal HP remain explicit choices.

## Verification evidence

The tests include pure rules and actual registered-command/document workflows with persistence failures. Actual Foundry v14.365 client code has been checked for Region, Token and model contracts. Controlled document/roll fixtures do not constitute a live Foundry world.

Use current `npm test`, `build:magic`, `build:packs`, `validate`, genuine-client model validation and package readback results for release claims. Earlier passing counts/screenshots do not validate a later working tree. Obtain publication/version status from the manifest and release history.

Alpha.6 validation: **662 tests passed**; all 18 compendiums compiled and read back; genuine V14.365 data-model validation preserved **36 Actors and 1369 Items**. Real actor/item sheet context and templates were rendered in Chromium at 600/700/1000 px without horizontal overflow. This browser check used controlled documents and is not a live Foundry session.
