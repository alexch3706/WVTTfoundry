# Ritual artifacts: source and execution contracts

Sources: user-supplied _A Tome of Chaos_ v1.01, printed pages 102–104,
117–120, 123–125. These modules cover four artifact families, not all magical
equipment in the supplement. The 14 magical Gifts are a separate feature.

## Entry points

- `registerMagicGear()` registers authoritative commands and document/time hooks.
- `magicGearDisplay(item)` supplies item-sheet controls. Render `canConfigure`,
  `canActivate`, `canCommand`, `canRetrieve`, `canAttune`, `canBurst`; call
  `magicGearAction(actor,item,'configure'|'activate'|'command'|'retrieve'|'trophy'|'burst'|'cast',key)`.
- `createMagicGearAdapters()`, `magicGearProcedureFields/Choices`,
  `prepareMagicGearEntry`, `magicGearComponentRequirements` plug into the ritual
  engine. The ritual agent already wires these exports.
- `beginAmuletImbuement({actor,item})` is the dedicated Enchant Amulet entry.
- `amuletImbuementInterruption(actor,reason)` returns a patch to merge into the
  same transaction as another action during actual imbuement. Root must call it
  from action consumers. It does not mutate actor state by itself.
- `trophyBenefits(items,actorUuid,context)` supplies special trophy rules to
  combat/derived consumers. `trophySupport(species,installedHooks)` is strict:
  only installed rule keys count as implemented.

## Crystal Skull

Creates a real Actor and linked Token using Cat, Dog, Bird or Serpent from the
actual bestiary. Mental commands require the creator's actual token within 50m.
Death (the `dead` condition, not merely zero HP) replaces the token with an inert
skull map marker. Retrieval checks the real scene, level and distance. Recharging
retains that exact skull and consumes two Fifth Essence. It preserves the original
animal Actor identity. No invented voluntary recall/reversion action is provided.

New creation uses Core ritual preparation, components and DC from the catalog.
Recharge selects its mode before the component dialog, so it never asks for five
essence or a fresh animal skull. Created actors/tokens/items carry inverse
operations for rollback if later persistence fails.

## Trophies

All 33 printed profiles are present. An actual nonenchanted single trophy must
come from an adult monster. The GM records the actors who helped kill it. Only
an eligible actor in physical contact (carried and equipped) receives a benefit.
Only one is active; switching requires one hour of meditation. First attunement
has no invented one-hour requirement. Each carried trophy contributes one
monster-slayer Reputation, capped at four (returned by `trophyBenefits`).

The skill modifiers for Werewolf, Foglet, Grave Hag and Fiend are actual actor
effects. Special combat/social/world rules are structured in the profiles and
remain pending until root installs their specific consumer hooks. Storing a
profile or a descriptive flag does not make these special rules automated.

## Wagerer's Pendant

Suppresses hex sources while worn, preserving source ownership of conditions and
restoring them on removal/expiry. It does not cure the hex. After one week, a
hexed wearer causes a burst; the GM selects the actual hexes. One unambiguous
wearer token freezes the nearby targets at expiry, so later token movement does
not redirect the burst. If the actor has multiple/no scene instances at expiry,
the GM must identify the actual bearer instance before resolving map targets.
An unworn pendant expires without inventing an off-body wearer/burst.

## Enchanted Amulet

An acquired item is configured by the GM with its actual 1–4 spells/invocations
and one drawback when it contains multiple spells. It then creates real embedded
magic items, each flagged `magicAmulet:{amuletId,key}`. The actual source artifact
has `ritualArtifact:{key:'enchant-amulet',complete:true,storedMagic,drawback}`.
It supplies Focus 2 while worn; no charges, hand occupation or free STA are
invented. `amuletCastPermission` rechecks the real worn source, stored key,
dimeritium and sufficient Vigor. The casting engine must consume this helper.

Drawbacks are real actor effects: max HP −5, INT/WILL/REF −1, or max STA −10.
They persist while worn and until 24 hours after removal. Repeated synchronization
does not keep extending the expiry.

Crafting performs 15 rounds of preparation, actual learned spell casts at full
STA without Focus, component consumption, and an actual DC18 Ritual Crafting
check. Only after all successful casts/payments/checks does the artifact and its
granted magic exist. Spell fumbles have real costs/HP/elemental effects; ritual
fumbles deal HP equal to actual ritual STA expenditure. Other intervening
actions fail imbuement when the root action consumer merges the interruption
patch. Casting receipts carry versions to reject duplicate/stale commands.

The book requires four maintenance payments for active spells but does not define
their Vigor timing. Maintained-spell crafting therefore requires a recorded GM
choice: pay them together with ordinary aggregated Vigor, or pay on four actual
upkeep rounds with each round's ordinary Vigor. This is explicitly a table ruling,
not an asserted additional book rule. Nonmaintained spells need no such choice.

## Compendium data and validation

`node tools/witcher/build-magic-gear.mjs` deterministically writes 45 records:
four skulls, 33 trophies, one pendant, four amulet configurations, and three
necessary material/tool entries. Unspecified weights/prices are explicitly flagged
instead of invented. Imported trophies/amulets/pendants require actual GM setup;
their configuration control is backed by an authoritative command.

`tests/witcher/magic-gear.test.mjs` runs pure rules and actual registered commands
against controlled document persistence, including rollback, stale versions,
real inventory debit, world actor/token creation, distance, death/retrieval,
drawback timing and burst target snapshots. These are not claims of live Forge
or native Foundry browser validation.
