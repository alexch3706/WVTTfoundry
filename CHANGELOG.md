# 0.1.0-alpha.2

- Make armor condition visible at the top of its item sheet: editable current SP and maximum SP for every covered location.
- Show current/max SP in the actor hit-location table and for each armor item in Equipment; highlight wear and broken locations.
- Preserve zero current SP and show non-humanoid/custom coverage on standalone armor sheets. Distinguish the source item from the worn actor copy.
- Combat calculation and saved armor values are unchanged; no migration is required.

# 0.1.0-alpha.1

- Complete the ordinary equipped-weapon/defense/damage workflow with fast/strong strikes, creature ROF, STA and ammunition.
- Serialize combat through the active GM, revalidate pending choices and protect resource/damage persistence against duplicate actions.
- Add all 136 Tools/Journal equipment, recipe, component and mutagen records; integrate school armor combat effects.
- Add installable release packaging and Forge acceptance instructions.
- Live Foundry V14 acceptance remains pending; magic, mounted combat and active creature/profession abilities remain deferred.

# Development changelog

## Unreleased — 0.1.0-dev.1

- Established an independent Witcher V14 implementation on the owner's
  Cyberpunk history, retaining its general Foundry compatibility helpers.
- Added character/NPC/monster data and sheets, combat and equipment workflows,
  critical wounds, crafting and eight compendia with 673 catalog records.
- Added Core Bestiary & NPCs: 36 Actors with 253 embedded records, printed
  variants, animals and named adventure NPCs; integrated creature combat traits.
- Added deterministic source audits, real LevelDB round-trip validation,
  genuine V14 data-model validation and 50 rules/catalog tests.

This is work in progress. See `docs/witcher/implementation-status.md` and
`docs/witcher/bestiary.md` for remaining implementation and live-test gates.
