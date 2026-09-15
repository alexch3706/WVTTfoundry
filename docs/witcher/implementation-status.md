# Witcher V14 implementation status

This is an implementation ledger, not a declaration of readiness.

Source: user-supplied Core Rulebook v1.35. References use printed page numbers.
The independent repository retains the Cyberpunk V14 history at `cyberpunk-v14-base`.
No runtime code from another Witcher system is included.

## Required completion gates

- Character/NPC/monster data and working sheets, item drag/drop, unlinked tokens.
- Rules engine and real attack/defense/damage workflow with persisted resources.
- Humanoid, monster and custom target anatomy; location-specific armor and damage.
- Complete core equipment, ammunition, armor, shields, alchemy, components, diagrams and Witcher equipment compendia.
- Critical wounds and treatment, effects, saves, healing, action economy.
- Combat exceptions: grappling, special attacks, ranged combat, cover, bombs/traps and environment.
- Complete core-book bestiary, including printed variants and animals, as an Actor compendium.
- Skills, races, professions and progression needed by sheets and non-magic combat.
- Automated book examples and boundary cases, package/schema/compendium validation.
- Installable GitHub release and Forge acceptance checklist. User performs live Forge checks.

Spells, signs, rituals and hex automation are deferred by the user.
Mounted combat is explicitly deprioritized; its incomplete implementation is
outside the current completion gates.

## Known textual ambiguities to resolve explicitly

- Death State: p.153 describes reaching the HP total, while p.162 says below zero. Current implementation uses HP <= 0; this decision must be visible in the conformance notes.
- Armor layering must use the p.155 worked example (3 + 12 + 20 = 24), including its table boundaries. Do not inherit Cyberpunk's thresholds.

## Current work

The following is implemented locally, but is not a release-readiness declaration:

- Own TypeDataModels for PCs, NPCs, monsters and thirteen item types.
- Own V1 sheets using the Cyberpunk V14 token-render compatibility fix.
- Attack/defense chat workflow, GM damage application, stale-armor recalculation,
  armor wear, critical wounds, resource persistence and duplicate-apply guard.
- All 24 core critical wounds represented with untreated/stabilized/treated data.
- Crafting/alchemy allocation, recovery, repair, item use and recurring effects.
- 673 catalog entries extracted from the supplied v1.35 PDF, including graphical
  alchemy ingredients. Eight real LevelDB packs built with the official Foundry
  CLI and independently extracted back; each stored system object compared.
- 36 core bestiary Actors with 253 embedded attacks, abilities and equipment
  records. Printed variants, eight animals and three named adventure NPCs are
  included. A ninth real LevelDB pack is built and every embedded Item checked
  after reading it back. See `bestiary.md` for coverage and remaining automation.
- Creature immunities, Feral INT, regeneration, weak armor, unlimited Golem STA,
  Shift defense and selected ability actions connect to the rules engine.
- Fumble application workflow, natural attack damage, effect display, token
  condition synchronization, potion/oil and environment handling have advanced;
  their live and concurrent-operation review remains open.
- 50 pure rules/catalog tests pass. Manifest/import/syntax/template checks pass.
- Genuine public Foundry V14.365 fields accept 36 Actors and 926 Item records
  (673 catalog + 253 embedded), preserving supplied fields recursively. This
  does not launch Foundry or certify sheets/multiplayer behavior.

## Open implementation and review gates

These must be addressed before claiming the requested nonmagic system is complete.

- Review fumble application, self/ally hits, jams, dropped equipment, natural
  weapons and interruption/retry behavior in actual Foundry.
- Dual wielding, charge push/contest, fast draw, tie-breaking initiative,
  fall/environment hazards and human-shield cover. Mounted combat is deferred.
- Complete creature ability workflows listed in `bestiary.md`, including High
  Noon Dance, auras, teleportation, knockback and flight consequences.
- Area placement/scatter, all affected actors, area escape, special bombs/traps,
  split/explosive ammunition and thrown alchemical items.
- Finish potion/decoction contextual triggers, oil damage, temporary HP, effects
  that confer immunities, toxicity recovery and conditional equipment bonuses.
- Wound arm restrictions, pain relief, healing modifiers, prostheses,
  treatment timing and pending death-save enforcement/notifications.
- Character creation/profession skills/trees and progression. Current sheet
  provides base stats, skills, custom skills, IP, identity and biography.
- Check token status synchronization and all sheet
  actions, item editors, unlinked actors and permission-sensitive operations.
- Review idempotence and rollback across all multi-document operations, not
  just damage application; serialize simultaneous workflows consistently.
- Remove retired Cyberpunk runtime from the final package; finish installation
  docs and release packaging. README/CI now describe Witcher; the Forge
  acceptance checklist is in `forge-checklist.md`.
- Commit and publish a release only after implementation gates pass. No release
  has been pushed at this stage, and no live Foundry session has been tested.

## Source inconsistencies preserved for review

- Elven Shield Diagram (printed p.138) requires **Etching Oil**, but the component
  tables do not define it. The official 2022 errata repeats that name. The recipe
  retains this requirement; the source audit reports its missing stock entry.
  No price or substitute ingredient has been invented.
- Recipe/product spelling aliases are recorded in the deterministic importer.
  Examples: Tanning Herb/Herbs, Mahkaman/Mahakaman, Spectacle/Spectacled Helm.
- Sailing Ship control differs between the transportation price table (−2) and
  the mounted-combat table (−1); the catalog currently uses the price-table value.

The supplied PDFs and extracted page images remain outside the repository in
`/root/witcher-reference`; they are not bundled with the system.
