# The Witcher TTRPG — Foundry V14

Independent Witcher implementation based on the owner's Cyberpunk V14 history
and the supplied **Core Rulebook v1.35**. System ID: `witcher-rilerena`.

**In development. Not yet a complete or live-verified game system.**
No runtime code from another Witcher system is included. Two general Foundry
compatibility helpers are retained from Cyberpunk.

## Current contents

- Character, NPC and monster data models and sheets.
- Attack, defense and GM damage workflow, location armor, wounds, saves,
  resources, crafting and equipment.
- **673 equipment and recipe records** in eight Item compendia.
- **36 creatures and NPCs** in **Core Bestiary & NPCs**, including printed
  variants, animals and three named adventure NPCs; **253 embedded records**.

See [implementation status](docs/witcher/implementation-status.md) for remaining
work and [bestiary coverage](docs/witcher/bestiary.md) for adaptations and limits.
Signs and player magic are deferred. Mounted combat is not a current priority.

## Validation

```sh
npm ci
npm test
npm run build:packs
npm run validate
```

The official Foundry CLI builds real LevelDB packs, reads them back and compares
every document, including embedded items. An optional check uses an externally
supplied genuine V14 client bundle to validate the data models:

```sh
node tools/witcher/validate-core-models.mjs /path/to/foundry.mjs
```

This does not start Foundry or verify sheet/multiplayer behavior. Live acceptance
will be performed on The Forge using the [checklist](docs/witcher/forge-checklist.md).

## Sources

PDFs and extracted pages remain outside the repository. Deterministic importers
record source pages and the PDF hash; they require Python and `pdfplumber`:

```sh
python tools/witcher/import-book.py /path/to/core-v1.35.pdf
python tools/witcher/import-bestiary.py /path/to/core-v1.35.pdf
```

Run the equipment importer first: NPC equipment and loot reference that catalog.
Runtime: `module/witcher/`. Templates: `templates/witcher/`. Source records:
`data/witcher/`. Packs: `packs/witcher/`. Tests: `tests/witcher/`.
Inherited Cyberpunk files outside these paths are not loaded by the manifest.
The original base is retained at tag `cyberpunk-v14-base`.
