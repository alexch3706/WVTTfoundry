# Witcher V14 implementation status

Release candidate: **0.1.0-alpha.4**. This ledger distinguishes implemented code
from live acceptance. No Foundry server has been launched in this environment;
the owner will test the installable release on The Forge.

## Agreed scope for this release

The owner narrowed the current work to ordinary combat and equipment:

- PC, NPC and monster sheets; inventory and compendium drag/drop; equipping,
  usable hands, ammunition and crossbow loading.
- Fast/strong player attacks, normal creature attacks with their printed ROF,
  extra actions and defenses with persisted STA and Luck.
- Dodge, Reposition, weapon/shield Block, unarmed Block and Parry. Defense uses
  the appropriate skill and statistic; weapon accuracy modifies attacks only.
- Real exploding/fumbling d10 rolls, damage dice, armor layering/wear, hit
  locations, critical wounds, saves and explicit GM damage application.
- Natural attacks, ordinary-weapon resistance, silver and meteorite exceptions,
  physical immunity and printed monster weak armor locations.
- Core equipment and bestiary, plus all equipment in A Witcher’s Tools and the
  components/mutagens in A Witcher’s Journal.

Magic/signs, mounted combat, active creature and profession abilities are
**deferred by the owner**. Advanced maneuvers, area/scatter bombs and contextual
potion/decoction automation have incomplete paths inherited from the first
implementation pass; they are not claims of completed ordinary combat and are
not the primary attack controls. Critical Flurry's Disarm/Trip and school armor
follow-up strikes are included because they are equipment effects.

## Bestiary portraits and tokens in alpha.4

All 36 bestiary Actors have portraits and round map tokens: 28 book-art entries
and 8 generated originals following a review of all six supplied books. Related
variants share art where no separate illustration exists. Sources and generation
prompts are documented in `art-sources.md` and the art manifest.

The elected GM updates recognized imported Actors and placed tokens, including
inactive scenes, only where they still use default images. Custom portraits and
token art are preserved independently. Renamed imports are matched by source
UUID; older imports require book/page markers and an exact name. Unlinked token
portrait inheritance is repaired without changing combat data. Failed writes
remain retryable through `game.witcher.updateBestiaryArt()` or a world restart.

## Manual combat dice in alpha.3

Attack and defense dialogs, including quick defenses, offer an optional **Manual d10**
field. Blank uses automatic dice. Enter the complete comma-separated sequence, such
as `7`, `10,10,6` or `1,10,4`; Core p.57 critical/fumble math is shared with automatic
checks. Stats, skills, situational modifiers, Luck and resource expenditure still
use the ordinary combat workflow. Chat and saved check flags identify manual input.

Invalid or incomplete input keeps the dialog open. GM command handlers validate
the sequence again before spending resources. Passive DC rejects dice; damage,
hit-location, critical-table and save dice remain automatic. No data migration is
needed. General skill-check dialogs are outside this change.

## Armor display in alpha.2

Armor item sheets show current/max SP prominently above Inventory and Characteristics.
The Equipment tab shows the same values per item/location; Hit locations shows
total current/max protection from the equipped layers and natural armor. Zero
current SP remains zero, and custom/monster coverage is not hidden on source items.
These views read existing saved wear; this release does not change damage rules.

## Implemented behavior

- Own V14 TypeDataModels and V1 sheets. No third-party Witcher runtime is used.
  Two general compatibility helpers come from the owner's Cyberpunk repository;
  its original history is retained at `cyberpunk-v14-base`.
- One elected active GM handles ordinary attack, defense, damage, inventory,
  recovery/reload and fumble commands. Persistent requests use the authenticated
  ChatMessage author. Permissions, current documents and turn identity are
  checked again after dialogs close.
- A remaining fast/ROF strike cannot bypass turn, condition or resource checks.
  Each creature selects one attack per round; extra STA does not reset its ROF.
- Attack and defense spending is rolled back if creating their result card
  fails. Defense claims and actor-side damage/wear receipts reject duplicate
  submissions. Pending post-damage saves/reactions can resume without applying
  HP/STA damage twice. This is compensation across documents, not a database
  transaction: a failed rollback is reported to the GM for inspection.
- Damage cards recalculate from their existing damage dice when armor/resources
  change before application. New immunity also suppresses wounds/conditions.
- All 24 core critical wound records, treatment states, recovery, death saves,
  automatic recurring conditions and passive creature regeneration are present.
- Tools armor provides critical-tier adjustment and immediate, once-consumed
  reaction choices. Manticore shield knockback moves the actual target token up
  to 4 m, stopping at walls/scene bounds, and applies prone. Griffin's Sign
  reaction is explicitly manual until signs are implemented.
- **809 catalog Items**: 673 core + 46 Tools + 90 Journal, across ten Item packs.
  **36 core bestiary Actors**, with **253 embedded Items**, in the eleventh pack.
  See `bestiary.md` and `supplements.md` for source coverage and adaptations.
- Real LevelDB packs are built with Foundry's official CLI, extracted back and
  compared to the source records, including all embedded Item system fields.
- The installable ZIP includes the Witcher runtime, its two compatibility
  helpers and actual compendiums. Cyberpunk runtime, PDFs and extraction inputs
  are excluded. The original Cyberpunk working directory is unchanged.

## Validation and remaining acceptance

**181 automated tests pass.** Tests cover art provenance, packaged asset references,
default-image migration, custom image preservation, retry safety, manual attack/defense entry and validation,
book examples, imported creature attacks and school gear,
turn/STA accounting, persistence failure recovery and package contents. Syntax,
module imports and Handlebars compilation are checked. A separate check uses the
genuine public Foundry V14.365 data layer: **36 Actors and 1062 Items** preserve
all supplied fields during model cleaning.

All 36 portraits and 36 token images decode and render to canvas in Chromium;
round tokens have transparent corners. The entire gallery was visually reviewed.
This checks browser rendering, not a running Foundry canvas or Forge asset hosting.

These are automated checks, including explicitly controlled document fixtures.
They do **not** establish that sheets, canvas movement or multiplayer sessions
work in an actual Foundry installation. The required live run is recorded in
`forge-checklist.md`; it is still pending. The first release is therefore an
installable **alpha**, not a claim that every non-magic rule in the books is
finished.

## Source interpretations and omissions

- Core v1.35 printed p.151: one grid square is 2 m, one round is 3 seconds.
  New scenes default to metres; imported/existing scenes need their scale checked.
- p.151: normal attacks do not themselves cost STA; an extra action costs 3 STA
  and applies −3. First defense in a round is free, later defenses cost 1 STA;
  Actively Dodge prevents defense STA drain.
- Creature ROF: [official Sage's Answers, part 5](https://rtalsoriangames.com/2018/08/20/the-sages-answers-part-5/).
  The creature chooses one listed attack per round.
- p.153: an ambush bonus lasts the first round against unaware targets. The GM
  establishes awareness/ambush, cover and other situational modifiers.
- Death State uses HP <= 0, reconciling p.153's total-damage wording with p.162.
- Armor stacking uses Witcher p.155 (3 + 12 + 20 = 24), not Cyberpunk thresholds.
  Improved AP uses floor(SP/2); the supplied text does not resolve odd-SP rounding.
  Armor resistance is retained at SP 0 because the source does not say broken
  armor loses it and p.90 explicitly preserves enhancements on broken armor.
- Anatomy uses the printed humanoid/non-humanoid tables. Species-specific
  probabilities absent from the book are not invented; custom anatomy is editable.
- Elven Shield Diagram requires **Etching Oil**, absent from the supplied
  component tables. Tools diagrams similarly require **Ruby Dust** and
  **Emerald Dust**. Requirements remain visible and unresolved; there are no
  invented prices or silent ingredient substitutions.
- Unprinted supplement prices/weights are flagged in item source notes. Zero
  numeric defaults must not be interpreted as a published free/weightless item.
- Tools gives no critical tier above Deadly. Ursine armor reports that boundary
  and leaves any additional ruling to the GM.
- Journal p.12 permits natural-weapon blocks and applies Reliability wear, but
  Core gives no numeric natural-weapon REL. Core imports use maximum REL 0 to
  mark it as unspecified. Attacks and parries work; blocking/wear require the
  GM to set current/maximum REL. A configured weapon at REL 0 is unusable;
  Regeneration restores 1 REL per day of rest. No default REL is invented.
- Armed-defense fumble 7 tells the defender to drop the weapon. Neither supplied
  book defines how an attached claw/tail can be dropped. The system requests and
  records a GM ruling for that case instead of deleting or dropping the limb.
- Reposition permits a player-selected unobstructed destination; its allowed
  movement is shown in the defense card. The player moves their token.

PDFs and the full image audit remain private in `/root/witcher-reference`.
Selected bestiary illustrations are included in the system assets; see their
provenance and attribution in `art-sources.md`.
