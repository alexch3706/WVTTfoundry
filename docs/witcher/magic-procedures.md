# Ritual and hex procedures

Sources: Core Rulebook v1.35 pp.120–121 and 168; A Tome of Chaos v1.01 pp.105–106 and each ritual entry. Tests use controlled document fixtures, not a running Foundry server.

## Runtime contract

`registerMagicProcedures({supportsRitual, planRitualResult, planSpecialMishap, planHexResult?})` registers authoritative commands. Result callbacks return `{plans:[{actor,changes,items?}], rolls?, execute?}` (legacy arrays remain accepted). Planning must not mutate documents. `execute()` returns a real world result with a `rollback()` method; world operations are compensated in reverse order if any later write fails. The engine compensates actor/resource/inventory changes if a later write fails. Callback context includes `actorState` and `targetState` projected after spending and exhaustion; use these states when adding effects so an outcome cannot overwrite resource consequences. `choices` includes Tyromancy’s secret d6; `dc` contains the final helper/source-adjusted difficulty. The trusted `castingAdjustments` callback also adjusts actual STA/checks and supplies Gateway repeat triggers. `componentRequirements`, `prepareEntry`, `procedureFields` and `procedureChoices` support real alternate recipes and required actual object selection. `dedicatedProcedure` handles the amulet sequence.

`castProcedure(actor,item)` opens the preparation/material UI; `registerMagicProcedureChat()` wires its persistent chat controls. `manageHex(actor,effectId)` opens identification and GM-confirmed lifting. Route ritual/hex entry separately from immediate spell casting. `activeRitualPreparation(game.messages,actor.uuid)` supports guards against conflicting actions during preparation. Apply damage/distraction/removal interruptions from the relevant action workflows; a world-time change alone cannot detect an interruption.

## Implemented procedure rules

- Actual world-time preparation: three seconds per printed round. No completion before its clock elapses; one active preparation per caster.
- Up to four different, able-bodied helpers, each reducing the final DC by one. Helpers do not reduce interruption DCs. A player must own submitted helper actors; a GM can assemble a group across ownership boundaries.
- Distraction DC15, physical harm DC18, and removal/return within one round at DC16. Time away pauses preparation. Failed or late return ends preparation. Ending preparation before the final attempt spends no casting STA or components; the book specifies expenditure on a completed failed attempt and does not separately price an interrupted preparation.
- Actual inventory quantities are revalidated and consumed at completion, even when the ritual check fails. Counted materials are consumed; explicitly reusable tools are retained. Uncounted environmental prerequisites require a description of the actual prerequisite. A GM must record substitutions. The result does not create missing materials.
- Ritual Crafting and Hex Weaving use real checks and support manual d10 input. Fixed/variable ritual DCs come from the catalog. Tyromancy’s variable difficulty and result remain GM-only.
- Ritual fumbles deal damage equal to STA spent; hex fumbles instead roll the printed 50% chance of applying the hex to its caster. Costs, available Vigor, held focus, explicit overdraw and exhaustion are checked before mutation. Zero-STA goetic rituals do not invent a Vigor requirement.
- Necromancy and Create Place of Power require their separate mishap handler. Enchant Amulet requires its separate stored-spell casting sequence and is blocked by this generic procedure. A missing ritual outcome handler prevents preparation and spending, rather than issuing a fake successful outcome.

The source does not establish one universal hex opposition DC, defense or range. The GM must record the actual opposition and ruling before a hex is woven. This is a visible table adjudication, not an invented universal Resist Magic rule.

## Hex sources and lifting

Hex effects retain source caster, cast identifier, casting total, book/page and the printed effect text. `hexCheckRules` exposes context-sensitive penalties, altered fumble faces, Evil Eye double fumbles, the learning prohibition and social-standing adjustment for integration with checks and learning. These returned rules require their consuming workflows; creating the effect alone does not automate every narrative consequence.

Identification uses Education DC16/20/26 or Witcher Training DC14/18/22. Successful identification is recorded on that source. Lifting requires a GM to record the actually fulfilled printed procedure, including calendar and narrative conditions. Counted consumed supplies are deducted from real inventory, retained materials remain, and a previously completed Fine Arts check must beat DC14 where printed. The GM records uncounted supplies and preceding story events rather than the system claiming to have observed them. Only the selected source effect is removed, preserving overlapping sources.

Lifting Forgetfulness transforms the single used Optima Matter into Focus2, with `flags['witcher-rilerena'].focusKinds = ['hex','goetia','necromancy']`. All focus-consuming workflows must honor those restrictions. The procedure requires a separate one-item stack before transformation. The procedure engine enforces this restriction for its own focus use.

## Verification

`node --test tests/witcher/magic-procedures.test.mjs` covers preparation, stale inventory, helpers and DCs, interruption/return, irreversible-looking result receipt failures with compensation, ritual/hex fumbles, exhaustion, zero-cost goetia, identification, source-specific lifting, retained/transformed focus and missing-handler rejection.

Forgetfulness is checked both before beginning and before completing a procedure. An Uninvited Guest hex explicitly rejects ordinary lifting: it requires its blood-free Seance and the actual spirit’s defeat or banishment.
