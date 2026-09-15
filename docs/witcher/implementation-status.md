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
- Combat exceptions: grappling, special attacks, ranged combat, cover, bombs/traps, environment and mounted combat.
- Skills, races, professions and progression needed by sheets and non-magic combat.
- Automated book examples and boundary cases, package/schema/compendium validation.
- Installable GitHub release and Forge acceptance checklist. User performs live Forge checks.

Spells, signs, rituals and hex automation are deferred by the user.

## Known textual ambiguities to resolve explicitly

- Death State: p.153 describes reaching the HP total, while p.162 says below zero. Current implementation uses HP <= 0; this decision must be visible in the conformance notes.
- Armor layering must use the p.155 worked example (3 + 12 + 20 = 24), including its table boundaries. Do not inherit Cyberpunk's thresholds.

## Current work

The following is implemented locally, but is not a release-readiness declaration:

- Own TypeDataModels for PCs, NPCs, monsters and twelve item types.
- Own V1 sheets using the Cyberpunk V14 token-render compatibility fix.
- Attack/defense chat workflow, GM damage application, stale-armor recalculation,
  armor wear, critical wounds, resource persistence and duplicate-apply guard.
- All 24 core critical wounds represented with untreated/stabilized/treated data.
- Crafting/alchemy allocation, recovery, repair, item use and recurring effects.
- 673 catalog entries extracted from the supplied v1.35 PDF, including graphical
  alchemy ingredients. Eight real LevelDB packs built with the official Foundry
  CLI and independently extracted back; each stored system object compared.
- 34 pure rules/catalog tests pass. Manifest/import/syntax/template checks pass.
- The genuine public Foundry V14.365 field/DataModel code accepts all 673 item
  records and actor defaults. This check does not launch the Foundry application.

## Open implementation and review gates

These must be addressed before claiming the requested nonmagic system is complete.

- Combat fumble consequences currently appear in chat but need their application
  workflow, including self/ally hits, weapon jams and dropped equipment.
- Dual wielding, charge push/contest, fast draw, tie-breaking initiative,
  mounted combat/control loss, fall/environment hazards and human-shield cover.
- Area placement/scatter, all affected actors, area escape, special bombs/traps,
  split/explosive ammunition and thrown alchemical items.
- Finish potion/decoction contextual triggers, oil damage, temporary HP, effects
  that confer immunities, toxicity recovery and conditional equipment bonuses.
- Wound arm restrictions, pain relief, healing modifiers, prostheses,
  treatment timing and pending death-save enforcement/notifications.
- Character creation/profession skills/trees and progression. Current sheet
  provides base stats, skills, custom skills, IP, identity and biography.
- Synchronize token status icons with persisted conditions; check all sheet
  actions, item editors, unlinked actors and permission-sensitive operations.
- Review idempotence and rollback across all multi-document operations, not
  just damage application; serialize simultaneous workflows consistently.
- Replace inherited Cyberpunk README/workflows and remove retired runtime from
  the final package. Produce installation docs and a Forge acceptance checklist.
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
